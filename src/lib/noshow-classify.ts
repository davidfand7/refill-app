/**
 * The canonical no-show classifier — Reschedule Reminders (v2.34.0).
 *
 * ONE source of truth for "what really happened to this appointment," on the
 * spa's OWN definition. A cancellation given inside the spa's required notice
 * window is a late cancel and is reclassified as a no-show; a cancellation
 * given with fair notice is an honored cancel. When we don't know WHEN the
 * cancel happened, we never brand the patient a no-show — the status stands and
 * `noticeKnown` is false so the UI can say so plainly.
 *
 * Pure (no I/O, no Date.now()): every input is passed in, so the matcher, the
 * settings preview, and (later) the reliability engine all agree. Lead-time is
 * a difference of two instants, so it is timezone-independent — "24 hours'
 * notice" is 24 hours regardless of the spa's locale.
 */

export type AppointmentOutcome =
  | "attended" // showed (or a still-pending status — caller should gate)
  | "cancel_honored" // cancelled with fair notice (≥ the spa's window)
  | "no_show" // never showed, OR a late cancel reclassified by the rule
  | "rescheduled"; // already moved to a new time — not a target

export type OutcomeResult = {
  outcome: AppointmentOutcome;
  /** False only for a cancellation whose timing we couldn't determine. */
  noticeKnown: boolean;
  /** Hours of notice the patient gave (scheduled_at − cancelled_at). Null when
   *  not applicable (showed/rescheduled) or unknown (untimed cancel). */
  leadHours: number | null;
};

export function classifyAppointmentOutcome(input: {
  /** appointments.status */
  status: string;
  /** ISO instant of the appointment time. */
  scheduledAt: string;
  /** ISO instant the cancellation was made, or null = unknown. */
  cancelledAt: string | null;
  /** The spa's required notice window in hours (noshow_notice_hours). */
  noticeHours: number;
}): OutcomeResult {
  const { status } = input;

  if (status === "rescheduled")
    return { outcome: "rescheduled", noticeKnown: true, leadHours: null };
  if (status === "no_show")
    return { outcome: "no_show", noticeKnown: true, leadHours: 0 };
  if (status !== "cancelled")
    // showed / scheduled / confirmed / anything non-terminal — the caller
    // should only classify terminal outcomes; treat the rest as benign.
    return { outcome: "attended", noticeKnown: true, leadHours: null };

  // status === "cancelled" — the load-bearing case.
  if (!input.cancelledAt)
    return { outcome: "cancel_honored", noticeKnown: false, leadHours: null };

  const sched = Date.parse(input.scheduledAt);
  const canc = Date.parse(input.cancelledAt);
  if (!Number.isFinite(sched) || !Number.isFinite(canc))
    return { outcome: "cancel_honored", noticeKnown: false, leadHours: null };

  const leadHours = (sched - canc) / 3_600_000;
  return leadHours >= input.noticeHours
    ? { outcome: "cancel_honored", noticeKnown: true, leadHours } // fair notice
    : { outcome: "no_show", noticeKnown: true, leadHours }; // late cancel → no-show
}
