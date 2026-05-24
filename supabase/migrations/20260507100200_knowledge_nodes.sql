-- Phase 3.5: Memory Graph storage — nodes.
--
-- Every Approve / Reject / Discuss in the CEO inbox extracts a node here
-- automatically (separate pass — see api.escalate / discuss-agent), and
-- agents can also push nodes directly via POST /api/memory-graph/upsert.
--
-- The graph is per-user and platform-agnostic — a Vertex agent and a Claude
-- Skill running for the same owner read/write the same institutional memory.
-- That portability is what makes the airport metaphor real.
--
-- node_type is intentionally free-form (decision / pattern / convention /
-- rationale / lesson / client / contributor / ...). lookup_key + lookup_type
-- are the primary index for tool-call retrieval (e.g. phone number → client).

create table if not exists public.knowledge_nodes (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  node_type           text        not null,
  title               text        not null,
  content             text        not null,
  context             text,
  lookup_key          text,
  lookup_type         text,
  weight              numeric     not null default 1.0,
  attachments         jsonb       not null default '[]'::jsonb,
  source              text,
  source_ref          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_referenced_at  timestamptz not null default now()
);

alter table public.knowledge_nodes enable row level security;

do $$ begin
  create policy "users_own_knowledge_nodes"
    on public.knowledge_nodes for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_knowledge_nodes"
    on public.knowledge_nodes for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists knowledge_nodes_lookup_idx
  on public.knowledge_nodes (user_id, context, lookup_type, lookup_key);

create index if not exists knowledge_nodes_recency_idx
  on public.knowledge_nodes (user_id, last_referenced_at desc);

create index if not exists knowledge_nodes_type_idx
  on public.knowledge_nodes (user_id, node_type);
