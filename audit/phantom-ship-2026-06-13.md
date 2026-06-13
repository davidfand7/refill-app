# Phantom-Ship Audit — 2026-06-13

**Scope:** commits touching `src/lib/changelog.ts` in the 14 days before 2026-06-13 (50 commits reviewed, 49 touched the changelog).

**Method:**
1. For every changelog commit, extract file references from `<code>…</code>` tags and explicit `Touched:` lists in the newly added entry.
2. Resolve each reference to a basename and compare against the commit's actual file list (`git show --name-only`).
3. Flag any entry whose `<code>`-tagged filename does not appear in the commit's diff.

---

## Results

| Commit SHA | Version | Changelog-claimed files (code refs) | Files actually changed | Verdict |
|---|---|---|---|---|
| `b01fbcafc5c0f64a35625144f7bcef0d80a18972` | v2.7.0 | `program-intel.ts`, `app.refill.recognition.program.tsx`, `program-intel.functions.ts`, `RecognitionTabs.tsx` | `src/components/refill/RecognitionTabs.tsx`, `src/lib/changelog.ts`, `src/routeTree.gen.ts`, `src/routes/app.refill.recognition.program.tsx`, `src/server/program-intel.functions.ts` | **PHANTOM** — `src/lib/program-intel.ts` not in commit |

All other 48 commits passed: either their changelog code-refs matched (by basename) to files present in the same commit, or they contained no file-shaped code references.

---

## Detail: Flagged commit

### `b01fbcafc` — v2.7.0 "Program Intelligence surface"

**Changelog entry (excerpt):**
> "Built on the pure-logic brain (`program-intel.ts`): it derives moves only for rebates actually in reach… **Added**: `app.refill.recognition.program.tsx`, `program-intel.functions.ts`; **touched**: `RecognitionTabs.tsx` (+Program tab)."

**What actually changed in this commit:**
```
src/components/refill/RecognitionTabs.tsx
src/lib/changelog.ts
src/routeTree.gen.ts
src/routes/app.refill.recognition.program.tsx
src/server/program-intel.functions.ts
```

**What's missing:** `src/lib/program-intel.ts`

**Where the file actually landed:** commit `3daa282c55858614d9d059baeec3acbcd3a2d7db`
("Phase 2 foundation: program-intel brain (diff-engine + moves)") — a separate, earlier commit that was never given a changelog entry of its own.

**Assessment:** The v2.7.0 changelog references `program-intel.ts` in a `<code>` tag within its prose ("Built on the pure-logic brain (`program-intel.ts`)"), creating the impression that the file is part of this commit's deliverable. In practice the file was introduced in `3daa282` with no corresponding changelog entry; v2.7.0 then silently relied on it. This is a minor phantom: the code exists, but it shipped without a changelog entry and was retroactively implied by a later entry. The explicit "Added:" / "touched:" footer of the v2.7.0 entry correctly lists only what changed in that commit, which is consistent bookkeeping, but the prose reference to `program-intel.ts` creates an ambiguity that the `3daa282` commit deserved its own entry.

---

## False positives investigated

| Commit | Claimed ref | Actual file | Reason dismissed |
|---|---|---|---|
| `9e527048` (v2.16.0) | `recovery.rescue.tsx` | `src/routes/app.refill.recovery.rescue.tsx` | Abbreviation of route file; file WAS in commit |

---

## Conclusion

One phantom ship found. The `program-intel.ts` library was shipped in `3daa282` without a changelog entry; the v2.7.0 changelog later implied it was part of that commit via a prose `<code>` reference, but the file was not in the v2.7.0 diff.

No application code was modified by this audit.
