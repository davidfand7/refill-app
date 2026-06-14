/**
 * No-show definition & Reschedule Reminders — settings card (v2.34.0, Slice 1).
 *
 * Lives on the Reminders (preshow) page. Two jobs:
 *   1. Let the operator define THEIR no-show rule — the notice window below
 *      which a "cancellation" is really a no-show — plus which outcome classes
 *      to follow up (cancels / no-shows), and the master on/off.
 *   2. Make the rule concrete: a live preview running that exact rule over the
 *      spa's last 30 days — "N of your M cancellations are really no-shows."
 *
 * Slice 1 sends nothing; this is the canonical rule + the honest preview. The
 * drafting surface is the /recovery/reschedule page (Slice 2).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowRight, CalendarClock, Loader2 } from "lucide-react";
import {
  getNoShowPolicy,
  updateNoShowPolicy,
  type NoShowPolicy,
} from "@/server/emma-appointments.functions";
import {
  getRescheduleClassificationPreview,
  type RescheduleClassificationPreview,
} from "@/server/reschedule.functions";
import { cn } from "@/lib/utils";

function Toggle({
  on,
  onClick,
  disabled,
  label,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50",
        on ? "bg-emerald" : "bg-rule",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
          on && "translate-x-4",
        )}
      />
    </button>
  );
}

export function NoShowDefinitionCard({
  accessToken,
  viewAsUserId,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
}) {
  const [policy, setPolicy] = useState<NoShowPolicy | null>(null);
  const [preview, setPreview] = useState<RescheduleClassificationPreview | null>(null);
  const [hoursInput, setHoursInput] = useState<string>("24");
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPreview = useCallback(
    async (noticeHoursOverride?: number) => {
      if (!accessToken) return;
      try {
        const p = await getRescheduleClassificationPreview({
          data: { accessToken, viewAsUserId, noticeHoursOverride },
        });
        setPreview(p);
      } catch {
        /* leave prior preview on transient error */
      }
    },
    [accessToken, viewAsUserId],
  );

  useEffect(() => {
    if (!accessToken) return;
    void (async () => {
      try {
        const pol = await getNoShowPolicy({ data: { accessToken, viewAsUserId } });
        setPolicy(pol);
        setHoursInput(String(pol.noshowNoticeHours));
      } catch {
        /* leave card empty on error */
      }
    })();
    void loadPreview();
  }, [accessToken, viewAsUserId, loadPreview]);

  const persist = useCallback(
    async (patch: Partial<NoShowPolicy>) => {
      if (!accessToken) return;
      setSaving(true);
      // Optimistic — reflect immediately, roll back on failure.
      setPolicy((prev) => (prev ? { ...prev, ...patch } : prev));
      try {
        const next = await updateNoShowPolicy({
          data: { accessToken, viewAsUserId, patch: patch as never },
        });
        setPolicy(next);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't save the change.");
        // Re-pull truth on failure.
        try {
          const pol = await getNoShowPolicy({ data: { accessToken, viewAsUserId } });
          setPolicy(pol);
          setHoursInput(String(pol.noshowNoticeHours));
        } catch {
          /* ignore */
        }
      } finally {
        setSaving(false);
      }
    },
    [accessToken, viewAsUserId],
  );

  function onHoursChange(raw: string) {
    setHoursInput(raw);
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0 || n > 336) return;
    // Live preview against the typed value (debounced); persist on blur.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void loadPreview(n), 350);
  }

  function onHoursBlur() {
    const n = parseInt(hoursInput, 10);
    if (!Number.isFinite(n) || n < 0 || n > 336) {
      // Reset to the saved value on invalid entry.
      if (policy) setHoursInput(String(policy.noshowNoticeHours));
      return;
    }
    if (policy && n !== policy.noshowNoticeHours) {
      void persist({ noshowNoticeHours: n });
    }
    void loadPreview(n);
  }

  if (!policy) {
    return (
      <section className="rounded-xl border border-rule bg-paper/30 p-5">
        <div className="flex items-center gap-2 text-sm text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading no-show settings…
        </div>
      </section>
    );
  }

  const hours = policy.noshowNoticeHours;
  const enabled = policy.rescheduleEnabled;

  return (
    <section className="rounded-xl border border-rule bg-paper/30 p-5">
      <header className="flex items-start gap-2">
        <CalendarClock className="h-5 w-5 text-emerald shrink-0 mt-0.5" />
        <div className="flex-1">
          <h2 className="text-base font-semibold text-ink tracking-tight">
            No-show definition &amp; Reschedule Reminders
          </h2>
          <p className="text-xs text-ink-soft mt-0.5 leading-relaxed">
            Set <em>your</em> line between a cancellation and a no-show, and which
            of them you want to win back. Reschedule Reminders sends a warm rebook
            nudge to those patients — you always review and send.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] font-semibold text-ink-soft">
            {enabled ? "On" : "Off"}
          </span>
          <Toggle
            on={enabled}
            disabled={saving}
            label="Reschedule Reminders on/off"
            onClick={() => void persist({ rescheduleEnabled: !enabled })}
          />
        </div>
      </header>

      {/* The notice rule */}
      <div className="mt-4 rounded-lg border border-rule bg-white p-4">
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1.5">
          Required notice
        </label>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-ink">A cancellation with less than</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={336}
            value={hoursInput}
            onChange={(e) => onHoursChange(e.target.value)}
            onBlur={onHoursBlur}
            className="w-16 rounded border border-rule bg-white px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-emerald/30"
          />
          <span className="text-sm text-ink">
            hours&rsquo; notice counts as a <strong>no-show</strong>.
          </span>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-faint">
          Common: 24h or 48h. A cancellation with at least this much notice stays
          an honored cancel.
        </p>
      </div>

      {/* Who to follow up — inert (and dimmed) while the feature is off. */}
      <div
        className={cn(
          "mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 transition",
          !enabled && "opacity-50 pointer-events-none",
        )}
        aria-disabled={!enabled}
      >
        <div className="flex items-center justify-between rounded-lg border border-rule bg-white px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-ink">Follow up cancels</div>
            <div className="text-[11px] text-ink-faint">Gave fair notice</div>
          </div>
          <Toggle
            on={policy.rescheduleTargetCancels}
            disabled={saving || !enabled}
            label="Follow up honored cancels"
            onClick={() =>
              void persist({ rescheduleTargetCancels: !policy.rescheduleTargetCancels })
            }
          />
        </div>
        <div className="flex items-center justify-between rounded-lg border border-rule bg-white px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-ink">Follow up no-shows</div>
            <div className="text-[11px] text-ink-faint">Incl. late cancels</div>
          </div>
          <Toggle
            on={policy.rescheduleTargetNoshows}
            disabled={saving || !enabled}
            label="Follow up no-shows"
            onClick={() =>
              void persist({ rescheduleTargetNoshows: !policy.rescheduleTargetNoshows })
            }
          />
        </div>
      </div>

      {/* Spa-wide opt-in: apply the rule to reliability scoring too (v2.39.0) */}
      <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-rule bg-white px-3 py-2.5">
        <div>
          <div className="text-sm font-medium text-ink">Apply to reliability scoring</div>
          <div className="text-[11px] text-ink-faint leading-relaxed">
            Also count a late cancel as a no-show in patient reliability — a chronic
            late-canceller can reach the <em>in-recovery</em> tier (which can require a
            deposit). Off by default; this changes how patients are scored.
          </div>
        </div>
        <Toggle
          on={policy.noshowRuleAppliesReliability}
          disabled={saving}
          label="Apply no-show rule to reliability scoring"
          onClick={() =>
            void persist({
              noshowRuleAppliesReliability: !policy.noshowRuleAppliesReliability,
            })
          }
        />
      </div>

      {/* Live reclassification preview */}
      {preview && (
        <div className="mt-3 rounded-lg border border-emerald/30 bg-emerald-soft/30 px-4 py-3">
          {preview.cancelledTotal === 0 && preview.noShowTotal === 0 ? (
            <p className="text-[12.5px] text-ink-soft">
              No cancellations or no-shows in the last {preview.windowDays} days to
              classify yet.
            </p>
          ) : (
            <>
              <p className="text-[13px] text-ink leading-relaxed">
                In the last {preview.windowDays} days,{" "}
                <strong>{preview.lateCancelsAsNoShow}</strong> of your{" "}
                <strong>{preview.cancelledTotal}</strong> cancellation
                {preview.cancelledTotal === 1 ? "" : "s"} count as{" "}
                <strong>no-shows</strong> by your {hours}h rule
                {preview.noShowTotal > 0 ? (
                  <>
                    , on top of <strong>{preview.noShowTotal}</strong> outright
                    no-show{preview.noShowTotal === 1 ? "" : "s"}
                  </>
                ) : null}
                .
              </p>
              {preview.noticeUnknown > 0 && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  {preview.noticeUnknown} cancellation
                  {preview.noticeUnknown === 1 ? "" : "s"} couldn&rsquo;t be timed
                  (no cancellation time on record) — left as cancels, never branded
                  a no-show.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Guide to the action surface */}
      <div className="mt-3 flex justify-end">
        <Link
          to="/app/refill/recovery/reschedule"
          className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-emerald hover:opacity-80"
        >
          View cancels &amp; no-shows to win back
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}
