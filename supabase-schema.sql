create table if not exists public.app_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "server service role can manage app state" on public.app_state;

create policy "server service role can manage app state"
on public.app_state
for all
using (true)
with check (true);
