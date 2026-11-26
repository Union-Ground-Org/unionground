// @vitest-environment node
//
// DEBT-UG-MEMBER-CASE-VISIBILITY-PREDICATE-SINGLE-SOURCE-20260917
// (controller decision 2026-09-26: the NARROW variant from).
//
// The member_cases restriction predicate was restated in the coordinator
// SELECT policy and in two byte-identical by-id SECURITY DEFINER helpers.
// 20260925995000 installs one row-typed predicate,
// private.member_case_row_visible(public.member_cases), and makes those three
// per-row gates consume it. The set-based hot-path mirrors (search, clause
// grievance counts, the procedures reader, reminder delivery) stay inline by
// decision and are tied to the predicate here: over one shared actor x case
// matrix on a disposable stack, the live policies must equal the predicate
// under their scope conjunct, the wrappers must equal the predicate, and every
// mirror must equal the live policies. A predicate is only ever proved by
// evaluating it; the offline half pins the SQL so the suite still guards the
// text without a database.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("member_case_visibility_row_helper"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const rowBody = squash(stripComments(fnBody(sql, "private.member_case_row_visible")));
const callerBody = squash(stripComments(fnBody(sql, "private.member_case_visible_to_caller")));
const clearedBody = squash(stripComments(fnBody(sql, "private.member_case_restriction_cleared")));

describe("member case visibility single-source migration", () => {
  it("sorts after the attachment lifecycle gate it wraps and guards both predecessor bodies", () => {
    expect(findMigrationName("member_case_visibility_row_helper")
      > "20260917105000_case_attachment_lifecycle_restriction_gate.sql").toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    for (const helper of ["private.member_case_visible_to_caller(uuid)", "private.member_case_restriction_cleared(uuid)"]) {
      expect(flat).toContain(`'${helper}'`);
    }
    expect(flat).toContain("d886c380c04e2cc8b4f55a2b71658cc9f4ab0a5e4a881feb64b8b9f0e5abff1d");
    expect(flat).toContain("raise exception 'unreviewed % predecessor: %', helper, digest using errcode = '55000'");
  });

  it("states the single predicate once, row-typed, with no member_cases read of its own", () => {
    expect(flat).toContain("create or replace function private.member_case_row_visible(p_case public.member_cases) returns boolean language sql stable security definer set search_path = ''");
    for (const branch of [
      "not p_case.is_restricted",
      "p_case.user_id = (select auth.uid())",
      "(p_case.steward_user_id = (select auth.uid()) and public.member_has_role(array['steward']))",
      "p_case.coordinator_user_id = (select auth.uid())",
      "private.has_organization_role(p_case.organization_id, array['advisor','admin','vp'])",
      "private.casework_actor_has_active_grant(p_case.id)",
    ]) expect(rowBody).toContain(branch);
    expect(rowBody).not.toContain("from public.member_cases");
    expect(rowBody).not.toContain("set role");
    // A policy evaluates it as the querying role, so authenticated alone holds EXECUTE.
    expect(flat).toContain("revoke all on function private.member_case_row_visible(public.member_cases) from public, anon, authenticated, service_role;");
    expect(flat).toContain("grant execute on function private.member_case_row_visible(public.member_cases) to authenticated;");
  });

  it("turns both by-id helpers into thin wrappers with no client EXECUTE", () => {
    expect(callerBody).toContain("from public.member_cases c where c.id = p_case_id and private.member_case_row_visible(c)");
    expect(clearedBody).toContain("as $function$ select private.member_case_visible_to_caller(p_case_id); $function$;");
    for (const body of [callerBody, clearedBody]) {
      expect(body).not.toContain("is_restricted");
      expect(body).not.toContain("casework_actor_has_active_grant");
    }
    for (const helper of ["member_case_visible_to_caller", "member_case_restriction_cleared"]) {
      expect(flat).toContain(`revoke all on function private.${helper}(uuid) from public, anon, authenticated, service_role;`);
      expect(flat).not.toContain(`grant execute on function private.${helper}`);
    }
  });

  it("re-emits only the coordinator policy, calling the predicate on the candidate row", () => {
    expect(flat).toContain(
      "create policy member_cases_select_coordinator on public.member_cases for select to authenticated using ("
      + " public.staff_can_see_user(user_id, 'coordinator') and private.member_case_row_visible(member_cases) );",
    );
    expect(flat).not.toContain("member_cases_select_own");
    expect(flat).not.toContain("member_cases_select_steward");
    expect(flat).toContain("qual like '%private.member_case_row_visible(member_cases.*)%'");
  });

  it("pins the installed shapes in the database contract", () => {
    const row = contract.functions.find((entry) => entry.sig === "private.member_case_row_visible(p_case member_cases)");
    expect(row).toMatchObject({ secdef: true, exec: "authenticated" });
    expect(row.bodyContains).toEqual(expect.arrayContaining([
      "private.case_scope_and_identity_allowed(p_case)",
      "not p_case.is_restricted",
      "(p_case.steward_user_id = (select auth.uid()) and public.member_has_role(array['steward']))",
      "private.casework_actor_has_active_grant(p_case.id)",
    ]));
    expect(row.bodyForbids).toEqual(expect.arrayContaining(["from public.member_cases", "set role"]));
    for (const sig of ["private.member_case_visible_to_caller(p_case_id uuid)", "private.member_case_restriction_cleared(p_case_id uuid)"]) {
      const entry = contract.functions.find((candidate) => candidate.sig === sig);
      expect(entry, sig).toMatchObject({ secdef: true, exec: "" });
      expect(entry.bodyContains.some((needle) => needle.includes("member_case"))).toBe(true);
      expect(entry.bodyContains).not.toContain("not c.is_restricted");
    }
    // The row reader now composes own/staff/default-steward scope with this
    // restriction predicate instead of repeating the policy OR expression.
    const policy = contract.policies.find((entry) => entry.table === "member_cases" && entry.name === "member_cases_select");
    expect(policy.qual).toBe("private.chapter_case_readable(member_cases.*)");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the single predicate, the policies, the wrappers and the inline mirrors agree over one matrix", () => {
  let client;
  const world = {};
  const ARTICLE = "Article 991";
  const TOKEN = `vismatrix${randomUUID().replace(/-/g, "").slice(0, 10)}`;

  async function person(label, { org = world.org, chapter = world.chapter } = {}) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [id, `${id}-${label}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic matrix factor','totp','verified',now(),now())", [randomUUID(), id]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    return { id, session, label, org, chapter };
  }

  async function grantRole(who, role) {
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [who.id, role, who.chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [who.id, role, who.chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [who.org, who.id, role]);
  }

  async function claims(who) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: who.id, session_id: who.session, aal: "aal2" }),
    ]);
  }
  async function become(who) {
    await claims(who);
    await client.query("set local role authenticated");
  }

  async function seedCase({ restricted, steward = null, coordinator = null, suffix }) {
    const id = randomUUID();
    await client.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,articles,step,is_restricted,restriction_reason,restricted_at,restricted_by,steward_user_id,coordinator_user_id)
       values ($1,$2,$3,$4,'Grievance',$5,'Intake',$6,$7,$8,$9,$10,$11)`,
      [id, world.owner.id, `VM-${id.slice(0, 8)}`, `${TOKEN} ${suffix} case`, ARTICLE, restricted,
        restricted ? "Restricted for this proof run" : null, restricted ? new Date().toISOString() : null,
        restricted ? world.owner.id : null, steward, coordinator],
    );
    return id;
  }

  // The predicate itself, asked as the definer owner with the actor's claims:
  // no client role may execute the by-id wrappers, and the policy is the only
  // client-side caller of the row predicate.
  const predicate = async (who, caseId) => {
    await claims(who);
    const { rows } = await client.query(
      "select private.member_case_row_visible(c) as row, private.member_case_visible_to_caller(c.id) as caller, private.member_case_restriction_cleared(c.id) as cleared from public.member_cases c where c.id = $1",
      [caseId],
    );
    return rows[0];
  };
  const selects = async (who, caseId) => {
    await become(who);
    return (await client.query("select exists(select 1 from public.member_cases where id = $1) as visible", [caseId])).rows[0].visible;
  };
  const searches = async (who, caseId) => {
    await become(who);
    const { rows } = await client.query("select case_id from public.search_member_cases($1, 50)", [TOKEN]);
    return rows.some((row) => row.case_id === caseId);
  };
  const counts = async (who) => {
    await become(who);
    const { rows } = await client.query("select public.list_contract_clause_grievance_counts() as counts");
    return Object.fromEntries((rows[0].counts ?? []).map((row) => [row.article, row.count]))[ARTICLE.toLowerCase()] ?? 0;
  };
  // The reader refuses a case it may not read with a raised error rather than
  // null, so each probe runs under its own savepoint.
  const procedure = async (who, caseId) => {
    await become(who);
    await client.query("savepoint probe");
    try {
      return (await client.query("select public.casework_get_case_procedure($1) as result", [caseId])).rows[0].result !== null;
    } catch (error) {
      if (!/case not found/u.test(error.message)) throw error;
      return false;
    } finally {
      await client.query("rollback to savepoint probe");
    }
  };
  const reminderRead = async (who, caseId) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
    return (await client.query("select private.casework_reminder_owner_can_read($1,$2) as ok", [who.id, caseId])).rows[0].ok;
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-case-visibility-single-source-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    world.org = randomUUID();
    world.otherOrg = randomUUID();
    world.chapter = `vm-${world.org.slice(0, 8)}`;
    world.otherChapter = `vm-other-${world.otherOrg.slice(0, 8)}`;
    // An organization-wide coordinator grant reaches every chapter of its
    // organization, so the out-of-scope actor is a coordinator of ANOTHER
    // organization, not of another chapter.
    for (const [org, chapter, order] of [[world.org, world.chapter, 9911], [world.otherOrg, world.otherChapter, 9912]]) {
      await client.query("insert into public.organizations(id,slug,name) values($1,$2,$2)", [org, chapter]);
      await client.query("insert into public.chapters(id,name,slug,region,organization_id,is_default,order_index) values($1,$1,$1,'proof',$2,false,$3)", [chapter, org, order]);
      await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
    }

    world.owner = await person("owner");
    world.member = await person("member");
    world.steward = await person("steward");
    world.chapterCoordinator = await person("chapter-coordinator");
    world.caseCoordinator = await person("case-coordinator");
    world.grantee = await person("granted-coordinator");
    world.officer = await person("advisor-coordinator");
    world.advisorOnly = await person("advisor-only");
    world.outsider = await person("other-organization-coordinator", { org: world.otherOrg, chapter: world.otherChapter });
    await grantRole(world.steward, "steward");
    for (const who of [world.chapterCoordinator, world.caseCoordinator, world.grantee, world.officer]) await grantRole(who, "coordinator");
    await grantRole(world.outsider, "coordinator");
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'advisor',$2)", [world.org, world.officer.id]);
    // An organization advisor who holds NO coordinator scope: the predicate
    // clears the restriction for them (the advisor/admin/vp branch), but the
    // coordinator SELECT policy's scope conjunct never admits them.
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'advisor',$2)", [world.org, world.advisorOnly.id]);

    world.openCase = await seedCase({ restricted: false, steward: world.steward.id, coordinator: world.caseCoordinator.id, suffix: "open" });
    world.restrictedCase = await seedCase({ restricted: true, steward: world.steward.id, coordinator: world.caseCoordinator.id, suffix: "restricted" });
    const bound = (await client.query("select organization_id, chapter_id from public.member_cases where id=$1", [world.restrictedCase])).rows[0];
    expect(bound.organization_id).toBe(world.org);
    await client.query(
      "insert into public.casework_access_grants(case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason) values($1,$2,$3,$4,$5,'Proof run explicit access grant')",
      [world.restrictedCase, bound.organization_id, bound.chapter_id, world.grantee.id, world.owner.id],
    );
    await client.query(
      "insert into public.contract_clauses(organization_id,article,section,category,title,summary,status) values($1,$2,'1','Proof','Proof clause','Proof clause summary','published')",
      [world.org, ARTICLE],
    );
    // One active organization-wide procedure so the procedures reader has
    // something to return for a case it may read.
    await become(world.chapterCoordinator);
    const steps = JSON.stringify([
      { key: "intake", label: "Intake", deadline_rule: { kind: "none", count: 0, from: "step_entry" } },
      { key: "finish", label: "Finish", deadline_rule: { kind: "none", count: 0, from: "step_entry" }, terminal: true },
    ]);
    await client.query("select public.casework_save_procedure(null,null,null,'Matrix procedure',$1,null)", [steps]);
    await client.query("reset role");
  }, 60000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  // Expected restriction clearance per actor on the restricted case. On the
  // open case the predicate is true for everyone by its first branch.
  const clears = {
    owner: true, member: false, steward: true, chapterCoordinator: false,
    caseCoordinator: true, grantee: true, officer: true, outsider: false, advisorOnly: true,
  };
  // Who reaches the case rows at all: the owner through select_own, the
  // steward through select_steward, the organization's coordinators through
  // the coordinator scope. The unrelated member and the other organization's
  // coordinator never do.
  const inScope = {
    owner: true, member: false, steward: true, chapterCoordinator: true,
    caseCoordinator: true, grantee: true, officer: true, outsider: false, advisorOnly: false,
  };
  // The definer readers (procedures, reminder delivery) admit organization
  // officers through their own scope conjunct, which the coordinator SELECT
  // policy does not; that is scope, not the restriction predicate this record
  // unifies, so the advisor-only actor is pinned on its own below rather than
  // folded into the "equals the live policies" loops.
  const staff = ["steward", "chapterCoordinator", "caseCoordinator", "grantee", "officer", "outsider"];
  const actors = Object.keys(clears);

  it("the predicate and both wrappers give the same answer for every actor and case", async () => {
    for (const label of actors) {
      const who = world[label];
      const open = await predicate(who, world.openCase);
      expect(open, `${label} open`).toEqual({ row: true, caller: true, cleared: true });
      const restricted = await predicate(who, world.restrictedCase);
      expect(restricted, `${label} restricted`).toEqual({ row: clears[label], caller: clears[label], cleared: clears[label] });
    }
  });

  it("the live member_cases policies equal the predicate under their scope conjunct", async () => {
    for (const label of actors) {
      expect(await selects(world[label], world.openCase), `${label} open`).toBe(inScope[label]);
      expect(await selects(world[label], world.restrictedCase), `${label} restricted`).toBe(inScope[label] && clears[label]);
    }
  });

  it("search and share destinations mirror the live policies for every actor", async () => {
    for (const label of actors) {
      for (const caseId of [world.openCase, world.restrictedCase]) {
        expect(await searches(world[label], caseId), `${label} search`)
          .toBe(await selects(world[label], caseId));
      }
      // Exact ordered comparison catches tenant/restriction leaks, omissions and
      // accidental active-only filtering, including callers without staff hats.
      await become(world[label]);
      const expected = await client.query("select id from public.member_cases order by updated_at desc, id limit 100");
      const destinations = await client.query("select id from public.list_share_case_destinations(100)");
      expect(destinations.rows, `${label} share destinations`).toEqual(expected.rows);
      const capped = await client.query("select id from public.list_share_case_destinations(1)");
      expect(capped.rows).toEqual(expected.rows.slice(0, 1));
    }
    await client.query("reset role");
    await client.query("savepoint share_status");
    await client.query("update public.member_cases set status='resolved' where id=$1", [world.openCase]);
    await become(world.chapterCoordinator);
    expect((await client.query("select id from public.list_share_case_destinations(100)")).rows)
      .toContainEqual({ id: world.openCase });
    await client.query("reset role");
    await client.query("rollback to savepoint share_status");
    await claims(world.chapterCoordinator);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      role: "authenticated", sub: world.chapterCoordinator.id,
      session_id: world.chapterCoordinator.session, aal: "aal1",
    })]);
    await client.query("set local role authenticated");
    const denied = await client.query("select id from public.member_cases order by updated_at desc,id limit 100");
    expect((await client.query("select id from public.list_share_case_destinations(100)")).rows).toEqual(denied.rows);
  });

  it("list_contract_clause_grievance_counts counts exactly the cases each actor can select", async () => {
    for (const label of actors) {
      const visible = [world.openCase, world.restrictedCase]
        .filter((caseId) => (caseId === world.openCase ? inScope[label] : inScope[label] && clears[label])).length;
      expect(await counts(world[label]), label).toBe(visible);
    }
  });

  it("the procedures reader answers only for a case its staff caller can select", async () => {
    for (const label of staff) {
      for (const caseId of [world.openCase, world.restrictedCase]) {
        expect(await procedure(world[label], caseId), `${label} ${caseId === world.openCase ? "open" : "restricted"}`)
          .toBe(await selects(world[label], caseId));
      }
    }
  });

  it("reminder delivery reads a restricted case for exactly the staff the policies admit", async () => {
    for (const label of staff) {
      for (const caseId of [world.openCase, world.restrictedCase]) {
        expect(await reminderRead(world[label], caseId), `${label} ${caseId === world.openCase ? "open" : "restricted"}`)
          .toBe(await selects(world[label], caseId));
      }
    }
  });

  it("an advisor with no coordinator scope clears the restriction but reaches only the surfaces whose scope admits officers", async () => {
    const who = world.advisorOnly;
    // Restriction clearance: the predicate and both wrappers say yes.
    expect(await predicate(who, world.restrictedCase)).toEqual({ row: true, caller: true, cleared: true });
    // Case rows: no SELECT policy admits an advisor without coordinator scope.
    expect(await selects(who, world.openCase)).toBe(false);
    expect(await selects(who, world.restrictedCase)).toBe(false);
    // The policy-mirroring set-based readers follow the policies.
    expect(await searches(who, world.openCase)).toBe(false);
    expect(await searches(who, world.restrictedCase)).toBe(false);
    expect(await counts(who)).toBe(0);
    // The definer readers admit organization officers by their own scope rule
    // and then apply the same restriction outcome the predicate gives.
    expect(await procedure(who, world.openCase)).toBe(true);
    expect(await procedure(who, world.restrictedCase)).toBe(true);
    expect(await reminderRead(who, world.openCase)).toBe(true);
    expect(await reminderRead(who, world.restrictedCase)).toBe(true);
  });

  it("a revoked steward hat loses the bypass everywhere the predicate is consumed", async () => {
    // The assigned steward with the hat removed: member_cases_select_steward
    // already refused the row; the predicate, both wrappers, the coordinator
    // policy (the steward holds no coordinator scope) and the two set-based
    // mirrors that read steward_hat now refuse it as one.
    await client.query("savepoint revoked");
    await client.query("reset role");
    await client.query("delete from public.member_roles where user_id=$1 and role='steward'", [world.steward.id]);
    await client.query("delete from public.member_role_chapters where user_id=$1 and role='steward'", [world.steward.id]);
    await client.query("delete from public.organization_role_grants where user_id=$1 and role='steward'", [world.steward.id]);
    expect(await predicate(world.steward, world.restrictedCase)).toEqual({ row: false, caller: false, cleared: false });
    expect(await selects(world.steward, world.restrictedCase)).toBe(false);
    expect(await searches(world.steward, world.restrictedCase)).toBe(false);
    expect(await counts(world.steward)).toBe(0);
    await client.query("rollback to savepoint revoked");
  });

  it("only the restriction predicate, staff mutation oracle, advisor desk and kept search mirrors state grant bypasses", async () => {
    await client.query("reset role");
    const { rows: functions } = await client.query(`
      select n.nspname || '.' || p.proname as name
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private')
        and p.prosrc ilike '%is_restricted%' and p.prosrc ilike '%casework_actor_has_active_grant%'
      order by 1`);
    expect(functions.map((row) => row.name)).toEqual([
      "private.casework_staff_can_access",
      "private.member_case_row_visible",
      //  reads the analytics snapshot's cases once: the helper restates
      // casework_staff_can_access's restriction clause with its grant bypass.
      "private.organization_analytics_readable_cases",
      // The search body moved here unchanged under; the public
      // function only neutralizes its rows.
      "private.search_member_cases",
      //  inlines the same bypass in the advisor desk so that desk does
      // not call casework_staff_can_access once per case.
      "public.get_advisor_overview",
      "public.list_share_case_destinations",
    ]);
    const { rows: policies } = await client.query(`
      select schemaname || '.' || tablename || '.' || policyname as name
      from pg_catalog.pg_policies
      where (coalesce(qual,'') || coalesce(with_check,'')) ilike '%casework_actor_has_active_grant%'
         or (coalesce(qual,'') || coalesce(with_check,'')) ilike '%is_restricted%'`);
    expect(policies).toEqual([]);
  });
});
