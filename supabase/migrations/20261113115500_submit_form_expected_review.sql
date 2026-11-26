-- BUG-UG-FORM-SUBMIT-FILES-CONTENT-THE-SUBMITTER-NEVER-SAW-20261114 (#8705).
-- Submitting a form files only what the submitter reviewed.
--
-- public.submit_form took only the form id and filed the row as it stood
-- with whatever filer signature was current for it. After a device's last
-- check, another session of the same member could replace the answers or the
-- attachments and save a fresh signature over the replacement; the first
-- device's Submit then filed it while still showing the earlier content
-- (gate stage 146 on #8700, finding r8s1; the website had the same gap).
-- 20261113114500 (#8702) made signing compare the reviewed content; this is
-- its twin at the submit step.
--
-- submit_form gains p_expected jsonb DEFAULT NULL, the same object
-- sign_member_form takes: attachmentIds always (the confirmed attachment ids
-- shown, [] when none), plus dataVersion for a sealed template or answers for
-- an ordinary one. It is compared under the existing form lock, after the
-- attachment waits and before the signature check and any filing. A
-- difference refuses with PT409 and DETAIL form_changed_since_review (the
-- signing refusal's token: the meaning and the client handling are the
-- same); a malformed argument refuses with 22023. Because the existing check
-- then requires the current signature's content digest to equal the row's,
-- the signature filed is necessarily one over the reviewed content.
--
-- Null keeps the previous behaviour, so shipped app builds keep working;
-- one-argument callers resolve here through the default. The body is the
-- live definition from 20261028174500 with the block above added; the
-- lock_case_graph entry, guard, lock order, attachment waits, signature and
-- completeness checks, filing, points and grants are unchanged. The applied
-- migration 20260907151000 is not edited: its source pin names the old
-- function where that migration wraps it. submit_form is not on the
-- account-lifecycle trigger surface, so there is no review receipt to renew.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.submit_form(uuid)'::regprocedure)) <> '6a057bb0aff62d561768fae34b7deeee' then
    raise exception 'unreviewed predecessor: public.submit_form(uuid)' using errcode = '55000';
  end if;
end;
$preflight$;

drop function public.submit_form(uuid);

create function public.submit_form(p_form_id uuid, p_expected jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  rec record;
  signature record;
  missing text;
  v_key text;
  had_event boolean;
  actual integer;
  current_digest text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.lock_member_form(p_form_id);
  select id, user_id, status, template_key, template_version, answers, encrypted_content into rec
    from public.member_forms where id = p_form_id for update;
  if not found or rec.user_id <> caller then raise exception 'form not found' using errcode = '22023'; end if;
  if rec.status not in ('draft', 'returned') then raise exception 'form not submittable' using errcode = '22023'; end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and deletion_requested_at is not null) then
    raise exception 'wait for attachment deletion to finish' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and confirmed_at is null) then
    raise exception 'wait for every attachment upload to finish' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files ff
             where ff.form_id = p_form_id and ff.deletion_requested_at is null
               and not private.private_upload_is_current(ff.bucket_id, ff.object_name)) then
    raise exception 'wait for every attachment inspection to finish' using errcode = '22023';
  end if;
  -- What the submitter reviewed (#8705), in the shape sign_member_form takes:
  -- compared under the form lock before the signature check and before
  -- anything is filed, so the filed content, and the signature that must
  -- cover it, are the reviewed ones.
  if p_expected is not null then
    if pg_catalog.jsonb_typeof(p_expected) <> 'object'
       or (private.form_template_is_sealed(rec.template_key) and not (p_expected ? 'dataVersion'))
       or (not private.form_template_is_sealed(rec.template_key) and not (p_expected ? 'answers'))
       or pg_catalog.jsonb_typeof(p_expected->'attachmentIds') is distinct from 'array' then
      raise exception 'expected review must name the reviewed answers and attachments' using errcode = '22023';
    end if;
    if (private.form_template_is_sealed(rec.template_key)
          and (p_expected->>'dataVersion') is distinct from (rec.encrypted_content #>> '{answers,dataVersion}'))
       or (not private.form_template_is_sealed(rec.template_key)
          and (p_expected->'answers') is distinct from rec.answers)
       or ((
          select coalesce(pg_catalog.array_agg(distinct ff.id::text order by ff.id::text), '{}'::text[])
            from public.member_form_files ff
            where ff.form_id = p_form_id and ff.confirmed_at is not null
        ) is distinct from (
          select coalesce(pg_catalog.array_agg(distinct pg_catalog.lower(seen.id) order by pg_catalog.lower(seen.id)), '{}'::text[])
            from pg_catalog.jsonb_array_elements_text(p_expected->'attachmentIds') seen(id)
        )) then
      raise exception 'form changed since review' using errcode = 'PT409',
        detail = 'form_changed_since_review';
    end if;
  end if;
  current_digest := private.form_content_digest(p_form_id);
  select content_digest, signature_digest, strokes into signature
    from private.member_form_signatures
    where form_id = p_form_id and signer_kind = 'filer' and signer_user_id = caller;
  if signature.signature_digest is null
     or signature.content_digest <> current_digest
     or signature.signature_digest <> private.form_signature_digest(
       current_digest, caller, signature.strokes) then
    raise exception 'draw and save a current signature before submitting' using errcode = '22023';
  end if;
  select k into missing
  from pg_catalog.unnest(private.form_required_keys(rec.template_key, rec.template_version)) as k
  -- The server-written "filled" list answers the check only for a sealed
  -- template's enveloped row; elsewhere answers.sealed and answers.filled are
  -- ordinary answers and cannot stand in for required ones (#6363 round 1).
  where case when private.form_template_is_sealed(rec.template_key) and rec.encrypted_content ? 'answers'
      and rec.answers->>'sealed' = 'true' then not coalesce(rec.answers->'filled' ? k, false)
    when pg_catalog.jsonb_typeof(rec.answers -> k) = 'array'
    then pg_catalog.jsonb_array_length(rec.answers -> k) = 0
    else pg_catalog.btrim(coalesce(rec.answers ->> k, '')) = '' end limit 1;
  if missing is not null then
    raise exception 'form incomplete: %', missing using errcode = '22023';
  end if;
  update public.member_forms set status='submitted', submitted_at=now(),
    review_note=null, content_digest=current_digest, updated_at=now()
    where id=p_form_id and user_id=caller;
  v_key := 'form-' || p_form_id::text;
  had_event := exists (select 1 from public.member_point_events
                       where user_id = caller and action_key = v_key);
  insert into public.member_action_log (user_id, action_key, action_kind)
    values (caller, v_key, 'form') on conflict (user_id, action_key) do nothing;
  select points into actual from public.member_point_events
    where user_id = caller and action_key = v_key;
  return pg_catalog.jsonb_build_object('status', 'submitted',
    'awardedPoints', case when had_event then 0 else coalesce(actual, 0) end);
end;
end
$function$;

revoke all on function public.submit_form(uuid, jsonb) from public, anon;
grant execute on function public.submit_form(uuid, jsonb) to authenticated, service_role;

comment on function public.submit_form(uuid, jsonb) is 'Files a form. p_expected (optional) names the reviewed dataVersion (sealed) or answers (ordinary) and the confirmed attachment ids shown; a difference under the form lock refuses with PT409 form_changed_since_review and nothing is filed.';

notify pgrst, 'reload schema';
commit;
