# Phantom-Ship Audit — 2026-06-15

**Audit window:** last 14 days (commits since 2026-06-01)  
**Total commits inspected:** 50  
**Phantom ships found:** 1

---

## Flagged commits

| Commit SHA | Version | Changelog-claimed files | Files actually changed | Verdict |
|---|---|---|---|---|
| `fb3dca9bdb70469bf521809c8bb3af87f9b5bea9` | v2.26.0 | `sending-pause.ts`, `emma-rescue`, `emma-preshow`, recall-digest cron, Skills page, migration `v2_26_0_sending_pause` | `src/lib/changelog.ts` only | **PHANTOM SHIP** |

---

## Detail

### fb3dca9b — "v2.26.0 changelog — kill switch entry (version pill was stuck at v2.25.0)"

This commit adds the v2.26.0 changelog entry but contains **zero source-code changes** beyond `changelog.ts`.

The changelog entry describes the honest-pause kill switch and explicitly claims:

> **New**: migration `v2_26_0_sending_pause` (`sending_paused` on the policy row), `sending-pause.ts`, `getSendingPaused`/`setSendingPaused`.  
> **Touched**: `emma-rescue` + `emma-preshow` + the recall-digest cron (all poll the switch at dispatch) · the Skills page (the control).

**None of those files appear in this commit's diff.** The actual code landed one commit earlier in:

> `fd464c40ce2c8d7030d04f869dea56f48d194812` — "v2.26.0 — honest-pause kill switch (Tier-2 Autonomous · Slice 3)"

which changes:
- `src/routes/api.cron.recall-digest.ts`
- `src/routes/app.refill.skills.tsx`
- `src/server/emma-preshow.functions.ts`
- `src/server/emma-rescue.functions.ts`
- `src/server/refill-recall.functions.ts`
- `src/server/sending-pause.ts`
- `src/server/skills.functions.ts`
- `supabase/migrations/20260801000000_v2_26_0_sending_pause.sql`

…but contains **no changelog entry**.

The changelog entry was split into a fixup commit (`fb3dca9b`) that the commit message itself acknowledges ("version pill was stuck at v2.25.0"). The changelog entry therefore describes code changes that are **not in the same commit**, making `fb3dca9b` a phantom ship by this audit's definition.

---

## Clean commits (50 checked, 49 clean)

All other commits with changelog entries were verified to include the source files their entries claim. No other phantom ships were found.

---

## Methodology

1. `git log --since="14 days ago"` → 50 commits
2. For each commit: extracted the `Touched:` / `New:` file claims from the `+`-lines of `git show <sha> -- src/lib/changelog.ts`
3. Compared claimed filenames against `git show --name-only --format= <sha>`
4. Flagged any commit where a claimed source file was absent from the commit's own diff, or where a changelog-only commit described code fixes

*Audit run by automated agent on 2026-06-15.*
