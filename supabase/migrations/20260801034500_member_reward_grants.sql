-- Rewards grant/claim/revoke machinery (design: Rewards Engine redemption
-- functions + the Site's Rewards admin and Fulfillment pages). Claiming spends
-- nothing: it is a tier check, never a point price. All mutation is
-- server-side ("no client can write a redemption directly"), every mutation
-- writes a member_admin_audit line. The seeded catalog is deliberately the
-- honest subset — physical and event items whose fulfillment the app can
-- truthfully report; cosmetic SKIN/AI items are excluded because nothing in
-- the app applies them yet, and a grant that doesn't re-skin would be a lie.
-- Item list, tiers and labels are owner-tunable rows, like member_point_rules.

set local lock_timeout = '5s';

create table public.member_reward_items (
  key text primary key check (key ~ '^[a-z0-9-]{2,40}$'),
  label_en text not null,
  label_es text not null,
  icon text not null default '',
  bucket text not null check (bucket in ('wear', 'skin', 'ai', 'util', 'xp', 'sol')),
  min_tier smallint not null references public.member_reward_tiers(tier),
  fulfillment text not null check (fulfillment in ('ship', 'instant', 'event')),
  active boolean not null default true,
  sort integer not null default 0
);

create table public.member_reward_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null references public.member_reward_items(key),
  status text not null check (status in ('claimed', 'granted', 'shipped', 'delivered', 'revoked')),
  source text not null check (source in ('member_claim', 'admin_grant')),
  granted_by uuid references auth.users(id) on delete set null,
  reason text check (reason is null or pg_catalog.char_length(reason) between 1 and 500),
  note text check (note is null or pg_catalog.char_length(note) <= 500),
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or pg_catalog.char_length(revoke_reason) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One LIVE grant per member+item; a revoke frees the item for re-claiming.
create unique index member_reward_grants_live_uniq on public.member_reward_grants (user_id, item_key) where status <> 'revoked';
create index member_reward_grants_user_idx on public.member_reward_grants (user_id, created_at desc);
create index member_reward_grants_status_idx on public.member_reward_grants (status, created_at desc);

-- Audit vocabulary (precedent: 20260724031000 added 'reset_mfa').
alter table public.member_admin_audit
  drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit
  add constraint member_admin_audit_action_check
  check (action in ('grant_role', 'revoke_role', 'create_event', 'update_event', 'reset_mfa',
                    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward'));

-- Caller tier from the paid ledger — the same math get_member_rewards_summary
-- uses, factored so claim and grant agree about what "unlocked" means.
create function private.member_tier_of(p_user uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select t.tier from public.member_reward_tiers t
    where t.min_points <= coalesce((select sum(e.points) from public.member_point_events e where e.user_id = p_user), 0)
    order by t.min_points desc limit 1), 1);
$$;
revoke all on function private.member_tier_of(uuid) from public, anon, authenticated;

create function public.claim_reward(p_item_key text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  item record;
  gid uuid;
begin
  -- Step-up: the definer bypasses the restrictive mfa_assurance policy, so
  -- this member write takes private.mfa_satisfied() directly (the
  -- send_member_message precedent).
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select key, min_tier, fulfillment into item
  from public.member_reward_items
  where key = p_item_key and active;
  if not found then
    raise exception 'reward not found' using errcode = '22023';
  end if;

  if private.member_tier_of(caller) < item.min_tier then
    raise exception 'tier not yet unlocked' using errcode = '22023';
  end if;

  insert into public.member_reward_grants (user_id, item_key, status, source, note)
  values (caller, item.key, 'claimed', 'member_claim', nullif(pg_catalog.btrim(coalesce(p_note, '')), ''))
  returning id into gid;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, 'claim_reward', caller, pg_catalog.jsonb_build_object('item', item.key, 'grantId', gid));

  return pg_catalog.jsonb_build_object('grantId', gid, 'status', 'claimed');
exception when unique_violation then
  -- The live-uniq index: one live grant per member+item.
  raise exception 'already claimed' using errcode = '22023';
end;
$$;

create function public.grant_reward(p_user_id uuid, p_item_key text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  item record;
  gid uuid;
  clean_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- "No silent grants, ever."
  if pg_catalog.char_length(clean_reason) not between 1 and 500 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  select key, min_tier into item
  from public.member_reward_items
  where key = p_item_key and active;
  if not found then
    raise exception 'reward not found' using errcode = '22023';
  end if;

  -- Design: even a manual grant is tier-verified.
  if private.member_tier_of(p_user_id) < item.min_tier then
    raise exception 'member has not unlocked this tier' using errcode = '22023';
  end if;

  insert into public.member_reward_grants (user_id, item_key, status, source, granted_by, reason)
  values (p_user_id, item.key, 'granted', 'admin_grant', caller, clean_reason)
  returning id into gid;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, 'grant_reward', p_user_id, pg_catalog.jsonb_build_object('item', item.key, 'grantId', gid, 'reason', clean_reason));

  return pg_catalog.jsonb_build_object('grantId', gid, 'status', 'granted');
exception when unique_violation then
  raise exception 'member already holds this reward' using errcode = '22023';
end;
$$;

create function public.revoke_reward(p_grant_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  g record;
  clean_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_reason) not between 1 and 500 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  select id, user_id, item_key, status into g
  from public.member_reward_grants
  where id = p_grant_id and status <> 'revoked'
  for update;
  if not found then
    raise exception 'grant not found' using errcode = '22023';
  end if;

  update public.member_reward_grants
  set status = 'revoked', revoked_by = caller, revoked_at = now(),
      revoke_reason = clean_reason, updated_at = now()
  where id = g.id;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, 'revoke_reward', g.user_id, pg_catalog.jsonb_build_object('item', g.item_key, 'grantId', g.id, 'reason', clean_reason));

  return pg_catalog.jsonb_build_object('grantId', g.id, 'status', 'revoked');
end;
$$;

create function public.fulfill_reward(p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  g record;
  nxt text;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select gr.id, gr.user_id, gr.item_key, gr.status, it.fulfillment into g
  from public.member_reward_grants gr
  join public.member_reward_items it on it.key = gr.item_key
  where gr.id = p_grant_id
  for update of gr;
  if not found then
    raise exception 'grant not found' using errcode = '22023';
  end if;

  nxt := case
    when g.fulfillment = 'ship' and g.status in ('claimed', 'granted') then 'shipped'
    when g.fulfillment = 'ship' and g.status = 'shipped' then 'delivered'
    when g.fulfillment in ('instant', 'event') and g.status in ('claimed', 'granted') then 'delivered'
    else null
  end;
  if nxt is null then
    raise exception 'grant is not advanceable' using errcode = '22023';
  end if;

  update public.member_reward_grants set status = nxt, updated_at = now() where id = g.id;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, 'fulfill_reward', g.user_id, pg_catalog.jsonb_build_object('item', g.item_key, 'grantId', g.id, 'to', nxt));

  return pg_catalog.jsonb_build_object('grantId', g.id, 'status', nxt);
end;
$$;

-- Admin queue with display names — the get_staff_roster idiom: raise on a
-- missing role so the client renders its explicit "unavailable" sentinel.
create function public.get_admin_reward_queue()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', g.id,
      'memberName', coalesce(p.full_name, 'Member'),
      'itemKey', g.item_key,
      'labelEn', it.label_en,
      'labelEs', it.label_es,
      'fulfillment', it.fulfillment,
      'status', g.status,
      'source', g.source,
      'reason', g.reason,
      'note', g.note,
      'createdAt', g.created_at) order by g.created_at desc)
    from (
      select * from public.member_reward_grants
      order by created_at desc
      limit 200
    ) g
    join public.member_reward_items it on it.key = g.item_key
    left join public.member_profiles p on p.id = g.user_id
  ), '[]'::jsonb);
end;
$$;

alter table public.member_reward_items enable row level security;
alter table public.member_reward_grants enable row level security;

create policy member_reward_items_select_active on public.member_reward_items
  for select to authenticated using (active or public.member_has_role(array['admin']));
create policy member_reward_grants_select_own on public.member_reward_grants
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.member_reward_items from anon, authenticated;
revoke all on public.member_reward_grants from anon, authenticated;
grant select on public.member_reward_items to authenticated;
grant select on public.member_reward_grants to authenticated;

revoke all on function public.claim_reward(text, text) from public, anon;
revoke all on function public.grant_reward(uuid, text, text) from public, anon;
revoke all on function public.revoke_reward(uuid, text) from public, anon;
revoke all on function public.fulfill_reward(uuid) from public, anon;
revoke all on function public.get_admin_reward_queue() from public, anon;
grant execute on function public.claim_reward(text, text) to authenticated;
grant execute on function public.grant_reward(uuid, text, text) to authenticated;
grant execute on function public.revoke_reward(uuid, text) to authenticated;
grant execute on function public.fulfill_reward(uuid) to authenticated;
grant execute on function public.get_admin_reward_queue() to authenticated;

-- Seed: the honest starter catalog (physical + event items only). Rows are
-- owner-tunable data, like member_point_rules — add, retire or re-tier items
-- without a deploy.
insert into public.member_reward_items (key, label_en, label_es, icon, bucket, min_tier, fulfillment, sort) values
  ('sg-thermos', 'Picket-Tested thermos', 'Termo probado en piquete', '☕', 'wear', 2, 'ship', 10),
  ('swag-line', 'Front of the swag line', 'Primero en la fila de swag', '🍕', 'util', 2, 'event', 20),
  ('minutes-name', 'Name in the Minutes', 'Tu nombre en el acta', '📜', 'xp', 3, 'event', 30),
  ('sg-hoodie', 'Union Ground hoodie', 'Sudadera Union Ground', '🧥', 'wear', 4, 'ship', 40);

notify pgrst, 'reload schema';
