-- REQ-UG-FULL-DEPTH-20260723 PR5: validate the two deferred constraints.
--
-- 20260723200500 and 20260723201000 add their CHECKs NOT VALID so that neither
-- one holds a heavy lock while scanning a populated table. NOT VALID already
-- enforces both constraints on every new and updated row; what it skips is the
-- proof that the rows that existed BEFOREHAND conform. This file supplies that
-- proof, and it has to be executable rather than a comment: a validation step
-- that lives only in an apply runbook is a validation step that eventually does
-- not happen, and `convalidated = false` is exactly what the post-apply
-- verifier reports as FAIL.
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, which does not block
-- SELECT, INSERT, UPDATE or DELETE. It does conflict with other schema changes,
-- hence the lock_timeout: if a migration or an autovacuum-driven operation is
-- holding the table, fail fast and let the operator re-run rather than sit in a
-- lock queue in front of application traffic.
--
-- Replay-safe: validating an already-validated constraint is a no-op, and the
-- guards skip cleanly if a constraint is absent.

-- Session-scoped, not SET LOCAL: the CLI applies each migration file outside an
-- explicit transaction, where SET LOCAL raises WARNING 25P01 and silently does
-- nothing. As written this guard never bounded a single lock wait.
set lock_timeout = '5s';

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.member_notifications'::regclass
      and conname = 'member_notifications_kind_check'
      and not convalidated
  ) then
    -- Scans ~300k rows comparing one text column against a six-value list.
    alter table public.member_notifications
      validate constraint member_notifications_kind_check;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.member_profiles'::regclass
      and conname = 'member_profiles_notification_prefs_boolean'
      and not convalidated
  ) then
    -- Scans ~100k rows calling an IMMUTABLE helper per row.
    alter table public.member_profiles
      validate constraint member_profiles_notification_prefs_boolean;
  end if;
end
$$;

-- Fail loudly rather than leave a half-validated schema looking applied.
do $$
declare
  unvalidated integer;
begin
  select pg_catalog.count(*) into unvalidated
  from pg_constraint
  where conname in (
      'member_notifications_kind_check',
      'member_profiles_notification_prefs_boolean')
    and not convalidated;
  if unvalidated > 0 then
    raise exception 'PR5: % notification constraint(s) still NOT VALID after validation', unvalidated;
  end if;
end
$$;
