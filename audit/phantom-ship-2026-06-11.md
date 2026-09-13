# Phantom-Ship Audit — 2026-06-11

**Scope:** commits touching `src/lib/changelog.ts` in the 14 days prior to 2026-06-11  
**Commits inspected:** 49 (of 50 recent commits; 1 skipped — does not touch changelog.ts)  
**Method:** For each commit, extract claimed source files from newly-added `<code>` tags and the `Touched:` list in the changelog entry, then compare against the commit's actual file list (`git show --name-only`). A commit is flagged if a claimed source file (excluding `changelog.ts` itself) does not appear anywhere in the actual diff.

---

## Results

| Commit SHA | Version | Changelog-claimed files | Files actually changed | Verdict |
|---|---|---|---|---|
| `ff217be9310077300b0bc6461c974b1e03e5d9f6` | v2.3.33 | `refill-recognition-allocation.functions.ts`, `changelog.ts` | `src/lib/changelog.ts` | **PHANTOM** |

---

## Finding Detail

### `ff217be9` — v2.3.33 "Rebate allocation now considers every patient, not just the first 1,000"

**Commit date:** 2026-06-09  
**Commit message:** `v2.3.33 — paginate the allocation engine's patient load`

**Changelog entry (verbatim excerpt):**
> The Recognition allocation engine loaded your patient list with a `limit(5000)` — but the database enforces its own 1,000-row ceiling that a client-side limit can't lift, so any spa past 1,000 patients had everyone beyond row 1,000 silently excluded from rebate allocation … The read now pages through the full patient set, so allocation scores the whole practice. **Touched**: `refill-recognition-allocation.functions.ts`, `changelog.ts`.

**Files actually in the commit:**
```
src/lib/changelog.ts
```

**Assessment:** The changelog entry describes a pagination bug fix in the allocation engine and explicitly claims `refill-recognition-allocation.functions.ts` was modified. However the commit diff contains **only** `src/lib/changelog.ts`. The allocation engine fix was either never applied, applied in a different commit that does not bump the changelog, or the changelog entry was written and committed before the corresponding code change. Either way, the described fix is not present in this commit.

---

## Notes on False-Positive Candidates

Two additional commits were initially flagged by automated matching but confirmed clean on manual inspection:

- **`5bc5c433`** (v2.3.24) — Changelog uses brace-expansion notation `app.refill.settings.{vagaro,zenoti,booker,boulevard}-install.tsx` to represent four files. All four files (`vagaro`, `zenoti`, `booker`, `boulevard` variants) are present in the commit. Clean.
- **`7eb0db3b`** (v2.3.19, mega-commit covering v1.42.0–v2.3.19) — Multi-version squash commit with 125+ files; every claimed file resolves to a basename present in the diff. Clean.
