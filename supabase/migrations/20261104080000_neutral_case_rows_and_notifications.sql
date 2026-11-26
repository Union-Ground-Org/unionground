-- REQ-UG-NEUTRAL-NOTIFICATION-AND-CASE-ROWS-SERVER-COPY-20261104 (#7015):
-- the Lovable audit (Oct 18-19, top issue 3) found case topics and free text
-- in list rows and previews. The native audit fixes (#6996, #7001) could only
-- hide what the server sent, so the rows are made neutral where they are
-- composed.
--
-- A case list row and a case search hit now carry a neutral line,
-- private.case_row_line(case_type, step) ("Discipline · Step 2"), in the
-- column or key that used to hold member_cases.title, beside the reference,
-- status, step and due date they already had. Installed native builds keep
-- reading the same key and show the neutral line. The topic, the description
-- and note text stay in the record read (public.member_cases and its child
-- tables under the case read policy, unchanged here):
--   - list_unassigned_chapter_cases, list_share_case_destinations,
--     list_steward_case_deadlines, casework_list_ulp_deadlines and
--     list_vp_case_reviews replace the topic with the neutral line. The jsonb
--     rows also gain caseType and step so the web app can say the line in
--     Spanish. The case's own deadline row is labelled 'Case deadline'
--     instead of repeating the topic.
--   - search_member_cases keeps matching on everything it matched before, but
--     a hit returns the neutral line, no articles and no headline snippet
--     (headline_source still says which field matched). Its search body moves
--     unchanged to private.search_member_cases, with no client grant, and the
--     public function returns that body's rows with the neutral columns. Any
--     earlier migration that redefines the public search body (the open
--     learning-period PR #7000, 20261104030000) is moved the same way.
-- Member names are kept on staff rows (list_unassigned_chapter_cases'
-- memberName): only the topic is dropped, pending the owner's answer to
-- question 4 (Nov 4, 2026).
--
-- Notifications: every case notification already comes from the
-- private.notification_copy catalogue or names only the reference and form
-- type. The two that still carried free text are approve_form and return_form,
-- which put the steward's review note in the body; the body now says where to
-- read it (member_forms.review_note, unchanged). Notifications already stored
-- are not rewritten.
--
-- Hosted application: SAMPLE first, then production; needs its own owner
-- authorization.

begin;
set local lock_timeout = '5s';

create function private.case_row_line(p_case_type text, p_step text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select coalesce(nullif(pg_catalog.btrim(p_case_type), ''), 'Case')
    || coalesce(' · ' || nullif(pg_catalog.btrim(p_step), ''), '');
$function$;

revoke all on function private.case_row_line(text, text) from public, anon, authenticated, service_role;

comment on function private.case_row_line(text, text) is
  'Neutral case row line (type and step) used by case list and search RPCs in place of the case topic (#7015).';

create or replace function public.list_unassigned_chapter_cases()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', open_case.id,
      'reference', open_case.reference,
      'title', private.case_row_line(open_case.case_type, open_case.step),
      'caseType', open_case.case_type,
      'step', open_case.step,
      'deadline', open_case.deadline,
      'filingStatus', open_case.filing_status,
      'createdAt', open_case.created_at,
      'memberName', open_case.full_name
    ) order by open_case.deadline nulls last, open_case.created_at, open_case.id)
    from (
      select c.id, c.reference, c.case_type, c.step, c.deadline,
             c.filing_status, c.created_at, p.full_name
      from public.member_cases c
      join public.member_profiles p on p.id = c.user_id
      where c.status = 'active'
        and c.steward_user_id is null
        and not c.is_restricted
        and c.user_id <> caller
        and private.chapter_case_readable(c)
        and c.organization_id = (select private.current_member_organization())
        and (private.has_organization_role(c.organization_id, array['steward'])
             or private.member_has_chapter_role(c.chapter_id, array['steward'])
             or private.chapter_scoped_role_allows(c.chapter_id,'steward',c.user_id,true))
        and private.chapter_case_intake_role_allows(c.user_id, 'steward')
      order by c.deadline nulls last, c.created_at, c.id
      limit 50
    ) open_case
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.list_share_case_destinations(p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, user_id uuid, reference text, title text, status text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();
declare
  v_actor uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit,100),1),100);
begin
  if v_actor is null then return; end if;
  return query
  with actor_scope as materialized (
    select
      -- mfa_assurance, the RESTRICTIVE policy both case tables carry. It ANDs
      -- over every permissive branch, so it gates the whole `visible` CTE.
      (select private.mfa_satisfied()) as mfa_satisfied,
      -- member_cases_select_steward's second conjunct.
      public.member_has_role(array['steward']) as steward_hat,
      -- public.staff_can_see_user(user_id, 'coordinator') as a set of chapters.
      array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters,
      -- private.has_organization_role(organization_id, array['advisor','admin','vp'])
      -- is false unless organization_id is this organization, so the grant test
      -- is a constant and the per-row test is a column comparison.
      (select private.current_mobile_staff_organization()) as staff_organization,
      coalesce((select private.has_organization_role(
        (select private.current_mobile_staff_organization()),
        array['advisor','admin','vp'])), false) as organization_officer,
      -- private.casework_actor_has_active_grant(id), as the set it tests.
      array(
        select g.case_id
        from public.casework_access_grants g
        where g.grantee_user_id = v_actor
          and g.revoked_at is null
      ) as granted_cases
  ),
  staff_visible as (
    select c.id
    from public.member_profiles case_owner
    join (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c on c.user_id = case_owner.id
    where (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
      and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
      and (
        not c.is_restricted or c.coordinator_user_id = v_actor
        or (c.organization_id is not null
          and c.organization_id = (select s.staff_organization from actor_scope s)
          and (select s.organization_officer from actor_scope s))
        or c.id = any((select s.granted_cases from actor_scope s)::uuid[])
      )
  ), visible_ids as (
    select c.id from (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c where private.chapter_case_readable(c)
    union
    select c.id from (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c where c.user_id = v_actor
    union
    select c.id from (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c
      where c.steward_user_id = v_actor and (select s.steward_hat from actor_scope s)
    union
    select s.id from staff_visible s
  )
  select c.id, c.user_id, c.reference, private.case_row_line(c.case_type, c.step), c.status, c.updated_at
  from visible_ids v join (select access_row.* from public.member_cases access_row where (private.chapter_case_readable(access_row))) c on c.id = v.id
  where (select s.mfa_satisfied from actor_scope s)
  order by c.updated_at desc, c.id
  limit v_limit;
end;
end;
$function$;

create or replace function public.list_steward_case_deadlines()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_build_object(
      'truncated', pg_catalog.count(*) > 100,
      'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'caseId', due.case_id, 'reference', due.reference,
      'title', private.case_row_line(due.case_type, due.step), 'caseType', due.case_type, 'step', due.step,
      'kind', due.kind, 'label', due.label, 'dueOn', due.due_on,
      'overdue', due.overdue,
      'afterStepDue', due.after_step_due
    ) order by due.due_on, due.reference, due.kind) filter (where due.position <= 100), '[]'::jsonb))
    from (
      select merged.*, pg_catalog.row_number() over (order by merged.due_on, merged.reference, merged.kind) as position
      from (
        -- A clock is overdue once its moment has passed or the sweep has
        -- marked it missed (20261002143000), whatever the calendar day.
        select c.id as case_id, c.reference, c.case_type, c.step, d.kind, d.label,
               (d.due_at at time zone 'America/New_York')::date as due_on,
               (d.due_at < pg_catalog.now() or d.status = 'missed') as overdue,
               false as after_step_due
        from public.member_cases c
        join public.casework_deadlines d on d.case_id = c.id and d.status in ('active', 'extended', 'missed')
        where c.steward_user_id = caller and c.status = 'active'
          and private.casework_staff_can_access(c.id)
        union all
        -- The case's own deadline is a date: overdue from the next Eastern day.
        select c.id, c.reference, c.case_type, c.step, 'case', 'Case deadline', c.deadline,
               c.deadline < (pg_catalog.now() at time zone 'America/New_York')::date,
               exists (
                 select 1 from public.casework_deadlines step
                 where step.case_id = c.id and step.status in ('active', 'extended', 'missed') and step.kind = 'procedure'
                   and (step.due_at at time zone 'America/New_York')::date < c.deadline)
        from public.member_cases c
        where c.steward_user_id = caller and c.status = 'active' and c.deadline is not null
          and private.casework_staff_can_access(c.id)
      ) merged
      order by merged.due_on, merged.reference, merged.kind
      limit 101
    ) due
  ), pg_catalog.jsonb_build_object('truncated', false, 'rows', '[]'::jsonb));
end;
$function$;

create or replace function public.casework_list_ulp_deadlines(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  perform private.casework_require_mfa();
  return coalesce((
    select pg_catalog.jsonb_agg(row_data order by deadline, flag_id)
    from (
      select case when f.safety_deadline >= current_date and f.safety_deadline < f.ulp_deadline
          then f.safety_deadline else f.ulp_deadline end as deadline,
        f.id as flag_id,
        pg_catalog.jsonb_build_object(
          'flagId', f.id,
          'caseId', c.id,
          'reference', c.reference,
          'title', private.case_row_line(c.case_type, c.step),
          'caseType', c.case_type,
          'step', c.step,
          'source', f.source,
          'status', f.status,
          'incidentOn', f.incident_on,
          'ulpDeadline', f.ulp_deadline,
          'daysLeft', f.ulp_deadline - current_date,
          'warningDays', t.warning_days,
          'criticalDays', t.critical_days,
          'protectedActivityCategory', f.protected_activity_category,
          'safetyDeadline', f.safety_deadline,
          'safetyRoute', private.casework_safety_retaliation_route(f.organization_id)) as row_data
      from public.casework_retaliation_flags f
      join public.member_cases c on c.id = f.case_id
      cross join lateral private.casework_ulp_thresholds(f.organization_id) t
      where f.status in ('open', 'confirmed')
        and f.organization_id = org
        and private.casework_staff_can_read(f.case_id)
        and private.organization_feature_enabled(f.organization_id, 'features.casework.ulp_deadline')
      order by case when f.safety_deadline >= current_date and f.safety_deadline < f.ulp_deadline
          then f.safety_deadline else f.ulp_deadline end, f.id
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) rows
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.list_vp_case_reviews()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  payload jsonb;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role with MFA required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller
    and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  order by r.chapter_id
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'caseId', v.case_id,
    'reviewedAt', v.reviewed_at,
    'reviewedBy', v.reviewed_by,
    'reviewerName', p.full_name,
    'caseReference', c.reference,
    'caseTitle', private.case_row_line(c.case_type, c.step),
    'caseType', c.case_type,
    'caseStep', c.step
  ) order by v.reviewed_at desc), '[]'::jsonb)
  into payload
  from public.member_vp_case_reviews v
  join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p on p.id = v.reviewed_by
  join (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c on c.id = v.case_id
  where v.chapter_id = caller_chapter;

  return payload;
end;
$function$;

create or replace function public.approve_form(p_form_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  rec record;
  signature record;
  current_digest text;
  approved_time timestamptz := now();
  frozen_digest text;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_note is not null and (pg_catalog.char_length(clean_note) > 4000
      or pg_catalog.regexp_replace(clean_note,
        '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]') then
    raise exception 'note is invalid' using errcode = '22023';
  end if;
  perform private.lock_member_form(p_form_id);
  select f.id, f.user_id, f.status, f.template_key, f.template_version,
         coalesce(p.language, 'en') as lang into rec
    from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and deletion_requested_at is not null) then
    raise exception 'form has a pending attachment deletion' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and confirmed_at is null) then
    raise exception 'form has an unfinished attachment' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files ff
             where ff.form_id = p_form_id and ff.deletion_requested_at is null
               and not private.private_upload_is_current(ff.bucket_id, ff.object_name)) then
    raise exception 'form has an attachment without a current inspection' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  select content_digest, signature_digest, strokes into signature
    from private.member_form_signatures
    where form_id = p_form_id and signer_kind = 'filer' and signer_user_id = rec.user_id;
  if signature.signature_digest is null
     or signature.content_digest <> current_digest
     or signature.signature_digest <> private.form_signature_digest(
       current_digest, rec.user_id, signature.strokes) then
    raise exception 'form does not have a current filer signature' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.member_form_cosigners c
    where c.form_id = p_form_id and c.status = 'accepted'
      and (c.signature_digest is null or not exists (
        select 1 from private.member_form_signatures s
        where s.cosigner_id = c.id and s.signer_kind = 'cosigner'
          and s.content_digest = current_digest
          and s.signature_digest = c.signature_digest
          and s.signature_digest = private.form_signature_digest(
            current_digest, c.id, s.strokes)
      ))
  ) then
    raise exception 'form has an invalid co-signature' using errcode = '22023';
  end if;
  frozen_digest := private.form_artifact_digest(
    p_form_id, current_digest, signature.signature_digest,
    clean_note, caller, approved_time);
  update public.member_forms set
    status = 'approved', review_note = clean_note, reviewed_by = caller,
    reviewed_at = approved_time, content_digest = current_digest,
    artifact_digest = frozen_digest, artifact_approved_at = approved_time,
    artifact_approved_by = caller, updated_at = approved_time
  where id = p_form_id and private.member_form_case_readable(p_form_id);
  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Formulario aprobado',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang)
        || ' — revisado y aprobado por tu delegado. Ya puedes descargar tu copia oficial de Union Base.'
        || case when clean_note is not null then ' Abre Formularios para leer la nota de tu delegado.' else '' end, 'forms');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Form approved',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang)
        || ' — reviewed and approved by your steward. Your Union Base official filing copy is ready to download.'
        || case when clean_note is not null then ' Open Forms to read your steward''s note.' else '' end, 'forms');
  end if;
  return pg_catalog.jsonb_build_object(
    'formId', p_form_id, 'status', 'approved',
    'artifactDigest', frozen_digest, 'approvedAt', approved_time);
end;
end;
$function$;

create or replace function public.return_form(p_form_id uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  rec record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_note = '' or pg_catalog.char_length(clean_note) > 4000 then
    raise exception 'return note must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if pg_catalog.regexp_replace(clean_note, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'note contains unsupported control characters' using errcode = '22023';
  end if;

  select f.id, f.user_id, f.status, f.template_key, f.template_version, coalesce(p.language, 'en') as lang into rec
    from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f
    left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;

  -- the one-active-per-template partial index covers draft+returned: if the
  -- member started a NEW draft of this template after submitting this row,
  -- flipping it to returned would collide. Surface a clean error instead of a
  -- unique_violation 500 — the steward can approve, or the member finishes
  -- the newer draft first.
  begin
    update public.member_forms
      set status = 'returned', review_note = clean_note, reviewed_by = caller, reviewed_at = now(), updated_at = now()
      where id = p_form_id and private.member_form_case_readable(p_form_id);
  exception when unique_violation then
    raise exception 'member already has an active draft of this template; approve instead or ask them to finish it' using errcode = '23505';
  end;

  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Formulario devuelto',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — devuelto por tu delegado para cambios. Abre Formularios para leer su nota.', 'forms');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Form returned',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — returned by your steward for changes. Open Forms to read the note.', 'forms');
  end if;

  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'returned');
end;
end;
$function$;

alter function public.search_member_cases(text, integer) set schema private;

revoke all on function private.search_member_cases(text, integer) from public, anon, authenticated, service_role;

comment on function private.search_member_cases(text, integer) is
  'Full-text case search body, unchanged and callable only through public.search_member_cases, which returns its hits with the neutral row line (#7015).';

create function public.search_member_cases(p_query text, p_limit integer default 20)
returns table(case_id uuid, reference text, title text, case_type text, articles text, step text, status text, deadline date, updated_at timestamp with time zone, rank real, headline text, headline_source text)
language sql
stable
security definer
set search_path = ''
as $function$
  select hit.case_id, hit.reference, private.case_row_line(hit.case_type, hit.step),
         hit.case_type, null::text, hit.step, hit.status, hit.deadline, hit.updated_at,
         hit.rank, null::text, hit.headline_source
  from private.search_member_cases(p_query, p_limit) with ordinality
    as hit(case_id, reference, title, case_type, articles, step, status, deadline, updated_at, rank, headline, headline_source, position)
  -- The search body already returns nothing without step-up; the wrapper
  -- states the same gate so the definer MFA sweep can see it.
  where (select private.mfa_satisfied())
  order by hit.position;
$function$;

revoke all on function public.search_member_cases(text, integer) from public, anon, service_role;
grant execute on function public.search_member_cases(text, integer) to authenticated;

comment on function public.search_member_cases(text, integer) is
  'Case search hits for the caller: reference, neutral type and step line, status, step, due date, rank and which field matched. The topic, articles and matched text stay in the case record (#7015).';

commit;
