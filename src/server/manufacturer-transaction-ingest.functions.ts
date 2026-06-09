/**
 * Manufacturer last-TREATMENT ingestion server fn — Lane 2 of the master
 * ingestion plan (project_manufacturer_data_ingestion_plan).
 *
 * Public surface:
 *   ingestManufacturerTransactionCsv — accept a wide Allergan
 *       last-transaction report, parse it (pure lib), match each patient to
 *       the spa's own patient graph (email → phone → name), and insert the
 *       melted last-treatment dates into patient_transactions at amount_usd
 *       = 0 with source = MFR_LAST_TXN_SOURCE. Returns a one-screen receipt.
 *
 * WHY patient_transactions (not a new table): the lapsed/overdue engine
 * (doListOverdue, spa-rep-data-share) already reduces patient_transactions
 * by (patient × kind) to find the most-recent treatment date per cadence
 * kind. Feeding manufacturer last-treatment dates into the SAME table is
 * what sharpens that detection — a patient whose QuickBooks book has gone
 * quiet but whose Allergan report shows a recent Botox gets the more
 * accurate recency.
 *
 * SAFETY (the contained blast radius):
 *   - amount_usd = 0 → every revenue/reconcile/campaign consumer (all of
 *     which filter amount_usd > 0) automatically excludes these rows.
 *   - source = MFR_LAST_TXN_SOURCE → the two cadence queries opt them IN.
 *   - rollupPatientSummary skips source = MFR_LAST_TXN_SOURCE → the patient
 *     LIST summary stays QuickBooks-truth (no inflated visit counts / brand).
 *   - Only MATCHED patients are inserted (patient_transactions requires a
 *     non-null patient_node_id; a cadence signal for a patient you don't
 *     have is useless anyway).
 *
 * Pattern mirrors manufacturer-reward-ingest.functions.ts.
 *
 * Established 2026-06-08 (Patient-Profitability OS · Lane 2).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import { normEmail, normPhone, nameTokenKey } from "@/lib/manufacturer-reward-csv";
import {
  parseManufacturerTxnCsv,
  detectManufacturerTxnFromCsv,
  MFR_LAST_TXN_SOURCE,
  MFR_LAST_TXN_INVOICE,
  type LastTreatmentRow,
} from "@/lib/manufacturer-transaction-csv";

// ─── Service-role client (mirrors the sibling ingest fns) ──────────────────

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

// ─── Receipt ───────────────────────────────────────────────────────────────

export type LastTxnImportReceipt = {
  report: string;
  displayName: string;
  manufacturer: string;
  /** Distinct patient rows in the file. */
  dataRows: number;
  /** Melted last-treatment cells (one per patient × product with a date). */
  meltedRows: number;
  /** Distinct patients matched into the spa's book. */
  matchedPatients: number;
  /** New patient_transactions rows inserted (re-uploads → 0). */
  rowsInserted: number;
  /** Melted rows whose dedupe key already existed (no-op). */
  rowsSkipped: number;
  /** Melted rows that had contact info but no matching patient. */
  unmatchedWithContact: number;
  /** Of the inserted rows, how many are cadence kinds (toxin/filler). */
  cadenceRows: number;
  /** Long-format only: loyalty rows (Points Used / Giftcard / Promo) skipped. */
  skippedLoyaltyRows: number;
  warnings: Array<{ sourceRow: number; message: string }>;
};

type NodeContact = {
  phone?: string | null;
  phoneRaw?: string | null;
  email?: string | null;
  [k: string]: unknown;
};

// ─── ingestManufacturerTransactionCsv ──────────────────────────────────────

const ingestInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  csv: z.string(),
  sourceFilename: z.string().nullable().optional(),
});

export const ingestManufacturerTransactionCsv = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ingestInput.parse(input))
  .handler(async ({ data }): Promise<LastTxnImportReceipt> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    return doIngestLastTransactions(
      sb,
      effectiveUserId,
      data.csv,
      data.sourceFilename ?? null,
    );
  });

export async function doIngestLastTransactions(
  sb: SupabaseAdmin,
  userId: string,
  csv: string,
  sourceFilename: string | null,
): Promise<LastTxnImportReceipt> {
  // 1) Parse — pure, no I/O. Dispatches on shape (wide pre-agg | long history).
  const parsed = parseManufacturerTxnCsv(csv);
  if (parsed.report === "unknown" || parsed.rows.length === 0) {
    throw new Error(
      parsed.warnings[0]?.message ??
        "Couldn't find any treatment dates in that file. Is this an Allergan last-transaction or TransactionsReport export?",
    );
  }

  // 2) Pre-fetch the spa's patient nodes once; build email/phone/name maps.
  //    Page past the 1,000-row cap so we match the full book.
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

  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const n of nodes ?? []) {
    const a = (n.attachments as NodeContact | null) ?? {};
    const email = normEmail(a.email ?? null);
    if (email && !byEmail.has(email)) byEmail.set(email, n.id);
    const phone = normPhone((a.phone ?? a.phoneRaw ?? null) as string | null);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, n.id);
    const nameKey = nameTokenKey(n.title ?? n.lookup_key ?? null);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, n.id);
  }

  const resolveNode = (e: LastTreatmentRow): string | null => {
    const email = normEmail(e.contactEmail);
    if (email && byEmail.has(email)) return byEmail.get(email)!;
    const phone = normPhone(e.contactPhone);
    if (phone && byPhone.has(phone)) return byPhone.get(phone)!;
    const nameKey = nameTokenKey(e.contactName);
    if (nameKey && byName.has(nameKey)) return byName.get(nameKey)!;
    return null;
  };

  // 3) Build insert rows for MATCHED patients only (the table requires a
  //    non-null patient_node_id, and an unmatched cadence signal is moot).
  const matchedPatientIds = new Set<string>();
  let unmatchedWithContact = 0;
  let cadenceRows = 0;
  // Deterministic line_index per (patient, date, invoice, product) so two
  // identical lines on one transaction coexist AND re-uploads stay no-ops
  // (same file order → same indices). The dedupe unique index needs it.
  const lineSeq = new Map<string, number>();

  const insertRows = parsed.rows
    .map((e) => {
      const nodeId = resolveNode(e);
      if (!nodeId) {
        if (normEmail(e.contactEmail) || normPhone(e.contactPhone)) {
          unmatchedWithContact++;
        }
        return null;
      }
      matchedPatientIds.add(nodeId);
      if (e.productKind === "toxin" || e.productKind === "filler") cadenceRows++;
      // Real vendor transaction ID when present (long history) → clean dedupe
      // across overlapping date-range exports; constant token for the wide
      // pre-aggregated reports (which have no per-row id).
      const invoiceNum = e.transactionId ?? MFR_LAST_TXN_INVOICE;
      const seqKey = `${nodeId}|${e.transactionDate}|${invoiceNum}|${e.productName}`;
      const lineIndex = lineSeq.get(seqKey) ?? 0;
      lineSeq.set(seqKey, lineIndex + 1);
      return {
        user_id: userId,
        patient_node_id: nodeId,
        transaction_date: e.transactionDate,
        invoice_num: invoiceNum,
        line_index: lineIndex,
        product_name: e.productName,
        product_manufacturer: e.productManufacturer,
        product_kind: e.productKind,
        description: `Last ${e.productName} treatment (Allergan ${parsed.report})`,
        quantity: null,
        unit_price_usd: null,
        // Recency marker only — never a revenue line. See file docblock.
        amount_usd: 0,
        balance_usd: null,
        source: MFR_LAST_TXN_SOURCE,
        source_ref: sourceFilename
          ? `${sourceFilename}:${e.sourceRow}`
          : `:${e.sourceRow}`,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // 4) Upsert (chunked). The dedupe unique index makes re-uploads no-ops via
  //    the stable MFR_LAST_TXN_INVOICE token + (patient, date, product).
  const CHUNK = 1000;
  let inserted = 0;
  for (let i = 0; i < insertRows.length; i += CHUNK) {
    const chunk = insertRows.slice(i, i + CHUNK);
    const { data: result, error } = await sb
      .from("patient_transactions")
      .upsert(chunk, {
        onConflict:
          "user_id,patient_node_id,transaction_date,invoice_num,product_name,line_index",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) {
      throw new Error(`Couldn't save last-treatment rows: ${error.message}`);
    }
    inserted += result?.length ?? 0;
  }

  return {
    report: parsed.report,
    displayName: parsed.displayName,
    manufacturer: parsed.manufacturer,
    dataRows: parsed.dataRowCount,
    meltedRows: parsed.rows.length,
    matchedPatients: matchedPatientIds.size,
    rowsInserted: inserted,
    rowsSkipped: insertRows.length - inserted,
    unmatchedWithContact,
    cadenceRows,
    skippedLoyaltyRows: parsed.skippedLoyaltyRows,
    warnings: parsed.warnings.slice(0, 50),
  };
}

// ─── Email-drop auto-ingest hook (parity with the reward lane) ─────────────
//
// The reward email-drop endpoint (api.resend.inbound-rewards) can route a
// last-transaction report here once that pipe goes live. detect → ingest,
// same core as the manual upload. Trust the token, not the sender.

export type TokenLastTxnResult = {
  ok: boolean;
  detected: string | null;
  receipt: LastTxnImportReceipt | null;
  reason: string | null;
};

/** True when this CSV is a manufacturer transaction report (vs a reward snapshot). */
export function isLastTransactionCsv(csv: string): boolean {
  return detectManufacturerTxnFromCsv(csv) !== null;
}

export async function ingestLastTxnCsvForUser(
  sb: SupabaseAdmin,
  userId: string,
  csv: string,
  sourceFilename: string | null,
): Promise<TokenLastTxnResult> {
  const detected = detectManufacturerTxnFromCsv(csv);
  if (!detected) {
    return { ok: false, detected: null, receipt: null, reason: "unrecognized_csv" };
  }
  const receipt = await doIngestLastTransactions(sb, userId, csv, sourceFilename);
  return { ok: true, detected, receipt, reason: null };
}
