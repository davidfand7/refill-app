/**
 * /app/rep/integrations — Phase 2F rep-facing integrations surface (v398).
 *
 * Single-card layout for the 5/29 demo: Zoho CRM connect + one-shot contact
 * sync. After connecting, "Sync contacts" pulls the first 25 contacts from
 * Zoho via Composio's tool-execute API and renders them as a preview list.
 *
 * Reuses the existing Composio broker plumbing — no new tables, no new
 * webhook handlers. The Connect button posts to /api/composio/connect with
 * returnTo=/app/rep/integrations so OAuth lands back here instead of
 * the admin credentials surface.
 *
 * Future (Phase 2G + 3): more connectors (HubSpot, Salesforce, Pipedrive,
 * Mailchimp), local contact caching via a zoho_contacts table, and the
 * "Add to outreach audience" CTA wiring contacts into /app/rep/outreach.
 */

import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, Database, Link2, RefreshCw, Sparkles } from "lucide-react";
import { z } from "zod";

import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import {
  getMyRepAccount,
  type RepAccountRow,
} from "@/server/rep-platform";
import {
  getMyZohoConnection,
  getZohoToolkitSlug,
  syncMyZohoContacts,
  type ZohoConnection,
  type ZohoContact,
} from "@/server/composio-zoho";

const searchSchema = z.object({
  composio_connected: z.string().optional(),
  composio_error: z.string().optional(),
});

export const Route = createFileRoute("/app/rep/integrations")({
  validateSearch: searchSchema,
  component: IntegrationsPage,
});

function IntegrationsPage() {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;
  const search = useSearch({ from: "/app/rep/integrations" });

  const [rep, setRep] = useState<RepAccountRow | null>(null);
  const [toolkitSlug, setToolkitSlug] = useState<string | null>(null);
  const [connection, setConnection] = useState<ZohoConnection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [contacts, setContacts] = useState<ZohoContact[]>([]);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncedActionSlug, setSyncedActionSlug] = useState<string | null>(null);

  // Banner from OAuth round-trip
  const banner = useMemo(() => {
    if (search.composio_connected) {
      return {
        tone: "success" as const,
        text: `Connected ${search.composio_connected.toUpperCase()} — try Sync below.`,
      };
    }
    if (search.composio_error) {
      return {
        tone: "error" as const,
        text: `Connect failed: ${search.composio_error}. Try again or check Composio settings.`,
      };
    }
    return null;
  }, [search.composio_connected, search.composio_error]);

  useEffect(() => {
    if (authLoading) return;
    if (!accessToken) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const repRes = await getMyRepAccount({ data: { accessToken } });
        if (cancelled) return;
        setRep(repRes.rep);

        const slugRes = await getZohoToolkitSlug({ data: { accessToken } });
        if (cancelled) return;
        setToolkitSlug(slugRes.slug);

        if (slugRes.slug) {
          const connRes = await getMyZohoConnection({
            data: { accessToken, toolkitSlug: slugRes.slug },
          });
          if (cancelled) return;
          setConnection(connRes.connection);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Couldn't load integrations.",
          );
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, accessToken]);

  const handleConnect = async () => {
    if (!accessToken || !toolkitSlug || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? accessToken;
      const resp = await fetch("/api/composio/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          toolkit: toolkitSlug,
          returnTo: "/app/rep/integrations",
        }),
      });
      const data = await resp.json();
      if (data.not_supported) {
        setError(
          `${toolkitSlug} isn't available via Composio managed auth on this account. Open a ticket with Composio to enable it, or wire a direct OAuth flow.`,
        );
        return;
      }
      if (!resp.ok || !data.redirectUrl) {
        setError(data.error ?? "Could not start the Zoho connect flow.");
        return;
      }
      window.location.href = data.redirectUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed.");
    } finally {
      setConnecting(false);
    }
  };

  const handleSync = async () => {
    if (!accessToken || !toolkitSlug || syncing) return;
    setSyncing(true);
    setError(null);
    setSyncMessage(null);
    try {
      const res = await syncMyZohoContacts({
        data: { accessToken, toolkitSlug, limit: 25 },
      });
      setContacts(res.contacts);
      setSyncMessage(res.message);
      setSyncedActionSlug(res.actionSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };

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
        Zoho available now; HubSpot + Salesforce coming soon.
      </Lede>

      {banner && (
        <div
          className="mt-4 rounded-md px-3 py-2 text-[13px]"
          style={
            banner.tone === "success"
              ? { background: "#e8f3ed", color: "#056048" }
              : { background: "#fdecec", color: "#8a1616" }
          }
        >
          {banner.text}
        </div>
      )}

      <ZohoCard
        toolkitSlug={toolkitSlug}
        connection={connection}
        connecting={connecting}
        syncing={syncing}
        onConnect={handleConnect}
        onSync={handleSync}
      />

      {syncMessage && (
        <div
          className="mt-4 rounded-md px-3 py-2 text-[13px]"
          style={{ background: "#fdf6e6", color: "#8a6d10" }}
        >
          {syncMessage}
          {syncedActionSlug && (
            <span className="opacity-60 ml-2">via {syncedActionSlug}</span>
          )}
        </div>
      )}

      {contacts.length > 0 && (
        <ContactList contacts={contacts} />
      )}

      {/* v404 Pinch #22: coming-soon affordance cards for HubSpot + Salesforce.
          Matches the lede promise ("Zoho available now; HubSpot + Salesforce
          coming soon") with VISUAL placeholders, not just text. Grayed out
          to telegraph "not clickable yet" while still occupying the slot so
          the rep can see the connector roadmap. */}
      <ComingSoonCard
        name="HubSpot"
        description="Pull HubSpot contacts into outreach. Same OAuth broker (Composio), same one-click sync."
      />
      <ComingSoonCard
        name="Salesforce"
        description="Same one-click connect for Salesforce accounts. Lands as soon as Composio confirms the toolkit slug."
      />

      {error && (
        <div
          className="mt-4 rounded-md px-3 py-2 text-[13px]"
          style={{ background: "#fdecec", color: "#8a1616" }}
        >
          {error}
        </div>
      )}

      <div
        className="mt-8 pt-5 border-t text-[12px] leading-[1.55]"
        style={{ borderColor: "#f0ebe0", color: "#8a9098" }}
      >
        <Sparkles
          className="inline h-3 w-3 mr-1"
          style={{ color: "#8a6d10" }}
        />
        Composio is the OAuth broker — your Zoho token lives on Composio&apos;s
        side, not in our database. We store only the connection reference and
        the most-recent synced contacts. Revoke any time from your Composio
        dashboard or here.
      </div>
    </Page>
  );
}

function ZohoCard({
  toolkitSlug,
  connection,
  connecting,
  syncing,
  onConnect,
  onSync,
}: {
  toolkitSlug: string | null;
  connection: ZohoConnection | null;
  connecting: boolean;
  syncing: boolean;
  onConnect: () => void;
  onSync: () => void;
}) {
  const isConnected = connection?.connected ?? false;
  return (
    <div
      className="rounded-xl border bg-white p-6 mt-6"
      style={{ borderColor: isConnected ? "#056048" : "#e6e2d6" }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Database
              className="h-4 w-4"
              style={{ color: isConnected ? "#056048" : "#8a9098" }}
            />
            <div
              className="text-[15px] font-semibold"
              style={{ color: "#1c2024" }}
            >
              Zoho CRM
            </div>
            {isConnected && (
              <span
                className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5"
                style={{ background: "#e8f3ed", color: "#056048" }}
              >
                Connected
              </span>
            )}
          </div>
          <p
            className="text-[13px] leading-[1.5]"
            style={{ color: "#5a6068" }}
          >
            Pull your existing contacts so you don&apos;t retype them into
            outreach. One connect, then sync as often as you like.
          </p>
          {connection?.accountLabel && (
            <p
              className="text-[11px] mt-2 font-mono"
              style={{ color: "#8a9098" }}
            >
              account · {connection.accountLabel}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          {!isConnected ? (
            <button
              type="button"
              onClick={onConnect}
              disabled={!toolkitSlug || connecting}
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: "#056048", color: "#fbfaf7" }}
            >
              <Link2 className="h-4 w-4" />
              {connecting ? "Opening…" : "Connect Zoho"}
            </button>
          ) : (
            <button
              type="button"
              onClick={onSync}
              disabled={syncing}
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: "#056048", color: "#fbfaf7" }}
            >
              <RefreshCw
                className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`}
              />
              {syncing ? "Syncing…" : "Sync contacts"}
            </button>
          )}
          {toolkitSlug && (
            <span
              className="text-[10px] uppercase tracking-wider"
              style={{ color: "#8a9098" }}
            >
              slug · {toolkitSlug}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ContactList({ contacts }: { contacts: ZohoContact[] }) {
  return (
    <div
      className="mt-5 rounded-lg border bg-white"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-b"
        style={{ borderColor: "#f0ebe0", background: "#fbfaf7" }}
      >
        <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "#056048" }} />
        <div
          className="text-[11px] uppercase tracking-wider font-semibold"
          style={{ color: "#5a6068" }}
        >
          {contacts.length} contact{contacts.length === 1 ? "" : "s"} from Zoho
        </div>
      </div>
      <ul className="divide-y" style={{ borderColor: "#f0ebe0" }}>
        {contacts.map((c) => (
          <li
            key={c.id || `${c.email}-${c.fullName}`}
            className="flex items-center justify-between px-4 py-3 gap-4"
          >
            <div className="min-w-0 flex-1">
              <div
                className="text-[14px] font-medium truncate"
                style={{ color: "#1c2024" }}
              >
                {c.fullName ?? "(no name)"}
              </div>
              <div
                className="text-[12px] truncate"
                style={{ color: "#5a6068" }}
              >
                {c.accountName ?? c.title ?? "—"}
              </div>
            </div>
            <div className="text-[12px] flex-shrink-0 max-w-[14rem] truncate text-right">
              <div style={{ color: "#1c2024" }}>{c.email ?? "—"}</div>
              {c.phone && (
                <div style={{ color: "#8a9098" }}>{c.phone}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
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
