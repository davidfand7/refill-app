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
export const DEFAULT_ZOOM_IDX = 3; // 2.0 px/min — more vertical breathing room (v2.56.1)
export const ZOOM_KEY = "refill.schedule.zoom";
// Minimum card heights — every card must be tall enough to show its full info
// (patient name + time) WITHOUT clipping. A card never renders shorter than this.
export const MIN_DAY_CARD_PX = 44;
export const MIN_WEEK_CARD_PX = 44;
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
export type AnchorLayout = {
  /** id -> pixel top = its real start time on the rail (always). */
  topOf: Map<string, number>;
  /** id -> pixel height: its real duration, but SHRUNK to the gap before the
   *  next appointment so cards never overlap. Tightly-packed appts get compact
   *  (the card content adapts), but every card's TOP stays on its true time. */
  heightOf: Map<string, number>;
};

/**
 * Anchor-to-time + shrink-to-fit layout (v2.56.4 — Grasshopper's call, matching
 * Acuity). Every card's top sits exactly on its start-time line, so a 1:00 PM
 * card is always at 1:00 and columns line up across the rail. A card is as tall
 * as its real duration, but never taller than the gap to the next appointment —
 * so a packed run compresses into snug, non-overlapping cards (content trims via
 * the card itself) while an open stretch shows true durations and real gaps.
 */
export function anchorApptCards(
  appts: DayAppointment[],
  tz: string,
  pxPerMin: number,
  winStart: number,
): AnchorLayout {
  const GAP = 2;
  const MIN_VIS = 20; // a card never collapses below this (room for one clean line)
  const topOf = new Map<string, number>();
  const heightOf = new Map<string, number>();
  const sorted = appts
    .map((a) => ({ a, start: localMinutes(a.startIso, tz) }))
    .sort((x, y) => x.start - y.start || (y.a.durationMin || 0) - (x.a.durationMin || 0));
  for (let i = 0; i < sorted.length; i++) {
    const { a, start } = sorted[i];
    const top = (start - winStart) * pxPerMin;
    const desired = Math.max(MIN_VIS, (a.durationMin || 0) * pxPerMin);
    const nextStart = i + 1 < sorted.length ? sorted[i + 1].start : null;
    const height =
      nextStart == null
        ? desired
        : Math.max(MIN_VIS, Math.min(desired, (nextStart - start) * pxPerMin - GAP));
    topOf.set(a.id, top);
    heightOf.set(a.id, height);
  }
  return { topOf, heightOf };
}

// ── Treatment color-coding (v2.56.6, matches Acuity's per-type coloring) ──────
// Soft pastel fills so a packed day is scannable by treatment at a glance.
// Common med-spa treatments are PINNED to a sensible hue; anything else gets a
// stable color hashed from its name (same treatment → same color every time).
const TREATMENT_PALETTE: Array<{ bg: string; border: string }> = [
  { bg: "#efe9fe", border: "#c4b5fd" }, // 0 violet
  { bg: "#fce7f3", border: "#f9a8d4" }, // 1 pink
  { bg: "#dcfce7", border: "#86efac" }, // 2 green
  { bg: "#dbeafe", border: "#93c5fd" }, // 3 blue
  { bg: "#fef3c7", border: "#fcd34d" }, // 4 amber
  { bg: "#ccfbf1", border: "#5eead4" }, // 5 teal
  { bg: "#e0e7ff", border: "#a5b4fc" }, // 6 indigo
  { bg: "#ffedd5", border: "#fdba74" }, // 7 orange
  { bg: "#fae8ff", border: "#e9b8f5" }, // 8 fuchsia
  { bg: "#cffafe", border: "#67e8f9" }, // 9 cyan
];
const TREATMENT_PINS: Array<[RegExp, number]> = [
  [/\b(tox|botox|dysport|jeuveau|xeomin|daxxify|neurotox)/i, 0], // violet
  [/\b(filler|juvederm|restylane|rha|versa|lip)/i, 1], // pink
  [/(sculptra|radiesse|collagen|biostim)/i, 2], // green
  [/(laser|thulium|ipl|bbl|co2|moxi|halo|clear)/i, 3], // blue
  [/(peel|chemical)/i, 4], // amber
  [/(facial|hydra|dermaplan)/i, 5], // teal
  [/(microneedl|morpheus|\brf\b|skinpen)/i, 6], // indigo
  [/(consult|follow|review|new patient|membership)/i, 8], // fuchsia
  [/(weight|semaglutide|tirzep|\biv\b|wellness|inject|b12|vitamin)/i, 9], // cyan
];

/** Stable soft-pastel {bg, border} for a treatment type (pinned or hashed). */
export function treatmentColor(treatment: string): { bg: string; border: string } {
  const t = treatment.trim();
  for (const [re, idx] of TREATMENT_PINS) if (re.test(t)) return TREATMENT_PALETTE[idx];
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return TREATMENT_PALETTE[h % TREATMENT_PALETTE.length];
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
