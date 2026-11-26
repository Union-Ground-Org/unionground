-- UB-WKL-04: cross-device My Reports layout, owned by exactly one member.
create table public.member_report_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  config jsonb not null default '{"order":[],"hidden":[],"custom":[]}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint member_report_preferences_config_shape check (
    jsonb_typeof(config) = 'object'
    and jsonb_typeof(config->'order') = 'array'
    and jsonb_typeof(config->'hidden') = 'array'
    and jsonb_typeof(config->'custom') = 'array'
    and jsonb_array_length(config->'order') <= 50
    and jsonb_array_length(config->'hidden') <= 50
    and jsonb_array_length(config->'custom') <= 25
    and pg_catalog.octet_length(config::text) <= 20000
  )
);

alter table public.member_report_preferences enable row level security;
create policy member_report_preferences_select_own on public.member_report_preferences
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.member_report_preferences from public, anon, authenticated;

create function public.get_my_report_preferences()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return (select p.config from public.member_report_preferences p where p.user_id = caller);
end
$$;

create function public.save_my_report_preferences(p_config jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object'
     or jsonb_typeof(p_config->'order') <> 'array'
     or jsonb_typeof(p_config->'hidden') <> 'array'
     or jsonb_typeof(p_config->'custom') <> 'array'
     or jsonb_array_length(p_config->'order') > 50
     or jsonb_array_length(p_config->'hidden') > 50
     or jsonb_array_length(p_config->'custom') > 25
     or octet_length(p_config::text) > 20000 then
    raise exception 'invalid report preferences' using errcode = '22023';
  end if;
  -- Every id/enum is also bounded structurally; arbitrary nested payloads do
  -- not become a 20KB storage loophole or executable client configuration.
  if exists (select 1 from jsonb_array_elements(p_config->'order') v where jsonb_typeof(v) <> 'string')
     or exists (select 1 from jsonb_array_elements(p_config->'hidden') v where jsonb_typeof(v) <> 'string')
     or exists (select 1 from jsonb_array_elements_text(p_config->'order') v where v !~ '^[a-z0-9-]{1,80}$')
     or exists (select 1 from jsonb_array_elements_text(p_config->'hidden') v where v !~ '^[a-z0-9-]{1,80}$')
     or exists (
       select 1 from jsonb_array_elements(p_config->'custom') c
       where jsonb_typeof(c) <> 'object'
          or not (c ?& array['id','metric','kind','range'])
          or c->>'id' !~ '^c-[a-z0-9-]{1,70}$'
          or c->>'metric' not in ('pts','actions','votes','hours')
          or c->>'kind' not in ('spark','rows','stat')
          or c->>'range' not in ('recent','ytd','all')
     ) then raise exception 'invalid report preferences' using errcode = '22023'; end if;

  insert into public.member_report_preferences(user_id, config) values (caller, p_config)
  on conflict (user_id) do update set config = excluded.config, updated_at = now();
  return p_config;
end
$$;

revoke all on function public.get_my_report_preferences() from public, anon;
revoke all on function public.save_my_report_preferences(jsonb) from public, anon;
grant execute on function public.get_my_report_preferences() to authenticated;
grant execute on function public.save_my_report_preferences(jsonb) to authenticated;
