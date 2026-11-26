-- SEC-UG-FORM-FILE-REMOVAL-REVEALS-ANOTHER-CHAPTERS-FILE-20261115 (#8809).
-- public.finalize_member_form_file_removal read a file's form id by file id
-- alone, before any scope check: an id that does not exist answered
-- {deleted: true}, while another member's live attachment went on to the
-- caller-scoped lookup and was refused "file unavailable", so the answer told
-- that the file exists. The first lookup is now the caller's own forms only:
-- any file id that is not the caller's answers exactly as a missing one,
-- without locking or reading the other member's form. The caller's own files
-- keep every existing check, and a retry after a completed removal still
-- answers {deleted: true}.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Preserve the reviewed predecessor: the 20260812222529 body as the
-- 20260907151000 case-graph wrapper left it.
do $guard$ begin
  if (select md5(prosrc) from pg_proc where oid='public.finalize_member_form_file_removal(uuid)'::regprocedure) is distinct from '9daaf37b0bf952097f0f4d7f9094a8b6' then
    raise exception 'unreviewed public.finalize_member_form_file_removal predecessor' using errcode='55000';
  end if;
end $guard$;

create or replace function public.finalize_member_form_file_removal(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  form_id uuid;
  rec public.member_form_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- #8809: only a file on one of the caller's own forms is looked up, so
  -- another member's attachment answers exactly as a missing id does.
  select ff.form_id into form_id from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.id = p_file_id and f.user_id = caller;
  if form_id is null then
    return pg_catalog.jsonb_build_object('deleted', true, 'id', p_file_id);
  end if;
  perform private.lock_member_form(form_id);
  select ff.* into rec from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.id = p_file_id and f.user_id = caller
      and f.status in ('draft', 'returned')
      and ff.deletion_requested_at is not null
      and ff.deletion_requested_by = caller for update of f, ff;
  if rec.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = rec.bucket_id and o.name = rec.object_name
  ) then
    raise exception 'attachment bytes still exist' using errcode = '22023';
  end if;
  delete from public.member_form_files where id = rec.id;
  return pg_catalog.jsonb_build_object('deleted', true, 'id', rec.id);
end;
end;
$function$;

comment on function public.finalize_member_form_file_removal(uuid) is
  'Finishes the caller''s own pending form attachment removal after the Storage API removed the bytes. Any file id that is not on one of the caller''s own forms answers as a missing one (#8809).';

notify pgrst,'reload schema';
commit;
