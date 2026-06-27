/**
 * connection-health.functions.ts — the unified read model behind the
 * Connection Health dashboard (feedback_connection_health_doctrine).
 *
 * One question, answered honestly: "Is every feed SmartSpa depends on
 * actually flowing — and if not, is it OUR fault or the connection's?"
 *
 * Two feed families today, one spine:
 *   1. PMS scheduler connections — scheduler_connections (Acuity live;
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
import { admin } from "./admin-client";
import { z } from "zod";

import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import { MANUFACTURER_MAPPERS } from "@/lib/manufacturer-reward-csv";
import { normalizePhoneE164 } from "@/lib/client-list-csv";
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
  /** Stable key, e.g. "scheduler:acuity" / "portal:abbvie" / "delivery:sms". */
  key: string;
  kind: "scheduler" | "portal" | "delivery" | "presence";
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

// ─── Display + tier maps ─────────────────────────────────────────────────

const CONNECTIONS_ROUTE = "/app/refill/calendar/connections";
const REWARDS_ROUTE = "/app/refill/recognition/rewards";
const RECOVERY_ROUTE = "/app/refill/recovery";
const HEALTH_ROUTE = "/app/refill/settings/health";

/** The two outbound channels SmartSpa sends patients on (patient_outreach.channel).
 *  source_key matches the channel value verbatim. */
const DELIVERY_DISPLAY: Record<string, { name: string; noun: string }> = {
  sms: { name: "Text messages", noun: "text" },
  email: { name: "Emails", noun: "email" },
};

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

/**
 * Appointment-FLOW freshness (S3): a DISTINCT signal from the connection pulse
 * the scheduler rows above measure. The reconcile cron (api.cron.acuity-reconcile,
 * every 2h) keeps scheduler_connections.last_sync_at fresh forever — so a
 * connected calendar reads "Healthy" indefinitely even if appointment DATA has
 * silently stopped arriving (a dead webhook + an empty reconcile window throw
 * nothing — the worst failure mode is an absence, not an error). This row
 * measures the honest thing: when the newest booking actually LANDED in our DB.
 * Realtime tier — a genuinely quiet calendar is legitimate, so we soft-flag
 * after a week and NEVER hard-break on silence (don't cry wolf) — but the
 * freshness clock is appointment arrival, not the sync pulse.
 */
function appointmentDetail(
  name: string,
  verdict: HealthVerdict,
  ageLabel: string,
): string {
  switch (verdict) {
    case "healthy":
      return `New ${name} bookings are flowing — the most recent landed ${ageLabel}.`;
    case "stale":
      return `No new ${name} appointments have arrived in a while (last ${ageLabel}). Often just a quiet calendar — but if you expected bookings, the live feed may have stopped even though the connection still reads healthy. ${BOUNDARY}`;
    case "setup":
      return `Connected to ${name} — waiting for the first appointment to arrive.`;
    case "broken":
      // Unreachable on realtime (no hard-break on silence); switch stays exhaustive.
      return `New ${name} appointments aren't arriving — check the connection. ${BOUNDARY}`;
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

function deliveryDetail(
  name: string,
  noun: string,
  verdict: HealthVerdict,
  ageLabel: string,
  ctx?: { neverSent?: boolean; expectedAgeLabel?: string },
): string {
  // "Never sent" = a channel the spa declared they expect, but nothing has EVER
  // gone out on it. Like the portal "never arrived" case, the copy must not
  // borrow last-event phrasing — there's no last send. NOTE: delivery never
  // hard-breaks on silence (brokenAfterH null) because a quiet stretch can be
  // legitimate, so the honest worst case here is "stale", never "broken".
  if (ctx?.neverSent) {
    const since = ctx.expectedAgeLabel ?? "recently";
    switch (verdict) {
      case "setup":
        return `${name} is on — waiting for the first ${noun} to go out.`;
      case "stale":
        return `You turned on ${name} ${since}, but nothing has gone out yet — check that your messaging is set up and the sending agent is running. ${BOUNDARY}`;
      default:
        break; // healthy/broken/unconfigured aren't reachable with zero sends
    }
  }
  switch (verdict) {
    case "healthy":
      return `Last ${noun} sent ${ageLabel}. Going out automatically as patients qualify.`;
    case "stale":
      return `Nothing has gone out on ${name} in a while (last ${ageLabel}). Often just a quiet stretch — but if you expected recall or rescue activity, your sending may have stopped (the agent isn't running, or messages aren't being delivered). ${BOUNDARY}`;
    case "setup":
      return `${name} is on — waiting for the first ${noun} to go out.`;
    case "unconfigured":
      return `${name} aren't going out yet.`;
    case "broken":
      // Unreachable on the delivery tier (no hard-break on silence), but the
      // switch must be exhaustive.
      return `${name} sending reports a problem. ${BOUNDARY}`;
  }
}

/**
 * Local delivery agent (presence tier). The freshness verdict comes from the
 * heartbeat age, but a fresh agent can still be UNABLE to relay — Messages.app
 * isn't running — which `capReason` carries. When present, the capability
 * problem overrides the copy even though the agent is checking in fine.
 */
function presenceDetail(
  name: string,
  verdict: HealthVerdict,
  ageLabel: string,
  ctx?: { neverSeen?: boolean; capReason?: string | null },
): string {
  // Fresh check-ins but a capability the relay needs is down → say THAT, not
  // "all good". The agent is alive; the relay is not.
  if (ctx?.capReason) {
    return `${name} is checking in (last ${ageLabel}), but ${ctx.capReason} — rescue texts can't relay until that's fixed. ${BOUNDARY}`;
  }
  if (ctx?.neverSeen) {
    switch (verdict) {
      case "setup":
        return `${name} is set up — waiting for its first check-in. Run the installer on the Mac that relays your texts.`;
      case "stale":
      case "broken":
        return `${name} was set up but has never checked in — the pinger may not be installed or running on the Mac. ${BOUNDARY}`;
      default:
        break;
    }
  }
  switch (verdict) {
    case "healthy":
      return `Online and standing by — last checked in ${ageLabel}. Refill texts can relay through this Mac.`;
    case "stale":
      return `${name} hasn't checked in for a bit (last ${ageLabel}) — the Mac may be asleep or Claude Desktop closed. Refill texts won't relay until it's back. ${BOUNDARY}`;
    case "broken":
      return `${name} has gone silent (last check-in ${ageLabel}) — the Mac is offline or the relay agent stopped. Refill texts can't go out until it reconnects. ${BOUNDARY}`;
    case "setup":
      return `${name} is set up — waiting for its first check-in.`;
    case "unconfigured":
      return `No local relay agent is set up.`;
  }
}

/**
 * Drafting routine (the "Drafting in Messages" presence row, v2.187.0). The
 * heartbeat proves the Mac is alive; THIS proves the Claude Desktop drafting
 * routine actually turns owed texts into staged iMessage drafts — the leg that
 * was blind until the run-report callback. The keystone of the copy is the
 * routine's OWN verbatim diagnosis (e.g. "Gmail connector not connected"): one
 * glance names the dark link instead of a 9-hour debug.
 */
function draftingDetail(
  verdict: HealthVerdict,
  ageLabel: string,
  ctx: {
    found: number | null;
    drafted: number | null;
    diagnosis: string | null;
    errors: string[];
  },
): string {
  const { found, drafted, diagnosis, errors } = ctx;
  switch (verdict) {
    case "setup":
      return `Your relay is checking in, but the drafting routine hasn't reported a run yet. Add the one-line report step to the routine (below) so this page can confirm rescue texts are actually being staged in Messages — not silently stuck.`;
    case "broken": {
      // The routine's self-diagnosis is the gold; fall back to the first error,
      // then to the found-vs-staged gap. Always the boundary clause.
      const said =
        (diagnosis && diagnosis.trim()) ||
        (errors.length > 0 ? errors[0] : "") ||
        "";
      const gapClause =
        found != null && found > 0 && (drafted ?? 0) === 0
          ? ` It found ${found} patient${found === 1 ? "" : "s"} owed a text but staged ${drafted ?? 0} drafts.`
          : "";
      if (said) {
        return `The last drafting run reported: “${said}”.${gapClause} Rescue texts won't reach patients until that's fixed in Claude Desktop. ${BOUNDARY}`;
      }
      return `The last drafting run couldn't stage its drafts.${gapClause} Rescue texts won't reach patients until the routine completes in Claude Desktop. ${BOUNDARY}`;
    }
    case "stale":
      return `The drafting routine hasn't reported a run in ${ageLabel} — it may be turned off or erroring in Claude Desktop. New rescue texts won't be staged until it runs again. ${BOUNDARY}`;
    case "healthy":
      if (found != null && found === 0) {
        return `Last run ${ageLabel}: nothing was owed a text, so there was nothing to stage. Drafting is working.`;
      }
      return `Last run ${ageLabel}: staged ${drafted ?? 0} of ${found ?? drafted ?? 0} draft${(found ?? drafted ?? 0) === 1 ? "" : "s"} into Messages. Drafting is working.`;
    default:
      return `Drafting routine status unknown (last run ${ageLabel}).`;
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
  kind: "portal" | "scheduler" | "delivery",
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
      .from("scheduler_connections")
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

    // ── Appointment-FLOW freshness (S3) — the silent feed-stop the pulse hides ──
    // The scheduler rows above score last_sync_at, which the reconcile cron keeps
    // fresh every 2h → a connected calendar reads "Healthy" forever even if no
    // appointment DATA is actually arriving. This adds a distinct per-connected-
    // scheduler row scored on the newest booking's arrival time (appointments
    // .created_at). Only emitted for a CONNECTED scheduler that has EVER received
    // an appointment — we don't invent a flow row for a calendar with none yet
    // (the connection row's setup/healthy state already covers that case).
    const connectedSchedulers = ((schedRows ?? []) as SchedulerRow[]).filter(
      (r) => r.status === "connected",
    );
    const appointmentItems: ConnectionHealthItem[] = (
      await Promise.all(
        connectedSchedulers.map(async (row): Promise<ConnectionHealthItem | null> => {
          const { data: latestApt } = await sb
            .from("appointments")
            .select("created_at")
            .eq("user_id", effectiveUserId)
            .eq("source", row.platform)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const lastEventAtMs = parseTs(
            (latestApt as { created_at: string | null } | null)?.created_at ?? null,
          );
          if (lastEventAtMs == null) return null; // no appointments yet → no flow row
          const name = SCHEDULER_DISPLAY[row.platform] ?? titleCase(row.platform);
          const { verdict, severity } = computeVerdict({
            tier: "realtime",
            connected: true,
            lastEventAtMs,
            nowMs,
          });
          const ageLabel = formatAge(Math.max(0, nowMs - lastEventAtMs));
          return {
            key: `scheduler:${row.platform}:appointments`,
            kind: "scheduler",
            displayName: `${name} appointments`,
            subLabel: "New bookings",
            tier: "realtime",
            tierLabel: "Live · bookings as they're made",
            verdict,
            severity,
            statusLabel: verdictLabel(verdict),
            detail: appointmentDetail(name, verdict, ageLabel),
            lastEventAtMs,
            lastEventLabel: ageLabel,
            cta: {
              label: verdict === "healthy" ? "View calendar" : "Check connection",
              to: CONNECTIONS_ROUTE,
            },
          };
        }),
      )
    ).filter((x): x is ConnectionHealthItem => x !== null);

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

    // ── Outbound delivery — the messages SmartSpa SENDS patients ──
    // The third feed kind, and the first OUTBOUND one. Everything above watches
    // data coming IN (portals, the calendar); this watches the recall / rescue
    // messages going OUT. If sending silently stops (the messaging agent isn't
    // running, an opt-out cascade, delivery failures), the recovery engine goes
    // dark with no error — the same silent failure, on the outbound side.
    //
    // Freshness event = the last successful outbound send per channel
    // (patient_outreach, direction='outbound', sent_at not null). connected is
    // always true (there's no connection row to read — exactly like a portal);
    // freshness + the expect-gate carry the whole signal. The 'delivery' tier
    // never hard-breaks on silence (a quiet week is legitimate), so the worst
    // verdict here is a soft "stale" nudge, never "broken".
    const expectedDelivery = await readExpectedSources(
      sb,
      effectiveUserId,
      "delivery",
    );

    const deliveryChannels = Object.keys(DELIVERY_DISPLAY);
    const lastSentByChannel = new Map<string, number | null>();
    await Promise.all(
      deliveryChannels.map(async (channel) => {
        const { data, error } = await sb
          .from("patient_outreach")
          .select("sent_at")
          .eq("user_id", effectiveUserId)
          .eq("direction", "outbound")
          .eq("channel", channel)
          .not("sent_at", "is", null)
          .order("sent_at", { ascending: false })
          .limit(1);
        // Surface a query failure loudly — a swallowed error here would read as
        // "nothing sent / all quiet", the exact silent absence we're guarding.
        if (error) throw new Error(error.message);
        const ts = parseTs((data?.[0] as { sent_at: string | null } | undefined)?.sent_at ?? null);
        lastSentByChannel.set(channel, ts);
      }),
    );

    // The killer-arch channel — recall/rescue iMessage drafts — writes NO
    // patient_outreach row (that table needs an Emma campaign state). So we also
    // read the messaging_activity heartbeat (v2.11.0), stamped at every outbound
    // dispatch, and take the FRESHER of the two per channel. Without this, an
    // actively-dispatching spa's delivery card reads "no text ever sent."
    // Degrades gracefully (try/catch → empty) so a missing migration can't break
    // the page; the patient_outreach read above stays load-bearing.
    const heartbeatByChannel = new Map<string, number | null>();
    try {
      type Beat = { channel: string; last_activity_at: string | null };
      const { data, error } = await (sb as unknown as { from(t: string): any })
        .from("messaging_activity")
        .select("channel, last_activity_at")
        .eq("user_id", effectiveUserId);
      if (error) throw new Error(error.message);
      for (const b of (data ?? []) as Beat[]) {
        const ch = (b.channel ?? "").toLowerCase();
        if (ch) heartbeatByChannel.set(ch, parseTs(b.last_activity_at));
      }
    } catch (err) {
      console.error(
        "[connection-health] messaging_activity read failed (degrading):",
        err,
      );
    }

    // Freshest outbound event per channel = max(direct send, dispatch beat).
    const lastOutboundByChannel = new Map<string, number | null>();
    for (const channel of deliveryChannels) {
      const a = lastSentByChannel.get(channel) ?? null;
      const b = heartbeatByChannel.get(channel) ?? null;
      const merged = a == null ? b : b == null ? a : Math.max(a, b);
      lastOutboundByChannel.set(channel, merged);
    }

    // Show a channel's card if we've ever sent on it (direct OR dispatch) OR the
    // spa declared they expect it — mirrors the portal union (heard-from ∪ expected).
    const deliveryKeys = new Set<string>([
      ...deliveryChannels.filter((c) => lastOutboundByChannel.get(c) != null),
      ...expectedDelivery.keys(),
    ]);

    const deliveryItems: ConnectionHealthItem[] = [...deliveryKeys].map(
      (channel) => {
        const disp = DELIVERY_DISPLAY[channel] ?? {
          name: titleCase(channel),
          noun: "message",
        };
        const lastEventAtMs = lastOutboundByChannel.get(channel) ?? null;
        const expected = expectedDelivery.get(channel);
        const expectedSinceMs = expected?.expectedSinceMs ?? null;
        const neverSent = lastEventAtMs == null;
        const displayName = expected?.label ?? disp.name;
        const { verdict, severity } = computeVerdict({
          tier: "delivery",
          connected: true, // sent before OR declared expected to send
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
        return {
          key: `delivery:${channel}`,
          kind: "delivery" as const,
          displayName,
          subLabel: "Patient messaging",
          tier: "delivery" as HealthTier,
          tierLabel: tierLabelOf("delivery"),
          verdict,
          severity,
          statusLabel: verdictLabel(verdict),
          detail: deliveryDetail(displayName, disp.noun, verdict, ageLabel, {
            neverSent,
            expectedAgeLabel,
          }),
          lastEventAtMs,
          lastEventLabel: ageLabel,
          cta: {
            label: neverSent
              ? "Set up messaging"
              : needsAction
                ? "Check sending"
                : "View",
            to: RECOVERY_ROUTE,
          },
        };
      },
    );

    // ── Local delivery agent (presence) — the iMessage relay's blind leg ──
    // The rescue loop is autonomous up to the proxy email; the final hop is the
    // owner's Mac (Claude Desktop + iMessage MCP) relaying the text — a leg with
    // ZERO server signal until now. The pinger on that Mac (scripts/local-agent)
    // POSTs /api/agent/heartbeat every ~5 min; we age the last check-in into a
    // Live/Quiet/Silent verdict. Only emitted once a spa has PROVISIONED an
    // agent (a local_agents row) — provisioning IS the "we use this relay"
    // declaration, so no expect-gate is needed. Degrades gracefully (try/catch)
    // so a not-yet-applied migration can't break the trust page.
    const presenceItems: ConnectionHealthItem[] = [];
    try {
      type AgentRow = {
        label: string | null;
        last_seen_at: string | null;
        capabilities: Record<string, unknown> | null;
      };
      const { data, error } = await (sb as unknown as { from(t: string): any })
        .from("local_agents")
        .select("label, last_seen_at, capabilities")
        .eq("user_id", effectiveUserId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const agent = data as AgentRow | null;
      if (agent) {
        const name = agent.label ?? "Local delivery agent";
        const lastEventAtMs = parseTs(agent.last_seen_at);
        const neverSeen = lastEventAtMs == null;
        const freshness = computeVerdict({
          tier: "presence",
          connected: true, // provisioned → it exists; freshness carries the signal
          lastEventAtMs,
          nowMs,
        });
        // A fresh agent that reports a relay-blocking capability as explicitly
        // false is online but USELESS for relaying — override to broken with the
        // specific reason. Absent capability keys = "unknown" → never cry wolf.
        const caps = agent.capabilities ?? {};
        let capReason: string | null = null;
        if (!neverSeen && caps.messages_app === false) {
          capReason = "the Messages app isn't running on that Mac";
        }
        const verdict: HealthVerdict = capReason ? "broken" : freshness.verdict;
        const severity: HealthSeverity = capReason ? "error" : freshness.severity;
        const ageLabel = formatAge(
          lastEventAtMs == null ? null : Math.max(0, nowMs - lastEventAtMs),
        );
        const needsAction = severity === "error" || severity === "warn";
        presenceItems.push({
          key: "presence:local-agent",
          kind: "presence",
          displayName: name,
          subLabel: "iMessage relay",
          tier: "presence",
          tierLabel: tierLabelOf("presence"),
          verdict,
          severity,
          statusLabel: verdictLabel(verdict),
          detail: presenceDetail(name, verdict, ageLabel, { neverSeen, capReason }),
          lastEventAtMs,
          lastEventLabel: ageLabel,
          cta: {
            label: neverSeen ? "Finish setup" : needsAction ? "Reconnect" : "Manage",
            to: HEALTH_ROUTE,
          },
        });

        // ── Drafting in Messages (the second presence row, v2.187.0) ──
        // The heartbeat above proves the Mac is alive; this proves the Claude
        // Desktop drafting routine actually turns owed texts into staged drafts.
        // Only emitted once the agent has checked in at least once (!neverSeen) —
        // a brand-new agent's setup story belongs to the heartbeat card alone, no
        // duplicate "set up" row. Verdict: broken = the routine REPORTED a failure
        // (errors, or found-but-staged-none); stale = it went quiet (age only);
        // setup = checking in but the report step was never added (adoption nudge).
        //
        // The run-report columns are read in their OWN guarded query so a not-yet-
        // applied migration only drops THIS card — the heartbeat card above (which
        // doesn't touch last_run_*) stays load-bearing regardless of deploy order.
        type RunRow = {
          last_run_at: string | null;
          last_run_found: number | null;
          last_run_drafted: number | null;
          last_run_errors: unknown;
          last_run_diagnosis: string | null;
        };
        let runRow: RunRow | null = null;
        try {
          const { data: rData, error: rErr } = await (
            sb as unknown as { from(t: string): any }
          )
            .from("local_agents")
            .select(
              "last_run_at, last_run_found, last_run_drafted, last_run_errors, last_run_diagnosis",
            )
            .eq("user_id", effectiveUserId)
            .maybeSingle();
          if (rErr) throw new Error(rErr.message);
          runRow = rData as RunRow | null;
        } catch (runErr) {
          // Migration not applied yet (columns absent) → skip the drafting card.
          console.error(
            "[connection-health] run-report read failed (skipping drafting card):",
            runErr,
          );
        }

        if (!neverSeen && runRow) {
          const lastRunAtMs = parseTs(runRow.last_run_at);
          const runFound = runRow.last_run_found;
          const runDrafted = runRow.last_run_drafted;
          const runErrors = Array.isArray(runRow.last_run_errors)
            ? (runRow.last_run_errors as unknown[])
                .filter((e): e is string => typeof e === "string")
            : [];
          const runDiagnosis = runRow.last_run_diagnosis;

          let dVerdict: HealthVerdict;
          let dSeverity: HealthSeverity;
          if (lastRunAtMs == null) {
            // Heartbeating, but the run-report callback was never wired in.
            dVerdict = "setup";
            dSeverity = "neutral";
          } else {
            const hasErrors = runErrors.length > 0;
            const gap = (runFound ?? 0) > 0 && (runDrafted ?? 0) === 0;
            const runAgeH = Math.max(0, nowMs - lastRunAtMs) / 3_600_000;
            // 6h of silence from a routine that runs ~hourly → it stopped. We
            // never escalate stale→broken on age alone; the heartbeat card owns
            // "the Mac is offline." Broken here means the routine TOLD us it failed.
            const STALE_RUN_H = 6;
            if (hasErrors || gap) {
              dVerdict = "broken";
              dSeverity = "error";
            } else if (runAgeH > STALE_RUN_H) {
              dVerdict = "stale";
              dSeverity = "warn";
            } else {
              dVerdict = "healthy";
              dSeverity = "ok";
            }
          }

          const runAgeLabel = formatAge(
            lastRunAtMs == null ? null : Math.max(0, nowMs - lastRunAtMs),
          );
          const dNeedsAction = dSeverity === "error" || dSeverity === "warn";
          presenceItems.push({
            key: "presence:drafting",
            kind: "presence",
            displayName: "Drafting in Messages",
            subLabel: "rescue draft routine",
            tier: "presence",
            // Custom tier label — the routine reports per-run, not "every few
            // minutes" like the heartbeat, so don't borrow the presence copy.
            tierLabel: "Drafting routine · reports after each run",
            verdict: dVerdict,
            severity: dSeverity,
            statusLabel: verdictLabel(dVerdict),
            detail: draftingDetail(dVerdict, runAgeLabel, {
              found: runFound,
              drafted: runDrafted,
              diagnosis: runDiagnosis,
              errors: runErrors,
            }),
            lastEventAtMs: lastRunAtMs,
            lastEventLabel: runAgeLabel,
            cta: { label: dNeedsAction ? "How to fix" : "Manage", to: HEALTH_ROUTE },
          });
        }
      }
    } catch (err) {
      console.error(
        "[connection-health] local_agents read failed (degrading):",
        err,
      );
    }

    // Sort worst-first so anything needing attention floats to the top.
    const sevRank: Record<HealthSeverity, number> = {
      error: 0,
      warn: 1,
      neutral: 2,
      ok: 3,
    };
    const items = [
      ...schedulerItems,
      ...appointmentItems,
      ...expectedSchedulerItems,
      ...portalItems,
      ...deliveryItems,
      ...presenceItems,
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
 *  scheduler_connections.platform + SCHEDULER_DISPLAY). Kept to the live
 *  ones — we don't offer to "watch" a platform we can't connect. */
export const EXPECTABLE_SCHEDULERS: ExpectedSourceOption[] = [
  { sourceKey: "acuity", name: "Acuity", subLabel: "Calendar" },
  { sourceKey: "vagaro", name: "Vagaro", subLabel: "Calendar" },
];

/** Outbound channels SmartSpa sends patients on (keys match
 *  patient_outreach.channel). Declaring one lets Connection Health flag it if
 *  sending ever goes quiet — the silent recovery-engine outage. */
export const EXPECTABLE_DELIVERY: ExpectedSourceOption[] = [
  { sourceKey: "sms", name: "Text messages", subLabel: "Patient messaging" },
  { sourceKey: "email", name: "Emails", subLabel: "Patient messaging" },
];

const EXPECTABLE_BY_KIND: Record<string, ExpectedSourceOption[]> = {
  portal: EXPECTABLE_PORTALS,
  scheduler: EXPECTABLE_SCHEDULERS,
  delivery: EXPECTABLE_DELIVERY,
};

export interface ExpectedSourceState extends ExpectedSourceOption {
  kind: "portal" | "scheduler" | "delivery";
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
  kind: z.enum(["portal", "scheduler", "delivery"]),
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
  kind: z.enum(["portal", "scheduler", "delivery"]),
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

// ─── Local delivery agent provisioning (presence tier) ───────────────────────
//
// The spa-facing half of the heartbeat: mint (or read) the per-spa secret the
// pinger on the relay Mac presents, and hand back a ready-to-run install
// command (secret embedded). One row per spa (unique user_id) — provisioning is
// idempotent: calling it twice returns the SAME secret, never rotates it out
// from under a running pinger.

const PUBLIC_ORIGIN =
  process.env.REFILL_PUBLIC_ORIGIN ?? "https://smartspa.app";

function localAgentTbl(sb: ReturnType<typeof admin>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sb as unknown as { from(t: string): any }).from("local_agents");
}

/** 48-hex random token — the same shape as the webhook path-secrets we trust as
 *  the real gate. crypto is a global on Workers + Node 18+. */
function genAgentSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The outbound iMessage sender (queue consumer), base64-encoded. Source of truth:
 *  scripts/local-agent/sender.sh (with __BASE__/__SECRET__ placeholders). Embedded
 *  as base64 so this backslash/quote-heavy script survives being dropped into the
 *  one-paste shell command with zero escaping. Regenerate after editing sender.sh:
 *    base64 -i scripts/local-agent/sender.sh | tr -d '\n'
 *  Decoded on the Mac, then `sed` fills the two placeholders. */
const LOCAL_SENDER_B64 =
  "IyEvYmluL2Jhc2gKIwojIFNtYXJ0U3BhIGxvY2FsIGRlbGl2ZXJ5IGFnZW50IOKAlCBPVVRCT1VORCBpTWVzc2FnZSBzZW5kZXIgKHF1ZXVlIGNvbnN1bWVyKS4KIwojIFRoZSB6ZXJvLXNldHVwIHNlbmRlciAoQnVpbGQgMiwgUGF0aCBCKS4gUnVucyBvbiB0aGUgc3BhJ3Mgb3duIE1hYyBhbG9uZ3NpZGUgdGhlCiMgaGVhcnRiZWF0IHBpbmdlci4gRXZlcnkgfjYwcyBpdCBjbGFpbXMgYW55IHRleHRzIFNtYXJ0U3BhIGhhcyBxdWV1ZWQgZm9yIHRoaXMgc3BhCiMgYW5kIHNlbmRzIGVhY2ggdmlhIE1lc3NhZ2VzLmFwcCDigJQgZnJvbSB0aGUgc3BhJ3Mgb3duIG51bWJlciwgbm8gR21haWwsIG5vIENsYXVkZQojIERlc2t0b3Agcm91dGluZSwgbm8gTUNQLiBTbWFydFNwYSBxdWV1ZXM7IHRoaXMgc2VuZHM7IHRoaXMgYWNrcyB0aGUgb3V0Y29tZS4KIwojIEF1dGggKyBpZGVudGl0eTogdGhlIFNBTUUgcGVyLXNwYSBzZWNyZXQgdGhlIGhlYXJ0YmVhdCB1c2VzICh4LWFnZW50LXNlY3JldCkuCiMgU2VuZCBnYXRlOiBTbWFydFNwYSBvbmx5IGhhbmRzIG91dCBpdGVtcyB3aGVuIHRoZSBzcGEncyBhdXRvX3NlbmQgaXMgT04sIGFuZCB0aGlzCiMgc2NyaXB0IGRvdWJsZS1jaGVja3MgYGF1dG9TZW5kYCBiZWZvcmUgc2VuZGluZyAoYmVsdC1hbmQtc3VzcGVuZGVycyDigJQgbm90aGluZwojIGdvZXMgb3V0IHVubGVzcyBhdXRvLXNlbmQgaXMgZXhwbGljaXRseSBlbmFibGVkKS4KIwojIFBlcm1pc3Npb24gbm90ZTogdGhlIEZJUlNUIHNlbmQgdHJpZ2dlcnMgYSBtYWNPUyBBdXRvbWF0aW9uIHByb21wdAojIChTeXN0ZW0gU2V0dGluZ3Mg4oaSIFByaXZhY3kgJiBTZWN1cml0eSDihpIgQXV0b21hdGlvbiDihpIgYWxsb3cgY29udHJvbGxpbmcgTWVzc2FnZXMpLgojIFVudGlsIGdyYW50ZWQsIHNlbmRzIGZhaWwgYW5kIGFyZSBhY2tlZCBhcyBmYWlsZWQgd2l0aCB0aGF0IHJlYXNvbi4KIwojIF9fQkFTRV9fIGFuZCBfX1NFQ1JFVF9fIGFyZSBmaWxsZWQgaW4gYnkgdGhlIGluc3RhbGxlciAoaW5zdGFsbC5zaCAvCiMgdGhlIGFwcCdzIG9uZS1wYXN0ZSBjb21tYW5kKS4gRG9uJ3QgcnVuIHRoaXMgdGVtcGxhdGUgZGlyZWN0bHkuCgpCQVNFPSJfX0JBU0VfXyIKU0VDUkVUPSJfX1NFQ1JFVF9fIgoKIyAxKSBDbGFpbSB1cCB0byA1IHF1ZXVlZCB0ZXh0cyBmb3IgdGhpcyBzcGEuIC1mc1M6IHF1aWV0LCBidXQgZmFpbCBvbiBIVFRQIGVycm9yLgpSRVNQPSQoY3VybCAtZnNTIC1tIDIwIC1YIFBPU1QgIiRCQVNFL2FwaS9hZ2VudC9xdWV1ZS9jbGFpbSIgXAogIC1IICJ4LWFnZW50LXNlY3JldDogJFNFQ1JFVCIgLUggIkNvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbiIgXAogIC1kICd7ImxpbWl0Ijo1fScgMj4vZGV2L251bGwpIHx8IGV4aXQgMApbIC16ICIkUkVTUCIgXSAmJiBleGl0IDAKCiMgMikgRmxhdHRlbiB0aGUgY2xhaW1lZCBpdGVtcyB0byBUU1YgdmlhIEpYQSAob3Nhc2NyaXB0IHNoaXBzIG9uIGV2ZXJ5IE1hYywgcGFyc2VzCiMgICAgSlNPTiBuYXRpdmVseSkuIEVtaXRzIE5PVEhJTkcgdW5sZXNzIGF1dG9TZW5kPT09dHJ1ZS4gRWFjaCBsaW5lOgojICAgIGlkIDxUQUI+IHJlY2lwaWVudCA8VEFCPiBjbGFpbVRva2VuIDxUQUI+IGJvZHkgKHRhYnPihpJzcGFjZXMsIG5ld2xpbmVz4oaSXG4sCiMgICAgYmFja3NsYXNoZXMgZXNjYXBlZCkg4oCUIHNvIG9uZSBpdGVtIGlzIGV4YWN0bHkgb25lIHNhZmUgbGluZS4KTElORVM9JCgvdXNyL2Jpbi9vc2FzY3JpcHQgLWwgSmF2YVNjcmlwdCAtZSAnZnVuY3Rpb24gcnVuKGEpe3ZhciBkO3RyeXtkPUpTT04ucGFyc2UoYVswXSl9Y2F0Y2goZSl7cmV0dXJuICIifWlmKGQuYXV0b1NlbmQhPT10cnVlKXJldHVybiAiIjtyZXR1cm4gKGQuaXRlbXN8fFtdKS5tYXAoZnVuY3Rpb24oaXQpe3ZhciBiPVN0cmluZyhpdC5ib2R5KS5yZXBsYWNlKC9cXC9nLCJcXFxcIikucmVwbGFjZSgvXHQvZywiICIpLnJlcGxhY2UoL1xyP1xuL2csIlxcbiIpO3JldHVybiBbaXQuaWQsaXQucmVjaXBpZW50LGQuY2xhaW1Ub2tlbixiXS5qb2luKCJcdCIpfSkuam9pbigiXG4iKX0nICIkUkVTUCIgMj4vZGV2L251bGwpIHx8IGV4aXQgMApbIC16ICIkTElORVMiIF0gJiYgZXhpdCAwCgojIDMpIFNlbmQgZWFjaCB2aWEgTWVzc2FnZXMuYXBwLCB0aGVuIGFjayB0aGUgb3V0Y29tZS4KT0xESUZTPSIkSUZTIgpJRlM9JCdcbicKZm9yIGxpbmUgaW4gJExJTkVTOyBkbwogIElEPSQocHJpbnRmICclcycgIiRsaW5lIiB8IGN1dCAtZjEpCiAgUEhPTkU9JChwcmludGYgJyVzJyAiJGxpbmUiIHwgY3V0IC1mMikKICBUT0tFTj0kKHByaW50ZiAnJXMnICIkbGluZSIgfCBjdXQgLWYzKQogIEJPRFk9JChwcmludGYgJyViJyAiJChwcmludGYgJyVzJyAiJGxpbmUiIHwgY3V0IC1mNC0pIikgICMgJWIgdW4tZXNjYXBlcyBcbiBhbmQgXFwKCiAgU1RBVFVTPSJzZW50IgogIEVSUj0iIgogIGlmIC91c3IvYmluL29zYXNjcmlwdCAtICIkUEhPTkUiICIkQk9EWSIgPi9kZXYvbnVsbCAyPiYxIDw8J0FQUExFU0NSSVBUJwpvbiBydW4gYXJndgogIHNldCB0YXJnZXRQaG9uZSB0byBpdGVtIDEgb2YgYXJndgogIHNldCB0YXJnZXRNZXNzYWdlIHRvIGl0ZW0gMiBvZiBhcmd2CiAgdGVsbCBhcHBsaWNhdGlvbiAiTWVzc2FnZXMiCiAgICBzZXQgdGFyZ2V0U2VydmljZSB0byAxc3QgYWNjb3VudCB3aG9zZSBzZXJ2aWNlIHR5cGUgPSBpTWVzc2FnZQogICAgc2V0IHRhcmdldFBhcnRpY2lwYW50IHRvIHBhcnRpY2lwYW50IHRhcmdldFBob25lIG9mIHRhcmdldFNlcnZpY2UKICAgIHNlbmQgdGFyZ2V0TWVzc2FnZSB0byB0YXJnZXRQYXJ0aWNpcGFudAogIGVuZCB0ZWxsCmVuZCBydW4KQVBQTEVTQ1JJUFQKICB0aGVuCiAgICBTVEFUVVM9InNlbnQiCiAgZWxzZQogICAgU1RBVFVTPSJmYWlsZWQiCiAgICBFUlI9Ik1lc3NhZ2VzIHNlbmQgZmFpbGVkIChncmFudCBBdXRvbWF0aW9uIHBlcm1pc3Npb24gZm9yIE1lc3NhZ2VzLCBvciBjaGVjayB0aGUgbnVtYmVyKSIKICBmaQoKICAjIEFjayDigJQgdGhlIGNsYWltVG9rZW4gcHJvdmVzIHRoaXMgbGVhc2UgaXMgb3VyczsgU21hcnRTcGEgNDA5cyBhIHN0YWxlL2ZvcmVpZ24KICAjIGFjay4gaWQvdG9rZW4gYXJlIFVVSURzIGFuZCBFUlIgaXMgYSBmaXhlZCBzdHJpbmcsIHNvIHRoaXMgSlNPTiBpcyBhbHdheXMgc2FmZS4KICBjdXJsIC1mc1MgLW0gMjAgLVggUE9TVCAiJEJBU0UvYXBpL2FnZW50L3F1ZXVlL2FjayIgXAogICAgLUggIngtYWdlbnQtc2VjcmV0OiAkU0VDUkVUIiAtSCAiQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9qc29uIiBcCiAgICAtZCAie1wiaWRcIjpcIiRJRFwiLFwiY2xhaW1Ub2tlblwiOlwiJFRPS0VOXCIsXCJzdGF0dXNcIjpcIiRTVEFUVVNcIixcImVycm9yXCI6XCIkRVJSXCJ9IiBcCiAgICA+L2Rldi9udWxsIDI+JjEgfHwgdHJ1ZQpkb25lCklGUz0iJE9MRElGUyIK";

/** The self-contained installer the owner runs ON THE RELAY MAC. Writes the tiny
 *  heartbeat pinger (every 5 min) AND the outbound iMessage sender (every 60s) +
 *  their launchd jobs, then starts them. Secret is embedded so it's a single
 *  copy-paste with nothing else to fill in. Mirrors scripts/local-agent/install.sh
 *  (the committed source of truth). */
function buildInstallCommand(secret: string): string {
  const endpoint = `${PUBLIC_ORIGIN}/api/agent/heartbeat`;
  const base = PUBLIC_ORIGIN;
  return `mkdir -p ~/.smartspa && cat > ~/.smartspa/pinger.sh <<'PINGER'
#!/bin/bash
# SmartSpa local delivery agent — heartbeat pinger
ENDPOINT="${endpoint}"
SECRET="${secret}"
MSG=false; pgrep -x Messages >/dev/null 2>&1 && MSG=true
curl -fsS -m 15 -X POST "$ENDPOINT" \\
  -H "x-agent-secret: $SECRET" -H "Content-Type: application/json" \\
  -d "{\\"version\\":\\"pinger-1.0\\",\\"status\\":\\"ok\\",\\"capabilities\\":{\\"messages_app\\":$MSG}}" >/dev/null 2>&1
PINGER
chmod +x ~/.smartspa/pinger.sh && cat > ~/Library/LaunchAgents/com.smartspa.localagent.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.smartspa.localagent</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HOME/.smartspa/pinger.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
launchctl unload ~/Library/LaunchAgents/com.smartspa.localagent.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.smartspa.localagent.plist && bash ~/.smartspa/pinger.sh && echo "${LOCAL_SENDER_B64}" | base64 -d > ~/.smartspa/sender.sh && sed -i '' "s|__BASE__|${base}|g; s|__SECRET__|${secret}|g" ~/.smartspa/sender.sh && chmod +x ~/.smartspa/sender.sh && cat > ~/Library/LaunchAgents/com.smartspa.sender.plist <<PLIST2
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.smartspa.sender</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HOME/.smartspa/sender.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST2
launchctl unload ~/Library/LaunchAgents/com.smartspa.sender.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.smartspa.sender.plist && echo "SmartSpa local agent installed: heartbeat + outbound iMessage sender are live."`;
}

export interface LocalAgentInfo {
  provisioned: boolean;
  secret: string | null;
  label: string | null;
  lastSeenAtMs: number | null;
  endpoint: string;
  installCommand: string | null;
  // Delivery config (v2.193.0 — the in-app toggles). Optional: only the readers
  // that select them populate these; provision/rotate omit them (the UI re-reads
  // via getLocalAgentFn). 'email' = owner-draft lane; 'queue' = autonomous send.
  deliveryMode?: "email" | "queue";
  autoSend?: boolean;
  testRecipients?: string[];
}

const localAgentSchema = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().optional(),
});

/** UI: read the spa's local agent (if any) — secret + last check-in + the
 *  ready-to-run installer. Returns provisioned:false when none exists yet. */
export const getLocalAgentFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => localAgentSchema.parse(raw))
  .handler(async ({ data }): Promise<LocalAgentInfo> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const endpoint = `${PUBLIC_ORIGIN}/api/agent/heartbeat`;
    const { data: row, error } = await localAgentTbl(sb)
      .select("secret, label, last_seen_at, delivery_mode, auto_send, test_recipients")
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) {
      return {
        provisioned: false,
        secret: null,
        label: null,
        lastSeenAtMs: null,
        endpoint,
        installCommand: null,
        deliveryMode: "email",
        autoSend: false,
        testRecipients: [],
      };
    }
    const r = row as {
      secret: string;
      label: string | null;
      last_seen_at: string | null;
      delivery_mode: string | null;
      auto_send: boolean | null;
      test_recipients: unknown;
    };
    return {
      provisioned: true,
      secret: r.secret,
      label: r.label,
      lastSeenAtMs: parseTs(r.last_seen_at),
      endpoint,
      installCommand: buildInstallCommand(r.secret),
      deliveryMode: r.delivery_mode === "queue" ? "queue" : "email",
      autoSend: r.auto_send === true,
      testRecipients: coerceTestRecipients(r.test_recipients),
    };
  });

/** Coerce a jsonb/text[] test_recipients value to a clean string[]. */
function coerceTestRecipients(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const provisionLocalAgentSchema = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().optional(),
  label: z.string().max(80).optional(),
});

/** UI: get-or-create the spa's local agent. Idempotent — never rotates an
 *  existing secret (a running pinger keeps working). Returns the installer. */
export const provisionLocalAgentFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => provisionLocalAgentSchema.parse(raw))
  .handler(async ({ data }): Promise<LocalAgentInfo> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const endpoint = `${PUBLIC_ORIGIN}/api/agent/heartbeat`;

    const { data: existing, error: readErr } = await localAgentTbl(sb)
      .select("secret, label, last_seen_at")
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (existing) {
      const e = existing as {
        secret: string;
        label: string | null;
        last_seen_at: string | null;
      };
      // Allow setting/updating a friendly label without rotating the secret.
      if (data.label && data.label !== e.label) {
        await localAgentTbl(sb)
          .update({ label: data.label, updated_at: new Date().toISOString() })
          .eq("user_id", effectiveUserId);
      }
      return {
        provisioned: true,
        secret: e.secret,
        label: data.label ?? e.label,
        lastSeenAtMs: parseTs(e.last_seen_at),
        endpoint,
        installCommand: buildInstallCommand(e.secret),
      };
    }

    const secret = genAgentSecret();
    const nowIso = new Date().toISOString();
    const { error: insErr } = await localAgentTbl(sb).insert({
      user_id: effectiveUserId,
      secret,
      label: data.label ?? null,
      capabilities: {},
      created_at: nowIso,
      updated_at: nowIso,
    });
    if (insErr) throw new Error(insErr.message);
    return {
      provisioned: true,
      secret,
      label: data.label ?? null,
      lastSeenAtMs: null,
      endpoint,
      installCommand: buildInstallCommand(secret),
    };
  });

/** UI: rotate the spa's agent secret. The OLD secret stops working immediately
 *  (any pinger still using it 401s until re-installed), so this returns the new
 *  install command to re-run on the relay Mac. Use after a leak (e.g. a secret
 *  caught in a screenshot). The new value is returned to the IN-APP card only —
 *  it never needs to travel through chat/support. */
export const rotateLocalAgentSecretFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => localAgentSchema.parse(raw))
  .handler(async ({ data }): Promise<LocalAgentInfo> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const endpoint = `${PUBLIC_ORIGIN}/api/agent/heartbeat`;
    const secret = genAgentSecret();
    const { data: row, error } = await localAgentTbl(sb)
      .update({ secret, updated_at: new Date().toISOString() })
      .eq("user_id", effectiveUserId)
      .select("secret, label, last_seen_at")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("No local agent to rotate — set one up first.");
    const r = row as { secret: string; label: string | null; last_seen_at: string | null };
    return {
      provisioned: true,
      secret: r.secret,
      label: r.label,
      lastSeenAtMs: parseTs(r.last_seen_at),
      endpoint,
      installCommand: buildInstallCommand(r.secret),
    };
  });

const updateLocalAgentSettingsSchema = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().optional(),
  deliveryMode: z.enum(["email", "queue"]).optional(),
  autoSend: z.boolean().optional(),
  testRecipients: z.array(z.string()).max(50).optional(),
});

/** UI: update the spa's delivery settings (v2.193.0) — the in-app controls that
 *  replace hand-editing local_agents in SQL. deliveryMode picks the lane (email
 *  draft vs autonomous queue); autoSend is the queue's send/stage interlock;
 *  testRecipients is the safe-testing allowlist (normalized to E.164, deduped).
 *  Only the provided fields are written; returns the fresh full agent info. */
export const updateLocalAgentSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateLocalAgentSettingsSchema.parse(raw))
  .handler(async ({ data }): Promise<LocalAgentInfo> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const endpoint = `${PUBLIC_ORIGIN}/api/agent/heartbeat`;

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.deliveryMode) patch.delivery_mode = data.deliveryMode;
    if (typeof data.autoSend === "boolean") patch.auto_send = data.autoSend;
    if (data.testRecipients) {
      // Normalize each to E.164 (so the owner can type "3037046530") and dedupe;
      // drop anything that isn't a usable number rather than store junk.
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of data.testRecipients) {
        const e164 = normalizePhoneE164(raw);
        if (e164 && !seen.has(e164)) {
          seen.add(e164);
          cleaned.push(e164);
        }
      }
      patch.test_recipients = cleaned;
    }

    const { data: row, error } = await localAgentTbl(sb)
      .update(patch)
      .eq("user_id", effectiveUserId)
      .select("secret, label, last_seen_at, delivery_mode, auto_send, test_recipients")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("No local agent to update — set one up first.");
    const r = row as {
      secret: string;
      label: string | null;
      last_seen_at: string | null;
      delivery_mode: string | null;
      auto_send: boolean | null;
      test_recipients: unknown;
    };
    return {
      provisioned: true,
      secret: r.secret,
      label: r.label,
      lastSeenAtMs: parseTs(r.last_seen_at),
      endpoint,
      installCommand: buildInstallCommand(r.secret),
      deliveryMode: r.delivery_mode === "queue" ? "queue" : "email",
      autoSend: r.auto_send === true,
      testRecipients: coerceTestRecipients(r.test_recipients),
    };
  });
