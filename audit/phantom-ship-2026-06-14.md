# Phantom-Ship Audit — 2026-06-14

Audit window: last 14 days (from 2026-05-31 to 2026-06-14).  
Total commits inspected: 49  
Commits that touched `src/lib/changelog.ts`: 36  
**Phantom ships found: 1**

---

## Findings

| Commit SHA | Version | Changelog-claimed files | Files actually changed | Verdict |
|---|---|---|---|---|
| `fb3dca9b` | v2.26.0 | `sending-pause.ts`, migration `v2_26_0_sending_pause`, `emma-rescue`, `emma-preshow`, recall-digest cron, Skills page | `src/lib/changelog.ts` only | **PHANTOM** |

---

## Detail: `fb3dca9bdb70469bf521809c8bb3af87f9b5bea9`

**Subject:** `v2.26.0 changelog — kill switch entry (version pill was stuck at v2.25.0)`

**What the changelog entry claims:**  
The v2.26.0 entry describes the "honest-pause kill switch" feature — a global pause control on the Skills page that stops all automated messages. It claims the following code changes:

- **New:** migration `v2_26_0_sending_pause` (adds `sending_paused` column), `sending-pause.ts`, `getSendingPaused`/`setSendingPaused`
- **Touched:** `emma-rescue`, `emma-preshow`, recall-digest cron (all poll the switch at dispatch), Skills page (the control)

**What the commit actually contains:**  
Only `src/lib/changelog.ts`. No application code was changed.

**Where the real code landed:**  
All of the described changes are in the immediately preceding commit **`fd464c40ce2c8d7030d04f869dea56f48d194812`** ("v2.26.0 — honest-pause kill switch"), which changed:

```
src/routes/api.cron.recall-digest.ts
src/routes/app.refill.skills.tsx
src/server/emma-preshow.functions.ts
src/server/emma-rescue.functions.ts
src/server/refill-recall.functions.ts
src/server/sending-pause.ts
src/server/skills.functions.ts
supabase/migrations/20260801000000_v2_26_0_sending_pause.sql
```

**Root cause:** The code commit `fd464c40` was merged without a changelog entry. A follow-up commit `fb3dca9b` added the changelog retroactively ("version pill was stuck at v2.25.0"). Because the changelog entry describes changes in a *different* commit, `fb3dca9b` is a phantom ship — it bumps the changelog without containing any of the code it describes.

**Risk:** Low. The code itself shipped correctly in `fd464c40`; only the commit-level traceability is broken. A bisect or blame on `sending-pause.ts` will not find the changelog entry in the same commit.

---

## Methodology

For each commit in the window:

1. Checked whether `src/lib/changelog.ts` was modified.
2. Extracted added lines from the diff and parsed `<strong>Touched</strong>:` sections to identify claimed file references (primary `<code>` items before any parenthetical descriptions).
3. Compared against the actual files changed in that commit (`git show --name-only`).
4. Flagged commits where (a) changelog.ts was the *only* changed file, or (b) a primary "Touched" file was absent from the commit's file list.

Function names and DB column names appearing inside parenthetical descriptions (e.g., `(now calls <code>getSpaName</code>)`) were excluded from file-reference matching to avoid false positives.
