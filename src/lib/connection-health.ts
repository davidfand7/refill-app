/**
 * connection-health.ts — the pure heart of the Connection Health spine.
 *
 * THE DOCTRINE (feedback_connection_health_doctrine, 2026-06-11): SmartSpa
 * can run perfectly while the third-party CONNECTION/ACCESS layer we don't
 * control fails — a token gets revoked, a webhook silently stops, a CSV
 * mirror goes stale, a portal login breaks. Unguarded, every one of those
 * reads to the spa as "SmartSpa is broken." The cure is to surface the
 * truth: prove WHERE the break is, and always offer the next step.
 *
 * The worst failure mode is SILENCE — not an error, an *absence*. A feed
 * that just stops reporting throws nothing. The only thing that catches it
 * is a freshness check: compare the last successful data event against the
 * cadence we expect for that connection's access tier. That comparison is
 * what lives here.
 *
 * HONESTY PER TIER is non-negotiable: we must never imply a snapshot is
 * live. Three tiers, three freshness contracts:
 *   - realtime — full API + webhooks (e.g. Acuity). Events arrive as they
 *       happen, so silence is OFTEN legitimate (a quiet calendar). We only
 *       soft-flag after a long gap; status is the primary signal.
 *   - poll — API key or scheduled pull (e.g. Vagaro key, the daily reward
 *       portal pulls). A known cadence, so a missed cycle IS a real signal.
 *   - snapshot — CSV-only / manual import. A point-in-time photo that ages
 *       the instant it lands. Never "broken" by age; we show "as of <when>"
 *       and nudge a refresh.
 *
 * This module is PURE: no DB, no React, no I/O, no clock of its own (the
 * caller passes `nowMs`). That keeps it trivially testable and free of the
 * timezone/DST traps that have bitten us before (feedback_db_timestamp_calendar_z).
 */

export type HealthTier = "realtime" | "poll" | "snapshot";

export type HealthVerdict =
  | "healthy" // connected + fresh within tier contract
  | "stale" // connected but we haven't heard in longer than expected
  | "broken" // hard failure: auth error, reconnect required
  | "setup" // configured/connecting, no successful data yet
  | "unconfigured"; // nothing connected at all

/** UI severity bucket — drives pill color + sort order. */
export type HealthSeverity = "ok" | "warn" | "error" | "neutral";

export interface TierThresholds {
  /** Older than this (hours) → "stale" (warn). */
  staleAfterH: number;
  /** Older than this (hours) → "broken" (error). null = age never escalates
   *  to broken (snapshots age but are never a hard failure). */
  brokenAfterH: number | null;
}

/**
 * Sensible defaults per tier. The server may override per-item (e.g. a
 * specific platform's poll cadence) — these are the floor.
 *
 * realtime: webhooks fire on change, so a calendar with no recent
 *   bookings legitimately goes quiet. We only soft-flag after a full week
 *   and NEVER escalate to broken on silence alone — status carries the
 *   real auth-failure signal. Hedge honestly, don't cry wolf.
 * poll: a daily/periodic cadence. One missed daily cycle + buffer ≈ 36h
 *   → stale; ~3 missed days → broken (something is genuinely wrong).
 * snapshot: ages forever; ~2 weeks → a gentle "refresh me" nudge, never broken.
 */
export const TIER_DEFAULTS: Record<HealthTier, TierThresholds> = {
  realtime: { staleAfterH: 24 * 7, brokenAfterH: null },
  poll: { staleAfterH: 36, brokenAfterH: 72 },
  snapshot: { staleAfterH: 24 * 14, brokenAfterH: null },
};

export interface VerdictInput {
  tier: HealthTier;
  /** Is there an active connection / credential at all? */
  connected: boolean;
  /** Hard failure surfaced by the platform (auth error / reauth needed). */
  errored?: boolean;
  /** Connection handshake in progress, no data yet. */
  pending?: boolean;
  /** Epoch ms of the last SUCCESSFUL data event (sync / import / webhook).
   *  null = connected but nothing has arrived yet. */
  lastEventAtMs: number | null;
  /** Caller-supplied clock (epoch ms). Passed in so this stays pure. */
  nowMs: number;
  /** Per-item override of the tier defaults. */
  thresholds?: Partial<TierThresholds>;
}

export interface VerdictResult {
  verdict: HealthVerdict;
  severity: HealthSeverity;
  /** Age of the last event in ms, or null if there's never been one. */
  ageMs: number | null;
}

const SEVERITY_OF: Record<HealthVerdict, HealthSeverity> = {
  healthy: "ok",
  stale: "warn",
  broken: "error",
  setup: "neutral",
  unconfigured: "neutral",
};

/**
 * The single decision function. Order matters: a hard error always wins,
 * then setup states, then freshness. Silence (a stale/old lastEventAtMs)
 * is only reachable once we know the connection is live and not errored —
 * which is exactly the case the spa would otherwise misread as "SmartSpa
 * stopped working."
 */
export function computeVerdict(input: VerdictInput): VerdictResult {
  const { tier, connected, errored, pending, lastEventAtMs, nowMs } = input;
  const t: TierThresholds = {
    ...TIER_DEFAULTS[tier],
    ...(input.thresholds ?? {}),
  };

  const ageMs = lastEventAtMs == null ? null : Math.max(0, nowMs - lastEventAtMs);

  if (errored) return { verdict: "broken", severity: SEVERITY_OF.broken, ageMs };
  if (pending) return { verdict: "setup", severity: SEVERITY_OF.setup, ageMs };
  if (!connected)
    return { verdict: "unconfigured", severity: SEVERITY_OF.unconfigured, ageMs };

  // Connected but no data has ever arrived → still standing up, not a failure.
  if (ageMs == null) return { verdict: "setup", severity: SEVERITY_OF.setup, ageMs };

  const ageH = ageMs / 3_600_000;
  if (t.brokenAfterH != null && ageH > t.brokenAfterH)
    return { verdict: "broken", severity: SEVERITY_OF.broken, ageMs };
  if (ageH > t.staleAfterH)
    return { verdict: "stale", severity: SEVERITY_OF.stale, ageMs };
  return { verdict: "healthy", severity: SEVERITY_OF.healthy, ageMs };
}

/** Human-readable relative age. Pure; no locale/timezone dependence. */
export function formatAge(ms: number | null): string {
  if (ms == null) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}

/** Short pill label per verdict (UI). */
export function verdictLabel(verdict: HealthVerdict): string {
  switch (verdict) {
    case "healthy":
      return "Healthy";
    case "stale":
      return "Stale";
    case "broken":
      return "Needs attention";
    case "setup":
      return "Setting up";
    case "unconfigured":
      return "Not connected";
  }
}

/** Human label for the access tier — used to set freshness expectations
 *  honestly in the UI (so a snapshot never reads as "live"). */
export function tierLabel(tier: HealthTier): string {
  switch (tier) {
    case "realtime":
      return "Live · syncs as it happens";
    case "poll":
      return "Scheduled · pulled on a cadence";
    case "snapshot":
      return "Snapshot · refreshed on import";
  }
}
