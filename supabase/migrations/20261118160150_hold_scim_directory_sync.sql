-- REQ-UG-HOLD-DIRECTORY-SYNC-WITH-SINGLE-SIGN-ON-20261117 (#9037).
--
-- Project decision (November 13, 2026): directory
-- sync (SCIM) is held together with single sign-on, which
-- 20261112214700_hold_release_calendar_switches holds. Each release is pressed
-- by hand, so the switch is held with no date (infinity), as the others are,
-- and is released later with scripts/release-calendar.mjs.
--
-- Held, private.organization_feature_enabled reads the switch off for every
-- organization whatever its stored value (kept, untouched): the admin settings
-- list leaves it out and refuses it on write, public.issue_scim_token refuses
-- (scim provisioning is switched off), public.scim_authenticate answers
-- disabled for every token, and /scim/v2 (api/scim.js) answers 403.
--
-- What the switch alone does not hide, as for single sign-on in 20261112214700:
-- public.get_scim_control() answered the setup page (chapters, tokens, groups,
-- directory counts) whatever the switch. While the switch is held it answers
-- only {organizationId, released: false}; released, it adds released: true and
-- nothing else changes. The web Integrations page and the phone Integration
-- controls screen read that answer to leave directory sync out.
--
-- The guard refuses a database where the definition row is missing or is not
-- a boolean, so this hold can never be recorded as applied while it holds
-- nothing.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- get_scim_control is replaced below from its only definition
-- (20261003041000); refuse a database where it has changed since.
do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_scim_control()'::regprocedure)
    is distinct from '2d444c7cf470e92aba13c8f02fb6c613' then
    raise exception 'unreviewed predecessor: public.get_scim_control' using errcode='55000';
  end if;
end
$preflight$;

do $hold$
declare
  held integer;
begin
  update public.platform_setting_definitions set release_at = 'infinity' where key = 'features.integrations.scim'
    and value_kind = 'boolean';
  get diagnostics held = row_count;
  if held <> 1 then
    raise exception 'expected to hold directory sync, held %', held using errcode = '55000';
  end if;
end;
$hold$;

-- Copied from 20261003041000:803-867 with only the hold added.
create or replace function public.get_scim_control()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  org := private.scim_admin_organization(false);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.platform_setting_definitions h
    where h.key = 'features.integrations.scim' and h.release_at > pg_catalog.now()
  ) then
    return pg_catalog.jsonb_build_object('organizationId', org, 'released', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'released', true,
    'enabled', private.organization_feature_enabled(org, 'features.integrations.scim'),
    'canManage', private.has_organization_role(org, array['admin']),
    'defaultChapterId', private.scim_default_chapter(org),
    'requestsPerMinute', private.organization_limit(org, 'limits.integrations.scim_requests_per_minute'),
    'invitationsPerDay', private.organization_limit(org, 'limits.integrations.scim_invitations_per_day'),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
      from public.chapters c where c.organization_id = org
    ), '[]'::jsonb),
    'tokens', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', t.id, 'label', t.label, 'tokenPrefix', t.token_prefix, 'createdAt', t.created_at,
        'expiresAt', t.expires_at, 'revokedAt', t.revoked_at, 'lastUsedAt', t.last_used_at
      ) order by t.created_at desc)
      from (select * from public.scim_tokens t where t.organization_id = org order by t.created_at desc limit 20) t
    ), '[]'::jsonb),
    'groups', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', g.id, 'displayName', g.display_name, 'mappedRole', g.mapped_role,
        'memberCount', (select pg_catalog.count(*) from public.scim_group_members m where m.group_id = g.id)
      ) order by g.display_name)
      from (select * from public.scim_groups g where g.organization_id = org order by g.display_name limit 200) g
    ), '[]'::jsonb),
    'users', (
      select pg_catalog.jsonb_build_object(
        'total', pg_catalog.count(*),
        'invited', pg_catalog.count(*) filter (where u.provisioning_state = 'invited'),
        'active', pg_catalog.count(*) filter (where u.provisioning_state = 'active'),
        'reactivationInvited', pg_catalog.count(*) filter (where u.provisioning_state = 'reactivation_invited'),
        'needsAdmin', pg_catalog.count(*) filter (where u.provisioning_state = 'needs_admin'),
        'deprovisioned', pg_catalog.count(*) filter (where u.provisioning_state = 'deprovisioned'))
      from public.scim_users u where u.organization_id = org
    ),
    'attention', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', u.id, 'userName', u.user_name, 'stateReason', u.state_reason, 'updatedAt', u.updated_at
      ) order by u.updated_at desc)
      from (select * from public.scim_users u
            where u.organization_id = org and u.provisioning_state = 'needs_admin'
            order by u.updated_at desc limit 25) u
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_scim_control() from public, anon, authenticated, service_role;
grant execute on function public.get_scim_control() to authenticated;

commit;
