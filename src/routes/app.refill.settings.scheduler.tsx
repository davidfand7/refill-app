/**
 * /app/refill/settings/scheduler — Scheduler integration wizard (v381).
 *
 * The ONE button that closes the live-sync gap: "Connect Acuity."
 *
 * Design principle (see [[feedback-setup-wizards-auto-advance]]): every
 * config step is a customer-loss risk. This page has exactly ONE button
 * — Connect. The user clicks, gets redirected through Acuity's OAuth
 * flow, lands back here with a green "Connected" status. No API keys
 * to find, no webhook URLs to configure, no fields to fill in.
 *
 * Once connected, status flips to "Connected · syncing live" and shows
 * the connected Acuity account email + last-sync timestamp + a
 * Disconnect button. Disconnect tears down the four webhook
 * subscriptions on the Acuity side so we don't keep firing on a spa
 * who explicitly opted out.
 *
 * Currently Acuity-only. Mindbody, JaneApp, Square, Boulevard slot
 * in as future ships using the same [Connect <platform>] pattern —
 * one row per supported platform in the Available section.
 */

import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  Plug,
  RefreshCw,
  XCircle,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  initiateAcuityOAuth,
  initiateSquareOAuth,
  initiateBoulevardOAuth,
  initiateMindbodyOAuth,
  initiateVagaroConnect,
  initiateBookerConnect,
  initiateJaneOAuth,
  initiateZenotiConnect,
  getSchedulerConnection,
  disconnectScheduler,
  resyncSchedulerConnection,
  type SchedulerConnection,
} from "@/server/emma-scheduler.functions";
import {
  getSchedulerExtras,
  type LightModePlatform,
} from "@/server/light-mode.functions";
import { useShell } from "@/lib/shell";
import { cn } from "@/lib/utils";

type SearchParams = {
  scheduler_connected?: string;
  scheduler_error?: string;
};

export const Route = createFileRoute("/app/refill/settings/scheduler")({
  validateSearch: (raw: Record<string, unknown>): SearchParams => ({
    scheduler_connected:
      typeof raw.scheduler_connected === "string" ? raw.scheduler_connected : undefined,
    scheduler_error:
      typeof raw.scheduler_error === "string" ? raw.scheduler_error : undefined,
  }),
  component: SchedulerSettingsPage,
});

function SchedulerSettingsPage() {
  const search = useSearch({ from: "/app/refill/settings/scheduler" });
  const navigate = useNavigate();
  // v411.5 — brand-aware constants. emma.agentiport.com renders "Emma(OS) ·
  // Settings" + "Emma knows..."; app.getrefill.app renders "Refill · Settings"
  // + "Refill knows...". Both surfaces share the same Acuity connection flow.
  const shell = useShell();
  const isRefill = shell === "refill";
  const brandHeader = isRefill ? "Refill" : "Emma(OS)";
  const brandName = isRefill ? "Refill" : "Emma";

  const [connection, setConnection] = useState<SchedulerConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v1.42.0 — Light Mode + Plaid Mode availability. Light Mode is
  // universally available; Plaid Mode is per-tenant flag-gated.
  const [schedulerExtras, setSchedulerExtras] = useState<{
    lightMode: boolean;
    plaidMode: boolean;
  }>({ lightMode: true, plaidMode: false });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setError("Please sign in.");
        return;
      }
      const c = await getSchedulerConnection({ data: { accessToken: token } });
      setConnection(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // v1.42.0 — Load Light Mode + Plaid Mode availability for this spa.
  // Light Mode is universally on; Plaid Mode is per-tenant flag-gated
  // via /app/admin/agents → plaid_mode_enabled feature flag.
  useEffect(() => {
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const extras = await getSchedulerExtras({
          data: { accessToken: token },
        });
        setSchedulerExtras(extras);
      } catch {
        // Soft-fail — extras default to { lightMode: true, plaidMode: false }.
      }
    })();
  }, []);

  // Surface OAuth round-trip outcomes as toasts + clean the URL.
  useEffect(() => {
    if (search.scheduler_connected) {
      toast.success(
        `${platformLabel(search.scheduler_connected)} connected — syncing live.`,
      );
      void navigate({
        to: "/app/refill/settings/scheduler",
        search: {},
        replace: true,
      });
    }
    if (search.scheduler_error) {
      toast.error(
        `Connection failed: ${humanizeError(search.scheduler_error)}`,
      );
      void navigate({
        to: "/app/refill/settings/scheduler",
        search: {},
        replace: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.scheduler_connected, search.scheduler_error]);

  const connectAcuity = useCallback(async () => {
    setConnecting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        setConnecting(false);
        return;
      }
      const { redirectUrl } = await initiateAcuityOAuth({
        data: {
          accessToken: token,
          origin: window.location.origin,
          returnTo: "/app/refill/settings/scheduler",
        },
      });
      // Send the user to Acuity's authorize page. They come back via
      // /api/integrations/acuity/oauth-callback which redirects here
      // with ?scheduler_connected=acuity.
      window.location.href = redirectUrl;
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't start the Acuity connect flow.",
      );
      setConnecting(false);
    }
  }, []);

  const connectSquare = useCallback(async () => {
    setConnecting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        setConnecting(false);
        return;
      }
      const { redirectUrl } = await initiateSquareOAuth({
        data: {
          accessToken: token,
          origin: window.location.origin,
          returnTo: "/app/refill/settings/scheduler",
        },
      });
      window.location.href = redirectUrl;
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't start the Square connect flow.",
      );
      setConnecting(false);
    }
  }, []);

  const connectBoulevard = useCallback(async () => {
    setConnecting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        setConnecting(false);
        return;
      }
      const { redirectUrl } = await initiateBoulevardOAuth({
        data: {
          accessToken: token,
          origin: window.location.origin,
          returnTo: "/app/refill/settings/scheduler",
        },
      });
      window.location.href = redirectUrl;
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : "Couldn't start the Boulevard connect flow.",
      );
      setConnecting(false);
    }
  }, []);

  const connectZenoti = useCallback(async () => {
    setConnecting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        setConnecting(false);
        return;
      }
      const { redirectUrl } = await initiateZenotiConnect({
        data: {
          accessToken: token,
          origin: window.location.origin,
          returnTo: "/app/refill/settings/scheduler",
        },
      });
      window.location.href = redirectUrl;
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't start the Zenoti connect flow.",
      );
      setConnecting(false);
    }
  }, []);

  const connectJane = useCallback(async () => {
    setConnecting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        setConnecting(false);
        return;
      }
      const { redirectUrl } = await initiateJaneOAuth({
        data: {
          accessToken: token,
          origin: window.location.origin,
          returnTo: "/app/refill/settings/scheduler",
        },
      });
      window.location.href = redirectUrl;
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't start the Jane connect flow.",
      );
      setConnecting(false);
    }
  }, []);

  const connectBooker = useCallback(async () => {
    setConnecting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        setConnecting(false);
        return;
      }
      const { redirectUrl } = await initiateBookerConnect({
        data: {
          accessToken: token,
          origin: window.location.origin,
          returnTo: "/app/refill/settings/scheduler",
        },
      });
      window.location.href = redirectUrl;
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't start the Booker connect flow.",
      );
      setConnecting(false);
    }
  }, []);

  const connectVagaro = useCallback(async () => {
    setConnecting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        setConnecting(false);
        return;
      }
      const { redirectUrl } = await initiateVagaroConnect({
        data: {
          accessToken: token,
          origin: window.location.origin,
          returnTo: "/app/refill/settings/scheduler",
        },
      });
      window.location.href = redirectUrl;
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : "Couldn't start the Vagaro connect flow.",
      );
      setConnecting(false);
    }
  }, []);

  const connectMindbody = useCallback(async () => {
    setConnecting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        setConnecting(false);
        return;
      }
      const { redirectUrl } = await initiateMindbodyOAuth({
        data: {
          accessToken: token,
          origin: window.location.origin,
          returnTo: "/app/refill/settings/scheduler",
        },
      });
      window.location.href = redirectUrl;
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : "Couldn't start the Mindbody connect flow.",
      );
      setConnecting(false);
    }
  }, []);

  const handleResync = useCallback(async () => {
    setResyncing(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        setResyncing(false);
        return;
      }
      const { totalAppointments, resolvedPatientNames } =
        await resyncSchedulerConnection({ data: { accessToken: token } });
      const matchedPct =
        totalAppointments > 0
          ? Math.round((resolvedPatientNames / totalAppointments) * 100)
          : 0;
      toast.success(
        `Re-synced ${totalAppointments} appointment${totalAppointments === 1 ? "" : "s"} · ${resolvedPatientNames} patient name${resolvedPatientNames === 1 ? "" : "s"} matched (${matchedPct}%).`,
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't re-sync.");
    } finally {
      setResyncing(false);
    }
  }, [load]);

  const handleDisconnect = useCallback(async () => {
    // v1.35.9: platform-aware confirm dialog (was hardcoded to Acuity).
    const platformName = connection
      ? platformLabel(connection.platform)
      : "this scheduler";
    if (!confirm(`Disconnect ${platformName}? ${brandName} will stop receiving real-time appointment updates from your scheduler.`)) {
      return;
    }
    setDisconnecting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        setDisconnecting(false);
        return;
      }
      const { webhooksRemoved } = await disconnectScheduler({
        data: {
          accessToken: token,
          origin: window.location.origin,
        },
      });
      toast.success(
        webhooksRemoved > 0
          ? `Disconnected · removed ${webhooksRemoved} webhook${webhooksRemoved === 1 ? "" : "s"} from ${platformName}`
          : "Disconnected.",
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }, [load]);

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8">
      <PageHeader
        eyebrow={`${brandHeader} · Settings`}
        title="Scheduler integration"
        description={`Connect your scheduling platform so ${brandName} knows the moment an appointment cancels or no-shows — no CSV uploads, no manual flips.`}
      />

      {loading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : error ? (
        <div className="mt-8 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : connection && connection.status !== "disconnected" ? (
        <ConnectedCard
          connection={connection}
          onDisconnect={handleDisconnect}
          disconnecting={disconnecting}
          onResync={handleResync}
          resyncing={resyncing}
        />
      ) : (
        <AvailablePlatforms
          onConnectAcuity={connectAcuity}
          onConnectSquare={connectSquare}
          onConnectBoulevard={connectBoulevard}
          onConnectMindbody={connectMindbody}
          onConnectVagaro={connectVagaro}
          onConnectBooker={connectBooker}
          onConnectJane={connectJane}
          onConnectZenoti={connectZenoti}
          schedulerExtras={schedulerExtras}
          onConnectLightMode={(platform) =>
            void navigate({
              to: "/app/refill/settings/light-mode",
              search: { platform },
            })
          }
          onConnectPlaid={(platform) =>
            toast.info(
              `Plaid Connect (Pro) for ${platformLabel(
                platform,
              )} — concierge setup. We'll reach out to confirm consent.`,
            )
          }
          connecting={connecting}
        />
      )}

      <HowItWorks brandName={brandName} />
    </div>
  );
}

function ConnectedCard({
  connection,
  onDisconnect,
  disconnecting,
  onResync,
  resyncing,
}: {
  connection: SchedulerConnection;
  onDisconnect: () => void;
  disconnecting: boolean;
  onResync: () => void;
  resyncing: boolean;
}) {
  const isConnected = connection.status === "connected";
  const isError = connection.status === "error" || connection.status === "reauth_needed";
  const isPending = connection.status === "pending";

  return (
    <div className="mt-6 rounded-lg border border-border bg-card overflow-hidden">
      <div
        className={cn(
          "px-5 py-4 flex items-center gap-3",
          isConnected && "bg-emerald-500/5 border-b border-emerald-500/20",
          isError && "bg-destructive/5 border-b border-destructive/20",
          isPending && "bg-sky-500/5 border-b border-sky-500/20",
        )}
      >
        <div
          className={cn(
            "h-10 w-10 rounded-full flex items-center justify-center shrink-0",
            isConnected && "bg-emerald-500/15 text-emerald-700",
            isError && "bg-destructive/15 text-destructive",
            isPending && "bg-sky-500/15 text-sky-700",
          )}
        >
          {isConnected ? (
            <CheckCircle2 className="h-5 w-5" />
          ) : isError ? (
            <XCircle className="h-5 w-5" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin" />
          )}
        </div>
        <div className="flex-1">
          <div className="font-medium text-ink">
            {platformLabel(connection.platform)}
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            {isConnected && "Connected · syncing live"}
            {isError && "Connection error · reconnect required"}
            {isPending && "Setting up…"}
          </div>
        </div>
        {isConnected && (
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-500/10 px-2 py-1 rounded-full">
            <Zap className="h-3 w-3" />
            Real-time
          </div>
        )}
      </div>

      <dl className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        {connection.platformAccountEmail && (
          <div>
            <dt className="text-xs text-ink-soft uppercase tracking-wide">Account</dt>
            <dd className="text-ink">{connection.platformAccountEmail}</dd>
          </div>
        )}
        {connection.connectedAt && (
          <div>
            <dt className="text-xs text-ink-soft uppercase tracking-wide">Connected</dt>
            <dd className="text-ink">
              {new Date(connection.connectedAt).toLocaleString()}
            </dd>
          </div>
        )}
        {connection.lastSyncAt && (
          <div>
            <dt className="text-xs text-ink-soft uppercase tracking-wide">Last sync</dt>
            <dd className="text-ink">
              {new Date(connection.lastSyncAt).toLocaleString()}
            </dd>
          </div>
        )}
        {connection.lastError && (
          // v1.35.9: split UI between "real error" (status=error) and
          // "informational warning" (status=connected but lastError set
          // for tier_gate / backfill / webhook degradations). Real errors
          // render destructive-red; warnings render amber.
          <div className="sm:col-span-2">
            <dt
              className={cn(
                "text-xs uppercase tracking-wide",
                isConnected ? "text-amber-700" : "text-destructive",
              )}
            >
              {isConnected ? "Note" : "Last error"}
            </dt>
            <dd
              className={cn(
                "text-xs mt-1 font-mono",
                isConnected ? "text-amber-700" : "text-destructive",
              )}
            >
              {connection.lastError}
            </dd>
          </div>
        )}
      </dl>

      <div className="px-5 py-3 border-t border-border bg-muted/20 flex items-center justify-between gap-2">
        <div className="flex items-center gap-4">
          <a
            href="/app/refill/health"
            className="inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink"
          >
            Check engine health
            <ArrowRight className="h-3 w-3" />
          </a>
          {isConnected && (
            <button
              type="button"
              onClick={onResync}
              disabled={resyncing}
              title="Re-pull the last 30 days + next 90 days of appointments from Acuity and re-match patient names against your roster."
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink hover:bg-muted/40 px-2.5 py-1 rounded disabled:opacity-50"
            >
              {resyncing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {resyncing ? "Re-syncing…" : "Re-sync now"}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onDisconnect}
          disabled={disconnecting}
          className="inline-flex items-center gap-1.5 text-xs text-destructive hover:bg-destructive/10 px-2.5 py-1 rounded disabled:opacity-50"
        >
          {disconnecting && <Loader2 className="h-3 w-3 animate-spin" />}
          Disconnect
        </button>
      </div>
    </div>
  );
}

function AvailablePlatforms({
  onConnectAcuity,
  onConnectSquare,
  onConnectBoulevard,
  onConnectMindbody,
  onConnectVagaro,
  onConnectBooker,
  onConnectJane,
  onConnectZenoti,
  schedulerExtras,
  onConnectLightMode,
  onConnectPlaid,
  connecting,
}: {
  onConnectAcuity: () => void;
  onConnectSquare: () => void;
  onConnectBoulevard: () => void;
  onConnectMindbody: () => void;
  onConnectVagaro: () => void;
  onConnectBooker: () => void;
  onConnectJane: () => void;
  onConnectZenoti: () => void;
  schedulerExtras: { lightMode: boolean; plaidMode: boolean };
  onConnectLightMode: (platform: LightModePlatform) => void;
  onConnectPlaid: (platform: LightModePlatform) => void;
  connecting: boolean;
}) {
  // v1.36.0 — Boulevard architecture pre-build per the platforms-pre-built
  // doctrine. UI lands in disabled state with "App approval pending"
  // badge; flip to enabled by setting REFILL_BOULEVARD_ENABLED=1 in
  // wrangler.jsonc vars OR by removing this constant once Boulevard's
  // 48hr app-approval clears + credentials land in CF secrets.
  const BOULEVARD_ENABLED =
    typeof window !== "undefined" &&
    typeof process !== "undefined" &&
    process.env?.REFILL_BOULEVARD_ENABLED === "1";

  // v1.37.0 — Mindbody architecture pre-build per the same doctrine.
  // Disabled until MINDBODY_OAUTH_CLIENT_ID + secret + API_KEY land in
  // CF secrets after the OAuth-client-provisioning Support ticket clears.
  // Flip by setting REFILL_MINDBODY_ENABLED=1 in wrangler.jsonc vars.
  const MINDBODY_ENABLED =
    typeof window !== "undefined" &&
    typeof process !== "undefined" &&
    process.env?.REFILL_MINDBODY_ENABLED === "1";

  // v1.39.0 — Booker architecture pre-build. Disabled until Booker
  // developer app approval at developers.booker.com + BOOKER_CLIENT_ID
  // + BOOKER_CLIENT_SECRET + BOOKER_SUBSCRIPTION_KEY land in CF.
  const BOOKER_ENABLED =
    typeof window !== "undefined" &&
    typeof process !== "undefined" &&
    process.env?.REFILL_BOOKER_ENABLED === "1";

  // v1.40.0 — Jane architecture pre-build. Polling-only (no webhooks).
  // Disabled until partnership approval clears + JANE_CLIENT_ID +
  // JANE_CLIENT_SECRET + JANE_IAM_BASE_URL land in CF.
  const JANE_ENABLED =
    typeof window !== "undefined" &&
    typeof process !== "undefined" &&
    process.env?.REFILL_JANE_ENABLED === "1";

  // v1.41.0 — Zenoti architecture pre-build. CSM-gated API package +
  // ZENOTI_API_KEY in CF.
  const ZENOTI_ENABLED =
    typeof window !== "undefined" &&
    typeof process !== "undefined" &&
    process.env?.REFILL_ZENOTI_ENABLED === "1";

  return (
    <div className="mt-6 space-y-3">
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-4">
        <div className="h-10 w-10 rounded-full bg-amber-500/15 text-amber-700 flex items-center justify-center shrink-0">
          <Calendar className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-ink">Acuity Scheduling</div>
          <div className="text-xs text-ink-soft mt-0.5">
            One click. We register the webhooks for you and pull your next 90 days of appointments. No API keys to find.
          </div>
        </div>
        <button
          type="button"
          onClick={onConnectAcuity}
          disabled={connecting}
          className="inline-flex items-center gap-2 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
        >
          {connecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plug className="h-4 w-4" />
          )}
          Connect Acuity
        </button>
      </div>

      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-4">
        <div className="h-10 w-10 rounded-full bg-slate-700/15 text-slate-700 flex items-center justify-center shrink-0">
          <Calendar className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-ink">Square Appointments</div>
          <div className="text-xs text-ink-soft mt-0.5">
            One click. Sign in with your Square account. Claim writeback needs Square Appointments Plus or Premium — we'll let you know if your account is on Free.
          </div>
        </div>
        <button
          type="button"
          onClick={onConnectSquare}
          disabled={connecting}
          className="inline-flex items-center gap-2 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
        >
          {connecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plug className="h-4 w-4" />
          )}
          Connect Square
        </button>
      </div>

      {/*
        Vagaro card — paste-API-key (no OAuth). Enabled in production
        because there's no Refill-side approval gate; each spa
        independently signs up for Vagaro's $10/mo API access form,
        gets an API key, pastes it into our wizard. Ordered with the
        live-connectable platforms (Acuity / Square / Vagaro) above
        the architecture-ready pending group.
      */}
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-4">
        <div className="h-10 w-10 rounded-full bg-orange-500/15 text-orange-700 flex items-center justify-center shrink-0">
          <Calendar className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-ink">Vagaro</div>
          <div className="text-xs text-ink-soft mt-0.5">
            Paste your Vagaro API key — we&rsquo;ll register webhooks and pull your next 90 days of appointments. Vagaro charges $10/mo for API access (paid to them, not us).
          </div>
        </div>
        <button
          type="button"
          onClick={onConnectVagaro}
          disabled={connecting}
          className="inline-flex items-center gap-2 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
        >
          {connecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plug className="h-4 w-4" />
          )}
          Connect Vagaro
        </button>
      </div>

      {/*
        Boulevard card — architecture-complete, button disabled until
        Boulevard's 48hr app approval clears + credentials land in CF.
        Per the platforms-pre-built doctrine: card lives in the live
        Available list (not Coming Soon), labeled "App approval pending"
        so spas see Boulevard is real + on the roadmap.
      */}
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-4">
        <div className="h-10 w-10 rounded-full bg-fuchsia-500/15 text-fuchsia-700 flex items-center justify-center shrink-0">
          <Calendar className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-ink flex items-center gap-2">
            Boulevard
            {!BOULEVARD_ENABLED && (
              <span className="text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-700 px-1.5 py-0.5 rounded">
                App approval pending
              </span>
            )}
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            {BOULEVARD_ENABLED
              ? "One click. We hand you your Application ID; you paste it into your Boulevard dashboard's Apps & Integrations. Claim writeback needs Boulevard Premier or Enterprise — we'll let you know if your tier doesn't qualify."
              : "Architecture ready. Submitted to Boulevard's developer portal — typical approval window is 48 hours. We'll flip this card live as soon as credentials clear."}
          </div>
          <PlatformExtrasRow
            platform="boulevard"
            extras={schedulerExtras}
            onLightMode={onConnectLightMode}
            onPlaid={onConnectPlaid}
          />
        </div>
        <button
          type="button"
          onClick={onConnectBoulevard}
          disabled={connecting || !BOULEVARD_ENABLED}
          title={
            BOULEVARD_ENABLED
              ? undefined
              : "Boulevard's 48hr app approval is in progress. We'll enable this button as soon as it clears."
          }
          className="inline-flex items-center gap-2 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
        >
          {connecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plug className="h-4 w-4" />
          )}
          {BOULEVARD_ENABLED
            ? "Connect Boulevard"
            : "Connect Boulevard · Pending"}
        </button>
      </div>

      {/*
        Mindbody card — architecture-complete, button disabled until
        Mindbody API Support clears the OAuth-client-provisioning ticket.
        Per the platforms-pre-built doctrine: card lives in the live
        Available list (not Coming Soon), labeled "OAuth setup pending"
        so spas see Mindbody is real + on the roadmap.
      */}
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-4">
        <div className="h-10 w-10 rounded-full bg-rose-500/15 text-rose-700 flex items-center justify-center shrink-0">
          <Calendar className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-ink flex items-center gap-2">
            Mindbody
            {!MINDBODY_ENABLED && (
              <span className="text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-700 px-1.5 py-0.5 rounded">
                OAuth setup pending
              </span>
            )}
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            {MINDBODY_ENABLED
              ? "One click. Sign in with your Mindbody owner account, grant Refill access — Refill handles activation, webhooks, and the next 90 days of appointments automatically."
              : "Architecture ready. Waiting on Mindbody API Support to provision our OAuth client — usually a few business days after submission. We'll flip this card live as soon as credentials clear."}
          </div>
          <PlatformExtrasRow
            platform="mindbody"
            extras={schedulerExtras}
            onLightMode={onConnectLightMode}
            onPlaid={onConnectPlaid}
          />
        </div>
        <button
          type="button"
          onClick={onConnectMindbody}
          disabled={connecting || !MINDBODY_ENABLED}
          title={
            MINDBODY_ENABLED
              ? undefined
              : "Mindbody API Support is provisioning our OAuth client. We'll enable this button as soon as it clears."
          }
          className="inline-flex items-center gap-2 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
        >
          {connecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plug className="h-4 w-4" />
          )}
          {MINDBODY_ENABLED
            ? "Connect Mindbody"
            : "Connect Mindbody · Pending"}
        </button>
      </div>

      {/*
        Zenoti card — enterprise tier, CSM-gated API package. Disabled
        until ZENOTI_API_KEY + REFILL_ZENOTI_ENABLED=1.
      */}
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-4">
        <div className="h-10 w-10 rounded-full bg-indigo-500/15 text-indigo-700 flex items-center justify-center shrink-0">
          <Calendar className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-ink flex items-center gap-2">
            Zenoti
            {!ZENOTI_ENABLED && (
              <span className="text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-700 px-1.5 py-0.5 rounded">
                CSM onboarding pending
              </span>
            )}
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            {ZENOTI_ENABLED
              ? "Paste your Zenoti center_id — we'll use the shared API package credentials to read appointments + receive cancel/no-show events. Multi-center chains: one connection per center."
              : "Architecture ready. Zenoti requires a CSM-led API package subscription (typically 1-2 weeks). We'll flip this card live as soon as the package activates."}
          </div>
          <PlatformExtrasRow
            platform="zenoti"
            extras={schedulerExtras}
            onLightMode={onConnectLightMode}
            onPlaid={onConnectPlaid}
          />
        </div>
        <button
          type="button"
          onClick={onConnectZenoti}
          disabled={connecting || !ZENOTI_ENABLED}
          title={ZENOTI_ENABLED ? undefined : "Zenoti CSM-led API package onboarding pending."}
          className="inline-flex items-center gap-2 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
        >
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          {ZENOTI_ENABLED ? "Connect Zenoti" : "Connect Zenoti · Pending"}
        </button>
      </div>

      {/*
        Jane card — polling architecture (no webhooks). Disabled until
        Jane partnership approval at developers.jane.app clears.
      */}
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-4">
        <div className="h-10 w-10 rounded-full bg-teal-500/15 text-teal-700 flex items-center justify-center shrink-0">
          <Calendar className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-ink flex items-center gap-2">
            Jane
            {!JANE_ENABLED && (
              <span className="text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-700 px-1.5 py-0.5 rounded">
                Partnership approval pending
              </span>
            )}
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            {JANE_ENABLED
              ? "One click — sign in with your Jane clinic owner account. Polling-based sync (Jane doesn't offer webhooks); cancels reach us within minutes."
              : "Architecture ready. Waiting on Jane's vetted-partner approval (intake at developers.jane.app). We'll flip this card live as soon as credentials clear."}
          </div>
          <PlatformExtrasRow
            platform="jane"
            extras={schedulerExtras}
            onLightMode={onConnectLightMode}
            onPlaid={onConnectPlaid}
          />
        </div>
        <button
          type="button"
          onClick={onConnectJane}
          disabled={connecting || !JANE_ENABLED}
          title={JANE_ENABLED ? undefined : "Jane partnership approval pending."}
          className="inline-flex items-center gap-2 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
        >
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          {JANE_ENABLED ? "Connect Jane" : "Connect Jane · Pending"}
        </button>
      </div>

      {/*
        Booker card — architecture-complete, disabled until Booker dev
        portal approval + app creds land in CF.
      */}
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-4">
        <div className="h-10 w-10 rounded-full bg-violet-500/15 text-violet-700 flex items-center justify-center shrink-0">
          <Calendar className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-ink flex items-center gap-2">
            Booker
            {!BOOKER_ENABLED && (
              <span className="text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-700 px-1.5 py-0.5 rounded">
                App approval pending
              </span>
            )}
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            {BOOKER_ENABLED
              ? "Paste your Booker Location ID — we'll use shared app credentials to read appointments + receive cancel/no-show events."
              : "Architecture ready. Waiting on Booker developer portal approval (Mindbody-owned but separate API). We'll flip this card live as soon as credentials clear."}
          </div>
          <PlatformExtrasRow
            platform="booker"
            extras={schedulerExtras}
            onLightMode={onConnectLightMode}
            onPlaid={onConnectPlaid}
          />
        </div>
        <button
          type="button"
          onClick={onConnectBooker}
          disabled={connecting || !BOOKER_ENABLED}
          title={BOOKER_ENABLED ? undefined : "Booker developer portal approval pending."}
          className="inline-flex items-center gap-2 rounded-md bg-emerald text-paper px-4 py-2 text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
        >
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          {BOOKER_ENABLED ? "Connect Booker" : "Connect Booker · Pending"}
        </button>
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/10 p-4 text-xs text-ink-soft">
        <div className="font-medium text-ink mb-1">Coming soon</div>
        <div>
          Mangomint requires a direct partnership contract (no public dev portal) — ask us about early access. All other major platforms are above; CSV import is available for anything else.
        </div>
      </div>
    </div>
  );
}

function HowItWorks({ brandName }: { brandName: string }) {
  return (
    <div className="mt-10 rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-2 text-sm font-medium text-ink mb-3">
        <Zap className="h-4 w-4" />
        How real-time sync works
      </div>
      <ol className="space-y-3 text-sm text-ink-soft">
        <li className="flex gap-3">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted/40 text-xs shrink-0">1</span>
          <span>You connect your Acuity account once. {brandName} pulls your next 90 days of appointments + your patient roster, and registers four webhooks on your Acuity account to stay current.</span>
        </li>
        <li className="flex gap-3">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted/40 text-xs shrink-0">2</span>
          <span>When an appointment cancels or you mark a no-show in Acuity, Acuity tells {brandName} within seconds.</span>
        </li>
        <li className="flex gap-3">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted/40 text-xs shrink-0">3</span>
          <span>The rescue engine fires — eligible waitlist patients get an offer for the open slot. First tap wins.</span>
        </li>
        <li className="flex gap-3">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted/40 text-xs shrink-0">4</span>
          <span>You're informed via the inbox · drafted iMessage on your Mac · whichever channels you've enabled. Zero manual flips.</span>
        </li>
      </ol>
      <div className="mt-4 pt-4 border-t border-border text-xs text-ink-soft flex items-center gap-1.5">
        <Clock className="h-3 w-3" />
        Typical lag: under 5 seconds from your Acuity click to the first waitlist patient's phone buzzing.
      </div>
    </div>
  );
}

/**
 * v1.42.0 — Per-card extras row surfaced on each gated platform card
 * (Boulevard / Mindbody / Booker / Jane / Zenoti). Shows Light Mode +
 * Plaid Connect alternatives so the spa doesn't have to wait for the
 * vendor's API gate to clear before starting Refill.
 *
 * Light Mode is universally available (extras.lightMode default true).
 * Plaid Mode is admin-gated per-tenant via the plaid_mode_enabled
 * feature flag — admin toggles it at /app/admin/agents.
 */
function PlatformExtrasRow({
  platform,
  extras,
  onLightMode,
  onPlaid,
}: {
  platform: LightModePlatform;
  extras: { lightMode: boolean; plaidMode: boolean };
  onLightMode: (p: LightModePlatform) => void;
  onPlaid: (p: LightModePlatform) => void;
}) {
  if (!extras.lightMode && !extras.plaidMode) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-soft">
      {extras.lightMode && (
        <button
          type="button"
          onClick={() => onLightMode(platform)}
          className="text-emerald hover:underline"
          title="Forward your platform notification emails — start today without vendor approval."
        >
          ⚡ Connect Light Mode (no approval needed) →
        </button>
      )}
      {extras.plaidMode && (
        <>
          {extras.lightMode && <span aria-hidden>·</span>}
          <button
            type="button"
            onClick={() => onPlaid(platform)}
            className="text-fuchsia-700 hover:underline"
            title="Pro option — credential-mediated connector with explicit consent. Concierge setup."
          >
            🔐 Plaid Connect (Pro) →
          </button>
        </>
      )}
    </div>
  );
}

function platformLabel(platform: string): string {
  switch (platform) {
    case "acuity":
      return "Acuity Scheduling";
    case "mindbody":
      return "Mindbody";
    case "jane":
      return "JaneApp";
    case "square":
      return "Square Appointments";
    case "boulevard":
      return "Boulevard";
    case "vagaro":
      return "Vagaro";
    case "zenoti":
      return "Zenoti";
    case "booker":
      return "Booker";
    default:
      return platform;
  }
}

function humanizeError(code: string): string {
  switch (code) {
    case "missing_params":
      return "missing OAuth parameters";
    case "invalid_state":
      return "expired or invalid session — try again";
    case "server_config":
      return "server isn't configured for Acuity yet";
    case "token_exchange":
      return "Acuity rejected the authorization code";
    case "me_failed":
      return "couldn't read your Acuity account info";
    case "connection_save":
      return "couldn't save the connection — try again";
    case "webhook_setup":
      return "couldn't register webhooks on your Acuity account";
    case "backfill":
      return "connected, but couldn't import your appointments yet";
    default:
      return code.replace(/_/g, " ");
  }
}
