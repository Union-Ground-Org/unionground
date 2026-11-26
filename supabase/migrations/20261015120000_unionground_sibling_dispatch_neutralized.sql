-- Union Ground: no migration-installed path may wire this database to hosts
-- of a deployment it does not own (owner decision, 2026-10-15).
--
-- Audit of every migration for live effects that would reach an outside
-- deployment if these migrations ran against a real Union Ground project:
--
--   * pg_cron. Every scheduled job runs a local SQL function, except three
--     pg_net ticks (notifications-dispatch-tick, integration-webhooks-
--     dispatch-tick, task-files-reconcile-tick). Those read their endpoint
--     from private.notification_controls.dispatch_url / files_reconcile_url
--     and private.integration_webhook_dispatch_controls.dispatch_url, which
--     migrations create NULL, and send nothing while the URL is NULL. They
--     name no host, so they stay scheduled for the deployment's own
--     dispatcher once one is provisioned.
--   * Configuration RPCs. Two service-role setup functions accept exactly one
--     destination, a fixed outside dispatcher, then store a Vault
--     bearer and write that URL into the control row the tick reads:
--       - public.configure_integration_webhook_dispatch(text, text)
--         (20260826152000), with no other precondition;
--       - public.configure_notification_dispatch(text, text)
--         (20261009220000), behind a fixed installation binding.
--     Run against a Union Ground project, either one would point a
--     five-minute tick, with a bearer secret, at that outside host. Both now
--     refuse before any Vault or control-row write, keeping their signatures
--     and service-role-only grants so callers get a named refusal.
--   * Vault. The only migration-time secret is the project-local random HMAC
--     key for public-interest suppression (20260831105356); it names nothing.
--   * Database settings, webhooks. No migration runs ALTER DATABASE/ROLE ...
--     SET, creates a supabase_functions webhook, or calls net.http_* outside
--     the three ticks above.
--   * Inert strings, left in place: target-ref guards that compare an argument
--     with a fixed outside project ref (demo seed, stress, residue), the
--     Constant Contact OAuth redirect allowlist (it can only refuse a
--     Union Ground host), and dues checkout URLs (dues are left out and
--     have no API route here). None of them calls out.
--
-- The control rows are also cleared, so a database that ever ran either
-- setup function stops dispatching at the next tick.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.configure_integration_webhook_dispatch(p_dispatch_url text, p_cron_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'integration webhook dispatch has no Union Ground endpoint to configure'
    using errcode = '55000';
end;
$function$;

revoke all on function public.configure_integration_webhook_dispatch(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_integration_webhook_dispatch(text, text) to service_role;

create or replace function public.configure_notification_dispatch(p_dispatch_url text, p_dispatch_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'notification dispatch has no Union Ground endpoint to configure'
    using errcode = '55000';
end;
$function$;

revoke all on function public.configure_notification_dispatch(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_notification_dispatch(text, text) to service_role;

update private.integration_webhook_dispatch_controls
set dispatch_url = null
where id and dispatch_url is not null;

update private.notification_controls
set dispatch_url = null, files_reconcile_url = null, updated_at = pg_catalog.now()
where id and (dispatch_url is not null or files_reconcile_url is not null);

notify pgrst, 'reload schema';
commit;
