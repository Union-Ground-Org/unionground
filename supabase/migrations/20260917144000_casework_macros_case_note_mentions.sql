-- REQ-UG-CASEWORK-CONSOLE-56-MACROS-BULK-MENTIONS-20260917
--
-- Two additions to the MI1 casework suite.
--
-- 1. Organization-defined case macros. A macro is an ordered list of actions a
--    coordinator already performs one case at a time. Applying one never
--    touches public.member_cases directly: every action runs through the
--    existing audited routine for that action (casework_advance_step,
--    casework_bulk_update_cases, assign_member_case, coordinator_add_case_note,
--    and the RLS-guarded casework_alerts insert), so each action keeps the
--    evidence, the optimistic-concurrency guard and the notification it has
--    when a human performs it by hand. On top of that, apply writes one
--    casework_audit_events row per action per case, keyed by a per-action
--    operation id derived from the batch key, which is also the replay guard.
--
-- 2. @mentions on case notes. member_case_updates gains a bounded mentioned
--    user list. Mentions resolve only to the stewards and coordinators of the
--    case's own chapter -- the same audience the assignment screen offers --
--    and each mentioned member is notified through private.notify_member, so
--    no notification literal enters a definer body and Spanish ships with
--    English. The member's own direct-insert path is narrowed to an empty
--    mention list: a mention is authored through the audited routine or not
--    at all.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- casework_audit_events.event_type is a closed enumeration. Macro and note
-- evidence needs five more members; every existing value is preserved.
alter table public.casework_audit_events
  drop constraint casework_audit_events_event_type_check;
alter table public.casework_audit_events
  add constraint casework_audit_events_event_type_check check (event_type in (
    'strength_scored','deadline_requested','deadline_decided','checklist_created','checklist_item_changed',
    'step_advanced','restriction_changed','access_granted','access_revoked',
    'alert_created','alert_acknowledged','alert_escalated','behavior_logged',
    'retaliation_submitted','retaliation_withdrawn','pattern_detected',
    'draft_saved','bulk_updated','entity_linked','reminder_changed',
    'bargaining_changed','behavior_addendum_added','pattern_reviewed',
    'macro_saved','macro_applied','note_added','note_mentioned','case_assigned'
  ));

-- The shape of a macro's action list, as one immutable predicate so the table
-- itself refuses a malformed macro. A CHECK cannot contain a subquery, so the
-- per-element walk lives here instead of inline. Each branch mirrors the bound
-- the downstream routine enforces: casework_step_transitions.outcome is
-- 3..1000 characters, member_case_updates.body is 1..4000, casework_alerts
-- carries its own kind/severity/message domains.
create or replace function private.casework_macro_actions_valid(p_actions jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_typeof(p_actions) = 'array'
    and pg_catalog.jsonb_array_length(p_actions) between 1 and 10
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_actions) as entry(action)
      where pg_catalog.jsonb_typeof(entry.action) <> 'object'
        or coalesce(entry.action->>'kind', '') not in ('advance_step','set_status','assign','add_note','add_alert')
        or (entry.action->>'kind' = 'advance_step' and (
              pg_catalog.char_length(pg_catalog.btrim(coalesce(entry.action->>'step', ''))) not between 2 and 100
              or pg_catalog.char_length(pg_catalog.btrim(coalesce(entry.action->>'outcome', ''))) not between 3 and 1000))
        or (entry.action->>'kind' = 'set_status'
              and coalesce(entry.action->>'status', '') not in ('active','resolved'))
        or (entry.action->>'kind' = 'assign'
              and entry.action->>'stewardId' is null and entry.action->>'coordinatorId' is null)
        or (entry.action->>'kind' = 'add_note'
              and pg_catalog.char_length(pg_catalog.btrim(coalesce(entry.action->>'body', ''))) not between 1 and 4000)
        or (entry.action->>'kind' = 'add_alert' and (
              coalesce(entry.action->>'alertKind', '') not in ('deadline','safety','retaliation','legal','stalled','custom')
              or coalesce(entry.action->>'severity', '') not in ('info','warning','critical')
              or pg_catalog.char_length(pg_catalog.btrim(coalesce(entry.action->>'message', ''))) not between 3 and 1000))
    );
$function$;

revoke all on function private.casework_macro_actions_valid(jsonb) from public, anon;
-- Unlike the other private helpers this one backs a CHECK constraint that is
-- evaluated in the inserting session, so authenticated keeps EXECUTE. It reads
-- no table and discloses nothing beyond the argument it was handed.
grant execute on function private.casework_macro_actions_valid(jsonb) to authenticated;

create table public.casework_macros (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  name text not null check (pg_catalog.char_length(pg_catalog.btrim(name)) between 2 and 120),
  actions jsonb not null,
  active boolean not null default true,
  -- ON DELETE SET NULL, reviewed as 'pseudonymize' in
  -- private.account_lifecycle_manifest at the end of this migration. A macro is
  -- organization-owned configuration, so it outlives the administrator who
  -- authored it: RESTRICT would block that administrator's account deletion
  -- (BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION-20260831), and CASCADE would
  -- delete an organization's whole macro library the moment one admin closes
  -- their account. This is exactly the disposition every other casework
  -- attribution column carries -- casework_checklist_templates.created_by,
  -- casework_alerts.created_by, casework_deadlines.created_by -- and the
  -- column is read for attribution only, never for authorization.
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint casework_macros_actions_shaped check (private.casework_macro_actions_valid(actions)),
  constraint casework_macros_actions_bounded check (pg_catalog.pg_column_size(actions) <= 8192),
  unique (id, organization_id)
);

-- One macro name per scope. A chapter macro and an organization macro may
-- share a name; two chapter macros in the same chapter may not.
create unique index casework_macros_scope_name_idx
  on public.casework_macros (organization_id, coalesce(chapter_id, ''), pg_catalog.lower(pg_catalog.btrim(name)));
create index casework_macros_scope_idx
  on public.casework_macros (organization_id, chapter_id, active, updated_at desc);

alter table public.casework_macros enable row level security;

create policy casework_macros_staff_read on public.casework_macros
  for select to authenticated using (
    private.has_organization_role(organization_id, array['steward','coordinator','advisor','admin','vp'])
    and (chapter_id is null
      or private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp']))
  );

-- The write admission is stated once per command rather than as one FOR ALL
-- policy. A FOR ALL policy is also permissive for SELECT, which would put two
-- permissive policies on the same table/role/action and add a
-- multiple_permissive_policies finding to the database assurance scan. The
-- admitted set is unchanged: the write audience is a subset of the read
-- audience above, so it never widened what an administrator may read.
create policy casework_macros_admin_insert on public.casework_macros
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and case when chapter_id is null
      then private.has_organization_role(organization_id, array['admin','vp'])
      else private.member_has_chapter_role(chapter_id, array['coordinator','admin','vp'])
    end
  );

create policy casework_macros_admin_update on public.casework_macros
  for update to authenticated
  using (
    case when chapter_id is null
      then private.has_organization_role(organization_id, array['admin','vp'])
      else private.member_has_chapter_role(chapter_id, array['coordinator','admin','vp'])
    end
  )
  with check (
    created_by = (select auth.uid())
    and case when chapter_id is null
      then private.has_organization_role(organization_id, array['admin','vp'])
      else private.member_has_chapter_role(chapter_id, array['coordinator','admin','vp'])
    end
  );

create policy casework_macros_admin_delete on public.casework_macros
  for delete to authenticated
  using (
    case when chapter_id is null
      then private.has_organization_role(organization_id, array['admin','vp'])
      else private.member_has_chapter_role(chapter_id, array['coordinator','admin','vp'])
    end
  );

create policy mfa_assurance on public.casework_macros as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

comment on policy casework_macros_staff_read on public.casework_macros is
  'Staff of the owning organization read its macros; a chapter-scoped macro additionally requires a staff role in that same chapter.';
comment on policy casework_macros_admin_insert on public.casework_macros is
  'Organization admins and vice presidents author organization-wide macros; chapter coordinators and admins author only macros scoped to their own chapter, and each author is stamped as the macro''s creator.';
comment on policy casework_macros_admin_update on public.casework_macros is
  'Organization admins and vice presidents edit organization-wide macros; chapter coordinators and admins edit only macros scoped to their own chapter, and an edit may not re-stamp the macro onto another member.';
comment on policy casework_macros_admin_delete on public.casework_macros is
  'Organization admins and vice presidents delete organization-wide macros; chapter coordinators and admins delete only macros scoped to their own chapter.';
comment on policy mfa_assurance on public.casework_macros is
  'Restrictive assurance gate: reading or writing a case macro requires a session that has satisfied multi-factor authentication.';

revoke all on table public.casework_macros from public, anon, authenticated;
-- Writes travel through casework_save_macro, exactly like every other table in
-- the casework suite: the client never holds an INSERT or UPDATE grant.
grant select on table public.casework_macros to authenticated;

comment on table public.casework_macros is
  'Organization-defined ordered case action lists; applied only through casework_apply_macro, which re-runs each action through its own audited routine.';

-- public.casework_macros is a case-graph relation twice over: it is a
-- public.casework_% table, which scripts/account-case-graph-inventory.mjs
-- conscripts by name alone, and it is a child of public.organizations and
-- public.chapters, which are already inside the derived closure. The gate pair
-- is therefore not optional here and carries no avoidable cost -- unlike
-- public.member_saved_views in the lane 5.2 migration
-- (20260917100000_member_saved_case_views.sql), which is hot presentation
-- state outside the closure and declines its identity foreign keys precisely
-- to stay out of it. Because the
-- gates are owed regardless, created_by keeps a real foreign key to auth.users
-- and the referential SET NULL above is the reviewed deletion disposition,
-- rather than a bare uuid swept by hand. Both gates are installed here for the
-- same reason the sensitive-content lane installed its own: the manifest
-- migration that carries every other table's pair is shipped and immutable.
-- Statement gate first for direct statements and cascading FK activity, row
-- gate to collect the Auth identity before the FK check.
create trigger a00_case_graph_lock before insert or update or delete on public.casework_macros
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.casework_macros
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');

-- ---------------------------------------------------------------------------
-- @mentions on case notes
-- ---------------------------------------------------------------------------

alter table public.member_case_updates
  add column mentioned_user_ids uuid[] not null default '{}'::uuid[];
alter table public.member_case_updates
  add constraint member_case_updates_mentions_bounded
  check (pg_catalog.array_length(mentioned_user_ids, 1) is null
    or pg_catalog.array_length(mentioned_user_ids, 1) <= 10);

-- A member still writes their own case note directly, but may not stamp a
-- mention list onto that insert: the audience check and the notification both
-- live in casework_add_case_note, and a raw insert would bypass them.
drop policy member_case_updates_insert_own on public.member_case_updates;
create policy member_case_updates_insert_own on public.member_case_updates
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.member_cases c
      where c.id = case_id and c.user_id = (select auth.uid()))
    and mentioned_user_ids = '{}'::uuid[]
  );

comment on policy member_case_updates_insert_own on public.member_case_updates is
  'A member writes notes only on their own case, and never carries a mention list on a direct insert: mentions are authored through the audited casework note routine.';

-- Shoulder test: the lock-screen copy names the author and nothing about the
-- case. No reference, no title, no step.
insert into private.notification_copy (key, lang, title, body) values
  ('case.note.mention', 'en', '{name} mentioned you on a case note', 'Open Casework to read the note.'),
  ('case.note.mention', 'es', '{name} te mencionó en una nota de caso', 'Abre Casos para leer la nota.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- The mention audience is the assignment audience: stewards and coordinators
-- of the case's own chapter. Gated by casework_staff_can_access so an assigned
-- steward reading the note thread resolves the same names the author saw.
create or replace function public.list_case_note_mention_candidates(p_case_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  v_case public.member_cases%rowtype;
  v_chapter text;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  select p.chapter_id into v_chapter from public.member_profiles p where p.id = v_case.user_id;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', eligible.user_id,
      'fullName', eligible.full_name,
      'roles', eligible.roles
    ) order by eligible.full_name, eligible.user_id)
    from (
      select r.user_id, p.full_name,
             pg_catalog.jsonb_agg(r.role order by r.role) as roles
      from public.member_roles r
      join public.member_profiles p on p.id = r.user_id
      where r.role in ('steward', 'coordinator')
        and (r.chapter_id is null or r.chapter_id = v_chapter)
      group by r.user_id, p.full_name
      order by p.full_name, r.user_id
      limit 200
    ) eligible
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_case_note_mention_candidates(uuid) from public, anon;
grant execute on function public.list_case_note_mention_candidates(uuid) to authenticated;

-- The mention-aware note. Authorization is unchanged from
-- coordinator_add_case_note: private.coordinator_case_for_update still demands
-- the coordinator role, MFA and staff_can_see_user on the case owner. The note
-- row, the coordinator audit row and the casework audit row are all written
-- the same way; mentions add an audience check and a notification per
-- recipient.
create or replace function public.casework_add_case_note(
  p_case_id uuid,
  p_body text,
  p_mention_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_case public.member_cases%rowtype;
  v_chapter text;
  v_body text;
  v_mentions uuid[];
  v_mention_count integer;
  v_inserted public.member_case_updates%rowtype;
  v_actor text;
  v_recipient uuid;
begin
  -- Case graph gate first, before any declaration initializer, authorization
  -- read or row acquisition: this routine writes member_case_updates and
  -- member_notifications, both of which sit inside the account/case graph.
  perform private.lock_case_graph(array[(select auth.uid())], array[p_case_id]);
  v_body := pg_catalog.btrim(coalesce(p_body, ''));
  v_case := private.coordinator_case_for_update(p_case_id);
  if pg_catalog.char_length(v_body) not between 1 and 4000 then
    raise exception 'note must be 1-4000 characters' using errcode = '22023';
  end if;

  -- Self-mentions are dropped rather than rejected: a coordinator typing their
  -- own name is not an error, it is just not a notification.
  select pg_catalog.array_agg(distinct candidate.id) into v_mentions
  from pg_catalog.unnest(coalesce(p_mention_ids, '{}'::uuid[])) as candidate(id)
  where candidate.id is not null and candidate.id <> (select auth.uid());
  v_mentions := coalesce(v_mentions, '{}'::uuid[]);
  v_mention_count := coalesce(pg_catalog.array_length(v_mentions, 1), 0);
  if v_mention_count > 10 then
    raise exception 'a note mentions at most 10 people' using errcode = '22023';
  end if;

  select p.chapter_id into v_chapter from public.member_profiles p where p.id = v_case.user_id;
  if exists (
    select 1
    from pg_catalog.unnest(v_mentions) as mention(id)
    where not exists (
      select 1 from public.member_roles r
      where r.user_id = mention.id
        and r.role in ('steward', 'coordinator')
        and (r.chapter_id is null or r.chapter_id = v_chapter))
  ) then
    raise exception 'mentioned person is outside the case chapter' using errcode = '23514';
  end if;

  insert into public.member_case_updates(case_id, user_id, body, mentioned_user_ids)
  values (v_case.id, v_case.user_id, v_body, v_mentions)
  returning * into v_inserted;

  insert into public.coordinator_case_audit(case_id, user_id, actor_id, action, after_value)
  values (v_case.id, v_case.user_id, (select auth.uid()), 'note_added',
    pg_catalog.jsonb_build_object('updateId', v_inserted.id, 'body', v_inserted.body, 'mentionCount', v_mention_count));

  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
    'note_added', 'case_update', v_inserted.id,
    pg_catalog.jsonb_build_object('mentionCount', v_mention_count));

  if v_mention_count > 0 then
    select coalesce(p.full_name, 'A staff member') into v_actor
    from public.member_profiles p where p.id = (select auth.uid());
    foreach v_recipient in array v_mentions loop
      perform private.notify_member(v_recipient, 'case.note.mention',
        pg_catalog.jsonb_build_object('name', coalesce(v_actor, 'A staff member')), 'cases');
    end loop;
    insert into public.casework_audit_events(
      organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
      'note_mentioned', 'case_update', v_inserted.id,
      pg_catalog.jsonb_build_object('mentionCount', v_mention_count));
  end if;

  return pg_catalog.jsonb_build_object(
    'id', v_inserted.id, 'caseId', v_inserted.case_id, 'body', v_inserted.body,
    'mentionedUserIds', pg_catalog.to_jsonb(v_mentions), 'createdAt', v_inserted.created_at);
end;
$function$;

revoke all on function public.casework_add_case_note(uuid, text, uuid[]) from public, anon;
grant execute on function public.casework_add_case_note(uuid, text, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Macro routines
-- ---------------------------------------------------------------------------

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

  -- Scope decides the writer. An organization-wide macro is an admin decision;
  -- a chapter macro is the chapter's own coordinators and admins.
  if v_chapter is null then
    v_org := (select private.current_mobile_staff_organization());
    if v_org is null or not private.has_organization_role(v_org, array['admin','vp']) then
      raise exception 'organization admin role required' using errcode = '42501';
    end if;
  else
    select c.organization_id into v_org from public.chapters c where c.id = v_chapter;
    if v_org is null then raise exception 'chapter not found' using errcode = 'P0002'; end if;
    if not private.member_has_chapter_role(v_chapter, array['coordinator','admin','vp']) then
      raise exception 'chapter coordinator or admin role required' using errcode = '42501';
    end if;
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
  if v_org is null
     or not private.has_organization_role(v_org, array['steward','coordinator','advisor','admin','vp']) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', m.id, 'name', m.name, 'chapterId', m.chapter_id,
      'actions', m.actions, 'active', m.active, 'updatedAt', m.updated_at
    ) order by m.name, m.id)
    from public.casework_macros m
    where m.organization_id = v_org
      and (m.chapter_id is null
        or private.member_has_chapter_role(m.chapter_id, array['steward','coordinator','advisor','admin','vp']))
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.casework_list_macros() from public, anon;
grant execute on function public.casework_list_macros() to authenticated;

-- Applying a macro is a loop over audited routines, never an update of
-- member_cases. Each (case, action) pair gets a deterministic operation id
-- derived from the batch key, which is both the downstream routine's
-- idempotency key and this function's own replay guard, so a retried batch
-- does not add a second note or a second alert.
create or replace function public.casework_apply_macro(
  p_macro_id uuid,
  p_case_ids uuid[],
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_macro public.casework_macros%rowtype;
  v_case public.member_cases%rowtype;
  v_case_id uuid;
  v_action jsonb;
  v_index integer;
  v_key uuid;
  v_applied integer;
  v_skipped integer;
  v_count integer;
  v_org_count integer;
  v_alert_id uuid;
  v_entity uuid;
begin
  -- Applying a macro re-enters casework_advance_step, casework_bulk_update_cases
  -- and assign_member_case, so this routine is itself a message-lifecycle and
  -- case-graph writer entry. It therefore opens with the canonical entry gate in
  -- the exact shape every other enrolled entry carries (the wrapper's
  -- array[auth.uid()], array[]::uuid[] form, pinned by
  -- tests/message-preservation-db.test.js), and only then adds this batch's own
  -- case identifiers. Both calls run through private.lock_case_graph, which takes
  -- the message-lifecycle lock and (509, 700) first and then walks its
  -- identifiers in sorted order, so the second call widens the acquisition
  -- without reordering it. Each per-action routine re-enters the same advisory
  -- locks, so the ordering established here is the ordering they all see.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.lock_case_graph(array[(select auth.uid())], p_case_ids);
  v_applied := 0;
  v_skipped := 0;
  perform private.casework_require_mfa();
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if coalesce(pg_catalog.array_length(p_case_ids, 1), 0) not between 1 and 100 then
    raise exception 'select 1 to 100 cases' using errcode = '22023';
  end if;

  select * into v_macro from public.casework_macros where id = p_macro_id;
  if v_macro.id is null or not v_macro.active then
    raise exception 'macro not found' using errcode = 'P0002';
  end if;
  if not private.has_organization_role(v_macro.organization_id, array['coordinator','admin','vp']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;

  -- Same selection bound casework_bulk_update_cases enforces: every case
  -- accessible, every case in this macro's organization, one organization.
  select pg_catalog.count(*), pg_catalog.count(distinct c.organization_id)
    into v_count, v_org_count
  from public.member_cases c
  where c.id = any(p_case_ids)
    and c.organization_id = v_macro.organization_id
    and private.casework_staff_can_access(c.id);
  if v_count <> pg_catalog.array_length(p_case_ids, 1) or v_org_count <> 1 then
    raise exception 'case selection is not authorized' using errcode = 'P0002';
  end if;
  if v_macro.chapter_id is not null and exists (
    select 1 from public.member_cases c
    where c.id = any(p_case_ids) and c.chapter_id is distinct from v_macro.chapter_id
  ) then
    raise exception 'macro is scoped to another chapter' using errcode = '42501';
  end if;

  foreach v_case_id in array p_case_ids loop
    v_index := 0;
    for v_action in select element from pg_catalog.jsonb_array_elements(v_macro.actions) as t(element) loop
      v_key := pg_catalog.md5(p_idempotency_key::text || v_case_id::text || v_index::text)::uuid;
      if exists (
        select 1 from public.casework_audit_events e
        where e.case_id = v_case_id and e.event_type = 'macro_applied'
          and e.metadata->>'operationId' = v_key::text
      ) then
        v_skipped := v_skipped + 1;
        v_index := v_index + 1;
        continue;
      end if;

      select * into v_case from public.member_cases where id = v_case_id;
      v_entity := v_case.id;

      if v_action->>'kind' = 'advance_step' then
        -- casework_advance_step refuses a no-op hop, so a case already parked
        -- on the target step is left alone instead of failing the batch.
        if v_case.step is distinct from pg_catalog.btrim(v_action->>'step') then
          perform public.casework_advance_step(
            v_case.id, v_case.step, v_action->>'step', v_action->>'outcome', v_key);
        end if;
      elsif v_action->>'kind' = 'set_status' then
        if v_case.status is distinct from (v_action->>'status') then
          perform public.casework_bulk_update_cases(
            array[v_case.id], v_case.status, v_action->>'status', null, v_key);
        end if;
      elsif v_action->>'kind' = 'assign' then
        perform public.assign_member_case(
          v_case.id, (v_action->>'stewardId')::uuid, (v_action->>'coordinatorId')::uuid);
        insert into public.casework_audit_events(
          organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
        values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
          'case_assigned', 'case', v_case.id,
          pg_catalog.jsonb_build_object('operationId', v_key::text, 'macroId', v_macro.id));
      elsif v_action->>'kind' = 'add_note' then
        perform public.coordinator_add_case_note(v_case.id, v_action->>'body');
      elsif v_action->>'kind' = 'add_alert' then
        insert into public.casework_alerts(
          case_id, organization_id, chapter_id, kind, severity, message, created_by)
        values (v_case.id, v_case.organization_id, v_case.chapter_id,
          v_action->>'alertKind', v_action->>'severity',
          pg_catalog.btrim(v_action->>'message'), (select auth.uid()))
        returning id into v_alert_id;
        v_entity := v_alert_id;
        insert into public.casework_audit_events(
          organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
        values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
          'alert_created', 'alert', v_alert_id,
          pg_catalog.jsonb_build_object('operationId', v_key::text, 'macroId', v_macro.id));
      end if;

      insert into public.casework_audit_events(
        organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
      values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
        'macro_applied', 'macro', v_macro.id,
        pg_catalog.jsonb_build_object(
          'operationId', v_key::text, 'batchId', p_idempotency_key::text,
          'macroId', v_macro.id, 'actionIndex', v_index,
          'kind', v_action->>'kind', 'entityId', v_entity));
      v_applied := v_applied + 1;
      v_index := v_index + 1;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'macroId', v_macro.id,
    'caseCount', pg_catalog.array_length(p_case_ids, 1),
    'actionsApplied', v_applied,
    'actionsSkipped', v_skipped);
end;
$function$;

revoke all on function public.casework_apply_macro(uuid, uuid[], uuid) from public, anon;
grant execute on function public.casework_apply_macro(uuid, uuid[], uuid) to authenticated;

-- The two staff desks read case timelines through this one RPC, so the mention
-- list has to travel with the note or the reader sees "@Ana Ruiz" as prose and
-- the chip never renders. The names come from a plain join, NOT a definer
-- lookup: this function stays security invoker, so member_profiles RLS decides
-- whether the reader may learn the mentioned person's name. A reader who may
-- not (a member reading their own case) gets an empty array and the body reads
-- exactly as the author typed it -- no new disclosure, just no chip.
--
-- The return type gains a column, which Postgres will not do in place.
drop function if exists public.list_case_latest_updates(uuid[], integer);

create function public.list_case_latest_updates(
  p_case_ids uuid[],
  p_per_case integer default 20
)
returns table (case_id uuid, id uuid, body text, created_at timestamptz, total_count bigint, mentions jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $updates$
declare
  per_case integer := least(greatest(coalesce(p_per_case, 20), 1), 100);
begin
  -- Bounded fan-in: the desk page is 200 cases; 500 leaves headroom without
  -- letting a caller turn this into an unbounded scan.
  if coalesce(pg_catalog.cardinality(p_case_ids), 0) > 500 then
    raise exception 'too many case ids' using errcode = '22023';
  end if;

  return query
  select ranked.case_id, ranked.id, ranked.body, ranked.created_at, ranked.total_count, ranked.mentions
  from (
    select u.case_id, u.id, u.body, u.created_at,
      pg_catalog.row_number() over (partition by u.case_id order by u.created_at desc, u.id desc) as rn,
      pg_catalog.count(*) over (partition by u.case_id) as total_count,
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('userId', p.id, 'fullName', p.full_name)
          order by p.full_name)
        from public.member_profiles p
        where p.id = any(u.mentioned_user_ids)
      ), '[]'::jsonb) as mentions
    from public.member_case_updates u
    where u.case_id = any(p_case_ids)
  ) ranked
  where ranked.rn <= per_case
  order by ranked.case_id, ranked.created_at, ranked.id;
end;
$updates$;

revoke all on function public.list_case_latest_updates(uuid[], integer) from public, anon;
grant execute on function public.list_case_latest_updates(uuid[], integer) to authenticated, service_role;
comment on function public.list_case_latest_updates(uuid[], integer) is
  'Recent updates per case (newest kept, returned chronological), the true per-case total, and the note mentions the reader is allowed to name. Invoker security: RLS decides both row visibility and whether a mentioned profile resolves.';

-- ---------------------------------------------------------------------------
-- Account lifecycle review
-- ---------------------------------------------------------------------------

-- public.casework_macros.created_by is the only new direct auth.users
-- reference in this migration (case note mentions are a bounded uuid[] on
-- public.member_case_updates, which is already a reviewed case child through
-- its own case_id foreign key, and carries no new referential action). The row
-- below is what private.account_lifecycle_unmanaged_restrictive_fks() reads:
-- 'pseudonymize' is the disposition that matches the installed ON DELETE SET
-- NULL action, and export_inventory_basis keeps the bidirectional ownership
-- inventory exactly equal to the independently discovered direct auth.users FK
-- catalogue. The export stays excluded for the same reviewed reason every other
-- staff attribution column carries: a macro is the organization's
-- configuration, not the authoring administrator's portable content.
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, exclusion_reason, note, reviewed_at)
values
  ('public', 'casework_macros', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk',
   'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
   'Attribution column on organization-owned casework configuration; installed action is ON DELETE SET NULL, so the organization keeps its macro library after the authoring administrator deletes their account.',
   current_date);

-- The two case-graph gates this migration installs enter the reviewed
-- lifecycle trigger surface, with their definition hashes taken from the
-- surface itself rather than copied in by hand, and the whole review must be
-- complete before this migration may commit.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'public' and table_name = 'casework_macros'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_casework_macros_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the casework macros migration';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after the casework macros migration';
  end if;
end;
$assert_casework_macros_trigger_review$;

notify pgrst, 'reload schema';

commit;
