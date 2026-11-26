-- REQ-UG-FIELD-NOTES-AI-PACKET-20261001 (restore-everything lane L11b).
--
-- The old app (git ref de7df4b57c^) let staff turn the Field Notes studio's
-- source-backed blocks into a draft packet brief:
--   app/api/field-notes/draft-packet/route.ts  the staff-only POST route
--   lib/field-notes/packet-prompt.ts:61-63     at most 12 blocks per packet
--   lib/field-notes/packet-prompt.ts:120-131   citations echoed only from the
--                                              server's own source registry
-- Main keeps field notes per task instead (src/views/TaskFieldNotesView.jsx
-- over public.chapter_task_comments), and there is no packet assembly. This
-- restores the behavior on Main's shapes: staff pick notes they can already
-- read on one task, the server adds verified chapter sources through the
-- existing Compass retrieval, and the platform AI path returns a draft for
-- review. Nothing is written; the draft is not stored.
--
-- Default OFF. The old production defaults were off on both gates:
--   de7df4b57c^ 0594_field_notes.sql:247-257 seeds field_notes_enabled 'false'
--   de7df4b57c^ 0023_claude_ai.sql:153 seeds the master gate claude_enabled
--   'false' (left false by 0404 and 0406)
-- which is the old app's effective production default per the product policy.

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- de7df4b57c^ 0594_field_notes.sql:247-257 seeded field_notes_enabled 'false'.
  ('features.ai_assistant.field_notes_packet', 'boolean', 'Draft a packet from field notes',
   'Let staff turn field notes they can already read on one task into a draft packet, grounded in verified chapter sources. The draft is for review and is never saved or sent on its own.',
   'false', null, null, null, 420, 'ai_assistant', true),
  -- de7df4b57c^ lib/field-notes/packet-prompt.ts:63 capped a packet at 12 blocks.
  ('limits.ai_assistant.packet_notes', 'integer', 'Field notes per draft packet',
   'How many field notes one draft packet may use. Extra selected notes are ignored.',
   '12', 1, 24, null, 430, 'ai_assistant', true)
on conflict (key) do nothing;

-- Read as the caller would: the task must be in the caller's own chapter and
-- not soft-deleted (the chapter_tasks_select_chapter predicate), and every
-- note must belong to that task and chapter (chapter_task_comments_select_board).
-- Author identities and timestamps stay in the database; only the note text
-- and a day offset leave it, and api/_lib/compassFieldNotes.js minimizes the
-- text before any provider sees it.
create function public.get_compass_field_notes_packet_context(p_task_id uuid, p_note_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  caller uuid;
  org uuid;
  note_limit integer;
  task_row public.chapter_tasks%rowtype;
  notes jsonb;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  org := private.member_organization_for(caller);
  if org is null
     or not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.field_notes_packet') then
    raise exception 'field notes packets are turned off' using errcode = '55000';
  end if;
  if p_note_ids is null or pg_catalog.array_length(p_note_ids, 1) is null then
    raise exception 'select at least one field note' using errcode = '22023';
  end if;
  note_limit := private.organization_limit(org, 'limits.ai_assistant.packet_notes');

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p
    on p.id = caller
   and p.chapter_id = t.chapter_id
  where t.id = p_task_id
    and t.deleted_at is null;
  if task_row.id is null then
    raise exception 'task unavailable' using errcode = 'P0002';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'daysAgo', note.days_ago, 'body', note.body) order by note.created_at), '[]'::jsonb)
    into notes
  from (
    select c.body, c.created_at,
           greatest(0, (current_date - (c.created_at at time zone 'UTC')::date)) as days_ago
    from public.chapter_task_comments c
    where c.task_id = task_row.id
      and c.chapter_id = task_row.chapter_id
      and c.id = any(p_note_ids)
    order by c.created_at, c.id
    limit note_limit
  ) note;

  return pg_catalog.jsonb_build_object(
    'organization_id', org,
    'noteLimit', note_limit,
    'data', pg_catalog.jsonb_build_object('title', task_row.title, 'notes', notes)
  );
end;
end;
$function$;

revoke all on function public.get_compass_field_notes_packet_context(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_compass_field_notes_packet_context(uuid, uuid[]) to authenticated;

comment on function public.get_compass_field_notes_packet_context(uuid, uuid[]) is
  'REQ-UG-FIELD-NOTES-AI-PACKET-20261001: switch-gated, staff-only read of the selected field notes on one task in the caller''s own chapter, bounded by limits.ai_assistant.packet_notes. Returns the task title, note text and day offsets only.';

notify pgrst, 'reload schema';

commit;
