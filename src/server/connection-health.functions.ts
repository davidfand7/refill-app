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
import { MANUFACTURER_MAPPERS } from "@/lib/manufacturer-reward-csv";
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
  ctx?: { expectedMissing?: boolean },
): string {
  // "Expected missing" = the spa declared they use this calendar, but there's
  // no active connection at all (never connected, or the token was revoked /
  // it was disconnected). Without the expect-gate this platform would simply
  // VANISH from the page — the silent calendar outage Connection Health exists
  // to catch. Say plainly that it's expected and not flowing.
  if (ctx?.expectedMissing) {
    return `${name} is set as a calendar you expect, but there's no active connection — SmartSpa isn't receiving appointments from it. Connect ${name} to resume live sync. ${BOUNDARY}`;
  }
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
  ctx?: { neverArrived?: boolean; expectedAgeLabel?: string },
): string {
  // "Never arrived" = an EXPECTED portal whose first import has not landed.
  // Its copy must NOT borrow last-event phrasing ("hasn't imported in X")
  // because there is no last event — it must say plainly that the very first
  // pull never came. This is the rung-1 silent-failure made legible.
  if (ctx?.neverArrived) {
    const since = ctx.expectedAgeLabel ?? "recently";
    switch (verdict) {
      case "setup":
        return `${name} auto-import is set up — waiting for the first import to land.`;
      case "stale":
        return `You set up ${name} ${since}, but no import has arrived yet — the first pull may not have landed (portal login wrong, or the agent hasn't run). ${BOUNDARY}`;
      case "broken":
        return `${name} was set up ${since}, but no import has EVER arrived — the first pull never landed. Check the portal login. ${BOUNDARY}`;
      default:
        break; // healthy/unconfigured aren't reachable with zero events
    }
  }
  switch (verdict) {
    case "healthy":
      return `Last pulled ${ageLabel}. Refreshes on a daily schedule.`;
    case "stale":
      return `${name}'s last successful pull was ${ageLabel} — the daily import may have stopped (portal login expired, or the agent didn't run). ${BOUNDARY}`;
    case "broken":
      return `${name}'s last import was ${ageLabel} — the auto-import looks stopped. Check the portal login. ${BOUNDARY}`;
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

/**
 * reward_signal_imports.manufacturer stores the MAPPER KEY (e.g.
 * "allergan-patient360", "galderma-savings"), not the canonical brand. Left
 * un-collapsed, each report variant became its own ugly per-report card
 * ("Allergan-patient360", "Galderma-savings") AND none of them merged with an
 * expected_portal_sources row (canonical "allergan"/"galderma"), double-carding
 * the same manufacturer. Collapse to the mapper's canonical `manufacturer` so
 * every report of a brand shares ONE health card and expectations merge with
 * imports. Unknown/legacy keys (already canonical) pass through unchanged.
 */
function canonicalManufacturer(mapperKeyOrName: string): string {
  const k = (mapperKeyOrName ?? "").toLowerCase();
  return (MANUFACTURER_MAPPERS[k]?.manufacturer ?? k).toLowerCase();
}

type ExpectedAnchor = { expectedSinceMs: number | null; label: string | null };

/**
 * The expect-gate read — one mechanism, every feed kind. Returns the enabled
 * expected_sources for a tenant+kind keyed by (lowercased) source_key. ADDITIVE
 * overlay: on ANY failure (e.g. the migration hasn't landed in this env yet) it
 * returns an empty map so the trust page degrades to connection/import-only
 * rather than throwing — the core reads beside it stay load-bearing and loud.
 */
async function readExpectedSources(
  sb: ReturnType<typeof admin>,
  userId: string,
  kind: "portal" | "scheduler",
): Promise<Map<string, ExpectedAnchor>> {
  const out = new Map<string, ExpectedAnchor>();
  try {
    type Row = {
      source_key: string;
      expected_since: string | null;
      label: string | null;
    };
    // expected_sources isn't in the generated types yet; loose view
    // (mirrors the reward_ingest_tokens cast pattern).
    const { data, error } = await (sb as unknown as { from(t: string): any })
      .from("expected_sources")
      .select("source_key, expected_since, label")
      .eq("user_id", userId)
      .eq("kind", kind)
      .eq("enabled", true);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Row[]) {
      const k = (r.source_key ?? "").toLowerCase();
      if (!k) continue;
      out.set(k, { expectedSinceMs: parseTs(r.expected_since), label: r.label });
    }
  } catch (err) {
    console.error(
      `[connection-health] expected_sources(${kind}) read failed (degrading):`,
      err,
    );
  }
  return out;
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
      // Freshness measures a real DATA event only. connected_at is the OAuth
      // handshake time, not a sync — borrowing it would let a connected row
      // that has NEVER synced read "Healthy · syncing live" off the auth
      // timestamp. With no last_sync_at, the honest verdict is "setup"
      // (waiting for first sync). Live Acuity stamps last_sync_at on connect,
      // so this only hardens any future platform that connects without one.
      const lastEventAtMs = parseTs(row.last_sync_at);
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

    // ── Expected scheduler/PMS connections — the silent-calendar-outage gate ──
    // A scheduler row exists from the OAuth handshake, so "connected but never
    // synced" already shows above. The blind spot is the OPPOSITE: a calendar
    // whose token was revoked, or that was disconnected / never connected, has
    // NO active row (the query above filters to active statuses) → it VANISHES
    // from the page. If the spa DECLARED they expect that platform, surface it
    // as a flagged "expected but not connected" card instead of nothing — the
    // same expect-gate primitive the portals use, second feed kind.
    const expectedSchedulers = await readExpectedSources(
      sb,
      effectiveUserId,
      "scheduler",
    );
    const activePlatforms = new Set(
      ((schedRows ?? []) as SchedulerRow[]).map((r) =>
        (r.platform ?? "").toLowerCase(),
      ),
    );
    const expectedSchedulerItems: ConnectionHealthItem[] = [
      ...expectedSchedulers.entries(),
    ]
      .filter(([platform]) => !activePlatforms.has(platform))
      .map(([platform, anchor]) => {
        const tier = schedulerTier(platform);
        const name =
          anchor.label ?? SCHEDULER_DISPLAY[platform] ?? titleCase(platform);
        const { verdict, severity } = computeVerdict({
          tier,
          connected: false, // declared expected, but no active connection
          lastEventAtMs: null,
          expectedSinceMs: anchor.expectedSinceMs,
          nowMs,
        });
        return {
          key: `scheduler:${platform}`,
          kind: "scheduler" as const,
          displayName: name,
          subLabel: "Calendar",
          tier,
          tierLabel: tierLabelOf(tier),
          verdict,
          severity,
          statusLabel: verdictLabel(verdict),
          detail: schedulerDetail(name, verdict, "—", { expectedMissing: true }),
          lastEventAtMs: null,
          lastEventLabel: "—",
          cta: { label: "Connect", to: CONNECTIONS_ROUTE },
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

    // importRows are globally ordered imported_at DESC, so the first time we
    // see a canonical manufacturer is its newest pull across ALL its report
    // variants — "when did we last hear from this brand at all".
    const latestByMfr = new Map<string, number | null>();
    for (const r of importRows) {
      const mfr = canonicalManufacturer(r.manufacturer);
      if (!mfr) continue;
      if (!latestByMfr.has(mfr)) latestByMfr.set(mfr, parseTs(r.imported_at));
    }

    // ── Expected portal sources — what the spa DECLARED should flow ──
    // The portals above are derived ONLY from imports that already landed, so a
    // portal set up but whose first pull never arrived (login wrong from day
    // one) writes no row and stays INVISIBLE — the rung-1 silent failure this
    // whole surface exists to catch. The expect-gate (expected_sources,
    // kind='portal') is the "we expect this" anchor: an expected-but-never-
    // imported portal now appears and its silence ages into a flag
    // (computeVerdict + expectedSinceMs). Degrades gracefully (see helper).
    const expectedByMfr = await readExpectedSources(
      sb,
      effectiveUserId,
      "portal",
    );

    // Union the manufacturers we've heard from with those we EXPECT to hear
    // from — so an expected portal with zero imports still gets a card.
    const portalMfrs = new Set<string>([
      ...latestByMfr.keys(),
      ...expectedByMfr.keys(),
    ]);

    const portalItems: ConnectionHealthItem[] = [...portalMfrs].map((mfr) => {
      const lastEventAtMs = latestByMfr.get(mfr) ?? null;
      const expected = expectedByMfr.get(mfr);
      const expectedSinceMs = expected?.expectedSinceMs ?? null;
      // No data has ever arrived → freshness has nothing real to measure; the
      // copy + CTA switch to the "first import hasn't landed" framing.
      const neverArrived = lastEventAtMs == null;
      const disp = PORTAL_DISPLAY[mfr] ?? {
        name: titleCase(mfr),
        brand: titleCase(mfr),
      };
      const displayName = expected?.label ?? disp.name;
      const { verdict, severity } = computeVerdict({
        tier: "poll",
        connected: true, // imported before OR declared expected to flow
        lastEventAtMs,
        expectedSinceMs,
        nowMs,
      });
      const ageLabel = formatAge(
        lastEventAtMs == null ? null : Math.max(0, nowMs - lastEventAtMs),
      );
      const expectedAgeLabel = formatAge(
        expectedSinceMs == null ? null : Math.max(0, nowMs - expectedSinceMs),
      );
      const needsAction = severity === "error" || severity === "warn";
      const ctaLabel = neverArrived
        ? needsAction
          ? "Fix login"
          : "Finish setup"
        : verdict === "healthy"
          ? "View"
          : "Check auto-import";
      return {
        key: `portal:${mfr}`,
        kind: "portal" as const,
        displayName,
        subLabel: disp.brand,
        tier: "poll" as HealthTier,
        tierLabel: tierLabelOf("poll"),
        verdict,
        severity,
        statusLabel: verdictLabel(verdict),
        detail: portalDetail(displayName, verdict, ageLabel, {
          neverArrived,
          expectedAgeLabel,
        }),
        lastEventAtMs,
        lastEventLabel: ageLabel,
        cta: { label: ctaLabel, to: REWARDS_ROUTE },
      };
    });

    // Sort worst-first so anything needing attention floats to the top.
    const sevRank: Record<HealthSeverity, number> = {
      error: 0,
      warn: 1,
      neutral: 2,
      ok: 3,
    };
    const items = [
      ...schedulerItems,
      ...expectedSchedulerItems,
      ...portalItems,
    ].sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

    const attention = items.filter(
      (i) => i.severity === "error" || i.severity === "warn",
    ).length;

    return {
      generatedAtMs: nowMs,
      items,
      summary: { ok: items.length - attention, attention, total: items.length },
    };
  });

// ─── Expected sources (the "gate" declaration — one primitive, every kind) ───
//
// The spa declares which feeds it EXPECTS to flow. That single row is what lets
// Connection Health flag a feed that's silently absent — a portal set up but
// never imported (no import = no row), or a calendar whose token was revoked /
// that was never connected (no active row). One mechanism, two feed kinds:
// declare → it gets watched → a silent gap becomes a flagged, fixable card.

export interface ExpectedSourceOption {
  /** Canonical lowercase key: a portal's brand or a scheduler's platform. */
  sourceKey: string;
  name: string;
  subLabel: string;
}

/** Reward portals SmartSpa can auto-import (keys match reward_signal_imports
 *  canonical manufacturers + PORTAL_DISPLAY). */
export const EXPECTABLE_PORTALS: ExpectedSourceOption[] = [
  { sourceKey: "allergan", name: "Allē", subLabel: "Allergan" },
  { sourceKey: "galderma", name: "ASPIRE", subLabel: "Galderma" },
  { sourceKey: "evolus", name: "Evolus Rewards", subLabel: "Evolus" },
];

/** Calendar/PMS platforms a spa can actually connect today (keys match
 *  emma_scheduler_connections.platform + SCHEDULER_DISPLAY). Kept to the live
 *  ones — we don't offer to "watch" a platform we can't connect. */
export const EXPECTABLE_SCHEDULERS: ExpectedSourceOption[] = [
  { sourceKey: "acuity", name: "Acuity", subLabel: "Calendar" },
  { sourceKey: "vagaro", name: "Vagaro", subLabel: "Calendar" },
];

const EXPECTABLE_BY_KIND: Record<string, ExpectedSourceOption[]> = {
  portal: EXPECTABLE_PORTALS,
  scheduler: EXPECTABLE_SCHEDULERS,
};

export interface ExpectedSourceState extends ExpectedSourceOption {
  kind: "portal" | "scheduler";
  expected: boolean;
}

// expected_sources isn't in the generated types yet; loose view (mirrors the
// reward_ingest_tokens cast pattern).
function expectedTbl(sb: ReturnType<typeof admin>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sb as unknown as { from(t: string): any }).from("expected_sources");
}

const kindSchema = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().optional(),
  kind: z.enum(["portal", "scheduler"]),
});

/** UI: which sources of this kind is the spa currently watching? Returns the
 *  full roster with an `expected` flag so toggles render in a stable order. */
export const listExpectedSourcesFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => kindSchema.parse(raw))
  .handler(async ({ data }): Promise<ExpectedSourceState[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const options = EXPECTABLE_BY_KIND[data.kind] ?? [];
    const { data: rows, error } = await expectedTbl(sb)
      .select("source_key")
      .eq("user_id", effectiveUserId)
      .eq("kind", data.kind)
      .eq("enabled", true);
    if (error) throw new Error(error.message);
    const on = new Set(
      ((rows ?? []) as { source_key: string }[]).map((r) =>
        (r.source_key ?? "").toLowerCase(),
      ),
    );
    return options.map((o) => ({
      kind: data.kind,
      sourceKey: o.sourceKey,
      name: o.name,
      subLabel: o.subLabel,
      expected: on.has(o.sourceKey),
    }));
  });

const setExpectedSchema = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().optional(),
  kind: z.enum(["portal", "scheduler"]),
  sourceKey: z.string().min(1),
  expected: z.boolean(),
});

/** UI: start (or stop) watching a source. Toggling on (re)stamps
 *  expected_since so the "overdue" clock starts from the declaration; toggling
 *  off disables without losing history. */
export const setExpectedSourceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => setExpectedSchema.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const key = data.sourceKey.toLowerCase();
    const options = EXPECTABLE_BY_KIND[data.kind] ?? [];
    if (!options.some((o) => o.sourceKey === key)) {
      throw new Error("Unknown source.");
    }
    const sb = admin();
    const nowIso = new Date().toISOString();
    if (data.expected) {
      const { error } = await expectedTbl(sb).upsert(
        {
          user_id: effectiveUserId,
          kind: data.kind,
          source_key: key,
          enabled: true,
          expected_since: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "user_id,kind,source_key" },
      );
      if (error) throw new Error(error.message);
    } else {
      const { error } = await expectedTbl(sb)
        .update({ enabled: false, updated_at: nowIso })
        .eq("user_id", effectiveUserId)
        .eq("kind", data.kind)
        .eq("source_key", key);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });
