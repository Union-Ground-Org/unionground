// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";
import { beforeSameRefusals, SAME_REFUSALS_MIGRATION } from "./helpers/refusals-same-for-other-organizations.js";

// BUG-UG-CHECKLIST-TEMPLATE-WRITE-AUDIENCE-NOT-SUBSET-READ-AUDIENCE-CHAPTER-20260921.
//
// casework_checklist_templates read through private.has_organization_role
// while casework_create_checklist_template wrote through
// private.member_has_chapter_role, which a member_role_chapters coordinator
// satisfies with no organization grant: their save landed and their next hub
// load selected nothing. 20260925620100 states the audience once, as
// private.casework_checklist_template_audience(organization, chapter,
// authorship): authorship is the chapter write role, and the read is the
// organization staff role OR that same term.
//
// The offline half pins the latest definitions and the contract. The live half
// (disposable loopback only) runs the routine for real as six actors, reads
// each accepted row back as its author, and fails if any actor is admitted by
// the write path and refused by the read path.
const MIGRATION = "20260925620100_casework_checklist_template_audience.sql";
const HELPER = "private.casework_checklist_template_audience";
const ROUTINE = "public.casework_create_checklist_template";
const READ_CALL = `${HELPER}(organization_id, chapter_id, false)`;
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));

function latestDefinition(name) {
  const pattern = new RegExp(`create\\s+or\\s+replace\\s+function\\s+${name.replace(".", "\\.")}\\s*\\(`, "i");
  const file = migrationFiles().filter((entry) => pattern.test(stripComments(entry.sql))).at(-1);
  return { name: file?.name, body: file ? stripComments(fnBody(file.sql, name)).replace(/\s+/g, " ") : "" };
}

describe("casework checklist template audience predicate", () => {
  it("states the audience once, with authorship as a disjunct of the read", () => {
    const helper = latestDefinition(HELPER);
    expect(helper.name).toBe(MIGRATION);
    expect(helper.body).toContain(
      "private.has_organization_role(p_organization_id, array['steward','coordinator','advisor','admin','vp']) or audience.chapter_write",
    );
    expect(helper.body).toContain("and (not coalesce(p_authorship, false) or audience.chapter_write)");
    expect(helper.body).toContain("where c.id = p_chapter_id and c.organization_id = p_organization_id");
    expect(helper.body).toContain("private.member_has_chapter_role(p_chapter_id, array['coordinator','advisor','admin','vp']) as chapter_write");
  });

  it("routes the read policy and the authoring routine through the one predicate", () => {
    const sql = stripComments(migrationFiles().find((entry) => entry.name === MIGRATION).sql).replace(/\s+/g, " ");
    expect(sql).toContain(`alter policy casework_checklist_templates_staff on public.casework_checklist_templates using (${READ_CALL});`);
    expect(sql).not.toMatch(/\b(?:create|drop) policy\b/);
    const routine = latestDefinition(ROUTINE);
    // #8365 re-emits the routine with a same-refusal chapter lookup; with that
    // undone it is this migration's body.
    expect(routine.name).toBe(SAME_REFUSALS_MIGRATION);
    const source = (file) => parseFunctions(migrationFiles().find((entry) => entry.name === file).sql, file)
      .find((entry) => entry.name === ROUTINE).source;
    expect(beforeSameRefusals(ROUTINE, source(SAME_REFUSALS_MIGRATION))).toBe(source(MIGRATION));
    // The installed case-graph wrapper stays the first statement.
    expect(routine.body).toMatch(/\$function\$ begin perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\); declare /);
    expect(routine.body).toContain(`if not ${HELPER}(v_org, p_chapter_id, true) then raise exception 'chapter not found' using errcode = 'P0002'; end if;`);
    expect(routine.body).not.toContain("private.member_has_chapter_role(");
    expect(routine.body).toContain("'checklist_created', 'checklist_template', v_row.id");
  });

  it("pins the predicate, the policy and the routine in the database contract", () => {
    const helper = contract.functions.find((entry) => entry.sig.startsWith(`${HELPER}(`));
    expect(helper).toMatchObject({ secdef: true, exec: "authenticated" });
    const policy = contract.policies.find((entry) => entry.table === "casework_checklist_templates"
      && entry.name === "casework_checklist_templates_staff");
    expect(policy.qual).toBe(READ_CALL);
    expect(policy.qualContains).toBeUndefined();
    const routine = contract.functions.find((entry) => entry.sig.startsWith(`${ROUTINE}(`));
    expect(routine.bodyContains).toContain(`${HELPER}(v_org, p_chapter_id, true)`);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

// [name, organization grant roles, member_role_chapters roles, home organization]
const ACTORS = [
  ["admin", ["admin"], ["admin"], "orgA"],
  // The record's actor: the coordinator hat exists only as a
  // member_role_chapters row, with no organization role grant behind it.
  ["chapterOnly", [], ["coordinator"], "orgA"],
  ["advisor", ["advisor"], [], "orgA"],
  ["steward", ["steward"], ["steward"], "orgA"],
  ["member", [], [], "orgA"],
  ["outsider", ["admin"], ["admin"], "orgB"],
];
const ITEMS = JSON.stringify([{ label: "Collect the write-up and the member's account", required: true }]);

live("the live checklist template audience", () => {
  let client;
  const ids = Object.fromEntries(["orgA", "orgB", ...ACTORS.flatMap(([name]) => [name, `${name}Session`])].map((key) => [key, randomUUID()]));
  const chapter = { orgA: `template-audience-a-${ids.orgA.slice(0, 8)}`, orgB: `template-audience-b-${ids.orgB.slice(0, 8)}` };
  let savepoint = 0;
  let seeded;

  async function as(name, role = "authenticated") {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
      sub: ids[name], role, session_id: ids[`${name}Session`], aal: "aal2",
    })]);
    await client.query(`set local role ${role}`);
  }

  // Each attempt is rolled back, so every actor is measured against the same
  // catalogue. An accepted create is read back by its author before the
  // rollback: that read-back is the only form that catches this defect.
  async function attemptCreate(title) {
    const label = `template_audience_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    try {
      const created = (await client.query(
        "select id from public.casework_create_checklist_template($1, 'Grievance', 'review', $2, $3::jsonb)",
        [chapter.orgA, title, ITEMS])).rows[0];
      const selectedBack = (await client.query(
        "select count(*)::int n from public.casework_checklist_templates where id = $1", [created.id])).rows[0].n === 1;
      return { accepted: true, code: null, selectedBack };
    } catch (error) {
      return { accepted: false, code: error.code, selectedBack: false };
    } finally {
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
    }
  }

  async function reads(id) {
    return (await client.query("select count(*)::int n from public.casework_checklist_templates where id = $1", [id])).rows[0].n === 1;
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-checklist-template-audience-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    for (const [name] of ACTORS) {
      await client.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}')", [ids[name], `${ids[name]}@example.invalid`]);
    }
    for (const [org, owner] of [["orgA", "admin"], ["orgB", "outsider"]]) {
      await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [ids[org], chapter[org], ids[owner]]);
      await client.query(
        "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9906)",
        [chapter[org], ids[org]],
      );
      await client.query("insert into public.org_security_policy (id, organization_id, require_staff_mfa) values (true, $1, true)", [ids[org]]);
    }
    for (const [name, orgRoles, chapterRoles, org] of ACTORS) {
      const user = ids[name];
      await client.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [ids[`${name}Session`], user]);
      await client.query(
        "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'Template audience factor', 'totp', 'verified', now(), now())",
        [randomUUID(), user],
      );
      await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids[org], user]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [user, chapter[org]]);
      await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [user, chapter[org]]);
      for (const role of orgRoles) {
        await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, $3, $2)", [ids[org], user, role]);
      }
      for (const role of chapterRoles) {
        await client.query("insert into public.member_roles (user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [user, role, chapter[org]]);
        await client.query("insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [user, role, chapter[org]]);
      }
    }
    // The template every read below is measured against, authored by the
    // organization admin.
    await as("admin");
    seeded = (await client.query(
      "select id from public.casework_create_checklist_template($1, 'Grievance', 'intake', 'Audience seed template', $2::jsonb)",
      [chapter.orgA, ITEMS])).rows[0];
    await client.query("reset role");
  }, 60_000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("lets the chapter-hat coordinator create a template and select it back", async () => {
    await as("chapterOnly");
    const helpers = (await client.query(
      `select private.member_has_chapter_role($1, array['coordinator','advisor','admin','vp']) chapter_role,
              private.has_organization_role($2, array['steward','coordinator','advisor','admin','vp']) org_role`,
      [chapter.orgA, ids.orgA])).rows[0];
    // The two role helpers still disagree for this actor; that is why the
    // audience had to be stated once.
    expect(helpers).toEqual({ chapter_role: true, org_role: false });
    expect(await attemptCreate("Chapter hat template")).toEqual({ accepted: true, code: null, selectedBack: true });
    // The same caller also reads the chapter's existing templates, as the hub does.
    expect(await reads(seeded.id)).toBe(true);
  });

  it("refuses the organization steward's create and keeps their organization-wide reads", async () => {
    await as("steward");
    expect(await attemptCreate("Steward template")).toMatchObject({ accepted: false, code: "P0002" });
    expect(await reads(seeded.id)).toBe(true);
  });

  it("binds the installed read policy to the one predicate", async () => {
    await client.query("reset role");
    const { rows } = await client.query(`
      select polname, pg_catalog.pg_get_expr(polqual, polrelid) qual
      from pg_catalog.pg_policy
      where polrelid = 'public.casework_checklist_templates'::regclass and polname <> 'mfa_assurance'
      order by polname`);
    expect(rows).toEqual([{ polname: "casework_checklist_templates_staff", qual: READ_CALL }]);
  });

  it("admits no actor to the write path that the read path refuses", async () => {
    const observed = {};
    for (const [name] of ACTORS) {
      await as(name);
      const tableRead = await reads(seeded.id);
      const predicate = (await client.query(
        `select ${HELPER}($1, $2, false) read_admitted, ${HELPER}($1, $2, true) write_admitted`,
        [ids.orgA, chapter.orgA])).rows[0];
      const create = await attemptCreate(`Enumerated ${name}`);
      observed[name] = { create: create.accepted, ...predicate, tableRead };
      expect(predicate.read_admitted, `${name}: the policy and the predicate must agree`).toBe(tableRead);
      if (predicate.write_admitted) expect(tableRead, `${name}: write admitted, read refused`).toBe(true);
      if (create.accepted) expect(create.selectedBack, `${name}: wrote a row they cannot select`).toBe(true);
      else expect(create.code, `${name}: a refused create must be the routine's refusal`).toBe("P0002");
      expect(create.accepted, `${name}: the routine and the predicate must state one audience`).toBe(predicate.write_admitted);
    }
    const both = { create: true, read_admitted: true, write_admitted: true, tableRead: true };
    const readOnly = { create: false, read_admitted: true, write_admitted: false, tableRead: true };
    const neither = { create: false, read_admitted: false, write_admitted: false, tableRead: false };
    expect(observed).toEqual({
      admin: both, chapterOnly: both, advisor: both, steward: readOnly, member: neither, outsider: neither,
    });
  }, 60_000);
});
