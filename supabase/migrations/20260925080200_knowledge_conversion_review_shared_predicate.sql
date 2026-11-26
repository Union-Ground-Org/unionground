-- SEC-UG-KNOWLEDGE-CONVERSION-WRITE-PREDICATE-WEAKER-THAN-READ-20260920
--
-- public.review_knowledge_conversion (live body 20260917145000) and
-- public.reject_knowledge_conversion (live body 20260918205000) authorized the
-- review write with a hand-rolled organization_memberships x
-- organization_role_grants EXISTS, while the ledger's only SELECT policy,
-- organization_knowledge_conversions_staff_read, uses
-- private.has_organization_role. The inline check dropped two terms that
-- predicate carries: the binding to the caller's selected staff organization
-- (private.current_mobile_staff_organization()) and the staff second factor
-- (private.has_second_factor() whenever private.staff_mfa_required()). A caller
-- the read policy refuses could still sign a review.
--
-- Both RPCs now authorize through private.has_organization_role with the
-- policy's exact role list. Everything else in each body -- the case-graph
-- lock, the MFA gate, reject's refuse-before-validate order, the single
-- awaiting-review update and the returned shape -- is unchanged. Grants are
-- preserved by CREATE OR REPLACE; the append-only trigger is not touched.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.review_knowledge_conversion(
  p_organization_id uuid, p_conversion_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  reviewer uuid;
  row_out public.organization_knowledge_conversions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  reviewer := (select auth.uid());
  if reviewer is null or p_organization_id is null or p_conversion_id is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not (select private.mfa_satisfied()) then
    raise exception 'reauthentication required' using errcode = '42501';
  end if;
  -- The same predicate as organization_knowledge_conversions_staff_read:
  -- active membership, a staff grant in THIS organization, the caller's
  -- selected staff organization, and the staff second factor.
  if not private.has_organization_role(
    p_organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then raise exception 'not authorized' using errcode = '42501'; end if;

  update public.organization_knowledge_conversions
  set conversion_reviewed_at = pg_catalog.now(),
      conversion_reviewed_by = reviewer,
      review_status = 'approved'
  where id = p_conversion_id
    and organization_id = p_organization_id
    and conversion_reviewed_at is null
  returning * into row_out;
  if not found then
    raise exception 'conversion is not awaiting review' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'id', row_out.id,
    'sourceId', row_out.source_id,
    'attempt', row_out.attempt,
    'reviewedAt', row_out.conversion_reviewed_at,
    'reviewedBy', row_out.conversion_reviewed_by,
    'reviewStatus', row_out.review_status
  );
end;
$function$;

create or replace function public.reject_knowledge_conversion(
  p_organization_id uuid, p_conversion_id uuid, p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  reviewer uuid;
  reason text;
  row_out public.organization_knowledge_conversions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  reviewer := (select auth.uid());
  reason := pg_catalog.btrim(coalesce(p_reason, ''));
  if reviewer is null or p_organization_id is null or p_conversion_id is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not (select private.mfa_satisfied()) then
    raise exception 'reauthentication required' using errcode = '42501';
  end if;
  -- Refuse before validating, exactly as public.review_knowledge_conversion
  -- does: a caller who may not write this organization's reviews must learn
  -- that and nothing else, whatever they sent as a reason.
  -- The same predicate as organization_knowledge_conversions_staff_read:
  -- active membership, a staff grant in THIS organization, the caller's
  -- selected staff organization, and the staff second factor.
  if not private.has_organization_role(
    p_organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then raise exception 'not authorized' using errcode = '42501'; end if;
  if pg_catalog.char_length(reason) not between 1 and 280 then
    raise exception 'invalid conversion rejection' using errcode = '22023';
  end if;

  update public.organization_knowledge_conversions
  set conversion_reviewed_at = pg_catalog.now(),
      conversion_reviewed_by = reviewer,
      review_status = 'rejected',
      rejection_reason = reason
  where id = p_conversion_id
    and organization_id = p_organization_id
    and conversion_reviewed_at is null
  returning * into row_out;
  if not found then
    raise exception 'conversion is not awaiting review' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'id', row_out.id,
    'sourceId', row_out.source_id,
    'attempt', row_out.attempt,
    'reviewedAt', row_out.conversion_reviewed_at,
    'reviewedBy', row_out.conversion_reviewed_by,
    'reviewStatus', row_out.review_status,
    'rejectionReason', row_out.rejection_reason
  );
end;
$function$;

commit;
