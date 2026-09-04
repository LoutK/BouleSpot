drop policy if exists "user_locations_insert_all" on public.user_locations;
drop policy if exists "user_locations_insert_service_role_only" on public.user_locations;

create policy "user_locations_insert_service_role_only"
  on public.user_locations
  for insert
  to service_role
  with check (true);
