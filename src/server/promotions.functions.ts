/**
 * promotions.functions.ts — Promotions Engine server fns (v335).
 *
 * Two reads for the first user-visible Promotions surfaces:
 *
 *   listPromotions       → /app/rep/promotions (the list view)
 *   getPromotionDetail   → /app/rep/promotions/$promotionId (the detail)
 *
 * Both follow the v332 viewAs="demo" pattern so the showcase tenant
 * surfaces the same way the rep's real territory does. Writes (blast
 * composer, status transitions) ship in v336 and refuse viewAs=demo at
 * the server layer.
 *
 * Promotion data lives in knowledge_nodes (node_type='promotion') per the
 * v319 schema, extended in v334 with PromotionAttachments.tiers[]. These
 * fns surface a flat read-friendly shape; the chat handler + memory-graph
 * tool query the underlying nodes directly.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/integrations/supabase/types";
import { verifyAuth, accessTokenInput } from "@/server/auth-helpers";
import { resolveEffectiveUserId, type ViewAs } from "@/server/demo-user";
import { callGeminiOneShot } from "@/server/gemini-oneshot";
import type {
  PromotionAttachments,
  PromotionBuyInTier,
  PromotionKind,
  AccountAttachments,
  AccountTier,
  RepAssignment,
} from "@/server/agent-schema";
import { REPLY_DOMAIN } from "@/server/resend-gateway";

// ── Public types ──────────────────────────────────────────────────────────

export type PromoListRow = {
  id: string;
  title: string;
  manufacturer: string | null;
  promoKind: PromotionKind | null;
  starts: string | null;
  ends: string | null;
  tierCount: number;
  heroImageUrl: string | null;
  /** Derived: "upcoming" if starts > today, "expired" if ends < today,
   *  otherwise "active". Computed server-side so the list view doesn't have
   *  to parse dates client-side. */
  status: "upcoming" | "active" | "expired" | "unknown";
  /** Days until ends (negative if already expired). null if no end date. */
  daysToEnd: number | null;
  /** Count of accounts in this rep's roster that match the manufacturer
   *  (rep_assignment-based). v335 surfaces the raw count; v336 adds the
   *  state-machine rollup once promotion_account_state rows exist. */
  eligibleAccountCount: number;
};

export type PromoEligibleAccount = {
  id: string;
  title: string;
  lookupKey: string | null;
  address?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  /** Current tier for THIS manufacturer (the one the promo is for) — picked
   *  out of account.tiers[] by family-prefix match. Null if the account
   *  has no tier history with this manufacturer. */
  currentTier: AccountTier | null;
  repAssignment?: RepAssignment;
};

/** Flat / serializable subset of PromotionAttachments — TanStack server-fn
 *  return types can't include the index signature on PromotionAttachments
 *  (it has `[key: string]: unknown` for forward-compat with v319 fields).
 *  So we pick out the fields the detail page actually uses. */
export type PromoMetaForDetail = {
  manufacturer: string | null;
  promoKind: PromotionKind | null;
  name: string | null;
  heroImageUrl: string | null;
  sourceUrl: string | null;
  appliesTo: string[];
  starts: string | null;
  ends: string | null;
  termsFinePrint: string | null;
};

export type PromoDetail = {
  id: string;
  title: string;
  content: string;
  lookupKey: string | null;
  meta: PromoMetaForDetail;
  /** Pre-computed structured ladder. */
  tiers: PromotionBuyInTier[];
  /** Same status fields the list row carries — convenient for the detail
   *  header. */
  status: "upcoming" | "active" | "expired" | "unknown";
  daysToEnd: number | null;
  eligibleAccounts: PromoEligibleAccount[];
  /** When this promo is concurrent with others — link them by lookup_key. */
  concurrentPromos: Array<{ id: string; title: string; lookupKey: string }>;
};

// ── Admin helper ──────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────

/** "evolus" → "evolus-rep". Used to filter accounts to those whose
 *  rep_assignment matches the promo's manufacturer. */
function manufacturerToRepAssignment(manufacturer: string | undefined): RepAssignment | null {
  if (!manufacturer) return null;
  const m = manufacturer.toLowerCase();
  // Some seed rows use "abbvie" for Allergan's Allē program; normalize.
  if (m === "abbvie" || m === "allergan") return "allergan-rep";
  if (m === "galderma") return "galderma-rep";
  if (m === "evolus") return "evolus-rep";
  if (m === "merz" || m === "merz-aesthetics") return "merz-rep";
  return null;
}

function computeStatus(starts: string | null, ends: string | null): {
  status: PromoListRow["status"];
  daysToEnd: number | null;
} {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const endsDate = ends ? new Date(ends + "T23:59:59Z") : null;
  const startsDate = starts ? new Date(starts + "T00:00:00Z") : null;
  const daysToEnd = endsDate
    ? Math.ceil((endsDate.getTime() - todayMs) / (24 * 60 * 60 * 1000))
    : null;
  let status: PromoListRow["status"] = "unknown";
  if (startsDate && startsDate.getTime() > todayMs) status = "upcoming";
  else if (endsDate && endsDate.getTime() < todayMs) status = "expired";
  else if (startsDate || endsDate) status = "active";
  return { status, daysToEnd };
}

/** Pick the AccountTier whose family matches the promo's manufacturer.
 *  Family naming convention: "toxins.jeuveau", "fillers.juvederm", etc.
 *  We match by manufacturer keyword in the family path. */
function pickTierForManufacturer(
  tiers: AccountTier[] | undefined,
  manufacturer: string | undefined,
): AccountTier | null {
  if (!tiers || tiers.length === 0 || !manufacturer) return null;
  const m = manufacturer.toLowerCase();
  // Map manufacturer → family keyword we'd see in tier.family.
  const familyKeyword =
    m === "evolus" ? "jeuveau" :
    m === "galderma" ? null :   // Galderma's program is unified, not family-bound
    m === "allergan" || m === "abbvie" ? "juvederm" :
    m === "merz" || m === "merz-aesthetics" ? "xeomin" :
    null;
  if (familyKeyword) {
    const match = tiers.find((t) => t.family?.toLowerCase().includes(familyKeyword));
    if (match) return match;
  }
  // Fallback: first tier (better than nothing for the seed shape).
  return tiers[0] ?? null;
}

// ── listPromotions ────────────────────────────────────────────────────────

const listInput = accessTokenInput.extend({
  viewAs: z.enum(["demo"]).optional(),
});

export const listPromotions = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<PromoListRow[]> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    // Fetch promo nodes + the rep's accounts in parallel — eligible-count
    // is the only join, computed in-memory once.
    const [{ data: promoRows, error: promoErr }, { data: accountRows }] = await Promise.all([
      sb
        .from("knowledge_nodes")
        .select("id, title, lookup_key, attachments")
        .eq("user_id", userId)
        .eq("node_type", "promotion")
        .limit(200),
      sb
        .from("knowledge_nodes")
        .select("attachments")
        .eq("user_id", userId)
        .eq("node_type", "account")
        .limit(500),
    ]);
    if (promoErr) throw new Error(`Couldn't load promotions — ${promoErr.message}`);

    // Per-rep-assignment account counts, computed once.
    const accountsByRep = new Map<string, number>();
    for (const a of accountRows ?? []) {
      const rep = (a.attachments as AccountAttachments | null)?.rep_assignment;
      if (typeof rep === "string") {
        accountsByRep.set(rep, (accountsByRep.get(rep) ?? 0) + 1);
      }
    }

    const rows: PromoListRow[] = (promoRows ?? []).map((p) => {
      const att = (p.attachments ?? {}) as PromotionAttachments;
      const repAssignment = manufacturerToRepAssignment(att.manufacturer);
      const eligibleAccountCount = repAssignment ? (accountsByRep.get(repAssignment) ?? 0) : 0;
      const { status, daysToEnd } = computeStatus(att.starts ?? null, att.ends ?? null);
      return {
        id: p.id,
        title: p.title,
        manufacturer: att.manufacturer ?? null,
        promoKind: (att.promo_kind as PromotionKind | undefined) ?? null,
        starts: att.starts ?? null,
        ends: att.ends ?? null,
        tierCount: Array.isArray(att.tiers) ? att.tiers.length : 0,
        heroImageUrl: att.hero_image_url ?? null,
        status,
        daysToEnd,
        eligibleAccountCount,
      };
    });

    // Sort: active first (by soonest end), then upcoming, then expired.
    const order = { active: 0, upcoming: 1, unknown: 2, expired: 3 } as const;
    rows.sort((a, b) => {
      const o = order[a.status] - order[b.status];
      if (o !== 0) return o;
      // Within same status, soonest ends first.
      const ad = a.daysToEnd ?? Number.POSITIVE_INFINITY;
      const bd = b.daysToEnd ?? Number.POSITIVE_INFINITY;
      return ad - bd;
    });

    return rows;
  });

// ── getPromotionDetail ────────────────────────────────────────────────────

const detailInput = accessTokenInput.extend({
  promotionId: z.string().uuid(),
  viewAs: z.enum(["demo"]).optional(),
});

export const getPromotionDetail = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => detailInput.parse(input))
  .handler(async ({ data }): Promise<PromoDetail> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    const { data: promoRow, error: promoErr } = await sb
      .from("knowledge_nodes")
      .select("id, title, content, lookup_key, attachments")
      .eq("user_id", userId)
      .eq("node_type", "promotion")
      .eq("id", data.promotionId)
      .maybeSingle();
    if (promoErr) throw new Error(`Couldn't load that promotion — ${promoErr.message}`);
    if (!promoRow) {
      throw new Error(
        "Couldn't find that promotion — it may have been removed, or the link is stale.",
      );
    }
    const att = (promoRow.attachments ?? {}) as PromotionAttachments;
    const repAssignment = manufacturerToRepAssignment(att.manufacturer);

    // Eligible accounts: filtered by rep_assignment matching the promo's
    // manufacturer. Galderma promos see ALL galderma-rep accounts; Evolus
    // promos see only evolus-rep accounts; etc. v336 will refine by
    // checking actual product purchase history.
    let eligibleAccounts: PromoEligibleAccount[] = [];
    if (repAssignment) {
      const { data: accountRows } = await sb
        .from("knowledge_nodes")
        .select("id, title, lookup_key, attachments")
        .eq("user_id", userId)
        .eq("node_type", "account")
        .eq("attachments->>rep_assignment", repAssignment)
        .order("title", { ascending: true })
        .limit(500);
      eligibleAccounts = (accountRows ?? []).map((a) => {
        const aatt = (a.attachments ?? {}) as AccountAttachments;
        return {
          id: a.id,
          title: a.title,
          lookupKey: a.lookup_key,
          address: typeof aatt.address === "string" ? aatt.address : undefined,
          contactName: typeof aatt.contact_name === "string" ? aatt.contact_name : undefined,
          contactEmail: typeof aatt.contact_email === "string" ? aatt.contact_email : undefined,
          contactPhone: typeof aatt.contact_phone === "string" ? aatt.contact_phone : undefined,
          currentTier: pickTierForManufacturer(
            aatt.tiers as AccountTier[] | undefined,
            att.manufacturer,
          ),
          repAssignment:
            typeof aatt.rep_assignment === "string"
              ? (aatt.rep_assignment as RepAssignment)
              : undefined,
        };
      });
    }

    // Concurrent promos (cross-linked via attachments.competitor_concurrent).
    let concurrentPromos: PromoDetail["concurrentPromos"] = [];
    if (Array.isArray(att.competitor_concurrent) && att.competitor_concurrent.length > 0) {
      const { data: concurrentRows } = await sb
        .from("knowledge_nodes")
        .select("id, title, lookup_key")
        .eq("user_id", userId)
        .eq("node_type", "promotion")
        .in("lookup_key", att.competitor_concurrent);
      concurrentPromos = (concurrentRows ?? [])
        .filter((r) => r.lookup_key)
        .map((r) => ({ id: r.id, title: r.title, lookupKey: r.lookup_key as string }));
    }

    const { status, daysToEnd } = computeStatus(att.starts ?? null, att.ends ?? null);

    return {
      id: promoRow.id,
      title: promoRow.title,
      content: promoRow.content,
      lookupKey: promoRow.lookup_key,
      meta: {
        manufacturer: att.manufacturer ?? null,
        promoKind: (att.promo_kind as PromotionKind | undefined) ?? null,
        name: att.name ?? null,
        heroImageUrl: att.hero_image_url ?? null,
        sourceUrl: att.source_url ?? null,
        appliesTo: Array.isArray(att.applies_to) ? (att.applies_to as string[]) : [],
        starts: att.starts ?? null,
        ends: att.ends ?? null,
        termsFinePrint: att.terms_fine_print ?? null,
      },
      tiers: Array.isArray(att.tiers) ? att.tiers : [],
      status,
      daysToEnd,
      eligibleAccounts,
      concurrentPromos,
    };
  });

// ── draftPromoBlast (v336) ────────────────────────────────────────────────
// Single-shot Gemini call producing a per-account warm outreach email for
// one promotion. NOT the full Liz agent loop — no tools, no memory-graph
// query, just generate-content with a focused prompt. Why: drafting is
// repetitive (one call per selected account in a blast) and we want
// bounded latency + cost.
//
// The detector layer (v333) doesn't run on these drafts — they're never
// shown to the user as Liz's reply; they're SHOWN AS DRAFTS for the rep
// to review + edit before send. That's the structural safety: rep eyes
// on every draft before delivery.

const DRAFT_SYSTEM_PROMPT = `You are a medical-aesthetics manufacturer sales rep drafting a warm, personal outreach email to one of your practice accounts about a new manufacturer promotion. Your job: produce ONLY a subject line and an email body. Nothing else — no preamble, no signoff editorializing, no markdown headers.

CONSTRAINTS:
- Tone: warm but professional. The practice has a relationship with this rep; this isn't a cold pitch.
- Length: 100-200 words for the body. Short paragraphs. Scannable on a phone.
- Subject: under 80 chars, specific to the practice. Reference the offer + a hook.
- Use the contact name if provided; otherwise address the practice by name.
- Recommend a specific buy-in tier based on the account's current standing — never cite specific volume the rep didn't observe; speak in conditional terms ("if you're tracking toward your usual Q2 volume, X tier would land you...").
- Do NOT claim dollar savings figures the rep can't verify against the promo terms. Quote the per-unit discount or flat-rate price from the tier table verbatim.
- One clear CTA — usually "happy to set up a quick call" or "reply with the tier you want and I'll handle the rest."
- No emojis. No multi-bold-line lists. No "Dear Sir/Madam".
- Sign with literal placeholder "[REP_NAME]" — the system substitutes the rep's real name before send.

OUTPUT FORMAT (parse strictly):
SUBJECT: <subject line>
BODY:
<body paragraphs>`;

// Gemini one-shot caller extracted to src/server/gemini-oneshot.ts (v349)
// so Emma + Lizzie both consume the same HTTP wiring without coupling.

/** Parse the strict SUBJECT/BODY output format. Tolerant of leading
 *  whitespace + a stray newline before "SUBJECT:". */
function parseDraftOutput(raw: string): { subject: string; body: string } {
  const trimmed = raw.trim();
  const subjectMatch = trimmed.match(/^SUBJECT:\s*(.+)$/m);
  const bodyMatch = trimmed.match(/^BODY:\s*([\s\S]+)$/m);
  if (!subjectMatch || !bodyMatch) {
    // Fall back to "treat the whole thing as the body, derive a subject".
    return {
      subject: trimmed.slice(0, 80).split(/\r?\n/)[0] || "Quick note on the latest promo",
      body: trimmed,
    };
  }
  return {
    subject: subjectMatch[1].trim().slice(0, 200),
    body: bodyMatch[1].trim(),
  };
}

/** Pick the tier the account most likely qualifies for, conservatively.
 *  v336 heuristic: cheapest tier (lowest min_units) — gives a friendly
 *  starting recommendation. v337 swaps in real volume-based picks once
 *  we have product-family-scoped order history. */
function recommendTier(tiers: PromotionBuyInTier[]): string | null {
  if (tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => a.min_units - b.min_units);
  return sorted[0].code;
}

function summarizeTierForPrompt(t: PromotionBuyInTier): string {
  const range = typeof t.max_units === "number"
    ? `${t.min_units}-${t.max_units} units`
    : `${t.min_units}+ units`;
  const priceClause =
    typeof t.flat_price_per_unit_usd === "number"
      ? `$${t.flat_price_per_unit_usd}/unit flat`
      : typeof t.discount_per_unit_usd === "number"
        ? `$${t.discount_per_unit_usd} off per unit`
        : "pricing unspecified";
  const goods = (t.physical_goods ?? [])
    .map((g) => `${g.quantity}× ${g.kind}`)
    .join(", ");
  const rewards = typeof t.rewards_credit_usd === "number" ? `$${t.rewards_credit_usd} rewards credit` : "";
  return [
    `- ${t.code} (${t.label}, ${range}): ${priceClause}`,
    goods ? `  bundled: ${goods}` : null,
    rewards ? `  ${rewards}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const draftInput = accessTokenInput.extend({
  promotionId: z.string().uuid(),
  accountId: z.string().uuid(),
  viewAs: z.enum(["demo"]).optional(),
});

export type PromoDraftResult = {
  subject: string;
  body: string;
  recommendedTierCode: string | null;
  /** Account email pre-resolved from the account node, if present. UI
   *  uses this to pre-fill the "To" field. */
  to: string | null;
};

export const draftPromoBlast = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => draftInput.parse(input))
  .handler(async ({ data }): Promise<PromoDraftResult> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    const [{ data: promoRow }, { data: accountRow }] = await Promise.all([
      sb
        .from("knowledge_nodes")
        .select("title, attachments")
        .eq("user_id", userId)
        .eq("node_type", "promotion")
        .eq("id", data.promotionId)
        .maybeSingle(),
      sb
        .from("knowledge_nodes")
        .select("title, attachments")
        .eq("user_id", userId)
        .eq("node_type", "account")
        .eq("id", data.accountId)
        .maybeSingle(),
    ]);
    if (!promoRow) throw new Error("Promotion not found.");
    if (!accountRow) throw new Error("Account not found.");

    const promoAtt = (promoRow.attachments ?? {}) as PromotionAttachments;
    const accountAtt = (accountRow.attachments ?? {}) as AccountAttachments;
    const tiers = Array.isArray(promoAtt.tiers) ? (promoAtt.tiers as PromotionBuyInTier[]) : [];
    const currentTier = pickTierForManufacturer(
      accountAtt.tiers as AccountTier[] | undefined,
      promoAtt.manufacturer,
    );
    const recommended = recommendTier(tiers);

    const tierBlock = tiers.length > 0
      ? tiers.map(summarizeTierForPrompt).join("\n")
      : "(no structured tier ladder)";

    const userPrompt = `ACCOUNT:
- Practice: ${accountRow.title}
- Address: ${typeof accountAtt.address === "string" ? accountAtt.address : "(not on file)"}
- Primary contact: ${typeof accountAtt.contact_name === "string" ? accountAtt.contact_name : "(not on file)"}
- Current tier with ${promoAtt.manufacturer ?? "this manufacturer"}: ${currentTier ? `${currentTier.tier} (${currentTier.family ?? "family unspecified"})` : "(no tier on file)"}

PROMOTION:
- Name: ${promoRow.title}
- Manufacturer: ${promoAtt.manufacturer ?? "(unspecified)"}
- Kind: ${promoAtt.promo_kind ?? "promotion"}
- Period: ${promoAtt.starts ?? "(no start date)"} → ${promoAtt.ends ?? "(no end date)"}
- Description: ${(promoAtt.description as string | undefined) ?? promoRow.title}

TIER LADDER:
${tierBlock}

RECOMMENDED TIER FOR THIS ACCOUNT: ${recommended ?? "(none — promo has no tier ladder)"}

${Array.isArray(promoAtt.competitor_concurrent) && promoAtt.competitor_concurrent.length > 0
  ? `NOTE: There is a concurrent ${promoAtt.manufacturer ?? "manufacturer"} promo. If it could pair well at this account's volume, briefly mention you can walk through both options — don't quote specifics from the other promo, just acknowledge it exists.\n\n`
  : ""}Draft the subject + body now.`;

    const raw = await callGeminiOneShot(DRAFT_SYSTEM_PROMPT, userPrompt);
    const { subject, body } = parseDraftOutput(raw);

    return {
      subject,
      body,
      recommendedTierCode: recommended,
      to: typeof accountAtt.contact_email === "string" ? accountAtt.contact_email : null,
    };
  });

// ── sendPromoBlast (v336) ─────────────────────────────────────────────────
// Mirrors the v323 sendSampleOrderEmail pattern: validate auth, render an
// HTML email, send via Resend, persist the state row + outreach row.
//
// Refuses viewAs=demo at the server layer (defense-in-depth — the demo
// tenant should never get accidental real emails sent on its behalf).
//
// Per the v336 spec scope, NO landing page yet — the email body has the
// rep's text + a reply-back CTA. Practice-facing /promo/<token> landing
// surface is v337.

const FROM_EMAIL_PROMO = "Lizzie <orders@notify.openagentic.site>";

// Apex hostname for the public promo landing page. Same brand-neutral
// rationale as the v325 sample-order landing — practice owners shouldn't
// have to puzzle out a subdomain.
const PUBLIC_SITE_ORIGIN = "https://agentiport.com";

const sendBlastInput = accessTokenInput.extend({
  promotionId: z.string().uuid(),
  accountId: z.string().uuid(),
  to: z.string().email("Practice email looks invalid — double-check the address."),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  recommendedTierCode: z.string().min(1).max(60).nullable().optional(),
  viewAs: z.enum(["demo"]).optional(),
});

export type SendPromoBlastResult = {
  ok: true;
  emailId: string | null;
  sentAt: string;
  stateId: string;
  /** v337: public landing-page URL the practice opens to confirm a tier. */
  promoUrl: string;
  /** v337: token for the promo_intents row. UI joins to surface
   *  Opened/Confirmed badges on the per-account composer row. */
  intentToken: string;
};

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPromoBlastHtml(input: {
  body: string;
  practiceTitle: string;
  promoTitle: string;
  repName: string;
  promoUrl: string;
}): string {
  const { body, practiceTitle, promoTitle, repName, promoUrl } = input;
  const bodyHtml = escapeHtml(body)
    .split("\n\n")
    .map((para) => `<p style="margin:0 0 14px 0;">${para.replaceAll("\n", "<br>")}</p>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(promoTitle)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d293d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7fb;">
  <tr><td align="center" style="padding:24px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;border:1px solid #e2e7f0;overflow:hidden;">
      <tr><td style="padding:28px 32px 6px 32px;">
        <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#6b7280;font-weight:600;">${escapeHtml(promoTitle)}</div>
        <div style="font-size:22px;font-weight:600;color:#0f172a;margin-top:4px;">${escapeHtml(practiceTitle)}</div>
        <div style="font-size:13px;color:#52607a;margin-top:2px;">A note from ${escapeHtml(repName)}</div>
      </td></tr>
      <tr><td style="padding:18px 32px 6px 32px;font-size:15px;line-height:1.55;color:#1d293d;">
        ${bodyHtml}
      </td></tr>
      <tr><td align="center" style="padding:14px 32px 6px 32px;">
        <a href="${escapeHtml(promoUrl)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:8px;letter-spacing:0.1px;">Review &amp; pick your tier →</a>
      </td></tr>
      <tr><td align="center" style="padding:0 32px 24px 32px;">
        <div style="font-size:12px;color:#52607a;">Or open: <a href="${escapeHtml(promoUrl)}" style="color:#1d4ed8;text-decoration:underline;">${escapeHtml(promoUrl)}</a></div>
      </td></tr>
      <tr><td style="padding:14px 32px 22px 32px;border-top:1px solid #eef0f6;">
        <div style="font-size:11px;color:#6b7280;line-height:1.5;">Click the link above to pick your tier and confirm. You can also reply directly to talk through options.</div>
      </td></tr>
    </table>
    <div style="font-size:11px;color:#9aa3b2;margin-top:12px;">Sent via Lizzie(OS) · agentiport.com</div>
  </td></tr>
</table>
</body>
</html>`;
}

async function resolveRepName(
  sb: ReturnType<typeof admin>,
  userId: string,
): Promise<{ name: string; email: string | null }> {
  try {
    const { data: u } = await sb.auth.admin.getUserById(userId);
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const candidate =
      typeof meta.full_name === "string" ? meta.full_name
      : typeof meta.name === "string" ? meta.name
      : typeof meta.display_name === "string" ? meta.display_name
      : null;
    return {
      name: (candidate && candidate.trim()) || u?.user?.email || "Your medical-aesthetics rep",
      email: u?.user?.email ?? null,
    };
  } catch {
    return { name: "Your medical-aesthetics rep", email: null };
  }
}

function generatePublicToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export const sendPromoBlast = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => sendBlastInput.parse(input))
  .handler(async ({ data }): Promise<SendPromoBlastResult> => {
    if (data.viewAs === "demo") {
      throw new Error("Demo mode is read-only. Exit demo to send real promos.");
    }
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) {
      throw new Error("Email isn't configured on the server (missing RESEND_API_KEY).");
    }
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Confirm the promo + account both belong to this rep.
    const [{ data: promoRow }, { data: accountRow }] = await Promise.all([
      sb
        .from("knowledge_nodes")
        .select("id, title, content, attachments")
        .eq("user_id", userId)
        .eq("node_type", "promotion")
        .eq("id", data.promotionId)
        .maybeSingle(),
      sb
        .from("knowledge_nodes")
        .select("id, title, attachments")
        .eq("user_id", userId)
        .eq("node_type", "account")
        .eq("id", data.accountId)
        .maybeSingle(),
    ]);
    if (!promoRow) throw new Error("Promotion not found.");
    if (!accountRow) throw new Error("Account not found.");

    const { name: repName, email: repEmail } = await resolveRepName(sb, userId);

    // Substitute the [REP_NAME] placeholder Liz left in the draft.
    const finalBody = data.body.replaceAll("[REP_NAME]", repName);
    const finalSubject = data.subject.replaceAll("[REP_NAME]", repName);

    // v337: mint the promo intent BEFORE Resend send. The landing page URL
    // we embed in the email points at this token. Freeze the snapshot here
    // so the practice owner always sees what the rep approved, regardless
    // of later prompt/schema drift.
    const promoAtt = (promoRow.attachments ?? {}) as PromotionAttachments;
    const accountAtt = (accountRow.attachments ?? {}) as AccountAttachments;
    const accountCurrentTier = pickTierForManufacturer(
      accountAtt.tiers as AccountTier[] | undefined,
      promoAtt.manufacturer,
    );
    const intentToken = generatePublicToken();
    const promoUrl = `${PUBLIC_SITE_ORIGIN}/promo/${intentToken}`;
    const snapshot = {
      promo: {
        title: promoRow.title,
        manufacturer: promoAtt.manufacturer ?? null,
        promoKind: promoAtt.promo_kind ?? null,
        description: typeof promoAtt.description === "string" ? promoAtt.description : promoRow.content ?? null,
        starts: promoAtt.starts ?? null,
        ends: promoAtt.ends ?? null,
        heroImageUrl: promoAtt.hero_image_url ?? null,
        sourceUrl: promoAtt.source_url ?? null,
        tiers: Array.isArray(promoAtt.tiers) ? (promoAtt.tiers as PromotionBuyInTier[]) : [],
        termsFinePrint: promoAtt.terms_fine_print ?? null,
      },
      account: {
        title: accountRow.title,
        address: typeof accountAtt.address === "string" ? accountAtt.address : null,
        contactName: typeof accountAtt.contact_name === "string" ? accountAtt.contact_name : null,
        currentTier: accountCurrentTier
          ? { tier: accountCurrentTier.tier, family: accountCurrentTier.family ?? "" }
          : null,
      },
      recommendedTierCode: data.recommendedTierCode ?? null,
    };
    const { error: intentErr } = await sb.from("promo_intents").insert({
      token: intentToken,
      rep_user_id: userId,
      promotion_node_id: promoRow.id,
      account_node_id: accountRow.id,
      snapshot: snapshot as unknown as Json,
      practice_email: data.to,
      rep_name: repName,
      rep_email: repEmail ?? null,
    });
    if (intentErr) {
      throw new Error(`Couldn't prep the promo link — ${intentErr.message}`);
    }

    // Compose text + HTML email bodies with the public URL appended.
    const textBody = `${finalBody.trimEnd()}\n\nReview and confirm the offer:\n${promoUrl}\n`;
    const htmlBody = renderPromoBlastHtml({
      body: finalBody,
      practiceTitle: accountRow.title,
      promoTitle: promoRow.title,
      repName,
      promoUrl,
    });

    // Send via Resend.
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL_PROMO,
        to: [data.to],
        // v338.1: gate the plus-address Reply-To behind whether the inbound
        // webhook secret is configured on the Worker. When set, config is
        // complete and replies route through Lizzie. When unset (e.g. before
        // the Resend dashboard + DNS config lands), fall back to the rep's
        // personal email — pre-v338 behavior, no silent reply loss. The
        // gate self-heals: setting RESEND_WEBHOOK_SECRET as the last config
        // step flips this on automatically with no code change.
        reply_to: process.env.RESEND_WEBHOOK_SECRET
          ? [`reply+${intentToken}@${REPLY_DOMAIN}`]
          : (repEmail ?? undefined),
        subject: finalSubject,
        text: textBody,
        html: htmlBody,
        tags: [
          { name: "type", value: "promo-blast" },
          { name: "promotion_id", value: promoRow.id },
          { name: "account_id", value: accountRow.id },
          { name: "intent_token", value: intentToken },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`Resend rejected the send (${res.status}). ${msg.slice(0, 200)}`);
    }
    const sendResp = (await res.json().catch(() => ({}))) as { id?: string };
    const emailId = sendResp.id ?? null;
    const sentAt = new Date().toISOString();

    // Upsert promotion_account_state (state='outreached') — keep prior
    // committed/ordered states intact, never regress backwards.
    const { data: existingState } = await sb
      .from("promotion_account_state")
      .select("id, state")
      .eq("user_id", userId)
      .eq("promotion_node_id", promoRow.id)
      .eq("account_node_id", accountRow.id)
      .maybeSingle();
    const PROGRESS_ORDER = [
      "targeted", "outreached", "engaged", "meeting_scheduled",
      "meeting_done", "committed", "ordered", "fulfilled",
      "closed_won", "closed_lost", "opted_out",
    ];
    let stateId: string;
    if (existingState) {
      // Only advance state if the new send moves us forward (or keep at
      // outreached). Don't backtrack a committed account to outreached.
      const currentIdx = PROGRESS_ORDER.indexOf(existingState.state);
      const outreachedIdx = PROGRESS_ORDER.indexOf("outreached");
      const nextState = currentIdx > outreachedIdx ? existingState.state : "outreached";
      await sb
        .from("promotion_account_state")
        .update({
          state: nextState,
          last_touched_at: sentAt,
          updated_at: sentAt,
        })
        .eq("id", existingState.id);
      stateId = existingState.id;
    } else {
      const { data: newState, error: insErr } = await sb
        .from("promotion_account_state")
        .insert({
          user_id: userId,
          promotion_node_id: promoRow.id,
          account_node_id: accountRow.id,
          state: "outreached",
          committed_tier_code: data.recommendedTierCode ?? null,
          last_touched_at: sentAt,
        })
        .select("id")
        .single();
      if (insErr || !newState) {
        throw new Error(`Couldn't record promo state: ${insErr?.message ?? "no row"}`);
      }
      stateId = newState.id;
    }

    // Log the outbound outreach. intent_token surfaced so the UI can join
    // back to promo_intents for Opened/Confirmed badges. email_id stored
    // both on the column (v338, for indexed In-Reply-To fallback) and in
    // metadata (backwards-compat for any v336/v337 reads).
    const { error: outreachErr } = await sb.from("promotion_outreach").insert({
      user_id: userId,
      state_id: stateId,
      kind: "email",
      direction: "outbound",
      subject: finalSubject,
      body: finalBody,
      sent_at: sentAt,
      intent_token: intentToken,
      email_id: emailId,
      metadata: { email_id: emailId, to: data.to } as unknown as Json,
    });
    if (outreachErr) {
      console.warn("[promo-blast] couldn't persist outreach log:", outreachErr.message);
    }

    return { ok: true, emailId, sentAt, stateId, promoUrl, intentToken };
  });

// ── listPromoOutreachStatesByPromo (v336) ─────────────────────────────────
// Loads existing state rows for one promo so the UI can mark which accounts
// have already been outreached (and what state they're in). Returns a
// compact shape — full state history lives behind the per-state drill-in
// which ships in a later phase.

const statesByPromoInput = accessTokenInput.extend({
  promotionId: z.string().uuid(),
  viewAs: z.enum(["demo"]).optional(),
});

export type AccountOutreachState = {
  accountId: string;
  state: string;
  lastTouchedAt: string | null;
  committedTierCode: string | null;
  /** v337: intent-side state for the landing page. Most recent intent
   *  wins when an account has multiple sends. */
  intentFirstViewedAt?: string | null;
  intentConfirmedAt?: string | null;
  intentConfirmedTierCode?: string | null;
  intentConfirmedByName?: string | null;
  intentToken?: string | null;
};

export const listPromoOutreachStates = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => statesByPromoInput.parse(input))
  .handler(async ({ data }): Promise<AccountOutreachState[]> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    const [{ data: stateRows, error }, { data: intentRows }] = await Promise.all([
      sb
        .from("promotion_account_state")
        .select("account_node_id, state, last_touched_at, committed_tier_code")
        .eq("user_id", userId)
        .eq("promotion_node_id", data.promotionId),
      sb
        .from("promo_intents")
        .select("account_node_id, token, first_viewed_at, confirmed_at, confirmed_tier_code, confirmed_by_name, sent_at")
        .eq("rep_user_id", userId)
        .eq("promotion_node_id", data.promotionId)
        .order("sent_at", { ascending: false }),
    ]);
    if (error) throw new Error(`Couldn't load outreach states — ${error.message}`);

    // Build a map of accountId → most-recent intent (intent rows ordered
    // sent_at desc, so the first one we see per account wins).
    const intentByAccount = new Map<string, NonNullable<typeof intentRows>[number]>();
    for (const ir of intentRows ?? []) {
      if (ir.account_node_id && !intentByAccount.has(ir.account_node_id)) {
        intentByAccount.set(ir.account_node_id, ir);
      }
    }

    return (stateRows ?? []).map((r) => {
      const intent = intentByAccount.get(r.account_node_id);
      return {
        accountId: r.account_node_id,
        state: r.state,
        lastTouchedAt: r.last_touched_at,
        committedTierCode: r.committed_tier_code,
        intentFirstViewedAt: intent?.first_viewed_at ?? null,
        intentConfirmedAt: intent?.confirmed_at ?? null,
        intentConfirmedTierCode: intent?.confirmed_tier_code ?? null,
        intentConfirmedByName: intent?.confirmed_by_name ?? null,
        intentToken: intent?.token ?? null,
      };
    });
  });

// ── routeInboundPromoReply (v338) ─────────────────────────────────────────
//
// Server-internal entry point for the Resend inbound webhook handler.
// Called from /api/resend/inbound after signature verification + body
// fetch. Handles:
//   - Webhook-replay idempotency (resend_email_id uniqueness)
//   - Plus-address routing via intent_token (primary)
//   - In-Reply-To header routing via promotion_outreach.email_id (fallback)
//   - Unmatched landing in inbox_unmatched (manual link UI = v339)
//   - State transition: outreached → engaged on first reply
//
// The state transition is one-way: states that have progressed beyond
// 'engaged' (committed, ordered, fulfilled, ...) stay where they are —
// a follow-up reply doesn't regress the funnel.

export type RouteInboundResult =
  | { ok: true; matched: true; inboundOutreachId: string; stateId: string; promotedToEngaged: boolean }
  | { ok: true; matched: false; unmatchedId: string }
  | { ok: true; idempotent: true; existingOutreachId: string };

export async function routeInboundPromoReply(input: {
  resendEmailId: string;
  intentToken: string | null;
  fromAddr: string;
  toAddr: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  inReplyTo: string | null;
  headers: Record<string, string>;
}): Promise<RouteInboundResult> {
  const sb = admin();

  // 1. Idempotency — webhook retries (Resend retries on non-2xx) must not
  //    create duplicate inbound rows.
  const { data: priorInbound } = await sb
    .from("promotion_outreach")
    .select("id")
    .eq("email_id", input.resendEmailId)
    .eq("direction", "inbound")
    .limit(1)
    .maybeSingle();
  if (priorInbound) {
    return { ok: true, idempotent: true, existingOutreachId: priorInbound.id };
  }

  // 2. Find the parent outbound outreach row.
  type ParentRow = { id: string; user_id: string; state_id: string };
  let parent: ParentRow | null = null;

  if (input.intentToken) {
    // Primary: plus-addressing routing.
    const { data } = await sb
      .from("promotion_outreach")
      .select("id, user_id, state_id")
      .eq("intent_token", input.intentToken)
      .eq("direction", "outbound")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) parent = data as ParentRow;
  }

  if (!parent && input.inReplyTo) {
    // Fallback: In-Reply-To header → outbound email_id correlation.
    const { data } = await sb
      .from("promotion_outreach")
      .select("id, user_id, state_id")
      .eq("email_id", input.inReplyTo)
      .eq("direction", "outbound")
      .limit(1)
      .maybeSingle();
    if (data) parent = data as ParentRow;
  }

  // 3a. Unmatched — both routing paths missed. Land in inbox_unmatched so
  //     the rep can manually link from the inbox UI (v339).
  if (!parent) {
    // Can't attribute to a user without the parent row; the webhook
    // payload's `to[]` plus-address resolves at the manufacturer level
    // (everyone's reply lands in the same MX bucket). Best-effort: leave
    // user_id null isn't allowed by schema, so we drop the row entirely
    // when we have no rep to attribute it to. Resolution: webhook
    // returns 200 (acknowledge) and we log to console.
    //
    // FUTURE: if we ever ship multi-rep tenants, intent_token presence
    // is the only reliable rep attribution we have. Without it, we
    // can't safely route — and inserting under the wrong rep's user_id
    // would leak email content across the multi-tenant boundary
    // (project_security_privacy_posture).
    console.warn(
      `[resend-inbound] unmatched reply: email_id=${input.resendEmailId} from=${input.fromAddr} to=${input.toAddr} — no intent_token + no In-Reply-To match. Dropping.`,
    );
    // No DB row inserted; the webhook still returns 200 so Resend doesn't retry.
    // Use a synthetic id to satisfy the discriminated-union return shape.
    return { ok: true, matched: false, unmatchedId: "(dropped, no rep attribution)" };
  }

  // 3b. Insert the inbound outreach row.
  const nowIso = new Date().toISOString();
  const { data: inserted, error: insErr } = await sb
    .from("promotion_outreach")
    .insert({
      user_id: parent.user_id,
      state_id: parent.state_id,
      kind: "email",
      direction: "inbound",
      subject: input.subject ?? "",
      body: (input.bodyText ?? input.bodyHtml ?? "").slice(0, 100_000),
      sent_at: nowIso,
      responded_at: nowIso,
      response_body: input.bodyText ?? null,
      email_id: input.resendEmailId,
      in_reply_to: input.inReplyTo ?? null,
      metadata: {
        from: input.fromAddr,
        to: input.toAddr,
        parent_outreach_id: parent.id,
        routed_by: input.intentToken ? "plus-address" : "in-reply-to",
      } as unknown as Json,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    throw new Error(`Couldn't insert inbound outreach: ${insErr?.message ?? "no row"}`);
  }

  // 3c. Stamp responded_at on the parent outbound row too, so the timeline
  //     view can show "replied N hours after send" without a sibling lookup.
  await sb
    .from("promotion_outreach")
    .update({ responded_at: nowIso })
    .eq("id", parent.id);

  // 3d. Promote parent state: outreached → engaged (one-way, never regress).
  //     States beyond engaged (meeting_scheduled, committed, ordered, ...)
  //     stay put — a follow-up reply doesn't roll back the funnel.
  const { data: parentState } = await sb
    .from("promotion_account_state")
    .select("state")
    .eq("id", parent.state_id)
    .maybeSingle();
  let promotedToEngaged = false;
  if (parentState?.state === "outreached" || parentState?.state === "targeted") {
    await sb
      .from("promotion_account_state")
      .update({
        state: "engaged",
        last_touched_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", parent.state_id);
    promotedToEngaged = true;
  } else {
    // Past engaged already — just bump last_touched_at so stale-detector
    // doesn't ping the rep about an account that just replied.
    await sb
      .from("promotion_account_state")
      .update({ last_touched_at: nowIso, updated_at: nowIso })
      .eq("id", parent.state_id);
  }

  // 3e. v339: fire-and-mostly-forget auto-draft generation. Synchronous so
  //     the draft is in the DB by the time the inbox UI refreshes, but
  //     wrapped in try/catch — a Gemini timeout or schema mismatch should
  //     NEVER 500 the webhook (Resend would retry forever). Worst case:
  //     the draft is missing, rep writes reply from scratch.
  try {
    await generateInboundReplyDraft(inserted.id);
  } catch (e) {
    console.warn(
      `[resend-inbound] auto-draft generation failed for outreach=${inserted.id}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  return {
    ok: true,
    matched: true,
    inboundOutreachId: inserted.id,
    stateId: parent.state_id,
    promotedToEngaged,
  };
}

// ── generateInboundReplyDraft (v339) ───────────────────────────────────────
//
// When a promo reply lands, Liz pre-drafts the rep's first-line response.
// The rep reviews, edits if needed, and one-clicks Send in /app/rep/inbox.
//
// Architecture: LLM produces prose + a tier recommendation. CODE produces
// the [VERIFIED] math block by looking up the recommended tier in the
// promo's structured tier ladder. This is the v337 [VERIFIED] convention
// extended to promo math (per [[project-verified-line-convention]] +
// [[feedback-math-must-be-exact]]): facts in VERIFIED come from data,
// not from the LLM. The LLM can't fabricate a savings figure — at worst it
// recommends a tier that doesn't exist (which we catch + fall back on).
//
// Called synchronously from the inbound webhook handler after the inbound
// row is inserted. Wrapped in try/catch by the caller so a draft failure
// never 500s the webhook.

/** v339.7 — per-rep tier-recommendation policy. Hybrid model locked
 *  2026-05-14 (see project_tier_recommendation_policy memory). Stored on
 *  user_preferences.rep_tier_policy; NULL is treated as 'balanced'. */
export type RepTierPolicy = "conservative" | "balanced" | "aggressive";

/** Resolve the rep's tier policy. Returns 'balanced' on any error or
 *  missing row — the default selling style is brand-safe for everyone. */
async function getRepTierPolicy(
  sb: ReturnType<typeof admin>,
  userId: string,
): Promise<RepTierPolicy> {
  try {
    const { data } = await sb
      .from("user_preferences")
      .select("rep_tier_policy")
      .eq("user_id", userId)
      .maybeSingle();
    const v = (data as { rep_tier_policy?: string | null } | null)?.rep_tier_policy;
    if (v === "conservative" || v === "balanced" || v === "aggressive") return v;
    return "balanced";
  } catch {
    return "balanced";
  }
}

/** The TIER CHOICE block injected into REPLY_SYSTEM_PROMPT, swapped by
 *  policy. The math chip stays code-computed in all modes — only Liz's
 *  judgment about WHICH tier code to recommend changes. */
function tierChoiceBlockForPolicy(policy: RepTierPolicy): string {
  if (policy === "conservative") {
    return `TIER CHOICE — CONSERVATIVE / MATCH EXACTLY: Pick the tier whose band the practice's stated volume sits clearly inside. Do NOT stretch them upward. If they say "40-50 vials" and the bands are 25-49 vs 50-99, recommend the 25-49 tier (the lower one) — they're closer to the middle of that band than the floor of the next. You may mention the next tier exists ("the next band up is 50-99 if you ever scale there"), but only as information, never as a pitch. Tone is matter-of-fact and trust-first.`;
  }
  if (policy === "aggressive") {
    return `TIER CHOICE — AGGRESSIVE / STRETCH UP: When a higher tier exists above the practice's stated volume, recommend the higher tier and frame it as a smart move. Example: they say "40-50 vials," bands are 25-49 vs 50-99 — recommend 50-99 as the play, note the rewards/bundle math favors stretching. Confident, never apologetic. Still no exclamation points, still no pressure language — frame as "the math works in your favor at the higher band," not "you should buy more."`;
  }
  // balanced (default)
  return `TIER CHOICE — BALANCED / NEVER PUSHY: Pick ONE tier from the ladder. The default is to match the practice's stated/implied volume. EXCEPTION (the stretch zone): when their stated volume is within ~20% of the next tier's floor, recommend the next tier and frame it as opportunity, not pressure ("you'd unlock 7QUEEN at 50 vials — worth a stretch if the quarter looks strong"). Outside that 20% zone, match exactly and mention the higher tier as informational only. Examples: practice says "40-50 vials," next band starts at 50 → recommend 7QUEEN (within stretch zone, 50 is within 20% of 40-50). Practice says "30 vials," next band at 50 → recommend 7ACE (30 is not within 20% of 50). Never use "you should," always use "you'd unlock" / "you'd land at" / "worth a stretch if."`;
}

function buildReplySystemPrompt(policy: RepTierPolicy): string {
  return `You are a medical-aesthetics sales rep drafting a TERSE, practical reply to a practice owner who responded to a promo outreach. You are NOT a customer service bot. You are NOT enthusiastic. You are a working rep who answers questions and moves the deal forward — warm enough to keep the relationship, lean enough to respect the practice's time.

ABSOLUTE BANS — never use any of these phrases or anything like them:
- "Great to hear from you"
- "Thanks for reaching out"
- "I'm so glad you're interested"
- "What a fantastic question"
- "I appreciate your interest"
- "Absolutely!" / "Of course!" / "Definitely!"
- "It's a fantastic promotion"
- "I'd love to" / "I'd be happy to"
- ANY enthusiasm opener that takes a full sentence
- ANY filler pleasantry

STRUCTURE — THE BODY MUST CONTAIN ALL FIVE LINES BELOW, IN THIS ORDER, NO EXCEPTIONS. Skipping any line is a hard failure. Greeting alone is NOT a complete reply.

LINE 1 — Greeting (mandatory): "Hi <FirstName> —" if a contact first name is provided in the prompt context; otherwise "Hey —". Just the greeting. No "Hope you're well."
LINE 2 — Tier recommendation (mandatory): the primary answer. Lead with the tier code. Example: "For 40-50 vials/qtr you're sitting right at 7QUEEN."
LINE 3 — Secondary answer (mandatory if practice asked a secondary question; otherwise a short relevant clarifier). Specific. Direct.
LINE 4 — Next-action CTA (mandatory). Pick ONE: "Want me to send the order form?" / "I can have this teed up in 10 min — just say go." / "Happy to jump on a quick call to lock it in."
LINE 5 — Signoff (mandatory): MUST be the literal token [REP_NAME] on its own line. Output exactly those 9 characters (open-bracket R E P underscore N A M E close-bracket). NEVER substitute a real first name, NEVER add "Best," / "Thanks," / "Cheers,". Even if the practice's reply mentions a rep by name (e.g. "Hi Liz,"), DO NOT echo that name in the signoff — output the literal [REP_NAME] token. The system substitutes the real rep at send-time.

EXAMPLE OF A COMPLETE BODY (this is what your output should look like — same shape, different facts):
Hi Karen —

For 80-100 vials/qtr you're sitting right at 7KING.

Scrubs ship with the vials, same PO — one package, one delivery date.

Want me to send the order form?

[REP_NAME]

SECOND EXAMPLE — note the signoff stays [REP_NAME] even though the practice addressed the rep by name:
Practice's reply opens with: "Hi Liz — thanks for the heads up..."
Your draft signoff is STILL: [REP_NAME] (never "Liz", never any real name)

LENGTH: 50-90 words TOTAL across all 5 lines. Tighter is better. Phones are small. But all 5 lines must be present.

${tierChoiceBlockForPolicy(policy)}

DO NOT:
- Quote dollar figures — the system attaches a separate [VERIFIED] math block with exact numbers. Reference the tier qualitatively.
- Restate what they said back to them ("So you're looking at 40-50 vials…"). They KNOW what they said.
- Apologize, hedge, or use "just" / "really" / "actually".
- Use exclamation points.

OUTPUT FORMAT (parse strictly — all three sections required):
SUBJECT: Re: <specific phrase tied to their question, 4-7 words>
BODY:
<the 5 lines per structure above>
RECOMMENDED_TIER: <one tier code from the ladder>`;
}

/** Parse the v339 SUBJECT/BODY/RECOMMENDED_TIER triple. Tolerant of leading
 *  whitespace and trailing junk. Falls back gracefully on missing fields.
 *
 *  v339.6: rewrote body extraction with indexOf instead of regex. The old
 *  regex `^BODY:\s*([\s\S]+?)(?:^RECOMMENDED_TIER:|\s*$)/m` was lazy AND
 *  treated any blank line (\s*$ with multiline flag) as a terminator, so
 *  it dropped everything after the first blank line in the body. Worked by
 *  accident through v339.4 because Liz's terse drafts had no internal
 *  blank lines; broke on v339.5's properly-formatted multi-line bodies. */
function parseReplyDraftOutput(raw: string): { subject: string; body: string; tierCode: string | null } {
  const trimmed = raw.trim();

  const subjectMatch = trimmed.match(/^SUBJECT:\s*(.+)$/m);
  const tierMatch = trimmed.match(/^RECOMMENDED_TIER:\s*([A-Za-z0-9_-]+)/m);

  // Extract body via marker indexing: everything between "BODY:" and the
  // RECOMMENDED_TIER: line (exclusive). Handles internal blank lines without
  // dropping content past the first paragraph break.
  let body = trimmed;
  const bodyIdx = trimmed.indexOf("BODY:");
  const tierIdx = trimmed.indexOf("RECOMMENDED_TIER:");
  if (bodyIdx !== -1) {
    const bodyStart = bodyIdx + "BODY:".length;
    const bodyEnd = tierIdx !== -1 && tierIdx > bodyStart ? tierIdx : trimmed.length;
    body = trimmed.slice(bodyStart, bodyEnd).trim();
  }

  return {
    subject: subjectMatch ? subjectMatch[1].trim().slice(0, 200) : "Re: your promo question",
    body,
    tierCode: tierMatch ? tierMatch[1].trim() : null,
  };
}

/** Structured [VERIFIED] block surfaced as a chip in the inbox UI. All
 *  fields come from CODE looking up the promo's tier ladder — never from
 *  the LLM. This is the math-fidelity guarantee. */
export type DraftVerifiedBlock = {
  promo_id: string;
  promo_title: string;
  manufacturer: string;
  /** Tier code the LLM recommended, AFTER validation against the promo's
   *  actual tier ladder. If the LLM hallucinated a code, we fell back to
   *  the lowest-min-units tier and record that here. */
  recommended_tier_code: string;
  /** Tier label copied verbatim from promo data (e.g. "Buy 50-99 vials"). */
  recommended_tier_label: string;
  /** The tier's savings clause copied verbatim from data ("$7 off per unit",
   *  "$370/vial flat", "$80 rewards credit + 2 scrubs"). */
  recommended_tier_clause: string;
  /** True if the LLM-proposed tier matched a real tier; false if we had
   *  to fall back. Surfaced in the UI so the rep knows when Liz reached. */
  llm_tier_was_valid: boolean;
  /** ISO timestamp the draft was generated. */
  generated_at: string;
};

function describeTierClauseForVerified(t: PromotionBuyInTier): string {
  const range = typeof t.max_units === "number"
    ? `${t.min_units}-${t.max_units} units`
    : `${t.min_units}+ units`;
  const parts: string[] = [];
  if (typeof t.flat_price_per_unit_usd === "number") {
    parts.push(`$${t.flat_price_per_unit_usd}/unit flat`);
  } else if (typeof t.discount_per_unit_usd === "number") {
    parts.push(`$${t.discount_per_unit_usd} off per unit`);
  }
  if ((t.physical_goods ?? []).length > 0) {
    const goods = (t.physical_goods ?? [])
      .map((g) => `${g.quantity}× ${g.kind}`)
      .join(", ");
    parts.push(goods);
  }
  if (typeof t.rewards_credit_usd === "number") {
    parts.push(`$${t.rewards_credit_usd} rewards credit`);
  }
  return parts.length > 0 ? `${range} → ${parts.join(", ")}` : range;
}

/** v339.7 — Belt-and-suspenders enforcement of the [REP_NAME] signoff.
 *  The prompt instructs Gemini to use the literal token, but it occasionally
 *  echoes a real first name from the practice's reply ("Hi Liz —" → signs
 *  "Liz"). This helper inspects the last non-empty line: if it's not already
 *  the literal [REP_NAME] but matches a name-signoff shape (1-3 short
 *  letter-only tokens), replace it with [REP_NAME]. Whitespace + trailing
 *  punctuation tolerated. Conservative — only fires on clear signoff shapes,
 *  never touches normal sentences. */
function enforceRepNamePlaceholder(body: string): string {
  if (!body) return body;
  if (body.includes("[REP_NAME]")) return body;

  const lines = body.split("\n");
  // Walk from the end, find the last non-empty line.
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) return body;

  const lastLine = lines[lastIdx].trim();
  // Strip trailing punctuation that sometimes follows a name signoff (",", ".", "—").
  const stripped = lastLine.replace(/[.,;:—–-]+\s*$/u, "").trim();

  // Match 1-3 capitalized name tokens (e.g. "Liz", "Liz Kunze", "Mary-Beth"),
  // each 2-20 letters. Conservative — avoids matching sentence remnants.
  const looksLikeNameSignoff = /^([A-Z][A-Za-z'-]{1,19})(\s+[A-Z][A-Za-z'-]{1,19}){0,2}$/u.test(stripped);
  if (!looksLikeNameSignoff) return body;

  lines[lastIdx] = "[REP_NAME]";
  return lines.join("\n");
}

/** Internal helper. Generates an auto-draft reply for the given inbound
 *  outreach row and persists it onto the row's auto_draft_* columns.
 *  Returns the draft for the caller (the webhook handler) to log if needed.
 *  Throws on hard failures (DB missing rows, Gemini timeout); the caller
 *  is expected to catch + swallow so the webhook still ACKs to Resend. */
export async function generateInboundReplyDraft(inboundOutreachId: string): Promise<{
  subject: string;
  body: string;
  verified: DraftVerifiedBlock;
}> {
  const sb = admin();

  // 1. Load the inbound row.
  const { data: inbound } = await sb
    .from("promotion_outreach")
    .select("id, state_id, body, subject, metadata, user_id")
    .eq("id", inboundOutreachId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (!inbound) throw new Error(`Inbound row ${inboundOutreachId} not found`);

  // 2. Parent state → promo node id + account node id.
  const { data: state } = await sb
    .from("promotion_account_state")
    .select("id, promotion_node_id, account_node_id")
    .eq("id", inbound.state_id)
    .maybeSingle();
  if (!state) throw new Error(`Parent state ${inbound.state_id} not found`);

  // 3. Promo + account nodes in parallel.
  const [promoRes, acctRes] = await Promise.all([
    sb
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .eq("id", state.promotion_node_id)
      .maybeSingle(),
    sb
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .eq("id", state.account_node_id)
      .maybeSingle(),
  ]);
  const promoRow = promoRes.data;
  const acctRow = acctRes.data;
  if (!promoRow) throw new Error(`Promo node ${state.promotion_node_id} not found`);
  if (!acctRow) throw new Error(`Account node ${state.account_node_id} not found`);

  const promoAtt = (promoRow.attachments ?? {}) as PromotionAttachments;
  const acctAtt = (acctRow.attachments ?? {}) as AccountAttachments;
  const tiers = (promoAtt.tiers ?? []) as PromotionBuyInTier[];

  // 4. Build prompt context for the LLM.
  const tierLadderText = tiers.length > 0
    ? tiers.map(summarizeTierForPrompt).join("\n")
    : "(no structured tiers — speak in general terms)";
  const acctCurrentTier = pickTierForManufacturer(
    acctAtt.tiers as AccountTier[] | undefined,
    promoAtt.manufacturer,
  );
  // v339.4: surface the contact's first name for the greeting line in the
  // draft. The prompt requires "Hi <FirstName> —" when available, "Hey —"
  // otherwise. Split on whitespace, take the first token; if contact_name
  // is missing or empty, leave undefined so the prompt picks the fallback.
  const contactFirstName =
    typeof acctAtt.contact_name === "string" && acctAtt.contact_name.trim().length > 0
      ? acctAtt.contact_name.trim().split(/\s+/)[0]
      : null;

  const acctContextLines = [
    `Practice: ${acctRow.title ?? "(unnamed)"}`,
    contactFirstName ? `Contact first name (use for greeting): ${contactFirstName}` : `Contact first name: (unknown — use "Hey —" greeting)`,
    acctCurrentTier ? `Current standing: ${acctCurrentTier.tier} (family=${acctCurrentTier.family})` : null,
    typeof acctAtt.q1_volume_usd === "number" ? `Q1 volume: $${acctAtt.q1_volume_usd.toFixed(0)}` : null,
    typeof acctAtt.ytd_volume_usd === "number" ? `YTD volume: $${acctAtt.ytd_volume_usd.toFixed(0)}` : null,
    typeof acctAtt.last_order_date === "string" ? `Last order: ${acctAtt.last_order_date}` : null,
  ].filter(Boolean).join("\n");

  const inboundBody = (inbound.body ?? "").slice(0, 4_000);
  const inboundSubject = inbound.subject ?? "(no subject)";

  const userPrompt = `PROMO:
- Title: ${promoRow.title}
- Manufacturer: ${promoAtt.manufacturer ?? "(unknown)"}
- Kind: ${promoAtt.promo_kind ?? "(unspecified)"}
- Ends: ${promoAtt.ends ?? "(undated)"}

TIER LADDER:
${tierLadderText}

ACCOUNT:
${acctContextLines || "(no account context available)"}

PRACTICE'S REPLY:
Subject: ${inboundSubject}

${inboundBody}

Draft your warm, personal reply. Recommend ONE tier from the ladder above.`;

  // 5. Call Gemini. v339.7 — system prompt is now policy-aware; we resolve
  //    the rep's selling style (conservative/balanced/aggressive) and inject
  //    the matching TIER CHOICE block. Default 'balanced' for any error /
  //    missing row, so this is brand-safe out of the box.
  const policy = await getRepTierPolicy(sb, inbound.user_id);
  const systemPrompt = buildReplySystemPrompt(policy);
  const raw = await callGeminiOneShot(systemPrompt, userPrompt);
  const parsed = parseReplyDraftOutput(raw);

  // v339.7 — Belt-and-suspenders [REP_NAME] enforcement. The prompt now has
  // a strong instruction + a worked example, but Gemini still occasionally
  // echoes a name from the practice's reply. Defensively rewrite the last
  // non-empty line if it looks like a name signoff (a short line that's
  // just letters/spaces). Send-time substitution does the real swap.
  parsed.body = enforceRepNamePlaceholder(parsed.body);

  // 6. Validate the LLM's tier choice against actual ladder. Fall back to
  //    lowest-min-units tier if invalid (mirrors recommendTier heuristic).
  let chosenTier: PromotionBuyInTier | null = null;
  let llmTierWasValid = false;
  if (parsed.tierCode) {
    chosenTier = tiers.find((t) => t.code === parsed.tierCode) ?? null;
    llmTierWasValid = chosenTier !== null;
  }
  if (!chosenTier && tiers.length > 0) {
    const fallbackCode = recommendTier(tiers);
    chosenTier = tiers.find((t) => t.code === fallbackCode) ?? tiers[0];
  }

  const nowIso = new Date().toISOString();
  const verified: DraftVerifiedBlock = chosenTier
    ? {
        promo_id: promoRow.id,
        promo_title: promoRow.title ?? "",
        manufacturer: promoAtt.manufacturer ?? "",
        recommended_tier_code: chosenTier.code,
        recommended_tier_label: chosenTier.label,
        recommended_tier_clause: describeTierClauseForVerified(chosenTier),
        llm_tier_was_valid: llmTierWasValid,
        generated_at: nowIso,
      }
    : {
        promo_id: promoRow.id,
        promo_title: promoRow.title ?? "",
        manufacturer: promoAtt.manufacturer ?? "",
        recommended_tier_code: "",
        recommended_tier_label: "(no tier ladder available)",
        recommended_tier_clause: "",
        llm_tier_was_valid: false,
        generated_at: nowIso,
      };

  // 7. Persist to the inbound row.
  await sb
    .from("promotion_outreach")
    .update({
      auto_draft_subject: parsed.subject,
      auto_draft_body: parsed.body,
      auto_draft_verified: verified as unknown as Json,
      auto_draft_generated_at: nowIso,
    })
    .eq("id", inboundOutreachId);

  return { subject: parsed.subject, body: parsed.body, verified };
}

// ── listPromoInbox (v338) ─────────────────────────────────────────────────
//
// Loader for /app/rep/inbox. Returns inbound outreach rows joined to
// parent state + account + promo node titles. Capped at 50 rows; pagination
// ships when the volume justifies it.

const inboxInput = accessTokenInput.extend({
  viewAs: z.enum(["demo"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export type InboxRow = {
  outreachId: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  fromAddr: string | null;
  sentAt: string;
  readAt: string | null;
  inReplyTo: string | null;
  stateId: string;
  state: string;
  accountId: string;
  accountTitle: string | null;
  promotionId: string;
  promotionTitle: string | null;
  /** The most recent outbound subject for this state — gives context
   *  in the inbox row without an extra fetch. */
  parentOutboundSubject: string | null;
  parentOutboundSentAt: string | null;
  parentOutboundBody: string | null;
  /** v339: Liz auto-drafted reply (null until generation completes). */
  autoDraftSubject: string | null;
  autoDraftBody: string | null;
  autoDraftVerified: DraftVerifiedBlock | null;
  autoDraftGeneratedAt: string | null;
};

export const listPromoInbox = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => inboxInput.parse(input))
  .handler(async ({ data }): Promise<InboxRow[]> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();
    const limit = data.limit ?? 50;

    // 1. Pull the inbound rows for this rep.
    const { data: inboundRows, error } = await sb
      .from("promotion_outreach")
      .select(
        "id, subject, body, response_body, sent_at, read_at, in_reply_to, state_id, metadata, auto_draft_subject, auto_draft_body, auto_draft_verified, auto_draft_generated_at",
      )
      .eq("user_id", userId)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Couldn't load inbox: ${error.message}`);
    if (!inboundRows || inboundRows.length === 0) return [];

    // 2. Look up the parent state + promo + account for each.
    const stateIds = Array.from(new Set(inboundRows.map((r) => r.state_id)));
    const { data: stateRows } = await sb
      .from("promotion_account_state")
      .select("id, state, promotion_node_id, account_node_id")
      .in("id", stateIds);
    const stateById = new Map((stateRows ?? []).map((s) => [s.id, s]));

    const nodeIds = Array.from(
      new Set(
        (stateRows ?? []).flatMap((s) => [s.promotion_node_id, s.account_node_id]),
      ),
    );
    const { data: nodeRows } = await sb
      .from("knowledge_nodes")
      .select("id, title")
      .in("id", nodeIds);
    const titleById = new Map((nodeRows ?? []).map((n) => [n.id, n.title as string | null]));

    // 3. For each inbound row, find the most-recent outbound parent in the
    //    same state — that's the "what they replied to" context.
    const { data: outboundRows } = await sb
      .from("promotion_outreach")
      .select("state_id, subject, body, sent_at")
      .eq("user_id", userId)
      .eq("direction", "outbound")
      .in("state_id", stateIds)
      .order("sent_at", { ascending: false });
    const latestOutboundByState = new Map<string, { subject: string | null; body: string | null; sent_at: string }>();
    for (const o of outboundRows ?? []) {
      if (!latestOutboundByState.has(o.state_id)) {
        latestOutboundByState.set(o.state_id, {
          subject: o.subject,
          body: o.body,
          sent_at: o.sent_at,
        });
      }
    }

    return inboundRows.map((r) => {
      const state = stateById.get(r.state_id);
      const parentOutbound = latestOutboundByState.get(r.state_id) ?? null;
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const fromAddr = typeof meta.from === "string" ? meta.from : null;
      return {
        outreachId: r.id,
        subject: r.subject,
        bodyText: r.response_body ?? r.body ?? null,
        bodyHtml: null, // we don't currently persist HTML on inbound rows
        fromAddr,
        sentAt: r.sent_at,
        readAt: r.read_at,
        inReplyTo: r.in_reply_to,
        stateId: r.state_id,
        state: state?.state ?? "unknown",
        accountId: state?.account_node_id ?? "",
        accountTitle: state ? titleById.get(state.account_node_id) ?? null : null,
        promotionId: state?.promotion_node_id ?? "",
        promotionTitle: state ? titleById.get(state.promotion_node_id) ?? null : null,
        parentOutboundSubject: parentOutbound?.subject ?? null,
        parentOutboundSentAt: parentOutbound?.sent_at ?? null,
        parentOutboundBody: parentOutbound?.body ?? null,
        autoDraftSubject: r.auto_draft_subject ?? null,
        autoDraftBody: r.auto_draft_body ?? null,
        autoDraftVerified: (r.auto_draft_verified as unknown as DraftVerifiedBlock) ?? null,
        autoDraftGeneratedAt: r.auto_draft_generated_at ?? null,
      };
    });
  });

// ── markInboxRead (v338) ──────────────────────────────────────────────────

const markReadInput = accessTokenInput.extend({
  outreachId: z.string().uuid(),
});

export const markInboxRead = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => markReadInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    await sb
      .from("promotion_outreach")
      .update({ read_at: new Date().toISOString() })
      .eq("id", data.outreachId)
      .eq("user_id", userId)
      .eq("direction", "inbound");
    return { ok: true };
  });

// ── countUnreadReplies (v338) ─────────────────────────────────────────────
// Tiny aggregate for the Today dashboard card.

const unreadCountInput = accessTokenInput.extend({
  viewAs: z.enum(["demo"]).optional(),
});

export const countUnreadReplies = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => unreadCountInput.parse(input))
  .handler(async ({ data }): Promise<{ unread: number }> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();
    const { count } = await sb
      .from("promotion_outreach")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("direction", "inbound")
      .is("read_at", null);
    return { unread: count ?? 0 };
  });

// ── regenerateInboundReplyDraft (v339.3) ─────────────────────────────────
//
// Rep clicks "Regenerate" in the inbox composer. We re-run
// generateInboundReplyDraft for the inbound row — useful for iterating
// on REPLY_SYSTEM_PROMPT without sending fresh emails, AND for backfilling
// any row whose draft generation failed or pre-dated v339.
//
// Rep-scoped: only the row's owner can regenerate it. Demo mode allowed
// (regeneration doesn't send anything — read-only equivalent).

const regenerateDraftInput = accessTokenInput.extend({
  outreachId: z.string().uuid(),
  viewAs: z.enum(["demo"]).optional(),
});

export type RegenerateDraftResult = {
  ok: true;
  subject: string;
  body: string;
  verified: DraftVerifiedBlock;
};

export const regenerateInboundReplyDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => regenerateDraftInput.parse(input))
  .handler(async ({ data }): Promise<RegenerateDraftResult> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    // Ownership check before regenerating — never let one rep trigger
    // Gemini calls against another rep's inbound rows.
    const { data: row } = await sb
      .from("promotion_outreach")
      .select("id, user_id, direction")
      .eq("id", data.outreachId)
      .maybeSingle();
    if (!row) throw new Error("Inbound row not found.");
    if (row.user_id !== userId) throw new Error("Not your row to regenerate.");
    if (row.direction !== "inbound") throw new Error("Can only regenerate drafts on inbound rows.");

    const { subject, body, verified } = await generateInboundReplyDraft(data.outreachId);
    return { ok: true, subject, body, verified };
  });

// ── sendInboundReplyDraft (v339) ─────────────────────────────────────────
//
// Rep clicks Send on the auto-draft (possibly after editing). We craft an
// outbound email that THREADS into the practice owner's reply chain via
// In-Reply-To + References, send via Resend, and persist a new outbound
// promotion_outreach row attached to the same parent state. The original
// inbound row keeps its auto_draft_* columns intact as a history breadcrumb
// (so we can later compute "rep edited Liz's draft by X words" telemetry).
//
// Demo mode is read-only — same posture as sendPromoBlast.

const sendDraftInput = accessTokenInput.extend({
  inboundOutreachId: z.string().uuid(),
  /** Rep-edited (or rep-accepted) subject. */
  subject: z.string().min(1).max(500),
  /** Rep-edited (or rep-accepted) body. */
  body: z.string().min(1).max(50_000),
  viewAs: z.enum(["demo"]).optional(),
});

export type SendDraftResult = {
  ok: true;
  outboundOutreachId: string;
  resendEmailId: string | null;
  to: string;
};

export const sendInboundReplyDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => sendDraftInput.parse(input))
  .handler(async ({ data }): Promise<SendDraftResult> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    if (data.viewAs === "demo") {
      throw new Error("Demo mode is read-only — replies aren't sent for real.");
    }

    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) throw new Error("RESEND_API_KEY not configured.");

    // 1. Load inbound row (we use its email_id for In-Reply-To threading +
    //    state_id for parent linkage).
    const { data: inbound } = await sb
      .from("promotion_outreach")
      .select("id, state_id, email_id, metadata")
      .eq("id", data.inboundOutreachId)
      .eq("user_id", userId)
      .eq("direction", "inbound")
      .maybeSingle();
    if (!inbound) throw new Error("Inbound row not found (or not yours to reply to).");

    // 2. Parent state → account email + promo intent_token (for Reply-To).
    const { data: state } = await sb
      .from("promotion_account_state")
      .select("id, promotion_node_id, account_node_id")
      .eq("id", inbound.state_id)
      .maybeSingle();
    if (!state) throw new Error("Parent state not found.");

    const { data: acctRow } = await sb
      .from("knowledge_nodes")
      .select("title, attachments")
      .eq("id", state.account_node_id)
      .maybeSingle();
    const acctAtt = (acctRow?.attachments ?? {}) as AccountAttachments;
    const toEmail = typeof acctAtt.contact_email === "string" ? acctAtt.contact_email : null;
    if (!toEmail) {
      throw new Error("No contact_email on the account — can't send the reply.");
    }

    // 3. Find the most-recent OUTBOUND in this state for intent_token reuse.
    //    Replies thread back via the SAME plus-address as the original send.
    const { data: parentOut } = await sb
      .from("promotion_outreach")
      .select("intent_token")
      .eq("state_id", inbound.state_id)
      .eq("direction", "outbound")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const intentToken = parentOut?.intent_token ?? null;

    // 4. Rep name for the [REP_NAME] placeholder substitution.
    const { name: repName, email: repEmail } = await resolveRepName(sb, userId);
    const finalBody = data.body.replace(/\[REP_NAME\]/g, repName);

    // 5. Send via Resend with thread-preserving headers.
    const replyTo = process.env.RESEND_WEBHOOK_SECRET && intentToken
      ? [`reply+${intentToken}@${REPLY_DOMAIN}`]
      : (repEmail ?? undefined);
    const headers: Record<string, string> = {};
    if (inbound.email_id) {
      // In-Reply-To: the practice's reply Message-ID (so their inbox threads).
      headers["In-Reply-To"] = `<${inbound.email_id}>`;
      headers["References"] = `<${inbound.email_id}>`;
    }

    const sendBody = {
      from: FROM_EMAIL_PROMO,
      to: [toEmail],
      reply_to: replyTo,
      subject: data.subject,
      text: finalBody,
      headers,
      tags: [
        { name: "type", value: "promo-reply" },
        { name: "state_id", value: state.id },
        { name: "inbound_outreach_id", value: inbound.id },
      ],
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendBody),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`Resend rejected the reply (${res.status}). ${msg.slice(0, 300)}`);
    }
    const sendResp = (await res.json().catch(() => ({}))) as { id?: string };
    const resendEmailId = sendResp.id ?? null;
    const nowIso = new Date().toISOString();

    // 6. Insert the outbound promotion_outreach row, linked to the same state.
    const { data: outboundRow, error: insErr } = await sb
      .from("promotion_outreach")
      .insert({
        user_id: userId,
        state_id: state.id,
        kind: "email",
        direction: "outbound",
        subject: data.subject,
        body: finalBody,
        sent_at: nowIso,
        email_id: resendEmailId,
        intent_token: intentToken,
        metadata: {
          to: toEmail,
          replied_to_inbound_id: inbound.id,
          source: "v339-auto-draft-send",
        } as unknown as Json,
      })
      .select("id")
      .single();
    if (insErr || !outboundRow) {
      throw new Error(`Couldn't persist outbound row: ${insErr?.message ?? "no row"}`);
    }

    // 7. Bump parent state's last_touched_at (no state regression).
    await sb
      .from("promotion_account_state")
      .update({ last_touched_at: nowIso, updated_at: nowIso })
      .eq("id", state.id);

    // 8. Mark the inbound row as read (the rep clearly read it to reply).
    if (inbound.metadata !== undefined) {
      await sb
        .from("promotion_outreach")
        .update({ read_at: nowIso })
        .eq("id", inbound.id);
    }

    return {
      ok: true,
      outboundOutreachId: outboundRow.id,
      resendEmailId,
      to: toEmail,
    };
  });

// ── v340 — Scheduled follow-up cadence ────────────────────────────────────
//
// The "5 nudges suggested" daily digest. Rep opens /app/rep/cadence,
// sees a list of stale `outreached` rows (state='outreached',
// last_touched_at < now() - NUDGE_STALE_DAYS, never dismissed), each with
// a Liz-drafted nudge body. Rep can Send, Edit then Send, or Dismiss.
// Never auto-send — rep eyes stay in the loop per the locked Phase 2 spec.
//
// The nudge uses the same v336 send mechanic (Reply-To plus-address with
// the original blast's intent_token, threading via In-Reply-To from the
// most-recent outbound email_id). A successful send bumps
// last_touched_at, so the row naturally falls off the digest.

/** Days of staleness before an outreached row is eligible for a nudge
 *  suggestion. 5 = "the message has had time to land + the practice has
 *  had time to read it + you haven't pestered them yet." Could be a
 *  per-rep config knob later. */
const NUDGE_STALE_DAYS = 5;

/** Tier-recommendation block for the NUDGE drafter. Different from the
 *  REPLY drafter's block because the practice hasn't told us their volume
 *  yet — so the nudge either ASKS for it (conservative), SUGGESTS based on
 *  prior history (balanced), or PITCHES the next tier (aggressive). */
function tierChoiceForNudge(policy: RepTierPolicy): string {
  if (policy === "conservative") {
    return `TIER POSTURE — CONSERVATIVE: The practice hasn't shared their volume yet. Do NOT recommend a tier. Instead, gently ASK: "If you can share a rough quarterly volume, I'll pull the tier that lines up best." Mention the promo's tier range exists in qualitative terms ("a few tiers depending on volume"), never a specific code. Pick the LOWEST tier as RECOMMENDED_TIER in the output (for math-chip purposes only — the body should not pitch it).`;
  }
  if (policy === "aggressive") {
    return `TIER POSTURE — AGGRESSIVE: Lead with the upper tier the account's prior history would qualify them for if their volume continues. Frame it as: "based on what you've done historically, [TIER] is the move — the math at that band is the strongest." If the account has no prior history in the ladder, name the middle-to-upper tier as a confident default. Output the upper-tier code as RECOMMENDED_TIER.`;
  }
  // balanced (default)
  return `TIER POSTURE — BALANCED: If the account has a usable prior tier or volume signal in the context block, gently suggest the matching tier ("you'd likely land at [TIER] based on what I'm seeing"). If there's no signal, mention 2-3 tiers exist + ask for a rough volume to confirm. Tone is collaborative, never pitchy. Output the suggested tier code as RECOMMENDED_TIER (lowest if no signal).`;
}

/** v340 system prompt for the nudge drafter. Different goal from the reply
 *  drafter: re-engage a quiet practice, surface value, give an out. Still
 *  policy-aware via the rep's tier-policy setting. Still ends with the
 *  literal [REP_NAME] token (substituted at send-time). */
function buildNudgeSystemPrompt(policy: RepTierPolicy): string {
  return `You are a medical-aesthetics sales rep drafting a SHORT, friendly follow-up to a practice owner you emailed about a promo a few days ago. They haven't replied. You're not chasing — you're checking in once, offering value, and making it easy for them to say "not now" if the timing's off.

ABSOLUTE BANS — never use any of these phrases or anything like them:
- "Just following up"
- "Just checking in"
- "Bumping this to the top"
- "Did you see my last email?"
- "I wanted to make sure"
- "Circling back"
- "Touching base"
- "Looping back"
- ANY phrase that draws attention to the fact that they didn't reply
- ANY filler pleasantry or enthusiasm opener
- Exclamation points
- "Just" / "really" / "actually" as intensifiers

STRUCTURE — THE BODY MUST CONTAIN ALL FIVE LINES BELOW, IN THIS ORDER, NO EXCEPTIONS.

LINE 1 — Greeting (mandatory): "Hi <FirstName> —" if a contact first name is in the prompt context; otherwise "Hey —". Just the greeting.
LINE 2 — Value re-engage (mandatory): one specific sentence about the promo that gives them a reason to care RIGHT NOW. Reference the promo's deadline if close, OR a tier benefit (qualitatively), OR a bundle component (e.g. scrubs, rewards credit). Do NOT recap "as I mentioned in my last email" — they have the email; reference what's NEW or what's relevant to them.
LINE 3 — Tier posture (mandatory): one sentence based on the TIER POSTURE block below — either ask for volume, suggest a tier based on prior signal, or pitch confidently. Match the rep's selling style.
LINE 4 — Easy CTA + EXPLICIT OUT (mandatory). Pick ONE shape: "Want me to send the order form, or is the timing not right this quarter?" / "Happy to set up a 5-min call this week — or just say 'not now' and I'll circle back at the next promo." / "I can have the math worked up in 10 min if useful — otherwise no pressure, totally fine to pass." The OUT is non-negotiable: the practice must have a graceful way to decline without ghosting again.
LINE 5 — Signoff (mandatory): MUST be the literal token [REP_NAME] on its own line. Output exactly those 9 characters. NEVER substitute a real first name. Even if the practice's earlier emails mentioned a rep by name, DO NOT echo any name in the signoff. The system substitutes the real rep at send-time.

EXAMPLE OF A COMPLETE BODY (same shape, different facts):
Hi Karen —

The 7-Year Anniversary promo wraps 5/29 — the rewards credit at the upper tier is meaningful for a practice your size.

You'd likely land at 7QUEEN based on what I'm seeing — happy to confirm with a rough volume number.

Want me to send the order form, or is the timing not right this quarter?

[REP_NAME]

LENGTH: 55-95 words TOTAL across all 5 lines. Tighter is better. Phones are small.

${tierChoiceForNudge(policy)}

DO NOT:
- Quote dollar figures — the system attaches a separate [VERIFIED] math block with exact numbers. Reference the tier qualitatively.
- Mention they didn't reply, or that this is a follow-up, or that you sent a previous email. They know.
- Apologize for emailing again.
- Be pushy. Always include the explicit OUT.

OUTPUT FORMAT (parse strictly — all three sections required):
SUBJECT: Re: <a fresh phrase tied to the promo or a value hook, 4-7 words; do NOT use "Following up" or "Quick check-in">
BODY:
<the 5 lines per structure above>
RECOMMENDED_TIER: <one tier code from the ladder>`;
}

/** Internal helper. Generates a nudge draft for the given state row.
 *  Mirrors generateInboundReplyDraft's shape — Gemini one-shot + post-
 *  process [REP_NAME] enforcement + code-computed [VERIFIED] chip. Drafts
 *  are NOT persisted; the digest UI regenerates on each open (cheap; ~1
 *  Gemini call per stale row per day per rep). */
async function generateNudgeDraftForState(
  sb: ReturnType<typeof admin>,
  stateId: string,
): Promise<{ subject: string; body: string; verified: DraftVerifiedBlock }> {
  const { data: state } = await sb
    .from("promotion_account_state")
    .select("id, user_id, promotion_node_id, account_node_id, last_touched_at, state")
    .eq("id", stateId)
    .maybeSingle();
  if (!state) throw new Error(`State ${stateId} not found`);

  const [promoRes, acctRes] = await Promise.all([
    sb
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .eq("id", state.promotion_node_id)
      .maybeSingle(),
    sb
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .eq("id", state.account_node_id)
      .maybeSingle(),
  ]);
  if (!promoRes.data) throw new Error(`Promo ${state.promotion_node_id} not found`);
  if (!acctRes.data) throw new Error(`Account ${state.account_node_id} not found`);

  const promoAtt = (promoRes.data.attachments ?? {}) as PromotionAttachments;
  const acctAtt = (acctRes.data.attachments ?? {}) as AccountAttachments;
  const tiers = (promoAtt.tiers ?? []) as PromotionBuyInTier[];

  const tierLadderText = tiers.length > 0
    ? tiers.map(summarizeTierForPrompt).join("\n")
    : "(no structured tiers — speak in general terms)";

  const acctCurrentTier = pickTierForManufacturer(
    acctAtt.tiers as AccountTier[] | undefined,
    promoAtt.manufacturer,
  );
  const contactFirstName =
    typeof acctAtt.contact_name === "string" && acctAtt.contact_name.trim().length > 0
      ? acctAtt.contact_name.trim().split(/\s+/)[0]
      : null;

  const acctContextLines = [
    `Practice: ${acctRes.data.title ?? "(unnamed)"}`,
    contactFirstName ? `Contact first name (use for greeting): ${contactFirstName}` : `Contact first name: (unknown — use "Hey —" greeting)`,
    acctCurrentTier ? `Prior tier signal: ${acctCurrentTier.tier} (family=${acctCurrentTier.family})` : "Prior tier signal: (none — no history with this manufacturer)",
    typeof acctAtt.q1_volume_usd === "number" ? `Q1 volume: $${acctAtt.q1_volume_usd.toFixed(0)}` : null,
    typeof acctAtt.ytd_volume_usd === "number" ? `YTD volume: $${acctAtt.ytd_volume_usd.toFixed(0)}` : null,
    typeof acctAtt.last_order_date === "string" ? `Last order: ${acctAtt.last_order_date}` : null,
  ].filter(Boolean).join("\n");

  // Days stale (informational for the prompt — the model can use it to
  // gauge urgency-of-tone, e.g. "promo wraps next week" vs "no rush").
  const lastTouchedIso = state.last_touched_at ?? new Date().toISOString();
  const daysStale = Math.max(0, Math.floor(
    (Date.now() - new Date(lastTouchedIso).getTime()) / 86_400_000
  ));

  const userPrompt = `PROMO:
- Title: ${promoRes.data.title}
- Manufacturer: ${promoAtt.manufacturer ?? "(unknown)"}
- Kind: ${promoAtt.promo_kind ?? "(unspecified)"}
- Ends: ${promoAtt.ends ?? "(undated)"}

TIER LADDER:
${tierLadderText}

ACCOUNT:
${acctContextLines}

CONTEXT:
- Days since the rep last touched this account about this promo: ${daysStale}
- This is the rep's first follow-up. The practice has not replied to the original blast.

Draft a short, low-pressure nudge. Re-engage with value. Give them an out.`;

  const policy = await getRepTierPolicy(sb, state.user_id);
  const systemPrompt = buildNudgeSystemPrompt(policy);
  const raw = await callGeminiOneShot(systemPrompt, userPrompt);
  const parsed = parseReplyDraftOutput(raw);
  parsed.body = enforceRepNamePlaceholder(parsed.body);

  // Validate the LLM's tier choice against the actual ladder. Fall back to
  // the lowest-min-units tier on hallucination — same pattern as v339.
  let chosenTier: PromotionBuyInTier | null = null;
  let llmTierWasValid = false;
  if (parsed.tierCode) {
    chosenTier = tiers.find((t) => t.code === parsed.tierCode) ?? null;
    llmTierWasValid = chosenTier !== null;
  }
  if (!chosenTier && tiers.length > 0) {
    const fallbackCode = recommendTier(tiers);
    chosenTier = tiers.find((t) => t.code === fallbackCode) ?? tiers[0];
  }

  const nowIso = new Date().toISOString();
  const verified: DraftVerifiedBlock = chosenTier
    ? {
        promo_id: promoRes.data.id,
        promo_title: promoRes.data.title ?? "",
        manufacturer: promoAtt.manufacturer ?? "",
        recommended_tier_code: chosenTier.code,
        recommended_tier_label: chosenTier.label,
        recommended_tier_clause: describeTierClauseForVerified(chosenTier),
        llm_tier_was_valid: llmTierWasValid,
        generated_at: nowIso,
      }
    : {
        promo_id: promoRes.data.id,
        promo_title: promoRes.data.title ?? "",
        manufacturer: promoAtt.manufacturer ?? "",
        recommended_tier_code: "",
        recommended_tier_label: "(no tier ladder available)",
        recommended_tier_clause: "",
        llm_tier_was_valid: false,
        generated_at: nowIso,
      };

  return { subject: parsed.subject, body: parsed.body, verified };
}

// ── listSuggestedNudges ───────────────────────────────────────────────────

export type SuggestedNudgeRow = {
  stateId: string;
  accountId: string;
  accountTitle: string;
  contactEmail: string | null;
  contactName: string | null;
  promotionId: string;
  promotionTitle: string;
  manufacturer: string | null;
  promoEnds: string | null;
  daysSinceLastTouch: number;
  lastTouchedAt: string | null;
};

const listNudgesInput = accessTokenInput.extend({
  viewAs: z.enum(["demo"]).optional(),
});

export const listSuggestedNudges = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listNudgesInput.parse(input))
  .handler(async ({ data }): Promise<SuggestedNudgeRow[]> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    const cutoffIso = new Date(Date.now() - NUDGE_STALE_DAYS * 86_400_000).toISOString();

    const { data: rows, error } = await sb
      .from("promotion_account_state")
      .select(
        "id, account_node_id, promotion_node_id, last_touched_at, state, nudge_dismissed_at",
      )
      .eq("user_id", userId)
      .eq("state", "outreached")
      .is("nudge_dismissed_at", null)
      .lt("last_touched_at", cutoffIso)
      .order("last_touched_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(`Couldn't load nudge suggestions: ${error.message}`);
    if (!rows || rows.length === 0) return [];

    const promoIds = Array.from(new Set(rows.map((r) => r.promotion_node_id)));
    const acctIds = Array.from(new Set(rows.map((r) => r.account_node_id)));
    const [{ data: promos }, { data: accounts }] = await Promise.all([
      sb
        .from("knowledge_nodes")
        .select("id, title, attachments")
        .in("id", promoIds),
      sb
        .from("knowledge_nodes")
        .select("id, title, attachments")
        .in("id", acctIds),
    ]);
    const promoMap = new Map((promos ?? []).map((p) => [p.id, p]));
    const acctMap = new Map((accounts ?? []).map((a) => [a.id, a]));

    const now = Date.now();
    return rows
      .map((r): SuggestedNudgeRow | null => {
        const promo = promoMap.get(r.promotion_node_id);
        const account = acctMap.get(r.account_node_id);
        if (!promo || !account) return null;
        const promoAtt = (promo.attachments ?? {}) as PromotionAttachments;
        const acctAtt = (account.attachments ?? {}) as AccountAttachments;
        const lastTouchedMs = r.last_touched_at ? new Date(r.last_touched_at).getTime() : now;
        return {
          stateId: r.id,
          accountId: account.id,
          accountTitle: account.title ?? "(unnamed practice)",
          contactEmail: typeof acctAtt.contact_email === "string" ? acctAtt.contact_email : null,
          contactName: typeof acctAtt.contact_name === "string" ? acctAtt.contact_name : null,
          promotionId: promo.id,
          promotionTitle: promo.title ?? "(untitled promo)",
          manufacturer: promoAtt.manufacturer ?? null,
          promoEnds: promoAtt.ends ?? null,
          daysSinceLastTouch: Math.max(0, Math.floor((now - lastTouchedMs) / 86_400_000)),
          lastTouchedAt: r.last_touched_at,
        };
      })
      .filter((x): x is SuggestedNudgeRow => x !== null);
  });

// ── generateNudgeDraft (per-row, called from cadence UI on mount) ─────────

const genNudgeInput = accessTokenInput.extend({
  stateId: z.string().uuid(),
  viewAs: z.enum(["demo"]).optional(),
});

export type NudgeDraftResult = {
  subject: string;
  body: string;
  verified: DraftVerifiedBlock;
};

export const generateNudgeDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => genNudgeInput.parse(input))
  .handler(async ({ data }): Promise<NudgeDraftResult> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    // Confirm ownership before drafting (RLS would catch this anyway, but
    // an explicit check produces a clearer error message in the UI).
    const { data: owner } = await sb
      .from("promotion_account_state")
      .select("id, user_id")
      .eq("id", data.stateId)
      .maybeSingle();
    if (!owner || owner.user_id !== userId) {
      throw new Error("Nudge target not found (or not yours to draft).");
    }
    return generateNudgeDraftForState(sb, data.stateId);
  });

// ── sendNudgeDraft ────────────────────────────────────────────────────────
//
// Reuses the v336 send pattern: thread via In-Reply-To from the most-recent
// outbound's email_id in this state, Reply-To via plus-address + the same
// intent_token (so any practice reply still routes through the v338 inbox).
// Successful send bumps last_touched_at, so the row falls off the next
// digest naturally.

const sendNudgeInput = accessTokenInput.extend({
  stateId: z.string().uuid(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(50_000),
  viewAs: z.enum(["demo"]).optional(),
});

export type SendNudgeResult = {
  ok: true;
  outboundOutreachId: string;
  resendEmailId: string | null;
  to: string;
};

export const sendNudgeDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => sendNudgeInput.parse(input))
  .handler(async ({ data }): Promise<SendNudgeResult> => {
    if (data.viewAs === "demo") {
      throw new Error("Demo mode is read-only — nudges aren't sent for real.");
    }
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) throw new Error("RESEND_API_KEY not configured.");

    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    // 1. Load state + confirm ownership + ownership of nudge eligibility.
    const { data: state } = await sb
      .from("promotion_account_state")
      .select("id, user_id, account_node_id, promotion_node_id, state")
      .eq("id", data.stateId)
      .maybeSingle();
    if (!state || state.user_id !== userId) {
      throw new Error("Nudge target not found (or not yours to send).");
    }

    // 2. Pull account contact_email + the most-recent outbound for
    //    threading (In-Reply-To) and intent_token reuse.
    const { data: acctRow } = await sb
      .from("knowledge_nodes")
      .select("title, attachments")
      .eq("id", state.account_node_id)
      .maybeSingle();
    const acctAtt = (acctRow?.attachments ?? {}) as AccountAttachments;
    const toEmail = typeof acctAtt.contact_email === "string" ? acctAtt.contact_email : null;
    if (!toEmail) {
      throw new Error("No contact_email on the account — can't send the nudge.");
    }

    const { data: parentOut } = await sb
      .from("promotion_outreach")
      .select("intent_token, email_id")
      .eq("state_id", state.id)
      .eq("direction", "outbound")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const intentToken = parentOut?.intent_token ?? null;
    const parentEmailId = parentOut?.email_id ?? null;

    // 3. Resolve rep name for the [REP_NAME] substitution.
    const { name: repName, email: repEmail } = await resolveRepName(sb, userId);
    const finalBody = data.body.replace(/\[REP_NAME\]/g, repName);
    const finalSubject = data.subject.replace(/\[REP_NAME\]/g, repName);

    // 4. Send via Resend with thread-preserving headers when we have a
    //    parent email_id to thread off of.
    const headers: Record<string, string> = {};
    if (parentEmailId) {
      headers["In-Reply-To"] = `<${parentEmailId}>`;
      headers["References"] = `<${parentEmailId}>`;
    }
    const replyTo = process.env.RESEND_WEBHOOK_SECRET && intentToken
      ? [`reply+${intentToken}@${REPLY_DOMAIN}`]
      : (repEmail ?? undefined);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL_PROMO,
        to: [toEmail],
        reply_to: replyTo,
        subject: finalSubject,
        text: finalBody,
        headers,
        tags: [
          { name: "type", value: "promo-nudge" },
          { name: "state_id", value: state.id },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`Resend rejected the nudge (${res.status}). ${msg.slice(0, 300)}`);
    }
    const sendResp = (await res.json().catch(() => ({}))) as { id?: string };
    const resendEmailId = sendResp.id ?? null;
    const nowIso = new Date().toISOString();

    // 5. Insert outbound row.
    const { data: outboundRow, error: insErr } = await sb
      .from("promotion_outreach")
      .insert({
        user_id: userId,
        state_id: state.id,
        kind: "email",
        direction: "outbound",
        subject: finalSubject,
        body: finalBody,
        sent_at: nowIso,
        email_id: resendEmailId,
        intent_token: intentToken,
        metadata: {
          to: toEmail,
          source: "v340-nudge",
        } as unknown as Json,
      })
      .select("id")
      .single();
    if (insErr || !outboundRow) {
      throw new Error(`Couldn't persist outbound row: ${insErr?.message ?? "no row"}`);
    }

    // 6. Bump state's last_touched_at — the row falls off the digest.
    await sb
      .from("promotion_account_state")
      .update({ last_touched_at: nowIso, updated_at: nowIso })
      .eq("id", state.id);

    return {
      ok: true,
      outboundOutreachId: outboundRow.id,
      resendEmailId,
      to: toEmail,
    };
  });

// ── dismissNudgeSuggestion ────────────────────────────────────────────────

const dismissNudgeInput = accessTokenInput.extend({
  stateId: z.string().uuid(),
  viewAs: z.enum(["demo"]).optional(),
});

export const dismissNudgeSuggestion = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => dismissNudgeInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    const { data: state } = await sb
      .from("promotion_account_state")
      .select("id, user_id")
      .eq("id", data.stateId)
      .maybeSingle();
    if (!state || state.user_id !== userId) {
      throw new Error("Nudge target not found (or not yours to dismiss).");
    }

    const { error } = await sb
      .from("promotion_account_state")
      .update({ nudge_dismissed_at: new Date().toISOString() })
      .eq("id", state.id);
    if (error) throw new Error(`Couldn't dismiss: ${error.message}`);
    return { ok: true };
  });

// ── countSuggestedNudges (cheap count for the Today card hint) ────────────

export const countSuggestedNudges = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listNudgesInput.parse(input))
  .handler(async ({ data }): Promise<{ count: number }> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    const cutoffIso = new Date(Date.now() - NUDGE_STALE_DAYS * 86_400_000).toISOString();
    const { count, error } = await sb
      .from("promotion_account_state")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("state", "outreached")
      .is("nudge_dismissed_at", null)
      .lt("last_touched_at", cutoffIso);
    if (error) throw new Error(`Couldn't count nudges: ${error.message}`);
    return { count: count ?? 0 };
  });

// ── v341 — Emma-side eligible promos ──────────────────────────────────────
//
// First Phase 3 ship: spa owner sees the manufacturer promos she's eligible
// for at /app/refill/promos, sourced cross-tenant from rep-created promotion
// nodes filtered by the manufacturers the spa actually uses (matched at
// claim-your-business via service.attachments.matchedProduct.manufacturer).
//
// Cross-tenant read uses the same pattern as crossReferenceServices in
// spa-claim.functions.ts — service-role admin client, no user_id filter,
// just node_type='promotion' + a manufacturer match. The shape we return
// is intentionally narrower than the rep-side PromoListRow: the spa
// shouldn't see rep-private fields (eligible account counts, account-level
// committed tier history, etc).

export type SpaInterestStatus = "interested" | "dismissed" | null;

export type EligiblePromoForSpa = {
  promotionId: string;
  title: string;
  manufacturer: string;
  promoKind: PromotionKind | null;
  description: string | null;
  starts: string | null;
  ends: string | null;
  daysToEnd: number | null;
  status: "upcoming" | "active" | "expired" | "unknown";
  heroImageUrl: string | null;
  sourceUrl: string | null;
  /** The lowest tier on the ladder — the spa's starting floor, useful as
   *  the [VERIFIED] anchor before they share a real volume number. */
  entryTier: { code: string; label: string; clause: string } | null;
  /** The top tier — aspirational reach. Helps the spa see what's possible. */
  bestTier: { code: string; label: string; clause: string } | null;
  /** Total tier count in the ladder (so UI can say "5 tiers, $370–$425/vial"). */
  tierCount: number;
  /** The spa's current interest signal. null = no signal yet. */
  spaInterestStatus: SpaInterestStatus;
  /** When the spa last changed status (interest or dismiss). null if no signal. */
  spaInterestUpdatedAt: string | null;
};

/** Manufacturer-name normalization for cross-tenant match between spa
 *  services (matchedProduct.manufacturer, set by claim-your-business
 *  extraction — case varies: "AbbVie" / "abbvie") and promo attachments
 *  (manufacturer, set by rep — typically lower-case "evolus" / "galderma"
 *  / "abbvie" / "merz"). Normalize both to lowercase + collapse common
 *  brand-name pairs (allergan ↔ abbvie; merz ↔ merz-aesthetics). */
function normalizeManufacturer(m: string | null | undefined): string | null {
  if (!m) return null;
  const lower = m.trim().toLowerCase();
  if (lower === "allergan") return "abbvie";
  if (lower === "merz aesthetics" || lower === "merz-aesthetics") return "merz";
  return lower;
}

const eligiblePromosInput = accessTokenInput;

export const listEligiblePromosForSpa = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => eligiblePromosInput.parse(input))
  .handler(async ({ data }): Promise<EligiblePromoForSpa[]> => {
    const spaUserId = await verifyAuth(data.accessToken);
    const sb = admin();

    // 1. Pull the spa's services. Each service's matchedProduct.manufacturer
    //    tells us which manufacturer's catalog the spa actually uses.
    const { data: services } = await sb
      .from("knowledge_nodes")
      .select("attachments")
      .eq("user_id", spaUserId)
      .eq("node_type", "service");

    const manufacturers = new Set<string>();
    for (const svc of services ?? []) {
      const att = (svc.attachments ?? {}) as {
        matchedProduct?: { manufacturer?: string };
      };
      const m = normalizeManufacturer(att.matchedProduct?.manufacturer);
      if (m) manufacturers.add(m);
    }

    // No manufacturer signal yet → no eligible promos (UI shows empty state
    // pointing at the dashboard's services editor).
    if (manufacturers.size === 0) return [];

    // 2. Cross-tenant promo read. Service-role bypass — no user_id filter.
    //    Pull all promotion nodes; we'll filter by manufacturer in app code
    //    since the manufacturer field is inside the attachments jsonb and
    //    case-insensitive match via ->>>>>> would require lower(...) which
    //    the Supabase client doesn't expose cleanly. ~hundreds of promos
    //    max for the foreseeable future, so an in-app filter is fine.
    const { data: promos, error } = await sb
      .from("knowledge_nodes")
      .select("id, user_id, title, content, attachments")
      .eq("node_type", "promotion")
      .limit(500);
    if (error) throw new Error(`Couldn't load promos: ${error.message}`);

    // 3. Filter by manufacturer + compute eligibility + status.
    const now = Date.now();
    const eligible: Array<EligiblePromoForSpa & { _repUserId: string; _sortKey: number }> = [];
    for (const p of promos ?? []) {
      const att = (p.attachments ?? {}) as PromotionAttachments;
      const promoMfr = normalizeManufacturer(att.manufacturer);
      if (!promoMfr || !manufacturers.has(promoMfr)) continue;

      // Drop expired promos older than 7 days (showed-up window already
      // closed; surfacing them just clutters).
      const endsMs = att.ends ? new Date(att.ends).getTime() : null;
      if (endsMs !== null && endsMs < now - 7 * 86_400_000) continue;

      const startsMs = att.starts ? new Date(att.starts).getTime() : null;
      const status: EligiblePromoForSpa["status"] = (() => {
        if (startsMs !== null && startsMs > now) return "upcoming";
        if (endsMs !== null && endsMs < now) return "expired";
        if (startsMs !== null || endsMs !== null) return "active";
        return "unknown";
      })();

      const tiers = (att.tiers ?? []) as PromotionBuyInTier[];
      const sortedTiers = [...tiers].sort((a, b) => a.min_units - b.min_units);
      const entry = sortedTiers[0] ?? null;
      const top = sortedTiers[sortedTiers.length - 1] ?? null;
      const daysToEnd = endsMs !== null
        ? Math.ceil((endsMs - now) / 86_400_000)
        : null;

      // Sort: active first by days-to-end ascending, then upcoming, then
      // recently-expired. Encode as a single sortable number.
      const sortKey = (() => {
        if (status === "active" && daysToEnd !== null) return daysToEnd;
        if (status === "upcoming") return 10_000 + (startsMs ?? 0);
        if (status === "expired") return 100_000 + (endsMs ?? 0);
        return 50_000;
      })();

      eligible.push({
        _repUserId: p.user_id,
        _sortKey: sortKey,
        promotionId: p.id,
        title: p.title ?? "(untitled promo)",
        manufacturer: att.manufacturer ?? promoMfr,
        promoKind: att.promo_kind ?? null,
        description: typeof att.description === "string" ? att.description : (p.content ?? null),
        starts: att.starts ?? null,
        ends: att.ends ?? null,
        daysToEnd,
        status,
        heroImageUrl: att.hero_image_url ?? null,
        sourceUrl: att.source_url ?? null,
        entryTier: entry
          ? { code: entry.code, label: entry.label, clause: describeTierClauseForVerified(entry) }
          : null,
        bestTier: top
          ? { code: top.code, label: top.label, clause: describeTierClauseForVerified(top) }
          : null,
        tierCount: sortedTiers.length,
        spaInterestStatus: null,
        spaInterestUpdatedAt: null,
      });
    }

    if (eligible.length === 0) return [];

    // 4. Pull the spa's existing interest signals for the matched promos
    //    in one query, hydrate each row.
    const promoIds = eligible.map((e) => e.promotionId);
    const { data: signals } = await sb
      .from("spa_promo_interest")
      .select("promotion_node_id, status, updated_at")
      .eq("spa_user_id", spaUserId)
      .in("promotion_node_id", promoIds);
    const signalByPromo = new Map(
      (signals ?? []).map((s) => [
        s.promotion_node_id,
        { status: s.status as SpaInterestStatus, updatedAt: s.updated_at },
      ]),
    );
    for (const row of eligible) {
      const sig = signalByPromo.get(row.promotionId);
      if (sig) {
        row.spaInterestStatus = sig.status;
        row.spaInterestUpdatedAt = sig.updatedAt;
      }
    }

    // Sort + drop the private sort key + rep_user_id before returning.
    eligible.sort((a, b) => a._sortKey - b._sortKey);
    return eligible.map((e) => {
      const { _repUserId, _sortKey, ...publicShape } = e;
      void _repUserId;
      void _sortKey;
      return publicShape;
    });
  });

// ── expressInterestInPromo + dismissPromoForSpa ───────────────────────────

const interestInput = accessTokenInput.extend({
  promotionId: z.string().uuid(),
  message: z.string().max(500).optional(),
});

export const expressInterestInPromo = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => interestInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; status: "interested" }> => {
    const spaUserId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Resolve the rep_user_id from the promotion node (we capture it on
    // the spa_promo_interest row so the rep-side query is a cheap join).
    const { data: promoRow } = await sb
      .from("knowledge_nodes")
      .select("user_id")
      .eq("id", data.promotionId)
      .eq("node_type", "promotion")
      .maybeSingle();
    if (!promoRow) throw new Error("Promo not found.");

    const { error } = await sb
      .from("spa_promo_interest")
      .upsert(
        {
          spa_user_id: spaUserId,
          rep_user_id: promoRow.user_id,
          promotion_node_id: data.promotionId,
          status: "interested",
          message: data.message ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "spa_user_id,promotion_node_id" },
      );
    if (error) throw new Error(`Couldn't record interest: ${error.message}`);
    return { ok: true, status: "interested" };
  });

const dismissInput = accessTokenInput.extend({
  promotionId: z.string().uuid(),
});

export const dismissPromoForSpa = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => dismissInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; status: "dismissed" }> => {
    const spaUserId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: promoRow } = await sb
      .from("knowledge_nodes")
      .select("user_id")
      .eq("id", data.promotionId)
      .eq("node_type", "promotion")
      .maybeSingle();
    if (!promoRow) throw new Error("Promo not found.");

    const { error } = await sb
      .from("spa_promo_interest")
      .upsert(
        {
          spa_user_id: spaUserId,
          rep_user_id: promoRow.user_id,
          promotion_node_id: data.promotionId,
          status: "dismissed",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "spa_user_id,promotion_node_id" },
      );
    if (error) throw new Error(`Couldn't dismiss: ${error.message}`);
    return { ok: true, status: "dismissed" };
  });

// ── v341.1 — Rep-side surface for spa interest signals ───────────────────
//
// Closes the rep↔spa loop opened by v341: rep visits
// /app/rep/promotions/$id and sees "N practices interested" with each
// spa's optional message. Read path is permissioned by the
// spa_promo_interest_rep_read RLS policy from the v341 migration; we still
// filter explicitly by rep_user_id since the admin client bypasses RLS.
//
// Spa identity is resolved from the spa's own knowledge_nodes
// (context='spa-profile') — see SPA_PROFILE_SCALAR_SPECS in
// spa-claim.functions.ts. For the 'spa-name' row the title column holds the
// practice name verbatim; for 'address' and 'contact-email' the content
// column does. We pull all three so the rep can recognize the practice at
// a glance even if multiple share a name.

export type PromoInterestSignal = {
  spaUserId: string;
  spaName: string;
  spaAddress: string | null;
  spaContactEmail: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
};

const interestSignalsInput = accessTokenInput.extend({
  promotionId: z.string().uuid(),
  viewAs: z.enum(["demo"]).optional(),
});

export const listPromoInterestSignals = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => interestSignalsInput.parse(input))
  .handler(async ({ data }): Promise<PromoInterestSignal[]> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    const { data: signals, error } = await sb
      .from("spa_promo_interest")
      .select("spa_user_id, message, created_at, updated_at")
      .eq("promotion_node_id", data.promotionId)
      .eq("rep_user_id", userId)
      .eq("status", "interested")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(`Couldn't load interest signals: ${error.message}`);
    if (!signals || signals.length === 0) return [];

    const spaUserIds = Array.from(new Set(signals.map((s) => s.spa_user_id)));
    const { data: profileNodes } = await sb
      .from("knowledge_nodes")
      .select("user_id, lookup_key, title, content")
      .eq("context", "spa-profile")
      .in("user_id", spaUserIds)
      .in("lookup_key", ["spa-name", "address", "contact-email"]);

    const profileByUser = new Map<string, { name?: string; address?: string; email?: string }>();
    for (const node of profileNodes ?? []) {
      const slot = profileByUser.get(node.user_id) ?? {};
      // spa-name stores the name verbatim in `title`; address + contact-email
      // store the value in `content` and keep the spec.title in `title`.
      if (node.lookup_key === "spa-name") {
        if (node.title) slot.name = node.title;
      } else if (node.lookup_key === "address") {
        if (node.content) slot.address = node.content;
      } else if (node.lookup_key === "contact-email") {
        if (node.content) slot.email = node.content;
      }
      profileByUser.set(node.user_id, slot);
    }

    return signals.map((s) => {
      const profile = profileByUser.get(s.spa_user_id);
      return {
        spaUserId: s.spa_user_id,
        spaName: profile?.name?.trim() || "An unclaimed practice",
        spaAddress: profile?.address?.trim() || null,
        spaContactEmail: profile?.email?.trim() || null,
        message: s.message,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      };
    });
  });

// ── countEligiblePromosForSpa (Today / dashboard hint) ────────────────────
//
// Cheaper sibling of listEligiblePromosForSpa — runs the same eligibility
// query but only returns the count of ACTIVE promos the spa hasn't yet
// dismissed. For the future Emma Today dashboard.

export const countEligiblePromosForSpa = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => eligiblePromosInput.parse(input))
  .handler(async ({ data }): Promise<{ count: number }> => {
    const spaUserId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: services } = await sb
      .from("knowledge_nodes")
      .select("attachments")
      .eq("user_id", spaUserId)
      .eq("node_type", "service");
    const manufacturers = new Set<string>();
    for (const svc of services ?? []) {
      const att = (svc.attachments ?? {}) as { matchedProduct?: { manufacturer?: string } };
      const m = normalizeManufacturer(att.matchedProduct?.manufacturer);
      if (m) manufacturers.add(m);
    }
    if (manufacturers.size === 0) return { count: 0 };

    const { data: promos } = await sb
      .from("knowledge_nodes")
      .select("id, attachments")
      .eq("node_type", "promotion")
      .limit(500);

    const { data: dismissed } = await sb
      .from("spa_promo_interest")
      .select("promotion_node_id")
      .eq("spa_user_id", spaUserId)
      .eq("status", "dismissed");
    const dismissedSet = new Set((dismissed ?? []).map((d) => d.promotion_node_id));

    const now = Date.now();
    let count = 0;
    for (const p of promos ?? []) {
      if (dismissedSet.has(p.id)) continue;
      const att = (p.attachments ?? {}) as PromotionAttachments;
      const m = normalizeManufacturer(att.manufacturer);
      if (!m || !manufacturers.has(m)) continue;
      const endsMs = att.ends ? new Date(att.ends).getTime() : null;
      const startsMs = att.starts ? new Date(att.starts).getTime() : null;
      const isActive =
        (startsMs === null || startsMs <= now) &&
        (endsMs === null || endsMs >= now);
      if (isActive) count++;
    }
    return { count };
  });
