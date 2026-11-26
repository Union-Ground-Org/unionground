// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { offlinePostgres } from './tamarack-postgres-helper.mjs';

const migration = readFileSync(new URL('../supabase/migrations/20261020232001_password_reset_recovery_claim_lifecycle.sql', import.meta.url), 'utf8');
const contract = JSON.parse(readFileSync(new URL('../scripts/db-contract.json', import.meta.url), 'utf8'));
const USER = '11111111-2222-4333-8444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TOKEN = 'b'.repeat(64);
const OTHER_TOKEN = 'c'.repeat(64);

describe('password reset claim lifecycle in PostgreSQL', () => {
  let database;
  let db;
  let handle;
  const prepare = async (cleanup = false, token = TOKEN) => (await db.query(
    'select public.prepare_password_reset_recovery($1,$2,$3,$4) result', [USER, handle, token, cleanup])).rows[0].result;
  const cancel = async (token = TOKEN, user = USER) => (await db.query(
    'select public.cancel_password_reset_recovery($1,$2,$3) result', [user, handle, token])).rows[0].result;

  beforeAll(async () => {
    database = await offlinePostgres();
    db = database.client;
    await db.query(`
      create schema auth; create schema private; create schema extensions;
      create extension pgcrypto with schema extensions;
      create role anon; create role authenticated; create role service_role;
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;
      create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
      create table private.gate_calls(called boolean);
      create function private.lock_case_graph(uuid[], uuid[]) returns void language plpgsql as $$
      begin
        if exists(select 1 from pg_catalog.pg_locks where locktype='advisory'
          and pid=pg_catalog.pg_backend_pid() and classid=509 and objid=701) then
          raise exception 'graph gate must precede the Auth bookkeeping lock';
        end if;
        insert into private.gate_calls values (true);
      end;
      $$;
      create function private.member_session_handle(id uuid) returns text language sql as
        $$select encode(extensions.digest(id::text,'sha256'),'hex')$$;
      create table auth.sessions(id uuid primary key, user_id uuid not null);
      create table public.mfa_recovery_codes(id uuid primary key, user_id uuid not null,
        used_at timestamptz, claimed_at timestamptz, claim_expires_at timestamptz,
        claim_session_handle text, claim_token_hash text);
      create table private.member_mfa_recovery_locks(user_id uuid primary key,
        claim_token_hash text not null, locked_at timestamptz not null default clock_timestamp());
      create table private.member_session_closing_barriers(user_id uuid, session_handle text,
        scope text, closed_at timestamptz default now(), primary key(user_id,session_handle));
      create table public.member_push_subscriptions(user_id uuid);
      create table public.member_native_push_installations(user_id uuid);
      set search_path = '';
    `);
    await db.query(migration);
    handle = (await db.query('select private.member_session_handle($1) handle', [SESSION])).rows[0].handle;
  }, 120_000);

  it('enters the graph gate before bookkeeping for preparation and cancellation', async () => {
    await db.query('truncate private.gate_calls');
    await prepare();
    await cancel();
    expect((await db.query('select count(*)::int n from private.gate_calls')).rows[0].n).toBe(2);
  });

  it('matches the installed RPC source and service-only grants to the database contract', async () => {
    for (const name of ['prepare_password_reset_recovery', 'cancel_password_reset_recovery']) {
      const entry = contract.functions.find(row => row.sig.startsWith(`public.${name}(`));
      const row = (await db.query(`select md5(p.prosrc) source_hash, p.prosecdef,
        has_function_privilege('anon',p.oid,'execute') anon,
        has_function_privilege('authenticated',p.oid,'execute') authenticated,
        has_function_privilege('service_role',p.oid,'execute') service_role
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=$1`, [name])).rows[0];
      expect(entry.exec).toBe('service_role');
      expect(row).toEqual({ source_hash: entry.sourceMd5, prosecdef: true, anon: false, authenticated: false, service_role: true });
    }
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await db.query(`truncate auth.sessions, public.mfa_recovery_codes, private.member_mfa_recovery_locks,
      private.member_session_closing_barriers, public.member_push_subscriptions, public.member_native_push_installations;
      select set_config('request.jwt.claim.role','service_role',false);`);
    await db.query('insert into auth.sessions values($1,$2)', [SESSION, USER]);
    await db.query(`insert into public.mfa_recovery_codes
      values($1,$2,null,now(),now()+interval '2 minutes',$3,encode(extensions.digest($4,'sha256'),'hex'))`, [SESSION, USER, handle, TOKEN]);
    await db.query('insert into public.member_push_subscriptions values($1);', [USER]);
    await db.query('insert into public.member_native_push_installations values($1);', [USER]);
  });

  it('prepares before Auth revocation and cleans push state afterward without the old session', async () => {
    expect(await prepare()).toEqual({ prepared: true, serverCleanupComplete: false });
    expect((await db.query('select count(*)::int n from public.member_push_subscriptions')).rows[0].n).toBe(1);
    expect((await db.query('select count(*)::int n from private.member_session_closing_barriers')).rows[0].n).toBe(0);
    await db.query('delete from auth.sessions'); // the admin password update
    expect(await prepare(true)).toEqual({ prepared: true, serverCleanupComplete: true });
    expect((await db.query('select count(*)::int n from public.member_push_subscriptions')).rows[0].n).toBe(0);
    expect((await db.query('select count(*)::int n from public.member_native_push_installations')).rows[0].n).toBe(0);
    expect((await db.query('select count(*)::int n from private.member_mfa_recovery_locks')).rows[0].n).toBe(1);
  });

  it('cancels a definite rejection without consuming the code or removing push registrations', async () => {
    await prepare();
    expect(await cancel()).toBe(true);
    expect((await db.query('select used_at,claim_expires_at,claim_token_hash,claim_session_handle from public.mfa_recovery_codes')).rows[0])
      .toEqual({ used_at: null, claim_expires_at: null, claim_token_hash: null, claim_session_handle: null });
    expect((await db.query('select count(*)::int n from private.member_mfa_recovery_locks')).rows[0].n).toBe(0);
    expect((await db.query('select count(*)::int n from public.member_native_push_installations')).rows[0].n).toBe(1);
  });

  it('rejects preparation and cleanup without the exact live claim and session proof', async () => {
    expect(await prepare(true)).toEqual({ prepared: false });
    expect(await prepare(false, OTHER_TOKEN)).toEqual({ prepared: false });
    await db.query('delete from auth.sessions');
    expect(await prepare()).toEqual({ prepared: false });
    expect((await db.query('select count(*)::int n from private.member_mfa_recovery_locks')).rows[0].n).toBe(0);
  });

  it('never lets an old token clear or replace another attempt lock', async () => {
    await prepare();
    expect(await cancel(OTHER_TOKEN)).toBe(false);
    expect(await cancel(TOKEN, SESSION)).toBe(false);
    await db.query("update private.member_mfa_recovery_locks set claim_token_hash=encode(extensions.digest($1,'sha256'),'hex')", [OTHER_TOKEN]);
    expect(await prepare()).toEqual({ prepared: false });
    expect(await cancel()).toBe(false);
    expect((await db.query('select claim_token_hash from private.member_mfa_recovery_locks')).rows[0].claim_token_hash)
      .toBe((await db.query("select encode(extensions.digest($1,'sha256'),'hex') h", [OTHER_TOKEN])).rows[0].h);
  });

  it('refuses expired and consumed claims for preparation and consumed claims for cancellation', async () => {
    await db.query("update public.mfa_recovery_codes set claim_expires_at=now()-interval '1 second'");
    expect(await prepare()).toEqual({ prepared: false });
    expect(await cancel()).toBe(true); // safe release can outlast a timed-out request
    await db.query("update public.mfa_recovery_codes set used_at=now(),claim_token_hash=encode(extensions.digest($1,'sha256'),'hex'),claim_session_handle=$2", [TOKEN, handle]);
    expect(await cancel()).toBe(false);
  });

  it('limits both RPCs to service role even with a correct claim token', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query("select has_function_privilege($1,'public.prepare_password_reset_recovery(uuid,text,text,boolean)','execute') allowed", [role])).rows[0].allowed).toBe(false);
      expect((await db.query("select has_function_privilege($1,'public.cancel_password_reset_recovery(uuid,text,text)','execute') allowed", [role])).rows[0].allowed).toBe(false);
      await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
      await expect(prepare()).rejects.toMatchObject({ code: '42501' });
      await expect(cancel()).rejects.toMatchObject({ code: '42501' });
    }
  });
});
