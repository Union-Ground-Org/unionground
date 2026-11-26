// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { reviewedGraph } from "../scripts/account-case-graph-inventory.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

// BUG-UG-AUTH-BOOKKEEPING-CASE-GRAPH-LOCK-20260908. A BEFORE STATEMENT
// shared lock precedes every exempt Auth tuple, while G_A enters the graph gate
// and then the exclusive bookkeeping lock before its first Auth tuple. Thus a
// waiter at either advisory edge owns no Auth tuple; later shared requests queue
// behind a waiting exclusive request, and gate-only work never conflicts with
// GoTrue. These local cases also prove the three bounded residuals: stock E/E
// tuple deadlocks, shared-to-exclusive upgrade deadlocks, and same-backend
// shared reacquisition during an exclusive-owning cascade.
const runLive = process.env.RUN_AUTH_BOOKKEEPING_LOCK_SCOPE_DB_TESTS === "1";
const live = runLive ? describe : describe.skip;
const connectionString = runLive
  ? assertDisposableProofUrl(process.env.DISPOSABLE_PROOF_URL ?? process.env.SUPABASE_DB_URL)
  : "";
const exemptTables = ["auth.sessions", "auth.refresh_tokens", "auth.one_time_tokens", "auth.mfa_amr_claims", "auth.mfa_challenges", "auth.identities"];
const coveredColumns = ["id", "instance_id", "aud", "role", "email", "phone", "deleted_at", "banned_until", "is_sso_user", "is_anonymous", "raw_user_meta_data", "email_change", "phone_change"];

async function connect(label) {
  const client = new pg.Client({ connectionString, ssl: false, application_name: `auth-bookkeeping-${label}` });
  await client.connect();
  await client.query("set statement_timeout = '10s'");
  await client.query("set lock_timeout = '1500ms'");
  return client;
}

async function lockShape(client) {
  return (await client.query(`select
    count(*) filter (where locktype='advisory' and classid=509 and objid=701)::int bookkeeping_count,
    coalesce(array_agg(mode order by mode) filter (where locktype='advisory' and classid=509 and objid=701),array[]::text[]) bookkeeping_modes,
    count(*) filter (where locktype='advisory' and classid=509 and objid=700)::int graph_gate_count
    from pg_locks where pid=pg_backend_pid() and granted`)).rows[0];
}

async function expectSharedOnly(client) {
  expect(await lockShape(client)).toEqual({ bookkeeping_count: 1, bookkeeping_modes: ["ShareLock"], graph_gate_count: 0 });
}

async function expectGateExclusive(client) {
  expect(await lockShape(client)).toMatchObject({ bookkeeping_count: 2, bookkeeping_modes: ["ExclusiveLock", "ShareLock"] });
  expect((await lockShape(client)).graph_gate_count).toBeGreaterThan(0);
}

async function createUser(client) {
  const id = randomUUID();
  const address = `${id}@${["example", "invalid"].join(".")}`;
  await client.query("begin");
  await client.query("insert into auth.users(id,email) values ($1,$2)", [id, address]);
  await client.query("commit");
  return id;
}

async function createSession(client, user, options = {}) {
  const id = randomUUID();
  await client.query(`insert into auth.sessions(id,user_id,aal,created_at,updated_at,oauth_client_id)
    values ($1,$2,'aal2',now(),now(),$3)`, [id, user, options.oauthClient ?? null]);
  return id;
}

async function createOauthClient(client, id) {
  await client.query(`insert into auth.oauth_clients(id,registration_type,redirect_uris,grant_types,client_name,token_endpoint_auth_method)
    values($1,'manual','http://127.0.0.1/callback','authorization_code','proof client','none')`, [id]);
  return id;
}

async function cleanupUser(client, user) {
  await client.query("rollback").catch(() => {});
  await client.query("begin");
  await client.query("delete from auth.users where id=$1", [user]);
  await client.query("commit");
}

async function waitUntilBlocked(observer, pid) {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    if ((await observer.query("select cardinality(pg_blocking_pids($1)) > 0 blocked", [pid])).rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("proof waiter never reached its blocking edge");
}

async function authenticate(client, user, session) {
  await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", session_id: session })]);
  await client.query("set local role authenticated");
}

async function expectOneDeadlock(firstClient, firstQuery, secondClient, secondQuery) {
  const errors = [];
  const run = async (client, query) => {
    try { await client.query(query); }
    catch (error) { errors.push(error); await client.query("rollback").catch(() => {}); }
  };
  const started = performance.now();
  await Promise.all([run(firstClient, firstQuery), run(secondClient, secondQuery)]);
  expect(errors.filter(error => error.code === "40P01")).toHaveLength(1);
  expect(errors.filter(error => error.code === "55P03")).toHaveLength(0);
  expect(performance.now() - started).toBeLessThan(runnerTimeout(2500));
}

live("Auth bookkeeping shared/exclusive lock protocol", () => {
  it("gives every exempt auth.users update exactly one shared bookkeeping lock and no graph gate", async () => {
    const client = await connect("users-exempt"); const user = await createUser(client);
    try {
      for (const [statement, values] of [
        ["update auth.users set recovery_token=$2,recovery_sent_at=now(),updated_at=now() where id=$1", [user, randomUUID()]],
        ["update auth.users set raw_app_meta_data=jsonb_build_object('proof',true) where id=$1", [user]],
        ["update auth.users set last_sign_in_at=now() where id=$1", [user]],
        ["update auth.users set encrypted_password='proof-only' where id=$1", [user]],
      ]) {
        await client.query("begin"); await client.query(statement, values); await expectSharedOnly(client); await client.query("rollback");
      }
    } finally { await cleanupUser(client, user).catch(() => {}); await client.end(); }
  });

  it("gives every standalone child write only the shared bookkeeping lock", async () => {
    const client = await connect("children"); const user = await createUser(client);
    const session = randomUUID(); const factor = randomUUID(); const identity = randomUUID();
    try {
      await client.query("begin");
      await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','unverified',now(),now())", [factor, user]);
      await client.query("commit");
      await client.query("begin");
      await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, user]);
      await client.query("insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,updated_at) values($1,$2,'password',now(),now())", [randomUUID(), session]);
      await client.query("insert into auth.refresh_tokens(token,user_id,session_id,created_at,updated_at) values($1,$2,$3,now(),now())", [randomUUID(), user, session]);
      await client.query("insert into auth.one_time_tokens(id,user_id,token_type,token_hash,relates_to) values($1,$2,'recovery_token',$3,$4)", [randomUUID(), user, randomUUID(), user]);
      await client.query("insert into auth.mfa_challenges(id,factor_id,created_at,ip_address) values($1,$2,now(),'127.0.0.1')", [randomUUID(), factor]);
      await client.query("insert into auth.identities(id,provider_id,user_id,identity_data,provider,created_at,updated_at) values($1,$2,$3::uuid,jsonb_build_object('sub',($3::uuid)::text),'proof',now(),now())", [identity, user, user]);
      await client.query("update auth.sessions set refreshed_at=now() where id=$1", [session]);
      await client.query("update auth.refresh_tokens set revoked=true where session_id=$1", [session]);
      await client.query("update auth.identities set last_sign_in_at=now() where id=$1", [identity]);
      await client.query("delete from auth.one_time_tokens where user_id=$1", [user]);
      await client.query("delete from auth.sessions where id=$1", [session]);
      await expectSharedOnly(client); await client.query("rollback");
    } finally { await cleanupUser(client, user).catch(() => {}); await client.end(); }
  });

  it("gives covered auth.users insert, delete and identity updates the gate plus exclusive bookkeeping lock", async () => {
    const client = await connect("users-covered"); const user = await createUser(client);
    try {
      const inserted = randomUUID();
      for (const [statement, values] of [
        ["insert into auth.users(id,email) values($1,$2)", [inserted, `${inserted}@${["example", "invalid"].join(".")}`]],
        ["delete from auth.users where id=$1", [user]],
        ["update auth.users set email=$2 where id=$1", [user, `${randomUUID()}@${["example", "invalid"].join(".")}`]],
        ["update auth.users set raw_user_meta_data=jsonb_build_object('proof',true) where id=$1", [user]],
        ["update auth.users set banned_until=now()+interval '1 minute' where id=$1", [user]],
      ]) {
        await client.query("begin"); await client.query(statement, values); await expectGateExclusive(client); await client.query("rollback");
      }
    } finally { await cleanupUser(client, user).catch(() => {}); await client.end(); }
  });

  it("runs a real magic-link sequence while another transaction holds only the graph gate", async () => {
    const gate = await connect("magic-gate"); const gotrue = await connect("magic-gotrue"); const user = await createUser(gate);
    try {
      await gate.query("begin"); await gate.query("select private.lock_case_graph(array[$1::uuid],array[]::uuid[])", [user]);
      const started = performance.now(); await gotrue.query("begin");
      await gotrue.query("delete from auth.one_time_tokens where user_id=$1", [user]);
      await gotrue.query("update auth.users set recovery_token=$2,recovery_sent_at=now(),updated_at=now() where id=$1", [user, randomUUID()]);
      await gotrue.query("insert into auth.one_time_tokens(id,user_id,token_type,token_hash,relates_to) values($1,$2,'recovery_token',$3,$4)", [randomUUID(), user, randomUUID(), user]);
      await expectSharedOnly(gotrue); await gotrue.query("commit");
      expect(performance.now() - started).toBeLessThan(runnerTimeout(1400));
      await gate.query("delete from auth.users where id=$1", [user]); await gate.query("rollback");
    } finally { await cleanupUser(gate, user).catch(() => {}); await gotrue.end(); await gate.end(); }
  });

  it("runs a real refresh sequence while another transaction holds only the graph gate", async () => {
    const gate = await connect("refresh-gate"); const gotrue = await connect("refresh-gotrue"); const user = await createUser(gate);
    try {
      await gate.query("begin"); await createSession(gate, user); await gate.query("commit");
      const visible = (await gate.query("select id from auth.sessions where user_id=$1 order by created_at desc limit 1", [user])).rows[0].id;
      await gate.query("begin"); await gate.query("select private.lock_case_graph(array[$1::uuid],array[]::uuid[])", [user]);
      const started = performance.now(); await gotrue.query("begin");
      await gotrue.query("update auth.sessions set refreshed_at=now(),updated_at=now() where id=$1", [visible]);
      await gotrue.query("insert into auth.refresh_tokens(token,user_id,session_id,created_at,updated_at) values($1,$2,$3,now(),now())", [randomUUID(), user, visible]);
      await gotrue.query("update auth.users set last_sign_in_at=now(),updated_at=now() where id=$1", [user]);
      await expectSharedOnly(gotrue); await gotrue.query("commit");
      expect(performance.now() - started).toBeLessThan(runnerTimeout(1400)); await gate.query("rollback");
    } finally { await cleanupUser(gate, user).catch(() => {}); await gotrue.end(); await gate.end(); }
  });

  it("lets session-first E finish before a gated account deletion in both child statements", async () => {
    const e = await connect("session-first-e"); const g = await connect("session-first-g"); const observer = await connect("session-first-observer"); const user = await createUser(e);
    try {
      await e.query("begin"); const session = await createSession(e, user); await e.query("commit");
      await e.query("begin"); await e.query("update auth.sessions set refreshed_at=now() where id=$1", [session]);
      await g.query("begin"); const pid = (await g.query("select pg_backend_pid() pid")).rows[0].pid;
      const deletion = g.query("delete from auth.users where id=$1", [user]); deletion.catch(() => {});
      await waitUntilBlocked(observer, pid);
      await e.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [randomUUID(), user]);
      await e.query("commit"); await expect(deletion).resolves.toMatchObject({ rowCount: 1 }); await g.query("rollback");
    } finally { await cleanupUser(e, user).catch(() => {}); await observer.end(); await g.end(); await e.end(); }
  });

  it("blocks deletion-first E at shared acquisition, then yields a zero-row update after deletion commits", async () => {
    const g = await connect("delete-first-g"); const e = await connect("delete-first-e"); const user = await createUser(g);
    try {
      await g.query("begin"); const session = await createSession(g, user); await g.query("commit");
      await g.query("begin"); await g.query("delete from auth.users where id=$1", [user]);
      await e.query("begin"); await expect(e.query("update auth.sessions set refreshed_at=now() where id=$1", [session])).rejects.toMatchObject({ code: "55P03" });
      await e.query("rollback"); await g.query("commit");
      await e.query("begin"); expect((await e.query("update auth.sessions set refreshed_at=now() where id=$1", [session])).rowCount).toBe(0); await e.query("commit");
    } finally { await e.query("rollback").catch(() => {}); await g.query("rollback").catch(() => {}); await e.end(); await g.end(); }
  });

  async function proveRevokeSibling(child) {
      const e = await connect(`${child}-e`); const g = await connect(`${child}-g`); const observer = await connect(`${child}-observer`); const user = await createUser(e);
      try {
        await e.query("begin"); const current = await createSession(e, user); const target = await createSession(e, user);
        if (child === "refresh_tokens") await e.query("insert into auth.refresh_tokens(token,user_id,session_id,created_at,updated_at) values($1,$2,$3,now(),now())", [randomUUID(), user, target]);
        else await e.query("insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,updated_at) values($1,$2,'password',now(),now())", [randomUUID(), target]);
        await e.query("commit");
        await e.query("begin");
        if (child === "refresh_tokens") await e.query("update auth.refresh_tokens set revoked=false where session_id=$1", [target]);
        else await e.query("update auth.mfa_amr_claims set updated_at=now() where session_id=$1", [target]);
        const targetHandle = (await e.query("select private.member_session_handle($1) handle", [target])).rows[0].handle;
        await g.query("begin"); await authenticate(g, user, current); const pid = (await g.query("select pg_backend_pid() pid")).rows[0].pid;
        const revoke = g.query("select public.revoke_my_session($1)", [targetHandle]); revoke.catch(() => {});
        await waitUntilBlocked(observer, pid);
        if (child === "refresh_tokens") await e.query("insert into auth.refresh_tokens(token,user_id,session_id,created_at,updated_at) values($1,$2,$3,now(),now())", [randomUUID(), user, target]);
        else await e.query("insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,updated_at) values($1,$2,'totp',now(),now())", [randomUUID(), target]);
        await e.query("commit"); await expect(revoke).resolves.toMatchObject({ rowCount: 1 }); await g.query("commit");
      } finally { await cleanupUser(e, user).catch(() => {}); await observer.end(); await g.end(); await e.end(); }
  }

  it("serializes revoke_my_session behind an open refresh_tokens writer without 40P01", async () => {
    await proveRevokeSibling("refresh_tokens");
  });

  it("serializes revoke_my_session behind an open mfa_amr_claims writer without 40P01", async () => {
    await proveRevokeSibling("mfa_amr_claims");
  });

  it("serializes oauth_clients deletion before its session cascade, holding the graph gate as well", async () => {
    const e = await connect("oauth-e"); const deleter = await connect("oauth-delete"); const observer = await connect("oauth-observer"); const user = await createUser(e); const clientId = randomUUID();
    try {
      await e.query("begin"); await createOauthClient(e, clientId);
      const session = await createSession(e, user, { oauthClient: clientId }); await e.query("commit");
      await e.query("begin"); await e.query("update auth.sessions set refreshed_at=now() where id=$1", [session]);
      await deleter.query("begin"); const pid = (await deleter.query("select pg_backend_pid() pid")).rows[0].pid;
      const deletion = deleter.query("delete from auth.oauth_clients where id=$1", [clientId]); deletion.catch(() => {}); await waitUntilBlocked(observer, pid);
      await e.query(`insert into auth.sessions(id,user_id,aal,created_at,updated_at,oauth_client_id) values($1,$2,'aal2',now(),now(),$3)`, [randomUUID(), user, clientId]);
      await e.query("commit"); await expect(deletion).resolves.toMatchObject({ rowCount: 1 });
      // The cascade reaches auth.oauth_authorizations and auth.oauth_consents,
      // which keep a00_case_graph_lock, so the deleter takes the graph gate in
      // its own a00 trigger before the exclusive bookkeeping lock in a01.
      expect(await lockShape(deleter)).toMatchObject({ bookkeeping_modes: ["ExclusiveLock", "ShareLock"] });
      expect((await lockShape(deleter)).graph_gate_count).toBeGreaterThan(0);
      await deleter.query("rollback");
    } finally { await cleanupUser(e, user).catch(() => {}); await e.query("delete from auth.oauth_clients where id=$1", [clientId]).catch(() => {}); await observer.end(); await deleter.end(); await e.end(); }
  });

  // The oauth_clients DELETE trigger acquires the exclusive bookkeeping lock,
  // and its ON DELETE CASCADE reaches auth.oauth_authorizations and
  // auth.oauth_consents, whose a00_case_graph_lock enters the graph gate. If
  // the exclusive lock were taken before the gate, a deleter blocked on the
  // gate would own (509, 701) while a covered auth.users statement that already
  // holds the gate waits for that very lock inside its own a00 trigger, and the
  // two cycle with 40P01. Both interleavings are driven here: the covered
  // statement's transaction holds the gate first, then the deleter's does.
  it("never cycles between an oauth_clients delete and a covered auth.users statement in either order", async () => {
    for (const order of ["gate-holder-first", "deleter-first"]) {
      const covered = await connect(`oauth-cycle-covered-${order}`);
      const deleter = await connect(`oauth-cycle-deleter-${order}`);
      const observer = await connect(`oauth-cycle-observer-${order}`);
      const user = await createUser(covered); const clientId = randomUUID();
      try {
        for (const client of [covered, deleter]) await client.query("set lock_timeout = '6s'");
        await covered.query("begin"); await createOauthClient(covered, clientId);
        await createSession(covered, user, { oauthClient: clientId });
        await covered.query(`insert into auth.oauth_consents(id,user_id,client_id,scopes,granted_at)
          values($1,$2,$3,'openid',now())`, [randomUUID(), user, clientId]);
        await covered.query("commit");
        const address = `${randomUUID()}@${["example", "invalid"].join(".")}`;
        if (order === "gate-holder-first") {
          // Exactly the state a00_case_graph_lock leaves a covered auth.users
          // statement in between its two acquisitions: graph gate, no (509, 701).
          await covered.query("begin");
          await covered.query("select private.lock_case_graph(array[]::uuid[],array[]::uuid[])");
          expect(await lockShape(covered)).toMatchObject({ bookkeeping_count: 0, graph_gate_count: 1 });
          await deleter.query("begin");
          const pid = (await deleter.query("select pg_backend_pid() pid")).rows[0].pid;
          const deletion = deleter.query("delete from auth.oauth_clients where id=$1", [clientId]); deletion.catch(() => {});
          await waitUntilBlocked(observer, pid);
          // The blocked deleter must own no bookkeeping lock at all: it is
          // waiting at the graph gate, which is the only safe place to wait.
          expect((await observer.query(`select count(*) filter (where locktype='advisory' and classid=509 and objid=701)::int bookkeeping,
            count(*) filter (where locktype='advisory' and classid=509 and objid=700)::int gate
            from pg_locks where pid=$1 and granted`, [pid])).rows[0]).toEqual({ bookkeeping: 0, gate: 0 });
          await covered.query("update auth.users set email=$2 where id=$1", [user, address]);
          await expectGateExclusive(covered);
          await covered.query("commit");
          await expect(deletion).resolves.toMatchObject({ rowCount: 1 });
          expect((await lockShape(deleter)).graph_gate_count).toBeGreaterThan(0);
          await deleter.query("rollback");
        } else {
          await deleter.query("begin");
          expect((await deleter.query("delete from auth.oauth_clients where id=$1", [clientId])).rowCount).toBe(1);
          expect(await lockShape(deleter)).toMatchObject({ bookkeeping_modes: ["ExclusiveLock", "ShareLock"] });
          expect((await lockShape(deleter)).graph_gate_count).toBeGreaterThan(0);
          await covered.query("begin");
          const pid = (await covered.query("select pg_backend_pid() pid")).rows[0].pid;
          const update = covered.query("update auth.users set email=$2 where id=$1", [user, address]); update.catch(() => {});
          await waitUntilBlocked(observer, pid);
          await deleter.query("rollback");
          await expect(update).resolves.toMatchObject({ rowCount: 1 });
          await expectGateExclusive(covered);
          await covered.query("rollback");
        }
      } finally {
        for (const client of [covered, deleter]) await client.query("rollback").catch(() => {});
        await cleanupUser(covered, user).catch(() => {});
        await covered.query("delete from auth.oauth_clients where id=$1", [clientId]).catch(() => {});
        await observer.end(); await deleter.end(); await covered.end();
      }
    }
  }, 60_000);

  it("demonstrates the bounded stock E-vs-E tuple deadlock with exactly one 40P01", async () => {
    const a = await connect("ee-a"); const b = await connect("ee-b"); const user = await createUser(a);
    try {
      expect((await a.query("show deadlock_timeout")).rows[0].deadlock_timeout).toBe("1s");
      await a.query("begin"); const session = await createSession(a, user); await a.query("commit");
      await a.query("begin"); await b.query("begin");
      await a.query("update auth.sessions set refreshed_at=now() where id=$1", [session]);
      await b.query("update auth.users set recovery_token=$2 where id=$1", [user, randomUUID()]);
      await expectOneDeadlock(a, { text: "update auth.users set recovery_token=$2 where id=$1", values: [user, randomUUID()] }, b,
        { text: "update auth.sessions set refreshed_at=now() where id=$1", values: [session] });
    } finally { await a.query("rollback").catch(() => {}); await b.query("rollback").catch(() => {}); await cleanupUser(a, user).catch(() => {}); await b.end(); await a.end(); }
  });

  it("demonstrates the bounded shared-to-exclusive upgrade residual with exactly one 40P01", async () => {
    const a = await connect("upgrade-a"); const b = await connect("upgrade-b"); const first = await createUser(a); const second = await createUser(a);
    try {
      await a.query("begin"); await b.query("begin");
      await a.query("update auth.users set recovery_token=$2 where id=$1", [first, randomUUID()]);
      await b.query("update auth.users set recovery_token=$2 where id=$1", [second, randomUUID()]);
      await expectOneDeadlock(a, { text: "update auth.users set email=$2 where id=$1", values: [first, `${randomUUID()}@${["example", "invalid"].join(".")}`] }, b,
        { text: "update auth.users set email=$2 where id=$1", values: [second, `${randomUUID()}@${["example", "invalid"].join(".")}`] });
    } finally { await a.query("rollback").catch(() => {}); await b.query("rollback").catch(() => {}); await cleanupUser(a, first).catch(() => {}); await cleanupUser(a, second).catch(() => {}); await b.end(); await a.end(); }
  });

  it("re-enters shared locks during an exclusive-owning full Auth cascade and leaves review issues empty", async () => {
    const client = await connect("cascade"); const user = await createUser(client); const session = randomUUID(); const factor = randomUUID();
    try {
      await client.query("begin");
      await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, user]);
      await client.query("insert into auth.refresh_tokens(token,user_id,session_id,created_at,updated_at) values($1,$2,$3,now(),now())", [randomUUID(), user, session]);
      await client.query("insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,updated_at) values($1,$2,'password',now(),now())", [randomUUID(), session]);
      await client.query("insert into auth.one_time_tokens(id,user_id,token_type,token_hash,relates_to) values($1,$2,'recovery_token',$3,$4)", [randomUUID(), user, randomUUID(), user]);
      await client.query("insert into auth.identities(id,provider_id,user_id,identity_data,provider,created_at,updated_at) values($1,$2,$3::uuid,jsonb_build_object('sub',($3::uuid)::text),'proof',now(),now())", [randomUUID(), user, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','unverified',now(),now())", [factor, user]);
      await client.query("insert into auth.mfa_challenges(id,factor_id,created_at,ip_address) values($1,$2,now(),'127.0.0.1')", [randomUUID(), factor]);
      await client.query("commit");
      await client.query("begin"); const started = performance.now(); await client.query("delete from auth.users where id=$1", [user]);
      expect(performance.now() - started).toBeLessThan(runnerTimeout(1400)); await expectGateExclusive(client);
      expect((await client.query("select count(*)::int n from auth.sessions where user_id=$1", [user])).rows[0].n).toBe(0);
      await client.query("rollback");
      await client.query("set statement_timeout = '60s'");
      expect((await client.query("select count(*)::int n from private.account_lifecycle_referential_action_trigger_issues()")).rows[0].n).toBe(0);
    } finally { await client.query("set statement_timeout = '10s'").catch(() => {}); await cleanupUser(client, user).catch(() => {}); await client.end(); }
  }, 60_000);

  it("matches the complete installed trigger, tgattr, function-source and unchanged-relation inventory", async () => {
    const client = await connect("inventory");
    try {
      const { rows } = await client.query(`select n.nspname||'.'||c.relname name,
        max(t.tgtype) filter(where t.tgname='a00_case_graph_lock')::int a00,
        max(t.tgtype) filter(where t.tgname='z99_case_graph_keys')::int z99,
        count(*) filter(where t.tgname='a01_auth_bookkeeping_shared')::int shared
        from unnest($1::regclass[]) relation(oid) join pg_class c on c.oid=relation.oid
        join pg_namespace n on n.oid=c.relnamespace left join pg_trigger t on t.tgrelid=c.oid and not t.tgisinternal
        group by 1 order by 1`, [reviewedGraph.tables]);
      for (const row of rows) {
        if (exemptTables.includes(row.name)) expect(row).toMatchObject({ a00: null, z99: null, shared: 1 });
        else if (row.name !== "private.mi1_w2_operation_receipts") expect(row).toMatchObject({ a00: 30, z99: 31, shared: row.name === "auth.users" ? 1 : 0 });
      }
      const attrs = (await client.query(`select pg_catalog.array_agg(a.attname::text order by binding.ordinality) columns
        from pg_trigger t cross join lateral pg_catalog.unnest(t.tgattr::smallint[]) with ordinality binding(attnum,ordinality)
        join pg_attribute a on a.attrelid=t.tgrelid and a.attnum=binding.attnum
        where t.tgrelid='auth.users'::regclass and t.tgname='a00_case_graph_lock'`)).rows[0].columns;
      expect(attrs).toEqual(coveredColumns);
      const source = (await client.query("select prosrc from pg_proc where oid='public.revoke_my_session(text)'::regprocedure")).rows[0].prosrc;
      expect(source.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBeLessThan(source.indexOf("perform pg_catalog.pg_advisory_xact_lock(509, 701);"));
      expect(source.indexOf("perform pg_catalog.pg_advisory_xact_lock(509, 701);")).toBeLessThan(source.indexOf("from auth.sessions s"));
      const oauth = (await client.query(`select tgname,tgtype::int type,tgenabled,
        tgfoid::regprocedure::text fn
        from pg_trigger where tgrelid='auth.oauth_clients'::regclass and not tgisinternal order by tgname`)).rows;
      expect(oauth).toEqual([
        { tgname: "a00_case_graph_lock", type: 10, tgenabled: "O", fn: "private.lock_case_graph_statement()" },
        { tgname: "a01_auth_bookkeeping_exclusive", type: 10, tgenabled: "O", fn: "private.lock_auth_bookkeeping_exclusive()" },
      ]);
    } finally { await client.end(); }
  });
});
