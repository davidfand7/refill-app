/**
 * /app/refill/schedule — owner calendar (v1.48.6).
 *
 * Day / Week / Month views. Day = positioned time grid; Week = 7 positioned
 * columns sharing a time axis; Month = a clickable date grid (cell → day view).
 * Manual book, block-off, and cancel work from any view. Times render in the
 * practice timezone. Manual book is EXCLUDE-guarded server-side.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarPlus, ChevronLeft, ChevronRight, Loader2, Plus, Ban, X } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { zonedWallClockToUtc } from "@/lib/scheduling-slots";
import {
  getDayScheduleFn,
  getRangeScheduleFn,
  ownerCreateAppointmentFn,
  ownerCreateBlockFn,
  ownerCancelAppointmentFn,
  type DaySchedule,
  type DayAppointment,
  type DayBlock,
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

export const Route = createFileRoute("/app/refill/schedule")({
  component: SchedulePage,
});

type View = "day" | "week" | "month";
type ServiceLite = { id: string; name: string; durationMin: number };

const DAY_PX_PER_MIN = 0.9;
const WEEK_PX_PER_MIN = 0.7;
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function SchedulePage() {
  const membership = useTenantMembership();
  const viewAsUserId = membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [view, setView] = useState<View>("day");
  const [dateIso, setDateIso] = useState<string>(todayIso());
  const [loading, setLoading] = useState(true);
  const [day, setDay] = useState<DaySchedule | null>(null);
  const [range, setRange] = useState<RangeSchedule | null>(null);
  const [bookOpen, setBookOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<DayAppointment | null>(null);

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
            <button type="button" onClick={() => setBookOpen(true)} className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition">
              <CalendarPlus className="h-3.5 w-3.5" /> Add booking
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-[14px] text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading schedule…
          </div>
        ) : view === "day" && day ? (
          <DayGrid day={day} tz={tz} onCancel={setCancelTarget} />
        ) : view === "week" && range ? (
          <WeekGrid
            range={range}
            tz={tz}
            weekStart={span.fromDate}
            onCancel={setCancelTarget}
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

      <BookDialog open={bookOpen} onClose={() => setBookOpen(false)} services={services} timezone={tz} dateIso={dateIso} viewAsUserId={viewAsUserId} onBooked={() => { setBookOpen(false); void load(); }} />
      <BlockDialog open={blockOpen} onClose={() => setBlockOpen(false)} timezone={tz} dateIso={dateIso} viewAsUserId={viewAsUserId} onBlocked={() => { setBlockOpen(false); void load(); }} />
      <CancelDialog appt={cancelTarget} tz={tz} viewAsUserId={viewAsUserId} onClose={() => setCancelTarget(null)} onCancelled={() => { setCancelTarget(null); void load(); }} />
    </div>
  );
}

// ── Day grid (positioned, single column) ─────────────────────────────────────

function DayGrid({ day, tz, onCancel }: { day: DaySchedule; tz: string; onCancel: (a: DayAppointment) => void }) {
  const win = useMemo(() => {
    let start = day.open.isOpen ? day.open.openMin : 9 * 60;
    let end = day.open.isOpen ? day.open.closeMin : 17 * 60;
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

  const height = (win.end - win.start) * DAY_PX_PER_MIN;
  const top = (iso: string) => (localMinutes(iso, tz) - win.start) * DAY_PX_PER_MIN;

  return (
    <div className="rounded-xl border border-rule bg-white p-4">
      {!day.open.isOpen && <div className="mb-3 text-[12px] text-ink-faint">Closed this day (per business hours).</div>}
      <div className="relative" style={{ height }}>
        {hourMarks(win).map((m) => (
          <div key={m} className="absolute left-0 right-0 border-t border-rule/60" style={{ top: (m - win.start) * DAY_PX_PER_MIN }}>
            <span className="absolute -top-2 left-0 text-[11px] text-ink-faint tabular-nums bg-white pr-1">{fmtHour(m)}</span>
          </div>
        ))}
        {day.open.isOpen && (
          <div className="absolute left-14 right-0 bg-emerald-soft/40 rounded" style={{ top: (day.open.openMin - win.start) * DAY_PX_PER_MIN, height: (day.open.closeMin - day.open.openMin) * DAY_PX_PER_MIN }} />
        )}
        {day.blocks.map((b) => (
          <BlockBand key={b.id} left="left-14" top={top(b.startIso)} height={Math.max(14, (localMinutes(b.endIso, tz) - localMinutes(b.startIso, tz)) * DAY_PX_PER_MIN)} reason={b.reason} />
        ))}
        {day.appointments.map((a) => (
          <ApptCard key={a.id} a={a} tz={tz} left="left-14" top={top(a.startIso)} height={Math.max(18, a.durationMin * DAY_PX_PER_MIN)} onCancel={onCancel} showTimes />
        ))}
        {day.appointments.length === 0 && day.blocks.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-faint">No bookings this day.</div>
        )}
      </div>
    </div>
  );
}

// ── Week grid (7 positioned columns sharing a time axis) ─────────────────────

function WeekGrid({
  range,
  tz,
  weekStart,
  onCancel,
  onPickDay,
}: {
  range: RangeSchedule;
  tz: string;
  weekStart: string;
  onCancel: (a: DayAppointment) => void;
  onPickDay: (iso: string) => void;
}) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const hoursByDow = useMemo(() => {
    const m = new Map<number, WeeklyHoursRow>();
    for (const h of range.weeklyHours) m.set(h.dayOfWeek, h);
    return m;
  }, [range.weeklyHours]);

  const apptsByDay = useMemo(() => groupByDay(range.appointments, tz), [range.appointments, tz]);
  const blocksByDay = useMemo(() => groupBlocksByDay(range.blocks, tz), [range.blocks, tz]);

  const win = useMemo(() => {
    let start = 24 * 60;
    let end = 0;
    for (const h of range.weeklyHours) {
      if (h.isClosed) continue;
      start = Math.min(start, h.openMin);
      end = Math.max(end, h.closeMin);
    }
    if (end === 0) {
      start = 9 * 60;
      end = 17 * 60;
    }
    for (const a of range.appointments) {
      start = Math.min(start, localMinutes(a.startIso, tz));
      end = Math.max(end, localMinutes(a.endIso, tz));
    }
    return padWindow(start, end);
  }, [range, tz]);

  const height = (win.end - win.start) * WEEK_PX_PER_MIN;
  const top = (iso: string) => (localMinutes(iso, tz) - win.start) * WEEK_PX_PER_MIN;
  const today = todayIso();

  return (
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
              <div key={m} className="absolute right-1 text-[10px] text-ink-faint tabular-nums" style={{ top: (m - win.start) * WEEK_PX_PER_MIN - 6 }}>
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
              <div key={d} className="relative border-l border-rule/60">
                {hourMarks(win).map((m) => (
                  <div key={m} className="absolute left-0 right-0 border-t border-rule/40" style={{ top: (m - win.start) * WEEK_PX_PER_MIN }} />
                ))}
                {h && !h.isClosed && (
                  <div className="absolute left-0 right-0 bg-emerald-soft/30" style={{ top: (h.openMin - win.start) * WEEK_PX_PER_MIN, height: (h.closeMin - h.openMin) * WEEK_PX_PER_MIN }} />
                )}
                {dayBlocks.map((b) => (
                  <BlockBand key={b.id} left="left-0" top={top(b.startIso)} height={Math.max(10, (localMinutes(b.endIso, tz) - localMinutes(b.startIso, tz)) * WEEK_PX_PER_MIN)} reason={b.reason} compact />
                ))}
                {dayAppts.map((a) => (
                  <ApptCard key={a.id} a={a} tz={tz} left="left-0" top={top(a.startIso)} height={Math.max(16, a.durationMin * WEEK_PX_PER_MIN)} onCancel={onCancel} compact />
                ))}
              </div>
            );
          })}
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
  showTimes,
  compact,
}: {
  a: DayAppointment;
  tz: string;
  left: string;
  top: number;
  height: number;
  onCancel: (a: DayAppointment) => void;
  showTimes?: boolean;
  compact?: boolean;
}) {
  const held = a.status === "held";
  return (
    <div
      className={cn(
        "absolute right-0 rounded-md border px-2 py-0.5 shadow-sm overflow-hidden group",
        left,
        held ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200",
      )}
      style={{ top, height }}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0">
          <div className={cn("font-semibold text-ink truncate", compact ? "text-[10px]" : "text-[12px]")}>
            {a.patientName ?? (held ? "Hold" : "Booked")}
          </div>
          {(showTimes || !compact) && (
            <div className="text-[11px] text-ink-soft tabular-nums">
              {fmtTime(a.startIso, tz)}–{fmtTime(a.endIso, tz)}
              {held && " · holding"}
            </div>
          )}
        </div>
        {!held && (
          <button type="button" onClick={() => onCancel(a)} className="opacity-0 group-hover:opacity-100 transition text-ink-faint hover:text-bad shrink-0" aria-label="Cancel appointment">
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
      className={cn("absolute right-0 rounded bg-[repeating-linear-gradient(45deg,#e7e1d6,#e7e1d6_6px,#f3ede2_6px,#f3ede2_12px)] border border-rule", left)}
      style={{ top, height }}
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
  timezone,
  dateIso,
  viewAsUserId,
  onBooked,
}: {
  open: boolean;
  onClose: () => void;
  services: ServiceLite[];
  timezone: string;
  dateIso: string;
  viewAsUserId?: string;
  onBooked: () => void;
}) {
  const [serviceId, setServiceId] = useState("");
  const [time, setTime] = useState("09:00");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!serviceId || !name.trim() || busy) return;
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const [y, m, d] = dateIso.split("-").map((n) => parseInt(n, 10));
      const [hh, mm] = time.split(":").map((n) => parseInt(n, 10));
      const startIso = zonedWallClockToUtc(y, m, d, hh, mm, timezone).toISOString();
      const r = await ownerCreateAppointmentFn({
        data: { accessToken: token, viewAsUserId, serviceId, startIso, patientName: name.trim(), patientEmail: email.trim() || undefined, patientPhone: phone.trim() || undefined },
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
          <DialogDescription>Book a patient in on {fmtDayLabel(dateIso)}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Labeled label="Service">
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={inputCls}>
              <option value="">Choose a service…</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name} · {s.durationMin} min</option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Time"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`${inputCls} tabular-nums`} /></Labeled>
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
            <Labeled label="From"><input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={`${inputCls} tabular-nums`} /></Labeled>
            <Labeled label="To"><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={`${inputCls} tabular-nums`} /></Labeled>
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
