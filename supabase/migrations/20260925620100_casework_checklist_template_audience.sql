-- BUG-UG-CHECKLIST-TEMPLATE-WRITE-AUDIENCE-NOT-SUBSET-READ-AUDIENCE-CHAPTER-20260921
--
-- public.casework_checklist_templates stated its audience twice, and the two
-- statements disagreed:
--
--   * casework_checklist_templates_staff (the only SELECT policy, 20260828210000:710)
--       private.has_organization_role(organization_id, [steward,coordinator,advisor,admin,vp])
--   * public.casework_create_checklist_template (20260828210000:1169, wrapped
--     with the case-graph entry lock by 20260907151000)
--       private.member_has_chapter_role(p_chapter_id, [coordinator,advisor,admin,vp])
--
-- private.member_has_chapter_role also accepts a public.member_role_chapters
-- row; private.has_organization_role accepts only an organization role grant.
-- A chapter-hat coordinator with no organization grant therefore saved a
-- template (the routine is SECURITY DEFINER, so RLS never re-tested the
-- writer) and the next hub load selected zero rows.
--
-- WHICH WAY THE AUDIENCES ARE UNIFIED.
-- The record's acceptance fixes the direction: the chapter-hat coordinator who
-- creates a template sees it on the next hub load, and the organization
-- steward who cannot create is refused while keeping the reads they have. So
-- the write keeps its reviewed audience and the read gains exactly that
-- audience for the template's own chapter:
--
--   authorship  = the chapter write role on the template's chapter
--                 ([coordinator,advisor,admin,vp], chapter in the same organization)
--   read        = the organization staff role (unchanged)
--                 OR that same chapter write term
--
-- The write term is one disjunct of the read, so every author is a reader by
-- construction. The only reads added are templates of a chapter the caller can
-- already author templates for. Nobody loses a read or an authorship.
--
-- HOW IT IS STATED ONCE.
-- private.casework_checklist_template_audience(organization, chapter,
-- authorship) is the single predicate, shaped like private.casework_macro_audience
-- (20260918201000). The read policy calls it with authorship false and the
-- authoring routine with authorship true. The routine is re-emitted from its
-- installed definition (predecessor digest guarded), and only its role check
-- changes; the case-graph lock, MFA gate, validation, insert, audit row and
-- the 'chapter not found' refusal are unchanged.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.casework_create_checklist_template(text, text, text, text, jsonb)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '13377c297692e79dd462bcd10ef83d6440216a12af68b14060dde1e131f045a3' then
    raise exception 'unreviewed casework_create_checklist_template predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function private.casework_checklist_template_audience(
  p_organization_id uuid,
  p_chapter_id text,
  p_authorship boolean default false
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (
      private.has_organization_role(p_organization_id, array['steward','coordinator','advisor','admin','vp'])
      or audience.chapter_write
    )
    and (not coalesce(p_authorship, false) or audience.chapter_write)
  from (
    select p_organization_id is not null
      and p_chapter_id is not null
      and exists (
        select 1 from public.chapters c
        where c.id = p_chapter_id and c.organization_id = p_organization_id
      )
      and private.member_has_chapter_role(p_chapter_id, array['coordinator','advisor','admin','vp'])
      as chapter_write
  ) audience;
$function$;

revoke all on function private.casework_checklist_template_audience(uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function private.casework_checklist_template_audience(uuid, text, boolean) to authenticated;

comment on function private.casework_checklist_template_audience(uuid, text, boolean) is
  'The single casework_checklist_templates audience. Authorship true is the chapter write role (coordinator, advisor, admin or vp) on the template''s own chapter in its own organization. Authorship false is an organization staff role (steward, coordinator, advisor, admin or vp) OR that same chapter write term, so every author reads what they wrote by construction.';

alter policy casework_checklist_templates_staff on public.casework_checklist_templates
  using (private.casework_checklist_template_audience(organization_id, chapter_id, false));

comment on policy casework_checklist_templates_staff on public.casework_checklist_templates is
  'Delegates to private.casework_checklist_template_audience with authorship false: an organization staff role on the template''s organization, or the chapter write role on the template''s chapter. public.casework_create_checklist_template calls the same function with authorship true, so every accepted create is a row its author can select.';

create or replace function public.casework_create_checklist_template(
  p_chapter_id text, p_case_type text, p_step text, p_title text, p_items jsonb
)
returns public.casework_checklist_templates
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_org uuid; v_row public.casework_checklist_templates%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into strict v_org from public.chapters c where c.id = p_chapter_id;
  if not private.casework_checklist_template_audience(v_org, p_chapter_id, true) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' or pg_catalog.jsonb_array_length(p_items) not between 1 and 50
    or exists (select 1 from pg_catalog.jsonb_array_elements(p_items) item where pg_catalog.jsonb_typeof(item) <> 'object' or pg_catalog.char_length(pg_catalog.btrim(item->>'label')) not between 1 and 300)
  then raise exception 'invalid checklist items' using errcode = '22023'; end if;
  insert into public.casework_checklist_templates(organization_id, chapter_id, case_type, step, title, items, created_by)
  values (v_org, p_chapter_id, pg_catalog.btrim(p_case_type), pg_catalog.btrim(p_step), pg_catalog.btrim(p_title), p_items, (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_org, p_chapter_id, (select auth.uid()), 'checklist_created', 'checklist_template', v_row.id);
  return v_row;
end;
end;
$function$;

revoke all on function public.casework_create_checklist_template(text, text, text, text, jsonb) from public, anon;
grant execute on function public.casework_create_checklist_template(text, text, text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
