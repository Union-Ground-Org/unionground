-- BUG-UG-PULSE-CHARTS-OTHER-CHAPTER-HIDDEN-YET-COUNTED-20261102 (#6755).
--
-- Saved Pulse charts (20261102001534) are listed for the caller's current
-- organization and chapter only, but the 30-chart limit counted every chart
-- the caller owns in any chapter or organization. After a member selected
-- another chapter, the earlier chapter's charts left the list yet still
-- filled the limit, so "chart limit reached" could appear with fewer than 30
-- charts shown and nothing visible to remove.
--
-- 1. public.save_pulse_chart counts the same scope list_pulse_charts shows:
--    the owner's live charts in the current organization and chapter.
-- 2. public.remove_pulse_chart's undo counts the restored chart's own
--    organization and chapter.
-- 3. public.share_pulse_chart refuses a chapter thread whose chapter is not
--    the chart's chapter. It already required the thread to be in the
--    caller's current chapter; a stale list after a chapter switch could
--    otherwise post a chapter-A chart into a chapter-B thread.
--
-- Signatures, security definer, search_path, case-graph entry and grants are
-- unchanged.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- Pin the predecessors so a concurrent change to the chart writers is not lost.
do $assert_pulse_chart_writers$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'public.save_pulse_chart(uuid,text,jsonb,text,boolean,boolean,text)'::pg_catalog.regprocedure)
      <> '1f5b7e7d24c83998767b404d3a0ea6c2'
    or (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'public.remove_pulse_chart(uuid,boolean)'::pg_catalog.regprocedure)
      <> '4d15a23756521b7b96e2497b93a67f0d'
    or (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'public.share_pulse_chart(uuid,text,text,uuid)'::pg_catalog.regprocedure)
      <> '12b3d411d409ff2c4c4ce630258d275a' then
    raise exception 'Unreviewed saved Pulse chart writer predecessor: integrate current Main before scoping the chart limit';
  end if;
end;
$assert_pulse_chart_writers$;

create or replace function public.save_pulse_chart(p_id uuid, p_title text, p_spec jsonb, p_scope text, p_pinned boolean, p_home boolean, p_hat text)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare org uuid; chapter text; checked jsonb; result uuid;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.pulse_chart_context(p_hat);
  chapter := private.current_member_chapter();
  checked := private.pulse_chart_spec(p_spec,p_hat,chapter);
  if p_scope is null or p_scope not in ('personal','chapter','organization')
    or (checked->>'measure' = 'my_actions' and p_scope <> 'personal') or (p_scope = 'organization' and p_hat = 'member') then
    raise exception 'chart cannot be shared in that scope' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pulse-charts:' || auth.uid()::text,0));
  delete from private.pulse_saved_charts where owner_id = auth.uid() and organization_id = org
    and deleted_at <= pg_catalog.now() - interval '30 seconds';
  if p_id is null then
    if (select pg_catalog.count(*) from private.pulse_saved_charts where owner_id = auth.uid()
      and organization_id = org and chapter_id = chapter and deleted_at is null) >= 30 then
      raise exception 'chart limit reached' using errcode = '22023';
    end if;
    insert into private.pulse_saved_charts(organization_id,chapter_id,owner_id,title,spec,scope,pinned,home)
      values(org,chapter,auth.uid(),pg_catalog.btrim(p_title),checked,p_scope,coalesce(p_pinned,false),coalesce(p_pinned,false) and coalesce(p_home,false)) returning id into result;
  else
    update private.pulse_saved_charts set title = pg_catalog.btrim(p_title),spec = checked,scope = p_scope,
      pinned = coalesce(p_pinned,false), home = coalesce(p_pinned,false) and coalesce(p_home,false), updated_at = pg_catalog.now()
    where id = p_id and owner_id = auth.uid() and organization_id = org and chapter_id = chapter and deleted_at is null returning id into result;
    if result is null then raise exception 'chart unavailable' using errcode = '42501'; end if;
  end if;
  return result;
end;
$function$;

create or replace function public.remove_pulse_chart(p_id uuid, p_undo boolean default false)
returns void language plpgsql security definer set search_path = '' as $function$
declare org uuid;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  org := private.pulse_chart_context('member');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pulse-charts:' || auth.uid()::text,0));
  if p_undo and (select pg_catalog.count(*) from private.pulse_saved_charts c where c.owner_id = auth.uid()
    and c.organization_id = org and c.deleted_at is null and c.chapter_id = (select r.chapter_id from private.pulse_saved_charts r
      where r.id = p_id and r.owner_id = auth.uid())) >= 30 then
    raise exception 'chart limit reached' using errcode = '22023';
  end if;
  update private.pulse_saved_charts set deleted_at = case when p_undo then null else pg_catalog.now() end,
    updated_at = pg_catalog.now()
  where id = p_id and owner_id = auth.uid() and organization_id = org
    and ((p_undo and deleted_at > pg_catalog.now() - interval '30 seconds') or (not p_undo and deleted_at is null));
  if not found then raise exception 'chart unavailable or undo expired' using errcode = '42501'; end if;
end;
$function$;

create or replace function public.share_pulse_chart(p_id uuid, p_hat text, p_kind text, p_target uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare chart jsonb; body text; source uuid;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  chart := public.read_pulse_chart(p_id,p_hat,true);
  if chart->>'owned' <> 'true' or chart->'figures'->>'locked' = 'true' then
    raise exception 'chart cannot be shared' using errcode = '42501';
  end if;
  body := '[pulse-chart:' || p_id::text || ']';
  if p_kind = 'chapter' then
    if chart->>'scope' <> 'chapter' or not exists (
      select 1 from public.chapter_threads t join public.chapter_spaces s on s.id = t.space_id
      where t.id = p_target and t.status = 'open' and t.chapter_id = private.current_member_chapter()
        and t.chapter_id = (select c.chapter_id from private.pulse_saved_charts c where c.id = p_id)
        and private.can_read_chapter_space(s) is true) then
      raise exception 'chart destination unavailable' using errcode = '42501';
    end if;
    perform private.message_action_admit();
    insert into public.chapter_thread_posts(thread_id,body) values(p_target,body);
  elsif p_kind = 'message' then
    if private.can_actor_send_private_message(auth.uid(),p_target,'member') then
      perform public.send_member_message(p_target,body);
    else
      select m.id into source from public.member_messages m where m.conversation_id = p_target
        and m.redacted_at is null and private.current_actor_can_read_message_source('private',m.id,null,null)
        order by m.created_at desc,m.id desc limit 1;
      if source is null then raise exception 'chart destination unavailable' using errcode = '42501'; end if;
      perform public.reply_to_member_message('private',source,body);
    end if;
  else raise exception 'invalid destination' using errcode = '22023'; end if;
end;
$function$;

revoke all on function public.save_pulse_chart(uuid,text,jsonb,text,boolean,boolean,text) from public, anon, authenticated, service_role;
revoke all on function public.remove_pulse_chart(uuid,boolean) from public, anon, authenticated, service_role;
revoke all on function public.share_pulse_chart(uuid,text,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_pulse_chart(uuid,text,jsonb,text,boolean,boolean,text) to authenticated;
grant execute on function public.remove_pulse_chart(uuid,boolean) to authenticated;
grant execute on function public.share_pulse_chart(uuid,text,text,uuid) to authenticated;

commit;
