/**
 * Refill outreach sending pipeline (v394).
 *
 * Two surfaces:
 *
 *   renderTemplatePreview — pure substitution. No DB write, no email
 *     send. Used by the admin Preview button to show what the rendered
 *     output looks like with sample placeholder values.
 *
 *   sendOutreachEmail — full sending pipeline:
 *     1. Resolve the active template by (icp, channel)
 *     2. Substitute placeholders against the provided context
 *     3. Pre-allocate an outreach_engagement_events row to get the
 *        plus-address Reply-To token (the row id)
 *     4. Mode branch:
 *        - send_mode='dry_run' (default when OUTREACH_LIVE!=true):
 *          stamp the rendered snapshot on the row, return without
 *          calling Resend
 *        - send_mode='test': same as dry_run but explicitly tagged so
 *          we can filter operator previews from system bench
 *        - send_mode='live' (only when OUTREACH_LIVE=true AND caller
 *          didn't pass dryRun:true): POST to Resend, stamp resend_email_id
 *
 * Feature flag: OUTREACH_LIVE env var. When 'true', non-test calls fire
 * real Resend POSTs. Otherwise everything falls to dry_run regardless of
 * what the caller asked for. Per [[project_outreach_paused]] the flag is
 * OFF by default — v394 lands the pipeline as a stub.
 *
 * Reply routing: the row's id is used directly as the plus-address token
 * (karen+<id>@reply.openagentic.site). routeInboundOutreachReply in
 * src/server/refill-inbox.ts handles the inbound side.
 *
 * Placeholders supported (case-insensitive):
 *   [first name] / [name]      — recipient first name
 *   [spa name]                 — recipient's spa
 *   [acuity URL]               — recipient's Acuity booking URL (ICP 3)
 *   $[exact figure] / $[recent figure]  — live Rejuv recovered $
 *   [N] weeks                  — how long Rejuv has been running it
 *   [recipient]                — generic fallback (rare)
 *
 * Per [[feedback_math_must_be_exact]]: if a numeric placeholder doesn't
 * have a value supplied, we LEAVE THE LITERAL PLACEHOLDER in the output
 * so it's visible during preview that data is missing. Better to ship a
 * draft with [N] weeks than to silently insert "0 weeks."
 *
 * Established 2026-05-20 (v394, post-v393 ship).
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { DIRECT_COMMISSION_RATE, formatRate } from "@/lib/rep-economics";
import { requireRepOrAdmin } from "@/server/auth-helpers";

// ─── service-role admin client (module-private) ──────────────────────────

type SbClient = ReturnType<typeof createClient<Database>>;

function admin(): SbClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// v397 Phase 2E: local requireAdmin removed — all callers now go through
// requireRepOrAdmin from auth-helpers (admin sends keep Karen persona; rep
// sends override the From: line via buildRepFrom below).

// ─── Sender config ───────────────────────────────────────────────────────

const KAREN_FROM =
  process.env.REFILL_OUTREACH_FROM ?? "Karen Anderson <karen@getrefill.app>";
const REPLY_DOMAIN =
  process.env.REFILL_DRIP_REPLY_DOMAIN ?? "reply.openagentic.site";
const KAREN_LOCAL_PART =
  process.env.REFILL_OUTREACH_LOCAL_PART ?? "karen";
// v408: getrefill.app is verified in Resend for any local part. Recruit
// sends use <rep first name>@getrefill.app so the From: address matches
// the voice (Kelly sending peer-rep recruit is "Kelly Caffee <kelly@…>",
// not "Kelly Caffee <karen@…>"). Spa outreach keeps the karen@ address
// because Karen is still the credibility source even when a rep dispatches.
const RECRUIT_DOMAIN =
  process.env.REFILL_RECRUIT_DOMAIN ?? "getrefill.app";

function buildReplyTo(eventId: string, displayName = "Karen Anderson"): string {
  return `${displayName} <${KAREN_LOCAL_PART}+${eventId}@${REPLY_DOMAIN}>`;
}

// v397 Phase 2E: when an active rep sends, the From: line uses the rep's
// display name with the same verified send address (so SPF/DKIM/DMARC stay
// aligned with the karen@getrefill.app sender that Resend is set up for).
// Spa owner sees "Kelly Caffee" in their inbox; hovering reveals the
// karen@getrefill.app address. Reply-To still uses the existing plus-address
// token shape so routeInboundOutreachReply matches without changes.
// sent_by column audits which rep fired the send.
function buildRepFrom(displayName: string): string {
  const safe = displayName.replace(/[<>"\r\n]/g, "").trim() || "Refill";
  // Extract the bare address from KAREN_FROM (e.g. "Karen … <karen@getrefill.app>" → "karen@getrefill.app").
  const angleMatch = KAREN_FROM.match(/<([^>]+)>/);
  const bareAddr = angleMatch ? angleMatch[1] : KAREN_FROM;
  return `${safe} <${bareAddr}>`;
}

// v408: peer-rep recruit sender. Maps rep display name to <firstName>@getrefill.app
// (e.g. "Kelly Caffee" → "Kelly Caffee <kelly@getrefill.app>", "Maria Chen" →
// "Maria Chen <maria@getrefill.app>"). The domain is verified in Resend so
// any local part lands without per-address registration. Falls back to "rep@"
// if the display name has no usable alpha chars (defensive).
function buildRecruitFrom(displayName: string): string {
  const safe = displayName.replace(/[<>"\r\n]/g, "").trim() || "Refill";
  const firstWord = (safe.split(/\s+/)[0] ?? "rep").toLowerCase();
  const localPart = firstWord.replace(/[^a-z0-9]/g, "") || "rep";
  return `${safe} <${localPart}@${RECRUIT_DOMAIN}>`;
}

// ─── Placeholder substitution ────────────────────────────────────────────

export interface PlaceholderContext {
  firstName?: string;
  lastName?: string;
  spaName?: string;
  acuityUrl?: string;
  rejuvRecoveredAmount?: string;   // "$4,275" — pre-formatted, no rounding
  rejuvRecoveredWeeks?: string;    // "5" or "5 weeks" — caller decides
  rejuvRecentRecoveredAmount?: string;
  recipient?: string;
  // v403 Pinch #18: rep-as-messenger voice-shift. Templates can now reference
  // [from] (full sender display name, e.g. "Kelly Caffee") and [from first
  // name] (e.g. "Kelly") so the body voices the actual sender — not first-
  // person Karen — when a rep dispatches outreach. Admin sends default to
  // "Karen Anderson" / "Karen" so the legacy templates still render correctly.
  senderName?: string;
  senderFirstName?: string;
  // v408: rep-recruit placeholders, voiced from the sender's own rep stats.
  // [my commission rate]  → "3%" (Tier-1 split formatted)
  // [my month earnings]   → "2,400" (last 30 days commission USD, comma-formatted)
  // [my downstream count] → "7" (active Tier-1 sub-rep count)
  // Per [[feedback-math-must-be-exact]] — if a value is unknown or zero, the
  // literal placeholder stays in the body so the sender sees the gap and
  // edits manually rather than shipping "$0" or "0 reps" into a recruit email.
  myCommissionRate?: string;
  myMonthEarnings?: string;
  myDownstreamCount?: string;
}

/**
 * Substitute placeholders in template text. Unknown placeholders are
 * LEFT INTACT so they're visible during preview — never silently filled
 * with "" or "0". Case-insensitive on bracket variants like [first name]
 * vs [First Name].
 */
export function substitutePlaceholders(
  template: string,
  ctx: PlaceholderContext,
): string {
  const replace = (pattern: RegExp, value: string | undefined) => {
    if (value === undefined || value === null || value === "") return; // keep literal
    template = template.replace(pattern, value);
  };

  replace(/\[first name\]/gi, ctx.firstName);
  replace(/\[name\]/gi, ctx.firstName);
  replace(/\[spa name\]/gi, ctx.spaName);
  replace(/\[acuity URL\]/gi, ctx.acuityUrl);
  replace(/\$\[exact figure\]/gi, ctx.rejuvRecoveredAmount);
  replace(/\$\[recent figure\]/gi, ctx.rejuvRecentRecoveredAmount);
  replace(/\[N\] weeks/gi, ctx.rejuvRecoveredWeeks);
  replace(/\[recipient\]/gi, ctx.recipient ?? ctx.firstName);
  replace(/\[the recipient\]/gi, ctx.recipient ?? ctx.firstName);
  // v403 Pinch #18: [from first name] must precede [from] so the longer
  // token matches first — otherwise [from] would consume the prefix and
  // leave a literal " first name]" tail behind.
  replace(/\[from first name\]/gi, ctx.senderFirstName);
  replace(/\[from\]/gi, ctx.senderName);
  // v408: rep-recruit placeholders. Same longer-first ordering discipline
  // (none of these prefix-collide today but the policy holds).
  replace(/\[my commission rate\]/gi, ctx.myCommissionRate);
  replace(/\[my month earnings\]/gi, ctx.myMonthEarnings);
  replace(/\[my downstream count\]/gi, ctx.myDownstreamCount);

  return template;
}

// ─── Template lookup (mirrors getActiveTemplate but admin client) ────────

async function getActiveTemplateInternal(
  sb: SbClient,
  icp: number,
  channel: string,
  audience: "spa" | "rep" = "spa",
): Promise<Database["public"]["Tables"]["outreach_templates"]["Row"] | null> {
  const { data, error } = await sb
    .from("outreach_templates")
    .select("*")
    .eq("icp", icp)
    .eq("channel", channel)
    .eq("audience", audience)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    throw new Error(`Couldn't load template: ${error.message}`);
  }
  return data;
}

// v408: live rep stats for the rep-recruit placeholder context. Pulled at
// send time (and surfaced via getMyRecruitStats for the recruit page UI
// chips). Per [[feedback-math-must-be-exact]] — if a value is zero or
// unknown we return undefined so the placeholder stays literal in the
// rendered body rather than rendering "$0" or "0 reps" into a recruit pitch.
//
// commissionRate is hardcoded to "3%" because Tier-1 direct is the
// structural rate every active rep gets — not a per-rep calibration. If a
// future rep_accounts override column appears, read it here.
async function loadRepStatsForPlaceholders(
  sb: SbClient,
  repUserId: string,
): Promise<{
  myCommissionRate: string;
  myMonthEarnings?: string;
  myDownstreamCount?: string;
}> {
  // Direct downstream count (Tier-1 only — the number Kelly can credibly
  // claim as "reps I personally recruited").
  const { data: affilRows } = await sb
    .from("rep_affiliations")
    .select("rep_id")
    .eq("parent_rep_id", repUserId)
    .eq("tier_level", 1)
    .eq("active", true);

  const downstream = (affilRows ?? []).length;

  // Trailing-30-day commission, summing Tier-1 + Tier-2 ledger rows. Reads
  // the rep_commission_ledger directly (admin client bypasses RLS). Filters
  // by created_at >= now()-30d on the ledger row; period_month is monthly-
  // bucketed and 30 days could span 2 periods so we sum any row created in
  // the window.
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: ledgerRows } = await sb
    .from("rep_commission_ledger")
    .select("commission_usd")
    .eq("rep_id", repUserId)
    .neq("status", "voided")
    .gte("created_at", sinceIso);

  const monthEarnings = (ledgerRows ?? []).reduce(
    (sum, r) => sum + Number(r.commission_usd ?? 0),
    0,
  );

  return {
    myCommissionRate: formatRate(DIRECT_COMMISSION_RATE),
    myMonthEarnings:
      monthEarnings > 0
        ? Math.round(monthEarnings).toLocaleString("en-US")
        : undefined,
    myDownstreamCount: downstream > 0 ? String(downstream) : undefined,
  };
}

// v408: surface live rep stats to the recruit page UI as read-only chips
// so the rep sees exactly what's going to substitute into the placeholders
// before they click Send. Same data the send pipeline uses internally —
// single source of truth.

const repStatsInput = z.object({ accessToken: z.string().min(1) });

export const getMyRecruitStats = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => repStatsInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      myCommissionRate: string;
      myMonthEarnings: string | null;
      myDownstreamCount: string | null;
    }> => {
      const sb = admin();
      const principal = await requireRepOrAdmin(sb, data.accessToken);
      const stats = await loadRepStatsForPlaceholders(sb, principal.userId);
      return {
        myCommissionRate: stats.myCommissionRate,
        myMonthEarnings: stats.myMonthEarnings ?? null,
        myDownstreamCount: stats.myDownstreamCount ?? null,
      };
    },
  );

// ─── renderTemplatePreview — admin Preview button ────────────────────────

const previewInput = z.object({
  accessToken: z.string().min(1),
  icp: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  channel: z.string().min(1).max(80),
  // v408: optional audience filter — defaults to 'spa' for back-compat.
  audience: z.enum(["spa", "rep"]).optional(),
  // Optional override — useful for previewing UNSAVED edits in the modal
  // without round-tripping to DB. When provided, these win over the DB row.
  draftSubject: z.string().nullable().optional(),
  draftBody: z.string().min(1).optional(),
  context: z
    .object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      spaName: z.string().optional(),
      acuityUrl: z.string().optional(),
      rejuvRecoveredAmount: z.string().optional(),
      rejuvRecoveredWeeks: z.string().optional(),
      rejuvRecentRecoveredAmount: z.string().optional(),
      recipient: z.string().optional(),
      // v408 rep-recruit context (UI sends what it's showing as chips):
      myCommissionRate: z.string().optional(),
      myMonthEarnings: z.string().optional(),
      myDownstreamCount: z.string().optional(),
    })
    .optional(),
});

export const renderTemplatePreview = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => previewInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      subject: string | null;
      body: string;
      replyToSample: string;
      placeholdersFound: string[];
    }> => {
      const sb = admin();
      // v397 Phase 2E: reps need preview before they send.
      await requireRepOrAdmin(sb, data.accessToken);

      // Resolve subject + body from either the draft override or the DB row.
      let subject: string | null;
      let body: string;
      const audience = data.audience ?? "spa";
      if (data.draftBody !== undefined) {
        subject = data.draftSubject ?? null;
        body = data.draftBody;
      } else {
        const tpl = await getActiveTemplateInternal(sb, data.icp, data.channel, audience);
        if (!tpl) {
          throw new Error(`No active ${audience} template for icp=${data.icp} channel=${data.channel}`);
        }
        subject = tpl.subject;
        body = tpl.body;
      }

      const ctx = data.context ?? {};
      const renderedSubject = subject
        ? substitutePlaceholders(subject, ctx)
        : null;
      const renderedBody = substitutePlaceholders(body, ctx);

      // Detect any remaining unfilled placeholders so the UI can highlight.
      const combined = `${renderedSubject ?? ""}\n${renderedBody}`;
      const placeholderMatches = combined.match(/\[[a-z\s]+\]|\$\[[a-z\s]+\]/gi) ?? [];
      const placeholdersFound = Array.from(new Set(placeholderMatches));

      // Sample Reply-To so the operator can see the address shape even
      // though no row is created.
      const replyToSample = buildReplyTo("00000000-0000-0000-0000-000000000000");

      return {
        subject: renderedSubject,
        body: renderedBody,
        replyToSample,
        placeholdersFound,
      };
    },
  );

// ─── sendOutreachEmail — full send pipeline (feature-flag gated) ─────────

const sendInput = z.object({
  accessToken: z.string().min(1),
  icp: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  channel: z.string().min(1).max(80),
  // v408: audience defaults to 'spa' (back-compat with the original outreach
  // page). The recruit page passes 'rep' to filter templates, swap the From:
  // line to <repFirstName>@getrefill.app, load rep-stat placeholders, and
  // stamp purpose='rep_recruit' on the engagement event.
  audience: z.enum(["spa", "rep"]).optional(),
  recipientEmail: z.string().email(),
  recipientFirstName: z.string().optional(),
  recipientLastName: z.string().optional(),
  sourceContext: z.string().optional(),
  context: z
    .object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      spaName: z.string().optional(),
      acuityUrl: z.string().optional(),
      rejuvRecoveredAmount: z.string().optional(),
      rejuvRecoveredWeeks: z.string().optional(),
      rejuvRecentRecoveredAmount: z.string().optional(),
      recipient: z.string().optional(),
    })
    .optional(),
  // Operator forced override: true = always dry_run, regardless of flag.
  // Used by the "Test send" affordance to be explicit that no real email
  // fires even if OUTREACH_LIVE=true.
  dryRun: z.boolean().optional(),
});

export type SendMode = "dry_run" | "test" | "live";

export const sendOutreachEmail = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => sendInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      mode: SendMode;
      eventId: string;
      renderedSubject: string | null;
      renderedBody: string;
      replyTo: string;
      resendEmailId: string | null;
      message: string;
    }> => {
      const sb = admin();
      // v397 Phase 2E: active reps OR admins can send. When a rep fires the
      // send, From: uses the rep's display name; admin sends keep "Karen
      // Anderson". sent_by column audits either path.
      const principal = await requireRepOrAdmin(sb, data.accessToken);
      const userId = principal.userId;

      // Resolve mode. Feature flag is the master gate.
      const OUTREACH_LIVE = process.env.OUTREACH_LIVE === "true";
      const mode: SendMode = data.dryRun
        ? "test"
        : OUTREACH_LIVE
          ? "live"
          : "dry_run";

      // v408: audience drives template filter, From: line, placeholder set,
      // and purpose column. Defaults to 'spa' for back-compat.
      const audience: "spa" | "rep" = data.audience ?? "spa";
      const purpose = audience === "rep" ? "rep_recruit" : "spa_outreach";

      // Load template
      const tpl = await getActiveTemplateInternal(sb, data.icp, data.channel, audience);
      if (!tpl) {
        throw new Error(
          `No active ${audience} template for icp=${data.icp} channel=${data.channel}`,
        );
      }

      // v403 Pinch #18: resolve sender persona BEFORE building the placeholder
      // context so [from] / [from first name] render in the body. Rep sends
      // voice as the rep ("My friend Karen at Rejuv built this... — Kelly"),
      // admin sends keep "Karen Anderson" / "Karen" so legacy ICP-1 templates
      // (where Karen messages her own warm network) still read first-person.
      const senderDisplayName = principal.isRep && principal.repDisplayName
        ? principal.repDisplayName
        : "Karen Anderson";
      const senderFirstNameToken =
        senderDisplayName.split(/\s+/)[0] || senderDisplayName;

      // v408: when audience='rep', load live rep stats for the recruit
      // placeholders. Skipped for spa audience (zero cost; no rep stats are
      // referenced by any spa template).
      const repStats =
        audience === "rep" && principal.isRep
          ? await loadRepStatsForPlaceholders(sb, userId)
          : null;

      // Build context with auto-fill of recipient name fields from explicit args
      const ctx: PlaceholderContext = {
        firstName:
          data.context?.firstName ?? data.recipientFirstName ?? undefined,
        lastName: data.context?.lastName ?? data.recipientLastName ?? undefined,
        spaName: data.context?.spaName,
        acuityUrl: data.context?.acuityUrl,
        rejuvRecoveredAmount: data.context?.rejuvRecoveredAmount,
        rejuvRecoveredWeeks: data.context?.rejuvRecoveredWeeks,
        rejuvRecentRecoveredAmount: data.context?.rejuvRecentRecoveredAmount,
        recipient: data.context?.recipient,
        senderName: senderDisplayName,
        senderFirstName: senderFirstNameToken,
        myCommissionRate: repStats?.myCommissionRate,
        myMonthEarnings: repStats?.myMonthEarnings,
        myDownstreamCount: repStats?.myDownstreamCount,
      };

      const renderedSubject = tpl.subject
        ? substitutePlaceholders(tpl.subject, ctx)
        : null;
      const renderedBody = substitutePlaceholders(tpl.body, ctx);

      // Insert engagement row FIRST so we have the row id to use as the
      // plus-address token in the Reply-To.
      const { data: row, error: insErr } = await sb
        .from("outreach_engagement_events")
        .insert({
          recipient_email: data.recipientEmail,
          recipient_first_name: data.recipientFirstName ?? null,
          recipient_last_name: data.recipientLastName ?? null,
          source_context: data.sourceContext ?? null,
          template_id: tpl.id,
          icp: data.icp,
          channel: data.channel,
          send_mode: mode,
          purpose,
          rendered_subject: renderedSubject,
          rendered_body: renderedBody,
          sent_by: userId,
        })
        .select("*")
        .single();
      if (insErr || !row) {
        throw new Error(`Couldn't pre-allocate engagement row: ${insErr?.message}`);
      }

      // v397: when a rep is the sender, From:/Reply-To use the rep's display
      // name. Admin sends keep "Karen Anderson" as the persona.
      // v408: audience='rep' routes the From: line through buildRecruitFrom
      // so peer-rep recruit emails come from <repFirstName>@getrefill.app
      // (Kelly Caffee <kelly@getrefill.app>) instead of the spa-outreach
      // karen@ address. Reply-To stays on karen+<id>@reply.openagentic.site
      // so the inbound dispatcher keeps a single local-part to match against.
      const fromLine =
        audience === "rep" && principal.isRep && principal.repDisplayName
          ? buildRecruitFrom(principal.repDisplayName)
          : principal.isRep && principal.repDisplayName
            ? buildRepFrom(principal.repDisplayName)
            : KAREN_FROM;
      const replyTo = buildReplyTo(row.id, senderDisplayName);

      // Non-live modes return without firing Resend.
      if (mode !== "live") {
        return {
          mode,
          eventId: row.id,
          renderedSubject,
          renderedBody,
          replyTo,
          resendEmailId: null,
          message:
            mode === "dry_run"
              ? "Logged dry-run. Set OUTREACH_LIVE=true on the worker to enable real sends."
              : "Operator test render. No email sent regardless of flag.",
        };
      }

      // ── LIVE PATH ────────────────────────────────────────────────────
      const RESEND_API_KEY = process.env.RESEND_API_KEY;
      if (!RESEND_API_KEY) {
        throw new Error(
          "OUTREACH_LIVE=true but RESEND_API_KEY is not set on the worker.",
        );
      }
      if (!renderedSubject) {
        throw new Error(
          `Live send requires a subject. Channel '${data.channel}' has none.`,
        );
      }

      const resendBody = {
        from: fromLine,
        to: data.recipientEmail,
        subject: renderedSubject,
        html: renderedBody,
        reply_to: replyTo,
        tags: [
          { name: "product", value: "refill" },
          { name: "stream", value: "outreach" },
          { name: "icp", value: String(data.icp) },
          { name: "channel", value: data.channel },
          // v408: audience + purpose let Resend analytics split rep-recruit
          // engagement from spa-outreach engagement without joining back to
          // outreach_engagement_events.
          { name: "audience", value: audience },
          { name: "purpose", value: purpose },
        ],
      };

      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(resendBody),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        // Stamp the row with the error context so we have a forensic trail.
        await sb
          .from("outreach_engagement_events")
          .update({ resend_email_id: null })
          .eq("id", row.id);
        throw new Error(`Resend POST failed (${resp.status}): ${errText.slice(0, 300)}`);
      }

      const resendData = (await resp.json().catch(() => ({}))) as {
        id?: string;
      };
      const resendEmailId = resendData.id ?? null;

      // Stamp resend_email_id on the engagement row.
      if (resendEmailId) {
        await sb
          .from("outreach_engagement_events")
          .update({ resend_email_id: resendEmailId })
          .eq("id", row.id);
      }

      return {
        mode: "live",
        eventId: row.id,
        renderedSubject,
        renderedBody,
        replyTo,
        resendEmailId,
        message: `Live send dispatched via Resend (${resendEmailId ?? "no-id-returned"}).`,
      };
    },
  );

// ─── getOutreachSendMode — pre-click affordance for rep UI ───────────────
// v404 Pinch #14b: the rep-facing Send button should TELEGRAPH whether the
// click is going to fire a real Resend POST or just log a dry-run row,
// BEFORE the click — not after. Returns the worker's effective live-send
// state so the button can render "Send (dry-run)" vs "Send LIVE" with
// distinct visual treatment (color shift on LIVE to break muscle-memory).
// Auth-gated via requireRepOrAdmin: this isn't sensitive but matches the
// pattern of every other rep-platform server fn.

const sendModeInput = z.object({ accessToken: z.string().min(1) });

export const getOutreachSendMode = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => sendModeInput.parse(raw))
  .handler(async ({ data }): Promise<{ liveEnabled: boolean }> => {
    await requireRepOrAdmin(admin(), data.accessToken);
    return { liveEnabled: process.env.OUTREACH_LIVE === "true" };
  });
