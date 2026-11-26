-- UB-NAV-01: durable, account-scoped phone navigation preferences.
-- Empty arrays mean “use current product defaults”; clients normalize them at
-- render time so a newly shipped destination can join defaults without a data
-- backfill. Non-empty arrays are bounded and allowlisted here because the
-- authenticated role can update these two columns on its own RLS-scoped row.

create function private.valid_member_preference_keys(
  p_value text[],
  p_allowed text[],
  p_max integer
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $function$
  select
    pg_catalog.cardinality(p_value) <= p_max
    and pg_catalog.array_position(p_value, null) is null
    and p_value <@ p_allowed
    and pg_catalog.cardinality(p_value) = (
      select pg_catalog.count(distinct key)
      from pg_catalog.unnest(p_value) as keys(key)
    );
$function$;

revoke all on function private.valid_member_preference_keys(text[], text[], integer)
  from public, anon, authenticated, service_role;

alter table public.member_profiles
  add column shortcut_keys text[] not null default '{}'::text[],
  add column work_widget_order text[] not null default '{}'::text[],
  add constraint member_profiles_shortcut_keys_valid check (
    private.valid_member_preference_keys(
      shortcut_keys,
      array['today','numbers','voting','rights','cases','messages','events','rewards','forms','appointments','workload','voice','hub','search','settings','compass']::text[],
      6
    )
  ),
  add constraint member_profiles_work_widget_order_valid check (
    private.valid_member_preference_keys(
      work_widget_order,
      array['messages','appointments','cases','forms','workload','numbers']::text[],
      6
    )
  );

grant update (shortcut_keys, work_widget_order)
  on table public.member_profiles to authenticated;
