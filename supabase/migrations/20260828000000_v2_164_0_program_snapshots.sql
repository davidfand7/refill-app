-- v2.164.0 — program_snapshots: per-tenant manufacturer rewards-program
-- snapshots — the real source for Program Intelligence (Incentives → Program).
--
-- Slice 1 of the capture → intelligence loop. This table PERSISTS snapshots;
-- loadSnapshot() reads latest + prior here (prior = same manufacturer, for the
-- "what changed" diff), falling back to the seed constant until real captures
-- land (Slice 2: vision/AI capture writes rows here). Snapshots are immutable
-- captures — we append a new row per pull, never mutate (hence no updated_at).

create table if not exists public.program_snapshots (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  manufacturer  text not null,
  snapshot      jsonb not null,
  source        text not null default 'manual_capture'
                  check (source in ('manual_capture','portal_pull')),
  pulled_at     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- One snapshot per (tenant, manufacturer, pull instant) — re-capturing the same
-- pull upserts rather than duplicating.
create unique index if not exists program_snapshots_tenant_mfr_pulled_uniq
  on public.program_snapshots (tenant_id, manufacturer, pulled_at);

-- Latest-first lookups: per tenant (pick the newest), and per tenant+manufacturer
-- (find the prior pull to diff against).
create index if not exists program_snapshots_tenant_pulled_idx
  on public.program_snapshots (tenant_id, pulled_at desc);
create index if not exists program_snapshots_tenant_mfr_pulled_idx
  on public.program_snapshots (tenant_id, manufacturer, pulled_at desc);

alter table public.program_snapshots enable row level security;

-- Read/write only via service-role server fns (getProgramIntelFn, and the
-- Slice 2 capture path). The UI never touches this table directly.
drop policy if exists "program_snapshots_service_role_all" on public.program_snapshots;
create policy "program_snapshots_service_role_all"
  on public.program_snapshots for all to service_role using (true) with check (true);

comment on table public.program_snapshots is
  'Per-tenant manufacturer rewards-program snapshots (ProgramSnapshot jsonb). Source for Program Intelligence; latest = current readout, prior (same manufacturer) = diff baseline. Append-only per pull.';
