-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- The server talks to these with the service-role key; RLS is on with no policies,
-- so the public anon key cannot read or write anything.

create table if not exists public.bsp_docs (
  path       text primary key,
  collection text not null,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists bsp_docs_collection_idx on public.bsp_docs (collection);
alter table public.bsp_docs enable row level security;

create table if not exists public.bsp_rl (
  k          text primary key,
  n          integer not null default 0,
  expires_at timestamptz not null
);
alter table public.bsp_rl enable row level security;

-- Fixed-window counter: returns the count after incrementing.
create or replace function public.bsp_bump(k text, win integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare c integer;
begin
  delete from public.bsp_rl where expires_at < now();
  insert into public.bsp_rl (k, n, expires_at)
    values (k, 1, now() + make_interval(secs => win))
  on conflict (k) do update set n = public.bsp_rl.n + 1
  returning n into c;
  return c;
end $$;
revoke all on function public.bsp_bump(text, integer) from public, anon, authenticated;
