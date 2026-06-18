/**
 * Patient Architecture P4 — spa-rep aggregate consent + rep-side aggregates.
 *
 * The cross-tenant bridge. Two halves:
 *
 *   Spa side:
 *     listSpaShareableReps   — reps the spa already has a relationship with
 *                              (via spa_promo_interest) plus the current
 *                              data-share state per rep.
 *     grantRepDataShare      — opt-in / opt-back-in.
 *     revokeRepDataShare     — sets revoked_at; preserves audit trail.
 *
 *   Rep side:
 *     getSpaAggregates       — for a given (rep, spa), returns aggregate
 *                              counts ONLY when the spa has actively granted
 *                              consent. Return TYPE cannot include patient
 *                              names or IDs — the compiler enforces the
 *                              privacy boundary, not just code review.
 *
 * Why a separate file from patient-ingest.functions.ts: the cross-tenant
 * read pattern, the strict type contract, and the consent gating are
 * conceptually their own surface. Mixing them with patient ingest would
 * blur the responsibility boundary.
 *
 * Established 2026-05-15 (Patient Architecture P4).
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import { verifyAuth } from "@/server/auth-helpers";
import type { PatientSummary } from "@/lib/patient-csv";
import type { ProductManufacturer } from "@/lib/product-manufacturer-map";
import {
  computeOverdue,
  daysSince,
  KIND_CADENCE,
} from "@/lib/patient-cadence";
import { MFR_LAST_TXN_SOURCE } from "@/lib/manufacturer-transaction-csv";

// ─── Public types (typed boundary lives here) ─────────────────────────────

/**
 * What the spa sees when managing its rep relationships.
 */
export type SpaShareableRep = {
  repUserId: string;
  /** Email used for the rep's auth account. Best identifier we have today. */
  repEmail: string | null;
  /** Optional short label — falls back to the email prefix. */
  repDisplayName: string;
  /** Promotion titles this rep has issued that the spa engaged with. */
  knownPromotions: string[];
  /** True when the spa has an active share (revoked_at IS NULL). */
  isSharing: boolean;
  /** ISO timestamp of the active grant, or null if no row exists. */
  grantedAt: string | null;
  /** ISO timestamp of the last revoke, or null if never revoked. */
  revokedAt: string | null;
  /** Optional note the spa left explaining the share. */
  spaNote: string | null;
};

/**
 * The aggregate payload the rep sees per consenting spa. TYPED so the
 * compiler refuses to add `displayName`, `patientNodeId`, `phone`, or any
 * other field that would leak per-patient information. Counts only.
 *
 * IMPORTANT: do not extend this type with anything that could identify or
 * partially-identify a patient. If a future field would do so (e.g.
 * "patientsWithMatchingCondition") it belongs in a different consent level
 * (cohort_lists / contact_pool) — not here.
 */
export type SpaAggregates = {
  /** Distinct patients seen for any injectable in the last 12 months. */
  activePatients12mo: number;
  /** Counts per manufacturer of patients whose primary brand is that one. */
  primaryManufacturerCounts: Partial<Record<ProductManufacturer, number>>;
  /** Counts per manufacturer of patients past their overdue window. */
  overdueByManufacturer: Partial<Record<ProductManufacturer, number>>;
  /** Total overdue count (across all kinds with a cadence policy). */
  totalOverdue: number;
  /** Loyalty-program engagement signal — distinct patients who have redeemed at all. */
  loyaltyEngaged: Partial<Record<ProductManufacturer, number>>;
  /** ISO timestamp the aggregate snapshot was computed — for "fresh as of X". */
  computedAt: string;
};

export type SpaAggregateForRep = {
  spaUserId: string;
  /** Public spa name — sourced from claim-your-business profile, NOT patient data. */
  spaName: string | null;
  isSharing: boolean;
  /** Populated only when isSharing is true. */
  aggregates: SpaAggregates | null;
};

// ─── Admin client ─────────────────────────────────────────────────────────

type SupabaseAdmin = ReturnType<typeof admin>;

// ─── Zod ──────────────────────────────────────────────────────────────────

const accessTokenOnly = z.object({
  accessToken: z.string().min(1),
});

const grantInput = z.object({
  accessToken: z.string().min(1),
  repUserId: z.string().uuid(),
  spaNote: z.string().max(500).optional(),
});

const revokeInput = z.object({
  accessToken: z.string().min(1),
  repUserId: z.string().uuid(),
});

const getAggregatesInput = z.object({
  accessToken: z.string().min(1),
  spaUserId: z.string().uuid(),
});

// ─── Spa side: list reps + their share state ──────────────────────────────

export const listSpaShareableReps = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => accessTokenOnly.parse(input))
  .handler(async ({ data }): Promise<SpaShareableRep[]> => {
    const spaUserId = await verifyAuth(data.accessToken);
    const sb = admin();

    // 1) Reps the spa has interacted with via interest signals. This is the
    //    universe of reps we surface — the spa already has a working
    //    relationship with them, so the share decision is on-context.
    const { data: signals } = await sb
      .from("spa_promo_interest")
      .select("rep_user_id, promotion_node_id, status, updated_at")
      .eq("spa_user_id", spaUserId);
    const repIds = Array.from(
      new Set((signals ?? []).map((s) => s.rep_user_id)),
    );
    if (repIds.length === 0) return [];

    // 2) Map promotion → title for the "known promotions" sub-line.
    const promoIds = Array.from(
      new Set((signals ?? []).map((s) => s.promotion_node_id)),
    );
    const promosByRep = new Map<string, string[]>();
    if (promoIds.length > 0) {
      const { data: promos } = await sb
        .from("knowledge_nodes")
        .select("id, title, user_id")
        .in("id", promoIds);
      const titleById = new Map<string, { title: string; userId: string }>();
      for (const p of promos ?? []) {
        titleById.set(p.id, { title: p.title, userId: p.user_id });
      }
      for (const s of signals ?? []) {
        const t = titleById.get(s.promotion_node_id);
        if (!t) continue;
        const list = promosByRep.get(s.rep_user_id) ?? [];
        if (!list.includes(t.title)) list.push(t.title);
        promosByRep.set(s.rep_user_id, list);
      }
    }

    // 3) Existing share rows for this spa.
    const { data: shares } = await sb
      .from("spa_rep_data_share")
      .select("rep_user_id, granted_at, revoked_at, spa_note")
      .eq("spa_user_id", spaUserId);
    const shareByRep = new Map<
      string,
      {
        grantedAt: string;
        revokedAt: string | null;
        spaNote: string | null;
      }
    >();
    for (const r of shares ?? []) {
      shareByRep.set(r.rep_user_id, {
        grantedAt: r.granted_at,
        revokedAt: r.revoked_at,
        spaNote: r.spa_note,
      });
    }

    // 4) Resolve rep email via auth.users admin lookup. Per-id calls are
    //    fine at this scale (a spa rarely has more than a handful of rep
    //    relationships); revisit if a top spa ever has 50+.
    const out: SpaShareableRep[] = [];
    for (const repId of repIds) {
      const { data: userResp } = await sb.auth.admin.getUserById(repId);
      const email = userResp?.user?.email ?? null;
      const share = shareByRep.get(repId);
      out.push({
        repUserId: repId,
        repEmail: email,
        repDisplayName: deriveRepName(email),
        knownPromotions: promosByRep.get(repId) ?? [],
        isSharing: !!share && share.revokedAt === null,
        grantedAt: share?.grantedAt ?? null,
        revokedAt: share?.revokedAt ?? null,
        spaNote: share?.spaNote ?? null,
      });
    }
    out.sort((a, b) => a.repDisplayName.localeCompare(b.repDisplayName));
    return out;
  });

function deriveRepName(email: string | null): string {
  if (!email) return "Unnamed rep";
  const local = email.split("@")[0] ?? email;
  // "first.last" → "First Last", "firstlast" stays as-is
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ") || email;
}

// ─── Spa side: grant / revoke ─────────────────────────────────────────────

export const grantRepDataShare = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => grantInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const spaUserId = await verifyAuth(data.accessToken);
    const sb = admin();
    const now = new Date().toISOString();
    const { error } = await sb
      .from("spa_rep_data_share")
      .upsert(
        {
          spa_user_id: spaUserId,
          rep_user_id: data.repUserId,
          share_level: "aggregate",
          granted_at: now,
          revoked_at: null,
          spa_note: data.spaNote ?? null,
          updated_at: now,
        },
        { onConflict: "spa_user_id,rep_user_id" },
      );
    if (error) throw new Error(`Couldn't grant share: ${error.message}`);
    return { ok: true };
  });

export const revokeRepDataShare = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => revokeInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const spaUserId = await verifyAuth(data.accessToken);
    const sb = admin();
    const now = new Date().toISOString();
    const { error } = await sb
      .from("spa_rep_data_share")
      .update({
        revoked_at: now,
        updated_at: now,
      })
      .eq("spa_user_id", spaUserId)
      .eq("rep_user_id", data.repUserId)
      .is("revoked_at", null);
    if (error) throw new Error(`Couldn't revoke share: ${error.message}`);
    return { ok: true };
  });

// ─── Rep side: get aggregates with typed boundary ─────────────────────────

/**
 * Compute the SpaAggregates for a (rep, spa) pair iff the spa has an active
 * grant. Returns a typed SpaAggregateForRep that the type system guarantees
 * does not include patient PII — the only "name" field is spaName which is
 * sourced from the spa's PUBLIC profile, never the patient data.
 *
 * No-consent path: returns { isSharing: false, aggregates: null }. The UI
 * shows a "this practice hasn't shared aggregates" line; no error.
 */
export const getSpaAggregatesForRep = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => getAggregatesInput.parse(input))
  .handler(async ({ data }): Promise<SpaAggregateForRep> => {
    const repUserId = await verifyAuth(data.accessToken);
    const sb = admin();
    return doGetSpaAggregatesForRep(sb, repUserId, data.spaUserId);
  });

export async function doGetSpaAggregatesForRep(
  sb: SupabaseAdmin,
  repUserId: string,
  spaUserId: string,
): Promise<SpaAggregateForRep> {
  // 1) Resolve spa name from PUBLIC profile (not patient data).
  const { data: nameNode } = await sb
    .from("knowledge_nodes")
    .select("title")
    .eq("user_id", spaUserId)
    .eq("context", "spa-profile")
    .eq("lookup_key", "spa-name")
    .maybeSingle();
  const spaName = nameNode?.title?.trim() || null;

  // 2) Verify active consent.
  const { data: shareRow } = await sb
    .from("spa_rep_data_share")
    .select("granted_at, revoked_at, share_level")
    .eq("spa_user_id", spaUserId)
    .eq("rep_user_id", repUserId)
    .is("revoked_at", null)
    .maybeSingle();
  if (!shareRow) {
    return { spaUserId, spaName, isSharing: false, aggregates: null };
  }

  // 3) Compute aggregates. Paginated patient scan; nothing leaves the loop
  //    beyond bare counts. NO patient identifiers anywhere in `agg`.
  const cutoff12mo = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 12);
    return d.toISOString().slice(0, 10);
  })();
  const agg: SpaAggregates = {
    activePatients12mo: 0,
    primaryManufacturerCounts: {},
    overdueByManufacturer: {},
    totalOverdue: 0,
    loyaltyEngaged: {},
    computedAt: new Date().toISOString(),
  };

  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data: chunk, error } = await sb
      .from("knowledge_nodes")
      .select("attachments")
      .eq("user_id", spaUserId)
      .eq("node_type", "patient")
      .eq("context", "patients")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Couldn't read patients: ${error.message}`);
    if (!chunk || chunk.length === 0) break;
    for (const r of chunk) {
      const p = (r.attachments as unknown as PatientSummary | null) ?? null;
      if (!p) continue;
      // Active = last visit within 12mo AND not banned.
      if (p.lastVisit && p.lastVisit >= cutoff12mo && !p.banned) {
        agg.activePatients12mo++;
      }
      if (p.primaryManufacturer) {
        agg.primaryManufacturerCounts[p.primaryManufacturer] =
          (agg.primaryManufacturerCounts[p.primaryManufacturer] ?? 0) + 1;
      }
      for (const [mfr, n] of Object.entries(p.loyaltyEngagement ?? {}) as Array<
        [ProductManufacturer, number]
      >) {
        if (n > 0) {
          agg.loyaltyEngaged[mfr] = (agg.loyaltyEngaged[mfr] ?? 0) + 1;
        }
      }
    }
    if (chunk.length < PAGE) break;
    from += PAGE;
  }

  // 4) Overdue counts via patient_transactions — same logic as
  //    listOverduePatients but tallying without joining names. The kind
  //    set comes from KIND_CADENCE (only kinds with a policy count).
  const targetKinds = Object.keys(KIND_CADENCE);
  type RecentByKey = { kind: string; manufacturer: string | null; date: string };
  const recents = new Map<string, RecentByKey>();
  let tFrom = 0;
  while (true) {
    const { data: chunk, error } = await sb
      .from("patient_transactions")
      .select("patient_node_id, product_kind, product_manufacturer, transaction_date")
      .eq("user_id", spaUserId)
      .in("product_kind", targetKinds)
      // Parity with doListOverdue: real purchases OR manufacturer
      // last-treatment markers (Lane 2). Keeps rep-facing overdue counts in
      // step with the owner's.
      .or(`amount_usd.gt.0,source.eq.${MFR_LAST_TXN_SOURCE}`)
      .order("transaction_date", { ascending: false })
      .range(tFrom, tFrom + PAGE - 1);
    if (error) throw new Error(`Couldn't read transactions: ${error.message}`);
    if (!chunk || chunk.length === 0) break;
    for (const t of chunk) {
      if (!t.product_kind) continue;
      const key = `${t.patient_node_id}::${t.product_kind}`;
      if (recents.has(key)) continue;
      recents.set(key, {
        kind: t.product_kind,
        manufacturer: t.product_manufacturer,
        date: t.transaction_date,
      });
    }
    if (chunk.length < PAGE) break;
    tFrom += PAGE;
  }
  for (const r of recents.values()) {
    const status = computeOverdue(
      r.kind as keyof typeof KIND_CADENCE,
      daysSince(r.date),
    );
    if (!status) continue;
    agg.totalOverdue++;
    if (r.manufacturer) {
      const m = r.manufacturer as ProductManufacturer;
      agg.overdueByManufacturer[m] = (agg.overdueByManufacturer[m] ?? 0) + 1;
    }
  }

  return { spaUserId, spaName, isSharing: true, aggregates: agg };
}

/**
 * Bulk variant for the InterestSignalsCard — one round trip resolves
 * aggregates for many spas. Same typed boundary; iterates the per-spa
 * function.
 */
export const getSpaAggregatesForReps = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        spaUserIds: z.array(z.string().uuid()).min(1).max(50),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<SpaAggregateForRep[]> => {
    const repUserId = await verifyAuth(data.accessToken);
    const sb = admin();
    const out: SpaAggregateForRep[] = [];
    for (const spaId of data.spaUserIds) {
      out.push(await doGetSpaAggregatesForRep(sb, repUserId, spaId));
    }
    return out;
  });
