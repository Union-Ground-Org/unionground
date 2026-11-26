begin;

-- UX-UG-KNOWLEDGE-CONVERSION-CARD-POLISH-20260917, database half.
--
-- Two bounded repairs to what 20260917145000 installed, neither of which
-- changes who may write a conversion review or what a review records.
--
-- 1. public.reject_knowledge_conversion validated the reason BEFORE it checked
--    the caller's active staff role, so a non-member who sent a blank or
--    281-character reason was answered 'invalid conversion rejection' (22023)
--    instead of 'not authorized' (42501). No row was disclosed, so this was an
--    ordering inconsistency rather than a leak, but public.review_knowledge_
--    conversion and every other gate in that file refuses first and validates
--    after. The reason check moves below the membership check so the two
--    siblings answer an unauthorized caller identically.
--
-- 2. private.knowledge_conversion_is_append_only() carried a third branch for
--    an already-signed row whose review_status was still null. That state
--    existed only for the in-migration backfill of 20260917145000. Once that
--    migration installed
--    organization_knowledge_conversions_review_is_complete, which asserts
--    (conversion_reviewed_at is null) = (review_status is null) as a table
--    invariant, no row can be signed with a null status again, so the branch
--    guards an unreachable state. Its removal narrows the append-only guard:
--    the second branch already refuses every review-column change on a signed
--    row, and it is now reached for every signed row rather than only for the
--    ones whose status was set.
--
-- No column, constraint, trigger binding, grant or RLS policy changes here.

create or replace function private.knowledge_conversion_is_append_only()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if (pg_catalog.to_jsonb(new)
        - 'conversion_reviewed_at'
        - 'conversion_reviewed_by'
        - 'review_status'
        - 'rejection_reason')
     is distinct from
     (pg_catalog.to_jsonb(old)
        - 'conversion_reviewed_at'
        - 'conversion_reviewed_by'
        - 'review_status'
        - 'rejection_reason') then
    raise exception 'knowledge conversion provenance is immutable' using errcode = '42501';
  end if;
  -- organization_knowledge_conversions_review_is_complete makes
  -- (conversion_reviewed_at is null) = (review_status is null) a table
  -- invariant, so a non-null conversion_reviewed_at is exactly a recorded
  -- decision. One branch therefore covers every signed row.
  if old.conversion_reviewed_at is not null
     and (new.conversion_reviewed_at, new.conversion_reviewed_by, new.review_status, new.rejection_reason)
        is distinct from
        (old.conversion_reviewed_at, old.conversion_reviewed_by, old.review_status, old.rejection_reason) then
    raise exception 'knowledge conversion review is recorded once' using errcode = '42501';
  end if;
  return new;
end;
$function$;

comment on function private.knowledge_conversion_is_append_only() is
  'Freezes every provenance column of public.organization_knowledge_conversions after insert. The reviewer pair, review_status and rejection_reason may be written exactly once; organization_knowledge_conversions_review_is_complete makes a signed row a recorded decision, so no separate allowance for a signed row without a status is reachable.';

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
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = reviewer and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
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

comment on function public.reject_knowledge_conversion(uuid, uuid, text) is
  'Records a rejected review of one conversion attempt with a bounded reason. Attribution is auth.uid(), never a parameter, MFA is demanded of the reviewer, the active-staff-role gate refuses before the reason is validated, and the append-only trigger makes the refusal unrepeatable. Failed conversions may be rejected so they do not remain pending; the ledger row is itself the audit record.';

-- THE ACCOUNT-LIFECYCLE REVIEW PIN.
--
-- private.account_lifecycle_trigger_surface() hashes the full definition of
-- every trigger reachable from the referential-action surface, and
-- private.account_lifecycle_referential_action_trigger_issues() reports any
-- hash the manifest has not reviewed. Re-emitting
-- private.knowledge_conversion_is_append_only() above changes that hash, so the
-- manifest row is reconciled here against its reviewed predecessor -- the
-- definition 20260917145000 left behind -- and the inventory is asserted empty
-- before this migration is allowed to commit.
do $reconcile_conversion_trigger_review$
declare
  reconciled integer;
begin
  update private.account_lifecycle_trigger_review
  set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(
    'private.knowledge_conversion_is_append_only()'::regprocedure))
  where kind = 'function' and schema_name = 'private' and table_name = ''
    and object_name = 'knowledge_conversion_is_append_only()'
    and definition_hash = '72508d38090a42c41cea7ff831f9af45';
  get diagnostics reconciled = row_count;
  if reconciled <> 1 then
    raise exception 'knowledge conversion append-only review pin was not updated exactly once';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the conversion gate-order migration';
  end if;
end;
$reconcile_conversion_trigger_review$;

commit;
