-- UB-RWD-01 / UB-RWD-04 / UB-RWD-05
--
-- Restore the exact twelve-perk catalog from the deleted Union Base Site
-- artifact, make every non-fulfillment perk a server-derived entitlement,
-- preserve attained tiers while admins tune the economy, and expose only
-- MFA-gated, audited economy mutations. A client never supplies an effect or
-- quota: effects are derived from a live grant joined to an active item.

set local lock_timeout = '5s';

alter table public.member_reward_items
  add column effect_kind text not null default 'fulfillment',
  add column effect_config jsonb not null default '{}'::jsonb;

alter table public.member_reward_items
  add constraint member_reward_items_effect_kind_check
  check (effect_kind in ('fulfillment', 'cosmetic', 'permission', 'weekly_question', 'ai_quota', 'gated_content')),
  add constraint member_reward_items_effect_config_check
  check (pg_catalog.jsonb_typeof(effect_config) = 'object' and pg_catalog.length(effect_config::text) <= 1000);

-- The four-row starter was intentionally honest while effects did not exist.
-- It is now historical, not a second live catalog. Grants keep their FK row
-- and ledger history, while only these twelve authoritative keys are active.
update public.member_reward_items set active = false;

insert into public.member_reward_items
  (key, label_en, label_es, icon, bucket, min_tier, fulfillment, active, sort, effect_kind, effect_config)
values
  ('union-swag', 'Free union swag', 'Artículos sindicales gratis', '🎁', 'wear', 2, 'ship', true, 10,
    'fulfillment', '{"queue":"shipping"}'),
  ('homepage-customize', 'Customize homepage layout', 'Personaliza la página de inicio', '⌂', 'skin', 2, 'instant', true, 20,
    'cosmetic', '{"surface":"home","variant":"organizer"}'),
  ('custom-theme', 'Custom app theme', 'Tema personalizado de la aplicación', '🎨', 'skin', 2, 'instant', true, 30,
    'cosmetic', '{"theme":"solidarity"}'),
  ('ai-msg-quota-bump', 'Extra AI assistant messages', 'Mensajes adicionales del asistente de IA', '🧭', 'ai', 3, 'instant', true, 40,
    'ai_quota', '{"hourly_bonus":10}'),
  ('steward-meeting-invite', 'Steward meeting invitation', 'Invitación a una reunión de delegados', '🤝', 'xp', 3, 'event', true, 50,
    'fulfillment', '{"queue":"steward_meeting"}'),
  ('create-thread', 'Create discussion thread', 'Crea un hilo de discusión', '💬', 'util', 3, 'instant', true, 60,
    'permission', '{"permission":"chapter_thread_create"}'),
  ('pizza-party', 'Pizza party invite', 'Invitación a una fiesta de pizza', '🍕', 'xp', 3, 'event', true, 70,
    'fulfillment', '{"queue":"pizza_party"}'),
  ('cross-chapter-cards', 'See other chapter cards', 'Ve las tarjetas públicas de otros capítulos', '🗂', 'util', 4, 'instant', true, 80,
    'permission', '{"permission":"public_chapter_cards"}'),
  ('im-anyone', 'IM anyone bypass', 'Solicita contacto directo con otro miembro', '✉', 'util', 4, 'instant', true, 90,
    'permission', '{"permission":"member_contact_request","privacy":"same_chapter_consent"}'),
  ('priority-wq-slot', 'Priority weekly-question placement', 'Prioridad para la pregunta semanal', '⬆', 'xp', 4, 'instant', true, 100,
    'weekly_question', '{"priority":1}'),
  ('wq-boost-2x', 'Weekly-question boost weight 2x', 'Peso doble para la pregunta semanal', '×2', 'xp', 4, 'instant', true, 110,
    'weekly_question', '{"weight":2}'),
  ('experimental-access', 'Experimental feature access', 'Acceso a funciones experimentales', '🧪', 'util', 5, 'instant', true, 120,
    'gated_content', '{"feature":"member_labs"}')
on conflict (key) do update set
  label_en = excluded.label_en,
  label_es = excluded.label_es,
  icon = excluded.icon,
  bucket = excluded.bucket,
  min_tier = excluded.min_tier,
  fulfillment = excluded.fulfillment,
  active = excluded.active,
  sort = excluded.sort,
  effect_kind = excluded.effect_kind,
  effect_config = excluded.effect_config;

-- An effect exists only while the catalog row is active and the grant is in
-- a granted/fulfilled state. A claim awaiting admin action unlocks nothing;
-- revocation or catalog retirement takes effect on the next server check.
create function private.member_reward_effect_enabled(p_user_id uuid, p_effect_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.member_reward_grants g
    join public.member_reward_items i on i.key = g.item_key
    where g.user_id = p_user_id
      and g.item_key = p_effect_key
      and g.status in ('granted', 'shipped', 'delivered')
      and i.active
  );
$$;

revoke all on function private.member_reward_effect_enabled(uuid, text) from public, anon, authenticated;

-- The governance migration installs this hook as a zero-only default so it
-- can deploy independently. Once the economy exists, replace it with the one
-- bounded, server-derived entitlement. The configured JSON is display/admin
-- metadata; it is deliberately not executable quota input.
create or replace function private.compass_ai_reward_quota_bonus(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.member_reward_effect_enabled(p_user_id, 'ai-msg-quota-bump') then 10
    else 0
  end;
$$;
revoke all on function private.compass_ai_reward_quota_bonus(uuid) from public, anon, authenticated, service_role;

-- Public chapter cards are already publication-reviewed and readable on the
-- signed-out site. The perk controls whether they enter the member home feed;
-- it never exposes an unpublished record or a chapter-private table.
create function public.get_reward_cross_chapter_cards(p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  wanted_locale text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.member_reward_effect_enabled(caller, 'cross-chapter-cards') then
    return '[]'::jsonb;
  end if;
  select case
    when p_locale = 'es' or (p_locale is null and p.language = 'es') then 'es'
    else 'en'
  end into wanted_locale
  from public.member_profiles p where p.id = caller;

  return coalesce((
    select pg_catalog.jsonb_agg(card.item order by card.sort_order, card.published_at desc, card.id)
    from (
      select r.id, r.sort_order, r.published_at,
        pg_catalog.jsonb_build_object(
          'id', r.id,
          'title', case when wanted_locale = 'es' then r.title_es else r.title_en end,
          'body', case when wanted_locale = 'es' then r.body_es else r.body_en end,
          'region', case when wanted_locale = 'es' then r.region_es else r.region_en end,
          'url', r.url
        ) as item
      from public.public_site_records r
      where r.is_published and r.kind = 'chapter'
      order by r.sort_order, r.published_at desc, r.id
      limit 12
    ) card
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.get_reward_cross_chapter_cards(text) from public, anon;
grant execute on function public.get_reward_cross_chapter_cards(text) to authenticated;

-- Weekly Pulse is a bounded, chapter-local workflow. Direct table access is
-- denied: the RPCs derive chapter/user/week, return no author identity, and
-- recompute both reward effects from live grants on every list call so a
-- revocation takes effect immediately.
create table public.member_weekly_questions (
  id uuid primary key default gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  body text not null check (pg_catalog.char_length(pg_catalog.btrim(body)) between 10 and 280),
  created_at timestamptz not null default now(),
  unique (user_id, week_start)
);

create table public.member_weekly_question_supports (
  question_id uuid not null references public.member_weekly_questions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (question_id, user_id)
);

create index member_weekly_questions_chapter_week_idx
  on public.member_weekly_questions (chapter_id, week_start, created_at, id);
create index member_weekly_question_supports_user_idx
  on public.member_weekly_question_supports (user_id, question_id);

alter table public.member_weekly_questions enable row level security;
alter table public.member_weekly_question_supports enable row level security;
create policy mfa_assurance on public.member_weekly_questions as restrictive
  for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
create policy mfa_assurance on public.member_weekly_question_supports as restrictive
  for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
revoke all on public.member_weekly_questions from public, anon, authenticated;
revoke all on public.member_weekly_question_supports from public, anon, authenticated;

create function public.list_weekly_questions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', now() at time zone 'UTC')::date;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', ranked.id,
      'body', ranked.body,
      'submittedByMe', ranked.user_id = caller,
      'boostedByMe', ranked.boosted_by_me,
      'priority', ranked.priority,
      'score', ranked.score,
      'createdAt', ranked.created_at
    ) order by ranked.priority desc, ranked.score desc, ranked.created_at, ranked.id)
    from (
      select q.id, q.user_id, q.body, q.created_at,
        private.member_reward_effect_enabled(q.user_id, 'priority-wq-slot') as priority,
        exists (
          select 1 from public.member_weekly_question_supports mine
          where mine.question_id = q.id and mine.user_id = caller
        ) as boosted_by_me,
        coalesce((
          select pg_catalog.sum(case
            when private.member_reward_effect_enabled(s.user_id, 'wq-boost-2x') then 2
            else 1
          end)::integer
          from public.member_weekly_question_supports s
          where s.question_id = q.id
        ), 0) as score
      from public.member_weekly_questions q
      where q.chapter_id = caller_chapter and q.week_start = current_week
      order by
        private.member_reward_effect_enabled(q.user_id, 'priority-wq-slot') desc,
        coalesce((select pg_catalog.count(*) from public.member_weekly_question_supports s where s.question_id = q.id), 0) desc,
        q.created_at,
        q.id
      limit 25
    ) ranked
  ), '[]'::jsonb);
end;
$$;

create function public.submit_weekly_question(p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', now() at time zone 'UTC')::date;
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  question_id uuid;
  inserted boolean := false;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 10 and 280 then
    raise exception 'question must be 10 to 280 characters' using errcode = '22023';
  end if;

  insert into public.member_weekly_questions (chapter_id, user_id, week_start, body)
  values (caller_chapter, caller, current_week, clean_body)
  on conflict (user_id, week_start) do nothing
  returning id into question_id;
  inserted := question_id is not null;
  if not inserted then
    select q.id into question_id from public.member_weekly_questions q
    where q.user_id = caller and q.week_start = current_week;
  end if;

  return pg_catalog.jsonb_build_object('id', question_id, 'created', inserted);
end;
$$;

create function public.boost_weekly_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  current_week date := pg_catalog.date_trunc('week', now() at time zone 'UTC')::date;
  inserted boolean := false;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_question_id is null or not exists (
    select 1 from public.member_weekly_questions q
    where q.id = p_question_id
      and q.chapter_id = caller_chapter
      and q.week_start = current_week
      and q.user_id <> caller
  ) then
    raise exception 'question unavailable' using errcode = '22023';
  end if;

  insert into public.member_weekly_question_supports (question_id, user_id)
  values (p_question_id, caller)
  on conflict (question_id, user_id) do nothing;
  inserted := found;

  return pg_catalog.jsonb_build_object(
    'questionId', p_question_id,
    'created', inserted,
    'weight', case when private.member_reward_effect_enabled(caller, 'wq-boost-2x') then 2 else 1 end
  );
end;
$$;

revoke all on function public.list_weekly_questions() from public, anon;
revoke all on function public.submit_weekly_question(text) from public, anon;
revoke all on function public.boost_weekly_question(uuid) from public, anon;
grant execute on function public.list_weekly_questions() to authenticated;
grant execute on function public.submit_weekly_question(text) to authenticated;
grant execute on function public.boost_weekly_question(uuid) to authenticated;

create function public.get_member_reward_effects()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', i.key,
      'kind', i.effect_kind,
      'config', i.effect_config,
      'status', g.status
    ) order by i.sort, i.key)
    from public.member_reward_grants g
    join public.member_reward_items i on i.key = g.item_key
    where g.user_id = caller
      and g.status in ('granted', 'shipped', 'delivered')
      and i.active
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_member_reward_effects() from public, anon;
grant execute on function public.get_member_reward_effects() to authenticated;

-- "Create discussion thread" is now a real permission. Staff retain their
-- existing authority; an ordinary member needs the live entitlement and can
-- still create only inside a same-chapter space they are already allowed to
-- read. The reward never widens space visibility.
drop policy chapter_threads_create on public.chapter_threads;
create policy chapter_threads_create on public.chapter_threads for insert to authenticated
  with check (
    chapter_id = private.current_member_chapter()
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.chapter_spaces s
      where s.id = space_id and private.can_read_chapter_space(s)
    )
    and (
      public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
      or private.member_reward_effect_enabled((select auth.uid()), 'create-thread')
    )
  );

-- Durable attainment makes the product's "tiers never demote" promise true
-- even when an admin raises a threshold. Snapshot current attainment before
-- each threshold edit and advance it after every paid point event.
create table public.member_reward_tier_attainment (
  user_id uuid primary key references auth.users(id) on delete cascade,
  highest_tier smallint not null references public.member_reward_tiers(tier),
  attained_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

with totals as (
  select p.id as user_id, coalesce(pg_catalog.sum(e.points), 0)::integer as points
  from public.member_profiles p
  left join public.member_point_events e on e.user_id = p.id
  group by p.id
), attained as (
  select t.user_id, coalesce((
    select r.tier from public.member_reward_tiers r
    where r.min_points <= t.points
    order by r.min_points desc limit 1
  ), 1)::smallint as tier
  from totals t
)
insert into public.member_reward_tier_attainment (user_id, highest_tier)
select user_id, tier from attained
on conflict (user_id) do update set
  highest_tier = greatest(public.member_reward_tier_attainment.highest_tier, excluded.highest_tier),
  updated_at = now();

create function private.preserve_member_reward_tier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reached smallint;
begin
  select coalesce((
    select r.tier
    from public.member_reward_tiers r
    where r.min_points <= (
      select coalesce(pg_catalog.sum(e.points), 0)
      from public.member_point_events e where e.user_id = new.user_id
    )
    order by r.min_points desc limit 1
  ), 1)::smallint into reached;

  insert into public.member_reward_tier_attainment (user_id, highest_tier)
  values (new.user_id, reached)
  on conflict (user_id) do update set
    highest_tier = greatest(public.member_reward_tier_attainment.highest_tier, excluded.highest_tier),
    updated_at = now();
  return new;
end;
$$;

revoke all on function private.preserve_member_reward_tier() from public, anon, authenticated;
create trigger member_point_events_preserve_tier
after insert or update of points on public.member_point_events
for each row execute function private.preserve_member_reward_tier();

create or replace function private.member_tier_of(p_user uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    coalesce((select a.highest_tier from public.member_reward_tier_attainment a where a.user_id = p_user), 1),
    coalesce((
      select r.tier from public.member_reward_tiers r
      where r.min_points <= coalesce((select pg_catalog.sum(e.points) from public.member_point_events e where e.user_id = p_user), 0)
      order by r.min_points desc limit 1
    ), 1)
  )::smallint;
$$;

revoke all on function private.member_tier_of(uuid) from public, anon, authenticated;

create or replace function public.get_member_rewards_summary()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  total integer;
  current_tier smallint;
  tier_row record;
  next_row record;
  streak integer;
  ytd integer;
  year_start timestamptz;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.sum(points), 0) into total
  from public.member_point_events where user_id = caller;
  current_tier := private.member_tier_of(caller);

  select tier, name, min_points into tier_row
  from public.member_reward_tiers where tier = current_tier;
  select tier, name, min_points into next_row
  from public.member_reward_tiers where tier > current_tier order by tier limit 1;

  with action_weeks as (
    select distinct pg_catalog.date_trunc('week', occurred_at) as wk
    from public.member_action_log
    where user_id = caller and action_kind <> 'seed'
  ), anchored as (
    select wk, pg_catalog.row_number() over (order by wk desc) as rn,
      pg_catalog.max(wk) over () as anchor from action_weeks
  )
  select pg_catalog.count(*) into streak from anchored
  where anchor >= pg_catalog.date_trunc('week', now()) - interval '7 days'
    and wk = anchor - ((rn - 1) * interval '7 days');

  year_start := pg_catalog.date_trunc('year', now() at time zone 'America/New_York') at time zone 'America/New_York';
  select pg_catalog.count(*) into ytd from public.member_point_events
  where user_id = caller and occurred_at >= year_start;

  return pg_catalog.jsonb_build_object(
    'totalPoints', total,
    'tierNumber', coalesce(tier_row.tier, 1),
    'tierName', coalesce(tier_row.name, 'Member'),
    'nextTierName', next_row.name,
    'pointsToGo', case when next_row.min_points is null then null else greatest(0, next_row.min_points - total) end,
    'weekStreak', coalesce(streak, 0),
    'actionsYtd', coalesce(ytd, 0)
  );
end;
$$;

alter table public.member_reward_tier_attainment enable row level security;
create policy member_reward_tier_attainment_select_own
  on public.member_reward_tier_attainment for select to authenticated
  using (user_id = (select auth.uid()));
create policy mfa_assurance on public.member_reward_tier_attainment
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
revoke all on public.member_reward_tier_attainment from public, anon, authenticated;
grant select on public.member_reward_tier_attainment to authenticated;

-- Append-only economy history. Direct writes are absent; only the three
-- server mutation functions below append old/new snapshots.
create table public.member_reward_economy_revisions (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  entity_kind text not null check (entity_kind in ('point_rule', 'tier', 'item')),
  entity_key text not null check (pg_catalog.char_length(entity_key) between 1 and 80),
  old_value jsonb,
  new_value jsonb not null,
  created_at timestamptz not null default now()
);
create index member_reward_economy_revisions_created_idx
  on public.member_reward_economy_revisions (created_at desc, id desc);
alter table public.member_reward_economy_revisions enable row level security;
create policy member_reward_economy_revisions_admin_read
  on public.member_reward_economy_revisions for select to authenticated
  using (public.member_has_role(array['admin']) and (select private.mfa_satisfied()));
create policy mfa_assurance on public.member_reward_economy_revisions
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
revoke all on public.member_reward_economy_revisions from public, anon, authenticated;
grant select on public.member_reward_economy_revisions to authenticated;

create function private.assert_reward_economy_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null
     or not private.mfa_satisfied()
     or not public.member_has_role(array['admin']) then
    raise exception 'admin role and MFA required' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.assert_reward_economy_admin() from public, anon, authenticated;

create function public.get_admin_reward_economy()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_reward_economy_admin();
  return pg_catalog.jsonb_build_object(
    'rules', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.action_kind) from public.member_point_rules r), '[]'::jsonb),
    'tiers', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.tier) from public.member_reward_tiers t), '[]'::jsonb),
    'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) order by i.sort, i.key) from public.member_reward_items i), '[]'::jsonb),
    'formTemplatePoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', f.key, 'version', f.version, 'labelEn', f.label_en, 'labelEs', f.label_es, 'points', f.points) order by f.sort, f.key)
      from (select distinct on (key) key, version, label_en, label_es, points, sort from public.form_templates order by key, version desc) f
    ), '[]'::jsonb),
    'revisions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc, x.id desc)
      from (select * from public.member_reward_economy_revisions order by created_at desc, id desc limit 50) x), '[]'::jsonb)
  );
end;
$$;

create function public.save_reward_point_rule(p_action_kind text, p_points integer, p_weekly_cap integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  old_row public.member_point_rules%rowtype;
  next_row public.member_point_rules%rowtype;
begin
  perform private.assert_reward_economy_admin();
  if p_points is null or p_points not between 0 and 100
     or (p_weekly_cap is not null and p_weekly_cap not between 1 and 1000) then
    raise exception 'invalid point rule' using errcode = '22023';
  end if;
  select * into old_row from public.member_point_rules where action_kind = p_action_kind for update;
  if not found then raise exception 'point rule not found' using errcode = '22023'; end if;
  update public.member_point_rules set points = p_points, weekly_cap = p_weekly_cap
    where action_kind = p_action_kind returning * into next_row;
  if pg_catalog.to_jsonb(old_row) is distinct from pg_catalog.to_jsonb(next_row) then
    insert into public.member_reward_economy_revisions(actor_id, entity_kind, entity_key, old_value, new_value)
    values (caller, 'point_rule', p_action_kind, pg_catalog.to_jsonb(old_row), pg_catalog.to_jsonb(next_row));
  end if;
  return pg_catalog.to_jsonb(next_row);
end;
$$;

create function public.save_reward_tier(p_tier smallint, p_name text, p_min_points integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_name text := pg_catalog.btrim(coalesce(p_name, ''));
  old_row public.member_reward_tiers%rowtype;
  next_row public.member_reward_tiers%rowtype;
begin
  perform private.assert_reward_economy_admin();
  if pg_catalog.char_length(clean_name) not between 2 and 60 or p_min_points is null or p_min_points < 0
     or (p_tier = 1 and p_min_points <> 0) then
    raise exception 'invalid tier' using errcode = '22023';
  end if;
  lock table public.member_reward_tiers in share row exclusive mode;
  select * into old_row from public.member_reward_tiers where tier = p_tier for update;
  if not found then raise exception 'tier not found' using errcode = '22023'; end if;
  if exists (select 1 from public.member_reward_tiers where tier < p_tier and min_points >= p_min_points)
     or exists (select 1 from public.member_reward_tiers where tier > p_tier and min_points <= p_min_points) then
    raise exception 'tier thresholds must increase' using errcode = '22023';
  end if;

  -- Snapshot the old ladder before changing it, so threshold edits cannot
  -- demote a member who had already reached a tier.
  with totals as (
    select p.id as user_id, coalesce(pg_catalog.sum(e.points), 0)::integer as points
    from public.member_profiles p left join public.member_point_events e on e.user_id = p.id
    group by p.id
  ), attained as (
    select t.user_id, coalesce((select r.tier from public.member_reward_tiers r
      where r.min_points <= t.points order by r.min_points desc limit 1), 1)::smallint as tier
    from totals t
  )
  insert into public.member_reward_tier_attainment(user_id, highest_tier)
  select user_id, tier from attained
  on conflict (user_id) do update set
    highest_tier = greatest(public.member_reward_tier_attainment.highest_tier, excluded.highest_tier),
    updated_at = now();

  update public.member_reward_tiers set name = clean_name, min_points = p_min_points
    where tier = p_tier returning * into next_row;
  if pg_catalog.to_jsonb(old_row) is distinct from pg_catalog.to_jsonb(next_row) then
    insert into public.member_reward_economy_revisions(actor_id, entity_kind, entity_key, old_value, new_value)
    values (caller, 'tier', p_tier::text, pg_catalog.to_jsonb(old_row), pg_catalog.to_jsonb(next_row));
  end if;
  return pg_catalog.to_jsonb(next_row);
end;
$$;

create function public.save_reward_item(
  p_key text, p_label_en text, p_label_es text, p_icon text, p_bucket text,
  p_min_tier smallint, p_fulfillment text, p_sort integer, p_active boolean,
  p_effect_kind text, p_effect_config jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_key text := pg_catalog.btrim(coalesce(p_key, ''));
  clean_en text := pg_catalog.btrim(coalesce(p_label_en, ''));
  clean_es text := pg_catalog.btrim(coalesce(p_label_es, ''));
  clean_icon text := pg_catalog.btrim(coalesce(p_icon, ''));
  old_value jsonb;
  next_row public.member_reward_items%rowtype;
begin
  perform private.assert_reward_economy_admin();
  if clean_key !~ '^[a-z0-9-]{2,40}$'
     or pg_catalog.char_length(clean_en) not between 2 and 100
     or pg_catalog.char_length(clean_es) not between 2 and 100
     or pg_catalog.char_length(clean_icon) > 12
     or p_bucket is null or p_bucket not in ('wear','skin','ai','util','xp','sol')
     or p_min_tier is null or p_min_tier not between 1 and 5
     or p_fulfillment is null or p_fulfillment not in ('ship','instant','event')
     or p_effect_kind is null or p_effect_kind not in ('fulfillment','cosmetic','permission','weekly_question','ai_quota','gated_content')
     or p_effect_config is null or pg_catalog.jsonb_typeof(p_effect_config) <> 'object'
     or pg_catalog.length(p_effect_config::text) > 1000
     or p_sort is null or p_sort not between 0 and 100000 then
    raise exception 'invalid reward item' using errcode = '22023';
  end if;
  select pg_catalog.to_jsonb(i) into old_value from public.member_reward_items i where i.key = clean_key for update;
  insert into public.member_reward_items
    (key,label_en,label_es,icon,bucket,min_tier,fulfillment,sort,active,effect_kind,effect_config)
  values
    (clean_key,clean_en,clean_es,clean_icon,p_bucket,p_min_tier,p_fulfillment,p_sort,coalesce(p_active,false),p_effect_kind,p_effect_config)
  on conflict (key) do update set
    label_en=excluded.label_en,label_es=excluded.label_es,icon=excluded.icon,bucket=excluded.bucket,
    min_tier=excluded.min_tier,fulfillment=excluded.fulfillment,sort=excluded.sort,active=excluded.active,
    effect_kind=excluded.effect_kind,effect_config=excluded.effect_config
  returning * into next_row;
  if old_value is distinct from pg_catalog.to_jsonb(next_row) then
    insert into public.member_reward_economy_revisions(actor_id, entity_kind, entity_key, old_value, new_value)
    values (caller, 'item', clean_key, old_value, pg_catalog.to_jsonb(next_row));
  end if;
  return pg_catalog.to_jsonb(next_row);
end;
$$;

-- The form award amount is already stored on each immutable template version.
-- Reassert that row-backed lookup here so the economy surface and award trigger
-- cannot drift back to a hardcoded CASE.
create or replace function private.form_points(p_template_key text)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select points from public.form_templates where key = p_template_key order by version desc limit 1
  ), 15);
$$;
revoke all on function private.form_points(text) from public, anon, authenticated;

revoke all on function public.get_admin_reward_economy() from public, anon;
revoke all on function public.save_reward_point_rule(text, integer, integer) from public, anon;
revoke all on function public.save_reward_tier(smallint, text, integer) from public, anon;
revoke all on function public.save_reward_item(text,text,text,text,text,smallint,text,integer,boolean,text,jsonb) from public, anon;
grant execute on function public.get_admin_reward_economy() to authenticated;
grant execute on function public.save_reward_point_rule(text, integer, integer) to authenticated;
grant execute on function public.save_reward_tier(smallint, text, integer) to authenticated;
grant execute on function public.save_reward_item(text,text,text,text,text,smallint,text,integer,boolean,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
