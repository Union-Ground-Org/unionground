-- BUG-UG-MFA-RESET-FOURTH-EXIT-NO-NOTICE-NO-DEBT-20260918
--
-- THE DEFECT. api/admin-mfa-reset.js has a fourth exit the pending-notice
-- work (20260918090000) did not cover: begin_mfa_reset succeeds — the reset
-- boundary is written and the member's sessions, web push and native push
-- installations are closed — and then the provider's factor inventory fails,
-- so the endpoint answers 502 auth-service-unavailable before any factor is
-- deleted. It wrote the member nothing and marked nothing owed.
--
-- WHY NOT THE EXISTING DEBT. (2026-09-19) carved the parent
-- record to its three enumerated paths and refused queue-only for this exit:
-- queue_member_mfa_reset_notice marks a debt that drain_member_mfa_reset_notice
-- (and notify_member_mfa_reset) discharge with "An administrator removed the
-- authenticator from your account". On this exit that is false — the
-- inventory failed, nothing was deleted, and the member's authenticator still
-- works. So this exit gets its own notice with its own true copy: sessions
-- were signed out, the reset did not finish, the authenticator was NOT
-- removed.
--
-- THE SHAPE. One RPC, public.notify_member_mfa_reset_incomplete(uuid), called
-- by the endpoint AS THE ADMINISTRATOR on that exit only. It is bound to a
-- reset this caller began (reset_by) within the last fifteen minutes, so it
-- cannot be used to send a member a notice about a reset that never happened
-- or happened long ago. It does not touch notice_owed_at/notice_sent_at: a
-- debt an earlier, complete reset left behind is still true for that reset
-- and still drains with its own copy on the next reset.
--
-- NO SECOND NOTICE. One notice per reset, anchored on the reset instant
-- (invalid_before), recognized by all four localized titles — the two
-- "was reset" titles notify_member_mfa_reset and the drain write, and the two
-- "did not finish" titles below — so a retried call, or a reset that somehow
-- already has its notice, writes nothing. A LATER reset writes a new boundary
-- instant and owes its own notice.
--
-- Conventions: SECURITY DEFINER, empty search_path, every call pg_catalog- or
-- schema-qualified, EXECUTE revoked from PUBLIC/anon/authenticated/service_role
-- and re-granted to exactly `authenticated`. Enters the case-graph transaction
-- gate first (public.member_notifications is a graph relation), gates on
-- public.member_has_role (which ANDs private.mfa_satisfied()), refuses a
-- self-target and resolves the member through the caller's own organization
-- with the same tenant predicate as the other reset authorities, with the same
-- flat 42501 for every refusal so it is not a membership oracle.
--
-- No existing function is re-declared and no shipped migration is edited.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function public.notify_member_mfa_reset_incomplete(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  reset_at timestamptz;
  member_lang text;
  notice_title text;
  notice_body text;
  inserted integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = caller then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  -- Same target scope as the sibling MFA-reset authorities (20260924100000):
  -- the tenant check plus the chapter-scope predicate on an active membership.
  select coalesce(p.language, 'en') into member_lang
  from public.member_profiles p
  where p.id = p_user_id
    and exists (
      select 1
      from public.chapters pc
      where pc.id = p.chapter_id
        and pc.organization_id = private.current_member_organization()
    )
    and exists (
      select 1
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id
      where m.user_id = p.id
        and m.status = 'active'
        and c.organization_id = private.current_member_organization()
        and (
          private.has_organization_role(c.organization_id, array['admin'])
          or private.member_has_chapter_role(m.chapter_id, array['admin'])
        )
    );
  if member_lang is null then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  -- Bound to a reset this caller just began: begin_mfa_reset wrote the
  -- boundary and named itself in reset_by.
  select b.invalid_before into reset_at
  from private.member_mfa_reset_boundaries b
  where b.user_id = p_user_id
    and b.reset_by = caller
    and b.invalid_before >= pg_catalog.clock_timestamp() - interval '15 minutes'
  for update;
  if not found then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.member_notifications n
    where n.user_id = p_user_id
      and n.created_at >= reset_at
      and n.title in ('Two-step sign-in was reset by an administrator',
                      'Un administrador restableció la verificación en dos pasos',
                      'Two-step sign-in reset did not finish',
                      'El restablecimiento de la verificación en dos pasos no terminó')
  ) then
    return pg_catalog.jsonb_build_object(
      'userId', p_user_id, 'notified', false, 'duplicate', true);
  end if;

  if member_lang = 'es' then
    notice_title := 'El restablecimiento de la verificación en dos pasos no terminó';
    notice_body := 'Un administrador empezó a restablecer la verificación en dos pasos de tu cuenta y cerró tus sesiones abiertas, pero el restablecimiento no terminó. Tu autenticador no se quitó y sigue funcionando: vuelve a iniciar sesión con el código de tu aplicación de autenticación. Si no lo pediste, contacta a tu oficina local de inmediato.';
  else
    notice_title := 'Two-step sign-in reset did not finish';
    notice_body := 'An administrator started resetting two-step sign-in on your account and signed out your open sessions, but the reset did not finish. Your authenticator was not removed and still works: sign in again with the code from your authenticator app. If you did not ask for this, contact your local office immediately.';
  end if;

  insert into public.member_notifications (user_id, title, body, kind)
  values (p_user_id, notice_title, notice_body, 'general');
  get diagnostics inserted = row_count;

  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'notified', inserted = 1, 'duplicate', false);
end;
$function$;

revoke all on function public.notify_member_mfa_reset_incomplete(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.notify_member_mfa_reset_incomplete(uuid) to authenticated;

comment on function public.notify_member_mfa_reset_incomplete(uuid) is
  'Admin-gated, tenant-scoped, self-target refused: tells the member, once per reset and in their language, that a reset this administrator began in the last fifteen minutes signed out their sessions but did not finish and did not remove their authenticator.';

notify pgrst, 'reload schema';

commit;
