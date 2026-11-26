// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, migrationFiles, migrationNames, stripComments } from "./helpers/migration.js";

// PERF-UG-MESSAGE-REMINDERS-OWNER-INDEX-MISSING-20260921.
//
// public.member_message_reminders shipped in 20260812200000 with a single
// index, (remind_at, id) WHERE status = 'pending', which is the dispatch
// cron's. Every owner-scoped read — the RLS SELECT policy, the activity list,
// and the per-message correlated subquery inside list_steward_thread_messages
// — filters on owner_id, and none of them had an index to stand on.
//
// The live half (disposable loopback only) takes the EXPLAIN evidence the
// record asks for: the RLS read, the activity list and the per-message lookup
// each plan an index condition on owner_id. `npm run verify:db` re-reads
// pg_indexes against the entries added to scripts/db-contract.json. What the
// offline half does is the part that regresses silently: it derives the owner-scoped query shapes from the
// defining migration and then asserts, across the WHOLE migration directory,
// that an index exists for each one. It fails on the tree as it stood before
// the repair, and it fails again the day someone drops one of them.
const SOURCE = "20260812200000_unified_messaging_restoration";
const REPAIR = "20260925570000_message_reminders_owner_scope_indexes";

const contract = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../scripts/db-contract.json"), "utf8"),
);

// Every `create index ... on public.member_message_reminders (...)` in the
// tree, in apply order, as { name, columns: [...], partial: boolean }.
// Collected from all migrations rather than from the repair file alone: an
// index the repair adds and a later migration drops must not read as coverage.
function reminderIndexes() {
  const found = new Map();
  for (const { name: file, sql } of migrationFiles()) {
    const executable = stripComments(sql);
    const create =
      /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+on\s+(?:public\.)?member_message_reminders\s*\(([^)]*)\)([^;]*);/gi;
    for (const match of executable.matchAll(create)) {
      found.set(match[1], {
        name: match[1],
        file,
        columns: match[2].split(",").map((column) => column.trim().split(/\s+/)[0].toLowerCase()),
        partial: /\bwhere\b/i.test(match[3]),
      });
    }
    for (const match of executable.matchAll(/drop\s+index\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi)) {
      found.delete(match[1]);
    }
  }
  return [...found.values()];
}

describe("member_message_reminders owner-scoped reads are indexed", () => {
  it("applies the repair after the migration that defined the table", () => {
    const names = migrationNames();
    expect(names.indexOf(`${REPAIR}.sql`)).toBeGreaterThan(names.indexOf(`${SOURCE}.sql`));
  });

  // The three shapes, read out of the defining migration so the pin cannot
  // outlive the queries it claims to be covering. If one of these assertions
  // fails, the consumer moved and the index set below has to be re-derived
  // rather than the assertion relaxed.
  it("still has the three owner-scoped consumers this repair was written for", () => {
    const source = stripComments(loadMigrationSql(SOURCE)).replace(/\s+/g, " ");

    // 1. The RLS SELECT policy: a bare owner_id predicate, no status filter,
    //    so a direct PostgREST select cannot ride the partial due index.
    expect(source).toMatch(
      /create policy member_message_reminders_read on public\.member_message_reminders for select to authenticated using \(\s*owner_id = \(select auth\.uid\(\)\)/i,
    );

    // 2. The activity list: owner_id plus pending, ordered by remind_at.
    expect(fnBody(loadMigrationSql(SOURCE), "public.list_member_message_activity").replace(/\s+/g, " "))
      .toContain("where candidate.owner_id = caller and candidate.status = 'pending'");

    // 3. The worst of the three: a correlated scalar subquery evaluated once
    //    per message row of the steward page.
    expect(fnBody(loadMigrationSql(SOURCE), "public.list_steward_thread_messages").replace(/\s+/g, " "))
      .toContain(
        "where reminder.owner_id = caller and reminder.private_message_id = message.id and reminder.status = 'pending'",
      );
  });

  it("indexes the bare owner_id read predicate without a status filter", () => {
    const covering = reminderIndexes().filter((index) => index.columns[0] === "owner_id" && !index.partial);
    expect(
      covering.map((index) => index.name),
      "the RLS SELECT policy filters owner_id alone; a partial index cannot serve it",
    ).not.toHaveLength(0);
    expect(covering.some((index) => index.columns[1] === "remind_at" || index.columns[1] === "created_at")).toBe(true);
  });

  it("indexes the per-message correlated (owner_id, private_message_id) lookup", () => {
    const covering = reminderIndexes().filter(
      (index) => index.columns[0] === "owner_id" && index.columns[1] === "private_message_id",
    );
    expect(covering.map((index) => index.name)).not.toHaveLength(0);
  });

  // Each is an `on delete cascade` reference; the parent delete walks the
  // child side, and the Supabase advisor lints the uncovered key.
  it("covers all three cascading source foreign keys", () => {
    const leading = new Set(reminderIndexes().map((index) => index.columns[0]));
    for (const column of ["private_message_id", "channel_post_id", "task_message_id"]) {
      expect(leading, `${column} is an on-delete-cascade FK with no index`).toContain(column);
    }
  });

  it("re-pins every new index in the database contract", () => {
    for (const [name, defContains] of [
      ["member_message_reminders_owner_idx", ["USING btree (owner_id, remind_at DESC)"]],
      [
        "member_message_reminders_owner_message_idx",
        ["USING btree (owner_id, private_message_id)", "WHERE (status = 'pending'::text)"],
      ],
      ["member_message_reminders_private_message_idx", ["USING btree (private_message_id)"]],
      ["member_message_reminders_channel_post_idx", ["USING btree (channel_post_id)"]],
      ["member_message_reminders_task_message_idx", ["USING btree (task_message_id)"]],
    ]) {
      const entry = contract.indexes.find((candidate) => candidate.name === name);
      expect(entry, `${name} must be pinned so verify:db reads it out of the catalog`).toBeTruthy();
      // Bare relation name: the verifier strips the public schema.
      expect(entry.table).toBe("member_message_reminders");
      expect(entry.defContains).toEqual(defContains);
    }
  });

  it("adds indexes only — no data, grants, policies or routines", () => {
    const executable = stripComments(loadMigrationSql(REPAIR));
    expect(executable).toMatch(/^\s*begin;/i);
    expect(executable.trimEnd()).toMatch(/commit;$/i);
    for (const forbidden of [/\bgrant\b/i, /\brevoke\b/i, /\bcreate policy\b/i, /\bcreate\s+(or replace )?function\b/i, /\binsert\s+into\b/i, /\bupdate\s+public\./i, /\bdelete\s+from\b/i, /\balter table\b/i]) {
      expect(executable, `${forbidden} does not belong in an index-only migration`).not.toMatch(forbidden);
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member_message_reminders owner-scoped reads plan an owner_id index condition", () => {
  let client;
  const owner = randomUUID();
  const message = randomUUID();

  async function plan(statement, params = []) {
    const { rows } = await client.query(`explain (costs off) ${statement}`, params);
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "message-reminders-owner-index-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    // An empty table can favor the due-date index for LIMIT, even when the
    // owner index exists. Give the planner real owner selectivity, including
    // later reminders belonging to someone else that a due-index scan would
    // have to filter. The enclosing transaction rolls back every fixture.
    for (const [user, source, count] of [[owner, message, 3], [randomUUID(), randomUUID(), 2048]]) {
      const conversation = randomUUID();
      await client.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
      await client.query("insert into public.member_conversations(id,user_id,title) values ($1,$2,'Index proof')", [conversation, user]);
      await client.query(
        "insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,$3,'member','Member','Index proof')",
        [source, conversation, user],
      );
      await client.query(
        `insert into public.member_message_reminders(owner_id,source_kind,private_message_id,remind_at)
         select $1,'private',$2,now() + interval '1 day' + ordinal * interval '1 minute'
         from generate_series(1,$3::integer) as ordinal`,
        [user, source, count],
      );
    }
    await client.query("analyze public.member_message_reminders");
    // Keep the original index-path requirement for the RLS parameter too;
    // disabling sequential scans alone does not prevent the due-index plan.
    await client.query("set local enable_seqscan = off");
  });

  afterAll(async () => {
    try {
      await client?.query("rollback").catch(() => {});
      await client?.query("analyze public.member_message_reminders");
    } finally {
      await client?.end();
    }
  });

  it("serves the RLS read policy from an owner_id index", async () => {
    await client.query("savepoint rls_plan");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: owner, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const text = await plan("select id, remind_at from public.member_message_reminders");
    await client.query("rollback to savepoint rls_plan");
    expect(text).toContain("member_message_reminders_owner_idx");
    expect(text).toMatch(/Index Cond: \(owner_id = /);
  });

  it("serves the activity list's owner + pending shape from an owner_id index", async () => {
    const text = await plan(
      `select candidate.id from public.member_message_reminders candidate
        where candidate.owner_id = $1 and candidate.status = 'pending'
        order by candidate.remind_at desc limit 50`,
      [owner],
    );
    expect(text).toMatch(/Index Cond: \(owner_id = /);
    expect(text).not.toContain("member_message_reminders_due_idx");
  });

  it("serves the per-message correlated lookup from the pending (owner_id, private_message_id) index", async () => {
    const text = await plan(
      `select reminder.id from public.member_message_reminders reminder
        where reminder.owner_id = $1 and reminder.private_message_id = $2 and reminder.status = 'pending'`,
      [owner, message],
    );
    expect(text).toContain("member_message_reminders_owner_message_idx");
    expect(text).toMatch(/Index Cond: \(\(owner_id = .*\) AND \(private_message_id = /);
  });

  it("installs all five indexes on the live catalogue", async () => {
    const { rows } = await client.query(
      `select indexname from pg_indexes
        where schemaname = 'public' and tablename = 'member_message_reminders'
          and indexname like 'member_message_reminders_%_idx' order by indexname`,
    );
    expect(rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "member_message_reminders_channel_post_idx",
      "member_message_reminders_owner_idx",
      "member_message_reminders_owner_message_idx",
      "member_message_reminders_private_message_idx",
      "member_message_reminders_task_message_idx",
    ]));
  });
});
