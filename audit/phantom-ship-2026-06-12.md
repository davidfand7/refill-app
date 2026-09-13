# Phantom-Ship Audit — 2026-06-12

**Audit window:** last 14 days (commits since 2026-05-29)  
**Total commits inspected:** 49  
**Phantom ships found:** 1

## Methodology

For each commit in the window:

1. Diffed `src/lib/changelog.ts` to extract the newly-added entry's claimed file list (text after **Touched:**, **New:**, and any `<code>…</code>` source-file references).
2. Compared those claimed files against the full file list reported by `git show --name-only --format= <sha>`.
3. Flagged any commit where a claimed source file is absent from the commit's actual diff — including changelog-only commits whose entry describes a code fix.

## Results

| Commit SHA | Version | Changelog-claimed files | Files actually changed | Verdict |
|---|---|---|---|---|
| `ff217be9310077300b0bc6461c974b1e03e5d9f6` | v2.3.33 | `src/server/refill-recognition-allocation.functions.ts`, `src/lib/changelog.ts` | `src/lib/changelog.ts` | **PHANTOM SHIP** |

## Detail

### v2.3.33 — `ff217be9310077300b0bc6461c974b1e03e5d9f6`

**Changelog entry claimed:**

> Touched: `refill-recognition-allocation.functions.ts`, `changelog.ts`

**What the entry described:**  
Paginating the allocation engine's patient-load read past the 1,000-row Postgres ceiling, so rebate allocation would score every patient rather than silently dropping patients beyond row 1,000.

**What was actually committed:**  
Only `src/lib/changelog.ts`. The code change to `refill-recognition-allocation.functions.ts` was never included.

**Confirmation:**  
The follow-up commit v2.3.36 (`b31608f3609f325165c51e7a3e454ccb4a714069`) explicitly acknowledges the phantom in its own changelog entry:

> *"v2.3.33 described paginating the rebate-allocation patient read past Postgres's 1,000-row cap — but that release committed only the changelog entry; the code edit never landed, so the `limit(5000)` (which doesn't lift the server's 1,000-row ceiling) was still live."*

The actual pagination code landed in v2.3.36, which correctly shows both `src/lib/changelog.ts` and `src/server/refill-recognition-allocation.functions.ts` in its diff.

**Patient impact window:**  
Between v2.3.33 and v2.3.36, any spa with more than 1,000 patients had patients beyond row 1,000 excluded from rebate allocation, and the spend-decile cutoff was computed from a truncated population.

## All other commits: clean

All 48 remaining commits with changelog entries were verified. In each case, every source file claimed by the changelog entry was present in the commit's actual file diff.
