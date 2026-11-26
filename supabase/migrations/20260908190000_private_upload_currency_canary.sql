begin;

-- --------------------------------------------------------------------------
-- The §6.4 database-currency canary.
--
-- docs/security/private-upload-activation-plan.md §6.4 names the quiet failure
-- this whole design has: `clean_until = least(now() + 24h,
-- signature_updated_at + 48h)`. If signature refresh stops, or the scanner
-- host's clock drifts, or the `clean_until` arithmetic is ever wrong, nothing
-- breaks loudly. The scanner stays up and answers every probe, while existing
-- clean verdicts expire one at a time and downloads start failing for files
-- that worked yesterday. A signature-age check on the scanner host cannot see
-- this: it is the scanner's own clock that is being trusted.
--
-- This function is the other side of that probe. It reads the ledger with no
-- caller involvement and answers one question: does a row that says it is
-- current — `status = 'clean'`, not deleted, `clean_until` still in the future
-- — actually satisfy `private.private_upload_is_current`? A `false` here is not
-- ordinary expiry; it means the predicate and the row disagree, which is
-- exactly the join, arithmetic or clock fault that has no other witness.
--
-- It is read-only, service-only, and returns no object name, no file id, no
-- path and no member-identifying value: a bucket id, three timestamps and two
-- counts. The caller (api/private-upload-currency-canary.js, a Vercel Cron tick
-- under the existing CRON_SECRET) compares the returned `now` against its own
-- clock, which is what makes the drift case visible from outside the host whose
-- clock is in question.
-- --------------------------------------------------------------------------
create function public.private_upload_currency_canary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  candidate private.private_upload_scans%rowtype;
  observed boolean;
  live_count bigint;
  expired_count bigint;
begin
  -- The ledger is service-owned. `security definer` would otherwise let any
  -- granted role read verdict provenance for objects it cannot see.
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'private upload currency canary is service-only' using errcode = '42501';
  end if;

  select
    count(*) filter (where scan.clean_until > pg_catalog.now()),
    count(*) filter (where scan.clean_until <= pg_catalog.now())
  into live_count, expired_count
  from private.private_upload_scans scan
  where scan.status = 'clean' and scan.deleted_at is null and scan.clean_until is not null;

  -- The row closest to expiry is the most informative canary: it is the one a
  -- `clean_until` arithmetic fault or a clock skew reaches first.
  select scan.* into candidate
  from private.private_upload_scans scan
  where scan.status = 'clean' and scan.deleted_at is null
    and scan.clean_until > pg_catalog.now()
  order by scan.clean_until asc
  limit 1;

  if not found then
    -- Absence is never a successful currency proof. The caller distinguishes
    -- an expired clean witness from unavailable coverage (including a new,
    -- empty database). Neither is reported green. This creates no fixtures.
    return pg_catalog.jsonb_build_object(
      'checked', false,
      'reason', 'no-current-clean-object',
      'liveCleanObjects', live_count,
      'expiredCleanObjects', expired_count,
      'now', pg_catalog.now()
    );
  end if;

  -- coalesce, not a bare call: an unknown answer is a failed assertion, never a
  -- silent pass.
  observed := coalesce(
    private.private_upload_is_current(candidate.bucket_id, candidate.object_name), false);

  return pg_catalog.jsonb_build_object(
    'checked', true,
    'current', observed,
    'bucketId', candidate.bucket_id,
    'cleanUntil', candidate.clean_until,
    'signatureUpdatedAt', candidate.signature_updated_at,
    'scannedAt', candidate.scanned_at,
    'liveCleanObjects', live_count,
    'expiredCleanObjects', expired_count,
    'now', pg_catalog.now()
  );
end;
$function$;

revoke all on function public.private_upload_currency_canary() from public, anon, authenticated, service_role;
grant execute on function public.private_upload_currency_canary() to service_role;

comment on function public.private_upload_currency_canary() is
  'Service-only read-only §6.4 canary: asserts that the clean ledger row closest to expiry still satisfies private.private_upload_is_current, and reports the database clock plus live/expired clean counts. Returns no object name, file id or path.';

commit;
