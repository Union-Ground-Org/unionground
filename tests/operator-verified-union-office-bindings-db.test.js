// @vitest-environment node
//
// SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101
//
// An organization administrator can ask for a binding from their chapter to a
// catalogue union office, but only an active platform operator decides it.
// The live half proves that a tenant administrator's verify and reject are
// refused and an operator's succeed, that re-pointing a verified binding
// returns it to requested, that the retained read lists every decision no
// operator made, and that an operator can reopen one so it is decided again.
// Everything runs in one transaction that is rolled back.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const STEM = "operator_verified_union_office_bindings";
const migration = stripComments(loadMigrationSql(STEM));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const SIGNATURES = {
  verify: "public.verify_chapter_union_org_binding(text, text, boolean, text, uuid)",
  list: "public.list_union_office_bindings_without_operator_verifier()",
  reopen: "public.reopen_chapter_union_org_binding(text, text, uuid, text)",
};

describe("operator-verified union office bindings (static)", () => {
  it("sorts after the standing-offer delivery it closes and applies under an empty search_path", () => {
    expect(findMigrationName(STEM) > "20261102014446_chapter_treasurer_financial_duties.sql").toBe(true);
    expect(migration).toContain("set local search_path = pg_catalog;");
    // Function definitions pin search_path = ''; the migration itself may not
    // (the pr1815 drift parser refuses that statement).
    expect(migration).not.toMatch(/^\s*set\s+(local\s+)?search_path\s*=\s*''\s*;/im);
  });

  it("refuses a verifier who is not an active operator and grants every routine to the service role only", () => {
    expect(migration.split("if not private.partner_binding_verifier_is_operator(")).toHaveLength(3);
    expect(migration.split("raise exception 'platform operator required' using errcode = '42501'")).toHaveLength(3);
    for (const sig of Object.values(SIGNATURES)) {
      expect(migration).toContain(`grant execute on function ${sig} to service_role;`);
      expect(migration).toMatch(new RegExp(`revoke all on function ${sig.replace(/[().]/g, "\\$&")}\\s+from public, anon, authenticated, service_role;`));
    }
  });

  it("pins the three routines in the database contract", () => {
    for (const [name, needle] of [
      ["public.verify_chapter_union_org_binding(", "platform operator required"],
      ["public.list_union_office_bindings_without_operator_verifier(", "private.partner_binding_verifier_is_operator(b.verified_by)"],
      ["public.reopen_chapter_union_org_binding(", "chapter_union_org_binding_reopened"],
    ]) {
      const entry = contract.functions.find((row) => row.sig.startsWith(name));
      expect(entry?.exec, name).toBe("service_role");
      expect(entry?.bodyContains, name).toContain(needle);
      for (const pinned of entry.bodyContains) expect(migration, `${name} ${pinned}`).toContain(pinned);
    }
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/operator-verified-union-office-bindings-db.test.js");
  });
});

const n = (suffix) => `50906714-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const ID = { org: n(1), admin: n(101), operator: n(102), revoked: n(103), adminSession: n(201) };
const CHAPTER = "operator-binding-proof";
const OFFICE = "operator-binding-office";
const OTHER_OFFICE = "operator-binding-office-elsewhere";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("operator-verified union office bindings on a disposable database", () => {
  let db;

  async function as(userId, sql, values = [], { role = "authenticated" } = {}) {
    await db.query("savepoint as_user");
    try {
      const claims = role === "service_role" ? { role } : { sub: userId, role, session_id: ID.adminSession, aal: "aal2" };
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.query(`set local role ${role}`);
      const rows = (await db.query(sql, values)).rows;
      await db.query("reset role");
      await db.query("release savepoint as_user");
      return rows[0]?.data;
    } catch (error) {
      await db.query("rollback to savepoint as_user");
      await db.query("reset role");
      throw error;
    }
  }
  const service = (sql, values) => as(null, sql, values, { role: "service_role" });
  const decide = (verifier, verified, office = OFFICE) => service(
    "select public.verify_chapter_union_org_binding($1,$2,$3,'Reviewed',$4) data", [CHAPTER, office, verified, verifier]);
  const request = (office) => as(ID.admin, "select public.request_chapter_union_org_binding($1) data", [office]);
  const binding = async () => (await db.query(
    "select union_org_id, status, verified_by, verified_at is not null stamped from public.chapter_union_org_bindings where chapter_id = $1", [CHAPTER])).rows[0];
  const ledger = async (event) => (await db.query(
    "select actor_user_id, metadata from public.organization_audit_ledger where organization_id = $1 and event_type = $2 order by occurred_at", [ID.org, event])).rows;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "operator-verified-union-office-bindings-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    for (const id of [ID.admin, ID.operator, ID.revoked]) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `operator-binding-${id.slice(-3)}@example.invalid`]);
    }
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [ID.adminSession, ID.admin]);
    await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values (gen_random_uuid(),$1,'Operator binding proof','totp','verified',now(),now())", [ID.admin]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,'operator-binding-proof','Operator binding proof',$2)", [ID.org, ID.admin]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,'Garage 9',$1,$2,false,9951)", [CHAPTER, ID.org]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [ID.org, ID.admin]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [ID.admin, CHAPTER]);
    await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [ID.admin, CHAPTER]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [ID.org, ID.admin]);
    for (const [id, file, name] of [[OFFICE, 790671401, "Harbor Ferry Workers"], [OTHER_OFFICE, 790671402, "Inland Rail Workers"]]) {
      await db.query(`insert into public.union_orgs(id,olms_file_number,name,affiliation,level,city,state,sector_tags,enrichment_status,atlas_manifest_sha)
        values ($1,$2,$3,'SYNTHETIC','local','Springfield','IL',array['transit'],'no_web_presence','operator-binding-proof')`, [id, file, name]);
    }
    await db.query("insert into private.compass_platform_operators(user_id, granted_note) values ($1, 'operator binding proof'), ($2, 'operator binding proof, revoked')", [ID.operator, ID.revoked]);
    await db.query("update private.compass_platform_operators set revoked_at = now() where user_id = $1", [ID.revoked]);
  }, 60_000);
  beforeEach(async () => {
    await db.query("savepoint binding_test");
    expect(await request(OFFICE)).toEqual({ requested: true, chapterId: CHAPTER });
  });
  afterEach(async () => { await db.query("rollback to savepoint binding_test"); });
  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("refuses the chapter's own administrator, and a revoked operator, both verify and reject", async () => {
    for (const verifier of [ID.admin, ID.revoked]) {
      for (const verified of [true, false]) {
        await expect(decide(verifier, verified)).rejects.toMatchObject({ code: "42501", message: "platform operator required" });
      }
    }
    expect(await binding()).toEqual({ union_org_id: OFFICE, status: "requested", verified_by: null, stamped: false });
    expect(await ledger("chapter_union_org_binding_verified")).toEqual([]);
  });

  it("lets an active operator verify, and names them on the row and in the ledger", async () => {
    expect(await decide(ID.operator, true)).toEqual({ verified: true, chapterId: CHAPTER, verifiedBy: ID.operator });
    expect(await binding()).toEqual({ union_org_id: OFFICE, status: "verified", verified_by: ID.operator, stamped: true });
    expect(await ledger("chapter_union_org_binding_verified")).toEqual([{
      actor_user_id: ID.operator,
      metadata: { chapterId: CHAPTER, userId: ID.operator, entityType: "union_org", entityId: OFFICE, fromStatus: "requested", toStatus: "verified" },
    }]);
  });

  it("lets an active operator reject", async () => {
    expect(await decide(ID.operator, false)).toMatchObject({ verified: false, verifiedBy: ID.operator });
    expect(await binding()).toEqual({ union_org_id: OFFICE, status: "rejected", verified_by: ID.operator, stamped: false });
  });

  it("returns a verified binding to requested when the administrator re-points it at another office", async () => {
    await decide(ID.operator, true);
    expect(await request(OTHER_OFFICE)).toEqual({ requested: true, chapterId: CHAPTER });
    expect(await binding()).toEqual({ union_org_id: OTHER_OFFICE, status: "requested", verified_by: null, stamped: false });
    // The administrator still cannot verify the new office themselves.
    await expect(decide(ID.admin, true, OTHER_OFFICE)).rejects.toMatchObject({ code: "42501" });
  });

  it("lists every decision no active operator made, and lets an operator reopen one", async () => {
    const listed = () => service("select public.list_union_office_bindings_without_operator_verifier() data");
    const mine = async () => (await listed()).filter((row) => row.chapterId === CHAPTER);
    expect(await mine()).toEqual([]);
    await decide(ID.operator, true);
    expect(await mine()).toEqual([]);
    // A binding the chapter's administrator verified before this record.
    await db.query("update public.chapter_union_org_bindings set verified_by = $2 where chapter_id = $1", [CHAPTER, ID.admin]);
    expect(await mine()).toEqual([expect.objectContaining({
      chapterId: CHAPTER, organizationId: ID.org, unionOrgId: OFFICE, status: "verified", verifiedBy: ID.admin,
    })]);
    // A verifier whose operator grant was revoked is no operator either.
    await db.query("update public.chapter_union_org_bindings set verified_by = $2 where chapter_id = $1", [CHAPTER, ID.revoked]);
    expect((await mine()).map((row) => row.verifiedBy)).toEqual([ID.revoked]);

    const reopen = (operator) => service("select public.reopen_chapter_union_org_binding($1,$2,$3,'Owner ruling: decide again') data", [CHAPTER, OFFICE, operator]);
    for (const nonOperator of [ID.admin, ID.revoked]) {
      await expect(reopen(nonOperator)).rejects.toMatchObject({ code: "42501", message: "platform operator required" });
    }
    expect(await reopen(ID.operator)).toEqual({ chapterId: CHAPTER, unionOrgId: OFFICE, fromStatus: "verified", status: "requested" });
    expect(await binding()).toEqual({ union_org_id: OFFICE, status: "requested", verified_by: null, stamped: false });
    expect(await ledger("chapter_union_org_binding_reopened")).toEqual([{
      actor_user_id: ID.operator,
      metadata: { chapterId: CHAPTER, userId: ID.operator, entityType: "union_org", entityId: OFFICE, fromStatus: "verified", toStatus: "requested" },
    }]);
    expect(await mine()).toEqual([]);
    // Nothing left to reopen; an operator now decides it through the ordinary path.
    await expect(reopen(ID.operator)).rejects.toMatchObject({ code: "22023" });
    expect(await decide(ID.operator, false)).toMatchObject({ verified: false });
  });

  it("keeps all three routines out of every role but the service role", async () => {
    const { rows } = await db.query(`
      select role,
        has_function_privilege(role, 'public.verify_chapter_union_org_binding(text,text,boolean,text,uuid)', 'execute') as verify,
        has_function_privilege(role, 'public.list_union_office_bindings_without_operator_verifier()', 'execute') as list,
        has_function_privilege(role, 'public.reopen_chapter_union_org_binding(text,text,uuid,text)', 'execute') as reopen
      from unnest(array['anon','authenticated','service_role']) as role`);
    expect(rows).toEqual([
      { role: "anon", verify: false, list: false, reopen: false },
      { role: "authenticated", verify: false, list: false, reopen: false },
      { role: "service_role", verify: true, list: true, reopen: true },
    ]);
  });
});
