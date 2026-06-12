/**
 * Manufacturer reward-signal ingestion server functions —
 * Patient-Profitability OS · Phase 0 · Manufacturer Import → RewardSignal.
 *
 * Public surface:
 *   ingestManufacturerRewardCsv — accept a raw manufacturer rewards CSV,
 *       parse it (pure lib), match each patient to the spa's own patient
 *       graph (email → phone → name), upsert per-patient×brand snapshot rows
 *       into patient_reward_entries, fill blank contact gaps on matched
 *       patients, and persist + return a one-screen receipt.
 *   listRewardSignal — for /app/refill/recognition/rewards: the headline
 *       summary (eligible-now / expiring-≤60d / $ on the table) + entries
 *       (joined to patient display name) + recent import history.
 *
 * Pattern follows patient-ingest.functions.ts: explicit accessToken,
 * resolveEffectiveUserId (admin viewing-as a tenant), service-role client
 * for writes. All reads/writes go through the service role, so the new
 * tables are service-role-only at the RLS layer.
 *
 * Established 2026-06-07 (Patient-Profitability OS P0).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import { resolveMatch, type MatchResolution } from "@/lib/match-confidence";
import {
  parseRewardCsv,
  summarizeRewardEntries,
  rewardMatchKey,
  normEmail,
  normPhone,
  nameTokenKey,
  detectMapperFromCsv,
  MANUFACTURER_MAPPERS,
  type RewardEntry,
  type RewardSignalSummary,
  type RewardStatusNorm,
} from "@/lib/manufacturer-reward-csv";

// ─── Service-role client (mirrors patient-ingest's admin()) ────────────────

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
type SupabaseAdmin = ReturnType<typeof admin>;

/** Loose table view for tables not yet in the generated types (mirrors the
 *  expect-gate's expectedTbl in connection-health.functions.ts). The migration
 *  ships before this code, so production has the tables when these run. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function looseTbl(sb: SupabaseAdmin, t: string): any {
  return (sb as unknown as { from(t: string): unknown }).from(t);
}

/** Stable non-crypto hash (FNV-1a 32-bit → hex) — Workers-safe, no node:crypto. */
function rowHash(parts: Array<string | number | null>): string {
  const s = parts.map((p) => (p == null ? "" : String(p))).join("");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ─── Public receipt + list types ───────────────────────────────────────────

export type RewardImportReceipt = {
  manufacturer: string;
  program: string | null;
  dataRows: number;
  entriesUpserted: number;
  matched: number;
  /** Confidently-skipped: matched >1 patient, held for the owner's eyes
   *  instead of being silently credited to whoever sorted first. */
  held: number;
  unmatchedWithContact: number;
  contactsFilled: number;
  summary: RewardSignalSummary;
  warnings: Array<{ sourceRow: number; message: string }>;
};

export type RewardEntryRow = {
  id: string;
  manufacturer: string;
  program: string | null;
  brandProduct: string;
  productKind: string | null;
  statusRaw: string | null;
  statusNorm: RewardStatusNorm;
  eligibleDate: string | null;
  expirationDate: string | null;
  rewardAmountUsd: number | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  lastVisit: string | null;
  patientNodeId: string | null;
  patientName: string | null;
  matched: boolean;
  updatedAt: string;
};

export type RewardImportRow = {
  id: string;
  manufacturer: string;
  program: string | null;
  sourceFilename: string | null;
  rowCount: number;
  entryCount: number;
  matchedCount: number;
  newContactsCount: number;
  contactsFilledCount: number;
  importedAt: string;
};

export type RewardSignalView = {
  summary: RewardSignalSummary;
  entries: RewardEntryRow[];
  imports: RewardImportRow[];
};

// ─── Minimal attachments shape we read off knowledge_nodes ─────────────────

type NodeContact = {
  phone?: string | null;
  phoneRaw?: string | null;
  email?: string | null;
  contactSource?: string | null;
  contactLinkedAt?: string | null;
  [k: string]: unknown;
};

// ─── ingestManufacturerRewardCsv ───────────────────────────────────────────

const ingestInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  manufacturer: z.string(),
  csv: z.string(),
  sourceFilename: z.string().nullable().optional(),
});

export const ingestManufacturerRewardCsv = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ingestInput.parse(input))
  .handler(async ({ data }): Promise<RewardImportReceipt> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    return doIngestRewards(
      sb,
      effectiveUserId,
      data.manufacturer,
      data.csv,
      data.sourceFilename ?? null,
    );
  });

export async function doIngestRewards(
  sb: SupabaseAdmin,
  userId: string,
  manufacturer: string,
  csv: string,
  sourceFilename: string | null,
): Promise<RewardImportReceipt> {
  if (!MANUFACTURER_MAPPERS[manufacturer]) {
    throw new Error(`Unsupported manufacturer: ${manufacturer}`);
  }

  // 1) Parse — pure, no I/O.
  const parsed = parseRewardCsv(manufacturer, csv);
  if (parsed.entries.length === 0) {
    throw new Error(
      "Couldn't find any reward rows in that CSV. Is this the manufacturer's patient-insights export?",
    );
  }

  // 2) Pre-fetch the spa's patient nodes once, build email/phone/name match
  //    maps in memory (same approach as patient-ingest's existing-node fetch).
  // v1.92.1: page past the 1,000-row cap — matching only against the first
  // 1,000 of a 1,140-patient book understated the match rate (entries for
  // patients past row 1,000 were wrongly flagged "not in your book").
  const nodes = await fetchAllRows<{
    id: string;
    lookup_key: string | null;
    title: string;
    attachments: unknown;
  }>((from, to) =>
    sb
      .from("knowledge_nodes")
      .select("id, lookup_key, title, attachments")
      .eq("user_id", userId)
      .eq("node_type", "patient")
      .eq("context", "patients")
      .order("id", { ascending: true })
      .range(from, to),
  );

  // Multi-candidate index: keep EVERY node a key points to, not just the first.
  // The old "first wins" silently credited a shared-email reward to whichever
  // patient sorted first; the confidence gate needs to SEE the collision.
  const byEmail = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const attByNode = new Map<string, NodeContact>();
  const titleByNode = new Map<string, string>();
  const pushKey = (m: Map<string, string[]>, k: string | null, id: string) => {
    if (!k) return;
    const arr = m.get(k);
    if (arr) {
      if (!arr.includes(id)) arr.push(id);
    } else m.set(k, [id]);
  };
  for (const n of nodes ?? []) {
    const a = (n.attachments as NodeContact | null) ?? {};
    attByNode.set(n.id, a);
    titleByNode.set(n.id, n.title ?? n.lookup_key ?? "");
    pushKey(byEmail, normEmail(a.email ?? null), n.id);
    pushKey(byPhone, normPhone((a.phone ?? a.phoneRaw ?? null) as string | null), n.id);
    pushKey(byName, nameTokenKey(n.title ?? n.lookup_key ?? null), n.id);
  }

  // Correction-teaches: a reward whose exact contact fingerprint the owner has
  // already confirmed resolves straight to that patient, no second guess.
  const aliasByFp = new Map<string, string>();
  {
    const { data: aliasRows } = await looseTbl(sb, "reward_match_aliases")
      .select("fingerprint, node_id")
      .eq("user_id", userId);
    for (const r of (aliasRows ?? []) as Array<{ fingerprint: string; node_id: string }>) {
      if (r.fingerprint && r.node_id) aliasByFp.set(r.fingerprint, r.node_id);
    }
  }

  // name|email|phone — the alias key. Carries the name so a spouse on the same
  // shared email is NOT silently inherited (their name differs → no alias hit).
  const fingerprintOf = (e: RewardEntry): string =>
    [nameTokenKey(e.contactName), normEmail(e.contactEmail), normPhone(e.contactPhone)]
      .map((x) => x ?? "")
      .join("|");

  // Resolve every entry to a confidence tier up front. "high"/"learned" attribute
  // as before; "ambiguous" is HELD (orphaned + a review card); "none" is the
  // existing unmatched path. Computed once and reused for counts + holds.
  const resolutionOf = (e: RewardEntry): MatchResolution => {
    const fp = fingerprintOf(e);
    const aliasId = aliasByFp.get(fp);
    const emailKey = normEmail(e.contactEmail);
    const phoneKey = normPhone(e.contactPhone);
    const nameKey = nameTokenKey(e.contactName);
    return resolveMatch({
      aliasNodeId: aliasId && attByNode.has(aliasId) ? aliasId : null,
      emailIds: emailKey ? byEmail.get(emailKey) : undefined,
      phoneIds: phoneKey ? byPhone.get(phoneKey) : undefined,
      nameIds: nameKey ? byName.get(nameKey) : undefined,
    });
  };

  const planByEntry = new Map<RewardEntry, MatchResolution>();
  for (const e of parsed.entries) planByEntry.set(e, resolutionOf(e));

  // A confident match attributes; ambiguous/none leave the node null (orphan row).
  const confidentNode = (res: MatchResolution): string | null =>
    res.tier === "high" || res.tier === "learned" ? res.nodeId : null;

  // 3) Record the import row first so entries can reference it.
  const { data: importRow, error: importErr } = await sb
    .from("reward_signal_imports")
    .insert({
      user_id: userId,
      manufacturer,
      program: parsed.program,
      source_filename: sourceFilename,
      row_count: parsed.dataRowCount,
      entry_count: parsed.entries.length,
      matched_count: 0,
      new_contacts_count: 0,
      contacts_filled_count: 0,
    })
    .select("id")
    .single();
  if (importErr || !importRow) {
    throw new Error(`Couldn't record the import: ${importErr?.message ?? "unknown"}`);
  }
  const importId = importRow.id;

  // 4) Build upsert rows + plan contact-gap fills for matched patients.
  type FillPatch = { email?: string; phone?: string };
  const fillByNode = new Map<string, FillPatch>();
  let matched = 0;

  const upsertRows = parsed.entries.map((e) => {
    const nodeId = confidentNode(planByEntry.get(e)!);
    if (nodeId) {
      matched++;
      // Plan a gap-fill if the patient is missing a channel this entry has.
      const a = attByNode.get(nodeId) ?? {};
      const haveEmail = !!normEmail(a.email ?? null);
      const havePhone = !!normPhone((a.phone ?? a.phoneRaw ?? null) as string | null);
      const eEmail = normEmail(e.contactEmail);
      const ePhone = normPhone(e.contactPhone);
      if ((!haveEmail && eEmail) || (!havePhone && ePhone)) {
        const patch = fillByNode.get(nodeId) ?? {};
        if (!haveEmail && eEmail && !patch.email) patch.email = e.contactEmail!.trim();
        if (!havePhone && ePhone && !patch.phone) patch.phone = e.contactPhone!.trim();
        fillByNode.set(nodeId, patch);
      }
    }
    const match_key = rewardMatchKey(e);
    return {
      user_id: userId,
      import_id: importId,
      patient_node_id: nodeId,
      manufacturer: e.manufacturer,
      program: e.program,
      brand_product: e.brandProduct,
      product_kind: e.productKind,
      status_raw: e.statusRaw,
      status_norm: e.statusNorm,
      eligible_date: e.eligibleDate,
      expiration_date: e.expirationDate,
      reward_amount_usd: e.rewardAmountUsd,
      contact_name: e.contactName,
      contact_phone: e.contactPhone,
      contact_email: e.contactEmail,
      zip: e.zip,
      last_visit: e.lastVisit,
      member_since: e.memberSince,
      total_checkins: e.totalCheckins,
      match_key,
      row_hash: rowHash([
        e.statusRaw,
        e.eligibleDate,
        e.expirationDate,
        e.rewardAmountUsd,
        e.lastVisit,
        e.contactEmail,
        e.contactPhone,
      ]),
    };
  });

  // 5) Upsert entries (chunked) — unique (user, manufacturer, brand, match_key)
  //    collapses re-uploads onto one row per patient-brand.
  const CHUNK = 1000;
  let entriesUpserted = 0;
  for (let i = 0; i < upsertRows.length; i += CHUNK) {
    const chunk = upsertRows.slice(i, i + CHUNK).map((r) => ({
      ...r,
      updated_at: new Date().toISOString(),
    }));
    const { data: result, error } = await sb
      .from("patient_reward_entries")
      .upsert(chunk, {
        onConflict: "user_id,manufacturer,brand_product,match_key",
      })
      .select("id");
    if (error) {
      throw new Error(`Couldn't save reward entries: ${error.message}`);
    }
    entriesUpserted += result?.length ?? 0;
  }

  // 6) Fill contact gaps on matched patients (additive — blank fields only).
  let contactsFilled = 0;
  const nowIso = new Date().toISOString();
  for (const [nodeId, patch] of fillByNode) {
    const a = attByNode.get(nodeId) ?? {};
    const next: NodeContact = { ...a };
    if (patch.email) next.email = patch.email;
    if (patch.phone) {
      next.phone = patch.phone;
      next.phoneRaw = patch.phone;
    }
    if (!a.contactSource) next.contactSource = "manual";
    next.contactLinkedAt = nowIso;
    const { error } = await sb
      .from("knowledge_nodes")
      .update({ attachments: next as unknown as Database["public"]["Tables"]["knowledge_nodes"]["Update"]["attachments"] })
      .eq("id", nodeId)
      .eq("user_id", userId);
    if (!error) contactsFilled++;
  }

  const unmatchedWithContact = parsed.entries.filter((e) => {
    const res = planByEntry.get(e)!;
    return res.tier === "none" && (normEmail(e.contactEmail) || normPhone(e.contactPhone));
  }).length;

  // 6b) Confidence gate: HELD entries (matched >1 patient) get a review card
  //     instead of a silent guess. The reward already landed orphaned above;
  //     here we record who the candidates are so the owner can latch the right
  //     one. Keyed on the same business tuple the entry is unique on, so a
  //     re-import is idempotent and a resolve updates exactly that orphan row.
  // Dedupe by the business tuple: a duplicate export row for the same
  // patient-brand is ONE hold (so the receipt count == the queue count), and
  // identical rows can't collide in a single ON CONFLICT upsert batch.
  const TUP_SEP = " ";
  const heldByTuple = new Map<string, Record<string, unknown>>();
  for (const e of parsed.entries) {
    const res = planByEntry.get(e)!;
    if (res.tier !== "ambiguous") continue;
    const key = `${e.manufacturer}${TUP_SEP}${e.brandProduct}${TUP_SEP}${rewardMatchKey(e)}`;
    if (heldByTuple.has(key)) continue;
    heldByTuple.set(key, {
      user_id: userId,
      import_id: importId,
      manufacturer: e.manufacturer,
      brand_product: e.brandProduct,
      match_key: rewardMatchKey(e),
      program: e.program,
      reward_amount_usd: e.rewardAmountUsd,
      expiration_date: e.expirationDate,
      contact_name: e.contactName,
      contact_email: e.contactEmail,
      contact_phone: e.contactPhone,
      fingerprint: fingerprintOf(e),
      signals: res.signals,
      candidates: res.candidateIds.map((id) => {
        const a = attByNode.get(id) ?? {};
        return {
          id,
          name: titleByNode.get(id) || null,
          email: (a.email ?? null) as string | null,
          phone: (a.phone ?? a.phoneRaw ?? null) as string | null,
        };
      }),
      status: "pending",
      resolved_node_id: null,
      resolved_at: null,
      updated_at: nowIso,
    });
  }
  const heldRows = [...heldByTuple.values()];
  const held = heldRows.length;
  if (heldRows.length > 0) {
    for (let i = 0; i < heldRows.length; i += CHUNK) {
      const { error } = await looseTbl(sb, "reward_attribution_holds").upsert(
        heldRows.slice(i, i + CHUNK),
        { onConflict: "user_id,manufacturer,brand_product,match_key" },
      );
      if (error) throw new Error(`Couldn't save attribution holds: ${error.message}`);
    }
  }

  // Any tuple that now resolves confidently (e.g. via a learned alias) auto-closes
  // a hold that was pending from a prior import — keep the "needs your eyes" queue
  // honest, never showing an item the owner has effectively already answered.
  // Match on the FULL business tuple (a bare match_key can repeat across brands).
  const SEP = " ";
  const confidentTuples = new Set(
    parsed.entries
      .filter((e) => confidentNode(planByEntry.get(e)!) != null)
      .map((e) => `${e.manufacturer}${SEP}${e.brandProduct}${SEP}${rewardMatchKey(e)}`),
  );
  if (confidentTuples.size > 0) {
    const { data: pendingHolds } = await looseTbl(sb, "reward_attribution_holds")
      .select("id, manufacturer, brand_product, match_key")
      .eq("user_id", userId)
      .eq("status", "pending");
    const toClose = (
      (pendingHolds ?? []) as Array<{
        id: string;
        manufacturer: string;
        brand_product: string;
        match_key: string;
      }>
    )
      .filter((h) =>
        confidentTuples.has(`${h.manufacturer}${SEP}${h.brand_product}${SEP}${h.match_key}`),
      )
      .map((h) => h.id);
    for (let i = 0; i < toClose.length; i += 200) {
      await looseTbl(sb, "reward_attribution_holds")
        .update({ status: "resolved", resolved_at: nowIso, updated_at: nowIso })
        .in("id", toClose.slice(i, i + 200));
    }
  }

  // 7) Stamp the import row with the final counts.
  await sb
    .from("reward_signal_imports")
    .update({
      matched_count: matched,
      new_contacts_count: unmatchedWithContact,
      contacts_filled_count: contactsFilled,
    })
    .eq("id", importId);

  const today = nowIso.slice(0, 10);
  const summary = summarizeRewardEntries(parsed.entries, today, 60);

  return {
    manufacturer,
    program: parsed.program,
    dataRows: parsed.dataRowCount,
    entriesUpserted,
    matched,
    held,
    unmatchedWithContact,
    contactsFilled,
    summary,
    warnings: parsed.warnings.slice(0, 50),
  };
}

// ─── listRewardSignal ──────────────────────────────────────────────────────

const listInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  manufacturer: z.string().optional(),
});

export const listRewardSignal = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<RewardSignalView> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // Page past PostgREST's default 1,000-row cap so the SUMMARY is computed
    // over the full population, not a truncated slice. (v1.91.1 — the capped
    // single read undercounted the headline tiles.)
    const SELECT_COLS =
      "id, manufacturer, program, brand_product, product_kind, status_raw, status_norm, eligible_date, expiration_date, reward_amount_usd, contact_name, contact_phone, contact_email, last_visit, patient_node_id, updated_at";
    type RewardDbRow = {
      id: string;
      manufacturer: string;
      program: string | null;
      brand_product: string;
      product_kind: string | null;
      status_raw: string | null;
      status_norm: string;
      eligible_date: string | null;
      expiration_date: string | null;
      reward_amount_usd: number | null;
      contact_name: string | null;
      contact_phone: string | null;
      contact_email: string | null;
      last_visit: string | null;
      patient_node_id: string | null;
      updated_at: string;
    };
    // Paginate by id (unique → stable offset paging); sort for display after.
    const list = await fetchAllRows<RewardDbRow>((from, to) => {
      let q = sb
        .from("patient_reward_entries")
        .select(SELECT_COLS)
        .eq("user_id", effectiveUserId)
        .order("id", { ascending: true })
        .range(from, to);
      if (data.manufacturer) q = q.eq("manufacturer", data.manufacturer);
      return q;
    });
    // Soonest-expiring first for the table (nulls last).
    list.sort((a, b) => {
      const ax = a.expiration_date ?? "9999-12-31";
      const bx = b.expiration_date ?? "9999-12-31";
      return ax < bx ? -1 : ax > bx ? 1 : 0;
    });

    // Resolve patient display names for matched entries. Chunk the id list:
    // a single `.in()` both caps at 1,000 rows and risks a 414 URI-too-long
    // once matched patients climb past several hundred UUIDs.
    const nodeIds = Array.from(
      new Set(list.map((r) => r.patient_node_id).filter((x): x is string => !!x)),
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

    const entries: RewardEntryRow[] = list.map((r) => ({
      id: r.id,
      manufacturer: r.manufacturer,
      program: r.program,
      brandProduct: r.brand_product,
      productKind: r.product_kind,
      statusRaw: r.status_raw,
      statusNorm: (r.status_norm as RewardStatusNorm) ?? "unknown",
      eligibleDate: r.eligible_date,
      expirationDate: r.expiration_date,
      rewardAmountUsd: r.reward_amount_usd != null ? Number(r.reward_amount_usd) : null,
      contactName: r.contact_name,
      contactPhone: r.contact_phone,
      contactEmail: r.contact_email,
      lastVisit: r.last_visit,
      patientNodeId: r.patient_node_id,
      patientName: r.patient_node_id ? (nameByNode.get(r.patient_node_id) ?? null) : null,
      matched: !!r.patient_node_id,
      updatedAt: r.updated_at,
    }));

    // Summary reuses the pure lib over the persisted rows.
    const today = new Date().toISOString().slice(0, 10);
    const summary = summarizeRewardEntries(
      list.map(
        (r): RewardEntry => ({
          manufacturer: r.manufacturer,
          program: r.program,
          brandProduct: r.brand_product,
          productKind: (r.product_kind as RewardEntry["productKind"]) ?? null,
          statusRaw: r.status_raw,
          statusNorm: (r.status_norm as RewardStatusNorm) ?? "unknown",
          eligibleDate: r.eligible_date,
          expirationDate: r.expiration_date,
          rewardAmountUsd: r.reward_amount_usd != null ? Number(r.reward_amount_usd) : null,
          contactName: r.contact_name,
          contactPhone: r.contact_phone,
          contactEmail: r.contact_email,
          zip: null,
          lastVisit: r.last_visit,
          memberSince: null,
          totalCheckins: null,
          sourceRow: 0,
        }),
      ),
      today,
      60,
    );

    const { data: importRows } = await sb
      .from("reward_signal_imports")
      .select(
        "id, manufacturer, program, source_filename, row_count, entry_count, matched_count, new_contacts_count, contacts_filled_count, imported_at",
      )
      .eq("user_id", effectiveUserId)
      .order("imported_at", { ascending: false })
      .limit(10);

    const imports: RewardImportRow[] = (importRows ?? []).map((r) => ({
      id: r.id,
      manufacturer: r.manufacturer,
      program: r.program,
      sourceFilename: r.source_filename,
      rowCount: r.row_count,
      entryCount: r.entry_count,
      matchedCount: r.matched_count,
      newContactsCount: r.new_contacts_count,
      contactsFilledCount: r.contacts_filled_count,
      importedAt: r.imported_at,
    }));

    return { summary, entries, imports };
  });

// ─── Email-drop auto-ingest: per-tenant token + token→detect→ingest ────────
//
// The spa points a manufacturer report (scheduled export / Gmail auto-forward)
// at <token>@rewards.smartspa.app. The inbound endpoint
// (api.resend.inbound-rewards) resolves the token here, auto-detects the
// mapper from the CSV headers, and runs the SAME doIngestRewards core as the
// manual upload — no dropdown, no manual touch. We trust the token, not the
// From sender.
//
// Hosted on the SmartSpa domain (not the deprecating getrefill.app): the one
// smartspa.app Resend domain now does both send and receive.

export const REWARD_INGEST_DOMAIN = "rewards.smartspa.app";

// reward_ingest_tokens isn't in the generated types yet; use a loose view
// for its queries (mirrors the inbound-lite cast pattern). Localized any.
function tokenTbl(sb: SupabaseAdmin) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sb as unknown as { from(t: string): any }).from("reward_ingest_tokens");
}

function randomToken(): string {
  // 32 hex chars — email-local-part safe, unguessable.
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

/** Resolve an active reward-ingest token → user_id (service role). */
export async function resolveRewardIngestToken(
  sb: SupabaseAdmin,
  token: string,
): Promise<string | null> {
  const { data } = await tokenTbl(sb)
    .select("user_id")
    .eq("token", token)
    .is("revoked_at", null)
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

const tokenInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
});

/** UI: get (or lazily mint) the spa's active reward-ingest address. */
export const getOrCreateRewardIngestToken = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<{ token: string; address: string }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const existing = await tokenTbl(sb)
      .select("token")
      .eq("user_id", effectiveUserId)
      .is("revoked_at", null)
      .maybeSingle();
    let token = existing.data?.token as string | undefined;
    if (!token) {
      token = randomToken();
      const { error } = await tokenTbl(sb).insert({
        user_id: effectiveUserId,
        token,
      });
      if (error) throw new Error("Couldn't create the auto-import address.");
    }
    return { token, address: `${token}@${REWARD_INGEST_DOMAIN}` };
  });

/**
 * UI: rotate the spa's reward-ingest token. Revokes the current active token
 * (so the old email address AND any installed SmartSpa Agent stop working) and
 * mints a fresh one. Self-serve "I think my token leaked / start clean" button.
 * Revoke-then-insert order respects the partial-unique-active-per-user index.
 */
export const rotateRewardIngestToken = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<{ token: string; address: string }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    // 1) Revoke every currently-active token for this spa.
    const { error: revokeErr } = await tokenTbl(sb)
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", effectiveUserId)
      .is("revoked_at", null);
    if (revokeErr) throw new Error("Couldn't rotate your token. Try again.");
    // 2) Mint a fresh one.
    const token = randomToken();
    const { error: insertErr } = await tokenTbl(sb).insert({
      user_id: effectiveUserId,
      token,
    });
    if (insertErr) throw new Error("Couldn't create a new token. Try again.");
    return { token, address: `${token}@${REWARD_INGEST_DOMAIN}` };
  });

export type TokenIngestResult = {
  ok: boolean;
  detected: string | null;
  receipt: RewardImportReceipt | null;
  reason: string | null;
};

/** Core: token + one CSV → auto-detect mapper → doIngestRewards. */
export async function ingestRewardCsvByToken(
  sb: SupabaseAdmin,
  token: string,
  csv: string,
  sourceFilename: string | null,
): Promise<TokenIngestResult> {
  const userId = await resolveRewardIngestToken(sb, token);
  if (!userId) {
    return { ok: false, detected: null, receipt: null, reason: "unknown_token" };
  }
  const key = detectMapperFromCsv(csv);
  if (!key) {
    return { ok: false, detected: null, receipt: null, reason: "unrecognized_csv" };
  }
  const receipt = await doIngestRewards(sb, userId, key, csv, sourceFilename);
  return { ok: true, detected: key, receipt, reason: null };
}
