-- BUG-UG-ORGANIZATION-CHAPTERLESS-ADMIN-VP-LOCKED-OUT-INTEGRATION-CONTROL-RPC-20260921
--
-- The integration control plane resolved its tenant through
-- private.mi1_require_selected_organization(), which derives the organization
-- from the caller's selected chapter (private.current_member_organization()
-- inner-joins member_chapter_memberships). An organization-only admin or VP —
-- the persona 20260902050000_g4_native_staff_authorization_depth.sql documents
-- and admits everywhere else — holds an active organization membership and an
-- organization_role_grants row but no chapter membership, so that resolver
-- returned NULL and every integration RPC raised 'active organization
-- membership required' before the role check ever ran. The same caller already
-- passes private.has_organization_role(), which compares against
-- private.current_mobile_staff_organization(), so the refusal was a resolver
-- mismatch rather than an authorization decision.
--
-- Move the integration guard onto that same resolver: a selected chapter still
-- wins, an organization-only caller resolves only when exactly one active
-- organization membership exists, and two or more still fail closed. The
-- admin/VP grant check is unchanged, so this admits no caller who could not
-- already act as organization staff on every sibling surface.
--
-- public.list_organization_integrations() was the one integration RPC that
-- inlined the chapter-bound resolver instead of calling the shared guard; it
-- now goes through private.mi1_require_integration_admin() like the rest of the
-- control plane. Its own MFA and role assertions are retained.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.mi1_require_integration_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  -- Selected chapter first, then exactly one active organization membership.
  -- Multiple organizations resolve to NULL and are refused below.
  org := private.current_mobile_staff_organization();
  if org is null then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return org;
end;
$function$;

revoke all on function private.mi1_require_integration_admin()
  from public, anon, authenticated, service_role;

comment on function private.mi1_require_integration_admin() is
  'Integration control-plane tenant guard. Resolves the organization the same way private.has_organization_role() does — selected chapter first, otherwise exactly one active organization membership, multiple organizations fail closed — so an organization-only admin or VP is not refused a tenant it already holds a role in. Organization admin/vp remains required.';

create or replace function public.list_organization_integrations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', i.id,
      'organizationId', i.organization_id,
      'provider', i.provider,
      'status', i.status,
      'accountOwner', i.account_owner,
      'allowChapterOverrides', i.allow_chapter_overrides,
      'allowChapterOwnedAccounts', i.allow_chapter_owned_accounts,
      'allowedChapterOverrideKeys', i.allowed_chapter_override_keys,
      'defaultSettings', i.default_settings,
      'hasCredentialRef', i.credential_ref is not null,
      'lastJobStatus', i.last_job_status,
      'lastErrorCode', i.last_error_code
    ) order by i.provider)
    from public.organization_integrations i
    where i.organization_id = org
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_integrations()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_integrations() to authenticated;

comment on function public.list_organization_integrations() is
  'Sanitized integration list for the caller''s organization; credential hashes stay off the wire. Shares the control-plane guard, so an organization-only admin or VP reads the same providers the write RPCs already accept.';

notify pgrst, 'reload schema';

commit;
