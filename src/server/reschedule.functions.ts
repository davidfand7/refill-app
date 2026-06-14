/**
 * Reschedule Reminders — server functions (v2.34.0, Slice 1).
 *
 * Slice 1 ships the canonical no-show classification + the settings preview —
 * NO sending yet. `getRescheduleClassificationPreview` runs the operator's own
 * notice rule over their recent cancellations and tells them, in plain numbers,
 * how many of those "cancellations" are really no-shows by that rule — making
 * the abstract rule concrete against real data before a single message is sent.
 *
 * The drafting/sending path + the /recovery/reschedule page land in Slice 2.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import { classifyAppointmentOutcome } from "@/lib/noshow-classify";

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type AnySb = ReturnType<typeof admin>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loose(sb: AnySb): { from(t: string): any } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sb as unknown as { from(t: string): any };
}

/** The illustration window for the settings preview (independent of the
 *  operational lookback — it's a "what does my rule do" snapshot). */
const PREVIEW_WINDOW_DAYS = 30;

export type RescheduleClassificationPreview = {
  windowDays: number;
  /** The spa's current notice rule (hours). */
  noticeHours: number;
  /** status='cancelled' rows in the window. */
  cancelledTotal: number;
  /** Of those: cancelled with fair notice (≥ the rule). */
  cancelHonored: number;
  /** Of those: cancelled too late → counts as a no-show by the rule. */
  lateCancelsAsNoShow: number;
  /** Of those: cancellation time unknown → stays a cancel (never branded). */
  noticeUnknown: number;
  /** status='no_show' rows in the window (always no-shows). */
  noShowTotal: number;
};

const previewInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  /** Optionally preview against a hypothetical rule (the slider's live value)
   *  without saving it first. Falls back to the saved policy. */
  noticeHoursOverride: z.number().int().min(0).max(336).optional(),
});

export const getRescheduleClassificationPreview = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => previewInput.parse(raw))
  .handler(async ({ data }): Promise<RescheduleClassificationPreview> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // The notice rule: the live slider value if given, else the saved policy.
    let noticeHours = data.noticeHoursOverride;
    if (noticeHours === undefined) {
      const { data: policy } = await loose(sb)
        .from("emma_noshow_policies")
        .select("noshow_notice_hours")
        .eq("user_id", effectiveUserId)
        .maybeSingle();
      noticeHours = (policy?.noshow_notice_hours as number | null) ?? 24;
    }

    const sinceIso = new Date(
      Date.now() - PREVIEW_WINDOW_DAYS * 86_400_000,
    ).toISOString();

    type Row = {
      status: string;
      scheduled_at: string;
      cancelled_at: string | null;
    };
    const rows = await fetchAllRows<Row>((from, to) =>
      loose(sb)
        .from("emma_appointments")
        .select("status, scheduled_at, cancelled_at")
        .eq("user_id", effectiveUserId)
        .in("status", ["cancelled", "no_show"])
        .gte("scheduled_at", sinceIso)
        .order("scheduled_at", { ascending: false })
        .range(from, to),
    );

    let cancelledTotal = 0;
    let cancelHonored = 0;
    let lateCancelsAsNoShow = 0;
    let noticeUnknown = 0;
    let noShowTotal = 0;

    for (const r of rows) {
      if (r.status === "no_show") {
        noShowTotal += 1;
        continue;
      }
      // status === 'cancelled'
      cancelledTotal += 1;
      const res = classifyAppointmentOutcome({
        status: r.status,
        scheduledAt: r.scheduled_at,
        cancelledAt: r.cancelled_at,
        noticeHours,
      });
      if (!res.noticeKnown) noticeUnknown += 1;
      else if (res.outcome === "no_show") lateCancelsAsNoShow += 1;
      else cancelHonored += 1;
    }

    return {
      windowDays: PREVIEW_WINDOW_DAYS,
      noticeHours,
      cancelledTotal,
      cancelHonored,
      lateCancelsAsNoShow,
      noticeUnknown,
      noShowTotal,
    };
  });
