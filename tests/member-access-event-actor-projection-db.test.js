// @vitest-environment node
//
// SEC-UG-MEMBER-ACCESS-EVENT-ACTOR-PROJECTION-20260921.
//
// public.list_my_access_history builds the subject's feed from a first-name
// label and the coarse actor_role and never selects actor_user_id. The birth
// migration nevertheless granted the subject SELECT on the whole table, and
// member_access_events_select_subject admits the subject for the whole row, so
// a direct read handed back the actor identity the RPC exists to withhold.
//
// The repair is a column-scoped grant. Two guards already generalise from the
// contract entry it adds — tests/migration-grant-sweep.test.js replays the
// whole GRANT/REVOKE chain, and `npm run verify:db` reads column_privileges off
// the deployed database — so the pins below are about THIS repair: the narrowing
// exists, it denies exactly the actor column, and the feed's own columns survive.
// The live half (disposable loopback only) reads as the subject, in one
// rolled-back transaction.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const NAME = "20260925570500_member_access_event_actor_projection";
const sql = stripComments(loadMigrationSql(NAME));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const squash = (text) => text.replace(/\s+/g, " ").trim();

// The columns list_my_access_history already projects to the subject.
const FEED_COLUMNS = [
  "action", "actor_role", "entity_id", "entity_type",
  "id", "occurred_at", "organization_id", "subject_user_id",
];

describe("member access event actor projection", () => {
  it("applies after the birth migration as one forward-only transaction", () => {
    const names = migrationNames();
    expect(names.indexOf(`${NAME}.sql`))
      .toBeGreaterThan(names.indexOf("20260828021500_mi1_member_access_history.sql"));
    expect(sql).toMatch(/^\s*begin;/);
    expect(sql).toMatch(/commit;\s*$/);
  });

  it("revokes the table-wide SELECT before re-granting the feed's columns", () => {
    // Order matters: a table-form REVOKE also clears the column privileges it
    // follows, so the grant has to come second or the feed reaches nothing.
    const revokedAt = sql.indexOf("revoke select on public.member_access_events from authenticated");
    const grantedAt = sql.indexOf("grant select (");
    expect(revokedAt).toBeGreaterThan(-1);
    expect(grantedAt).toBeGreaterThan(revokedAt);
    // The grant is written in column order; the set is what matters, so it is
    // compared as a set against the columns the feed projects.
    const granted = squash(sql).match(/grant select \(([^)]*)\) on public\.member_access_events to authenticated;/);
    expect(granted, "the re-grant names its columns").toBeTruthy();
    expect(granted[1].split(",").map((column) => column.trim()).sort()).toEqual(FEED_COLUMNS);
  });

  it("never re-grants the actor column and leaves the RPCs and policies alone", () => {
    expect(sql).not.toMatch(/\bactor_user_id\b/);
    // A repair that dropped the own-row policy or re-emitted either definer RPC
    // would be a different change than the record asks for.
    expect(sql).not.toMatch(/\b(create|drop)\s+policy\b/i);
    expect(sql).not.toMatch(/\bcreate\s+(or\s+replace\s+)?function\b/i);
  });

  it("pins the narrowed privilege in the deployed-database contract", () => {
    const table = contract.tableGrants.find(
      (entry) => entry.table === "public.member_access_events" && entry.role === "authenticated");
    expect(table.privileges, "the table-wide SELECT is gone").toBe("");

    const columns = contract.columnGrants.find(
      (entry) => entry.table === "public.member_access_events"
        && entry.role === "authenticated"
        && entry.privilege === "SELECT");
    expect(columns, "the column scope is what the live verifier replays").toBeTruthy();
    expect(columns.columns.split(",").map((column) => column.trim()).sort()).toEqual(FEED_COLUMNS);
    expect(columns.denied).toContain("actor_user_id");
  });

  it("keeps the anonymous deny row and the subject's own-row policy in the contract", () => {
    const anon = contract.tableGrants.find(
      (entry) => entry.table === "public.member_access_events" && entry.role === "anon");
    expect(anon.privileges).toBe("");
    const policy = contract.policies.find((entry) => entry.name === "member_access_events_select_subject");
    expect(policy.qualContains).toContain("subject_user_id = ( SELECT auth.uid() AS uid)");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the subject reads their access history without the actor's identity", () => {
  let client;
  const id = Object.fromEntries(["org", "subject", "actor", "session", "event"].map((key) => [key, randomUUID()]));
  const chapter = `access-actor-${id.org.slice(0, 8)}`;

  async function asSubject(statement, params = []) {
    await client.query("savepoint subject_read");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: id.subject, role: "authenticated", session_id: id.session, aal: "aal1",
      })]);
      await client.query("set local role authenticated");
      const result = await client.query(statement, params);
      await client.query("release savepoint subject_read");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint subject_read");
      return { code: error.code || "?", message: error.message || "" };
    }
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-access-event-actor-projection-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query(
      "insert into auth.users (id, email) values ($1, $3), ($2, $4)",
      [id.subject, id.actor, `${id.subject}@example.invalid`, `${id.actor}@example.invalid`],
    );
    await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [id.org, chapter, id.actor]);
    await client.query(
      "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9903)",
      [chapter, id.org],
    );
    for (const user of [id.subject, id.actor]) {
      await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [user, chapter]);
    }
    await client.query("update public.member_profiles set full_name = 'Actor Proof Steward' where id = $1", [id.actor]);
    await client.query(
      "insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal1')",
      [id.session, id.subject],
    );
    await client.query(
      `insert into public.member_access_events
         (id, organization_id, subject_user_id, actor_user_id, actor_role, action, entity_type, entity_id)
       values ($1, $2, $3, $4, 'steward', 'viewed_profile', 'member', $5)`,
      [id.event, id.org, id.subject, id.actor, id.subject],
    );
  });

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("refuses a direct read of actor_user_id, alone or through select *", async () => {
    for (const statement of [
      "select actor_user_id from public.member_access_events where id = $1",
      "select * from public.member_access_events where id = $1",
    ]) {
      const refused = await asSubject(statement, [id.event]);
      expect(refused.code, statement).toBe("42501");
    }
  });

  it("still returns the subject's own row through the feed's columns", async () => {
    const read = await asSubject(
      "select id, organization_id, subject_user_id, actor_role, action, entity_type, entity_id, occurred_at from public.member_access_events where id = $1",
      [id.event],
    );
    expect(read, read.message).toMatchObject({ code: "" });
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]).toMatchObject({ subject_user_id: id.subject, actor_role: "steward", action: "viewed_profile" });
  });

  it("keeps list_my_access_history's feed, which never carries the actor id", async () => {
    const feed = await asSubject("select public.list_my_access_history(30)::text feed");
    expect(feed, feed.message).toMatchObject({ code: "" });
    const text = feed.rows[0].feed;
    expect(text).toContain(id.event);
    expect(text).not.toContain(id.actor);
  });
});
