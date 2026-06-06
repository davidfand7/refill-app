/**
 * /app/refill/schedule — owner calendar (v1.48.6).
 *
 * Day / Week / Month views. Day = positioned time grid; Week = 7 positioned
 * columns sharing a time axis; Month = a clickable date grid (cell → day view).
 * Manual book, block-off, and cancel work from any view. Times render in the
 * practice timezone. Manual book is EXCLUDE-guarded server-side.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CalendarPlus, ChevronLeft, ChevronRight, Loader2, Plus, Ban, X, ZoomIn, ZoomOut } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { zonedWallClockToUtc } from "@/lib/scheduling-slots";
import {
  getDayScheduleFn,
  getRangeScheduleFn,
  ownerCreateAppointmentFn,
  ownerUpdateAppointmentFn,
  ownerCreateBlockFn,
  ownerCancelAppointmentFn,
  type DaySchedule,
  type DayAppointment,
  type DayBlock,
  type ProviderLite,
  type RangeSchedule,
  type WeeklyHoursRow,
} from "@/server/scheduling-owner.functions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { TimeSelect } from "@/components/refill/TimeSelect";

export const Route = createFileRoute("/app/refill/schedule")({
  component: SchedulePage,
});

type View = "day" | "week" | "month";
type ServiceLite = { id: string; name: string; durationMin: number };

// Zoom = pixels-per-minute for the positioned grids. Default is "comfortable"
// so a 30-min appt is tall enough to show name + time without clipping.
const ZOOM_LEVELS = [0.7, 1.0, 1.4, 2.0, 2.8];
const DEFAULT_ZOOM_IDX = 2; // 1.4 px/min
const ZOOM_KEY = "refill.schedule.zoom";
// Minimum card heights so a short appointment is still tall enough to show
// name + time without clipping (longer appts size by their real duration).
const MIN_DAY_CARD_PX = 40;
const MIN_WEEK_CARD_PX = 40;
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Per-provider header accent dot (cards/bands stay emerald — the column + name
// identify the provider; this is a small additive touch, not a restyle).
const PROVIDER_DOTS = [
  "bg-emerald",
  "bg-sky-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-orange-500",
];
function providerDot(i: number): string {
  return PROVIDER_DOTS[i % PROVIDER_DOTS.length];
}

function SchedulePage() {
  const membership = useTenantMembership();
  const viewAsUserId = membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [view, setView] = useState<View>("day");
  const [dateIso, setDateIso] = useState<string>(todayIso());
  const [loading, setLoading] = useState(true);
  const [day, setDay] = useState<DaySchedule | null>(null);
  const [range, setRange] = useState<RangeSchedule | null>(null);
  const [bookSeed, setBookSeed] = useState<{ date: string; time: string; providerId?: string } | null>(
    null,
  );
  // Week view provider filter ("all" or a providerId).
  const [weekProviderId, setWeekProviderId] = useState<string>("all");
  const [blockOpen, setBlockOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<DayAppointment | null>(null);
  const [editTarget, setEditTarget] = useState<DayAppointment | null>(null);
  const [zoomIdx, setZoomIdx] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_ZOOM_IDX;
    const v = parseInt(window.localStorage.getItem(ZOOM_KEY) ?? "", 10);
    return Number.isFinite(v) && v >= 0 && v < ZOOM_LEVELS.length ? v : DEFAULT_ZOOM_IDX;
  });
  function setZoom(next: number) {
    const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, next));
    setZoomIdx(clamped);
    if (typeof window !== "undefined") window.localStorage.setItem(ZOOM_KEY, String(clamped));
  }
  const dayPpm = ZOOM_LEVELS[zoomIdx];
  const weekPpm = ZOOM_LEVELS[zoomIdx] * 0.7;

  // The visible date span (for week/month range loads).
  const span = useMemo(() => computeSpan(view, dateIso), [view, dateIso]);

  const load = useCallback(async () => {
    if (membership.status !== "tenant") return;
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Please sign in.");
      if (view === "day") {
        const r = await getDayScheduleFn({ data: { accessToken: token, viewAsUserId, dateIso } });
        setDay(r);
      } else {
        const r = await getRangeScheduleFn({
          data: {
            accessToken: token,
            viewAsUserId,
            fromDate: span.fromDate,
            toDateExclusive: span.toDateExclusive,
          },
        });
        setRange(r);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load the schedule.");
    } finally {
      setLoading(false);
    }
  }, [membership.status, viewAsUserId, view, dateIso, span.fromDate, span.toDateExclusive]);

  useEffect(() => {
    void load();
  }, [load]);

  const tz = (view === "day" ? day?.timezone : range?.timezone) ?? "America/Los_Angeles";
  const services: ServiceLite[] = (view === "day" ? day?.services : range?.services) ?? [];
  const providers: ProviderLite[] = (view === "day" ? day?.providers : range?.providers) ?? [];

  /** Drag-to-move: reschedule (and, in multi-column day, reassign provider). */
  async function onMove(appt: DayAppointment, startIso: string, providerId?: string) {
    // No-op if nothing changed.
    if (appt.startIso === startIso && (providerId === undefined || providerId === appt.providerId)) {
      return;
    }
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Please sign in.");
      const r = await ownerUpdateAppointmentFn({
        data: { accessToken: token, viewAsUserId, appointmentId: appt.id, startIso, providerId },
      });
      if (!r.ok) toast.error(r.reason);
      else toast.success("Appointment moved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't move the appointment.");
    } finally {
      void load();
    }
  }

  function navPrev() {
    setDateIso((d) => (view === "day" ? addDays(d, -1) : view === "week" ? addDays(d, -7) : addMonths(d, -1)));
  }
  function navNext() {
    setDateIso((d) => (view === "day" ? addDays(d, 1) : view === "week" ? addDays(d, 7) : addMonths(d, 1)));
  }

  const label =
    view === "day"
      ? fmtDayLabel(dateIso)
      : view === "week"
        ? fmtWeekLabel(span.fromDate, span.toDateExclusive)
        : fmtMonthLabel(dateIso);

  if (membership.status !== "tenant") {
    return (
      <div className="min-h-screen bg-background">
        <PageHeader title="Schedule" description="Your day at a glance." />
        <div className="px-6 lg:px-10 py-10 text-[14px] text-ink-soft">
          Use the persona switcher (upper-right) to view as a spa.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader title="Schedule" description="Bookings, holds, and blocked time — day, week, or month." />

      <div className="px-6 lg:px-10 py-4 max-w-6xl w-full mx-auto">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={navPrev} className="rounded-md border border-rule p-1.5 text-ink-soft hover:text-ink hover:border-emerald/40 transition" aria-label="Previous">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setDateIso(todayIso())} className="rounded-md border border-rule px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition">
              Today
            </button>
            <button type="button" onClick={navNext} className="rounded-md border border-rule p-1.5 text-ink-soft hover:text-ink hover:border-emerald/40 transition" aria-label="Next">
              <ChevronRight className="h-4 w-4" />
            </button>
            <span className="ml-2 text-[15px] font-semibold text-ink">{label}</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Zoom (positioned views only) */}
            {view !== "month" && (
              <div className="inline-flex items-center rounded-md border border-rule overflow-hidden">
                <button type="button" onClick={() => setZoom(zoomIdx - 1)} disabled={zoomIdx === 0} className="p-1.5 text-ink-soft hover:text-ink disabled:opacity-30 transition" aria-label="Zoom out">
                  <ZoomOut className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => setZoom(zoomIdx + 1)} disabled={zoomIdx === ZOOM_LEVELS.length - 1} className="p-1.5 text-ink-soft hover:text-ink disabled:opacity-30 transition border-l border-rule" aria-label="Zoom in">
                  <ZoomIn className="h-4 w-4" />
                </button>
              </div>
            )}
            {/* View toggle */}
            <div className="inline-flex rounded-md border border-rule overflow-hidden">
              {(["day", "week", "month"] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={cn(
                    "px-3 py-1.5 text-[13px] font-medium capitalize transition",
                    view === v ? "bg-emerald text-paper" : "text-ink-soft hover:text-ink",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setBlockOpen(true)} className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition">
              <Ban className="h-3.5 w-3.5" /> Block
            </button>
            <button type="button" onClick={() => setBookSeed({ date: dateIso, time: "09:00" })} className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition">
              <CalendarPlus className="h-3.5 w-3.5" /> Add booking
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-[14px] text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading schedule…
          </div>
        ) : view === "day" && day ? (
          <DayGrid
            day={day}
            tz={tz}
            pxPerMin={dayPpm}
            onCancel={setCancelTarget}
            onEdit={setEditTarget}
            onMove={onMove}
            onBook={(d, t, pid) => setBookSeed({ date: d, time: t, providerId: pid })}
          />
        ) : view === "week" && range ? (
          <WeekGrid
            range={range}
            tz={tz}
            pxPerMin={weekPpm}
            weekStart={span.fromDate}
            providerId={weekProviderId}
            onProviderChange={setWeekProviderId}
            onCancel={setCancelTarget}
            onEdit={setEditTarget}
            onMove={onMove}
            onBook={(d, t) =>
              setBookSeed({
                date: d,
                time: t,
                providerId: weekProviderId === "all" ? undefined : weekProviderId,
              })
            }
            onPickDay={(iso) => {
              setDateIso(iso);
              setView("day");
            }}
          />
        ) : view === "month" && range ? (
          <MonthGrid
            range={range}
            tz={tz}
            monthAnchor={dateIso}
            gridStart={span.fromDate}
            onPickDay={(iso) => {
              setDateIso(iso);
              setView("day");
            }}
          />
        ) : null}
      </div>

      <BookDialog open={!!bookSeed} initialDate={bookSeed?.date ?? dateIso} initialTime={bookSeed?.time ?? "09:00"} initialProviderId={bookSeed?.providerId} providers={providers} onClose={() => setBookSeed(null)} services={services} timezone={tz} viewAsUserId={viewAsUserId} onBooked={() => { setBookSeed(null); void load(); }} />
      <BlockDialog open={blockOpen} onClose={() => setBlockOpen(false)} timezone={tz} dateIso={dateIso} viewAsUserId={viewAsUserId} onBlocked={() => { setBlockOpen(false); void load(); }} />
      <CancelDialog appt={cancelTarget} tz={tz} viewAsUserId={viewAsUserId} onClose={() => setCancelTarget(null)} onCancelled={() => { setCancelTarget(null); void load(); }} />
      <EditDialog appt={editTarget} tz={tz} providers={providers} viewAsUserId={viewAsUserId} onClose={() => setEditTarget(null)} onSaved={() => { setEditTarget(null); void load(); }} onCancelAppt={(a) => { setEditTarget(null); setCancelTarget(a); }} />
    </div>
  );
}

// ── Day grid (positioned, single column) ─────────────────────────────────────

function DayGrid({
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
            <ApptCard key={a.id} a={a} tz={tz} left="left-14" top={top(a.startIso)} height={Math.max(MIN_DAY_CARD_PX, a.durationMin * pxPerMin)} onCancel={onCancel} onEdit={onEdit} onDragStartAppt={setDragged} />
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
  const colMinPx = 130;
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
          {providers.map((p) => {
            const band = day.openByProvider[p.id] ?? { isOpen: false, openMin: 9 * 60, closeMin: 17 * 60 };
            const colAppts = day.appointments.filter((a) => a.providerId === p.id);
            // Provider-specific blocks + whole-practice (null) blocks.
            const colBlocks = day.blocks.filter((b) => b.providerId === p.id || b.providerId === null);
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
                  <ApptCard key={a.id} a={a} tz={tz} left="left-0" top={top(a.startIso)} height={Math.max(MIN_DAY_CARD_PX, a.durationMin * pxPerMin)} onCancel={onCancel} onEdit={onEdit} onDragStartAppt={setDragged} compact={compact} />
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

function WeekGrid({
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
      <div className="min-w-[680px]">
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
          {days.map((d) => {
            const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
            const h = hoursByDow.get(dow);
            const dayAppts = apptsByDay.get(d) ?? [];
            const dayBlocks = blocksByDay.get(d) ?? [];
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
                  <ApptCard key={a.id} a={a} tz={tz} left="left-0" top={top(a.startIso)} height={Math.max(MIN_WEEK_CARD_PX, a.durationMin * pxPerMin)} onCancel={onCancel} onEdit={onEdit} onDragStartAppt={setDragged} compact />
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

function MonthGrid({
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

function ApptCard({
  a,
  tz,
  left,
  top,
  height,
  onCancel,
  onEdit,
  onDragStartAppt,
  compact,
}: {
  a: DayAppointment;
  tz: string;
  left: string;
  top: number;
  height: number;
  onCancel: (a: DayAppointment) => void;
  onEdit: (a: DayAppointment) => void;
  onDragStartAppt?: (a: DayAppointment) => void;
  compact?: boolean;
}) {
  const held = a.status === "held";
  return (
    <div
      draggable={!held}
      className={cn(
        "absolute right-0 rounded-md border px-2 py-0.5 shadow-sm overflow-hidden group cursor-pointer",
        left,
        held ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200",
      )}
      style={{ top, height }}
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
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0">
          <div className={cn("font-semibold text-ink truncate leading-tight", compact ? "text-[11px]" : "text-[12px]")}>
            {a.patientName ?? (held ? "Hold" : "Booked")}
          </div>
          {height >= 30 && (
            <div className="text-[11px] text-ink-soft tabular-nums leading-tight truncate">
              {compact ? fmtTime(a.startIso, tz) : `${fmtTime(a.startIso, tz)}–${fmtTime(a.endIso, tz)}`}
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

function BlockBand({ left, top, height, reason, compact }: { left: string; top: number; height: number; reason: string | null; compact?: boolean }) {
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

// ── Dialogs ──────────────────────────────────────────────────────────────────

function BookDialog({
  open,
  onClose,
  services,
  providers,
  timezone,
  initialDate,
  initialTime,
  initialProviderId,
  viewAsUserId,
  onBooked,
}: {
  open: boolean;
  onClose: () => void;
  services: ServiceLite[];
  providers: ProviderLite[];
  timezone: string;
  initialDate: string;
  initialTime: string;
  initialProviderId?: string;
  viewAsUserId?: string;
  onBooked: () => void;
}) {
  const [serviceId, setServiceId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  // Reseed date+time+provider whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setDate(initialDate);
      setTime(initialTime);
      setProviderId(initialProviderId ?? providers[0]?.id ?? "");
    }
  }, [open, initialDate, initialTime, initialProviderId, providers]);

  async function submit() {
    if (!serviceId || !name.trim() || busy) return;
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const [y, m, d] = date.split("-").map((n) => parseInt(n, 10));
      const [hh, mm] = time.split(":").map((n) => parseInt(n, 10));
      const startIso = zonedWallClockToUtc(y, m, d, hh, mm, timezone).toISOString();
      const r = await ownerCreateAppointmentFn({
        data: { accessToken: token, viewAsUserId, serviceId, providerId: providerId || undefined, startIso, patientName: name.trim(), patientEmail: email.trim() || undefined, patientPhone: phone.trim() || undefined },
      });
      if (!r.ok) { toast.error(r.reason); return; }
      toast.success("Booked.");
      onBooked();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't book.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add booking</DialogTitle>
          <DialogDescription>Pick the day, time, and service to book a patient in.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {providers.length > 1 && (
            <Labeled label="Provider">
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={inputCls}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Labeled>
          )}
          <Labeled label="Service">
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={inputCls}>
              <option value="">Choose a service…</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name} · {s.durationMin} min</option>
              ))}
            </select>
          </Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Day"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></Labeled>
            <Labeled label="Time"><TimeSelect value={time} onChange={setTime} className={`${inputCls} tabular-nums`} /></Labeled>
          </div>
          <Labeled label="Patient name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Email (optional)"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} /></Labeled>
            <Labeled label="Phone (optional)"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} /></Labeled>
          </div>
        </div>
        <DialogFooter>
          <button type="button" disabled={busy} onClick={onClose} className={btnGhost}>Cancel</button>
          <button type="button" disabled={busy || !serviceId || !name.trim()} onClick={submit} className={btnPrimary}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}<Plus className="h-3.5 w-3.5" /> Book
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BlockDialog({
  open,
  onClose,
  timezone,
  dateIso,
  viewAsUserId,
  onBlocked,
}: {
  open: boolean;
  onClose: () => void;
  timezone: string;
  dateIso: string;
  viewAsUserId?: string;
  onBlocked: () => void;
}) {
  const [start, setStart] = useState("12:00");
  const [end, setEnd] = useState("13:00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    if (start >= end) { toast.error("End time must be after start time."); return; }
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const [y, m, d] = dateIso.split("-").map((n) => parseInt(n, 10));
      const [sh, sm] = start.split(":").map((n) => parseInt(n, 10));
      const [eh, em] = end.split(":").map((n) => parseInt(n, 10));
      const startIso = zonedWallClockToUtc(y, m, d, sh, sm, timezone).toISOString();
      const endIso = zonedWallClockToUtc(y, m, d, eh, em, timezone).toISOString();
      const r = await ownerCreateBlockFn({ data: { accessToken: token, viewAsUserId, startIso, endIso, reason: reason.trim() || undefined } });
      if (!r.ok) { toast.error(r.reason); return; }
      toast.success("Time blocked.");
      onBlocked();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't block time.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Block off time</DialogTitle>
          <DialogDescription>Mark time as unavailable on {fmtDayLabel(dateIso)}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="From"><TimeSelect value={start} onChange={setStart} className={`${inputCls} tabular-nums`} /></Labeled>
            <Labeled label="To"><TimeSelect value={end} onChange={setEnd} className={`${inputCls} tabular-nums`} /></Labeled>
          </div>
          <Labeled label="Reason (optional)"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lunch, meeting, vacation…" className={inputCls} /></Labeled>
        </div>
        <DialogFooter>
          <button type="button" disabled={busy} onClick={onClose} className={btnGhost}>Cancel</button>
          <button type="button" disabled={busy} onClick={submit} className={btnInk}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}<Ban className="h-3.5 w-3.5" /> Block
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({
  appt,
  tz,
  viewAsUserId,
  onClose,
  onCancelled,
}: {
  appt: DayAppointment | null;
  tz: string;
  viewAsUserId?: string;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (!appt || busy) return;
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const r = await ownerCancelAppointmentFn({ data: { accessToken: token, viewAsUserId, appointmentId: appt.id } });
      if (!r.ok) { toast.error(r.reason); return; }
      toast.success("Appointment cancelled.");
      onCancelled();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't cancel.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!appt} onOpenChange={(o) => !busy && !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel appointment?</DialogTitle>
          <DialogDescription>
            {appt ? `${appt.patientName ?? "This appointment"} at ${fmtTime(appt.startIso, tz)} will be cancelled and the slot freed.` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button type="button" disabled={busy} onClick={onClose} className={btnGhost}>Keep it</button>
          <button type="button" disabled={busy} onClick={confirm} className="inline-flex items-center gap-1.5 rounded-lg bg-bad px-4 py-2 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-40">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Cancel appointment
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  appt,
  tz,
  providers,
  viewAsUserId,
  onClose,
  onSaved,
  onCancelAppt,
}: {
  appt: DayAppointment | null;
  tz: string;
  providers: ProviderLite[];
  viewAsUserId?: string;
  onClose: () => void;
  onSaved: () => void;
  onCancelAppt: (a: DayAppointment) => void;
}) {
  const [providerId, setProviderId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [duration, setDuration] = useState(30);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (appt) {
      setProviderId(appt.providerId ?? "");
      setDate(dayKey(appt.startIso, tz));
      setTime(minToHHMM(localMinutes(appt.startIso, tz)));
      setDuration(appt.durationMin);
      setName(appt.patientName ?? "");
    }
  }, [appt, tz]);

  async function save() {
    if (!appt || busy || !date) return;
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const [y, m, d] = date.split("-").map((n) => parseInt(n, 10));
      const [hh, mm] = time.split(":").map((n) => parseInt(n, 10));
      const startIso = zonedWallClockToUtc(y, m, d, hh, mm, tz).toISOString();
      const r = await ownerUpdateAppointmentFn({
        data: {
          accessToken: token,
          viewAsUserId,
          appointmentId: appt.id,
          startIso,
          providerId: providerId || undefined,
          durationMin: duration,
          patientName: name.trim() || undefined,
        },
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success("Appointment updated.");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!appt} onOpenChange={(o) => !busy && !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit appointment</DialogTitle>
          <DialogDescription>
            {appt?.patientName ? `${appt.patientName} — ` : ""}reschedule, reassign, or update.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {providers.length > 1 && (
            <Labeled label="Provider">
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={inputCls}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Labeled>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Day"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></Labeled>
            <Labeled label="Time"><TimeSelect value={time} onChange={setTime} className={`${inputCls} tabular-nums`} /></Labeled>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Duration (min)">
              <input type="number" min={5} max={1440} step={5} value={duration} onChange={(e) => setDuration(Math.max(5, Math.min(1440, Math.round((parseInt(e.target.value || "5", 10)) / 5) * 5)))} className={`${inputCls} tabular-nums`} />
            </Labeled>
            <Labeled label="Patient name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Labeled>
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <button type="button" disabled={busy} onClick={() => appt && onCancelAppt(appt)} className="inline-flex items-center gap-1.5 rounded-lg border border-bad/30 bg-white px-4 py-2 text-sm text-bad hover:bg-bad/5 transition disabled:opacity-40">
            Cancel appointment
          </button>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy} onClick={onClose} className={btnGhost}>Close</button>
            <button type="button" disabled={busy || !date} onClick={save} className={btnPrimary}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── shared classes + helpers ─────────────────────────────────────────────────

const inputCls = "w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30";
const btnGhost = "inline-flex items-center rounded-lg border border-rule bg-white px-4 py-2 text-sm text-ink-soft hover:bg-rule-soft transition disabled:opacity-40";
const btnPrimary = "inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-2 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-40";
const btnInk = "inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-40";

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1">{label}</span>
      {children}
    </label>
  );
}

function computeSpan(view: View, dateIso: string): { fromDate: string; toDateExclusive: string } {
  if (view === "day") return { fromDate: dateIso, toDateExclusive: addDays(dateIso, 1) };
  if (view === "week") {
    const start = mondayOf(dateIso);
    return { fromDate: start, toDateExclusive: addDays(start, 7) };
  }
  const gridStart = mondayOf(startOfMonth(dateIso));
  return { fromDate: gridStart, toDateExclusive: addDays(gridStart, 42) };
}

function padWindow(start: number, end: number): { start: number; end: number } {
  let s = Math.max(0, Math.floor((start - 30) / 60) * 60);
  let e = Math.min(24 * 60, Math.ceil((end + 30) / 60) * 60);
  if (e <= s) e = s + 60;
  return { start: s, end: e };
}

function hourMarks(win: { start: number; end: number }): number[] {
  const out: number[] = [];
  for (let m = win.start; m <= win.end; m += 60) out.push(m);
  return out;
}

function groupByDay(appts: DayAppointment[], tz: string): Map<string, DayAppointment[]> {
  const m = new Map<string, DayAppointment[]>();
  for (const a of appts) {
    const k = dayKey(a.startIso, tz);
    const arr = m.get(k);
    if (arr) arr.push(a);
    else m.set(k, [a]);
  }
  return m;
}

function groupBlocksByDay(blocks: DayBlock[], tz: string): Map<string, DayBlock[]> {
  const m = new Map<string, DayBlock[]>();
  for (const b of blocks) {
    const k = dayKey(b.startIso, tz);
    const arr = m.get(k);
    if (arr) arr.push(b);
    else m.set(k, [b]);
  }
  return m;
}

function snap5(mins: number, win: { start: number; end: number }): number {
  const snapped = Math.round(mins / 5) * 5;
  return Math.max(win.start, Math.min(win.end - 5, snapped));
}

function minToHHMM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function todayIso(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const base = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, lastDay));
  return base.toISOString().slice(0, 10);
}

function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function mondayOf(iso: string): string {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  const back = (dow + 6) % 7; // days since Monday
  return addDays(iso, -back);
}

function fmtDayLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(`${iso}T12:00:00Z`));
}

function fmtWeekLabel(fromDate: string, toDateExclusive: string): string {
  const last = addDays(toDateExclusive, -1);
  const a = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${fromDate}T12:00:00Z`));
  const b = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${last}T12:00:00Z`));
  return `${a} – ${b}`;
}

function fmtMonthLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${iso}T12:00:00Z`));
}

function fmtHour(min: number): string {
  const h = Math.floor(min / 60);
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${ampm}`;
}

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function dayKey(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function localMinutes(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = parseInt(p.value, 10);
    if (p.type === "minute") m = parseInt(p.value, 10);
  }
  return h * 60 + m;
}
