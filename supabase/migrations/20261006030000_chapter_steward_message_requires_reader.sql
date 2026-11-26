-- BUG-UG-STAFF-MESSAGES-TO-CHAPTER-STEWARD-UNDELIVERED-20261003
--
-- A member's "Chapter steward" conversation (public.start_member_conversation,
-- steward_user_id null) is readable only through
-- member_conversations_select_steward: a steward of the member's chapter or an
-- organization-wide steward. In the Harrow Bay pilot the chapter had no
-- steward yet, so three messages were stored, reported as sent, and reached
-- nobody. Owner ruling, October 5, 2026, 4:52 PM ET (verbatim "1"; recorded as
-- steward_messages_no_steward_20261005 in the owner review decisions): refuse
-- up front when the chapter has no steward; nothing is stored and nothing is
-- claimed sent. Who may read steward-addressed messages is unchanged; routing
-- them to admins or the President (option 2) stays off.
--
--   * private.chapter_steward_reader_exists(p_member): true when some other
--     member of the member's organization holds the organization-wide steward
--     role, or the steward role for the member's chapter with an active
--     membership there (the people the select policy admits). It mirrors
--     private.staff_visible_member_ids('steward') for each other user: the
--     reader's organization comes from their own profile chapter, and the
--     staff second-factor rule applies, so a steward who could not open the
--     conversation does not count; neither does an account under MFA
--     recovery or a deleted or currently banned account.
--   * public.send_member_message refuses a member message into a conversation
--     with no bound steward when no such reader exists ('no steward assigned',
--     22023, detail no_steward_assigned for the app's translated copy). start_member_conversation sends its first message through this
--     writer, so a refused first message also rolls back its new conversation.
--   * public.reply_to_member_message and public.schedule_member_message refuse a
--     member's reply or scheduled message into such a conversation the same
--     way, and private.dispatch_due_member_messaging fails (authorization-
--     revoked) a member's scheduled message whose readers are gone by its
--     send time instead of storing it as sent, and notifies the member.
--
-- Hosted application: SAMPLE first, then production; needs its own owner
-- authorization.

begin;
set local lock_timeout = '5s';

create function private.chapter_steward_reader_exists(p_member uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- Mirrors member_conversations_select_steward
  -- (private.staff_visible_member_ids('steward')) evaluated as each other
  -- user: their organization comes from their own profile chapter
  -- (private.current_member_organization), staff second-factor rules apply,
  -- and the role is the organization-wide steward grant or the steward role
  -- for the member's chapter with an active membership there. Session-only
  -- conditions (aal2 at read time) are left to the reader's sign-in.
  select exists (
    select 1
    from public.member_profiles member
    join public.chapters chapter on chapter.id = member.chapter_id
    join public.member_profiles reader on reader.id <> member.id
    left join public.chapters reader_chapter on reader_chapter.id = reader.chapter_id
    where member.id = p_member
      -- An account under MFA recovery cannot open any session
      -- (private.mfa_satisfied), so it reads nothing until recovery ends.
      and not exists (
        select 1 from private.member_mfa_recovery_locks recovery where recovery.user_id = reader.id
      )
      -- A deleted or currently banned account cannot sign in (an interrupted
      -- password reissue leaves one banned with its sessions revoked).
      and exists (
        select 1 from auth.users account
        where account.id = reader.id
          and account.deleted_at is null
          and coalesce(account.banned_until, '-infinity'::timestamptz) <= pg_catalog.now()
      )
      and (
        (
          chapter.organization_id is not null
          and reader_chapter.organization_id = chapter.organization_id
          and exists (
            select 1 from public.organizations organization
            where organization.id = chapter.organization_id and organization.status = 'active'
          )
          and exists (
            select 1 from public.member_chapter_memberships home
            where home.user_id = reader.id and home.chapter_id = reader_chapter.id and home.status = 'active'
          )
          and exists (
            select 1 from public.organization_memberships om
            where om.organization_id = chapter.organization_id and om.user_id = reader.id and om.status = 'active'
          )
          and (
            not private.staff_mfa_required(chapter.organization_id)
            or (
              private.has_second_factor(reader.id)
              or exists (
                select 1 from private.verified_key_sessions key
                where key.user_id = reader.id and private.verified_key_session(reader.id, key.session_id)
              )
            )
          )
          and (
            exists (
              select 1 from public.organization_role_grants grant_row
              where grant_row.organization_id = chapter.organization_id
                and grant_row.user_id = reader.id
                and grant_row.role = 'steward'
            )
            or exists (
              select 1
              from public.member_role_chapters rc
              join public.member_chapter_memberships m
                on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
              where rc.user_id = reader.id
                and rc.role = 'steward'
                and rc.chapter_id = chapter.id
                and m.status = 'active'
            )
          )
        )
        or (
          chapter.organization_id is null
          and (reader_chapter.id is null or reader_chapter.organization_id is null)
          and (
            not coalesce((
              select policy.require_staff_mfa
              from public.org_security_policy policy
              where policy.organization_id is null and policy.id
            ), true)
            or (
              private.has_second_factor(reader.id)
              or exists (
                select 1 from private.verified_key_sessions key
                where key.user_id = reader.id and private.verified_key_session(reader.id, key.session_id)
              )
            )
          )
          and exists (
            select 1
            from public.member_roles r
            where r.user_id = reader.id
              and r.role = 'steward'
              and (
                r.chapter_id is null
                or exists (
                  select 1
                  from public.member_role_chapters rc
                  join public.member_chapter_memberships m
                    on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                  where rc.user_id = r.user_id
                    and rc.role = 'steward'
                    and rc.chapter_id = chapter.id
                    and m.status = 'active'
                )
              )
          )
        )
      )
  );
$function$;

revoke all on function private.chapter_steward_reader_exists(uuid)
  from public, anon, authenticated, service_role;

comment on function private.chapter_steward_reader_exists(uuid) is
  'True when some other member could read the member''s "Chapter steward" conversation: an organization-wide steward of the member''s organization, or a steward of the member''s chapter with an active membership there. send_member_message refuses an unreadable message.';

create or replace function public.send_member_message(p_conversation_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();
declare
  caller     uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || chr(9) || chr(10) || chr(13) || chr(12) || chr(11));
  conv       record;
  sender     text;
  new_id     uuid;
  akey       text;
  awarded    integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  select c.id, c.user_id, c.steward_user_id into conv
  from public.member_conversations c
  where c.id = p_conversation_id
  for update;

  if not found or conv.user_id is distinct from caller then
    raise exception 'conversation not found' using errcode = '22023';
  end if;

  -- A "Chapter steward" conversation (no bound steward) is readable only by a
  -- steward of the member's chapter or an organization-wide steward. When no
  -- such person exists the message would reach nobody, so it is refused and
  -- nothing is stored (a first message also rolls back its new conversation).
  if conv.steward_user_id is null and not private.chapter_steward_reader_exists(caller) then
    raise exception 'no steward assigned' using errcode = '22023', detail = 'no_steward_assigned';
  end if;

  select p.full_name into sender from public.member_profiles p where p.id = caller;

  insert into public.member_messages (conversation_id, user_id, sender_kind, sender_name, body)
  values (
    p_conversation_id,
    caller,
    'member',
    coalesce(nullif(pg_catalog.btrim(coalesce(sender, '')), ''), 'Member'),
    clean_body)
  returning id into new_id;

  update public.member_conversations set updated_at = now() where id = p_conversation_id;

  akey := 'message-' || new_id::text;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'message')
  on conflict (user_id, action_key) do nothing;

  select e.points into awarded
  from public.member_point_events e
  where e.user_id = caller and e.action_key = akey;

  return pg_catalog.jsonb_build_object('messageId', new_id, 'awardedPoints', coalesce(awarded, 0));
end;
end;
end;$function$;

-- Review round 2: a member's reply and a member's scheduled message reach the
-- same unreadable conversation without send_member_message, so both refuse
-- the same way, and the dispatcher fails a scheduled message whose readers
-- are gone by its send time. Bodies are the installed ones plus the check.

create or replace function public.reply_to_member_message(p_source_kind text, p_message_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
  declare caller uuid := (select auth.uid()); clean text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
    source public.member_messages%rowtype; post public.chapter_thread_posts%rowtype; result jsonb; new_id uuid; kind text;
  begin
    perform public.get_member_message_actions(p_source_kind, p_message_id);
    if pg_catalog.char_length(clean) not between 1 and 4000 then
      raise exception 'invalid message' using errcode = '22023';
    end if;
    if p_source_kind = 'private' then
      select * into source from public.member_messages where id = p_message_id;
      if private.can_actor_send_private_message(caller, source.conversation_id, 'member') is true then
        kind := 'member';
        if (select c.steward_user_id from public.member_conversations c where c.id = source.conversation_id) is null
           and not private.chapter_steward_reader_exists(caller) then
          raise exception 'no steward assigned' using errcode = '22023', detail = 'no_steward_assigned';
        end if;
      elsif private.can_actor_send_private_message(caller, source.conversation_id, 'steward') is true
          and public.member_has_role(array['steward']) is true then kind := 'steward';
      else raise exception 'message unavailable' using errcode = '42501'; end if;
      result := (select pg_catalog.to_jsonb(m) from public.member_messages m
        where m.parent_message_id = p_message_id and m.sender_id = caller and m.body = clean
          and m.redacted_at is null and m.created_at > pg_catalog.clock_timestamp() - interval '60 seconds'
        order by m.created_at desc, m.id desc limit 1);
      if result is not null then return result; end if;
      perform private.message_action_admit();
      insert into public.member_messages(conversation_id, user_id, sender_kind, sender_name, body, parent_message_id, created_at)
        values(source.conversation_id, source.user_id, kind,
          case when kind = 'steward' then 'Chapter steward'
            else coalesce((select nullif(full_name, '') from public.member_profiles where id = caller), 'Member') end,
          clean, p_message_id, pg_catalog.clock_timestamp())
        returning id into new_id;
      update public.member_conversations set updated_at = pg_catalog.now() where id = source.conversation_id;
      result := (select pg_catalog.to_jsonb(m) from public.member_messages m where m.id = new_id);
    else
      select * into post from public.chapter_thread_posts where id = p_message_id;
      if not exists (select 1 from public.chapter_threads t join public.chapter_spaces s on s.id = t.space_id
        where t.id = post.thread_id and t.status = 'open' and private.can_read_chapter_space(s) is true
          and t.chapter_id = private.current_member_chapter()) then
        raise exception 'message unavailable' using errcode = '42501';
      end if;
      result := (select pg_catalog.to_jsonb(p) from public.chapter_thread_posts p
        where p.parent_post_id = p_message_id and p.author_id = caller and p.body = clean
          and p.deleted_at is null and p.created_at > pg_catalog.clock_timestamp() - interval '60 seconds'
        order by p.created_at desc, p.id desc limit 1);
      if result is not null then return result; end if;
      perform private.message_action_admit();
      insert into public.chapter_thread_posts(thread_id, body, parent_post_id)
        values(post.thread_id, clean, p_message_id) returning id into new_id;
      result := (select pg_catalog.to_jsonb(p) from public.chapter_thread_posts p where p.id = new_id);
    end if;
    perform private.message_action_audit(p_source_kind, new_id, 'replied');
    return result;
  end;
end;
end;
$function$;

create or replace function public.schedule_member_message(p_conversation_id uuid, p_body text, p_scheduled_for timestamp with time zone)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
  conversation public.member_conversations%rowtype;
  sender_kind text;
  new_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if p_scheduled_for <= now() or p_scheduled_for > now() + interval '1 year' then
    raise exception 'invalid schedule time' using errcode = '22023';
  end if;
  select * into conversation from public.member_conversations where id = p_conversation_id for update;
  if not found then
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  if private.can_actor_send_private_message(caller, p_conversation_id, 'member') then
    sender_kind := 'member';
    if conversation.steward_user_id is null and not private.chapter_steward_reader_exists(caller) then
      raise exception 'no steward assigned' using errcode = '22023', detail = 'no_steward_assigned';
    end if;
  elsif public.member_has_role(array['steward'])
        and private.can_actor_send_private_message(caller, p_conversation_id, 'steward') then
    sender_kind := 'steward';
  else
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  insert into public.member_scheduled_messages(
    actor_id, conversation_id, recipient_id, sender_kind, body, scheduled_for)
  values (caller, conversation.id, conversation.user_id, sender_kind, clean_body, p_scheduled_for)
  returning id into new_id;
  return pg_catalog.jsonb_build_object('id', new_id, 'status', 'pending');
end;
end;
end;
$function$;

create or replace function private.dispatch_due_member_messaging(p_limit integer DEFAULT 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  job record;
  reminder record;
  sender_name text;
  new_message_id uuid;
  sent_count integer := 0;
  reminder_count integer := 0;
  failed_count integer := 0;
begin
  perform private.lock_message_lifecycle();
  if p_limit not between 1 and 500 then raise exception 'invalid dispatch limit' using errcode = '22023'; end if;

  for job in
    select scheduled.* from public.member_scheduled_messages scheduled
    where scheduled.status = 'pending' and scheduled.scheduled_for <= now()
    order by scheduled.scheduled_for, scheduled.id
    limit p_limit
    for update skip locked
  loop
    if not private.can_actor_send_private_message(job.actor_id, job.conversation_id, job.sender_kind)
       or not exists (select 1 from public.member_profiles recipient where recipient.id = job.recipient_id)
       or not exists (
         select 1 from public.member_conversations conversation
         where conversation.id = job.conversation_id and conversation.user_id = job.recipient_id
       ) then
      update public.member_scheduled_messages
      set status = 'failed', failure_reason = 'authorization-revoked',
          dispatched_at = now(), attempts = attempts + 1
      where id = job.id;
      failed_count := failed_count + 1;
      continue;
    end if;
    -- A member's scheduled message into a Chapter steward conversation that
    -- nobody could read fails instead of being stored as sent.
    if job.sender_kind = 'member'
       and exists (
         select 1 from public.member_conversations conversation
         where conversation.id = job.conversation_id and conversation.steward_user_id is null
       )
       and not private.chapter_steward_reader_exists(job.actor_id) then
      update public.member_scheduled_messages
      set status = 'failed', failure_reason = 'authorization-revoked',
          dispatched_at = now(), attempts = attempts + 1
      where id = job.id;
      -- The inbox lists only pending schedules, so tell the member it was not sent.
      insert into public.member_notifications(user_id, title, body, kind)
      values (job.actor_id, 'Scheduled message not sent',
        'Your chapter has no steward assigned yet, so a message you scheduled was not sent. To reach someone now, contact your chapter''s officers, such as the chapter President or Admin.',
        'messages');
      failed_count := failed_count + 1;
      continue;
    end if;
    begin
      if job.sender_kind = 'member' then
        select coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Member') into sender_name
        from public.member_profiles profile where profile.id = job.actor_id;
      else
        sender_name := 'Chapter steward';
      end if;
      insert into public.member_messages(
        conversation_id, user_id, sender_kind, sender_name, body, scheduled_message_id)
      values (
        job.conversation_id, job.recipient_id, job.sender_kind, sender_name, job.body, job.id)
      on conflict (scheduled_message_id) do nothing
      returning id into new_message_id;
      if new_message_id is null then
        select id into new_message_id from public.member_messages where scheduled_message_id = job.id;
      end if;
      if job.sender_kind = 'member' then
        insert into public.member_action_log(user_id, action_key, action_kind)
        values (job.actor_id, 'message-' || new_message_id::text, 'message')
        on conflict (user_id, action_key) do nothing;
      end if;
      update public.member_conversations set updated_at = now() where id = job.conversation_id;
      update public.member_scheduled_messages
      set status = 'sent', sent_message_id = new_message_id, failure_reason = null,
          dispatched_at = now(), attempts = attempts + 1
      where id = job.id;
      sent_count := sent_count + 1;
    exception when others then
      update public.member_scheduled_messages
      set status = 'failed', failure_reason = 'dispatch-error',
          dispatched_at = now(), attempts = attempts + 1
      where id = job.id;
      failed_count := failed_count + 1;
    end;
  end loop;

  for reminder in
    select pending.* from public.member_message_reminders pending
    where pending.status = 'pending' and pending.remind_at <= now()
    order by pending.remind_at, pending.id
    limit p_limit
    for update skip locked
  loop
    if not private.can_read_message_source(reminder.owner_id, reminder.source_kind,
      reminder.private_message_id, reminder.channel_post_id, reminder.task_message_id) then
      update public.member_message_reminders
      set status = 'failed', delivered_at = now() where id = reminder.id;
      failed_count := failed_count + 1;
      continue;
    end if;
    insert into public.member_notifications(user_id, title, body, kind, message_reminder_id)
    values (reminder.owner_id, 'Message reminder', 'Open Messages to review your reminder.', 'general', reminder.id)
    on conflict (message_reminder_id) do nothing;
    update public.member_message_reminders
    set status = 'delivered', delivered_at = now() where id = reminder.id;
    reminder_count := reminder_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'sent', sent_count, 'reminders', reminder_count, 'failed', failed_count);
end;
end;
end;
$function$;

commit;
