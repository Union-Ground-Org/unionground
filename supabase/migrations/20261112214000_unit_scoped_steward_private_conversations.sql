-- SEC-UG-UNIT-SCOPED-STEWARD-READS-OTHER-UNIT-PRIVATE-CONVERSATIONS-20261111 (#8308).
--
-- Row-level security on member_conversations and member_messages hides a
-- conversation from a steward limited to another unit or committee
-- (private.staff_visible_member_ids honours the scopes #6682 added). The
-- SECURITY DEFINER message functions decide through
-- private.can_actor_send_private_message -> private.staff_actor_can_see_user,
-- whose chapter-role branch never learned the scopes: with a conversation or
-- message id, a steward limited to one unit read another unit's contact notes
-- and member messages, replied and scheduled messages
-- (tests/unit-scoped-steward-private-conversations-db.test.js, red on Main).
--
-- The repair is in that one shared helper, behind every caller (the four
-- functions the audit saw leak, the eleven others, the contact-notes read
-- policy and the event and task recipient helpers): a chapter steward role
-- that carries a unit or committee scope now covers a member only when
-- private.actor_role_covers_member says it does, the rule row-level security
-- already applies. Unscoped chapter stewards, organization stewards and the
-- legacy branch are unchanged. Staff channels and the chapter steward list do
-- not use this helper (#7665) and are unchanged.
-- The non-interference proof also found a separate chapter-only staff arm
-- in redact_member_message. Its re-emission below additionally requires the
-- same per-member role coverage, preserving coordinator/admin moderation,
-- legacy reader coverage, member-own removal and preservation/learning rules.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.staff_actor_can_see_user(uuid,uuid)'::regprocedure)) <> '2579b0cff9f90278b9400103bef98dc3' then
    raise exception 'unreviewed predecessor: private.staff_actor_can_see_user(uuid,uuid)' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.redact_member_message(uuid)'::regprocedure)) is distinct from '8cacfd4f7745b94df79486bd7860741e' then
    raise exception 'unreviewed predecessor: public.redact_member_message(uuid)' using errcode = '55000';
  end if;
end;
$preflight$;

CREATE OR REPLACE FUNCTION private.staff_actor_can_see_user(p_actor uuid, p_target uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.member_profiles target
    join public.chapters target_chapter on target_chapter.id = target.chapter_id
    where target.id = p_target
      and (
        (
          target_chapter.organization_id is not null
          and exists (
            select 1
            from public.member_profiles actor_profile
            join public.chapters actor_chapter
              on actor_chapter.id = actor_profile.chapter_id
             and actor_chapter.organization_id = target_chapter.organization_id
            join public.member_chapter_memberships actor_membership
              on actor_membership.user_id = actor_profile.id
             and actor_membership.chapter_id = actor_chapter.id
             and actor_membership.status = 'active'
            where actor_profile.id = p_actor
          )
          and exists (
            select 1
            from public.organizations o
            where o.id = target_chapter.organization_id
              and o.status = 'active'
          )
          and exists (
            select 1
            from public.organization_memberships om
            where om.organization_id = target_chapter.organization_id
              and om.user_id = p_actor
              and om.status = 'active'
          )
          and (
            exists (
              select 1 from public.organization_role_grants g
              where g.organization_id = target_chapter.organization_id
                and g.user_id = p_actor
                and g.role = 'steward'
            )
            or exists (
              select 1
              from public.member_role_chapters rc
              join public.member_chapter_memberships cm
                on cm.user_id = rc.user_id
               and cm.chapter_id = rc.chapter_id
               and cm.status = 'active'
              where rc.user_id = p_actor
                and rc.chapter_id = target_chapter.id
                and rc.role = 'steward'
                and (
                  -- A chapter steward with no unit or committee scope covers
                  -- the whole chapter, as before.
                  not exists (
                    select 1
                    from private.chapter_role_scopes scope
                    where scope.user_id = rc.user_id
                      and scope.chapter_id = rc.chapter_id
                      and scope.role = rc.role
                  )
                  -- A steward limited to units or committees covers only their
                  -- members (#6682), the rule row-level security applies.
                  or private.actor_role_covers_member(p_actor, target_chapter.id, 'steward', p_target)
                )
            )
          )
          and (
            not private.staff_mfa_required(target_chapter.organization_id)
            or private.has_second_factor(p_actor)
          )
        )
        or (
          target_chapter.organization_id is null
          and exists (
            select 1
            from public.member_profiles actor_profile
            left join public.chapters actor_chapter
              on actor_chapter.id = actor_profile.chapter_id
            where actor_profile.id = p_actor
              and (actor_chapter.id is null or actor_chapter.organization_id is null)
          )
          and exists (
            select 1
            from public.member_roles r
            where r.user_id = p_actor
              and r.role = 'steward'
              and (r.chapter_id is null or r.chapter_id = target_chapter.id)
          )
          and (
            not private.staff_mfa_required()
            or private.has_second_factor(p_actor)
          )
        )
      )
  );
$function$;

-- Staff moderation keeps its existing chapter/role gate and additionally
-- requires the same per-member role coverage as scoped readers. The legacy
-- no-organization branch uses that reader's existing legacy predicate.
CREATE OR REPLACE FUNCTION public.redact_member_message(p_message_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid;
  message_row public.member_messages%rowtype;
  org uuid;
  reason text;
  removed boolean;
  held_at timestamptz;
  held_entry uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select m.* into message_row
  from public.member_messages m
  where m.id = p_message_id;
  if message_row.id is null then
    -- Flat denial: an unauthorized caller must not learn that an id exists.
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if message_row.user_id = caller and message_row.sender_kind = 'member' then
    -- The member removes content the member wrote. A steward's reply in the
    -- member's own conversation is the steward's content and takes the staff
    -- path below.
    reason := 'sender_removed';
  elsif public.member_has_role(array['steward', 'coordinator', 'admin'])
        and exists (
          select 1
          from public.member_profiles author
          join public.chapters c on c.id = author.chapter_id
          where author.id = message_row.user_id
            and c.id = private.current_member_chapter()
            and exists (
              select 1 from pg_catalog.unnest(array['steward','coordinator','admin']) staff_role(role_name)
              where private.actor_role_covers_member(caller, c.id, staff_role.role_name, message_row.user_id)
                or (c.organization_id is null
                  and public.staff_can_see_user(message_row.user_id, staff_role.role_name))
            )
        ) then
    reason := 'staff_removed';
  else
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- Your own message, while your organization's learning period runs: hold.
  if (reason = 'sender_removed' or message_row.sender_id = caller)
     and private.learning_period_running(private.current_mobile_staff_organization()) is not null then
    perform private.lock_member_message_conversation(message_row.conversation_id);
    select m.* into message_row from public.member_messages m where m.id = message_row.id for update;
    if message_row.redacted_at is null and message_row.learning_removal_held_at is null then
      if private.member_message_under_legal_hold(message_row.conversation_id) then
        raise exception 'conversation is under a preservation order' using errcode = '42501';
      end if;
      held_at := pg_catalog.clock_timestamp();
      update public.member_messages m set learning_removal_held_at = held_at where m.id = message_row.id;
      held_entry := private.learning_journal_append('message_remove_own', 'public.member_messages', message_row.id::text, null,
        private.learning_fingerprint(pg_catalog.jsonb_build_object('held', true, 'redacted', false)), null,
        pg_catalog.jsonb_build_object('held', false, 'redacted', false));
      if held_entry is null then
        -- The period closed while this waited: an ordinary removal.
        update public.member_messages m set learning_removal_held_at = null where m.id = message_row.id;
      else
        -- The dispatched scheduled copy is a second copy of the same text: it
        -- is destroyed now, so the held body lives in its own row only. Undo
        -- shows the message again from that row and recreates no copy.
        update public.member_scheduled_messages s
          set body = '', redacted_at = pg_catalog.now()
          where s.sent_message_id = message_row.id and s.redacted_at is null;
        org := (select private.current_member_organization());
        if org is not null then
          insert into public.organization_audit_ledger (
            organization_id, domain, event_type, action, actor_user_id,
            entity_type, entity_id, idempotency_key, metadata
          ) values (
            org, 'privacy', 'message.removal_held', 'delete', caller,
            'message', message_row.id::text, extensions.gen_random_uuid(),
            pg_catalog.jsonb_build_object('reasonCode', reason, 'operation', 'hold', 'count', 1)
          );
        end if;
        return pg_catalog.jsonb_build_object('redacted', false, 'held', true, 'reasonCode', reason, 'learningEntryId', held_entry,
          'message', pg_catalog.jsonb_build_object('id', message_row.id, 'body', '', 'redacted_at', null,
            'learning_removal_held_at', held_at, 'redaction_reason', null));
      end if;
    elsif message_row.learning_removal_held_at is not null then
      return pg_catalog.jsonb_build_object('redacted', false, 'held', true, 'reasonCode', reason,
        'message', pg_catalog.jsonb_build_object('id', message_row.id, 'body', '', 'redacted_at', null,
          'learning_removal_held_at', message_row.learning_removal_held_at, 'redaction_reason', null));
    end if;
  end if;

  removed := private.redact_member_message_row(message_row.id, reason, caller);
  if not removed then
    return pg_catalog.jsonb_build_object('redacted', false, 'alreadyRedacted', true,
      'message', (select pg_catalog.jsonb_build_object('id', m.id, 'body', '', 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) from public.member_messages m where m.id = message_row.id));
  end if;

  org := (select private.current_member_organization());
  if org is not null then
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'privacy', 'message.redacted', 'delete', caller,
      'message', message_row.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('reasonCode', reason, 'operation', 'redact', 'count', 1)
    );
  end if;
  -- A staff removal during the period is listed as done; it stays done.
  perform private.learning_journal_append('message_remove', 'public.member_messages', message_row.id::text);

  return pg_catalog.jsonb_build_object('redacted', true, 'reasonCode', reason,
    'message', (select pg_catalog.jsonb_build_object('id', m.id, 'body', '', 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) from public.member_messages m where m.id = message_row.id));
end;
$function$;

commit;
