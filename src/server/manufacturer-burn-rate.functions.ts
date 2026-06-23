/**
 * Manufacturer burn-rate (v2.149.0, slice 2 of project_rep_dealmaker).
 *
 * Derives the spa's own purchasing pace per manufacturer from its transaction
 * history, to arm the Rep Deal-Maker with credible "I'm a real account" leverage
 * (the owner's OWN volume — never anyone else's; see the slice-1 guardrail).
 *
 * Two signals, deliberately separated by trust:
 *  - SPEND ($/quarter, $/year): sum of amount_usd. GIGO-FREE — no unit ambiguity,
 *    safe to DISPLAY. This is the strongest, cleanest negotiation anchor.
 *  - UNIT pace (units/quarter per product): quantity when present, else
 *    amount_usd ÷ unit_price_usd. An ESTIMATE (toxin "units" ≠ vials; quantity is
 *    often null), so it only PRE-FILLS the owner-confirmed field in the dialog —
 *    never shown as fact. fromDollarEstimate flags rows that used the $ fallback.
 *
 * Window: trailing 365 days. Quarterly = annual ÷ 4 (conservative when a spa has
 * <12mo of data — understates rather than overclaims).
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { admin } from "./admin-client";
import { getTenantIdForUser, resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import { MFR_LAST_TXN_SOURCE } from "@/lib/manufacturer-transaction-csv";
import { resolveProduct } from "@/lib/product-manufacturer-map";

const NO_TENANT_MSG = "No SmartSpa tenant — finish onboarding to see your buying pace.";

export type ManufacturerBurnProduct = {
  productName: string;
  productKind: string | null;
  /** Estimated units/quarter (owner-confirmed signal, not a fact). */
  unitsPerQuarter: number;
  /** True if any contributing row used amount ÷ unit_price (no explicit qty). */
  fromDollarEstimate: boolean;
};

export type ManufacturerBurn = {
  manufacturer: string;
  /** Trailing-365d spend (reliable — safe to display). */
  annualSpendUsd: number;
  /** annualSpendUsd ÷ 4. */
  quarterlySpendUsd: number;
  txnCount: number;
  /** Top products by estimated unit pace (desc), capped. */
  products: ManufacturerBurnProduct[];
};

export type BurnRateResult = {
  windowDays: number;
  byManufacturer: Record<string, ManufacturerBurn>;
};

const burnInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

/** Normalize a transaction's manufacturer to a canonical program key. Trusts the
 *  stored value when it's already canonical; falls back to resolving the product
 *  name (same source of truth the catalog uses). */
function canonicalManufacturer(
  stored: string | null,
  productName: string,
): string | null {
  let m = (stored ?? "").toLowerCase().trim();
  if (m === "allergan" || m === "alle" || m === "allē") m = "abbvie";
  if (m) return m;
  return resolveProduct(productName).manufacturer;
}

type TxnRow = {
  amount_usd: number;
  quantity: number | null;
  unit_price_usd: number | null;
  product_name: string;
  product_manufacturer: string | null;
  product_kind: string | null;
};

const WINDOW_DAYS = 365;
const MAX_PRODUCTS = 6;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export const getManufacturerBurnRatesFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => burnInput.parse(raw))
  .handler(async ({ data }): Promise<BurnRateResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId, NO_TENANT_MSG);

    const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const rows = await fetchAllRows<TxnRow>((from, to) =>
      sb
        .from("patient_transactions")
        .select(
          "amount_usd, quantity, unit_price_usd, product_name, product_manufacturer, product_kind",
        )
        .eq("user_id", tenantId)
        .gt("amount_usd", 0) // real purchases only — excludes $0 cadence markers + negative redemptions
        .neq("source", MFR_LAST_TXN_SOURCE)
        .gte("transaction_date", cutoff)
        // Stable order so range-pagination doesn't skip/double rows (truncation class).
        .order("transaction_date", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    );

    type Acc = {
      manufacturer: string;
      annualSpendUsd: number;
      txnCount: number;
      products: Map<string, { kind: string | null; units: number; fromDollar: boolean }>;
    };
    const byMfr = new Map<string, Acc>();

    for (const t of rows) {
      const mfr = canonicalManufacturer(t.product_manufacturer, t.product_name);
      if (!mfr) continue;
      const acc =
        byMfr.get(mfr) ??
        { manufacturer: mfr, annualSpendUsd: 0, txnCount: 0, products: new Map() };
      acc.annualSpendUsd += t.amount_usd;
      acc.txnCount += 1;

      // Unit estimate: explicit quantity, else amount ÷ unit_price.
      let units: number | null = null;
      let fromDollar = false;
      if (t.quantity != null && Number.isFinite(t.quantity) && t.quantity > 0) {
        units = t.quantity;
      } else if (
        t.unit_price_usd != null &&
        Number.isFinite(t.unit_price_usd) &&
        t.unit_price_usd > 0
      ) {
        units = t.amount_usd / t.unit_price_usd;
        fromDollar = true;
      }
      if (units != null) {
        const name = t.product_name.trim();
        const p =
          acc.products.get(name) ?? { kind: t.product_kind, units: 0, fromDollar: false };
        p.units += units;
        if (fromDollar) p.fromDollar = true;
        if (!p.kind && t.product_kind) p.kind = t.product_kind;
        acc.products.set(name, p);
      }
      byMfr.set(mfr, acc);
    }

    const byManufacturer: Record<string, ManufacturerBurn> = {};
    for (const [mfr, acc] of byMfr) {
      const products: ManufacturerBurnProduct[] = [...acc.products.entries()]
        .map(([productName, p]) => ({
          productName,
          productKind: p.kind,
          unitsPerQuarter: round1(p.units / 4),
          fromDollarEstimate: p.fromDollar,
        }))
        .filter((p) => p.unitsPerQuarter > 0)
        .sort((a, b) => b.unitsPerQuarter - a.unitsPerQuarter)
        .slice(0, MAX_PRODUCTS);
      byManufacturer[mfr] = {
        manufacturer: mfr,
        annualSpendUsd: Math.round(acc.annualSpendUsd),
        quarterlySpendUsd: Math.round(acc.annualSpendUsd / 4),
        txnCount: acc.txnCount,
        products,
      };
    }

    return { windowDays: WINDOW_DAYS, byManufacturer };
  });
