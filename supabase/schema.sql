create table if not exists public.user_locations (
  id text primary key,
  name text not null,
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  source text not null default 'Gebruiker',
  created_at timestamptz not null default now()
);

create table if not exists public.ratings (
  id bigint generated always as identity primary key,
  location_id text not null,
  location_score smallint check (location_score between 1 and 5),
  atmosphere_score smallint check (atmosphere_score between 1 and 5),
  created_at timestamptz not null default now(),
  constraint ratings_has_score check (location_score is not null or atmosphere_score is not null)
);

create index if not exists ratings_location_id_idx on public.ratings (location_id);

alter table public.user_locations enable row level security;
alter table public.ratings enable row level security;

drop policy if exists "user_locations_select_all" on public.user_locations;
create policy "user_locations_select_all"
  on public.user_locations
  for select
  to anon, authenticated
  using (true);

drop policy if exists "user_locations_insert_all" on public.user_locations;
create policy "user_locations_insert_all"
  on public.user_locations
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "ratings_select_all" on public.ratings;
create policy "ratings_select_all"
  on public.ratings
  for select
  to anon, authenticated
  using (true);

drop policy if exists "ratings_insert_all" on public.ratings;
create policy "ratings_insert_all"
  on public.ratings
  for insert
  to anon, authenticated
  with check (true);
