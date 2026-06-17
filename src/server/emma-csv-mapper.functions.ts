/**
 * Emma(OS) universal CSV column-mapper (v368).
 *
 * The v367 hardcoded-dialect cascade covers 24 named platforms. v368 closes
 * the long tail: when an upload's headers don't match any known dialect
 * AND the generic fuzzy parser returns zero appointments, we fall back to
 * a single small LLM call that maps the headers → our canonical schema.
 *
 * The mapping is cached per-spa by SHA-256 hash of the normalized header
 * row, so the LLM only runs ONCE per (spa × unique-header-shape). Every
 * re-upload of that CSV shape — even if the spa swaps PMS — is free,
 * deterministic, and instant.
 *
 * Failure modes are all graceful: missing API creds, malformed LLM JSON,
 * LLM picks a header that doesn't actually exist in the CSV — each of
 * these returns null and lets the caller fall through to the generic
 * parse. The mapper never throws upstream.
 *
 * Why this matters strategically: every incumbent's data-migration moat
 * dies the moment a spa can drop ANY appointment CSV — known platform or
 * not — and have it parsed correctly. v367 made the claim "24 platforms".
 * v368 makes the claim "any CSV, period."
 *
 * See [[project-emma-noshow-recovery-engine]] for surrounding architecture.
 */

import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";
import { callGeminiOneShot } from "@/server/gemini-oneshot";
import type { ColAliases } from "@/lib/appointment-csv";

// ─── Public types ─────────────────────────────────────────────────────────

export type AiMappingResult = {
  /** The column-alias map applied to parse the CSV. */
  aliases: ColAliases;
  /** LLM-guessed source platform name (display-only). null if uncertain. */
  platform: string | null;
  /** True when the mapping was served from cache (no LLM call this upload). */
  fromCache: boolean;
  /** True when a human has previously edited this mapping. */
  userCorrected: boolean;
  /** SHA-256 of the normalized header row — surfaced for cache management UI. */
  headerHash: string;
};

// ─── Module-private supabase admin ────────────────────────────────────────

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

// ─── Hashing + validation ─────────────────────────────────────────────────

export function hashHeaders(headers: string[]): string {
  const normalized = headers.map((h) => h.trim().toLowerCase()).join("|");
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Validate an LLM-returned alias map against the actual CSV headers.
 *
 * Drops any alias whose header doesn't case-insensitively exist in the
 * CSV (LLM hallucination guard). Returns the cleaned map.
 */
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

// ─── LLM prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You map CSV column headers from any med-spa, salon, or wellness scheduling platform to a canonical appointment schema. Return strict JSON only — no prose, no markdown fences.`;

function buildUserPrompt(
  headers: string[],
  sampleRows: string[][],
): string {
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
    `Map these headers to our schema. For each field in our schema, return the EXACT header name from the CSV that contains that data, or omit the field if not present.`,
    "",
    `Schema fields:`,
    `- externalId: stable appointment/booking/visit id (for idempotent re-imports)`,
    `- date: date column (e.g. 2026-05-17 or full ISO timestamp)`,
    `- time: time-of-day column (only if separate from date)`,
    `- dateTime: combined date+time column (only if no separate date/time)`,
    `- startTime: when there are start AND end time columns`,
    `- endTime: end time column (paired with startTime)`,
    `- duration: appointment duration column (any units, parser extracts the first integer)`,
    `- fullName: full patient/client/customer/guest/invitee name column`,
    `- firstName / lastName: split-name columns (only if no fullName)`,
    `- phone: any phone/mobile/cell column`,
    `- email: email column`,
    `- service: treatment / service / procedure / appointment type / event type / class name`,
    `- provider: practitioner / provider / staff / therapist / stylist / clinician / employee / physician / instructor / team member`,
    `- status: appointment status column`,
    `- notes: free-form notes/comments column`,
    `- cancelled: a boolean cancelled flag column (Yes/No or true/false), if status is not a separate column`,
    "",
    `Also guess the source platform name if recognizable from header conventions (e.g. Mindbody, JaneApp, Zenoti, Fresha, Square, GlossGenius, Acuity, Boulevard, Mangomint, Vagaro, AestheticsPro, Aesthetic Record, WellnessLiving, SimplePractice, Pabau, Calendly, PatientNow, Nextech, Symplast, Booker, Schedulicity, Moxie, Meevo, RepeatMD). Otherwise return null.`,
    "",
    `Return ONLY this JSON shape, no prose:`,
    `{`,
    `  "platform": "Mindbody" or null,`,
    `  "aliases": {`,
    `    "date": ["<exact CSV header name>"],`,
    `    "time": ["<exact CSV header name>"],`,
    `    "fullName": ["<exact CSV header name>"],`,
    `    "service": ["<exact CSV header name>"],`,
    `    "provider": ["<exact CSV header name>"]`,
    `  }`,
    `}`,
    "",
    `Each alias value is an array of strings (single-element arrays are fine). Omit fields not present.`,
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

// ─── The mapper (callable from any server fn, e.g. ingestAppointmentCsv) ──

/**
 * Map CSV headers to canonical aliases. Cache-first; LLM only on miss.
 *
 * Returns null on any failure (LLM unavailable, malformed JSON, validated
 * alias map ended up empty) so the caller can fall through to the generic
 * fuzzy parse. The caller never has to catch.
 */
export async function mapCsvHeaders(
  sb: SbClient,
  userId: string,
  headers: string[],
  sampleRows: string[][],
): Promise<AiMappingResult | null> {
  if (headers.length === 0) return null;
  const headerHash = hashHeaders(headers);

  // ── Cache hit?
  const { data: cached, error: cacheErr } = await sb
    .from("csv_dialect_cache")
    .select(
      "alias_map, detected_platform, user_corrected_at, use_count",
    )
    .eq("user_id", userId)
    .eq("header_hash", headerHash)
    .maybeSingle();
  if (!cacheErr && cached) {
    const aliases = validateAliases(cached.alias_map, headers);
    if (Object.keys(aliases).length > 0) {
      // v373.5: awaited on Workers — fire-and-forget no-ops at isolate
      // termination, so the use_count counter never increments.
      try {
        await sb
          .from("csv_dialect_cache")
          .update({ use_count: (cached.use_count ?? 0) + 1 })
          .eq("user_id", userId)
          .eq("header_hash", headerHash);
      } catch (e) {
        console.error(
          "csv_dialect_cache use_count bump failed:",
          e instanceof Error ? e.message : e,
        );
      }
      return {
        aliases,
        platform: cached.detected_platform,
        fromCache: true,
        userCorrected: cached.user_corrected_at !== null,
        headerHash,
      };
    }
  }

  // ── Cache miss → LLM call
  let parsed: unknown;
  let modelUsed = process.env.GEMINI_MODEL ?? "gemini-2.5-pro";
  try {
    const text = await callGeminiOneShot(
      SYSTEM_PROMPT,
      buildUserPrompt(headers, sampleRows),
      { temperature: 0.1, maxOutputTokens: 4096, timeoutMs: 20_000 },
    );
    parsed = extractJson(text);
  } catch (err) {
    console.warn(
      "[emma-csv-mapper] LLM mapping failed:",
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

  // ── Cache the result (best-effort; ignore conflict)
  const { error: insertErr } = await sb
    .from("csv_dialect_cache")
    .upsert(
      {
        user_id: userId,
        header_hash: headerHash,
        detected_platform: platform,
        alias_map: aliases as unknown as Json,
        llm_model: modelUsed,
        use_count: 1,
      },
      { onConflict: "user_id,header_hash" },
    );
  if (insertErr) {
    console.warn(
      "[emma-csv-mapper] cache insert failed (non-fatal):",
      insertErr.message,
    );
  }

  return {
    aliases,
    platform,
    fromCache: false,
    userCorrected: false,
    headerHash,
  };
}

// ─── User-facing fns (manual correction + cache management) ───────────────

const updateMappingInput = z.object({
  accessToken: z.string(),
  headerHash: z.string().min(1).max(200),
  aliases: z.record(z.string(), z.array(z.string())),
  platform: z.string().nullable().optional(),
});

/**
 * Spa owner manually corrects a cached mapping (or pre-creates one for a
 * header shape they expect to upload). Stamps user_corrected_at so the
 * LLM never overwrites their fix.
 */
export const updateCsvDialectMapping = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => updateMappingInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const { error } = await sb
      .from("csv_dialect_cache")
      .upsert(
        {
          user_id: userId,
          header_hash: data.headerHash,
          detected_platform: data.platform ?? null,
          alias_map: data.aliases as unknown as Json,
          llm_model: "user_corrected",
          user_corrected_at: new Date().toISOString(),
          use_count: 0,
        },
        { onConflict: "user_id,header_hash" },
      );
    if (error) {
      throw new Error(`Couldn't save mapping correction: ${error.message}`);
    }
    return { ok: true };
  });

const listMappingsInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().uuid().optional(),
});

export type CachedDialectMapping = {
  headerHash: string;
  detectedPlatform: string | null;
  aliasMap: ColAliases;
  llmModel: string;
  llmAt: string;
  userCorrectedAt: string | null;
  useCount: number;
  createdAt: string;
};

/** List a spa's cached mappings — for the settings/audit surface. */
export const listCsvDialectMappings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listMappingsInput.parse(input))
  .handler(async ({ data }): Promise<CachedDialectMapping[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: rows, error } = await sb
      .from("csv_dialect_cache")
      .select(
        "header_hash, detected_platform, alias_map, llm_model, llm_at, user_corrected_at, use_count, created_at",
      )
      .eq("user_id", effectiveUserId)
      .order("llm_at", { ascending: false })
      .limit(50);
    if (error) {
      throw new Error(`Couldn't list cached mappings: ${error.message}`);
    }
    return (rows ?? []).map((r) => ({
      headerHash: r.header_hash,
      detectedPlatform: r.detected_platform,
      aliasMap: r.alias_map as unknown as ColAliases,
      llmModel: r.llm_model,
      llmAt: r.llm_at,
      userCorrectedAt: r.user_corrected_at,
      useCount: r.use_count,
      createdAt: r.created_at,
    }));
  });
