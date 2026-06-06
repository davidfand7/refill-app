/**
 * /app/refill/schedule — owner calendar, day view (v1.48.0).
 *
 * See the day's bookings on a positioned time grid, navigate days, manually
 * book a patient in, block off time, and cancel. Reads/writes via the
 * scheduling-owner server fns; times render in the practice timezone. Manual
 * book is EXCLUDE-guarded server-side (no double-book even from the owner).
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
  ownerCreateAppointmentFn,
  ownerCreateBlockFn,
  ownerCancelAppointmentFn,
  type DaySchedule,
  type DayAppointment,
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

const PX_PER_MIN = 0.9;

function SchedulePage() {
  const membership = useTenantMembership();
  const viewAsUserId = membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [dateIso, setDateIso] = useState<string>(todayIso());
  const [loading, setLoading] = useState(true);
  const [day, setDay] = useState<DaySchedule | null>(null);
  const [bookOpen, setBookOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<DayAppointment | null>(null);

  const load = useCallback(async () => {
    if (membership.status !== "tenant") return;
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Please sign in.");
      const result = await getDayScheduleFn({ data: { accessToken: token, viewAsUserId, dateIso } });
      setDay(result);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load the schedule.");
    } finally {
      setLoading(false);
    }
  }, [membership.status, viewAsUserId, dateIso]);

  useEffect(() => {
    void load();
  }, [load]);

  const tz = day?.timezone ?? "America/Los_Angeles";

  // Compute the visible time window (minutes-from-midnight).
  const windowRange = useMemo(() => {
    let start = day?.open.isOpen ? day.open.openMin : 9 * 60;
    let end = day?.open.isOpen ? day.open.closeMin : 17 * 60;
    for (const a of day?.appointments ?? []) {
      start = Math.min(start, localMinutes(a.startIso, tz));
      end = Math.max(end, localMinutes(a.endIso, tz));
    }
    for (const b of day?.blocks ?? []) {
      start = Math.min(start, localMinutes(b.startIso, tz));
      end = Math.max(end, localMinutes(b.endIso, tz));
    }
    start = Math.max(0, Math.floor((start - 30) / 60) * 60);
    end = Math.min(24 * 60, Math.ceil((end + 30) / 60) * 60);
    if (end <= start) end = start + 60;
    return { start, end };
  }, [day, tz]);

  const hourLines = useMemo(() => {
    const lines: number[] = [];
    for (let m = windowRange.start; m <= windowRange.end; m += 60) lines.push(m);
    return lines;
  }, [windowRange]);

  const gridHeight = (windowRange.end - windowRange.start) * PX_PER_MIN;

  function topFor(iso: string): number {
    return (localMinutes(iso, tz) - windowRange.start) * PX_PER_MIN;
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader title="Schedule" description="Your day at a glance — bookings, holds, and blocked time." />

      <div className="px-6 lg:px-10 py-4 max-w-5xl w-full mx-auto">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setDateIso((d) => addDays(d, -1))}
              className="rounded-md border border-rule p-1.5 text-ink-soft hover:text-ink hover:border-emerald/40 transition"
              aria-label="Previous day"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setDateIso(todayIso())}
              className="rounded-md border border-rule px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => setDateIso((d) => addDays(d, 1))}
              className="rounded-md border border-rule p-1.5 text-ink-soft hover:text-ink hover:border-emerald/40 transition"
              aria-label="Next day"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <span className="ml-2 text-[15px] font-semibold text-ink">{fmtDateLabel(dateIso)}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setBlockOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-[13px] font-medium text-ink-soft hover:text-ink hover:border-emerald/40 transition"
            >
              <Ban className="h-3.5 w-3.5" /> Block time
            </button>
            <button
              type="button"
              onClick={() => setBookOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
            >
              <CalendarPlus className="h-3.5 w-3.5" /> Add booking
            </button>
          </div>
        </div>

        {loading || !day ? (
          <div className="flex items-center gap-2 text-[14px] text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading schedule…
          </div>
        ) : (
          <div className="rounded-xl border border-rule bg-white p-4">
            {!day.open.isOpen && (
              <div className="mb-3 text-[12px] text-ink-faint">Closed this day (per business hours).</div>
            )}
            <div className="relative" style={{ height: gridHeight }}>
              {/* Hour gridlines + labels */}
              {hourLines.map((m) => (
                <div
                  key={m}
                  className="absolute left-0 right-0 border-t border-rule/60"
                  style={{ top: (m - windowRange.start) * PX_PER_MIN }}
                >
                  <span className="absolute -top-2 left-0 text-[11px] text-ink-faint tabular-nums bg-white pr-1">
                    {fmtHour(m)}
                  </span>
                </div>
              ))}

              {/* Open band */}
              {day.open.isOpen && (
                <div
                  className="absolute left-14 right-0 bg-emerald-soft/40 rounded"
                  style={{
                    top: (day.open.openMin - windowRange.start) * PX_PER_MIN,
                    height: (day.open.closeMin - day.open.openMin) * PX_PER_MIN,
                  }}
                />
              )}

              {/* Blocks */}
              {day.blocks.map((b) => (
                <div
                  key={b.id}
                  className="absolute left-14 right-0 rounded bg-[repeating-linear-gradient(45deg,#e7e1d6,#e7e1d6_6px,#f3ede2_6px,#f3ede2_12px)] border border-rule"
                  style={{
                    top: topFor(b.startIso),
                    height: Math.max(14, (localMinutes(b.endIso, tz) - localMinutes(b.startIso, tz)) * PX_PER_MIN),
                  }}
                >
                  <span className="absolute top-0.5 left-2 text-[11px] text-ink-soft">
                    {b.reason ?? "Blocked"}
                  </span>
                </div>
              ))}

              {/* Appointments */}
              {day.appointments.map((a) => {
                const h = Math.max(18, a.durationMin * PX_PER_MIN);
                const held = a.status === "held";
                return (
                  <div
                    key={a.id}
                    className={cn(
                      "absolute left-14 right-0 rounded-md border px-2 py-1 shadow-sm overflow-hidden group",
                      held
                        ? "bg-amber-50 border-amber-200"
                        : "bg-emerald-50 border-emerald-200",
                    )}
                    style={{ top: topFor(a.startIso), height: h }}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0">
                        <div className="text-[12px] font-semibold text-ink truncate">
                          {a.patientName ?? (held ? "Hold (pending)" : "Booked")}
                        </div>
                        <div className="text-[11px] text-ink-soft tabular-nums">
                          {fmtTime(a.startIso, tz)}–{fmtTime(a.endIso, tz)}
                          {held && " · holding"}
                        </div>
                      </div>
                      {!held && (
                        <button
                          type="button"
                          onClick={() => setCancelTarget(a)}
                          className="opacity-0 group-hover:opacity-100 transition text-ink-faint hover:text-bad shrink-0"
                          aria-label="Cancel appointment"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {day.appointments.length === 0 && day.blocks.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-faint">
                  No bookings this day.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {day && (
        <BookDialog
          open={bookOpen}
          onClose={() => setBookOpen(false)}
          day={day}
          dateIso={dateIso}
          viewAsUserId={viewAsUserId}
          onBooked={() => {
            setBookOpen(false);
            void load();
          }}
        />
      )}
      {day && (
        <BlockDialog
          open={blockOpen}
          onClose={() => setBlockOpen(false)}
          timezone={tz}
          dateIso={dateIso}
          viewAsUserId={viewAsUserId}
          onBlocked={() => {
            setBlockOpen(false);
            void load();
          }}
        />
      )}
      <CancelDialog
        appt={cancelTarget}
        tz={tz}
        viewAsUserId={viewAsUserId}
        onClose={() => setCancelTarget(null)}
        onCancelled={() => {
          setCancelTarget(null);
          void load();
        }}
      />
    </div>
  );
}

// ── Manual-book dialog ───────────────────────────────────────────────────────

function BookDialog({
  open,
  onClose,
  day,
  dateIso,
  viewAsUserId,
  onBooked,
}: {
  open: boolean;
  onClose: () => void;
  day: DaySchedule;
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
      const startIso = zonedWallClockToUtc(y, m, d, hh, mm, day.timezone).toISOString();
      const r = await ownerCreateAppointmentFn({
        data: {
          accessToken: token,
          viewAsUserId,
          serviceId,
          startIso,
          patientName: name.trim(),
          patientEmail: email.trim() || undefined,
          patientPhone: phone.trim() || undefined,
        },
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
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
          <DialogDescription>Book a patient in on {fmtDateLabel(dateIso)}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Labeled label="Service">
            <select
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
            >
              <option value="">Choose a service…</option>
              {day.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.durationMin} min
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Time">
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
            />
          </Labeled>
          <Labeled label="Patient name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
            />
          </Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Email (optional)">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
              />
            </Labeled>
            <Labeled label="Phone (optional)">
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
              />
            </Labeled>
          </div>
        </div>
        <DialogFooter>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="inline-flex items-center rounded-lg border border-rule bg-white px-4 py-2 text-sm text-ink-soft hover:bg-rule-soft transition disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !serviceId || !name.trim()}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-2 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <Plus className="h-3.5 w-3.5" /> Book
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Block-off dialog ─────────────────────────────────────────────────────────

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
    if (start >= end) {
      toast.error("End time must be after start time.");
      return;
    }
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
      const r = await ownerCreateBlockFn({
        data: { accessToken: token, viewAsUserId, startIso, endIso, reason: reason.trim() || undefined },
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
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
          <DialogDescription>Mark time as unavailable on {fmtDateLabel(dateIso)}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="From">
              <input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
              />
            </Labeled>
            <Labeled label="To">
              <input
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
              />
            </Labeled>
          </div>
          <Labeled label="Reason (optional)">
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Lunch, meeting, vacation…"
              className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
            />
          </Labeled>
        </div>
        <DialogFooter>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="inline-flex items-center rounded-lg border border-rule bg-white px-4 py-2 text-sm text-ink-soft hover:bg-rule-soft transition disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <Ban className="h-3.5 w-3.5" /> Block
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Cancel dialog ────────────────────────────────────────────────────────────

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
      const r = await ownerCancelAppointmentFn({
        data: { accessToken: token, viewAsUserId, appointmentId: appt.id },
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
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
            {appt
              ? `${appt.patientName ?? "This appointment"} at ${fmtTime(appt.startIso, tz)} will be cancelled and the slot freed.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="inline-flex items-center rounded-lg border border-rule bg-white px-4 py-2 text-sm text-ink-soft hover:bg-rule-soft transition disabled:opacity-40"
          >
            Keep it
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-bad px-4 py-2 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Cancel appointment
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

function todayIso(): string {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const base = new Date(`${iso}T00:00:00Z`);
  return new Date(base.getTime() + n * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

function fmtDateLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(`${iso}T12:00:00Z`));
}

function fmtHour(min: number): string {
  const h = Math.floor(min / 60);
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${ampm}`;
}

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
}

function localMinutes(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = parseInt(p.value, 10);
    if (p.type === "minute") m = parseInt(p.value, 10);
  }
  return h * 60 + m;
}
