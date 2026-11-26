// @vitest-environment node
//
// BUG-UG-HOSTED-SERVICE-ROLE-EXECUTE-DRIFT-20261102
//
// Hosted projects default-grant EXECUTE on new public functions to
// service_role, so these 17 staff functions kept that grant on Production while
// #6682 re-pinned scripts/db-contract.json to authenticated only (Main push CI
// job 125437020656, "Deployed database drift and Main image cache"). The repair
// revokes service_role only. The live case recreates the hosted default grant
// inside a transaction, applies the repair and rolls everything back.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261102174600_staff_function_service_role_execute_revoke";
const FUNCTIONS = [
  "public.form_owner_in_steward_scope(uuid)",
  "public.get_admin_events()",
  "public.get_broadcast_read_counts()",
  "public.get_staff_roster()",
  "public.get_steward_badge_counts()",
  "public.get_steward_chapter_member_count()",
  "public.assign_member_case(uuid, uuid, uuid)",
  "public.list_member_case_assignment_candidates(uuid)",
  "public.open_form_as_case(uuid)",
  "public.retract_member_broadcast(text)",
  "public.return_form(uuid, text)",
  "public.list_intake_triage_owners()",
  "public.convert_member_intake_report(uuid, text, uuid)",
  "public.steward_start_review(uuid)",
  "public.list_vp_case_reviews()",
  "public.update_chapter_document_content(uuid, text, text, text, text, text, text)",
  "public.create_member_contact_note(uuid, text, uuid)",
];
const revoke = (identity) => `revoke execute on function ${identity} from service_role`;
// A later migration replaced a repaired function's signature; the live replay
// revokes from the function as it exists today. 20261124175100 (#9533) gave
// the roster an optional p_chapter_only argument.
const REPLACED = { "public.get_staff_roster()": "public.get_staff_roster(boolean)" };
const current = (identity) => REPLACED[identity] ?? identity;
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("staff function service_role EXECUTE revoke (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("is one transaction under an empty-equivalent search_path that revokes service_role EXECUTE on the 17 functions and nothing else", () => {
    const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
    expect(statements).toEqual([
      "begin",
      "set local lock_timeout = '5s'",
      "set local statement_timeout = '60s'",
      "set local search_path = pg_catalog",
      ...FUNCTIONS.map(revoke),
      "commit",
    ]);
  });

  it("sorts after the scoped-access migration that last replaced these functions", () => {
    expect(MIGRATION > "20261102005607_unit_committee_scoped_access").toBe(true);
  });

  it("keeps the contract at authenticated only for each repaired function", () => {
    for (const identity of FUNCTIONS) {
      const name = identity.split("(")[0];
      const entries = contract.functions.filter((fn) => fn.sig.startsWith(`${name}(`));
      expect(entries, identity).toHaveLength(1);
      expect(entries[0].exec, identity).toBe("authenticated");
      expect(entries[0].secdef, identity).toBe(true);
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("staff function service_role EXECUTE revoke on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "staff-function-acl-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  it("removes the hosted default service_role grant and leaves authenticated as the only caller", async () => {
    const privileges = async (identity) => (await client.query(
      `select has_function_privilege('anon', $1::regprocedure, 'execute') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'execute') as authenticated,
              has_function_privilege('service_role', $1::regprocedure, 'execute') as service_role,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public
         from pg_proc p where p.oid = $1::regprocedure`, [identity])).rows[0];
    // The repair body, without its own begin and commit, runs inside this
    // transaction so the rollback undoes it.
    let body = stripComments(loadMigrationSql(MIGRATION)).trim().replace(/^begin;/u, "").replace(/commit;$/u, "");
    for (const [before, now] of Object.entries(REPLACED)) {
      expect(body, before).toContain(revoke(before));
      body = body.replace(revoke(before), revoke(now));
    }
    const LIVE = FUNCTIONS.map(current);
    await client.query("begin");
    try {
      // The hosted default privilege, as Production carried it.
      for (const identity of LIVE) await client.query(`grant execute on function ${identity} to service_role`);
      for (const identity of LIVE) expect((await privileges(identity)).service_role, identity).toBe(true);
      await client.query(body);
      for (const identity of LIVE) {
        expect(await privileges(identity), identity).toEqual({ anon: false, authenticated: true, service_role: false, public: false });
      }
      // A repeat run is a no-op.
      await client.query(body);
      for (const identity of LIVE) expect((await privileges(identity)).service_role, identity).toBe(false);
    } finally {
      await client.query("rollback");
    }
  });
});
