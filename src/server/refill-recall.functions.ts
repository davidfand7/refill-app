/**
 * Recall — Patient-Profitability OS · Phase 1 (Slice A: surface, read-only).
 *
 * `listRecallTargets` unions two already-built signal sources into the four
 * recall triggers the spa can act on today:
 *
 *   1. Expiring          — reward entries whose reward expires ≤60d
 *                          (status_norm 'expiring_soon'). Highest urgency:
 *                          a dollar amount is literally about to evaporate.
 *   2. Eligible & idle   — reward entries 'eligible' now, but the patient
 *                          hasn't visited in 90d+. Money sitting unredeemed.
 *   3. Becoming-eligible — reward entries 'not_yet_eligible' — pre-position
 *                          the outreach so we book them the day it unlocks.
 *   4. Lapsed            — cadence-driven (doListOverdue + isLapsed). No
 *                          reward row required; these are patients past the
 *                          hard lapse window for their primary kind.
 *
 * Slice A is READ-ONLY: it surfaces the lists + the twin headline
 * ("$X on the table · N patients"). The one-click → iMessage → book → bill
 * write path is Slice B and lives elsewhere.
 *
 * Reuse: the reward read mirrors listRewardSignal (manufacturer-reward-
 * ingest); the lapsed read reuses doListOverdue (patient-ingest); cadence
 * idle math reuses daysSince (patient-cadence). No new tables.
 *
 * Established 2026-06-07.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { getSpaName } from "@/server/emma-optout.functions";
import { fetchAllRows } from "@/server/paginate";
import { doListOverdue } from "@/server/patient-ingest.functions";
import { recordRecoveryEvent } from "@/server/emma-attribution.functions";
import { recordMessagingActivity, recordAgentAction } from "@/server/messaging-activity";
import { isSendingPaused } from "@/server/sending-pause";
import { loadBlockedNodeIds } from "@/server/patient-contactability";
import { daysSince } from "@/lib/patient-cadence";
import type { RewardStatusNorm } from "@/lib/manufacturer-reward-csv";

// ─── Service-role client (mirrors the other ingest fns) ────────────────────

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// A patient is "idle" (eligible-but-not-coming-in) after this many days
// without a visit. Matches the synthesis "eligible + idle 3 months".
const IDLE_DAYS = 90;
// How far back the lapsed scan reaches. Big enough to never truncate a real
// spa's overdue book.
const LAPSED_SCAN_LIMIT = 2000;

export type RecallTrigger =
  | "expiring"
  | "eligible_idle"
  | "becoming_eligible"
  | "lapsed";

export type RecallTarget = {
  /** Stable row key: reward-entry id, or `lapsed:<patientId>`. */
  key: string;
  trigger: RecallTrigger;
  patientNodeId: string | null;
  patientName: string | null;
  manufacturer: string | null;
  /** Brand for reward triggers; null for cadence-driven lapsed rows. */
  brandProduct: string | null;
  statusRaw: string | null;
  /** Reward amount on the table ($), when the source carries one. */
  rewardAmountUsd: number | null;
  eligibleDate: string | null;
  expirationDate: string | null;
  lastVisit: string | null;
  /** Days since last visit (idle/lapsed measure). */
  daysIdle: number | null;
  phone: string | null;
  email: string | null;
  matched: boolean;
};

export type RecallGroup = {
  trigger: RecallTrigger;
  label: string;
  /** Distinct patients in this group. */
  patients: number;
  /** Reward $ on the table in this group (0 for becoming-eligible/lapsed). */
  dollars: number;
  targets: RecallTarget[];
};

export type RecallView = {
  groups: RecallGroup[];
  /** Twin headline: reward $ across actionable buckets… */
  dollarsOnTable: number;
  /** …across this many distinct patients (all four triggers). */
  distinctPatients: number;
  /** Whether the Weekly Recall Digest routine is on (Skill adopted/On). */
  digestEnabled: boolean;
  /** When the last weekly digest actually went out (null = none yet). */
  digestLastSentAt: string | null;
};

// recall_digest_* columns aren't in the generated types yet — narrow loose read.
type LooseDigestRead = {
  from(t: string): {
    select(c: string): {
      eq(
        c: string,
        v: unknown,
      ): {
        maybeSingle(): Promise<{
          data: {
            recall_digest_enabled: boolean | null;
            recall_digest_last_sent_at: string | null;
          } | null;
        }>;
      };
    };
  };
};

const GROUP_LABELS: Record<RecallTrigger, string> = {
  expiring: "Expiring",
  eligible_idle: "Eligible & idle",
  becoming_eligible: "Becoming eligible",
  lapsed: "Lapsed",
};

const ORDER: RecallTrigger[] = [
  "expiring",
  "eligible_idle",
  "becoming_eligible",
  "lapsed",
];

const input = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

type RewardDbRow = {
  id: string;
  manufacturer: string;
  brand_product: string;
  status_raw: string | null;
  status_norm: string;
  eligible_date: string | null;
  expiration_date: string | null;
  reward_amount_usd: number | null;
  contact_phone: string | null;
  contact_email: string | null;
  last_visit: string | null;
  patient_node_id: string | null;
};

type RecallSb = ReturnType<typeof admin>;

/**
 * The pure recall computation, shared by the interactive surface
 * (listRecallTargets) and the weekly Recall Digest cron. Keeping it in one
 * place means the digest reads EXACTLY what the Recall page shows — no second,
 * drifting definition of "who's due".
 */
export async function computeRecallView(
  sb: RecallSb,
  effectiveUserId: string,
): Promise<RecallView> {
    // ── 1) Reward-driven triggers (expiring / eligible-idle / becoming) ──
    const rewardRows = await fetchAllRows<RewardDbRow>((from, to) =>
      sb
        .from("patient_reward_entries")
        .select(
          "id, manufacturer, brand_product, status_raw, status_norm, eligible_date, expiration_date, reward_amount_usd, contact_phone, contact_email, last_visit, patient_node_id",
        )
        .eq("user_id", effectiveUserId)
        .order("id", { ascending: true })
        .range(from, to),
    );

    // Resolve display names for matched reward rows (chunked .in — a single
    // call caps at 1,000 and risks a 414 once matched patients climb).
    const nodeIds = Array.from(
      new Set(
        rewardRows.map((r) => r.patient_node_id).filter((x): x is string => !!x),
      ),
    );
    const nameByNode = new Map<string, string>();
    const ID_CHUNK = 300;
    for (let i = 0; i < nodeIds.length; i += ID_CHUNK) {
      const slice = nodeIds.slice(i, i + ID_CHUNK);
      const { data: nodes } = await sb
        .from("knowledge_nodes")
        .select("id, title")
        .in("id", slice);
      for (const n of nodes ?? []) nameByNode.set(n.id, n.title ?? "");
    }

    const expiring: RecallTarget[] = [];
    const eligibleIdle: RecallTarget[] = [];
    const becoming: RecallTarget[] = [];

    for (const r of rewardRows) {
      const status = (r.status_norm as RewardStatusNorm) ?? "unknown";
      const idle = daysSince(r.last_visit);
      // Date-driven expiry: trust the reward's REAL expiration date vs today,
      // not the status_norm frozen at ingest. A manufacturer "eligible" row
      // whose reward actually closes in soon should surface as Expiring — and
      // the bucket can't go stale between exports.
      const RECALL_EXPIRING_WINDOW_DAYS = 60;
      const dSinceExp = daysSince(r.expiration_date);
      const daysUntilExp = dSinceExp == null ? null : -dSinceExp;
      const isExpiringByDate =
        daysUntilExp != null &&
        daysUntilExp >= 0 &&
        daysUntilExp <= RECALL_EXPIRING_WINDOW_DAYS;
      const isExpiredByDate = daysUntilExp != null && daysUntilExp < 0;
      const base: Omit<RecallTarget, "trigger"> = {
        key: r.id,
        patientNodeId: r.patient_node_id,
        patientName: r.patient_node_id
          ? (nameByNode.get(r.patient_node_id) ?? null)
          : null,
        manufacturer: r.manufacturer,
        brandProduct: r.brand_product,
        statusRaw: r.status_raw,
        rewardAmountUsd:
          r.reward_amount_usd != null ? Number(r.reward_amount_usd) : null,
        eligibleDate: r.eligible_date,
        expirationDate: r.expiration_date,
        lastVisit: r.last_visit,
        daysIdle: idle,
        phone: r.contact_phone,
        email: r.contact_email,
        matched: !!r.patient_node_id,
      };

      if (status === "not_yet_eligible") {
        becoming.push({ ...base, trigger: "becoming_eligible" });
      } else if (isExpiredByDate || status === "expired") {
        // Already lapsed/expired — not an actionable recall trigger.
      } else if (isExpiringByDate || status === "expiring_soon") {
        expiring.push({ ...base, trigger: "expiring" });
      } else if (status === "eligible" && idle != null && idle > IDLE_DAYS) {
        eligibleIdle.push({ ...base, trigger: "eligible_idle" });
      }
    }

    // Soonest-expiring first; most-idle first; soonest-to-unlock first.
    expiring.sort((a, b) =>
      (a.expirationDate ?? "9999-12-31") < (b.expirationDate ?? "9999-12-31")
        ? -1
        : 1,
    );
    eligibleIdle.sort((a, b) => (b.daysIdle ?? 0) - (a.daysIdle ?? 0));
    becoming.sort((a, b) =>
      (a.eligibleDate ?? "9999-12-31") < (b.eligibleDate ?? "9999-12-31")
        ? -1
        : 1,
    );

    // ── 2) Lapsed (cadence-driven, reward-independent) ──
    const overdue = await doListOverdue(sb, effectiveUserId, LAPSED_SCAN_LIMIT, null);
    const lapsed: RecallTarget[] = overdue
      .filter((p) => p.isLapsed)
      .map((p) => ({
        key: `lapsed:${p.patientId}`,
        trigger: "lapsed" as const,
        patientNodeId: p.patientId,
        patientName: p.displayName,
        manufacturer: p.manufacturer,
        brandProduct: null,
        statusRaw: `${p.daysOverdue}d past ${p.kind} cadence`,
        rewardAmountUsd: null,
        eligibleDate: null,
        expirationDate: null,
        lastVisit: p.lastVisitOfKind,
        daysIdle: p.daysOverdue,
        phone: p.phone,
        email: p.email,
        matched: true,
      }));

    // ── 2.5) Compliance: never recall a banned / opted-out patient ──
    // Drop them at the SOURCE so they vanish from the page list, the digest
    // dollars, AND the drafts in one place (recall previously had no opt-out
    // check anywhere). In-place splice keeps the const bindings; downstream
    // groups/dollars/distinct read the filtered arrays. See patient-contactability.
    const blockedNodes = await loadBlockedNodeIds(
      sb,
      effectiveUserId,
      [...expiring, ...eligibleIdle, ...becoming, ...lapsed].map(
        (t) => t.patientNodeId,
      ),
    );
    if (blockedNodes.size > 0) {
      for (const arr of [expiring, eligibleIdle, becoming, lapsed]) {
        for (let i = arr.length - 1; i >= 0; i--) {
          const nid = arr[i].patientNodeId;
          if (nid && blockedNodes.has(nid)) arr.splice(i, 1);
        }
      }
    }

    // ── 3) Assemble groups + the twin headline ──
    const byTrigger: Record<RecallTrigger, RecallTarget[]> = {
      expiring,
      eligible_idle: eligibleIdle,
      becoming_eligible: becoming,
      lapsed,
    };

    const groups: RecallGroup[] = ORDER.map((trigger) => {
      const targets = byTrigger[trigger];
      const dollars = targets.reduce(
        (sum, t) => sum + (t.rewardAmountUsd ?? 0),
        0,
      );
      const patients = new Set(
        targets.map((t) => t.patientNodeId ?? t.key),
      ).size;
      return { trigger, label: GROUP_LABELS[trigger], patients, dollars, targets };
    });

    // $X = reward dollars across the buckets that carry a live reward amount
    // (Expiring + Eligible-&-idle). N = distinct patients across all four.
    const dollarsOnTable =
      expiring.reduce((s, t) => s + (t.rewardAmountUsd ?? 0), 0) +
      eligibleIdle.reduce((s, t) => s + (t.rewardAmountUsd ?? 0), 0);
    const distinctPatients = new Set(
      [...expiring, ...eligibleIdle, ...becoming, ...lapsed].map(
        (t) => t.patientNodeId ?? t.key,
      ),
    ).size;

    // ── 4) Digest routine state (for the page's honest "digest is on" chip) ──
    const { data: digestRow } = await (sb as unknown as LooseDigestRead)
      .from("noshow_policies")
      .select("recall_digest_enabled, recall_digest_last_sent_at")
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    const digestEnabled = Boolean(digestRow?.recall_digest_enabled);
    const digestLastSentAt = digestRow?.recall_digest_last_sent_at ?? null;

    return {
      groups,
      dollarsOnTable,
      distinctPatients,
      digestEnabled,
      digestLastSentAt,
    };
}

export const listRecallTargets = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => input.parse(raw))
  .handler(async ({ data }): Promise<RecallView> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    return computeRecallView(admin(), effectiveUserId);
  });

// ─── getRewardExpiryBadge (the 'surface' materializer — Reward-Expiry Sweep) ──
//
// Powers the ambient "expiring soon" badge pinned on the Recall tab. It is the
// honest, distinct counterpart to the Weekly Recall Digest: the digest is a
// weekly EMAIL; this is an always-visible in-app glance, opt-in via the Skill.
// Gated on the Skill being adopted + enabled (skills.template_key=
// 'reward_expiry_sweep'); paused → badge returns enabled=false → hides. The
// "expiring" definition matches Recall's Expiring trigger (≤window days, not
// already-expired, not not_yet_eligible) so there's ONE notion of "expiring".

const EXPIRY_BADGE_WINDOW_DAYS = 60;

const badgeInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export type RewardExpiryBadge = {
  /** Whether the Reward-Expiry Sweep Skill is adopted + on for this spa. */
  enabled: boolean;
  /** Distinct patients with a reward expiring within the window. */
  count: number;
  /** Reward dollars on those expiring rewards. */
  dollars: number;
};

// skills isn't in the generated types — narrow loose read of the enable flag.
type LooseSkillEnabledRead = {
  from(t: string): {
    select(c: string): {
      eq(
        c: string,
        v: unknown,
      ): {
        eq(
          c: string,
          v: unknown,
        ): { maybeSingle(): Promise<{ data: { enabled: boolean } | null }> };
      };
    };
  };
};

export const getRewardExpiryBadge = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => badgeInput.parse(raw))
  .handler(async ({ data }): Promise<RewardExpiryBadge> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // Gate: only render when the Skill is adopted AND on.
    const { data: skillRow } = await (sb as unknown as LooseSkillEnabledRead)
      .from("skills")
      .select("enabled")
      .eq("user_id", effectiveUserId)
      .eq("template_key", "reward_expiry_sweep")
      .maybeSingle();
    if (!skillRow || !skillRow.enabled) {
      return { enabled: false, count: 0, dollars: 0 };
    }

    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const windowEndIso = new Date(
      now.getTime() + EXPIRY_BADGE_WINDOW_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    const rows = await fetchAllRows<{
      patient_node_id: string | null;
      reward_amount_usd: number | null;
    }>((from, to) =>
      sb
        .from("patient_reward_entries")
        .select("patient_node_id, reward_amount_usd")
        .eq("user_id", effectiveUserId)
        .neq("status_norm", "not_yet_eligible")
        .gte("expiration_date", todayIso)
        .lte("expiration_date", windowEndIso)
        .order("id", { ascending: true })
        .range(from, to),
    );

    const patientKeys = new Set<string>();
    let dollars = 0;
    rows.forEach((r, i) => {
      patientKeys.add(r.patient_node_id ?? `row:${i}`);
      dollars += r.reward_amount_usd != null ? Number(r.reward_amount_usd) : 0;
    });

    return { enabled: true, count: patientKeys.size, dollars: Math.round(dollars) };
  });

// ─── recordRecallBookingFn (Slice B — the $5 win) ──────────────────────────
//
// Called by BookDialog after a successful owner booking made *from* a Recall
// row. Writes a provisional recovery event tagged recovery_agent='recall' +
// metric_key='recall_booking' (the landmine: without the explicit metric_key
// the DB defaults to slot_fill and the recall win mis-bills). The reconcile
// cron later verifies it against the patient's real transaction → $5 lands on
// the fee-rules ledger. Idempotent on appointment_id (recordRecoveryEvent).

const recallBookInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  appointmentId: z.string().uuid(),
  patientNodeId: z.string().uuid(),
});

export const recordRecallBookingFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => recallBookInput.parse(raw))
  .handler(async ({ data }): Promise<{ id: string; created: boolean }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    return recordRecoveryEvent({
      sb,
      userId: effectiveUserId,
      appointmentId: data.appointmentId,
      patientNodeId: data.patientNodeId,
      recoveryAgent: "recall",
      metricKey: "recall_booking",
      attributionMethod: "direct",
      notes: "Recall booking",
    });
  });

// ─── draftRecallOutreachFn (Slice B — the outreach) ────────────────────────
//
// Mirrors the Recognition allocation dispatch (refill-recognition-allocation):
// build one iMessage draft per selected target, email the batch to the spa's
// configured rescue_proxy_email, owner pastes it into Claude Desktop → the
// iMessage MCP drafts each conversation from the spa's own Apple ID → owner
// taps Send. No carrier, no shortcode — blue bubble from the number the
// patient already has saved.

type RecallDraftTrigger =
  | "expiring"
  | "eligible_idle"
  | "becoming_eligible"
  | "lapsed";

const draftInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  targets: z
    .array(
      z.object({
        fullName: z.string(),
        phone: z.string().nullable().optional(),
        brand: z.string().nullable().optional(),
        trigger: z.enum([
          "expiring",
          "eligible_idle",
          "becoming_eligible",
          "lapsed",
        ]),
        expirationDate: z.string().nullable().optional(),
        eligibleDate: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export type RecallDraftResult = {
  sent: boolean;
  drafted: number;
  skippedNoPhone: string[];
  sentTo: string | null;
  error: string | null;
};

function firstNameOf(full: string): string {
  return full.split(/\s+/)[0] || full || "there";
}

function prettyDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = parseInt(m, 10) - 1;
  return `${months[mi] ?? m} ${parseInt(d, 10)}`;
}

function composeRecallBody(args: {
  trigger: RecallDraftTrigger;
  firstName: string;
  spaName: string;
  brand: string | null | undefined;
  expirationDate: string | null | undefined;
  eligibleDate: string | null | undefined;
}): string {
  const { firstName, spaName, brand } = args;
  const b = brand && brand.trim() ? brand.trim() : "your";
  switch (args.trigger) {
    case "expiring": {
      const when = prettyDate(args.expirationDate);
      const exp = when ? ` expires ${when}` : " is about to expire";
      return `Hi ${firstName}! It's ${spaName} — your ${b} reward${exp}. Want me to get you on the calendar before it's gone? Reply and I'll book you in. 💛`;
    }
    case "eligible_idle":
      return `Hi ${firstName}! It's ${spaName} — you've got a ${b} reward ready to use and we'd love to see you. Want me to find you a time that works?`;
    case "becoming_eligible": {
      const when = prettyDate(args.eligibleDate);
      const unlock = when ? ` unlocks ${when}` : " unlocks soon";
      return `Hi ${firstName}! It's ${spaName} — your ${b} reward${unlock}. Want me to hold a spot so you can use it the day it's ready?`;
    }
    case "lapsed":
    default:
      return `Hi ${firstName}! It's ${spaName} — it's been a while and we miss you. Want me to get you booked for your next visit?`;
  }
}

export const draftRecallOutreachFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => draftInput.parse(raw))
  .handler(async ({ data }): Promise<RecallDraftResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // Destination inbox + spa identity (same sources as Recognition dispatch).
    const [{ data: policy }, spaName] = await Promise.all([
      sb
        .from("noshow_policies")
        .select("rescue_proxy_email")
        .eq("user_id", effectiveUserId)
        .maybeSingle(),
      // Canonical spa-name resolver (context='spa-profile'/lookup_key='spa-name').
      // The old node_type='spa_profile' read missed it → generic "Your spa".
      getSpaName(effectiveUserId),
    ]);
    const proxyEmail = policy?.rescue_proxy_email?.trim() || null;

    type Built = { fullName: string; phone: string; body: string };
    const built: Built[] = [];
    const skippedNoPhone: string[] = [];
    for (const t of data.targets) {
      const phone = (t.phone ?? "").trim();
      if (!phone) {
        skippedNoPhone.push(t.fullName);
        continue;
      }
      built.push({
        fullName: t.fullName,
        phone,
        body: composeRecallBody({
          trigger: t.trigger,
          firstName: firstNameOf(t.fullName),
          spaName,
          brand: t.brand,
          expirationDate: t.expirationDate,
          eligibleDate: t.eligibleDate,
        }),
      });
    }

    if (built.length === 0) {
      return {
        sent: false,
        drafted: 0,
        skippedNoPhone,
        sentTo: null,
        error: "No selected patients had a phone number on file.",
      };
    }
    if (!proxyEmail) {
      return {
        sent: false,
        drafted: built.length,
        skippedNoPhone,
        sentTo: null,
        error:
          "Set a drafts inbox (rescue_proxy_email) on this spa's policy so outreach can route to your Mac.",
      };
    }
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      return {
        sent: false,
        drafted: built.length,
        skippedNoPhone,
        sentTo: null,
        error: "RESEND_API_KEY missing on the worker.",
      };
    }

    const subject = `${spaName} — ${built.length} recall draft${built.length === 1 ? "" : "s"} ready to send`;
    const draftBlocks = built
      .map(
        (d) =>
          `<div style="margin:18px 0;padding:14px 16px;background:#f7f6f3;border-left:3px solid #047857;border-radius:6px;">
  <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#222;margin-bottom:8px;"><strong>To:</strong> ${d.phone} <span style="color:#666;">(${d.fullName})</span></div>
  <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#222;white-space:pre-wrap;">${d.body}</div>
</div>`,
      )
      .join("");
    const html = `<!doctype html><html><body style="margin:0;padding:32px;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;color:#1a1a1a;">
  <div style="max-width:640px;margin:0 auto;">
    <div style="margin-bottom:20px;padding:14px 16px;background:#ecfdf5;border-left:3px solid #047857;border-radius:6px;font-size:13px;color:#064e3b;line-height:1.55;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#047857;margin-bottom:6px;">Recall · iMessage drafts</div>
      Paste this whole email into Claude Desktop with the iMessage MCP installed. Claude will call <code>draft_imessage(recipient_phone, body)</code> for each row below — one Messages.app conversation per draft. Review each and tap Send. Messages come from YOUR Apple ID, not a platform shortcode. When a patient replies yes, book them on the Recall tab and Refill records the win.
    </div>
    <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#047857;margin:24px 0 8px;">Ready-to-send drafts</div>
    ${draftBlocks}
  </div>
</body></html>`;
    const text = `${spaName} — Recall outreach\n\nPaste into Claude Desktop with the iMessage MCP. Claude drafts each iMessage below; review and tap Send.\n\n${built.map((d) => `── To: ${d.phone} (${d.fullName}) ──\n\n${d.body}`).join("\n\n")}`;

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.REFILL_FROM_EMAIL ?? "recall@getrefill.app",
          to: [proxyEmail],
          subject,
          text,
          html,
          tags: [
            { name: "type", value: "refill-recall-dispatch" },
            { name: "tenant", value: effectiveUserId },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        return {
          sent: false,
          drafted: built.length,
          skippedNoPhone,
          sentTo: null,
          error: `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
        };
      }
    } catch (e) {
      return {
        sent: false,
        drafted: built.length,
        skippedNoPhone,
        sentTo: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    // Outbound heartbeat: the recall drafts just went to the spa's Mac for
    // iMessage sending. This is the killer-arch channel that writes no
    // patient_outreach row, so without this beat Connection Health's delivery
    // card stays blind to active recall. Best-effort — the dispatch already
    // succeeded; a missed beat only makes the card briefly stale.
    await recordMessagingActivity(sb, effectiveUserId, "sms", "recall", built.length);

    return {
      sent: true,
      drafted: built.length,
      skippedNoPhone,
      sentTo: proxyEmail,
      error: null,
    };
  });

// ═══════════════════════════════════════════════════════════════════════════
// RECALL DIGEST (v2.22.0) — the honest "Auto-Recall" routine.
//
// A weekly scheduled job (pg_cron → /api/cron/recall-digest) that computes the
// same recall view the page shows and emails the OWNER a heads-up: "$X on the
// table across N patients due." Gated by noshow_policies.recall_digest_
// enabled (the Skill's adopt/On flips it; pause flips it off). The digest is a
// nudge to come review — it sends NO patient outreach. Sending stays one-click
// and consented on the Recall page (draftRecallOutreachFn). That boundary is
// the Tier-2 line (project_trusted_onboarding): a routine can surface and
// summarize on its own, but a blue-bubble to a patient still wants a human tap.
// ═══════════════════════════════════════════════════════════════════════════

function digestMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

/** Pure email composer for the weekly digest — no I/O, easy to eyeball. */
export function composeRecallDigestEmail(args: {
  spaName: string;
  view: RecallView;
  ctaUrl: string;
}): { subject: string; text: string; html: string } {
  const { spaName, view, ctaUrl } = args;
  const dollars = Math.round(view.dollarsOnTable);
  const patients = view.distinctPatients;

  const subject =
    dollars > 0
      ? `${spaName} — ${digestMoney(dollars)} on the table: ${patients} patient${patients === 1 ? "" : "s"} due for recall`
      : `${spaName} — ${patients} patient${patients === 1 ? "" : "s"} due for recall`;

  // Only show groups that actually have someone in them.
  const liveGroups = view.groups.filter((g) => g.patients > 0);
  const rowsHtml = liveGroups
    .map(
      (g) => `<tr>
  <td style="padding:8px 12px;border-bottom:1px solid #eee9dd;font-size:13px;color:#1a1a1a;">${g.label}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #eee9dd;font-size:13px;color:#1a1a1a;text-align:right;font-variant-numeric:tabular-nums;">${g.patients.toLocaleString()}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #eee9dd;font-size:13px;color:#047857;text-align:right;font-variant-numeric:tabular-nums;">${g.dollars > 0 ? digestMoney(g.dollars) : "—"}</td>
</tr>`,
    )
    .join("");
  const rowsText = liveGroups
    .map(
      (g) =>
        `  • ${g.label}: ${g.patients} patient${g.patients === 1 ? "" : "s"}${g.dollars > 0 ? ` · ${digestMoney(g.dollars)} in rewards` : ""}`,
    )
    .join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:32px;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#047857;margin-bottom:6px;">SmartSpa · Recall digest</div>
    <h1 style="font-size:20px;margin:0 0 4px;color:#1a1a1a;">Money on the table this week</h1>
    <p style="font-size:13px;color:#555;margin:0 0 20px;line-height:1.55;">Here's who's due back at ${spaName} — expiring rewards and lapsed regulars the manufacturer would otherwise send to “a provider near you.” Book them into your own chair instead.</p>

    <div style="display:flex;gap:28px;padding:16px 18px;background:#fff;border:1px solid #e6e2d6;border-radius:12px;margin-bottom:18px;">
      <div>
        <div style="font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#999;">On the table</div>
        <div style="font-size:26px;font-weight:700;color:#047857;font-variant-numeric:tabular-nums;">${digestMoney(dollars)}</div>
      </div>
      <div>
        <div style="font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#999;">Patients to recall</div>
        <div style="font-size:26px;font-weight:700;color:#1a1a1a;font-variant-numeric:tabular-nums;">${patients.toLocaleString()}</div>
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e6e2d6;border-radius:12px;overflow:hidden;margin-bottom:22px;">
      <thead>
        <tr style="background:#f7f6f3;">
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#999;">Trigger</th>
          <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#999;">Patients</th>
          <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#999;">Rewards</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <a href="${ctaUrl}" style="display:inline-block;background:#047857;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:9px;">Review &amp; send recall &rarr;</a>

    <p style="font-size:12px;color:#888;margin:18px 0 0;line-height:1.55;">Nothing was sent to any patient — this is just your weekly heads-up. Open Recall, pick who to reach, and send the drafts in one tap. You can turn this digest off any time from <strong>Skills</strong>.</p>
  </div>
</body></html>`;

  const text = `SmartSpa · Recall digest — ${spaName}\n\nMoney on the table this week:\n  On the table: ${digestMoney(dollars)}\n  Patients to recall: ${patients}\n\n${rowsText}\n\nReview & send recall: ${ctaUrl}\n\nNothing was sent to any patient — this is your weekly heads-up. Open Recall, pick who to reach, and send in one tap. Turn this digest off any time from Skills.`;

  return { subject, text, html };
}

async function ownerEmailForUserId(
  sb: RecallSb,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await sb.auth.admin.getUserById(userId);
    if (error) {
      console.warn("[recall-digest] owner email lookup failed", userId, error.message);
      return null;
    }
    return data?.user?.email ?? null;
  } catch (e) {
    console.warn("[recall-digest] owner email lookup threw", userId, e);
    return null;
  }
}

export type RecallDigestResult =
  | { status: "sent"; email: string; dollars: number; patients: number }
  | { status: "empty" }
  | { status: "no_email" }
  | { status: "paused" }
  | { status: "error"; error: string };

/**
 * Compute + deliver one spa's weekly recall digest. Honest by construction:
 *   • an empty book sends NOTHING (no noise),
 *   • it emails the owner a summary only — never a patient,
 *   • on success it stamps recall_digest_last_sent_at for the cron's dedup.
 */
export async function sendRecallDigestForUser(
  sb: RecallSb,
  userId: string,
  publicOrigin: string,
): Promise<RecallDigestResult> {
  // Tier-2 kill switch (Slice 3): the master pause halts the weekly digest too.
  // This cron doesn't load the policy row, so query the flag directly.
  if (await isSendingPaused(sb, userId)) return { status: "paused" };
  const view = await computeRecallView(sb, userId);
  if (view.distinctPatients === 0) return { status: "empty" };

  const email = await ownerEmailForUserId(sb, userId);
  if (!email) return { status: "no_email" };

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return { status: "error", error: "RESEND_API_KEY missing on the worker." };

  const spaName = await getSpaName(userId);
  const ctaUrl = `${publicOrigin.replace(/\/$/, "")}/app/refill/recognition/recall`;
  const { subject, text, html } = composeRecallDigestEmail({ spaName, view, ctaUrl });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.REFILL_FROM_EMAIL ?? "recall@getrefill.app",
        to: [email],
        subject,
        text,
        html,
        tags: [
          { name: "type", value: "refill-recall-digest" },
          { name: "tenant", value: userId },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return {
        status: "error",
        error: `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
      };
    }
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  // Stamp the send for the cron's 6-day dedup guard. recall_digest_last_sent_at
  // isn't in types.ts yet (same posture as skills' loose tables) — cast the
  // update payload. Best-effort: a missed stamp only risks a duplicate next run.
  const stamp: Record<string, unknown> = {
    recall_digest_last_sent_at: new Date().toISOString(),
  };
  await sb
    .from("noshow_policies")
    .update(stamp as Database["public"]["Tables"]["noshow_policies"]["Update"])
    .eq("user_id", userId);

  // Tier-2 ledger: the weekly digest just went out on its own (owner-facing
  // autonomous send). Best-effort — the email already sent.
  await recordAgentAction(sb, userId, {
    agent: "recall_digest",
    action: "digest_emailed",
    channel: "email",
    count: 1,
    initiatedBy: "autonomous",
    metadata: {
      dollars: Math.round(view.dollarsOnTable),
      patients: view.distinctPatients,
    },
  });

  return {
    status: "sent",
    email,
    dollars: Math.round(view.dollarsOnTable),
    patients: view.distinctPatients,
  };
}
