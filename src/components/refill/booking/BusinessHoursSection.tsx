/**
 * Business-hours section of the booking-settings page (extracted in the
 * v1.67.x consolidation sprint). Per-provider weekly hours with a bulk
 * select-days → apply editor. Pure presentation: all state + mutations are
 * owned by the page and passed in, so behavior is identical to before.
 */

import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { TimeSelect } from "@/components/refill/TimeSelect";
import type { ProviderRow, SchedulingHoursDraft } from "@/server/scheduling-settings.functions";

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABELS: Record<number, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

export function BusinessHoursSection({
  activeProviders,
  selProviderId,
  setSelProviderId,
  selProviderName,
  selHours,
  selDays,
  setSelDays,
  bulkOpen,
  setBulkOpen,
  bulkClose,
  setBulkClose,
  applyHoursToSelected,
  setSelectedClosed,
  patchDay,
  toggleSelDay,
}: {
  activeProviders: ProviderRow[];
  selProviderId: string;
  setSelProviderId: (id: string) => void;
  selProviderName: string;
  selHours: SchedulingHoursDraft[];
  selDays: Set<number>;
  setSelDays: (s: Set<number>) => void;
  bulkOpen: string;
  setBulkOpen: (v: string) => void;
  bulkClose: string;
  setBulkClose: (v: string) => void;
  applyHoursToSelected: () => void;
  setSelectedClosed: () => void;
  patchDay: (dayOfWeek: number, patch: Partial<SchedulingHoursDraft>) => void;
  toggleSelDay: (dow: number) => void;
}) {
  return (
    <section id="provider-hours" className="scroll-mt-24 rounded-xl border border-rule bg-white px-5 py-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-emerald" />
          <h3 className="text-[14px] font-semibold text-ink">
            {activeProviders.length > 1 ? "Provider hours" : "Business hours"}
          </h3>
        </div>
        {activeProviders.length > 1 && (
          <select
            value={selProviderId}
            onChange={(e) => setSelProviderId(e.target.value)}
            className="rounded-md border border-rule bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
          >
            {activeProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {activeProviders.length > 1 && (
        <p className="text-[12px] text-ink-soft mb-3 -mt-1">
          Editing hours for <strong>{selProviderName}</strong>. Each provider has their own
          week.
        </p>
      )}

      {/* Bulk edit: select days → apply hours */}
      <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-rule/60 text-[12px]">
        <span className="text-ink-soft">Select:</span>
        <button type="button" onClick={() => setSelDays(new Set([1, 2, 3, 4, 5]))} className="rounded border border-rule px-2 py-1 text-ink-soft hover:text-ink hover:border-emerald/40 transition">Weekdays</button>
        <button type="button" onClick={() => setSelDays(new Set([0, 1, 2, 3, 4, 5, 6]))} className="rounded border border-rule px-2 py-1 text-ink-soft hover:text-ink hover:border-emerald/40 transition">All</button>
        {selDays.size > 0 && (
          <button type="button" onClick={() => setSelDays(new Set())} className="rounded border border-rule px-2 py-1 text-ink-soft hover:text-ink hover:border-emerald/40 transition">Clear</button>
        )}
        {selDays.size > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            <span className="text-emerald font-medium mr-1">{selDays.size} day{selDays.size === 1 ? "" : "s"} →</span>
            <TimeSelect value={bulkOpen} onChange={setBulkOpen} className="rounded-md border border-rule bg-white px-2 py-1 text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums" />
            <TimeSelect value={bulkClose} onChange={setBulkClose} className="rounded-md border border-rule bg-white px-2 py-1 text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums" />
            <button type="button" onClick={applyHoursToSelected} className="rounded-md bg-emerald px-2.5 py-1 font-medium text-paper hover:opacity-95 transition">Apply</button>
            <button type="button" onClick={setSelectedClosed} className="rounded-md border border-rule px-2.5 py-1 text-ink-soft hover:text-ink transition">Set closed</button>
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        {DAY_ORDER.map((dow) => {
          const h = selHours.find((x) => x.dayOfWeek === dow);
          if (!h) return null;
          return (
            <div
              key={dow}
              className={cn(
                "grid grid-cols-[110px_1fr] sm:grid-cols-[150px_auto_auto_1fr] items-center gap-2 py-1.5 px-1 rounded-md",
                selDays.has(dow) && "bg-emerald-soft/20",
              )}
            >
              <label className="flex items-center gap-2 text-[13px] font-medium text-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={selDays.has(dow)}
                  onChange={() => toggleSelDay(dow)}
                  className="h-3.5 w-3.5 rounded border-rule accent-emerald"
                />
                {DAY_LABELS[dow]}
              </label>
              {h.isClosed ? (
                <span className="text-[13px] text-ink-faint sm:col-span-2">Closed</span>
              ) : (
                <>
                  <TimeSelect
                    value={h.openTime}
                    onChange={(v) => patchDay(dow, { openTime: v })}
                    className="rounded-md border border-rule bg-white px-2 py-1.5 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                  />
                  <TimeSelect
                    value={h.closeTime}
                    onChange={(v) => patchDay(dow, { closeTime: v })}
                    className="rounded-md border border-rule bg-white px-2 py-1.5 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
                  />
                </>
              )}
              <label className="flex items-center justify-end gap-1.5 text-[12px] text-ink-soft">
                <input
                  type="checkbox"
                  checked={h.isClosed}
                  onChange={(e) => patchDay(dow, { isClosed: e.target.checked })}
                  className="h-3.5 w-3.5 rounded border-rule accent-emerald"
                />
                Closed
              </label>
            </div>
          );
        })}
      </div>
    </section>
  );
}
