-- BUG-UG-SCIM-CONFLICT-LABELS-AND-EMAIL-SELECTOR-TRIM-20261021
-- Report a SCIM user uniqueness refusal by the constraint that refused it.
-- scim_upsert_user caught every
-- unique_violation as one 'conflict', so an account-binding collision found
-- while reconciling read as a duplicate userName. The outcome stays 'conflict'
-- and `conflict` names the constraint (userName, binding or other), so an API
-- deployed before or after this migration still answers 409. The signature,
-- grants and every other statement are unchanged from 20261020232405.
--
-- scim_upsert_group needs no change: private.lock_case_graph holds the
-- exclusive (509, 700) advisory lock for the transaction, so a concurrent
-- create of the same displayName waits and its existence check then reports
-- the conflict before the unique index is reached.
begin;

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
  conflict_constraint text;
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
  -- The outcome stays 'conflict' for every endpoint version; `conflict` names
  -- the constraint so the API reports a binding collision as one.
  get stacked diagnostics conflict_constraint = constraint_name;
  return pg_catalog.jsonb_build_object('outcome', 'conflict', 'conflict',
    case
      when conflict_constraint in ('scim_users_organization_user_name_key', 'scim_users_organization_directory_name_key') then 'userName'
      when conflict_constraint = 'scim_users_organization_auth_user_key' then 'binding'
      else 'other'
    end);
end;
end;
$function$;

revoke all on function public.scim_upsert_user(uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.scim_upsert_user(uuid, uuid, jsonb, text) to service_role;

commit;
