// @vitest-environment node
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.RUN_MEMBERSHIP_CARD_NONCE_DB_TESTS === "1" ? describe : describe.skip;
const nonce = () => randomBytes(16).toString("base64url");

async function connect(applicationName) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: applicationName,
  });
  await client.connect();
  return client;
}

// The server verifier calls the consumer with the backend service credential
// (SEC-UG-MEMBERSHIP-CARD-NONCE-SERVICE-ONLY-20261013), so the proof
// calls it exactly as PostgREST would for that key: role service_role with the
// matching JWT role claim.
async function consumeAs(role, client, value, surface = "saas", expiresAt = new Date(Date.now() + 60_000)) {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
    await client.query(`set local role ${role}`);
    const consumed = (await client.query(
      "select public.consume_membership_card_verification_nonce($1, $2, $3) as consumed",
      [value, surface, expiresAt],
    )).rows[0].consumed;
    await client.query("commit");
    return consumed;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

const consumeAsService = (...args) => consumeAs("service_role", ...args);

live("membership-card single-use nonce RPC", () => {
  let client;

  beforeAll(async () => {
    client = await connect("membership-card-single-use-proof");
  });

  beforeEach(async () => {
    await client.query("delete from private.membership_card_verification_nonces");
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("delete from private.membership_card_verification_nonces").catch(() => {});
    await client.end();
  });

  it("allows exactly one of two concurrent server-verifier consumers", async () => {
    const value = nonce();
    const callers = await Promise.all([
      connect("membership-card-concurrent-a"),
      connect("membership-card-concurrent-b"),
    ]);
    try {
      const results = await Promise.all(callers.map((caller) => consumeAsService(caller, value)));
      expect(results.sort()).toEqual([false, true]);
      expect((await client.query(
        "select nonce, origin_surface, expires_at from private.membership_card_verification_nonces",
      )).rows).toHaveLength(1);
    } finally {
      await Promise.all(callers.map((caller) => caller.end()));
    }
  });

  const rowCount = async () => (await client.query(
    "select count(*)::integer as count from private.membership_card_verification_nonces",
  )).rows[0].count;

  it("rejects expired and long-lived values and prunes at most 200 expired rows", async () => {
    expect(await consumeAsService(client, nonce(), "saas", new Date(Date.now() - 1_000))).toBe(false);
    expect(await rowCount()).toBe(0);

    // No caller may park a row for longer than
    // a real code can live, and a genuine first check must still win when the
    // route's clock runs a little ahead of the database's.
    expect(await consumeAsService(client, nonce(), "saas", new Date(Date.now() + 7 * 60_000))).toBe(false);
    expect(await rowCount()).toBe(0);
    expect(await consumeAsService(client, nonce(), "saas", new Date(Date.now() + 330_000))).toBe(true);
    expect(await rowCount()).toBe(1);

    const expired = Array.from({ length: 201 }, () => nonce());
    await client.query(`
      insert into private.membership_card_verification_nonces (nonce, origin_surface, expires_at)
      select value, 'saas', clock_timestamp() - interval '1 hour'
      from pg_catalog.unnest($1::text[]) value
    `, [expired]);
    expect(await consumeAsService(client, nonce())).toBe(true);
    expect((await client.query(`
      select count(*)::integer as count
      from private.membership_card_verification_nonces
      where expires_at <= clock_timestamp()
    `)).rows[0].count).toBe(1);
  });

  // A burst of verified codes can allocate rows faster than the 200-row prune
  // reclaims them. The RPC therefore refuses to insert at or above a fixed
  // ceiling of 20000 live rows, and recovers on its own as soon as pruning has
  // room again.
  const LIVE_NONCE_CAP = 20_000;
  const PRUNE_BATCH = 200;

  it("fails closed at the live-row allocation ceiling and recovers once pruning has room", async () => {
    // Park exactly the ceiling in unexpired rows. The padded decimal values
    // satisfy the table's 22-character opaque-nonce check and stay unique.
    await client.query(`
      insert into private.membership_card_verification_nonces (nonce, origin_surface, expires_at)
      select lpad(series::text, 22, '0'), 'saas', clock_timestamp() + interval '5 minutes'
      from generate_series(1, $1::integer) as series
    `, [LIVE_NONCE_CAP]);
    expect(await rowCount()).toBe(LIVE_NONCE_CAP);

    // A genuine, well-formed, in-window nonce is refused with the same false a
    // replay returns, and nothing is inserted, so the table cannot grow further.
    const refused = nonce();
    expect(await consumeAsService(client, refused)).toBe(false);
    expect(await rowCount()).toBe(LIVE_NONCE_CAP);
    expect((await client.query(
      "select 1 from private.membership_card_verification_nonces where nonce = $1",
      [refused],
    )).rowCount).toBe(0);

    // Expire exactly one prune batch. A single call then reclaims all of it and
    // the live population drops below the ceiling, so the next genuine nonce is
    // admitted without any operator action.
    await client.query(`
      update private.membership_card_verification_nonces
      set expires_at = clock_timestamp() - interval '1 hour'
      where nonce in (
        select nonce
        from private.membership_card_verification_nonces
        order by nonce
        limit $1::integer
      )
    `, [PRUNE_BATCH]);
    const admitted = nonce();
    expect(await consumeAsService(client, admitted)).toBe(true);
    expect((await client.query(
      "select 1 from private.membership_card_verification_nonces where nonce = $1",
      [admitted],
    )).rowCount).toBe(1);
    expect(await rowCount()).toBe(LIVE_NONCE_CAP - PRUNE_BATCH + 1);
    expect((await client.query(`
      select count(*)::integer as count
      from private.membership_card_verification_nonces
      where expires_at > clock_timestamp()
    `)).rows[0].count).toBe(LIVE_NONCE_CAP - PRUNE_BATCH + 1);
  });

  it("denies every direct table role through ACLs and forced RLS", async () => {
    const relation = (await client.query(`
      select relrowsecurity, relforcerowsecurity
      from pg_catalog.pg_class
      where oid = 'private.membership_card_verification_nonces'::regclass
    `)).rows[0];
    expect(relation).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    for (const role of ["anon", "authenticated", "service_role"]) {
      await client.query("begin");
      try {
        await client.query(`set local role ${role}`);
        await expect(client.query("select * from private.membership_card_verification_nonces"))
          .rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("rollback");
      }
    }
  });

  it("exposes only the minimal row, grants RPC execution only to service_role and refuses every other caller", async () => {
    const columns = (await client.query(`
      select column_name
      from information_schema.columns
      where table_schema = 'private'
        and table_name = 'membership_card_verification_nonces'
      order by ordinal_position
    `)).rows.map((row) => row.column_name);
    expect(columns).toEqual(["nonce", "origin_surface", "expires_at"]);

    const grants = (await client.query(`
      select
        pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        exists (
          select 1 from pg_catalog.aclexplode(p.proacl) acl where acl.grantee = 0
        ) as public
      from pg_catalog.pg_proc p
      where p.oid = 'public.consume_membership_card_verification_nonce(text,text,timestamptz)'::regprocedure
    `)).rows[0];
    expect(grants).toEqual({ anon: false, authenticated: false, service_role: true, public: false });

    // Neither the grant nor the in-body check lets anon or a signed-in member
    // reach the shared budget, and nothing is written on refusal.
    for (const role of ["anon", "authenticated"]) {
      await expect(consumeAs(role, client, nonce())).rejects.toMatchObject({ code: "42501" });
    }
    // The definer body itself fails closed when the role claim is not
    // service_role, even for a session role that holds EXECUTE.
    await client.query("begin");
    try {
      await client.query("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true)");
      await client.query("set local role service_role");
      await expect(client.query(
        "select public.consume_membership_card_verification_nonce($1, 'saas', $2)",
        [nonce(), new Date(Date.now() + 60_000)],
      )).rejects.toMatchObject({ code: "42501", message: "server verifier required" });
    } finally {
      await client.query("rollback");
    }
    expect(await rowCount()).toBe(0);
  });
});
