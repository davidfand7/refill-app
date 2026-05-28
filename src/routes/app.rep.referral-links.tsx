/**
 * /app/rep/referral-links — Phase 2C minimal rep mint UI.
 *
 * Two-state surface:
 *   1. Not registered as a rep → show "Become a rep" CTA (one-tap, idempotent).
 *   2. Registered → show "Generate referral link" CTA, then display the URL
 *      with copy-to-clipboard.
 *
 * The fuller rep dashboard (network view, ledger, live $$ widget) lands in
 * Phase 2D. This route exists to round-trip Phase 2C: rep mints link →
 * pastes it → new spa signs up → tenants.referred_by_rep_id captured.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, Copy, Link2, Sparkles } from "lucide-react";

import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import { useAuth } from "@/lib/auth";
import {
  ensureMyRepAccount,
  getMyRepAccount,
  listMyReferralLinks,
  mintMyReferralLink,
  type RepAccountRow,
  type ReferralLink,
} from "@/server/rep-platform";

export const Route = createFileRoute("/app/rep/referral-links")({
  component: ReferralLinksPage,
});

function ReferralLinksPage() {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;

  const [rep, setRep] = useState<RepAccountRow | null>(null);
  const [repLoaded, setRepLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<ReferralLink | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!accessToken) {
      setRepLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // v406 Pinch #7: fetch existing referral links alongside the rep
        // profile so the page hydrates with the persisted link card (and its
        // use_count / last_used_at history) instead of showing the empty
        // "Generate" CTA every time. Fail-soft on the links query so a
        // transient DB error doesn't kill the rep-profile path.
        const viewAsUserId =
          typeof window !== "undefined" ? getAdminViewAsUserId() : undefined;
        const [repRes, linksRes] = await Promise.all([
          getMyRepAccount({ data: { accessToken, viewAsUserId } }),
          listMyReferralLinks({ data: { accessToken, viewAsUserId } }).catch(
            () => ({ links: [] }),
          ),
        ]);
        if (cancelled) return;
        setRep(repRes.rep);
        if (linksRes.links.length > 0) {
          setLink(linksRes.links[0]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Couldn't load your rep profile.",
          );
        }
      } finally {
        if (!cancelled) setRepLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, accessToken]);

  const handleEnroll = async () => {
    if (!accessToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { rep: row } = await ensureMyRepAccount({ data: { accessToken } });
      setRep(row);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't set up your rep profile.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleMint = async () => {
    if (!accessToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mintMyReferralLink({
        data: { accessToken },
      });
      setLink(result);
      setCopied(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't mint a referral link.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Couldn't copy — select the URL and copy manually.");
    }
  };

  if (authLoading || !repLoaded) {
    return <Pulse label="Loading your rep profile…" />;
  }

  if (!accessToken) {
    return (
      <Page>
        <Heading>Referral links</Heading>
        <Lede>Sign in to mint a referral link.</Lede>
      </Page>
    );
  }

  return (
    <Page>
      <Heading>Referral links</Heading>

      {!rep ? (
        <>
          <Lede>
            Set up your rep profile to start minting referral links. Every spa
            that signs up through your link is attributed to you — lifetime
            commission, 3% of recovered revenue, no decay.
          </Lede>
          <CTA onClick={handleEnroll} disabled={busy} icon={<Sparkles className="h-4 w-4" />}>
            {busy ? "Setting up…" : "Become a rep"}
          </CTA>
        </>
      ) : (
        <>
          <Lede>
            Hi {rep.displayName}. Mint a fresh link, share it with a spa, and
            you'll be credited on every recovery they bill.
          </Lede>
          {!link ? (
            <CTA onClick={handleMint} disabled={busy} icon={<Link2 className="h-4 w-4" />}>
              {busy ? "Minting…" : "Generate referral link"}
            </CTA>
          ) : (
            <LinkCard
              link={link}
              copied={copied}
              onCopy={handleCopy}
            />
          )}
        </>
      )}

      {error && (
        <div
          className="mt-4 rounded-md px-3 py-2 text-[13px]"
          style={{ background: "#fdecec", color: "#8a1616" }}
        >
          {error}
        </div>
      )}
    </Page>
  );
}

// ─── presentational helpers ──────────────────────────────────────────────

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen flex items-start justify-center px-5 sm:px-8 py-12 sm:py-16"
      style={{ background: "#fbfaf7", color: "#1c2024" }}
    >
      <div className="w-full max-w-xl">
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
      style={{ fontFamily: "Georgia, 'Times New Roman', serif", color: "#1c2024" }}
    >
      {children}
    </h1>
  );
}

function Lede({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[15px] leading-[1.6] mb-5" style={{ color: "#5a6068" }}>
      {children}
    </p>
  );
}

function CTA({
  onClick,
  disabled,
  icon,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ background: "#056048", color: "#fbfaf7" }}
    >
      {icon}
      {children}
    </button>
  );
}

function LinkCard({
  link,
  copied,
  onCopy,
}: {
  link: ReferralLink;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <>
      <div
        className="rounded-lg border p-4 mb-4"
        style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
      >
        <div
          className="text-[12px] uppercase tracking-wider font-semibold mb-2"
          style={{ color: "#8a9098" }}
        >
          Your referral link
        </div>
        <div
          className="text-[15px] font-mono break-all leading-[1.5] mb-3"
          style={{ color: "#1c2024" }}
        >
          {link.url}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium border transition"
            style={{
              borderColor: "#e6e2d6",
              background: copied ? "#f0f5ef" : "#fff",
              color: copied ? "#056048" : "#1c2024",
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {/* v406 Pinch #7: history surface — created date + resolution audit
          (use_count + last_used_at). Tells the rep that this link is live,
          how many people have clicked through, and the most recent hit. */}
      <div
        className="rounded-lg border p-4 mb-4"
        style={{ borderColor: "#e6e2d6", background: "#fff" }}
      >
        <div
          className="text-[11px] uppercase tracking-wider font-semibold mb-3"
          style={{ color: "#8a9098" }}
        >
          History
        </div>
        <div className="grid grid-cols-3 gap-3 text-[13px]">
          <HistoryStat label="Created" value={formatDayDiff(link.createdAt)} />
          <HistoryStat
            label="Clicks / signups"
            value={`${link.useCount}`}
            emphasize
          />
          <HistoryStat
            label="Last click"
            value={link.lastUsedAt ? formatDayDiff(link.lastUsedAt) : "—"}
          />
        </div>
      </div>

      <p className="text-[13px]" style={{ color: "#8a9098" }}>
        Same link, lifetime. Every spa that signs up through it is attributed
        to you — 3% direct, 1% cascade through your sub-reps.
      </p>
    </>
  );
}

function HistoryStat({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider font-semibold mb-1"
        style={{ color: "#8a9098" }}
      >
        {label}
      </div>
      <div
        className="tabular-nums"
        style={{
          color: emphasize ? "#056048" : "#1c2024",
          fontWeight: emphasize ? 700 : 600,
          fontSize: emphasize ? "20px" : "14px",
          fontFamily: emphasize ? "Georgia, 'Times New Roman', serif" : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function formatDayDiff(iso: string): string {
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
