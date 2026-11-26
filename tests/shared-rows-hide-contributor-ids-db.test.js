// @vitest-environment node
//
// SEC-UG-SHARED-ROWS-SHOW-REQUESTER-AND-CONTRIBUTOR-IDS-TO-OTHER-ORGANIZATIONS-20261111 (#8322)
//
// Union office bindings and shared exact-place civic entries stay shared
// between organizations, but the members' role no longer reads who asked for,
// verified or entered them: requested_by and verified_by on
// public.chapter_union_org_bindings, org_id and created_by on
// public.civic_local_jurisdictions, created_by on public.civic_local_officials.
// The live half populates two organizations, reads every surface of the three
// tables as staff and as a plain member of the other organization, and finds
// none of the contributing organization's person ids or its chapter id in the
// civic rows; the contributing organization still reads its own through the
// own-organization functions. Everything runs in one transaction that is
// rolled back.
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const STEM = "shared_rows_hide_contributor_ids";
const migration = stripComments(loadMigrationSql(STEM));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const HIDDEN = {
  "public.chapter_union_org_bindings": ["requested_by", "verified_by"],
  "public.civic_local_jurisdictions": ["org_id", "created_by"],
  "public.civic_local_officials": ["created_by"],
};
const VISIBLE = {
  "public.chapter_union_org_bindings": ["chapter_id", "union_org_id", "status", "requested_at", "verified_at", "public_note"],
  "public.civic_local_jurisdictions": ["id", "name", "kind", "state", "match_zips", "match_cities", "updated_at", "place_geoid", "shared", "reviewed_at"],
  "public.civic_local_officials": ["id", "jurisdiction_id", "office", "full_name", "party", "email", "phone", "contact_form_url", "website", "term_end", "is_current", "updated_at"],
};
const OWN_FUNCTIONS = [
  "public.list_own_organization_chapter_union_org_bindings()",
  "public.civic_local_jurisdictions_for_org(p_org text)",
  "public.civic_local_officials_for_org(p_org text)",
];

describe("shared rows hide contributor ids (static)", () => {
  it("sorts after the pending queue and applies under an empty search_path", () => {
    expect(findMigrationName(STEM) > "20261112231000").toBe(true);
    expect(migration).toContain("set local search_path = pg_catalog;");
  });

  it("takes table-wide SELECT from authenticated and grants back every column but the id columns", () => {
    for (const table of Object.keys(HIDDEN)) {
      expect(migration).toMatch(new RegExp(`revoke select on [^;]*${table.replace(".", "\\.")}[^;]* from authenticated;`));
      const grant = migration.match(new RegExp(`grant select \\(([^)]*)\\)\\s+on ${table.replace(".", "\\.")} to authenticated;`));
      expect(grant, table).not.toBeNull();
      const columns = grant[1].split(",").map((column) => column.trim());
      expect(columns.sort()).toEqual([...VISIBLE[table]].sort());
      for (const hidden of HIDDEN[table]) expect(columns).not.toContain(hidden);
    }
  });

  it("pins the column grants, the table grants and the own-organization functions in the database contract", () => {
    for (const [table, visible] of Object.entries(VISIBLE)) {
      const entry = contract.columnGrants.find((row) => row.table === table && row.role === "authenticated" && row.privilege === "SELECT");
      expect(entry?.columns.split(",").sort(), table).toEqual([...visible].sort());
      expect(entry.denied.sort(), table).toEqual([...HIDDEN[table]].sort());
      const tableGrant = contract.tableGrants.find((row) => row.table === table && row.role === "authenticated");
      expect(tableGrant.privileges.split(",")).not.toContain("SELECT");
    }
    for (const sig of OWN_FUNCTIONS) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry?.secdef, sig).toBe(true);
      expect(entry.exec, sig).toBe("authenticated,service_role");
      for (const pinned of entry.bodyContains) expect(migration, `${sig} ${pinned}`).toContain(pinned);
    }
  });

  it("orders the invoker view through a public helper service_role may execute (gate round 1 P2)", () => {
    expect(migration).toContain("grant execute on function public.civic_local_jurisdiction_own(uuid) to authenticated, service_role;");
    expect(migration).toContain("public.civic_local_jurisdiction_own(j.id) desc");
    expect(migration).not.toContain("private.civic_local_jurisdiction_own");
    const entry = contract.functions.find((row) => row.sig === "public.civic_local_jurisdiction_own(p_jurisdiction uuid)");
    expect(entry?.exec).toBe("authenticated,service_role");
  });

  // Civic action is left out of this edition's screens (no src/lib/civicApi.js),
  // so no client may read the civic tables by filtering on org_id either.
  it("has no client that reads civic entries by filtering on org_id", () => {
    const sources = ["src", "api", "apps/mobile/src"].flatMap((dir) =>
      readdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true })
        .filter((name) => /\.(jsx?|tsx?|mjs)$/.test(name) && !/node_modules/.test(name))
        .map((name) => [`${dir}/${name}`, read(`../${dir}/${name}`)]));
    expect(sources.length).toBeGreaterThan(100);
    for (const [path, text] of sources) {
      expect(text, path).not.toMatch(/civic_local_jurisdictions(\.|!inner\()[^"]*org_id/);
      expect(text, path).not.toMatch(/from\("civic_local_jurisdictions"\)[^\n]*\.eq\("org_id"/);
    }
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/shared-rows-hide-contributor-ids-db.test.js");
  });
});

const n = (suffix) => `50908322-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const ID = {
  orgA: n(1), orgB: n(2),
  staffA: n(101), memberA: n(102), staffB: n(201), memberB: n(202), operatorA: n(301), operatorB: n(302),
};
const CHAPTER_A = "shared-ids-proof-harbor";
const CHAPTER_B = "shared-ids-proof-inland";
const OFFICE_A = "shared-ids-proof-office-harbor";
const OFFICE_B = "shared-ids-proof-office-inland";
const PLACE = "4299832";
const SESSION = (id) => `50908322-0000-4000-8000-9${id.slice(-11)}`;
// operatorA verified only the contributing organization's binding.
const A_PEOPLE = [ID.staffA, ID.memberA, ID.operatorA];
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("shared rows hide contributor ids on a disposable database", () => {
  let db;
  const ref = {};

  async function as(userId, sql, values = []) {
    await db.query("savepoint as_user");
    try {
      const claims = { sub: userId, role: "authenticated", session_id: SESSION(userId), aal: "aal2" };
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.query("set local role authenticated");
      const rows = (await db.query(sql, values)).rows;
      await db.query("reset role");
      await db.query("release savepoint as_user");
      return rows;
    } catch (error) {
      await db.query("rollback to savepoint as_user");
      await db.query("reset role");
      throw error;
    }
  }
  async function service(sql, values = []) {
    await db.query("savepoint as_service");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await db.query("set local role service_role");
    try {
      return (await db.query(sql, values)).rows;
    } finally {
      await db.query("reset role");
      await db.query("release savepoint as_service");
    }
  }
  const visibleColumns = (table) => VISIBLE[table].join(", ");

  // Every row the persona can read from the three tables, the view over them
  // and the own-organization functions (for its own chapter), as one string.
  async function everythingReadableBy(userId, ownChapter) {
    const parts = [];
    for (const table of Object.keys(VISIBLE)) parts.push(await as(userId, `select ${visibleColumns(table)} from ${table}`));
    parts.push(await as(userId, "select * from public.civic_member_officials_keyed"));
    parts.push(await as(userId, "select * from public.list_own_organization_chapter_union_org_bindings()"));
    parts.push(await as(userId, "select * from public.civic_local_jurisdictions_for_org($1)", [ownChapter]));
    parts.push(await as(userId, "select * from public.civic_local_officials_for_org($1)", [ownChapter]));
    return JSON.stringify(parts);
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "shared-rows-hide-contributor-ids-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    const people = [
      [ID.staffA, ID.orgA, CHAPTER_A], [ID.memberA, ID.orgA, CHAPTER_A],
      [ID.staffB, ID.orgB, CHAPTER_B], [ID.memberB, ID.orgB, CHAPTER_B],
    ];
    for (const operator of [ID.operatorA, ID.operatorB]) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [operator, `shared-ids-operator-${operator.slice(-3)}@example.invalid`]);
    }
    for (const [org, slug, name, creator] of [[ID.orgA, "shared-ids-proof-harbor", "Harbor Proof Local", ID.staffA], [ID.orgB, "shared-ids-proof-inland", "Inland Proof Local", ID.staffB]]) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [creator, `shared-ids-${creator.slice(-3)}@example.invalid`]);
      await db.query("insert into public.organizations(id, slug, name, created_by) values ($1, $2, $3, $4)", [org, slug, name, creator]);
    }
    await db.query("insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, 'Harbor Main', $1, $2, false, 9961), ($3, 'Inland Main', $3, $4, false, 9962)",
      [CHAPTER_A, ID.orgA, CHAPTER_B, ID.orgB]);
    for (const [id, org, chapter] of people) {
      if (id === ID.memberA || id === ID.memberB) {
        await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `shared-ids-${id.slice(-3)}@example.invalid`]);
      }
      await db.query("insert into auth.sessions(id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [SESSION(id), id]);
      await db.query("insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'Shared ids proof', 'totp', 'verified', now(), now())", [id]);
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [id, chapter]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [id, chapter]);
    }
    for (const [org, staff] of [[ID.orgA, ID.staffA], [ID.orgB, ID.staffB]]) {
      await db.query("insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2), ($1, $2, 'steward', $2)", [org, staff]);
    }
    for (const [id, file, name] of [[OFFICE_A, 790832201, "Harbor Ferry Workers"], [OFFICE_B, 790832202, "Inland Rail Workers"]]) {
      await db.query(`insert into public.union_orgs(id, olms_file_number, name, affiliation, level, city, state, sector_tags, enrichment_status, atlas_manifest_sha)
        values ($1, $2, $3, 'SYNTHETIC', 'local', 'Springfield', 'IL', array['transit'], 'no_web_presence', 'shared-ids-proof')`, [id, file, name]);
    }
    await db.query("insert into private.compass_platform_operators(user_id, granted_note) values ($1, 'shared ids proof'), ($2, 'shared ids proof')", [ID.operatorA, ID.operatorB]);
    // Each organization asks for its binding; the operator verifies both.
    expect(await as(ID.staffA, "select public.request_chapter_union_org_binding($1) data", [OFFICE_A])).toHaveLength(1);
    expect(await as(ID.staffB, "select public.request_chapter_union_org_binding($1) data", [OFFICE_B])).toHaveLength(1);
    for (const [chapter, office, operator] of [[CHAPTER_A, OFFICE_A, ID.operatorA], [CHAPTER_B, OFFICE_B, ID.operatorB]]) {
      await service("select public.verify_chapter_union_org_binding($1, $2, true, 'Reviewed', $3)", [chapter, office, operator]);
    }
    // Harbor's officer enters a shared exact place with one official; Inland
    // enters the same place for itself, and both members live there.
    await db.query("insert into public.civic_places(geoid, kind, name, state, source, retrieved_at) values ($1, 'place', 'Proofton city', 'PA', 'proof', now())", [PLACE]);
    [{ id: ref.jurisdictionA }] = await as(ID.staffA, `insert into public.civic_local_jurisdictions(org_id, name, kind, state, place_geoid, shared, created_by)
      values ($1, 'Proofton', 'city', 'PA', $2, true, $3) returning id`, [CHAPTER_A, PLACE, ID.staffA]);
    [{ id: ref.officialA }] = await as(ID.staffA, `insert into public.civic_local_officials(jurisdiction_id, office, full_name, created_by)
      values ($1, 'Mayor', 'Noni West', $2) returning id`, [ref.jurisdictionA, ID.staffA]);
    [{ id: ref.jurisdictionB }] = await as(ID.staffB, `insert into public.civic_local_jurisdictions(org_id, name, kind, state, place_geoid, shared, created_by)
      values ($1, 'Proofton', 'city', 'PA', $2, false, $3) returning id`, [CHAPTER_B, PLACE, ID.staffB]);
    [{ id: ref.officialB }] = await as(ID.staffB, `insert into public.civic_local_officials(jurisdiction_id, office, full_name, created_by)
      values ($1, 'Council member', 'Ada Ruiz', $2) returning id`, [ref.jurisdictionB, ID.staffB]);
    for (const id of [ID.memberA, ID.memberB]) {
      await db.query(`insert into public.civic_member_addresses(user_id, full_name, line1, city, state, postal_code, consent_version)
        values ($1, 'Proof Member', '1 Main St', 'Proofton', 'PA', '19000', '2026-09')`, [id]);
      await db.query("insert into public.civic_user_places(user_id, geoid, resolved_at) values ($1, $2, now())", [id, PLACE]);
    }
  }, 60_000);
  beforeEach(async () => { await db.query("savepoint proof_case"); });
  afterEach(async () => { await db.query("rollback to savepoint proof_case"); });
  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("keeps the rows shared with the other organization's staff and plain member", async () => {
    const bindings = await as(ID.staffB, "select chapter_id, union_org_id, status from public.chapter_union_org_bindings where union_org_id = $1", [OFFICE_A]);
    expect(bindings).toEqual([{ chapter_id: CHAPTER_A, union_org_id: OFFICE_A, status: "verified" }]);
    for (const reader of [ID.staffB, ID.memberB]) {
      expect(await as(reader, "select id, name, shared from public.civic_local_jurisdictions where id = $1", [ref.jurisdictionA]))
        .toEqual([{ id: ref.jurisdictionA, name: "Proofton", shared: true }]);
      expect(await as(reader, "select id, full_name from public.civic_local_officials where jurisdiction_id = $1", [ref.jurisdictionA]))
        .toEqual([{ id: ref.officialA, full_name: "Noni West" }]);
    }
  });

  it("refuses the id columns, and a whole-row read, to every member of any organization", async () => {
    for (const reader of [ID.staffB, ID.memberB, ID.staffA, ID.memberA]) {
      for (const [table, hidden] of Object.entries(HIDDEN)) {
        for (const column of [...hidden, "*"]) {
          await expect(as(reader, `select ${column} from ${table} limit 1`), `${reader} ${table}.${column}`)
            .rejects.toMatchObject({ code: "42501" });
        }
      }
      await expect(as(reader, "select id from public.civic_local_jurisdictions where org_id = $1", [CHAPTER_A]))
        .rejects.toMatchObject({ code: "42501" });
    }
  });

  it("finds no person id of the contributing organization, and no chapter id in the civic rows, in anything the other organization reads", async () => {
    for (const reader of [ID.staffB, ID.memberB]) {
      const seen = await everythingReadableBy(reader, CHAPTER_B);
      for (const person of A_PEOPLE) expect(seen, `${reader} sees ${person}`).not.toContain(person);
      // The shared rows themselves are there.
      expect(seen).toContain(ref.jurisdictionA);
      expect(seen).toContain(ref.officialA);
      const civicParts = JSON.stringify([
        await as(reader, `select ${visibleColumns("public.civic_local_jurisdictions")} from public.civic_local_jurisdictions`),
        await as(reader, `select ${visibleColumns("public.civic_local_officials")} from public.civic_local_officials`),
        await as(reader, "select * from public.civic_member_officials_keyed"),
      ]);
      expect(civicParts, `${reader} civic rows name the contributing chapter`).not.toContain(CHAPTER_A);
    }
    // A binding is keyed by its chapter: chapter_id is its only Harbor reference.
    const binding = await as(ID.staffB, `select ${visibleColumns("public.chapter_union_org_bindings")} from public.chapter_union_org_bindings where chapter_id = $1`, [CHAPTER_A]);
    expect(binding).toHaveLength(1);
    expect(Object.keys(binding[0]).sort()).toEqual([...VISIBLE["public.chapter_union_org_bindings"]].sort());
  });

  it("refuses the other organization's own-organization reads and returns none of the contributor's bindings", async () => {
    for (const reader of [ID.staffB, ID.memberB]) {
      await expect(as(reader, "select * from public.civic_local_jurisdictions_for_org($1)", [CHAPTER_A])).rejects.toMatchObject({ code: "42501" });
      await expect(as(reader, "select * from public.civic_local_officials_for_org($1)", [CHAPTER_A])).rejects.toMatchObject({ code: "42501" });
      const own = await as(reader, "select chapter_id from public.list_own_organization_chapter_union_org_bindings()");
      expect(own.map((row) => row.chapter_id)).not.toContain(CHAPTER_A);
    }
  });

  it("still shows the contributing organization its own ids", async () => {
    expect(await as(ID.staffA, "select chapter_id, union_org_id, requested_by, verified_by from public.list_own_organization_chapter_union_org_bindings()"))
      .toEqual([{ chapter_id: CHAPTER_A, union_org_id: OFFICE_A, requested_by: ID.staffA, verified_by: ID.operatorA }]);
    expect(await as(ID.memberA, "select chapter_id, requested_by from public.list_own_organization_chapter_union_org_bindings()"))
      .toEqual([{ chapter_id: CHAPTER_A, requested_by: ID.staffA }]);
    for (const reader of [ID.staffA, ID.memberA]) {
      expect(await as(reader, "select id, org_id, created_by from public.civic_local_jurisdictions_for_org($1)", [CHAPTER_A]))
        .toEqual([{ id: ref.jurisdictionA, org_id: CHAPTER_A, created_by: ID.staffA }]);
      expect(await as(reader, "select id, jurisdiction_id, created_by from public.civic_local_officials_for_org($1)", [CHAPTER_A]))
        .toEqual([{ id: ref.officialA, jurisdiction_id: ref.jurisdictionA, created_by: ID.staffA }]);
    }
    // The staff of the other organization see their own, and only their own.
    expect(await as(ID.staffB, "select chapter_id, requested_by from public.list_own_organization_chapter_union_org_bindings()"))
      .toEqual([{ chapter_id: CHAPTER_B, requested_by: ID.staffB }]);
  });

  // Gate round 1 P2: the view is security invoker and service_role has no
  // USAGE on schema private, so its ordering helper lives in public and
  // service_role may execute it. A service-role read of the view still works.
  it("keeps a service-role read of the officials view working", async () => {
    const rows = await service("select user_id, full_name from public.civic_member_officials_keyed where district_level = 'local' and user_id = any($1)",
      [[ID.memberA, ID.memberB]]);
    expect(rows.map((row) => row.user_id).sort()).toEqual([ID.memberA, ID.memberB].sort());
    expect(await service("select has_function_privilege('service_role', 'public.civic_local_jurisdiction_own(uuid)', 'EXECUTE') ok")).toEqual([{ ok: true }]);
  });

  it("keeps each member's own chapter entry first for a place two chapters entered", async () => {
    for (const [reader, official] of [[ID.memberA, "Noni West"], [ID.memberB, "Ada Ruiz"]]) {
      const local = await as(reader, "select full_name from public.civic_member_officials_keyed where district_level = 'local'");
      expect(local, reader).toEqual([{ full_name: official }]);
    }
  });

  it("keeps the officer write path: the contributing officer edits its officials, the other organization's officer cannot", async () => {
    const [{ id }] = await as(ID.staffA, "insert into public.civic_local_officials(jurisdiction_id, office, full_name, created_by) values ($1, 'Clerk', 'Lee Park', $2) returning id",
      [ref.jurisdictionA, ID.staffA]);
    expect(await as(ID.staffA, "update public.civic_local_officials set party = 'Independent' where id = $1 returning id", [id])).toEqual([{ id }]);
    expect(await as(ID.staffB, "update public.civic_local_officials set party = 'Other' where id = $1 returning id", [id])).toEqual([]);
    expect(await as(ID.staffB, "delete from public.civic_local_officials where id = $1 returning id", [id])).toEqual([]);
    await expect(as(ID.staffB, "insert into public.civic_local_officials(jurisdiction_id, office, full_name) values ($1, 'Clerk', 'Intruder')", [ref.jurisdictionA]))
      .rejects.toMatchObject({ code: "42501" });
    expect(await as(ID.staffA, "delete from public.civic_local_officials where id = $1 returning id", [id])).toEqual([{ id }]);
    expect(await as(ID.staffA, "update public.civic_local_jurisdictions set name = 'Proofton City' where id = $1 returning id", [ref.jurisdictionA]))
      .toEqual([{ id: ref.jurisdictionA }]);
  });
});
