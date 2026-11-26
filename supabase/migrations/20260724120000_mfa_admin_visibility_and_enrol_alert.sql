-- REQ-UG-MFA-ADMIN-VISIBILITY + the notify half of REQ-UG-MFA-ENROL-REAUTH.
--
-- (1) Admins can finally answer "do our stewards have MFA on?". GoTrue owns
--     auth.mfa_factors and members self-enrol, so until now there was no
--     app-queryable record at all — the people holding the most sensitive
--     access were exactly the ones nobody could check. get_admin_mfa_status()
--     is the same shape as every other admin read: definer (authenticated
--     cannot select auth.mfa_factors — verified in 20260724030000), gated on
--     member_has_role(array['admin']) which since 20260724031000 also ANDs
--     the caller's own assurance level. Reads are not audited, consistent
--     with admin_search_members and get_admin_audit; the trail records
--     changes, and this changes nothing.
--
-- (2) Enrolment now leaves an in-app trace the member can see. GoTrue has no
--     reauthentication hook on factor enrolment, so someone holding a stolen
--     password can enrol THEIR OWN authenticator at aal1 and lock the real
--     member out of their own account (the admin reset in 20260724031000 is
--     the way back). What the app CAN do is make that move loud: a trigger on
--     auth.mfa_factors writes a member_notifications row the moment a factor
--     becomes verified, localized to the member's stored language. The row
--     uses kind='general', which the notification delivery pipeline
--     intentionally excludes from email/push.
--
--     The in-app row is behind the very assurance
--     boundary the thief just raised, so the locked-out victim reads it only
--     after an admin reset. This is not out-of-band confirmation. Closing
--     enrolment still needs a GoTrue-side reauth hook or a dedicated,
--     non-disableable provider security-change channel.
--
-- Inert on arrival: auth.mfa_factors holds zero rows live (re-verified at
-- apply time), so the trigger fires for nobody until a member enrols, and no
-- client calls the RPC until the bundle that renders it deploys. DB first,
-- client after — same rollout order as every prior PR.

-- Session-scoped, not SET LOCAL: the CLI applies each migration file outside an
-- explicit transaction, where SET LOCAL raises WARNING 25P01 and silently does
-- nothing. As written this guard never bounded a single lock wait.
set lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Admin visibility: per-staff-member MFA status + org-wide enrolment count.
-- ---------------------------------------------------------------------------
-- Staff scope = every distinct member_roles holder. Two facts per person:
-- does a verified TOTP factor exist (the only kind this client can challenge
-- — the assurance predicate is scoped the same way), and how many verified
-- factors exist that the app CANNOT challenge (a lockout signal: those are
-- invisible to the assurance predicate, and a member holding ONLY such a
-- factor enrolled it outside this app).
create function public.get_admin_mfa_status()
returns jsonb
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'staff', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', s.user_id,
        'fullName', s.full_name,
        'initials', s.initials,
        'roles', s.roles,
        'totpVerified', s.totp_verified,
        'verifiedAt', s.verified_at,
        'otherFactors', s.other_factors)
        -- Unprotected staff first: that is the row an admin opens this to find.
        order by s.totp_verified, s.full_name, s.user_id)
      from (
        select r.user_id,
               p.full_name,
               p.initials,
               coalesce((select pg_catalog.jsonb_agg(r2.role order by r2.role)
                           from public.member_roles r2
                          where r2.user_id = r.user_id), '[]'::jsonb) as roles,
               exists (select 1 from auth.mfa_factors f
                        where f.user_id = r.user_id
                          and f.status = 'verified'
                          and f.factor_type = 'totp') as totp_verified,
               (select pg_catalog.min(f.updated_at) from auth.mfa_factors f
                 where f.user_id = r.user_id
                   and f.status = 'verified'
                   and f.factor_type = 'totp') as verified_at,
               (select pg_catalog.count(*) from auth.mfa_factors f
                 where f.user_id = r.user_id
                   and f.status = 'verified'
                   and f.factor_type <> 'totp')::integer as other_factors
        from (select distinct user_id from public.member_roles) r
        join public.member_profiles p on p.id = r.user_id
      ) s
    ), '[]'::jsonb),
    -- The org-wide number is a count, not a list: admins get "how many members
    -- protected", never a browsable roster of who — that is more than this
    -- surface needs, and less to leak if an admin session is stolen.
    'enrolledMembers', (
      select pg_catalog.count(distinct f.user_id)
        from auth.mfa_factors f
       where f.status = 'verified'
         and f.factor_type = 'totp'));
end;
$$;

revoke all on function public.get_admin_mfa_status() from public, anon;
grant execute on function public.get_admin_mfa_status() to authenticated;

comment on function public.get_admin_mfa_status() is
  'Admin-gated MFA visibility: per-staff-member verified-TOTP status plus an '
  'org-wide enrolment count. Definer because authenticated cannot read '
  'auth.mfa_factors.';

-- ---------------------------------------------------------------------------
-- 2. In-app trace of every factor enrolment.
-- ---------------------------------------------------------------------------
-- Runs INSIDE GoTrue's own transaction, so the one inviolable rule is that it
-- must never make enrolment itself fail: everything is wrapped, and a failure
-- degrades to a warning in the database log rather than a 500 on the member's
-- verify call. SECURITY DEFINER because the trigger fires as
-- supabase_auth_admin, which holds no INSERT on public.member_notifications.
create function private.notify_mfa_enrolment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_lang text;
begin
  begin
    -- One warning per hour per member. The first row is the alert; N duplicates
    -- add nothing for the member and hand an attacker who already holds the
    -- account (password + their own factor at aal2) an unenroll -> re-enrol ->
    -- verify loop that buries the feed. The adversarial review put that loop on
    -- record; this closes it.
    if exists (
      select 1 from public.member_notifications n
       where n.user_id = new.user_id
         and n.title in ('Two-step sign-in was turned on',
                         'Se activó la verificación en dos pasos')
         and n.created_at > now() - interval '1 hour'
    ) then
      return null;
    end if;

    select coalesce(p.language, 'en') into member_lang
      from public.member_profiles p
     where p.id = new.user_id;
    if member_lang is null then
      member_lang := 'en';
    end if;

    if member_lang = 'es' then
      insert into public.member_notifications (user_id, title, body, kind)
      values (new.user_id,
              'Se activó la verificación en dos pasos',
              'Se agregó un autenticador a tu cuenta. Si no fuiste tú, contacta a tu oficina local de inmediato — un administrador puede quitarlo y cerrar las sesiones abiertas.',
              'general');
    else
      insert into public.member_notifications (user_id, title, body, kind)
      values (new.user_id,
              'Two-step sign-in was turned on',
              'An authenticator was added to your account. If this was not you, contact your local office immediately — an admin can remove it and sign out any open sessions.',
              'general');
    end if;
  exception when others then
    raise warning 'mfa enrolment notification failed for %: %', new.user_id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.notify_mfa_enrolment() from public, anon, authenticated;

-- TOTP enrols unverified and flips to verified when the member proves the
-- code — that is the UPDATE trigger, and IS DISTINCT FROM keeps re-saves of
-- an already-verified row silent. The INSERT trigger covers any factor type
-- GoTrue ever creates pre-verified, so a future flow cannot slip in unheard.
drop trigger if exists mfa_factor_verified_notify_insert on auth.mfa_factors;
create trigger mfa_factor_verified_notify_insert
  after insert on auth.mfa_factors
  for each row
  when (new.status = 'verified')
  execute function private.notify_mfa_enrolment();

drop trigger if exists mfa_factor_verified_notify_update on auth.mfa_factors;
create trigger mfa_factor_verified_notify_update
  after update on auth.mfa_factors
  for each row
  when (old.status is distinct from new.status and new.status = 'verified')
  execute function private.notify_mfa_enrolment();

notify pgrst, 'reload schema';
