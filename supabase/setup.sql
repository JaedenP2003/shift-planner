-- Shared schedule storage for Shift Planner. Run once in the Supabase SQL editor.
-- The whole schedule is one JSON row. Only accounts listed in planner_editors can use it.

create table public.planner_editors (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table public.planner (
  id text primary key check (id = 'main'),
  data jsonb not null check (pg_column_size(data) < 5000000),
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.planner_editors enable row level security;
alter table public.planner enable row level security;

revoke all on public.planner_editors, public.planner from anon, authenticated;
grant select on public.planner_editors to authenticated;
grant select, insert, update on public.planner to authenticated;

create policy "see own editor entry" on public.planner_editors
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "editors read" on public.planner
  for select to authenticated
  using (exists (select 1 from public.planner_editors e where e.user_id = (select auth.uid())));

create policy "editors create" on public.planner
  for insert to authenticated
  with check (exists (select 1 from public.planner_editors e where e.user_id = (select auth.uid())));

create policy "editors change" on public.planner
  for update to authenticated
  using (exists (select 1 from public.planner_editors e where e.user_id = (select auth.uid())))
  with check (exists (select 1 from public.planner_editors e where e.user_id = (select auth.uid())));

-- Every save must build on the latest revision, so one person can't silently overwrite another.
create function public.planner_check_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.revision <> old.revision + 1 then
    raise exception 'The schedule changed since it was loaded.';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger planner_revision before update on public.planner
  for each row execute function public.planner_check_revision();

-- After adding the shared user (Authentication > Users > Add user), allow it in:
-- insert into public.planner_editors (user_id)
--   select id from auth.users where email = 'THE-SHARED-EMAIL';
