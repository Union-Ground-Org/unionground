// @vitest-environment node
// REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009: the server authority
// behind Account > Sessions on the native apps. The screen may show only what
// public.list_my_sessions() returns and may revoke only through
// public.revoke_my_session(handle) and public.prepare_my_signout(scope, user),
// so these cases are the authorization, privacy, idempotency and
// post-revocation evidence the record asks for. Synthetic accounts only
// (@example.invalid); every case runs in one transaction that is rolled back.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const live = process.env.RUN_NATIVE_SESSION_MANAGEMENT_DB_TESTS === '1' ? it : it.skip;

async function withClient(run) {
  const c = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    application_name: 'native-session-management-rollback-proof',
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

// One account in its own organization, with `sessions` live Auth sessions. The
// organization is created so the denial cases below are genuinely
// cross-organization and not merely two users in the same tenant.
async function account(c, sessions, options = {}) {
  const user = randomUUID();
  const org = randomUUID();
  const chapter = `proof-${org}`;
  await c.query('insert into public.organizations(id,slug,name) values ($1,$2,$2)', [org, chapter]);
  await c.query(
    "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9950)",
    [chapter, org],
  );
  await c.query('insert into auth.users(id,email) values ($1,$2)', [user, `${user}@example.invalid`]);
  await c.query('update public.member_profiles set chapter_id=$2 where id=$1', [user, chapter]);
  await c.query(
    "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",
    [org, user],
  );
  await c.query(
    "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict(user_id,chapter_id) do update set status='active'",
    [user, chapter],
  );
  if (options.administrator) {
    await c.query('alter table public.member_roles disable trigger member_roles_forbid_new_ownerless');
    await c.query(
      "insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',null) on conflict(user_id,role) do update set chapter_id=null",
      [user],
    );
    await c.query('alter table public.member_roles enable trigger member_roles_forbid_new_ownerless');
  }
  const ids = [];
  for (let i = 0; i < sessions; i += 1) {
    const id = randomUUID();
    await c.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at,ip,user_agent) values ($1,$2,'aal1',now(),now(),$3,$4)",
      [id, user, '203.0.113.7', 'Union Ground/1.0 (iPhone; iOS 26.0)'],
    );
    ids.push(id);
  }
  return { user, org, chapter, ids };
}

// Call an RPC as the account the JWT names, from the client role that JWT
// claims, exactly as PostgREST would. Nothing here runs as the schema owner,
// so a missing grant is a refusal rather than a silent success.
const CLIENT_ROLES = new Set(['anon', 'authenticated', 'service_role']);

async function rpc(c, identity, sql, args = []) {
  const role = identity.role;
  if (!CLIENT_ROLES.has(role)) throw new Error(`refusing to assume ${role}`);
  await c.query('savepoint rpc_call');
  try {
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(identity)]);
    await c.query(`set local role ${role}`);
    const result = await c.query(sql, args);
    await c.query('reset role');
    await c.query('release savepoint rpc_call');
    return result.rows[0]?.r;
  } catch (error) {
    await c.query('rollback to savepoint rpc_call');
    await c.query('release savepoint rpc_call');
    throw error;
  }
}

const member = (user, session) => ({ sub: user, role: 'authenticated', session_id: session, aal: 'aal1' });
const handleOf = async (c, session) => (
  await c.query('select private.member_session_handle($1) h', [session])
).rows[0].h;
const sessionCount = async (c, user) => (
  await c.query('select count(*)::int n from auth.sessions where user_id=$1', [user])
).rows[0].n;
const barriers = async (c, user) => (
  await c.query('select session_handle, scope from private.member_session_closing_barriers where user_id=$1 order by session_handle', [user])
).rows;

live('lists only the caller’s own live sessions, marks the current one, and carries no raw identifier', async () => {
  await withClient(async (c) => {
    const caller = await account(c, 2);
    const stranger = await account(c, 2, { administrator: true });
    const expired = randomUUID();
    await c.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at,not_after) values ($1,$2,'aal1',now(),now(),now()-interval '1 hour')",
      [expired, caller.user],
    );

    const rows = await rpc(c, member(caller.user, caller.ids[0]), 'select public.list_my_sessions() r');
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.current === true)).toHaveLength(1);
    expect(rows[0].current).toBe(true);
    expect(rows[0].handle).toBe(await handleOf(c, caller.ids[0]));

    const handles = rows.map((row) => row.handle);
    expect(handles).toContain(await handleOf(c, caller.ids[1]));
    // An expired session is not an active one, and another account's sessions
    // are never the caller's business whatever role that account holds.
    expect(handles).not.toContain(await handleOf(c, expired));
    for (const id of stranger.ids) expect(handles).not.toContain(await handleOf(c, id));

    // The whole payload, keys and values: no vendor session id, IP or agent.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(caller.ids[0]);
    expect(serialized).not.toContain('203.0.113.7');
    expect(serialized).not.toContain('iPhone; iOS');
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['browserLabel', 'createdAt', 'current', 'deviceLabel', 'handle', 'lastActiveAt'],
    );
  });
});

live('refuses every client role but the signed-in member, and refuses a mismatched expected account', async () => {
  await withClient(async (c) => {
    const caller = await account(c, 1);
    const stranger = await account(c, 1, { administrator: true });
    const handle = await handleOf(c, caller.ids[0]);

    for (const role of ['anon', 'service_role']) {
      for (const [sql, args] of [
        ['select public.list_my_sessions() r', []],
        ['select public.revoke_my_session($1) r', [handle]],
        ['select public.prepare_my_signout($1,$2) r', ['local', caller.user]],
      ]) {
        await expect(rpc(c, { sub: caller.user, role, session_id: caller.ids[0], aal: 'aal1' }, sql, args))
          .rejects.toMatchObject({ code: '42501' });
      }
    }
    // The expected-account parameter is a second lock on the sign-out barrier:
    // a client holding one account's session may not prepare another's.
    await expect(rpc(c, member(caller.user, caller.ids[0]), 'select public.prepare_my_signout($1,$2) r', ['global', stranger.user]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(rpc(c, member(caller.user, caller.ids[0]), 'select public.prepare_my_signout($1,$2) r', ['local', null]))
      .rejects.toMatchObject({ code: '42501' });
    expect(await barriers(c, stranger.user)).toEqual([]);
    // The control: the same caller, its own account, still succeeds.
    expect(await rpc(c, member(caller.user, caller.ids[0]), 'select public.prepare_my_signout($1,$2) r', ['local', caller.user]))
      .toMatchObject({ scope: 'local', serverCleanupComplete: true });
  });
});

live('refuses a cross-user and cross-organization revoke, and leaves the other account untouched', async () => {
  await withClient(async (c) => {
    const caller = await account(c, 2);
    const stranger = await account(c, 2, { administrator: true });
    const strangerHandle = await handleOf(c, stranger.ids[1]);

    // The handle is a SHA-256 of a session id the caller never sees, but even
    // holding one proves nothing: the lookup is scoped to the caller's own rows.
    await expect(rpc(c, member(caller.user, caller.ids[0]), 'select public.revoke_my_session($1) r', [strangerHandle]))
      .rejects.toMatchObject({ code: '22023' });
    // And the reverse direction, from the organization administrator.
    await expect(rpc(c, member(stranger.user, stranger.ids[0]), 'select public.revoke_my_session($1) r', [await handleOf(c, caller.ids[1])]))
      .rejects.toMatchObject({ code: '22023' });

    expect(await sessionCount(c, caller.user)).toBe(2);
    expect(await sessionCount(c, stranger.user)).toBe(2);
    expect(await barriers(c, caller.user)).toEqual([]);
    expect(await barriers(c, stranger.user)).toEqual([]);

    // The control: each account may still end its own other session.
    expect(await rpc(c, member(caller.user, caller.ids[0]), 'select public.revoke_my_session($1) r', [await handleOf(c, caller.ids[1])]))
      .toMatchObject({ revoked: true, alreadyRevoked: false });
    expect(await sessionCount(c, caller.user)).toBe(1);
    expect(await sessionCount(c, stranger.user)).toBe(2);
  });
});

live('replays a revoke idempotently and never ends the session making the call', async () => {
  await withClient(async (c) => {
    const caller = await account(c, 3);
    const target = await handleOf(c, caller.ids[2]);

    expect(await rpc(c, member(caller.user, caller.ids[0]), 'select public.revoke_my_session($1) r', [target]))
      .toMatchObject({ revoked: true, alreadyRevoked: false });
    // The exact-replay ledger answers the repeat without a second delete, so a
    // retried request on a flaky network is safe and still honest.
    for (const attempt of [2, 3]) {
      expect(await rpc(c, member(caller.user, caller.ids[0]), 'select public.revoke_my_session($1) r', [target]), `attempt ${attempt}`)
        .toMatchObject({ revoked: true, alreadyRevoked: true });
    }
    expect(await sessionCount(c, caller.user)).toBe(2);
    expect((await c.query('select count(*)::int n from private.member_session_revocations where user_id=$1', [caller.user])).rows[0].n).toBe(1);

    // The current session is ended by sign-out, not by the list's row action.
    await expect(rpc(c, member(caller.user, caller.ids[0]), 'select public.revoke_my_session($1) r', [await handleOf(c, caller.ids[0])]))
      .rejects.toMatchObject({ code: '22023' });
    expect(await sessionCount(c, caller.user)).toBe(2);
    // A handle that is not 64 hex is refused before any lookup.
    for (const malformed of ['', '  ', 'not-a-handle', `${'a'.repeat(63)}z`, 'A'.repeat(64)]) {
      await expect(rpc(c, member(caller.user, caller.ids[0]), 'select public.revoke_my_session($1) r', [malformed]))
        .rejects.toMatchObject({ code: '22023' });
    }
  });
});

live('a global sign-out closes every session of the account and only that account, idempotently', async () => {
  await withClient(async (c) => {
    const caller = await account(c, 3);
    const stranger = await account(c, 2, { administrator: true });

    const first = await rpc(c, member(caller.user, caller.ids[0]), 'select public.prepare_my_signout($1,$2) r', ['global', caller.user]);
    expect(first).toMatchObject({ scope: 'global', serverCleanupComplete: true });
    const closed = await barriers(c, caller.user);
    expect(closed).toHaveLength(3);
    expect(new Set(closed.map((row) => row.scope))).toEqual(new Set(['global']));
    const expected = [];
    for (const id of caller.ids) expected.push(await handleOf(c, id));
    expect(closed.map((row) => row.session_handle).sort()).toEqual(expected.sort());
    expect(await barriers(c, stranger.user)).toEqual([]);

    // A repeat is the same answer and the same rows: a member who presses the
    // confirmed action twice, or retries after a dropped reply, is safe.
    expect(await rpc(c, member(caller.user, caller.ids[0]), 'select public.prepare_my_signout($1,$2) r', ['global', caller.user]))
      .toMatchObject({ scope: 'global', serverCleanupComplete: true });
    expect(await barriers(c, caller.user)).toHaveLength(3);
    // An unknown scope is refused rather than guessed, while the two known
    // ones are read after a lower-case and a trim, so a client that sends
    // padding still gets the scope it asked for and never a silent downgrade.
    for (const scope of ['', '  ', 'everywhere', 'all', null]) {
      await expect(rpc(c, member(caller.user, caller.ids[0]), 'select public.prepare_my_signout($1,$2) r', [scope, caller.user]))
        .rejects.toMatchObject({ code: '22023' });
    }
    expect(await rpc(c, member(caller.user, caller.ids[0]), 'select public.prepare_my_signout($1,$2) r', [' GLOBAL ', caller.user]))
      .toMatchObject({ scope: 'global', serverCleanupComplete: true });
  });
});

live('every session RPC refuses the caller once its own session row is gone', async () => {
  await withClient(async (c) => {
    const caller = await account(c, 2);
    const handle = await handleOf(c, caller.ids[1]);
    // What GoTrue's user-wide logout leaves behind on the other device: an
    // access token that is still cryptographically valid for up to an hour,
    // with no auth.sessions row. The next server validation must refuse it,
    // which is what makes the second device re-authenticate instead of
    // reading protected content or refreshing into a new session.
    await c.query('delete from auth.sessions where user_id=$1', [caller.user]);

    for (const [sql, args] of [
      ['select public.list_my_sessions() r', []],
      ['select public.revoke_my_session($1) r', [handle]],
      ['select public.prepare_my_signout($1,$2) r', ['local', caller.user]],
      ['select public.prepare_my_signout($1,$2) r', ['global', caller.user]],
    ]) {
      await expect(rpc(c, member(caller.user, caller.ids[0]), sql, args)).rejects.toMatchObject({ code: '42501' });
    }
    // A revoked session cannot reach the definer helpers at all, so it cannot
    // re-derive a handle or read another session back into existence.
    await expect(rpc(c, member(caller.user, caller.ids[0]), 'select private.current_member_session_id() r'))
      .rejects.toMatchObject({ code: '42501' });
    expect(await barriers(c, caller.user)).toEqual([]);
  });
});

// BUG-UG-REVOKED-SESSION-TOKEN-STILL-SERVES-THREE-RPCS-20261103
// (#6886): these three member reads answered such a token with 200 while the
// RPCs above refused it. Each case first proves the same claim is served while
// its session row exists, so the refusal is the session check and nothing else.
async function servedThenRefusedAfterGlobalSignOut(c, sql, args, served) {
  const caller = await account(c, 2);
  served(await rpc(c, member(caller.user, caller.ids[0]), sql, args), caller);
  await c.query('delete from auth.sessions where user_id=$1', [caller.user]);
  await expect(rpc(c, member(caller.user, caller.ids[0]), sql, args))
    .rejects.toMatchObject({ code: '42501', message: 'member session required' });
}

live('the Home bootstrap refuses the caller once its own session row is gone', async () => {
  await withClient(async (c) => {
    await servedThenRefusedAfterGlobalSignOut(
      c,
      "select public.get_member_home_bootstrap(now() - interval '7 days', array['member_notifications','chapters']) r",
      [],
      (payload, caller) => {
        expect(payload.user_id).toBe(caller.user);
        expect(payload.chapters.map((row) => row.id)).toContain(caller.chapter);
      },
    );
  });
});

live('chapter memberships refuse the caller once its own session row is gone instead of answering []', async () => {
  await withClient(async (c) => {
    await servedThenRefusedAfterGlobalSignOut(c, 'select public.get_my_chapter_memberships() r', [], (rows, caller) => {
      expect(rows.map((row) => row.chapterId)).toEqual([caller.chapter]);
    });
  });
});

live('staff two-step standing refuses the caller once its own session row is gone', async () => {
  await withClient(async (c) => {
    await servedThenRefusedAfterGlobalSignOut(c, 'select public.get_staff_mfa_standing() r', [], (standing) => {
      expect(Object.keys(standing).sort()).toEqual(['assured', 'blocked', 'enrolled', 'holdsStaffRole', 'requireStaffMfa']);
    });
  });
});

live('refuses a session claim the caller does not own and a malformed one', async () => {
  await withClient(async (c) => {
    const caller = await account(c, 1);
    const stranger = await account(c, 1);

    // A forged session_id for someone else's live session, under the caller's
    // own subject: the resolver requires the row to be the caller's.
    await expect(rpc(c, member(caller.user, stranger.ids[0]), 'select public.list_my_sessions() r'))
      .rejects.toMatchObject({ code: '42501' });
    for (const claim of [{ sub: caller.user, role: 'authenticated', aal: 'aal1' }, member(caller.user, 'not-a-uuid')]) {
      await expect(rpc(c, claim, 'select public.list_my_sessions() r')).rejects.toMatchObject({ code: '42501' });
    }
    // The control: the caller's own claim still works.
    expect(await rpc(c, member(caller.user, caller.ids[0]), 'select public.list_my_sessions() r')).toHaveLength(1);
  });
});
