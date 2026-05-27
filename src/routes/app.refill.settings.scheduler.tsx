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
  getSchedulerConnection,
  disconnectScheduler,
  resyncSchedulerConnection,
  type SchedulerConnection,
} from "@/server/emma-scheduler.functions";
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
    if (!confirm(`Disconnect Acuity? ${brandName} will stop receiving real-time appointment updates from your scheduler.`)) {
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
          ? `Disconnected · removed ${webhooksRemoved} webhook${webhooksRemoved === 1 ? "" : "s"} from Acuity`
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
          <div className="sm:col-span-2">
            <dt className="text-xs text-destructive uppercase tracking-wide">Last error</dt>
            <dd className="text-destructive text-xs mt-1 font-mono">
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
  connecting,
}: {
  onConnectAcuity: () => void;
  connecting: boolean;
}) {
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

      <div className="rounded-lg border border-border/60 bg-muted/10 p-4 text-xs text-ink-soft">
        <div className="font-medium text-ink mb-1">Coming soon</div>
        <div>
          Mindbody · JaneApp · Square Appointments · Boulevard — each shipping as its own connector. Until then, those platforms can use the CSV import flow — ask us to enable it for your account.
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
