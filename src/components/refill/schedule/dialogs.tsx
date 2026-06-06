/**
 * Owner schedule dialogs — Book / Block / Cancel / Edit (extracted in the
 * v1.67.x consolidation sprint). Prop-driven; behavior identical.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Ban, Plus } from "lucide-react";
import { zonedWallClockToUtc } from "@/lib/scheduling-slots";
import { supabase } from "@/integrations/supabase/client";
import { TimeSelect } from "@/components/refill/TimeSelect";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ownerCreateAppointmentFn,
  ownerUpdateAppointmentFn,
  ownerCreateBlockFn,
  ownerCancelAppointmentFn,
  type DayAppointment,
  type ProviderLite,
} from "@/server/scheduling-owner.functions";
import {
  type ServiceLite,
  dayKey,
  fmtDayLabel,
  fmtTime,
  minToHHMM,
  localMinutes,
} from "@/components/refill/schedule/shared";

// ── Dialogs ──────────────────────────────────────────────────────────────────

export function BookDialog({
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

export function BlockDialog({
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

export function CancelDialog({
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

export function EditDialog({
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

export function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1">{label}</span>
      {children}
    </label>
  );
}
