-- v368: Universal LLM-mapped CSV adapter — per-spa header-hash cache.
--
-- When a spa uploads a CSV the importer can't recognize via the v367
-- hardcoded dialect cascade (or whose generic-fuzzy parse returns zero
-- appointments), we call a single small LLM mapping pass that returns
-- header → canonical-field aliases. The mapping is cached here keyed
-- on (user_id, header_hash) so every subsequent upload of that same
-- CSV shape is free — no LLM call, no latency, deterministic parse.
--
-- The user_corrected_at column captures human-in-the-loop fixes: if the
-- spa edits the mapping in the UI, we stamp it and trust the corrected
-- mapping forever. The LLM never gets to re-overwrite a manual fix.

create table if not exists public.emma_csv_dialect_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Normalized SHA-256 hash of (header row lowercased, joined by |)
  header_hash text not null,
  -- Display-only name the LLM guessed ("Mindbody", "Custom export", etc.)
  detected_platform text,
  -- ColAliases shape: { date: ["Booking Date"], time: ["Start Time"], ... }
  alias_map jsonb not null,
  -- Which LLM produced this mapping (for future model-upgrade re-runs)
  llm_model text not null,
  llm_at timestamptz not null default now(),
  -- Stamped when a user manually edits the mapping. LLM never overwrites this.
  user_corrected_at timestamptz,
  use_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, header_hash)
);

create index if not exists emma_csv_dialect_cache_user_id_idx
  on public.emma_csv_dialect_cache (user_id);

alter table public.emma_csv_dialect_cache enable row level security;

-- Spa owners can see + edit their own cache rows
create policy "spa owners select own dialect cache"
  on public.emma_csv_dialect_cache for select
  using (auth.uid() = user_id);

create policy "spa owners update own dialect cache"
  on public.emma_csv_dialect_cache for update
  using (auth.uid() = user_id);

create policy "spa owners delete own dialect cache"
  on public.emma_csv_dialect_cache for delete
  using (auth.uid() = user_id);

-- Service role full access (the ingest fn writes via service role)
create policy "service role full access on dialect cache"
  on public.emma_csv_dialect_cache for all
  to service_role using (true) with check (true);

-- updated_at auto-touch
create or replace function public.touch_emma_csv_dialect_cache_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_emma_csv_dialect_cache_updated_at
  on public.emma_csv_dialect_cache;
create trigger trg_emma_csv_dialect_cache_updated_at
  before update on public.emma_csv_dialect_cache
  for each row execute function public.touch_emma_csv_dialect_cache_updated_at();
