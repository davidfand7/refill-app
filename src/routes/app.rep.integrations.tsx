/**
 * /app/rep/integrations — CRM connectors surface.
 *
 * Refill cleave 2026-05-25: degraded to "all coming soon" — the underlying
 * Composio broker stack (composio_supported_toolkits + workspace_connections
 * migrations, /api/composio/connect handler, nightly refresh-toolkits cron)
 * did not make the cleave. Re-port that stack OR rewire to a direct OAuth
 * flow before flipping Zoho/HubSpot/Salesforce to active.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Clock, Database, Link2, Sparkles } from "lucide-react";

import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import { useAuth } from "@/lib/auth";
import {
  getMyRepAccount,
  type RepAccountRow,
} from "@/server/rep-platform";

export const Route = createFileRoute("/app/rep/integrations")({
  component: IntegrationsPage,
});

function IntegrationsPage() {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;

  const [rep, setRep] = useState<RepAccountRow | null>(null);
  const [loaded, setLoaded] = useState(false);

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
        const repRes = await getMyRepAccount({
          data: { accessToken, viewAsUserId },
        });
        if (cancelled) return;
        setRep(repRes.rep);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, accessToken]);

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
        Zoho, HubSpot, and Salesforce are all coming soon.
      </Lede>

      <ComingSoonCard
        name="Zoho CRM"
        description="Pull your existing contacts so you don't retype them into outreach. One connect, then sync as often as you like."
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
