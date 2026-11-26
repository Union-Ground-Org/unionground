-- REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: a case's
-- deadlines on the clock of the group the case belongs to.
--
-- docs/contracts/time-zones-per-group.md: a case's day, its "overdue", its
-- business days and its week are counted in its group's zone, a notice about
-- it goes out on that group's clock, and a deadline already set keeps its
-- date and the zone it was set in. Until now every one of these read New
-- York's day (private.eastern_day or the same cast by hand).
--
-- 1. Where a deadline's zone is kept. public.member_cases.time_zone is the
--    zone the case's dates are counted in: set when the case is created and
--    again whenever its deadline is set or changed, and kept otherwise.
--    public.casework_deadlines.time_zone is the zone a step deadline's day is
--    counted in: set when it is created and whenever its moment moves. Both
--    are written only by a BEFORE trigger, from the group's zone through
--    private.record_time_zone. Every row that exists keeps New York's zone,
--    the zone it was set in.
--
-- 2. private.record_time_zone(organization, chapter, unit) is
--    private.group_time_zone for a stored record: it never refuses. A record
--    whose chapter is not in its organization is counted on the
--    organization's zone, and a record with no organization on New York's,
--    as before. While features.governance.group_time_zones is held it
--    answers New York's zone, like private.group_time_zone.
--
-- 3. Every reader of those deadlines now counts on the stored zone: the
--    member and staff deadline notice sweeps, the next-due day, the steward's
--    deadline board, the coordinator's due-this-week filter and KPIs, the
--    next-action and attention queues, the president's overdue list and its
--    review mark, case help, case strength, the staff notice marks' reset, a
--    case note's day, and the range checks on a new case's dates. A step's
--    deadline is set on the group's zone at that moment, and the business-day
--    helper takes that zone (private.casework_add_business_days gains a zone
--    argument; its one caller passes it).
--
-- 4. Gate round 1 (stage 560). The staff queues and case strength count a
--    next deadline's days on that deadline's own zone
--    (private.case_next_deadline, which replaces
--    private.case_signals_next_due), never one deadline's date against
--    another zone's today. The advisor overview, workload rebalancing and the
--    case-deadline automation triggers read each case's stored zone too. A
--    deadline's undo fingerprint leaves the zone out (it only ever moves with
--    the deadline), so practice actions recorded before this migration still
--    undo, and an undo puts back the zone the restored deadline was set in
--    (private.restore_case_deadline_zone). A member's own intake checks its
--    incident date on the member's group.
--
-- Nothing changes while the switch is held: every zone read here answers
-- New York's, as every day did before. The overdue test, its notices and the
-- staff notices move together, so a notice can never be counted on another
-- day than the deadline it warns of. The ULP and retaliation deadlines, the
-- committee windows and dues follow in later parts.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Every body below is replaced from the definition Main holds; refuse a
-- database where one has changed since.
do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.case_deadline_notice_sweep()'::regprocedure)
     is distinct from 'f0cb6285ef7e4aff068ca878839ccfda' then
    raise exception 'unreviewed predecessor: private.case_deadline_notice_sweep()' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.staff_deadline_notice_sweep()'::regprocedure)
     is distinct from 'c7a7b6581337f633e944902bfba4218f' then
    raise exception 'unreviewed predecessor: private.staff_deadline_notice_sweep()' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.list_steward_case_deadlines()'::regprocedure)
     is distinct from 'fcfba3faba3e9591e5e1484a9bb4bbcf' then
    raise exception 'unreviewed predecessor: public.list_steward_case_deadlines()' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.list_coordinator_cases(text,date,uuid,integer)'::regprocedure)
     is distinct from '0345056bb368bac157ee62504d7bf942' then
    raise exception 'unreviewed predecessor: public.list_coordinator_cases(text,date,uuid,integer)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_case_queue_next_actions(text,integer)'::regprocedure)
     is distinct from 'ec8549e48fc68188116b3c843809ef4c' then
    raise exception 'unreviewed predecessor: public.get_case_queue_next_actions(text,integer)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_steward_attention_queue(text)'::regprocedure)
     is distinct from '42eac9095d30ddb348937a6d1aa6180d' then
    raise exception 'unreviewed predecessor: public.get_steward_attention_queue(text)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_coordinator_kpis()'::regprocedure)
     is distinct from '40ba1c7b4dbef3951d362312fd46acee' then
    raise exception 'unreviewed predecessor: public.get_coordinator_kpis()' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_vp_overview()'::regprocedure)
     is distinct from '511dabeea29334d40e8d1d79aebdcd3e' then
    raise exception 'unreviewed predecessor: public.get_vp_overview()' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.mark_vp_case_reviewed(uuid)'::regprocedure)
     is distinct from '7a4c39eebe2ae591d51c2cd2e238148c' then
    raise exception 'unreviewed predecessor: public.mark_vp_case_reviewed(uuid)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_compass_case_context(uuid)'::regprocedure)
     is distinct from 'f7c7be37de1aff761a2951f66ee77b82' then
    raise exception 'unreviewed predecessor: public.get_compass_case_context(uuid)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.casework_suggest_case_strength(uuid,text)'::regprocedure)
     is distinct from '2e23c82792cfac8956215e0258c8ac09' then
    raise exception 'unreviewed predecessor: public.casework_suggest_case_strength(uuid,text)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.capture_casework_record_version()'::regprocedure)
     is distinct from '6d680c056ed380e4341cd68d7eca416a' then
    raise exception 'unreviewed predecessor: private.capture_casework_record_version()' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.casework_advance_step(uuid,text,text,text,uuid)'::regprocedure)
     is distinct from '6d708b16b1d734cdc952a8de320b8549' then
    raise exception 'unreviewed predecessor: public.casework_advance_step(uuid,text,text,text,uuid)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.steward_add_case_note(uuid,text,date)'::regprocedure)
     is distinct from 'e354c70d6b98182936735dc4049cc539' then
    raise exception 'unreviewed predecessor: public.steward_add_case_note(uuid,text,date)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.create_member_case(text,date,text,text)'::regprocedure)
     is distinct from 'd9a649df38b718df6bc49612f9b9c5de' then
    raise exception 'unreviewed predecessor: public.create_member_case(text,date,text,text)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.open_member_case(uuid,text,text,text,date,text,date,text,text,boolean)'::regprocedure)
     is distinct from '5d91a88f9a9aa77597441134448464bf' then
    raise exception 'unreviewed predecessor: public.open_member_case(uuid,text,text,text,date,text,date,text,text,boolean)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_organization_analytics_workspace()'::regprocedure)
     is distinct from '7732aebe672be578a7f20273952492fe' then
    raise exception 'unreviewed predecessor: public.get_organization_analytics_workspace()' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_advisor_overview()'::regprocedure)
     is distinct from 'eff97d6ddf7dc82c7f9ee5ab6e4e578f' then
    raise exception 'unreviewed predecessor: public.get_advisor_overview()' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.workload_rebalancing(text)'::regprocedure)
     is distinct from '5b78244b0099836219f91186e35c6745' then
    raise exception 'unreviewed predecessor: private.workload_rebalancing(text)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.automation_v2_candidates(uuid,boolean)'::regprocedure)
     is distinct from '11dd98d1591b87b226849d56013cc170' then
    raise exception 'unreviewed predecessor: private.automation_v2_candidates(uuid,boolean)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.cr108_candidate_count(uuid,uuid,text,integer)'::regprocedure)
     is distinct from '6a0ef566abaa8bd7778c85899c274b03' then
    raise exception 'unreviewed predecessor: private.cr108_candidate_count(uuid,uuid,text,integer)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.cr108_candidate_sources(uuid,uuid,text,integer,integer)'::regprocedure)
     is distinct from '7885522fdc7887fe4abcc4c2fb825b96' then
    raise exception 'unreviewed predecessor: private.cr108_candidate_sources(uuid,uuid,text,integer,integer)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_member_home_bootstrap(timestamp with time zone,text[])'::regprocedure)
     is distinct from '6ebc247b9d04fb7f35972b12bce7b4b0' then
    raise exception 'unreviewed predecessor: public.get_member_home_bootstrap(timestamp with time zone,text[])' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.learning_casework_stable(text,jsonb)'::regprocedure)
     is distinct from '177ec01fd372cc5846609c64abc6c3d5' then
    raise exception 'unreviewed predecessor: private.learning_casework_stable(text,jsonb)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.learning_undo_casework(text,jsonb)'::regprocedure)
     is distinct from 'be62e5b6688927dab0eea29332e38e4f' then
    raise exception 'unreviewed predecessor: private.learning_undo_casework(text,jsonb)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.learning_undo_case(text,jsonb)'::regprocedure)
     is distinct from '447d605024cbd7e484f71834220e1f95' then
    raise exception 'unreviewed predecessor: private.learning_undo_case(text,jsonb)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.casework_add_business_days(timestamp with time zone,integer,uuid)'::regprocedure)
     is distinct from '51b3538ec6438ae79fd3ac35d8cf1b6e' then
    raise exception 'unreviewed predecessor: private.casework_add_business_days(timestamp with time zone,integer,uuid)' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.case_signals_next_due(uuid,date)'::regprocedure)
     is distinct from '6767eca3deec6e72f04083651d20cd4d' then
    raise exception 'unreviewed predecessor: private.case_signals_next_due(uuid,date)' using errcode = '55000';
  end if;
end
$preflight$;

-- The zone of a stored record's group, never a refusal: the sweeps and
-- triggers that call it must not stop on one record.
create function private.record_time_zone(p_organization_id uuid, p_chapter_id text default null, p_unit_id uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  organization_key uuid := p_organization_id;
  chapter_key text;
  unit_key uuid;
begin
  if organization_key is null and p_chapter_id is not null then
    select c.organization_id into organization_key from public.chapters c where c.id = p_chapter_id;
  end if;
  if organization_key is null or not exists (select 1 from public.organizations o where o.id = organization_key) then
    return 'America/New_York'; -- fixed-zone: a record with no organization has no group, and keeps the zone every record had
  end if;
  select c.id into chapter_key from public.chapters c where c.id = p_chapter_id and c.organization_id = organization_key;
  if chapter_key is not null and p_unit_id is not null then
    select u.id into unit_key from private.chapter_units u
     where u.id = p_unit_id and u.chapter_id = chapter_key and u.organization_id = organization_key;
  end if;
  return private.group_time_zone(organization_key, chapter_key, unit_key);
end;
$function$;

-- Every case and step deadline that exists was set on New York's zone. The
-- constant default fills existing rows without rewriting them. The trigger
-- below writes every new value; only a write made with triggers switched off
-- (session_replication_role replica: bulk seeds and proofs) takes the
-- default, which is right while the switch is held. Before the switch is
-- released those writers set the zone themselves (part 7 of #9446).
alter table public.member_cases
  add column time_zone text not null default 'America/New_York'; -- fixed-zone: the zone every existing case was counted in
alter table public.casework_deadlines
  add column time_zone text not null default 'America/New_York'; -- fixed-zone: the zone every existing step deadline was set in

-- An undo that puts a deadline back passes the zone that deadline was set
-- in. Only definer code sets this transaction-local value (the API cannot
-- reach set_config); the trigger takes it for that one row and clears it.
create function private.restore_case_deadline_zone(p_table text, p_id uuid, p_row jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_table not in ('member_cases', 'casework_deadlines') or p_id is null then
    raise exception 'invalid deadline zone restore' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('unionground.case_deadline_zone_restore',
    pg_catalog.jsonb_build_object('table', p_table, 'id', p_id,
      'zone', coalesce(p_row ->> 'time_zone', 'America/New_York'))::text, true); -- fixed-zone: a row recorded before zones were stored was set on New York's zone
end;
$function$;

create function private.set_case_deadline_time_zone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  changed boolean;
  restore jsonb;
begin
  -- A restore passed for this row is taken now, whether or not the deadline
  -- moves, so it can never reach a later write in the same transaction.
  restore := nullif(pg_catalog.current_setting('unionground.case_deadline_zone_restore', true), '')::jsonb;
  if restore ->> 'table' = tg_table_name and (restore ->> 'id')::uuid = new.id then
    perform pg_catalog.set_config('unionground.case_deadline_zone_restore', '', true);
  else
    restore := null;
  end if;
  if tg_table_name = 'member_cases' then
    changed := tg_op = 'INSERT' or new.deadline is distinct from old.deadline;
  else
    changed := tg_op = 'INSERT' or new.due_at is distinct from old.due_at;
  end if;
  if not changed then
    new.time_zone := old.time_zone;
  else
    new.time_zone := coalesce(restore ->> 'zone', private.record_time_zone(new.organization_id, new.chapter_id));
  end if;
  return new;
end;
$function$;

-- A case's next deadline: the earliest open step deadline when it comes
-- first, else the case's own deadline; its day and its days left are counted
-- on that deadline's own zone, so a case and a step deadline set in two zones
-- are never mixed. Used by the staff queues and the case's next due day.
create function private.case_next_deadline(p_case_id uuid, p_case_deadline date, p_case_time_zone text)
returns table(due_on date, days integer, kind text, label text)
language sql
stable
security definer
set search_path = ''
as $function$
  with step as (
    select private.local_day(d.time_zone, d.due_at) as due_on,
           private.local_day(d.time_zone, d.due_at) - private.local_day(d.time_zone, pg_catalog.now()) as days,
           d.label
      from public.casework_deadlines d
     where d.case_id = p_case_id and d.status in ('active', 'extended', 'missed')
     order by d.due_at, d.id
     limit 1
  ), own as (
    select p_case_deadline as due_on, p_case_deadline - private.local_day(p_case_time_zone, pg_catalog.now()) as days
     where p_case_deadline is not null
  )
  select s.due_on, s.days, 'step'::text, s.label from step s
   where not exists (select 1 from own o where o.days <= s.days)
  union all
  select o.due_on, o.days, 'case'::text, null::text from own o
   where not exists (select 1 from step s where s.days < o.days);
$function$;

-- After member_cases_bind_organization, which fills a new case's
-- organization and chapter (triggers of one kind fire in name order).
create trigger member_cases_time_zone
  before insert or update on public.member_cases
  for each row execute function private.set_case_deadline_time_zone();
create trigger casework_deadlines_time_zone
  before insert or update on public.casework_deadlines
  for each row execute function private.set_case_deadline_time_zone();

revoke all on function private.record_time_zone(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.set_case_deadline_time_zone() from public, anon, authenticated, service_role;
revoke all on function private.restore_case_deadline_zone(text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.case_next_deadline(uuid, date, text) from public, anon, authenticated, service_role;

-- Business days are counted on the zone the deadline is set in, which the
-- one caller passes; the form without a zone goes.
drop function private.casework_add_business_days(timestamptz, integer, uuid);

create function private.casework_add_business_days(p_start timestamptz, p_count integer, p_organization_id uuid, p_time_zone text)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare v_date timestamp; v_left integer := p_count;
  v_start date; v_extra integer;
begin
  if p_start is null or not isfinite(p_start) or p_count is null or p_count < 0 or p_organization_id is null
     or p_time_zone is null then
    raise exception 'invalid business-day input' using errcode = '22023';
  end if;
  v_date := private.local_day(p_time_zone, p_start)::timestamp;
  -- Whole weeks are arithmetic. Each subsequent iteration accounts only for
  -- holidays crossed by the previous extension, never loops once per day.
  while v_left > 0 loop
    v_start := v_date::date;
    if extract(isodow from v_date) >= 6 then
      v_date := v_date + ((8 - extract(isodow from v_date)::integer) * interval '1 day');
      v_left := v_left - 1;
    end if;
    v_date := v_date + ((v_left / 5)::bigint * 7 * interval '1 day');
    v_extra := v_left % 5;
    if extract(isodow from v_date)::integer + v_extra > 5 then v_extra := v_extra + 2; end if;
    v_date := v_date + (v_extra * interval '1 day');
    select count(*)::integer into v_left from public.organization_holidays h
      where h.organization_id = p_organization_id and h.holiday_date > v_start
        and h.holiday_date <= v_date::date and extract(isodow from h.holiday_date) < 6;
  end loop;
  return (v_date::date + time '23:59:59') at time zone p_time_zone;
end;
$function$;

revoke all on function private.casework_add_business_days(timestamptz, integer, uuid, text) from public, anon, authenticated, service_role;

-- No caller is left: the staff queues read private.case_next_deadline.
drop function private.case_signals_next_due(uuid, date);


-- private.case_deadline_notice_sweep
CREATE OR REPLACE FUNCTION private.case_deadline_notice_sweep()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  r record;
begin
  for r in
    select c.id, c.user_id, (c.deadline - private.local_day(c.time_zone, pg_catalog.now())) as days_left
    from public.member_cases c
    where c.status = 'active' and c.learning_undone_at is null
      and c.deadline is not null
      and (c.deadline - private.local_day(c.time_zone, pg_catalog.now())) between 0 and 7
      and (
        ((c.deadline - private.local_day(c.time_zone, pg_catalog.now())) <= 1 and c.deadline_notice_1_sent_at is null)
        or ((c.deadline - private.local_day(c.time_zone, pg_catalog.now())) between 2 and 3 and c.deadline_notice_3_sent_at is null)
        or ((c.deadline - private.local_day(c.time_zone, pg_catalog.now())) between 4 and 7 and c.deadline_notice_7_sent_at is null)
      )
    for update skip locked
  loop
    if r.days_left <= 1 then
      update public.member_cases
        set deadline_notice_1_sent_at = now(),
            deadline_notice_3_sent_at = coalesce(deadline_notice_3_sent_at, now()),
            deadline_notice_7_sent_at = coalesce(deadline_notice_7_sent_at, now())
        where id = r.id;
      perform private.notify_member(
        r.user_id,
        case when r.days_left <= 0 then 'deadline.case.today' else 'deadline.case.tomorrow' end,
        '{}'::jsonb, 'deadlines');
    elsif r.days_left <= 3 then
      update public.member_cases
        set deadline_notice_3_sent_at = now(),
            deadline_notice_7_sent_at = coalesce(deadline_notice_7_sent_at, now())
        where id = r.id;
      perform private.notify_member(
        r.user_id, 'deadline.case.days',
        pg_catalog.jsonb_build_object('days', r.days_left::text), 'deadlines');
    else
      update public.member_cases
        set deadline_notice_7_sent_at = now()
        where id = r.id;
      perform private.notify_member(
        r.user_id, 'deadline.case.days',
        pg_catalog.jsonb_build_object('days', r.days_left::text), 'deadlines');
    end if;
  end loop;
  begin
    perform private.staff_deadline_notice_sweep();
  exception
    when query_canceled then
      raise;
    when others then
      raise warning 'staff_deadline_notice_sweep failed: % (%)', sqlerrm, sqlstate;
  end;
end;
end;
$function$;

-- private.staff_deadline_notice_sweep
CREATE OR REPLACE FUNCTION private.staff_deadline_notice_sweep()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_deadline record;
  v_today date;
  v_recipient uuid;
  v_sent integer;
  v_read integer;
  v_batch_rows integer;
  v_batch_size integer;
  v_max_rows integer;
  v_after_due date;
  v_after_source text;
  v_after_id uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  -- Only the clean-up of old marks and the outer bound on a case's
  -- deadline read one day for everyone; their margins (a week, two days)
  -- cover every zone's day, which is never more than one day from it.
  v_today := (pg_catalog.now() at time zone 'America/New_York')::date; -- fixed-zone: clean-up horizon and outer index bound only, with margins past any zone's day
  v_sent := 0;
  v_read := 0;
  -- The case-graph lock is held for this transaction, so one run reads at
  -- most v_max_rows due deadlines in keyset batches. Only work that is due
  -- (inside the organization's window and not yet announced at today's
  -- stage) is read; switched-off organizations never enter the scan. Nearer
  -- deadlines come first and the remainder is reached on the next run.
  v_batch_size := 100;
  v_max_rows := 500;
  v_after_due := '-infinity'::date;
  v_after_source := '';
  v_after_id := '00000000-0000-0000-0000-000000000000'::uuid;
  delete from private.staff_deadline_notice_marks mark
   where mark.due_on < v_today - 7;
  loop
    v_batch_rows := 0;
    for v_deadline in
      select candidate.source, candidate.deadline_id, candidate.case_id,
             candidate.organization_id, candidate.owner_id,
             candidate.steward_user_id, candidate.coordinator_user_id,
             candidate.due_on, stage.days, stage.stage
        from (
          select 'member_case'::text as source, c.id as deadline_id, c.id as case_id,
                 c.organization_id, c.user_id as owner_id,
                 c.steward_user_id, c.coordinator_user_id, c.deadline as due_on,
                 private.local_day(c.time_zone, pg_catalog.now()) as today
            from public.member_cases c
           where c.status = 'active'
             -- A constant range keeps the (status, deadline) index (#9678
             -- round 1); the day in the case's own zone decides.
             and c.deadline between v_today - 2 and v_today + 32
             and c.deadline between private.local_day(c.time_zone, pg_catalog.now()) and private.local_day(c.time_zone, pg_catalog.now()) + 30
             and (c.steward_user_id is not null or c.coordinator_user_id is not null)
             and private.organization_feature_enabled(c.organization_id, 'features.notifications.steward_deadline_reminders')
          union all
          select 'casework_deadline', d.id, c.id,
                 c.organization_id, c.user_id,
                 c.steward_user_id, c.coordinator_user_id, private.local_day(d.time_zone, d.due_at),
                 private.local_day(d.time_zone, pg_catalog.now())
            from public.casework_deadlines d
            join public.member_cases c on c.id = d.case_id and c.organization_id = d.organization_id
           where d.status in ('active', 'extended')
             and c.status = 'active'
             -- A wide window on the moment keeps the index; the day in the
             -- deadline's own zone decides.
             and d.due_at >= pg_catalog.now() - interval '2 days'
             and d.due_at < pg_catalog.now() + interval '33 days'
             and private.local_day(d.time_zone, d.due_at) between private.local_day(d.time_zone, pg_catalog.now()) and private.local_day(d.time_zone, pg_catalog.now()) + 30
             and (c.steward_user_id is not null or c.coordinator_user_id is not null)
             and private.organization_feature_enabled(c.organization_id, 'features.notifications.steward_deadline_reminders')
        ) candidate
        cross join lateral (
          select candidate.due_on - candidate.today as days,
                 (case
                    when candidate.due_on - candidate.today <= 0 then 3
                    when candidate.due_on - candidate.today = 1 then 2
                    when candidate.due_on - candidate.today <= least(greatest(coalesce(private.organization_limit(
                      candidate.organization_id, 'limits.notifications.steward_deadline_reminder_days'), 3), 1), 30) then 1
                  end)::smallint as stage
        ) stage
       where stage.stage is not null
         and (candidate.due_on, candidate.source, candidate.deadline_id)
             > (v_after_due, v_after_source, v_after_id)
         and not exists (
           select 1 from private.staff_deadline_notice_marks mark
            where mark.source = candidate.source
              and mark.deadline_id = candidate.deadline_id
              and mark.due_on = candidate.due_on
              and mark.eastern_day
              and mark.stage >= stage.stage
         )
       order by candidate.due_on, candidate.source, candidate.deadline_id
       limit least(v_batch_size, v_max_rows - v_read)
    loop
      v_batch_rows := v_batch_rows + 1;
      v_read := v_read + 1;
      v_after_due := v_deadline.due_on;
      v_after_source := v_deadline.source;
      v_after_id := v_deadline.deadline_id;
      insert into private.staff_deadline_notice_marks as mark (source, deadline_id, due_on, stage, marked_at, eastern_day)
      values (v_deadline.source, v_deadline.deadline_id, v_deadline.due_on, v_deadline.stage, pg_catalog.clock_timestamp(), true)
      on conflict (source, deadline_id, due_on) do update
        set stage = excluded.stage, marked_at = pg_catalog.clock_timestamp(), eastern_day = true
        where not mark.eastern_day or mark.stage < excluded.stage;
      if not found then
        continue;
      end if;
      for v_recipient in
        select distinct assignee.user_id
          from (values (v_deadline.steward_user_id), (v_deadline.coordinator_user_id)) as assignee(user_id)
         where assignee.user_id is not null
           -- The case owner already gets the member deadline notice.
           and not (v_deadline.source = 'member_case' and assignee.user_id = v_deadline.owner_id)
      loop
        if private.casework_reminder_owner_can_read(v_recipient, v_deadline.case_id) then
          perform private.notify_member(
            v_recipient,
            case v_deadline.stage when 3 then 'deadline.staff.today' when 2 then 'deadline.staff.tomorrow' else 'deadline.staff.days' end,
            case when v_deadline.stage = 1 then pg_catalog.jsonb_build_object('days', v_deadline.days::text) else '{}'::jsonb end,
            'deadlines');
          v_sent := v_sent + 1;
        end if;
      end loop;
    end loop;
    exit when v_batch_rows < v_batch_size or v_read >= v_max_rows;
  end loop;
  return v_sent;
end;
$function$;

-- public.list_steward_case_deadlines
CREATE OR REPLACE FUNCTION public.list_steward_case_deadlines()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_build_object(
      'truncated', pg_catalog.count(*) > 100,
      'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'caseId', due.case_id, 'reference', due.reference,
      'title', private.case_row_title(due.case_id), 'topicShown', private.case_row_topic_shown(due.case_id),
      'caseType', due.case_type, 'step', due.step,
      'kind', due.kind, 'label', due.label, 'dueOn', due.due_on,
      'overdue', due.overdue,
      'afterStepDue', due.after_step_due
    ) order by due.due_on, due.reference, due.kind) filter (where due.position <= 100), '[]'::jsonb))
    from (
      select merged.*, pg_catalog.row_number() over (order by merged.due_on, merged.reference, merged.kind) as position
      from (
        -- A clock is overdue once its moment has passed or the sweep has
        -- marked it missed (20261002143000), whatever the calendar day.
        select c.id as case_id, c.reference, c.case_type, c.step, d.kind, d.label,
               private.local_day(d.time_zone, d.due_at) as due_on,
               (d.due_at < pg_catalog.now() or d.status = 'missed') as overdue,
               false as after_step_due
        from public.member_cases c
        join public.casework_deadlines d on d.case_id = c.id and d.status in ('active', 'extended', 'missed')
        where c.steward_user_id = caller and c.status = 'active'
          and private.casework_staff_can_access(c.id)
        union all
        -- The case's own deadline is a date: overdue from the next day in its zone.
        select c.id, c.reference, c.case_type, c.step, 'case', 'Case deadline', c.deadline,
               c.deadline < private.local_day(c.time_zone, pg_catalog.now()),
               exists (
                 select 1 from public.casework_deadlines step
                 where step.case_id = c.id and step.status in ('active', 'extended', 'missed') and step.kind = 'procedure'
                   and private.local_day(step.time_zone, step.due_at) < c.deadline)
        from public.member_cases c
        where c.steward_user_id = caller and c.status = 'active' and c.deadline is not null
          and private.casework_staff_can_access(c.id)
      ) merged
      order by merged.due_on, merged.reference, merged.kind
      limit 101
    ) due
  ), pg_catalog.jsonb_build_object('truncated', false, 'rows', '[]'::jsonb));
end;
$function$;

-- public.list_coordinator_cases
CREATE OR REPLACE FUNCTION public.list_coordinator_cases(p_focus text DEFAULT 'all'::text, p_after_deadline date DEFAULT NULL::date, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 200)
 RETURNS SETOF public.member_cases
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 200), 1), 200);
begin
  if (select auth.uid()) is null or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  if p_focus not in ('all', 'due', 'arbitration') then
    raise exception 'unknown focus' using errcode = '22023';
  end if;

  -- Tenant bound copied from private.casework_dashboard_open_cases
  -- (20260917142000) / public.get_coordinator_kpis (PR #2171) and MUST stay
  -- in sync with both. Applied before the remaining focus and keyset
  -- predicates so the RLS-visible read visits another chapter's case only
  -- when the caller holds an active grant for it and staff_can_see_user
  -- admits them (20261022053100). Due window is the Eastern day + 6: seven days
  -- inclusive of today (#8568).
  return query
  select c.*
  from public.member_cases c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and (
      (c.organization_id = (select private.current_member_organization())
        and c.chapter_id = (select private.current_member_chapter()))
      or (
        c.id in (
          select g.case_id
          from public.casework_access_grants g
          where g.grantee_user_id = (select auth.uid())
            and g.revoked_at is null
        )
        and public.staff_can_see_user(c.user_id, 'coordinator')
        and private.casework_staff_can_access(c.id)
      )
    )
    and (p_focus <> 'due' or (c.deadline is not null
      and c.deadline between (pg_catalog.now() at time zone c.time_zone)::date and (pg_catalog.now() at time zone c.time_zone)::date + 6))
    and (p_focus <> 'arbitration' or (c.step ~* 'arb' or c.step = 'Step 4'))
    and (
      p_after_id is null
      or (p_after_deadline is not null and (
        c.deadline > p_after_deadline
        or (c.deadline = p_after_deadline and c.id > p_after_id)
        or c.deadline is null))
      or (p_after_deadline is null and c.deadline is null and c.id > p_after_id)
    )
  order by c.deadline asc nulls last, c.id asc
  limit page_limit;
end;
$function$;

-- public.get_case_queue_next_actions
CREATE OR REPLACE FUNCTION public.get_case_queue_next_actions(p_selected_hat text, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.case_signals_staff_organization(p_selected_hat);
  hat text := pg_catalog.btrim(p_selected_hat);
  lookahead integer;
  critical_days integer;
  high_days integer;
  stale_days integer;
  evidence_days integer;
  weak_below integer;
  bounded integer := greatest(1, least(coalesce(p_limit, 25), 100));
  items jsonb;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.casework.next_action_queue') then
    return pg_catalog.jsonb_build_object('enabled', false, 'items', '[]'::jsonb,
      'summary', pg_catalog.jsonb_build_object('total', 0, 'urgent', 0, 'missingOwner', 0));
  end if;
  lookahead := private.organization_limit(org, 'limits.casework.deadline_lookahead_days');
  critical_days := private.organization_limit(org, 'limits.casework.deadline_risk_critical_days');
  high_days := private.organization_limit(org, 'limits.casework.deadline_risk_high_days');
  stale_days := private.organization_limit(org, 'limits.casework.stale_contact_days');
  evidence_days := private.organization_limit(org, 'limits.casework.evidence_deadline_days');
  weak_below := private.organization_limit(org, 'limits.casework.weak_strength_threshold');

  with cases as (
    select c.id, c.user_id, c.reference, c.step, c.steward_user_id, c.deadline as case_deadline, c.time_zone,
      nd.due_on as next_due, nd.days as next_days, nd.kind as next_kind, nd.label as next_label
    from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
    left join lateral private.case_next_deadline(c.id, c.deadline, c.time_zone) nd on true
    where c.organization_id = org
      and c.status = 'active'
      and c.user_id <> caller
      and (hat <> 'steward' or c.steward_user_id = caller)
      and private.casework_staff_can_read(c.id)
  ),
  enriched as (
    select cs.*,
      -- Which deadline next_due is, and its days left on its own zone:
      -- private.case_next_deadline. The member's My cases card and Home
      -- pick the same one (src/lib/caseNextDeadline.js).
      cs.next_days as due_days,
      cs.next_kind as due_kind,
      cs.next_label as due_label,
      exists (
        select 1 from public.member_case_files f
        where f.case_id = cs.id and f.confirmed_at is not null and f.removal_requested_at is null
      ) as has_evidence,
      (
        select a.score from public.casework_strength_analyses a
        where a.case_id = cs.id
        order by a.created_at desc, a.id desc
        limit 1
      ) as strength
    from cases cs
  ),
  members as (
    select e.user_id,
      pg_catalog.count(*) as open_cases,
      (pg_catalog.array_agg(e.id order by e.due_days nulls last, e.reference))[1] as top_case,
      (pg_catalog.array_agg(e.reference order by e.due_days nulls last, e.reference))[1] as top_reference,
      (pg_catalog.array_agg(e.time_zone order by e.due_days nulls last, e.reference))[1] as top_time_zone,
      greatest(
        (select pg_catalog.max(n.created_at) from public.member_contact_notes n
          join public.chapters ch on ch.id = n.chapter_id and ch.organization_id = org
          where n.member_user_id = e.user_id),
        (select pg_catalog.max(m.created_at) from public.member_messages m
          join public.member_conversations conversation
            on conversation.id = m.conversation_id and conversation.organization_id = org
          where m.user_id = e.user_id and m.sender_kind = 'steward' and m.learning_removal_held_at is null)
      ) as last_contact
    from enriched e
    group by e.user_id
  ),
  raw_items as (
    -- Deadline risk (workflow-queues.ts:322-361): due within the lookahead,
    -- overdue always included.
    select pg_catalog.jsonb_build_object(
        'id', 'deadline_risk:' || e.id, 'kind', 'deadline_risk',
        'severity', case when e.due_days <= critical_days then 'critical' when e.due_days <= high_days then 'high' else 'medium' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'dueKind', e.due_kind, 'dueLabel', e.due_label, 'days', e.due_days) as item,
      case when e.due_days <= 0 then 500 + pg_catalog.abs(e.due_days) else 360 - e.due_days end::numeric as score
    from enriched e
    where e.due_days is not null and e.due_days <= lookahead
    union all
    -- Owner gap (unassigned case), for queue owners only.
    select pg_catalog.jsonb_build_object(
        'id', 'missing_owner:' || e.id, 'kind', 'missing_owner', 'severity', 'high',
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'dueKind', e.due_kind, 'dueLabel', e.due_label, 'days', e.due_days),
      330::numeric
    from enriched e
    where hat <> 'steward' and e.steward_user_id is null
    union all
    -- Stale member contact (workflow-queues.ts:468-541), one item per member.
    select pg_catalog.jsonb_build_object(
        'id', 'stale_contact:' || mb.user_id, 'kind', 'stale_contact', 'severity', 'medium',
        'caseId', mb.top_case, 'reference', mb.top_reference, 'memberId', mb.user_id,
        'memberName', private.member_support_member_label(mb.user_id),
        'openCases', mb.open_cases,
        'lastContactDays', case when mb.last_contact is null then null
          else private.local_day(mb.top_time_zone, pg_catalog.now()) - private.local_day(mb.top_time_zone, mb.last_contact) end),
      210 + coalesce(private.local_day(mb.top_time_zone, pg_catalog.now()) - private.local_day(mb.top_time_zone, mb.last_contact), stale_days + 1)::numeric / 100
    from members mb
    where mb.last_contact is null
       or private.local_day(mb.top_time_zone, pg_catalog.now()) - private.local_day(mb.top_time_zone, mb.last_contact) > stale_days
    union all
    -- Missing evidence before a deadline (workflow-queues.ts:543-590).
    select pg_catalog.jsonb_build_object(
        'id', 'missing_evidence:' || e.id, 'kind', 'missing_evidence',
        'severity', case when e.due_days <= 0 then 'critical' else 'high' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'dueKind', e.due_kind, 'dueLabel', e.due_label, 'days', e.due_days),
      case when e.due_days <= 0 then 440 + least(pg_catalog.abs(e.due_days), 9) else 348 - e.due_days end::numeric
    from enriched e
    where e.due_days is not null and e.due_days <= evidence_days and not e.has_evidence
    union all
    -- Weak case strength (workflow-queues.ts:603-645): scored cases only.
    select pg_catalog.jsonb_build_object(
        'id', 'weak_strength:' || e.id, 'kind', 'weak_strength',
        'severity', case when e.strength < weak_below / 2.0 then 'high' else 'medium' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'dueKind', e.due_kind, 'dueLabel', e.due_label, 'days', e.due_days, 'strength', e.strength),
      200 + greatest(0, weak_below - e.strength)::numeric / 100
    from enriched e
    where e.strength is not null and e.strength < weak_below
  ),
  ranked as (
    select r.item, r.score,
      case r.item ->> 'severity' when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end as severity_rank
    from raw_items r
  )
  select pg_catalog.jsonb_build_object(
    'enabled', true,
    'items', coalesce((
      select pg_catalog.jsonb_agg(top.item order by top.score desc, top.severity_rank desc, top.item ->> 'dueDate' nulls last, top.item ->> 'id')
      from (select * from ranked order by score desc, severity_rank desc, item ->> 'dueDate' nulls last, item ->> 'id' limit bounded) top
    ), '[]'::jsonb),
    'summary', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from ranked),
      'urgent', (select pg_catalog.count(*) from ranked where severity_rank >= 3),
      'missingOwner', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'missing_owner'),
      'staleContact', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'stale_contact'),
      'missingEvidence', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'missing_evidence'),
      'weakStrength', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'weak_strength')
    ),
    'settings', pg_catalog.jsonb_build_object('staleContactDays', stale_days, 'evidenceDays', evidence_days, 'weakStrengthBelow', weak_below)
  ) into items;
  return items;
end;
$function$;

-- public.get_steward_attention_queue
CREATE OR REPLACE FUNCTION public.get_steward_attention_queue(p_selected_hat text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.case_signals_staff_organization(p_selected_hat);
  enabled boolean;
  result jsonb;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  enabled := private.organization_feature_enabled(org, 'features.attention.guided_portal')
    and private.organization_feature_enabled(org, 'features.attention.dashboard');
  if not enabled then
    return pg_catalog.jsonb_build_object('enabled', false, 'members', '[]'::jsonb, 'count', 0,
      'memberSurfaces', false, 'navigation', false);
  end if;

  with cases as (
    select c.id, c.user_id, c.reference, c.step,
      nd.due_on as next_due, nd.days as next_days
    from public.member_cases c
    left join lateral private.case_next_deadline(c.id, c.deadline, c.time_zone) nd on true
    where c.organization_id = org
      and c.status = 'active'
      and c.user_id <> caller
      and (c.steward_user_id = caller or c.coordinator_user_id = caller)
      and private.casework_staff_can_access(c.id)
  ),
  signals as (
    select cs.*,
      cs.next_days as due_days,
      cs.next_days is not null and cs.next_days <= 3 as deadline_risk
    from cases cs
  ),
  rollup as (
    select s.user_id,
      pg_catalog.count(*) as open_cases,
      pg_catalog.bool_or(s.deadline_risk) as deadline_risk,
      (pg_catalog.array_agg(s.id order by s.deadline_risk desc, s.due_days nulls last, s.reference))[1] as top_case,
      (pg_catalog.array_agg(s.reference order by s.deadline_risk desc, s.due_days nulls last, s.reference))[1] as top_reference,
      (pg_catalog.array_agg(s.step order by s.deadline_risk desc, s.due_days nulls last, s.reference))[1] as top_step,
      (pg_catalog.array_agg(s.due_days order by s.deadline_risk desc, s.due_days nulls last, s.reference))[1] as top_days
    from signals s
    group by s.user_id
  )
  select pg_catalog.jsonb_build_object(
    'enabled', true,
    'memberSurfaces', private.organization_feature_enabled(org, 'features.attention.member_surfaces'),
    'navigation', private.organization_feature_enabled(org, 'features.attention.navigation'),
    'count', (select pg_catalog.count(*) from rollup),
    'breakdown', pg_catalog.jsonb_build_object(
      'dueSoon', (select pg_catalog.count(*) from rollup where deadline_risk),
      'openWithoutDeadlineRisk', (select pg_catalog.count(*) from rollup where not deadline_risk)
    ),
    'dominantReason', case
      when (select pg_catalog.count(*) from rollup) = 0 then null
      when (select pg_catalog.count(*) from rollup where deadline_risk) * 2 >= (select pg_catalog.count(*) from rollup) then 'deadline_risk'
      else 'open_case' end,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'memberId', r.user_id,
        'memberName', private.member_support_member_label(r.user_id),
        'openCases', r.open_cases,
        'reasons', case when r.deadline_risk then '["deadline_risk","open_case"]'::jsonb else '["open_case"]'::jsonb end,
        'urgency', case when r.deadline_risk then 90 else 60 end,
        'caseId', r.top_case, 'reference', r.top_reference, 'step', r.top_step, 'days', r.top_days
      ) order by r.deadline_risk desc, r.top_days nulls last, r.open_cases desc, r.top_reference)
      from rollup r
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

-- public.get_coordinator_kpis
CREATE OR REPLACE FUNCTION public.get_coordinator_kpis()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  open_cases integer;
  due_week integer;
  in_arb integer;
  resolved_cases integer;
  by_step jsonb;
  by_article jsonb;
begin
  if caller is null or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  if private.organization_is_platform(private.current_member_organization()) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- Caller-only and chapter/organization authority is projected once.
  with coordinator_members as materialized (
    select private.staff_visible_member_ids('coordinator') as id
  ),
  active_grants as materialized (
    select g.case_id
    from public.casework_access_grants g
    where g.grantee_user_id = (select auth.uid())
      and g.revoked_at is null
  ),
  union_organizations as materialized (
    select o.id from public.organizations o
    where private.organization_is_union(o.id)
  ),
  tenant as materialized (
    select c as case_row, c.id, c.user_id, c.organization_id, c.chapter_id,
      c.steward_user_id, c.coordinator_user_id, c.is_restricted,
      c.status, c.step, c.articles, c.deadline, c.time_zone
    from public.member_cases c
    where (select private.mfa_satisfied())
      and c.organization_id in (select id from union_organizations)
      and c.chapter_id is not null
      and (
        (c.organization_id = (select private.current_member_organization())
          and c.chapter_id = (select private.current_member_chapter()))
        or (c.id in (select case_id from active_grants)
          and c.user_id in (select id from coordinator_members))
      )
  ),
  chapter_scope as materialized (
    select chapters.chapter_id,
      private.actor_has_chapter_staff_role(caller, chapters.chapter_id) as staff,
      coalesce((select p.steward_grievances from private.chapter_access_policies p
        where p.chapter_id = chapters.chapter_id), true) as steward_grievances
    from (select distinct chapter_id from tenant) chapters
  ),
  organization_scope as materialized (
    select organizations.organization_id,
      private.has_organization_role(organizations.organization_id, array['advisor','admin','vp']) as oversight
    from (select distinct organization_id from tenant) organizations
  ),
  access as materialized (
    select t.*, chapter_scope.steward_grievances,
      (chapter_scope.staff
        and (t.steward_user_id = caller or t.coordinator_user_id = caller
          or t.user_id in (select id from coordinator_members) or organization_scope.oversight)
        and (not t.is_restricted or t.steward_user_id = caller or t.coordinator_user_id = caller
          or organization_scope.oversight or t.id in (select case_id from active_grants))) as direct_access
    from tenant t
    join chapter_scope on chapter_scope.chapter_id = t.chapter_id
    join organization_scope on organization_scope.organization_id = t.organization_id
  ),
  base as materialized (
    select t.id, t.status, t.step, t.articles, t.deadline, t.time_zone
    from access t
    where private.case_scope_and_identity_allowed(t.case_row)
      and case when t.direct_access then true else (
        t.organization_id = (select private.current_member_organization())
        and (
          (private.actor_role_covers_member(caller, t.chapter_id, 'coordinator', t.user_id, true)
            and (not t.is_restricted or t.coordinator_user_id = caller
              or t.id in (select case_id from active_grants)))
          or (t.user_id <> caller and not t.is_restricted and t.steward_grievances
            and private.chapter_grievance_steward_scope(t.chapter_id, t.user_id))
        )
      ) end
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline between private.local_day(b.time_zone, pg_catalog.now()) and private.local_day(b.time_zone, pg_catalog.now()) + 6),
    pg_catalog.count(*) filter (where b.status = 'active'
      and (b.step ~* 'arb' or b.step = 'Step 4')),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('step', s.step, 'count', s.n) order by s.n desc, s.step), '[]'::jsonb)
     from (
       select step, pg_catalog.count(*) as n
       from base
       where status = 'active'
       group by step
     ) s),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('articles', a.articles, 'count', a.n) order by a.n desc, a.articles), '[]'::jsonb)
     from (
       select articles, pg_catalog.count(*) as n
       from base
       where status = 'active' and articles <> ''
       group by articles
     ) a)
  into open_cases, due_week, in_arb, resolved_cases, by_step, by_article
  from base b;

  return pg_catalog.jsonb_build_object(
    'openCases', open_cases,
    'dueThisWeek', due_week,
    'inArbitration', in_arb,
    'resolved', resolved_cases,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'byStep', by_step,
    'byArticle', by_article);
end;
$function$;

-- public.get_vp_overview
CREATE OR REPLACE FUNCTION public.get_vp_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid;
  caller_chapter text;
  member_count integer;
  new_this_year integer;
  active_grievances integer;
  turnout jsonb;
  attention jsonb;
  upcoming jsonb;
  priorities jsonb;
  trend jsonb;
  leadership_open boolean := false;
  caller_has_scopes boolean := false;
begin
  if caller is null or not public.member_has_role(array['vp', 'admin']) then
    raise exception 'vp role required' using errcode = '42501';
  end if;

  -- Fail closed: no selected organization or chapter means no tenant to
  -- report on, never a database-wide scan.
  caller_org := private.current_member_organization();
  caller_chapter := private.current_member_chapter();
  if caller_org is null or caller_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.organization_is_union(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- The leadership read's caller-constant gates, once for this statement. The
  -- outer reads already require the case organization and chapter to be the
  -- caller's, so the role and staff-factor checks do not vary per case. A
  -- closed gate is zero grievances and an empty attention list.
  leadership_open := private.mfa_satisfied()
    and not private.member_pin_session_restricted()
    and (not private.staff_mfa_required(caller_org) or private.has_second_factor(caller))
    and (
      private.member_has_chapter_role(caller_chapter, array['admin', 'vp'])
      or private.has_organization_role(caller_org, array['admin', 'vp'])
    );
  caller_has_scopes := exists (
    select 1 from (select * from private.steward_assignment_scopes(caller,null) where not legacy_chapter_coverage) scope_row
    where scope_row.user_id = caller
  );

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
  into member_count, new_this_year
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.chapter_id = caller_chapter;

  if leadership_open then
    select pg_catalog.count(*)
    into active_grievances
    from public.member_cases c
    where c.status = 'active'
      and c.organization_id is not null
      and c.learning_undone_at is null
      and case
        when c.user_id = caller then true
        when not caller_has_scopes
          and not exists (
            select 1 from private.case_identity_privacy privacy
            where privacy.case_id = c.id
          )
          then true
        else private.actor_case_scope_and_identity_allowed(caller, c)
      end
      and c.organization_id = caller_org
      and c.chapter_id = caller_chapter;

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id,
        'reference', s.reference,
        'title', s.title,
        'step', s.step,
        'deadline', s.deadline,
        'memberName', s.member_name) order by s.deadline, s.id), '[]'::jsonb)
    into attention
    from (
      select c.id, c.reference, c.title, c.step, c.deadline, p.full_name as member_name
      from public.member_cases c
      join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
      where c.status = 'active'
        and c.deadline is not null
        and c.deadline < private.local_day(c.time_zone, pg_catalog.now())
        and c.organization_id is not null
        and c.chapter_id is not null
        and c.learning_undone_at is null
        and case
          when c.user_id = caller then true
          when not caller_has_scopes
            and not exists (
              select 1 from private.case_identity_privacy privacy
              where privacy.case_id = c.id
            )
            then true
          else private.actor_case_scope_and_identity_allowed(caller, c)
        end
        and c.organization_id = caller_org
        and c.chapter_id = caller_chapter
      order by c.deadline
      limit 6
    ) s;
  else
    active_grievances := 0;
    attention := '[]'::jsonb;
  end if;

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and b.campaign_state <> 'draft'
    and b.organization_id = caller_org
    and (b.chapter_id is null or b.chapter_id = caller_chapter)
  order by b.closes_at desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary) order by e.starts_at, e.id), '[]'::jsonb)
  into upcoming
  from (
    select ev.id, ev.title, ev.starts_at, ev.location, ev.summary
    from public.member_events ev
    join public.chapters event_chapter
      on event_chapter.id = ev.chapter_id
     and event_chapter.organization_id = caller_org
    where ev.starts_at >= pg_catalog.now()
      and ev.cancelled_at is null
      and private.member_event_scope_allows(
        (select private.member_event_caller_scope()),
        ev.chapter_id,
        ev.is_public,
        ev.is_public_across_agencies)
    order by ev.starts_at
    limit 5
  ) e;

  -- The aggregate-level ORDER BY is the guarantee; the subquery's ORDER BY
  -- only picks WHICH 8 survive the limit.
  select coalesce(pg_catalog.jsonb_agg(x.obj order by x.order_index), '[]'::jsonb)
  into priorities
  from (
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'ballot') as obj, order_index
    from public.member_ballots
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    union all
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'survey'), order_index
    from public.member_surveys
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    order by order_index
    limit 8
  ) x;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'year', y.yr, 'count', y.cumulative) order by y.yr), '[]'::jsonb)
  into trend
  from (
    select g.yr, pg_catalog.sum(g.n) over (order by g.yr) as cumulative
    from (
      select p.member_since as yr, pg_catalog.count(*) as n
      from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
      where p.chapter_id = caller_chapter
      group by p.member_since
    ) g
  ) y
  where y.yr >= pg_catalog.date_part('year', pg_catalog.now())::int - 5;

  return pg_catalog.jsonb_build_object(
    'memberCount', member_count,
    'newThisYear', new_this_year,
    'activeGrievances', active_grievances,
    'turnout', turnout,
    'attention', attention,
    'upcomingEvents', upcoming,
    'priorities', priorities,
    'membershipTrend', trend);
end;
$function$;

-- public.mark_vp_case_reviewed
CREATE OR REPLACE FUNCTION public.mark_vp_case_reviewed(p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  -- #8311: the selected workspace, never the first legacy role row.
  caller_chapter text := private.current_member_chapter();
  caller_org uuid := private.current_member_organization();
  result_row public.member_vp_case_reviews%rowtype;
begin
  if caller is null or not public.member_has_role(array['vp']) or not (select private.mfa_satisfied()) then
    raise exception 'president role with MFA required' using errcode = '42501';
  end if;

  -- The case's own stored chapter, never its owner's selected one, which
  -- the owner can switch after the case was opened.
  if caller_chapter is null or not exists (
    select 1
    from public.member_cases c
    join public.chapters ch on ch.id = c.chapter_id
    where c.id = p_case_id and c.learning_undone_at is null
      and c.chapter_id = caller_chapter
      and c.organization_id is not distinct from caller_org
      and ch.organization_id is not distinct from caller_org
      and c.status = 'active'
      and c.deadline is not null
      and c.deadline < private.local_day(c.time_zone, pg_catalog.now())
  ) then
    raise exception 'attention case not found' using errcode = 'P0002';
  end if;

  insert into public.member_vp_case_reviews (chapter_id, case_id, reviewed_by)
  values (caller_chapter, p_case_id, caller)
  on conflict (chapter_id, case_id) do nothing;

  select * into strict result_row
  from public.member_vp_case_reviews r
  where r.chapter_id = caller_chapter and r.case_id = p_case_id;

  return pg_catalog.jsonb_build_object(
    'caseId', result_row.case_id,
    'reviewedAt', result_row.reviewed_at,
    'reviewedBy', result_row.reviewed_by);
end;
end;
$function$;

-- public.get_compass_case_context
CREATE OR REPLACE FUNCTION public.get_compass_case_context(p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  caller uuid;
  org uuid;
  include_narrative boolean;
  case_row public.member_cases%rowtype;
  facts jsonb;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  org := private.member_organization_for(caller);
  if org is null
     or not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.case_help') then
    raise exception 'case help is turned off' using errcode = '55000';
  end if;
  include_narrative := private.organization_feature_enabled(org, 'features.ai_assistant.case_context_includes_narrative');

  select c.* into case_row
  from public.member_cases c
  where c.id = p_case_id
    and c.organization_id = org
    and private.casework_can_read(c.id);
  if case_row.id is null then
    raise exception 'case unavailable' using errcode = 'P0002';
  end if;

  facts := pg_catalog.jsonb_build_object(
    'status', case_row.status,
    'step', case_row.step,
    'openedDaysAgo', greatest(0, (private.local_day(case_row.time_zone, pg_catalog.now()) - private.local_day(case_row.time_zone, case_row.created_at))),
    'lastChangeDaysAgo', greatest(0, (private.local_day(case_row.time_zone, pg_catalog.now()) - private.local_day(case_row.time_zone, case_row.updated_at))),
    'caseDeadlineInDays', case when case_row.deadline is null then null else (case_row.deadline - private.local_day(case_row.time_zone, pg_catalog.now())) end,
    'deadlines', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind', deadline.kind, 'status', deadline.status,
        'dueInDays', pg_catalog.floor(extract(epoch from (deadline.due_at - pg_catalog.now())) / 86400.0)::integer
      ) order by deadline.due_at)
      from (
        select d.kind, d.status, d.due_at
        from public.casework_deadlines d
        where d.case_id = case_row.id and d.status = 'active'
        order by d.due_at, d.id
        limit 10
      ) deadline
    ), '[]'::jsonb),
    'timeline', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('type', event.kind, 'daysAgo', event.days_ago) order by event.at)
      from (
        select kind, at, greatest(0, (private.local_day(case_row.time_zone, pg_catalog.now()) - private.local_day(case_row.time_zone, at))) as days_ago
        from (
          select 'step_advanced'::text as kind, t.created_at as at
          from public.casework_step_transitions t where t.case_id = case_row.id
          union all
          select 'case_note'::text, u.created_at from public.member_case_updates u where u.case_id = case_row.id and u.learning_undone_at is null
          union all
          select 'outcome_recorded'::text, o.updated_at from public.member_case_outcomes o where o.case_id = case_row.id
        ) events
        order by at desc
        limit 12
      ) event
    ), '[]'::jsonb)
  );

  if include_narrative then
    facts := facts || pg_catalog.jsonb_build_object(
      'title', case_row.title,
      'notes', coalesce((
        select pg_catalog.jsonb_agg(note.body order by note.created_at)
        from (
          select u.body, u.created_at from public.member_case_updates u
          where u.case_id = case_row.id and u.learning_undone_at is null
          order by u.created_at desc
          limit 3
        ) note
      ), '[]'::jsonb));
  end if;

  return pg_catalog.jsonb_build_object(
    'organization_id', org,
    'includesNarrative', include_narrative,
    'data', facts
  );
end;
end;
$function$;

-- public.casework_suggest_case_strength
CREATE OR REPLACE FUNCTION public.casework_suggest_case_strength(p_case_id uuid, p_evidence_type text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_case public.member_cases%rowtype;
  v_answers jsonb;
  v_words text[];
  v_word_count integer;
  v_matches jsonb;
  v_max integer;
  v_contract integer;
  v_evidence_type text;
  v_inferred boolean;
  v_evidence integer;
  v_incident date;
  v_window integer;
  v_warning_days integer;
  v_days_since integer;
  v_procedural integer;
  v_days_remaining integer;
  v_due date;
  v_step_days integer;
  v_today date;
  v_overall integer;
begin
  perform private.casework_require_mfa();
  if p_case_id is null or not private.casework_staff_can_read(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  if p_evidence_type is not null and p_evidence_type not in ('witness_statements', 'documents', 'photos', 'none') then
    raise exception 'invalid evidence type' using errcode = '22023';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  v_today := private.local_day(v_case.time_zone, pg_catalog.now());
  if not private.organization_feature_enabled(v_case.organization_id, 'features.casework.strength_auto_suggest') then
    raise exception 'strength suggestion is turned off' using errcode = '55000';
  end if;
  select f.answers into v_answers from public.member_forms f
  where f.case_id = v_case.id and f.user_id = v_case.user_id
    and (f.user_id=(select auth.uid()) or f.status in ('submitted','in_review','approved') or private.member_draft_shared_to_caller(f))
  order by f.created_at, f.id limit 1;
  v_answers := coalesce(v_answers, '{}'::jsonb);

  -- Old words(): lower case, drop non-alphanumerics, split, keep >= 3 chars.
  select coalesce(array_agg(w), '{}'::text[]) into v_words
  from pg_catalog.regexp_split_to_table(
    pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.concat_ws(' ',
      v_case.title, v_case.articles, v_answers ->> 'summary', v_answers ->> 'articles', v_answers ->> 'narrative')),
      '[^a-z0-9[:space:]]', '', 'g'),
    '[[:space:]]+') w
  where pg_catalog.char_length(w) >= 3;
  v_word_count := pg_catalog.cardinality(v_words);

  with scored as (
    select c.id, c.article, c.title, c.sort_order,
      (select pg_catalog.count(*)::integer from pg_catalog.unnest(v_words) w
        where pg_catalog.strpos(
          pg_catalog.lower(pg_catalog.array_to_string(c.keywords, ' ') || ' ' || coalesce(c.summary, '')), w) > 0
      ) as match_count
    from public.contract_clauses c
    where c.organization_id = v_case.organization_id and c.status = 'published'
  ), ranked as (
    select s.*, row_number() over (order by s.match_count desc, s.sort_order, s.article, s.id) as position
    from scored s where s.match_count > 0
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'article', r.article, 'title', r.title, 'matchCount', r.match_count,
      'tag', case when r.position = 1 then 'Primary' else 'Supporting' end) order by r.position)
      filter (where r.position <= 3), '[]'::jsonb),
    coalesce(max(r.match_count), 0)
  into v_matches, v_max
  from ranked r;
  v_contract := case when v_max > 0
    then least(100, round(v_max::numeric / greatest(v_word_count, 1) * 100))::integer else 0 end;

  v_inferred := p_evidence_type is null;
  v_evidence_type := coalesce(p_evidence_type, case
    when nullif(pg_catalog.btrim(coalesce(v_answers ->> 'witnesses', '')), '') is not null then 'witness_statements'
    when exists (select 1 from public.member_case_files mf where mf.case_id = v_case.id and mf.removal_id is null
      and mf.mime_type not like 'image/%') then 'documents'
    when exists (select 1 from public.member_case_files mf where mf.case_id = v_case.id and mf.removal_id is null
      and mf.mime_type like 'image/%') then 'photos'
    else 'none' end);
  v_evidence := private.organization_limit(v_case.organization_id, case v_evidence_type
    when 'witness_statements' then 'limits.casework.strength_evidence_witness'
    when 'documents' then 'limits.casework.strength_evidence_documents'
    when 'photos' then 'limits.casework.strength_evidence_photos'
    else 'limits.casework.strength_evidence_none' end);

  v_window := private.organization_limit(v_case.organization_id, 'limits.casework.strength_filing_window_days');
  v_warning_days := private.organization_limit(v_case.organization_id, 'limits.casework.strength_deadline_warning_days');
  if coalesce(v_answers ->> 'incident_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then
    v_incident := (v_answers ->> 'incident_date')::date;
  end if;
  v_procedural := 100;
  if v_incident is not null then
    v_days_since := greatest(0, v_today - v_incident);
    v_procedural := greatest(0, round(100 - v_days_since::numeric / v_window * 100))::integer;
    v_days_remaining := v_window - v_days_since;
  end if;
  -- The earliest open filing or procedure deadline, and its days left on its own zone.
  select private.local_day(d.time_zone, d.due_at), private.local_day(d.time_zone, d.due_at) - private.local_day(d.time_zone, pg_catalog.now())
    into v_due, v_step_days
  from public.casework_deadlines d
  where d.case_id = v_case.id and d.kind in ('filing', 'procedure') and d.status in ('active', 'extended')
  order by d.due_at, d.id
  limit 1;
  if v_due is not null then
    v_days_remaining := v_step_days;
  end if;

  v_overall := round(v_contract * 0.4 + v_evidence * 0.35 + v_procedural * 0.25)::integer;
  return pg_catalog.jsonb_build_object(
    'overallScore', v_overall,
    'band', case when v_overall < 45 then 'needs_evidence' when v_overall < 75 then 'developing' else 'strong' end,
    'contractScore', v_contract,
    'evidenceScore', v_evidence,
    'proceduralScore', v_procedural,
    'evidenceType', v_evidence_type,
    'evidenceInferred', v_inferred,
    'matchedClauses', v_matches,
    'daysRemaining', case when v_days_remaining is not null then greatest(0, v_days_remaining) end,
    'deadlineWarning', case
      when v_days_remaining is null then null
      when v_days_remaining < 0 then 'passed'
      when v_days_remaining <= v_warning_days then 'soon' end,
    'warningDays', v_warning_days,
    'suggestedInputs', pg_catalog.jsonb_build_object(
      'contract_support', least(5, round(v_contract / 20.0))::integer,
      'documentation', least(5, round(v_evidence / 20.0))::integer,
      'timeliness', least(5, round(v_procedural / 20.0))::integer,
      'witnesses', case when v_evidence_type = 'witness_statements' then 5 else 0 end));
end;
$function$;

-- private.capture_casework_record_version
CREATE OR REPLACE FUNCTION private.capture_casework_record_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  previous jsonb; following jsonb; row_data jsonb; case_key uuid;
  parent_table text; parent_key text; record_key text; chapter_key text;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  if tg_op <> 'INSERT' then previous := pg_catalog.to_jsonb(old); end if;
  if tg_op <> 'DELETE' then following := pg_catalog.to_jsonb(new); end if;
  -- Every due_at writer reaches this existing row trigger: approved
  -- extensions, direct writes, seed upserts and learning-period undo.
  if tg_table_name = 'casework_deadlines' and (
    tg_op in ('INSERT', 'DELETE')
    or private.local_day(previous ->> 'time_zone', (previous ->> 'due_at')::timestamptz)
       is distinct from private.local_day(following ->> 'time_zone', (following ->> 'due_at')::timestamptz)
  ) then
    delete from private.staff_deadline_notice_marks
     where source = 'casework_deadline'
       and deadline_id = coalesce(following ->> 'id', previous ->> 'id')::uuid;
  end if;
  if tg_op = 'UPDATE' and previous - 'updated_at' = following - 'updated_at' then
    return null;
  end if;
  row_data := coalesce(following, previous);
  record_key := coalesce(row_data ->> 'id',
    (row_data ->> 'pattern_id') || ':' || (row_data ->> 'report_id'));
  case_key := case when tg_table_name = 'member_cases' then (row_data ->> 'id')::uuid
    else coalesce(row_data ->> 'case_id', row_data ->> 'source_case_id', previous ->> 'case_id')::uuid end;
  chapter_key := row_data ->> 'chapter_id';
  -- Child rows carry no case_id. Resolve each parent with its own constant
  -- statement: dynamic EXECUTE is unanalyzable and the conventions verifier
  -- refuses it, so every lookup below is a fixed relation.
  case tg_table_name
    when 'casework_deadline_extensions' then
      parent_table := 'casework_deadlines'; parent_key := coalesce(row_data ->> 'deadline_id', previous ->> 'deadline_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_deadlines p where p.id = parent_key::uuid;
    when 'casework_checklist_items' then
      parent_table := 'casework_checklists'; parent_key := coalesce(row_data ->> 'checklist_id', previous ->> 'checklist_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_checklists p where p.id = parent_key::uuid;
    when 'casework_alert_acknowledgements' then
      parent_table := 'casework_alerts'; parent_key := coalesce(row_data ->> 'alert_id', previous ->> 'alert_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_alerts p where p.id = parent_key::uuid;
    when 'casework_management_addenda' then
      parent_table := 'casework_management_entries'; parent_key := coalesce(row_data ->> 'entry_id', previous ->> 'entry_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_management_entries p where p.id = parent_key::uuid;
    when 'casework_retaliation_pattern_reports' then
      parent_table := 'casework_retaliation_reports'; parent_key := coalesce(row_data ->> 'report_id', previous ->> 'report_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_retaliation_reports p where p.id = parent_key::uuid;
    else null;
  end case;
  -- During a parent cascade the live parent row can already be gone; the
  -- parent's own last captured version still carries the case.
  if parent_table is not null and case_key is null then
    select v.case_id, v.chapter_id into case_key, chapter_key from private.casework_record_versions v
    where v.record_table = parent_table and v.record_id = parent_key
    order by v.id desc limit 1;
  end if;
  -- Retained children may be detached by a case cascade after its versions
  -- have already disappeared. The existing lifecycle snapshot identifies that
  -- case even for rows which predate this migration.
  if case_key is null then
    select h.case_id into case_key from private.account_lifecycle_history_scope h
    where (h.kind = 'deadline_extension' and tg_table_name = 'casework_deadline_extensions' and h.record_id = record_key)
       or (h.kind = 'management_entry' and h.record_id = case when tg_table_name = 'casework_management_addenda' then parent_key when tg_table_name = 'casework_management_entries' then record_key end)
       or (h.kind = 'retaliation_report' and h.record_id = case when tg_table_name = 'casework_retaliation_pattern_reports' then parent_key when tg_table_name = 'casework_retaliation_reports' then record_key end)
    limit 1;
  end if;
  -- These children always belong to a case. No unscoped snapshot survives a
  -- cascade whose parent and version have both already been removed.
  if case_key is null and tg_table_name = any(array[
    'casework_checklist_items','casework_alert_acknowledgements','casework_deadline_extensions'
  ]) then return null; end if;
  -- Never resurrect versions during the case's own delete/cascade/detachment.
  if case_key is not null and not exists (select 1 from public.member_cases c where c.id = case_key) then
    return null;
  end if;
  if row_data ->> 'organization_id' is not null and not exists (
    select 1 from public.organizations o where o.id = (row_data ->> 'organization_id')::uuid
  ) then return null; end if;
  insert into private.casework_record_versions
    (case_id, organization_id, chapter_id, record_table, record_id, op, old_row, new_row, actor)
  values (case_key, (row_data ->> 'organization_id')::uuid, chapter_key, tg_table_name,
    record_key, tg_op, previous, following, (select u.id from auth.users u where u.id = auth.uid()));
  return null;
end;
$function$;

-- public.casework_advance_step
CREATE OR REPLACE FUNCTION public.casework_advance_step(p_case_id uuid, p_expected_step text, p_next_step text, p_outcome text, p_idempotency_key uuid)
 RETURNS public.casework_step_transitions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_case public.member_cases%rowtype; v_transition public.casework_step_transitions%rowtype; v_template public.casework_checklist_templates%rowtype; v_checklist_id uuid; v_procedure uuid; v_current public.casework_procedure_steps%rowtype; v_next public.casework_procedure_steps%rowtype; v_start timestamptz; v_due timestamptz; v_incident text; v_deadline_id uuid;
  v_zone text;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_next_step is null or p_outcome is null or p_idempotency_key is null then raise exception 'invalid transition' using errcode = '22023'; end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('casework-procedure:' || v_case.organization_id::text, 0));
  select * into strict v_case from public.member_cases where id = p_case_id for update;
  select * into v_transition from public.casework_step_transitions where organization_id = v_case.organization_id and transitioned_by = (select auth.uid()) and idempotency_key = p_idempotency_key;
  if found then
    if v_transition.case_id <> p_case_id or v_transition.from_step is distinct from p_expected_step or v_transition.to_step is distinct from btrim(p_next_step) or v_transition.outcome is distinct from btrim(p_outcome) then raise exception 'idempotency key reused' using errcode = '22023'; end if;
    return v_transition;
  end if;
  if v_case.step is distinct from p_expected_step then raise exception 'case step changed' using errcode = 'PT409'; end if;
  v_procedure := private.casework_resolve_procedure(v_case.organization_id, v_case.chapter_id, v_case.case_type);
  if v_procedure is null and (char_length(btrim(p_next_step)) not between 2 and 100 or p_next_step = p_expected_step) then raise exception 'invalid next step' using errcode = '22023'; end if;
  if v_procedure is not null then
    select * into v_current from public.casework_procedure_steps where procedure_id = v_procedure and key = v_case.step;
    if v_current.terminal then raise exception 'terminal step cannot advance' using errcode = '22023'; end if;
    select * into v_next from private.casework_allowed_next_steps(v_procedure, v_case.step) s where s.key = btrim(p_next_step);
    if v_next.id is null then raise exception 'invalid procedure successor' using errcode = '22023'; end if;
    if v_current.requires_checklist and (not exists (select 1 from public.casework_checklists c where c.case_id = v_case.id and c.step = v_case.step)
      or exists (select 1 from public.casework_checklists c join public.casework_checklist_items i on i.checklist_id = c.id
        where c.case_id = v_case.id and c.step = v_case.step and i.required and i.completed_at is null))
      then raise exception 'required checklist incomplete' using errcode = '22023'; end if;
    if v_next.deadline_rule->>'kind' <> 'none' then
      -- A deadline set now is counted on its group's zone now, and keeps it.
      v_zone := private.record_time_zone(v_case.organization_id, v_case.chapter_id);
      v_start := now();
      if v_next.deadline_rule->>'from' = 'filing' then v_start := v_case.created_at; end if;
      if v_next.deadline_rule->>'from' = 'incident' then
        select f.answers->>'incident_date' into v_incident from public.member_forms f
          where f.case_id = v_case.id and f.user_id = v_case.user_id order by f.created_at, f.id limit 1;
        if v_incident is null or v_incident !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'incident date required on case filing' using errcode = '22023'; end if;
        v_start := v_incident::date::timestamp at time zone v_zone;
      end if;
      v_due := case v_next.deadline_rule->>'kind'
        when 'business_days' then private.casework_add_business_days(v_start, (v_next.deadline_rule->>'count')::integer, v_case.organization_id, v_zone)
        else ((private.local_day(v_zone, v_start) + (v_next.deadline_rule->>'count')::integer) + time '23:59:59') at time zone v_zone end;
    end if;
  end if;
  insert into public.casework_step_transitions(case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, procedure_transaction_id)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, v_case.step, pg_catalog.btrim(p_next_step), pg_catalog.btrim(p_outcome), (select auth.uid()), p_idempotency_key, pg_current_xact_id())
  returning * into v_transition;
  if v_due is not null then
    insert into public.casework_deadlines(case_id, organization_id, chapter_id, kind, label, due_at, created_by)
    values(v_case.id, v_case.organization_id, v_case.chapter_id, 'procedure', v_next.label, v_due, (select auth.uid()))
    returning id into v_deadline_id;
    insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'deadline_created', 'deadline', v_deadline_id,
      pg_catalog.jsonb_build_object('kind', 'procedure', 'dueAt', v_due, 'reminderSet', false));
  end if;
  update public.member_cases set step = pg_catalog.btrim(p_next_step), updated_at = pg_catalog.now() where id = v_case.id;
  select * into v_template from public.casework_checklist_templates t
  where t.organization_id = v_case.organization_id and (t.chapter_id is null or t.chapter_id = v_case.chapter_id)
    and t.case_type = v_case.case_type and t.step = pg_catalog.btrim(p_next_step) and t.active
  order by (t.chapter_id is not null) desc, t.updated_at desc limit 1;
  if found then
    insert into public.casework_checklists(case_id, organization_id, chapter_id, template_id, step, title, created_by)
    values (v_case.id, v_case.organization_id, v_case.chapter_id, v_template.id, p_next_step, v_template.title, (select auth.uid())) returning id into v_checklist_id;
    insert into public.casework_checklist_items(checklist_id, organization_id, label, position, required)
    select v_checklist_id, v_case.organization_id, item->>'label', (ordinality - 1)::integer, coalesce((item->>'required')::boolean, true)
    from pg_catalog.jsonb_array_elements(v_template.items) with ordinality as x(item, ordinality);
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'step_advanced', 'step_transition', v_transition.id, pg_catalog.jsonb_build_object('fromStep', v_case.step, 'toStep', p_next_step, 'checklistId', v_checklist_id));
  perform private.learning_casework_journal('casework_step_advance', p_case_id);
  return v_transition;
end;

end;
$function$;

-- public.steward_add_case_note
CREATE OR REPLACE FUNCTION public.steward_add_case_note(p_case_id uuid, p_body text, p_occurred_on date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid;
  v_case public.member_cases%rowtype;
  v_body text;
  v_today date;
  v_on date;
  v_inserted public.member_case_updates%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[p_case_id]);
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  select c.* into v_case from public.member_cases c where c.id = p_case_id for update;
  -- Only the case's own steward, and only while they still hold staff
  -- authority in the case's own chapter and organization
  -- (private.casework_staff_can_access): a steward whose membership there was
  -- revoked keeps the assignment row but not the case. Any other case
  -- collapses to one refusal.
  if not found or v_case.steward_user_id is distinct from caller
     or not private.casework_staff_can_access(v_case.id) then
    raise exception 'case not found or not yours' using errcode = '42501';
  end if;
  v_body := pg_catalog.btrim(coalesce(p_body, ''));
  if pg_catalog.char_length(v_body) not between 1 and 4000 then
    raise exception 'note must be 1-4000 characters' using errcode = '22023';
  end if;
  -- Today on the case's own zone; the session's current_date is the UTC day.
  v_today := private.local_day(v_case.time_zone, pg_catalog.now());
  v_on := coalesce(p_occurred_on, v_today);
  if v_on < v_today - 3650 or v_on > v_today + 1 then
    raise exception 'note date out of range' using errcode = '22023';
  end if;

  insert into public.member_case_updates(case_id, user_id, body, occurred_on)
  values (v_case.id, v_case.user_id, v_body, v_on)
  returning * into v_inserted;

  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, caller,
    'note_added', 'case_update', v_inserted.id,
    pg_catalog.jsonb_build_object('occurredOn', v_on, 'by', 'steward'));

  perform private.learning_journal_append('case_note_add', 'public.member_case_updates', v_inserted.id::text, null,
    private.learning_fingerprint(private.learning_case_note_state(v_inserted.id)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'id', v_inserted.id, 'caseId', v_inserted.case_id, 'body', v_inserted.body,
    'occurredOn', v_inserted.occurred_on, 'createdAt', v_inserted.created_at);
end;
end;
$function$;

-- public.create_member_case
CREATE OR REPLACE FUNCTION public.create_member_case(p_title text, p_deadline date, p_case_type text, p_articles text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller         uuid := (select auth.uid());
  clean_title    text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_articles text := pg_catalog.btrim(coalesce(p_articles, ''));
  ref            text;
  new_case       uuid;
  attempts       integer := 0;
  akey           text;
  awarded        integer;
  today          date;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Bounds are raised, never truncated. A grievance is a legal document; a
  -- server that quietly clips the member's account of what happened at 200
  -- characters is worse than one that refuses and says why.
  if pg_catalog.char_length(clean_title) < 1 then
    raise exception 'case title is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) > 200 then
    raise exception 'case title too long (200 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;

  -- Mirrors the six <option value> entries in src/views/CasesView.jsx. The
  -- column has no CHECK, so before this the case_type was free text straight
  -- from the wire and the coordinator/steward case planes grouped on it.
  if p_case_type is null
     or p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other') then
    raise exception 'invalid case type' using errcode = '22023';
  end if;

  today := private.local_day(private.record_time_zone(private.member_organization_for(caller), private.current_member_chapter()), pg_catalog.now());
  -- Deadlines drive the member's Today screen and the steward deadline board.
  -- +/- 10 years is generous for a real contractual deadline and still keeps a
  -- fat-fingered year 0202 or 20260 out of every downstream sort.
  if p_deadline is not null
     and (p_deadline < today - 3650 or p_deadline > today + 3650) then
    raise exception 'deadline out of range' using errcode = '22023';
  end if;

  -- Bounded retry rather than a uniqueness pre-check: the check-then-insert
  -- race is exactly the duplicate this migration exists to remove. 5 attempts
  -- over a 100000-value space is astronomically more than enough; exhausting
  -- it means something is badly wrong and the caller gets a clean error rather
  -- than a hung loop.
  loop
    attempts := attempts + 1;
    ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-' || private.member_case_suffix();
    begin
      insert into public.member_cases (user_id, reference, title, deadline, case_type, articles, step)
      values (caller, ref, clean_title, p_deadline, p_case_type, clean_articles, 'Intake')
      returning id into new_case;
      exit;
    exception when unique_violation then
      if attempts >= 5 then
        raise exception 'could not allocate a case reference' using errcode = '23505';
      end if;
    end;
  end loop;

  akey := 'case-' || ref;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'case')
  on conflict (user_id, action_key) do nothing;

  -- 'case' is capped at 3/week; read the real award, not the rule.
  select e.points into awarded
  from public.member_point_events e
  where e.user_id = caller and e.action_key = akey;

  perform private.learning_case_journal('case_create', new_case, null);
  return pg_catalog.jsonb_build_object(
    'caseId', new_case,
    'reference', ref,
    'awardedPoints', coalesce(awarded, 0));
end;
end;
$function$;

-- public.open_member_case
CREATE OR REPLACE FUNCTION public.open_member_case(p_member_id uuid, p_title text, p_case_type text, p_articles text, p_deadline date, p_description text, p_incident_date date, p_remedy_sought text, p_filing_status text, p_assign_self boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
declare
  caller uuid;
  clean_title text;
  clean_articles text;
  clean_description text;
  clean_remedy text;
  steward_scope boolean;
  assign boolean;
  steward_label text;
  actor_label text;
  created jsonb;
  ref text;
  new_case uuid;
  attempts integer;
  today date;
begin
  caller := (select auth.uid());
  -- The intake's member: the named one, or the caller filing their own.
  today := private.local_day(private.record_time_zone(private.member_organization_for(coalesce(p_member_id, caller)),
    (select p.chapter_id from public.member_profiles p where p.id = coalesce(p_member_id, caller))), pg_catalog.now());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  clean_description := nullif(pg_catalog.btrim(coalesce(p_description, '')), '');
  clean_remedy := nullif(pg_catalog.btrim(coalesce(p_remedy_sought, '')), '');
  -- Bounds are raised, never clipped, as in public.create_member_case.
  if pg_catalog.char_length(clean_description) > 10000 then
    raise exception 'case description too long (10000 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_remedy) > 2000 then
    raise exception 'remedy sought too long (2000 characters max)' using errcode = '22023';
  end if;
  if p_filing_status is not null and p_filing_status not in ('informal', 'filed') then
    raise exception 'invalid filing status' using errcode = '22023';
  end if;
  if p_incident_date is not null
     and (p_incident_date < today - 3650 or p_incident_date > today + 1) then
    raise exception 'incident date out of range' using errcode = '22023';
  end if;

  -- The member's own intake keeps every rule, reference and award of
  -- public.create_member_case and adds the details to that same row.
  if p_member_id is null or p_member_id = caller then
    created := public.create_member_case(p_title, p_deadline, p_case_type, p_articles);
    update public.member_cases set
      description = clean_description,
      incident_date = p_incident_date,
      remedy_sought = clean_remedy,
      filing_status = p_filing_status
    where id = (created->>'caseId')::uuid and user_id = caller;
    -- The details are a later step on the case create_member_case journalled,
    -- so undoing the case undoes both, newest first.
    perform private.learning_case_journal('case_edit', (created->>'caseId')::uuid, null);
    return created || pg_catalog.jsonb_build_object('assigned', false);
  end if;

  -- A case opened for another member: staff in the member's scope only.
  if not public.member_has_role(array['steward', 'coordinator', 'admin']) then
    raise exception 'steward, coordinator or admin role required' using errcode = '42501';
  end if;
  steward_scope := private.chapter_case_intake_role_allows(p_member_id, 'steward');
  if not (steward_scope
          or private.chapter_case_intake_role_allows(p_member_id, 'coordinator')
          or private.chapter_case_intake_role_allows(p_member_id, 'admin')) then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;

  clean_title := pg_catalog.btrim(coalesce(p_title, ''));
  clean_articles := pg_catalog.btrim(coalesce(p_articles, ''));
  if pg_catalog.char_length(clean_title) < 1 then
    raise exception 'case title is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) > 200 then
    raise exception 'case title too long (200 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;
  if p_case_type is null
     or p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other') then
    raise exception 'invalid case type' using errcode = '22023';
  end if;
  if p_deadline is not null
     and (p_deadline < today - 3650 or p_deadline > today + 3650) then
    raise exception 'deadline out of range' using errcode = '22023';
  end if;

  -- A steward who opens the case is its steward, so it is on their caseload.
  assign := coalesce(p_assign_self, true) and steward_scope;
  if assign then
    select p.full_name into steward_label from public.member_profiles p where p.id = caller;
  end if;

  attempts := 0;
  loop
    attempts := attempts + 1;
    ref := 'GR-' || pg_catalog.to_char(pg_catalog.now(), 'YYYY') || '-' || private.member_case_suffix();
    begin
      insert into public.member_cases (
        user_id, reference, title, deadline, case_type, articles, step,
        description, incident_date, remedy_sought, filing_status,
        steward_user_id, steward_name, assigned_at)
      values (
        p_member_id, ref, clean_title, p_deadline, p_case_type, clean_articles, 'Intake',
        clean_description, p_incident_date, clean_remedy, p_filing_status,
        case when assign then caller end,
        case when assign then coalesce(steward_label, 'Steward') end,
        case when assign then pg_catalog.now() end)
      returning id into new_case;
      exit;
    exception when unique_violation then
      if attempts >= 5 then
        raise exception 'could not allocate a case reference' using errcode = '23505';
      end if;
    end;
  end loop;

  if assign then
    actor_label := coalesce(steward_label, 'Staff member');
    insert into public.member_case_assignment_audit
      (case_id, actor_id, actor_name, before_assignment, after_assignment)
    values (new_case, caller, actor_label,
      pg_catalog.jsonb_build_object('stewardUserId', null, 'stewardName', null,
        'coordinatorUserId', null, 'coordinatorName', null),
      pg_catalog.jsonb_build_object('stewardUserId', caller, 'stewardName', coalesce(steward_label, 'Steward'),
        'coordinatorUserId', null, 'coordinatorName', null));
  end if;

  perform private.learning_case_journal('case_create', new_case, null);
  return pg_catalog.jsonb_build_object('caseId', new_case, 'reference', ref, 'assigned', assign);
end;
end;
end;
$function$;

-- public.get_organization_analytics_workspace
CREATE OR REPLACE FUNCTION public.get_organization_analytics_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph_read();
  perform private.member_pin_require_full_session();
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  health_threshold integer := private.organization_limit(org, 'limits.analytics.chapter_health_cohort_floor');
  actor uuid := (select auth.uid());
  may_read_unassigned boolean;
  scoped_actor boolean;
  default_steward_chapters text[];
  org_case_reader boolean;
  staff_chapters text[];
  roster_limited boolean;
  roster_chapters text[];
begin
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Necessary candidate condition only, never an authorization result.
  -- Deliberately retain roles in ANY tenant/chapter (including inactive or
  -- otherwise unusable grants): false positives still reach the shared final
  -- predicate. All current organization, chapter and legacy role sources are
  -- included. Assignment is checked per case below.
  may_read_unassigned := exists (
    select 1 from public.organization_role_grants g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_role_chapters g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_roles g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  );

  -- Cached ordinary-steward authorization. The enclosing roster query
  -- already proves the target's active chapter and organization memberships.
  -- Scoped actors, private identities and legacy exceptions use the oracle.
  scoped_actor := exists(select 1 from (select * from private.steward_assignment_scopes(actor,null) where not legacy_chapter_coverage) scope where scope.user_id=actor);
  default_steward_chapters := array(
        select ch.id from public.chapters ch
        left join private.chapter_access_policies target_policy on target_policy.chapter_id=ch.id
        where ch.organization_id=org
          and coalesce(target_policy.steward_grievances,true)
          and (not private.staff_mfa_required(ch.organization_id) or private.has_second_factor(actor))
          and (private.chapter_organization_role_allowed(ch.id,array['steward'])
            or private.member_has_chapter_role(ch.id,array['steward'])
            or exists(select 1 from public.member_role_chapters r
              join public.chapters source on source.id=r.chapter_id and source.organization_id=ch.organization_id
              join public.member_chapter_memberships source_member on source_member.chapter_id=r.chapter_id and source_member.user_id=r.user_id and source_member.status='active'
              join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
              where r.user_id=actor and r.role='steward' and private.member_has_chapter_role(r.chapter_id,array['steward'])))
      );

  -- BUG-UG-SAMPLE-ANALYTICS-PANELS-TIME-OUT-20261030: for an
  -- organization advisor, administrator or leader, every per-case clause of
  -- private.casework_staff_can_access except the chapter staff-role test is
  -- already met by that organization role, so the per-case call (about 16 ms
  -- each at Tamarack scale, one per active case) reduces to membership in
  -- the chapters where private.actor_has_chapter_staff_role holds. Both are
  -- read once here, after lock_case_graph_read, with the same helpers and
  -- arguments the shared predicate uses; every other caller keeps the shared
  -- predicate per case.
  -- Scoped access: the shortcut applies only to an unscoped actor and a case
  -- with no identity privacy, where private.case_scope_and_identity_allowed
  -- is already true; every other case keeps the read oracle below.
  org_case_reader := private.has_organization_role(org, array['advisor','admin','vp']);
  -- #8589 rounds 1-2: a caller admitted only by an organization steward
  -- grant sees named members only where an assignment covers them: whole
  -- chapters for steward carry-over and for live, unscoped chapter-level
  -- higher roles; otherwise the unit, default-unit or committee members of
  -- each scoped steward, coordinator or advisor assignment; and themselves.
  roster_limited := not private.has_organization_role(org, array['coordinator','advisor','admin','vp']);
  roster_chapters := array(
    select scope.chapter_id from private.steward_assignment_scopes(actor,null) scope
    where roster_limited and scope.role='steward' and scope.legacy_chapter_coverage
    union
    select grant_row.chapter_id from public.member_role_chapters grant_row
    join public.chapters chapter on chapter.id=grant_row.chapter_id and chapter.organization_id=org
    join public.member_chapter_memberships membership on membership.user_id=grant_row.user_id
      and membership.chapter_id=grant_row.chapter_id and membership.status='active'
    where roster_limited and grant_row.user_id=actor and grant_row.role=any(array['coordinator','advisor','admin','vp'])
      and not exists(select 1 from private.chapter_role_scopes scope
        where scope.user_id=grant_row.user_id and scope.chapter_id=grant_row.chapter_id and scope.role=grant_row.role));
  select coalesce(pg_catalog.array_agg(c.id), array[]::text[]) into staff_chapters
  from public.chapters c
  where c.organization_id = org
    and private.actor_has_chapter_staff_role(actor, c.id);

  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'analytics_parity_workspace'
  ));

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapterHealthFloor', health_threshold,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'id', m.user_id::text || ':' || m.chapter_id,
        'name', p.full_name,
        'chapterId', c.id,
        'chapterName', c.name,
        'participationScore', case when privacy.shown then least(100, activity.event_count * 10) end,
        'profileReadiness', case when privacy.shown then
          (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50 end,
        'followThrough', case when privacy.shown then least(100, activity.follow_count * 20) end,
        'overallScore', case when privacy.shown then pg_catalog.round((
          least(100, activity.event_count * 10)
          + ((case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50)
          + least(100, activity.follow_count * 20)
        )::numeric / 3) end,
        'scoreHidden', not privacy.shown,
        'attention', case
          when cases.overdue_cases > 0 then 'urgent'
          when not privacy.shown then null
          when activity.event_count = 0 then 'support'
          when activity.event_count < 5 then 'watch'
          else 'steady'
        end,
        'activeCases', cases.active_cases,
        'overdueCases', cases.overdue_cases,
        'lastActivityAt', case when privacy.shown then activity.last_activity end
      ) order by c.name, p.full_name, m.user_id)
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = org
      join public.organization_memberships om
        on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
      join public.member_profiles p on p.id = m.user_id
      -- #6774: a member who hides their Pulse score keeps their row; only the
      -- activity-derived fields are withheld, and their activity is not read.
      cross join lateral (select p.pulse_score_visible or m.user_id = actor as shown) privacy
      cross join lateral (
        select
          pg_catalog.count(*)::integer as event_count,
          pg_catalog.count(*) filter (
            where e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')
              and e.occurred_at >= generated - interval '90 days'
          )::integer as follow_count,
          pg_catalog.max(e.occurred_at) as last_activity
        from public.organization_engagement_events e
        where privacy.shown
          and e.organization_id = org
          and e.user_id = m.user_id
          -- Preserve train 2a participation semantics: page views are telemetry.
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
      ) activity
      cross join lateral (
        select
          pg_catalog.count(*) filter (where cs.status = 'active')::integer as active_cases,
          pg_catalog.count(*) filter (
            where cs.status = 'active' and cs.deadline < private.local_day(cs.time_zone, generated)
          )::integer as overdue_cases
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id = c.id
          and cs.user_id = m.user_id
          and cs.status = 'active'
          and case
            when org_case_reader and not scoped_actor
              and cs.chapter_id = any(staff_chapters)
              and (may_read_unassigned or cs.steward_user_id=actor or cs.coordinator_user_id=actor
                or cs.chapter_id=any(default_steward_chapters))
              and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
            then true
            when not scoped_actor and not cs.is_restricted and cs.user_id<>actor
              and cs.chapter_id=any(default_steward_chapters)
              and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
            then true
            else case when may_read_unassigned or cs.steward_user_id=actor or cs.coordinator_user_id=actor
                or cs.chapter_id=any(default_steward_chapters)
              then private.casework_staff_can_read(cs.id) else false end
          end
      ) cases
      where m.status = 'active'
        and (not roster_limited or m.user_id = actor or m.chapter_id = any(roster_chapters)
          or exists(select 1 from (
              select steward_scope.unit_id,steward_scope.committee_id
              from private.steward_assignment_scopes(actor,m.chapter_id) steward_scope
              where steward_scope.role='steward' and not steward_scope.legacy_chapter_coverage and steward_scope.chapter_id=m.chapter_id
              union all
              select role_scope.unit_id,role_scope.committee_id
              from private.chapter_role_scopes role_scope
              join public.member_role_chapters grant_row on grant_row.user_id=role_scope.user_id
                and grant_row.chapter_id=role_scope.chapter_id and grant_row.role=role_scope.role
              join public.member_chapter_memberships membership on membership.user_id=role_scope.user_id
                and membership.chapter_id=role_scope.chapter_id and membership.status='active'
              where role_scope.user_id=actor and role_scope.chapter_id=m.chapter_id
                and role_scope.role=any(array['coordinator','advisor'])) scope
            where ((scope.unit_id is not null and (
                  exists(select 1 from private.chapter_unit_members physical
                    where physical.unit_id=scope.unit_id and physical.chapter_id=m.chapter_id and physical.user_id=m.user_id)
                  or (exists(select 1 from private.chapter_units unit
                      where unit.id=scope.unit_id and unit.chapter_id=m.chapter_id and unit.is_default)
                    and not exists(select 1 from private.chapter_unit_members physical
                      where physical.user_id=m.user_id and physical.chapter_id=m.chapter_id))))
                or (scope.committee_id is not null and exists(select 1 from private.chapter_committees committee
                  join private.chapter_committee_members member on member.committee_id=committee.id and member.chapter_id=committee.chapter_id
                  where committee.id=scope.committee_id and committee.chapter_id=m.chapter_id and member.user_id=m.user_id
                    and committee.starts_on<=(select private.eastern_day()) and (committee.ends_on is null or committee.ends_on>=(select private.eastern_day()))))))) -- fixed-zone: a committee window moves with the committees part of #9446 (4b)
    ), '[]'::jsonb),
    'chapterHealth', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'chapterName', c.name,
        'memberCount', totals.member_count,
        'protected', totals.member_count < health_threshold
          or (latest.id is not null and latest.member_count < health_threshold),
        'score', case when totals.member_count >= health_threshold and latest.member_count >= health_threshold
          then latest.score else null end,
        'drivers', case when totals.member_count >= health_threshold and latest.member_count >= health_threshold
          then pg_catalog.jsonb_build_object(
            'participation', latest.participation,
            'caseTimeliness', latest.case_timeliness,
            'stewardCapacity', latest.steward_capacity,
            'trainingCoverage', latest.training_coverage,
            'communicationReach', latest.communication_reach,
            'governanceReadiness', latest.governance_readiness
          ) else null end,
        'trend', case when totals.member_count >= health_threshold then coalesce(trend.points, '[]'::jsonb) else '[]'::jsonb end
      ) order by c.name)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*)::integer as member_count
        from public.member_chapter_memberships m
        join public.organization_memberships om
          on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
        where m.chapter_id = c.id and m.status = 'active'
      ) totals
      left join lateral (
        select s.* from public.chapter_health_snapshots s
        where s.chapter_id = c.id order by s.measured_on desc limit 1
      ) latest on true
      left join lateral (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'measuredOn', history.measured_on, 'score', history.score
        ) order by history.measured_on) as points
        from (
          select s.measured_on, s.score
          from public.chapter_health_snapshots s
          where s.chapter_id = c.id and s.member_count >= health_threshold
          order by s.measured_on desc limit 36
        ) history
      ) trend on true
      where c.organization_id = org
    ), '[]'::jsonb),
    'datasets', coalesce((
      select pg_catalog.jsonb_agg(dataset.value order by dataset.sort_key)
      from (
        select 0 as sort_key, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'organization:chapter-health',
          'label', 'Chapter health',
          'description', 'Latest protected chapter health score.',
          'scope', 'organization',
          'chapterId', null,
          'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', qualified.name, 'value', qualified.score
          ) order by qualified.name), '[]'::jsonb)
        ) as value
        from (
          select c.name, latest.score
          from public.chapters c
          cross join lateral (
            select pg_catalog.count(*)::integer as member_count
            from public.member_chapter_memberships m
            join public.organization_memberships om
              on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
            where m.chapter_id = c.id and m.status = 'active'
          ) totals
          join lateral (
            select s.score, s.member_count from public.chapter_health_snapshots s
            where s.chapter_id = c.id order by s.measured_on desc limit 1
          ) latest on true
          where c.organization_id = org and totals.member_count >= health_threshold
            and latest.member_count >= health_threshold
        ) qualified
        union all
        select 100 + c.order_index, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'chapter:' || c.id || ':health-trend',
          'label', c.name || ' health trend',
          'description', 'Protected chapter score history.',
          'scope', 'chapter',
          'chapterId', c.id,
          'rows', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'label', s.measured_on::text, 'value', s.score
            ) order by s.measured_on)
            from public.chapter_health_snapshots s
            where s.chapter_id = c.id and s.member_count >= greatest(privacy_threshold, health_threshold)
          ), '[]'::jsonb)
        )
        from public.chapters c
        where c.organization_id = org
          and (select pg_catalog.count(*) from public.member_chapter_memberships m
               join public.organization_memberships om
                 on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
               where m.chapter_id = c.id and m.status = 'active') >= privacy_threshold
      ) dataset
    ), '[]'::jsonb),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', l.id,
        'organizationId', l.organization_id,
        'name', l.name,
        'scope', l.scope,
        'chapterId', l.chapter_id,
        'spec', l.spec,
        'canEdit', l.owner_user_id = (select auth.uid())
          or private.has_organization_role(org, array['admin']),
        'updatedAt', l.updated_at
      ) order by l.updated_at desc)
      from public.organization_analytics_layouts l
      where l.organization_id = org
        and (
          (l.scope = 'personal' and l.owner_user_id = (select auth.uid()))
          or l.scope in ('chapter', 'organization')
        )
    ), '[]'::jsonb)
  );
end;
end;
$function$;

-- public.get_advisor_overview
CREATE OR REPLACE FUNCTION public.get_advisor_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid := private.current_member_organization();
  members_covered integer;
  open_cases integer;
  resolved_cases integer;
  overdue_cases integer;
  steward_count integer;
  turnout jsonb;
  mfa_ok boolean := false;
  mobile_org uuid;
  elevated_org uuid;
  caller_has_scopes boolean := false;
  staff_chapters text[] := '{}'::text[];
  coordinator_ids uuid[] := '{}'::uuid[];
begin
  if caller is null or not public.member_has_role(array['advisor', 'admin']) then
    raise exception 'advisor role required' using errcode = '42501';
  end if;
  -- A legacy advisor on an ownerless chapter resolves no organization; only a
  -- platform caller is refused, and only platform-owned rows leave the totals.
  if private.organization_is_platform(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- The selected workspace, never a NULL legacy role row, sets the scope.
  -- Keep an explicitly selected ownerless legacy chapter isolated as well.
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null or not exists (
    select 1 from public.chapters chapter where chapter.id = caller_chapter
      and chapter.organization_id is not distinct from caller_org
  ) then
    raise exception 'organization or legacy chapter required' using errcode = '42501';
  end if;

  -- Caller-constant half of the staff case read. SQL CASE below stops before
  -- the coordinator and grievance branches when an elevated organization role
  -- already admits the row, which is the desk that was paying once per case.
  mfa_ok := private.mfa_satisfied();
  mobile_org := private.current_mobile_staff_organization();
  if mobile_org is not null
    and private.has_organization_role(mobile_org, array['advisor', 'admin', 'vp']) then
    elevated_org := mobile_org;
  end if;
  caller_has_scopes := exists (
    select 1 from (select * from private.steward_assignment_scopes(caller,null) where not legacy_chapter_coverage) scope_row
    where scope_row.user_id = caller
  );
  select coalesce(pg_catalog.array_agg(chapter.id), '{}'::text[])
    into staff_chapters
  from public.chapters chapter
  where private.actor_has_chapter_staff_role(caller, chapter.id);
  select coalesce(pg_catalog.array_agg(visible.id), '{}'::uuid[])
    into coordinator_ids
  from private.staff_visible_member_ids('coordinator') visible(id);

  select pg_catalog.count(*)
  into members_covered
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.chapter_id = caller_chapter
    and not private.chapter_belongs_to_platform(p.chapter_id);

  with base as materialized (
    select c.status, c.deadline, c.time_zone
    from public.member_cases c
    join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
    where c.organization_id is not distinct from caller_org
      and c.chapter_id = caller_chapter
      and not private.organization_is_platform(c.organization_id)
      and (
        (c.organization_id is null and caller_org is null)
        or (
          c.learning_undone_at is null
          and mfa_ok
          and case
            when c.user_id = caller then true
            when c.organization_id is not null
              and c.chapter_id is not null
              and case
                when c.user_id = caller then true
                when not caller_has_scopes
                  and not exists (
                    select 1 from private.case_identity_privacy privacy
                    where privacy.case_id = c.id
                  )
                  then true
                else private.actor_case_scope_and_identity_allowed(caller, c)
              end
              and case
                when c.chapter_id = any (staff_chapters)
                  and (
                    c.steward_user_id = caller
                    or c.coordinator_user_id = caller
                    or (elevated_org is not null and c.organization_id = elevated_org)
                    or c.user_id = any (coordinator_ids)
                  )
                  and (
                    not c.is_restricted
                    or c.steward_user_id = caller
                    or c.coordinator_user_id = caller
                    or (elevated_org is not null and c.organization_id = elevated_org)
                    or private.casework_actor_has_active_grant(c.id)
                  )
                  then true
                when c.organization_id = caller_org
                  and private.actor_role_covers_member(caller, c.chapter_id, 'coordinator', c.user_id, true)
                  and (
                    not c.is_restricted
                    or c.coordinator_user_id = caller
                    or private.casework_actor_has_active_grant(c.id)
                  )
                  then true
                else false
              end
              then true
            when c.user_id <> caller
              and not c.is_restricted
              and c.organization_id = caller_org
              and coalesce((select policy.steward_grievances from private.chapter_access_policies policy where policy.chapter_id = c.chapter_id), true)
              and private.chapter_grievance_steward_scope(c.chapter_id, c.user_id)
              and private.member_case_row_visible(c)
              then true
            else false
          end
        )
      )
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline < private.local_day(b.time_zone, pg_catalog.now()))
  into open_cases, resolved_cases, overdue_cases
  from base b;

  -- Resolve chapter and organization grants through the same live scope
  -- projection as the staff roster. Membership in a second tenant never
  -- transfers a steward grant there.
  if caller_org is not null then
    select pg_catalog.count(*) into steward_count
    from public.organization_memberships membership
    where membership.organization_id = caller_org and membership.status = 'active'
      and private.organization_member_roles(membership.user_id, caller_org, caller_chapter) @> '["steward"]'::jsonb;
  else
    -- No organization-wide NULL role can be attributed to an ownerless
    -- chapter. Its exact chapter steward remains valid, including #6369.
    select pg_catalog.count(distinct r.user_id) into steward_count
    from public.member_roles r
    where r.role = 'steward' and r.chapter_id = caller_chapter;
  end if;

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and b.organization_id is not distinct from caller_org
    and (b.chapter_id = caller_chapter or (caller_org is not null and b.chapter_id is null))
    and b.campaign_state <> 'draft'
    and not private.organization_is_platform(b.organization_id)
  order by b.closes_at desc, b.id
  limit 1;

  return pg_catalog.jsonb_build_object(
    'membersCovered', members_covered,
    'openGrievances', open_cases,
    'resolvedGrievances', resolved_cases,
    'stewardCount', steward_count,
    'coverageRatio', case when steward_count = 0 then null
      else pg_catalog.round(members_covered::numeric / steward_count) end,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'turnout', turnout,
    'atRisk', pg_catalog.jsonb_build_object(
      'overdueCases', overdue_cases,
      'unstaffed', steward_count = 0));
end;
$function$;

-- private.workload_rebalancing
CREATE OR REPLACE FUNCTION private.workload_rebalancing(p_chapter text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with chapter_scope as materialized (
    select c.organization_id, private.caller_unit_limited_in_chapter(p_chapter) as unit_limited
    from public.chapters c
    where c.id = p_chapter
  ), steward_roster as materialized (
    select distinct p.id as steward_id, p.full_name
    from public.member_profiles p
    cross join chapter_scope
    where p.chapter_id = p_chapter
      -- A steward limited to some units sees itself, the chapter-wide and
      -- organization-wide stewards and the stewards whose unit or committee
      -- scope overlaps its own. An
      -- organization-wide staff grant wins over a unit scope left from before
      -- it was granted.
      and (not chapter_scope.unit_limited
        or p.id = (select auth.uid())
        or exists (
          select 1 from public.organization_role_grants broad
          join public.organization_memberships membership
            on membership.user_id = broad.user_id and membership.organization_id = broad.organization_id
           and membership.status = 'active'
          where broad.user_id = p.id and broad.organization_id = chapter_scope.organization_id
            and broad.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
        -- #9043: a chapter-wide staff grant in this chapter (a role row with no
        -- unit or committee scope for that role, as
        -- private.member_has_chapter_role reads it) wins over a unit steward
        -- scope too.
        or exists (
          select 1 from public.member_role_chapters chapter_grant
          join public.member_chapter_memberships chapter_membership
            on chapter_membership.user_id = chapter_grant.user_id
           and chapter_membership.chapter_id = chapter_grant.chapter_id
           and chapter_membership.status = 'active'
          where chapter_grant.user_id = p.id and chapter_grant.chapter_id = p_chapter
            and chapter_grant.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
            and not exists (
              select 1 from private.chapter_role_scopes grant_scope
              where grant_scope.user_id = chapter_grant.user_id
                and grant_scope.chapter_id = chapter_grant.chapter_id
                and grant_scope.role = chapter_grant.role))
        or not exists (
          select 1 from private.chapter_role_scopes steward_scope
          where steward_scope.user_id = p.id and steward_scope.chapter_id = p_chapter
            and steward_scope.role = 'steward')
        or exists (
          select 1 from private.chapter_role_scopes steward_scope
          join private.chapter_role_scopes caller_scope
            on caller_scope.user_id = (select auth.uid()) and caller_scope.chapter_id = p_chapter
           and (steward_scope.unit_id = caller_scope.unit_id or steward_scope.committee_id = caller_scope.committee_id)
          where steward_scope.user_id = p.id and steward_scope.chapter_id = p_chapter
            and steward_scope.role = 'steward'))
      and (
        (
          chapter_scope.organization_id is not null
          and private.organization_member_roles(
            p.id,
            chapter_scope.organization_id,
            p_chapter
          ) ? 'steward'
        )
        or (
          chapter_scope.organization_id is null
          and exists (
            select 1
            from public.member_roles legacy_role
            where legacy_role.user_id = p.id
              and legacy_role.role = 'steward'
              and (legacy_role.chapter_id is null or legacy_role.chapter_id = p_chapter)
          )
        )
      )
    order by p.full_name, p.id
    limit 50
  ), counts as (
    select s.steward_id, s.full_name,
      pg_catalog.count(c.id)::integer as active,
      pg_catalog.count(c.id) filter (
        where c.deadline between private.local_day(c.time_zone, pg_catalog.now()) and private.local_day(c.time_zone, pg_catalog.now()) + 6)::integer as due_soon,
      pg_catalog.count(c.id) filter (where c.deadline < private.local_day(c.time_zone, pg_catalog.now()))::integer as overdue
    from steward_roster s
    left join public.member_cases c on c.steward_user_id = s.steward_id
      and c.status = 'active' and c.learning_undone_at is null
      and not private.organization_is_platform(c.organization_id)
      and exists (
        select 1 from public.member_profiles owner
        where owner.id = c.user_id and owner.chapter_id = p_chapter)
      -- and counts only the cases of members it may see.
      and (not (select scope.unit_limited from chapter_scope scope) or private.caller_may_see_member(c.user_id))
    group by s.steward_id, s.full_name
  ), mean as (
    select coalesce(pg_catalog.avg(active), 0) as avg_active from counts
  ), ranked_high as (
    select c.*, pg_catalog.row_number() over (order by active desc, overdue desc, steward_id) as rn
    from counts c, mean m where c.active >= pg_catalog.ceil(m.avg_active)::integer + 2
  ), ranked_low as (
    select c.*, pg_catalog.row_number() over (order by active asc, overdue asc, steward_id) as rn
    from counts c, mean m where c.active <= greatest(pg_catalog.floor(m.avg_active)::integer - 1, 0)
  ), suggestions as (
    select h.steward_id as from_id, h.full_name as from_name,
      l.steward_id as to_id, l.full_name as to_name,
      least(greatest((h.active - l.active) / 2, 1), 10)::integer as review_count,
      h.active as from_active, l.active as to_active
    from ranked_high h join ranked_low l using (rn)
    where h.steward_id <> l.steward_id
    order by h.active desc, l.active asc, h.steward_id, l.steward_id
    limit 10
  )
  select pg_catalog.jsonb_build_object(
    'stewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', c.steward_id, 'name', c.full_name, 'activeCases', c.active,
      'dueSoon', c.due_soon, 'overdue', c.overdue) order by c.full_name, c.steward_id) from counts c), '[]'::jsonb),
    'suggestions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fromUserId', s.from_id, 'fromName', s.from_name,
      'toUserId', s.to_id, 'toName', s.to_name,
      'reviewCount', s.review_count, 'fromActiveCases', s.from_active,
      'toActiveCases', s.to_active) order by s.from_active desc, s.from_id) from suggestions s), '[]'::jsonb)
  );
$function$;

-- private.automation_v2_candidates
CREATE OR REPLACE FUNCTION private.automation_v2_candidates(p_definition_id uuid, p_deduplicate boolean DEFAULT true)
 RETURNS TABLE(source_kind text, source_id text, chapter_id text, sort_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 with d as (select * from public.organization_automation_definitions where id=p_definition_id and schema_version=2),
 raw as (
 select 'task'::text kind,t.id::text id,t.chapter_id,t.updated_at sort_at,t.status
 from d join public.chapter_tasks t on true join public.chapters ch on ch.id=t.chapter_id
 where ch.organization_id=d.organization_id and t.deleted_at is null and t.status<>'done'
 and not exists(select 1 from public.organization_automation_effects e where e.planned_task_id=t.id)
 and case d.trigger_kind
   when 'overdue_task' then t.due_date <= (select private.eastern_day())-d.threshold_days -- fixed-zone: a task's due date moves with the tasks part of #9446
   when 'task_due' then t.due_date between (select private.eastern_day()) and (select private.eastern_day())+d.threshold_days -- fixed-zone: a task's due date moves with the tasks part of #9446
   when 'blocked_task' then t.blocked
   when 'unassigned_task' then t.assignee_id is null and not exists(select 1 from public.chapter_task_assignments a where a.task_id=t.id)
   when 'stale_task' then t.updated_at <= now()-d.threshold_days*interval '24 hours'
   when 'review_task' then t.status='needs_review' and t.updated_at<=now()-d.threshold_days*interval '24 hours'
   else false end
 union all
 select 'case',c.id::text,c.chapter_id,c.created_at,c.status
 from d join public.member_cases c on c.organization_id=d.organization_id
 where c.chapter_id is not null and c.status='active' and case d.trigger_kind
 when 'case_deadline' then c.deadline <= private.local_day(c.time_zone, pg_catalog.now())+d.threshold_days
 when 'unassigned_case' then c.steward_user_id is null and c.coordinator_user_id is null
 -- Restored stale_contact_followup (20261003030000): one source per member,
 -- the member's oldest active case, when the organization recorded no contact
 -- with that member inside the window.
 when 'stale_member_contact' then c.created_at <= now()-d.threshold_days*interval '24 hours'
   and c.id=(select o.id from public.member_cases o where o.organization_id=c.organization_id and o.user_id=c.user_id
     and o.status='active' and o.chapter_id is not null order by o.created_at,o.id limit 1)
   and exists(select 1 from public.organization_memberships m where m.organization_id=c.organization_id and m.user_id=c.user_id and m.status='active')
   and not exists(select 1 from public.member_case_contacts x join public.member_cases xc on xc.id=x.case_id and xc.organization_id=c.organization_id
     where x.user_id=c.user_id and x.contacted_at>now()-d.threshold_days*interval '24 hours')
   and not exists(select 1 from public.chapter_contact_log x where x.organization_id=c.organization_id and x.subject_user_id=c.user_id
     and x.archived_at is null and x.occurred_at>now()-d.threshold_days*interval '24 hours')
   and not exists(select 1 from public.member_contact_notes x join public.chapters xch on xch.id=x.chapter_id and xch.organization_id=c.organization_id
     where x.member_user_id=c.user_id and x.created_at>now()-d.threshold_days*interval '24 hours')
 else false end
 union all
 select 'casework_deadline',x.id::text,x.chapter_id,x.due_at,x.status
 from d join public.casework_deadlines x on x.organization_id=d.organization_id
 join public.member_cases c on c.id=x.case_id and c.organization_id=x.organization_id and c.chapter_id=x.chapter_id
 where d.trigger_kind='casework_deadline' and c.status='active' and x.status in ('active','missed')
 and x.due_at <= now()+d.threshold_days*interval '24 hours'
 and (not d.conditions ? 'deadlineKind' or x.kind=d.conditions->>'deadlineKind')
 union all
 select 'checklist',x.id::text,x.chapter_id,x.created_at,null::text
 from d join public.casework_checklists x on x.organization_id=d.organization_id
 join public.member_cases c on c.id=x.case_id and c.organization_id=x.organization_id and c.chapter_id=x.chapter_id
 where d.trigger_kind='incomplete_case_checklist' and c.status='active' and x.completed_at is null
 and exists(select 1 from public.casework_checklist_items i where i.checklist_id=x.id and i.organization_id=x.organization_id and i.required and i.completed_at is null)
 union all
 select 'appointment',a.id::text,a.chapter_id,a.starts_at,a.status
 from d join public.member_appointments a on true join public.chapters ch on ch.id=a.chapter_id and ch.organization_id=d.organization_id
 where case d.trigger_kind
 when 'appointment_upcoming' then a.status='confirmed' and a.starts_at between now() and now()+d.threshold_days*interval '24 hours'
 when 'appointment_followup' then a.status in ('completed','no_show') and a.ends_at between now()-d.threshold_days*interval '24 hours' and now()
 else false end
 union all
 select 'event',e.id,e.chapter_id,e.starts_at,null::text
 from d join public.member_events e on true join public.chapters ch on ch.id=e.chapter_id and ch.organization_id=d.organization_id
 where e.cancelled_at is null and case d.trigger_kind
 when 'event_upcoming' then e.starts_at between now() and now()+d.threshold_days*interval '24 hours'
 -- Events have a start instant, not a completion state. Follow-up means after
 -- the recorded start; the UI must not claim the event was completed.
 when 'event_followup' then e.starts_at between now()-d.threshold_days*interval '24 hours' and now()
 else false end
 )
 select r.kind,r.id,r.chapter_id,r.sort_at from raw r cross join d
 -- A scheduled, approved default recipe may cover non-restricted work across
 -- its organization. Manual evaluations retain the actor's own visibility.
 -- The executor separately requires d.updated_by to remain a live approver;
 -- source scope alone never grants execution authority.
 where case when auth.uid() is null and d.recipe_key is not null
              and d.status = 'active' and d.review_status = 'approved'
              and d.review_version = d.version
              and private.automation_v2_operator(d.updated_by, d.organization_id)
   then private.automation_recipe_source_in_scope(d.organization_id,r.kind,r.id)
   else private.automation_v2_source_visible(coalesce(auth.uid(),d.updated_by),d.organization_id,r.kind,r.id) end
 and (not d.conditions ? 'chapterId' or r.chapter_id=d.conditions->>'chapterId')
 -- Case-family context always identifies the parent case. Effect provenance
 -- still identifies the actual deadline/checklist that matched the predicate.
 and (not d.conditions ? 'sourceId' or case r.kind
   when 'casework_deadline' then exists(select 1 from public.casework_deadlines x where x.id::text=r.id and x.case_id::text=d.conditions->>'sourceId')
   when 'checklist' then exists(select 1 from public.casework_checklists x where x.id::text=r.id and x.case_id::text=d.conditions->>'sourceId')
   else r.id=d.conditions->>'sourceId' end)
 and (not d.conditions ? 'status' or r.status=d.conditions->>'status')
 and (not d.conditions ? 'priority' or exists(select 1 from public.chapter_tasks t where r.kind='task' and t.id::text=r.id and t.priority=d.conditions->>'priority'))
 and (not d.conditions ? 'assignment' or exists(select 1 from public.chapter_tasks t where r.kind='task' and t.id::text=r.id
   and (t.assignee_id is not null or exists(select 1 from public.chapter_task_assignments a where a.task_id=t.id))=(d.conditions->>'assignment'='assigned')))
 -- Action no-ops never consume the first page of a capped run or starve later
 -- eligible sources. The executor repeats these checks after row locking.
 and (d.action_kind<>'assign_task' or exists(select 1 from public.chapter_tasks t where t.id::text=r.id and r.kind='task' and t.assignee_id is null
   and not exists(select 1 from public.chapter_task_assignments a where a.task_id=t.id)))
 and (d.action_kind<>'raise_task_priority' or exists(select 1 from public.chapter_tasks t where t.id::text=r.id and r.kind='task'
   and array_position(array['low','medium','high'],t.priority)<array_position(array['low','medium','high'],d.action_config->>'priority')))
 and (not p_deduplicate or not exists(select 1 from public.organization_automation_effects e
 where e.organization_id=d.organization_id and e.definition_id=d.id and e.source_kind=r.kind and e.source_id=r.id and e.status in ('pending','created')))
 order by r.sort_at,r.id;
$function$;

-- private.cr108_candidate_count
CREATE OR REPLACE FUNCTION private.cr108_candidate_count(p_organization_id uuid, p_definition_id uuid, p_trigger_kind text, p_threshold_days integer)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  total bigint := 0;
begin
  if exists(select 1 from public.organization_automation_definitions where id=p_definition_id and organization_id=p_organization_id and schema_version=2) then
    return (select count(*)::integer from private.automation_v2_candidates(p_definition_id));
  end if;
  case p_trigger_kind
    when 'overdue_task' then
      select pg_catalog.count(*) into total
      from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id
      where ch.organization_id = p_organization_id
        and t.deleted_at is null
        and t.status <> 'done'
        and t.due_date is not null
        and t.due_date <= (select private.eastern_day()) - p_threshold_days -- fixed-zone: a task's due date moves with the tasks part of #9446
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'task'
            and e.source_id = t.id::text
            and e.status in ('pending', 'created')
        );
    when 'case_deadline' then
      select pg_catalog.count(*) into total
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.deadline is not null
        and c.deadline <= private.local_day(c.time_zone, pg_catalog.now()) + p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        );
    when 'unassigned_case' then
      select pg_catalog.count(*) into total
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.steward_user_id is null
        and c.coordinator_user_id is null
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        );
    else
      raise exception 'unsupported automation trigger' using errcode = '22023';
  end case;
  return total::integer;
end;
$function$;

-- private.cr108_candidate_sources
CREATE OR REPLACE FUNCTION private.cr108_candidate_sources(p_organization_id uuid, p_definition_id uuid, p_trigger_kind text, p_threshold_days integer, p_limit integer)
 RETURNS TABLE(source_kind text, source_id uuid, chapter_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_limit not between 1 and 50 then
    raise exception 'automation effect limit out of range' using errcode = '22023';
  end if;
  case p_trigger_kind
    when 'overdue_task' then
      return query
      select 'task'::text, t.id, t.chapter_id
      from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id
      where ch.organization_id = p_organization_id
        and t.deleted_at is null
        and t.status <> 'done'
        and t.due_date is not null
        and t.due_date <= (select private.eastern_day()) - p_threshold_days -- fixed-zone: a task's due date moves with the tasks part of #9446
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'task'
            and e.source_id = t.id::text
            and e.status in ('pending', 'created')
        )
      order by t.due_date, t.created_at, t.id
      limit p_limit;
    when 'case_deadline' then
      return query
      select 'case'::text, c.id, c.chapter_id
      from public.member_cases c
      where c.organization_id = p_organization_id and c.learning_undone_at is null
        and c.chapter_id is not null
        and c.status = 'active'
        and c.deadline is not null
        and c.deadline <= private.local_day(c.time_zone, pg_catalog.now()) + p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        )
      order by c.deadline, c.created_at, c.id
      limit p_limit;
    when 'unassigned_case' then
      return query
      select 'case'::text, c.id, c.chapter_id
      from public.member_cases c
      where c.organization_id = p_organization_id and c.learning_undone_at is null
        and c.chapter_id is not null
        and c.status = 'active'
        and c.steward_user_id is null
        and c.coordinator_user_id is null
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        )
      order by c.created_at, c.id
      limit p_limit;
    else
      raise exception 'unsupported automation trigger' using errcode = '22023';
  end case;
end;
$function$;

-- public.get_member_home_bootstrap
CREATE OR REPLACE FUNCTION public.get_member_home_bootstrap(p_action_log_since timestamp with time zone, p_resources text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.require_member_session();
  if p_action_log_since is null then
    raise exception 'action log window required' using errcode = '22023';
  end if;
  if p_resources is null or pg_catalog.cardinality(p_resources) = 0 then
    raise exception 'resource list required' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object(
    'user_id', caller,
    -- select * ... eq user_id ... order created_at desc
    'member_notifications', case when 'member_notifications' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
      from (select * from public.member_notifications where user_id = caller order by created_at desc limit 1000) t) end,
    -- select role ... eq user_id
    'member_roles', case when 'member_roles' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role', t.role)), '[]'::jsonb)
      from (select role from public.member_roles where user_id = caller limit 1000) t) end,
    -- select id,name ... order order_index
    'chapters', case when 'chapters' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'name', t.name) order by t.order_index), '[]'::jsonb)
      from (select id, name, order_index from public.chapters order by order_index limit 1000) t) end,
    -- select MEMBER_CASE_COLUMNS ... eq user_id ... order updated_at desc (time_zone: #9446)
    'member_cases', case when 'member_cases' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.updated_at desc), '[]'::jsonb)
      from (select id, user_id, reference, title, deadline, case_type, articles, step, status, created_at, updated_at, steward_name, coordinator_name, time_zone
            from public.member_cases where user_id = caller order by updated_at desc limit 1000) t) end,
    -- select id,case_id,user_id,body,occurred_on,created_at ... eq user_id ... order created_at
    'member_case_updates', case when 'member_case_updates' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.created_at), '[]'::jsonb)
      from (select id, case_id, user_id, body, occurred_on, created_at from public.member_case_updates where user_id = caller order by created_at limit 1000) t) end,
    -- select id,sender,title,body,published_at,locale,audience_scope ... is retracted_at null ... order published_at desc ... limit 50
    'member_broadcasts', case when 'member_broadcasts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.published_at desc), '[]'::jsonb)
      from (select id, sender, title, body, published_at, locale, audience_scope
            from public.member_broadcasts where retracted_at is null order by published_at desc limit 50) t) end,
    -- select broadcast_id,read_at ... eq user_id
    'member_broadcast_receipts', case when 'member_broadcast_receipts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select broadcast_id, read_at from public.member_broadcast_receipts where user_id = caller limit 1000) t) end,
    -- select <ballot columns>,member_ballot_options(id,ballot_id,label,label_es,order_index) ... order order_index
    'member_ballots', case when 'member_ballots' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select b.id, b.title, b.title_es, b.body, b.body_es, b.closes_at, b.active, b.order_index, b.quorum_target, b.chapter_id,
                   b.campaign_state, b.published_at, b.closed_at,
                   (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.order_index), '[]'::jsonb)
                    from (select id, ballot_id, label, label_es, order_index from public.member_ballot_options where ballot_id = b.id) o)
                     as member_ballot_options
            from public.member_ballots b order by b.order_index limit 1000) t) end,
    -- select <survey columns>,member_survey_options(id,survey_id,label,label_es,order_index) ... order order_index
    'member_surveys', case when 'member_surveys' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select s.id, s.title, s.title_es, s.body, s.body_es, s.closes_at, s.active, s.order_index, s.chapter_id,
                   s.campaign_state, s.published_at, s.closed_at,
                   (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.order_index), '[]'::jsonb)
                    from (select id, survey_id, label, label_es, order_index from public.member_survey_options where survey_id = s.id) o)
                     as member_survey_options
            from public.member_surveys s order by s.order_index limit 1000) t) end,
    -- select survey_id,option_id ... eq user_id
    'member_survey_responses', case when 'member_survey_responses' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select survey_id, option_id from public.member_survey_responses where user_id = caller limit 1000) t) end,
    -- select * ... order order_index
    'member_rights_lessons', case when 'member_rights_lessons' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select * from public.member_rights_lessons order by order_index limit 1000) t) end,
    -- select lesson_id,completed_steps ... eq user_id
    'member_rights_progress', case when 'member_rights_progress' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select lesson_id, completed_steps from public.member_rights_progress where user_id = caller limit 1000) t) end,
    -- select action_key,action_kind,occurred_at ... eq user_id ... gte occurred_at <since> ... order occurred_at
    'member_action_log', case when 'member_action_log' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.occurred_at), '[]'::jsonb)
      from (select action_key, action_kind, occurred_at from public.member_action_log
            where user_id = caller and occurred_at >= p_action_log_since order by occurred_at limit 1000) t) end,
    -- select ballot_id,receipt_code,issued_at ... eq user_id
    'member_ballot_receipts', case when 'member_ballot_receipts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select ballot_id, receipt_code, issued_at from public.member_ballot_receipts where user_id = caller limit 1000) t) end,
    -- select event_id,status ... eq user_id
    'member_event_rsvps', case when 'member_event_rsvps' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select event_id, status from public.member_event_rsvps where user_id = caller limit 1000) t) end,
    -- select event_id ... eq user_id
    'member_event_checkins', case when 'member_event_checkins' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select event_id from public.member_event_checkins where user_id = caller limit 1000) t) end,
    -- select action_kind,label,points,weekly_cap ... order points desc
    'member_point_rules', case when 'member_point_rules' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.points desc), '[]'::jsonb)
      from (select action_kind, label, points, weekly_cap from public.member_point_rules order by points desc limit 1000) t) end,
    -- select tier,name,min_points ... order tier
    'member_reward_tiers', case when 'member_reward_tiers' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.tier), '[]'::jsonb)
      from (select tier, name, min_points from public.member_reward_tiers order by tier limit 1000) t) end
  );
end;
$function$;

-- private.learning_casework_stable
CREATE OR REPLACE FUNCTION private.learning_casework_stable(p_table text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when p_row is null then null
    when p_table = 'casework_reminders' then p_row - array['updated_at', 'last_fired_at']::text[]
    when p_table = 'casework_deadlines' then p_row - array['updated_at', 'reminder_sent_at', 'reminder_disposition', 'time_zone']::text[]
    else p_row - 'updated_at'
  end;
$function$;

-- private.learning_undo_casework
CREATE OR REPLACE FUNCTION private.learning_undo_casework(p_mode text, p_entry jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  t text := pg_catalog.substr(p_entry ->> 'target_table', 8);
  target text := p_entry ->> 'target_id';
  v private.casework_record_versions%rowtype;
  v_row jsonb;
begin
  select r.* into v from private.casework_record_versions r where r.id = (p_entry ->> 'before_ref')::bigint;
  v_row := coalesce(v.new_row, v.old_row);
  if p_mode = 'lock' then
    case t
      when 'casework_step_transitions' then perform 1 from public.casework_step_transitions x where x.id::text = target for update;
      when 'casework_deadlines' then perform 1 from public.casework_deadlines x where x.id::text = target for update;
      when 'casework_deadline_extensions' then perform 1 from public.casework_deadline_extensions x where x.id::text = target for update;
      when 'casework_checklists' then perform 1 from public.casework_checklists x where x.id::text = target for update;
      when 'casework_checklist_items' then perform 1 from public.casework_checklist_items x where x.id::text = target for update;
      when 'casework_reminders' then perform 1 from public.casework_reminders x where x.id::text = target for update;
      when 'casework_intake_drafts' then perform 1 from public.casework_intake_drafts x where x.id::text = target for update;
      when 'casework_strength_analyses' then perform 1 from public.casework_strength_analyses x where x.id::text = target for update;
      else null;
    end case;
    return null;
  elsif p_mode = 'state' then
    return private.learning_casework_row_state(t, target);
  elsif p_mode = 'before' then
    return case when v.old_row is null then null else private.learning_casework_stable(t, v.old_row) end;
  elsif p_mode = 'check' then
    if v.id is null or v.record_table is distinct from t or v.record_id is distinct from target then
      raise exception 'this practice action can no longer be undone' using errcode = '55000';
    end if;
    -- Today's rule of the writer that made the change, per table and
    -- operation: a reminder is its owner's while they can still read the
    -- case; a draft is its writer's while they still hold the drafting role
    -- (and the case it names is in scope); an extension request is its
    -- requester's while they may still request one (the case's member or
    -- staff who can work on it); every other workflow change (steps,
    -- deadlines, decisions, checklists, scores) needs staff who can work on
    -- the case today.
    if not private.mfa_satisfied() or not coalesce(case
         when t = 'casework_reminders' then
           (v_row ->> 'owner_user_id')::uuid = caller and private.casework_can_read((v_row ->> 'case_id')::uuid)
         when t = 'casework_intake_drafts' then
           v.actor = caller
           and private.member_has_chapter_staff_grant(v_row ->> 'chapter_id', array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
           and (v_row ->> 'member_user_id' is null or private.chapter_staff_member_allowed(v_row ->> 'chapter_id', (v_row ->> 'member_user_id')::uuid, array['steward','coordinator','advisor','admin','vp']))
           and (v.old_row ->> 'member_user_id' is null or private.chapter_staff_member_allowed(v.old_row ->> 'chapter_id', (v.old_row ->> 'member_user_id')::uuid, array['steward','coordinator','advisor','admin','vp']))
           and (v_row ->> 'case_id' is null or private.casework_staff_can_access((v_row ->> 'case_id')::uuid))
           and (v.old_row ->> 'case_id' is null or private.casework_staff_can_access((v.old_row ->> 'case_id')::uuid))
           and (v_row ->> 'case_id' is null or private.casework_scope_matches((v_row ->> 'case_id')::uuid,
             (v_row ->> 'organization_id')::uuid, v_row ->> 'chapter_id'))
         when v.case_id is null then false
         when t = 'casework_deadline_extensions' and v.op = 'INSERT' then
           v.actor = caller and private.casework_can_read(v.case_id)
           and (private.casework_member_owns(v.case_id) or private.casework_staff_can_access(v.case_id))
         else private.casework_staff_can_access(v.case_id)
       end, false) then
      raise exception 'you can no longer change this case' using errcode = '42501';
    end if;
    -- Taking away a deadline someone asked to extend would detach the request.
    if v.op = 'INSERT' and t = 'casework_deadlines'
       and exists (select 1 from public.casework_deadline_extensions e where e.deadline_id::text = target) then
      raise exception 'this has changed since your practice action' using errcode = 'PT409';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if v.op = 'INSERT' then
    if t = 'casework_step_transitions' then
      perform private.learning_reverse_transition((v.new_row ->> 'case_id')::uuid, v.new_row ->> 'to_step', v.new_row ->> 'from_step');
    else
      case t
        when 'casework_deadlines' then delete from public.casework_deadlines x where x.id::text = target;
        when 'casework_deadline_extensions' then delete from public.casework_deadline_extensions x where x.id::text = target;
        when 'casework_checklists' then delete from public.casework_checklists x where x.id::text = target;
        when 'casework_checklist_items' then delete from public.casework_checklist_items x where x.id::text = target;
        when 'casework_reminders' then delete from public.casework_reminders x where x.id::text = target;
        when 'casework_intake_drafts' then delete from public.casework_intake_drafts x where x.id::text = target;
        when 'casework_strength_analyses' then delete from public.casework_strength_analyses x where x.id::text = target;
        else null;
      end case;
    end if;
  elsif v.op = 'UPDATE' then
    case t
        when 'casework_step_transitions' then update public.casework_step_transitions x set (case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, created_at, procedure_transaction_id) =
          (select r.case_id, r.organization_id, r.chapter_id, r.from_step, r.to_step, r.outcome, r.transitioned_by, r.idempotency_key, r.created_at, r.procedure_transaction_id from pg_catalog.jsonb_populate_record(null::public.casework_step_transitions, v.old_row) r)
          where x.id::text = target;
        when 'casework_deadlines' then
          perform private.restore_case_deadline_zone('casework_deadlines', target::uuid, v.old_row);
          update public.casework_deadlines x set (case_id, organization_id, chapter_id, kind, label, due_at, status, reminder_at, created_by, created_at, updated_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.kind, r.label, r.due_at, r.status, r.reminder_at, r.created_by, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_deadlines, v.old_row) r)
          where x.id::text = target;
          -- An unused restore never outlives its statement.
          perform pg_catalog.set_config('unionground.case_deadline_zone_restore', '', true);
        when 'casework_deadline_extensions' then update public.casework_deadline_extensions x set (deadline_id, organization_id, requested_by, previous_due_at, requested_due_at, reason, status, decided_by, decided_at, decision_note, idempotency_key, created_at) =
          (select r.deadline_id, r.organization_id, r.requested_by, r.previous_due_at, r.requested_due_at, r.reason, r.status, r.decided_by, r.decided_at, r.decision_note, r.idempotency_key, r.created_at from pg_catalog.jsonb_populate_record(null::public.casework_deadline_extensions, v.old_row) r)
          where x.id::text = target;
        when 'casework_checklists' then update public.casework_checklists x set (case_id, organization_id, chapter_id, template_id, step, title, created_by, created_at, completed_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.template_id, r.step, r.title, r.created_by, r.created_at, r.completed_at from pg_catalog.jsonb_populate_record(null::public.casework_checklists, v.old_row) r)
          where x.id::text = target;
        when 'casework_checklist_items' then update public.casework_checklist_items x set (checklist_id, organization_id, label, position, required, completed_at, completed_by) =
          (select r.checklist_id, r.organization_id, r.label, r.position, r.required, r.completed_at, r.completed_by from pg_catalog.jsonb_populate_record(null::public.casework_checklist_items, v.old_row) r)
          where x.id::text = target;
        when 'casework_reminders' then update public.casework_reminders x set (case_id, organization_id, chapter_id, owner_user_id, title, remind_at, recurrence, status, completed_at, created_at, updated_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.owner_user_id, r.title, r.remind_at, r.recurrence, r.status, r.completed_at, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_reminders, v.old_row) r)
          where x.id::text = target;
        when 'casework_intake_drafts' then update public.casework_intake_drafts x set (organization_id, chapter_id, owner_user_id, member_user_id, case_id, payload, revision, created_at, updated_at) =
          (select r.organization_id, r.chapter_id, r.owner_user_id, r.member_user_id, r.case_id, r.payload, r.revision, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_intake_drafts, v.old_row) r)
          where x.id::text = target;
        when 'casework_strength_analyses' then update public.casework_strength_analyses x set (case_id, organization_id, chapter_id, analyzed_by, inputs, score, band, recommendations, idempotency_key, created_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.analyzed_by, r.inputs, r.score, r.band, r.recommendations, r.idempotency_key, r.created_at from pg_catalog.jsonb_populate_record(null::public.casework_strength_analyses, v.old_row) r)
          where x.id::text = target;
      else null;
    end case;
  else
    case t
        when 'casework_step_transitions' then insert into public.casework_step_transitions select * from pg_catalog.jsonb_populate_record(null::public.casework_step_transitions, v.old_row);
        when 'casework_deadlines' then
          perform private.restore_case_deadline_zone('casework_deadlines', target::uuid, v.old_row);
          insert into public.casework_deadlines select * from pg_catalog.jsonb_populate_record(null::public.casework_deadlines, v.old_row);
          perform pg_catalog.set_config('unionground.case_deadline_zone_restore', '', true);
        when 'casework_deadline_extensions' then insert into public.casework_deadline_extensions select * from pg_catalog.jsonb_populate_record(null::public.casework_deadline_extensions, v.old_row);
        when 'casework_checklists' then insert into public.casework_checklists select * from pg_catalog.jsonb_populate_record(null::public.casework_checklists, v.old_row);
        when 'casework_checklist_items' then insert into public.casework_checklist_items select * from pg_catalog.jsonb_populate_record(null::public.casework_checklist_items, v.old_row);
        when 'casework_reminders' then insert into public.casework_reminders select * from pg_catalog.jsonb_populate_record(null::public.casework_reminders, v.old_row);
        when 'casework_intake_drafts' then insert into public.casework_intake_drafts select * from pg_catalog.jsonb_populate_record(null::public.casework_intake_drafts, v.old_row);
        when 'casework_strength_analyses' then insert into public.casework_strength_analyses select * from pg_catalog.jsonb_populate_record(null::public.casework_strength_analyses, v.old_row);
      else null;
    end case;
  end if;
  return null;
end;
end;
$function$;

-- private.learning_undo_case
CREATE OR REPLACE FUNCTION private.learning_undo_case(p_mode text, p_entry jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target uuid := (p_entry ->> 'target_id')::uuid;
  case_row public.member_cases%rowtype;
  earlier jsonb;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_cases c where c.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_state(target);
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'case_create' then return null; end if;
    return private.learning_case_state_from(
      (select v.old_row from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint));
  end if;
  select c.* into case_row from public.member_cases c where c.id = target;
  if p_mode = 'check' then
    -- Today's rule for changing the case: its owner, or staff who can work on it.
    if case_row.id is null or not private.mfa_satisfied() or not (
        (case_row.user_id = caller and private.chapter_case_readable(case_row))
        or private.casework_staff_can_access(case_row.id)
        -- Whoever opened the case at intake may undo that, under the same
        -- intake rule open_member_case applies, assigned or not.
        or (p_entry ->> 'action_kind' = 'case_create' and (
          private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
          or private.chapter_case_intake_role_allows(case_row.user_id, 'coordinator')
          or private.chapter_case_intake_role_allows(case_row.user_id, 'admin')))) then
      raise exception 'you can no longer change this case' using errcode = '42501';
    end if;
    -- Undoing a member's own edit is still the member changing status,
    -- deadline and step: refused once a steward, a coordinator or an
    -- organization procedure holds the case, as update_my_member_case refuses
    -- the edit itself (#7980). Staff who can work on the case keep their undo,
    -- and so does an undo whose chain also undoes the caller's own creation of
    -- this case: the case goes as a whole, under the case_create checks below.
    if p_entry ->> 'action_kind' = 'case_edit' and not private.casework_staff_can_access(case_row.id)
       and not exists (
         select 1 from private.learning_action_journal created
         where created.id::text in (select pg_catalog.jsonb_array_elements_text(coalesce(p_entry -> 'chain_entry_ids', '[]'::jsonb)))
           and created.action_kind = 'case_create'
           and created.target_table = 'public.member_cases'
           and created.target_id = target::text
           and created.actor_user_id = caller)
       and private.member_case_managed(case_row) then
      raise exception 'case is managed by its representative' using errcode = '42501';
    end if;
    -- A step this edit moved cannot go back by hand once a procedure governs
    -- the case: the procedure's own transition is the only way to move it.
    -- The step is the one the newer undos in this chain leave (projected).
    if p_entry ->> 'action_kind' = 'case_edit'
       and coalesce(p_entry -> 'projected_state' ->> 'step', case_row.step) is distinct from (select v.old_row ->> 'step' from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint)
       and private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null
       -- A step the caller's own transition moved goes back by the reverse
       -- transition (20261104123000); any other step change still does not.
       and not exists (select 1 from public.casework_step_transitions st
         where st.case_id = target and st.to_step = coalesce(p_entry -> 'projected_state' ->> 'step', case_row.step) and st.transitioned_by = caller
           and st.from_step = (select v.old_row ->> 'step' from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint)) then
      raise exception 'this case now follows a procedure; move its step there' using errcode = '55000';
    end if;
    -- Opening a case is undone only while nobody else has worked on it:
    -- no one else's note, contact, file, outcome, audited action or change
    -- in its history.
    if p_entry ->> 'action_kind' = 'case_create' and (
        exists (select 1 from public.member_case_updates u
          where u.case_id = target and u.learning_undone_at is null and u.author_user_id is distinct from caller)
        or exists (select 1 from public.member_case_files f
          where f.case_id = target and f.removal_requested_at is null and f.uploaded_by is distinct from caller)
        or exists (select 1 from public.member_case_outcomes o where o.case_id = target and o.recorded_by is distinct from caller)
        or exists (select 1 from public.member_case_contacts k where k.case_id = target and k.coordinator_id is distinct from caller)
        or exists (select 1 from public.coordinator_case_audit a where a.case_id = target and a.actor_id is distinct from caller)
        -- A President's review and a steward's identity-privacy decision
        -- leave no case history row, so they are checked here (#7000 r2s2, r2g1).
        or exists (select 1 from public.member_vp_case_reviews r where r.case_id = target and r.reviewed_by is distinct from caller)
        -- An administrator's Action Lab action on the case (#7000 r3s3).
        or exists (select 1 from public.organization_object_action_runs a
          where a.target_kind = 'member_case' and a.target_id = target and a.actor_user_id is distinct from caller)
        or exists (select 1 from public.member_admin_audit a
          where a.action = 'grievance_identity_visibility_updated' and a.detail ->> 'caseId' = target::text
            and a.actor is distinct from caller)
        or exists (select 1 from private.casework_record_versions v
          where v.case_id = target and v.actor is not null and v.actor is distinct from caller)) then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    -- Conversion also changed a staff-managed report. Changing the task or
    -- case alone is insufficient: recheck convert_member_intake_report's
    -- current role and same-chapter readable-profile predicate before any
    -- restoring write. An ordinary creation carries no report image.
    if p_entry -> 'before_image' -> 'intake_report' ->> 'id' is not null
       and (not public.member_has_role(array['steward', 'coordinator'])
         or not exists (
           select 1 from public.member_intake_reports r
           join public.member_profiles p on p.id = caller
           where r.id = (p_entry -> 'before_image' -> 'intake_report' ->> 'id')::uuid
             and p.chapter_id = r.chapter_id)) then
      raise exception 'intake staff role required' using errcode = '42501';
    end if;
    if p_entry ->> 'action_kind' = 'case_create' then
      -- Ordinary staff intake uses open_member_case's current predicate.
      -- Conversion, import and approved forms have their own gates instead;
      -- none acquires an unrelated intake requirement from this handler.
      if p_entry -> 'before_image' -> 'intake_report' ->> 'id' is null
         and not exists (select 1 from public.member_forms f where f.case_id = target)
         and not exists (select 1 from private.learning_action_journal j
           where j.id = (p_entry ->> 'parent_entry_id')::uuid and j.action_kind = 'case_operations_import')
         and case_row.user_id is distinct from caller
         and not (private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
           or private.chapter_case_intake_role_allows(case_row.user_id, 'coordinator')
           or private.chapter_case_intake_role_allows(case_row.user_id, 'admin')) then
        raise exception 'case intake authority required' using errcode = '42501';
      end if;
      -- Freeing an approved form is open_form_as_case's steward-only action,
      -- even when an admin or coordinator could otherwise open a case.
      -- Evaluate the unlinked form the forward writer saw, without changing
      -- its stored row: linked-case readability is not form-opening authority.
      if exists (select 1 from public.member_forms f where f.case_id = target)
         and (not public.member_has_role(array['steward']) or exists (
           select 1 from public.member_forms f where f.case_id = target
             and (f.user_id = caller or not private.member_form_scope_and_identity_allowed(
                 pg_catalog.jsonb_populate_record(f, '{"case_id": null}'::jsonb))
               or not public.staff_can_see_user(f.user_id, 'steward')))) then
        raise exception 'steward role and form scope required' using errcode = '42501';
      end if;
      -- Import children retain the parent's provenance. A broad case role
      -- must not stand in for the import writer's current organization admin.
      if exists (select 1 from private.learning_action_journal j
           where j.id = (p_entry ->> 'parent_entry_id')::uuid and j.action_kind = 'case_operations_import')
         and private.require_member_operations_admin() is distinct from case_row.organization_id then
        raise exception 'admin role required' using errcode = '42501';
      end if;
    end if;
    -- A report the record was converted from must still stand as conversion
    -- left it; anyone's later triage refuses the undo.
    if not private.learning_intake_report_unchanged(p_entry -> 'before_image' -> 'intake_report') then
      raise exception 'someone else has changed this since' using errcode = 'PT409';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if p_entry ->> 'action_kind' = 'case_create' then
    update public.member_cases c set learning_undone_at = pg_catalog.clock_timestamp()
    where c.id = target and c.learning_undone_at is null;
    -- A form the case was opened from can be opened as a case again.
    update public.member_forms f set case_id = null, updated_at = pg_catalog.now() where f.case_id = target;
    -- An intake report converted into the case goes back to how it stood.
    perform private.learning_restore_intake_report(p_entry -> 'before_image' -> 'intake_report');
    return null;
  end if;
  earlier := private.learning_case_state_from(
    (select v.old_row from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint));
  if earlier is null then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  perform private.restore_case_deadline_zone('member_cases', target,
    (select v.old_row from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint));
  update public.member_cases c
  set title = earlier ->> 'title', deadline = (earlier ->> 'deadline')::date, case_type = earlier ->> 'case_type',
      articles = earlier ->> 'articles', status = earlier ->> 'status', description = earlier ->> 'description',
      filing_status = earlier ->> 'filing_status', incident_date = (earlier ->> 'incident_date')::date,
      remedy_sought = earlier ->> 'remedy_sought'
  where c.id = target;
  -- An unused restore never outlives its statement.
  perform pg_catalog.set_config('unionground.case_deadline_zone_restore', '', true);
  -- The step guard fires only on a real change; a step the edit did not
  -- move is left alone.
  if case_row.step is distinct from earlier ->> 'step' then
    if private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null then
      perform private.learning_reverse_transition(target, case_row.step, earlier ->> 'step');
    end if;
    update public.member_cases c set step = earlier ->> 'step' where c.id = target;
  end if;
  return null;
end;
end;
$function$;

comment on function private.record_time_zone(uuid, text, uuid) is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: private.group_time_zone for a stored record, never a refusal: a chapter outside the organization counts on the organization''s zone, no organization on New York''s. New York''s zone for everyone while features.governance.group_time_zones is held.';
comment on function private.set_case_deadline_time_zone() is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: the only writer of member_cases.time_zone and casework_deadlines.time_zone: the group''s zone when the row is created and when its deadline is set or moved; kept otherwise.';
comment on column public.member_cases.time_zone is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: the zone this case''s dates (its deadline, its today, its overdue) are counted in: its group''s zone when the case was created or its deadline last set. Written only by private.set_case_deadline_time_zone.';
comment on column public.casework_deadlines.time_zone is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: the zone this deadline''s day is counted in: its group''s zone when it was set or last moved. Written only by private.set_case_deadline_time_zone.';
comment on function private.casework_add_business_days(timestamptz, integer, uuid, text) is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: the end (23:59:59) of the business day p_count business days after p_start, skipping weekends and the organization''s holidays, counted on p_time_zone, the zone the deadline is set in.';

-- Reviewed call-graph change (account lifecycle inventory): the two zone
-- triggers on case tables, what they reach, and the restated version trigger.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public' and table_name in ('member_cases', 'casework_deadlines')
       and object_name in ('member_cases_time_zone', 'casework_deadlines_time_zone'))
   or (kind = 'function' and schema_name = 'private'
       and pg_catalog.split_part(object_name, '(', 1) in ('set_case_deadline_time_zone', 'capture_casework_record_version',
         'record_time_zone', 'local_day', 'group_time_zone', 'group_time_zones_released'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

commit;
