// @vitest-environment node
//
// BUG-UG-BOUNDED-CLEANUPS-CAN-TOUCH-EVERY-ROW-IN-ONE-CALL-20261113
//
// Fourteen functions bounded a cleanup or batch with
//   delete/update ... where k in (select k ... limit n for update skip locked).
// When a table's statistics
// say it is empty, the planner runs that as a nested-loop semi-join with the
// locking subquery on the inner side and no Materialize, re-runs it for every
// outer row, and each re-run skips what the statement already removed and
// returns the next rows: one call of consume_member_invitation_accept_limit
// deleted 201 expired windows, not 200. Each
// statement now picks its keys once in a MATERIALIZED WITH query. (A WITH query
// that locks rows is never inlined, so the "with candidates as (... for update
// skip locked)" batches elsewhere already ran once; the last case keeps that so.)
//
// The static case holds every live function to that shape. The live cases set
// the failing plan condition on an owned disposable database (the table's
// statistics say it is empty while more than the limit qualify) and require
// one call to touch exactly the limit. Every live case is rolled back.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { unboundedLockingSubqueries } from "./helpers/bounded-cleanup.js";
import { migrationFiles, stripComments } from "./helpers/migration.js";

const REPLACED = [
  "public.consume_member_invitation_accept_limit",
  "public.consume_member_invitation_accept_limit_for_token",
  "public.consume_membership_card_verification_nonce",
  "public.begin_union_document_contribution",
  "public.request_public_interest_stop",
  "public.confirm_public_interest_stop",
  "public.stop_public_interest",
  "public.submit_join_request",
  "public.submit_organization_claim",
  "public.submit_public_event_rsvp",
  "public.reserve_password_signin_attempt",
  "public.reconcile_pending_account_deletions",
  "private.purge_expired_member_event_checkin_tokens",
  "private.purge_organization_claim_personal_data",
  "private.purge_expired_compass_training_samples",
];

// One pass over the migrations in apply order: each function's live body (its
// last declaration, cut at its own dollar-quote tag; a later drop retires it)
// and every function any generation declared with a limited locking subquery,
// so a later generation cannot bring the shape back unnoticed.
function functionGenerations() {
  const statement = /\b(create\s+(?:or\s+replace\s+)?function|drop\s+function\s+(?:if\s+exists\s+)?)\s*([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b/gi;
  const live = new Map();
  const everLocked = new Set();
  for (const { sql } of migrationFiles()) {
    const code = stripComments(sql);
    for (const match of code.matchAll(statement)) {
      const name = match[2].toLowerCase();
      if (/^drop/i.test(match[1])) {
        live.delete(name);
        continue;
      }
      const tag = /\bas\s+(\$[a-z_]*\$)/i.exec(code.slice(match.index));
      const open = match.index + tag.index + tag[0].length;
      const body = code.slice(match.index, code.indexOf(tag[1], open) + tag[1].length);
      live.set(name, body);
      if (unboundedLockingSubqueries(body).length) everLocked.add(name);
    }
  }
  return { live, everLocked: [...everLocked].sort() };
}

describe("bounded cleanups pick their rows once (static)", () => {
  it("leaves no live function with a limited locking subquery the planner can re-run", () => {
    const { live, everLocked } = functionGenerations();
    expect(everLocked).toEqual(expect.arrayContaining(REPLACED));
    const offenders = everLocked.flatMap((name) => (live.has(name)
      ? unboundedLockingSubqueries(live.get(name)).map((subquery) => `${name}: ${subquery}`)
      : []));
    expect(offenders).toEqual([]);
    for (const name of REPLACED) expect(live.get(name), name).toMatch(/\bas materialized \(/i);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const hex = (bytes) => randomBytes(bytes).toString("hex");
const nonce = () => randomBytes(16).toString("base64url").slice(0, 22);

live("bounded cleanups on a disposable database whose statistics say the table is empty", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "bounded-cleanup-limits-proof",
    });
    await client.connect();
    await client.query("set statement_timeout = '30s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function rolledBack(work) {
    await client.query("begin");
    try {
      await work();
    } finally {
      await client.query("rollback");
    }
  }

  // The plan condition: a page that holds no live row, analyzed, so the
  // planner estimates one row however many qualify by the time of the call.
  // One throwaway row guarantees a page; every row, including any another
  // file left, is deleted inside this transaction, which is rolled back.
  async function statisticsSayEmpty(table, insertOne) {
    await client.query(insertOne);
    await client.query(`delete from ${table}`);
    await client.query(`analyze ${table}`);
    const stats = (await client.query(
      "select reltuples, relpages from pg_catalog.pg_class where oid = $1::regclass", [table],
    )).rows[0];
    expect(stats).toMatchObject({ reltuples: 0 });
    expect(stats.relpages).toBeGreaterThanOrEqual(1);
  }

  async function asService(statement, args) {
    await client.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
    await client.query("set local role service_role");
    try {
      return (await client.query(statement, args)).rows[0];
    } finally {
      await client.query("reset role");
    }
  }

  const ACCEPT = "private.member_invitation_accept_limits";
  const seedAcceptWindows = (scopes) => client.query(
    `insert into ${ACCEPT} (scope_hash, window_started_at, request_count)
     select scope, clock_timestamp() - interval '16 minutes', 20 from pg_catalog.unnest($1::text[]) scope`,
    [scopes],
  );
  const closedLeft = async (scopes) => Number((await client.query(
    `select count(*)::integer as n from ${ACCEPT}
      where scope_hash = any($1::text[]) and window_started_at <= clock_timestamp() - interval '15 minutes'`,
    [scopes],
  )).rows[0].n);

  for (const [rpc, call] of [
    ["consume_member_invitation_accept_limit", "select public.consume_member_invitation_accept_limit($1) as value"],
    ["consume_member_invitation_accept_limit_for_token", "select public.consume_member_invitation_accept_limit_for_token($1, null) as value"],
  ]) {
    it(`${rpc} prunes at most 200 closed windows in one call`, async () => {
      await rolledBack(async () => {
        await statisticsSayEmpty(ACCEPT, `insert into ${ACCEPT} (scope_hash, window_started_at, request_count) values ('${hex(32)}', clock_timestamp(), 1)`);
        const scopes = Array.from({ length: 201 }, () => hex(32));
        await seedAcceptWindows(scopes);
        const result = await asService(call, [hex(32)]);
        expect(result.value).toMatchObject({ allowed: true });
        expect(await closedLeft(scopes)).toBe(1);
      });
    });
  }

  it("consume_membership_card_verification_nonce prunes at most 200 expired nonces in one call", async () => {
    const NONCES = "private.membership_card_verification_nonces";
    await rolledBack(async () => {
      await statisticsSayEmpty(NONCES, `insert into ${NONCES} (nonce, origin_surface, expires_at) values ('${nonce()}', 'saas', clock_timestamp() + interval '1 minute')`);
      const seeded = Array.from({ length: 201 }, nonce);
      await client.query(
        `insert into ${NONCES} (nonce, origin_surface, expires_at)
         select value, 'saas', clock_timestamp() - interval '1 minute' from pg_catalog.unnest($1::text[]) value`,
        [seeded],
      );
      const accepted = await asService(
        "select public.consume_membership_card_verification_nonce($1, 'saas', clock_timestamp() + interval '5 minutes') as value",
        [nonce()],
      );
      expect(accepted.value).toBe(true);
      expect(Number((await client.query(
        `select count(*)::integer as n from ${NONCES} where origin_surface = 'saas' and nonce = any($1::text[])`, [seeded],
      )).rows[0].n)).toBe(1);
    });
  });

  it("reserve_password_signin_attempt removes at most 200 stale reservations in one call", async () => {
    const RESERVATIONS = "private.password_signin_reservations";
    await rolledBack(async () => {
      const insertOld = (count) => client.query(
        `insert into ${RESERVATIONS} (network_hash, email_hash, network_window, email_window, created_at)
         select $1, $1, clock_timestamp(), clock_timestamp(), clock_timestamp() - interval '3 days'
         from pg_catalog.generate_series(1, $2) returning id`,
        [hex(32), count],
      );
      await statisticsSayEmpty(RESERVATIONS, `insert into ${RESERVATIONS} (network_hash, email_hash, network_window, email_window) values ('${hex(32)}', '${hex(32)}', clock_timestamp(), clock_timestamp())`);
      const seeded = (await insertOld(201)).rows.map((row) => row.id);
      const reserved = await asService(
        "select public.reserve_password_signin_attempt($1, 'ipv4:203.0.113.7') as value",
        [`bounded-cleanup-${hex(6)}@example.invalid`],
      );
      expect(reserved.value).toMatchObject({ allowed: true });
      expect(Number((await client.query(
        `select count(*)::integer as n from ${RESERVATIONS} where id = any($1::uuid[])`, [seeded],
      )).rows[0].n)).toBe(1);
    });
  });

  it("stop_public_interest prunes at most 200 stale submission limits in one call", async () => {
    const LIMITS = "private.public_interest_submission_limits";
    await rolledBack(async () => {
      await statisticsSayEmpty(LIMITS, `insert into ${LIMITS} (scope_hash, operation, window_started_at, request_count) values ('${hex(32)}', 'stop-network-15m', clock_timestamp(), 1)`);
      const scopes = Array.from({ length: 201 }, () => hex(32));
      await client.query(
        `insert into ${LIMITS} (scope_hash, operation, window_started_at, request_count)
         select scope, 'stop-network-15m', clock_timestamp() - interval '3 days', 1
         from pg_catalog.unnest($1::text[]) scope`, [scopes],
      );
      const stopped = await asService(
        "select public.stop_public_interest($1, 'en', 'public-landing', '', $2, $3) as value",
        [`bounded-cleanup-${hex(6)}@example.invalid`, hex(32), hex(32)],
      );
      expect(stopped.value).toEqual({ accepted: true });
      expect(Number((await client.query(
        `select count(*)::integer as n from ${LIMITS} where scope_hash = any($1::text[])`, [scopes],
      )).rows[0].n)).toBe(1);
    });
  });

  it("a WITH query that locks a limited set is picked once, as the retention, claim and lease batches rely on", async () => {
    await rolledBack(async () => {
      await statisticsSayEmpty(ACCEPT, `insert into ${ACCEPT} (scope_hash, window_started_at, request_count) values ('${hex(32)}', clock_timestamp(), 1)`);
      const scopes = Array.from({ length: 201 }, () => hex(32));
      await seedAcceptWindows(scopes);
      const removed = await client.query(
        `with candidates as (
           select candidate.ctid from ${ACCEPT} as candidate
            where candidate.scope_hash = any($1::text[])
              and candidate.window_started_at <= clock_timestamp() - interval '15 minutes'
            order by candidate.window_started_at, candidate.scope_hash
            limit 200
            for update skip locked
         )
         delete from ${ACCEPT} as target where target.ctid in (select candidates.ctid from candidates)`,
        [scopes],
      );
      expect(removed.rowCount).toBe(200);
      expect(await closedLeft(scopes)).toBe(1);
    });
  });
});
