/**
 * /app/rep/integrations — CRM connectors surface.
 *
 * v1.46.0: Zoho CRM is LIVE via direct OAuth (replaces the never-shipped
 * Composio broker path that was lost in the v.cleave). One click → standard
 * Zoho consent screen → back with a connected card showing email + org +
 * Sync button. HubSpot + Salesforce stay coming-soon.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Link2,
  Loader2,
  Plug,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import { useAuth } from "@/lib/auth";
import {
  getMyRepAccount,
  type RepAccountRow,
} from "@/server/rep-platform";
import {
  disconnectZoho,
  getMyZohoConnection,
  initiateZohoOAuth,
  syncMyZohoContacts,
  type ZohoConnection,
} from "@/server/zoho.functions";
import type { ZohoContact } from "@/lib/integrations/zoho";

// Search params from the OAuth callback bounce. Tolerant — any unknown
// shape is ignored without throwing, so a stale link with garbage params
// still renders the page.
const integrationsSearchSchema = z.object({
  zoho_connected: z.string().optional(),
  zoho_error: z.string().optional(),
});

export const Route = createFileRoute("/app/rep/integrations")({
  validateSearch: (search: Record<string, unknown>) =>
    integrationsSearchSchema.parse(search),
  component: IntegrationsPage,
});

function IntegrationsPage() {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;
  const search = Route.useSearch();

  const [rep, setRep] = useState<RepAccountRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [connection, setConnection] = useState<ZohoConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [contacts, setContacts] = useState<ZohoContact[] | null>(null);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!accessToken) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const viewAsUserId =
          typeof window !== "undefined" ? getAdminViewAsUserId() : undefined;
        const [repRes, connRes] = await Promise.all([
          getMyRepAccount({ data: { accessToken, viewAsUserId } }),
          getMyZohoConnection({ data: { accessToken } }).catch(() => ({
            connection: null,
          })),
        ]);
        if (cancelled) return;
        setRep(repRes.rep);
        setConnection(connRes.connection);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, accessToken]);

  // Surface the callback-bounce result. Fires once on first render after the
  // OAuth round-trip lands us back here.
  useEffect(() => {
    if (!loaded) return;
    if (search.zoho_connected === "1") {
      toast.success("Zoho CRM connected.");
    } else if (search.zoho_error) {
      const human = humanizeZohoError(search.zoho_error);
      toast.error(`Zoho connect failed: ${human}`);
    }
    // We intentionally don't watch search.zoho_* — only fire on first paint
    // post-load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const handleConnect = useCallback(async () => {
    if (!accessToken) return;
    setConnecting(true);
    try {
      const { redirectUrl } = await initiateZohoOAuth({
        data: {
          accessToken,
          origin: window.location.origin,
          returnTo: "/app/rep/integrations",
        },
      });
      window.location.href = redirectUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't start Zoho connect: ${msg}`);
      setConnecting(false);
    }
  }, [accessToken]);

  const handleSync = useCallback(async () => {
    if (!accessToken) return;
    setSyncing(true);
    setLastSyncMessage(null);
    try {
      const res = await syncMyZohoContacts({
        data: { accessToken, limit: 25 },
      });
      setContacts(res.contacts);
      setLastSyncMessage(res.message);
      // Refresh the connection row so last_sync_at + last_synced_contact_count update.
      const { connection: refreshed } = await getMyZohoConnection({
        data: { accessToken },
      });
      setConnection(refreshed);
      toast.success(res.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Sync failed: ${msg}`);
      // Refresh connection in case status flipped to expired/error.
      try {
        const { connection: refreshed } = await getMyZohoConnection({
          data: { accessToken },
        });
        setConnection(refreshed);
      } catch {
        // Ignore — outer error already surfaced.
      }
    } finally {
      setSyncing(false);
    }
  }, [accessToken]);

  const handleDisconnect = useCallback(async () => {
    if (!accessToken) return;
    if (!window.confirm("Disconnect Zoho? You can reconnect any time.")) return;
    setDisconnecting(true);
    try {
      await disconnectZoho({ data: { accessToken } });
      setConnection(null);
      setContacts(null);
      setLastSyncMessage(null);
      toast.success("Zoho disconnected.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Disconnect failed: ${msg}`);
    } finally {
      setDisconnecting(false);
    }
  }, [accessToken]);

  if (authLoading || !loaded) {
    return <Pulse label="Loading integrations…" />;
  }

  if (!accessToken) {
    return (
      <Page>
        <Heading>Integrations</Heading>
        <Lede>Sign in to manage your integrations.</Lede>
      </Page>
    );
  }

  if (!rep) {
    return (
      <Page>
        <Heading>Integrations</Heading>
        <Lede>
          Set up your rep profile first. Integrations attach to your rep
          identity so the contacts you sync route into your outreach + commission
          attribution.
        </Lede>
        <Link
          to="/app/rep/referral-links"
          className="inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition"
          style={{ background: "#056048", color: "#fbfaf7" }}
        >
          Set up rep profile
        </Link>
      </Page>
    );
  }

  return (
    <Page>
      <Heading>Integrations</Heading>
      <Lede>
        Connect your CRM to pull contacts directly into your outreach flow.
        Zoho is live; HubSpot and Salesforce are next up.
      </Lede>

      <ConnectZohoCard
        connection={connection}
        connecting={connecting}
        syncing={syncing}
        disconnecting={disconnecting}
        contacts={contacts}
        lastSyncMessage={lastSyncMessage}
        onConnect={handleConnect}
        onSync={handleSync}
        onDisconnect={handleDisconnect}
      />
      <ComingSoonCard
        name="HubSpot"
        description="Pull HubSpot contacts into outreach. Same one-click sync once connectors land."
      />
      <ComingSoonCard
        name="Salesforce"
        description="Same one-click connect for Salesforce accounts."
      />

      <div
        className="mt-8 pt-5 border-t text-[12px] leading-[1.55]"
        style={{ borderColor: "#f0ebe0", color: "#8a9098" }}
      >
        <Sparkles
          className="inline h-3 w-3 mr-1"
          style={{ color: "#8a6d10" }}
        />
        Want a connector sooner? Tell us which CRM you live in and we&apos;ll
        prioritize it.
      </div>
    </Page>
  );
}

// ─── presentational shell ────────────────────────────────────────────────

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen px-5 sm:px-8 py-12 sm:py-16"
      style={{ background: "#fbfaf7", color: "#1c2024" }}
    >
      <div className="w-full max-w-2xl mx-auto">
        <div
          className="rounded-xl border bg-white p-7 sm:p-10 shadow-sm"
          style={{ borderColor: "#e6e2d6" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h1
      className="text-[28px] leading-[1.15] font-semibold tracking-tight mb-3"
      style={{
        fontFamily: "Georgia, 'Times New Roman', serif",
        color: "#1c2024",
      }}
    >
      {children}
    </h1>
  );
}

function Lede({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[15px] leading-[1.6] mb-2" style={{ color: "#5a6068" }}>
      {children}
    </p>
  );
}

// ─── Zoho connect card ───────────────────────────────────────────────────

function ConnectZohoCard({
  connection,
  connecting,
  syncing,
  disconnecting,
  contacts,
  lastSyncMessage,
  onConnect,
  onSync,
  onDisconnect,
}: {
  connection: ZohoConnection | null;
  connecting: boolean;
  syncing: boolean;
  disconnecting: boolean;
  contacts: ZohoContact[] | null;
  lastSyncMessage: string | null;
  onConnect: () => void;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  const isConnected =
    connection?.status === "connected";
  const needsReconnect =
    connection?.status === "expired" || connection?.status === "error";
  const isRevoked = connection?.status === "revoked";

  // Treat revoked the same as never-connected for the UI gate.
  const showConnectedState = isConnected || needsReconnect;
  const showInitialState = !connection || isRevoked;

  return (
    <div
      className="rounded-xl border bg-white p-6 mt-4"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <Database
              className="h-4 w-4"
              style={{ color: isConnected ? "#056048" : "#5a6068" }}
            />
            <div
              className="text-[15px] font-semibold"
              style={{ color: "#1c2024" }}
            >
              Zoho CRM
            </div>
            <ZohoStatusPill
              isConnected={isConnected}
              needsReconnect={needsReconnect}
            />
          </div>
          {showConnectedState && connection ? (
            <div
              className="text-[12px] leading-[1.55]"
              style={{ color: "#5a6068" }}
            >
              {connection.zohoUserEmail ? (
                <>
                  Signed in as{" "}
                  <strong style={{ color: "#1c2024" }}>
                    {connection.zohoUserEmail}
                  </strong>
                </>
              ) : (
                "Signed in"
              )}
              {connection.zohoOrgName ? (
                <>
                  {" "}
                  · <strong>{connection.zohoOrgName}</strong>
                </>
              ) : null}
              {connection.lastSyncAt ? (
                <>
                  {" "}
                  · last sync {formatRelativeShort(connection.lastSyncAt)}
                </>
              ) : (
                <> · never synced</>
              )}
            </div>
          ) : (
            <p
              className="text-[13px] leading-[1.5]"
              style={{ color: "#8a9098" }}
            >
              Pull your existing contacts so you don&apos;t retype them into
              outreach. One connect, then sync as often as you like.
            </p>
          )}
        </div>

        {showInitialState ? (
          <button
            type="button"
            onClick={onConnect}
            disabled={connecting}
            className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "#056048", color: "#fbfaf7" }}
          >
            {connecting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Connecting…
              </>
            ) : (
              <>
                <Plug className="h-4 w-4" />
                Connect Zoho
              </>
            )}
          </button>
        ) : needsReconnect ? (
          <button
            type="button"
            onClick={onConnect}
            disabled={connecting}
            className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "#b45309", color: "#fbfaf7" }}
          >
            {connecting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Reconnecting…
              </>
            ) : (
              <>
                <Plug className="h-4 w-4" />
                Reconnect
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSync}
            disabled={syncing}
            className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "#056048", color: "#fbfaf7" }}
          >
            {syncing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Syncing…
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4" />
                Sync now
              </>
            )}
          </button>
        )}
      </div>

      {needsReconnect && connection?.lastError ? (
        <div
          className="mt-2 rounded-md px-3 py-2 text-[12px] leading-[1.5]"
          style={{ background: "#fdf6e6", color: "#8a6d10" }}
        >
          <AlertTriangle className="inline h-3 w-3 mr-1" />
          {truncate(connection.lastError, 220)}
        </div>
      ) : null}

      {/* Contact preview after a sync. Shown only when we have results in
          memory — survives until next sync or page leave. */}
      {contacts && contacts.length > 0 ? (
        <div className="mt-4">
          <div
            className="text-[11px] uppercase tracking-wider font-semibold mb-2"
            style={{ color: "#8a9098" }}
          >
            Latest sync · {contacts.length}{" "}
            {contacts.length === 1 ? "contact" : "contacts"}
          </div>
          <div
            className="rounded-lg border overflow-hidden"
            style={{ borderColor: "#f0ebe0" }}
          >
            <ul className="divide-y" style={{ borderColor: "#f0ebe0" }}>
              {contacts.slice(0, 25).map((c) => (
                <ZohoContactRow key={c.id} contact={c} />
              ))}
            </ul>
          </div>
          {lastSyncMessage ? (
            <p
              className="mt-2 text-[11px]"
              style={{ color: "#8a9098" }}
            >
              <CheckCircle2
                className="inline h-3 w-3 mr-1"
                style={{ color: "#056048" }}
              />
              {lastSyncMessage}
            </p>
          ) : null}
        </div>
      ) : null}

      {isConnected ? (
        <div className="mt-4 pt-3 border-t" style={{ borderColor: "#f0ebe0" }}>
          <button
            type="button"
            onClick={onDisconnect}
            disabled={disconnecting}
            className="text-[11px] underline-offset-2 hover:underline disabled:opacity-50"
            style={{ color: "#8a9098" }}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect Zoho"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ZohoStatusPill({
  isConnected,
  needsReconnect,
}: {
  isConnected: boolean;
  needsReconnect: boolean;
}) {
  if (isConnected) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5"
        style={{ background: "#e8f3ed", color: "#056048" }}
      >
        <CheckCircle2 className="h-2.5 w-2.5" />
        Connected
      </span>
    );
  }
  if (needsReconnect) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5"
        style={{ background: "#fdf6e6", color: "#8a6d10" }}
      >
        <AlertTriangle className="h-2.5 w-2.5" />
        Reconnect needed
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5"
      style={{ background: "#f0ebe0", color: "#5a6068" }}
    >
      <Plug className="h-2.5 w-2.5" />
      Not connected
    </span>
  );
}

function ZohoContactRow({ contact }: { contact: ZohoContact }) {
  const name = contact.fullName ?? "(no name)";
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div
          className="text-[13px] font-medium truncate"
          style={{ color: "#1c2024" }}
        >
          {name}
        </div>
        <div
          className="text-[11px] mt-0.5 truncate"
          style={{ color: "#8a9098" }}
        >
          {contact.email ?? "—"}
          {contact.phone ? ` · ${contact.phone}` : ""}
          {contact.accountName ? ` · ${contact.accountName}` : ""}
        </div>
      </div>
    </li>
  );
}

function humanizeZohoError(raw: string): string {
  if (raw.startsWith("token_exchange__")) {
    return "Token exchange failed. Try the Connect button again.";
  }
  switch (raw) {
    case "missing_params":
      return "Zoho didn't return the expected params. Try again.";
    case "invalid_state":
      return "Session expired during the OAuth round-trip. Try again.";
    case "missing_refresh_token":
      return "Zoho didn't issue a refresh token. Make sure you're on the standard consent screen.";
    case "server_config":
      return "Server isn't configured for Zoho yet. Ask an admin.";
    case "connection_save":
      return "Couldn't save the connection. Try again.";
    default:
      if (raw.startsWith("zoho:")) return raw.slice(5).replace(/_/g, " ");
      return raw.replace(/_/g, " ");
  }
}

function formatRelativeShort(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ─── Coming-soon card ────────────────────────────────────────────────────

function ComingSoonCard({
  name,
  description,
}: {
  name: string;
  description: string;
}) {
  return (
    <div
      className="rounded-xl border bg-white p-6 mt-4"
      style={{
        borderColor: "#e6e2d6",
        background: "#fbfaf7",
        opacity: 0.85,
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Database className="h-4 w-4" style={{ color: "#8a9098" }} />
            <div
              className="text-[15px] font-semibold"
              style={{ color: "#5a6068" }}
            >
              {name}
            </div>
            <span
              className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5"
              style={{ background: "#fdf6e6", color: "#8a6d10" }}
            >
              <Clock className="h-2.5 w-2.5" />
              Coming soon
            </span>
          </div>
          <p
            className="text-[13px] leading-[1.5]"
            style={{ color: "#8a9098" }}
          >
            {description}
          </p>
        </div>
        <button
          type="button"
          disabled
          aria-disabled
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold transition cursor-not-allowed opacity-60"
          style={{ background: "#e6e2d6", color: "#5a6068" }}
        >
          <Link2 className="h-4 w-4" />
          Not yet
        </button>
      </div>
    </div>
  );
}

function Pulse({ label }: { label: string }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4"
      style={{ background: "#fbfaf7" }}
      role="status"
      aria-live="polite"
    >
      <div
        className="h-9 w-9 rounded-full animate-pulse"
        style={{ background: "#056048" }}
        aria-hidden
      />
      <div className="text-[14px]" style={{ color: "#5a6068" }}>
        {label}
      </div>
    </div>
  );
}
