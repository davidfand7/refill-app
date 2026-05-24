# Refill — migration port manifest (Step 2.1)

**Source**: `openagenticv4/supabase/migrations/` (163 total)
**Target**: `refill-app/supabase/migrations/`
**Refill scope**: 74 ports + 1 new admin seed = **75 migrations**
(Audit added `20260507100200_knowledge_nodes.sql` as a foundation dep after Step 2.3.)
**Approach**: Lift in chronological order. Files marked `⚠️ ADJUST` reference user IDs / emails that don't exist yet in the fresh project — handled in Step 2.3 audit + Step 2.6 paste.

---

## Section 0 — New (Step 2.5)

| File | Purpose |
|---|---|
| `00_admin_seed.sql` | Grant admin role to Grasshopper's new auth.users id post-signup. Required because v417.1 migration references the OLD project's davidfand303 user_id. |

---

## Section 1 — Foundational shared infra

| Order | File | Purpose |
|---|---|---|
| 1 | `20260424134817_email_infra.sql` | pgmq + pg_cron + pg_net extensions. Email queue (auth_emails, transactional_emails) + DLQ. Foundational for drip + scan-followup + transactional sends. |
| 2 | `20260507100200_knowledge_nodes.sql` | **Added Step 2.3**: per-user semantic graph storage. Refill promotions engine + accounts use this as entity storage. Only depends on `auth.users`. |
| 3 | `20260513000000_user_preferences.sql` | `primary_role` per-user pref. Drives post-login dispatch (spa-owner → /app/refill, rep → /app/rep, developer → admin). |

---

## Section 2 — Spa claim + reports + promotions foundation

| Order | File | Purpose | Status |
|---|---|---|---|
| 3 | `20260511000000_spa_claim_sessions.sql` | Claim-your-business onboarding session staging. | lift |
| 4 | `20260511010000_idempotent_spa_claim.sql` | Idempotency guard against duplicate claim nodes. | lift |
| 5 | `20260513020000_reports.sql` | Rep dataset upload (CSV) — Galderma accounts, etc. | lift |
| 6 | `20260513030000_reports_undo.sql` | Reports versioning + undo. | lift |
| 7 | `20260513040000_sample_order_intents.sql` | Send-to-Practice rep flow. | lift |
| 8 | `20260513050000_promotions_engine.sql` | Promotions engine pillar 1. | lift |
| 9 | `20260513060000_promo_intents.sql` | Promo intents tracking. | lift |
| 10 | `20260513060001_drop_promotion_outreach_intent_fk.sql` | FK cleanup. | lift |
| 11 | `20260513070000_promo_inbox.sql` | Promo inbox routing. | lift |
| 12 | `20260513080000_promo_inbox_drafts.sql` | Promo inbox drafts. | lift |
| 13 | `20260514000000_rep_tier_policy.sql` | Rep tier recommendation policy (lean upsell). | lift |
| 14 | `20260515000000_nudge_dismissed_at.sql` | Rep cadence nudge dismissal. | lift |
| 15 | `20260515010000_spa_promo_interest.sql` | Spa promo interest tracking. | lift |
| 16 | `20260515020000_patient_transactions.sql` | Patient transaction ledger. | lift |
| 17 | `20260515030000_patient_contact_candidates.sql` | Patient contact candidates. | lift |
| 18 | `20260515040000_spa_rep_data_share.sql` | Spa↔rep data sharing. | lift |
| 19 | `20260515050000_patient_outreach_state.sql` | Patient outreach state machine. | lift |
| 20 | `20260515060000_patient_outreach.sql` | Patient outreach records. | lift |

---

## Section 3 — Emma recovery engine (the bulk)

| Order | File | Purpose | Status |
|---|---|---|---|
| 21 | `20260516000000_emma_sender_domains.sql` | Sender domain verification. | lift |
| 22 | `20260516010000_patient_outreach_state_scheduled.sql` | Outreach schedule. | lift |
| 23 | `20260516020000_emma_sweep_cron.sql` | Main sweep cron metadata. | lift |
| 24 | `20260517000000_emma_appointments.sql` | Appointment ingestion table. | lift |
| 25 | `20260517010000_emma_noshow_policies.sql` | No-show policies per tenant. | lift |
| 26 | `20260517020000_emma_preshow_cron.sql` | Preshow reminder cron. | lift |
| 27 | `20260518000000_emma_waitlist.sql` | Waitlist (cancellations). | lift |
| 28 | `20260518010000_emma_rescue.sql` | Rescue (emergency recovery) outreach. | lift |
| 29 | `20260519000000_emma_reliability.sql` | Reliability scoring. | lift |
| 30 | `20260519010000_emma_reliability_cron.sql` | Reliability sweep cron. | lift |
| 31 | `20260520000000_emma_recovery_events.sql` | Core recovery ledger. | lift |
| 32 | `20260520010000_emma_reconcile_cron.sql` | Reconcile cron. | lift |
| 33 | `20260521000000_emma_deposit_holds.sql` | Deposit holds. | lift |
| 34 | `20260522000000_emma_intelligence.sql` | Intelligence layer. | lift |
| 35 | `20260522010000_emma_recommendations_cron.sql` | Recommendations cron. | lift |
| 36 | `20260523000000_emma_billing.sql` | Emma-side billing. | lift |
| 37 | `20260523010000_emma_invoice_cron.sql` | Emma invoice cron. | lift |
| 38 | `20260524000000_emma_csv_dialect_cache.sql` | CSV dialect cache. | lift |

---

## Section 4 — Scan funnel + setup intent

| Order | File | Purpose | Status |
|---|---|---|---|
| 39 | `20260525000000_scan_public.sql` | Public scan surface (anon access). | lift |
| 40 | `20260525010000_scan_followup.sql` | Scan result delivery + tokens. | lift |
| 41 | `20260526000000_scan_report_hosting.sql` | Hosted scan report. | lift |
| 42 | `20260527000000_refill_setup_intent.sql` | Onboarding setup intent. | lift |

---

## Section 5 — Emma post-scan additions

| Order | File | Purpose | Status |
|---|---|---|---|
| 43 | `20260528000000_emma_waitlist_intent.sql` | Waitlist intent. | lift |
| 44 | `20260529000000_emma_rescue_proxy.sql` | Rescue proxy mechanism. | lift |
| 45 | `20260530000000_emma_scheduler_connections.sql` | Scheduler OAuth credentials (Acuity). | lift |
| 46 | `20260530010000_emma_appointments_source_expand.sql` | Appointment source canonicalization. | lift |
| 47 | `20260530020000_emma_rescue_one_active_per_apt.sql` | One-active-per-apt constraint. | lift |

---

## Section 6 — Refill core (tenants, auth gate, billing)

| Order | File | Purpose | Status |
|---|---|---|---|
| 48 | `20260531000000_refill_auth_gate.sql` | Auth gate on tenants. | lift |
| 49 | `20260531010000_refill_tenants.sql` | tenants + tenant_memberships. | lift |
| 50 | `20260531020000_refill_trial_drip.sql` | Trial drip campaign. | lift |
| 51 | `20260531030000_refill_incentive_offers.sql` | Incentive offers. | lift |
| 52 | `20260601000000_refill_billing.sql` | Refill billing core. | lift |
| 53 | `20260602000000_stripe_customer_mode_aware.sql` | Stripe customer ID by mode. | lift |
| 54 | `20260603000000_refill_invoice_cron.sql` | Refill invoice cron. | lift |

---

## Section 7 — Outreach engine

| Order | File | Purpose | Status |
|---|---|---|---|
| 55 | `20260604000000_outreach_templates.sql` | Outreach template library (DB-driven). | lift |
| 56 | `20260605000000_outreach_engagement_events.sql` | Open/click/reply tracking. | lift |

---

## Section 8 — Rep platform

| Order | File | Purpose | Status |
|---|---|---|---|
| 57 | `20260606000000_rep_platform_foundation.sql` | Rep accounts foundation. | lift |
| 58 | `20260607000000_rep_platform_phase_2d.sql` | Rep platform phase 2d. | lift |
| 59 | `20260608000000_rep_platform_demo_seed.sql` | Kelly + Maria + sub-rep tree seed. | **⚠️ ADJUST** (creates auth.users — may collide with Step 2.4 pre-create) |
| 60 | `20260609000000_voice_shift_pinch_18.sql` | Voice shift table. | lift |
| 61 | `20260610000000_seed_restitch_spa_names.sql` | Demo spa name seed. | **⚠️ ADJUST** (data seed) |
| 62 | `20260611000000_rep_referral_links.sql` | Referral link mint. | lift |
| 63 | `20260612000000_kelly_outreach_history_seed.sql` | Kelly outreach seed. | **⚠️ ADJUST** (depends on Kelly user_id existing) |
| 64 | `20260613000000_outreach_rep_audience.sql` | Rep audience selection. | lift |
| 65 | `20260614000000_kelly_recruit_seed.sql` | Kelly recruit seed. | **⚠️ ADJUST** (depends on Kelly user_id existing) |

---

## Section 9 — Tenant finishing + v417 personas

| Order | File | Purpose | Status |
|---|---|---|---|
| 66 | `20260615000000_tenants_is_demo.sql` | tenants.is_demo flag. | lift |
| 67 | `20260615010000_karen_demo_seed.sql` | Karen + Rejuv tenant seed. | **⚠️ ADJUST** (depends on Karen user_id existing) |
| 68 | `20260616000000_refill_pricing_plans_add_predictable.sql` | Predictable pricing tier. | lift |
| 69 | `20260617000000_tenants_delivery_channel.sql` | tenants.delivery_channel (proxy/direct). | lift |
| 70 | `20260618000000_v417_admin_personas.sql` | Admin role + persona primary_role. | **⚠️ ADJUST** (references davidfand303@gmail.com user_id) |
| 71 | `20260618010000_v417_admin_testing_identity.sql` | admin@refill-demo.test creation + password seeding for Kelly/Maria/Karen. | **⚠️ ADJUST** (hardcoded user_id `addf1110-...`; may collide on re-run) |
| 72 | `20260618020000_v417_admin_refill_next.sql` | Admin refill_next metadata. | lift (depends on 71) |
| 73 | `20260618030000_v417_persona_bridge_metadata.sql` | Kelly/Maria refill_next metadata. | lift (depends on rep_platform_demo_seed) |

---

## SKIPPED — Agentiport-only (not ported)

Major categories — **89 migrations** stay in openagenticv4:

- All April 2026-04-* migrations except the two with named purposes — pre-cleave Agentiport platform bootstrap
- `agent_*` — agent gallery, versions, memories, attribution, etc.
- `pipeline_*` — pipeline builder
- `bundle_manifest_v2`, `workspace_connections`, `connectors_catalog`, `connector_watches`, `connector_health_cron`
- `usage_events`, `chat_feedback`, `chat_history`, `memory_items`, `refinement_suggestions`, `test_run_agent_snapshot`
- `wcs_payments*`, `user_api_keys`, `user_subscriptions`, `agents_preferred_model`
- `stores`, `stripe_accounts`, `gallery_paid_seed`, `clawhub_top10_certification_seeds`
- `waitlist_signups` (Agentiport waitlist), `scheduler_cron`, `payout_policy_v2`, `event_trigger_state`, `scheduler_sweeps`
- `ai_assist_events_clars`, `mcp_servers`, `approval_rules`, `composio_*`
- `connected_repos`, `connected_agents`, `escalations`, `knowledge_*`
- `callback_signing`, `backfill_connected_agent_id`, `agent_chat_sessions`, `drop_platform_check`
- `twilio_bridge` (Agentiport's SMS bridge for Karen/Liz — Refill has its own sms-provider/* abstraction)

---

## Paste-marathon plan (Step 2.6)

Chunk the 74 migrations into 8 batches for the dashboard paste. Each batch:
1. Po hands you the .sql files for a batch as one combined SQL block (or links to file paths)
2. Operator pastes in Supabase SQL editor
3. Po surfaces verify SELECTs to confirm expected rows
4. Move to next batch

Batch boundaries (cleaved at natural section breaks):
- **Batch A**: New admin seed prep + Section 1 (1 + 2 = 3 files)
- **Batch B**: Section 2 (18 files — spa claim, reports, promotions, patient foundation)
- **Batch C**: Section 3 first half (Emma engine 21–30 = 10 files)
- **Batch D**: Section 3 second half (Emma engine 31–38 = 8 files)
- **Batch E**: Sections 4–5 (scan + Emma additions = 9 files)
- **Batch F**: Sections 6–7 (Refill core + outreach = 9 files)
- **Batch G**: Section 8 (rep platform with adjust items = 9 files)
- **Batch H**: Section 9 (tenant finishing + v417 personas = 8 files)
