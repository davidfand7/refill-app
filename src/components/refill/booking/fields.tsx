/**
 * Booking-settings field helpers (extracted from app.refill.settings.booking.tsx
 * in the v1.67.x consolidation sprint).
 *
 * Pure, prop-driven presentational pieces + small numeric utilities shared
 * across the booking-settings sections. No coupling to page state.
 */

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** Public self-book URL for a tenant slug. */
export function bookingUrl(slug: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://getrefill.app";
  return `${origin}/s/${slug}`;
}

export function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** Round to the nearest 5 minutes, clamped to [min, 1440]. */
export function snap5(n: number, min: number): number {
  return Math.max(min, Math.min(1440, Math.round(n / 5) * 5));
}

export const DUR_INPUT_CLS =
  "rounded-md border border-rule bg-white px-1.5 py-1 text-[13px] text-ink text-right outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums";

/** Buffer = cleanup minutes only (0–60 in 5-min steps), independent of the
 *  duration H:M / minutes display toggle. */
export function BufferSelect({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const opts = Array.from({ length: 13 }, (_, i) => i * 5); // 0…60
  return (
    <div className="flex items-center justify-end gap-1">
      <select
        value={minutes}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className={cn(DUR_INPUT_CLS, "w-16 text-right")}
      >
        {!opts.includes(minutes) && <option value={minutes}>{minutes}</option>}
        {opts.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <span className="text-[11px] text-ink-faint">m</span>
    </div>
  );
}

/**
 * Duration / buffer editor in 5-minute steps. Always stores minutes; renders as
 * "1 h 30 m" (format "hm") or "90 min" (format "min").
 */
export function DurationField({
  minutes,
  min,
  format,
  onChange,
}: {
  minutes: number;
  min: number; // 0 for buffer, 5 for duration
  format: "hm" | "min";
  onChange: (m: number) => void;
}) {
  if (format === "min") {
    return (
      <div className="flex items-center justify-end gap-1">
        <input
          type="number"
          min={min}
          max={1440}
          step={5}
          value={minutes}
          onChange={(e) => onChange(snap5(parseInt(e.target.value || "0", 10), min))}
          className={cn(DUR_INPUT_CLS, "w-16")}
        />
        <span className="text-[11px] text-ink-faint">min</span>
      </div>
    );
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return (
    <div className="flex items-center justify-end gap-1">
      <input
        type="number"
        min={0}
        max={24}
        value={h}
        onChange={(e) => onChange(snap5((clampInt(e.target.value, 0, 24)) * 60 + m, min))}
        className={cn(DUR_INPUT_CLS, "w-10")}
      />
      <span className="text-[11px] text-ink-faint">h</span>
      <select
        value={m}
        onChange={(e) => onChange(snap5(h * 60 + parseInt(e.target.value, 10), min))}
        className="rounded-md border border-rule bg-white px-1 py-1 text-[13px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
      >
        {Array.from({ length: 12 }, (_, i) => i * 5).map((mm) => (
          <option key={mm} value={mm}>
            {String(mm).padStart(2, "0")}
          </option>
        ))}
      </select>
      <span className="text-[11px] text-ink-faint">m</span>
    </div>
  );
}

/** Checkbox with an indeterminate (some-selected) state. */
export function TriCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="h-4 w-4 rounded border-rule accent-emerald shrink-0"
    />
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-emerald" : "bg-rule",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function NumberField({
  label,
  caption,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  caption: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
        {label}
      </label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(clampInt(e.target.value, min, max))}
        className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30 tabular-nums"
      />
      <p className="text-[12px] text-ink-soft mt-1 leading-relaxed">{caption}</p>
    </div>
  );
}

export function SelectField({
  label,
  caption,
  value,
  options,
  onChange,
}: {
  label: string;
  caption: string;
  value: number;
  options: Array<{ value: number; label: string }>;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="text-[12px] text-ink-soft mt-1 leading-relaxed">{caption}</p>
    </div>
  );
}
