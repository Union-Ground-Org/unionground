-- BUG-UG-CASE-MACRO-WRITE-AUDIENCE-WIDER-THAN-READ-20260917
--
-- public.casework_macros shipped (20260917144000) with three separate
-- statements of one audience, and they disagreed:
--
--   * casework_macros_staff_read  -- private.has_organization_role(organization_id, [steward,coordinator,advisor,admin,vp])
--                                    AND (chapter_id is null OR private.member_has_chapter_role(chapter_id, [same five]))
--   * casework_list_macros()      -- the same two conjuncts, written out a second time
--   * casework_save_macro()       -- chapter branch: private.member_has_chapter_role(chapter, [coordinator,admin,vp]) ALONE
--
-- private.member_has_chapter_role is satisfied by private.has_organization_role
-- OR by a public.member_role_chapters row joined to an active
-- public.member_chapter_memberships row; private.has_organization_role requires
-- a public.organization_role_grants row and nothing else will do. A coordinator
-- whose hat comes from member_role_chapters alone therefore passed the write
-- branch and failed the read gate: the save was accepted, casework_list_macros()
-- returned [] and a direct select under casework_macros_staff_read returned 0
-- rows, so the author watched the macro they had just written disappear. The
-- migration's own comment asserted the opposite ("the write audience is a subset
-- of the read audience"), which is the part a later reader would have trusted.
--
-- WHICH WAY THE AUDIENCES ARE UNIFIED, AND WHY.
-- The record allows either direction. This migration narrows the WRITE to the
-- READ; it does not widen the read.
--   1. Widening the read would hand the macro library -- an organization's
--      configuration for writing case actions in bulk -- to actors the reviewed
--      read statement deliberately excludes. Nobody asked for that, and a
--      disclosure is not the smallest repair for an authorship bug.
--   2. The refused actor loses nothing they could ever have used. They could
--      not list, edit, deactivate or delete the macro they authored, and
--      public.casework_apply_macro already gates on
--      private.has_organization_role(..., [coordinator,admin,vp]) -- an
--      organization role grant -- so they could not apply it either. Narrowing
--      converts a silent stranded write into an honest 42501 at the moment of
--      authorship.
--   3. Narrowing keeps the reviewed read statement authoritative: after this
--      migration the sentence "the write audience is a subset of the read
--      audience" is true by construction rather than by assertion.
--
-- HOW IT IS STATED ONCE.
-- private.casework_macro_audience(p_organization_id, p_chapter_id, p_authorship)
-- is the single predicate. With p_authorship false it IS the read audience;
-- with p_authorship true it is that same expression conjoined with one further
-- scope-write term. Subset is therefore syntactic: the authorship branch cannot
-- admit an actor the read branch refuses, because it evaluates the read branch
-- first and ANDs onto it. Every consumer now calls this one function:
--
--   read   -- casework_macros_staff_read              -> (organization_id, chapter_id, false)
--          -- casework_list_macros()                  -> (v_org, null, false) as the cheap
--                                                        organization short-circuit, then
--                                                        (m.organization_id, m.chapter_id, false) per row
--   write  -- casework_save_macro()                   -> (v_org, v_chapter, true)
--          -- casework_macros_admin_insert/_update/_delete -> (organization_id, chapter_id, true)
--
-- The per-command write policy split (insert / update / delete rather than one
-- FOR ALL policy, which would add a second permissive SELECT policy and a
-- multiple_permissive_policies assurance finding) is preserved exactly: the
-- three policies keep their commands, their roles and their
-- created_by = auth.uid() authorship stamp, and only the audience expression
-- inside them is replaced, through ALTER POLICY rather than a drop/recreate.
-- private.member_has_chapter_role and private.has_organization_role are NOT
-- touched: they are correct for their own callers and shared repository-wide.
-- casework_macros.created_by keeps its ON DELETE SET NULL / 'pseudonymize'
-- disposition, which.3 (2026-09-17) settled as the accepted
-- product behaviour; nothing here retires, reassigns or blocks it.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The one audience. Shape mirrors the two helpers it composes: language sql,
-- stable, security definer, empty search_path, EXECUTE to authenticated only
-- (an RLS policy expression runs as the querying role, so the read policy
-- cannot call this without that grant).
create or replace function private.casework_macro_audience(
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
  select private.has_organization_role(p_organization_id, array['steward','coordinator','advisor','admin','vp'])
    and (p_chapter_id is null
      or private.member_has_chapter_role(p_chapter_id, array['steward','coordinator','advisor','admin','vp']))
    -- Authorship is the read audience plus one term, never an alternative to
    -- it. coalesce keeps a null argument on the reading side rather than
    -- letting it three-value its way past the conjunct.
    and (not coalesce(p_authorship, false)
      or case when p_chapter_id is null
           then private.has_organization_role(p_organization_id, array['admin','vp'])
           else private.member_has_chapter_role(p_chapter_id, array['coordinator','admin','vp'])
         end);
$function$;

revoke all on function private.casework_macro_audience(uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function private.casework_macro_audience(uuid, text, boolean) to authenticated;

comment on function private.casework_macro_audience(uuid, text, boolean) is
  'The single casework_macros audience. False authorship yields the read audience: staff of the owning organization, and for a chapter-scoped macro a staff role in that same chapter. True authorship yields that same expression conjoined with the scope write role, so the write audience is a subset of the read audience by construction rather than by comment.';

-- ---------------------------------------------------------------------------
-- The read policy, re-stated through the predicate
-- ---------------------------------------------------------------------------

alter policy casework_macros_staff_read on public.casework_macros
  using (private.casework_macro_audience(organization_id, chapter_id, false));

comment on policy casework_macros_staff_read on public.casework_macros is
  'Delegates to private.casework_macro_audience with authorship false: a reader must hold an organization staff role (steward, coordinator, advisor, admin or vp) granted on this macro''s organization, and a chapter-scoped macro additionally requires one of those roles in that same chapter. The write policies below call the same function with authorship true, which evaluates this expression and then adds the scope write role, so every writer is one of these readers.';

-- ---------------------------------------------------------------------------
-- The three write policies, re-stated through the same predicate
-- ---------------------------------------------------------------------------
--
-- Same split, same commands, same roles, same authorship stamp; only the
-- audience expression changes. Before this migration each carried a bare CASE
-- on member_has_chapter_role / has_organization_role, which admitted the
-- chapter-hat-only coordinator the read policy refuses.

alter policy casework_macros_admin_insert on public.casework_macros
  with check (
    created_by = (select auth.uid())
    and private.casework_macro_audience(organization_id, chapter_id, true)
  );

alter policy casework_macros_admin_update on public.casework_macros
  using (private.casework_macro_audience(organization_id, chapter_id, true))
  with check (
    created_by = (select auth.uid())
    and private.casework_macro_audience(organization_id, chapter_id, true)
  );

alter policy casework_macros_admin_delete on public.casework_macros
  using (private.casework_macro_audience(organization_id, chapter_id, true));

comment on policy casework_macros_admin_insert on public.casework_macros is
  'Authorship is private.casework_macro_audience with authorship true: the reader test for this macro''s scope, and then organization admin or vp for an organization-wide macro or chapter coordinator, admin or vp for a chapter macro. Each author is stamped as the macro''s creator.';
comment on policy casework_macros_admin_update on public.casework_macros is
  'Edits use the same authorship predicate as the insert policy on both sides, so an editor is always a reader of the row they edit, and an edit may not re-stamp the macro onto another member.';
comment on policy casework_macros_admin_delete on public.casework_macros is
  'Deletes use the same authorship predicate as the insert and update policies, so nobody may delete a macro they could not have read.';

-- ---------------------------------------------------------------------------
-- public.casework_save_macro -- the write side of the disagreement
-- ---------------------------------------------------------------------------
--
-- Re-emitted whole (create or replace, identical signature). The scope branches
-- now resolve only the organization; the single audience call decides who may
-- write. That is the narrowing: a member_role_chapters-only coordinator is
-- refused 42501 at authorship instead of being handed a macro they can never
-- see. The refusal carries HINT 'casework_macro_audience' so the client can
-- explain the decision in the author's own language instead of echoing an
-- untranslated server string.

create or replace function public.casework_save_macro(
  p_macro_id uuid,
  p_chapter_id text,
  p_name text,
  p_actions jsonb,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid;
  v_chapter text;
  v_name text;
  v_macro public.casework_macros%rowtype;
begin
  -- casework_macros carries a created_by reference into auth.users, so it is a
  -- case graph relation: the gate precedes the MFA read and the upsert.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  v_chapter := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  v_name := pg_catalog.btrim(coalesce(p_name, ''));
  perform private.casework_require_mfa();
  if pg_catalog.char_length(v_name) not between 2 and 120 then
    raise exception 'macro name must be 2-120 characters' using errcode = '22023';
  end if;
  if not private.casework_macro_actions_valid(p_actions) then
    raise exception 'macro actions are not a valid ordered action list' using errcode = '22023';
  end if;

  -- Scope decides the organization the macro belongs to. An organization-wide
  -- macro is owned by the caller's own selected staff organization; a chapter
  -- macro is owned by the chapter's organization.
  if v_chapter is null then
    v_org := (select private.current_mobile_staff_organization());
    if v_org is null then
      raise exception 'organization admin role required' using errcode = '42501';
    end if;
  else
    select c.organization_id into v_org from public.chapters c where c.id = v_chapter;
    if v_org is null then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  end if;

  -- One audience, one call. This is the same function casework_list_macros()
  -- and casework_macros_staff_read evaluate, with the authorship term added,
  -- so a save that succeeds here is a row this caller can list and re-open.
  if not private.casework_macro_audience(v_org, v_chapter, true) then
    raise exception 'macro authorship requires the scope write role and the staff role that reads the macro'
      using errcode = '42501', hint = 'casework_macro_audience';
  end if;

  if p_macro_id is null then
    insert into public.casework_macros(organization_id, chapter_id, name, actions, active, created_by)
    values (v_org, v_chapter, v_name, p_actions, coalesce(p_active, true), (select auth.uid()))
    returning * into v_macro;
  else
    select * into v_macro from public.casework_macros where id = p_macro_id for update;
    if v_macro.id is null then raise exception 'macro not found' using errcode = 'P0002'; end if;
    -- Re-scoping a macro would move it past the role check that created it.
    if v_macro.organization_id <> v_org or v_macro.chapter_id is distinct from v_chapter then
      raise exception 'macro scope cannot change' using errcode = '42501';
    end if;
    update public.casework_macros
      set name = v_name, actions = p_actions,
          active = coalesce(p_active, v_macro.active), updated_at = pg_catalog.now()
      where id = v_macro.id
      returning * into v_macro;
  end if;

  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_macro.organization_id, v_macro.chapter_id, null, (select auth.uid()),
    'macro_saved', 'macro', v_macro.id,
    pg_catalog.jsonb_build_object(
      'actionCount', pg_catalog.jsonb_array_length(v_macro.actions), 'active', v_macro.active));

  return pg_catalog.jsonb_build_object(
    'id', v_macro.id, 'name', v_macro.name, 'chapterId', v_macro.chapter_id,
    'actions', v_macro.actions, 'active', v_macro.active, 'updatedAt', v_macro.updated_at);
end;
$function$;

revoke all on function public.casework_save_macro(uuid, text, text, jsonb, boolean) from public, anon;
grant execute on function public.casework_save_macro(uuid, text, text, jsonb, boolean) to authenticated;

comment on function public.casework_save_macro(uuid, text, text, jsonb, boolean) is
  'Organization or chapter scoped macro upsert. Authorship is private.casework_macro_audience(..., true), the same predicate casework_macros_staff_read and casework_list_macros() evaluate with authorship false, so an accepted save is always a row the saving caller can read back.';

-- ---------------------------------------------------------------------------
-- public.casework_list_macros -- the read side of the disagreement
-- ---------------------------------------------------------------------------
--
-- The organization gate and the per-row chapter filter were two hand-written
-- halves of the read policy. Both are now the predicate: (v_org, null, false)
-- is exactly the policy's leading conjunct and keeps the cheap short-circuit
-- for a non-staff caller, and the row filter is the whole policy expression.

create or replace function public.casework_list_macros()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  v_org uuid;
begin
  perform private.casework_require_mfa();
  v_org := (select private.current_mobile_staff_organization());
  if v_org is null or not private.casework_macro_audience(v_org, null, false) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', m.id, 'name', m.name, 'chapterId', m.chapter_id,
      'actions', m.actions, 'active', m.active, 'updatedAt', m.updated_at
    ) order by m.name, m.id)
    from public.casework_macros m
    where m.organization_id = v_org
      and private.casework_macro_audience(m.organization_id, m.chapter_id, false)
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.casework_list_macros() from public, anon;
grant execute on function public.casework_list_macros() to authenticated;

comment on function public.casework_list_macros() is
  'Macro catalogue for the caller''s own organization. Both its organization gate and its per-row chapter filter are private.casework_macro_audience with authorship false, the identical expression casework_macros_staff_read evaluates, so the RPC and a direct table select return the same rows to the same caller.';

notify pgrst, 'reload schema';

commit;
