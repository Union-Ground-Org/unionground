-- BUG-UG-BROADCAST-READ-COUNTS-FOR-PER-RECEIPT-READ-SLOW-AT-SCALE-20261106
-- (#7357); stamp reserved by .
-- public.get_broadcast_read_counts_for, the steward desk's read counts for a
-- page of up to 100 broadcasts, took 4.4 s for a steward on SAMPLE (1,002
-- accounts, about two years of history). For each broadcast asked for it
-- called private.member_notice_read_count, which ran the security-definer
-- audience check private.member_scoped_notice_in_audience (and through it
-- private.member_notice_in_audience) once per receipt, so an organization
-- notice read by most of 1,000 members cost about 2,000 definer calls; and it
-- ran private.can_read_member_broadcast and the publisher checks once per
-- broadcast asked for.
-- The body now takes the caller's readable broadcasts among those asked for
-- once from private.visible_member_broadcast_ids (the exact set form of
-- private.can_read_member_broadcast that the broadcast read policy uses),
-- runs the publisher checks once per distinct chapter, unit and committee,
-- and counts their receipts in one aggregate with the audience predicate of
-- private.member_scoped_notice_in_audience written as set joins, as
-- 20261106223000 did for public.get_broadcast_read_counts. The guards, the
-- broadcasts listed, their order and every count are unchanged; the result
-- carries counts only, never reader identities.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Replace only the exact predecessor 20261102005607 installed.
do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_broadcast_read_counts_for(text[])'::regprocedure)) <> '74fc20636ca92e3a044b73b4205b2891' then
    raise exception 'unreviewed predecessor: public.get_broadcast_read_counts_for' using errcode = '55000';
  end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind = 'function' and schema_name = 'public' and object_name = 'get_broadcast_read_counts_for(p_broadcast_ids text[])' and definition_hash <> '74fc20636ca92e3a044b73b4205b2891') then
    raise exception 'stale trigger receipt: public.get_broadcast_read_counts_for' using errcode = '55000';
  end if;
end;
$preflight$;

create or replace function public.get_broadcast_read_counts_for(p_broadcast_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
  publisher_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null
     or not (private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp']) or private.chapter_office_role_present(private.current_member_chapter(),'notices')) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_broadcast_ids is null
     or pg_catalog.cardinality(p_broadcast_ids) < 1
     or pg_catalog.cardinality(p_broadcast_ids) > 100 then
    raise exception 'between 1 and 100 broadcast ids' using errcode = '22023';
  end if;
  if publisher_org is null then
    return '[]'::jsonb;
  end if;

  with readable as materialized (
    -- The caller's readable broadcasts among those asked for, once: the exact
    -- set form of private.can_read_member_broadcast.
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id
    from public.member_broadcasts b
    where b.id = any(p_broadcast_ids)
      and b.organization_id = publisher_org
      and b.id in (select private.visible_member_broadcast_ids())
  ),
  publisher_scope as materialized (
    -- The chapter publisher checks once per chapter, unit and committee.
    select s.chapter_id, s.access_unit_id, s.access_committee_id,
      (private.member_has_chapter_role(s.chapter_id,array['steward','admin','vp']) or private.chapter_officer_can_for_scope(s.chapter_id,'notices',s.access_unit_id,s.access_committee_id)) as allowed
    from (
      select distinct readable.chapter_id, readable.access_unit_id, readable.access_committee_id
      from readable
      where readable.audience_scope = 'chapter'
    ) s
  ),
  organization_publisher as materialized (
    select private.has_organization_role(publisher_org,array['steward','admin','vp']) as allowed
  ),
  asked as materialized (
    select b.id, b.published_at, b.chapter_id, b.audience_scope, b.access_unit_id, b.access_committee_id
    from readable b
    left join publisher_scope s
      on b.audience_scope = 'chapter'
     and s.chapter_id = b.chapter_id
     and s.access_unit_id is not distinct from b.access_unit_id
     and s.access_committee_id is not distinct from b.access_committee_id
    cross join organization_publisher o
    where (b.audience_scope = 'chapter' and s.allowed) or (b.audience_scope = 'organization' and o.allowed)
  ),
  reads as (
    -- Receipts from readers still in the notice's audience: the predicate of
    -- private.member_scoped_notice_in_audience, counted in one pass.
    select b.id, pg_catalog.count(*) as read_count
    from asked b
    join public.member_broadcast_receipts r on r.broadcast_id = b.id
    where exists (
        select 1
        from public.organization_memberships om
        where om.user_id = r.user_id
          and om.organization_id = publisher_org
          and om.status = 'active'
      )
      and (
        b.audience_scope = 'organization'
        or exists (
          select 1
          from public.member_chapter_memberships m
          where m.user_id = r.user_id
            and m.chapter_id = b.chapter_id
            and m.status = 'active'
        )
      )
      and (
        (b.access_unit_id is null and b.access_committee_id is null)
        or exists (
          select 1
          from private.chapter_unit_members m
          where m.unit_id = b.access_unit_id
            and m.chapter_id = b.chapter_id
            and m.user_id = r.user_id
        )
        or exists (
          select 1
          from private.chapter_committees c
          join private.chapter_committee_members m on m.committee_id = c.id and m.chapter_id = c.chapter_id
          where c.id = b.access_committee_id
            and c.chapter_id = b.chapter_id
            and m.user_id = r.user_id
            and c.starts_on <= current_date
            and (c.ends_on is null or c.ends_on >= current_date)
        )
      )
    group by b.id
  )
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', b.id,
      'readCount', coalesce(reads.read_count, 0)
    ) order by b.published_at desc
  ), '[]'::jsonb)
  into result
  from asked b
  left join reads on reads.id = b.id;

  return result;
end;
$function$;
revoke all on function public.get_broadcast_read_counts_for(text[]) from public, anon;
grant execute on function public.get_broadcast_read_counts_for(text[]) to authenticated, service_role;

-- A function the account-lifecycle trigger surface reaches keeps a current
-- receipt; an absent receipt stays absent.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_broadcast_read_counts_for(text[])'::regprocedure))
 where reviewed.kind = 'function' and reviewed.schema_name = 'public'
   and reviewed.table_name = ''
   and reviewed.object_name = 'get_broadcast_read_counts_for(p_broadcast_ids text[])';

notify pgrst, 'reload schema';
commit;
