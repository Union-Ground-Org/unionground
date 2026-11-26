-- REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111 (#8281,
-- follow-up to #8212; a project decision): a
-- member may discard their own unsubmitted draft.
--
-- public.discard_form_draft takes the case-graph lock first and the form lock
-- (the locks every form writer takes), requires a signed-in member with a
-- satisfied second factor, and deletes only the caller's own row with status
-- draft that was never submitted and has no case. Someone else's draft, a
-- missing id and a form that was ever submitted are refused alike. It waits
-- while an attachment is still uploading or being deleted. Signatures,
-- co-signer invitations, attachment rows and steward shares cascade; the
-- private-upload orphan sweep removes the stored files.
--
-- No other function changes. A save naming a discarded form is already
-- refused (PT409 form_not_editable, 20261113114500 and 20261113134400), so
-- another tab's save never recreates the draft.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.discard_form_draft(p_form_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  rec record;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.lock_member_form(p_form_id);
  select id, user_id, status, submitted_at, case_id into rec
    from public.member_forms where id = p_form_id for update;
  -- Someone else's form, a missing one and one that was ever submitted
  -- (submitted, in review, approved or returned) are refused alike.
  if not found or rec.user_id <> caller or rec.status <> 'draft'
     or rec.submitted_at is not null or rec.case_id is not null then
    raise exception 'form not found' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id
               and (confirmed_at is null or deletion_requested_at is not null)) then
    raise exception 'wait for every attachment to finish' using errcode = '22023';
  end if;
  -- Signatures, co-signer invitations, attachment rows and steward shares
  -- cascade; the private-upload orphan sweep removes the stored files.
  delete from public.member_forms where id = p_form_id and user_id = caller and status = 'draft';
  return pg_catalog.jsonb_build_object('formId', p_form_id, 'discarded', true);
end;
end
$function$;
revoke all on function public.discard_form_draft(uuid) from public, anon, service_role;
grant execute on function public.discard_form_draft(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
