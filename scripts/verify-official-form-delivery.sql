\set ON_ERROR_STOP on

-- UB-FORM-02 / UB-FORM-05 rollback-only adversarial proof. The migration,
-- objects, files, signatures, users, roles and audit state all disappear at
-- ROLLBACK, so the local database is unchanged after every run.
begin;
\ir ../supabase/migrations/20260812190000_official_form_delivery.sql
\ir ../supabase/migrations/20260812222529_form_filing_concurrency.sql

insert into auth.users (id, email) values
  ('f2010001-1111-4111-8111-111111111111', 'filer-proof@example.test'),
  ('f2020002-2222-4222-8222-222222222222', 'cosigner-proof@example.test'),
  ('f2030003-3333-4333-8333-333333333333', 'optional-proof@example.test'),
  ('f2040004-4444-4444-8444-444444444444', 'member-proof@example.test'),
  ('f2050005-5555-4555-8555-555555555555', 'steward-proof@example.test'),
  ('f2060006-6666-4666-8666-666666666666', 'cross-steward-proof@example.test');

update public.member_profiles p
set first_name = fixture.first_name, full_name = fixture.full_name,
    initials = fixture.initials, role_line = fixture.role_line,
    chapter_id = fixture.chapter_id, language = fixture.language
from (values
  ('f2010001-1111-4111-8111-111111111111'::uuid, 'Filer', 'Proof Filer', 'PF', 'Member', 'wor', 'en'),
  ('f2020002-2222-4222-8222-222222222222'::uuid, 'Cosigner', 'Proof Cosigner', 'PC', 'Member', 'wor', 'es'),
  ('f2030003-3333-4333-8333-333333333333'::uuid, 'Optional', 'Optional Signer', 'OS', 'Member', 'wor', 'en'),
  ('f2040004-4444-4444-8444-444444444444'::uuid, 'Member', 'Other Member', 'OM', 'Member', 'wor', 'en'),
  ('f2050005-5555-4555-8555-555555555555'::uuid, 'Steward', 'Proof Steward', 'PS', 'Steward', 'wor', 'en'),
  ('f2060006-6666-4666-8666-666666666666'::uuid, 'Cross', 'Cross Steward', 'CS', 'Steward', 'bos', 'en')
) as fixture(id, first_name, full_name, initials, role_line, chapter_id, language)
where p.id = fixture.id;

insert into public.member_roles (user_id, role, chapter_id) values
  ('f2050005-5555-4555-8555-555555555555', 'steward', 'wor'),
  ('f2060006-6666-4666-8666-666666666666', 'steward', 'bos');

insert into auth.mfa_factors
  (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values
  ('f2070007-7777-4777-8777-777777777777',
   'f2050005-5555-4555-8555-555555555555', 'proof factor', 'totp', 'verified', now(), now());

-- The filer creates an alliance grievance. An unsigned or malformed signature
-- cannot advance the row and another member cannot sign it.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2010001-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}', true);
select public.save_form_draft(
  'alliance_grievance',
  '{"summary":"Unsafe staffing","incident_date":"2026-08-11","narrative":"Two-person work assigned alone.","affected":["unit"],"remedy":"Restore safe staffing."}'::jsonb,
  4
) as form_id \gset
select set_config('proof.form_id', :'form_id', true);
do $$
begin
  perform public.submit_form(current_setting('proof.form_id')::uuid);
  raise exception 'unsigned form unexpectedly submitted';
exception when invalid_parameter_value then null;
end
$$;
do $$
begin
  perform public.sign_member_form(
    current_setting('proof.form_id')::uuid,
    '[[{"x":-1,"y":10},{"x":900,"y":900}]]'::jsonb, true);
  raise exception 'out-of-range signature unexpectedly stored';
exception when invalid_parameter_value then null;
end
$$;
select public.sign_member_form(
  :'form_id', '[[{"x":20,"y":100},{"x":500,"y":800},{"x":960,"y":120}]]'::jsonb, true);
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2040004-4444-4444-8444-444444444444","email":"member-proof@example.test","role":"authenticated","aal":"aal2"}', true);
do $$
begin
  perform public.sign_member_form(
    current_setting('proof.form_id')::uuid,
    '[[{"x":10,"y":10},{"x":900,"y":900}]]'::jsonb, true);
  raise exception 'cross-member signature unexpectedly stored';
exception when invalid_parameter_value then null;
end
$$;
reset role;

-- Registration invalidates the current filer signature. The Storage object is
-- inserted as a proof fixture (the production browser uploads through Storage
-- API), then only the owning caller can confirm it.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2010001-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}', true);
select public.register_member_form_file(
  :'form_id', 'staffing-note.pdf', 'application/pdf', 2048
)->>'id' as file_id,
public.register_member_form_file(
  :'form_id', 'photo.png', 'image/png', 4096
)->>'id' as photo_id \gset
reset role;

do $$
begin
  if exists (select 1 from private.member_form_signatures
             where form_id = current_setting('proof.form_id')::uuid) then
    raise exception 'attachment registration did not destroy prior signatures';
  end if;
end
$$;

insert into storage.objects (bucket_id, name, owner)
select ff.bucket_id, ff.object_name, ff.uploaded_by
from public.member_form_files ff
where ff.id in (:'file_id'::uuid, :'photo_id'::uuid);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2010001-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}', true);
select public.confirm_member_form_file(:'file_id');
select public.confirm_member_form_file(:'photo_id');
select public.sign_member_form(
  :'form_id', '[[{"x":25,"y":120},{"x":510,"y":790},{"x":950,"y":140}]]'::jsonb, true);
select public.invite_cosigner(:'form_id', 'cosigner-proof@example.test');
select public.invite_cosigner(:'form_id', 'optional-proof@example.test');
select public.submit_form(:'form_id');
reset role;

-- Only the invitation owner can accept. Acceptance requires that person's own
-- strokes and consent; the other optional invitation remains explicitly
-- unsigned and never blocks approval.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2040004-4444-4444-8444-444444444444","email":"member-proof@example.test","role":"authenticated","aal":"aal2"}', true);
do $$
begin
  perform public.respond_to_cosign(
    current_setting('proof.form_id')::uuid, true,
    '[[{"x":10,"y":10},{"x":900,"y":900}]]'::jsonb, true);
  raise exception 'uninvited member unexpectedly co-signed';
exception when invalid_parameter_value then null;
end
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2020002-2222-4222-8222-222222222222","email":"cosigner-proof@example.test","role":"authenticated","aal":"aal2"}', true);
do $$
begin
  perform public.respond_to_cosign(
    current_setting('proof.form_id')::uuid, true,
    '[[{"x":100,"y":100},{"x":900,"y":900}]]'::jsonb, false);
  raise exception 'co-signer accepted without consent';
exception when invalid_parameter_value then null;
end
$$;
select public.respond_to_cosign(
  :'form_id', true,
  '[[{"x":100,"y":100},{"x":300,"y":850},{"x":900,"y":220}]]'::jsonb, true);
reset role;

-- Every approve_form call below runs the August 12 approve_form(uuid, text)
-- this proof installs at its top, which takes no review expectation. They
-- prove those two migrations, not the current approval; the expectation the
-- website and the phone send (#8707, #8728) is proven by
-- tests/approve-form-expected-review-db.test.js.

-- Cross-chapter and under-assured stewards are refused before mutation.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2060006-6666-4666-8666-666666666666","role":"authenticated","aal":"aal2"}', true);
do $$
begin
  perform public.approve_form(current_setting('proof.form_id')::uuid, 'wrong scope');
  raise exception 'cross-chapter steward unexpectedly approved';
exception when invalid_parameter_value then null;
end
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2050005-5555-4555-8555-555555555555","role":"authenticated","aal":"aal1"}', true);
do $$
begin
  perform public.approve_form(current_setting('proof.form_id')::uuid, 'under assured');
  raise exception 'aal1 steward unexpectedly approved';
exception when insufficient_privilege then null;
end
$$;
reset role;

do $$
begin
  if (select status from public.member_forms
      where id = current_setting('proof.form_id')::uuid) <> 'submitted' then
    raise exception 'refused approval mutated the form';
  end if;
end
$$;

-- A stepped-up exact-scope steward freezes the digest and server attestation.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2050005-5555-4555-8555-555555555555","role":"authenticated","aal":"aal2"}', true);
select public.approve_form(:'form_id', 'Approved for official filing');
reset role;

do $$
begin
  if (select artifact_digest is null or artifact_approved_at is null
      from public.member_forms where id = current_setting('proof.form_id')::uuid) then
    raise exception 'approval did not freeze an artifact attestation';
  end if;
  if (select count(*) from public.member_form_cosigners
      where form_id = current_setting('proof.form_id')::uuid and status = 'invited') <> 1 then
    raise exception 'optional unsigned co-signer did not remain explicit';
  end if;
  begin
    update public.member_forms set answers = answers || '{"summary":"mutated"}'::jsonb
    where id = current_setting('proof.form_id')::uuid;
    raise exception 'approved answers unexpectedly changed';
  exception when invalid_parameter_value then null;
  end;
  begin
    update public.member_form_cosigners set status = 'declined'
    where form_id = current_setting('proof.form_id')::uuid;
    raise exception 'approved co-signer child unexpectedly changed';
  exception when invalid_parameter_value then null;
  end;
  begin
    update private.member_form_signatures set strokes = '[[{"x":1,"y":1},{"x":2,"y":2}]]'::jsonb
    where form_id = current_setting('proof.form_id')::uuid;
    raise exception 'approved signature child unexpectedly changed';
  exception when invalid_parameter_value then null;
  end;
  begin
    update public.member_form_files set filename = 'mutated.pdf'
    where form_id = current_setting('proof.form_id')::uuid;
    raise exception 'approved attachment metadata unexpectedly changed';
  exception when invalid_parameter_value then null;
  end;
end
$$;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2020002-2222-4222-8222-222222222222","email":"cosigner-proof@example.test","role":"authenticated","aal":"aal2"}', true);
do $$
begin
  perform public.withdraw_cosign(current_setting('proof.form_id')::uuid);
  raise exception 'approved co-signature unexpectedly withdrew';
exception when invalid_parameter_value then null;
end
$$;
reset role;

-- HUB-02-style account deletion detaches the accepted co-signer identity but
-- preserves the approved form's private evidence through the form/cosigner
-- retention boundary. The persistent cosigner row id remains the digest
-- subject, so the stored strokes can still be verified without an auth FK.
delete from auth.users
where id = 'f2020002-2222-4222-8222-222222222222'::uuid;
do $$
begin
  if not exists (
    select 1 from public.member_form_cosigners c
    join private.member_form_signatures s on s.cosigner_id = c.id
    where c.form_id = current_setting('proof.form_id')::uuid
      and c.invited_email = 'cosigner-proof@example.test'
      and c.status = 'accepted'
      and c.cosigner_user_id is null
      and s.signer_user_id is null
      and s.signature_digest = c.signature_digest
  ) then
    raise exception 'co-signer deletion removed or changed frozen signature evidence';
  end if;
end
$$;

-- Owner and scoped steward can authorize PDF output; an ordinary member and
-- cross-chapter steward cannot. Only service_role receives stored strokes.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2010001-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}', true);
do $$ begin
  if not public.can_access_form_filing(current_setting('proof.form_id')::uuid) then
    raise exception 'owner could not authorize approved filing';
  end if;
  begin
    perform public.get_form_filing_payload(
      current_setting('proof.form_id')::uuid,
      'f2010001-1111-4111-8111-111111111111'::uuid);
    raise exception 'authenticated caller read service payload';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2050005-5555-4555-8555-555555555555","role":"authenticated","aal":"aal2"}', true);
do $$ begin
  if not public.can_access_form_filing(current_setting('proof.form_id')::uuid) then
    raise exception 'same-chapter steward could not authorize approved filing';
  end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2040004-4444-4444-8444-444444444444","role":"authenticated","aal":"aal2"}', true);
do $$ begin
  if public.can_access_form_filing(current_setting('proof.form_id')::uuid) then
    raise exception 'ordinary member authorized another filing';
  end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2060006-6666-4666-8666-666666666666","role":"authenticated","aal":"aal2"}', true);
do $$ begin
  if public.can_access_form_filing(current_setting('proof.form_id')::uuid) then
    raise exception 'cross-chapter steward authorized the filing';
  end if;
end $$;
reset role;

set local role service_role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role","aal":"aal2"}', true);
do $$
declare payload jsonb;
begin
  payload := public.get_form_filing_payload(
    current_setting('proof.form_id')::uuid,
    'f2010001-1111-4111-8111-111111111111'::uuid);
  if payload #> '{filerSignature,strokes}' is null
     or pg_catalog.jsonb_array_length(payload -> 'attachments') <> 2
     or payload #>> '{approval,artifactDigest}' is null then
    raise exception 'owner-bound service payload omitted frozen filing content';
  end if;
  payload := public.get_form_filing_payload(
    current_setting('proof.form_id')::uuid,
    'f2050005-5555-4555-8555-555555555555'::uuid);
  if payload #>> '{approval,artifactDigest}' is null then
    raise exception 'same-chapter steward could not fetch bound payload';
  end if;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(payload -> 'cosigners') c
    where c ->> 'status' = 'accepted'
      and c -> 'strokes' is not null
      and c ->> 'signatureDigest' is not null
  ) then
    raise exception 'deleted co-signer evidence was missing from frozen payload';
  end if;
  begin
    perform public.get_form_filing_payload(
      current_setting('proof.form_id')::uuid,
      'f2040004-4444-4444-8444-444444444444'::uuid);
    raise exception 'ordinary user id fetched service payload';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_form_filing_payload(
      current_setting('proof.form_id')::uuid,
      'f2060006-6666-4666-8666-666666666666'::uuid);
    raise exception 'cross-chapter steward user id fetched service payload';
  exception when invalid_parameter_value then null;
  end;
end
$$;

do $$
begin
  perform public.get_form_filing_payload(
    current_setting('proof.form_id')::uuid,
    'f2040004-4444-4444-8444-444444444444'::uuid);
  raise exception 'service payload accepted an ordinary foreign member identity';
exception when invalid_parameter_value then null;
end
$$;

do $$
begin
  perform public.get_form_filing_payload(
    current_setting('proof.form_id')::uuid,
    'f2060006-6666-4666-8666-666666666666'::uuid);
  raise exception 'service payload accepted a cross-chapter steward identity';
exception when invalid_parameter_value then null;
end
$$;

delete from public.member_roles
where user_id = 'f2050005-5555-4555-8555-555555555555'::uuid
  and role = 'steward';
do $$
begin
  perform public.get_form_filing_payload(
    current_setting('proof.form_id')::uuid,
    'f2050005-5555-4555-8555-555555555555'::uuid);
  raise exception 'service payload ignored a steward role revocation';
exception when invalid_parameter_value then null;
end
$$;
insert into public.member_roles (user_id, role, chapter_id) values
  ('f2050005-5555-4555-8555-555555555555', 'steward', 'wor');
reset role;

-- Simulate the authorization/fetch race: the member-token authorization above
-- succeeded, but a live role deletion before the service fetch must fail.
delete from public.member_roles
where user_id = 'f2050005-5555-4555-8555-555555555555'::uuid
  and role = 'steward';
set local role service_role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role","aal":"aal2"}', true);
do $$ begin
  perform public.get_form_filing_payload(
    current_setting('proof.form_id')::uuid,
    'f2050005-5555-4555-8555-555555555555'::uuid);
  raise exception 'revoked steward fetched payload after preliminary authorization';
exception when invalid_parameter_value then null;
end $$;
reset role;
insert into public.member_roles (user_id, role, chapter_id) values
  ('f2050005-5555-4555-8555-555555555555', 'steward', 'wor');

-- A steward's own signed/submitted form cannot be self-approved.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2050005-5555-4555-8555-555555555555","role":"authenticated","aal":"aal2"}', true);
select public.save_form_draft(
  'service_request', '{"category":"other","description":"Self review proof"}'::jsonb, 2
) as self_form_id \gset
select set_config('proof.self_form_id', :'self_form_id', true);
select public.sign_member_form(
  :'self_form_id', '[[{"x":10,"y":20},{"x":900,"y":800}]]'::jsonb, true);
select public.submit_form(:'self_form_id');
do $$
begin
  perform public.approve_form(current_setting('proof.self_form_id')::uuid, null);
  raise exception 'steward unexpectedly self-approved';
exception when invalid_parameter_value then null;
end
$$;
reset role;

-- Answer edits also destroy strokes (separate from the attachment proof).
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f2040004-4444-4444-8444-444444444444","role":"authenticated","aal":"aal2"}', true);
select public.save_form_draft(
  'alt_work', '{"requested":"Hybrid","reason":"Care schedule"}'::jsonb, 2
) as edit_form_id \gset
select set_config('proof.edit_form_id', :'edit_form_id', true);
select public.sign_member_form(
  :'edit_form_id', '[[{"x":20,"y":20},{"x":880,"y":800}]]'::jsonb, true);
select public.save_form_draft(
  'alt_work', '{"requested":"Hybrid Fridays","reason":"Care schedule"}'::jsonb, 2);
reset role;

do $$
begin
  if exists (select 1 from private.member_form_signatures
             where form_id = current_setting('proof.edit_form_id')::uuid) then
    raise exception 'answer edit retained a stale signature';
  end if;
  if has_table_privilege('authenticated', 'private.member_form_signatures', 'select')
     or has_table_privilege('service_role', 'private.member_form_signatures', 'select')
     or has_table_privilege('authenticated', 'private.member_form_signatures', 'insert')
     or has_table_privilege('authenticated', 'public.member_form_files', 'insert')
     or has_table_privilege('authenticated', 'public.member_form_files', 'update')
     or has_table_privilege('authenticated', 'public.member_form_files', 'delete') then
    raise exception 'signature/file table grants widened beyond the RPC boundary';
  end if;
  if has_function_privilege('authenticated', 'public.get_form_filing_payload(uuid,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.get_form_filing_payload(uuid,uuid)', 'execute') then
    raise exception 'filing payload RPC grants are wrong';
  end if;
  if to_regprocedure('public.get_form_filing_payload(uuid)') is not null then
    raise exception 'unbound one-argument filing payload RPC still exists';
  end if;
  if to_regprocedure('public.respond_to_cosign(uuid,boolean)') is not null then
    raise exception 'unsigned two-argument co-sign RPC still exists';
  end if;
  if to_regprocedure('public.remove_member_form_file(uuid)') is not null
     or not has_function_privilege('authenticated', 'public.request_member_form_file_removal(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.finalize_member_form_file_removal(uuid)', 'execute') then
    raise exception 'attachment deletion RPC grants are wrong';
  end if;
end
$$;

\echo 'UB-FORM-02/05 rollback-only proof passed'
rollback;
