/**
 * connection-health.functions.ts — the unified read model behind the
 * Connection Health dashboard (feedback_connection_health_doctrine).
 *
 * One question, answered honestly: "Is every feed SmartSpa depends on
 * actually flowing — and if not, is it OUR fault or the connection's?"
 *
 * Two feed families today, one spine:
 *   1. PMS scheduler connections — emma_scheduler_connections (Acuity live;
 *      Vagaro key; others reserved). Status enum + last_sync_at.
 *   2. Manufacturer reward-portal pulls — reward_signal_imports, the daily
 *      Allē / ASPIRE / Evolus pulls (a Claude Code /schedule task on the
 *      spa's Mac POSTs each report in). Freshness = max(imported_at) per
 *      manufacturer. If the portal login breaks, NO row is written — so the
 *      absence of a recent import IS the signal. That silent gap is exactly
 *      what the freshness check in connection-health.ts catches.
 *
 * No migration: every timestamp this needs already exists. This fn only
 * reads + classifies; computeVerdict (pure lib) makes the call.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import {
  computeVerdict,
  formatAge,
  verdictLabel,
  tierLabel as tierLabelOf,
  type HealthTier,
  type HealthVerdict,
  type HealthSeverity,
} from "@/lib/connection-health";

// ─── Output shape ────────────────────────────────────────────────────────

export interface ConnectionHealthItem {
  /** Stable key, e.g. "scheduler:acuity" / "portal:abbvie". */
  key: string;
  kind: "scheduler" | "portal";
  displayName: string;
  /** Secondary line — connected account email, or manufacturer brand. */
  subLabel: string | null;
  tier: HealthTier;
  tierLabel: string;
  verdict: HealthVerdict;
  severity: HealthSeverity;
  statusLabel: string;
  /** One-line human explanation, including the "it's the connection, not
   *  SmartSpa" boundary clause when something's wrong. */
  detail: string;
  lastEventAtMs: number | null;
  lastEventLabel: string;
  cta: { label: string; to: string };
}

export interface ConnectionHealthReport {
  generatedAtMs: number;
  items: ConnectionHealthItem[];
  summary: { ok: number; attention: number; total: number };
}

// ─── Admin client ──────────────────────────────────────────────────────────

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── Display + tier maps ─────────────────────────────────────────────────

const CONNECTIONS_ROUTE = "/app/refill/calendar/connections";
const REWARDS_ROUTE = "/app/refill/recognition/rewards";

const SCHEDULER_DISPLAY: Record<string, string> = {
  acuity: "Acuity",
  vagaro: "Vagaro",
  square: "Square",
  boulevard: "Boulevard",
  mindbody: "Mindbody",
  jane: "Jane",
  zenoti: "Zenoti",
  booker: "Booker",
};

/** Acuity is webhook-driven (realtime); Vagaro is API-key polling. The rest
 *  are OAuth/webhook platforms (realtime) when they go live. */
function schedulerTier(platform: string): HealthTier {
  return platform === "vagaro" ? "poll" : "realtime";
}

/** manufacturer code → patient-facing program name + brand owner. */
const PORTAL_DISPLAY: Record<string, { name: string; brand: string }> = {
  abbvie: { name: "Allē", brand: "Allergan" },
  allergan: { name: "Allē", brand: "Allergan" },
  galderma: { name: "ASPIRE", brand: "Galderma" },
  evolus: { name: "Evolus Rewards", brand: "Evolus" },
};

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ─── Copy ────────────────────────────────────────────────────────────────

/** The boundary clause — the doctrine's trust move: when a feed is down,
 *  say plainly that SmartSpa is fine and the connection is the issue. */
const BOUNDARY = "SmartSpa is healthy — this is the connection, not us.";

function schedulerDetail(
  name: string,
  verdict: HealthVerdict,
  ageLabel: string,
): string {
  switch (verdict) {
    case "healthy":
      return `Connected and syncing live. Last activity ${ageLabel}.`;
    case "stale":
      return `No activity from ${name} in a while (last ${ageLabel}). Often normal for a quiet calendar — reconnect if bookings aren't flowing through. ${BOUNDARY}`;
    case "broken":
      return `${name} reports a connection error — reconnect to resume live sync. ${BOUNDARY}`;
    case "setup":
      return `Connecting to ${name} — waiting for the first sync.`;
    case "unconfigured":
      return `${name} isn't connected.`;
  }
}

function portalDetail(
  name: string,
  verdict: HealthVerdict,
  ageLabel: string,
): string {
  switch (verdict) {
    case "healthy":
      return `Last pulled ${ageLabel}. Refreshes on a daily schedule.`;
    case "stale":
      return `No successful ${name} pull in ${ageLabel} — the daily import may have stopped (portal login expired, or the agent didn't run). ${BOUNDARY}`;
    case "broken":
      return `${name} hasn't imported in ${ageLabel} — the auto-import looks stopped. Check the portal login. ${BOUNDARY}`;
    case "setup":
      return `${name} is set up — waiting for the first import.`;
    case "unconfigured":
      return `${name} auto-import isn't set up.`;
  }
}

// ─── Row types ─────────────────────────────────────────────────────────────

type SchedulerRow = {
  id: string;
  platform: string;
  platform_account_email: string | null;
  status: string;
  last_sync_at: string | null;
  connected_at: string | null;
};

type ImportRow = {
  manufacturer: string;
  imported_at: string | null;
};

function parseTs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// ─── getConnectionHealthFn ──────────────────────────────────────────────────

const inputSchema = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().optional(),
});

export const getConnectionHealthFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => inputSchema.parse(raw))
  .handler(async ({ data }): Promise<ConnectionHealthReport> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const nowMs = Date.now();

    // ── Scheduler connections (exclude fully-disconnected rows) ──
    // Surface a query failure LOUDLY (throw → UI toast) rather than swallow it:
    // ignoring `error` here would let a failed read render as "no connections /
    // all healthy" — the exact silent absence this whole surface exists to catch.
    const { data: schedRows, error: schedErr } = await sb
      .from("emma_scheduler_connections")
      .select(
        "id, platform, platform_account_email, status, last_sync_at, connected_at",
      )
      .eq("user_id", effectiveUserId)
      .in("status", ["connected", "pending", "reauth_needed", "error"])
      .order("connected_at", { ascending: false });
    if (schedErr) throw new Error(schedErr.message);

    const schedulerItems: ConnectionHealthItem[] = (
      (schedRows ?? []) as SchedulerRow[]
    ).map((row) => {
      const tier = schedulerTier(row.platform);
      const name = SCHEDULER_DISPLAY[row.platform] ?? titleCase(row.platform);
      const lastEventAtMs =
        parseTs(row.last_sync_at) ?? parseTs(row.connected_at);
      const { verdict, severity } = computeVerdict({
        tier,
        connected: row.status === "connected",
        errored: row.status === "error" || row.status === "reauth_needed",
        pending: row.status === "pending",
        lastEventAtMs,
        nowMs,
      });
      return {
        key: `scheduler:${row.platform}`,
        kind: "scheduler",
        displayName: name,
        subLabel: row.platform_account_email,
        tier,
        tierLabel: tierLabelOf(tier),
        verdict,
        severity,
        statusLabel: verdictLabel(verdict),
        detail: schedulerDetail(name, verdict, formatAge(
          lastEventAtMs == null ? null : Math.max(0, nowMs - lastEventAtMs),
        )),
        lastEventAtMs,
        lastEventLabel: formatAge(
          lastEventAtMs == null ? null : Math.max(0, nowMs - lastEventAtMs),
        ),
        cta: { label: verdict === "healthy" ? "Manage" : "Reconnect", to: CONNECTIONS_ROUTE },
      };
    });

    // ── Reward-portal pulls — newest imported_at PER manufacturer ──
    // Read ALL import rows (paginated) ordered newest-first, then take the
    // first occurrence per manufacturer. A fixed .limit() was wrong: a
    // manufacturer with many daily pulls could fill the whole window and bury
    // another manufacturer's latest pull past the cutoff, falsely reading it
    // as "no data."
    const importRows = await fetchAllRows<ImportRow>((from, to) =>
      sb
        .from("reward_signal_imports")
        .select("manufacturer, imported_at")
        .eq("user_id", effectiveUserId)
        .order("imported_at", { ascending: false })
        .range(from, to),
    );

    const latestByMfr = new Map<string, number | null>();
    for (const r of importRows) {
      const mfr = (r.manufacturer ?? "").toLowerCase();
      if (!mfr) continue;
      if (!latestByMfr.has(mfr)) latestByMfr.set(mfr, parseTs(r.imported_at));
    }

    const portalItems: ConnectionHealthItem[] = [...latestByMfr.entries()].map(
      ([mfr, lastEventAtMs]) => {
        const disp = PORTAL_DISPLAY[mfr] ?? { name: titleCase(mfr), brand: titleCase(mfr) };
        const { verdict, severity } = computeVerdict({
          tier: "poll",
          connected: true, // we've received data from this portal before
          lastEventAtMs,
          nowMs,
        });
        const ageLabel = formatAge(
          lastEventAtMs == null ? null : Math.max(0, nowMs - lastEventAtMs),
        );
        return {
          key: `portal:${mfr}`,
          kind: "portal" as const,
          displayName: disp.name,
          subLabel: disp.brand,
          tier: "poll" as HealthTier,
          tierLabel: tierLabelOf("poll"),
          verdict,
          severity,
          statusLabel: verdictLabel(verdict),
          detail: portalDetail(disp.name, verdict, ageLabel),
          lastEventAtMs,
          lastEventLabel: ageLabel,
          cta: {
            label: verdict === "healthy" ? "View" : "Check auto-import",
            to: REWARDS_ROUTE,
          },
        };
      },
    );

    // Sort worst-first so anything needing attention floats to the top.
    const sevRank: Record<HealthSeverity, number> = {
      error: 0,
      warn: 1,
      neutral: 2,
      ok: 3,
    };
    const items = [...schedulerItems, ...portalItems].sort(
      (a, b) => sevRank[a.severity] - sevRank[b.severity],
    );

    const attention = items.filter(
      (i) => i.severity === "error" || i.severity === "warn",
    ).length;

    return {
      generatedAtMs: nowMs,
      items,
      summary: { ok: items.length - attention, attention, total: items.length },
    };
  });
