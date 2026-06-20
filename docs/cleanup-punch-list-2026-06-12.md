# Cleanup punch list — 2026-06-12

> Rolling check-in. Scheduled 2026-05-29. Covers HEAD at v2.8.0 (50 commits since schedule date).  
> **No code changes in this PR** — items below are proposed actions for Grasshopper to triage and execute.

## Searches run

| Search | Hits |
|---|---|
| `git log --since=2026-05-29 --oneline` | 50 commits (v1.26.13 → v2.8.0) |
| `grep -rn 'TODO.*pre-launch\|TODO.*cleanup\|cleanup before\|BASELINE\|dead-code' src/ supabase/` | 3 hits (changelog only + 1 migration comment) |
| `grep -rn 'karen@rejuv-demo\|karen\.aslak' src/` (non-changelog, non-comment) | **0 hits in active code** |
| `grep -rn 'applyPricingPlan\|getActivePlan\|listInvoices' src/server/emma-billing.functions.ts` | 0 — removed v1.26.14 ✅ |
| `grep -rn 'getInvoicePreview' src/server/emma-billing.functions.ts` | 1 hit — DEPRECATED since v1.26.23 |

---

## A — Dead code

| # | WHAT | WHERE | HOW | RISK |
|---|---|---|---|---|
| A1 | `getInvoicePreview` — deprecated fn, zero callers since v1.26.23. Recovery page now imports from `refill-billing`. File comment says keep until Phase 3 full-file deletion. | `src/server/emma-billing.functions.ts:229-320` | Delete lines 229-320 (fn + its `InvoicePreview` type + `invoicePreviewInput` schema). Then remove the `resolveEffectiveUserId` import if it has no other callers in the file. | Low — zero import consumers confirmed. |
| A2 | `api.cron.emma-invoice` route — writes to legacy `emma_invoices` table. The live replacement is `api.cron.refill-invoice` (writes to `refill_invoices`). If both are registered with the external scheduler, the emma route fires every month doing wasted work against an unmaintained table. | `src/routes/api.cron.emma-invoice.ts` (whole file) + scheduler registration (external) | (1) Confirm the emma cron is still registered with the scheduler. (2) If yes, deregister it. (3) Delete `src/routes/api.cron.emma-invoice.ts`. `generateMonthlyInvoiceForUser` + `generateMonthlyInvoicesForAll` in `emma-billing.functions.ts` also become dead after deletion — remove them too (lines ~95-220). | Medium — confirm scheduler state before deleting. |
| A3 | `generateMonthlyInvoiceForUser` + `generateMonthlyInvoicesForAll` in emma-billing — only called from the A2 cron route above. | `src/server/emma-billing.functions.ts:95-220` | Remove after A2 cron is deregistered. At that point `emma-billing.functions.ts` only holds `getPlanEconomics` + `PLAN_ECONOMICS` — evaluate whether the whole file can be deleted or folded into `refill-billing.ts`. | Low (dependent on A2). |

---

## B — Legacy email references

| # | WHAT | WHERE | HOW | RISK |
|---|---|---|---|---|
| B1 | `karen@rejuv-demo.test` in a code comment — historical rename note, not active code. | `src/lib/personas.ts:34` | Trim comment to just `// renamed → testspaowner@test.com in v1.26.13` if the old email is confusing to future readers. Or leave as-is — comment is accurate history. | None — comment only. |
| B2 | `karen.aslak` in a code comment — historical shell-routing note. | `src/server/role-helpers.ts:96` | Same — trim or leave. Not actionable. | None — comment only. |
| B3 | `karen@rejuv-demo.test` in 4 migration files. | `supabase/migrations/20260615010000_karen_demo_seed.sql`, `20260618000000_v417_admin_personas.sql`, `20260618010000_v417_admin_testing_identity.sql`, `20260618030000_v417_persona_bridge_metadata.sql` | Historical migrations are immutable by convention — do not edit. | None — already applied, immutable. |

**Verdict:** Active code is clean. v1.26.13 sweep was complete. B1/B2 are cosmetic.

---

## C — Database rows (SQL required — Grasshopper runs)

> No DB credentials in this session. All items below are SQL suggestions to paste into the Supabase dashboard.

### C1 — Tenant overlap audit

Two tenants hold patient/appointment data. Confirm the intended disposition before any merge or archive.

```sql
-- Tenant sizes at a glance
select
  u.email,
  t.name,
  t.is_demo,
  (select count(*) from public.emma_appointments ea where ea.user_id = u.id) as appointments,
  (select count(*) from public.emma_patients   ep where ep.user_id = u.id) as patients
from auth.users u
join public.user_roles ur on ur.user_id = u.id and ur.role = 'spa_owner'
join public.tenants     t  on t.owner_id   = u.id
where u.email in ('testspaowner@test.com', 'dormantspaowner@test.com');
```

**Recommended disposition:** Archive `dormantspaowner` (5 754 Acuity appts + 1 140 QB patients, engine never fires) — keep rows intact in DB for historical reference, but mark `is_demo = false, archived_at = now()` or equivalent. No merge into live tenant needed unless Grasshopper wants historical reports.

### C2 — Duplicate patient name overlap

```sql
-- Find patients with the same (first_name, last_name) across both tenants
select
  p1.first_name, p1.last_name,
  p1.email as live_email,   p1.user_id as live_owner,
  p2.email as dormant_email, p2.user_id as dormant_owner
from public.emma_patients p1
join public.emma_patients p2
  on lower(p1.first_name) = lower(p2.first_name)
 and lower(p1.last_name)  = lower(p2.last_name)
 and p1.user_id <> p2.user_id
where p1.user_id = (
  select id from auth.users where email = 'testspaowner@test.com'
)
and p2.user_id = (
  select id from auth.users where email = 'dormantspaowner@test.com'
)
order by p1.last_name, p1.first_name
limit 100;
```

If the live tenant has a 'David Anderson' from test imports and the dormant has a real one, that row in live can be deleted. Decision per row.

### C3 — Orphaned synthetic / zero-visit patients in live tenant

```sql
-- Live tenant patients with zero appointment rows (potential CSV-import residue)
select p.id, p.first_name, p.last_name, p.email, p.created_at
from public.emma_patients p
where p.user_id = (
  select id from auth.users where email = 'testspaowner@test.com'
)
and not exists (
  select 1 from public.emma_appointments a
  where a.patient_id = p.id
)
order by p.created_at desc
limit 50;
```

If any rows return: check `created_at` against known import test dates. Delete rows whose creation timestamp matches a CSV-import-test session and who have no appointment history.

### C4 — Rescue-attempt duplicate check (migration 20260530 verify query)

Migration `20260530020000_emma_rescue_one_active_per_apt.sql` added a verify SELECT at the bottom. It was run at migration time but worth re-confirming no new duplicates have accumulated:

```sql
select user_id, freed_appointment_id, count(*) as active_count
from public.emma_rescue_attempts
where status = 'active'
group by user_id, freed_appointment_id
having count(*) > 1;
```

Expected: zero rows.

---

## D — Stale config / infra

| # | WHAT | WHERE | HOW | RISK |
|---|---|---|---|---|
| D1 | `wrangler.jsonc` — no cron schedule entries found for `/api/cron/emma-invoice`. Confirm via hosting dashboard (Cloudflare / Trigger.dev / Supabase cron) whether it's still registered externally. | External scheduler config | Check scheduler dashboard. If registered, remove. | Low — worst case is the dead cron fires and writes to the unmaintained `emma_invoices` table, which has no UI consumers. |

---

## E — Cleared / all-clear items

| Item from brief | Status |
|---|---|
| `emma-billing.functions.ts: applyPricingPlan, getActivePlan, listInvoices` | **REMOVED v1.26.14** ✅ |
| `src/lib/demo-personas.ts` (duplicate persona source) | **DELETED v1.26.17** ✅ |
| Active code `karen@rejuv-demo.test` / `karen.aslak@gmail.com` references | **Clean** — 0 hits outside changelog + comments ✅ |
| `refill-billing.ts: getInvoicePreview` dead copy | **Live** — this is the current active fn (v1.26.23 restoration). Not dead. ✅ |
| `src/lib/personas.ts` single source of truth | **Consolidated v1.26.17** ✅ |
| `TODO.*pre-launch / BASELINE` grep | **0 hits** in `src/` ✅ |

---

## Priority order

1. **C4** (5 min) — run the rescue-attempt verify SELECT. Expected zero; if non-zero, close duplicates immediately.
2. **C1 + C2** (15 min) — run tenant size + overlap queries; decide dormant disposition.
3. **A2** (10 min) — confirm emma-invoice scheduler registration; deregister if live.
4. **A1 + A3** (20 min code) — delete `emma-billing.functions.ts:getInvoicePreview` + the dead cron helpers once A2 is confirmed.
5. **C3** (15 min) — orphan patient audit.
6. **B1/B2, D1** — cosmetic / confirm-only.
