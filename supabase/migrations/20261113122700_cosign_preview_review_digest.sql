-- BUG-UG-COSIGNER-SIGNATURE-COVERS-CONTENT-THE-PREVIEW-NEVER-SHOWED-20261114 (#8703).
-- A co-signature covers the form exactly as it stood when the invitation
-- preview was shown.
--
-- An invited co-signer decides from public.cosign_invite_preview (the template,
-- the filer's name and the first 500 characters of the summary; owner design
-- D2 of the co-signers spec keeps the rest of the grievance from anyone who has
-- not accepted). public.respond_to_cosign then took the form lock and signed
-- private.form_content_digest of the row as it stood, so a save by the filer
-- between the preview and the accept was co-signed without the co-signer ever
-- having been shown that version. Accepted co-signers are reset to
-- reaffirm_needed by a later save, but an invited co-signer who accepts after
-- the save was not. Twin of #8702 (the filer's signature, 20261113114500).
--
-- What a co-signer may read and what a stored co-signature covers do not
-- change: the co-signature still stores the full content digest that approval
-- and filing check. What changes is that the accept can name the version it
-- was shown:
--   cosign_invite_preview returns reviewDigest, an HMAC-SHA256 over the
--   invitation id and the form's full content digest, keyed with one random
--   key held in private.cosign_review_digest_key that no client role can read.
--   Without the key nobody can recompute it, so an invited co-signer cannot
--   test guessed answers against it (it is not an oracle), and binding the
--   invitation id means one invitation's value says nothing about another's.
--   respond_to_cosign takes an optional p_expected_digest. On an accept, under
--   the form lock and after the invitation is found, the value is recomputed
--   from the row as it stands; a difference refuses with PT409 and DETAIL
--   cosign_changed_since_preview (HTTP 409, never retried by PostgREST;
--   20261106220000) and nothing is stored. A decline ignores it.
--
-- p_expected_digest null keeps the previous behaviour, so clients that do not
-- send it yet (the store builds) keep working; PostgREST resolves their four
-- or five named arguments to the new function through the defaults.
--
-- Everything else is the live definition from 20261113120500 unchanged:
-- respond_to_cosign keeps the optional typed name (#8701) and its checks, the
-- lock_case_graph entry 20260907151000 wrapped around it, the MFA guard,
-- consent and stroke checks, the form lock before the invitation read, the
-- signature row, the notice and its grants (authenticated and service_role).
-- cosign_invite_preview keeps the PIN full-session guard 20261003040000 added,
-- the MFA guard before every read and its grant (authenticated). Neither is on
-- the account-lifecycle trigger surface.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.respond_to_cosign(uuid,boolean,jsonb,boolean,text)'::regprocedure)) <> '8d307028eea72c9b2c57782b8b2b72fe' then
    raise exception 'unreviewed predecessor: public.respond_to_cosign(uuid,boolean,jsonb,boolean,text)' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.cosign_invite_preview(uuid)'::regprocedure)) <> '860fab02f62191884661b0f8f2b336e2' then
    raise exception 'unreviewed predecessor: public.cosign_invite_preview(uuid)' using errcode = '55000';
  end if;
end;
$preflight$;

-- One key for every review digest. No client role can read it.
create table private.cosign_review_digest_key (
  singleton boolean primary key default true check (singleton),
  key bytea not null check (pg_catalog.octet_length(key) = 32),
  created_at timestamptz not null default pg_catalog.now()
);
revoke all on private.cosign_review_digest_key from public, anon, authenticated, service_role;
insert into private.cosign_review_digest_key (singleton, key)
values (true, extensions.gen_random_bytes(32));

-- The value a co-signer's preview shows and the accept sends back: HMAC-SHA256
-- over the invitation id and the form's full content digest. Not a client RPC.
create function private.cosign_review_digest(p_cosigner_id uuid, p_content_digest text)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select pg_catalog.encode(extensions.hmac(
    pg_catalog.convert_to('cosign-review:' || p_cosigner_id::pg_catalog.text || ':' || coalesce(p_content_digest, ''), 'UTF8'),
    k.key, 'sha256'), 'hex')
    from private.cosign_review_digest_key k
   where k.singleton
$fn$;
revoke all on function private.cosign_review_digest(uuid, text) from public, anon, authenticated, service_role;

create or replace function public.cosign_invite_preview(p_form_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  inv record;
  frec record;
  filer_name text;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): pre-accept disclosure of filer name + summary; the guard precedes every read.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select id, status into inv
    from public.member_form_cosigners
    where form_id = p_form_id
      and status in ('invited','reaffirm_needed','accepted')
      and (cosigner_user_id = caller or (caller_email <> '' and invited_email = caller_email))
    order by invited_at desc limit 1;
  if inv.id is null then
    raise exception 'no co-sign invitation for you on this form' using errcode='22023';
  end if;

  -- One statement, one snapshot (#8703): the review digest is taken with the
  -- answers the summary comes from, so a save committed while the preview
  -- runs can never pair this summary with a later version's digest.
  -- form_content_digest is STABLE and so reads with this statement's snapshot.
  select f.user_id, f.template_key, f.answers,
         private.form_content_digest(f.id) as content_digest
    into frec
    from public.member_forms f where f.id = p_form_id;
  select full_name into filer_name from public.member_profiles where id = frec.user_id;

  -- reviewDigest (#8703): names the version this preview was taken from (read
  -- above with the answers), keyed so it cannot be recomputed from guessed
  -- answers; respond_to_cosign compares it under the form lock.
  return pg_catalog.jsonb_build_object(
    'formId', p_form_id,
    'template', frec.template_key,
    'inviteStatus', inv.status,
    'summary', pg_catalog.left(coalesce(frec.answers->>'summary',''), 500),
    'filerName', coalesce(nullif(pg_catalog.btrim(coalesce(filer_name,'')),''), 'A member'),
    'reviewDigest', private.cosign_review_digest(inv.id, frec.content_digest)
  );
end;
end;
$function$;

drop function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text);

create function public.respond_to_cosign(
  p_form_id uuid, p_accept boolean, p_strokes jsonb, p_consent boolean,
  p_typed_name text default null, p_expected_digest text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  inv record;
  new_status text;
  current_digest text;
  signed_time timestamptz;
  signed_digest text;
  signed_kind text := 'drawn';
  signed_name text;
  material jsonb := p_strokes;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_accept and p_consent is distinct from true then
    raise exception 'signature consent required' using errcode = '22023';
  end if;
  if p_accept then
    if p_typed_name is null then
      perform private.validate_form_signature_strokes(p_strokes);
    elsif p_strokes is not null then
      raise exception 'sign by drawing or by typing your name, not both' using errcode = '22023';
    else
      signed_name := private.normalize_form_typed_signature(p_typed_name);
      signed_kind := 'typed';
      material := pg_catalog.jsonb_build_object('kind', 'typed', 'name', signed_name);
    end if;
  end if;

  perform private.lock_member_form(p_form_id);
  select c.*, f.status as form_status into inv
    from public.member_form_cosigners c
    join public.member_forms f on f.id = c.form_id
    where c.form_id = p_form_id
      and f.status <> 'approved'
      and c.status in ('invited', 'reaffirm_needed')
      and (c.cosigner_user_id = caller
        or (caller_email <> '' and c.invited_email = caller_email))
    order by c.invited_at desc for update of c limit 1;
  if inv.id is null then
    raise exception 'no pending co-sign invitation for you on this form' using errcode = '22023';
  end if;

  new_status := case when p_accept then 'accepted' else 'declined' end;
  if p_accept then
    current_digest := private.form_content_digest(p_form_id);
    -- The version the co-signer's preview was taken from (#8703), compared
    -- under the form lock before anything is stored.
    if p_expected_digest is not null
       and p_expected_digest is distinct from private.cosign_review_digest(inv.id, current_digest) then
      raise exception 'form changed since the co-sign preview' using errcode = 'PT409',
        detail = 'cosign_changed_since_preview';
    end if;
    signed_time := now();
    signed_digest := private.form_signature_digest(current_digest, inv.id, material);
    insert into private.member_form_signatures (
      form_id, signer_kind, signer_user_id, cosigner_id, strokes, signature_kind,
      typed_name, content_digest, signature_digest, consented_at
    ) values (
      p_form_id, 'cosigner', caller, inv.id, material, signed_kind,
      signed_name, current_digest, signed_digest, signed_time
    )
    on conflict (form_id, signer_kind, signer_user_id) do update set
      cosigner_id = excluded.cosigner_id, strokes = excluded.strokes,
      signature_kind = excluded.signature_kind, typed_name = excluded.typed_name,
      content_digest = excluded.content_digest,
      signature_digest = excluded.signature_digest,
      consented_at = excluded.consented_at, created_at = now();
  else
    delete from private.member_form_signatures
      where form_id = p_form_id and signer_kind = 'cosigner' and signer_user_id = caller;
  end if;
  update public.member_form_cosigners
    set status = new_status,
        cosigner_user_id = case when p_accept then caller else cosigner_user_id end,
        responded_at = now(), signed_at = signed_time, signature_digest = signed_digest
    where id = inv.id;
  if p_accept then
    perform private.notify_member(inv.invited_by, 'cosign.accepted', '{}'::jsonb, 'forms');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', new_status, 'signedAt', signed_time,
    'signatureKind', case when p_accept then signed_kind end,
    'signatureDigest', signed_digest);
end;
end;
$$;

revoke all on function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text, text) from public, anon;
grant execute on function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text, text) to authenticated, service_role;

comment on function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text, text) is 'Co-signer accept or decline. p_expected_digest (optional) is the reviewDigest cosign_invite_preview returned; on an accept a difference under the form lock refuses with PT409 cosign_changed_since_preview and stores nothing.';

notify pgrst, 'reload schema';
commit;
