/**
 * Public /scan page server fns (v369).
 *
 * Two surfaces, both NO-AUTH:
 *
 *   mapHeadersPublic — when the public scanner can't recognize a CSV via
 *     the v367 deterministic cascade, the page calls this with the header
 *     row + 3 sample rows. We check the GLOBAL public_csv_dialect_cache
 *     (keyed by SHA-256 of headers — header shapes are not PII, so global
 *     caching is safe and compounds). On miss, one LLM call → validate →
 *     cache. Returns null on any failure for graceful degrade.
 *
 *   captureScanLead — email + receipt-snapshot capture from the /scan page.
 *     Public anon-INSERT only; reads + updates require service role.
 *
 * Why this matters: every scan teaches the global cache. The 50th med-spa
 * who drops a Symplast export gets an instant cached parse — they never
 * know a previous spa paid the LLM tax for them. Network effect on the
 * data-migration moat: the more spas scan, the faster the cache covers
 * every realistic CSV shape on the market.
 *
 * Privacy: this server-side path NEVER receives appointment rows. The
 * page parses everything client-side. We get the header row + a couple
 * of sample-row arrays (which the page can additionally sanitize before
 * sending) so the LLM can disambiguate column meaning when needed.
 */

import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { callGeminiOneShot } from "@/server/gemini-oneshot";
import type { ColAliases } from "@/lib/appointment-csv";
import {
  sendScanFollowUpEmail,
  sendScanReturnLinkEmail,
} from "@/server/scan-followup";

// ─── Module-private supabase admin (service role) ─────────────────────────

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

// ─── Validation helper (same shape as the authed mapper) ──────────────────

function hashHeaders(headers: string[]): string {
  const normalized = headers.map((h) => h.trim().toLowerCase()).join("|");
  return createHash("sha256").update(normalized).digest("hex");
}

function validateAliases(raw: unknown, headers: string[]): ColAliases {
  if (!raw || typeof raw !== "object") return {};
  const headerSet = new Set(headers.map((h) => h.trim().toLowerCase()));
  const validFields: (keyof ColAliases)[] = [
    "externalId",
    "dateTime",
    "date",
    "time",
    "startTime",
    "endTime",
    "duration",
    "firstName",
    "lastName",
    "fullName",
    "phone",
    "email",
    "service",
    "provider",
    "status",
    "notes",
    "cancelled",
  ];
  const out: ColAliases = {};
  for (const field of validFields) {
    const value = (raw as Record<string, unknown>)[field];
    if (!value) continue;
    const list = Array.isArray(value) ? value : [value];
    const kept = list
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .filter((v) => headerSet.has(v.trim().toLowerCase()));
    if (kept.length > 0) out[field] = kept;
  }
  return out;
}

const SYSTEM_PROMPT = `You map CSV column headers from any med-spa, salon, or wellness scheduling platform to a canonical appointment schema. Return strict JSON only — no prose, no markdown fences.`;

function buildUserPrompt(headers: string[], sampleRows: string[][]): string {
  const headerJson = JSON.stringify(headers);
  const sampleLines = sampleRows
    .slice(0, 3)
    .map((row, i) => `Row ${i + 1}: ${JSON.stringify(row)}`)
    .join("\n");
  return [
    `CSV headers: ${headerJson}`,
    "",
    `Sample data rows:`,
    sampleLines || "(no sample rows available)",
    "",
    `Map these headers to our schema. For each field present, return the EXACT header name.`,
    "",
    `Schema fields:`,
    `- externalId: stable appointment/booking/visit id`,
    `- date / time / dateTime / startTime / endTime / duration`,
    `- fullName / firstName / lastName / phone / email`,
    `- service: treatment / service / procedure / appointment type / event type / class name`,
    `- provider: practitioner / staff / clinician / therapist / stylist / employee / etc.`,
    `- status / notes / cancelled`,
    "",
    `Also guess the source platform if recognizable (Mindbody, JaneApp, Zenoti, Fresha, Square, GlossGenius, Acuity, Boulevard, Mangomint, Vagaro, AestheticsPro, Aesthetic Record, WellnessLiving, SimplePractice, Pabau, Calendly, PatientNow, Nextech, Symplast, Booker, Schedulicity, Moxie, Meevo, RepeatMD). Otherwise null.`,
    "",
    `Return ONLY this JSON, no prose:`,
    `{`,
    `  "platform": "Mindbody" or null,`,
    `  "aliases": { "date": ["<exact header>"], "fullName": ["<exact header>"], ... }`,
    `}`,
    "",
    `Each alias value is an array of strings. Omit fields not present.`,
  ].join("\n");
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const cleaned = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

// ─── Public mapper ───────────────────────────────────────────────────────

const mapHeadersInput = z.object({
  headers: z.array(z.string()).min(1).max(200),
  sampleRows: z.array(z.array(z.string())).max(5).default([]),
});

export type PublicMappingResult = {
  aliases: ColAliases;
  platform: string | null;
  fromCache: boolean;
  headerHash: string;
};

// ─── /onboard wizard — public lead lookup (v384.1) ────────────────────────

const getLeadInput = z
  .object({
    leadId: z.string().uuid().optional(),
    token: z.string().min(8).max(128).optional(),
  })
  .refine((v) => Boolean(v.leadId) || Boolean(v.token), {
    message: "Either leadId or token is required",
  });

export interface ScanLeadForWizard {
  /** Practice name if a setup-intent has been submitted; otherwise null. */
  practiceName: string | null;
  /** Estimated monthly $ leaked to cancellations/no-shows. */
  monthlyLeakUsd: number | null;
  /** Estimated monthly $ Refill could recover (low end). */
  monthlyRecoveryUsd: number | null;
  /** The detected scheduler platform from the scan (acuity, mindbody, etc). */
  detectedPlatform: string | null;
}

/**
 * v384.1: hydrate the /onboard wizard's Step 1 from a /scan lead row.
 *
 * Wizard URL: app.getrefill.app/onboard?step=1&lead=<id>. When the lead
 * param is present, the wizard's welcome card calls this fn to anchor the
 * copy on the user's own scan dollar number (per arch doc §5 Step 1:
 * "Refill estimates ~$3,180 of recoverable no-show revenue per month for
 * Rejuv Skin Spa.").
 *
 * No-auth: lead IDs are uuid-v4 (capability-style — possession of the ID
 * is the authorization). The fields returned are NON-PII (practice name,
 * dollar estimates, scheduler) — the lead email + IP hash are never
 * surfaced. Returns `null` if the leadId doesn't exist so a stale link
 * just falls back to the wizard's generic welcome copy.
 */
export const getScanLeadForWizard = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getLeadInput.parse(raw))
  .handler(async ({ data }): Promise<ScanLeadForWizard | null> => {
    const sb = admin();
    const query = sb
      .from("csv_scanner_leads")
      .select(
        "setup_intent_practice_name, estimated_monthly_leak_usd, estimated_monthly_recovery_usd, detected_platform",
      );
    // Prefer leadId when both are provided; fall back to followup_report_token
    // so the deep-link path from the Refill follow-up email (which only knows
    // the token, not the UUID) works without server-side stitching.
    const filtered = data.leadId
      ? query.eq("id", data.leadId)
      : query.eq("followup_report_token", data.token!);
    const { data: row } = await filtered.maybeSingle();
    if (!row) return null;
    return {
      practiceName: row.setup_intent_practice_name ?? null,
      monthlyLeakUsd: row.estimated_monthly_leak_usd ?? null,
      monthlyRecoveryUsd: row.estimated_monthly_recovery_usd ?? null,
      detectedPlatform: row.detected_platform ?? null,
    };
  });

export const mapHeadersPublic = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => mapHeadersInput.parse(input))
  .handler(async ({ data }): Promise<PublicMappingResult | null> => {
    const sb = admin();
    const headers = data.headers;
    const sampleRows = data.sampleRows;
    const headerHash = hashHeaders(headers);

    // ── Cache hit?
    const { data: cached } = await sb
      .from("public_csv_dialect_cache")
      .select("alias_map, detected_platform, scan_count")
      .eq("header_hash", headerHash)
      .maybeSingle();
    if (cached) {
      const aliases = validateAliases(cached.alias_map, headers);
      if (Object.keys(aliases).length > 0) {
        // v373.5: awaited on Workers — fire-and-forget no-ops at isolate
        // termination, so the scan_count counter never increments.
        try {
          await sb
            .from("public_csv_dialect_cache")
            .update({ scan_count: (cached.scan_count ?? 0) + 1 })
            .eq("header_hash", headerHash);
        } catch (e) {
          console.error(
            "public_csv_dialect_cache scan_count bump failed:",
            e instanceof Error ? e.message : e,
          );
        }
        return {
          aliases,
          platform: cached.detected_platform,
          fromCache: true,
          headerHash,
        };
      }
    }

    // ── Cache miss → LLM call
    let parsed: unknown;
    const modelUsed = process.env.GEMINI_MODEL ?? "gemini-2.5-pro";
    try {
      const text = await callGeminiOneShot(
        SYSTEM_PROMPT,
        buildUserPrompt(headers, sampleRows),
        { temperature: 0.1, maxOutputTokens: 4096, timeoutMs: 20_000 },
      );
      parsed = extractJson(text);
    } catch (err) {
      console.warn(
        "[scan.mapHeadersPublic] LLM mapping failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }

    const platform =
      typeof (parsed as { platform?: unknown })?.platform === "string"
        ? (parsed as { platform: string }).platform
        : null;
    const rawAliases = (parsed as { aliases?: unknown })?.aliases;
    const aliases = validateAliases(rawAliases, headers);
    if (Object.keys(aliases).length === 0) {
      return null;
    }

    const { error: insertErr } = await sb
      .from("public_csv_dialect_cache")
      .upsert(
        {
          header_hash: headerHash,
          detected_platform: platform,
          alias_map: aliases as unknown as Json,
          llm_model: modelUsed,
          scan_count: 1,
        },
        { onConflict: "header_hash" },
      );
    if (insertErr) {
      console.warn(
        "[scan.mapHeadersPublic] cache insert failed (non-fatal):",
        insertErr.message,
      );
    }

    return {
      aliases,
      platform,
      fromCache: false,
      headerHash,
    };
  });

// ─── Lead capture ────────────────────────────────────────────────────────

/** v371: breakdown-bucket shape matches LeakBucket in scan-analysis.ts. */
const leakBucketSchema = z.object({
  label: z.string().max(120),
  cancelledCount: z.number().int().min(0).max(1_000_000),
  refilledCount: z.number().int().min(0).max(1_000_000),
  emptyCount: z.number().int().min(0).max(1_000_000),
  emptyLeakUsd: z.number().min(0).max(10_000_000),
});

const captureLeadInput = z.object({
  email: z.string().email().max(320),
  detectedPlatform: z.string().max(120).nullable().optional(),
  source: z.string().max(120).nullable().optional(),
  appointmentCount: z.number().int().min(0).max(1_000_000).nullable().optional(),
  dateRangeStart: z.string().max(40).nullable().optional(),
  dateRangeEnd: z.string().max(40).nullable().optional(),
  noshowCount: z.number().int().min(0).max(1_000_000).nullable().optional(),
  estimatedMonthlyLeakUsd: z.number().min(0).max(10_000_000).nullable().optional(),
  estimatedMonthlyRecoveryUsd: z.number().min(0).max(10_000_000).nullable().optional(),
  headerSample: z.array(z.string()).max(80).nullable().optional(),
  wasAiMapped: z.boolean().optional().default(false),
  userAgent: z.string().max(500).nullable().optional(),
  // v371: breakdowns for the HTML report attached to the follow-up email.
  // Computed client-side from the parsed appointments; never persisted to
  // csv_scanner_leads (large + transient). Passed straight to the email
  // composer via a module-private handoff so the report can be built.
  totalLossEvents: z.number().int().min(0).max(1_000_000).optional(),
  refilledSlotCount: z.number().int().min(0).max(1_000_000).optional(),
  emptySlotCount: z.number().int().min(0).max(1_000_000).optional(),
  monthsCovered: z.number().min(0).max(1000).optional(),
  monthlyManualSavedUsd: z.number().min(0).max(10_000_000).nullable().optional(),
  byDayOfWeek: z.array(leakBucketSchema).max(7).optional(),
  byProvider: z.array(leakBucketSchema).max(20).optional(),
  byService: z.array(leakBucketSchema).max(20).optional(),
});

export const captureScanLead = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => captureLeadInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; id: string }> => {
    const sb = admin();

    const { data: row, error } = await sb
      .from("csv_scanner_leads")
      .insert({
        email: data.email.trim().toLowerCase(),
        detected_platform: data.detectedPlatform ?? null,
        source: data.source ?? null,
        appointment_count: data.appointmentCount ?? null,
        date_range_start: data.dateRangeStart ?? null,
        date_range_end: data.dateRangeEnd ?? null,
        noshow_count: data.noshowCount ?? null,
        estimated_monthly_leak_usd: data.estimatedMonthlyLeakUsd ?? null,
        estimated_monthly_recovery_usd: data.estimatedMonthlyRecoveryUsd ?? null,
        header_sample: data.headerSample ?? null,
        was_ai_mapped: data.wasAiMapped ?? false,
        user_agent: data.userAgent ?? null,
      })
      .select("id")
      .single();
    if (error) {
      throw new Error(`Couldn't save your email: ${error.message}`);
    }

    // v369.4: AWAIT the follow-up send. The v369.1 fire-and-forget pattern
    // (void .catch) doesn't work on Cloudflare Workers — the isolate
    // terminates the moment the HTTP response is returned, so background
    // promises never resolve. By awaiting, the user waits a few extra
    // seconds for the "Got it" confirmation but the email is guaranteed
    // to fire (or fail in a way that stamps followup_error for diagnosis).
    // Worth the latency trade-off given how critical this email is — it's
    // the entire conversion mechanic from /scan → trial.
    //
    // v371: pass the rich breakdowns (computed client-side, never
    // persisted) so the email composer can attach a polished HTML report.
    try {
      await sendScanFollowUpEmail(sb, row.id, {
        totalLossEvents: data.totalLossEvents ?? null,
        refilledSlotCount: data.refilledSlotCount ?? null,
        emptySlotCount: data.emptySlotCount ?? null,
        monthsCovered: data.monthsCovered ?? null,
        monthlyManualSavedUsd: data.monthlyManualSavedUsd ?? null,
        byDayOfWeek: data.byDayOfWeek ?? null,
        byProvider: data.byProvider ?? null,
        byService: data.byService ?? null,
      });
    } catch (err) {
      // sendScanFollowUpEmail itself already stamps followup_error on
      // any handled failure path. This catch is defensive for any
      // unhandled exception that escapes it.
      console.warn(
        "[captureScanLead] follow-up send threw unhandled:",
        err instanceof Error ? err.message : err,
      );
    }

    return { ok: true, id: row.id };
  });

// ─── Slice B: "email me a link to run my own scan" ─────────────────────────
//
// For visitors who looked at the pre-loaded sample but don't have their export
// handy. Captures the email as a lead (source = "sample-return-link") and
// sends a friendly link back to /scan. No scan math involved — distinct from
// captureScanLead, which sends the breakdown of a real upload.
const returnLinkInput = z.object({ email: z.string().email() });

export const sendScanReturnLink = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => returnLinkInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const sb = admin();
    const email = data.email.trim().toLowerCase();
    const { data: row, error } = await sb
      .from("csv_scanner_leads")
      .insert({ email, source: "sample-return-link" })
      .select("id")
      .single();
    if (error) {
      throw new Error(`Couldn't save your email: ${error.message}`);
    }
    await sendScanReturnLinkEmail(sb, row.id, email);
    return { ok: true };
  });
