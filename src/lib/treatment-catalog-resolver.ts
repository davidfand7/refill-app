/**
 * Treatment → catalog resolver (v2.63.0 — Waitlist Slice 2).
 *
 * The waitlist's "desired service" has always been free-text (`treatment_types`
 * — e.g. "Tox w/ Karen", "filler", "RF Micro Face+Neck"). Smart Slot-Fill needs
 * the desire as real catalog rows so it can check provider qualification
 * (scheduling_provider_services.service_id) and duration (services.duration_min).
 *
 * This pure fn maps free-text labels onto `services.id`s. It deliberately
 * MIRRORS the rescue matcher's existing loose comparison (case-insensitive,
 * trimmed, equality OR substring either direction — see emma-rescue
 * selectFitPatients) so the catalog-linked world stays consistent with the
 * free-text world rather than diverging. Match precedence:
 *
 *   1. exact name match    ("tox" → service "Tox")                       — highest confidence
 *   2. token-subset match  (one name's whole-word tokens ⊆ the other's:
 *                           "tox w/ karen" → "Tox"; "RF Micro Face" → "RF Micro Face+Neck")
 *   3. category match      ("filler" → every service in the Filler category) — the
 *                          "category = config shortcut" behavior; only fires when no
 *                          name match was found (the label looks like a category).
 *
 * Token-subset (not raw substring) is deliberate: substring over-matches by
 * letters — "Detox Facial" would spuriously contain "tox", mis-linking a facial
 * desire to a Tox slot. Whole-word tokens kill that (the token "tox" is not in
 * ["detox","facial"]) while still matching the dominant real case (the appt
 * treatment_type "Tox w/ Karen" carries the service name "Tox" as a token).
 *
 * Mild over-inclusion is still acceptable: Smart Slot-Fill RANKS exact-service
 * match first and gates on duration + provider qualification, so a slightly wide
 * desire set gets filtered downstream. Under-inclusion (a label resolving to
 * nothing) is surfaced via `unresolved` so callers keep the free-text fallback.
 */

export type ServiceCatalogEntry = {
  id: string;
  name: string;
  category: string | null;
};

export type TreatmentResolution = {
  /** Unique resolved services.id references. */
  serviceIds: string[];
  /** Input labels that matched no catalog row (free-text fallback still applies). */
  unresolved: string[];
};

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Whole-word tokens (split on any non-alphanumeric), lowercased, deduped. */
function tokenize(s: string): Set<string> {
  return new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/** True when every token of `sub` appears in `sup` (sub ⊆ sup), sub non-empty. */
function isSubset(sub: Set<string>, sup: Set<string>): boolean {
  if (sub.size === 0) return false;
  for (const t of sub) if (!sup.has(t)) return false;
  return true;
}

export function resolveTreatmentsToServiceIds(
  treatmentLabels: readonly string[],
  catalog: readonly ServiceCatalogEntry[],
): TreatmentResolution {
  const ids = new Set<string>();
  const unresolved: string[] = [];

  const entries = catalog
    .map((s) => ({
      id: s.id,
      name: norm(s.name),
      nameTokens: tokenize(s.name),
      category: s.category ? norm(s.category) : "",
      categoryTokens: s.category ? tokenize(s.category) : new Set<string>(),
    }))
    .filter((s) => s.name.length > 0);

  for (const raw of treatmentLabels) {
    const label = norm(raw);
    if (!label) continue;
    const labelTokens = tokenize(raw);
    let matched = false;

    // 1) exact name match
    for (const s of entries) {
      if (s.name === label) {
        ids.add(s.id);
        matched = true;
      }
    }
    if (matched) continue;

    // 2) token-subset either direction (whole-word, not raw substring)
    for (const s of entries) {
      if (
        isSubset(s.nameTokens, labelTokens) ||
        isSubset(labelTokens, s.nameTokens)
      ) {
        ids.add(s.id);
        matched = true;
      }
    }
    if (matched) continue;

    // 3) category match (the "I want any filler" shortcut — label names a category)
    for (const s of entries) {
      if (!s.category) continue;
      if (label === s.category || isSubset(s.categoryTokens, labelTokens)) {
        ids.add(s.id);
        matched = true;
      }
    }

    if (!matched) unresolved.push(raw);
  }

  return { serviceIds: [...ids], unresolved };
}
