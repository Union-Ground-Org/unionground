-- Union Ground: no mission leaderboards leave the database (owner decision
-- D5, 2026-10-15).
--
-- This product has no points economy, and ranking workers by activity would
-- show management who the most active organizers are. The web client no longer
-- renders leaderboards, but public.get_organization_coordination_snapshot()
-- still projected one per mission, each listing up to 100 participants with a
-- privacy alias, points and status plus a participant total.
--
-- Re-emitted from the installed definition (20261003047000) with the
-- 'leaderboards' key removed from both the empty and the ready snapshot; every
-- other key, the record visibility, the caller-completion projection and the
-- grants are unchanged. The client normalizer (src/features/coordination/
-- authorization.js) already reads a missing key as an empty list. The
-- participant rows, their points columns and the mission records themselves
-- stay in place, inert, as for other left-out features.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_organization_coordination_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  staff boolean;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if organization is null then
    return pg_catalog.jsonb_build_object(
      'state', 'empty', 'organizationId', null, 'staff', false,
      'records', '[]'::jsonb,
      'messages', '[]'::jsonb, 'resources', '[]'::jsonb,
      'exportRuns', '[]'::jsonb, 'outreach', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  staff := private.organization_coordination_is_staff(organization);
  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', organization,
    'staff', staff,
    'records', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'title', r.title, 'summary', r.summary,
        'status', r.status, 'visibility', r.visibility,
        'organizationId', r.organization_id,
        'partnerOrganizationId', r.partner_organization_id,
        'chapterId', r.chapter_id, 'parentId', r.parent_id,
        'config', case when staff or r.visibility <> 'staff' then r.config else '{}'::jsonb end,
        'completedByCaller', exists (
          select 1
          from public.organization_coordination_events event
          where event.record_id = r.id
            and event.actor_user_id = caller
            and event.event_type = 'complete_objective'
        ),
        'createdAt', r.created_at, 'updatedAt', r.updated_at
      ) order by r.updated_at desc, r.id desc)
      from (
        select visible.*
        from public.organization_coordination_records visible
        where private.organization_coordination_can_read(visible.id)
        order by visible.updated_at desc, visible.id desc
        limit 50
      ) r
    ), '[]'::jsonb),
    'messages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'conversationId', m.conversation_id,
        'senderOrganizationId', m.sender_organization_id,
        'body', m.body, 'createdAt', m.created_at
      ) order by m.created_at desc, m.id desc)
      from (
        select message.*
        from public.organization_coordination_messages message
        where private.organization_coordination_can_read(message.conversation_id)
        order by message.created_at desc, message.id desc
        limit 30
      ) m
    ), '[]'::jsonb),
    'resources', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', x.id, 'recordId', x.record_id, 'kind', x.resource_kind,
        'title', x.title, 'status', x.status,
        'fromOrganizationId', x.from_organization_id,
        'toOrganizationId', x.to_organization_id,
        'documentId', x.chapter_document_id, 'updatedAt', x.updated_at
      ) order by x.updated_at desc, x.id desc)
      from public.organization_coordination_resources x
      where private.organization_coordination_can_read(x.record_id)
    ), '[]'::jsonb),
    'exportRuns', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'scheduleId', e.schedule_id, 'format', e.format,
        'deliveryMode', e.delivery_mode, 'status', e.status,
        'rowCount', e.row_count, 'expiresAt', e.expires_at,
        'createdAt', e.created_at
      ) order by e.created_at desc, e.id desc)
      from public.organization_coordination_export_runs e
      where e.organization_id = organization
    ), '[]'::jsonb) else '[]'::jsonb end,
    'outreach', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', o.id, 'campaignId', o.campaign_id,
        'targetUserId', o.target_user_id, 'disposition', o.disposition,
        'note', o.note, 'contactedAt', o.contacted_at
      ) order by o.contacted_at desc, o.id desc)
      from public.organization_coordination_outreach_events o
      where o.organization_id = organization
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

revoke all on function public.get_organization_coordination_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function public.get_organization_coordination_snapshot()
  to authenticated;

comment on function public.get_organization_coordination_snapshot() is
  'Tenant-scoped coordination projection whose records include whether the authenticated caller completed each mission objective. It carries no mission leaderboards, participant points or ranking aliases.';

notify pgrst, 'reload schema';

commit;
