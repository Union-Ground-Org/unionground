-- #8927 slice 2: sanitized Notice reach and channel-poll chart reads.
-- Shared, persistent partition refinement prevents differencing across reads,
-- polls, notices, publishers and scopes. No layout-store dependency.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The secret and comparison tokens never leave this private table. Tokens are
-- HMACs of opaque account UUIDs, not identities or votes. Each atom represents
-- people indistinguishable across ALL previously published chart groups. No
-- chart/source identifier, figure or payload is retained. Never prune/reset the
-- partition: doing so would forget previously disclosed intersections.
create table private.pulse_release_partitions (
  organization_id uuid primary key references public.organizations(id) on update cascade on delete cascade,
  secret bytea not null default extensions.gen_random_bytes(32) check (pg_catalog.octet_length(secret)=32),
  atoms jsonb not null default '[]'::jsonb check (pg_catalog.jsonb_typeof(atoms)='array' and pg_catalog.jsonb_array_length(atoms)<=2048 and pg_catalog.pg_column_size(atoms)<=4194304)
);
alter table private.pulse_release_partitions enable row level security;
alter table private.pulse_release_partitions force row level security;
revoke all on private.pulse_release_partitions from public,anon,authenticated,service_role;
create policy mfa_assurance on private.pulse_release_partitions as restrictive for all to authenticated
using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.pulse_release_partitions is 'RPC-only privacy state: restrictive MFA defense, no permissive policy or client table grants. Chart reads independently check current organization and source permissions.';
create trigger a00_case_graph_lock before insert or update or delete on private.pulse_release_partitions
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.pulse_release_partitions
for each row execute function private.lock_case_graph_row_keys('', '');
comment on table private.pulse_release_partitions is '#8927: RPC-only organization-wide privacy comparison state. Salted, unlinkable outside this table; no account UUIDs, raw votes, source identifiers or figures. All nonempty Boolean atoms must meet the current organization floor before release. Capacity exhaustion withholds; history is never evicted.';
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
where schema_name='private' and table_name='pulse_release_partitions'
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;

create function private.pulse_release_safe(p_org uuid, p_groups jsonb)
returns boolean language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  floor_value integer;
  salt bytea;
  prior jsonb;
  working jsonb;
  refined jsonb;
  source_group jsonb;
  atom jsonb;
  tokens jsonb;
  token_set jsonb;
  known_set jsonb;
  inside_group jsonb;
  outside_group jsonb;
  newcomers jsonb;
begin
  -- Only authenticated server reads call this helper, after their source gate.
  if (select auth.uid()) is null or not private.mfa_satisfied()
    or p_org is distinct from private.current_member_organization()
    or not private.is_organization_member(p_org)
    or not private.organization_is_union(p_org) then return false; end if;
  floor_value := private.organization_limit(p_org,'limits.analytics.anonymity_floor');
  if floor_value is null or floor_value<1 or pg_catalog.jsonb_typeof(p_groups) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_groups)>32 then return false; end if;
  if exists(select 1 from pg_catalog.jsonb_array_elements(p_groups) g where pg_catalog.jsonb_typeof(g) is distinct from 'array') then return false; end if;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_groups) g cross join lateral pg_catalog.jsonb_array_elements(g) person)>60000 then return false; end if;
  insert into private.pulse_release_partitions(organization_id) values(p_org) on conflict do nothing;
  select s.secret,s.atoms into salt,prior from private.pulse_release_partitions s where s.organization_id=p_org for update;
  working:=prior;
  if exists(select 1 from pg_catalog.jsonb_array_elements(working) a where pg_catalog.jsonb_array_length(a)<floor_value) then return false; end if;
  for source_group in select value from pg_catalog.jsonb_array_elements(p_groups) loop
    select coalesce(pg_catalog.jsonb_agg(t order by t),'[]'::jsonb) into tokens from (
      select distinct pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(person::uuid::text,'UTF8'),salt,'sha256'),'hex') t
      from pg_catalog.jsonb_array_elements_text(source_group) person
    ) hashed;
    if pg_catalog.jsonb_array_length(tokens)=0 then continue; end if;
    if pg_catalog.jsonb_array_length(tokens)<floor_value then return false; end if;
    select pg_catalog.jsonb_object_agg(t,true) into token_set from pg_catalog.jsonb_array_elements_text(tokens) t;
    select coalesce(pg_catalog.jsonb_object_agg(t,true),'{}'::jsonb) into known_set
      from pg_catalog.jsonb_array_elements(working) a cross join lateral pg_catalog.jsonb_array_elements_text(a) t;
    refined:='[]'::jsonb;
    for atom in select value from pg_catalog.jsonb_array_elements(working) loop
      select coalesce(pg_catalog.jsonb_agg(t order by t) filter(where token_set ? t),'[]'::jsonb),
        coalesce(pg_catalog.jsonb_agg(t order by t) filter(where not (token_set ? t)),'[]'::jsonb)
      into inside_group,outside_group from pg_catalog.jsonb_array_elements_text(atom) t;
      if (pg_catalog.jsonb_array_length(inside_group)>0 and pg_catalog.jsonb_array_length(inside_group)<floor_value)
        or (pg_catalog.jsonb_array_length(outside_group)>0 and pg_catalog.jsonb_array_length(outside_group)<floor_value) then return false; end if;
      if pg_catalog.jsonb_array_length(inside_group)>0 then refined:=refined||pg_catalog.jsonb_build_array(inside_group); end if;
      if pg_catalog.jsonb_array_length(outside_group)>0 then refined:=refined||pg_catalog.jsonb_build_array(outside_group); end if;
    end loop;
    select coalesce(pg_catalog.jsonb_agg(t order by t),'[]'::jsonb) into newcomers
    from pg_catalog.jsonb_array_elements_text(tokens) t
    where not (known_set ? t);
    if pg_catalog.jsonb_array_length(newcomers)>0 then
      if pg_catalog.jsonb_array_length(newcomers)<floor_value then return false; end if;
      refined:=refined||pg_catalog.jsonb_build_array(newcomers);
    end if;
    working:=refined;
    if pg_catalog.jsonb_array_length(working)>2048 or pg_catalog.pg_column_size(working)>4194304 then return false; end if;
  end loop;
  if working is distinct from prior then update private.pulse_release_partitions set atoms=working where organization_id=p_org; end if;
  return true;
end;
end;
$function$;
revoke all on function private.pulse_release_safe(uuid,jsonb) from public,anon,authenticated,service_role;

-- Options are independent of the layout store. Data reads repeat their gates;
-- an option is never authority. No hat or role string from the client is used.
create function public.pulse_ready_chart_options()
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph_read();
declare
  org uuid:=private.current_member_organization();
  chapter text:=private.current_member_chapter();
  result jsonb:='[]'::jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or not private.is_organization_member(org)
    or not exists(select 1 from public.chapters c where c.id=chapter and c.organization_id=org) then return result; end if;
  if private.organization_is_union(org) and (private.chapter_notice_scope_allowed(chapter,null,null)
    or exists(select 1 from private.steward_assignment_scopes((select auth.uid()),chapter) s where private.chapter_notice_scope_allowed(chapter,s.unit_id,s.committee_id))
    or exists(select 1 from private.organization_steward_unit_assignments s where s.user_id=(select auth.uid()) and s.chapter_id=chapter and private.chapter_notice_scope_allowed(chapter,s.unit_id,null))) then
    result:=result||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('key','ready:notice-reach','group','Voice','read','get_pulse_notice_reach'));
  end if;
  if exists(select 1 from public.chapter_spaces s where s.chapter_id=chapter and s.archived_at is null and private.can_read_chapter_space(s)) then
    result:=result||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('key','ready:meeting-night-poll','group','Meetings','read','get_pulse_meeting_poll'));
  end if;
  return result;
end;
end;
$function$;
revoke all on function public.pulse_ready_chart_options() from public,anon,authenticated,service_role;
grant execute on function public.pulse_ready_chart_options() to authenticated;

create function public.get_pulse_notice_reach()
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  caller uuid:=(select auth.uid());
  org uuid:=private.current_member_organization();
  chapter text:=private.current_member_chapter();
  notice public.member_broadcasts;
  groups jsonb:='[]'::jsonb;
  rows jsonb:='[]'::jsonb;
  audience jsonb;
  readers jsonb;
  unread jsonb;
  safe boolean;
begin
  if caller is null or not private.mfa_satisfied() or not private.is_organization_member(org)
    or not private.organization_is_union(org)
    or not exists(select 1 from pg_catalog.jsonb_array_elements(public.pulse_ready_chart_options()) o where o->>'key'='ready:notice-reach') then
    return pg_catalog.jsonb_build_object('state','unavailable','notices','[]'::jsonb);
  end if;
  for notice in select b.* from public.member_broadcasts b
    where b.created_by=caller and b.organization_id=org and b.retracted_at is null
      and ((b.audience_scope='chapter' and b.chapter_id=chapter and private.chapter_notice_scope_allowed(b.chapter_id,b.access_unit_id,b.access_committee_id))
        or (b.audience_scope='organization' and private.has_organization_role(org,array['admin','vp'])))
    order by b.published_at desc,b.id desc limit 3 loop
    select coalesce(pg_catalog.jsonb_agg(m.user_id::text order by m.user_id),'[]'::jsonb),
      coalesce(pg_catalog.jsonb_agg(m.user_id::text order by m.user_id) filter(where r.user_id is not null),'[]'::jsonb),
      coalesce(pg_catalog.jsonb_agg(m.user_id::text order by m.user_id) filter(where r.user_id is null),'[]'::jsonb)
    into audience,readers,unread
    from public.organization_memberships m
    left join public.member_broadcast_receipts r on r.broadcast_id=notice.id and r.user_id=m.user_id
    where m.organization_id=org and m.status='active' and private.member_scoped_notice_in_audience(m.user_id,notice);
    groups:=groups||pg_catalog.jsonb_build_array(audience,readers,unread);
    rows:=rows||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',notice.id,'title',notice.title,'publishedAt',notice.published_at,
      'audience',pg_catalog.jsonb_array_length(audience),'read',pg_catalog.jsonb_array_length(readers),'unread',pg_catalog.jsonb_array_length(unread)));
  end loop;
  if pg_catalog.jsonb_array_length(rows)=0 then return pg_catalog.jsonb_build_object('state','missing','notices',rows); end if;
  safe:=private.pulse_release_safe(org,groups);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',r->'id','title',r->'title','publishedAt',r->'publishedAt',
    'state',case when not safe then 'withheld' when (r->>'audience')::integer=0 then 'no_eligible_records' else 'ready' end,
    'audience',case when safe then r->'audience' end,'read',case when safe then r->'read' end,'unread',case when safe then r->'unread' end,
    'percentage',case when safe and (r->>'audience')::integer>0 then pg_catalog.round(100.0*(r->>'read')::numeric/(r->>'audience')::numeric,2) end) order by n)
    into rows from pg_catalog.jsonb_array_elements(rows) with ordinality as x(r,n);
  return pg_catalog.jsonb_build_object('state',case when safe then 'ready' else 'withheld' end,'notices',rows);
end;
end;
$function$;
revoke all on function public.get_pulse_notice_reach() from public,anon,authenticated,service_role;
grant execute on function public.get_pulse_notice_reach() to authenticated;

create function public.get_pulse_meeting_poll(p_poll_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
declare
  caller uuid:=(select auth.uid());
  org uuid:=private.current_member_organization();
  chapter text:=private.current_member_chapter();
  poll public.chapter_channel_polls;
  groups jsonb;
  options jsonb;
  mine uuid;
  safe boolean;
  total integer;
begin
  if caller is null or not private.mfa_satisfied() or not private.is_organization_member(org) then
    return pg_catalog.jsonb_build_object('state','unavailable'); end if;
  select p.* into poll from public.chapter_channel_polls p join public.chapter_spaces s on s.id=p.space_id
    join public.chapters c on c.id=p.chapter_id and c.organization_id=org
    where p.chapter_id=chapter and s.archived_at is null and private.can_read_chapter_space(s)
      and ((p_poll_id is not null and p.id=p_poll_id) or (p_poll_id is null and (p.closes_at is null or p.closes_at>pg_catalog.now())))
    order by p.created_at desc,p.id desc limit 1;
  if poll.id is null then
    -- Explicit foreign, inaccessible and missing IDs have identical responses.
    return pg_catalog.jsonb_build_object('state',case when p_poll_id is null then 'missing' else 'unavailable' end); end if;
  select v.option_id into mine from public.chapter_channel_poll_votes v where v.poll_id=poll.id and v.user_id=caller;
  select coalesce(pg_catalog.jsonb_agg(cell.people order by cell.position,cell.id),'[]'::jsonb),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',cell.id,'label',cell.label,'position',cell.position,'votes',pg_catalog.jsonb_array_length(cell.people)) order by cell.position,cell.id),'[]'::jsonb)
  into groups,options from (
    select o.id,o.label,o.position,coalesce(pg_catalog.jsonb_agg(v.user_id::text order by v.user_id) filter(where v.user_id is not null),'[]'::jsonb) people
    from public.chapter_channel_poll_options o left join public.chapter_channel_poll_votes v on v.poll_id=o.poll_id and v.option_id=o.id
    where o.poll_id=poll.id group by o.id,o.label,o.position
  ) cell;
  select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(g)),0)::integer into total from pg_catalog.jsonb_array_elements(groups) g;
  -- Never relay the existing un-floored tally, including its platform branch.
  safe:=not private.chapter_belongs_to_platform(poll.chapter_id) and pg_catalog.jsonb_array_length(options)>=2;
  if safe then safe:=private.pulse_release_safe(org,groups); end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',o->'id','label',o->'label','position',o->'position',
    'votes',case when safe then o->'votes' end,'percentage',case when safe and total>0 then pg_catalog.round(100.0*(o->>'votes')::numeric/total,2) end) order by n),'[]'::jsonb)
    into options from pg_catalog.jsonb_array_elements(options) with ordinality as x(o,n);
  return pg_catalog.jsonb_build_object('state',case when not safe then 'withheld' when total=0 then 'no_eligible_records' else 'ready' end,
    'label',case when p_poll_id is null then 'Live chapter poll' else 'Meeting night poll' end,
    'pollId',poll.id,'question',poll.question,'closesAt',poll.closes_at,'mine',mine,'options',options,'total',case when safe then total end);
end;
end;
$function$;
revoke all on function public.get_pulse_meeting_poll(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_pulse_meeting_poll(uuid) to authenticated;
commit;
