-- REQ-UG-BOTS-IN-PRODUCTION-UNTIL-SIGNUP-20261016
-- Project decision, October 16, 2026: the role-play bots and the Tamarack bots
-- may work in production until public signup opens, and all of their data is
-- removed before it opens. This migration records every bot-created
-- organization, chapter, invitation and account in a private ledger, so
-- scripts/bots-production-remove.mjs never has to guess which rows are the
-- bots', and keeps public signup closed while any ledger entry is unremoved.
--
-- Rows enter the ledger three ways:
--   * the kits mark their anchors before creating them (the Tamarack seed
--     marks its organization, chapters and accounts; the role-play founder
--     command marks its founder idempotency key);
--   * a founder invitation created under a marked key marks its organization,
--     chapter and invitation in the same transaction;
--   * a chapter created in a marked organization, an invitation created in a
--     marked chapter, and an account bound to a marked invitation are marked
--     by the triggers below, so rows the bots create through the app inherit
--     the marker.
-- Applying this migration marks nothing and never opens signup.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.bot_production_marks (
  kind text not null
    check (kind in ('auth_user', 'organization', 'chapter', 'invitation', 'founder_key', 'storage_object')),
  record_id text not null check (length(record_id) between 1 and 200),
  kit text not null check (kit in ('tamarack', 'role-play')),
  run_id text not null check (run_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  marked_at timestamptz not null default pg_catalog.now(),
  -- storage_object entries are written by the remover before it deletes a
  -- bot file through the Storage API: sha256 (hex) of bucket_id || '/' || name, so the
  -- gate stays closed until the file is gone and verify can prove it.
  -- Set by the remover in the transaction that deleted the row. The ids stay
  -- so verify mode can prove each one is gone; they are opaque ids, never
  -- names, addresses or content.
  removed_at timestamptz,
  primary key (kind, record_id)
);
create index bot_production_marks_unremoved_idx on private.bot_production_marks (kind) where removed_at is null;
alter table private.bot_production_marks enable row level security;
alter table private.bot_production_marks force row level security;
revoke all on private.bot_production_marks from public, anon, authenticated, service_role;

comment on table private.bot_production_marks is
  'Machine-only marker ledger for bot data in production (project decision 2026-10-16). Public signup stays closed while any row has removed_at null.';

-- True while any bot row is still recorded as present.
create function private.bot_production_marks_present()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (select 1 from private.bot_production_marks m where m.removed_at is null);
$function$;
revoke all on function private.bot_production_marks_present() from public, anon, authenticated, service_role;

create function private.bot_production_mark_row(p_kind text, p_record_id text, p_kit text, p_run_id text)
returns void language sql volatile security definer set search_path = ''
as $function$
  insert into private.bot_production_marks (kind, record_id, kit, run_id)
  values (p_kind, p_record_id, p_kit, p_run_id)
  on conflict (kind, record_id) do update
    set removed_at = null
    where private.bot_production_marks.removed_at is not null;
$function$;
revoke all on function private.bot_production_mark_row(text, text, text, text) from public, anon, authenticated, service_role;

-- A founder invitation created under a marked idempotency key: mark its
-- organization, chapter and invitation in the creating transaction. A key
-- entry a removal already closed (the create was still in flight) counts
-- too and is re-opened: keys are UUIDs, never reused by anyone else.
create function private.bot_production_mark_founder_invitation()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  founder private.bot_production_marks%rowtype;
begin
  if new.idempotency_key is null or new.event_type <> 'organization_founder_invited' then
    return null;
  end if;
  select * into founder from private.bot_production_marks m
   where m.kind = 'founder_key' and m.record_id = new.idempotency_key::text;
  if not found then
    return null;
  end if;
  perform private.bot_production_mark_row('founder_key', founder.record_id, founder.kit, founder.run_id);
  perform private.bot_production_mark_row('organization', new.organization_id::text, founder.kit, founder.run_id);
  if new.metadata ->> 'chapterId' is not null then
    perform private.bot_production_mark_row('chapter', new.metadata ->> 'chapterId', founder.kit, founder.run_id);
  end if;
  if new.metadata ->> 'entityId' is not null then
    perform private.bot_production_mark_row('invitation', new.metadata ->> 'entityId', founder.kit, founder.run_id);
  end if;
  return null;
end;
$function$;
revoke all on function private.bot_production_mark_founder_invitation() from public, anon, authenticated, service_role;

create trigger bot_production_mark_founder_invitation
after insert on public.organization_audit_ledger
for each row execute function private.bot_production_mark_founder_invitation();

-- A chapter created in a marked organization.
create function private.bot_production_mark_chapter()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  parent private.bot_production_marks%rowtype;
begin
  if new.organization_id is null then
    return null;
  end if;
  select * into parent from private.bot_production_marks m
   where m.kind = 'organization' and m.record_id = new.organization_id::text and m.removed_at is null;
  if found then
    perform private.bot_production_mark_row('chapter', new.id, parent.kit, parent.run_id);
  end if;
  return null;
end;
$function$;
revoke all on function private.bot_production_mark_chapter() from public, anon, authenticated, service_role;

create trigger bot_production_mark_chapter
after insert on public.chapters
for each row execute function private.bot_production_mark_chapter();

-- An invitation created in a marked chapter, and the account bound to a
-- marked invitation when it is accepted.
create function private.bot_production_mark_invitation()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  parent private.bot_production_marks%rowtype;
begin
  select * into parent from private.bot_production_marks m
   where m.kind = 'invitation' and m.record_id = new.id::text and m.removed_at is null;
  if not found then
    select * into parent from private.bot_production_marks m
     where m.kind = 'chapter' and m.record_id = new.chapter_id and m.removed_at is null;
    if not found then
      return null;
    end if;
    perform private.bot_production_mark_row('invitation', new.id::text, parent.kit, parent.run_id);
  end if;
  if new.auth_user_id is not null then
    perform private.bot_production_mark_row('auth_user', new.auth_user_id::text, parent.kit, parent.run_id);
  end if;
  return null;
end;
$function$;
revoke all on function private.bot_production_mark_invitation() from public, anon, authenticated, service_role;

create trigger bot_production_mark_invitation
after insert or update of auth_user_id on public.member_invitations
for each row execute function private.bot_production_mark_invitation();

-- An account an invitation acceptance creates is committed before the
-- invitation is bound to it (api/_lib/memberInvitations.js
-- createPasswordAuthUser names the invitation in user_metadata), and an
-- interrupted acceptance leaves it staged. Mark it when it is created.
create function private.bot_production_mark_staged_account()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  parent private.bot_production_marks%rowtype;
begin
  if new.raw_user_meta_data ->> 'union_base_invitation_id' is null then
    return null;
  end if;
  select * into parent from private.bot_production_marks m
   where m.kind = 'invitation' and m.record_id = new.raw_user_meta_data ->> 'union_base_invitation_id'
     and m.removed_at is null;
  if found then
    perform private.bot_production_mark_row('auth_user', new.id::text, parent.kit, parent.run_id);
  end if;
  return null;
end;
$function$;
revoke all on function private.bot_production_mark_staged_account() from public, anon, authenticated, service_role;

create trigger bot_production_mark_staged_account
after insert on auth.users
for each row execute function private.bot_production_mark_staged_account();

-- A row inserted under an id the ledger already holds re-opens that entry.
-- The kits mark before they insert, so a remover that ran in between and
-- closed the entry as absent cannot leave the later row unmarked. Only UUID
-- ids are re-opened (organizations, invitations, accounts): a chapter id is
-- reusable text, so a chapter is marked only through an open organization
-- mark (bot_production_mark_chapter), never by its id alone.
create function private.bot_production_reopen()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  update private.bot_production_marks m set removed_at = null
   where m.kind = tg_argv[0] and m.record_id = new.id::text and m.removed_at is not null;
  return null;
end;
$function$;
revoke all on function private.bot_production_reopen() from public, anon, authenticated, service_role;

create trigger bot_production_reopen_organization
after insert on public.organizations
for each row execute function private.bot_production_reopen('organization');
create trigger bot_production_reopen_invitation
after insert on public.member_invitations
for each row execute function private.bot_production_reopen('invitation');
create trigger bot_production_reopen_account
after insert on auth.users
for each row execute function private.bot_production_reopen('auth_user');

-- Public signup also stays closed while any bot row is unremoved.
create or replace function private.open_signup_is_open()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select coalesce((select p.opens_at <= pg_catalog.now()
    from private.open_signup_period p where p.singleton), false)
    and private.open_signup_recovery_ready()
    and private.open_signup_coverage_active()
    and not private.bot_production_marks_present();
$function$;
revoke all on function private.open_signup_is_open() from public, anon, authenticated, service_role;

-- Service-role entry points for the kits that reach production over HTTPS
-- (bots/lib/production.mjs). Marking accepts only a founder idempotency key,
-- before the key creates anything: an existing account, organization or
-- chapter can never be marked from outside the database. The seed and the
-- remover connect to Postgres directly.
create function public.bot_production_mark(p_kind text, p_record_ids text[], p_kit text, p_run_id text)
returns integer language plpgsql volatile security definer set search_path = ''
as $function$
declare
  marked integer := 0;
  v_id text;
begin
  if p_kind is distinct from 'founder_key' then
    raise exception 'bot_production_mark accepts founder_key only' using errcode = '22023';
  end if;
  if p_record_ids is null or pg_catalog.cardinality(p_record_ids) = 0 or pg_catalog.cardinality(p_record_ids) > 200 then
    raise exception 'bot_production_mark needs 1 to 200 ids' using errcode = '22023';
  end if;
  foreach v_id in array p_record_ids loop
    if v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'bot_production_mark ids must be UUIDs' using errcode = '22023';
    end if;
    if exists (select 1 from public.organization_audit_ledger l where l.idempotency_key::text = pg_catalog.lower(v_id)) then
      -- A retry of this kit's own create (its response was lost) replays
      -- through the founder RPC; any other used key is refused.
      if exists (select 1 from private.bot_production_marks m
                  where m.kind = 'founder_key' and m.record_id = pg_catalog.lower(v_id)
                    and m.kit = p_kit and m.run_id = p_run_id) then
        marked := marked + 1;
        continue;
      end if;
      raise exception 'bot_production_mark refuses a key that has already been used' using errcode = '22023';
    end if;
    perform private.bot_production_mark_row(p_kind, pg_catalog.lower(v_id), p_kit, p_run_id);
    marked := marked + 1;
  end loop;
  return marked;
end;
$function$;
revoke all on function public.bot_production_mark(text, text[], text, text) from public, anon, authenticated;
grant execute on function public.bot_production_mark(text, text[], text, text) to service_role;

create function public.bot_production_status()
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'ledger', true,
    'unremoved', (select count(*) from private.bot_production_marks m where m.removed_at is null),
    'signupOpen', private.open_signup_is_open());
$function$;
revoke all on function public.bot_production_status() from public, anon, authenticated;
grant execute on function public.bot_production_status() to service_role;

comment on function public.bot_production_status() is
  'Counts only. The bot kits refuse a production run unless the ledger exists and public signup is closed.';

-- The new triggers and their functions join the reviewed trigger surface.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.schema_name in ('public', 'auth') and s.object_name in (
    'bot_production_mark_founder_invitation', 'bot_production_mark_chapter', 'bot_production_mark_invitation',
    'bot_production_mark_staged_account', 'bot_production_reopen_organization',
    'bot_production_reopen_invitation', 'bot_production_reopen_account'))
  or (s.kind = 'function' and s.schema_name = 'private' and s.object_name in (
    'bot_production_mark_founder_invitation()', 'bot_production_mark_chapter()', 'bot_production_mark_invitation()',
    'bot_production_mark_staged_account()', 'bot_production_reopen()',
    'bot_production_mark_row(p_kind text, p_record_id text, p_kit text, p_run_id text)',
    -- The self-serve intake guard on auth.users (20261017024400) calls the
    -- signup gate, so the gate and the marker probe it now calls are reached.
    'open_signup_is_open()', 'bot_production_marks_present()'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_bot_production_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the bot production ledger';
  end if;
end
$assert_bot_production_trigger_review$;

notify pgrst, 'reload schema';
commit;
