// @vitest-environment node
//
// BUG-UG-RECOVERY-CLAIM-LEASED-MATCH-BUSY-OUTCOME-20261022: a recovery
// claim can time out while its transaction is still in flight. An immediate
// retry of the same, correct code then finds it under the first claim's lease.
// claim_mfa_recovery_code used to exclude it and count a wrong code toward the
// recovery lockout; it now answers busy with no failed attempt and no new lease.
// Runs on its own temporary socket-only PostgreSQL with a minimal schema.
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { offlinePostgres } from './tamarack-postgres-helper.mjs';

const MIGRATION = readdirSync(new URL('../supabase/migrations/', import.meta.url)).find(name => name.endsWith('_recovery_claim_leased_match_busy.sql'));
const migration = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
const contract = JSON.parse(readFileSync(new URL('../scripts/db-contract.json', import.meta.url), 'utf8'));
const USER = '11111111-2222-4333-8444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CODE = 'UG0123ABCD4567EF89';
const OTHER = 'UG99999999ABCDEF01';

describe('recovery claim of a leased matching code', () => {
  let database;
  let db;
  const claim = async (code) => (await db.query('select public.claim_mfa_recovery_code($1) result', [code])).rows[0].result;
  const attempts = async () => (await db.query('select failed_attempts, locked_until from public.mfa_recovery_code_sets')).rows[0];
  const lease = async () => (await db.query('select claim_token_hash, claim_expires_at, used_at from public.mfa_recovery_codes')).rows[0];

  beforeAll(async () => {
    database = await offlinePostgres();
    db = database.client;
    await db.query(`
      create schema auth; create schema private; create schema extensions;
      create extension pgcrypto with schema extensions;
      create role authenticated;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
      create function private.lock_case_graph(uuid[], uuid[]) returns void language sql as $$select$$;
      create function private.current_member_session_id() returns uuid language sql as $$select '${SESSION}'::uuid$$;
      create function private.member_session_handle(id uuid) returns text language sql as
        $$select encode(extensions.digest(id::text,'sha256'),'hex')$$;
      create function private.current_member_organization() returns uuid language sql as $$select null::uuid$$;
      create function private.organization_limit(uuid, text) returns integer language sql as
        $$select case when $2 = 'limits.security.mfa_recovery_failures' then 3 else 15 end$$;
      create table auth.sessions(id uuid primary key, user_id uuid not null);
      create table public.mfa_recovery_code_sets(user_id uuid primary key, generation integer not null,
        failed_attempts integer not null default 0, locked_until timestamptz);
      create table public.mfa_recovery_codes(id uuid primary key default extensions.gen_random_uuid(), user_id uuid not null,
        generation integer not null, code_prefix text not null, code_hash text not null, used_at timestamptz,
        claimed_at timestamptz, claim_expires_at timestamptz, claim_token_hash text, claim_session_handle text);
    `);
    await db.query(migration);
  }, 120_000);

  afterAll(async () => { await database?.close(); });

  beforeEach(async () => {
    await db.query('truncate auth.sessions, public.mfa_recovery_code_sets, public.mfa_recovery_codes');
    await db.query("select set_config('test.uid', $1, false)", [USER]);
    await db.query('insert into auth.sessions values ($1,$2)', [SESSION, USER]);
    await db.query('insert into public.mfa_recovery_code_sets(user_id, generation) values ($1, 1)', [USER]);
    await db.query(`insert into public.mfa_recovery_codes(user_id, generation, code_prefix, code_hash)
      values ($1, 1, substr($2, 3, 8), extensions.crypt($2, extensions.gen_salt('bf', 4)))`, [USER, CODE]);
  });

  it('answers a retry of the leased correct code as busy, counting nothing and leasing nothing new', async () => {
    const first = await claim(CODE);
    expect(first).toMatchObject({ userId: USER, expiresIn: 120 });
    expect(first.claimToken).toMatch(/^[0-9a-f]{64}$/);
    const leased = await lease();
    // The first claim has committed; the retry of the same code now finds it leased.
    const busy = await claim(CODE);
    expect(busy).toMatchObject({ accepted: false, busy: true });
    expect(Object.keys(busy).sort()).toEqual(['accepted', 'busy', 'retryAfterSeconds']);
    expect(busy.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(busy.retryAfterSeconds).toBeLessThanOrEqual(120);
    expect(await attempts()).toEqual({ failed_attempts: 0, locked_until: null });
    expect(await lease()).toEqual(leased);
  });

  //  on #5770: the busy match hashes nothing under the global locks, so a
  // wrong suffix on the leased prefix also waits out the lease and counts nothing.
  it('answers a wrong suffix on the leased prefix as busy too, then counts it once the lease ends', async () => {
    await claim(CODE);
    const wrongSuffix = `${CODE.slice(0, 10)}00000000`;
    expect(await claim(wrongSuffix)).toMatchObject({ accepted: false, busy: true });
    expect((await attempts()).failed_attempts).toBe(0);
    await db.query("update public.mfa_recovery_codes set claim_expires_at = now() - interval '1 second'");
    expect(await claim(wrongSuffix)).toEqual({ accepted: false });
    expect((await attempts()).failed_attempts).toBe(1);
  });

  it('hashes nothing on the busy path', () => {
    const busy = migration.slice(migration.indexOf('from public.mfa_recovery_codes leased'), migration.indexOf("'busy', true"));
    expect(busy).not.toMatch(/crypt\(/u);
  });

  it('keeps counting a wrong code, including while another code is leased', async () => {
    expect(await claim(OTHER)).toEqual({ accepted: false });
    expect((await attempts()).failed_attempts).toBe(1);
    await claim(CODE);
    expect(await claim(OTHER)).toEqual({ accepted: false });
    expect((await attempts()).failed_attempts).toBe(1);
  });

  it('keeps counting a used code and an expired lease stays claimable', async () => {
    await db.query("update public.mfa_recovery_codes set used_at = now()");
    expect(await claim(CODE)).toEqual({ accepted: false });
    expect((await attempts()).failed_attempts).toBe(1);
    await db.query("update public.mfa_recovery_codes set used_at = null, claim_expires_at = now() - interval '1 second'");
    expect(await claim(CODE)).toMatchObject({ userId: USER });
  });

  it('keeps refusing a locked-out account before any lease check', async () => {
    await claim(CODE);
    await db.query("update public.mfa_recovery_code_sets set locked_until = now() + interval '5 minutes'");
    await expect(claim(CODE)).rejects.toMatchObject({ code: '22023' });
  });

  it('pins the replaced definition in the database contract', async () => {
    const entry = contract.functions.find(row => row.sig === 'public.claim_mfa_recovery_code(p_code text)');
    const row = (await db.query(`select md5(pg_get_functiondef(p.oid)) def_md5 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_mfa_recovery_code'`)).rows[0];
    expect(row.def_md5).toBe(entry.bodyMd5);
    for (const fragment of entry.bodyContains) expect(migration).toContain(fragment);
  });
});
