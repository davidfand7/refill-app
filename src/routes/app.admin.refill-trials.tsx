/**
 * /app/admin/refill-trials — Refill trial spa lever board (v389 / Phase 1.6).
 *
 * Grasshopper-only admin view of every tenant in the Refill funnel:
 *   - Slug, name, plan, trial day-number, trial end date
 *   - Per-day drip state pills (Day 3 / 7 / 14 / 21 / 28 — sent ✓, pending ⏳, future ◌)
 *   - Per-row "Send now" buttons for any drip the tenant hasn't received yet
 *
 * Auth: useIsAdmin gate. Non-admins get bounced to /app via a hard redirect
 * effect (the same pattern as /app/templates' admin-only sections). The
 * server fns ALSO gate independently — listAllTrialTenants + adminSendDrip
 * both call requireAdmin against user_roles, so a tampering client can't
 * pull the table even if they slip past the route gate.
 *
 * This is the foundation for v390+ levers (incentive offers attached per
 * tenant, reply-text inspection, trial extensions, ad-hoc messaging). For
 * v389 the board is read-only-plus-resend.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Clock,
  Send,
  Loader2,
  MessageSquare,
  Gift,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

import { Link } from "@tanstack/react-router";

import { useAuth } from "@/lib/auth";
import { PageHeader } from "@/components/PageHeader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  listAllTrialTenants,
  adminSendDripToTenant,
  type TrialTenantRow,
} from "@/server/refill-admin";
import { DRIP_DAYS, type DripDay } from "@/server/refill-drip";
import {
  createIncentiveOffer,
  listOffersForTenant,
  sendOfferToTenant,
  OFFER_TYPES,
  type OfferType,
  type OfferWithStatus,
} from "@/server/refill-offers";

export const Route = createFileRoute("/app/admin/refill-trials")({
  component: AdminRefillTrialsPage,
});

type Filter = "all" | "active" | "ended";

type GateState = "checking" | "ok" | "not-admin" | "unauthenticated";

function AdminRefillTrialsPage() {
  const { session, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  // ── Use the SERVER response as the source of truth for admin gating.
  // The client useIsAdmin hook starts at `false` and only flips after an
  // async query — so gating on it client-side races the redirect. The
  // server fn (listAllTrialTenants) already enforces requireAdmin; treat
  // its success as admin, its "Admin role required" error as not-admin.
  const [gate, setGate] = useState<GateState>("checking");
  const [rows, setRows] = useState<TrialTenantRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("active");
  const [sendingFor, setSendingFor] = useState<Set<string>>(new Set());
  const [offersByTenant, setOffersByTenant] = useState<
    Map<string, OfferWithStatus[]>
  >(new Map());
  const [offerModalTenant, setOfferModalTenant] = useState<TrialTenantRow | null>(
    null,
  );
  const [sendingOfferId, setSendingOfferId] = useState<string | null>(null);

  // Unauthenticated bounce only — we KNOW immediately if there's no session.
  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      setGate("unauthenticated");
      void navigate({ to: "/login" });
    }
  }, [authLoading, session, navigate]);

  const refresh = async () => {
    const accessToken = session?.access_token;
    if (!accessToken) return;
    try {
      setLoadError(null);
      const result = await listAllTrialTenants({ data: { accessToken } });
      setRows(result.tenants);
      setGate("ok");
      // Fan out offer-load calls in parallel.
      const offerResults = await Promise.allSettled(
        result.tenants.map((t) =>
          listOffersForTenant({ data: { accessToken, tenantId: t.id } }).then(
            (r) => [t.id, r.offers] as const,
          ),
        ),
      );
      const next = new Map<string, OfferWithStatus[]>();
      for (const settled of offerResults) {
        if (settled.status === "fulfilled") {
          next.set(settled.value[0], settled.value[1]);
        }
      }
      setOffersByTenant(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/admin/i.test(msg)) {
        setGate("not-admin");
      } else {
        setGate("ok");
        setLoadError(msg);
      }
    }
  };

  const refreshOffersForTenant = async (tenantId: string) => {
    const accessToken = session?.access_token;
    if (!accessToken) return;
    try {
      const r = await listOffersForTenant({ data: { accessToken, tenantId } });
      setOffersByTenant((prev) => {
        const next = new Map(prev);
        next.set(tenantId, r.offers);
        return next;
      });
    } catch (err) {
      console.error("offer refresh failed:", err);
    }
  };

  const sendOffer = async (offerId: string, tenantId: string) => {
    const accessToken = session?.access_token;
    if (!accessToken) return;
    setSendingOfferId(offerId);
    try {
      const result = await sendOfferToTenant({ data: { accessToken, offerId } });
      if (result.ok) {
        toast.success("Offer sent.");
        await refreshOffersForTenant(tenantId);
      } else {
        toast.error(`Send failed: ${result.reason}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setSendingOfferId(null);
    }
  };

  useEffect(() => {
    if (!session?.access_token) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const now = Date.now();
    return rows.filter((r) => {
      const trialEndMs = new Date(r.trialEndsAt).getTime();
      const isActive = trialEndMs > now;
      if (filter === "active") return isActive;
      if (filter === "ended") return !isActive;
      return true;
    });
  }, [rows, filter]);

  const sendDrip = async (tenant: TrialTenantRow, day: DripDay) => {
    const accessToken = session?.access_token;
    if (!accessToken) return;
    const key = `${tenant.id}:${day}`;
    setSendingFor((prev) => new Set(prev).add(key));
    try {
      const result = await adminSendDripToTenant({
        data: { accessToken, tenantId: tenant.id, day },
      });
      if (result.ok) {
        toast.success(`Day-${day} drip sent to ${tenant.name}`);
        await refresh();
      } else {
        toast.error(`Send failed: ${result.reason}`);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Send failed.",
      );
    } finally {
      setSendingFor((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  if (authLoading || gate === "checking" || gate === "unauthenticated") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (gate === "not-admin") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-3">
          <h2 className="text-lg font-semibold">Admin only</h2>
          <p className="text-sm text-muted-foreground">
            This page is restricted to admin users. If you should have access,
            ask Grasshopper to add your user_id to the admin role.
          </p>
          <Link
            to="/app"
            className="inline-block text-sm text-emerald underline"
          >
            Back to workspace
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <PageHeader
        eyebrow="Admin"
        title="Refill trials"
        description="Every tenant in the Refill funnel + their drip state. Send-now for any drip that hasn't fired."
      />
      <div className="px-6 lg:px-10 py-6 space-y-5">
        <FilterStrip
          value={filter}
          onChange={setFilter}
          counts={countByFilter(rows)}
        />

        {loadError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {!filtered ? (
          <div className="text-sm text-muted-foreground">Loading trials…</div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            {filter === "ended"
              ? "No ended trials yet."
              : filter === "active"
                ? "No active trials yet."
                : "No tenants yet."}
          </div>
        ) : (
          <div className="rounded-lg border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Spa</TableHead>
                  <TableHead>Trial</TableHead>
                  <TableHead>Plan</TableHead>
                  {DRIP_DAYS.map((d) => (
                    <TableHead key={d} className="text-center">
                      D{d}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => (
                  <TrialRow
                    key={row.id}
                    row={row}
                    sendingFor={sendingFor}
                    offers={offersByTenant.get(row.id) ?? []}
                    sendingOfferId={sendingOfferId}
                    onSend={(day) => sendDrip(row, day)}
                    onOpenOfferModal={() => setOfferModalTenant(row)}
                    onSendOffer={(offerId) => sendOffer(offerId, row.id)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <RepliesPanel rows={filtered} />

        <p className="text-xs text-muted-foreground">
          Drip schedule fires daily at 09:00 UTC. Replies route through
          <code> reply+&lt;eventId&gt;@reply.openagentic.site</code> and land
          inline on the originating drip row.
        </p>
      </div>

      <OfferModal
        tenant={offerModalTenant}
        onClose={() => setOfferModalTenant(null)}
        onCreated={async (tenantId) => {
          setOfferModalTenant(null);
          await refreshOffersForTenant(tenantId);
        }}
        accessToken={session?.access_token ?? null}
      />
    </div>
  );
}

function OfferModal({
  tenant,
  onClose,
  onCreated,
  accessToken,
}: {
  tenant: TrialTenantRow | null;
  onClose: () => void;
  onCreated: (tenantId: string) => Promise<void>;
  accessToken: string | null;
}) {
  const [offerType, setOfferType] = useState<OfferType>("trial_extension");
  const [days, setDays] = useState(7);
  const [pct, setPct] = useState(8);
  const [durationMonths, setDurationMonths] = useState(3);
  const [usd, setUsd] = useState(100);
  const [description, setDescription] = useState("");
  const [validUntil, setValidUntil] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Reset form when tenant changes (modal re-opens).
  useEffect(() => {
    if (tenant) {
      setOfferType("trial_extension");
      setDays(7);
      setPct(8);
      setDurationMonths(3);
      setUsd(100);
      setDescription("");
      setValidUntil(defaultValidUntil());
    }
  }, [tenant]);

  const handleSave = async () => {
    if (!tenant || !accessToken) return;
    setSaving(true);
    try {
      let terms: Record<string, unknown>;
      switch (offerType) {
        case "trial_extension":
          terms = { days };
          break;
        case "revenue_share_discount":
          terms = { pct, durationMonths };
          break;
        case "flat_credit":
          terms = { usd };
          break;
        case "custom":
          if (!description.trim()) {
            toast.error("Description required for custom offers.");
            return;
          }
          terms = { description };
          break;
      }
      await createIncentiveOffer({
        data: {
          accessToken,
          tenantId: tenant.id,
          offerType,
          terms,
          validUntil: validUntil || null,
        },
      });
      toast.success(`Draft offer saved for ${tenant.name}`);
      await onCreated(tenant.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save offer.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={tenant !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add offer for {tenant?.name ?? ""}</DialogTitle>
          <DialogDescription>
            Saves as a draft. Send via the offer pill on the row when ready.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <label className="block">
            <span className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1.5 block">
              Offer type
            </span>
            <select
              value={offerType}
              onChange={(e) => setOfferType(e.target.value as OfferType)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              {/* revenue_share_discount retired — the pricing model is now
                  free + $5/booking, no revenue share. Type kept defined for
                  back-compat reads, but no longer creatable. */}
              {OFFER_TYPES.filter((t) => t !== "revenue_share_discount").map((t) => (
                <option key={t} value={t}>
                  {labelForOfferType(t)}
                </option>
              ))}
            </select>
          </label>

          {offerType === "trial_extension" && (
            <NumberInput
              label="Extension (days)"
              value={days}
              onChange={setDays}
              min={1}
              max={180}
            />
          )}
          {offerType === "revenue_share_discount" && (
            <div className="grid grid-cols-2 gap-3">
              <NumberInput
                label="Revenue share %"
                value={pct}
                onChange={setPct}
                min={0}
                max={100}
              />
              <NumberInput
                label="Duration (months)"
                value={durationMonths}
                onChange={setDurationMonths}
                min={1}
                max={36}
              />
            </div>
          )}
          {offerType === "flat_credit" && (
            <NumberInput
              label="Credit amount (USD)"
              value={usd}
              onChange={setUsd}
              min={1}
              max={100_000}
            />
          )}
          {offerType === "custom" && (
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1.5 block">
                Description
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Free-form offer copy, e.g. 'Lifetime grandfathered pricing if you commit by Q3.'"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </label>
          )}

          <label className="block">
            <span className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1.5 block">
              Valid until (optional)
            </span>
            <input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-emerald px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save draft
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1.5 block">
        {label}
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        min={min}
        max={max}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm tabular-nums"
      />
    </label>
  );
}

function labelForOfferType(t: OfferType): string {
  switch (t) {
    case "trial_extension":
      return "Trial extension";
    case "revenue_share_discount":
      return "Discounted revenue share";
    case "flat_credit":
      return "Flat credit";
    case "custom":
      return "Custom";
  }
}

function defaultValidUntil(): string {
  const d = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function RepliesPanel({ rows }: { rows: TrialTenantRow[] | null }) {
  // Flatten all replies across all tenants + all drips, newest first.
  const replies = useMemo(() => {
    if (!rows) return [];
    const out: {
      tenantId: string;
      tenantName: string;
      tenantSlug: string;
      day: DripDay;
      receivedAt: string;
      body: string;
    }[] = [];
    for (const row of rows) {
      for (const day of DRIP_DAYS) {
        const drip = row.drips[day];
        if (!drip?.replyText) continue;
        out.push({
          tenantId: row.id,
          tenantName: row.name,
          tenantSlug: row.slug,
          day,
          receivedAt: drip.replyReceivedAt ?? "",
          body: drip.replyText,
        });
      }
    }
    return out.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }, [rows]);

  if (!rows) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Recent replies</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {replies.length} total
        </span>
      </div>
      {replies.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-background px-4 py-6 text-center text-sm text-muted-foreground">
          No replies yet. They&apos;ll show up here as spa owners hit reply on
          Karen&apos;s drips.
        </div>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {replies.map((r) => (
            <div key={`${r.tenantId}:${r.day}`} className="p-4">
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <div className="text-sm">
                  <span className="font-medium">{r.tenantName}</span>
                  <span className="ml-2 text-xs text-muted-foreground font-mono">
                    {r.tenantSlug}
                  </span>
                  <span className="ml-2 inline-block text-[11px] uppercase tracking-wider text-emerald-700 font-semibold">
                    replied to Day {r.day}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  {r.receivedAt
                    ? new Date(r.receivedAt).toLocaleString()
                    : "—"}
                </div>
              </div>
              <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
                {r.body}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────

function FilterStrip({
  value,
  onChange,
  counts,
}: {
  value: Filter;
  onChange: (f: Filter) => void;
  counts: { all: number; active: number; ended: number };
}) {
  const opts: { id: Filter; label: string; count: number }[] = [
    { id: "active", label: "Active", count: counts.active },
    { id: "ended", label: "Ended", count: counts.ended },
    { id: "all", label: "All", count: counts.all },
  ];
  return (
    <div className="flex items-center gap-2">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
            value === o.id
              ? "bg-emerald text-paper border-emerald"
              : "bg-background text-muted-foreground border-border hover:text-foreground"
          }`}
        >
          {o.label}
          <span
            className={`text-[10px] tabular-nums ${
              value === o.id ? "opacity-80" : "opacity-60"
            }`}
          >
            {o.count}
          </span>
        </button>
      ))}
    </div>
  );
}

function TrialRow({
  row,
  sendingFor,
  offers,
  sendingOfferId,
  onSend,
  onOpenOfferModal,
  onSendOffer,
}: {
  row: TrialTenantRow;
  sendingFor: Set<string>;
  offers: OfferWithStatus[];
  sendingOfferId: string | null;
  onSend: (day: DripDay) => void;
  onOpenOfferModal: () => void;
  onSendOffer: (offerId: string) => void;
}) {
  const trialEnd = new Date(row.trialEndsAt);
  const isActive = trialEnd.getTime() > Date.now();
  return (
    <>
    <TableRow>
      <TableCell>
        <div className="font-medium">{row.name}</div>
        <div className="text-xs text-muted-foreground font-mono">
          {row.slug}.getrefill.app
        </div>
      </TableCell>
      <TableCell>
        <div className="text-sm">Day {row.trialDayNumber} of 30</div>
        <div className="text-xs text-muted-foreground">
          {isActive
            ? `ends ${trialEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
            : `ended ${trialEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
        </div>
      </TableCell>
      <TableCell>
        <span
          className={`inline-block text-xs rounded-full px-2 py-0.5 ${
            row.plan === "trial"
              ? "bg-muted text-muted-foreground"
              : "bg-emerald/10 text-emerald"
          }`}
        >
          {row.plan}
        </span>
      </TableCell>
      {DRIP_DAYS.map((day) => {
        const sent = row.drips[day];
        const pending = !sent && row.trialDayNumber >= day;
        const future = !sent && row.trialDayNumber < day;
        const key = `${row.id}:${day}`;
        const isSending = sendingFor.has(key);
        return (
          <TableCell key={day} className="text-center">
            {sent ? (
              <div className="inline-flex items-center gap-1">
                <span
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
                  title={`Sent ${new Date(sent.sentAt).toLocaleString()}`}
                >
                  <Check className="h-3.5 w-3.5" />
                </span>
                {sent.replyText && (
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-amber-700"
                    title={`Replied ${sent.replyReceivedAt ? new Date(sent.replyReceivedAt).toLocaleString() : ""}`}
                  >
                    <MessageSquare className="h-3 w-3" />
                  </span>
                )}
              </div>
            ) : pending ? (
              <button
                type="button"
                onClick={() => onSend(day)}
                disabled={isSending}
                title={`Send Day-${day} now`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-50 text-amber-700 hover:bg-amber-100 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isSending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
              </button>
            ) : future ? (
              <span
                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground"
                title={`Day ${day} not yet eligible`}
              >
                <Clock className="h-3.5 w-3.5" />
              </span>
            ) : null}
          </TableCell>
        );
      })}
    </TableRow>
    <TableRow className="bg-muted/20 hover:bg-muted/20">
      <TableCell colSpan={3 + DRIP_DAYS.length} className="py-2">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <Gift className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground font-medium">Offers</span>
          {offers.length === 0 ? (
            <span className="text-muted-foreground">none yet</span>
          ) : (
            offers.map((o) => (
              <OfferPill
                key={o.id}
                offer={o}
                isSending={sendingOfferId === o.id}
                onSend={() => onSendOffer(o.id)}
              />
            ))
          )}
          <button
            type="button"
            onClick={onOpenOfferModal}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-emerald hover:text-emerald transition"
          >
            <Plus className="h-3 w-3" />
            Add offer
          </button>
        </div>
      </TableCell>
    </TableRow>
    </>
  );
}

function OfferPill({
  offer,
  isSending,
  onSend,
}: {
  offer: OfferWithStatus;
  isSending: boolean;
  onSend: () => void;
}) {
  const summary = summarizeOfferTerms(offer);
  const status = offer.claimedAt
    ? "claimed"
    : offer.sentAt
      ? "sent"
      : "draft";
  const statusColor =
    status === "claimed"
      ? "bg-emerald-100 text-emerald-700"
      : status === "sent"
        ? "bg-sky-100 text-sky-700"
        : "bg-amber-100 text-amber-700";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${statusColor}`}>
      <span className="font-medium">{summary}</span>
      <span className="opacity-70">· {status}</span>
      {status === "draft" && (
        <button
          type="button"
          onClick={onSend}
          disabled={isSending}
          title="Send this offer to the tenant"
          className="ml-1 inline-flex items-center justify-center h-4 w-4 rounded-full bg-white/60 hover:bg-white transition disabled:opacity-40"
        >
          {isSending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
        </button>
      )}
    </span>
  );
}

function summarizeOfferTerms(offer: OfferWithStatus): string {
  const t = offer.terms;
  switch (offer.offerType) {
    case "trial_extension":
      return `+${Number((t as { days?: number }).days ?? 0)}d trial`;
    case "revenue_share_discount":
      return `${Number((t as { pct?: number }).pct ?? 0)}% × ${Number((t as { durationMonths?: number }).durationMonths ?? 0)}mo`;
    case "flat_credit":
      return `$${Number((t as { usd?: number }).usd ?? 0)} credit`;
    case "custom":
      return (t as { description?: string }).description?.slice(0, 40) ?? "custom";
    default:
      return offer.offerType;
  }
}

function countByFilter(rows: TrialTenantRow[] | null): {
  all: number;
  active: number;
  ended: number;
} {
  if (!rows) return { all: 0, active: 0, ended: 0 };
  const now = Date.now();
  let active = 0;
  let ended = 0;
  for (const r of rows) {
    if (new Date(r.trialEndsAt).getTime() > now) active += 1;
    else ended += 1;
  }
  return { all: rows.length, active, ended };
}
