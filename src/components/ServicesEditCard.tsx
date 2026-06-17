/**
 * ServicesEditCard — shared service-chips editor for the spa surfaces.
 *
 * Used by:
 *   - /claim-your-business (review stage during onboarding)
 *   - /app/karen (post-claim dashboard)
 *
 * Both surfaces are editing the same logical thing — "what services Emma
 * knows about" — so they get the same editor. Two surface-level diffs are
 * passed in via props:
 *   - `outerClassName`: claim review uses lg:row-span-1 for its layout grid;
 *     dashboard doesn't need that.
 *   - `emptyCopy`: claim says "We didn't pick out services from your site,
 *     add them below…" (sets expectation for fresh-scrape state); dashboard
 *     says "Add the treatments you offer…" (already-onboarded mental model).
 *
 * v269: extracted from inline copies in claim-your-business.tsx + app.karen.tsx
 * after the v264 "intentionally not extracted" decision flipped — v265.1 +
 * v266 both required syncing the same diff across both surfaces, which is
 * exactly the maintenance tax v264 was hoping to avoid by keeping room for
 * divergence. Divergence didn't materialize; the lockstep tax did. Single
 * component now; if a future surface-specific need lands, add a prop.
 */

import { useState, type ReactNode } from "react";
import { BadgeCheck, Plus, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  SpaScrapeService,
  ProductCandidate,
} from "@/server/spa-claim.functions";

export type ServicesEditCardProps = {
  services: SpaScrapeService[];
  onChange: (next: SpaScrapeService[]) => void;
  /** Extra classes on the outer container (e.g., lg:row-span-1 on the claim grid). */
  outerClassName?: string;
  /** Surface-specific empty-state copy. */
  emptyCopy?: ReactNode;
};

const DEFAULT_EMPTY_COPY = (
  <>Add the treatments you offer. SmartSpa uses these in its replies.</>
);

export function ServicesEditCard({
  services,
  onChange,
  outerClassName,
  emptyCopy = DEFAULT_EMPTY_COPY,
}: ServicesEditCardProps) {
  const [draft, setDraft] = useState("");

  function addService() {
    const name = draft.trim();
    if (!name) return;
    if (services.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...services, { name }]);
    setDraft("");
  }

  function removeService(name: string) {
    onChange(services.filter((s) => s.name !== name));
  }

  // Categories with candidates render as a quick-add checklist below the chips.
  const categoryGroups = services
    .filter((s) => s.candidates && s.candidates.length > 0)
    .map((s) => ({ parentName: s.name, candidates: s.candidates! }));

  // Match a candidate against existing services either by nodeId (the strong
  // signal — same canonical product) or by name as a soft fallback. Catches
  // "Botox" → "Botox Cosmetic" shorthand-vs-canonical pairs.
  function isCandidateAdded(c: ProductCandidate): boolean {
    return services.some(
      (s) =>
        s.matchedProduct?.nodeId === c.nodeId ||
        s.name.toLowerCase() === c.name.toLowerCase(),
    );
  }

  function toggleCandidate(c: ProductCandidate) {
    if (isCandidateAdded(c)) {
      onChange(
        services.filter(
          (s) =>
            s.matchedProduct?.nodeId !== c.nodeId &&
            s.name.toLowerCase() !== c.name.toLowerCase(),
        ),
      );
    } else {
      onChange([
        ...services,
        {
          name: c.name,
          matchedProduct: {
            nodeId: c.nodeId,
            canonicalName: c.name,
            family: c.family,
            manufacturer: c.manufacturer,
          },
        },
      ]);
    }
  }

  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-3",
        outerClassName,
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-emerald/10 flex items-center justify-center">
            <Sparkles className="h-3.5 w-3.5 text-emerald" />
          </div>
          <div className="text-sm font-semibold">Services</div>
        </div>
        <span className="text-[11px] text-ink-soft font-medium">
          {services.length} {services.length === 1 ? "service" : "services"}
        </span>
      </div>

      {services.length === 0 ? (
        <p className="text-xs text-ink-soft italic leading-relaxed">{emptyCopy}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {services.map((s) => (
            <span
              key={s.name}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-foreground"
              title={
                s.matchedProduct
                  ? `${s.matchedProduct.canonicalName} (${s.matchedProduct.manufacturer ?? "manufacturer unknown"})`
                  : undefined
              }
            >
              {s.matchedProduct && <BadgeCheck className="h-3 w-3 text-emerald" />}
              {s.name}
              {s.price && (
                <span className="text-ink-soft font-medium">· {s.price}</span>
              )}
              <button
                type="button"
                onClick={() => removeService(s.name)}
                className="rounded-full opacity-50 hover:opacity-100 hover:bg-background p-0.5 transition"
                aria-label={`Remove ${s.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {categoryGroups.length > 0 && (
        <div className="rounded-xl border border-dashed border-emerald/30 bg-emerald/5 p-3 space-y-3">
          <div className="text-[11px] font-semibold text-emerald uppercase tracking-wider">
            Quick-add specifics
          </div>
          {categoryGroups.map((group) => (
            <div key={group.parentName} className="space-y-1.5">
              <div className="text-xs text-ink-soft">
                Under{" "}
                <span className="font-semibold text-foreground">
                  {group.parentName}
                </span>
                , which do you offer?
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.candidates.map((c) => {
                  const checked = isCandidateAdded(c);
                  return (
                    <button
                      key={c.nodeId}
                      type="button"
                      onClick={() => toggleCandidate(c)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition",
                        checked
                          ? "bg-emerald text-paper hover:opacity-90"
                          : "bg-card border border-border text-foreground hover:bg-muted",
                      )}
                      title={c.manufacturer}
                    >
                      {checked ? (
                        <BadgeCheck className="h-3 w-3" />
                      ) : (
                        <Plus className="h-3 w-3 opacity-60" />
                      )}
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="text-[11px] text-ink-soft italic leading-relaxed">
            Tap to add. SmartSpa answers customer questions better when it knows
            specific brand names, not just categories.
          </p>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addService();
            }
          }}
          placeholder="Add a service (e.g. Botox, HydraFacial)"
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={addService}
          disabled={!draft.trim()}
          className="inline-flex items-center justify-center gap-1 rounded-lg bg-foreground text-background px-3 py-2 text-xs font-medium hover:opacity-90 disabled:opacity-40 transition"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>
      <p className="text-[11px] text-ink-soft">
        <BadgeCheck className="inline h-3 w-3 text-emerald mr-0.5" />
        markers indicate services SmartSpa recognizes from its product database.
      </p>
    </div>
  );
}
