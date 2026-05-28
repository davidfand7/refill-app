/**
 * Patient ingestion server functions — Emma(OS) Patient Architecture P1.
 *
 * Public surface:
 *
 *   ingestPatientCsv     — accept the raw QB CSV body + filename, parse,
 *                          upsert knowledge_nodes patient rows, bulk-insert
 *                          patient_transactions, recompute summaries.
 *                          Returns a one-screen receipt for the spa owner.
 *   listPatients         — for /app/refill/patients list view. Reads the
 *                          summary attachments directly (no joins).
 *   getPatientByKey      — single-patient detail (P2 prep — exported so the
 *                          P2 ship is a UI-only change).
 *
 * Pattern follows reports.functions.ts:
 *   - explicit accessToken in payload, verified via verifyAuth
 *   - service-role client for the actual writes (RLS enforced via user_id)
 *   - typed contracts — return types never expose patient PII to callers
 *     that aren't the owning spa.
 *
 * Established 2026-05-15 (Patient Architecture P1).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";
import {
  parsePatientDetailCsv,
  rollupPatientSummary,
  type ParsedPatient,
  type ParsedTransaction,
  type PatientSummary,
  type PatientContactSummary,
} from "@/lib/patient-csv";
import {
  parseClientListCsv,
  type ParsedClientRow,
} from "@/lib/client-list-csv";
import {
  findFuzzyMatches,
  fuzzyTargetFromName,
  nicknameCanonical,
  type FuzzyTarget,
} from "@/lib/fuzzy-name-match";
import type {
  ProductManufacturer,
  ProductKind,
} from "@/lib/product-manufacturer-map";
import {
  computeOverdue,
  daysSince,
  KIND_CADENCE,
  type OverdueStatus,
} from "@/lib/patient-cadence";

// ─── Public types exported to UI ───────────────────────────────────────────

export type IngestReceipt = {
  businessName: string | null;
  dateRangeLabel: string | null;
  /** Distinct patient rows touched by this upload. */
  patientsTouched: number;
  /** New patient rows that didn't exist before this upload. */
  patientsCreated: number;
  /** New transaction lines inserted. Re-uploads of the same CSV → 0. */
  transactionsInserted: number;
  /** Transaction rows whose dedupe key already existed (no-op). */
  transactionsSkipped: number;
  /** Sum of amount_usd across inserted lines (negative redemptions net out). */
  revenueUsdInserted: number;
  /** Distinct product names that didn't resolve to a manufacturer. */
  unknownProducts: string[];
  /** Parser warnings — surface in a collapsible "details" panel. */
  warnings: Array<{ sourceRow: number; message: string }>;
};

export type PatientListRow = {
  id: string;
  normalizedName: string;
  displayName: string;
  firstVisit: string | null;
  lastVisit: string | null;
  totalVisits: number;
  lifetimeSpendUsd: number;
  netSpendUsd: number;
  primaryManufacturer: ProductManufacturer | null;
  productMix: Partial<Record<ProductManufacturer, number>>;
  loyaltyEngagement: Partial<Record<ProductManufacturer, number>>;
  /** Contact-info fields sourced from the client-list CSV (P1.5). */
  phone: string | null;
  email: string | null;
  daysSinceLastAppointment: number | null;
  banned: boolean;
  /**
   * v385.2: A-list / VIP flag, persisted on
   * `knowledge_nodes.attachments.vip`. Drives the patient-list star
   * toggle today; future rescue-dispatcher logic ([target VIPs first])
   * reads the same flag. When the targeting logic ships, promote this
   * to a proper column for indexed lookups (v386 candidate).
   */
  vip: boolean;
  contactSource: "client-csv" | "manual" | "fuzzy-confirmed" | null;
};

export type PatientTransactionRow = {
  id: string;
  transactionDate: string;
  invoiceNum: string | null;
  productName: string;
  productManufacturer: ProductManufacturer | null;
  productKind: ProductKind | null;
  description: string | null;
  quantity: number | null;
  unitPriceUsd: number | null;
  amountUsd: number;
};

export type PatientDetail = {
  patient: PatientListRow;
  transactions: PatientTransactionRow[];
};

/** A patient flagged as overdue for a touchup by the cadence rules. */
export type OverduePatient = {
  patientId: string;
  displayName: string;
  /** Manufacturer to feature on the card chip — defaults to primary. */
  manufacturer: ProductManufacturer | null;
  /** Most-recent visit of the overdue KIND (toxin/filler/biostim). */
  lastVisitOfKind: string;
  /** Days past the soft-overdue window. Always > 0. */
  daysOverdue: number;
  /** The kind whose cadence triggered the overdue. */
  kind: ProductKind;
  /** True when the lapsed-window threshold is also crossed. */
  isLapsed: boolean;
  lifetimeSpendUsd: number;
  totalVisits: number;
  /** Contact-info passthrough for the Today card's per-row chips. */
  phone: string | null;
  email: string | null;
};

export type OverdueCohortSummary = {
  totalOverdue: number;
  totalLapsed: number;
  byKind: Partial<Record<ProductKind, number>>;
  byManufacturer: Partial<Record<ProductManufacturer, number>>;
};

// ─── Admin client ──────────────────────────────────────────────────────────

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

// ─── Zod ───────────────────────────────────────────────────────────────────

const ingestInput = z.object({
  accessToken: z.string().min(1),
  csv: z.string().min(1).max(20 * 1024 * 1024), // 20MB headroom; Rejuv is ~1.4MB
  sourceFilename: z.string().max(500).optional(),
  /** v1.20.5: admin-only write-path opt-in. When set + caller is admin,
   *  the ingest writes under this user_id (typically the impersonated
   *  tenant owner) instead of the caller's. Same gate as read-path
   *  viewAsUserId — see [[resolveEffectiveUserId]]. Closes the
   *  admin-uploads-land-in-wrong-bucket footgun that bit us 2026-05-27. */
  viewAsUserId: z.string().uuid().optional(),
});

const listInput = z.object({
  accessToken: z.string().min(1),
  // v1.25.2: raised from 2000 → 5000 so the A-list rules dashboard can
  // count across multi-location tenant books without truncating. Rejuv
  // at 1,140 was well under the old cap; the new ceiling is headroom
  // for spas with 3+ locations under one tenant.
  limit: z.number().int().min(1).max(5000).optional(),
  /** v1.20 admin viewing-as: when set + caller is admin, fetch this
   *  user's patients instead of the caller's. See resolveEffectiveUserId. */
  viewAsUserId: z.string().uuid().optional(),
});

const getInput = z.object({
  accessToken: z.string().min(1),
  normalizedName: z.string().min(1).max(240),
  viewAsUserId: z.string().uuid().optional(),
});

const getByIdInput = z.object({
  accessToken: z.string().min(1),
  patientId: z.string().uuid(),
  viewAsUserId: z.string().uuid().optional(),
});

const overdueInput = z.object({
  accessToken: z.string().min(1),
  /** Max rows in the list result. Defaults small for the Today card;
   *  /app/refill/patients passes 5000 to show the full roster. v366.1
   *  raised cap from 500 to 10000 — Rejuv has 1,126 patients, multi-
   *  location chains may have more; page if a single tenant ever
   *  exceeds 10k. */
  limit: z.number().int().min(1).max(10000).optional(),
  /** Filter by kind — null/undefined returns all kinds. */
  kind: z.enum(["toxin", "filler", "biostimulator"]).optional(),
  viewAsUserId: z.string().uuid().optional(),
});

// ─── Hydration helpers ─────────────────────────────────────────────────────

type KnowledgeNodeRow = Database["public"]["Tables"]["knowledge_nodes"]["Row"];
type PatientTransactionDbRow =
  Database["public"]["Tables"]["patient_transactions"]["Row"];

function hydratePatientListRow(node: KnowledgeNodeRow): PatientListRow {
  const a = (node.attachments as unknown as PatientSummary | null) ?? null;
  return {
    id: node.id,
    normalizedName: node.lookup_key ?? a?.normalizedName ?? "",
    displayName: node.title,
    firstVisit: a?.firstVisit ?? null,
    lastVisit: a?.lastVisit ?? null,
    totalVisits: a?.totalVisits ?? 0,
    lifetimeSpendUsd: a?.lifetimeSpendUsd ?? 0,
    netSpendUsd: a?.netSpendUsd ?? 0,
    primaryManufacturer: a?.primaryManufacturer ?? null,
    productMix: a?.productMix ?? {},
    loyaltyEngagement: a?.loyaltyEngagement ?? {},
    phone: a?.phone ?? null,
    email: a?.email ?? null,
    daysSinceLastAppointment: a?.daysSinceLastAppointment ?? null,
    banned: a?.banned ?? false,
    vip: a?.vip ?? false,
    contactSource: a?.contactSource ?? null,
  };
}

/**
 * Pull the contact-info fields out of an existing PatientSummary so the
 * sales-CSV re-roll can preserve them (the rollup recomputes everything
 * else from transactions). Returns null/empty for never-linked patients.
 */
function extractContactSummary(
  summary: PatientSummary,
): Partial<PatientContactSummary> {
  return {
    phone: summary.phone ?? null,
    phoneRaw: summary.phoneRaw ?? null,
    email: summary.email ?? null,
    daysSinceLastAppointment: summary.daysSinceLastAppointment ?? null,
    banned: summary.banned ?? false,
    contactSource: summary.contactSource ?? null,
    contactLinkedAt: summary.contactLinkedAt ?? null,
  };
}

function hydrateTransactionRow(t: PatientTransactionDbRow): PatientTransactionRow {
  return {
    id: t.id,
    transactionDate: t.transaction_date,
    invoiceNum: t.invoice_num,
    productName: t.product_name,
    productManufacturer: (t.product_manufacturer as ProductManufacturer | null) ?? null,
    productKind: (t.product_kind as ProductKind | null) ?? null,
    description: t.description,
    quantity: t.quantity !== null ? Number(t.quantity) : null,
    unitPriceUsd: t.unit_price_usd !== null ? Number(t.unit_price_usd) : null,
    amountUsd: Number(t.amount_usd),
  };
}

// ─── Core: ingestPatientCsv ────────────────────────────────────────────────

export const ingestPatientCsv = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ingestInput.parse(input))
  .handler(async ({ data }): Promise<IngestReceipt> => {
    // v1.20.5: opted into the admin viewing-as write path. When admin is
    // observing tenant X via useTenantMembership.viewAsUserId, an /import
    // upload now writes patient_nodes + patient_transactions under tenant
    // X's owner user_id instead of the admin's own bucket.
    //
    // Background: pre-v1.20.5 this called verifyAuth(accessToken) directly,
    // so admin uploads landed under the admin's user_id — invisible to the
    // target spa, requiring a manual SQL re-assignment (the 2026-05-27
    // Patient-Data-Move-To-Karen.sql detour for the Rejuv pilot CSV). The
    // v1.20 docblock had explicitly excluded write paths from viewAs for
    // safety; v1.20.5 narrows that policy: ingest IS safe to viewAs because
    // (a) the use case is explicit (admin pasting CSV on behalf of a
    // tenant during pilot setup), (b) resolveEffectiveUserId re-verifies
    // admin role server-side, (c) bad ingests are reversible via the same
    // CSV-upload UI. Stripe-mutating writes and plan changes are still
    // intentionally NOT viewAs-aware.
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    return doIngest(sb, effectiveUserId, data.csv, data.sourceFilename ?? null);
  });

export async function doIngest(
  sb: SupabaseAdmin,
  userId: string,
  csv: string,
  sourceFilename: string | null,
): Promise<IngestReceipt> {
  // 1) Parse the CSV — pure, no I/O.
  const parsed = parsePatientDetailCsv(csv, {
    sourceFilename: sourceFilename ?? undefined,
  });

  if (parsed.patients.length === 0) {
    throw new Error(
      "Couldn't find any patient sections in that CSV. Is this a QuickBooks 'Sales by Patient Detail' export?",
    );
  }

  // 2) Pre-fetch existing patient nodes for this user so we know which are
  //    creates vs touches. lookup_key is the normalized name. Also grab
  //    attachments so the re-roll can preserve client-list contact fields
  //    written by ingestClientListCsv (P1.5) — losing those on a sales
  //    re-upload would silently wipe out the spa owner's contact work.
  const normalizedNames = parsed.patients.map((p) => p.normalizedName);
  const { data: existingNodes, error: existingErr } = await sb
    .from("knowledge_nodes")
    .select("id, lookup_key, attachments")
    .eq("user_id", userId)
    .eq("node_type", "patient")
    .eq("context", "patients")
    .in("lookup_key", normalizedNames);
  if (existingErr) {
    throw new Error(`Couldn't read existing patients: ${existingErr.message}`);
  }

  const existingByKey = new Map<string, string>();
  const priorContactByKey = new Map<string, Partial<PatientContactSummary>>();
  for (const n of existingNodes ?? []) {
    if (!n.lookup_key) continue;
    existingByKey.set(n.lookup_key, n.id);
    const a = n.attachments as unknown as PatientSummary | null;
    if (a) priorContactByKey.set(n.lookup_key, extractContactSummary(a));
  }

  // 3) Upsert patient rows. We do this in a single upsert call per chunk
  //    to keep round-trips bounded — even at Rejuv's 1.1k patients it fits
  //    in one call comfortably.
  const linesByPatient = new Map<string, ParsedTransaction[]>();
  for (const t of parsed.transactions) {
    let bucket = linesByPatient.get(t.patientKey);
    if (!bucket) {
      bucket = [];
      linesByPatient.set(t.patientKey, bucket);
    }
    bucket.push(t);
  }

  // Build a placeholder summary per patient even before transactions land —
  // it's overwritten after the insert pass below.
  const patientsForUpsert = parsed.patients.map((p) =>
    buildPatientNodeForUpsert(
      p,
      linesByPatient.get(p.normalizedName) ?? [],
      userId,
      existingByKey.get(p.normalizedName) ?? null,
      priorContactByKey.get(p.normalizedName) ?? null,
    ),
  );

  const { data: upserted, error: upsertErr } = await sb
    .from("knowledge_nodes")
    .upsert(patientsForUpsert, { onConflict: "id" })
    .select("id, lookup_key");
  if (upsertErr) {
    throw new Error(`Couldn't upsert patients: ${upsertErr.message}`);
  }

  const nodeIdByKey = new Map<string, string>();
  for (const row of upserted ?? []) {
    if (row.lookup_key) nodeIdByKey.set(row.lookup_key, row.id);
  }
  // Belt-and-suspenders: also seed from the pre-fetch in case of any
  // race / no-op rows. Existing IDs already point at the right node.
  for (const [k, id] of existingByKey) {
    if (!nodeIdByKey.has(k)) nodeIdByKey.set(k, id);
  }

  // 4) Bulk-insert transactions. Use the dedupe constraint to make re-uploads
  //    no-ops. Supabase's onConflict='ignore' is the right shape here.
  const txnRows = parsed.transactions
    .map((t) => {
      const patientNodeId = nodeIdByKey.get(t.patientKey);
      if (!patientNodeId) return null;
      return {
        user_id: userId,
        patient_node_id: patientNodeId,
        transaction_date: t.transactionDate,
        invoice_num: t.invoiceNum,
        line_index: t.lineIndex,
        product_name: t.productName,
        product_manufacturer: t.productManufacturer,
        product_kind: t.productKind,
        description: t.description,
        quantity: t.quantity,
        unit_price_usd: t.unitPriceUsd,
        amount_usd: t.amountUsd,
        balance_usd: t.balanceUsd,
        source: "quickbooks-csv",
        source_ref: sourceFilename ? `${sourceFilename}:${t.sourceRow}` : `:${t.sourceRow}`,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Chunked insert — Postgres prefers a few thousand rows per statement.
  const CHUNK = 1000;
  let inserted = 0;
  let revenueInserted = 0;
  for (let i = 0; i < txnRows.length; i += CHUNK) {
    const chunk = txnRows.slice(i, i + CHUNK);
    const { data: result, error } = await sb
      .from("patient_transactions")
      .upsert(chunk, {
        onConflict:
          "user_id,patient_node_id,transaction_date,invoice_num,product_name,line_index",
        ignoreDuplicates: true,
      })
      .select("id, amount_usd");
    if (error) {
      throw new Error(`Couldn't insert transactions: ${error.message}`);
    }
    if (result) {
      inserted += result.length;
      for (const r of result) revenueInserted += Number(r.amount_usd ?? 0);
    }
  }

  // 5) Re-materialize each touched patient's summary from authoritative DB
  //    state — handles both the "first upload" and "delta upload" cases
  //    correctly. We use the parsed transactions for fresh-uploaded patients
  //    but for any patient with prior data, we re-roll from the DB.
  for (const patient of parsed.patients) {
    const nodeId = nodeIdByKey.get(patient.normalizedName);
    if (!nodeId) continue;
    await refreshPatientSummary(sb, userId, nodeId, patient);
  }

  return {
    businessName: parsed.businessName,
    dateRangeLabel: parsed.dateRangeLabel,
    patientsTouched: parsed.patients.length,
    patientsCreated: parsed.patients.filter(
      (p) => !existingByKey.has(p.normalizedName),
    ).length,
    transactionsInserted: inserted,
    transactionsSkipped: txnRows.length - inserted,
    revenueUsdInserted: Math.round(revenueInserted * 100) / 100,
    unknownProducts: parsed.unknownProductNames,
    warnings: parsed.warnings.slice(0, 50), // cap for the receipt UI
  };
}

function buildPatientNodeForUpsert(
  patient: ParsedPatient,
  lines: ParsedTransaction[],
  userId: string,
  existingId: string | null,
  priorContact: Partial<PatientContactSummary> | null,
): Database["public"]["Tables"]["knowledge_nodes"]["Insert"] {
  const summary = rollupPatientSummary(patient, lines, priorContact);
  const content = patientSummaryToContent(summary);
  const row: Database["public"]["Tables"]["knowledge_nodes"]["Insert"] = {
    user_id: userId,
    node_type: "patient",
    context: "patients",
    lookup_key: patient.normalizedName,
    lookup_type: "patient",
    title: patient.displayName,
    content,
    attachments: summary as unknown as Json,
    source: "quickbooks-csv",
  };
  if (existingId) row.id = existingId;
  return row;
}

/**
 * Liz-readable patient summary string — written to knowledge_nodes.content.
 * Kept short and verifiable; the rich shape lives in attachments.
 */
function patientSummaryToContent(s: PatientSummary): string {
  const parts: string[] = [];
  parts.push(s.displayName);
  if (s.firstVisit && s.lastVisit) {
    parts.push(
      `${s.totalVisits} visit${s.totalVisits === 1 ? "" : "s"} between ${s.firstVisit} and ${s.lastVisit}`,
    );
  }
  if (s.lifetimeSpendUsd) {
    parts.push(`lifetime spend $${s.lifetimeSpendUsd.toFixed(2)}`);
  }
  if (s.primaryManufacturer) {
    parts.push(`primary ${s.primaryManufacturer}`);
  }
  return parts.join(" · ");
}

/**
 * Re-roll a patient's summary from the authoritative patient_transactions
 * rows after a delta upload. Conservative — runs one round-trip per touched
 * patient, which at Rejuv's scale is fine. If we ever hit a spa with 10k
 * patients we'll switch to a single CTE that updates summaries in-DB.
 */
async function refreshPatientSummary(
  sb: SupabaseAdmin,
  userId: string,
  nodeId: string,
  patient: ParsedPatient,
): Promise<void> {
  // Preserve client-list contact fields (P1.5) — re-roll uses transactions
  // but contact info is sourced from the second CSV, so we read the prior
  // attachments before computing the new summary.
  const { data: priorNode, error: priorErr } = await sb
    .from("knowledge_nodes")
    .select("attachments")
    .eq("id", nodeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (priorErr) {
    throw new Error(`Couldn't read prior patient summary: ${priorErr.message}`);
  }
  const priorContact = priorNode?.attachments
    ? extractContactSummary(priorNode.attachments as unknown as PatientSummary)
    : null;
  const { data: rows, error } = await sb
    .from("patient_transactions")
    .select(
      "transaction_date, invoice_num, product_name, product_manufacturer, product_kind, description, quantity, unit_price_usd, amount_usd, balance_usd",
    )
    .eq("user_id", userId)
    .eq("patient_node_id", nodeId);
  if (error) {
    throw new Error(`Couldn't reload patient transactions: ${error.message}`);
  }
  const lines: ParsedTransaction[] = (rows ?? []).map((r, idx) => ({
    sourceRow: idx + 1,
    patientKey: patient.normalizedName,
    transactionDate: r.transaction_date,
    invoiceNum: r.invoice_num,
    lineIndex: 0, // not used by rollup
    productName: r.product_name,
    productManufacturer: r.product_manufacturer as ProductManufacturer | null,
    productKind: r.product_kind as ProductKind | null,
    description: r.description,
    quantity: r.quantity !== null ? Number(r.quantity) : null,
    unitPriceUsd: r.unit_price_usd !== null ? Number(r.unit_price_usd) : null,
    amountUsd: Number(r.amount_usd),
    balanceUsd: r.balance_usd !== null ? Number(r.balance_usd) : null,
  }));
  const summary = rollupPatientSummary(patient, lines, priorContact);
  const content = patientSummaryToContent(summary);
  const { error: updErr } = await sb
    .from("knowledge_nodes")
    .update({
      title: patient.displayName,
      content,
      attachments: summary as unknown as Json,
      updated_at: new Date().toISOString(),
    })
    .eq("id", nodeId)
    .eq("user_id", userId);
  if (updErr) {
    throw new Error(`Couldn't refresh patient summary: ${updErr.message}`);
  }
}

// ─── setPatientVip (v385.2) ───────────────────────────────────────────────

const setVipInput = z.object({
  accessToken: z.string().min(1),
  patientNodeId: z.string().uuid(),
  vip: z.boolean(),
});

// v1.25.1: bulk variant for the A-list automation dashboard. Apply passes
// addIds; Clear passes removeIds. Backed by the refill_bulk_set_vip Postgres
// RPC (migration 20260528000000) which does both updates in a single round
// trip via jsonb_set, preserving all other PatientSummary fields. Unlike
// the per-row setPatientVip above, this fn DOES go through
// resolveEffectiveUserId so admin viewing-as Karen writes to Karen's rows.
const setVipBulkInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  addIds: z.array(z.string().uuid()).default([]),
  removeIds: z.array(z.string().uuid()).default([]),
});

/**
 * v385.2: toggle the A-list / VIP flag on a patient row.
 *
 * Stored on `knowledge_nodes.attachments.vip` (a field on the
 * PatientSummary blob, not a column). Reads the current attachments,
 * merges `vip`, writes back. This keeps Phase 0 migration-free while
 * still surviving sales-CSV re-rolls (the rollup preserves the flag
 * via PatientContactSummary).
 *
 * Promote to a real column when the rescue-dispatcher VIP-targeting
 * logic actually ships — JSON predicates work but a proper column
 * indexes cleanly for `ORDER BY vip DESC` priority ordering.
 */
export const setPatientVip = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => setVipInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const { data: existing, error: readErr } = await sb
      .from("knowledge_nodes")
      .select("attachments")
      .eq("id", data.patientNodeId)
      .eq("user_id", userId)
      .eq("node_type", "patient")
      .maybeSingle();
    if (readErr) throw new Error(`Couldn't read patient: ${readErr.message}`);
    if (!existing) throw new Error("Patient not found.");
    const summary =
      (existing.attachments as unknown as PatientSummary | null) ?? null;
    const next: PatientSummary = {
      ...(summary ?? ({
        normalizedName: "",
        displayName: "",
        firstVisit: null,
        lastVisit: null,
        totalVisits: 0,
        lifetimeUnits: 0,
        lifetimeSpendUsd: 0,
        netSpendUsd: 0,
        primaryManufacturer: null,
        productMix: {},
        loyaltyEngagement: {},
      } as PatientSummary)),
      vip: data.vip,
    };
    const { error: updErr } = await sb
      .from("knowledge_nodes")
      .update({
        attachments: next as unknown as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.patientNodeId)
      .eq("user_id", userId);
    if (updErr) throw new Error(`Couldn't update VIP: ${updErr.message}`);
    return { ok: true };
  });

export const setPatientVipBulk = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => setVipBulkInput.parse(raw))
  .handler(async ({ data }): Promise<{ touched: number }> => {
    if (data.addIds.length === 0 && data.removeIds.length === 0) {
      return { touched: 0 };
    }
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: touched, error } = await sb.rpc("refill_bulk_set_vip", {
      p_user_id: effectiveUserId,
      p_add_ids: data.addIds,
      p_remove_ids: data.removeIds,
    });
    if (error) throw new Error(`Bulk VIP write failed: ${error.message}`);
    return { touched: typeof touched === "number" ? touched : 0 };
  });

// ─── listPatients ──────────────────────────────────────────────────────────

export const listPatients = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<PatientListRow[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const limit = data.limit ?? 2000;
    const { data: rows, error } = await sb
      .from("knowledge_nodes")
      .select("*")
      .eq("user_id", effectiveUserId)
      .eq("node_type", "patient")
      .eq("context", "patients")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Couldn't list patients: ${error.message}`);
    return (rows ?? []).map(hydratePatientListRow);
  });

// ─── getPatientByKey (P2 prep) ────────────────────────────────────────────

export const getPatientByKey = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => getInput.parse(input))
  .handler(async ({ data }): Promise<PatientDetail | null> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: node, error: nodeErr } = await sb
      .from("knowledge_nodes")
      .select("*")
      .eq("user_id", effectiveUserId)
      .eq("node_type", "patient")
      .eq("context", "patients")
      .eq("lookup_key", data.normalizedName)
      .maybeSingle();
    if (nodeErr) throw new Error(`Couldn't load patient: ${nodeErr.message}`);
    if (!node) return null;

    const { data: txns, error: txnErr } = await sb
      .from("patient_transactions")
      .select("*")
      .eq("user_id", effectiveUserId)
      .eq("patient_node_id", node.id)
      .order("transaction_date", { ascending: false })
      .order("line_index", { ascending: true });
    if (txnErr) throw new Error(`Couldn't load transactions: ${txnErr.message}`);

    return {
      patient: hydratePatientListRow(node),
      transactions: (txns ?? []).map(hydrateTransactionRow),
    };
  });

// ─── getPatientById (UUID-keyed, P2 detail page) ──────────────────────────

export const getPatientById = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => getByIdInput.parse(input))
  .handler(async ({ data }): Promise<PatientDetail | null> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: node, error: nodeErr } = await sb
      .from("knowledge_nodes")
      .select("*")
      .eq("user_id", effectiveUserId)
      .eq("id", data.patientId)
      .eq("node_type", "patient")
      .eq("context", "patients")
      .maybeSingle();
    if (nodeErr) throw new Error(`Couldn't load patient: ${nodeErr.message}`);
    if (!node) return null;

    // Paginated through transactions — a long-tenure top-spender patient at
    // Rejuv has ~200 lines, well under the 1000-row cap, but we paginate
    // anyway for future-proofing. Capped at 5000 to keep payload sane.
    const lines: PatientTransactionRow[] = [];
    const PAGE = 1000;
    let from = 0;
    while (from < 5000) {
      const { data: chunk, error: txnErr } = await sb
        .from("patient_transactions")
        .select("*")
        .eq("user_id", effectiveUserId)
        .eq("patient_node_id", node.id)
        .order("transaction_date", { ascending: false })
        .order("line_index", { ascending: true })
        .range(from, from + PAGE - 1);
      if (txnErr) throw new Error(`Couldn't load transactions: ${txnErr.message}`);
      if (!chunk || chunk.length === 0) break;
      for (const t of chunk) lines.push(hydrateTransactionRow(t));
      if (chunk.length < PAGE) break;
      from += PAGE;
    }

    return {
      patient: hydratePatientListRow(node),
      transactions: lines,
    };
  });

// ════════════════════════════════════════════════════════════════════════════
//  P3 — Overdue / cohort signals
// ════════════════════════════════════════════════════════════════════════════

/**
 * Find every patient whose most-recent visit of an injectable kind is past
 * the cadence window for that kind. Excludes banned. Ordered most-overdue
 * first.
 *
 * Implementation: pull patient_transactions filtered to kinds we care
 * about, group by (patient_node_id, product_kind) keeping the max date,
 * then join against the patient summary in JS. Two queries (transactions
 * + patient nodes) — much cheaper than one row per visit query.
 */
export const listOverduePatients = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => overdueInput.parse(input))
  .handler(async ({ data }): Promise<OverduePatient[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    return doListOverdue(sb, effectiveUserId, data.limit ?? 100, data.kind ?? null);
  });

export const summarizeOverdueCohort = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        viewAsUserId: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<OverdueCohortSummary> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    // Pull every kind so the summary is comprehensive; limit big enough
    // to never truncate at a real-spa scale.
    const all = await doListOverdue(sb, effectiveUserId, 5000, null);
    let totalLapsed = 0;
    const byKind: Partial<Record<ProductKind, number>> = {};
    const byManufacturer: Partial<Record<ProductManufacturer, number>> = {};
    for (const p of all) {
      if (p.isLapsed) totalLapsed++;
      byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
      if (p.manufacturer) {
        byManufacturer[p.manufacturer] = (byManufacturer[p.manufacturer] ?? 0) + 1;
      }
    }
    return {
      totalOverdue: all.length,
      totalLapsed,
      byKind,
      byManufacturer,
    };
  });

async function doListOverdue(
  sb: SupabaseAdmin,
  userId: string,
  limit: number,
  kindFilter: ProductKind | null,
): Promise<OverduePatient[]> {
  // 1) Pull the most-recent transaction-date per (patient, kind) for kinds
  //    that have a cadence policy. PostgREST doesn't support GROUP BY
  //    directly, so we paginate the raw rows and reduce in JS. This is
  //    bounded by the spa's transaction count (~15k for Rejuv) which is
  //    well inside the working-set budget.
  const targetKinds: ProductKind[] = kindFilter
    ? [kindFilter]
    : (Object.keys(KIND_CADENCE) as ProductKind[]);
  type Recent = {
    patientId: string;
    kind: ProductKind;
    manufacturer: ProductManufacturer | null;
    lastDate: string;
  };
  const recentByPatientKind = new Map<string, Recent>();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data: chunk, error } = await sb
      .from("patient_transactions")
      .select("patient_node_id, product_kind, product_manufacturer, transaction_date")
      .eq("user_id", userId)
      .in("product_kind", targetKinds)
      .gt("amount_usd", 0) // only count real purchases, not redemption / refund / discount lines
      .order("transaction_date", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Couldn't load transactions: ${error.message}`);
    if (!chunk || chunk.length === 0) break;
    for (const t of chunk) {
      if (!t.product_kind) continue;
      const key = `${t.patient_node_id}::${t.product_kind}`;
      if (recentByPatientKind.has(key)) continue; // we sorted desc — first seen is max
      recentByPatientKind.set(key, {
        patientId: t.patient_node_id,
        kind: t.product_kind as ProductKind,
        manufacturer: (t.product_manufacturer as ProductManufacturer | null) ?? null,
        lastDate: t.transaction_date,
      });
    }
    if (chunk.length < PAGE) break;
    from += PAGE;
  }

  // 2) Filter to those past the cadence window AND join the patient
  //    summary for the display fields.
  const overdueRecents: Array<Recent & { status: OverdueStatus }> = [];
  for (const r of recentByPatientKind.values()) {
    const d = daysSince(r.lastDate);
    const status = computeOverdue(r.kind, d);
    if (!status) continue;
    overdueRecents.push({ ...r, status });
  }
  if (overdueRecents.length === 0) return [];

  // 3) Hydrate patient summary attachments — paginated for the same reason
  //    forEachPatient was added in P1.5.
  const patientById = new Map<
    string,
    {
      title: string;
      attachments: PatientSummary | null;
    }
  >();
  await forEachPatient(sb, userId, ({ id, title, attachments }) => {
    patientById.set(id, { title, attachments });
  });

  // 4) Build the OverduePatient rows, excluding banned, sorted by most
  //    overdue first.
  const out: OverduePatient[] = [];
  for (const r of overdueRecents) {
    const p = patientById.get(r.patientId);
    if (!p) continue;
    if (p.attachments?.banned) continue;
    out.push({
      patientId: r.patientId,
      displayName: p.title,
      manufacturer: r.manufacturer ?? p.attachments?.primaryManufacturer ?? null,
      lastVisitOfKind: r.lastDate,
      daysOverdue: r.status.daysOverdue,
      kind: r.kind,
      isLapsed: r.status.isLapsed,
      lifetimeSpendUsd: p.attachments?.lifetimeSpendUsd ?? 0,
      totalVisits: p.attachments?.totalVisits ?? 0,
      phone: p.attachments?.phone ?? null,
      email: p.attachments?.email ?? null,
    });
  }
  out.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return out.slice(0, limit);
}

// ════════════════════════════════════════════════════════════════════════════
//  P1.5 — Client-list ingestion + fuzzy-match cross-reference
// ════════════════════════════════════════════════════════════════════════════

export type ClientListReceipt = {
  candidatesTouched: number;
  candidatesCreated: number;
  exactMatches: number;
  /** Patients we exact-matched to a candidate whose attachments we updated. */
  patientsEnriched: number;
  /** Unmatched candidates with no purchase history — the 661-bucket. */
  clientsNoSales: number;
  bannedCount: number;
  withPhone: number;
  withEmail: number;
  /** Distinct sales patients still missing contact info after this upload. */
  salesNoClient: number;
  warnings: Array<{ sourceRow: number; message: string }>;
};

export type ContactSuggestion = {
  patient: {
    id: string;
    displayName: string;
    normalizedName: string;
    lifetimeSpendUsd: number;
    totalVisits: number;
    primaryManufacturer: ProductManufacturer | null;
  };
  candidate: {
    id: string;
    displayName: string;
    phone: string | null;
    email: string | null;
    banned: boolean;
  };
  distance: number;
  confidence: number;
};

export type ContactGap = {
  id: string;
  displayName: string;
  normalizedName: string;
  lifetimeSpendUsd: number;
  totalVisits: number;
  lastVisit: string | null;
  primaryManufacturer: ProductManufacturer | null;
  /** Up to 3 fuzzy-match suggestions, sorted by confidence. Empty when none. */
  suggestions: ContactSuggestion[];
};

export type ContactsOverview = {
  totalPatients: number;
  patientsWithContact: number;
  patientsWithPhone: number;
  patientsWithEmail: number;
  bannedPatientCount: number;
  contactGapCount: number;
  unmatchedCandidateCount: number;
  /** True once at least one client-list CSV has landed for this user. */
  hasClientList: boolean;
};

// ─── Zod: client-list inputs ──────────────────────────────────────────────

const ingestClientInput = z.object({
  accessToken: z.string().min(1),
  csv: z.string().min(1).max(20 * 1024 * 1024),
  sourceFilename: z.string().max(500).optional(),
  /** v1.23.0 P3 sweep — admin viewing-as for client-list ingest. Same
   *  rationale as v1.20.5's opt-in for ingestPatientCsv: explicit admin-
   *  on-behalf-of-tenant uploads during pilot setup, re-verified server-
   *  side via resolveEffectiveUserId. */
  viewAsUserId: z.string().uuid().optional(),
});

const confirmSuggestionInput = z.object({
  accessToken: z.string().min(1),
  patientNodeId: z.string().uuid(),
  candidateId: z.string().uuid(),
});

const dismissSuggestionInput = z.object({
  accessToken: z.string().min(1),
  candidateId: z.string().uuid(),
  patientNodeId: z.string().uuid().optional(),
});

const overviewInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const gapsInput = z.object({
  accessToken: z.string().min(1),
  /** Max gap rows to return. The UI paginates with offset/limit later. */
  limit: z.number().int().min(1).max(500).optional(),
  viewAsUserId: z.string().uuid().optional(),
});

// ─── ingestClientListCsv ───────────────────────────────────────────────────

export const ingestClientListCsv = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ingestClientInput.parse(input))
  .handler(async ({ data }): Promise<ClientListReceipt> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    return doIngestClientList(sb, effectiveUserId, data.csv, data.sourceFilename ?? null);
  });

export async function doIngestClientList(
  sb: SupabaseAdmin,
  userId: string,
  csv: string,
  sourceFilename: string | null,
): Promise<ClientListReceipt> {
  const parsed = parseClientListCsv(csv);
  if (parsed.rows.length === 0) {
    throw new Error(
      "Couldn't find any client rows. Does the CSV have a First Name / Last Name header?",
    );
  }

  // Pre-fetch ALL existing candidate rows for this user — at 1.5k client-list
  // size, the URL-length cost of `.in(normalized_name, [...])` exceeds
  // PostgREST's request limit. Paginated because PostgREST also caps single
  // requests at 1000 rows (without pagination this miscounted re-runs as
  // "501 new" when they should have been 0).
  const priorByKey = new Map<
    string,
    { id: string; status: string; linkedPatientNodeId: string | null }
  >();
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data: chunk, error: priorErr } = await sb
        .from("patient_contact_candidates")
        .select("id, normalized_name, status, linked_patient_node_id")
        .eq("user_id", userId)
        .range(from, from + PAGE - 1);
      if (priorErr) {
        throw new Error(`Couldn't read prior candidates: ${priorErr.message}`);
      }
      if (!chunk || chunk.length === 0) break;
      for (const c of chunk) {
        priorByKey.set(c.normalized_name, {
          id: c.id,
          status: c.status,
          linkedPatientNodeId: c.linked_patient_node_id,
        });
      }
      if (chunk.length < PAGE) break;
      from += PAGE;
    }
  }

  // Look up existing patient nodes by normalized name — only the matched
  // ones get enriched. The salesNoClient gap = patients NOT in this set.
  // Paginated because Supabase's PostgREST caps at 1000 rows per request;
  // Rejuv's 1.1k book hit this limit on the first cut.
  const patientByKey = new Map<string, { id: string; attachments: PatientSummary | null }>();
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data: chunk, error: patErr } = await sb
        .from("knowledge_nodes")
        .select("id, lookup_key, attachments")
        .eq("user_id", userId)
        .eq("node_type", "patient")
        .eq("context", "patients")
        .range(from, from + PAGE - 1);
      if (patErr) {
        throw new Error(`Couldn't read patients: ${patErr.message}`);
      }
      if (!chunk || chunk.length === 0) break;
      for (const p of chunk) {
        if (!p.lookup_key) continue;
        patientByKey.set(p.lookup_key, {
          id: p.id,
          attachments: (p.attachments as unknown as PatientSummary | null) ?? null,
        });
      }
      if (chunk.length < PAGE) break;
      from += PAGE;
    }
  }

  const now = new Date().toISOString();

  // Build candidate upsert rows. For each parsed client:
  //   - If the normalized name matches a patient, mark candidate status as
  //     'matched' and link both directions.
  //   - Otherwise mark 'unmatched' (or preserve prior 'dismissed' so we
  //     don't resurrect rejected suggestions on re-upload).
  const candidateRows: Database["public"]["Tables"]["patient_contact_candidates"]["Insert"][] = [];
  const enrichmentJobs: Array<{
    patientId: string;
    patient: PatientSummary | null;
    fromCandidate: ParsedClientRow;
  }> = [];

  for (const r of parsed.rows) {
    const prior = priorByKey.get(r.normalizedName);
    const patient = patientByKey.get(r.normalizedName) ?? null;
    let status: string;
    let linkedPatientNodeId: string | null = null;
    if (prior?.status === "dismissed") {
      status = "dismissed";
    } else if (patient) {
      status = "matched";
      linkedPatientNodeId = patient.id;
      enrichmentJobs.push({
        patientId: patient.id,
        patient: patient.attachments,
        fromCandidate: r,
      });
    } else {
      status = prior?.status === "manual-add" ? "manual-add" : "unmatched";
      linkedPatientNodeId = prior?.linkedPatientNodeId ?? null;
    }
    const row: Database["public"]["Tables"]["patient_contact_candidates"]["Insert"] = {
      user_id: userId,
      display_name: r.displayName,
      normalized_name: r.normalizedName,
      first_name: r.firstName,
      last_name: r.lastName,
      phone: r.phone,
      phone_raw: r.phoneRaw,
      email: r.email,
      notes: r.notes,
      days_since_last_appointment: r.daysSinceLastAppointment,
      banned: r.banned,
      status,
      linked_patient_node_id: linkedPatientNodeId,
      source_filename: sourceFilename,
      source_row: r.sourceRow,
      imported_at: now,
      linked_at: status === "matched" ? now : null,
      updated_at: now,
    };
    if (prior) row.id = prior.id;
    candidateRows.push(row);
  }

  // Bulk upsert candidates.
  const CHUNK = 500;
  let candidatesTouched = 0;
  for (let i = 0; i < candidateRows.length; i += CHUNK) {
    const chunk = candidateRows.slice(i, i + CHUNK);
    const { error: cErr } = await sb
      .from("patient_contact_candidates")
      .upsert(chunk, { onConflict: "user_id,normalized_name" });
    if (cErr) {
      throw new Error(`Couldn't upsert candidates: ${cErr.message}`);
    }
    candidatesTouched += chunk.length;
  }

  // Enrich the matched patients' attachments. Same pattern as
  // refreshPatientSummary but only touches contact fields — we don't need
  // to re-roll from transactions here.
  let patientsEnriched = 0;
  for (const job of enrichmentJobs) {
    const next = applyContactToSummary(job.patient, job.fromCandidate, now);
    const { error: upErr } = await sb
      .from("knowledge_nodes")
      .update({
        attachments: next as unknown as Json,
        updated_at: now,
      })
      .eq("id", job.patientId)
      .eq("user_id", userId);
    if (upErr) {
      throw new Error(`Couldn't enrich patient: ${upErr.message}`);
    }
    patientsEnriched++;
  }

  const candidatesCreated = candidateRows.length - priorByKey.size;
  const exactMatches = enrichmentJobs.length;
  const clientsNoSales = candidateRows.filter(
    (c) => c.status === "unmatched" || c.status === "manual-add",
  ).length;
  const bannedCount = candidateRows.filter((c) => c.banned === true).length;
  const withPhone = candidateRows.filter((c) => c.phone !== null).length;
  const withEmail = candidateRows.filter((c) => c.email !== null).length;
  // salesNoClient = total patients minus those reachable after this ingest.
  // "Reachable" = enriched this round OR pre-existing phone/email from a
  // prior client-list upload. Counted post-enrichment so the receipt
  // reflects the state the spa owner is about to see.
  const totalPatients = patientByKey.size;
  const enrichedKeys = new Set(enrichmentJobs.map((j) => j.patientId));
  let patientsWithContact = 0;
  for (const [, p] of patientByKey) {
    const a = p.attachments;
    if (enrichedKeys.has(p.id)) {
      patientsWithContact++;
    } else if (a && (a.phone || a.email)) {
      patientsWithContact++;
    }
  }
  const salesNoClient = Math.max(0, totalPatients - patientsWithContact);

  return {
    candidatesTouched,
    candidatesCreated,
    exactMatches,
    patientsEnriched,
    clientsNoSales,
    bannedCount,
    withPhone,
    withEmail,
    salesNoClient,
    warnings: parsed.warnings.slice(0, 50),
  };
}

/**
 * Page through every patient knowledge_node for a user, applying a
 * row-by-row callback. PostgREST caps a single request at 1000 rows, so
 * any call that needs the full set has to paginate. Centralized here so
 * the overview / gaps / ingest paths can't accidentally skip rows.
 */
async function forEachPatient(
  sb: SupabaseAdmin,
  userId: string,
  cb: (row: {
    id: string;
    title: string;
    lookupKey: string | null;
    attachments: PatientSummary | null;
  }) => void,
): Promise<void> {
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("knowledge_nodes")
      .select("id, title, lookup_key, attachments")
      .eq("user_id", userId)
      .eq("node_type", "patient")
      .eq("context", "patients")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Couldn't read patients: ${error.message}`);
    if (!data || data.length === 0) return;
    for (const r of data) {
      cb({
        id: r.id,
        title: r.title,
        lookupKey: r.lookup_key,
        attachments: (r.attachments as unknown as PatientSummary | null) ?? null,
      });
    }
    if (data.length < PAGE) return;
    from += PAGE;
  }
}

/**
 * Write contact info from a parsed candidate row into a patient summary —
 * preserves all other fields (visits, spend, mix). Used both by the bulk
 * ingest pass above and by confirmContactSuggestion.
 */
function applyContactToSummary(
  prior: PatientSummary | null,
  candidate: ParsedClientRow,
  nowIso: string,
  contactSource: "client-csv" | "manual" | "fuzzy-confirmed" = "client-csv",
): PatientSummary {
  const base: PatientSummary = prior
    ? { ...prior }
    : ({
        normalizedName: candidate.normalizedName,
        displayName: candidate.displayName,
        firstVisit: null,
        lastVisit: null,
        totalVisits: 0,
        lifetimeUnits: 0,
        lifetimeSpendUsd: 0,
        netSpendUsd: 0,
        primaryManufacturer: null,
        productMix: {},
        loyaltyEngagement: {},
      } as PatientSummary);
  base.phone = candidate.phone;
  base.phoneRaw = candidate.phoneRaw;
  base.email = candidate.email;
  base.daysSinceLastAppointment = candidate.daysSinceLastAppointment;
  base.banned = candidate.banned;
  base.contactSource = contactSource;
  base.contactLinkedAt = nowIso;
  return base;
}

// ─── listContactsOverview ──────────────────────────────────────────────────

export const listContactsOverview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => overviewInput.parse(input))
  .handler(async ({ data }): Promise<ContactsOverview> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    let totalPatients = 0;
    let withContact = 0;
    let withPhone = 0;
    let withEmail = 0;
    let banned = 0;
    await forEachPatient(sb, effectiveUserId, ({ attachments: a }) => {
      totalPatients++;
      if (!a) return;
      if (a.phone || a.email) withContact++;
      if (a.phone) withPhone++;
      if (a.email) withEmail++;
      if (a.banned) banned++;
    });

    const [{ count: candidateCount }, { count: unmatchedCount }] = await Promise.all([
      sb
        .from("patient_contact_candidates")
        .select("id", { count: "exact", head: true })
        .eq("user_id", effectiveUserId),
      sb
        .from("patient_contact_candidates")
        .select("id", { count: "exact", head: true })
        .eq("user_id", effectiveUserId)
        .eq("status", "unmatched"),
    ]);

    return {
      totalPatients,
      patientsWithContact: withContact,
      patientsWithPhone: withPhone,
      patientsWithEmail: withEmail,
      bannedPatientCount: banned,
      contactGapCount: totalPatients - withContact,
      unmatchedCandidateCount: unmatchedCount ?? 0,
      hasClientList: (candidateCount ?? 0) > 0,
    };
  });

// ─── listContactGaps (with fuzzy suggestions) ──────────────────────────────

export const listContactGaps = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => gapsInput.parse(input))
  .handler(async ({ data }): Promise<ContactGap[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const limit = data.limit ?? 200;

    // Patients with NO contact info. We can't easily filter the jsonb at
    // query time, so pull all patients via the paginated helper and filter
    // in JS — fine at Rejuv's ~1.1k scale; revisit if a tenant ever crosses
    // ~50k. Without pagination this silently truncated at 1000 rows.
    const allPatients: Array<{
      id: string;
      title: string;
      lookupKey: string | null;
      attachments: PatientSummary | null;
    }> = [];
    await forEachPatient(sb, effectiveUserId, (p) => allPatients.push(p));

    const gapPatients = allPatients.filter((p) => {
      if (!p.lookupKey) return false;
      const a = p.attachments;
      if (!a) return true;
      return !a.phone && !a.email;
    });

    // Sort by lifetime spend descending so the highest-value gaps surface
    // first — matches the match-report ordering.
    gapPatients.sort((a, b) => {
      const sa = a.attachments?.lifetimeSpendUsd ?? 0;
      const sb_ = b.attachments?.lifetimeSpendUsd ?? 0;
      return sb_ - sa;
    });

    // Unmatched candidates form the fuzzy pool — we don't try to fuzzy-match
    // against already-matched candidates because that'd suggest a candidate
    // who's already linked to a different patient.
    const { data: pool, error: poolErr } = await sb
      .from("patient_contact_candidates")
      .select("id, display_name, first_name, last_name, phone, email, banned")
      .eq("user_id", effectiveUserId)
      .eq("status", "unmatched");
    if (poolErr) throw new Error(`Couldn't load candidate pool: ${poolErr.message}`);

    const poolTargets: Array<
      FuzzyTarget & { phone: string | null; email: string | null; banned: boolean; candidateId: string }
    > = (pool ?? []).map((c) => ({
      ...fuzzyTargetFromName(c.id, c.display_name, c.first_name, c.last_name),
      phone: c.phone,
      email: c.email,
      banned: c.banned,
      candidateId: c.id,
    }));

    const gaps: ContactGap[] = [];
    for (const p of gapPatients.slice(0, limit)) {
      const source = fuzzyTargetFromName(p.id, p.title, null, null);
      const matches = findFuzzyMatches(source, poolTargets, {
        maxDistance: 2,
        maxResults: 3,
      });
      const suggestions: ContactSuggestion[] = matches.map((m) => {
        const t = poolTargets.find((x) => x.id === m.target.id)!;
        return {
          patient: {
            id: p.id,
            displayName: p.title,
            normalizedName: p.lookupKey ?? "",
            lifetimeSpendUsd: p.attachments?.lifetimeSpendUsd ?? 0,
            totalVisits: p.attachments?.totalVisits ?? 0,
            primaryManufacturer: p.attachments?.primaryManufacturer ?? null,
          },
          candidate: {
            id: t.candidateId,
            displayName: t.displayName,
            phone: t.phone,
            email: t.email,
            banned: t.banned,
          },
          distance: m.distance,
          confidence: m.confidence,
        };
      });
      gaps.push({
        id: p.id,
        displayName: p.title,
        normalizedName: p.lookupKey ?? "",
        lifetimeSpendUsd: p.attachments?.lifetimeSpendUsd ?? 0,
        totalVisits: p.attachments?.totalVisits ?? 0,
        lastVisit: p.attachments?.lastVisit ?? null,
        primaryManufacturer: p.attachments?.primaryManufacturer ?? null,
        suggestions,
      });
    }
    return gaps;
  });

// ─── confirmContactSuggestion ──────────────────────────────────────────────

export const confirmContactSuggestion = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => confirmSuggestionInput.parse(input))
  .handler(async ({ data }): Promise<PatientListRow> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const [{ data: candidate, error: cErr }, { data: patientNode, error: pErr }] =
      await Promise.all([
        sb
          .from("patient_contact_candidates")
          .select("*")
          .eq("user_id", userId)
          .eq("id", data.candidateId)
          .maybeSingle(),
        sb
          .from("knowledge_nodes")
          .select("*")
          .eq("user_id", userId)
          .eq("id", data.patientNodeId)
          .maybeSingle(),
      ]);
    if (cErr) throw new Error(`Couldn't load candidate: ${cErr.message}`);
    if (pErr) throw new Error(`Couldn't load patient: ${pErr.message}`);
    if (!candidate) throw new Error("Candidate not found.");
    if (!patientNode) throw new Error("Patient not found.");

    const now = new Date().toISOString();
    const candidateAsRow: ParsedClientRow = {
      sourceRow: candidate.source_row ?? 0,
      firstName: candidate.first_name,
      lastName: candidate.last_name,
      displayName: candidate.display_name,
      normalizedName: candidate.normalized_name,
      phone: candidate.phone,
      phoneRaw: candidate.phone_raw,
      email: candidate.email,
      notes: candidate.notes,
      daysSinceLastAppointment: candidate.days_since_last_appointment,
      banned: candidate.banned,
    };
    const priorSummary =
      (patientNode.attachments as unknown as PatientSummary | null) ?? null;
    const nextSummary = applyContactToSummary(
      priorSummary,
      candidateAsRow,
      now,
      "fuzzy-confirmed",
    );

    const { data: updatedNode, error: upErr } = await sb
      .from("knowledge_nodes")
      .update({
        attachments: nextSummary as unknown as Json,
        updated_at: now,
      })
      .eq("id", data.patientNodeId)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (upErr) throw new Error(`Couldn't update patient: ${upErr.message}`);

    const { error: linkErr } = await sb
      .from("patient_contact_candidates")
      .update({
        status: "matched",
        linked_patient_node_id: data.patientNodeId,
        linked_at: now,
        updated_at: now,
      })
      .eq("user_id", userId)
      .eq("id", data.candidateId);
    if (linkErr) throw new Error(`Couldn't link candidate: ${linkErr.message}`);

    return hydratePatientListRow(updatedNode);
  });

// ─── dismissContactSuggestion ──────────────────────────────────────────────

export const dismissContactSuggestion = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => dismissSuggestionInput.parse(input))
  .handler(async ({ data }): Promise<{ candidateId: string }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    // Dismissing the candidate globally — it won't be suggested again for
    // any patient. The intent is "this client list row is junk" or "this
    // row is for someone we don't have purchase history for." Per-patient
    // dismissal (less invasive) is a future refinement; we can carry it on
    // a new junction table when the spa actually asks for it.
    const { error } = await sb
      .from("patient_contact_candidates")
      .update({
        status: "dismissed",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("id", data.candidateId);
    if (error) throw new Error(`Couldn't dismiss candidate: ${error.message}`);
    return { candidateId: data.candidateId };
  });

// ─── findSameContactDifferentName (Pass 3, v1.25.0) ────────────────────────
//
// Detects probable maiden/married surname-change pairs (and other source-
// data duplicates) by finding patient records that share a phone or email
// + a canonical first name, but differ on last name.
//
// Letter-distance fuzzy match (Pass 2) caps at 2 edits — it can't catch
// Anderson↔Chen. Pass 3 uses CONTACT INFO as the bridge: if two patient
// records share a phone OR email AND their first names map to the same
// canonical form (e.g. "Sarah" vs "Sarah", or "Bob" vs "Robert"), they're
// almost certainly the same person.
//
// First-name guard prevents household-sharing false positives: mom +
// daughter sharing a phone have DIFFERENT first names, so they're filtered
// out cleanly. This pass surfaces surname-change candidates only.
//
// Output: pairs ready for one-click confirmation. No merge action yet —
// surfaced for spa-owner review; the merge primitive lands in a future ship.

export type SameContactPatientStub = {
  patientNodeId: string;
  displayName: string;
  lifetimeSpendUsd: number;
  lastVisit: string | null;
  totalVisits: number;
};

export type SameContactPair = {
  /** First patient record (alphabetically earlier last name — stable). */
  a: SameContactPatientStub;
  /** Second patient record. */
  b: SameContactPatientStub;
  /** What linked them. */
  matchedField: "phone" | "email";
  /** The matching value (for UI display: phone number or email). */
  matchedValue: string;
  /** Canonical first name they shared (via nickname dictionary). Useful
   *  for UI to render "Both first names map to <canonical>". */
  sharedFirstNameCanonical: string;
  /** True when the first-name equivalence required nickname resolution
   *  (e.g. Bob ↔ Robert). UI can show a hint chip. */
  matchedViaNickname: boolean;
};

const sameContactInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

/** Pull the lowercase first-token of a display name (handles "Last, First"
 *  and "First Last"). Empty string when nothing parseable. */
function extractFirstName(display: string): string {
  if (display.includes(",")) {
    const parts = display.split(",", 2).map((s) => s.trim());
    return parts[1]?.split(/\s+/)[0]?.toLowerCase() ?? "";
  }
  return display.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Pull the lowercase last-token of a display name. */
function extractLastName(display: string): string {
  if (display.includes(",")) {
    return display.split(",", 1)[0].trim().toLowerCase();
  }
  const parts = display.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

export const findSameContactDifferentName = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => sameContactInput.parse(input))
  .handler(async ({ data }): Promise<{ pairs: SameContactPair[] }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    type PatientRecord = {
      stub: SameContactPatientStub;
      firstNameCanonical: string;
      lastName: string;
      phone: string | null;
      email: string | null;
    };

    const all: PatientRecord[] = [];
    await forEachPatient(sb, effectiveUserId, ({ id, title, attachments }) => {
      if (!attachments) return;
      const phone = attachments.phone ?? null;
      const email = attachments.email ?? null;
      if (!phone && !email) return; // no contact = can't cross-match
      const displayName = attachments.displayName || title;
      const first = extractFirstName(displayName);
      const last = extractLastName(displayName);
      if (!first || !last) return;
      all.push({
        stub: {
          patientNodeId: id,
          displayName,
          lifetimeSpendUsd: attachments.lifetimeSpendUsd ?? 0,
          lastVisit: attachments.lastVisit ?? null,
          totalVisits: attachments.totalVisits ?? 0,
        },
        firstNameCanonical: nicknameCanonical(first),
        lastName: last.replace(/[^a-z0-9]/g, ""),
        phone,
        email: email ? email.toLowerCase() : null,
      });
    });

    // Group by phone, then by email — each group is a list of patients
    // sharing that contact value.
    const byPhone = new Map<string, PatientRecord[]>();
    const byEmail = new Map<string, PatientRecord[]>();
    for (const r of all) {
      if (r.phone) {
        let arr = byPhone.get(r.phone);
        if (!arr) {
          arr = [];
          byPhone.set(r.phone, arr);
        }
        arr.push(r);
      }
      if (r.email) {
        let arr = byEmail.get(r.email);
        if (!arr) {
          arr = [];
          byEmail.set(r.email, arr);
        }
        arr.push(r);
      }
    }

    // Walk each group, generate pairs where last names differ + first
    // names share a canonical form. Dedupe by (a.id, b.id) sorted —
    // shouldn't appear under both phone and email for the same pair
    // unless they genuinely share both, in which case the phone match
    // takes precedence (arbitrary but stable).
    const seen = new Set<string>();
    const pairs: SameContactPair[] = [];

    function tryPair(
      group: PatientRecord[],
      field: "phone" | "email",
      value: string,
    ) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          // Surname change = different last name.
          if (a.lastName === b.lastName) continue;
          // First name MUST share a canonical (filters out household phones).
          if (a.firstNameCanonical !== b.firstNameCanonical) continue;

          // Stable ordering: earlier-lastName-alphabetically first.
          const [first, second] =
            a.lastName < b.lastName ? [a, b] : [b, a];
          const key = `${first.stub.patientNodeId}|${second.stub.patientNodeId}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // matchedViaNickname is true when the canonical resolution was
          // needed (raw first names differed).
          const aRawFirst = extractFirstName(a.stub.displayName);
          const bRawFirst = extractFirstName(b.stub.displayName);
          const matchedViaNickname = aRawFirst !== bRawFirst;

          pairs.push({
            a: first.stub,
            b: second.stub,
            matchedField: field,
            matchedValue: value,
            sharedFirstNameCanonical: a.firstNameCanonical,
            matchedViaNickname,
          });
        }
      }
    }

    for (const [phone, group] of byPhone) {
      if (group.length < 2) continue;
      tryPair(group, "phone", phone);
    }
    for (const [email, group] of byEmail) {
      if (group.length < 2) continue;
      tryPair(group, "email", email);
    }

    // Sort: combined lifetime spend desc (highest-value duplicates first).
    pairs.sort(
      (x, y) =>
        y.a.lifetimeSpendUsd + y.b.lifetimeSpendUsd -
        (x.a.lifetimeSpendUsd + x.b.lifetimeSpendUsd),
    );

    return { pairs };
  });
