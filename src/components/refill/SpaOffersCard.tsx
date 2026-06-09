/**
 * Spa-authored offers — the owner writes their OWN cross-sell offers, a
 * first-class peer to manufacturer promos. Same table, same at-booking badge,
 * same $5 cross_sell_addon win pipeline. Match is by service name.
 *
 * Self-contained card (accessToken + viewAsUserId props only) so it can mount in
 * more than one Solution: it lives in Promos → Reward signals AND as a tab in the
 * Calendar Solution (the offers badge at booking, so Calendar is a natural home).
 * Both surfaces read/write the same offers — one room, two doors.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Sparkles, Tag, Trash2 } from "lucide-react";
import { listPromoOffers, createSpaOffer, deleteSpaOffer } from "@/server/refill-promo-calendar.functions";
import { listServicesFn, type Service } from "@/server/refill-catalog";
import type { PromoOffer } from "@/lib/promo-calendar";

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
      {children}
    </label>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  });
}

function fmtWindow(startsOn: string | null, endsOn: string | null): string {
  if (!startsOn && !endsOn) return "· ongoing";
  if (startsOn && endsOn) return `· ${fmtDate(startsOn)}–${fmtDate(endsOn)}`;
  if (endsOn) return `· through ${fmtDate(endsOn)}`;
  return `· from ${fmtDate(startsOn!)}`;
}

export function SpaOffersCard({
  accessToken,
  viewAsUserId,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [offers, setOffers] = useState<PromoOffer[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [serviceName, setServiceName] = useState("");
  const [discount, setDiscount] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const [all, svc] = await Promise.all([
        listPromoOffers({ data: { accessToken, viewAsUserId } }),
        listServicesFn({ data: { accessToken, viewAsUserId } }),
      ]);
      setOffers(all.filter((o) => o.source === "spa"));
      // Only services a patient can actually book can carry a cross-sell offer
      // that fires — exclude non-bookable rows (e.g. category placeholders).
      setServices(svc.filter((s) => s.onlineBookable));
    } catch {
      /* leave card empty on error */
    }
  }, [accessToken, viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (!accessToken || !serviceName) {
      toast.error("Pick a service for the offer.");
      return;
    }
    const trimmed = discount.trim();
    const d = trimmed ? Number(trimmed) : null;
    if (trimmed && (!Number.isFinite(d) || (d as number) <= 0)) {
      toast.error("Enter a dollar amount, or leave it blank.");
      return;
    }
    if (startsOn && endsOn && endsOn < startsOn) {
      toast.error("The end date is before the start date.");
      return;
    }
    setBusy(true);
    try {
      await createSpaOffer({
        data: {
          accessToken,
          viewAsUserId,
          serviceName,
          discountUsd: d,
          startsOn: startsOn || null,
          endsOn: endsOn || null,
          title: label.trim() || undefined,
        },
      });
      toast.success("Offer added — it badges that service at booking.");
      setServiceName("");
      setDiscount("");
      setStartsOn("");
      setEndsOn("");
      setLabel("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add the offer.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id?: string) {
    if (!accessToken || !id) return;
    try {
      await deleteSpaOffer({ data: { accessToken, viewAsUserId, offerId: id } });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove the offer.");
    }
  }

  return (
    <div className="rounded-2xl border border-rule bg-paper/30 p-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 text-sm font-semibold text-ink"
      >
        <Sparkles className="h-4 w-4 text-amber" />
        Your own offers — author a cross-sell
        {offers.length > 0 && (
          <span className="rounded-full bg-amber-soft px-2 py-0.5 text-[10.5px] font-semibold text-amber">
            {offers.length}
          </span>
        )}
        <span className="ml-auto text-[11px] font-normal text-ink-faint">
          {open ? "hide" : "add"}
        </span>
      </button>

      <p className="mt-2 text-[11px] text-ink-faint">
        Not from a manufacturer — your own upsell. Pick one of your services,
        set the discount, and it badges that service at booking just like a
        manufacturer promo — and earns the same $5 when a matched patient books it.
      </p>

      {open && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <Lbl>Service</Lbl>
              <select
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                disabled={services.length === 0}
                className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30 disabled:opacity-60"
              >
                <option value="">Choose a service…</option>
                {services.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
              {services.length === 0 && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  No bookable services yet — turn on online booking for a service
                  (Calendar → Online booking) and it'll show up here.
                </p>
              )}
            </div>
            <div>
              <Lbl>Discount ($)</Lbl>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                placeholder="50"
                className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
              />
            </div>
            <div>
              <Lbl>Custom label (optional)</Lbl>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="auto: “$50 off …”"
                className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
              />
            </div>
            <div>
              <Lbl>Starts (optional)</Lbl>
              <input
                type="date"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
                className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
              />
            </div>
            <div>
              <Lbl>Ends (optional)</Lbl>
              <input
                type="date"
                value={endsOn}
                onChange={(e) => setEndsOn(e.target.value)}
                className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !serviceName}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber px-4 py-2 text-sm font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add offer
          </button>
        </div>
      )}

      {offers.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {offers.map((o) => (
            <li
              key={o.id}
              className="flex items-center gap-2 rounded-lg border border-rule bg-white px-3 py-2 text-[12.5px]"
            >
              <Tag className="h-3.5 w-3.5 text-amber shrink-0" />
              <span className="font-medium text-ink">{o.title}</span>
              <span className="text-ink-faint">
                {fmtWindow(o.startsOn, o.endsOn)}
              </span>
              <button
                type="button"
                onClick={() => void remove(o.id)}
                className="ml-auto text-ink-faint hover:text-rose transition"
                aria-label="Remove offer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
