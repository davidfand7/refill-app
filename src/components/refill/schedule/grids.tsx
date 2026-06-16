/**
 * Owner schedule grids — Day / Week / Month positioned calendar views +
 * shared ApptCard / BlockBand visual pieces (extracted in the v1.67.x
 * consolidation sprint). Prop-driven; behavior identical to before.
 */

import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { zonedWallClockToUtc } from "@/lib/scheduling-slots";
import { CalendarPlus, ChevronLeft, ChevronRight, Loader2, Plus, Ban, X, ZoomIn, ZoomOut } from "lucide-react";
import type {
  DayAppointment,
  DayBlock,
  DaySchedule,
  ProviderLite,
  RangeSchedule,
  WeeklyHoursRow,
} from "@/server/scheduling-owner.functions";
import {
  type View,
  type ServiceLite,
  ZOOM_LEVELS,
  DEFAULT_ZOOM_IDX,
  ZOOM_KEY,
  MIN_DAY_CARD_PX,
  MIN_WEEK_CARD_PX,
  WD_SHORT,
  PROVIDER_DOTS,
  providerDot,
  computeSpan,
  padWindow,
  hourMarks,
  groupByDay,
  groupBlocksByDay,
  snap5,
  minToHHMM,
  todayIso,
  addDays,
  addMonths,
  startOfMonth,
  mondayOf,
  fmtDayLabel,
  fmtWeekLabel,
  fmtMonthLabel,
  fmtHour,
  fmtTime,
  dayKey,
  localMinutes,
  anchorApptCards,
} from "@/components/refill/schedule/shared";

// ── Day grid (positioned, single column) ─────────────────────────────────────

export function DayGrid({
  day,
  tz,
  pxPerMin,
  onCancel,
  onEdit,
  onMove,
  onBook,
}: {
  day: DaySchedule;
  tz: string;
  pxPerMin: number;
  onCancel: (a: DayAppointment) => void;
  onEdit: (a: DayAppointment) => void;
  onMove: (appt: DayAppointment, startIso: string, providerId?: string) => void;
  onBook: (dateIso: string, time: string, providerId?: string) => void;
}) {
  const dragged = useRef<DayAppointment | null>(null);
  // Shared time window across every provider's band + all appts + all blocks.
  const win = useMemo(() => {
    let start = 24 * 60;
    let end = 0;
    let anyOpen = false;
    for (const band of Object.values(day.openByProvider)) {
      if (!band.isOpen) continue;
      anyOpen = true;
      start = Math.min(start, band.openMin);
      end = Math.max(end, band.closeMin);
    }
    if (!anyOpen) {
      start = 9 * 60;
      end = 17 * 60;
    }
    for (const a of day.appointments) {
      start = Math.min(start, localMinutes(a.startIso, tz));
      end = Math.max(end, localMinutes(a.endIso, tz));
    }
    for (const b of day.blocks) {
      start = Math.min(start, localMinutes(b.startIso, tz));
      end = Math.max(end, localMinutes(b.endIso, tz));
    }
    return padWindow(start, end);
  }, [day, tz]);

  const height = (win.end - win.start) * pxPerMin;
  const top = (iso: string) => (localMinutes(iso, tz) - win.start) * pxPerMin;
  const providers = day.providers;

  // Drop a dragged appointment at the pointer's time (and provider, if multi-col).
  function dropAt(
    e: { preventDefault: () => void; currentTarget: HTMLDivElement; clientY: number },
    providerId?: string,
  ) {
    e.preventDefault();
    const appt = dragged.current;
    dragged.current = null;
    if (!appt) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mins = snap5(win.start + (e.clientY - rect.top) / pxPerMin, win);
    const [y, mo, d] = day.dateIso.split("-").map((n) => parseInt(n, 10));
    const startIso = zonedWallClockToUtc(y, mo, d, Math.floor(mins / 60), mins % 60, tz).toISOString();
    onMove(appt, startIso, providerId);
  }
  const setDragged = (a: DayAppointment) => {
    dragged.current = a;
  };

  // ── Single provider: render exactly as before (loved layout, unchanged). ──
  if (providers.length <= 1) {
    const solo = providers[0];
    const band = (solo && day.openByProvider[solo.id]) ?? {
      isOpen: false,
      openMin: 9 * 60,
      closeMin: 17 * 60,
    };
    function bgClick(e: { currentTarget: HTMLDivElement; clientY: number }) {
      const rect = e.currentTarget.getBoundingClientRect();
      const mins = win.start + (e.clientY - rect.top) / pxPerMin;
      onBook(day.dateIso, minToHHMM(snap5(mins, win)), solo?.id);
    }
    const soloStack = anchorApptCards(day.appointments, tz, pxPerMin, win.start);
    return (
      <div className="rounded-xl border border-rule bg-white p-4">
        {!band.isOpen && <div className="mb-3 text-[12px] text-ink-faint">Closed this day (per business hours).</div>}
        <div
          className="relative cursor-pointer"
          style={{ height }}
          onClick={bgClick}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => dropAt(e, solo?.id)}
          title="Click an open time to book"
        >
          <div className="absolute inset-0 left-14 hover:bg-emerald-soft/10 transition-colors" />
          {hourMarks(win).map((m) => (
            <div key={m} className="absolute left-0 right-0 border-t border-rule/60" style={{ top: (m - win.start) * pxPerMin }}>
              <span className="absolute -top-2 left-0 text-[11px] text-ink-faint tabular-nums bg-white pr-1">{fmtHour(m)}</span>
            </div>
          ))}
          {band.isOpen && (
            <div className="absolute left-14 right-0 bg-emerald-soft/40 rounded" style={{ top: (band.openMin - win.start) * pxPerMin, height: (band.closeMin - band.openMin) * pxPerMin }} />
          )}
          {day.blocks.map((b) => (
            <BlockBand key={b.id} left="left-14" top={top(b.startIso)} height={Math.max(14, (localMinutes(b.endIso, tz) - localMinutes(b.startIso, tz)) * pxPerMin)} reason={b.reason} />
          ))}
          {day.appointments.map((a) => (
            <ApptCard key={a.id} a={a} tz={tz} basePx={56} lane={0} lanes={1} top={soloStack.topOf.get(a.id) ?? top(a.startIso)} height={soloStack.heightOf.get(a.id) ?? MIN_DAY_CARD_PX} onCancel={onCancel} onEdit={onEdit} onDragStartAppt={setDragged} />
          ))}
          {day.appointments.length === 0 && day.blocks.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-faint pointer-events-none">No bookings this day.</div>
          )}
        </div>
      </div>
    );
  }

  // ── Multiple providers: one column per provider, sharing the time axis. ──
  const compact = providers.length >= 3;
  const colMinPx = 150;
  // Pre-stack each column so the shared grid height fits the tallest column.
  const colData = providers.map((p) => {
    const band = day.openByProvider[p.id] ?? { isOpen: false, openMin: 9 * 60, closeMin: 17 * 60 };
    const colAppts = day.appointments.filter((a) => a.providerId === p.id);
    // Provider-specific blocks + whole-practice (null) blocks.
    const colBlocks = day.blocks.filter((b) => b.providerId === p.id || b.providerId === null);
    const stack = anchorApptCards(colAppts, tz, pxPerMin, win.start);
    return { p, band, colAppts, colBlocks, stack };
  });
  return (
    <div className="rounded-xl border border-rule bg-white p-3 overflow-x-auto">
      <div style={{ minWidth: 48 + providers.length * colMinPx }}>
        {/* Provider headers */}
        <div className="grid" style={{ gridTemplateColumns: `48px repeat(${providers.length}, 1fr)` }}>
          <div />
          {providers.map((p, i) => (
            <div key={p.id} className="flex items-center justify-center gap-1.5 py-1.5 border-b border-rule">
              <span className={cn("h-2 w-2 rounded-full shrink-0", providerDot(i))} />
              <span className="text-[12px] font-semibold text-ink truncate">{p.name}</span>
            </div>
          ))}
        </div>
        {/* Grid body */}
        <div className="relative grid" style={{ gridTemplateColumns: `48px repeat(${providers.length}, 1fr)`, height }}>
          {/* hour rail */}
          <div className="relative">
            {hourMarks(win).map((m) => (
              <div key={m} className="absolute right-1 text-[10px] text-ink-faint tabular-nums" style={{ top: (m - win.start) * pxPerMin - 6 }}>
                {fmtHour(m)}
              </div>
            ))}
          </div>
          {colData.map(({ p, band, colAppts, colBlocks, stack }) => {
            return (
              <div
                key={p.id}
                className="relative border-l border-rule/60 cursor-pointer hover:bg-emerald-soft/10 transition-colors"
                title={`Click an open time to book ${p.name}`}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const mins = win.start + (e.clientY - rect.top) / pxPerMin;
                  onBook(day.dateIso, minToHHMM(snap5(mins, win)), p.id);
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => dropAt(e, p.id)}
              >
                {hourMarks(win).map((m) => (
                  <div key={m} className="absolute left-0 right-0 border-t border-rule/40" style={{ top: (m - win.start) * pxPerMin }} />
                ))}
                {band.isOpen && (
                  <div className="absolute left-0 right-0 bg-emerald-soft/30" style={{ top: (band.openMin - win.start) * pxPerMin, height: (band.closeMin - band.openMin) * pxPerMin }} />
                )}
                {colBlocks.map((b) => (
                  <BlockBand key={b.id} left="left-0" top={top(b.startIso)} height={Math.max(10, (localMinutes(b.endIso, tz) - localMinutes(b.startIso, tz)) * pxPerMin)} reason={b.reason} compact />
                ))}
                {colAppts.map((a) => (
                  <ApptCard key={a.id} a={a} tz={tz} basePx={0} lane={0} lanes={1} top={stack.topOf.get(a.id) ?? top(a.startIso)} height={stack.heightOf.get(a.id) ?? MIN_DAY_CARD_PX} onCancel={onCancel} onEdit={onEdit} onDragStartAppt={setDragged} compact={compact} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Week grid (7 positioned columns sharing a time axis) ─────────────────────

export function WeekGrid({
  range,
  tz,
  pxPerMin,
  weekStart,
  providerId,
  onProviderChange,
  onCancel,
  onEdit,
  onMove,
  onBook,
  onPickDay,
}: {
  range: RangeSchedule;
  tz: string;
  pxPerMin: number;
  weekStart: string;
  providerId: string; // "all" or a providerId
  onProviderChange: (id: string) => void;
  onCancel: (a: DayAppointment) => void;
  onEdit: (a: DayAppointment) => void;
  onMove: (appt: DayAppointment, startIso: string, providerId?: string) => void;
  onBook: (dateIso: string, time: string) => void;
  onPickDay: (iso: string) => void;
}) {
  const dragged = useRef<DayAppointment | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const providers = range.providers;
  // Effective filter — fall back to "all" if the chosen provider is gone.
  const filter = providerId !== "all" && providers.some((p) => p.id === providerId) ? providerId : "all";

  // Effective weekly hours for the current filter: a specific provider's week,
  // or (for "all") the per-weekday union across every active provider.
  const hoursByDow = useMemo(() => {
    const m = new Map<number, WeeklyHoursRow>();
    if (filter !== "all") {
      for (const h of range.weeklyHoursByProvider[filter] ?? []) m.set(h.dayOfWeek, h);
      return m;
    }
    for (const rows of Object.values(range.weeklyHoursByProvider)) {
      for (const h of rows) {
        if (h.isClosed) continue;
        const cur = m.get(h.dayOfWeek);
        if (!cur || cur.isClosed) {
          m.set(h.dayOfWeek, { ...h });
        } else {
          cur.openMin = Math.min(cur.openMin, h.openMin);
          cur.closeMin = Math.max(cur.closeMin, h.closeMin);
        }
      }
    }
    return m;
  }, [range.weeklyHoursByProvider, filter]);

  const filteredAppts = useMemo(
    () => (filter === "all" ? range.appointments : range.appointments.filter((a) => a.providerId === filter)),
    [range.appointments, filter],
  );
  const apptsByDay = useMemo(() => groupByDay(filteredAppts, tz), [filteredAppts, tz]);
  const blocksByDay = useMemo(() => groupBlocksByDay(range.blocks, tz), [range.blocks, tz]);

  const win = useMemo(() => {
    let start = 24 * 60;
    let end = 0;
    for (const h of hoursByDow.values()) {
      if (h.isClosed) continue;
      start = Math.min(start, h.openMin);
      end = Math.max(end, h.closeMin);
    }
    if (end === 0) {
      start = 9 * 60;
      end = 17 * 60;
    }
    for (const a of filteredAppts) {
      start = Math.min(start, localMinutes(a.startIso, tz));
      end = Math.max(end, localMinutes(a.endIso, tz));
    }
    return padWindow(start, end);
  }, [hoursByDow, filteredAppts, tz]);

  const height = (win.end - win.start) * pxPerMin;
  const top = (iso: string) => (localMinutes(iso, tz) - win.start) * pxPerMin;
  const today = todayIso();

  // Drop a dragged appointment onto a day column at the pointer's time.
  function dropAt(
    e: { preventDefault: () => void; currentTarget: HTMLDivElement; clientY: number },
    dateIso: string,
  ) {
    e.preventDefault();
    const appt = dragged.current;
    dragged.current = null;
    if (!appt) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mins = snap5(win.start + (e.clientY - rect.top) / pxPerMin, win);
    const [y, mo, d] = dateIso.split("-").map((n) => parseInt(n, 10));
    const startIso = zonedWallClockToUtc(y, mo, d, Math.floor(mins / 60), mins % 60, tz).toISOString();
    onMove(appt, startIso); // week view keeps the same provider
  }
  const setDragged = (a: DayAppointment) => {
    dragged.current = a;
  };

  // Pre-stack each day so the shared grid height fits the busiest column.
  const weekData = days.map((d) => {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    const h = hoursByDow.get(dow);
    const dayAppts = apptsByDay.get(d) ?? [];
    const dayBlocks = blocksByDay.get(d) ?? [];
    const stack = anchorApptCards(dayAppts, tz, pxPerMin, win.start);
    return { d, dow, h, dayAppts, dayBlocks, stack };
  });

  return (
    <div>
      {providers.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <span className="text-[12px] text-ink-soft mr-1">Provider:</span>
          <button
            type="button"
            onClick={() => onProviderChange("all")}
            className={cn(
              "rounded-md border px-2.5 py-1 text-[12px] font-medium transition",
              filter === "all"
                ? "bg-emerald text-paper border-emerald"
                : "border-rule text-ink-soft hover:text-ink hover:border-emerald/40",
            )}
          >
            All
          </button>
          {providers.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onProviderChange(p.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition",
                filter === p.id
                  ? "bg-emerald text-paper border-emerald"
                  : "border-rule text-ink-soft hover:text-ink hover:border-emerald/40",
              )}
            >
              <span className={cn("h-2 w-2 rounded-full shrink-0", providerDot(i))} />
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-rule bg-white p-3 overflow-x-auto">
      <div className="min-w-[980px]">
        {/* Day headers */}
        <div className="grid" style={{ gridTemplateColumns: `48px repeat(7, 1fr)` }}>
          <div />
          {days.map((d) => {
            const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
            return (
              <button key={d} type="button" onClick={() => onPickDay(d)} className={cn("text-center py-1.5 border-b border-rule", d === today && "text-emerald font-semibold")}>
                <div className="text-[11px] uppercase tracking-wide text-ink-faint">{WD_SHORT[dow]}</div>
                <div className="text-[14px] text-ink">{parseInt(d.slice(8), 10)}</div>
              </button>
            );
          })}
        </div>
        {/* Grid body */}
        <div className="relative grid" style={{ gridTemplateColumns: `48px repeat(7, 1fr)`, height }}>
          {/* hour rail */}
          <div className="relative">
            {hourMarks(win).map((m) => (
              <div key={m} className="absolute right-1 text-[10px] text-ink-faint tabular-nums" style={{ top: (m - win.start) * pxPerMin - 6 }}>
                {fmtHour(m)}
              </div>
            ))}
          </div>
          {weekData.map(({ d, h, dayAppts, dayBlocks, stack }) => {
            return (
              <div
                key={d}
                className="relative border-l border-rule/60 cursor-pointer hover:bg-emerald-soft/10 transition-colors"
                title="Click an open time to book"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const mins = win.start + (e.clientY - rect.top) / pxPerMin;
                  onBook(d, minToHHMM(snap5(mins, win)));
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => dropAt(e, d)}
              >
                {hourMarks(win).map((m) => (
                  <div key={m} className="absolute left-0 right-0 border-t border-rule/40" style={{ top: (m - win.start) * pxPerMin }} />
                ))}
                {h && !h.isClosed && (
                  <div className="absolute left-0 right-0 bg-emerald-soft/30" style={{ top: (h.openMin - win.start) * pxPerMin, height: (h.closeMin - h.openMin) * pxPerMin }} />
                )}
                {dayBlocks.map((b) => (
                  <BlockBand key={b.id} left="left-0" top={top(b.startIso)} height={Math.max(10, (localMinutes(b.endIso, tz) - localMinutes(b.startIso, tz)) * pxPerMin)} reason={b.reason} compact />
                ))}
                {dayAppts.map((a) => (
                  <ApptCard key={a.id} a={a} tz={tz} basePx={0} lane={0} lanes={1} top={stack.topOf.get(a.id) ?? top(a.startIso)} height={stack.heightOf.get(a.id) ?? MIN_WEEK_CARD_PX} onCancel={onCancel} onEdit={onEdit} onDragStartAppt={setDragged} compact />
                ))}
              </div>
            );
          })}
        </div>
      </div>
      </div>
    </div>
  );
}

// ── Month grid (date cells, click → day) ─────────────────────────────────────

export function MonthGrid({
  range,
  tz,
  monthAnchor,
  gridStart,
  onPickDay,
}: {
  range: RangeSchedule;
  tz: string;
  monthAnchor: string;
  gridStart: string;
  onPickDay: (iso: string) => void;
}) {
  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart]);
  const apptsByDay = useMemo(() => groupByDay(range.appointments, tz), [range.appointments, tz]);
  const anchorMonth = monthAnchor.slice(0, 7);
  const today = todayIso();

  return (
    <div className="rounded-xl border border-rule bg-white p-3">
      <div className="grid grid-cols-7 mb-1">
        {WD_SHORT.map((w, i) => (
          <div key={i} className="text-center text-[11px] uppercase tracking-wide text-ink-faint py-1">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-rule/60 rounded-lg overflow-hidden">
        {cells.map((d) => {
          const inMonth = d.slice(0, 7) === anchorMonth;
          const appts = apptsByDay.get(d) ?? [];
          return (
            <button
              key={d}
              type="button"
              onClick={() => onPickDay(d)}
              className={cn(
                "min-h-[92px] bg-white text-left p-1.5 hover:bg-emerald-soft/20 transition flex flex-col gap-1",
                !inMonth && "bg-paper/40",
              )}
            >
              <span className={cn("text-[12px] tabular-nums self-end", inMonth ? "text-ink" : "text-ink-faint", d === today && "bg-emerald text-paper rounded-full w-5 h-5 flex items-center justify-center")}>
                {parseInt(d.slice(8), 10)}
              </span>
              <div className="flex flex-col gap-0.5">
                {appts.slice(0, 3).map((a) => (
                  <span key={a.id} className={cn("text-[10px] truncate rounded px-1 py-0.5", a.status === "held" ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800")}>
                    {fmtTime(a.startIso, tz)} {a.patientName ?? "Booked"}
                  </span>
                ))}
                {appts.length > 3 && <span className="text-[10px] text-ink-faint pl-1">+{appts.length - 3} more</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared visual pieces ─────────────────────────────────────────────────────

export function ApptCard({
  a,
  tz,
  basePx,
  lane = 0,
  lanes = 1,
  top,
  height,
  onCancel,
  onEdit,
  onDragStartAppt,
  compact,
}: {
  a: DayAppointment;
  tz: string;
  /** Left gutter to clear (the hour rail) before the lane area begins, in px. */
  basePx: number;
  /** This card's 0-indexed sub-column among overlapping appts. */
  lane?: number;
  /** Width divisor = peak concurrency of the overlap cluster. */
  lanes?: number;
  top: number;
  height: number;
  onCancel: (a: DayAppointment) => void;
  onEdit: (a: DayAppointment) => void;
  onDragStartAppt?: (a: DayAppointment) => void;
  compact?: boolean;
}) {
  const held = a.status === "held";
  // Side-by-side lane layout: each card occupies 1/lanes of the content width
  // (the column minus the rail gutter), offset by its lane. A small gap keeps
  // overlapping cards visually distinct. lanes=1 → effectively full width.
  const GAP_PX = lanes > 1 ? 3 : 0;
  const frac = lane / lanes;
  const left = `calc(${basePx}px + ${frac} * (100% - ${basePx}px))`;
  const width = `calc(${1 / lanes} * (100% - ${basePx}px) - ${GAP_PX}px)`;
  // 1px hairline gap below each card so vertically-adjacent (back-to-back)
  // bookings read as distinct instead of merging into one block.
  const drawnHeight = Math.max(14, height - 1);
  const treatment = a.treatment?.trim() || null;
  // Tall enough for a 2nd line (name + "time · treatment"); otherwise the
  // treatment rides inline on the name line and time is implied by position.
  const twoLine = height >= 36;
  return (
    <div
      draggable={!held}
      className={cn(
        "absolute rounded-md border px-2 py-0.5 shadow-sm overflow-hidden group cursor-pointer",
        held ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200",
      )}
      style={{ top, height: drawnHeight, left, width }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!held) onEdit(a);
      }}
      onDragStart={(e) => {
        if (held) return;
        e.dataTransfer.effectAllowed = "move";
        onDragStartAppt?.(a);
      }}
      title={held ? undefined : "Double-click to edit · drag to move"}
    >
      <div className={cn("flex justify-between gap-1", twoLine ? "items-start" : "h-full items-center")}>
        <div className="min-w-0">
          <div className={cn("font-semibold text-ink truncate leading-tight", compact ? "text-[11px]" : "text-[12px]")}>
            {a.patientName ?? (held ? "Hold" : "Booked")}
            {!twoLine && treatment && (
              <span className="font-normal text-ink-soft"> · {treatment}</span>
            )}
          </div>
          {twoLine && (
            <div className="text-[11px] text-ink-soft leading-tight truncate">
              <span className="tabular-nums">
                {compact ? fmtTime(a.startIso, tz) : `${fmtTime(a.startIso, tz)}–${fmtTime(a.endIso, tz)}`}
              </span>
              {treatment && ` · ${treatment}`}
              {held && " · holding"}
            </div>
          )}
        </div>
        {!held && (
          <button type="button" onClick={(e) => { e.stopPropagation(); onCancel(a); }} className="opacity-0 group-hover:opacity-100 transition text-ink-faint hover:text-bad shrink-0" aria-label="Cancel appointment">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

export function BlockBand({ left, top, height, reason, compact }: { left: string; top: number; height: number; reason: string | null; compact?: boolean }) {
  return (
    <div
      className={cn("absolute right-0 rounded bg-[repeating-linear-gradient(45deg,#e7e1d6,#e7e1d6_6px,#f3ede2_6px,#f3ede2_12px)] border border-rule cursor-default", left)}
      style={{ top, height }}
      onClick={(e) => e.stopPropagation()}
    >
      {!compact && <span className="absolute top-0.5 left-2 text-[11px] text-ink-soft">{reason ?? "Blocked"}</span>}
    </div>
  );
}
