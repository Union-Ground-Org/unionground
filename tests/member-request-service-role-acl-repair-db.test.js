// @vitest-environment node
//
// Hosted projects default-grant EXECUTE on new public functions to
// service_role, so the five member-request functions kept that grant after
// 20261030235900 while scripts/db-contract.json pins them to authenticated
// (Main push CI run 41336510434, "Deployed DB contract drift"). The officer
// member-directory export and probe from 20261031020000 have the same
// omission. The repair revokes service_role only. The live case recreates the
// hosted default grant inside a transaction, applies the repair and rolls
// everything back.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261031020500_member_request_service_role_acl_repair";
const MEMBER_REQUESTS = [
  "public.submit_member_request(text, text, text, text, text)",
  "public.list_my_member_requests(integer, timestamptz, uuid)",
  "public.list_member_requests(text, integer, timestamptz, uuid)",
  "public.decide_member_request(uuid, text)",
  "public.approve_member_request_invitation(uuid, text, text, text)",
];
const OFFICER_DIRECTORY = [
  "public.export_member_directory_csv(uuid, text, text)",
  "public.get_member_directory_access()",
];
const revoke = (identity) => `revoke execute on function ${identity} from service_role`;
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("member request service_role ACL repair (static)", () => {
  const raw = loadMigrationSql(MIGRATION);
  const sql = stripComments(raw);

  it("is one transaction that revokes service_role EXECUTE on the seven functions and nothing else", () => {
    const code = sql.trim();
    expect(code.startsWith("begin;")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
    for (const identity of MEMBER_REQUESTS) expect(code).toContain(`\n${revoke(identity)};`);
    for (const identity of OFFICER_DIRECTORY) {
      // On a function ALL is exactly EXECUTE.
      expect(code).toContain(`if pg_catalog.to_regprocedure('${identity}') is not null then\n    revoke all on function ${identity} from service_role;`);
    }
    const revokes = [...code.matchAll(/\brevoke\b[^;]*;/giu)].map((match) => match[0]);
    expect(revokes).toHaveLength(MEMBER_REQUESTS.length + OFFICER_DIRECTORY.length);
    expect(revokes.every((statement) => /from service_role;$/u.test(statement))).toBe(true);
    expect(code).not.toMatch(/\b(?:grant|create|alter|drop)\b/iu);
  });

  it("sorts after the officer directory migration whose functions it repairs", () => {
    expect(MIGRATION > "20261031020000_officer_member_directory_and_export").toBe(true);
    expect(MIGRATION > "20261030235900_member_requests").toBe(true);
  });

  it("keeps the contract at authenticated only for each repaired function", () => {
    for (const identity of MEMBER_REQUESTS) {
      const entry = contract.functions.find((fn) => fn.sig.startsWith(`${identity.split("(")[0]}(`));
      expect(entry?.exec, identity).toBe("authenticated");
    }
    // The officer directory entries arrive with 20261031020000.
    for (const identity of OFFICER_DIRECTORY) {
      const entry = contract.functions.find((fn) => fn.sig.startsWith(`${identity.split("(")[0]}(`));
      if (entry) expect(entry.exec, identity).toBe("authenticated");
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member request service_role ACL repair on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "member-request-acl-rollback-proof" });
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
    const present = [];
    for (const identity of OFFICER_DIRECTORY) {
      if ((await client.query("select pg_catalog.to_regprocedure($1) is not null as present", [identity])).rows[0].present) present.push(identity);
    }
    const repaired = [...MEMBER_REQUESTS, ...present];
    // The repair body, without its own begin and commit, runs inside this
    // transaction so the rollback undoes it.
    const body = stripComments(loadMigrationSql(MIGRATION)).trim().replace(/^begin;/u, "").replace(/commit;$/u, "");
    await client.query("begin");
    try {
      // The hosted default privilege, as Production carried it.
      for (const identity of repaired) await client.query(`grant execute on function ${identity} to service_role`);
      for (const identity of repaired) expect((await privileges(identity)).service_role, identity).toBe(true);
      await client.query(body);
      for (const identity of repaired) {
        expect(await privileges(identity), identity).toEqual({ anon: false, authenticated: true, service_role: false, public: false });
      }
      // A repeat run is a no-op.
      await client.query(body);
      for (const identity of repaired) expect((await privileges(identity)).service_role, identity).toBe(false);
    } finally {
      await client.query("rollback");
    }
  });
});
