// @vitest-environment node
// BUG-UG-ADMIN-SESSION-REVOKE-ENDPOINT-20261003: the service-role
// revocation behind admin password reissue, sign-in address recovery and MFA
// reset (20261003061000_end_member_auth_sessions.sql). Synthetic accounts
// only (@example.invalid). Every case runs in one transaction that is rolled
// back, and each refusal carries a control that must still succeed.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const live = process.env.RUN_END_MEMBER_AUTH_SESSIONS_DB_TESTS === '1' ? it : it.skip;

async function withClient(run) {
  const c = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    application_name: 'end-member-auth-sessions-rollback-proof',
  });
  await c.connect();
  await c.query("set statement_timeout = '20s'");
  await c.query('begin');
  try {
    await run(c);
  } finally {
    await c.query('rollback');
    await c.end();
  }
}

async function call(c, role, userId) {
  await c.query('savepoint rpc_call');
  try {
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify(role === 'service_role' ? { role } : { sub: randomUUID(), role }),
    ]);
    await c.query(`set local role ${role}`);
    const result = (await c.query('select public.end_member_auth_sessions($1) as r', [userId])).rows[0]?.r;
    await c.query('reset role');
    await c.query('release savepoint rpc_call');
    return result;
  } catch (error) {
    await c.query('rollback to savepoint rpc_call');
    await c.query('release savepoint rpc_call');
    throw error;
  }
}

async function account(c, sessions) {
  const user = randomUUID();
  await c.query('insert into auth.users(id,email) values ($1,$2)', [user, `${user}@example.invalid`]);
  const ids = [];
  for (let i = 0; i < sessions; i += 1) {
    const id = randomUUID();
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal1',now(),now())", [id, user]);
    ids.push(id);
  }
  return { user, ids };
}

const count = async (c, sql, params) => (await c.query(sql, params)).rows[0].n;

live('ends every Auth session and PIN marker of the account, and no other account', async () => {
  await withClient(async (c) => {
    const target = await account(c, 3);
    const other = await account(c, 2);
    await c.query('insert into private.member_pin_sessions(session_id,user_id) values ($1,$2)', [target.ids[0], target.user]);
    await c.query('insert into private.member_pin_sessions(session_id,user_id) values ($1,$2)', [other.ids[0], other.user]);

    expect(await call(c, 'service_role', target.user)).toEqual({ ended: true });

    expect(await count(c, 'select count(*)::int as n from auth.sessions where user_id = $1', [target.user])).toBe(0);
    expect(await count(c, 'select count(*)::int as n from private.member_pin_sessions where user_id = $1', [target.user])).toBe(0);
    expect(await count(c, 'select count(*)::int as n from auth.sessions where user_id = $1', [other.user])).toBe(2);
    expect(await count(c, 'select count(*)::int as n from private.member_pin_sessions where user_id = $1', [other.user])).toBe(1);
  });
});

live('answers ended for an account with no sessions, so a retry after a lost response succeeds', async () => {
  await withClient(async (c) => {
    const target = await account(c, 1);
    expect(await call(c, 'service_role', target.user)).toEqual({ ended: true });
    expect(await call(c, 'service_role', target.user)).toEqual({ ended: true });
  });
});

live('refuses every client role and a missing account, while the service role still succeeds', async () => {
  await withClient(async (c) => {
    const target = await account(c, 1);
    for (const role of ['authenticated', 'anon']) {
      const error = await call(c, role, target.user).then(() => null, (e) => e);
      expect(error?.code, role).toBe('42501');
    }
    expect(await count(c, 'select count(*)::int as n from auth.sessions where user_id = $1', [target.user])).toBe(1);
    const missing = await call(c, 'service_role', null).then(() => null, (e) => e);
    expect(missing?.code).toBe('22023');
    expect(await call(c, 'service_role', target.user)).toEqual({ ended: true });
  });
});
