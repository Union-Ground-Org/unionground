// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.RUN_MEMBER_INVITATION_RATE_LIMIT_DB_TESTS === "1" ? describe : describe.skip;
const hashes = Array.from({ length: 202 }, (_, index) => createHash("sha256")
  .update(`member-invitation-rate-limit-pruning:${randomBytes(16).toString("hex")}:${index}`)
  .digest("hex"));
const expiredHashes = hashes.slice(0, 201);
const activeHash = hashes[201];
const sameScopeHash = createHash("sha256")
  .update(`member-invitation-rate-limit-same-scope:${randomBytes(16).toString("hex")}`)
  .digest("hex");
const crossScopeHashes = [`${"f".repeat(63)}e`, "f".repeat(64)];
const crossScopeFillers = Array.from({ length: 201 }, (_, index) => createHash("sha256")
  .update(`member-invitation-rate-limit-cross-scope:${randomBytes(16).toString("hex")}:${index}`)
  .digest("hex"));
const cleanupHashes = [...hashes, sameScopeHash, ...crossScopeFillers, ...crossScopeHashes];

async function connectClient(applicationName) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: applicationName,
  });
  await client.connect();
  return client;
}

async function beginServiceTransaction(client) {
  await client.query("begin");
  await client.query("set local deadlock_timeout = '50ms'");
  await client.query("set local statement_timeout = '5s'");
  await client.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
  await client.query("set local role service_role");
}

async function callAndCommit(scopeHash, applicationName) {
  const session = await connectClient(applicationName);
  try {
    await beginServiceTransaction(session);
    const value = (await session.query(
      "select public.consume_member_invitation_accept_limit($1) as value",
      [scopeHash],
    )).rows[0].value;
    await session.query("commit");
    return value;
  } catch (error) {
    await session.query("rollback").catch(() => {});
    throw error;
  } finally {
    await session.end();
  }
}

live("member invitation acceptance limiter pruning", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-invitation-rate-limit-proof",
    });
    await client.connect();
    await client.query(`
      insert into private.member_invitation_accept_limits (
        scope_hash, window_started_at, request_count
      )
      select scope_hash, clock_timestamp() - interval '16 minutes', 20
      from pg_catalog.unnest($1::text[]) scope_hash
    `, [expiredHashes]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(
      "delete from private.member_invitation_accept_limits where scope_hash = any($1::text[])",
      [cleanupHashes],
    ).catch(() => {});
    await client.end();
  });

  it("deletes at most 200 closed windows, including legacy-key rows", async () => {
    await client.query("begin");
    let result;
    try {
      await client.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
      await client.query("set local role service_role");
      result = (await client.query(
        "select public.consume_member_invitation_accept_limit($1) as value",
        [activeHash],
      )).rows[0].value;
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }

    const remaining = Number((await client.query(`
      select count(*)::integer as count
      from private.member_invitation_accept_limits
      where scope_hash = any($1::text[])
        and window_started_at <= clock_timestamp() - interval '15 minutes'
    `, [expiredHashes])).rows[0].count);
    expect(result).toMatchObject({ allowed: true, remaining: 19 });
    expect(remaining).toBe(1);
    expect((await client.query(
      "select request_count from private.member_invitation_accept_limits where scope_hash = $1",
      [activeHash],
    )).rows[0].request_count).toBe(1);

    await client.query(`
      insert into private.member_invitation_accept_limits (
        scope_hash, window_started_at, request_count
      ) values ($1, clock_timestamp() - interval '1 year', 20)
    `, [sameScopeHash]);
    const sameScope = await Promise.all([
      callAndCommit(sameScopeHash, "member-invitation-rate-limit-same-a"),
      callAndCommit(sameScopeHash, "member-invitation-rate-limit-same-b"),
    ]);
    expect(sameScope.map((value) => value.remaining).sort()).toEqual([18, 19]);
    expect(sameScope.every((value) => value.allowed === true)).toBe(true);

    expect(crossScopeFillers.every((hash) => hash < crossScopeHashes[0])).toBe(true);
    await client.query(`
      insert into private.member_invitation_accept_limits (
        scope_hash, window_started_at, request_count
      )
      select scope_hash, clock_timestamp() - interval '1 year', 20
      from pg_catalog.unnest($1::text[]) scope_hash
    `, [[...crossScopeFillers, ...crossScopeHashes]]);

    const crossSessions = await Promise.all([
      connectClient("member-invitation-rate-limit-cross-a"),
      connectClient("member-invitation-rate-limit-cross-b"),
    ]);
    try {
      await Promise.all(crossSessions.map(beginServiceTransaction));
      const calls = crossSessions.map((session, index) => session.query(
        "select public.consume_member_invitation_accept_limit($1) as value",
        [crossScopeHashes[index]],
      ));
      const settled = await Promise.allSettled(calls);
      expect(settled.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
      expect(settled.map((result) => result.value.rows[0].value)).toEqual([
        { allowed: true, remaining: 19 },
        { allowed: true, remaining: 19 },
      ]);
      await Promise.all(crossSessions.map((session) => session.query("commit")));
    } catch (error) {
      await Promise.all(crossSessions.map((session) => session.query("rollback").catch(() => {})));
      throw error;
    } finally {
      await Promise.all(crossSessions.map((session) => session.end()));
    }

    const crossScopeRemaining = Number((await client.query(`
      select count(*)::integer as count
      from private.member_invitation_accept_limits
      where scope_hash = any($1::text[])
        and window_started_at <= clock_timestamp() - interval '15 minutes'
    `, [[...crossScopeFillers, ...crossScopeHashes]])).rows[0].count);
    expect(crossScopeRemaining).toBe(1);
  }, 15_000);
});
