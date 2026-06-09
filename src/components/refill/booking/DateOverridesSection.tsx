/**
 * Date-specific availability overrides (v1.77.0). Sits under Provider hours and
 * follows the same selected provider: override that provider's weekly hours for
 * a single calendar date (a holiday closure, or different hours just that day).
 * Partial-day time-off still uses Block on the Schedule tab.
 */

import { CalendarRange, ChevronDown, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TimeSelect } from "@/components/refill/TimeSelect";
import type { BookingSettings } from "@/components/refill/booking/useBookingSettings";
import { useSectionCollapse } from "@/components/refill/booking/useSectionCollapse";

/** "2026-07-03" → "Fri, Jul 3, 2026" (parsed as a plain calendar date, no tz drift). */
function fmtDate(d: string): string {
  const [y, m, day] = d.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !day) return d;
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function DateOverridesSection({ bk }: { bk: BookingSettings }) {
  const {
    draft, activeProviders, selProviderName,
    selDateOverrides, selProviderId,
    addingOverride, setAddingOverride, ovDate, setOvDate, ovClosed, setOvClosed,
    ovRange, setOvRange, ovEndDate, setOvEndDate,
    ovOpen, setOvOpen, ovClose, setOvClose, ovBusy,
    onAddDateOverride, onRemoveDateOverride,
  } = bk;
  if (!draft) return null;
  const multi = activeProviders.length > 1;
  const { open, toggle } = useSectionCollapse("date-overrides");
  const today = new Date().toISOString().slice(0, 10);

  return (
    <section className="rounded-xl border border-rule bg-white px-5 py-4">
      <button type="button" onClick={toggle} className="flex w-full items-center gap-2 text-left">
        <ChevronDown className={cn("h-4 w-4 text-ink-faint transition-transform shrink-0", open ? "" : "-rotate-90")} />
        <CalendarRange className="h-4 w-4 text-emerald shrink-0" />
        <h3 className="text-[14px] font-semibold text-ink">Date-specific hours</h3>
      </button>
      {open && (<>
      <p className="text-[12px] text-ink-soft mb-3 mt-1 leading-relaxed">
        Override {multi ? <strong>{selProviderName}</strong> : "your"}
        {multi ? "’s" : ""} weekly hours for a single date — or check <strong>Range</strong> for a
        span (a holiday closure, a vacation week, or different hours those days). (Use{" "}
        <strong>Block</strong> on the Schedule for a partial-day time-off.)
      </p>

      {selDateOverrides.length > 0 && (
        <ul className="divide-y divide-rule/60 mb-3">
          {selDateOverrides.map((o) => (
            <li key={o.id} className="flex items-center gap-2 py-2">
              <span className="text-[13px] font-medium text-ink w-44 shrink-0">{fmtDate(o.date)}</span>
              {o.isClosed ? (
                <span className="text-[12px] font-semibold text-bad">Closed</span>
              ) : (
                <span className="text-[13px] text-ink-soft tabular-nums">
                  {o.openTime ? to12h(o.openTime) : "?"} – {o.closeTime ? to12h(o.closeTime) : "?"}
                </span>
              )}
              <button
                type="button"
                onClick={() => void onRemoveDateOverride(selProviderId, o.id)}
                className="ml-auto shrink-0 text-ink-faint hover:text-bad transition p-1"
                aria-label="Remove override"
                title="Remove this date override"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {addingOverride ? (
        <div className="rounded-lg border border-rule/70 bg-paper/40 px-3 py-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                {ovRange ? "From" : "Date"}
              </label>
              <input
                type="date"
                value={ovDate}
                min={today}
                onChange={(e) => setOvDate(e.target.value)}
                className="rounded-md border border-rule bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
              />
            </div>
            {ovRange && (
              <div>
                <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                  To
                </label>
                <input
                  type="date"
                  value={ovEndDate}
                  min={ovDate || today}
                  onChange={(e) => setOvEndDate(e.target.value)}
                  className="rounded-md border border-rule bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                />
              </div>
            )}
            <label className="flex items-center gap-1.5 text-[13px] text-ink cursor-pointer pb-1.5">
              <input
                type="checkbox"
                checked={ovRange}
                onChange={(e) => {
                  setOvRange(e.target.checked);
                  if (!e.target.checked) setOvEndDate("");
                }}
                className="h-3.5 w-3.5 rounded border-rule accent-emerald"
              />
              Range
            </label>
            <label className="flex items-center gap-1.5 text-[13px] text-ink cursor-pointer pb-1.5">
              <input
                type="checkbox"
                checked={ovClosed}
                onChange={(e) => setOvClosed(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-rule accent-emerald"
              />
              Closed all day
            </label>
            {!ovClosed && (
              <div className="flex items-end gap-1.5">
                <div>
                  <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                    Open
                  </label>
                  <TimeSelect
                    value={ovOpen}
                    onChange={setOvOpen}
                    className="rounded-md border border-rule bg-white px-2 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                  />
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1 block">
                    Close
                  </label>
                  <TimeSelect
                    value={ovClose}
                    onChange={setOvClose}
                    className="rounded-md border border-rule bg-white px-2 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onAddDateOverride()}
              disabled={ovBusy || !ovDate || (ovRange && !ovEndDate)}
              className="inline-flex items-center gap-1 rounded-md bg-emerald px-3 py-1.5 text-[13px] font-medium text-paper hover:opacity-95 transition disabled:opacity-50"
            >
              {ovBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Save
            </button>
            <button
              type="button"
              onClick={() => setAddingOverride(false)}
              className="rounded-md border border-rule px-3 py-1.5 text-[13px] text-ink-soft hover:text-ink transition"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setAddingOverride(true);
            setOvClosed(false);
            setOvRange(false);
            setOvEndDate("");
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
        >
          <Plus className="h-3.5 w-3.5" /> Add date override
        </button>
      )}
      </>)}
    </section>
  );
}
