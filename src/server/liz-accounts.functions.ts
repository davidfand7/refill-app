/**
 * Liz Accounts — server functions for the rep-side bulk account import.
 *
 * Two functions:
 *   importLizAccounts({ accessToken, rows }) — upsert account knowledge_nodes
 *     for the rep, matching on (user_id, node_type='account', lookup_key).
 *     New accounts insert; existing accounts UPDATE with merged tier arrays
 *     (per-family replace, others preserved) so re-imports don't wipe data.
 *   listLizAccounts({ accessToken }) — load all account nodes for the rep,
 *     newest-first. Powers the "list" state of /app/liz/accounts.
 *
 * Auth: explicit accessToken in payload (project_tanstack_serverfn_auth memory).
 * Source attribution: 'manual-seed' + connected_agent_id = Liz's row, so
 * Liz's memory_graph_query calls find these accounts as her own.
 *
 * Established v252 (2026-05-09).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";
import { resolveEffectiveUserId, type ViewAs } from "@/server/demo-user";
import {
  buildAccountAttachments,
  buildAccountContent,
  mergeTiers,
  type ParsedAccountRow,
} from "@/lib/liz-csv";
import {
  isAccountAttachments,
  type AccountAttachments,
  type AccountTier,
  type RepAssignment,
} from "@/server/agent-schema";
import { ensureLizAgent } from "@/server/liz-chat.functions";

// ── Admin helper ────────────────────────────────────────────────────────────
// (verifyAuth moved to @/server/auth-helpers as of v267 — single source of truth)

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

// ── Public types ──────────────────────────────────────────────────────────

export type LizAccount = {
  id: string;
  accountName: string;
  lookupKey: string | null;
  content: string;
  tiers: AccountTier[];
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  notes: string | null;
  /** Demo-seed rep persona marker — one of 'allergan-rep' / 'galderma-rep' /
   * 'evolus-rep' / 'merz-rep'. Undefined on organically-imported accounts
   * (e.g. real CSV imports without the field). Used by the persona filter
   * dropdown at /app/rep/accounts. */
  repAssignment?: RepAssignment;
  updatedAt: string;
};

export type ImportResultRow = {
  sourceRow: number;
  accountName: string;
  action: "created" | "updated" | "skipped";
  message?: string;
};

export type ImportLizAccountsResult = {
  created: number;
  updated: number;
  skipped: number;
  rows: ImportResultRow[];
};

// ── Row hydration ─────────────────────────────────────────────────────────

type AccountNodeRow = Pick<
  Database["public"]["Tables"]["knowledge_nodes"]["Row"],
  | "id"
  | "title"
  | "content"
  | "context"
  | "lookup_key"
  | "lookup_type"
  | "attachments"
  | "updated_at"
>;

function hydrateAccount(row: AccountNodeRow): LizAccount {
  const att = isAccountAttachments(row.attachments)
    ? (row.attachments as AccountAttachments)
    : {};
  return {
    id: row.id,
    accountName: row.title,
    lookupKey: row.lookup_key,
    content: row.content,
    tiers: Array.isArray(att.tiers) ? (att.tiers as AccountTier[]) : [],
    contactName: typeof att.contact_name === "string" ? att.contact_name : undefined,
    contactEmail: typeof att.contact_email === "string" ? att.contact_email : undefined,
    contactPhone: typeof att.contact_phone === "string" ? att.contact_phone : undefined,
    address: typeof att.address === "string" ? att.address : undefined,
    notes: row.context,
    repAssignment:
      typeof att.rep_assignment === "string"
        ? (att.rep_assignment as RepAssignment)
        : undefined,
    updatedAt: row.updated_at,
  };
}

// ── listLizAccounts ───────────────────────────────────────────────────────

const listInput = z.object({
  accessToken: z.string().min(1),
  // v332: when set, read queries scope to the demo tenant. Rep's auth still
  // gates the call — anonymous traffic never reaches demo data. See
  // src/server/demo-user.ts for the read-only routing pattern.
  viewAs: z.enum(["demo"]).optional(),
});

export const listLizAccounts = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<LizAccount[]> => {
    const repUserId = await verifyAuth(data.accessToken);
    const targetUserId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    const { data: rows, error } = await sb
      .from("knowledge_nodes")
      .select(
        "id, title, content, context, lookup_key, lookup_type, attachments, updated_at",
      )
      .eq("user_id", targetUserId)
      .eq("node_type", "account")
      .order("updated_at", { ascending: false })
      .limit(500);

    if (error) throw new Error(`Couldn't load accounts: ${error.message}`);
    return (rows ?? []).map((r) => hydrateAccount(r as AccountNodeRow));
  });

// ── importLizAccounts ─────────────────────────────────────────────────────

const parsedRowSchema = z.object({
  sourceRow: z.number().int().nonnegative(),
  accountName: z.string().min(1),
  lookupKey: z.string().min(1),
  contactName: z.string().optional(),
  contactEmail: z.string().optional(),
  contactPhone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
  tiers: z
    .array(
      z.object({
        family: z.string().min(1),
        tier: z.string().min(1),
        qtd_volume: z.number().optional(),
        threshold_to_maintain: z.number().optional(),
        threshold_to_advance: z.number().optional(),
        qtr_end: z.string().optional(),
      }),
    )
    .default([]),
  errors: z.array(z.string()).default([]),
});

const importInput = z.object({
  accessToken: z.string().min(1),
  rows: z.array(parsedRowSchema).min(1).max(500),
});

export const importLizAccounts = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => importInput.parse(input))
  .handler(async ({ data }): Promise<ImportLizAccountsResult> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const agent = await ensureLizAgent(userId);

    // Pre-load existing account rows for this rep, keyed by lookup_key, so we
    // can decide create-vs-update + merge tiers in a single round trip.
    const { data: existingRows, error: existingErr } = await sb
      .from("knowledge_nodes")
      .select("id, title, lookup_key, attachments")
      .eq("user_id", userId)
      .eq("node_type", "account");
    if (existingErr) {
      throw new Error(`Couldn't load existing accounts: ${existingErr.message}`);
    }
    const byLookup = new Map<
      string,
      { id: string; attachments: Json | null }
    >();
    for (const r of existingRows ?? []) {
      if (r.lookup_key) {
        byLookup.set(r.lookup_key, {
          id: r.id,
          attachments: r.attachments ?? null,
        });
      }
    }

    const result: ImportLizAccountsResult = {
      created: 0,
      updated: 0,
      skipped: 0,
      rows: [],
    };

    for (const raw of data.rows) {
      // Re-cast through ParsedAccountRow shape — the schema accepts the same
      // fields and the helpers expect that nominal type.
      const row: ParsedAccountRow = {
        sourceRow: raw.sourceRow,
        accountName: raw.accountName,
        lookupKey: raw.lookupKey,
        contactName: raw.contactName,
        contactEmail: raw.contactEmail,
        contactPhone: raw.contactPhone,
        address: raw.address,
        notes: raw.notes,
        tiers: raw.tiers as AccountTier[],
        errors: raw.errors,
      };

      if (row.errors.length > 0) {
        result.skipped++;
        result.rows.push({
          sourceRow: row.sourceRow,
          accountName: row.accountName || "(unnamed)",
          action: "skipped",
          message: row.errors.join("; "),
        });
        continue;
      }

      const existing = byLookup.get(row.lookupKey);

      // Build the attachments — for updates, merge tiers with existing.
      const incomingTiers = row.tiers;
      const finalTiers = existing
        ? mergeTiers(
            isAccountAttachments(existing.attachments)
              ? (existing.attachments as AccountAttachments).tiers
              : undefined,
            incomingTiers,
          )
        : incomingTiers;

      const attachments: AccountAttachments = {
        ...buildAccountAttachments(row),
        tiers: finalTiers,
      };
      // Drop tiers if empty so the JSON stays clean.
      if (!attachments.tiers || attachments.tiers.length === 0) {
        delete attachments.tiers;
      }

      const content = buildAccountContent(row);

      if (existing) {
        const { error: upErr } = await sb
          .from("knowledge_nodes")
          .update({
            title: row.accountName,
            content,
            context: row.notes ?? null,
            attachments: attachments as Json,
            source: "manual-seed",
            connected_agent_id: agent.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id)
          .eq("user_id", userId);
        if (upErr) {
          result.skipped++;
          result.rows.push({
            sourceRow: row.sourceRow,
            accountName: row.accountName,
            action: "skipped",
            message: `DB error: ${upErr.message}`,
          });
          continue;
        }
        result.updated++;
        result.rows.push({
          sourceRow: row.sourceRow,
          accountName: row.accountName,
          action: "updated",
        });
      } else {
        const { error: insErr } = await sb.from("knowledge_nodes").insert({
          user_id: userId,
          node_type: "account",
          title: row.accountName,
          content,
          context: row.notes ?? null,
          lookup_key: row.lookupKey,
          lookup_type: "account",
          attachments: attachments as Json,
          source: "manual-seed",
          connected_agent_id: agent.id,
        });
        if (insErr) {
          result.skipped++;
          result.rows.push({
            sourceRow: row.sourceRow,
            accountName: row.accountName,
            action: "skipped",
            message: `DB error: ${insErr.message}`,
          });
          continue;
        }
        result.created++;
        result.rows.push({
          sourceRow: row.sourceRow,
          accountName: row.accountName,
          action: "created",
        });
      }
    }

    return result;
  });

// ── getLizAccountDetail (v327 — Account Detail page) ───────────────────────
// Single round-trip fetch of everything the per-account drill-down view needs:
//   - the account node itself (tiers, contact, address, notes)
//   - recent order knowledge_nodes joined by attachments.account_lookup_key
//   - recent sample_order_intents for this account (joined by the snapshot's
//     account.lookup_key — JSONB query, filtered client-side as fallback)
//   - aggregate metrics computed server-side: YTD from order rows, count of
//     completed orders, last-order date, last-send date.
//
// Designed as a freeze-frame view: every value is computed at fetch time so
// the page renders without sub-queries. Refresh re-runs the whole thing.

export type LizAccountOrder = {
  id: string;
  title: string;
  productFamily: string;
  productName: string;
  quantity: number | null;
  invoiceAmountUsd: number | null;
  pointsEarned: number | null;
  dateOrdered: string | null;
  invoiceNumber: string | null;
  kind: "purchase" | "points_adjustment" | "unknown";
};

export type LizAccountSendIntent = {
  token: string;
  state: "active" | "viewed" | "confirmed" | "revoked";
  practiceEmail: string;
  totalUsd: number;
  putsThemAtTier: string | null;
  sentAt: string;
  firstViewedAt: string | null;
  confirmedAt: string | null;
  confirmedByName: string | null;
  confirmedNote: string | null;
  turnId: string | null;
};

export type LizAccountDetail = {
  account: LizAccount;
  orders: LizAccountOrder[];
  intents: LizAccountSendIntent[];
  metrics: {
    orderCount: number;
    ytdOrdersSumUsd: number;
    lastOrderDate: string | null;
    lastSendAt: string | null;
    lastConfirmAt: string | null;
  };
};

// v328 switched the route param from lookup_key → UUID accountId so the
// v316 report projector's colon-separated keys (which are unsafe to round-
// trip through URL encoding) don't ever appear in URLs. Server fn resolves
// the account by id first, then uses its (server-known) lookup_key for the
// downstream JSONB joins on orders + intents.
const detailInput = z.object({
  accessToken: z.string().min(1),
  accountId: z.string().uuid(),
  viewAs: z.enum(["demo"]).optional(),
});

export const getLizAccountDetail = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => detailInput.parse(input))
  .handler(async ({ data }): Promise<LizAccountDetail> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    // 1. Account row — looked up by UUID so URL-encoding can't mangle it.
    const { data: accountRow, error: accountErr } = await sb
      .from("knowledge_nodes")
      .select(
        "id, title, content, context, lookup_key, lookup_type, attachments, updated_at",
      )
      .eq("user_id", userId)
      .eq("node_type", "account")
      .eq("id", data.accountId)
      .maybeSingle();
    if (accountErr) {
      throw new Error(`Couldn't load that account — ${accountErr.message}`);
    }
    if (!accountRow) {
      throw new Error(
        "Couldn't find that account — it may have been removed or the link is stale.",
      );
    }
    const account = hydrateAccount(accountRow as AccountNodeRow);
    // Pull the canonical lookup_key off the resolved row — that's what the
    // order + intent JSONB joins need. Falls back to id-derived sentinel
    // when null so the downstream queries return 0 rows safely.
    const accountLookupKey = account.lookupKey ?? `__no-key__:${data.accountId}`;

    // 2. Order nodes attached to this account. JSONB key access via the
    //    `->>` operator on supabase-js.
    const { data: orderRows, error: ordersErr } = await sb
      .from("knowledge_nodes")
      .select("id, title, attachments, updated_at")
      .eq("user_id", userId)
      .eq("node_type", "order")
      .eq("attachments->>account_lookup_key", accountLookupKey)
      .order("updated_at", { ascending: false })
      .limit(200);
    if (ordersErr) {
      throw new Error(`Couldn't load orders for that account — ${ordersErr.message}`);
    }

    const orders: LizAccountOrder[] = (orderRows ?? []).map((r) => {
      const att = (r.attachments ?? {}) as Record<string, unknown>;
      const kindRaw = typeof att.kind === "string" ? att.kind : "unknown";
      const kind: LizAccountOrder["kind"] =
        kindRaw === "purchase" || kindRaw === "points_adjustment"
          ? kindRaw
          : "unknown";
      return {
        id: r.id,
        title: r.title,
        productFamily: typeof att.product_family === "string" ? att.product_family : "",
        productName: typeof att.product_name === "string" ? att.product_name : r.title,
        quantity: typeof att.quantity === "number" ? att.quantity : null,
        invoiceAmountUsd:
          typeof att.invoice_amount_usd === "number" ? att.invoice_amount_usd : null,
        pointsEarned: typeof att.points_earned === "number" ? att.points_earned : null,
        dateOrdered: typeof att.date_ordered === "string" ? att.date_ordered : null,
        invoiceNumber:
          typeof att.invoice_number === "string" ? att.invoice_number : null,
        kind,
      };
    });
    // Re-sort by date_ordered desc when present (updated_at order can be off
    // for legacy upserts that didn't bump updated_at on each row).
    orders.sort((a, b) => {
      if (a.dateOrdered && b.dateOrdered) {
        return a.dateOrdered < b.dateOrdered ? 1 : -1;
      }
      if (a.dateOrdered) return -1;
      if (b.dateOrdered) return 1;
      return 0;
    });

    // 3. Sample-order intents for this account. JSONB path query through the
    //    frozen snapshot.
    const { data: intentRows, error: intentsErr } = await sb
      .from("sample_order_intents")
      .select(
        "token, practice_email, order_snapshot, sent_at, first_viewed_at, confirmed_at, confirmed_by_name, confirmed_note, revoked_at, turn_id",
      )
      .eq("rep_user_id", userId)
      .eq("order_snapshot->account->>lookup_key", accountLookupKey)
      .order("sent_at", { ascending: false })
      .limit(50);
    if (intentsErr) {
      throw new Error(`Couldn't load activity for that account — ${intentsErr.message}`);
    }
    const intents: LizAccountSendIntent[] = (intentRows ?? []).map((r) => {
      const snap = r.order_snapshot as unknown as {
        total_usd?: number;
        puts_them_at_tier?: string;
      };
      const state: LizAccountSendIntent["state"] = r.revoked_at
        ? "revoked"
        : r.confirmed_at
          ? "confirmed"
          : r.first_viewed_at
            ? "viewed"
            : "active";
      return {
        token: r.token,
        state,
        practiceEmail: r.practice_email,
        totalUsd: typeof snap?.total_usd === "number" ? snap.total_usd : 0,
        putsThemAtTier: snap?.puts_them_at_tier ?? null,
        sentAt: r.sent_at,
        firstViewedAt: r.first_viewed_at,
        confirmedAt: r.confirmed_at,
        confirmedByName: r.confirmed_by_name,
        confirmedNote: r.confirmed_note,
        turnId: r.turn_id,
      };
    });

    // 4. Aggregate metrics.
    const ytdStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
    const ytdOrdersSumUsd = orders
      .filter((o) => o.kind === "purchase" && o.dateOrdered && o.dateOrdered >= ytdStart)
      .reduce((sum, o) => sum + (o.invoiceAmountUsd ?? 0), 0);
    const lastOrderDate =
      orders.find((o) => o.kind === "purchase")?.dateOrdered ?? null;
    const lastSendAt = intents[0]?.sentAt ?? null;
    const lastConfirmAt = intents.find((i) => i.state === "confirmed")?.confirmedAt ?? null;

    return {
      account,
      orders,
      intents,
      metrics: {
        orderCount: orders.filter((o) => o.kind === "purchase").length,
        ytdOrdersSumUsd,
        lastOrderDate,
        lastSendAt,
        lastConfirmAt,
      },
    };
  });

// ── updateLizAccountNotes (v327) ───────────────────────────────────────────
// Rep-editable free-text notes on the account's knowledge_nodes.context.
// Single field, autosave on blur or debounced typing.

const updateNotesInput = z.object({
  accessToken: z.string().min(1),
  accountId: z.string().uuid(),
  notes: z.string().max(8000),
  // v332: present-but-ignored on writes. Server REFUSES the call if set — we
  // never want a demo-mode UI accidentally mutating the showcase tenant.
  viewAs: z.enum(["demo"]).optional(),
});

export const updateLizAccountNotes = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => updateNotesInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; updatedAt: string }> => {
    if (data.viewAs === "demo") {
      throw new Error("Demo mode is read-only. Exit demo to edit your own notes.");
    }
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const trimmed = data.notes.trim();
    const now = new Date().toISOString();
    const { error } = await sb
      .from("knowledge_nodes")
      .update({
        context: trimmed.length > 0 ? trimmed : null,
        updated_at: now,
      })
      .eq("user_id", userId)
      .eq("node_type", "account")
      .eq("id", data.accountId);
    if (error) throw new Error(`Couldn't save notes — ${error.message}`);
    return { ok: true, updatedAt: now };
  });
