/**
 * Smart Scheduling — the slot-generation engine (the one piece of genuinely new IP).
 *
 * A PURE function. No DB calls, no I/O, no `Date.now()` inside the core — `now`
 * is always passed in so the engine is deterministic and trivially testable. The
 * caller (a server fn) loads settings / hours / blocks / existing appointments
 * from the DB and hands them here; this module does only interval math.
 *
 * ── DESIGN DECISIONS (validated by the math-audit subagent) ──────────────────
 *
 *  1. TIMEZONE / DST. Business hours are stored as WALL-CLOCK times ("09:00") in
 *     the tenant's IANA timezone. For each calendar date we convert that wall
 *     clock to the correct UTC instant using the runtime `Intl` API (which ships
 *     a full tz database on Cloudflare Workers). DST is handled by a two-pass
 *     offset resolution — the offset is re-checked at the corrected instant so a
 *     date whose offset differs from the naive guess (i.e. across a DST boundary)
 *     still lands correctly. For the rare nonexistent/ambiguous wall-clock times
 *     inside a DST transition (spring-forward gap / fall-back overlap), we resolve
 *     deterministically to the post-transition offset. Med-spa business hours
 *     essentially never fall in those windows, but the math is correct regardless.
 *
 *  2. BUFFER. Every appointment RESERVES `[start, start + duration + buffer)` —
 *     the body plus trailing turnover/cleanup time. Applying this one rule
 *     uniformly to BOTH existing appointments and the candidate slot makes the
 *     guarantee symmetric: there is always at least `buffer` minutes between any
 *     two bookings. The appointment BODY (`[start, start + duration)`) must fit
 *     within business hours; the trailing buffer is allowed to run past closing
 *     (you can clean up after the last patient of the day).
 *
 *     NOTE on the DB guarantee: the Postgres EXCLUDE constraint keys on the body
 *     range only (`during` = body, no buffer) — so the DATABASE guarantees no
 *     physical BODY overlap (the hard, never-double-booked promise), while THIS
 *     engine additionally enforces the softer buffer gap on the read/offer side.
 *
 *  3. GRID. Candidate start times step by `slotGranularityMin` (e.g. every 15
 *     min) across the open interval — so a 30-min service still offers :00/:15/
 *     :30/:45 starts; the overlap check prevents any that would collide.
 *
 *  4. HALF-OPEN INTERVALS `[)`. Matches the Postgres tstzrange default, so a
 *     10:00–10:30 and a 10:30–11:00 booking do NOT conflict (boundary touch is
 *     allowed); 10:00–10:30 and 10:15–10:45 DO conflict.
 */

const MIN = 60_000; // ms per minute

// ── Public types ────────────────────────────────────────────────────────────

export interface SlotEngineSettings {
  /** IANA tz name, e.g. "America/Los_Angeles". */
  timezone: string;
  /** Grid spacing for candidate start times, minutes (e.g. 15). */
  slotGranularityMin: number;
  /** Patients cannot book closer than this many minutes from `now`. */
  minAdvanceNoticeMin: number;
  /** Patients cannot book further out than this many days from `now`. */
  maxAdvanceDays: number;
}

export interface ProviderHoursRow {
  /** Postgres DOW: 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** Wall-clock "HH:MM" or "HH:MM:SS" in the tenant timezone. */
  openTime: string;
  closeTime: string;
  isClosed: boolean;
}

/** A whole-day override of the weekly hours for one calendar date. When present
 *  for a date, it REPLACES that day's weekly hours (closed, or new open/close). */
export interface DateOverrideRow {
  /** Calendar date "YYYY-MM-DD" in the tenant timezone. */
  date: string;
  isClosed: boolean;
  /** Wall-clock "HH:MM[:SS]" — null when closed. */
  openTime: string | null;
  closeTime: string | null;
}

/** An existing appointment that occupies time (status <> 'cancelled'). */
export interface ExistingAppointment {
  /** UTC start, ms since epoch. */
  startMs: number;
  durationMin: number;
  /** Trailing buffer for THIS appointment's service (0 if unknown). */
  bufferMin: number;
}

/** A hard-unavailability window (vacation/holiday/lunch). UTC ms. */
export interface BlockInterval {
  startMs: number;
  endMs: number;
}

export interface ServiceSpec {
  durationMin: number;
  bufferMin: number;
}

export interface Slot {
  /** UTC ISO of the appointment start. */
  startIso: string;
  /** UTC ISO of the appointment END (body only, excludes buffer). */
  endIso: string;
  /** Convenience: start as ms since epoch. */
  startMs: number;
}

export interface AvailableSlotsArgs {
  settings: SlotEngineSettings;
  /** The provider's weekly hours (0..6). Missing weekday ⇒ closed. */
  hours: ProviderHoursRow[];
  /** Whole-day overrides keyed by date; replace weekly hours for that date. */
  dateOverrides?: DateOverrideRow[];
  /** Existing non-cancelled appointments for this provider. */
  busy: ExistingAppointment[];
  /** Hard-block windows overlapping the range. */
  blocks: BlockInterval[];
  /** The service being booked (drives duration + buffer). */
  service: ServiceSpec;
  /** Inclusive lower bound of the search window (a UTC instant). */
  rangeStart: Date;
  /** Exclusive upper bound of the search window (a UTC instant). */
  rangeEnd: Date;
  /** "Now" — injected for determinism. */
  now: Date;
}

// ── Timezone helpers (Intl-based, dependency-free, DST-correct) ──────────────

/**
 * The offset, in minutes, that `timeZone` is AHEAD of UTC at the given instant.
 * e.g. America/Los_Angeles in July (PDT) ⇒ -420; in January (PST) ⇒ -480.
 */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const m: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") m[p.type] = parseInt(p.value, 10);
  }
  // The wall-clock the tz shows for this instant, read back AS IF it were UTC.
  const asIfUtc = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
  return Math.round((asIfUtc - instant.getTime()) / MIN);
}

/**
 * Convert a wall-clock time on a given calendar date in `timeZone` to the correct
 * UTC instant. Two-pass: guess assuming the wall clock is UTC, subtract the tz
 * offset at the guess, then re-check the offset at the corrected instant and
 * re-correct if it changed (the DST-boundary case).
 */
export function zonedWallClockToUtc(
  year: number,
  month1to12: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guessUtc = Date.UTC(year, month1to12 - 1, day, hour, minute, 0);
  const o1 = tzOffsetMinutes(new Date(guessUtc), timeZone);
  let utc = guessUtc - o1 * MIN;
  const o2 = tzOffsetMinutes(new Date(utc), timeZone);
  if (o2 !== o1) {
    utc = guessUtc - o2 * MIN;
  }
  return new Date(utc);
}

/** The calendar Y/M/D and weekday a tz shows at a given instant. */
export function zonedDateParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") m[p.type] = p.value;
  }
  const WD: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year: parseInt(m.year, 10),
    month: parseInt(m.month, 10),
    day: parseInt(m.day, 10),
    weekday: WD[m.weekday],
  };
}

/**
 * Today's calendar date as "YYYY-MM-DD" IN a given IANA timezone.
 *
 * `new Date().toISOString().slice(0,10)` gives the UTC date — which rolls to
 * "tomorrow" in the evening for any US timezone (after 6pm in UTC-6), so a
 * date-only comparison like a promo's start/end boundary fires hours early.
 * This resolves the wall-clock date in the spa's own timezone instead.
 */
export function todayIsoInTz(timeZone: string, instant: Date = new Date()): string {
  const { year, month, day } = zonedDateParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Parse "HH:MM" / "HH:MM:SS" wall clock to {hour, minute}. */
function parseWallClock(t: string): { hour: number; minute: number } {
  const [h, mn] = t.split(":");
  return { hour: parseInt(h, 10), minute: parseInt(mn ?? "0", 10) };
}

/** Half-open overlap: do [aS,aE) and [bS,bE) share any point? */
function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

// ── The engine ───────────────────────────────────────────────────────────────

/**
 * Generate the bookable slots for one provider + one service across a date range.
 * Pure; deterministic given its inputs.
 */
export function availableSlots(args: AvailableSlotsArgs): Slot[] {
  const { settings, hours, busy, blocks, service, rangeStart, rangeEnd, now } = args;
  // Date-specific overrides win over weekly hours for the matching calendar date.
  const overrideByDate = new Map<string, DateOverrideRow>();
  for (const o of args.dateOverrides ?? []) overrideByDate.set(o.date, o);
  const pad2 = (n: number) => String(n).padStart(2, "0");

  const granMs = settings.slotGranularityMin * MIN;
  const bodyMs = service.durationMin * MIN;
  const reserveMs = (service.durationMin + service.bufferMin) * MIN; // body + buffer
  const earliestMs = now.getTime() + settings.minAdvanceNoticeMin * MIN;
  const latestMs = now.getTime() + settings.maxAdvanceDays * 24 * 60 * MIN;

  // Index hours by weekday for O(1) lookup.
  const hoursByDow = new Map<number, ProviderHoursRow>();
  for (const h of hours) hoursByDow.set(h.dayOfWeek, h);

  // Pre-expand existing appointments to their reservations [start, start+dur+buf).
  const busyReservations = busy.map((a) => ({
    s: a.startMs,
    e: a.startMs + (a.durationMin + a.bufferMin) * MIN,
  }));

  const slots: Slot[] = [];

  // Walk calendar dates in the tenant tz from rangeStart..rangeEnd. We iterate by
  // stepping a cursor and reading the tz-local date; we advance a full day at a
  // time using the tz-local midnight so DST day-length changes don't drift.
  // Cap the loop defensively (range should be days, not years).
  const startParts = zonedDateParts(rangeStart, settings.timezone);
  let cursorY = startParts.year;
  let cursorM = startParts.month;
  let cursorD = startParts.day;

  for (let guard = 0; guard < 400; guard++) {
    // The tz-local midnight of the cursor date, as a UTC instant.
    const dayMidnightUtc = zonedWallClockToUtc(
      cursorY, cursorM, cursorD, 0, 0, settings.timezone,
    );
    if (dayMidnightUtc.getTime() >= rangeEnd.getTime()) break;

    const { weekday } = zonedDateParts(dayMidnightUtc, settings.timezone);
    const h = hoursByDow.get(weekday);

    // Resolve the day's effective open band: a date override (if any) replaces
    // the weekly hours entirely; otherwise fall back to the weekday row.
    const dateK = `${cursorY}-${pad2(cursorM)}-${pad2(cursorD)}`;
    const ov = overrideByDate.get(dateK);
    const effClosed = ov ? ov.isClosed || !ov.openTime || !ov.closeTime : !h || h.isClosed;
    const effOpenTime = ov ? ov.openTime : h?.openTime;
    const effCloseTime = ov ? ov.closeTime : h?.closeTime;

    if (!effClosed && effOpenTime && effCloseTime) {
      const open = parseWallClock(effOpenTime);
      const close = parseWallClock(effCloseTime);
      const openUtc = zonedWallClockToUtc(
        cursorY, cursorM, cursorD, open.hour, open.minute, settings.timezone,
      ).getTime();
      const closeUtc = zonedWallClockToUtc(
        cursorY, cursorM, cursorD, close.hour, close.minute, settings.timezone,
      ).getTime();

      // Step candidate starts across the open interval. Body must fit by close;
      // trailing buffer may run past close.
      for (let t = openUtc; t + bodyMs <= closeUtc; t += granMs) {
        if (t < earliestMs) continue;      // too soon
        if (t < rangeStart.getTime()) continue;
        if (t >= rangeEnd.getTime()) break;
        if (t > latestMs) break;           // past max advance — nothing later qualifies either

        const bodyEnd = t + bodyMs;
        const reserveEnd = t + reserveMs;

        // Candidate body must not intersect any hard block.
        let blocked = false;
        for (const b of blocks) {
          if (overlaps(t, bodyEnd, b.startMs, b.endMs)) { blocked = true; break; }
        }
        if (blocked) continue;

        // Candidate reservation (body+buffer) must not collide with any existing
        // reservation.
        let collides = false;
        for (const r of busyReservations) {
          if (overlaps(t, reserveEnd, r.s, r.e)) { collides = true; break; }
        }
        if (collides) continue;

        slots.push({
          startIso: new Date(t).toISOString(),
          endIso: new Date(bodyEnd).toISOString(),
          startMs: t,
        });
      }
    }

    // Advance to the next calendar date (tz-local). Use a noon anchor + 24h so we
    // never land back on the same date across a DST boundary, then re-read parts.
    const noonUtc = zonedWallClockToUtc(
      cursorY, cursorM, cursorD, 12, 0, settings.timezone,
    );
    const nextDayInstant = new Date(noonUtc.getTime() + 24 * 60 * MIN);
    const np = zonedDateParts(nextDayInstant, settings.timezone);
    cursorY = np.year;
    cursorM = np.month;
    cursorD = np.day;
  }

  return slots;
}
