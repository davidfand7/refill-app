/**
 * Owner schedule dialogs — Book / Block / Cancel / Edit (extracted in the
 * v1.67.x consolidation sprint). Prop-driven; behavior identical.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Ban, Plus, ChevronDown, Check, CalendarClock, CalendarRange, Pencil, Eye, EyeOff, X } from "lucide-react";
import { zonedWallClockToUtc } from "@/lib/scheduling-slots";
import { categoryLabel, categoryRank } from "@/lib/service-categories";
import { listAvailableSlots, type PublicSlot } from "@/server/scheduling.functions";
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
  listManagedProvidersFn,
  setProviderVisibilityFn,
  setProviderDisplayNameFn,
  type DayAppointment,
  type ProviderLite,
  type ManagedProvider,
} from "@/server/scheduling-owner.functions";
import { recordRecallBookingFn } from "@/server/refill-recall.functions";
import {
  type ServiceLite,
  dayKey,
  fmtDayLabel,
  fmtTime,
  minToHHMM,
  localMinutes,
} from "@/components/refill/schedule/shared";

// ── Service picker (collapsible category turndowns) ──────────────────────────
// Replaces a flat alphabetical <select> of every service with category groups
// that are COLLAPSED by default — so a long catalog (e.g. dozens of BBL / RF
// areas) is scannable. Pick a category to reveal its services, then a service.
function ServicePicker({
  services,
  value,
  onChange,
}: {
  services: ServiceLite[];
  value: string;
  onChange: (id: string) => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, ServiceLite[]>();
    for (const s of services) {
      const c = s.category?.trim() || "other";
      const arr = m.get(c) ?? [];
      arr.push(s);
      m.set(c, arr);
    }
    return [...m.entries()]
      .map(([cat, rows]) => ({
        cat,
        rows: [...rows].sort(
          (a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || a.name.localeCompare(b.name),
        ),
      }))
      .sort((a, b) => categoryRank(a.cat) - categoryRank(b.cat) || a.cat.localeCompare(b.cat));
  }, [services]);

  const selected = services.find((s) => s.id === value) ?? null;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Reveal the selected service's category (e.g. on reopen) — otherwise default
  // is everything collapsed.
  useEffect(() => {
    if (!value) return;
    const svc = services.find((s) => s.id === value);
    if (!svc) return;
    const cat = svc.category?.trim() || "other";
    setExpanded((p) => (p.has(cat) ? p : new Set(p).add(cat)));
  }, [value, services]);

  function toggle(cat: string) {
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(cat)) n.delete(cat);
      else n.add(cat);
      return n;
    });
  }

  return (
    <div className="rounded-md border border-rule overflow-hidden">
      <div className="px-3 py-2 text-[13px] border-b border-rule bg-paper/40">
        {selected ? (
          <span className="text-ink">
            {selected.name} <span className="text-ink-faint">· {selected.durationMin} min</span>
          </span>
        ) : (
          <span className="text-ink-faint">Choose a service…</span>
        )}
      </div>
      <div className="max-h-56 overflow-auto divide-y divide-rule/50">
        {groups.map(({ cat, rows }) => {
          const open = expanded.has(cat);
          const selectedHere = !!selected && rows.some((r) => r.id === value);
          return (
            <div key={cat}>
              <button
                type="button"
                onClick={() => toggle(cat)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-paper/50 transition"
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 text-ink-faint transition-transform ${open ? "" : "-rotate-90"}`}
                />
                <span className="text-[13px] font-medium text-ink">{categoryLabel(cat)}</span>
                <span className="text-[11px] text-ink-faint tabular-nums">{rows.length}</span>
                {selectedHere && !open && (
                  <span className="ml-auto text-[11px] text-emerald truncate max-w-[55%]">
                    {selected!.name}
                  </span>
                )}
              </button>
              {open && (
                <ul className="pb-1">
                  {rows.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => onChange(s.id)}
                        className={`w-full flex items-center gap-2 pl-9 pr-3 py-1.5 text-left text-[13px] transition ${
                          value === s.id
                            ? "bg-emerald/10 text-ink font-medium"
                            : "text-ink-soft hover:bg-paper/60 hover:text-ink"
                        }`}
                      >
                        <span className="flex-1 truncate">
                          {s.name} <span className="text-ink-faint">· {s.durationMin} min</span>
                          {s.activeOffer && (
                            <span className="ml-1.5 inline-block rounded-full bg-amber-soft text-amber text-[10px] font-semibold px-1.5 py-0.5 align-middle">
                              {s.activeOffer.label}
                            </span>
                          )}
                        </span>
                        {value === s.id && <Check className="h-3.5 w-3.5 text-emerald shrink-0" />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {groups.length === 0 && (
          <p className="px-3 py-3 text-[12px] text-ink-soft">No bookable services yet.</p>
        )}
      </div>
    </div>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

export function BookDialog({
  open,
  onClose,
  services,
  providers,
  providerUnoffered,
  tenantId,
  timezone,
  initialDate,
  initialTime,
  initialProviderId,
  initialName,
  initialEmail,
  initialPhone,
  recallPatientNodeId,
  viewAsUserId,
  onBooked,
}: {
  open: boolean;
  onClose: () => void;
  services: ServiceLite[];
  providers: ProviderLite[];
  /** providerId → serviceIds that provider does NOT offer (hidden from picker). */
  providerUnoffered: Record<string, string[]>;
  tenantId: string;
  timezone: string;
  initialDate: string;
  initialTime: string;
  initialProviderId?: string;
  /** Prefill the patient fields (e.g. booking a known patient from Recall). */
  initialName?: string;
  initialEmail?: string;
  initialPhone?: string;
  /**
   * When set, this booking came from a Recall row: on success we record a
   * recall_booking win against this patient node ($5 on the fee-rules ledger).
   */
  recallPatientNodeId?: string;
  viewAsUserId?: string;
  onBooked: (appointmentId?: string) => void;
}) {
  const [serviceId, setServiceId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [selectedAddons, setSelectedAddons] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  // Smart Schedule (mirrors the patient page): show the provider's real openings.
  // Owners keep a "Custom time" escape to book walk-ins / off-hours overrides.
  const [whenMode, setWhenMode] = useState<"soonest" | "day" | "custom">("soonest");
  const [pickedDay, setPickedDay] = useState("");
  const [chosenSlotIso, setChosenSlotIso] = useState<string | null>(null);
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  // Reseed date+time+provider whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setDate(initialDate);
      setTime(initialTime);
      setProviderId(initialProviderId ?? providers[0]?.id ?? "");
      setWhenMode("soonest");
      setPickedDay("");
      setChosenSlotIso(null);
      setSelectedAddons(new Set());
      setName(initialName ?? "");
      setEmail(initialEmail ?? "");
      setPhone(initialPhone ?? "");
    }
  }, [open, initialDate, initialTime, initialProviderId, providers, initialName, initialEmail, initialPhone]);

  // Add-ons offered with the chosen service. Each selection extends the visit
  // (combined duration drives the slot engine; combined price shows inline).
  const selService = useMemo(() => services.find((s) => s.id === serviceId) ?? null, [services, serviceId]);
  const addOns = selService?.addOns ?? [];
  const hasAddons = addOns.length > 0;
  const selectedAddonList = useMemo(
    () => addOns.filter((a) => selectedAddons.has(a.id)),
    [addOns, selectedAddons],
  );
  const extraMinutes = useMemo(
    () => selectedAddonList.reduce((s, a) => s + a.durationMin, 0),
    [selectedAddonList],
  );
  const addonPriceTotal = useMemo(
    () => selectedAddonList.reduce((s, a) => s + (a.isFree ? 0 : a.price), 0),
    [selectedAddonList],
  );
  function toggleAddon(id: string) {
    setSelectedAddons((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  // Switching service invalidates a prior service's add-on picks.
  useEffect(() => {
    setSelectedAddons(new Set());
  }, [serviceId]);

  // Load the chosen provider's real openings for Smart Schedule (not Custom).
  useEffect(() => {
    if (!open || whenMode === "custom" || !tenantId || !serviceId || !providerId) {
      setSlots([]);
      return;
    }
    let cancelled = false;
    setSlotsLoading(true);
    void (async () => {
      try {
        const now = new Date();
        const to = new Date(now.getTime() + 30 * 86_400_000);
        const r = await listAvailableSlots({
          data: {
            tenantId,
            serviceId,
            providerId,
            extraMinutes: extraMinutes || undefined,
            fromIso: now.toISOString(),
            toIso: to.toISOString(),
          },
        });
        if (!cancelled) setSlots(r.ok ? r.slots : []);
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, whenMode, tenantId, serviceId, providerId, extraMinutes]);

  // Group openings by day; "Pick a day" filters to the chosen date.
  const dayGroups = useMemo(() => {
    const byKey = new Map<string, { key: string; heading: string; slots: PublicSlot[] }>();
    const out: Array<{ key: string; heading: string; slots: PublicSlot[] }> = [];
    for (const s of slots) {
      const key = dayKey(s.startIso, timezone);
      let g = byKey.get(key);
      if (!g) {
        // fmtDayLabel expects a "YYYY-MM-DD" date key (it appends T12:00:00Z),
        // NOT a full ISO timestamp — pass key, not s.startIso.
        g = { key, heading: fmtDayLabel(key), slots: [] };
        byKey.set(key, g);
        out.push(g);
      }
      g.slots.push(s);
    }
    return out;
  }, [slots, timezone]);
  const visibleDayGroups = useMemo(() => {
    if (whenMode !== "day") return dayGroups;
    if (!pickedDay) return dayGroups.slice(0, 1);
    return dayGroups.filter((g) => g.key === pickedDay);
  }, [dayGroups, whenMode, pickedDay]);

  // Default the "Pick a day" date to the soonest day with openings.
  useEffect(() => {
    if (whenMode === "day" && !pickedDay && dayGroups.length > 0) setPickedDay(dayGroups[0].key);
  }, [whenMode, pickedDay, dayGroups]);

  const todayKey = dayKey(new Date().toISOString(), timezone);
  const maxKey = dayKey(new Date(Date.now() + 30 * 86_400_000).toISOString(), timezone);

  /** Picking a slot fills date+time so submit() builds the same startIso. */
  function pickSlot(s: PublicSlot) {
    setDate(dayKey(s.startIso, timezone));
    setTime(minToHHMM(localMinutes(s.startIso, timezone)));
    setChosenSlotIso(s.startIso);
  }
  // A time is chosen if Custom (manual fields) or a slot was clicked.
  const timeReady = whenMode === "custom" || chosenSlotIso !== null;

  // A prior slot pick is void once the service/provider/mode/add-ons change
  // (add-ons change the visit length, so the held slot may no longer fit).
  useEffect(() => {
    setChosenSlotIso(null);
  }, [serviceId, providerId, whenMode, extraMinutes]);

  // Service-first flow: pick the service, then choose among the providers who
  // actually perform it (opt-out model — all providers unless explicitly off).
  const eligibleProviders = useMemo(() => {
    if (!serviceId) return providers;
    return providers.filter((p) => !(providerUnoffered[p.id] ?? []).includes(serviceId));
  }, [providers, providerUnoffered, serviceId]);

  // Keep the selected provider valid for the chosen service — auto-pick the only
  // eligible one, or switch off an ineligible carry-over.
  useEffect(() => {
    if (!serviceId) return;
    if (!eligibleProviders.some((p) => p.id === providerId)) {
      setProviderId(eligibleProviders[0]?.id ?? "");
    }
  }, [serviceId, eligibleProviders, providerId]);

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
        data: { accessToken: token, viewAsUserId, serviceId, providerId: providerId || undefined, startIso, patientName: name.trim(), patientEmail: email.trim() || undefined, patientPhone: phone.trim() || undefined, addonServiceIds: selectedAddonList.map((a) => a.id) },
      });
      if (!r.ok) { toast.error(r.reason); return; }
      // Recall booking → record the $5 recall_booking win (best-effort; never
      // block the booking on the attribution write).
      if (recallPatientNodeId) {
        try {
          await recordRecallBookingFn({
            data: { accessToken: token, viewAsUserId, appointmentId: r.id, patientNodeId: recallPatientNodeId },
          });
          toast.success("Booked — recall win recorded.");
        } catch {
          toast.success("Booked.");
        }
      } else {
        toast.success("Booked.");
      }
      onBooked(r.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't book.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && !o && onClose()}>
      <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add booking</DialogTitle>
          <DialogDescription>Pick the day, time, and service to book a patient in.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 min-w-0">
          <Labeled label="Service">
            <ServicePicker services={services} value={serviceId} onChange={setServiceId} />
          </Labeled>
          {serviceId && eligibleProviders.length > 1 && (
            <Labeled label="Provider">
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={inputCls}>
                {eligibleProviders.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Labeled>
          )}
          {serviceId && providers.length > 1 && eligibleProviders.length === 1 && (
            <p className="text-[12px] text-ink-soft -mt-1">
              with <span className="font-medium text-ink">{eligibleProviders[0].name}</span>
            </p>
          )}
          {serviceId && eligibleProviders.length === 0 && (
            <p className="text-[12px] text-rose">
              No provider currently performs this service — assign one in Booking settings.
            </p>
          )}
          {serviceId && hasAddons && (
            <Labeled label="Add-ons (optional)">
              <div className="rounded-md border border-rule divide-y divide-rule/50 overflow-hidden">
                {addOns.map((a) => {
                  const checked = selectedAddons.has(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAddon(a.id)}
                      className={
                        "w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition " +
                        (checked ? "bg-emerald/10" : "hover:bg-paper/50")
                      }
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className={
                            "h-4 w-4 rounded border flex items-center justify-center shrink-0 " +
                            (checked ? "border-emerald bg-emerald" : "border-rule bg-white")
                          }
                        >
                          {checked && <Check className="h-3 w-3 text-paper" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-ink">{a.name}</span>
                          {a.activeOffer && (
                            <span className="inline-block mt-0.5 rounded-full bg-amber-soft text-amber text-[10.5px] font-semibold px-1.5 py-0.5">
                              {a.activeOffer.label}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="text-ink-faint tabular-nums shrink-0 whitespace-nowrap">
                        +{a.durationMin} min{a.isFree ? " · Free" : ` · +$${a.price}`}
                      </span>
                    </button>
                  );
                })}
              </div>
              {selectedAddonList.length > 0 && (
                <p className="mt-1.5 text-[12px] text-ink-soft">
                  Total visit:{" "}
                  <span className="font-medium text-ink tabular-nums">
                    {(selService?.durationMin ?? 0) + extraMinutes} min
                  </span>
                  {addonPriceTotal > 0 ? ` · +$${addonPriceTotal} add-ons` : ""}
                </p>
              )}
            </Labeled>
          )}
          {serviceId && providerId && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5">When</div>
              <div className="inline-flex rounded-md border border-rule overflow-hidden text-[12px] mb-3">
                {([
                  { k: "soonest", label: "Soonest", icon: CalendarClock },
                  { k: "day", label: "Pick a day", icon: CalendarRange },
                  { k: "custom", label: "Custom time", icon: Pencil },
                ] as const).map(({ k, label, icon: Icon }, i) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setWhenMode(k)}
                    className={
                      "inline-flex items-center gap-1.5 px-2.5 py-1.5 font-medium transition " +
                      (i > 0 ? "border-l border-rule " : "") +
                      (whenMode === k ? "bg-emerald text-paper" : "text-ink-soft hover:text-ink")
                    }
                  >
                    <Icon className="h-3.5 w-3.5" /> {label}
                  </button>
                ))}
              </div>

              {whenMode === "custom" ? (
                <div className="grid grid-cols-2 gap-3">
                  <Labeled label="Day"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></Labeled>
                  <Labeled label="Time"><TimeSelect value={time} onChange={setTime} className={`${inputCls} tabular-nums`} /></Labeled>
                </div>
              ) : (
                <div className="space-y-3">
                  {whenMode === "day" && (
                    <input
                      type="date"
                      value={pickedDay}
                      min={todayKey}
                      max={maxKey}
                      onChange={(e) => setPickedDay(e.target.value)}
                      className={inputCls}
                    />
                  )}
                  {slotsLoading ? (
                    <div className="flex items-center gap-2 text-ink-soft text-[13px] py-3">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding open times…
                    </div>
                  ) : visibleDayGroups.length === 0 ? (
                    <p className="text-[13px] text-ink-soft py-3">
                      {whenMode === "day"
                        ? "No openings that day — try another date or Custom time."
                        : "No open times in the next 30 days. Use Custom time to override."}
                    </p>
                  ) : (
                    <div className="min-w-0 flex flex-col sm:flex-row gap-y-4 sm:gap-x-3 max-h-[40vh] overflow-y-auto sm:overflow-y-hidden sm:overflow-x-auto pr-1 sm:pb-2">
                      {visibleDayGroups.map((g) => (
                        <div key={g.key} className="sm:shrink-0 sm:w-32 sm:max-h-[38vh] sm:overflow-y-auto">
                          <div className="text-[12px] font-semibold text-ink-soft mb-1.5 sm:text-center sm:sticky sm:top-0 sm:bg-paper sm:pb-1">
                            {g.heading}
                          </div>
                          <div className="grid grid-cols-3 sm:grid-cols-1 gap-1.5">
                            {g.slots.map((s) => (
                              <button
                                key={`${s.startIso}-${s.providerId}`}
                                type="button"
                                onClick={() => pickSlot(s)}
                                className={
                                  "rounded-md border px-2 py-1.5 text-[13px] tabular-nums transition sm:text-center " +
                                  (chosenSlotIso === s.startIso
                                    ? "border-emerald bg-emerald text-paper"
                                    : "border-rule bg-white text-ink hover:border-emerald")
                                }
                              >
                                {fmtTime(s.startIso, timezone)}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <Labeled label="Patient name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Email (optional)"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} /></Labeled>
            <Labeled label="Phone (optional)"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} /></Labeled>
          </div>
        </div>
        <DialogFooter>
          <button type="button" disabled={busy} onClick={onClose} className={btnGhost}>Cancel</button>
          <button type="button" disabled={busy || !serviceId || !providerId || !timeReady || !name.trim()} onClick={submit} className={btnPrimary}>
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
          {appt && appt.addOns.length > 0 && (
            <div className="rounded-md border border-rule bg-paper/40 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1">Add-ons</div>
              <ul className="space-y-0.5">
                {appt.addOns.map((a, i) => (
                  <li key={i} className="flex items-center justify-between text-[13px] text-ink-soft">
                    <span className="truncate">{a.name}</span>
                    <span className="tabular-nums shrink-0 whitespace-nowrap">
                      +{a.durationMin} min{a.price > 0 ? ` · $${a.price}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-ink-faint">
                Duration above includes add-on time. Editing duration won&rsquo;t change the saved add-ons.
              </p>
            </div>
          )}
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

// ── Manage providers (which columns show on the calendar) — v2.46.0 ──────────

export function ManageProvidersDialog({
  open,
  viewAsUserId,
  onClose,
  onChanged,
}: {
  open: boolean;
  viewAsUserId?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ManagedProvider[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function load() {
    setRows(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      setRows(await listManagedProvidersFn({ data: { accessToken: token, viewAsUserId } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load providers.");
      setRows([]);
    }
  }

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function toggle(p: ManagedProvider) {
    setBusyId(p.id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const r = await setProviderVisibilityFn({
        data: { accessToken: token, viewAsUserId, providerId: p.id, hidden: !p.hidden },
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      await load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update.");
    } finally {
      setBusyId(null);
    }
  }

  function startRename(p: ManagedProvider) {
    setEditingId(p.id);
    setDraft(p.displayName ?? p.name);
  }

  async function saveRename(p: ManagedProvider) {
    setBusyId(p.id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const r = await setProviderDisplayNameFn({
        data: { accessToken: token, viewAsUserId, providerId: p.id, displayName: draft },
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      setEditingId(null);
      await load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't rename.");
    } finally {
      setBusyId(null);
    }
  }

  const visibleCount = (rows ?? []).filter((r) => !r.hidden).length;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Calendar providers</DialogTitle>
          <DialogDescription>
            Choose which columns show on your calendar, and rename them. An imported calendar
            named after your business can be renamed (e.g. to the provider who works it) or
            hidden — your rename sticks even when the calendar re-syncs. Clear a name to go back
            to the calendar&rsquo;s own.
          </DialogDescription>
        </DialogHeader>
        {rows === null ? (
          <div className="flex items-center gap-2 py-8 text-[13px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-[13px] text-ink-soft">No providers yet.</p>
        ) : (
          <ul className="divide-y divide-rule -my-1">
            {rows.map((p) => {
              const effName = p.displayName ?? p.name;
              const renamed = p.displayName != null && p.displayName !== p.name;
              if (editingId === p.id) {
                return (
                  <li key={p.id} className="flex items-center gap-2 py-2.5">
                    <input
                      autoFocus
                      value={draft}
                      maxLength={80}
                      placeholder={p.name}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void saveRename(p);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      className="min-w-0 flex-1 rounded-md border border-rule bg-white px-2.5 py-1.5 text-[13.5px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                    />
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => void saveRename(p)}
                      title="Save name"
                      className="inline-flex items-center justify-center rounded-lg border border-emerald/40 bg-emerald/10 p-1.5 text-emerald hover:bg-emerald/20 transition disabled:opacity-40 shrink-0"
                    >
                      {busyId === p.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      title="Cancel"
                      className="inline-flex items-center justify-center rounded-lg border border-rule bg-white p-1.5 text-ink-soft hover:bg-rule-soft transition shrink-0"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                );
              }
              return (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                      <span className={`truncate ${p.hidden ? "text-ink-soft line-through" : ""}`}>{effName}</span>
                      {p.isPrimary && <ProviderTag>Primary</ProviderTag>}
                      {p.isMirrored && <ProviderTag>Acuity</ProviderTag>}
                    </div>
                    <div className="text-[11.5px] text-ink-soft">
                      {renamed && <span>Calendar: {p.name} · </span>}
                      {p.apptCount} {p.apptCount === 1 ? "appointment" : "appointments"}
                      {p.hidden
                        ? " · hidden from calendar"
                        : p.apptCount > 0
                          ? " · hiding also hides these"
                          : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => startRename(p)}
                      title="Rename column"
                      className="inline-flex items-center justify-center rounded-lg border border-rule bg-white p-1.5 text-ink-soft hover:bg-rule-soft transition"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => void toggle(p)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink-soft hover:bg-rule-soft transition disabled:opacity-40"
                    >
                      {busyId === p.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : p.hidden ? (
                        <Eye className="h-3.5 w-3.5" />
                      ) : (
                        <EyeOff className="h-3.5 w-3.5" />
                      )}
                      {p.hidden ? "Show" : "Hide"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {rows && rows.length > 0 && visibleCount === 0 && (
          <p className="text-[12px] text-amber">
            Every provider is hidden — your calendar grid will be empty until you show one.
          </p>
        )}
        <DialogFooter>
          <button type="button" onClick={onClose} className={btnGhost}>
            Done
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-rule-soft px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-soft shrink-0">
      {children}
    </span>
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
