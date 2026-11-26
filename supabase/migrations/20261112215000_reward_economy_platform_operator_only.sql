-- SEC-UG-REWARD-ECONOMY-EDITABLE-ACROSS-ORGANIZATIONS-20261111 (#8307):
-- containment. The reward economy (public.member_point_rules,
-- public.member_reward_tiers, public.member_reward_items and their revision log)
-- is one shared set of rows with no organization column, so an admin of any
-- organization could change what every organization's members earn and get,
-- and read every other organization's admins' changes.
--
-- Until each organization has its own rows (#8388), only the platform
-- operator changes the shared economy: an MFA-assured admin of the platform
-- organization (organizations.kind = 'platform') selected as their current
-- organization. public.save_reward_point_rule, public.save_reward_tier and
-- public.save_reward_item pass through private.assert_reward_economy_admin(),
-- so tightening that one guard contains every write without re-emitting them.
--
-- public.get_admin_reward_economy() keeps serving every MFA-assured admin, now
-- through private.assert_reward_economy_reader(): it also carries the admin's
-- own organization's form template amounts. It says whether the caller may
-- change the shared rows (sharedEditable), and returns the change log, with
-- its actor ids and before and after values, only to the platform operator.
-- The direct-read policy and the client SELECT grant on the change log are
-- dropped, so the log has no other client path. Members still read the rules,
-- tiers and active items as before.

begin;

create function private.reward_economy_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and private.mfa_satisfied()
    and private.organization_is_platform(private.current_member_organization())
    and private.has_organization_role(private.current_member_organization(), array['admin']);
$function$;
revoke all on function private.reward_economy_operator() from public, anon, authenticated, service_role;

create or replace function private.assert_reward_economy_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.mfa_satisfied() or not private.reward_economy_operator() then
    raise exception 'platform operator required: the reward economy is shared by every organization'
      using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.assert_reward_economy_admin() from public, anon, authenticated, service_role;

-- The reader's gate, the economy's former admin check unchanged.
create function private.assert_reward_economy_reader()
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
revoke all on function private.assert_reward_economy_reader() from public, anon, authenticated, service_role;

create or replace function public.get_admin_reward_economy()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  operator boolean;
begin
  perform private.assert_reward_economy_reader();
  operator := private.reward_economy_operator();
  return pg_catalog.jsonb_build_object(
    'sharedEditable', operator,
    'rules', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.action_kind) from public.member_point_rules r), '[]'::jsonb),
    'tiers', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.tier) from public.member_reward_tiers t), '[]'::jsonb),
    'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) order by i.sort, i.key) from public.member_reward_items i), '[]'::jsonb),
    'formTemplatePoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', f.key, 'version', f.version, 'labelEn', f.label_en, 'labelEs', f.label_es, 'points', f.points) order by f.sort, f.key)
      from (select distinct on (key) key, version, label_en, label_es, points, sort from public.form_templates where is_platform_seed or organization_id=(select private.current_member_organization()) order by key, (organization_id is not null) desc, version desc) f
    ), '[]'::jsonb),
    -- The shared change log names other organizations' admins and their
    -- before and after values: the platform operator only.
    'revisions', case when operator then coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc, x.id desc)
      from (select * from public.member_reward_economy_revisions order by created_at desc, id desc limit 50) x), '[]'::jsonb)
      else '[]'::jsonb end
  );
end;
$function$;

drop policy member_reward_economy_revisions_admin_read on public.member_reward_economy_revisions;
revoke select on public.member_reward_economy_revisions from authenticated;

notify pgrst, 'reload schema';

commit;
