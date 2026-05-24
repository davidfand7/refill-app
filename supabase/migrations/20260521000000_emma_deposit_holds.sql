-- Emma(OS) deposit-credit holds (v364).
--
-- The OPTIONAL deposit-credit mechanic for the chronic-offender tail.
-- OFF by default. Most spas will never enable it. The marketing line
-- is "Emma never punishes your patients — unless you tell us to."
--
-- v364 ships the schema + settings activation + intent audit log.
-- v364.x (future) wires the Stripe payment_intent flow that puts an
-- actual hold on the patient's card. For now, when an in-recovery
-- patient books AND policy.deposit_enabled is true, Emma LOGS the
-- intent — a row marked 'intent' in this table. The spa owner sees
-- it on /app/emma/recovery Deposits tab; no money moves yet.
--
-- Status lifecycle (future Stripe wiring):
--   intent     — would-have-been-requested; logged today, no money moves
--   held       — Stripe payment_intent in requires_capture mode (auth)
--   applied    — appointment showed + billed; auth was captured as credit
--   refunded   — patient rescheduled in time; auth was released
--   voided     — spa cancelled the hold manually
--
-- Established 2026-05-17 (Promotions Engine v364).

create table if not exists public.emma_deposit_holds (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,

  -- The appointment the deposit is tied to. Null is invalid; deposits
  -- always reference a specific booking.
  appointment_id      uuid        not null references public.emma_appointments(id) on delete cascade,

  -- The patient on the hook.
  patient_node_id     uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- The trigger that fired this — useful for reporting which trigger
  -- type is producing the most holds (and for future A/B of triggers).
  trigger_reason      text        not null
                      check (trigger_reason in (
                        'in_recovery_tier',
                        'new_patient',
                        'high_value_treatment'
                      )),

  amount_usd          numeric(10,2) not null,

  -- v1 status enum. Future ships add the rest as Stripe wiring lands.
  status              text        not null default 'intent'
                      check (status in (
                        'intent',
                        'held',
                        'applied',
                        'refunded',
                        'voided'
                      )),

  -- Stripe payment_intent id when wired (v364.x); null on intent-only rows.
  stripe_payment_intent_id text,

  -- Lifecycle timestamps.
  intent_logged_at    timestamptz not null default now(),
  held_at             timestamptz,
  applied_at          timestamptz,
  refunded_at         timestamptz,
  voided_at           timestamptz,

  -- Audit fields.
  voided_by           text,
  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- One deposit per appointment. If the appointment is rescheduled
  -- (new emma_appointments row), the deposit follows the new row.
  unique (appointment_id)
);

alter table public.emma_deposit_holds enable row level security;

do $$ begin
  create policy "users_own_emma_deposit_holds"
    on public.emma_deposit_holds for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_deposit_holds"
    on public.emma_deposit_holds for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_deposit_holds_by_status_idx
  on public.emma_deposit_holds (user_id, status, intent_logged_at desc);

create index if not exists emma_deposit_holds_by_patient_idx
  on public.emma_deposit_holds (user_id, patient_node_id, intent_logged_at desc);

create trigger emma_deposit_holds_set_updated_at
  before update on public.emma_deposit_holds
  for each row execute function public.set_updated_at();

comment on table public.emma_deposit_holds is
  'Per-appointment deposit-credit lifecycle. Spa-scoped via RLS. v364 ships intent-only logging (status=intent); future v364.x wires Stripe payment_intent for actual card holds. OFF by default policy-side — owner must explicitly enable on /app/emma/settings/noshow.';
