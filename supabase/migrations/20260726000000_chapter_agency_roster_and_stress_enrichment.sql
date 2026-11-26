-- Multi-agency chapter roster + a guarded enrichment lane for the synthetic
-- member dataset (REQ-UG-STRESS-RESEED-ORGS-20260726).
--
-- WHY
-- The 100k stress dataset removed on 2026-07-25 was a clone farm: every
-- synthetic member carried the SAME four case references, the same two
-- conversations, the same three notifications, and every one of them landed on
-- the single default chapter. The cause is structural, not incidental —
-- member_stress_apply_batch only inserts auth.users rows, and ALL per-member
-- data is fanned out by private.handle_new_member, which produces one fixed
-- shape. The seeder never sent a chapter_id, so the trigger's "unknown or
-- absent slug -> default chapter" branch put all 100,000 members in the
-- default chapter.
--
-- WHAT THIS ADDS
-- 1. 24 new chapters across SEVEN fictional public-service departments (Care,
--    Family, Benefits, Health, Rehab, Public Health, Youth), with the previously-unused chapters.region
--    column backfilled as the AGENCY key on all 29 rows. Pure reference data:
--    no schema change, no RLS change. Every chapter consumer is caller-scoped
--    and row-count agnostic (staff_can_see_user, the steward SELECT policies,
--    get_steward_chapter_member_count, the coordinator/advisor/president
--    dashboards), and the only member-facing surface is a read-only label.
-- 2. Org-level prelude so participation data has something believable to point
--    at: four PAST events (check-ins are only legitimate against past events),
--    two closed ballots and two closed surveys with options, and a quorum
--    target on the live ballot that is proportionate to a 100k membership.
-- 3. public.member_stress_enrich_batch — a service_role-only definer RPC that
--    reshapes a ledgered run's rows into a realistic distribution, and
--    public.member_stress_enrich_verify, which replaces the stock verifier's
--    exact-multiple equalities with DISTRIBUTION BANDS.
--
-- WHY A SEPARATE ENRICHMENT LANE (and not a change to the seed RPCs)
-- member_stress_verify's pass condition hard-codes notifications = n*3,
-- conversations = n*2, messages = n*2, cases = n*4, rights = n*1,
-- action_log = n*3. Enrichment deliberately breaks those equalities, so it
-- runs AFTER `stress:verify` has passed and stamped the run 'verified'.
-- member_stress_verify never DOWNGRADES state (20260721210635:372 is
-- `if passed then update ... end if`), and member_stress_begin_remove accepts
-- 'verified', so teardown is unaffected by a later failing re-verify.
-- The stock seed functions are NOT touched: a CREATE OR REPLACE on any of them
-- would silently drop the statement_timeout that 20260721211321 applied
-- out-of-band via ALTER FUNCTION, reddening `npm run verify:db`.
--
-- SAFETY RULES ENCODED HERE (each one is a live production hazard)
-- * NOTIFICATION KIND IS FROZEN AT 'general'. private.enqueue_notification_
--   deliveries returns early only for kinds outside
--   ('deadlines','cases','forms','votes','events'); outbound_enabled is TRUE
--   and the dispatch cron runs every 5 minutes, so a typed kind on 240k
--   synthetic rows would attempt real provider sends to @loadtest.example.com.
--   This lane never inserts a notification and never updates `kind`.
-- * POINTS ARE MINTED BY DIRECT BACKDATED INSERT, NEVER BY THE TRIGGER.
--   member_action_log.action_kind stays 'seed' (award_member_points' first
--   statement returns on it), and member_steward_requests rows are INSERTED in
--   their final status — never UPDATEd — so the 20260725230000
--   award-on-acknowledgment trigger (AFTER UPDATE) cannot fire 11k times at
--   now() and collapse every history into the current cap window.
-- * TEARDOWN IS PRESERVED. Every row this lane writes hangs off a user_id with
--   ON DELETE CASCADE from auth.users; the actor columns it touches
--   (member_event_checkins.scanned_by, member_steward_requests.handled_by,
--   member_roles.granted_by) are ON DELETE SET NULL, so a cross-batch delete
--   order cannot block removal. Nothing is written to member_broadcasts.
--   created_by or form_templates.updated_by, whose SET NULL would leave
--   authorless org rows behind after teardown.
--
-- ROLLBACK (copy-paste)
--   drop function if exists public.member_stress_enrich_verify(uuid);
--   drop function if exists public.member_stress_enrich_batch(uuid, text, integer, integer, text, text);
--   drop table if exists private.member_stress_chapter_plan;
--   drop table if exists private.member_stress_name_pool;
--   drop table if exists private.member_stress_role_pool;
--   drop function if exists private.member_stress_pick(text, integer);
--   drop function if exists private.member_stress_rand(text);
--   update public.member_ballots set quorum_target = 200 where id = 'ballot-2026';
--   delete from public.member_ballot_options where ballot_id in ('ballot-2025-contract','ballot-2025-bylaws');
--   delete from public.member_ballots where id in ('ballot-2025-contract','ballot-2025-bylaws');
--   delete from public.member_survey_options where survey_id in ('pulse-2025-caseload','pulse-2025-safety');
--   delete from public.member_surveys where id in ('pulse-2025-caseload','pulse-2025-safety');
--   delete from public.member_events where id like 'evt-2025-%';
--   update public.chapters set region = null;
--   delete from public.chapters where id not in ('wor','bos','spr','law','nbd');
--   -- (chapter deletes require the synthetic members to be gone first; the
--   --  member_profiles.chapter_id FK is NOT cascading, which is the point.)

set local lock_timeout = '5s';

-- ---------------------------------------------------------------- 1. roster --
-- region carries the AGENCY key; name carries "City Agency" the way the five
-- pre-existing rows already read. wor stays is_default so real signups (which
-- send no chapter_id) keep landing in a normal, proportionally-sized chapter.

insert into public.chapters (id, name, region, is_default, order_index) values
  ('dds-hyn', 'Spruce Point Care Services',    'Care',         false,  6),
  ('dds-pit', 'Birch Hollow Care Services',    'Care',         false,  7),
  ('dcf-bos', 'Pine Harbor Family Services',   'Family',       false,  8),
  ('dcf-wor', 'Cedar Ridge Family Services',   'Family',       false,  9),
  ('dcf-spr', 'Maple Crossing Family Services','Family',       false, 10),
  ('dcf-law', 'Willow Bend Family Services',   'Family',       false, 11),
  ('dcf-brk', 'Alder Springs Family Services', 'Family',       false, 12),
  ('dcf-hol', 'Juniper Hill Family Services',  'Family',       false, 13),
  ('dta-bos', 'Pine Harbor Benefits Office',   'Benefits',     false, 14),
  ('dta-spr', 'Maple Crossing Benefits Office','Benefits',     false, 15),
  ('dta-wor', 'Cedar Ridge Benefits Office',   'Benefits',     false, 16),
  ('dta-fal', 'Aspen Flats Benefits Office',   'Benefits',     false, 17),
  ('dta-lyn', 'Larch Valley Benefits Office',  'Benefits',     false, 18),
  ('dmh-bos', 'Pine Harbor Health Services',   'Health',       false, 19),
  ('dmh-wor', 'Cedar Ridge Health Services',   'Health',       false, 20),
  ('dmh-tau', 'Elm Grove Health Services',     'Health',       false, 21),
  ('dmh-nth', 'Oak Meadow Health Services',    'Health',       false, 22),
  ('mrc-bos', 'Pine Harbor Rehab Services',    'Rehab',        false, 23),
  ('mrc-wor', 'Cedar Ridge Rehab Services',    'Rehab',        false, 24),
  ('mrc-spr', 'Maple Crossing Rehab Services', 'Rehab',        false, 25),
  ('dph-bos', 'Pine Harbor Public Health',     'Public Health',false, 26),
  ('dph-tew', 'Fir Lake Public Health',        'Public Health',false, 27),
  ('dys-bos', 'Pine Harbor Youth Services',    'Youth',        false, 28),
  ('dys-wor', 'Cedar Ridge Youth Services',    'Youth',        false, 29)
on conflict (id) do nothing;

update public.chapters set region = 'Care'
where id in ('wor', 'bos', 'spr', 'law', 'nbd') and region is distinct from 'Care';

-- --------------------------------------------------------- 2. org prelude ----
-- Past events: member_event_checkins against a future event is nonsense, and
-- only one of the five live events has already happened.

-- check_in_code is constrained to '^SG-[0-9A-Z]{3,12}$' (the Union Ground
-- scanner format); a bare 'FALL25' is rejected by member_events_check_in_code_check.
insert into public.member_events (id, title, starts_at, location, summary, check_in_code, order_index) values
  ('evt-2025-fall-assembly', 'Fall chapter assembly', now() - interval '244 days', 'Cedar Ridge Union Hall',
   'Chapter reports, contract-action planning and the fall steward slate.', 'SG-FALL25', 11),
  ('evt-2025-caseload-forum', 'Caseload standards forum', now() - interval '166 days', 'Maple Crossing Regional Office',
   'Members compared caseload counts ahead of the workload-standards push.', 'SG-LOAD25', 12),
  ('evt-2026-winter-training', 'Winter steward training', now() - interval '96 days', 'Pine Harbor Tamarack Office',
   'Weingarten, Loudermill and Step 1 practice for newly elected stewards.', 'SG-WNTR26', 13),
  ('evt-2026-lobby-day', 'State House lobby day', now() - interval '38 days', 'State Capitol',
   'Human-services line-item testimony and legislator visits.', 'SG-LOBBY6', 14)
on conflict (id) do nothing;

-- Closed ballots and surveys so voting history is not concentrated on the one
-- live ballot. Both are inactive: they render as history, never as an ask.
insert into public.member_ballots (id, title, closes_at, active, order_index, quorum_target) values
  ('ballot-2025-contract', 'Ratify the 2025-2028 successor agreement', now() - interval '201 days', false, 2, 20000),
  ('ballot-2025-bylaws',   'Adopt the revised chapter bylaws',          now() - interval '96 days',  false, 3, 12000)
on conflict (id) do nothing;

insert into public.member_ballot_options (id, ballot_id, label, order_index) values
  ('ballot-2025-contract-yes',     'ballot-2025-contract', 'Ratify the agreement',        1),
  ('ballot-2025-contract-no',      'ballot-2025-contract', 'Reject and return to talks',  2),
  ('ballot-2025-contract-abstain', 'ballot-2025-contract', 'Abstain',                     3),
  ('ballot-2025-bylaws-yes',       'ballot-2025-bylaws',   'Adopt the revised bylaws',    1),
  ('ballot-2025-bylaws-no',        'ballot-2025-bylaws',   'Keep the current bylaws',     2),
  ('ballot-2025-bylaws-abstain',   'ballot-2025-bylaws',   'Abstain',                     3)
on conflict (id) do nothing;

insert into public.member_surveys (id, title, closes_at, active, order_index) values
  ('pulse-2025-caseload', 'How manageable is your current caseload?', now() - interval '150 days', false, 2),
  ('pulse-2025-safety',   'Do you have what you need to work safely?', now() - interval '75 days', false, 3)
on conflict (id) do nothing;

insert into public.member_survey_options (id, survey_id, label, order_index) values
  ('pulse-2025-caseload-manageable', 'pulse-2025-caseload', 'Manageable most weeks',        1),
  ('pulse-2025-caseload-stretched',  'pulse-2025-caseload', 'Stretched but coping',         2),
  ('pulse-2025-caseload-unsafe',     'pulse-2025-caseload', 'Unsafe for clients and staff', 3),
  ('pulse-2025-safety-yes',          'pulse-2025-safety',   'Yes, consistently',            1),
  ('pulse-2025-safety-sometimes',    'pulse-2025-safety',   'Sometimes',                    2),
  ('pulse-2025-safety-no',           'pulse-2025-safety',   'No',                           3)
on conflict (id) do nothing;

-- The live ballot's quorum was 200 — a threshold set when the org had a
-- handful of members. Against a 100k roster it would be met by rounding error,
-- and quorum is described elsewhere in this repo as legally meaningful. The two
-- real votes cast against it and their receipts are untouched.
update public.member_ballots set quorum_target = 25000 where id = 'ballot-2026';

-- ------------------------------------------------- 3. deterministic helpers --
-- Seven hex digits -> bit(28) -> a NON-NEGATIVE integer. Using eight digits and
-- abs() would be wrong: abs(-2147483648) overflows.

create or replace function private.member_stress_rand(p_seed text)
returns double precision
language sql
immutable
strict
set search_path = ''
as $$
  select (('x' || pg_catalog.substr(pg_catalog.md5(p_seed), 1, 7))::bit(28)::integer)::double precision
    / 268435456.0;
$$;

create or replace function private.member_stress_pick(p_seed text, p_n integer)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.floor(private.member_stress_rand(p_seed) * p_n)::integer;
$$;

-- The chapter distribution, as data rather than as a CASE ladder: deliberately
-- uneven (9,600 largest, 700 smallest) because a uniform split across 29
-- chapters is its own clone tell. lo/hi are cumulative 0-based ranges over
-- 100,000 so a member's chapter is a range lookup on one hashed draw.
create table if not exists private.member_stress_chapter_plan (
  chapter_id text primary key references public.chapters(id) on delete cascade,
  members integer not null check (members > 0),
  lo integer not null,
  hi integer not null check (hi >= lo)
);

insert into private.member_stress_chapter_plan (chapter_id, members, lo, hi) values
  ('wor',     6300,     0,  6299),
  ('bos',     7200,  6300, 13499),
  ('spr',     4600, 13500, 18099),
  ('law',     3100, 18100, 21199),
  ('nbd',     2400, 21200, 23599),
  ('dds-hyn', 1500, 23600, 25099),
  ('dds-pit',  900, 25100, 25999),
  ('dcf-bos', 9600, 26000, 35599),
  ('dcf-wor', 6400, 35600, 41999),
  ('dcf-spr', 5700, 42000, 47699),
  ('dcf-law', 4300, 47700, 51999),
  ('dcf-brk', 3400, 52000, 55399),
  ('dcf-hol', 2600, 55400, 57999),
  ('dta-bos', 5600, 58000, 63599),
  ('dta-spr', 4200, 63600, 67799),
  ('dta-wor', 3500, 67800, 71299),
  ('dta-fal', 2600, 71300, 73899),
  ('dta-lyn', 2100, 73900, 75999),
  ('dmh-bos', 4400, 76000, 80399),
  ('dmh-wor', 3100, 80400, 83499),
  ('dmh-tau', 2600, 83500, 86099),
  ('dmh-nth', 1900, 86100, 87999),
  ('mrc-bos', 3000, 88000, 90999),
  ('mrc-wor', 2000, 91000, 92999),
  ('mrc-spr', 1500, 93000, 94499),
  ('dph-bos', 2300, 94500, 96799),
  ('dph-tew', 1200, 96800, 97999),
  ('dys-bos', 1300, 98000, 99299),
  ('dys-wor',  700, 99300, 99999)
on conflict (chapter_id) do nothing;

do $$
declare
  total integer;
  gaps integer;
begin
  select pg_catalog.sum(members), pg_catalog.count(*) filter (where hi - lo + 1 <> members)
    into total, gaps
  from private.member_stress_chapter_plan;
  if total <> 100000 or gaps <> 0 then
    raise exception 'chapter plan must cover exactly 100000 with consistent ranges (got % / % bad rows)', total, gaps;
  end if;
  if exists (
    select 1 from private.member_stress_chapter_plan a
    join private.member_stress_chapter_plan b
      on a.chapter_id <> b.chapter_id and a.lo <= b.hi and b.lo <= a.hi
  ) then
    raise exception 'chapter plan ranges overlap';
  end if;
end
$$;

-- Column is `part`, not `kind`: `kind` is the notification column whose value
-- decides whether the outbound delivery trigger engages, and every pin in this
-- repo that asserts "this code never writes a notification kind" would be
-- satisfied-by-accident by an unrelated column of the same name.
create table if not exists private.member_stress_name_pool (
  part text not null check (part in ('first', 'last')),
  idx integer not null,
  value text not null,
  primary key (part, idx)
);

insert into private.member_stress_name_pool (part, idx, value)
select 'first', (ord - 1)::integer, name
from unnest(array[
  'Maria','James','Aisha','Robert','Linda','Carlos','Danielle','Michael','Fatima','Kevin',
  'Rosa','Thomas','Nia','Steven','Yolanda','Patrick','Mei','Andre','Kathleen','Luis',
  'Deborah','Samuel','Priya','Brian','Tanya','Joseph','Amara','Daniel','Sofia','Gregory',
  'Janelle','Anthony','Hana','Marcus','Colleen','Ricardo','Simone','Edward','Grace','Omar',
  'Bridget','Terrence','Lucia','Sean','Adanna','Victor','Erin','Malik','Camila','Douglas',
  'Nadia','Francis','Imani','Peter','Rosario','Jerome','Elena','Curtis','Isabel','Raymond',
  'Latoya','Vincent','Farida','Nathan'
]) with ordinality as t(name, ord)
on conflict (part, idx) do nothing;

insert into private.member_stress_name_pool (part, idx, value)
select 'last', (ord - 1)::integer, name
from unnest(array[
  'Alvarez','Brennan','Carvalho','Desrosiers','Egan','Fitzgerald','Goncalves','Hernandez','Iyer','Jackson',
  'Kowalski','Lemieux','Mendes','Nguyen','Okafor','Perreault','Quinones','Ramirez','Sullivan','Tavares',
  'Ubaldo','Vasquez','Whelan','Xiong','Yeboah','Zaman','Almeida','Boucher','Correia','Dubois',
  'Estrada','Ferreira','Gagnon','Haddad','Ivanov','Joseph','Kelly','Laurent','Monteiro','Novak',
  'OConnell','Pires','Quintana','Rosario','Santiago','Thibodeau','Ukwu','Villanueva','Walsh','Yusuf',
  'Adeyemi','Barros','Chen','Doucette','Eldridge','Fontaine','Guerrero','Hurley','Ishmael','Jalloh',
  'Keane','Lopes','Mercado','Nolan'
]) with ordinality as t(name, ord)
on conflict (part, idx) do nothing;

create table if not exists private.member_stress_role_pool (
  agency text not null,
  idx integer not null,
  title text not null,
  primary key (agency, idx)
);

insert into private.member_stress_role_pool (agency, idx, title) values
  ('Care', 0, 'Service Coordinator · Care'),
  ('Care', 1, 'Case Manager · Care'),
  ('Care', 2, 'Area Office Support · Care'),
  ('Care', 3, 'Quality Enhancement Specialist · Care'),
  ('Care', 4, 'Residential Program Liaison · Care'),
  ('Family', 0, 'Social Worker · Family'),
  ('Family', 1, 'Family Resource Worker · Family'),
  ('Family', 2, 'Area Program Manager · Family'),
  ('Family', 3, 'Adoption Social Worker · Family'),
  ('Family', 4, 'Response Social Worker · Family'),
  ('Benefits', 0, 'Benefits Eligibility Specialist · Benefits'),
  ('Benefits', 1, 'Case Manager · Benefits'),
  ('Benefits', 2, 'Cash Assistance Program Worker · Benefits'),
  ('Benefits', 3, 'SNAP Outreach Specialist · Benefits'),
  ('Health', 0, 'Case Manager · Health'),
  ('Health', 1, 'Community Support Worker · Health'),
  ('Health', 2, 'Mental Health Clinician · Health'),
  ('Health', 3, 'Continuing Care Coordinator · Health'),
  ('Rehab', 0, 'Vocational Rehabilitation Counselor · Rehab'),
  ('Rehab', 1, 'Independent Living Specialist · Rehab'),
  ('Rehab', 2, 'Community Services Coordinator · Rehab'),
  ('Public Health', 0, 'Community Health Worker · Public Health'),
  ('Public Health', 1, 'Public Health Nurse · Public Health'),
  ('Public Health', 2, 'Hospital Support Staff · Public Health'),
  ('Youth', 0, 'Caseworker · Youth'),
  ('Youth', 1, 'Group Worker · Youth'),
  ('Youth', 2, 'Education Liaison · Youth')
on conflict (agency, idx) do nothing;

do $$
begin
  if exists (
    select 1 from public.chapters c
    left join private.member_stress_role_pool r on r.agency = c.region
    where r.agency is null
  ) then
    raise exception 'every chapter region must have at least one role title';
  end if;
end
$$;

revoke all on table private.member_stress_chapter_plan, private.member_stress_name_pool,
  private.member_stress_role_pool from public, anon, authenticated, service_role;
revoke all on function private.member_stress_rand(text) from public, anon, authenticated, service_role;
revoke all on function private.member_stress_pick(text, integer) from public, anon, authenticated, service_role;

-- --------------------------------------------------- 4. enrichment batches ---
-- One phase per call, one ordinal window per call, driven by
-- scripts/member-stress-enrich.mjs. Every derivation is a pure function of
-- (run_id, phase, ordinal), so a re-run of any window is idempotent: UPDATEs
-- land the same values and INSERTs collide on their natural keys.

create function public.member_stress_enrich_batch(
  p_run_id uuid,
  p_phase text,
  p_start_ordinal integer,
  p_batch_count integer,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.member_stress_runs%rowtype;
  lo integer := p_start_ordinal;
  hi integer := p_start_ordinal + p_batch_count - 1;
  touched bigint := 0;
  seed text := p_run_id::text;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 5000 or p_start_ordinal < 1 then
    raise exception 'invalid enrichment batch range';
  end if;
  select * into run from private.member_stress_runs where id = p_run_id;
  if not found then raise exception 'unknown member stress run'; end if;
  -- 'applied' or 'verified' only: enrichment must never race the seeder, and a
  -- removed/removing run has nothing to enrich.
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied or verified to enrich (state %)', run.state;
  end if;

  if p_phase = 'profile' then
    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    assigned as (
      select t.*,
        (select cp.chapter_id from private.member_stress_chapter_plan cp
          where private.member_stress_pick(t.s || ':chapter', 100000) between cp.lo and cp.hi
          limit 1) as chapter_id
      from tgt t
    ),
    named as (
      select a.*,
        (select v.value from private.member_stress_name_pool v
          where v.part = 'first'
            and v.idx = private.member_stress_pick(a.s || ':first',
              (select pg_catalog.count(*)::integer from private.member_stress_name_pool where part = 'first'))) as fn,
        (select v.value from private.member_stress_name_pool v
          where v.part = 'last'
            and v.idx = private.member_stress_pick(a.s || ':last',
              (select pg_catalog.count(*)::integer from private.member_stress_name_pool where part = 'last'))) as ln
      from assigned a
    ),
    resolved as (
      select n.*, c.region as agency,
        (select r.title from private.member_stress_role_pool r
          where r.agency = c.region
            and r.idx = private.member_stress_pick(n.s || ':role',
              (select pg_catalog.count(*)::integer from private.member_stress_role_pool r2 where r2.agency = c.region))) as role_title
      from named n join public.chapters c on c.id = n.chapter_id
    ),
    upd as (
      update public.member_profiles mp
      set chapter_id = r.chapter_id,
          first_name = r.fn,
          full_name = r.fn || ' ' || r.ln,
          initials = pg_catalog.upper(pg_catalog.left(r.fn, 1) || pg_catalog.left(r.ln, 1)),
          role_line = r.role_title,
          member_since = 1998 + private.member_stress_pick(r.s || ':since', 28),
          language = case when private.member_stress_rand(r.s || ':lang') < 0.15 then 'es' else 'en' end
      from resolved r
      where mp.id = r.user_id
      returning 1
    )
    select pg_catalog.count(*) into touched from upd;

  elsif p_phase = 'texture' then
    -- Notification/conversation/message variety. `kind` is NEVER touched: see
    -- the outbound-delivery rule in this file's header.
    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select n.id, t.s,
        pg_catalog.row_number() over (partition by n.user_id order by n.created_at) as rn
      from public.member_notifications n join tgt t on t.user_id = n.user_id
    ),
    upd as (
      update public.member_notifications n
      set title = (array[
            'Step 2 hearing scheduled','Contract action update','Chapter meeting reminder',
            'Your grievance moved forward','New rights lesson available','Steward office hours',
            'Membership drive this week','Workload survey closing'
          ])[1 + private.member_stress_pick(k.s || ':ntitle' || k.rn, 8)],
          body = (array[
            'Your steward will meet you 30 minutes before the hearing.',
            'The bargaining team posted a summary of this week''s session.',
            'Agenda and the call-in link are posted on the chapter board.',
            'The employer''s written answer is due at the end of next week.',
            'A three-minute refresher on your representation rights.',
            'Drop-in hours run Thursday afternoon at the area office.',
            'Two co-workers signed up this week — say hello.',
            'Last call to log your caseload for the quarter.'
          ])[1 + private.member_stress_pick(k.s || ':nbody' || k.rn, 8)],
          created_at = pg_catalog.now()
            - (private.member_stress_pick(k.s || ':nage' || k.rn, 120) || ' days')::interval
            - (private.member_stress_pick(k.s || ':nhr' || k.rn, 24) || ' hours')::interval,
          read_at = case when private.member_stress_rand(k.s || ':nread' || k.rn) < 0.62
            then pg_catalog.now() - (private.member_stress_pick(k.s || ':nrd' || k.rn, 96) || ' hours')::interval
            else null end
      from ranked k
      where n.id = k.id
      returning 1
    )
    select pg_catalog.count(*) into touched from upd;

    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select c.id, t.s,
        pg_catalog.row_number() over (partition by c.user_id order by c.created_at) as rn
      from public.member_conversations c join tgt t on t.user_id = c.user_id
    )
    update public.member_conversations c
    set title = (array[
          'Chapter steward','Area steward','Grievance chair','Field representative','Chapter president'
        ])[1 + private.member_stress_pick(k.s || ':ctitle' || k.rn, 5)],
        initials = (array['CS','AS','GC','FR','CP'])[1 + private.member_stress_pick(k.s || ':ctitle' || k.rn, 5)],
        created_at = pg_catalog.now() - (30 + private.member_stress_pick(k.s || ':cage' || k.rn, 300) || ' days')::interval,
        updated_at = pg_catalog.now() - (private.member_stress_pick(k.s || ':cupd' || k.rn, 30) || ' days')::interval
    from ranked k
    where c.id = k.id;

    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select m.id, t.s,
        pg_catalog.row_number() over (partition by m.user_id order by m.created_at) as rn
      from public.member_messages m join tgt t on t.user_id = m.user_id
    )
    update public.member_messages m
    set body = (array[
          'Now the employer owes a written Step 2 answer, due at the end of next week.',
          'I filed the grievance this morning — you are copied on the paperwork.',
          'Bring your notes from the meeting and we will go through them together.',
          'They agreed to restore the schedule. I will confirm in writing.',
          'You have the right to a union rep in that meeting. Do not go alone.',
          'The caseload numbers you sent are going into the standards push.'
        ])[1 + private.member_stress_pick(k.s || ':mbody' || k.rn, 6)],
        created_at = pg_catalog.now() - (private.member_stress_pick(k.s || ':mage' || k.rn, 240) || ' days')::interval
    from ranked k
    where m.id = k.id;

  elsif p_phase = 'cases' then
    -- The clone tell this whole migration exists to kill: every member carried
    -- the same four references. Rewrite to a globally unique
    -- GR-<year>-<ordinal><slot> and vary count, type, step and status.
    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select c.id, t.s, t.ordinal,
        pg_catalog.row_number() over (partition by c.user_id order by c.created_at desc) as rn
      from public.member_cases c join tgt t on t.user_id = c.user_id
    ),
    doomed as (
      -- Keep 0-4 cases per member (mean ~2.2): a fixed four-per-member is as
      -- artificial as identical references.
      delete from public.member_cases c
      using ranked k
      where c.id = k.id
        and k.rn > private.member_stress_pick(k.s || ':ncases', 5)
      returning 1
    )
    select pg_catalog.count(*) into touched from doomed;

    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select c.id, t.s, t.ordinal,
        pg_catalog.row_number() over (partition by c.user_id order by c.created_at desc) as rn
      from public.member_cases c join tgt t on t.user_id = c.user_id
    ),
    shaped as (
      select k.*,
        private.member_stress_pick(k.s || ':ctype' || k.rn, 6) as type_idx,
        private.member_stress_pick(k.s || ':cage' || k.rn, 900) as age_days
      from ranked k
    )
    update public.member_cases c
    set reference = 'GR-' || pg_catalog.to_char(pg_catalog.now() - (s.age_days || ' days')::interval, 'YYYY')
          || '-' || pg_catalog.lpad(((s.ordinal - 1) * 4 + s.rn)::text, 7, '0'),
        case_type = (array['Discipline','Telework','Safety','Scheduling','Caseload','Contract'])[1 + s.type_idx],
        title = (array[
          'Step 2 — discipline','Telework schedule restored','Safety equipment issued',
          'Scheduling shift corrected','Caseload above the standard','Contract language dispute'
        ])[1 + s.type_idx],
        articles = (array[
          'Article 12 — Discipline · Article 3 — Union Rights and Representation',
          'Article 7 — Hours of Work',
          'Article 16 — Health and Safety',
          'Article 7 — Hours of Work',
          'Article 24 — Workload',
          'Article 5 — Management Rights'
        ])[1 + s.type_idx],
        step = case when s.age_days < 120 then (array['Step 1','Step 2','Step 3'])[1 + private.member_stress_pick(s.s || ':cstep' || s.rn, 3)] else 'Closed' end,
        status = case when s.age_days < 120 then 'active' else 'resolved' end,
        deadline = (pg_catalog.now() - (s.age_days || ' days')::interval + interval '30 days')::date,
        created_at = pg_catalog.now() - (s.age_days || ' days')::interval,
        updated_at = pg_catalog.now() - (s.age_days / 2 || ' days')::interval
    from shaped s
    where c.id = s.id;

    -- Case timelines: 0-3 updates on each surviving case.
    insert into public.member_case_updates (case_id, user_id, body, created_at)
    select c.id, c.user_id,
      (array[
        'Filed with the area office and logged by the steward.',
        'Step 1 meeting held; the employer asked for a week to respond.',
        'Written answer received — escalating to the next step.',
        'Resolved. The member confirmed the correction took effect.'
      ])[1 + private.member_stress_pick(t.s || ':cu' || c.id::text || g.i::text, 4)],
      c.created_at + (g.i * (7 + private.member_stress_pick(t.s || ':cud' || c.id::text || g.i::text, 20)) || ' days')::interval
    from private.member_stress_ledger l
    join public.member_cases c on c.user_id = l.user_id
    cross join lateral (select seed || ':' || l.ordinal::text as s) t
    cross join lateral generate_series(1, private.member_stress_pick(t.s || ':nupd' || c.id::text, 4)) g(i)
    where l.run_id = p_run_id and l.ordinal between lo and hi
    on conflict do nothing;

  elsif p_phase = 'rights' then
    -- 1-5 of the five live lessons, at varying completion depth. The
    -- completed_steps CHECK (cardinality <= 64, migration 20260725160000) is
    -- nowhere near binding at three steps.
    -- A CASE, not a subscripted nested array: `(array[array[0], array[0,1]])[n]`
    -- reads as a single-element access on a 2-D array and yields integer, not
    -- integer[], which the column rejects.
    insert into public.member_rights_progress (lesson_id, user_id, completed_steps)
    select les.id, l.user_id,
      case private.member_stress_pick(seed || ':' || l.ordinal::text || ':rp' || les.id, 3)
        when 0 then array[0]
        when 1 then array[0, 1]
        else array[0, 1, 2]
      end
    from private.member_stress_ledger l
    cross join public.member_rights_lessons les
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':rl' || les.id) < 0.42
    on conflict (lesson_id, user_id) do nothing;
    get diagnostics touched = row_count;

  elsif p_phase = 'participation' then
    -- RSVPs across all events; check-ins only against events that have already
    -- happened, and only for members who RSVP'd.
    -- status is constrained to ('going','not_going') — there is no 'maybe'.
    insert into public.member_event_rsvps (event_id, user_id, status, created_at, updated_at)
    select e.id, l.user_id,
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':rs' || e.id) < 0.82 then 'going' else 'not_going' end,
      e.starts_at - interval '14 days', e.starts_at - interval '14 days'
    from private.member_stress_ledger l
    cross join public.member_events e
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':rv' || e.id) < 0.26
    on conflict (event_id, user_id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_event_checkins (event_id, user_id, checked_in_at, scanned_by)
    select r.event_id, r.user_id, e.starts_at + interval '12 minutes', null
    from public.member_event_rsvps r
    join public.member_events e on e.id = r.event_id
    join private.member_stress_ledger l on l.user_id = r.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.starts_at < pg_catalog.now()
      and r.status = 'going'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ci' || r.event_id) < 0.61
    on conflict (event_id, user_id) do nothing;

    -- Surveys: the two closed pulses take broad participation, the live one less.
    insert into public.member_survey_responses (survey_id, option_id, user_id, submitted_at)
    select o.survey_id, o.id, l.user_id,
      coalesce(s.closes_at, pg_catalog.now()) - (1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':sd' || o.survey_id, 20) || ' days')::interval
    from private.member_stress_ledger l
    cross join public.member_surveys s
    join public.member_survey_options o on o.survey_id = s.id
      and o.order_index = 1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':so' || s.id,
        (select pg_catalog.count(*)::integer from public.member_survey_options o2 where o2.survey_id = s.id))
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':sv' || s.id) < case when s.active then 0.19 else 0.34 end
    on conflict (survey_id, user_id) do nothing;

    insert into public.member_broadcast_receipts (broadcast_id, user_id, read_at)
    select b.id, l.user_id,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':br' || b.id, 200) || ' days')::interval
    from private.member_stress_ledger l
    cross join public.member_broadcasts b
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':bc' || b.id) < 0.34
    on conflict (broadcast_id, user_id) do nothing;

    -- Steward requests are INSERTED in their FINAL status. An UPDATE here would
    -- fire member_steward_requests_award_on_ack (20260725230000) and mint the
    -- steward award at now() for every row — see this file's header.
    insert into public.member_steward_requests (user_id, lesson_id, status, created_at, acknowledged_at, closed_at, handled_by)
    select l.user_id,
      (select les.id from public.member_rights_lessons les
        order by les.id
        offset private.member_stress_pick(seed || ':' || l.ordinal::text || ':srl', 5) limit 1),
      (array['acknowledged','closed','closed','requested'])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':srs', 4)],
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':srd', 400) || ' days')::interval,
      case when private.member_stress_pick(seed || ':' || l.ordinal::text || ':srs', 4) < 3
        then pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':sra', 380) || ' days')::interval end,
      case when private.member_stress_pick(seed || ':' || l.ordinal::text || ':srs', 4) between 1 and 2
        then pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':src', 360) || ' days')::interval end,
      null
    from private.member_stress_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':sr') < 0.11
    on conflict do nothing;

    insert into public.member_forms (user_id, template_key, template_version, status, answers, step, submitted_at, created_at, updated_at)
    select l.user_id, ft.key, ft.version,
      (array['submitted','approved','approved','draft'])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':fs', 4)],
      '{}'::jsonb, 0,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':fd', 300) || ' days')::interval,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':fd', 300) || ' days')::interval,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':fu', 200) || ' days')::interval
    from private.member_stress_ledger l
    join lateral (
      select f.key, f.version from public.form_templates f where f.active
      order by f.key
      offset private.member_stress_pick(seed || ':' || l.ordinal::text || ':ft',
        (select pg_catalog.count(*)::integer from public.form_templates where active))
      limit 1
    ) ft on true
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':fm') < 0.15
    on conflict do nothing;

    -- Three constraints govern this table and all three are easy to trip:
    -- receipt_code must match '^[0-9a-f]{8}$' (lower-case, exactly 8), every
    -- count column is bounded 0..300, and pt_hours_when_part_time requires a
    -- non-null pt_hours whenever employment is 'part_time'.
    insert into public.member_workload_logs (user_id, priority, pending, unread_docs, todos, referrals,
      ce_activities, assistance_requests, aged_cases, weekly_assigned, employment, pt_hours, receipt_code,
      created_at, logged_on)
    select l.user_id,
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wp', 12),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wpe', 40),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wu', 25),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wt', 30),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wr', 15),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wc', 8),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wa', 10),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wg', 18),
      10 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ww', 25),
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':we') < 0.86 then 'full_time' else 'part_time' end,
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':we') < 0.86 then null
        else (16 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':wph', 24))::smallint end,
      pg_catalog.substr(pg_catalog.md5(seed || ':wrc:' || l.ordinal::text), 1, 8),
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':wd', 120) || ' days')::interval,
      (pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':wd', 120) || ' days')::interval)::date
    from private.member_stress_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':wl') < 0.23
    on conflict do nothing;

    with threads as (
      insert into public.member_guide_threads (user_id, title, created_at, updated_at)
      select l.user_id,
        (array[
          'What are my Weingarten rights?','How do I file a grievance?',
          'Can they change my schedule without notice?','What counts as a safety refusal?',
          'How much notice for a shift change?'
        ])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':gt', 5)],
        pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':gd', 180) || ' days')::interval,
        pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':gd', 180) || ' days')::interval
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
        and private.member_stress_rand(seed || ':' || l.ordinal::text || ':gv') < 0.09
      returning id, user_id, title, created_at
    )
    insert into public.member_guide_messages (thread_id, user_id, role, body, created_at)
    select t.id, t.user_id, m.role, m.body, t.created_at + m.offs
    from threads t
    cross join lateral (values
      ('user', t.title, interval '0 minutes'),
      ('assistant', 'Here is what your contract and the law say, with the article citations.', interval '9 seconds')
    ) as m(role, body, offs);

  elsif p_phase = 'ballots' then
    -- Turnout on each ballot, weighted lower on the still-open one. The two
    -- real votes on ballot-2026 collide on (ballot_id, user_id) only for real
    -- users, who are not in the ledger — they are untouched either way.
    -- The timestamp column is submitted_at; member_ballot_votes has no created_at.
    insert into public.member_ballot_votes (ballot_id, option_id, user_id, submitted_at)
    select b.id, o.id, l.user_id,
      coalesce(b.closes_at, pg_catalog.now()) - (1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':bd' || b.id, 40) || ' days')::interval
    from private.member_stress_ledger l
    cross join public.member_ballots b
    join public.member_ballot_options o on o.ballot_id = b.id
      and o.order_index = 1 + case
        when private.member_stress_rand(seed || ':' || l.ordinal::text || ':bo' || b.id) < 0.74 then 0
        when private.member_stress_rand(seed || ':' || l.ordinal::text || ':bo' || b.id) < 0.93 then 1
        else 2 end
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':bv' || b.id) < case when b.active then 0.31 else 0.38 end
    on conflict (ballot_id, user_id) do nothing;
    get diagnostics touched = row_count;

  elsif p_phase = 'points' then
    -- Direct, BACKDATED inserts. Routing these through member_action_log would
    -- hand them to private.award_member_points, which stamps occurred_at =
    -- now() and enforces per-kind weekly caps — collapsing 100k members'
    -- histories into the current week and paying almost none of them.
    insert into public.member_point_events (user_id, action_key, action_kind, points, occurred_at)
    select l.user_id,
      'hist-' || l.ordinal::text || '-' || g.i::text,
      (array['vote','survey','rights','case','rsvp','checkin','form','message'])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':pk' || g.i::text, 8)],
      (array[20, 10, 15, 25, 40, 50, 15, 2])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':pk' || g.i::text, 8)],
      pg_catalog.now() - (7 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':pd' || g.i::text, 540) || ' days')::interval
    from private.member_stress_ledger l
    cross join lateral generate_series(1, private.member_stress_pick(seed || ':' || l.ordinal::text || ':pn', 11)) g(i)
    where l.run_id = p_run_id and l.ordinal between lo and hi
    on conflict (user_id, action_key) do nothing;
    get diagnostics touched = row_count;

  elsif p_phase = 'roles' then
    -- Chapter-scoped stewards, roughly 1 per 90 members, so the steward desk
    -- and get_steward_chapter_member_count have realistic scoped populations.
    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, 'steward', mp.chapter_id,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':rg', 700) || ' days')::interval,
      null
    from private.member_stress_ledger l
    join public.member_profiles mp on mp.id = l.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':stw') < 0.011
    on conflict (user_id, role) do nothing;
    get diagnostics touched = row_count;

  else
    raise exception 'unknown enrichment phase %', p_phase;
  end if;

  return jsonb_build_object('phase', p_phase, 'from', lo, 'to', hi, 'touched', touched);
end;
$$;

-- ------------------------------------------------- 5. distribution verifier --
-- The stock member_stress_verify asserts EQUALITIES (n*3 notifications, n*4
-- cases...). Enrichment exists precisely to break those, so this verifier
-- asserts BANDS plus the invariants that must hold absolutely: no typed
-- notification kinds, no outbound deliveries, no point event inside the
-- current cap window, and globally unique case references.

create function public.member_stress_enrich_verify(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.member_stress_runs%rowtype;
  result jsonb;
  chapters_used integer;
  max_share double precision;
  cases_total bigint;
  cases_distinct bigint;
  typed_kinds bigint;
  deliveries bigint;
  fresh_points bigint;
  passed boolean;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'member stress RPC requires service_role'; end if;
  select * into run from private.member_stress_runs where id = p_run_id;
  if not found then raise exception 'unknown member stress run'; end if;

  select pg_catalog.count(distinct mp.chapter_id),
         -- GREATEST is a grammar construct, not a function: it cannot be
         -- schema-qualified (tests/admin-plane.test.js pins this repo-wide).
         pg_catalog.max(share.n)::double precision / greatest(run.member_count, 1)
    into chapters_used, max_share
  from public.member_profiles mp
  join private.member_stress_ledger l on l.user_id = mp.id and l.run_id = p_run_id
  cross join lateral (
    select pg_catalog.count(*) as n from public.member_profiles p2
    join private.member_stress_ledger l2 on l2.user_id = p2.id and l2.run_id = p_run_id
    where p2.chapter_id = mp.chapter_id
  ) share;

  select pg_catalog.count(*), pg_catalog.count(distinct c.reference)
    into cases_total, cases_distinct
  from public.member_cases c
  join private.member_stress_ledger l on l.user_id = c.user_id and l.run_id = p_run_id;

  select pg_catalog.count(*) into typed_kinds
  from public.member_notifications n
  join private.member_stress_ledger l on l.user_id = n.user_id and l.run_id = p_run_id
  where n.kind <> 'general';

  select pg_catalog.count(*) into deliveries
  from public.member_notification_deliveries d
  join private.member_stress_ledger l on l.user_id = d.user_id and l.run_id = p_run_id;

  select pg_catalog.count(*) into fresh_points
  from public.member_point_events e
  join private.member_stress_ledger l on l.user_id = e.user_id and l.run_id = p_run_id
  where e.occurred_at >= pg_catalog.date_trunc('week', pg_catalog.now());

  result := jsonb_build_object(
    'run_id', p_run_id,
    'members', run.member_count,
    'chapters_used', chapters_used,
    'largest_chapter_share', pg_catalog.round(max_share::numeric, 4),
    'cases', cases_total,
    'cases_distinct_refs', cases_distinct,
    'typed_notification_kinds', typed_kinds,
    'outbound_deliveries', deliveries,
    'points_in_current_week', fresh_points,
    'rights_progress', (select pg_catalog.count(*) from public.member_rights_progress r join private.member_stress_ledger l on l.user_id = r.user_id and l.run_id = p_run_id),
    'ballot_votes', (select pg_catalog.count(*) from public.member_ballot_votes v join private.member_stress_ledger l on l.user_id = v.user_id and l.run_id = p_run_id),
    'ballot_receipts', (select pg_catalog.count(*) from public.member_ballot_receipts b join private.member_stress_ledger l on l.user_id = b.user_id and l.run_id = p_run_id),
    'event_rsvps', (select pg_catalog.count(*) from public.member_event_rsvps r join private.member_stress_ledger l on l.user_id = r.user_id and l.run_id = p_run_id),
    'event_checkins', (select pg_catalog.count(*) from public.member_event_checkins c join private.member_stress_ledger l on l.user_id = c.user_id and l.run_id = p_run_id),
    'survey_responses', (select pg_catalog.count(*) from public.member_survey_responses s join private.member_stress_ledger l on l.user_id = s.user_id and l.run_id = p_run_id),
    'broadcast_receipts', (select pg_catalog.count(*) from public.member_broadcast_receipts b join private.member_stress_ledger l on l.user_id = b.user_id and l.run_id = p_run_id),
    'steward_requests', (select pg_catalog.count(*) from public.member_steward_requests s join private.member_stress_ledger l on l.user_id = s.user_id and l.run_id = p_run_id),
    'forms', (select pg_catalog.count(*) from public.member_forms f join private.member_stress_ledger l on l.user_id = f.user_id and l.run_id = p_run_id),
    'workload_logs', (select pg_catalog.count(*) from public.member_workload_logs w join private.member_stress_ledger l on l.user_id = w.user_id and l.run_id = p_run_id),
    'guide_threads', (select pg_catalog.count(*) from public.member_guide_threads t join private.member_stress_ledger l on l.user_id = t.user_id and l.run_id = p_run_id),
    'case_updates', (select pg_catalog.count(*) from public.member_case_updates u join private.member_stress_ledger l on l.user_id = u.user_id and l.run_id = p_run_id),
    'point_events', (select pg_catalog.count(*) from public.member_point_events e join private.member_stress_ledger l on l.user_id = e.user_id and l.run_id = p_run_id),
    'steward_roles', (select pg_catalog.count(*) from public.member_roles r join private.member_stress_ledger l on l.user_id = r.user_id and l.run_id = p_run_id),
    'protected_unchanged', run.protected_snapshot = private.member_stress_protected_snapshot(p_run_id)
  );

  passed :=
    chapters_used >= 29
    and max_share <= 0.12
    and cases_total = cases_distinct
    and typed_kinds = 0
    and deliveries = 0
    and fresh_points = 0
    and (result ->> 'protected_unchanged')::boolean;

  return result || jsonb_build_object('ok', passed);
end;
$$;

-- ------------------------------------------------------------- 6. grants -----

revoke all on function public.member_stress_enrich_batch(uuid, text, integer, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.member_stress_enrich_verify(uuid) from public, anon, authenticated;
grant execute on function public.member_stress_enrich_batch(uuid, text, integer, integer, text, text) to service_role;
grant execute on function public.member_stress_enrich_verify(uuid) to service_role;

-- CONTRACT COORDINATION (scripts/db-contract.json): both new functions get a
-- functions entry (secdef, exec "service_role", config search_path + the
-- 300s statement_timeout declared INLINE in CREATE — never via a later ALTER,
-- which is how 20260721211321's timeouts became invisible to a
-- CREATE OR REPLACE). The 24 new chapters need no contract change: chapters
-- has no row-count pin and chapters_select_all is already an org-wide catalog
-- policy. tests/stress-reseed-orgs.test.js pins this file.
