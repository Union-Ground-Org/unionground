// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";
import { sqlStatements } from "../scripts/lib/sql-text.mjs";

// SEC-UG-DUES-PROVIDER-CONNECTION-READ-PROJECTION-20260921.
//
// public.get_dues_provider_status is the reviewed read projection for a dues
// provider connection: financial hat first, then five projected fields. The
// base table kept a direct client read next to it, so the projection decided
// nothing about what an ordinary organization member could see. 20260925570300
// removes that read.
//
// These pins are written against the WHOLE migration directory in apply order
// rather than against one file, because the question is a net effect: a later
// migration that re-grants SELECT or re-creates a permissive policy would leave
// a single-file pin green while reopening the read. The live half (disposable
// loopback only) reads as an ordinary member and as a financial admin, in one
// rolled-back transaction.
const MIGRATION = "20260925570300_dues_provider_connection_read_projection.sql";
const TABLE = "public.dues_provider_connections";
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));

function topLevelStatements() {
  return migrationFiles().flatMap(({ name, sql }) =>
    sqlStatements(sql).map((statement) => ({ name, statement: stripComments(statement).trim() })));
}

// Roles holding SELECT on the table after every grant and revoke in the
// directory has been applied in order. `public` is tracked as the literal
// grantee PostgreSQL records, which is exact for this table: every statement
// naming it lists its grantees explicitly.
function selectHoldersAtHead() {
  const holders = new Set();
  const statements = [];
  for (const { name, statement } of topLevelStatements()) {
    const parsed = /^(grant|revoke)\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+(?:to|from)\s+([\s\S]+?);?$/i.exec(statement);
    if (!parsed) continue;
    const [, verb, privileges, objects, grantees] = parsed;
    if (/^\s*(?:function|procedure|routine|schema|sequence|all\s)/i.test(objects)) continue;
    if (!new RegExp(`\\b${TABLE.replace(".", "\\.")}\\b`, "i").test(objects)) continue;
    if (!/\b(?:all|select)\b/i.test(privileges)) continue;
    statements.push({ name, verb: verb.toLowerCase() });
    for (const grantee of grantees.split(",").map((role) => role.trim().toLowerCase())) {
      if (verb.toLowerCase() === "grant") holders.add(grantee);
      else holders.delete(grantee);
    }
  }
  return { holders, statements };
}

// Permissive policies on the table, by the same apply-order walk. The
// restrictive mfa_assurance policy is returned separately: it narrows, so it is
// not a read path of its own.
function policiesAtHead() {
  const permissive = new Map();
  const restrictive = new Map();
  for (const { name, statement } of topLevelStatements()) {
    const created = new RegExp(`^create\\s+policy\\s+([a-z_0-9]+)\\s+on\\s+${TABLE.replace(".", "\\.")}\\b([\\s\\S]*)$`, "i").exec(statement);
    if (created) {
      const [, policy, rest] = created;
      (/^\s*as\s+restrictive\b/i.test(rest) ? restrictive : permissive).set(policy.toLowerCase(), name);
      continue;
    }
    const dropped = new RegExp(`^drop\\s+policy\\s+(?:if\\s+exists\\s+)?([a-z_0-9]+)\\s+on\\s+${TABLE.replace(".", "\\.")}\\b`, "i").exec(statement);
    if (dropped) {
      permissive.delete(dropped[1].toLowerCase());
      restrictive.delete(dropped[1].toLowerCase());
    }
  }
  return { permissive, restrictive };
}

describe("dues provider connection read projection", () => {
  it("ships the migration that removes the direct read", () => {
    const names = migrationFiles().map((entry) => entry.name);
    expect(names).toContain(MIGRATION);
    const sql = migrationFiles().find((entry) => entry.name === MIGRATION).sql;
    expect(sql).toContain(`revoke all on ${TABLE} from public, anon, authenticated;`);
    expect(sql).toContain(`drop policy if exists dues_provider_connections_own_select on ${TABLE};`);
    // The whole file is one transaction, so a failed revoke cannot leave the
    // policy dropped and the grant standing.
    const statements = sqlStatements(sql).map((statement) => stripComments(statement).trim().toLowerCase());
    expect(statements[0]).toBe("begin;");
    expect(statements.at(-1)).toBe("commit;");
  });

  it("leaves no Data API role holding SELECT on the provider connection table", () => {
    const { holders, statements } = selectHoldersAtHead();
    // A pin that parsed nothing would pass vacuously.
    expect(statements.filter((entry) => entry.verb === "grant").length).toBeGreaterThan(0);
    expect(statements.at(-1)).toEqual({ name: MIGRATION, verb: "revoke" });
    expect([...holders].sort()).toEqual([]);
  });

  it("leaves no permissive policy on the table, and keeps the restrictive MFA policy", () => {
    const { permissive, restrictive } = policiesAtHead();
    expect([...permissive.keys()].sort()).toEqual([]);
    expect([...restrictive.keys()].sort()).toEqual(["mfa_assurance"]);
  });

  it("keeps the financial-hat projection as the only read path", () => {
    const declaring = migrationFiles().filter((entry) =>
      /create\s+(?:or\s+replace\s+)?function\s+public\.get_dues_provider_status\s*\(/i.test(entry.sql));
    expect(declaring.length).toBeGreaterThan(0);
    const body = fnBody(declaring.at(-1).sql, "public.get_dues_provider_status");
    expect(body).toContain("private.dues_require_financial_hat(p_selected_hat)");
    expect(body).toContain("'checkoutAvailable'");
    // The projection withholds the connected account identifier and the payout
    // flag; the base-table read was the way around that.
    expect(body).not.toMatch(/'stripe_?account_?id'|'payoutsEnabled'/i);
  });

  it("records the closed read in the database contract", () => {
    const grants = new Map(contract.tableGrants.map((entry) => [`${entry.table}|${entry.role}`, entry.privileges]));
    expect(grants.get(`${TABLE}|authenticated`)).toBe("");
    expect(grants.get(`${TABLE}|anon`)).toBe("");
    expect(contract.policyCoverage.noPermissivePolicies).toContain("dues_provider_connections");
    expect(contract.policies.filter((entry) => entry.table === "dues_provider_connections").map((entry) => entry.name))
      .toEqual([]);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the live provider connection is readable only through the financial-hat projection", () => {
  let client;
  const id = Object.fromEntries(["org", "admin", "member", "adminSession", "memberSession"].map((key) => [key, randomUUID()]));
  const chapter = `dues-projection-${id.org.slice(0, 8)}`;
  const account = `acct_proof_${id.org.slice(0, 8)}`;

  async function as(user, session, aal, statement, params = []) {
    await client.query("savepoint dues_read");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: user, role: "authenticated", session_id: session, aal,
      })]);
      await client.query("set local role authenticated");
      const result = await client.query(statement, params);
      await client.query("release savepoint dues_read");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint dues_read");
      return { code: error.code || "?", message: error.message || "" };
    }
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-provider-connection-read-projection-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query(
      "insert into auth.users (id, email) values ($1, $3), ($2, $4)",
      [id.admin, id.member, `${id.admin}@example.invalid`, `${id.member}@example.invalid`],
    );
    await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [id.org, chapter, id.admin]);
    await client.query(
      "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9904)",
      [chapter, id.org],
    );
    for (const [user, session, aal] of [[id.admin, id.adminSession, "aal2"], [id.member, id.memberSession, "aal1"]]) {
      await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [user, chapter]);
      await client.query(
        "insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), $3)",
        [session, user, aal],
      );
    }
    await client.query(
      "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'Dues projection factor', 'totp', 'verified', now(), now())",
      [randomUUID(), id.admin],
    );
    await client.query(
      "insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)",
      [id.org, id.admin],
    );
    await client.query(
      `insert into private.dues_financial_identity_selections (organization_id, user_id, selected_hat, selected_by)
       values ($1, $2, 'admin', $2)
       on conflict (organization_id, user_id) do update set selected_hat = 'admin'`,
      [id.org, id.admin],
    );
    await client.query(
      `insert into public.dues_provider_connections
         (organization_id, state, stripe_account_id, account_label, charges_enabled, payouts_enabled)
       values ($1, 'ready', $2, 'Proof Local Dues', true, true)`,
      [id.org, account],
    );
  });

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("refuses an ordinary organization member's direct read of the connection row", async () => {
    const refused = await as(id.member, id.memberSession, "aal1",
      "select stripe_account_id, payouts_enabled from public.dues_provider_connections where organization_id = $1", [id.org]);
    expect(refused.code).toBe("42501");
  });

  it("refuses the financial admin's direct read too; the projection is the only path", async () => {
    const refused = await as(id.admin, id.adminSession, "aal2",
      "select * from public.dues_provider_connections where organization_id = $1", [id.org]);
    expect(refused.code).toBe("42501");
  });

  it("still serves the financial admin the bounded status projection without the account identifier", async () => {
    const status = await as(id.admin, id.adminSession, "aal2", "select public.get_dues_provider_status('admin') status");
    expect(status, status.message).toMatchObject({ code: "" });
    expect(status.rows[0].status).toEqual({
      organizationId: id.org,
      state: "ready",
      checkoutAvailable: true,
      accountLabel: "Proof Local Dues",
      attention: null,
    });
    expect(JSON.stringify(status.rows[0].status)).not.toContain(account);
  });
});
