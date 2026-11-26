-- BUG-UG-REFERRAL-ACTIVATED-BEFORE-WEEKLY-CAP-IS-NEVER-PAID-20261115 (#8772).
--
-- Before this migration private.award_member_referral activated a referral,
-- then found the referring member at the weekly cap and returned with no point
-- event. The referral stayed activated, so nothing ever paid it: the credit was
-- lost, not deferred.
--
-- Now a referral over the cap waits and is paid in a later week:
-- * Activation records the payout the referring member is owed, whenever the
--   referral rule pays points, in private.member_referral_payouts_waiting:
--   only the referring member, the award key 'referral-<referral row id>' (the
--   row's random id, as before) and when it started waiting. It then pays the
--   member's waiting payouts, oldest first, while the week has room under the
--   cap; a payout made at once leaves nothing waiting.
-- * The obligation does not live on the referral row, so it outlasts the
--   referral relationship: when the referred member deletes their account the
--   referral row goes with it, as before, and the waiting payout, which names
--   no one but the referring member, stays.
-- * A payout the cap holds back is paid, oldest first, the next time the cap
--   has room: when another of the member's referrals activates, or when the
--   referring member checks in themselves. Any successful check-in counts,
--   whether or not it earns check-in points: the payer runs on the check-in
--   row itself (public.member_event_checkins), not only on a check-in point
--   event, which is not minted while check-in points are 0 (gate final r3s1).
-- * The cap week is unchanged: pg_catalog.date_trunc('week', now()) in the
--   session time zone, the same boundary private.award_member_points uses for
--   every other weekly point cap (UTC on the hosted databases, so the week
--   turns over Sunday evening Eastern).
-- * Referrals the old code consumed at the cap are found by the rule in force
--   when each one activated, read from public.member_reward_economy_revisions.
--   Under the old code an activated referral
--   was left with no point event only when the rule paid nothing (not owed) or
--   when the cap stopped it; so an activated referral with no event under its
--   key, whose rule at activation paid points and had a cap, was consumed by
--   the cap. No count of that week's awards is taken, so the order of
--   transaction-start timestamps does not matter (gate final r3s2). Those found
--   are recorded waiting and paid while the current week has room. The
--   case-graph gate is taken first, before any statement, so no old-code
--   activation can commit between the backfill's snapshot and its write (gate
--   final r4s3).
-- * A waiting payout is the referring member's own data, so it is in their
--   account export (additionalDomains.member_referral_payouts_waiting: the
--   award key and when it started waiting) until it is paid; once paid it is
--   their referral point event, which the export already carries
--   (activity.points). The payer deletes a waiting row when it pays it; one
--   the cap holds back stays until a week with room, or goes with the
--   referring account. While the rule pays nothing, rows wait (a payout owed
--   under the rule in force at activation) and stay in the export.
-- While the referral rule pays nothing (no row, or points 0) activation is
-- unchanged: the program is off and the referral is not owed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

-- The global case-graph gate every activation takes, held from here to commit
-- (gate final r4s3).
do $case_graph_gate$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
end;
$case_graph_gate$;

-- One row per payout owed and not yet paid. No client role can read it.
create table private.member_referral_payouts_waiting (
  award_key text primary key check (award_key ~ '^referral-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  referrer_user_id uuid not null references auth.users(id) on delete cascade,
  waiting_since timestamptz not null default pg_catalog.now()
);
create index member_referral_payouts_waiting_referrer_idx
  on private.member_referral_payouts_waiting (referrer_user_id, waiting_since, award_key);
alter table private.member_referral_payouts_waiting enable row level security;
alter table private.member_referral_payouts_waiting force row level security;
revoke all on table private.member_referral_payouts_waiting from public, anon, authenticated, service_role;
create trigger a00_case_graph_lock before insert or update or delete on private.member_referral_payouts_waiting
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_referral_payouts_waiting
for each row execute function private.lock_case_graph_row_keys('{referrer_user_id}', '');

-- The referral rule in force at a moment, from the economy's revision log: the
-- last saved value at or before it, else the value the first later save
-- replaced, else the rule as it stands (never changed since).
create function private.member_referral_rule_at(p_at timestamptz)
returns pg_catalog.jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (select r.new_value from public.member_reward_economy_revisions r
      where r.entity_kind = 'point_rule' and r.entity_key = 'referral' and r.created_at <= p_at
      order by r.created_at desc, r.id desc limit 1),
    (select r.old_value from public.member_reward_economy_revisions r
      where r.entity_kind = 'point_rule' and r.entity_key = 'referral' and r.created_at > p_at
        and r.old_value is not null
      order by r.created_at, r.id limit 1),
    (select pg_catalog.to_jsonb(p) from public.member_point_rules p where p.action_kind = 'referral'))
$fn$;
revoke all on function private.member_referral_rule_at(timestamptz) from public, anon, authenticated, service_role;

-- Pays the referring member's waiting payouts, oldest first, while the cap
-- week has room. Returns how many were paid. Not a client RPC.
create function private.pay_waiting_member_referrals(p_referrer uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform private.lock_case_graph(array[p_referrer], array[]::uuid[]);
declare
  v_rule record;
  v_this_week integer;
  v_key text;
  v_paid integer;
begin
  v_paid := 0;
  if not exists (
    select 1 from private.member_referral_payouts_waiting w
     where w.referrer_user_id = p_referrer) then
    return 0;
  end if;
  select points, weekly_cap into v_rule
    from public.member_point_rules
   where action_kind = 'referral' and points > 0;
  if not found then
    return 0;
  end if;
  for v_key in
    select w.award_key from private.member_referral_payouts_waiting w
     where w.referrer_user_id = p_referrer
     order by w.waiting_since, w.award_key
  loop
    if v_rule.weekly_cap is not null then
      select pg_catalog.count(*) into v_this_week
        from public.member_point_events e
       where e.user_id = p_referrer and e.action_kind = 'referral'
         and e.occurred_at >= pg_catalog.date_trunc('week', pg_catalog.now());
      if v_this_week >= v_rule.weekly_cap then
        exit;
      end if;
    end if;
    insert into public.member_point_events (user_id, action_key, action_kind, points)
    values (p_referrer, v_key, 'referral', v_rule.points)
    on conflict (user_id, action_key) do nothing;
    if found then
      v_paid := v_paid + 1;
    end if;
    delete from private.member_referral_payouts_waiting w
     where w.award_key = v_key;
  end loop;
  return v_paid;
end;
end
$fn$;
revoke all on function private.pay_waiting_member_referrals(uuid) from public, anon, authenticated, service_role;

-- Activation, shared by the check-in trigger and the recorder. The referral is
-- activated once; when the rule pays points its payout is recorded waiting and
-- the referring member's waiting payouts are paid within the cap. The award
-- key is still the referral row's own random id.
create or replace function private.award_member_referral(p_referred uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_referral uuid;
  v_referrer uuid;
begin
  perform private.lock_case_graph(array[p_referred], array[]::uuid[]);
  update private.member_referrals r
     set activated_at = pg_catalog.now()
   where r.referred_user_id = p_referred and r.activated_at is null
  returning r.id, r.referrer_user_id into v_referral, v_referrer;
  if v_referral is null then
    return;
  end if;
  if not exists (
    select 1 from public.member_point_rules pr
     where pr.action_kind = 'referral' and pr.points > 0) then
    return;
  end if;
  insert into private.member_referral_payouts_waiting (award_key, referrer_user_id)
  values ('referral-' || v_referral::pg_catalog.text, v_referrer)
  on conflict (award_key) do nothing;
  perform private.pay_waiting_member_referrals(v_referrer);
end
$fn$;

-- The referred member's first check-in point event activates the referral, and
-- a member's own check-in pays their payouts that waited on the cap.
create or replace function private.activate_member_referral()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform private.lock_case_graph(array[new.user_id], array[]::uuid[]);
  perform private.award_member_referral(new.user_id);
  perform private.pay_waiting_member_referrals(new.user_id);
  return new;
end
$fn$;

-- Any successful check-in settles the member's waiting payouts, whether or not
-- it earns check-in points (gate final r3s1).
create function private.settle_member_referrals_on_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform private.lock_case_graph(array[new.user_id], array[]::uuid[]);
  perform private.pay_waiting_member_referrals(new.user_id);
  return null;
end
$fn$;
revoke all on function private.settle_member_referrals_on_checkin() from public, anon, authenticated, service_role;

create trigger member_event_checkins_settle_referrals
after insert on public.member_event_checkins
for each row execute function private.settle_member_referrals_on_checkin();

-- Referrals the old code consumed at the cap, judged by the rule in force when
-- each activated: activated, never paid, and the rule then paid points and had
-- a cap (the only other way the old code left an activated referral unpaid).
insert into private.member_referral_payouts_waiting (award_key, referrer_user_id, waiting_since)
select 'referral-' || r.id::pg_catalog.text, r.referrer_user_id, r.activated_at
  from private.member_referrals r
  cross join lateral (select private.member_referral_rule_at(r.activated_at) as rule) at_activation
 where r.activated_at is not null
   and not exists (
     select 1 from public.member_point_events e
      where e.user_id = r.referrer_user_id
        and e.action_key = 'referral-' || r.id::pg_catalog.text)
   and coalesce((at_activation.rule ->> 'points')::integer, 0) > 0
   and (at_activation.rule ->> 'weekly_cap') is not null
on conflict (award_key) do nothing;

do $pay_waiting_referrals$
declare
  v_referrer uuid;
begin
  for v_referrer in
    select distinct w.referrer_user_id from private.member_referral_payouts_waiting w
     order by 1
  loop
    perform private.pay_waiting_member_referrals(v_referrer);
  end loop;
end;
$pay_waiting_referrals$;

-- Account lifecycle: the waiting payout goes with the referring account only,
-- and is in that member's own export until it is paid.
create function private.account_lifecycle_export_member_referral_payouts_waiting(p_caller uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
   'award_key', w.award_key, 'referrer_user_id', w.referrer_user_id, 'waiting_since', w.waiting_since)
   order by w.waiting_since, w.award_key), '[]'::jsonb)
   from private.member_referral_payouts_waiting w where w.referrer_user_id = p_caller;
$function$;
revoke all on function private.account_lifecycle_export_member_referral_payouts_waiting(uuid) from public, anon, authenticated, service_role;

do $export_predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.account_lifecycle_export_additional_domains(uuid)'))) is distinct from '72972ff004b37d0cbd65f6066ad0356e' then
    raise exception 'unreviewed predecessor: private.account_lifecycle_export_additional_domains' using errcode = '55000';
  end if;
end;
$export_predecessor$;

-- Re-emitted from 20261113115000 with the waiting referral payouts appended.
CREATE OR REPLACE FUNCTION private.account_lifecycle_export_additional_domains(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'pulse_saved_charts', private.account_lifecycle_export_pulse_saved_charts(p_caller), 'chapter_bid_entries', private.account_lifecycle_export_chapter_bid_entries(p_caller), 'chapter_seniority_entries', private.account_lifecycle_export_chapter_seniority_entries(p_caller), 'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller), 'steward_private_reminders', private.account_lifecycle_export_steward_private_reminders(p_caller), 'compass_training_member_consents', private.account_lifecycle_export_compass_training_member_consents(p_caller), 'compass_training_samples', private.account_lifecycle_export_compass_training_samples(p_caller)
  ) || pg_catalog.jsonb_build_object(
    'chapter_unit_members',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'unit_id',m.unit_id) order by m.chapter_id,m.unit_id) from private.chapter_unit_members m where m.user_id=p_caller),'[]'::jsonb),
    'chapter_committee_members',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'committee_id',m.committee_id) order by m.chapter_id,m.committee_id) from private.chapter_committee_members m where m.user_id=p_caller),'[]'::jsonb),
    'organization_steward_unit_assignments',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id',m.organization_id,'user_id',m.user_id,'role',m.role,'chapter_id',m.chapter_id,'unit_id',m.unit_id,'legacy_chapter_coverage',m.legacy_chapter_coverage) order by m.chapter_id) from private.organization_steward_unit_assignments m where m.user_id=p_caller),'[]'::jsonb),
    'chapter_role_scopes',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id',m.user_id,'chapter_id',m.chapter_id,'role',m.role,'unit_id',m.unit_id,'committee_id',m.committee_id,'legacy_chapter_coverage',m.legacy_chapter_coverage) order by m.chapter_id,m.role) from private.chapter_role_scopes m where m.user_id=p_caller),'[]'::jsonb)
  ) || jsonb_build_object('chapter_financial_requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'organization_id',r.organization_id,'chapter_id',r.chapter_id,'subject_id',r.subject_id,'kind',r.kind,'title',r.title,'description',r.description,'amount',r.amount,'currency',r.currency,'status',r.status,'decision_note',r.decision_note,'revision',r.revision,'created_at',r.created_at,'decided_at',r.decided_at) order by r.created_at,r.id) from private.chapter_financial_requests r where r.subject_id=p_caller),'[]'::jsonb))
  || pg_catalog.jsonb_build_object('member_referral_payouts_waiting', private.account_lifecycle_export_member_referral_payouts_waiting(p_caller))
  || pg_catalog.jsonb_build_object(
    'member_capacity_commitments', private.account_lifecycle_export_member_capacity_commitments(p_caller), 'member_learning_assignments', private.account_lifecycle_export_member_learning_assignments(p_caller), 'member_membership_periods', private.account_lifecycle_export_member_membership_periods(p_caller), 'member_onboarding_steps', private.account_lifecycle_export_member_onboarding_steps(p_caller), 'member_participation_completions', private.account_lifecycle_export_member_participation_completions(p_caller), 'member_participation_events', private.account_lifecycle_export_member_participation_events(p_caller), 'member_recognition_events', private.account_lifecycle_export_member_recognition_events(p_caller)
  );
$function$;

insert into private.account_lifecycle_manifest
 (schema_name,table_name,user_column,delete_disposition,export_disposition,export_projection,export_inventory_basis,export_projection_version,export_domain,export_columns,exclusion_reason,note)
values ('private','member_referral_payouts_waiting','referrer_user_id','cascade','included','additional_domains','auth_user_fk',1,'additionalDomains.member_referral_payouts_waiting',
 array['award_key','referrer_user_id','waiting_since']::text[],null,
 'A points payout the referring member is owed and not yet paid, keyed by a random award key; it names no other member. Deleted by the payer when paid (it is then the member''s referral point event), and removed with the referring account.');
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.schema_name = 'private' and s.table_name in ('member_referrals', 'member_referral_payouts_waiting'))
   or (s.schema_name = 'public' and s.table_name in ('member_point_events', 'member_event_checkins'))
   or (s.kind = 'function' and s.schema_name = 'private' and s.object_name in (
     'activate_member_referral()', 'award_member_referral(p_referred uuid)',
     'member_referral_code(p_user_id uuid)', 'pay_waiting_member_referrals(p_referrer uuid)',
     'account_lifecycle_export_additional_domains(p_caller uuid)',
     'account_lifecycle_export_member_referral_payouts_waiting(p_caller uuid)',
     'settle_member_referrals_on_checkin()'))
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;
do $assert_member_referral_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the referral payout wait';
  end if;
end;
$assert_member_referral_trigger_review$;

notify pgrst, 'reload schema';

commit;
