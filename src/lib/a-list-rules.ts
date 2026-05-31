/**
 * Pure A-list matching logic. Extracted from app.refill.patients.a-list-rules.tsx
 * in v1.27.2 so the new waitlist-invite picker can share the same scoring
 * without duplicating it. Adding a field to AListRules requires updating
 * matchesRules() in one place.
 */

import type { PatientListRow } from "@/server/patient-ingest.functions";
import type { AListRules } from "@/server/user-prefs.functions";

export function matchesAListRules(
  p: PatientListRow,
  rules: AListRules,
  todayMs: number,
  unreliableIds: Set<string>,
): boolean {
  if (rules.excludeBanned && p.banned) return false;
  if (rules.excludeUnreliable && unreliableIds.has(p.id)) return false;
  if (
    rules.lifetimeSpendMinUsd !== null &&
    p.lifetimeSpendUsd < rules.lifetimeSpendMinUsd
  ) {
    return false;
  }
  if (rules.totalVisitsMin !== null && p.totalVisits < rules.totalVisitsMin) {
    return false;
  }
  if (rules.lastVisitWithinDays !== null) {
    if (!p.lastVisit) return false;
    const lastMs = new Date(p.lastVisit).getTime();
    if (Number.isNaN(lastMs)) return false;
    const days = (todayMs - lastMs) / (1000 * 60 * 60 * 24);
    if (days > rules.lastVisitWithinDays) return false;
  }
  return true;
}
