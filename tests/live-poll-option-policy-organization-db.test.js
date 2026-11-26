// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrationFiles, stripComments } from "./helpers/migration.js";
import { sqlStatements } from "../scripts/lib/sql-text.mjs";

// DEBT-UG-LIVE-POLL-OPTION-ORG-POLICY-TAUTOLOGY-20260921.
//
// organization_live_poll_options_member_read wrote its organization cross-check
// unqualified inside the poll subquery, so it compared the poll's organization
// with itself. 20260925620200 qualifies it against the option row.
//
// The offline half extracts the policy from the LAST migration that creates or
// alters it, so a later rewrite that drops the qualification fails here. The
// live half (disposable loopback only) seeds an option whose organization
// disagrees with its poll and reads as a member of the poll's organization,
// in one rolled-back transaction.
const MIGRATION = "20260925620200_live_poll_option_policy_organization_check.sql";
const POLICY = "organization_live_poll_options_member_read";
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));

function latestPolicyStatement() {
  const pattern = new RegExp(`^(?:create|alter)\\s+policy\\s+${POLICY}\\s+on\\s+public\\.organization_live_poll_options\\b`, "i");
  let latest = null;
  for (const { name, sql } of migrationFiles()) {
    for (const raw of sqlStatements(sql)) {
      const statement = stripComments(raw).trim().replace(/\s+/g, " ");
      if (pattern.test(statement)) latest = { name, statement };
    }
  }
  return latest;
}

describe("live poll option read policy organization check", () => {
  it("compares the option row's organization with its poll's in the latest policy statement", () => {
    const latest = latestPolicyStatement();
    expect(latest?.name).toBe(MIGRATION);
    expect(latest.statement).toContain("p.id = organization_live_poll_options.poll_id");
    expect(latest.statement).toContain("p.organization_id = organization_live_poll_options.organization_id");
    // The tautology: an unqualified organization_id binds to the poll alias.
    expect(latest.statement).not.toMatch(/p\.organization_id = organization_id\b/);
  });

  it("pins the installed expression in the database contract", () => {
    const entry = contract.policies.find((policy) => policy.table === "organization_live_poll_options" && policy.name === POLICY);
    expect(entry.qualContains).toContain("(p.organization_id = organization_live_poll_options.organization_id)");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the live option read policy", () => {
  let client;
  const id = Object.fromEntries(["orgA", "orgB", "member", "session", "poll", "matching", "foreign"].map((key) => [key, randomUUID()]));
  const chapter = `live-poll-option-${id.orgA.slice(0, 8)}`;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "live-poll-option-policy-organization-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query("insert into auth.users (id, email) values ($1, $2)", [id.member, `${id.member}@example.invalid`]);
    for (const org of [id.orgA, id.orgB]) {
      await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [org, `live-poll-option-${org.slice(0, 8)}`, id.member]);
    }
    await client.query(
      "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9907)",
      [chapter, id.orgA],
    );
    await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [id.orgA, id.member]);
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [id.member, chapter]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [id.member, chapter]);
    await client.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [id.session, id.member]);
    await client.query(
      "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'Live poll option factor', 'totp', 'verified', now(), now())",
      [randomUUID(), id.member],
    );
    await client.query(
      "insert into public.organization_live_polls (id, organization_id, title, state, results_visibility) values ($1, $2, 'Option policy proof poll', 'open', 'live')",
      [id.poll, id.orgA],
    );
    // One option that agrees with its poll's organization and one that names
    // another organization on the same poll.
    await client.query(
      "insert into public.organization_live_poll_options (id, organization_id, poll_id, label, sort_index) values ($1, $2, $4, 'Matching option', 0), ($3, $5, $4, 'Foreign option', 1)",
      [id.matching, id.orgA, id.foreign, id.poll, id.orgB],
    );
  });

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  async function visibleOptions() {
    await client.query("savepoint option_read");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
      sub: id.member, role: "authenticated", session_id: id.session, aal: "aal2",
    })]);
    await client.query("set local role authenticated");
    const { rows } = await client.query("select id from public.organization_live_poll_options where poll_id = $1 order by sort_index", [id.poll]);
    await client.query("rollback to savepoint option_read");
    return rows.map((row) => row.id);
  }

  it("shows a member the option whose organization matches the poll", async () => {
    expect(await visibleOptions()).toContain(id.matching);
  });

  it("withholds an option whose organization disagrees with its poll", async () => {
    expect(await visibleOptions()).toEqual([id.matching]);
  });

  it("installs the qualified expression", async () => {
    const { rows } = await client.query(
      "select pg_catalog.pg_get_expr(polqual, polrelid) qual from pg_catalog.pg_policy where polname = $1",
      [POLICY],
    );
    expect(rows[0].qual).toContain("(p.organization_id = organization_live_poll_options.organization_id)");
  });
});
