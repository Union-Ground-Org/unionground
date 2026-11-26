-- BUG-UG-EXPIRED-CLAIM-RESTART-HANDOFF-20261019
-- Hide lapsed email claims in the authorized read so Start again exposes the
-- request form before retention. submit_organization_claim already expires
-- these rows under its locks before deciding whether to issue a replacement.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_organization_catalog_verification(
  p_selected_hat text,
  p_expected_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  placement private.organization_catalog_placements%rowtype;
  verified_identity jsonb;
  open_claim jsonb;
begin
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into placement
    from private.organization_catalog_placements as p
   where p.organization_id = org;
  if found and placement.verified_at is not null then
    if placement.identity_catalog_key is not null then
      verified_identity := pg_catalog.jsonb_build_object(
        'kind', 'catalog',
        'catalogKey', placement.identity_catalog_key,
        'name', (select o.name from private.catalog_organizations as o
                  where o.catalog_key = placement.identity_catalog_key));
    else
      verified_identity := pg_catalog.jsonb_build_object(
        'kind', 'unlisted',
        'catalogKey', null,
        'name', (select o.name from public.organizations as o where o.id = org));
    end if;
  end if;

  select pg_catalog.jsonb_build_object(
           'state', case when c.status = 'awaiting_email' then 'awaiting_email' else 'in_review' end,
           'catalogKey', c.catalog_key)
    into open_claim
    from private.organization_claims as c
   where c.organization_id = org
     and c.status in ('awaiting_email', 'under_review', 'held')
     and (c.status <> 'awaiting_email' or c.confirm_expires_at > pg_catalog.now())
   order by c.created_at desc
   limit 1;

  return pg_catalog.jsonb_build_object(
    'verification', pg_catalog.jsonb_build_object(
      'status', case when verified_identity is not null then 'verified' else 'self_reported' end,
      'identity', verified_identity,
      'verifiedAt', case when verified_identity is not null then placement.verified_at end),
    'openClaim', open_claim
  );
end;
$function$;

notify pgrst, 'reload schema';
commit;
