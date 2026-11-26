-- Union Ground organizing copy for text the database seeds or mints.
--
-- Earlier migrations seed user-facing text in older words and mint codes
-- with older initials. Those historical files stay as they shipped, and this
-- migration corrects the result here, after the 20261014 lane:
--
-- 1. Form templates. The platform group-issue template (alliance_grievance,
--    version 1, seeded by 20260723110000_form_templates_registry) labels its
--    roster field "Affected members"; the client catalogue
--    (forms.field.affected in src/lib/i18n.js) says "Affected workers".
--    Only that label changes: field keys, types and the version stay, so
--    existing submissions keep reading against the same schema.
-- 2. Guide suggested questions. 20261003054000_compass_role_suggested_questions
--    seeds the earlier role defaults (Weingarten, grievances, contract
--    articles, Loudermill, "my steward"). The platform definitions now carry
--    the web's role defaults verbatim (src/features/compass/suggestedQuestions.js,
--    which apps/mobile/src/lib/compassSuggestions.ts mirrors), and the admin
--    labels name the Guide. An organization's own saved list is untouched.
-- 3. Peer-contact codes. private.member_peer_contact_code minted
--    'UG-' || 20 hex. It now mints 'PSG-' || 20 hex, every stored digest is
--    recomputed from the new code, and request_reward_peer_contact accepts
--    only the new shape. A code is derived on read (get_reward_peer_contact),
--    never stored in plaintext, so no member holds a code that stops working
--    except one copied before this migration; no deployed database had
--    applied this lane, so none exists.
-- 4. MFA recovery codes. generate_mfa_recovery_codes issued
--    UG-XXXX-XXXX-XXXX-XXXX and claim_mfa_recovery_code accepted only that
--    shape. Both now use PSG-XXXX-XXXX-XXXX-XXXX (the hash input is
--    'PSG' || 16 hex). A set generated before this migration would no longer
--    redeem; no deployed database had applied this lane, so none was issued.
--    The 18-32 character client bound (src/components/MfaSettings.jsx,
--    apps/mobile/src/lib/mfaRecovery.ts) admits the 23-character code.
--
-- Function bodies below are the current definitions with only the prefix
-- changed; grants are restated exactly as they stood.

begin;

set local lock_timeout = '5s';

-- 1. Form template copy.
update public.form_templates
set field_schema = pg_catalog.replace(pg_catalog.replace(field_schema::text,
      '"en": "Affected members"', '"en": "Affected workers"'),
      '"es": "Miembros afectados"', '"es": "Trabajadores afectados"')::jsonb
where key = 'alliance_grievance'
  and version = 1
  and organization_id is null
  and field_schema::text like '%"Affected members"%';

-- 2. Guide suggested questions.
update public.platform_setting_definitions
set label = 'Guide suggested questions',
    description = 'Show suggested questions in the Guide for each role. Each question only fills the box; the person still sends it.'
where key = 'features.ai_assistant.suggested_questions';

update public.platform_setting_definitions
set label = 'Guide questions: workers',
    description = 'Suggested questions workers see in the Guide. Leave the defaults or write your own; at most 8.',
    default_value = '["What are my organizing rights if I''m called into a meeting with a manager?","How do I raise an issue?","What can we ask for in a first contract?","What should I do if I get a disciplinary notice?","How do I talk with coworkers about organizing?","How do I find my committee contact?"]'::jsonb
where key = 'lists.ai_assistant.suggested_questions_member';

update public.platform_setting_definitions
set label = 'Guide questions: committee',
    description = 'Suggested questions the committee, campaign leads and advisors see in the Guide while working as staff. At most 8.',
    default_value = '["How many issues are open and how many are resolved?","Show me worker stats by unit","Which issues come up most often?","How is org health trending across departments?","Walk me through the steps to file for a union election"]'::jsonb
where key = 'lists.ai_assistant.suggested_questions_steward';

update public.platform_setting_definitions
set label = 'Guide questions: admins',
    description = 'Suggested questions admins and campaign chairs see in the Guide while working as staff. At most 8.',
    default_value = '["How''s org health trending?","Show me engagement trends for the last 6 months","Which issues come up most across campaigns?","How many workers are in each unit?","How does the union election process work?"]'::jsonb
where key = 'lists.ai_assistant.suggested_questions_admin';

-- 3. Peer-contact codes.
create or replace function private.member_peer_contact_code(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select 'PSG-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(p_user_id::text, 'UTF8'), secret.secret, 'sha256'),
    'hex'), 1, 20))
  from private.member_peer_contact_secret secret
  where secret.id
$function$;

revoke all on function private.member_peer_contact_code(uuid) from public, anon, authenticated, service_role;

update public.member_peer_contact_keys k
set code_digest = extensions.digest(
  pg_catalog.convert_to(private.member_peer_contact_code(k.user_id), 'UTF8'),
  'sha256');

create or replace function public.request_reward_peer_contact(p_contact_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid(), (select k.user_id from public.member_peer_contact_keys k
    where private.mfa_satisfied() and k.code_digest = extensions.digest(pg_catalog.convert_to(
      pg_catalog.upper(pg_catalog.btrim(coalesce(p_contact_code, ''))), 'UTF8'), 'sha256'))], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  normalized_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_contact_code, '')));
  target uuid;
  target_chapter text;
  created_id uuid;
  created_at_value timestamptz;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- One caller lock makes the 24-hour limit exact even under two connections.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('peer-contact-caller:' || caller::text, 0));

  -- Every eligibility/code/scope/cooldown refusal is the same response and
  -- performs no write. In particular, an exact-code miss leaves no audit row
  -- containing the submitted plaintext or a derived identifier.
  if normalized_code !~ '^PSG-[0-9A-F]{20}$'
     or (not private.member_reward_effect_enabled(caller, 'im-anyone')
       and not private.member_peer_staff_eligible(caller, private.current_member_chapter()))
     or (select pg_catalog.count(*) from public.member_peer_contact_requests r
         where r.requester_id = caller and r.created_at >= now() - interval '24 hours') >= 3 then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  select k.user_id into target
  from public.member_peer_contact_keys k
  where k.code_digest = extensions.digest(
    pg_catalog.convert_to(normalized_code, 'UTF8'), 'sha256');

  if target is null or target = caller then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  -- Lock both exact profile rows in UUID order before deriving chapter scope.
  -- A concurrent member move/delete therefore completes first (and this call
  -- sees the new scope) or waits until this request decision commits.
  perform p.id
  from public.member_profiles p
  where p.id in (caller, target)
  order by p.id
  for share;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  select p.chapter_id into target_chapter
  from public.member_profiles p where p.id = target;

  if caller_chapter is null or target_chapter is distinct from caller_chapter
     or (not private.member_reward_effect_enabled(caller, 'im-anyone')
       and not (private.member_peer_staff_eligible(caller, caller_chapter)
         and private.member_peer_staff_eligible(target, caller_chapter))) then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'peer-contact-pair:' || least(caller, target)::text || ':' || greatest(caller, target)::text, 0));

  if exists (
    select 1 from public.member_peer_conversations c
    where c.user_low = least(caller, target) and c.user_high = greatest(caller, target)
  ) or exists (
    -- Pair requests are limited to one every 14 days in either direction.
    select 1 from public.member_peer_contact_requests r
    where least(r.requester_id, r.recipient_id) = least(caller, target)
      and greatest(r.requester_id, r.recipient_id) = greatest(caller, target)
      and r.created_at >= now() - interval '14 days'
  ) then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  insert into public.member_peer_contact_requests (requester_id, recipient_id, chapter_id, staff_authorized)
  values (caller, target, caller_chapter, not private.member_reward_effect_enabled(caller, 'im-anyone'))
  returning id, created_at into created_id, created_at_value;

  return pg_catalog.jsonb_build_object(
    'requested', true,
    'id', created_id,
    'status', 'pending',
    'createdAt', created_at_value);
end;
end;
$function$;

revoke all on function public.request_reward_peer_contact(text) from public, anon, authenticated, service_role;
grant execute on function public.request_reward_peer_contact(text) to authenticated;

-- 4. MFA recovery codes.
create or replace function public.generate_mfa_recovery_codes()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org_id uuid := private.current_member_organization();
  next_generation integer;
  plain text;
  compact text;
  codes text[] := array[]::text[];
  i integer;
begin
  if caller is null or coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' or not private.mfa_satisfied() then
    raise exception 'aal2 required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.mfa_factors f
    where f.user_id = caller and f.status = 'verified' and f.factor_type = 'totp'
  ) then raise exception 'verified authenticator required' using errcode = '42501'; end if;
  if org_id is not null and not coalesce((
    select coalesce((v.value #>> '{}')::boolean, (d.default_value #>> '{}')::boolean)
    from public.platform_setting_definitions d
    left join public.organization_setting_values v
      on v.organization_id = org_id and v.setting_key = d.key
    where d.key = 'features.mfa_recovery_code_enrollment'
  ), true) then
    raise exception 'recovery code enrollment disabled' using errcode = '42501';
  end if;

  insert into public.mfa_recovery_code_sets (user_id, organization_id)
  values (caller, org_id)
  on conflict (user_id) do update set
    organization_id = excluded.organization_id,
    generation = public.mfa_recovery_code_sets.generation + 1,
    failed_attempts = 0,
    locked_until = null,
    generated_at = pg_catalog.now();
  select generation into next_generation from public.mfa_recovery_code_sets where user_id = caller;
  delete from public.mfa_recovery_codes where user_id = caller;

  for i in 1..8 loop
    compact := pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'));
    plain := 'PSG-' || pg_catalog.substr(compact, 1, 4) || '-'
      || pg_catalog.substr(compact, 5, 4) || '-'
      || pg_catalog.substr(compact, 9, 4) || '-'
      || pg_catalog.substr(compact, 13, 4);
    insert into public.mfa_recovery_codes
      (user_id, organization_id, generation, code_prefix, code_hash)
    values (
      caller, org_id, next_generation, pg_catalog.substr(compact, 1, 8),
      extensions.crypt('PSG' || compact, extensions.gen_salt('bf', 12))
    );
    codes := pg_catalog.array_append(codes, plain);
  end loop;
  return pg_catalog.jsonb_build_object('codes', pg_catalog.to_jsonb(codes), 'generation', next_generation,
    'generatedAt', pg_catalog.now(), 'displayOnce', true);
end;
end;
$function$;

revoke all on function public.generate_mfa_recovery_codes() from public, anon, authenticated, service_role;
grant execute on function public.generate_mfa_recovery_codes() to authenticated;

create or replace function public.claim_mfa_recovery_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);

declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
  clean text := pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  prefix text;
  set_row public.mfa_recovery_code_sets%rowtype;
  code_row public.mfa_recovery_codes%rowtype;
  claim_token text;
  recovery_limit integer;
  recovery_lock_minutes integer;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || caller::text));
  current_session := private.current_member_session_id();
  -- Pin the proven Auth row through claim commit. If external revocation won
  -- the race after JWT verification, this lookup observes no row and refuses.
  perform 1
  from auth.sessions s
  where s.id = current_session
    and s.user_id = caller
  for key share;
  if not found then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  current_handle := private.member_session_handle(current_session);
  recovery_limit := private.organization_limit(private.current_member_organization(), 'limits.security.mfa_recovery_failures');
  recovery_lock_minutes := private.organization_limit(private.current_member_organization(), 'limits.security.mfa_recovery_lock_minutes');

  if clean !~ '^PSG[A-F0-9]{16}$' then
    raise exception 'recovery code not accepted' using errcode = '22023';
  end if;
  select * into set_row
  from public.mfa_recovery_code_sets
  where user_id = caller
  for update;
  if not found
     or (set_row.locked_until is not null and set_row.locked_until > pg_catalog.now()) then
    raise exception 'recovery code not accepted' using errcode = '22023';
  end if;

  prefix := pg_catalog.substr(clean, 4, 8);
  select * into code_row
  from public.mfa_recovery_codes
  where user_id = caller
    and generation = set_row.generation
    and code_prefix = prefix
    and used_at is null
    and (claim_expires_at is null or claim_expires_at <= pg_catalog.now())
  for update;
  if not found or extensions.crypt(clean, code_row.code_hash) <> code_row.code_hash then
    update public.mfa_recovery_code_sets
    set failed_attempts = case when failed_attempts >= recovery_limit - 1 then 0 else failed_attempts + 1 end,
        locked_until = case
          when failed_attempts >= recovery_limit - 1 then pg_catalog.now() + pg_catalog.make_interval(mins => recovery_lock_minutes)
          else null
        end
    where user_id = caller;
    return pg_catalog.jsonb_build_object('accepted', false);
  end if;

  claim_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  update public.mfa_recovery_codes
  set claimed_at = pg_catalog.now(),
      claim_expires_at = pg_catalog.now() + interval '2 minutes',
      claim_token_hash = pg_catalog.encode(
        extensions.digest(claim_token, 'sha256'), 'hex'),
      claim_session_handle = current_handle
  where id = code_row.id;
  update public.mfa_recovery_code_sets
  set failed_attempts = 0,
      locked_until = null
  where user_id = caller;

  return pg_catalog.jsonb_build_object(
    'claimToken', claim_token,
    'userId', caller,
    'sessionHandle', current_handle,
    'expiresIn', 120);
end;
end;
$function$;

revoke all on function public.claim_mfa_recovery_code(text) from public, anon, authenticated, service_role;
grant execute on function public.claim_mfa_recovery_code(text) to authenticated;

-- member_peer_contact_code is reachable from the reviewed account-lifecycle
-- trigger graph (member_profiles_peer_contact_key). Re-enroll only the
-- definition replaced here; unrelated review mismatches stay detectable.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name = 'private' and table_name = ''
  and object_name = 'member_peer_contact_code(p_user_id uuid)'
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

commit;
