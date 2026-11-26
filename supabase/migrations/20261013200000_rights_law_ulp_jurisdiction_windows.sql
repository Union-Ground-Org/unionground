-- REQ-UG-RIGHTS-LAW-LIBRARY-20261012
--
-- Build-it-all campaign, lane L2a (rights and law layer). Two parts:
--
-- 1. features.rights.law_library: the platform switch for the Massachusetts
--    and federal labor-rights library on the Rights page (the content is
--    reference data in data/reference/labor-rights/, every row with its
--    provenance record). Member-visible so web and native can show or hide
--    the section honestly; off by default.
--
-- 2. A per-jurisdiction unfair-labor-practice (ULP) charge window replacing
--    the generic 180-day organization default where the law is known.
--    private.reference_ulp_limitation_periods holds one row per jurisdiction,
--    the period exactly as the law states it (Massachusetts: six months, not
--    180 days), the quote it rests on and the provenance record
--    (docs/conventions/provenance.md; the CHECK below is the contract's).
--    An organization picks its jurisdiction in limits.casework.ulp_jurisdiction
--    (default none = the organization's own limits.casework.ulp_window_days,
--    as before). A BEFORE INSERT trigger stamps each new flag with the window
--    computed for that incident date, so "six months" lands on the calendar
--    date six months later (an incident on 2026-08-31 is due 2027-02-28),
--    and records the basis. The stored-deadline rule of
--    20261002140000_casework_ulp_filing_deadline.sql holds: the deadline is
--    still incident_on + ulp_window_days, generated and stored, so changing
--    the jurisdiction or the table never moves a deadline already shown.
--    The three inserters (staff flag, member-report sweep, timing detector)
--    keep their bodies; the trigger covers all three.
--
-- Massachusetts row: 456 CMR 15.04 as published by the Department of Labor
-- Relations ("no charge shall be entertained by the Department based upon any
-- prohibited practice occurring more than six months prior to the filing of a
-- charge with the Department", except for good cause shown), read from a
-- capture of the DLR's own copy on October 12, 2026, and the DLR's procedures
-- page (six months from when the charging party knew or should have known).
-- The same record is in data/reference/labor-rights/agencies.json
-- (ulp_limitation_periods) and tests/rights-law-library-data.test.js keeps the
-- two identical. Not legal advice: the member copy routes every case to a
-- steward.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible)
values
  -- New in this campaign; no earlier default. Off until a platform editor or
  -- an organization admin turns it on.
  ('features.rights.law_library', 'boolean', 'Laws and agencies library',
   'Show members the Massachusetts and federal labor-rights library on the Rights page: enforcement agencies, filing deadlines with their sources, and plain-language guides. General information, not legal advice.',
   'false', null, null, null, 2400, 'guidance_onboarding', true),
  -- New: none keeps limits.casework.ulp_window_days (180) exactly as before.
  ('limits.casework.ulp_jurisdiction', 'text', 'ULP filing deadline law',
   'Which jurisdiction''s law sets the unfair labor practice charge deadline on newly flagged incidents. None uses the ULP filing window in days. Massachusetts uses six months (456 CMR 15.04).',
   '"none"', null, null, array['none', 'MA'], 1405, 'casework', false)
on conflict (key) do nothing;

create table private.reference_ulp_limitation_periods (
  jurisdiction text primary key check (jurisdiction ~ '^[A-Z]{2}$'),
  jurisdiction_name text not null check (pg_catalog.char_length(pg_catalog.btrim(jurisdiction_name)) between 2 and 80),
  period_value integer not null,
  period_unit text not null check (period_unit in ('day', 'month')),
  period_text text not null check (pg_catalog.char_length(pg_catalog.btrim(period_text)) between 3 and 200),
  trigger_text text not null check (pg_catalog.char_length(pg_catalog.btrim(trigger_text)) between 3 and 300),
  extension_text text check (extension_text is null or pg_catalog.char_length(pg_catalog.btrim(extension_text)) between 3 and 300),
  pinpoint text not null check (pg_catalog.char_length(pg_catalog.btrim(pinpoint)) between 3 and 120),
  quote text not null check (pg_catalog.char_length(quote) between 20 and 1000),
  provenance jsonb not null,
  updated_at timestamptz not null default pg_catalog.now(),
  -- Every period must fit casework_retaliation_flags.ulp_window_days
  -- (between 30 and 365) for any incident date: 2 to 11 months is 59 to 337
  -- days, so a sourced row can never make a flag insert fail its check.
  constraint reference_ulp_limitation_periods_period_bounds check (
    (period_unit = 'day' and period_value between 30 and 365)
    or (period_unit = 'month' and period_value between 2 and 11)
  ),
  constraint reference_ulp_limitation_periods_provenance_complete check (
    jsonb_typeof(provenance) = 'object'
    and coalesce(provenance ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'url', '')) ~ '^https?://'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'publisher', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'retrieved_at', '')) <> ''
    and coalesce(provenance ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance -> 'review' ->> 'status', '')) <> ''
  )
);

comment on table private.reference_ulp_limitation_periods is
  'Per-jurisdiction unfair labor practice charge filing period, stated as the law states it, with the quote and provenance record it rests on (REQ-UG-RIGHTS-LAW-LIBRARY-20261012). Read only by SECURITY DEFINER casework functions.';

alter table private.reference_ulp_limitation_periods enable row level security;
-- Deny-by-default: no policy and no grant. Only the SECURITY DEFINER casework
-- routines below read it.
revoke all on table private.reference_ulp_limitation_periods from public, anon, authenticated, service_role;

-- The Massachusetts row, exactly as data/reference/labor-rights/agencies.json
-- (ulp_limitation_periods) carries it; tests/rights-law-library-data.test.js
-- compares the two.
insert into private.reference_ulp_limitation_periods
  (jurisdiction, jurisdiction_name, period_value, period_unit, period_text,
   trigger_text, extension_text, pinpoint, quote, provenance)
values (
  'MA', 'Massachusetts', 6, 'month', 'six months',
  'from the date the Charging Party knew or should have known of the alleged prohibited practice',
  'unless good cause is shown',
  '456 CMR 15.04',
  'The Charging Party must submit a Charge on the DLR’s Charge of prohibited practice form with the DLR within six months from the date the Charging Party knew or should have known of the alleged prohibited practice, unless good cause is shown.',
  '{"provenance_id":"prov-9e2e4feb5c8e3728d2954a37318d5d71fc8f4cfa9eb1c4a841291f8c3a30d070","source":{"url":"https://www.mass.gov/info-details/a-unfair-labor-practice-procedures","publisher":"Massachusetts Department of Labor Relations (mass.gov)","title":"A. Unfair labor practice procedures","document_date":null},"retrieved_at":"2026-10-12T07:09:26.000Z","content_sha256":"7cdca0301e9806f88afafc964e2160159cc3c59da75efdb54bd1a77be0bd5998","capture":{"method":"firecrawl","tool":"firecrawl-cli@1.19.18 scrape --only-main-content --max-age 0","run_id":"build-it-all-20261012/L7/authoring"},"extraction":{"method":"model","extractor":"claude-opus-5-5 (lane L2a deadline verifier); quotes checked by scripts/build-rights-law-library.mjs@1","quote_binding":"exact-substring"},"as_of":"2026-10-12","derived_from":["prov-3b349959c4dafde0979adfe32682368b4359e5256ba2e71bbe940e38a013d009","prov-6a3f1a229301e516353b1e185f714a42d0bf80eaf5eb77989511ed4ca30107cb"],"review":{"status":"reviewed","reviewed_at":"2026-10-12T08:16:57Z","reviewer_role":"lane","note":"Period, trigger and exception from the DLR procedures page; the rule from the DLR''s own copy of 456 CMR 15.04. Agrees with lane L2b''s Massachusetts row (456 CMR 15.04 via Cornell LII)."},"reuse":{"basis":"public-record","note":"Cited and paraphrased; not republished in full."}}'::jsonb
);

alter table public.casework_retaliation_flags
  add column ulp_window_basis text not null default 'organization_limit',
  add constraint casework_retaliation_flags_ulp_window_basis_check
    check (ulp_window_basis = 'organization_limit' or ulp_window_basis ~ '^jurisdiction:[A-Z]{2}$');

comment on column public.casework_retaliation_flags.ulp_window_basis is
  'What set ulp_window_days when the flag was created: organization_limit (limits.casework.ulp_window_days) or jurisdiction:<code> (private.reference_ulp_limitation_periods). Existing flags keep organization_limit, which is what set them.';

create function private.casework_ulp_apply_jurisdiction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_code text;
  v_row private.reference_ulp_limitation_periods%rowtype;
begin
  v_code := private.organization_setting_text(new.organization_id, 'limits.casework.ulp_jurisdiction');
  if v_code is null or v_code = 'none' then
    new.ulp_window_basis := 'organization_limit';
    return new;
  end if;
  select * into v_row from private.reference_ulp_limitation_periods r where r.jurisdiction = v_code;
  if not found then
    -- Fail closed: a jurisdiction without its sourced row never falls back silently.
    raise exception 'no sourced ULP period for jurisdiction %', v_code using errcode = '22023';
  end if;
  new.ulp_window_days := case v_row.period_unit
    when 'month' then ((new.incident_on + pg_catalog.make_interval(months => v_row.period_value))::date - new.incident_on)
    else v_row.period_value
  end;
  new.ulp_window_basis := 'jurisdiction:' || v_row.jurisdiction;
  return new;
end;
$function$;

revoke all on function private.casework_ulp_apply_jurisdiction() from public, anon, authenticated, service_role;

comment on function private.casework_ulp_apply_jurisdiction() is
  'REQ-UG-RIGHTS-LAW-LIBRARY-20261012: BEFORE INSERT on casework_retaliation_flags. When the organization''s limits.casework.ulp_jurisdiction names a sourced row, sets ulp_window_days to the calendar span of that period from the incident date (six months, not 180 days) and ulp_window_basis to jurisdiction:<code>; otherwise keeps the inserted organization window. Never runs on update, so a stored deadline never moves.';

-- After a00_case_graph_lock, before z99_case_graph_keys.
create trigger m10_ulp_jurisdiction_window before insert on public.casework_retaliation_flags
  for each row execute function private.casework_ulp_apply_jurisdiction();

-- The staff projection of one flag gains what set its window: windowBasis
-- (organization_limit or jurisdiction:<code>) and, for a jurisdiction, the
-- provenance record of the law it rests on (windowSource). Same signature;
-- every earlier key is kept (latest body: 20261002141000).
create or replace function private.casework_retaliation_flag_json(p_flag public.casework_retaliation_flags, p_enabled boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_flag.id,
    'caseId', p_flag.case_id,
    'source', p_flag.source,
    'incidentOn', p_flag.incident_on,
    'ulpDeadline', case when p_enabled then p_flag.ulp_deadline end,
    'daysLeft', case when p_enabled then p_flag.ulp_deadline - current_date end,
    'windowDays', p_flag.ulp_window_days,
    'status', p_flag.status,
    'note', p_flag.note,
    'reviewedAt', p_flag.reviewed_at,
    'warningSentAt', p_flag.warning_sent_at,
    'urgentSentAt', p_flag.urgent_sent_at,
    'createdAt', p_flag.created_at,
    'adverseKind', p_flag.adverse_kind,
    'protectedActivityOn', p_flag.protected_activity_on,
    'daysBetween', p_flag.days_between,
    'confidence', p_flag.confidence,
    'priorDisciplineCount', p_flag.prior_discipline_count,
    'staffNotifiedAt', p_flag.staff_notified_at,
    'windowBasis', p_flag.ulp_window_basis,
    'windowSource', (
      select r.provenance
      from private.reference_ulp_limitation_periods r
      where p_flag.ulp_window_basis = 'jurisdiction:' || r.jurisdiction));
$function$;

-- The staff case view gains the organization's jurisdiction (null when it is
-- none), so the panel can say "six months (456 CMR 15.04)" with its source
-- instead of the day window. Same signature and checks (latest body:
-- 20261002140000).
create or replace function public.casework_list_case_retaliation_flags(p_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_case public.member_cases%rowtype;
  v_enabled boolean;
  v_warning integer;
  v_critical integer;
  v_jurisdiction jsonb;
begin
  perform private.casework_require_mfa();
  if p_case_id is null or not private.casework_staff_can_access(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  v_enabled := private.organization_feature_enabled(v_case.organization_id, 'features.casework.ulp_deadline');
  select t.warning_days, t.critical_days into v_warning, v_critical
  from private.casework_ulp_thresholds(v_case.organization_id) t;
  select pg_catalog.jsonb_build_object(
      'code', r.jurisdiction,
      'name', r.jurisdiction_name,
      'periodValue', r.period_value,
      'periodUnit', r.period_unit,
      'periodText', r.period_text,
      'trigger', r.trigger_text,
      'extension', r.extension_text,
      'pinpoint', r.pinpoint,
      'provenance', r.provenance)
    into v_jurisdiction
  from private.reference_ulp_limitation_periods r
  where r.jurisdiction = private.organization_setting_text(v_case.organization_id, 'limits.casework.ulp_jurisdiction');
  return pg_catalog.jsonb_build_object(
    'enabled', v_enabled,
    'windowDays', private.organization_limit(v_case.organization_id, 'limits.casework.ulp_window_days'),
    'jurisdiction', v_jurisdiction,
    'warningDays', v_warning,
    'criticalDays', v_critical,
    'flags', coalesce((
      select pg_catalog.jsonb_agg(private.casework_retaliation_flag_json(f, v_enabled)
        order by f.ulp_deadline, f.created_at, f.id)
      from public.casework_retaliation_flags f
      where f.case_id = v_case.id
    ), '[]'::jsonb));
end;
$function$;

-- The member summary keeps every pinned field and the PIN full-session gate
-- (latest body: 20261003040000_member_pin_signin.sql) and adds ulpSource: the
-- provenance record of the law behind the flag whose deadline it reports, or
-- null when that flag used the organization's day window or tracking is off.
create or replace function public.get_my_case_ulp_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'caseId', s.case_id,
      'ulpDeadline', case when s.enabled then s.ulp_deadline end,
      'retaliationFlagged', true,
      'stewardNotified', s.steward_notified,
      'ulpWarningDays', s.warning_days,
      'ulpCriticalDays', s.critical_days,
      'ulpSource', case when s.enabled then (
        select r.provenance
        from (
          select d.ulp_window_basis
          from public.casework_retaliation_flags d
          where d.case_id = s.case_id and d.status in ('open', 'confirmed')
            and d.ulp_deadline = s.ulp_deadline
          order by d.created_at, d.id
          limit 1
        ) b
        join private.reference_ulp_limitation_periods r
          on b.ulp_window_basis = 'jurisdiction:' || r.jurisdiction) end) order by s.ulp_deadline, s.case_id)
    from (
      select c.id as case_id,
        private.organization_feature_enabled(c.organization_id, 'features.casework.ulp_deadline') as enabled,
        coalesce(
          min(f.ulp_deadline) filter (where f.ulp_deadline >= current_date),
          max(f.ulp_deadline)) as ulp_deadline,
        bool_or(f.staff_notified_at is not null) as steward_notified,
        t.warning_days,
        t.critical_days
      from public.member_cases c
      join public.casework_retaliation_flags f on f.case_id = c.id and f.status in ('open', 'confirmed')
      cross join lateral private.casework_ulp_thresholds(c.organization_id) t
      where c.user_id = caller
      group by c.id, c.organization_id, t.warning_days, t.critical_days
    ) s
  ), '[]'::jsonb);
end;

end;
$function$;

-- Account lifecycle: the trigger and its function join the reviewed trigger
-- surface (20260907150000 / 20260929034500). Only rows the review does not
-- hold yet are added; a changed definition of an already reviewed object is
-- not ratified here and fails the check below.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where ((s.kind = 'trigger' and s.schema_name = 'public' and s.table_name = 'casework_retaliation_flags'
        and s.object_name = 'm10_ulp_jurisdiction_window')
    or s.kind = 'function')
  and not exists (
    select 1 from private.account_lifecycle_trigger_review r
    where r.kind = s.kind and r.schema_name = s.schema_name
      and r.table_name = s.table_name and r.object_name = s.object_name);

do $review$
begin
  if not exists (
    select 1 from private.account_lifecycle_trigger_review r
    where r.kind = 'trigger' and r.schema_name = 'public' and r.table_name = 'casework_retaliation_flags'
      and r.object_name = 'm10_ulp_jurisdiction_window'
  ) or not exists (
    select 1 from private.account_lifecycle_trigger_review r
    where r.kind = 'function' and r.schema_name = 'private'
      and r.object_name = 'casework_ulp_apply_jurisdiction()'
  ) then
    raise exception 'ULP jurisdiction trigger review is missing its trigger or function';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the ULP jurisdiction trigger';
  end if;
end;
$review$;

commit;
