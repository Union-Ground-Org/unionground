-- REQ-UG-MEMBER-REFERRAL-ATTRIBUTION-20261110 (#8152, narrowed by a
-- project decision).
--
-- A member who brings someone in gets credit for it:
-- * Each member has a referral code derived by HMAC from one database-held key
--   and the member's id. Nothing per member is stored, and the code cannot be
--   produced without the key.
-- * When an administrator-issued invitation is accepted with a member's code,
--   private.member_referrals records the referring member, the code, the new
--   member and the time. One referral per person, ever; never oneself; both in
--   the same organization; no invitee email is kept.
-- * The new member's first event check-in point event activates the referral.
--   Union Ground retired the points economy, so the 'referral' rule is held at
--   0 points and activation mints nothing; the count still shows on Home.
-- Who can create an account does not change: member-sent invitations are #8171.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

-- One key for every code. No client role can read it.
create table private.member_referral_code_key (
  singleton boolean primary key default true check (singleton),
  key bytea not null check (pg_catalog.octet_length(key) = 32),
  created_at timestamptz not null default pg_catalog.now()
);
revoke all on private.member_referral_code_key from public, anon, authenticated, service_role;
insert into private.member_referral_code_key (singleton, key)
values (true, extensions.gen_random_bytes(32));

-- The member's code: twelve upper-case hex digits of HMAC-SHA256(key, user id).
create function private.member_referral_code(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.hmac(
    pg_catalog.convert_to(p_user_id::pg_catalog.text, 'UTF8'), k.key, 'sha256'), 'hex'), 1, 12))
    from private.member_referral_code_key k
   where k.singleton
$fn$;
revoke all on function private.member_referral_code(uuid) from public, anon, authenticated, service_role;

create table private.member_referrals (
  id uuid primary key default extensions.gen_random_uuid(),
  referrer_user_id uuid not null references auth.users(id) on delete cascade,
  referred_user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  code text not null check (code ~ '^[0-9A-F]{12}$'),
  created_at timestamptz not null default pg_catalog.now(),
  activated_at timestamptz,
  constraint member_referrals_referred_once unique (referred_user_id),
  constraint member_referrals_not_self check (referrer_user_id <> referred_user_id)
);
create index member_referrals_referrer_idx on private.member_referrals (referrer_user_id, created_at);
alter table private.member_referrals enable row level security;
alter table private.member_referrals force row level security;
revoke all on table private.member_referrals from public, anon, authenticated, service_role;
create trigger a00_case_graph_lock before insert or update or delete on private.member_referrals
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_referrals
for each row execute function private.lock_case_graph_row_keys('{referred_user_id},{referrer_user_id}', '');

-- The rule for the activation event. Union Ground retired the points economy
-- (20261014003000 pins every rule to 0 points), so the rule exists at 0 and
-- private.award_member_referral below, which reads only rules with points > 0,
-- mints nothing. The referral itself is still recorded and counted.
insert into public.member_point_rules (action_kind, label, points, weekly_cap)
values ('referral', 'Recruit a member', 0, 2)
on conflict (action_kind) do update set label = excluded.label, points = excluded.points, weekly_cap = excluded.weekly_cap;

-- Activation, shared by the check-in trigger and the recorder: the first time
-- the referred member has a check-in point event, the referral is activated and
-- the referring member gets one referral point event, within the rule's live
-- points and weekly cap. The key is the referral row's own random id, so the
-- referring member's readable ledger never names the other account.
create function private.award_member_referral(p_referred uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_referral uuid;
  v_referrer uuid;
  v_rule record;
  v_this_week integer;
begin
  perform private.lock_case_graph(array[p_referred], array[]::uuid[]);
  update private.member_referrals r
     set activated_at = pg_catalog.now()
   where r.referred_user_id = p_referred and r.activated_at is null
  returning r.id, r.referrer_user_id into v_referral, v_referrer;
  if v_referral is null then
    return;
  end if;
  select points, weekly_cap into v_rule
    from public.member_point_rules
   where action_kind = 'referral' and points > 0;
  if not found then
    return;
  end if;
  if v_rule.weekly_cap is not null then
    select pg_catalog.count(*) into v_this_week
      from public.member_point_events e
     where e.user_id = v_referrer and e.action_kind = 'referral'
       and e.occurred_at >= pg_catalog.date_trunc('week', pg_catalog.now());
    if v_this_week >= v_rule.weekly_cap then
      return;
    end if;
  end if;
  insert into public.member_point_events (user_id, action_key, action_kind, points)
  values (v_referrer, 'referral-' || v_referral::pg_catalog.text, 'referral', v_rule.points)
  on conflict (user_id, action_key) do nothing;
end
$fn$;
revoke all on function private.award_member_referral(uuid) from public, anon, authenticated, service_role;

-- Called by api/accept-invitation.js after a new account's acceptance commits.
-- Returns whether a referral was recorded; an unknown, foreign or own code
-- records nothing and never fails the acceptance. A check-in the new member
-- made before this call (the acceptance and the referral are separate steps)
-- is reconciled here, under the same lock the check-in trigger takes.
create function public.record_member_referral(p_invitation_id uuid, p_code text)
returns pg_catalog.jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_referred uuid;
  v_organization uuid;
  v_code pg_catalog.text;
  v_referrer uuid;
  v_recorded boolean;
begin
  perform private.lock_case_graph(array[(select i.auth_user_id from public.member_invitations i where i.id = p_invitation_id)], array[]::uuid[]);
  v_code := pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, '')));
  if v_code !~ '^[0-9A-F]{12}$' then
    return pg_catalog.jsonb_build_object('recorded', false, 'reason', 'invalid-code');
  end if;
  select i.auth_user_id, c.organization_id into v_referred, v_organization
    from public.member_invitations i
    join public.chapters c on c.id = i.chapter_id
   where i.id = p_invitation_id and i.status = 'accepted' and i.auth_user_id is not null;
  if v_referred is null then
    return pg_catalog.jsonb_build_object('recorded', false, 'reason', 'invitation-not-accepted');
  end if;
  select m.user_id into v_referrer
    from public.organization_memberships m
   where m.organization_id = v_organization and m.status = 'active'
     and m.user_id <> v_referred
     and private.member_referral_code(m.user_id) = v_code
   limit 1;
  if v_referrer is null then
    return pg_catalog.jsonb_build_object('recorded', false, 'reason', 'no-member');
  end if;
  insert into private.member_referrals (referrer_user_id, referred_user_id, organization_id, code)
  values (v_referrer, v_referred, v_organization, v_code)
  on conflict on constraint member_referrals_referred_once do nothing;
  v_recorded := found;
  if v_recorded and exists (
    select 1 from public.member_point_events e
     where e.user_id = v_referred and e.action_kind = 'checkin') then
    perform private.award_member_referral(v_referred);
  end if;
  return pg_catalog.jsonb_build_object('recorded', v_recorded);
end
$fn$;
revoke all on function public.record_member_referral(uuid, pg_catalog.text) from public, anon, authenticated;
grant all on function public.record_member_referral(uuid, pg_catalog.text) to service_role;

-- The referred member's first check-in point event activates the referral.
create function private.activate_member_referral()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform private.lock_case_graph(array[new.user_id], array[]::uuid[]);
  perform private.award_member_referral(new.user_id);
  return new;
end
$fn$;
revoke all on function private.activate_member_referral() from public, anon, authenticated, service_role;

create trigger member_point_events_activate_referral
after insert on public.member_point_events
for each row when (new.action_kind = 'checkin')
execute function private.activate_member_referral();

-- The Home tile reads its count from the rewards summary it already loads, so
-- the cold Home request budget does not grow. Union Ground keeps the retired,
-- neutral summary of 20261014003000 and adds only the caller's own count of
-- referrals this calendar year (Eastern); grants are unchanged by CREATE OR
-- REPLACE.
create or replace function public.get_member_rewards_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'totalPoints', 0,
    'tierNumber', 1,
    'tierName', 'Contributions',
    'nextTierName', null,
    'pointsToGo', null,
    'weekStreak', 0,
    'actionsYtd', 0,
    'retired', true,
    'recruitedYtd', (
      select pg_catalog.count(*)
        from private.member_referrals r
       where r.referrer_user_id = (select auth.uid())
         and r.created_at >= (pg_catalog.date_trunc('year', pg_catalog.now() at time zone 'America/New_York') at time zone 'America/New_York'))
  )
  where (select auth.uid()) is not null;
$$;

-- The signed-in member's own code and own count of referrals recorded this
-- calendar year (Eastern). Never a recruiter-recruit pair.
create function public.get_member_referral_summary()
returns pg_catalog.jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select case when exists (
      select 1 from public.organization_memberships m
       where m.user_id = auth.uid() and m.status = 'active')
    then pg_catalog.jsonb_build_object(
      'code', private.member_referral_code(auth.uid()),
      'recruitedYtd', (
        select pg_catalog.count(*)
          from private.member_referrals r
         where r.referrer_user_id = auth.uid()
           and r.created_at >= (pg_catalog.date_trunc('year', pg_catalog.now() at time zone 'America/New_York') at time zone 'America/New_York')))
    else null end
$fn$;
revoke all on function public.get_member_referral_summary() from public, anon, service_role;
grant all on function public.get_member_referral_summary() to authenticated;

-- Account lifecycle: both people's rows go with either account.
insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','member_referrals','referrer_user_id','cascade','excluded_with_reason','auth_user_fk','A referral link between two members; the referring member sees only their own count, never the other person.','Removed with the referring account.'),
 ('private','member_referrals','referred_user_id','cascade','excluded_with_reason','auth_user_fk','A referral link between two members; the referred member is never shown who referred them.','Removed with the referred account.');
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.schema_name = 'private' and s.table_name = 'member_referrals')
   or (s.schema_name = 'public' and s.table_name = 'member_point_events')
   or (s.kind = 'function' and s.schema_name = 'private' and s.object_name in ('activate_member_referral()', 'award_member_referral(p_referred uuid)', 'member_referral_code(p_user_id uuid)'))
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;
do $assert_member_referral_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after member referrals';
  end if;
end;
$assert_member_referral_trigger_review$;

notify pgrst, 'reload schema';

commit;
