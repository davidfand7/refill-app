# Phantom-Ship Audit — 2026-06-10

**Audit window:** 14 days prior to 2026-06-10  
**Commits inspected:** 49  
**Commits with changelog entries:** 48 (one mega-sync commit `7eb0db3b` backfills v2.3.11–v2.3.19)  
**Phantom ships found:** 1

## Findings

| Commit SHA | Version | Changelog-claimed files | Files actually changed | Verdict |
|---|---|---|---|---|
| `ff217be9` | v2.3.33 | `refill-recognition-allocation.functions.ts`, `changelog.ts` | `src/lib/changelog.ts` | **PHANTOM SHIP** |

## Detail

### `ff217be9` — v2.3.33 — "paginate the allocation engine's patient load"

The changelog entry reads:

> **v2.3.33 — Rebate allocation now considers every patient, not just the first 1,000.** The Recognition allocation engine loaded your patient list with a `limit(5000)` — but the database enforces its own 1,000-row ceiling that a client-side limit can't lift, so any spa past 1,000 patients had everyone beyond row 1,000 **silently excluded from rebate allocation** … The read now pages through the full patient set … **Touched**: `refill-recognition-allocation.functions.ts`, `changelog.ts`.

**Actual diff:** only `src/lib/changelog.ts` was committed. `refill-recognition-allocation.functions.ts` was never changed.

**Consequence:** The bug described (1,000-patient truncation in rebate allocation) was **not fixed** despite the entry saying it was. Any practice over 1,000 patients continued to have patients silently excluded from rebate allocation, and the spend-decile cohort boundary continued to be computed from the truncated list.

**Confirmed by:** The author noticed and acknowledged the miss in v2.3.36 (`b31608f3`):

> **v2.3.36 — The allocation engine's patient-load fix is now actually in the code (v2.3.33 was changelog-only).** v2.3.33 described paginating the rebate-allocation patient read … but that release committed only the changelog entry; the code edit never landed … Caught on a fresh-walk re-audit by checking the commit, not just the changelog.

The real fix landed in commit `b31608f3` (v2.3.36).

## All other commits: clean

All remaining 48 commits with changelog entries were verified to contain every source file referenced in their "Touched:" list. No other phantom ships were found in the 14-day window.
