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
import { CalendarPlus, ChevronLeft, ChevronRight, Loader2, Ban, ZoomIn, ZoomOut, Users, EyeOff, Maximize2, Minimize2 } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { CalendarTabs } from "@/components/refill/CalendarTabs";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getDayScheduleFn,
  getRangeScheduleFn,
  ownerUpdateAppointmentFn,
  type DaySchedule,
  type DayAppointment,
  type ProviderLite,
  type RangeSchedule,
} from "@/server/scheduling-owner.functions";
import { cn } from "@/lib/utils";
import {
  type View,
  type ServiceLite,
  ZOOM_LEVELS,
  DEFAULT_ZOOM_IDX,
  ZOOM_KEY,
  computeSpan,
  todayIso,
  addDays,
  addMonths,
  fmtDayLabel,
  fmtWeekLabel,
  fmtMonthLabel,
} from "@/components/refill/schedule/shared";
import { DayGrid, WeekGrid, MonthGrid } from "@/components/refill/schedule/grids";
import {
  BookDialog,
  BlockDialog,
  CancelDialog,
  EditDialog,
  ManageProvidersDialog,
} from "@/components/refill/schedule/dialogs";

export const Route = createFileRoute("/app/refill/calendar/schedule")({
  component: SchedulePage,
});


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
  const [manageOpen, setManageOpen] = useState(false);
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
  // Week runs at the SAME vertical scale as the day so its stacking/spacing
  // matches (was 0.7× → cramped columns vs the day's breathing room).
  const weekPpm = ZOOM_LEVELS[zoomIdx];

  // Fullscreen ("pop out") — expand the calendar edge-to-edge via the native
  // Fullscreen API. Movable/resizable floating-window variants deferred.
  const scheduleRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFullscreen(document.fullscreenElement === scheduleRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void scheduleRef.current?.requestFullscreen();
  }

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
  const providerUnoffered: Record<string, string[]> =
    (view === "day" ? day?.providerUnoffered : range?.providerUnoffered) ?? {};
  const tenantId = (view === "day" ? day?.tenantId : range?.tenantId) ?? "";
  const hiddenProviderCount =
    (view === "day" ? day?.hiddenProviderCount : range?.hiddenProviderCount) ?? 0;

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
        <PageHeader wide title="Schedule" description="Your day at a glance." />
        <CalendarTabs active="schedule" />
        <div className="px-6 lg:px-10 py-10 text-[14px] text-ink-soft">
          Use the persona switcher (upper-right) to view as a spa.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader wide title="Schedule" description="Bookings, holds, and blocked time — day, week, or month." />
      <CalendarTabs active="schedule" />

      <div
        ref={scheduleRef}
        className={cn(
          "px-6 lg:px-10 py-4 w-full mx-auto",
          isFullscreen ? "max-w-none h-screen overflow-auto bg-background" : "max-w-[1280px]",
        )}
      >
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
            <button
              type="button"
              onClick={toggleFullscreen}
              className="rounded-md border border-rule p-2 text-ink-soft hover:text-ink hover:border-emerald/40 transition"
              aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
              title={isFullscreen ? "Exit full screen" : "Full screen"}
            >
              {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
            <button type="button" onClick={() => setManageOpen(true)} className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition">
              <Users className="h-3.5 w-3.5" /> Providers
            </button>
            <button type="button" onClick={() => setBlockOpen(true)} className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition">
              <Ban className="h-3.5 w-3.5" /> Block
            </button>
            <button type="button" onClick={() => setBookSeed({ date: dateIso, time: "09:00" })} className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition">
              <CalendarPlus className="h-3.5 w-3.5" /> Add booking
            </button>
          </div>
        </div>

        {!loading && hiddenProviderCount > 0 && (
          <button
            type="button"
            onClick={() => setManageOpen(true)}
            className="mb-3 flex w-full items-center gap-2 rounded-md border border-rule bg-paper/40 px-3 py-2 text-left text-[12.5px] text-ink-soft hover:border-emerald/40 hover:text-ink transition"
          >
            <EyeOff className="h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium text-ink">{hiddenProviderCount}</span>{" "}
              {hiddenProviderCount === 1 ? "calendar is" : "calendars are"} hidden from this view —
              review
            </span>
          </button>
        )}
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
            providerId={weekProviderId}
            onProviderChange={setWeekProviderId}
            onPickDay={(iso) => {
              setDateIso(iso);
              setView("day");
            }}
          />
        ) : null}
      </div>

      <BookDialog open={!!bookSeed} initialDate={bookSeed?.date ?? dateIso} initialTime={bookSeed?.time ?? "09:00"} initialProviderId={bookSeed?.providerId} providers={providers} onClose={() => setBookSeed(null)} services={services} providerUnoffered={providerUnoffered} tenantId={tenantId} timezone={tz} viewAsUserId={viewAsUserId} onBooked={() => { setBookSeed(null); void load(); }} />
      <BlockDialog open={blockOpen} onClose={() => setBlockOpen(false)} timezone={tz} dateIso={dateIso} viewAsUserId={viewAsUserId} onBlocked={() => { setBlockOpen(false); void load(); }} />
      <ManageProvidersDialog open={manageOpen} viewAsUserId={viewAsUserId} onClose={() => setManageOpen(false)} onChanged={() => void load()} />
      <CancelDialog appt={cancelTarget} tz={tz} viewAsUserId={viewAsUserId} onClose={() => setCancelTarget(null)} onCancelled={() => { setCancelTarget(null); void load(); }} />
      <EditDialog appt={editTarget} tz={tz} providers={providers} viewAsUserId={viewAsUserId} onClose={() => setEditTarget(null)} onSaved={() => { setEditTarget(null); void load(); }} onCancelAppt={(a) => { setEditTarget(null); setCancelTarget(a); }} />
    </div>
  );
}

