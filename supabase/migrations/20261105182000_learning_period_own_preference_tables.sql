-- REQ-UG-LEARNING-PERIOD-PREFERENCE-TABLES-JOURNAL-20261104 (#7027):
-- the smaller own-preference tables under the learning period. Built on the
-- engine (20261103163000) and the undo dispatcher as the slices before it
-- left it. Stamped after every open migration (20261104124500 #7085,
-- 20261104130000 #7059, 20261105030000 #7079). 20261105030000 adds no undo
-- handler, so the dispatcher this hands off to is the one 20261104123000
-- installed. Design: the operator runbook,
-- "Your own preferences", whose decision table marks these five areas
-- practice (Reverse, no conflict check beyond the actor's own later change):
--   own_report_preferences        save_my_report_preferences
--   own_workload_reminder         set_workload_reminder_preferences
--   own_platform_update_preference set_my_platform_announcement_preference
--   own_compass_workspace         save_compass_workspace_preferences
--   own_channel_notifications     set_channel_notification_level, set_channel_mute,
--                                 set_channel_keyword_alerts (through
--                                 private.save_channel_notification_settings)
-- SMS consent (member_sms_preferences, set_my_sms_consent) is real, not
-- practice: it is the consent record a carrier STOP keeps sticky, so it is
-- not journalled and set_my_sms_consent is not touched here.
--
-- Each writer reads the person's own row before it writes and journals the
-- change after it, in the same transaction. Undo puts the earlier choice
-- back; a row the action created is removed, so the person is back to
-- "never set" (a channel keeps no row for its defaults, as its writer does).
-- A reminder or notice already delivered stays sent. A delivery sweep's
-- bookkeeping (a workload reminder's next_due_at and last_sent_at) is not the
-- person's choice, so it neither blocks an undo nor is put back by one.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- 1. Kinds
-- ---------------------------------------------------------------------------
insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('own_report_preferences', 'settings', 'reverse', 'public.member_report_preferences', false, 'private.learning_undo_own_preference',
    array['present', 'config']::text[], 'Changing the order, hidden reports or custom reports in your own My Reports.'),
  ('own_workload_reminder', 'settings', 'reverse', 'private.workload_reminder_preferences', false, 'private.learning_undo_own_preference',
    array['present', 'enabled', 'cadence', 'weekday', 'local_hour', 'timezone']::text[],
    'Changing your own workload reminder. A reminder already delivered stays sent.'),
  ('own_platform_update_preference', 'settings', 'reverse', 'private.platform_announcement_preferences', false, 'private.learning_undo_own_preference',
    array['present', 'hidden']::text[], 'Hiding or showing Union Ground platform updates for yourself.'),
  ('own_compass_workspace', 'settings', 'reverse', 'public.compass_workspace_preferences', false, 'private.learning_undo_own_preference',
    array['present', 'module_order', 'hidden_modules']::text[], 'Changing the order or hidden modules of your own Compass workspace.'),
  ('own_channel_notifications', 'settings', 'reverse', 'public.chapter_space_notification_settings', false, 'private.learning_undo_own_preference',
    array['present', 'notification_level', 'muted', 'muted_until', 'keywords']::text[],
    'Changing your own notification level, mute or keyword alerts for a chapter space. Notices already delivered stay sent.');

-- ---------------------------------------------------------------------------
-- 2. State and the journal call
-- ---------------------------------------------------------------------------
-- One person's own choice in one of these tables, as the undo compares it:
-- the choice columns only, with "present" false when the person has no row.
-- Targets: the person's id, or '<organization or space id>:<person id>'.
create function private.learning_preference_state(p_table text, p_target text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  scope uuid;
  member uuid;
  state jsonb;
begin
  if p_table in ('public.member_report_preferences', 'private.workload_reminder_preferences') then
    member := p_target::uuid;
  else
    scope := pg_catalog.split_part(p_target, ':', 1)::uuid;
    member := pg_catalog.split_part(p_target, ':', 2)::uuid;
  end if;
  case p_table
    when 'public.member_report_preferences' then
      select pg_catalog.jsonb_build_object('present', true, 'config', p.config) into state
      from public.member_report_preferences p where p.user_id = member;
    when 'private.workload_reminder_preferences' then
      select pg_catalog.jsonb_build_object('present', true, 'enabled', p.enabled, 'cadence', p.cadence,
        'weekday', p.weekday, 'local_hour', p.local_hour, 'timezone', p.timezone) into state
      from private.workload_reminder_preferences p where p.user_id = member;
    when 'private.platform_announcement_preferences' then
      select pg_catalog.jsonb_build_object('present', true, 'hidden', p.hidden) into state
      from private.platform_announcement_preferences p where p.organization_id = scope and p.user_id = member;
    when 'public.compass_workspace_preferences' then
      select pg_catalog.jsonb_build_object('present', true, 'module_order', p.module_order, 'hidden_modules', p.hidden_modules) into state
      from public.compass_workspace_preferences p where p.organization_id = scope and p.user_id = member;
    when 'public.chapter_space_notification_settings' then
      select pg_catalog.jsonb_build_object('present', true, 'notification_level', s.notification_level, 'muted', s.muted,
        'muted_until', s.muted_until, 'keywords', pg_catalog.to_jsonb(s.keywords)) into state
      from public.chapter_space_notification_settings s where s.space_id = scope and s.user_id = member;
    else
      raise exception 'invalid learning preference table' using errcode = '22023';
  end case;
  return coalesce(state, '{"present": false}'::jsonb);
end;
$function$;
revoke all on function private.learning_preference_state(text, text) from public, anon, authenticated, service_role;

-- Journals one own-preference change, as private.learning_membership_journal
-- does: nothing when the choice did not change, and the save goes through as
-- a real action when its before-image is over the journal's bound.
create function private.learning_preference_journal(p_kind text, p_table text, p_target text, p_before jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  after_state jsonb := private.learning_preference_state(p_table, p_target);
  failed_check text;
begin
  if after_state is null or p_before is null or after_state = p_before
     or pg_catalog.char_length(p_target) > 128 then
    return null;
  end if;
  return private.learning_journal_append(
    p_kind, p_table, p_target, null, private.learning_fingerprint(after_state), null, p_before);
exception
  when check_violation then
    get stacked diagnostics failed_check = constraint_name;
    if failed_check = 'learning_action_journal_image' then
      return null;
    end if;
    raise;
end;
end;
$function$;
revoke all on function private.learning_preference_journal(text, text, text, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The reversing handler (interface in 20261103163000)
-- ---------------------------------------------------------------------------
-- Only the person who made the choice can undo it, in a full session with
-- the extra verification step, and only while today's rule for writing that
-- choice still lets them: membership of the organization for Compass and
-- platform updates; for a channel, a readable space, the keyword limit and
-- the level, mute and keyword switches for each part the undo changes.
create function private.learning_undo_own_preference(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  target_table text := p_entry ->> 'target_table';
  target text := p_entry ->> 'target_id';
  image jsonb := p_entry -> 'before_image';
  present boolean := coalesce((p_entry -> 'before_image' ->> 'present')::boolean, false);
  scope uuid;
  member uuid;
  space_org uuid;
  wanted_keywords text[];
  wanted_enabled boolean;
  elsewhere integer;
  current_state jsonb;
  wanted_muted boolean;
  current_muted boolean;
begin
  if target_table in ('public.member_report_preferences', 'private.workload_reminder_preferences') then
    member := target::uuid;
  elsif target_table in ('private.platform_announcement_preferences', 'public.compass_workspace_preferences',
                         'public.chapter_space_notification_settings') then
    scope := pg_catalog.split_part(target, ':', 1)::uuid;
    member := pg_catalog.split_part(target, ':', 2)::uuid;
  else
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if p_mode = 'lock' then
    case target_table
      when 'public.member_report_preferences' then
        perform 1 from public.member_report_preferences p where p.user_id = member for update;
      when 'private.workload_reminder_preferences' then
        -- The setter's own lock, then the row.
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workload-reminder:' || member::text, 0));
        perform 1 from private.workload_reminder_preferences p where p.user_id = member for update;
      when 'private.platform_announcement_preferences' then
        perform 1 from private.platform_announcement_preferences p where p.organization_id = scope and p.user_id = member for update;
      when 'public.compass_workspace_preferences' then
        perform 1 from public.compass_workspace_preferences p where p.organization_id = scope and p.user_id = member for update;
      else
        perform 1 from public.chapter_space_notification_settings s where s.space_id = scope and s.user_id = member for update;
    end case;
    return null;
  elsif p_mode = 'state' then
    return private.learning_preference_state(target_table, target);
  elsif p_mode = 'before' then
    return image;
  elsif p_mode = 'check' then
    perform private.member_pin_require_full_session();
    if member is distinct from (select auth.uid()) or not private.mfa_satisfied() then
      raise exception 'authentication required' using errcode = '42501';
    end if;
    if target_table = 'private.platform_announcement_preferences'
       and private.platform_announcement_context(false, false, true) is distinct from scope then
      raise exception 'platform updates unavailable' using errcode = '42501';
    elsif target_table = 'public.compass_workspace_preferences' and not private.is_organization_member(scope) then
      raise exception 'active organization membership required' using errcode = '42501';
    elsif target_table = 'public.chapter_space_notification_settings' then
      -- A space that is gone, archived or no longer readable refuses the undo
      -- as one that can no longer be taken, before anything reads its rows.
      begin
        space_org := private.channel_settings_target(scope);
      exception
        when no_data_found then
          raise exception 'this practice action can no longer be undone' using errcode = '55000';
      end;
      -- Each part the undo changes needs the switch its own setter needs.
      current_state := private.learning_preference_state(target_table, target);
      if coalesce(case when present then image ->> 'notification_level' end, 'mentions')
           is distinct from coalesce(current_state ->> 'notification_level', 'mentions')
         and not private.organization_feature_enabled(space_org, 'features.messaging.channel_notification_levels') then
        perform private.raise_channel_control_disabled('Channel notification levels');
      end if;
      wanted_muted := present and coalesce((image ->> 'muted')::boolean, false);
      current_muted := coalesce((current_state ->> 'muted')::boolean, false);
      if (wanted_muted is distinct from current_muted
          or (wanted_muted and (image ->> 'muted_until')::timestamptz is distinct from (current_state ->> 'muted_until')::timestamptz))
         and not private.organization_feature_enabled(space_org, 'features.messaging.channel_mute') then
        perform private.raise_channel_control_disabled('Channel mute');
      end if;
      if coalesce(case when present then image -> 'keywords' end, '[]'::jsonb)
           is distinct from coalesce(current_state -> 'keywords', '[]'::jsonb)
         and not private.organization_feature_enabled(space_org, 'features.messaging.keyword_alerts') then
        perform private.raise_channel_control_disabled('Keyword alerts');
      end if;
      if present then
        select coalesce(pg_catalog.sum(pg_catalog.cardinality(s.keywords)), 0)::integer into elsewhere
        from public.chapter_space_notification_settings s
        where s.organization_id = space_org and s.user_id = member and s.space_id <> scope;
        if elsewhere + pg_catalog.jsonb_array_length(coalesce(image -> 'keywords', '[]'::jsonb))
           > private.organization_limit(space_org, 'limits.messaging.keyword_alerts_per_member') then
          raise exception 'keyword alert limit reached' using errcode = '22023', detail = 'keyword-limit';
        end if;
      end if;
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  -- A change that created the person's row is undone by removing the row,
  -- so every reader sees "never set" again rather than a saved default.
  case target_table
    when 'public.member_report_preferences' then
      if present then
        update public.member_report_preferences p
        set config = image -> 'config', updated_at = pg_catalog.now()
        where p.user_id = member;
      else
        delete from public.member_report_preferences p where p.user_id = member;
      end if;
    when 'private.workload_reminder_preferences' then
      if present then
        -- The earlier choice, with its next reminder worked out the way the
        -- setter works it out; the last reminder sent stays as it is.
        wanted_enabled := coalesce((image ->> 'enabled')::boolean, false);
        update private.workload_reminder_preferences p
        set enabled = wanted_enabled,
            cadence = image ->> 'cadence',
            weekday = (image ->> 'weekday')::smallint,
            local_hour = (image ->> 'local_hour')::smallint,
            timezone = image ->> 'timezone',
            next_due_at = case when wanted_enabled then private.next_workload_reminder_at(
              image ->> 'cadence', (image ->> 'weekday')::integer, (image ->> 'local_hour')::integer,
              image ->> 'timezone', pg_catalog.now()) end,
            updated_at = pg_catalog.now()
        where p.user_id = member;
      else
        delete from private.workload_reminder_preferences p where p.user_id = member;
      end if;
    when 'private.platform_announcement_preferences' then
      if present then
        update private.platform_announcement_preferences p
        set hidden = coalesce((image ->> 'hidden')::boolean, false)
        where p.organization_id = scope and p.user_id = member;
      else
        delete from private.platform_announcement_preferences p
        where p.organization_id = scope and p.user_id = member;
      end if;
    when 'public.compass_workspace_preferences' then
      if present then
        update public.compass_workspace_preferences p
        set module_order = image -> 'module_order', hidden_modules = image -> 'hidden_modules',
            updated_at = pg_catalog.now()
        where p.organization_id = scope and p.user_id = member;
      else
        delete from public.compass_workspace_preferences p
        where p.organization_id = scope and p.user_id = member;
      end if;
    else
      if present then
        select coalesce(pg_catalog.array_agg(k.value order by k.ordinality), '{}'::text[]) into wanted_keywords
        from pg_catalog.jsonb_array_elements_text(coalesce(image -> 'keywords', '[]'::jsonb)) with ordinality k(value, ordinality);
        insert into public.chapter_space_notification_settings (
          organization_id, space_id, user_id, notification_level, muted, muted_until, keywords, updated_at
        ) values (
          private.channel_settings_target(scope), scope, member, image ->> 'notification_level',
          coalesce((image ->> 'muted')::boolean, false),
          case when coalesce((image ->> 'muted')::boolean, false) then (image ->> 'muted_until')::timestamptz end,
          wanted_keywords, pg_catalog.now()
        )
        on conflict (space_id, user_id) do update set
          organization_id = excluded.organization_id,
          notification_level = excluded.notification_level,
          muted = excluded.muted,
          muted_until = excluded.muted_until,
          keywords = excluded.keywords,
          updated_at = excluded.updated_at;
      else
        -- No row was the defaults; the channel writer keeps no row for them.
        delete from public.chapter_space_notification_settings s
        where s.space_id = scope and s.user_id = member;
      end if;
  end case;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_own_preference(text, jsonb) from public, anon, authenticated, service_role;

-- Hand-off, as 20261104111500, 20261104120000 and 20261104123000 do: the
-- dispatcher installed when this applies keeps its body under a new name,
-- and the new dispatcher sends this slice's handler to it and every other
-- handler to the one it found. No earlier slice's branch is copied, so none
-- can be dropped whichever order the slices land in.
alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_preferences;
comment on function private.learning_dispatch_before_preferences(text, text, jsonb) is
  'REQ-UG-LEARNING-PERIOD-PREFERENCE-TABLES-JOURNAL-20261104: the undo dispatcher as the slices before the own-preference tables slice left it, reached only through private.learning_dispatch.';

create function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- Handlers write graph tables, so the dispatcher takes the lock first too.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if p_mode is null or p_mode not in ('lock', 'state', 'before', 'check', 'apply') or p_entry is null then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  case p_handler
    when 'private.learning_undo_own_preference' then return private.learning_undo_own_preference(p_mode, p_entry);
    else return private.learning_dispatch_before_preferences(p_handler, p_mode, p_entry);
  end case;
end;
$function$;
revoke all on function private.learning_dispatch(text, text, jsonb) from public, anon, authenticated, service_role;

-- Every registered handler must still be named by a dispatcher in the
-- chain; refuse to apply otherwise, so no slice's undo can stop working.
do $assert_learning_dispatch_complete$
declare
  missing text;
  chain text;
begin
  select pg_catalog.string_agg(pg_catalog.pg_get_functiondef(p.oid), ' ') into chain
  from pg_catalog.pg_proc p
  where p.pronamespace = 'private'::regnamespace and p.proname ~ '^learning_dispatch(_before_[a-z0-9_]+)?$';
  select pg_catalog.string_agg(distinct k.handler, ', ') into missing
  from private.learning_action_kinds k
  where k.handler is not null
    and pg_catalog.strpos(chain, 'when ''' || k.handler || ''' then return ' || k.handler || '(p_mode, p_entry);') = 0;
  if missing is not null then
    raise exception 'learning dispatcher lacks handlers: %', missing;
  end if;
end;
$assert_learning_dispatch_complete$;

-- ---------------------------------------------------------------------------
-- 4. Writers, re-emitted from their latest definitions with the journal call
-- ---------------------------------------------------------------------------
-- Each body is the current one with the graph lock first (as the installed
-- definitions already have it, from 20260907151000 or their own text), the
-- before-state read and the journal call added. Grants are unchanged.

-- My Reports (20260810153000).
create or replace function public.save_my_report_preferences(p_config jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  before_state jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object'
     or jsonb_typeof(p_config->'order') <> 'array'
     or jsonb_typeof(p_config->'hidden') <> 'array'
     or jsonb_typeof(p_config->'custom') <> 'array'
     or jsonb_array_length(p_config->'order') > 50
     or jsonb_array_length(p_config->'hidden') > 50
     or jsonb_array_length(p_config->'custom') > 25
     or octet_length(p_config::text) > 20000 then
    raise exception 'invalid report preferences' using errcode = '22023';
  end if;
  -- Every id/enum is also bounded structurally; arbitrary nested payloads do
  -- not become a 20KB storage loophole or executable client configuration.
  if exists (select 1 from jsonb_array_elements(p_config->'order') v where jsonb_typeof(v) <> 'string')
     or exists (select 1 from jsonb_array_elements(p_config->'hidden') v where jsonb_typeof(v) <> 'string')
     or exists (select 1 from jsonb_array_elements_text(p_config->'order') v where v !~ '^[a-z0-9-]{1,80}$')
     or exists (select 1 from jsonb_array_elements_text(p_config->'hidden') v where v !~ '^[a-z0-9-]{1,80}$')
     or exists (
       select 1 from jsonb_array_elements(p_config->'custom') c
       where jsonb_typeof(c) <> 'object'
          or not (c ?& array['id','metric','kind','range'])
          or c->>'id' !~ '^c-[a-z0-9-]{1,70}$'
          or c->>'metric' not in ('pts','actions','votes','hours')
          or c->>'kind' not in ('spark','rows','stat')
          or c->>'range' not in ('recent','ytd','all')
     ) then raise exception 'invalid report preferences' using errcode = '22023'; end if;

  perform 1 from public.member_report_preferences p where p.user_id = caller for update;
  before_state := private.learning_preference_state('public.member_report_preferences', caller::text);
  insert into public.member_report_preferences(user_id, config) values (caller, p_config)
  on conflict (user_id) do update set config = excluded.config, updated_at = now();
  perform private.learning_preference_journal('own_report_preferences', 'public.member_report_preferences', caller::text, before_state);
  return p_config;
end;
end
$function$;

-- Workload reminders (20260812203100).
create or replace function public.set_workload_reminder_preferences(
  p_enabled boolean,
  p_cadence text,
  p_weekday integer,
  p_local_hour integer,
  p_timezone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  existing private.workload_reminder_preferences;
  next_due timestamptz;
  before_state jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Validate even when disabled so a hidden invalid schedule cannot become
  -- active through a later boolean-only edit.
  perform private.next_workload_reminder_at(p_cadence, p_weekday, p_local_hour, p_timezone, pg_catalog.now());
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('workload-reminder:' || caller::text, 0));
  select * into existing from private.workload_reminder_preferences
    where user_id = caller for update;
  before_state := private.learning_preference_state('private.workload_reminder_preferences', caller::text);

  if coalesce(p_enabled, false) then
    next_due := case
      when existing.user_id is not null
        and existing.enabled
        and existing.cadence = p_cadence
        and existing.weekday = p_weekday
        and existing.local_hour = p_local_hour
        and existing.timezone = p_timezone
        and existing.next_due_at > pg_catalog.now()
      then existing.next_due_at
      else private.next_workload_reminder_at(p_cadence, p_weekday, p_local_hour, p_timezone, pg_catalog.now())
    end;
  end if;

  insert into private.workload_reminder_preferences (
    user_id, enabled, cadence, weekday, local_hour, timezone, next_due_at, updated_at)
  values (caller, coalesce(p_enabled, false), p_cadence, p_weekday, p_local_hour, p_timezone, next_due, pg_catalog.now())
  on conflict (user_id) do update set
    enabled = excluded.enabled,
    cadence = excluded.cadence,
    weekday = excluded.weekday,
    local_hour = excluded.local_hour,
    timezone = excluded.timezone,
    next_due_at = excluded.next_due_at,
    updated_at = pg_catalog.now();
  perform private.learning_preference_journal('own_workload_reminder', 'private.workload_reminder_preferences', caller::text, before_state);

  return public.get_workload_reminder_preferences();
end;
end;
$function$;

-- Platform updates (20261029141540).
create or replace function public.set_my_platform_announcement_preference(p_hidden boolean)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; before_state jsonb;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
 org:=private.platform_announcement_context(false,false,true);
 if p_hidden is null then raise exception 'invalid platform update preference' using errcode='22023'; end if;
 perform 1 from private.platform_announcement_preferences p where p.organization_id=org and p.user_id=auth.uid() for update;
 before_state:=private.learning_preference_state('private.platform_announcement_preferences', org::text||':'||auth.uid()::text);
 insert into private.platform_announcement_preferences(organization_id,user_id,hidden) values(org,auth.uid(),p_hidden)
  on conflict(organization_id,user_id) do update set hidden=excluded.hidden;
 perform private.learning_preference_journal('own_platform_update_preference', 'private.platform_announcement_preferences',
  org::text||':'||auth.uid()::text, before_state);
 return jsonb_build_object('hidden',p_hidden);
end;
$function$;

-- Compass workspace (20260828034122).
create or replace function public.save_compass_workspace_preferences(
  p_module_order jsonb,
  p_hidden_modules jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  allowed text[] := array['inbox', 'surveys', 'polls', 'tasks', 'cases', 'calendar'];
  saved public.compass_workspace_preferences%rowtype;
  before_state jsonb;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_module_order) <> 'array'
     or pg_catalog.jsonb_array_length(p_module_order) not between 1 and 6
     or pg_catalog.jsonb_typeof(p_hidden_modules) <> 'array'
     or pg_catalog.jsonb_array_length(p_hidden_modules) > 6
     or exists (
       select 1 from pg_catalog.jsonb_array_elements_text(p_module_order) module(value)
       where not module.value = any(allowed)
     )
     or exists (
       select 1 from pg_catalog.jsonb_array_elements_text(p_hidden_modules) module(value)
       where not module.value = any(allowed)
     )
     or (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements_text(p_module_order))
        <> (select pg_catalog.count(distinct module.value) from pg_catalog.jsonb_array_elements_text(p_module_order) module(value)) then
    raise exception 'invalid workspace module selection' using errcode = '22023';
  end if;
  perform 1 from public.compass_workspace_preferences p where p.organization_id = org and p.user_id = actor for update;
  before_state := private.learning_preference_state('public.compass_workspace_preferences', org::text || ':' || actor::text);
  insert into public.compass_workspace_preferences (
    organization_id, user_id, module_order, hidden_modules
  ) values (org, actor, p_module_order, p_hidden_modules)
  on conflict (organization_id, user_id) do update
    set module_order = excluded.module_order,
        hidden_modules = excluded.hidden_modules,
        updated_at = pg_catalog.now()
  returning * into saved;
  perform private.learning_preference_journal('own_compass_workspace', 'public.compass_workspace_preferences',
    org::text || ':' || actor::text, before_state);
  return pg_catalog.jsonb_build_object(
    'moduleOrder', saved.module_order,
    'hiddenModules', saved.hidden_modules,
    'updatedAt', saved.updated_at
  );
end;
end;
$function$;

-- Channel notification settings (20261003034000): the one writer the three
-- set_channel_* RPCs share, so a level, mute or keyword change is journalled
-- once, against the person's own row for that space.
create or replace function private.save_channel_notification_settings(
  p_organization_id uuid,
  p_space_id uuid,
  p_user_id uuid,
  p_level text,
  p_muted boolean,
  p_muted_until timestamptz,
  p_keywords text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  saved public.chapter_space_notification_settings%rowtype;
  target text;
  before_state jsonb;
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  target := p_space_id::text || ':' || p_user_id::text;
  perform 1 from public.chapter_space_notification_settings s
  where s.space_id = p_space_id and s.user_id = p_user_id for update;
  before_state := private.learning_preference_state('public.chapter_space_notification_settings', target);
  if p_level = 'mentions' and not coalesce(p_muted, false) and coalesce(pg_catalog.cardinality(p_keywords), 0) = 0 then
    delete from public.chapter_space_notification_settings s
    where s.space_id = p_space_id and s.user_id = p_user_id;
    if p_user_id = (select auth.uid()) then
      perform private.learning_preference_journal('own_channel_notifications', 'public.chapter_space_notification_settings', target, before_state);
    end if;
    saved.space_id := p_space_id;
    saved.notification_level := 'mentions';
    saved.muted := false;
    saved.keywords := '{}'::text[];
    return private.channel_settings_json(saved);
  end if;
  insert into public.chapter_space_notification_settings (
    organization_id, space_id, user_id, notification_level, muted, muted_until, keywords, updated_at
  ) values (
    p_organization_id, p_space_id, p_user_id, p_level, coalesce(p_muted, false),
    case when coalesce(p_muted, false) then p_muted_until end,
    coalesce(p_keywords, '{}'::text[]), pg_catalog.now()
  )
  on conflict (space_id, user_id) do update set
    organization_id = excluded.organization_id,
    notification_level = excluded.notification_level,
    muted = excluded.muted,
    muted_until = excluded.muted_until,
    keywords = excluded.keywords,
    updated_at = excluded.updated_at
  returning * into saved;
  if p_user_id = (select auth.uid()) then
    perform private.learning_preference_journal('own_channel_notifications', 'public.chapter_space_notification_settings', target, before_state);
  end if;
  return private.channel_settings_json(saved);
end;
$function$;

notify pgrst, 'reload schema';
commit;
