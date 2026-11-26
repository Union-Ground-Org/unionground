begin;

-- Two write-path narrowings for the private upload ledger.
--
-- 1. `public.record_private_upload_scan` is dropped. It was a second, parallel
--    way to write a verdict: path-addressed, reachable by anything holding the
--    service-role key, and skipping the lease, quota and authorization that
--    `authorize_private_upload_inspection` /
--    `finish_private_upload_inspection` exist to impose. The scanner never
--    needed it — `finish_private_upload_inspection` is SECURITY DEFINER and
--    reaches the private implementation directly, binding every verdict to an
--    unexpired attempt it did not choose. Leaving a path-addressed verdict
--    write in place would mean the only thing standing between a leaked
--    service-role key and a forged `clean` attestation was the fact that
--    nothing currently calls it.
--
--    `private.record_private_upload_scan` itself is unchanged: EXECUTE is
--    granted to service_role and the default PUBLIC EXECUTE is revoked, and
--    that grant is the WHOLE of the control. Do not read schema isolation into
--    it: `authenticated` does hold USAGE on schema private (it has for some
--    time, because the mfa_assurance restrictive policy calls
--    private.mfa_satisfied() as the invoking role — see schemaUsage in
--    scripts/db-contract.json), so the EXECUTE grant is the only thing standing
--    between a client role and this function. Do not relax it. Its one
--    remaining caller is the attempt-bound completion RPC.
--
-- 2. `image/heic` leaves the four private buckets' allowed MIME types. The
--    inspector rejects HEIC and always will (there is no bounded decoder for
--    it here), so every accepted HEIC upload became an object that could never
--    earn a clean verdict: unreachable to its owner, undeletable by the
--    quarantine read policy, and costing one of the actor's twenty hourly
--    inspections on every retry. Refusing the bytes at the bucket boundary is
--    the honest answer. Clients convert to JPEG before uploading (native
--    re-encodes; web converts or explains), which is a UX cost taken
--    deliberately in exchange for never storing a permanently quarantined
--    object. Recorded as decision E2 of the upload-security design.
--
-- Forward-only. Neither statement rewrites data; the bucket update changes an
-- allowlist that Storage consults on the next upload.

drop function if exists public.record_private_upload_scan(text, text, uuid, text, text, text,
  text, bigint, timestamp with time zone, timestamp with time zone);

update storage.buckets set allowed_mime_types = array[
    'application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
where id in ('case-files','chapter-task-files','member-form-files','organization-knowledge');

notify pgrst, 'reload schema';
commit;
