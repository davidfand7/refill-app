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
import {
  parseRewardCsv,
  summarizeRewardEntries,
  rewardMatchKey,
  normEmail,
  normPhone,
  nameTokenKey,
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
  const { data: nodes, error: nodesErr } = await sb
    .from("knowledge_nodes")
    .select("id, lookup_key, title, attachments")
    .eq("user_id", userId)
    .eq("node_type", "patient")
    .eq("context", "patients");
  if (nodesErr) {
    throw new Error(`Couldn't read your patients: ${nodesErr.message}`);
  }

  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();
  const byName = new Map<string, string>();
  const attByNode = new Map<string, NodeContact>();
  for (const n of nodes ?? []) {
    const a = (n.attachments as NodeContact | null) ?? {};
    attByNode.set(n.id, a);
    const email = normEmail(a.email ?? null);
    if (email && !byEmail.has(email)) byEmail.set(email, n.id);
    const phone = normPhone((a.phone ?? a.phoneRaw ?? null) as string | null);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, n.id);
    const nameKey = nameTokenKey(n.title ?? n.lookup_key ?? null);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, n.id);
  }

  const resolveNode = (e: RewardEntry): string | null => {
    const email = normEmail(e.contactEmail);
    if (email && byEmail.has(email)) return byEmail.get(email)!;
    const phone = normPhone(e.contactPhone);
    if (phone && byPhone.has(phone)) return byPhone.get(phone)!;
    const nameKey = nameTokenKey(e.contactName);
    if (nameKey && byName.has(nameKey)) return byName.get(nameKey)!;
    return null;
  };

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
    const nodeId = resolveNode(e);
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

  const unmatchedWithContact = parsed.entries.filter(
    (e) => !resolveNode(e) && (normEmail(e.contactEmail) || normPhone(e.contactPhone)),
  ).length;

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
    const PAGE = 1000;
    const list: RewardDbRow[] = [];
    for (let from = 0; from <= 50000; from += PAGE) {
      let q = sb
        .from("patient_reward_entries")
        .select(SELECT_COLS)
        .eq("user_id", effectiveUserId)
        .order("expiration_date", { ascending: true, nullsFirst: false })
        .range(from, from + PAGE - 1);
      if (data.manufacturer) q = q.eq("manufacturer", data.manufacturer);
      const { data: page, error } = await q;
      if (error) throw new Error(`Couldn't load reward signals: ${error.message}`);
      const rows = (page ?? []) as RewardDbRow[];
      list.push(...rows);
      if (rows.length < PAGE) break;
    }

    // Resolve patient display names for matched entries in one query.
    const nodeIds = Array.from(
      new Set(list.map((r) => r.patient_node_id).filter((x): x is string => !!x)),
    );
    const nameByNode = new Map<string, string>();
    if (nodeIds.length > 0) {
      const { data: nodes } = await sb
        .from("knowledge_nodes")
        .select("id, title")
        .in("id", nodeIds);
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
