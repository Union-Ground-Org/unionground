// @vitest-environment node
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reviewedForeignKeys } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, migrationFiles, migrationNames, stripComments } from "./helpers/migration.js";

// PERF-UG-CASEWORK-CASE-GRAPH-UNINDEXED-FOREIGN-KEYS-20260920.
//
// Eight casework child tables linked to public.member_cases through
// (case_id, organization_id, chapter_id) with no index leading on the case
// column, and private.casework_record_versions.actor (an auth.users link that
// account deletion nulls) had no index at all. 20260925580000 adds one index
// per link.
//
// The offline guard does not list today's tables. It reads every casework link
// into public.member_cases from the reviewed FK catalogue
// (scripts/account-case-graph-fks.json, which tests/account-case-graph-lock-
// inventory.test.js keeps bound to the migration chain), so a NEW casework
// child table that joins the case graph without a case-leading index fails
// here too. The live half (disposable loopback only) re-reads the same fact
// from pg_constraint/pg_index and takes the EXPLAIN evidence at volume for the
// macro replay guard and the paged per-case audit read.
const REPAIR = "20260925580000_casework_case_graph_case_indexes";

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const NEW_INDEXES = [
  ["casework_audit_events", "casework_audit_events_case_created_idx", ["USING btree (case_id, created_at DESC, id DESC)", "WHERE (case_id IS NOT NULL)"]],
  ["casework_deadlines", "casework_deadlines_case_due_idx", ["USING btree (case_id, due_at)"]],
  ["casework_alerts", "casework_alerts_case_created_idx", ["USING btree (case_id, created_at DESC)"]],
  ["casework_reminders", "casework_reminders_case_remind_idx", ["USING btree (case_id, remind_at)"]],
  ["casework_management_entries", "casework_management_entries_case_occurred_idx", ["USING btree (case_id, occurred_at DESC)", "WHERE (case_id IS NOT NULL)"]],
  ["casework_retaliation_reports", "casework_retaliation_reports_case_idx", ["USING btree (case_id)", "WHERE (case_id IS NOT NULL)"]],
  ["casework_intake_drafts", "casework_intake_drafts_case_idx", ["USING btree (case_id)", "WHERE (case_id IS NOT NULL)"]],
  ["casework_entity_links", "casework_entity_links_target_idx", ["USING btree (target_case_id, created_at)", "WHERE (target_case_id IS NOT NULL)"]],
  ["private.casework_record_versions", "casework_record_versions_actor_idx", ["USING btree (actor)", "WHERE (actor IS NOT NULL)"]],
];

const qualified = (table) => (table.includes(".") ? table : `public.${table}`);
const columnsOf = (entry) => entry.columns.replace(/[{}]/g, "").split(",");

// Every index created on a casework table across the migration chain, in apply
// order, keyed by name: { table, leading }. A later drop removes it, so an
// index this repair adds and a later migration drops does not read as coverage.
function caseworkIndexes() {
  const found = new Map();
  const create =
    /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+on\s+(?:only\s+)?((?:public|private)\.)?(casework_[a-z0-9_]+)\s*(?:using\s+\w+\s*)?\(\s*([a-z0-9_]+)/gi;
  for (const { sql } of migrationFiles()) {
    const executable = stripComments(sql);
    for (const match of executable.matchAll(create)) {
      const schema = (match[2] ?? "public.").toLowerCase();
      found.set(match[1].toLowerCase(), { table: `${schema}${match[3].toLowerCase()}`, leading: match[4].toLowerCase() });
    }
    for (const match of executable.matchAll(/drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?(?:(?:public|private)\.)?([a-z0-9_]+)/gi)) {
      found.delete(match[1].toLowerCase());
    }
  }
  return [...found.values()];
}

// The links this record governs: every casework link into public.member_cases,
// plus the version ledger's actor link to auth.users.
function governedLinks(foreignKeys = reviewedForeignKeys.foreign_keys) {
  return foreignKeys.filter((entry) =>
    (entry.parent === "public.member_cases" && /^(public|private)\.casework_/.test(entry.child))
    || (entry.child === "private.casework_record_versions" && entry.parent === "auth.users"));
}

function uncoveredLinks(links, indexes) {
  return links
    .filter((entry) => !indexes.some((index) => index.table === entry.child && index.leading === columnsOf(entry)[0]))
    .map((entry) => `${entry.child}(${columnsOf(entry)[0]})`);
}

describe("casework links into member_cases are indexed on their leading column", () => {
  it("applies the repair after every migration that created the governed tables", () => {
    const names = migrationNames();
    const repair = names.indexOf(`${REPAIR}.sql`);
    expect(repair).toBeGreaterThan(names.indexOf("20260828210000_mi1_casework_suite.sql"));
    expect(repair).toBeGreaterThan(names.indexOf("20260917143000_casework_case_history.sql"));
  });

  it("reads the known links out of the reviewed catalogue (tripwire against a vacuous scan)", () => {
    const links = governedLinks().map((entry) => `${entry.child}(${columnsOf(entry)[0]})`);
    expect(links.length).toBeGreaterThanOrEqual(15);
    expect(links).toEqual(expect.arrayContaining([
      "public.casework_audit_events(case_id)",
      "public.casework_deadlines(case_id)",
      "public.casework_alerts(case_id)",
      "public.casework_reminders(case_id)",
      "public.casework_management_entries(case_id)",
      "public.casework_retaliation_reports(case_id)",
      "public.casework_intake_drafts(case_id)",
      "public.casework_entity_links(target_case_id)",
      "public.casework_entity_links(source_case_id)",
      "public.casework_checklists(case_id)",
      "private.casework_record_versions(case_id)",
      "private.casework_record_versions(actor)",
    ]));
  });

  it("gives every governed link a leading-column index somewhere in the migration chain", () => {
    expect(uncoveredLinks(governedLinks(), caseworkIndexes())).toEqual([]);
  });

  it("fails for a new casework child table that joins the case graph without a case-leading index", () => {
    const candidate = {
      child: "public.casework_future_child",
      parent: "public.member_cases",
      name: "casework_future_child_case_id_organization_id_chapter_id_fkey",
      columns: "{case_id,organization_id,chapter_id}",
      parent_columns: "{id,organization_id,chapter_id}",
    };
    const links = governedLinks([...reviewedForeignKeys.foreign_keys, candidate]);
    expect(uncoveredLinks(links, caseworkIndexes())).toEqual(["public.casework_future_child(case_id)"]);
    // An index that leads on another column does not count.
    const wrongLead = [...caseworkIndexes(), { table: "public.casework_future_child", leading: "organization_id" }];
    expect(uncoveredLinks(links, wrongLead)).toEqual(["public.casework_future_child(case_id)"]);
  });

  it("pins every new index in the database contract", () => {
    for (const [table, name, defContains] of NEW_INDEXES) {
      const entry = contract.indexes.find((candidate) => candidate.name === name);
      expect(entry, `${name} must be pinned so verify:db reads it out of the catalog`).toBeTruthy();
      expect(entry.table).toBe(table);
      expect(entry.defContains).toEqual(defContains);
    }
  });

  it("adds indexes only and states its build lock and write cost", () => {
    const raw = loadMigrationSql(REPAIR);
    const header = raw.slice(0, raw.indexOf("begin;"));
    expect(header).toMatch(/Build lock:.*SHARE lock/s);
    expect(header).toMatch(/Added write cost:/);
    const executable = stripComments(raw);
    expect(executable).toMatch(/^\s*begin;/i);
    expect(executable.trimEnd()).toMatch(/commit;$/i);
    expect(executable.match(/create index if not exists/gi)).toHaveLength(NEW_INDEXES.length);
    for (const forbidden of [/\bgrant\b/i, /\brevoke\b/i, /\bpolicy\b/i, /\bfunction\b/i, /\bconstraint\b/i, /\binsert\s+into\b/i, /\bupdate\s+(public|private)\./i, /\bdelete\s+from\b/i, /\balter\s+table\b/i, /\bcomment\s+on\b/i]) {
      expect(executable, `${forbidden} does not belong in an index-only migration`).not.toMatch(forbidden);
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("casework case-graph indexes on the live catalogue and in the plan", () => {
  let client;
  const ID = {
    admin: "00000000-0000-4000-8000-0000000fc301",
    org: "00000000-0000-4000-8000-0000000fc302",
  };
  const CHAPTER = "cw-fk-index-proof";
  const CASES = 40;
  const EVENTS = 5000;
  let caseId;

  async function plan(statement, params = []) {
    const { rows } = await client.query(`explain (costs off) ${statement}`, params);
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-case-graph-case-indexes-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    await client.query("insert into auth.users (id, email) values ($1, 'cw-fk-index-admin@example.invalid')", [ID.admin]);
    await client.query(
      "insert into public.organizations (id, slug, name, created_by) values ($1, 'cw-fk-index-proof', 'Casework index proof', $2)",
      [ID.org, ID.admin],
    );
    await client.query(
      "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9931)",
      [CHAPTER, ID.org],
    );
    await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, ID.admin]);
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ID.admin, CHAPTER]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [ID.admin, CHAPTER]);
    const cases = await client.query(
      `insert into public.member_cases (user_id, reference, title, case_type, step, status)
       select $1, 'CW-FK-IDX-' || g, 'Casework index proof case ' || g, 'other', 'Intake', 'active'
       from pg_catalog.generate_series(1, $2::integer) g
       returning id, organization_id, chapter_id`,
      [ID.admin, CASES],
    );
    expect(cases.rows).toHaveLength(CASES);
    expect(cases.rows.every((row) => row.organization_id === ID.org && row.chapter_id === CHAPTER)).toBe(true);
    caseId = cases.rows[0].id;
    // Volume: EVENTS macro_applied rows spread across the org's cases, the
    // shape the replay guard and the per-case reader walk. No ANALYZE: its
    // pg_class.reltuples update is not rolled back with the fixture, and the
    // plan already sees the volume through the table's page count.
    await client.query(
      `insert into public.casework_audit_events
         (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata, created_at)
       select $1, $2, ids[1 + (g % pg_catalog.array_length(ids, 1))], $3, 'macro_applied', 'macro', gen_random_uuid(),
              pg_catalog.jsonb_build_object('operationId', gen_random_uuid()::text), now() - (g || ' seconds')::interval
       from pg_catalog.generate_series(1, $4::integer) g,
            (select pg_catalog.array_agg(id) ids from public.member_cases where organization_id = $1) c`,
      [ID.org, CHAPTER, ID.admin, EVENTS],
    );
  });

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("has a leading-column index for every casework link into member_cases and the version actor", async () => {
    const { rows } = await client.query(`
      select c.conrelid::regclass::text as child, a.attname as leading
        from pg_catalog.pg_constraint c
        join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f'
         and c.conrelid::regclass::text ~ '^(private\\.)?casework_'
         and (c.confrelid = 'public.member_cases'::regclass
              or (c.conrelid = 'private.casework_record_versions'::regclass and c.confrelid = 'auth.users'::regclass))
         and not exists (
           select 1 from pg_catalog.pg_index i
            where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
       order by 1, 2`);
    expect(rows).toEqual([]);
  });

  it("installs all nine indexes as pinned", async () => {
    const { rows } = await client.query(
      "select indexname, indexdef from pg_catalog.pg_indexes where indexname = any($1::text[])",
      [NEW_INDEXES.map(([, name]) => name)],
    );
    expect(rows).toHaveLength(NEW_INDEXES.length);
    for (const [, name, defContains] of NEW_INDEXES) {
      const def = rows.find((row) => row.indexname === name)?.indexdef ?? "";
      for (const needle of defContains) expect(def, name).toContain(needle);
    }
  });

  it(`plans the macro replay guard on the case index at ${EVENTS} rows`, async () => {
    const text = await plan(
      `select 1 from public.casework_audit_events e
        where e.case_id = $1 and e.event_type = 'macro_applied'
          and e.metadata->>'operationId' = $2`,
      [caseId, "00000000-0000-4000-8000-000000000000"],
    );
    expect(text).toContain("casework_audit_events_case_created_idx");
    expect(text).toMatch(/Index Cond: \(case_id = /);
    expect(text).not.toContain("Seq Scan");
  });

  it(`plans a paged list_casework_audit_events(p_case_id) read on the case index at ${EVENTS} rows`, async () => {
    const text = await plan(
      `select a.id from public.casework_audit_events a
        where a.organization_id = $1 and a.case_id = $2
        order by a.created_at desc, a.id desc
        limit 50`,
      [ID.org, caseId],
    );
    expect(text).toContain("casework_audit_events_case_created_idx");
    expect(text).toMatch(/Index Cond: \(case_id = /);
    expect(text).not.toContain("Seq Scan");
  });
});
