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
import { admin, type SbClient } from "./admin-client";
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
  /** Per-product trailing-365d spend (reliable). */
  annualSpendUsd: number;
  /** Matched catalog brand_family (links to the verified ladder), if found. */
  brandFamily: string | null;
  /** Matched catalog per-purchase-unit sales price. The CLIENT uses this vs the
   *  verified ladder's per-unit COST as a same-unit gate: if sales ≥ ~0.8× cost,
   *  the spa prices in the ladder's unit (syringe) → a reliable unit-pace can be
   *  derived (spend ÷ sales price); if far below (toxin dosing-units) it can't. */
  salesPricePerUnit: number | null;
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

type CatalogRow = {
  brand: string;
  brand_family: string | null;
  manufacturer: string | null;
  sales_price_per_unit: number;
};

const WINDOW_DAYS = 365;
const MAX_PRODUCTS = 6;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Best catalog match for a transaction product name: exact normalized, then
 *  bidirectional contains. Returns brand_family + per-unit sales price. */
function matchCatalog(
  catalog: CatalogRow[],
  productName: string,
): { brandFamily: string | null; salesPricePerUnit: number | null } {
  const n = normalizeName(productName);
  if (!n) return { brandFamily: null, salesPricePerUnit: null };
  let exact: CatalogRow | undefined;
  let contains: CatalogRow | undefined;
  for (const c of catalog) {
    const cb = normalizeName(c.brand);
    if (!cb) continue;
    if (cb === n) {
      exact = c;
      break;
    }
    if (!contains && (cb.includes(n) || n.includes(cb))) contains = c;
  }
  const m = exact ?? contains;
  return {
    brandFamily: m?.brand_family ?? null,
    salesPricePerUnit: m && m.sales_price_per_unit > 0 ? m.sales_price_per_unit : null,
  };
}

/**
 * Core burn-rate aggregation, reusable server-side (mirrors the doListOverdue
 * pattern). The createServerFn wraps this; program-intel calls it directly to
 * power the profitability calc — both ride the same math so the numbers can't
 * drift. Filters patient_transactions to real purchases (amount > 0) in the
 * trailing window.
 */
export async function doManufacturerBurnRates(
  sb: SbClient,
  tenantId: string,
): Promise<BurnRateResult> {
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

    // Catalog (per-unit sales price + brand_family) for the unit-pace bridge.
    const catalog = await fetchAllRows<CatalogRow>((from, to) =>
      sb
        .from("products")
        .select("brand, brand_family, manufacturer, sales_price_per_unit")
        .eq("tenant_id", tenantId)
        .order("brand", { ascending: true })
        .range(from, to),
    );

    type Acc = {
      manufacturer: string;
      annualSpendUsd: number;
      txnCount: number;
      products: Map<
        string,
        { kind: string | null; units: number; spend: number; fromDollar: boolean }
      >;
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

      const name = t.product_name.trim();
      const p =
        acc.products.get(name) ?? { kind: t.product_kind, units: 0, spend: 0, fromDollar: false };
      p.spend += t.amount_usd;
      if (!p.kind && t.product_kind) p.kind = t.product_kind;

      // Unit estimate: explicit quantity, else amount ÷ unit_price (flagged).
      if (t.quantity != null && Number.isFinite(t.quantity) && t.quantity > 0) {
        p.units += t.quantity;
      } else if (
        t.unit_price_usd != null &&
        Number.isFinite(t.unit_price_usd) &&
        t.unit_price_usd > 0
      ) {
        p.units += t.amount_usd / t.unit_price_usd;
        p.fromDollar = true;
      }
      acc.products.set(name, p);
      byMfr.set(mfr, acc);
    }

    const byManufacturer: Record<string, ManufacturerBurn> = {};
    for (const [mfr, acc] of byMfr) {
      const mfrCatalog = catalog.filter(
        (c) => (c.manufacturer ?? "").toLowerCase() === mfr || !c.manufacturer,
      );
      const products: ManufacturerBurnProduct[] = [...acc.products.entries()]
        .map(([productName, p]) => {
          const cat = matchCatalog(mfrCatalog, productName);
          return {
            productName,
            productKind: p.kind,
            unitsPerQuarter: round1(p.units / 4),
            fromDollarEstimate: p.fromDollar,
            annualSpendUsd: Math.round(p.spend),
            brandFamily: cat.brandFamily,
            salesPricePerUnit: cat.salesPricePerUnit,
          };
        })
        .filter((p) => p.annualSpendUsd > 0)
        .sort((a, b) => b.annualSpendUsd - a.annualSpendUsd)
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
    return doManufacturerBurnRates(sb, tenantId);
  });
