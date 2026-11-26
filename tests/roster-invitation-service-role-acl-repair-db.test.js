// @vitest-environment node
//
// SEC-UG-ROSTER-INVITATION-SERVICE-ROLE-EXECUTE-20261026
//
// Hosted projects default-grant EXECUTE on new public functions to
// service_role, so the roster invitation create kept that grant after
// 20261022171700 while scripts/db-contract.json pins it to authenticated. The
// repair revokes service_role only. The live case recreates the hosted default
// grant inside a transaction, applies the repair and rolls everything back.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261026140000_roster_invitation_service_role_acl_repair";
const IDENTITY = "public.create_roster_member_invitation(text, text, text, text, text)";
const REVOKE = `revoke execute on function ${IDENTITY} from service_role;`;
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("roster invitation service_role ACL repair (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("is one transaction that revokes service_role EXECUTE on the roster create and nothing else", () => {
    const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
    expect(statements).toEqual(["begin", REVOKE.slice(0, -1), "commit"]);
  });

  it("keeps the contract at authenticated only for the roster create", () => {
    const entry = contract.functions.find((fn) => fn.sig.startsWith("public.create_roster_member_invitation("));
    expect(entry?.exec).toBe("authenticated");
    expect(entry?.secdef).toBe(true);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("roster invitation service_role ACL repair on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "roster-invitation-acl-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  it("removes the hosted default service_role grant and leaves authenticated as the only caller", async () => {
    const privileges = async () => (await client.query(
      `select has_function_privilege('anon', $1::regprocedure, 'execute') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'execute') as authenticated,
              has_function_privilege('service_role', $1::regprocedure, 'execute') as service_role,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public
         from pg_proc p where p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
    await client.query("begin");
    try {
      // The hosted default privilege, as SAMPLE and Production carried it.
      await client.query(`grant execute on function ${IDENTITY} to service_role`);
      expect((await privileges()).service_role).toBe(true);
      await client.query(REVOKE);
      expect(await privileges()).toEqual({ anon: false, authenticated: true, service_role: false, public: false });
    } finally {
      await client.query("rollback");
    }
  });
});
