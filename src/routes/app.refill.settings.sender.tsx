/**
 * /app/refill/settings/sender — Emma(OS) per-spa email sender (v355).
 *
 * Replaces the platform-default "Emma <hello@notify.openagentic.site>"
 * with a verified domain the spa owns ("hello@rejuvmedical.com").
 *
 * Two states:
 *   • No verified domain → Emma sends from platform default. Card shows
 *     the live preview + "Add your domain" CTA.
 *   • Verified domain    → Emma sends from spa's domain. Card shows the
 *     verified address, badge, "Send a test" placeholder, and Remove.
 *
 * In-setup domains (status='pending' / 'failed') render as a separate
 * card per domain with the DNS records to publish and a Refresh button
 * that re-asks Resend for current status.
 *
 * Why no nested Outlet shell for /app/refill/settings: this is the only
 * settings pane shipping in v355. When the second pane lands (timezone,
 * unsubscribe footer, etc.) we'll convert app.emma.settings.tsx into an
 * Outlet shell + app.emma.settings.index.tsx redirect — same v341.3
 * pattern.
 *
 * Established 2026-05-16 (Promotions Engine v355).
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  createSenderDomain,
  deleteSenderDomain,
  listSenderDomains,
  refreshSenderDomain,
  type EmmaSenderDomain,
} from "@/server/emma-sender.functions";
import { useShell } from "@/lib/shell";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/settings/sender")({
  component: SenderSettingsPage,
});

// v411.6 — brand-aware platform default display name. The underlying email
// address (notify.openagentic.site) is unchanged because the SMTP envelope is
// a real DNS/reputation concern that has to be solved before flipping for
// Refill users. UI surface flips though — Karen sees "Refill <hello@...>",
// Emma users see "Emma <hello@...>". Future v411.6.x can swap the actual
// envelope when the Refill-branded sender domain is verified in Resend.
function platformDefaultFor(brandName: string): string {
  return `${brandName} <hello@notify.openagentic.site>`;
}

function SenderSettingsPage() {
  // v411.6 — brand-aware constants. Same useShell pattern as v411.5.
  const shell = useShell();
  const isRefill = shell === "refill";
  const brandHeader = isRefill ? "Refill" : "Emma(OS)";
  const brandName = isRefill ? "Refill" : "Emma";
  const platformDefault = platformDefaultFor(brandName);

  const [domains, setDomains] = useState<EmmaSenderDomain[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in to manage your sender.");
        return;
      }
      const rows = await listSenderDomains({ data: { accessToken: token } });
      setDomains(rows);
      setLoadError(null);
    } catch (e) {
      setLoadError(
        e instanceof Error ? e.message : "Couldn't load sender settings.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const verified = domains?.find((d) => d.status === "verified") ?? null;
  const pending = domains?.filter((d) => d.status !== "verified") ?? [];

  async function withToken<T>(
    fn: (token: string) => Promise<T>,
  ): Promise<T | null> {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      toast.error("Sign-in lost — refresh and try again.");
      return null;
    }
    return fn(token);
  }

  async function handleAdd(domain: string, displayName: string, localPart: string) {
    setAdding(true);
    try {
      const row = await withToken((token) =>
        createSenderDomain({
          data: {
            accessToken: token,
            domain,
            fromDisplayName: displayName || undefined,
            fromLocalPart: localPart || undefined,
          },
        }),
      );
      if (!row) return;
      toast.success(`${row.domain} added — publish the DNS records below to verify.`);
      setShowAddForm(false);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add domain.");
    } finally {
      setAdding(false);
    }
  }

  async function handleRefresh(id: string) {
    setRefreshingId(id);
    try {
      const row = await withToken((token) =>
        refreshSenderDomain({ data: { accessToken: token, id } }),
      );
      if (!row) return;
      if (row.status === "verified") {
        toast.success(`Verified — ${brandName} now sends from ${row.fromAddressPreview}.`);
      } else if (row.status === "failed") {
        toast.error("Resend gave up on this domain — remove and try again.");
      } else {
        toast.info("Still pending — DNS can take a few minutes to propagate.");
      }
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't refresh.");
    } finally {
      setRefreshingId(null);
    }
  }

  async function handleRemove(id: string, domain: string) {
    if (!window.confirm(`Remove ${domain}? ${brandName} will fall back to the platform default sender.`)) {
      return;
    }
    setRemovingId(id);
    try {
      await withToken((token) =>
        deleteSenderDomain({ data: { accessToken: token, id } }),
      );
      toast.success(`${domain} removed.`);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove domain.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow={`${brandHeader} · Settings`}
        title="Email sender"
        description={`The From address ${brandName} uses when sending campaigns. By default messages send from the platform domain — connect your own domain so messages land as you.`}
        breadcrumbs={[
          { label: brandHeader, to: "/app/refill" },
          { label: "Settings" },
          { label: "Email sender" },
        ]}
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl w-full mx-auto space-y-6">
        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {/* Live preview — what Emma is sending from right now. */}
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-xs font-medium tracking-wider text-ink-soft uppercase mb-2">
            <Mail className="h-3.5 w-3.5" />
            Live sender
          </div>
          {verified ? (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[11px] font-medium">
                  <CheckCircle2 className="h-3 w-3" />
                  Verified
                </span>
                <span className="text-xs text-ink-soft">
                  Your domain
                </span>
              </div>
              <div className="font-mono text-sm text-foreground">
                {verified.fromAddressPreview}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => handleRemove(verified.id, verified.domain)}
                  disabled={removingId === verified.id}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs text-ink-soft hover:text-foreground hover:border-destructive/40 disabled:opacity-50"
                >
                  {removingId === verified.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[11px] font-medium">
                  Platform default
                </span>
                <span className="text-xs text-ink-soft">
                  Connect your domain to send as you
                </span>
              </div>
              <div className="font-mono text-sm text-foreground">
                {platformDefault}
              </div>
            </div>
          )}
        </section>

        {/* Pending / failed domains in setup. */}
        {pending.map((d) => (
          <PendingDomainCard
            key={d.id}
            domain={d}
            refreshing={refreshingId === d.id}
            removing={removingId === d.id}
            onRefresh={() => handleRefresh(d.id)}
            onRemove={() => handleRemove(d.id, d.domain)}
          />
        ))}

        {/* Add new domain. */}
        {!verified && !showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card hover:bg-muted/30 px-4 py-5 text-sm font-medium text-foreground transition-colors"
          >
            <Plus className="h-4 w-4" />
            Connect your domain
          </button>
        )}

        {showAddForm && (
          <AddDomainForm
            adding={adding}
            onSubmit={handleAdd}
            onCancel={() => setShowAddForm(false)}
            brandName={brandName}
          />
        )}

        {domains === null && !loadError && (
          <div className="flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading sender settings…
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Add domain form ──────────────────────────────────────────────────────

function AddDomainForm({
  adding,
  onSubmit,
  onCancel,
  brandName,
}: {
  adding: boolean;
  onSubmit: (domain: string, displayName: string, localPart: string) => void;
  onCancel: () => void;
  brandName: string;
}) {
  const [domain, setDomain] = useState("");
  const [displayName, setDisplayName] = useState(brandName);
  const [localPart, setLocalPart] = useState("hello");

  const preview = domain
    ? `${displayName || brandName} <${localPart || "hello"}@${domain.trim().toLowerCase()}>`
    : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(domain.trim().toLowerCase(), displayName.trim(), localPart.trim());
      }}
      className="rounded-xl border border-border bg-card p-5 space-y-4"
    >
      <div>
        <label className="block text-xs font-medium text-ink-soft mb-1.5">
          Domain
        </label>
        <input
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="rejuvmedical.com"
          required
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald/30"
        />
        <p className="mt-1 text-[11px] text-ink-soft">
          The domain you own — we'll ask you to publish a few DNS records to prove it.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-ink-soft mb-1.5">
            Display name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={brandName}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-soft mb-1.5">
            Local part
          </label>
          <input
            type="text"
            value={localPart}
            onChange={(e) => setLocalPart(e.target.value)}
            placeholder="hello"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald/30"
          />
        </div>
      </div>

      {preview && (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
          <span className="text-ink-soft mr-2">Will send as:</span>
          <span className="font-mono text-foreground">{preview}</span>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={adding || !domain.trim()}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald text-paper text-sm font-medium hover:bg-emerald/90 disabled:opacity-50"
        >
          {adding ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Connect domain
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={adding}
          className="px-3 py-2 rounded-md border border-border text-sm text-ink-soft hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Pending domain card ──────────────────────────────────────────────────

function PendingDomainCard({
  domain,
  refreshing,
  removing,
  onRefresh,
  onRemove,
}: {
  domain: EmmaSenderDomain;
  refreshing: boolean;
  removing: boolean;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <StatusPill status={domain.status} />
            <span className="font-mono text-sm text-foreground">
              {domain.domain}
            </span>
          </div>
          <div className="text-xs text-ink-soft">
            Once verified: <span className="font-mono">{domain.fromAddressPreview}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs text-foreground hover:bg-muted/40 disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Check
          </button>
          <button
            onClick={onRemove}
            disabled={removing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs text-ink-soft hover:text-destructive hover:border-destructive/40 disabled:opacity-50"
          >
            {removing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Remove
          </button>
        </div>
      </div>

      {domain.dnsRecords.length > 0 ? (
        <div>
          <div className="text-xs font-medium text-ink-soft mb-2">
            Add these records to your DNS provider:
          </div>
          <DnsRecordsTable records={domain.dnsRecords} />
          <p className="mt-3 text-[11px] text-ink-soft">
            DNS propagation usually takes 1–10 minutes. Click <span className="font-medium text-foreground">Check</span> after publishing.
          </p>
        </div>
      ) : (
        <div className="text-xs text-ink-soft">
          Resend hasn't returned DNS records yet — click Check in a moment.
        </div>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: EmmaSenderDomain["status"] }) {
  if (status === "verified") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[11px] font-medium">
        <CheckCircle2 className="h-3 w-3" />
        Verified
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-destructive/10 text-destructive text-[11px] font-medium">
        <AlertTriangle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[11px] font-medium">
      <Loader2 className="h-3 w-3 animate-spin" />
      Pending DNS
    </span>
  );
}

function DnsRecordsTable({
  records,
}: {
  records: EmmaSenderDomain["dnsRecords"];
}) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-muted/40">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium text-ink-soft">Type</th>
            <th className="px-3 py-2 font-medium text-ink-soft">Name</th>
            <th className="px-3 py-2 font-medium text-ink-soft">Value</th>
            <th className="px-3 py-2 w-8"></th>
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-3 py-2 font-mono uppercase">{r.type || r.record}</td>
              <td className="px-3 py-2 font-mono break-all">{r.name}</td>
              <td className="px-3 py-2 font-mono break-all">{r.value}</td>
              <td className="px-3 py-2">
                <CopyButton text={r.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          toast.error("Couldn't copy — select and copy manually.");
        }
      }}
      className={cn(
        "p-1.5 rounded hover:bg-muted/60 text-ink-soft hover:text-foreground transition-colors",
        copied && "text-emerald-600",
      )}
      title="Copy value"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
