-- Follow-up to #7104 (#7027); stamp reserved by .
-- Fix forward after 20261105182000; no journal or audit row changes.
-- A channel undo checked the keyword alert limit even when it changed only
-- the level or the mute, so lowering the limit could block an undo that
-- restores no keywords. The limit is checked now only when the undo puts
-- back keywords different from the ones saved today, as the keyword
-- setter checks it only when it writes keywords. The body is otherwise
-- the one 20261105182000 installed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.learning_undo_own_preference(p_mode text, p_entry jsonb)
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
      -- The limit binds only an undo that puts keywords back, as it binds
      -- only the keyword setter: a level or mute undo keeps today's keywords.
      if present and coalesce(image -> 'keywords', '[]'::jsonb)
           is distinct from coalesce(current_state -> 'keywords', '[]'::jsonb) then
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

commit;
