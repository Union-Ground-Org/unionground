-- SEC-UG-MOBILE-PUSH-TOKEN-LIFECYCLE-20260814: the reviewed database half
-- of the SAMPLE notification dispatch-URL operation that activation step 7 of
-- docs/mobile/native-push-operations.md calls for.
--
-- Until now the repository held no reviewed operation for the notifications
-- plane: 20260723204000_notification_dispatch_cron.sql deliberately leaves
-- private.notification_controls.dispatch_url NULL and the five-minute tick
-- inert, and the only configuration RPC in the tree
-- (public.configure_integration_webhook_dispatch) points the *integration*
-- webhook dispatcher at a different path with a differently named Vault
-- secret. Setting the notifications URL by hand was therefore an improvised
-- query, which is exactly what step 7 refuses to accept.
--
-- The protected installation binding must identify this live cluster and
-- database as SAMPLE before any mutation. Pinning a destination URL alone does
-- not establish the source database's identity. Migrations leave the binding
-- empty; only an out-of-band administrator may establish it on verified SAMPLE.
--
-- Three things it deliberately does NOT do:
--   * it never touches private.notification_controls.outbound_enabled — that
--     is the owner's bounded-window control and a separate authorization;
--   * it never reads or copies an existing secret, so it cannot move the
--     production Vault value onto SAMPLE;
--   * it returns no secret material, only the configured URL and the Vault
--     name, so a caller's receipt can be kept verbatim.
--
-- Fresh-secret rule: every call replaces the Vault secret under the single
-- name the tick reads. The delete-then-create pair is what makes a second
-- activation attempt replace rather than silently keep the previous value.
-- The CLI generates a new bearer by default; supplied values must be fresh.
-- Step 7 supplies the fresh step-4 deployment copy after step 5 deploys it;
-- while the two differ the tick receives 401 and nothing is delivered.
begin;

create function public.configure_notification_dispatch(p_dispatch_url text, p_dispatch_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_url text := pg_catalog.rtrim(coalesce(p_dispatch_url, ''), '/');
  live_system_identifier numeric;
  live_database_oid oid;
  reconcile_url text;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'notification dispatch RPC requires service_role' using errcode = '42501';
  end if;
  select control.system_identifier::numeric into live_system_identifier
  from pg_catalog.pg_control_system() as control;
  select database.oid into live_database_oid
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();
  if not exists (
    select 1 from private.demo_seed_installation_bindings as binding
    where binding.project_ref = 'sampledemoprojectref'
      and binding.system_identifier = live_system_identifier
      and binding.database_oid = live_database_oid
  ) then
    raise exception 'notification dispatch database identity is not bound to SAMPLE' using errcode = '42501';
  end if;
  if normalized_url <> 'https://demo.example.com/api/notifications-dispatch' then
    raise exception 'invalid dispatch url' using errcode = '22023';
  end if;
  -- Same window the deployed dispatcher enforces on
  -- SAMPLE_NOTIFICATION_DISPATCH_SECRET, so a value the endpoint would refuse
  -- can never reach the Vault.
  if pg_catalog.char_length(coalesce(p_dispatch_secret, '')) not between 32 and 512
     or p_dispatch_secret ~ '[[:cntrl:]]' then
    raise exception 'invalid dispatch secret' using errcode = '22023';
  end if;
  -- The task-files tick also reads this Vault name, but its endpoint accepts
  -- only CRON_SECRET. A dedicated notification bearer would break that tick.
  -- Lock the control row through commit so a concurrent URL update cannot
  -- invalidate this precondition while the secret is replaced.
  select controls.files_reconcile_url into reconcile_url
  from private.notification_controls as controls
  where controls.id
  for update;
  if reconcile_url is not null then
    raise exception 'notification dispatch requires files_reconcile_url to be null; task-files reconciliation shares this Vault bearer but requires CRON_SECRET' using errcode = '22023';
  end if;
  delete from vault.secrets where name = 'notifications-dispatch-secret';
  perform vault.create_secret(
    p_dispatch_secret,
    'notifications-dispatch-secret',
    'Bearer secret the database notification dispatch tick sends to the selected dispatcher'
  );
  -- Idempotent by construction: the control plane is a single row, so
  -- re-running with the same URL updates it in place and adds nothing.
  update private.notification_controls
  set dispatch_url = normalized_url, updated_at = pg_catalog.now()
  where id;
  return pg_catalog.jsonb_build_object(
    'configured', true,
    'dispatchUrl', normalized_url,
    'vaultSecretName', 'notifications-dispatch-secret'
  );
end;
$function$;

revoke all on function public.configure_notification_dispatch(text, text) from public, anon, authenticated, service_role;
grant execute on function public.configure_notification_dispatch(text, text) to service_role;

notify pgrst, 'reload schema';

commit;
