/**
 * Shared pure helpers, types, and constants for the owner schedule page
 * (extracted from app.refill.schedule.tsx in the v1.67.x consolidation sprint).
 * No React — pure date/layout math + per-provider accent constants.
 */

import type { AddOnLite, DayAppointment, DayBlock } from "@/server/scheduling-owner.functions";
import type { AddOnOffer } from "@/lib/promo-calendar";

export type View = "day" | "week" | "month";
export type ServiceLite = {
  id: string;
  name: string;
  durationMin: number;
  category: string;
  sortOrder: number | null;
  addOns: AddOnLite[];
  activeOffer?: AddOnOffer | null;
};

// Zoom = pixels-per-minute for the positioned grids. Default is "comfortable"
// so a 30-min appt is tall enough to show name + time without clipping.
export const ZOOM_LEVELS = [0.7, 1.0, 1.4, 2.0, 2.8];
export const DEFAULT_ZOOM_IDX = 2; // 1.4 px/min
export const ZOOM_KEY = "refill.schedule.zoom";
// Minimum card heights so a short appointment is still tall enough to show
// name + time without clipping (longer appts size by their real duration).
export const MIN_DAY_CARD_PX = 40;
export const MIN_WEEK_CARD_PX = 40;
export const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Per-provider header accent dot (cards/bands stay emerald — the column + name
// identify the provider; this is a small additive touch, not a restyle).
export const PROVIDER_DOTS = [
  "bg-emerald",
  "bg-sky-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-orange-500",
];
export function providerDot(i: number): string {
  return PROVIDER_DOTS[i % PROVIDER_DOTS.length];
}

export function computeSpan(view: View, dateIso: string): { fromDate: string; toDateExclusive: string } {
  if (view === "day") return { fromDate: dateIso, toDateExclusive: addDays(dateIso, 1) };
  if (view === "week") {
    const start = mondayOf(dateIso);
    return { fromDate: start, toDateExclusive: addDays(start, 7) };
  }
  const gridStart = mondayOf(startOfMonth(dateIso));
  return { fromDate: gridStart, toDateExclusive: addDays(gridStart, 42) };
}

export function padWindow(start: number, end: number): { start: number; end: number } {
  let s = Math.max(0, Math.floor((start - 30) / 60) * 60);
  let e = Math.min(24 * 60, Math.ceil((end + 30) / 60) * 60);
  if (e <= s) e = s + 60;
  return { start: s, end: e };
}

export function hourMarks(win: { start: number; end: number }): number[] {
  const out: number[] = [];
  for (let m = win.start; m <= win.end; m += 60) out.push(m);
  return out;
}

export function groupByDay(appts: DayAppointment[], tz: string): Map<string, DayAppointment[]> {
  const m = new Map<string, DayAppointment[]>();
  for (const a of appts) {
    const k = dayKey(a.startIso, tz);
    const arr = m.get(k);
    if (arr) arr.push(a);
    else m.set(k, [a]);
  }
  return m;
}

export function groupBlocksByDay(blocks: DayBlock[], tz: string): Map<string, DayBlock[]> {
  const m = new Map<string, DayBlock[]>();
  for (const b of blocks) {
    const k = dayKey(b.startIso, tz);
    const arr = m.get(k);
    if (arr) arr.push(b);
    else m.set(k, [b]);
  }
  return m;
}

/**
 * Lane-pack overlapping appointments into side-by-side columns (Google-Calendar
 * style) so simultaneous bookings sit beside each other instead of stacking on
 * top of one another and hiding the ones underneath. Returns id -> {lane, lanes}
 * where `lane` is the 0-indexed sub-column and `lanes` is the width divisor (the
 * peak concurrency of that appointment's overlap cluster, so every member of a
 * cluster divides the column by the same amount and the widths line up).
 *
 * Pure; works off real start/end minutes in the given tz. A zero/negative span
 * is floored to 5 min so a same-instant pair still registers as overlapping.
 */
export function assignApptLanes(
  appts: DayAppointment[],
  tz: string,
): Map<string, { lane: number; lanes: number }> {
  const out = new Map<string, { lane: number; lanes: number }>();
  if (appts.length === 0) return out;

  const items = appts
    .map((a) => {
      const start = localMinutes(a.startIso, tz);
      const end = Math.max(start + 5, localMinutes(a.endIso, tz));
      return { id: a.id, start, end };
    })
    .sort((x, y) => x.start - y.start || x.end - y.end);

  // Walk start-ordered, breaking into clusters of transitively-overlapping
  // intervals. Within a cluster, greedily take the lowest lane free at this
  // start; the cluster's divisor is the max lane used + 1.
  let cluster: { id: string; end: number; lane: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    if (cluster.length === 0) return;
    const lanes = Math.max(...cluster.map((c) => c.lane)) + 1;
    for (const c of cluster) out.set(c.id, { lane: c.lane, lanes });
    cluster = [];
    clusterEnd = -1;
  };
  for (const it of items) {
    if (cluster.length > 0 && it.start >= clusterEnd) flush();
    const taken = new Set(cluster.filter((c) => c.end > it.start).map((c) => c.lane));
    let lane = 0;
    while (taken.has(lane)) lane++;
    cluster.push({ id: it.id, end: it.end, lane });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

export function snap5(mins: number, win: { start: number; end: number }): number {
  const snapped = Math.round(mins / 5) * 5;
  return Math.max(win.start, Math.min(win.end - 5, snapped));
}

export function minToHHMM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function todayIso(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const base = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, lastDay));
  return base.toISOString().slice(0, 10);
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function mondayOf(iso: string): string {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  const back = (dow + 6) % 7; // days since Monday
  return addDays(iso, -back);
}

export function fmtDayLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(`${iso}T12:00:00Z`));
}

export function fmtWeekLabel(fromDate: string, toDateExclusive: string): string {
  const last = addDays(toDateExclusive, -1);
  const a = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${fromDate}T12:00:00Z`));
  const b = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${last}T12:00:00Z`));
  return `${a} – ${b}`;
}

export function fmtMonthLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${iso}T12:00:00Z`));
}

export function fmtHour(min: number): string {
  const h = Math.floor(min / 60);
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${ampm}`;
}

export function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function dayKey(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function localMinutes(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = parseInt(p.value, 10);
    if (p.type === "minute") m = parseInt(p.value, 10);
  }
  return h * 60 + m;
}
