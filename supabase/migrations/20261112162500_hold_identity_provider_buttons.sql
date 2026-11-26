-- REQ-UG-HOLD-APPLE-AND-GOOGLE-ENTRY-BUTTONS-20261112 (#8483).
--
-- Owner direction, November 12, 2026: the Apple and Google buttons come off
-- the sign-in screens now and return on their release day
-- (docs/contracts/staged-feature-releases.md). The calendar makes the two
-- providers one release and its date is not confirmed yet, so each key is held
-- with no date (infinity). A later calendar migration sets the date.
--
-- Data only. public.get_entry_screen_release_state() (20261112102500) then
-- answers apple false and google false, /api/auth-signin-options offers
-- neither, and the web sign-in card and the native sign-in screen draw nothing
-- for them. features.security.sso and every organization switch stay released.
--
-- The guard refuses a database where either definition row is missing or is
-- not a boolean, so this hold can never be recorded as applied while it holds
-- nothing.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $hold$
declare
  held integer;
begin
  update public.platform_setting_definitions
  set release_at = 'infinity'
  where key in ('features.identity_providers.apple', 'features.identity_providers.google')
    and value_kind = 'boolean';
  get diagnostics held = row_count;
  if held <> 2 then
    raise exception 'expected to hold 2 provider definitions, held %', held using errcode = '55000';
  end if;
end;
$hold$;

commit;
