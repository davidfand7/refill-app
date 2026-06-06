/**
 * Booking-rules section of the booking-settings page (extracted in the v1.67.x
 * consolidation sprint). Notice/window/interval/hold/reminder numbers + the
 * smart-option lead toggle. Pure presentation — settings + patch come from the
 * page, so it stays part of the batched Save. Behavior-identical.
 */

import { CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import { NumberField, SelectField } from "@/components/refill/booking/fields";
import type { SchedulingSettingsDraft } from "@/server/scheduling-settings.functions";

const GRANULARITY_OPTIONS = [10, 15, 20, 30, 60];

export function BookingRulesSection({
  settings,
  patchSettings,
}: {
  settings: SchedulingSettingsDraft;
  patchSettings: (patch: Partial<SchedulingSettingsDraft>) => void;
}) {
  return (
    <section className="rounded-xl border border-rule bg-white px-5 py-4">
      <div className="flex items-center gap-2 mb-3">
        <CalendarClock className="h-4 w-4 text-emerald" />
        <h3 className="text-[14px] font-semibold text-ink">Booking rules</h3>
      </div>
      <div className="grid sm:grid-cols-2 gap-x-5 gap-y-4">
        <NumberField
          label="Minimum notice (hours)"
          caption="How far ahead a patient must book."
          value={Math.round(settings.minAdvanceNoticeMin / 60)}
          min={0}
          max={720}
          onChange={(v) => patchSettings({ minAdvanceNoticeMin: v * 60 })}
        />
        <NumberField
          label="Booking window (days)"
          caption="How far out patients can book."
          value={settings.maxAdvanceDays}
          min={1}
          max={730}
          onChange={(v) => patchSettings({ maxAdvanceDays: v })}
        />
        <SelectField
          label="Time slot interval"
          caption="Spacing of offered start times."
          value={settings.slotGranularityMin}
          options={GRANULARITY_OPTIONS.map((m) => ({ value: m, label: `${m} min` }))}
          onChange={(v) => patchSettings({ slotGranularityMin: v })}
        />
        <NumberField
          label="Hold window (minutes)"
          caption="How long a slot is held during checkout."
          value={settings.holdMinutes}
          min={1}
          max={120}
          onChange={(v) => patchSettings({ holdMinutes: v })}
        />
        <NumberField
          label="Reminder lead (hours)"
          caption="Send a reminder this many hours before."
          value={settings.reminderLeadHours}
          min={0}
          max={336}
          onChange={(v) => patchSettings({ reminderLeadHours: v })}
        />
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={settings.samedayReminderEnabled}
              onChange={(e) => patchSettings({ samedayReminderEnabled: e.target.checked })}
              className="h-4 w-4 rounded border-rule accent-emerald"
            />
            Also send a same-day reminder
          </label>
        </div>

        {/* Smart-option default — which leads when prices vary by provider. */}
        <div className="sm:col-span-2 pt-1 border-t border-rule/60">
          <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block mt-3">
            When prices vary by provider, lead with
          </label>
          <div className="inline-flex rounded-md border border-rule overflow-hidden">
            {(["best_deal", "first_available"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => patchSettings({ bookingLeadOption: opt })}
                className={cn(
                  "px-3 py-1.5 text-[13px] font-medium transition",
                  settings.bookingLeadOption === opt
                    ? "bg-emerald text-paper"
                    : "text-ink-soft hover:text-ink",
                )}
              >
                {opt === "best_deal" ? "Best deal" : "First available"}
              </button>
            ))}
          </div>
          <p className="text-[12px] text-ink-soft mt-1.5 leading-relaxed">
            Patients always see both. This picks which appears first — and only matters for
            services you price differently per provider.
          </p>
        </div>
      </div>
    </section>
  );
}
