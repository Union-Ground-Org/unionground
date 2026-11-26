-- BUG-UG-SCIM-EMAIL-PATCH-IGNORED-20261020 / #5250 deciding-test repair.
-- Keep directory userName independent of the address used by the unchanged
-- invitation/account safeguards. An unchanged directory mapping cannot undo
-- a work-email correction on the next synchronization request.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Hold writers through the preflight and constraint installation. Refuse
-- existing collisions before backfilling or changing any function definition.
lock table public.scim_users in access exclusive mode;
do $assert_scim_account_bindings$
begin
  if exists (
    select 1 from public.scim_users
    where auth_user_id is not null
    group by organization_id, auth_user_id
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'SCIM account binding conflict: duplicate (organization_id, auth_user_id); reconcile before hosted cutover'
      using errcode = '23505', constraint = 'scim_users_organization_auth_user_key';
  end if;
end;
$assert_scim_account_bindings$;

alter table public.scim_users add column directory_user_name text;
update public.scim_users set directory_user_name = user_name;
alter table public.scim_users alter column directory_user_name set not null;
alter table public.scim_users add constraint scim_users_directory_name_shape check (
 directory_user_name = pg_catalog.lower(pg_catalog.btrim(directory_user_name))
 and pg_catalog.char_length(directory_user_name) between 1 and 254
 and directory_user_name !~ '[[:cntrl:]]');
alter table public.scim_users add constraint scim_users_organization_directory_name_key
 unique (organization_id, directory_user_name);
-- A renamed address does not release the original account binding. Enforce
-- this for reconciliation and invitation acceptance, including racing writes.
-- NULL bindings remain independent; the same account may belong to two orgs.
-- Existing duplicate bindings deliberately refuse the unapplied cutover.
alter table public.scim_users add constraint scim_users_organization_auth_user_key
 unique (organization_id, auth_user_id);

create or replace function private.scim_user_json(p_row public.scim_users)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'externalId', p_row.external_id,
    'userName', p_row.user_name,
    'directoryUserName', p_row.directory_user_name,
    'givenName', p_row.given_name,
    'familyName', p_row.family_name,
    'displayName', p_row.display_name,
    'active', p_row.active,
    'locale', p_row.locale,
    'state', p_row.provisioning_state,
    'stateReason', p_row.state_reason,
    'version', p_row.version,
    'createdAt', p_row.created_at,
    'updatedAt', p_row.updated_at
  );
$function$;

revoke all on function private.scim_user_json(public.scim_users) from public, anon, authenticated, service_role;

create or replace function public.scim_list_users(
  p_organization_id uuid,
  p_field text,
  p_value text,
  p_start_index integer,
  p_count integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  start_at integer := greatest(coalesce(p_start_index, 1), 1);
  page integer := least(greatest(coalesce(p_count, 100), 0), 200);
begin
  perform private.scim_require_service();
  if p_field is not null and p_field not in ('userName', 'externalId', 'id', 'emails.value') then
    raise exception 'unsupported filter' using errcode = '22023';
  end if;
  return (
    with matched as (
      select u.*
      from public.scim_users u
      where u.organization_id = p_organization_id
        and (p_field is null
          or (p_field = 'userName' and u.directory_user_name = pg_catalog.lower(pg_catalog.btrim(coalesce(p_value, ''))))
          or (p_field = 'emails.value' and u.user_name = pg_catalog.lower(pg_catalog.btrim(coalesce(p_value, ''))))
          or (p_field = 'externalId' and u.external_id = p_value)
          or (p_field = 'id' and u.id::text = pg_catalog.lower(coalesce(p_value, ''))))
    )
    select pg_catalog.jsonb_build_object(
      'totalResults', (select pg_catalog.count(*) from matched),
      'items', coalesce((
        select pg_catalog.jsonb_agg(private.scim_user_json(page_rows) order by page_rows.created_at, page_rows.id)
        from (select * from matched order by created_at, id offset start_at - 1 limit page) page_rows
      ), '[]'::jsonb))
  );
end;
$function$;

revoke all on function public.scim_list_users(uuid, text, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.scim_list_users(uuid, text, text, integer, integer) to service_role;

create or replace function public.scim_upsert_user(
  p_organization_id uuid,
  p_user_id uuid,
  p_user jsonb,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  user_row public.scim_users%rowtype;
  clean_name text;
  directory_name text;
  invitation jsonb;
  created boolean := false;
  renamed_account boolean := false;
begin
  perform private.scim_require_service();
  if p_user is null or pg_catalog.jsonb_typeof(p_user) <> 'object' then
    raise exception 'invalid scim user' using errcode = '22023';
  end if;
  clean_name := pg_catalog.lower(pg_catalog.btrim(coalesce(p_user ->> 'userName', '')));
  directory_name := pg_catalog.lower(pg_catalog.btrim(coalesce(p_user ->> 'directoryUserName', p_user ->> 'userName', '')));
  if directory_name = '' or pg_catalog.char_length(directory_name) > 254 or directory_name ~ '[[:cntrl:]]' then
    raise exception 'invalid directory userName' using errcode = '22023';
  end if;
  -- Serialize both directory-name and canonical-address uniqueness per tenant.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scim-directory-user:' || p_organization_id::text, 509));
  if p_user_id is null then
    if exists (select 1 from public.scim_users u
               where u.organization_id = p_organization_id
                 and (u.user_name = clean_name or u.directory_user_name = directory_name)) then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    insert into public.scim_users
      (organization_id, user_name, directory_user_name, external_id, given_name, family_name, display_name, active, locale)
    values
      (p_organization_id, clean_name, directory_name, nullif(p_user ->> 'externalId', ''), nullif(p_user ->> 'givenName', ''),
       nullif(p_user ->> 'familyName', ''), nullif(p_user ->> 'displayName', ''),
       coalesce((p_user ->> 'active')::boolean, true),
       case when p_user ->> 'locale' = 'es' then 'es' else 'en' end)
    returning * into user_row;
    created := true;
  else
    select * into user_row from public.scim_users u
    where u.id = p_user_id and u.organization_id = p_organization_id
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if exists (
      select 1 from public.scim_users u
      where u.organization_id = p_organization_id and u.id <> user_row.id
        and (u.user_name = clean_name or u.directory_user_name = directory_name)) then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if user_row.auth_user_id is null then
      perform private.scim_reconcile_user(user_row.id, null);
      select * into user_row from public.scim_users where id = user_row.id;
    end if;
    if clean_name <> user_row.user_name then
      if user_row.provisioning_state = 'invited' then
        -- Nobody accepted yet: the old address's open invitation is withdrawn
        -- and the new address is invited below.
        perform private.scim_revoke_pending_invitations(p_organization_id, user_row.user_name);
      elsif user_row.provisioning_state in ('active', 'reactivation_invited') then
        -- An account already holds the old address. SCIM never rewrites a
        -- sign-in address or invites a second account for the same person:
        -- an admin moves the address (sign-in recovery), after which the next
        -- sync matches the account again.
        renamed_account := true;
      end if;
    end if;
    update public.scim_users
    set provisioning_state = case when renamed_account then 'needs_admin' else provisioning_state end,
        state_reason = case when renamed_account then 'user_name_changed' else state_reason end,
        user_name = clean_name,
        directory_user_name = directory_name,
        external_id = nullif(p_user ->> 'externalId', ''),
        given_name = nullif(p_user ->> 'givenName', ''),
        family_name = nullif(p_user ->> 'familyName', ''),
        display_name = nullif(p_user ->> 'displayName', ''),
        active = coalesce((p_user ->> 'active')::boolean, true),
        locale = case when p_user ->> 'locale' = 'es' then 'es' else 'en' end,
        invitation_id = case when clean_name <> user_row.user_name then null else invitation_id end,
        version = version + 1,
        updated_at = pg_catalog.clock_timestamp()
    where id = user_row.id
    returning * into user_row;
  end if;
  invitation := private.scim_reconcile_user(user_row.id, p_token_hash);
  select * into user_row from public.scim_users where id = user_row.id;
  return pg_catalog.jsonb_build_object(
    'outcome', case when created then 'created' else 'updated' end,
    'user', private.scim_user_json(user_row),
    'invitation', invitation);
exception when unique_violation then
  -- Roll back the entire create/update (including reconciliation side effects)
  -- before the old or new endpoint maps this result to SCIM 409 uniqueness.
  return pg_catalog.jsonb_build_object('outcome', 'conflict');
end;
end;
$function$;

revoke all on function public.scim_upsert_user(uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.scim_upsert_user(uuid, uuid, jsonb, text) to service_role;

commit;
