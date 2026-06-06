/**
 * TimeSelect — a 5-minute-increment time picker (v1.48.12).
 *
 * The native <input type="time"> dropdown in Chrome ignores the `step`
 * attribute and always lists every minute, so to actually offer 5-minute
 * increments in the PICKER we use a real <select> of 5-min options. Value is
 * 24h "HH:MM" (same as the native input it replaces); labels are 12h am/pm.
 * An off-grid current value (e.g. legacy "09:03") stays selectable via a
 * prepended fallback option so saving never silently loses it.
 */

const STEP_MIN = 5;

const OPTIONS: Array<{ value: string; label: string }> = (() => {
  const out: Array<{ value: string; label: string }> = [];
  for (let m = 0; m < 24 * 60; m += STEP_MIN) {
    out.push({ value: hhmm(m), label: label12(m) });
  }
  return out;
})();

function hhmm(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function label12(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function labelFor(value: string): string {
  const [h, m] = value.split(":").map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return value;
  return label12(h * 60 + m);
}

export function TimeSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const onGrid = OPTIONS.some((o) => o.value === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {!onGrid && value && <option value={value}>{labelFor(value)}</option>}
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
