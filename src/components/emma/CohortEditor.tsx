/**
 * CohortEditor — SmartSpa Promotions Engine Phase 2 cohort builder.
 *
 * Chip-based filter editor for the campaign detail page. Each chip is an
 * inline-editable filter (kind dropdown, manufacturer dropdown, number,
 * toggle). Add Filter button opens a menu listing the filter types that
 * aren't already in use.
 *
 * Live preview: every edit fires resolveCohort (debounced 300ms) and
 * updates the count + 10 sample patients on the right. The 500-cap
 * warning surfaces when the cohort would exceed the regulatory blast
 * limit.
 *
 * Save model: the editor holds a local draft of the query; "Save changes"
 * commits via updateSpaCampaign. Discard reverts. The campaign detail
 * page owns when to persist.
 *
 * Established 2026-05-15 (Promotions Engine Phase 2).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Filter,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  resolveCohort,
  type CohortPreview,
} from "@/server/emma-campaigns.functions";
import type { CohortQuery } from "@/lib/campaign-templates";
import type {
  ProductKind,
  ProductManufacturer,
} from "@/lib/product-manufacturer-map";
import { cn } from "@/lib/utils";

// ─── Public types ─────────────────────────────────────────────────────────

export type CohortEditorProps = {
  /** Current saved cohort query (from the campaign record). */
  value: CohortQuery;
  /**
   * Called with the new query when the spa owner clicks Save. The parent
   * is responsible for persisting via updateSpaCampaign.
   */
  onSave: (next: CohortQuery) => Promise<void> | void;
  /** Optional spa-side "this campaign is locked" flag — disables editing. */
  readOnly?: boolean;
};

// ─── Filter type metadata ─────────────────────────────────────────────────

type FilterKey =
  | "hasPurchasedKind"
  | "notPurchasedKind"
  | "primaryManufacturer"
  | "minTotalVisits"
  | "minDaysSinceLastVisit"
  | "maxDaysSinceLastVisit"
  | "minLifetimeSpendUsd"
  | "anniversaryMonth"
  | "requireReachable";

type FilterDef = {
  key: FilterKey;
  label: string;
  /** Sub-text on the add-menu and as default chip text. */
  description: string;
};

const FILTERS: FilterDef[] = [
  {
    key: "hasPurchasedKind",
    label: "Has purchased",
    description: "Patient has a paid line of this kind",
  },
  {
    key: "notPurchasedKind",
    label: "Has NOT purchased",
    description: "Patient has zero paid lines of this kind",
  },
  {
    key: "primaryManufacturer",
    label: "Primary brand is",
    description: "Top-of-mix manufacturer",
  },
  {
    key: "minTotalVisits",
    label: "Visits ≥",
    description: "Distinct visit count",
  },
  {
    key: "minDaysSinceLastVisit",
    label: "Last visit ≥ N days ago",
    description: "Reactivation / lapsed window",
  },
  {
    key: "maxDaysSinceLastVisit",
    label: "Last visit ≤ N days ago",
    description: "Recently engaged",
  },
  {
    key: "minLifetimeSpendUsd",
    label: "Lifetime spend ≥ $",
    description: "Value-tier gate",
  },
  {
    key: "anniversaryMonth",
    label: "Anniversary this month",
    description: "First visit was this calendar month",
  },
  {
    key: "requireReachable",
    label: "Has phone or email",
    description: "Auto-excludes banned + un-contactable",
  },
];

const KINDS: ProductKind[] = [
  "toxin",
  "filler",
  "biostimulator",
  "device",
  "retail",
  "service",
];

const MANUFACTURERS: ProductManufacturer[] = [
  "evolus",
  "abbvie",
  "merz",
  "galderma",
  "skinceuticals",
  "eltamd",
  "neocutis",
  "obagi",
  "sciton",
  "abbvie-coolsculpting",
];

// ─── Top-level editor ─────────────────────────────────────────────────────

export function CohortEditor({ value, onSave, readOnly }: CohortEditorProps) {
  const [draft, setDraft] = useState<CohortQuery>(value);
  const [preview, setPreview] = useState<CohortPreview | null>(null);
  const [previewing, setPreviewing] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset draft when the parent's saved value changes (post-save).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const dirty = useMemo(
    () => !cohortQueriesEqual(draft, value),
    [draft, value],
  );

  // Debounced preview — every keystroke / chip change triggers a refresh
  // 300ms later. Cancels in-flight when the draft changes.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setPreviewing(true);
    setPreviewError(null);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const { data: sess } = await supabase.auth.getSession();
          const token = sess.session?.access_token;
          if (!token) {
            setPreviewError("Sign in to preview your cohort.");
            setPreviewing(false);
            return;
          }
          const p = await resolveCohort({
            data: { accessToken: token, cohortQuery: draft },
          });
          setPreview(p);
          setPreviewing(false);
        } catch (e) {
          setPreviewError(
            e instanceof Error ? e.message : "Couldn't compute the cohort.",
          );
          setPreviewing(false);
        }
      })();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [draft]);

  function update<K extends FilterKey>(key: K, val: CohortQuery[K]) {
    setDraft((prev) => ({ ...prev, [key]: val }));
  }
  function remove(key: FilterKey) {
    setDraft((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }
  function addFilter(key: FilterKey) {
    setDraft((prev) => ({ ...prev, [key]: defaultValueFor(key) }));
  }
  async function handleSave() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }
  function handleReset() {
    setDraft(value);
  }

  const activeKeys = new Set(
    (Object.entries(draft) as Array<[FilterKey, unknown]>)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k),
  );

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-muted/30 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-ink-soft" />
          <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
            Target cohort
          </div>
        </div>
        {dirty && !readOnly && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleReset}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[11px] font-medium hover:bg-muted transition disabled:opacity-50"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald text-paper px-2.5 py-1 text-[11px] font-semibold hover:opacity-90 transition disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Save className="h-3 w-3" />
              )}
              Save changes
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] divide-y lg:divide-y-0 lg:divide-x divide-border">
        {/* Chip builder column */}
        <div className="px-5 py-4 space-y-3">
          {activeKeys.size === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-background/50 px-3 py-4 text-center text-xs text-ink-faint">
              No filters yet. Click <strong>Add filter</strong> below to start
              narrowing your audience.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {FILTERS.filter((f) => activeKeys.has(f.key)).map((f) => (
                <FilterChip
                  key={f.key}
                  def={f}
                  draft={draft}
                  onChange={update}
                  onRemove={() => remove(f.key)}
                  readOnly={readOnly}
                />
              ))}
            </div>
          )}
          {!readOnly && (
            <AddFilterMenu activeKeys={activeKeys} onAdd={addFilter} />
          )}
        </div>

        {/* Preview pane */}
        <div className="px-5 py-4 bg-muted/15">
          <CohortPreviewPane
            preview={preview}
            previewing={previewing}
            error={previewError}
          />
        </div>
      </div>
    </section>
  );
}

// ─── Chip ─────────────────────────────────────────────────────────────────

function FilterChip({
  def,
  draft,
  onChange,
  onRemove,
  readOnly,
}: {
  def: FilterDef;
  draft: CohortQuery;
  onChange: <K extends FilterKey>(key: K, val: CohortQuery[K]) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 text-xs">
      <span className="text-ink-soft">{def.label}</span>
      <ChipValueEditor
        def={def}
        draft={draft}
        onChange={onChange}
        readOnly={readOnly}
      />
      {!readOnly && (
        <button
          type="button"
          onClick={onRemove}
          className="text-ink-faint hover:text-destructive transition"
          aria-label="Remove filter"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function ChipValueEditor({
  def,
  draft,
  onChange,
  readOnly,
}: {
  def: FilterDef;
  draft: CohortQuery;
  onChange: <K extends FilterKey>(key: K, val: CohortQuery[K]) => void;
  readOnly?: boolean;
}) {
  switch (def.key) {
    case "hasPurchasedKind":
    case "notPurchasedKind": {
      const v = draft[def.key];
      return (
        <select
          value={v ?? ""}
          disabled={readOnly}
          onChange={(e) =>
            onChange(def.key, (e.target.value || undefined) as ProductKind | undefined)
          }
          className="bg-transparent text-foreground font-semibold focus:outline-none disabled:opacity-60"
        >
          <option value="">choose kind…</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
      );
    }
    case "primaryManufacturer": {
      const v = draft[def.key];
      return (
        <select
          value={v ?? ""}
          disabled={readOnly}
          onChange={(e) =>
            onChange(
              def.key,
              (e.target.value || undefined) as ProductManufacturer | undefined,
            )
          }
          className="bg-transparent text-foreground font-semibold focus:outline-none disabled:opacity-60"
        >
          <option value="">choose brand…</option>
          {MANUFACTURERS.map((m) => (
            <option key={m} value={m}>
              {manufacturerLabel(m)}
            </option>
          ))}
        </select>
      );
    }
    case "minTotalVisits":
    case "minDaysSinceLastVisit":
    case "maxDaysSinceLastVisit":
    case "minLifetimeSpendUsd": {
      const v = draft[def.key];
      return (
        <input
          type="number"
          min={0}
          value={v === undefined ? "" : v}
          disabled={readOnly}
          onChange={(e) => {
            const num = e.target.value === "" ? undefined : Number(e.target.value);
            onChange(def.key, Number.isFinite(num as number) ? num : undefined);
          }}
          className="w-16 bg-transparent text-foreground font-semibold focus:outline-none disabled:opacity-60 tabular-nums"
        />
      );
    }
    case "anniversaryMonth":
    case "requireReachable": {
      const v = !!draft[def.key];
      return (
        <button
          type="button"
          disabled={readOnly}
          onClick={() => onChange(def.key, !v as never)}
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition",
            v
              ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
              : "bg-muted text-ink-soft",
            !readOnly && "hover:opacity-80",
          )}
        >
          {v ? "On" : "Off"}
        </button>
      );
    }
  }
}

// ─── Add-filter menu ──────────────────────────────────────────────────────

function AddFilterMenu({
  activeKeys,
  onAdd,
}: {
  activeKeys: Set<FilterKey>;
  onAdd: (key: FilterKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const available = FILTERS.filter((f) => !activeKeys.has(f.key));
  if (available.length === 0) {
    return (
      <div className="text-[11px] text-ink-faint italic">
        All filter types are in use.
      </div>
    );
  }
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
      >
        <Plus className="h-3 w-3" />
        Add filter
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-72 rounded-xl border border-border bg-card shadow-lg overflow-hidden">
          {available.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                onAdd(f.key);
                setOpen(false);
              }}
              className="block w-full text-left px-3 py-2 hover:bg-muted/60 transition"
            >
              <div className="text-xs font-medium">{f.label}</div>
              <div className="text-[11px] text-ink-soft mt-0.5">
                {f.description}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Preview pane ─────────────────────────────────────────────────────────

function CohortPreviewPane({
  preview,
  previewing,
  error,
}: {
  preview: CohortPreview | null;
  previewing: boolean;
  error: string | null;
}) {
  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-soft">
        Live preview
      </div>
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : !preview && previewing ? (
        <div className="flex items-center gap-2 text-xs text-ink-soft">
          <Loader2 className="h-3 w-3 animate-spin" />
          Computing…
        </div>
      ) : preview ? (
        <>
          <div
            className={cn(
              "rounded-lg px-3 py-3 flex items-baseline gap-2",
              preview.exceedsBlastCap
                ? "bg-destructive/10"
                : preview.totalMatched === 0
                  ? "bg-muted"
                  : "bg-emerald/5",
            )}
          >
            <span className="text-2xl font-semibold tabular-nums">
              {preview.totalMatched.toLocaleString()}
            </span>
            <span className="text-xs text-ink-soft">
              patient{preview.totalMatched === 1 ? "" : "s"} match
            </span>
            {previewing && (
              <Loader2 className="h-3 w-3 animate-spin text-ink-faint ml-auto" />
            )}
          </div>
          {preview.exceedsBlastCap && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive leading-relaxed flex gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                That's over the <strong>{preview.blastCap}</strong>-patient
                blast cap. The composer will split this into multiple sends —
                or narrow the cohort with another filter.
              </span>
            </div>
          )}
          {preview.sample.length > 0 ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-soft mb-1.5">
                Top by lifetime spend
              </div>
              <ul className="space-y-1.5">
                {preview.sample.map((p) => (
                  <li
                    key={p.id}
                    className="text-[11px] flex items-baseline justify-between gap-2 tabular-nums"
                  >
                    <span className="truncate font-medium">{p.displayName}</span>
                    <span className="text-ink-faint">
                      {p.lifetimeSpendUsd.toLocaleString("en-US", {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-background/50 px-3 py-3 text-center text-[11px] text-ink-faint flex items-center justify-center gap-1.5">
              <Sparkles className="h-3 w-3" />
              No matches yet — relax a filter to see candidates.
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function cohortQueriesEqual(a: CohortQuery, b: CohortQuery): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function defaultValueFor(key: FilterKey): CohortQuery[FilterKey] {
  switch (key) {
    case "hasPurchasedKind":
    case "notPurchasedKind":
      return "toxin";
    case "primaryManufacturer":
      return "evolus";
    case "minTotalVisits":
      return 1;
    case "minDaysSinceLastVisit":
      return 180;
    case "maxDaysSinceLastVisit":
      return 30;
    case "minLifetimeSpendUsd":
      return 500;
    case "anniversaryMonth":
    case "requireReachable":
      return true;
  }
}

function kindLabel(k: ProductKind): string {
  switch (k) {
    case "toxin":
      return "Toxin";
    case "filler":
      return "Filler";
    case "biostimulator":
      return "Biostim";
    case "device":
      return "Device";
    case "retail":
      return "Retail";
    case "service":
      return "Service";
    case "reward":
      return "Reward";
    case "payment":
      return "Payment";
    case "discount":
      return "Discount";
    case "note":
      return "Note";
    default:
      return k;
  }
}

function manufacturerLabel(m: ProductManufacturer): string {
  switch (m) {
    case "evolus":
      return "Evolus";
    case "abbvie":
      return "AbbVie";
    case "merz":
      return "Merz";
    case "galderma":
      return "Galderma";
    case "skinceuticals":
      return "SkinCeuticals";
    case "eltamd":
      return "EltaMD";
    case "neocutis":
      return "Neocutis";
    case "obagi":
      return "Obagi";
    case "sciton":
      return "Sciton";
    case "abbvie-coolsculpting":
      return "CoolSculpting";
    default:
      return m;
  }
}
