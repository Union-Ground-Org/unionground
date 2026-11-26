-- BUG-UG-ORDINARY-FORM-SAVES-HAVE-NO-PER-WRITE-REVISION-20261118 (#9092).
-- An ordinary form draft gets a number that names one write.
--
-- save_form_draft returns only the form id and the forms load returns
-- answers; updated_at is the transaction start and is never returned. So the
-- website could only compare answers, and equal answers cannot order two
-- writes: "A loaded before B landed" and "A saved back after B" look the same
-- (PR #8949, record #8935, gate rounds 3 to 12). A sealed form's dataVersion
-- names one write; ordinary forms now have the same.
--
-- 1. public.member_forms.revision bigint not null default 1. A BEFORE INSERT
--    OR UPDATE trigger owns it: 1 on insert; old + 1 when the answers change;
--    otherwise unchanged (step, status, signature, review and case-link
--    updates). It runs under the row lock, so the number only goes up, two
--    writes never share one, and no caller can set it.
-- 2. public.save_member_form_draft(p_template_key, p_answers, p_step,
--    p_expected_form_id, p_base_revision) returns {formId, revision}. Under
--    the template lock and the form lock (the named form, or the caller's
--    newest open form of the template, locked and re-read) it refuses PT409
--    form_saved_elsewhere, writing nothing, unless the stored revision equals
--    p_base_revision. 0 names "no open draft yet": a first save. It then
--    saves through save_form_draft on the form it compared (no base answers),
--    so the guard, the sealed refusal, the template checks, the signature
--    reset and the co-signer reaffirm stay in one place.
-- 3. public.save_unit_member_form_draft: the same through the unit work
--    context, as save_unit_form_draft does for save_form_draft.
--
-- save_form_draft and save_unit_form_draft are not changed: the phone app and
-- outbox saves queued before the website change keep their answers check.
-- The migration reaches the database before the website deploy that reads
-- revision. Applied migrations are not edited.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  -- The save this one delegates to: the live definition from 20261113134400.
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.save_form_draft(text,jsonb,integer,uuid,jsonb)'::regprocedure)) <> '676990840ef522a137d96c250523c5cc' then
    raise exception 'unreviewed predecessor: public.save_form_draft(text,jsonb,integer,uuid,jsonb)' using errcode = '55000';
  end if;
end;
$preflight$;

alter table public.member_forms add column revision bigint not null default 1;
comment on column public.member_forms.revision is 'Names one write of the answers: 1 on insert, one more each time the answers change, set only by the member_forms_revision trigger. save_member_form_draft refuses a save based on any other revision.';

create function private.member_form_revision()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
  elsif new.answers is distinct from old.answers then
    new.revision := old.revision + 1;
  else
    new.revision := old.revision;
  end if;
  return new;
end;
$function$;
revoke all on function private.member_form_revision() from public, anon, authenticated, service_role;

create trigger member_forms_revision
  before insert or update on public.member_forms
  for each row execute function private.member_form_revision();

CREATE FUNCTION public.save_member_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_expected_form_id uuid, p_base_revision bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean jsonb := coalesce(p_answers, '{}'::jsonb);
  existing uuid;
  stored bigint;
  saved uuid;
  saved_revision bigint;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if private.form_template_is_sealed(p_template_key) then
    raise exception 'sealed form templates save through the sensitive content API' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(clean) <> 'object' or pg_catalog.length(clean::text) > 20000 then
    raise exception 'answers too large' using errcode = '22023';
  end if;
  if p_base_revision is null or p_base_revision < 0 then
    raise exception 'base revision required' using errcode = '22023';
  end if;
  -- Every form starts at revision 1, so a revision means something only for
  -- the form it was read from: a base that names a write must name its form.
  -- Unnamed, a late save would match a replacement draft at the same number.
  if p_base_revision > 0 and p_expected_form_id is null then
    raise exception 'form required with a base revision' using errcode = '22023';
  end if;

  -- The template lock save_form_draft takes, then the form lock that
  -- submit_form and sign_member_form take; both are re-entered below.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-form-' || caller::text || '-' || p_template_key, 509));
  if p_expected_form_id is not null then
    perform private.lock_member_form(p_expected_form_id);
    select f.id, f.revision into existing, stored from public.member_forms f
      where f.id = p_expected_form_id and f.user_id = caller and f.template_key = p_template_key
        and f.status in ('draft', 'returned')
      for update;
    if existing is null then
      raise exception 'form no longer editable' using errcode = 'PT409', detail = 'form_not_editable';
    end if;
  else
    -- Base 0: the caller knows no open draft; one that exists refuses below.
    select f.id into existing from public.member_forms f
      where f.user_id = caller and f.template_key = p_template_key and f.status in ('draft', 'returned')
      order by f.updated_at desc limit 1;
    if existing is not null then
      perform private.lock_member_form(existing);
      select f.revision into stored from public.member_forms f
        where f.id = existing and f.status in ('draft', 'returned')
        for update;
      if not found then
        existing := null;
      end if;
    end if;
  end if;
  -- The write this save was based on: any other stored revision (another
  -- session saved, or a draft now exists where the caller knew none) refuses,
  -- and nothing is written.
  if coalesce(stored, 0) <> p_base_revision then
    raise exception 'form changed elsewhere' using errcode = 'PT409', detail = 'form_saved_elsewhere';
  end if;

  saved := public.save_form_draft(p_template_key, clean, p_step, existing, null::jsonb);
  select f.revision into saved_revision from public.member_forms f where f.id = saved;
  return pg_catalog.jsonb_build_object('formId', saved, 'revision', saved_revision);
end;
end;
$function$;

revoke all on function public.save_member_form_draft(text, jsonb, integer, uuid, bigint) from public, anon;
grant execute on function public.save_member_form_draft(text, jsonb, integer, uuid, bigint) to authenticated, service_role;

comment on function public.save_member_form_draft(text, jsonb, integer, uuid, bigint) is 'Ordinary form save based on one write. p_expected_form_id must still be the caller''s open form of the template, else PT409 form_not_editable, and is required (22023) whenever p_base_revision is above 0; p_base_revision (0, with no form named, when the caller knows no open draft) must equal the stored revision, else PT409 form_saved_elsewhere and nothing is written. Returns {formId, revision}.';

create function public.save_unit_member_form_draft(p_template_key text,p_answers jsonb,p_step integer,p_unit uuid,p_actor uuid,p_chapter text,p_organization uuid,p_expected_form_id uuid,p_base_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; previous text;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  previous:=current_setting('unionground.settings_unit',true);
  perform private.require_unit_workflow_context(p_actor,p_chapter,p_organization);
  perform private.resolve_settings_unit(private.current_member_chapter(),p_unit);
  perform set_config('unionground.settings_unit',coalesce(p_unit::text,''),true);
  result:=public.save_member_form_draft(p_template_key,p_answers,p_step,p_expected_form_id,p_base_revision);
  perform set_config('unionground.settings_unit',coalesce(previous,''),true);
  return result;
end;
$$;
revoke all on function public.save_unit_member_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.save_unit_member_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,bigint) to authenticated;

-- The new trigger and its function are on the account lifecycle trigger
-- surface; record exactly those two rows, then prove the inventory matches.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select s.kind,s.schema_name,s.table_name,s.object_name,s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind='trigger' and s.schema_name='public' and s.table_name='member_forms' and s.object_name='member_forms_revision')
  or (s.kind='function' and s.schema_name='private' and s.object_name='member_form_revision()')
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;

do $inventory$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review';
  end if;
end;
$inventory$;

notify pgrst, 'reload schema';
commit;
