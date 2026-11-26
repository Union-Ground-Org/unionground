// @vitest-environment node
//
// REQ-UG-CASEWORK-CONSOLE-57-CASE-SEARCH-20260917
//
// public.search_member_cases is SECURITY DEFINER, so the boundary it enforces
// is code, not policy. The live half therefore never asserts "the coordinator
// sees three rows": it asserts that for every actor the RPC's case set is
// EQUAL to the set that same actor's own `select id from public.member_cases`
// returns under RLS, on a corpus where every case matches the query. A widened
// predicate and a narrowed one both fail that comparison, which is the only
// property worth pinning for a definer read.
//
// The static half keeps the SQL guarded without a database: the two GIN
// EXPRESSION indexes and the fact that the RPC restates their expressions
// verbatim, the grant shape, the clamp, and the fact that no extension is
// installed. It also pins the absence of a stored generated column, which is
// not a style preference: PostgreSQL computes a stored generated column AFTER
// the BEFORE triggers, so one on either case table makes NEW and OLD
// unconditionally distinct inside private.guard_casework_restriction_update()
// and private.touch_member_case_updated_at() (20260907150000) and every
// auth.users delete that detaches a still-restricted case raises 42501. The
// live half proves that detachment end to end.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const raw = loadMigrationSql("member_case_full_text_search");
const sql = stripComments(raw);

describe("member case full-text search migration", () => {
  it("installs no extension and references no external full-text-search package", () => {
    expect(sql).not.toMatch(/create\s+extension/i);
    expect(sql).not.toMatch(/pg_search|pgroonga|pg_trgm/i);
  });

  it("indexes one english-configuration document per table with a GIN expression index", () => {
    // Weighted: a reference or title hit must outrank an articles hit.
    for (const [column, weight] of [["reference", "A"], ["title", "A"], ["case_type", "B"], ["articles", "C"]]) {
      expect(sql).toContain(`pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(${column}, '')), '${weight}'`);
    }
    expect(sql).toContain("pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(body, ''))");
    expect(sql).toContain("create index member_cases_search_document_idx\n  on public.member_cases using gin ((");
    expect(sql).toContain("create index member_case_updates_search_document_idx\n  on public.member_case_updates using gin ((");
  });

  it("adds no column at all, so no BEFORE UPDATE whole-row comparison moves", () => {
    // The first revision of this migration used two stored generated columns.
    // PostgreSQL computes those AFTER the BEFORE triggers run, so inside
    // private.guard_casework_restriction_update() and
    // private.touch_member_case_updated_at() NEW.search_document was null while
    // OLD held the stored value: their
    // `to_jsonb(new) - 'restricted_by' is not distinct from to_jsonb(old) - 'restricted_by'`
    // arms could never be true again, and the nested Auth detachment those arms
    // exist to admit raised 42501 instead. The live half of this file proves the
    // detachment; this pin is what stops the column coming back.
    expect(sql).not.toMatch(/\balter\s+table\b/i);
    expect(sql).not.toMatch(/\badd\s+column\b/i);
    expect(sql).not.toMatch(/\bgenerated\s+always\s+as\b/i);
    expect(sql).not.toMatch(/\)\s*stored\s*;/i);
    expect(sql).not.toContain("search_document tsvector");
    // And the two guards themselves stay where 20260907150000 wrote them: this
    // migration names them only in its rationale, never in a DDL statement.
    for (const guard of ["guard_casework_restriction_update", "touch_member_case_updated_at"]) {
      expect(sql).not.toMatch(new RegExp(`function\\s+private\\.${guard}`, "i"));
    }
    expect(sql).not.toMatch(/\b(create|drop|alter)\s+trigger\b/i);
  });

  // An expression index serves only a query whose expression matches it, so the
  // two copies in public.search_member_cases are not "similar" to the index
  // expressions: they are the same text, differing only by the `c.` / `u.`
  // table alias, which changes the parse tree not at all. Derive both from the
  // file rather than restating them here, so there is no third copy to drift.
  function indexExpression(indexName) {
    const start = sql.indexOf(`create index ${indexName}\n`);
    expect(start).toBeGreaterThan(-1);
    const open = sql.indexOf("using gin ((", start) + "using gin (".length;
    let depth = 0;
    let end = open;
    for (; end < sql.length; end += 1) {
      if (sql[end] === "(") depth += 1;
      if (sql[end] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return sql.slice(open + 1, end).trim();
  }

  it("restates both index expressions verbatim in the candidate CTE", () => {
    const rpc = stripComments(fnBody(raw, "public.search_member_cases"));
    for (const [indexName, alias] of [
      ["member_cases_search_document_idx", "c."],
      ["member_case_updates_search_document_idx", "u."],
    ]) {
      const expression = indexExpression(indexName);
      // Not a regex, not a fuzzy match: the aliased copy is the index
      // expression with the alias inserted before every column reference.
      const aliased = expression.replace(/coalesce\(/g, `coalesce(${alias}`);
      expect(aliased).not.toBe(expression);
      expect(rpc.replace(/\s+/g, " ")).toContain(aliased.replace(/\s+/g, " "));
    }
  });

  it("mirrors every member_cases SELECT policy branch, including the restrictive MFA policy", () => {
    const rpc = stripComments(fnBody(raw, "public.search_member_cases"));
    // The mirror is a set, not a row function. actor_scope resolves everything
    // that depends only on the caller ONCE — MATERIALIZED is load-bearing,
    // because a single-row CTE referenced once is inlined and every helper in
    // it runs per candidate row again, which is exactly the defect this
    // revision repairs.
    expect(rpc).toContain("with actor_scope as materialized (");
    // mfa_assurance is RESTRICTIVE: it ANDs over the permissive branches.
    expect(rpc).toContain("(select private.mfa_satisfied()) as mfa_satisfied");
    expect(rpc).toContain("where (select s.mfa_satisfied from actor_scope s)");
    // member_cases_select_own / _select_steward / _select_coordinator.
    expect(rpc).toContain("c.user_id = v_actor");
    expect(rpc).toContain("public.member_has_role(array['steward']) as steward_hat");
    expect(rpc).toContain("or (c.steward_user_id = v_actor and (select s.steward_hat from actor_scope s))");
    expect(rpc).toContain("or c.id in (select candidate_id from staff_visible)");
    // staff_can_see_user(user_id, 'coordinator'), as the chapter set it is
    // equal to, tested against the case owner's own profile row.
    expect(rpc).toContain("array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters");
    expect(rpc).toContain("join public.member_profiles case_owner on case_owner.id = c.user_id");
    expect(rpc).toContain("and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])");
    // The restriction branch, with has_organization_role and
    // casework_actor_has_active_grant resolved once each.
    expect(rpc).toContain("not c.is_restricted");
    expect(rpc).toContain("or c.coordinator_user_id = v_actor");
    expect(rpc).toContain("and c.organization_id = (select s.staff_organization from actor_scope s)");
    expect(rpc).toContain("and (select s.organization_officer from actor_scope s)");
    expect(rpc).toContain("or c.id = any((select s.granted_cases from actor_scope s)::uuid[])");
    expect(rpc).toContain("private.has_organization_role(");
    expect(rpc).toContain("from public.casework_access_grants g");
    // casework_can_read is not equal to member_cases SELECT in either
    // direction, so it must not be the gate here.
    expect(rpc).not.toContain("casework_can_read");
    // And nothing in the body may call a visibility helper per candidate row:
    // the whole point of this revision is that the staff test is a semijoin.
    expect(rpc).not.toContain("member_case_visible_to_actor");
    expect(rpc).not.toMatch(/public\.staff_can_see_user\s*\(/);
    expect(sql).toContain("revoke all on function private.staff_visible_chapter_scope(text)\n  from public, anon, authenticated, service_role;");
  });

  // private.staff_visible_chapter_scope is public.staff_can_see_user with its
  // target removed, and that is a claim about TEXT, not a resemblance. Every
  // conjunct of staff_can_see_user's EXISTS body references the target only
  // through the chapter it joins to, so dropping `public.member_profiles
  // target` and `target.id = p_target` — and writing `target.chapter_id` as the
  // `target_chapter.id` the join made it equal to — leaves the predicate
  // unchanged. The live half proves the two forms agree for every actor and
  // every profile in the fixture; this half proves they are still the same
  // words, and pins the helper so a rewrite of it cannot leave the lift behind.
  it("lifts public.staff_can_see_user off its target without changing its predicate", () => {
    const helperSource = loadMigrationSql("mi1_organization_scope_foundation");
    const helper = stripComments(fnBody(helperSource, "public.staff_can_see_user"));
    const scope = stripComments(fnBody(raw, "private.staff_visible_chapter_scope"));
    const flat = (text) => text.replace(/\s+/g, " ");
    for (const clause of [
      "target_chapter.organization_id is not null and target_chapter.organization_id = (select private.current_member_organization())",
      "or private.member_has_chapter_role(target_chapter.id, array[p_role])",
      "target_chapter.organization_id is null and (select private.current_member_organization()) is null",
      "from public.member_profiles caller_profile left join public.chapters caller_chapter on caller_chapter.id = caller_profile.chapter_id where caller_profile.id = (select auth.uid()) and (caller_chapter.id is null or caller_chapter.organization_id is null)",
      "not (select private.staff_mfa_required()) or (select private.has_second_factor((select auth.uid())))",
      "from public.member_roles r where r.user_id = (select auth.uid()) and r.role = p_role",
      "from public.member_role_chapters rc join public.member_chapter_memberships m on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id join public.chapters mapped on mapped.id = rc.chapter_id where rc.user_id = r.user_id and rc.role = r.role",
      "and mapped.organization_id is null and m.status = 'active'",
    ]) {
      expect(flat(helper)).toContain(clause);
      expect(flat(scope)).toContain(clause);
    }
    // The four edits the lift is allowed to make, and no others: the two
    // pinned here, the has_organization_role argument rewrite and the added
    // necessary condition pinned below.
    expect(flat(helper)).toContain("from public.member_profiles target join public.chapters target_chapter on target_chapter.id = target.chapter_id where target.id = p_target");
    expect(flat(scope)).toContain("from public.chapters target_chapter where");
    expect(scope).not.toContain("p_target");
    expect(flat(helper)).toContain("and rc.chapter_id = target.chapter_id");
    expect(flat(scope)).toContain("and rc.chapter_id = target_chapter.id");
    // has_organization_role is called with the constant the conjunct above it
    // makes target_chapter.organization_id equal to, so it is one InitPlan
    // instead of one call per chapter.
    expect(flat(helper)).toContain("private.has_organization_role(target_chapter.organization_id, array[p_role])");
    expect(flat(scope)).toContain("(select private.has_organization_role((select private.current_member_organization()), array[p_role]))");
    // The cheap necessary condition that keeps a caller with no staff hat off
    // public.chapters entirely: every branch reaches p_role through one of
    // these three tables.
    for (const table of ["public.member_roles role_probe", "public.member_role_chapters chapter_probe", "public.organization_role_grants organization_probe"]) {
      expect(scope).toContain(table);
    }
    // #6665 retains the historical lift for the ordinary unscoped path and
    // routes scoped grants and private identities through the full row oracle.
    // Keep the historical source pin and verify the new caller's dispatch.
    const declaring = migrationFiles()
      .filter((entry) => /create\s+(or\s+replace\s+)?function\s+public\.staff_can_see_user\s*\(/i.test(entry.sql))
      .map((entry) => entry.name);
    // #7663 (stewards_require_unit_with_carry_over) re-declares it with the
    // steward unit rule and re-emits private.search_member_cases with it; the
    // live half of this file proves the two forms still agree.
    expect(declaring[declaring.length - 1]).toMatch(/_stewards_require_unit_with_carry_over\.sql$/);
    // #7206 (20261106221000) re-declares it only to run the same query from
    // PL/pgSQL (cached plan): its query is word for word the 20261102005607
    // predicate, so the lift above still describes the live helper.
    const query = (statement) => flat(stripComments(statement)).match(/ as \$function\$ (?:begin return \( )?(select case .*?) (?:\); end; )?\$function\$/i)?.[1];
    const reviewed = query(fnBody(loadMigrationSql("unit_committee_scoped_access"), "public.staff_can_see_user"));
    const cached = query(fnBody(loadMigrationSql("20261106221000_"), "public.staff_can_see_user"));
    expect(reviewed).toMatch(/^select case .* end;?$/);
    expect(cached?.replace(/;$/, "")).toBe(reviewed.replace(/;$/, ""));
    const current = stripComments(fnBody(loadMigrationSql("unit_committee_scoped_access"), "public.search_member_cases"));
    expect(current).toContain("s.has_scoped_grants");
    expect(current).toContain("private.case_identity_privacy");
    expect(current).toContain("private.chapter_case_readable(c.authorization_case)");
    expect(current).toContain("s.default_steward_chapters");
    expect(createHash("sha256").update(helper).digest("hex"))
      .toBe("ae1b4317999517931f45196c870d110b731308527de53b8d48e571f039de159b");
  });

  it("clamps the limit, refuses anonymous and empty queries, and is authenticated-only", () => {
    const rpc = stripComments(fnBody(raw, "public.search_member_cases"));
    expect(rpc).toContain("security definer");
    expect(rpc).toContain("set search_path = ''");
    expect(rpc).toContain("least(greatest(coalesce(p_limit, 20), 1), 50)");
    expect(rpc).toContain("if v_actor is null or pg_catalog.numnode(v_query) = 0 then");
    expect(rpc).toContain("pg_catalog.websearch_to_tsquery(");
    expect(rpc).toContain("'StartSel=\"[[\",StopSel=\"]]\"");
    // ts_headline is the most expensive expression in the projection and a
    // projection is computed before the ORDER BY sort, so it must sit above the
    // ranked page, never beside the visibility filter.
    expect(rpc.indexOf("ranked as (")).toBeLessThan(rpc.indexOf("pg_catalog.ts_headline("));
    expect(rpc).toContain("limit v_limit");
    expect(sql).toContain("revoke all on function public.search_member_cases(text, integer) from public, anon, service_role;");
    expect(sql).toContain("grant execute on function public.search_member_cases(text, integer) to authenticated;");
  });

  it("filters the case-note lateral by the member_case_updates SELECT policies", () => {
    const rpc = stripComments(fnBody(raw, "public.search_member_cases"));
    expect(rpc).toContain("(n.user_id = v_actor and c.user_id = v_actor)");
    expect(rpc).toContain("or ((select s.steward_hat from actor_scope s) and c.steward_user_id = v_actor)");
    // member_case_updates_select_coordinator, through the same chapter scope
    // the case gate uses — one array membership test per note, not a
    // staff_can_see_user call per note.
    expect(rpc).toContain("from public.member_profiles note_author");
    expect(rpc).toContain("and note_author.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])");
  });

  it("selects its candidate rows through both GIN indexes before it applies visibility", () => {
    // The GIN indexes are only load-bearing if something can be handed to
    // them. `c.search_document @@ v_query OR note.body is not null` sits above
    // a LEFT JOIN LATERAL, so a query driven straight off public.member_cases
    // has no index-able case-side predicate at all: it reads every row and
    // evaluates private.member_case_visible_to_actor — and therefore
    // public.staff_can_see_user — once per row. The candidate list restores
    // both index paths; the live half below proves the planner takes them.
    const rpc = stripComments(fnBody(raw, "public.search_member_cases"));
    expect(rpc).toContain("candidate_hits as (");
    expect(rpc).toContain("select c.id as candidate_id, true as case_hit, false as note_hit");
    expect(rpc).toContain("select u.case_id as candidate_id, false as case_hit, true as note_hit");
    expect(rpc).toContain(") @@ v_query");
    expect(rpc).toContain("from candidates k");
    // And the case rows are fetched BY the candidate list, one primary-key
    // probe at a time. `offset 0` is the fence that keeps it that way: without
    // it the planner flattens the LATERAL, prices the GIN candidate estimate at
    // its 200-row default and reads the whole case table instead.
    expect(rpc).toContain("where row_case.id = k.candidate_id");
    expect(rpc).toContain("offset 0");
  });
});

const live = process.env.RUN_CASE_SEARCH_DB_TESTS === "1" && process.env.SUPABASE_DB_URL ? describe : describe.skip;

// Every seeded case carries this token, so "the cases that match" and "the
// cases that exist" are the same set and the RLS comparison is total.
const CORPUS_TOKEN = "casewide";
// Lives only in a note on the restricted case. A caller the restriction
// refuses must never see it, whether the case matched or the note did.
const SEALED_NOTE_TOKEN = "sealedwitnessledger";

function connectionUrl() {
  const url = new URL(process.env.SUPABASE_DB_URL);
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  return url.toString();
}

live("search_member_cases over a disposable database", () => {
  let client;
  const world = {};

  async function actor(email, { aal = "aal2" } = {}) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${email}`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())", [session, id, aal]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, world.chapter]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, world.chapter]);
    return { id, session, aal };
  }

  // public.member_has_role wants the whole staff shape: an active chapter
  // membership, an active organization membership, a chapter role grant, and
  // — when private.staff_mfa_required() is on — an enrolled second factor.
  async function grantRole(person, role) {
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [person.id, role, world.chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [person.id, role, world.chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [world.org, person.id]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), person.id]);
  }

  async function become(person) {
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: person?.id ?? null,
      role: "authenticated",
      aal: person?.aal ?? "aal1",
      session_id: person?.session ?? null,
    })]);
    await client.query("set local role authenticated");
  }

  async function claimsOf(person) {
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: person?.id ?? null,
      role: "authenticated",
      aal: person?.aal ?? "aal1",
      session_id: person?.session ?? null,
    })]);
  }

  async function asPostgres() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function visibleThroughRls() {
    return (await client.query("select id from public.member_cases order by id")).rows.map((row) => row.id);
  }

  async function visibleThroughSearch(query = CORPUS_TOKEN, limit = 50) {
    const { rows } = await client.query("select case_id from public.search_member_cases($1,$2) order by case_id", [query, limit]);
    return rows.map((row) => row.case_id);
  }

  async function seedCase(fields) {
    const id = randomUUID();
    await client.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,articles,step,is_restricted,restriction_reason,restricted_at,restricted_by,steward_user_id,coordinator_user_id)
       values ($1,$2,$3,$4,$5,$6,'Intake',$7,$8,$9,$10,$11,$12)`,
      [id, fields.owner, fields.reference, fields.title, fields.caseType ?? "Grievance", fields.articles ?? `${CORPUS_TOKEN} article`,
        Boolean(fields.restricted), fields.restricted ? "Restricted for this proof run" : null,
        fields.restricted ? new Date().toISOString() : null, fields.restricted ? (fields.restrictedBy ?? fields.owner) : null,
        fields.steward ?? null, fields.coordinator ?? null],
    );
    return id;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: connectionUrl(), application_name: "member-case-search-proof" });
    await client.connect();
    await client.query("set statement_timeout = '30s'");
    await client.query("begin");

    world.org = randomUUID();
    world.chapter = `p57-${world.org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, world.chapter]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9902)", [world.chapter, world.org]);

    world.owner = await actor("owner@example.invalid");
    world.stranger = await actor("stranger@example.invalid");
    world.steward = await actor("steward@example.invalid");
    world.lockedOutSteward = await actor("locked@example.invalid", { aal: "aal1" });
    world.coordinator = await actor("coordinator@example.invalid");
    world.grantedCoordinator = await actor("granted@example.invalid");

    for (const person of [world.steward, world.lockedOutSteward]) {
      await grantRole(person, "steward");
    }
    // lockedOutSteward already carries the same enrolled factor grantRole
    // added; its aal1 session is what private.mfa_satisfied() refuses.
    for (const person of [world.coordinator, world.grantedCoordinator]) {
      await grantRole(person, "coordinator");
    }

    world.plainCase = await seedCase({
      owner: world.owner.id,
      reference: "SG-2026-0101",
      title: `${CORPUS_TOKEN} overtime pay withheld`,
      articles: `${CORPUS_TOKEN} Article 12 overtime distribution`,
    });
    world.stewardCase = await seedCase({
      owner: world.owner.id,
      reference: "SG-2026-0102",
      title: `${CORPUS_TOKEN} schedule change notice`,
      steward: world.steward.id,
    });
    world.stewardLockedCase = await seedCase({
      owner: world.owner.id,
      reference: "SG-2026-0103",
      title: `${CORPUS_TOKEN} locker room access`,
      steward: world.lockedOutSteward.id,
    });
    world.noteOnlyCase = await seedCase({
      owner: world.owner.id,
      reference: "SG-2026-0106",
      title: `${CORPUS_TOKEN} parking permits`,
    });
    world.restrictedCase = await seedCase({
      owner: world.stranger.id,
      reference: "SG-2026-0104",
      title: `${CORPUS_TOKEN} sealed investigation`,
      restricted: true,
    });
    world.strangerCase = await seedCase({
      owner: world.stranger.id,
      reference: "SG-2026-0105",
      title: `${CORPUS_TOKEN} uniform allowance`,
    });

    await client.query(
      "insert into public.member_case_updates(case_id,user_id,body) values ($1,$2,$3)",
      [world.plainCase, world.owner.id, "The steward filed the step one paperwork about unpaid overtime on Monday."],
    );
    await client.query(
      "insert into public.member_case_updates(case_id,user_id,body) values ($1,$2,$3)",
      [world.noteOnlyCase, world.owner.id, "Overtime came up once while discussing the permit queue."],
    );
    await client.query(
      "insert into public.member_case_updates(case_id,user_id,body) values ($1,$2,$3)",
      [world.strangerCase, world.stranger.id, "Private note naming a confidential uniform reimbursement figure."],
    );
    // The note's author is the restricted case's owner, who IS inside every
    // proof coordinator's staff scope: member_case_updates_select_coordinator
    // alone would let that note through, so this row is what proves the case
    // gate is applied before the note lateral.
    await client.query(
      "insert into public.member_case_updates(case_id,user_id,body) values ($1,$2,$3)",
      [world.restrictedCase, world.stranger.id, `Sealed interview: the ${SEALED_NOTE_TOKEN} names the witness and the ${CORPUS_TOKEN} figure.`],
    );

    const orgOfCase = (await client.query("select organization_id, chapter_id from public.member_cases where id=$1", [world.restrictedCase])).rows[0];
    await client.query(
      `insert into public.casework_access_grants(case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason)
       values ($1,$2,$3,$4,$5,'Proof run explicit access grant')`,
      [world.restrictedCase, orgOfCase.organization_id, orgOfCase.chapter_id, world.grantedCoordinator.id, world.stranger.id],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  for (const who of ["owner", "stranger", "steward", "lockedOutSteward", "coordinator", "grantedCoordinator"]) {
    it(`returns exactly what ${who} can select from member_cases`, async () => {
      await become(world[who]);
      const throughSearch = await visibleThroughSearch();
      const throughRls = await visibleThroughRls();
      await asPostgres();
      expect(throughSearch).toEqual(throughRls);
      // A comparison of two empty sets proves nothing about the predicate, so
      // the matrix must contain the actors it claims to.
      if (who !== "lockedOutSteward") expect(throughRls.length).toBeGreaterThan(0);
    });
  }

  it("refuses a steward who has not completed step-up even on their own assignment", async () => {
    await become(world.lockedOutSteward);
    const rows = await visibleThroughSearch();
    await asPostgres();
    expect(rows).toEqual([]);
  });

  it("hides a restricted case from an in-scope coordinator and shows it to a granted one", async () => {
    await become(world.coordinator);
    const plain = await visibleThroughSearch();
    await become(world.grantedCoordinator);
    const granted = await visibleThroughSearch();
    await asPostgres();
    expect(plain).not.toContain(world.restrictedCase);
    expect(granted).toContain(world.restrictedCase);
  });

  it("hides a restricted case, and every note on it, from a non-granted steward", async () => {
    await become(world.steward);
    const corpus = await client.query("select * from public.search_member_cases($1, 50)", [CORPUS_TOKEN]);
    const sealed = await client.query("select * from public.search_member_cases($1, 50)", [SEALED_NOTE_TOKEN]);
    await asPostgres();
    // The steward holds no coordinator hat, no grant and no assignment on the
    // restricted case: not through the case document, not through its note.
    expect(corpus.rows.map((row) => row.case_id)).not.toContain(world.restrictedCase);
    expect(corpus.rows.map((row) => row.case_id)).not.toContain(world.strangerCase);
    expect(sealed.rows).toEqual([]);
    expect(JSON.stringify(corpus.rows)).not.toContain(SEALED_NOTE_TOKEN);
  });

  // #7015: the public RPC returns hits without the snippet; the snippet and
  // visibility logic live unchanged in private.search_member_cases, which the
  // snippet proofs below call as the definer under the caller's claims.
  it("never lets a matching note on a restricted case reach an in-scope coordinator without a grant", async () => {
    await claimsOf(world.coordinator);
    const corpus = await client.query("select * from private.search_member_cases($1, 50)", [CORPUS_TOKEN]);
    const sealed = await client.query("select * from private.search_member_cases($1, 50)", [SEALED_NOTE_TOKEN]);
    await claimsOf(world.grantedCoordinator);
    const granted = await client.query("select * from private.search_member_cases($1, 50)", [SEALED_NOTE_TOKEN]);
    await asPostgres();
    // The note matches the query and its author is in the coordinator's staff
    // scope; only the restriction stands between them, and it must hold for
    // both the row and the ts_headline snippet.
    expect(corpus.rows.map((row) => row.case_id)).not.toContain(world.restrictedCase);
    expect(JSON.stringify(corpus.rows)).not.toContain(SEALED_NOTE_TOKEN);
    expect(sealed.rows).toEqual([]);
    // The explicit grant is the only thing that changes the answer, and then
    // the snippet is drawn from that same note.
    expect(granted.rows.map((row) => row.case_id)).toEqual([world.restrictedCase]);
    expect(granted.rows[0].headline_source).toBe("update");
    expect(granted.rows[0].headline).toContain(`[[${SEALED_NOTE_TOKEN}]]`);
  });

  it("returns nothing for an anonymous caller or an empty query", async () => {
    await claimsOf(null);
    expect(await visibleThroughSearch()).toEqual([]);
    await claimsOf(world.owner);
    expect(await visibleThroughSearch("")).toEqual([]);
    expect(await visibleThroughSearch("   ")).toEqual([]);
    await asPostgres();
  });

  it("ranks a weighted document hit above a case-note-only hit", async () => {
    await claimsOf(world.owner);
    const { rows } = await client.query("select * from private.search_member_cases('overtime', 10)");
    await asPostgres();
    // plainCase matches its own articles line AND a note; noteOnlyCase matches
    // only a note, and the weighted document rank must decide the order.
    expect(rows.map((row) => row.case_id)).toEqual([world.plainCase, world.noteOnlyCase]);
    expect(rows[0].rank).toBeGreaterThan(rows[1].rank);
    expect(rows[0].reference).toBe("SG-2026-0101");
    expect(rows[0].headline).toContain("[[overtime]]");
  });

  it("draws the headline from the best matching visible note, else the articles line", async () => {
    await claimsOf(world.owner);
    const noted = await client.query("select * from private.search_member_cases('overtime', 10)");
    const articles = await client.query("select * from private.search_member_cases('distribution', 10)");
    await asPostgres();
    expect(noted.rows[0].headline_source).toBe("update");
    expect(noted.rows[0].headline).toContain("[[overtime]]");
    expect(articles.rows.map((row) => row.case_id)).toEqual([world.plainCase]);
    expect(articles.rows[0].headline_source).toBe("articles");
    expect(articles.rows[0].headline).toContain("[[distribution]]");
  });

  it("finds a case through a stemmed word that only its case note carries", async () => {
    await claimsOf(world.owner);
    const { rows } = await client.query("select * from private.search_member_cases('filing paperwork', 10)");
    await asPostgres();
    expect(rows.map((row) => row.case_id)).toEqual([world.plainCase]);
    expect(rows[0].headline_source).toBe("update");
    expect(rows[0].headline).toContain("[[filed]]");
  });

  it("never draws a headline from a case note the caller cannot select", async () => {
    await become(world.steward);
    const { rows } = await client.query("select * from public.search_member_cases($1, 50)", [CORPUS_TOKEN]);
    await asPostgres();
    // The steward's assigned case has no note; the stranger's confidential note
    // must not reach this caller through any row.
    expect(rows.map((row) => row.case_id)).toEqual([world.stewardCase]);
    expect(JSON.stringify(rows)).not.toContain("confidential uniform reimbursement");
  });

  it("clamps p_limit into 1..50 in both directions", async () => {
    await become(world.owner);
    const one = await client.query("select case_id from public.search_member_cases($1, 0)", [CORPUS_TOKEN]);
    expect(one.rowCount).toBe(1);
    const negative = await client.query("select case_id from public.search_member_cases($1, -5)", [CORPUS_TOKEN]);
    expect(negative.rowCount).toBe(1);
    const missing = await client.query("select case_id from public.search_member_cases($1, null)", [CORPUS_TOKEN]);
    expect(missing.rowCount).toBe(4);
    await asPostgres();

    // Fifty-two matching cases prove the upper clamp is the RPC's and not the
    // corpus's.
    for (let index = 0; index < 52; index += 1) {
      await seedCase({ owner: world.stranger.id, reference: `SG-2026-9${String(index).padStart(3, "0")}`, title: `${CORPUS_TOKEN} bulk row ${index}` });
    }
    await become(world.stranger);
    const capped = await client.query("select case_id from public.search_member_cases($1, 999)", [CORPUS_TOKEN]);
    await asPostgres();
    expect(capped.rowCount).toBe(50);
  });

  // PERF-UG-CASE-SEARCH-VISIBILITY-PER-CANDIDATE-ROW-20260917, acceptance 3.
  // The RLS comparison above runs at p_limit 50 over a corpus smaller than any
  // page, so it never sees a cut. This is the ranked-page form of the same
  // equality: for the four actors a restricted case is decided for -- its
  // owner, its assigned steward, a granted coordinator and an ungranted one --
  // the RPC's page at p_limit 1, 20 and 50 is the same ordered list, with the
  // same ranks, as the caller's own RLS read of member_cases and
  // member_case_updates ranked and cut the RPC's way. Every actor can see more
  // than fifty matching cases, so every limit cuts, and the restricted case
  // ranks first for everyone admitted to it, so the p_limit 1 page alone says
  // whether the set-based mirror admitted it.
  const PAGE_CUT_TOKEN = "pagecutledger";
  const CASE_DOCUMENT = `pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C')`;

  // The oracle: the RPC's rank (case document rank plus half the best matching
  // note's rank) and its order (rank, then updated_at, then id), computed over
  // exactly the rows RLS gives the caller. It shares no CTE, helper or
  // visibility predicate with the RPC.
  async function rankedThroughRls(term, limit) {
    const { rows } = await client.query(
      `with q as (select pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig, $1) as query),
       scored as (
         select c.id, c.updated_at,
                pg_catalog.ts_rank(${CASE_DOCUMENT}, q.query) + coalesce(best.note_rank, 0) * 0.5 as rank_value
         from public.member_cases c
         cross join q
         left join lateral (
           select max(pg_catalog.ts_rank(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, '')), q.query)) as note_rank
           from public.member_case_updates u
           where u.case_id = c.id
             and pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, '')) @@ q.query
         ) best on true
         where (${CASE_DOCUMENT}) @@ q.query or best.note_rank is not null
       )
       select id, rank_value::real as rank from scored
       order by rank_value desc, updated_at desc, id
       limit $2`,
      [term, limit]);
    return rows.map((row) => ({ id: row.id, rank: row.rank }));
  }

  async function rankedThroughSearch(term, limit) {
    const { rows } = await client.query("select case_id, rank from public.search_member_cases($1,$2)", [term, limit]);
    return rows.map((row) => ({ id: row.case_id, rank: row.rank }));
  }

  it("returns the caller's own RLS-ranked page at p_limit 1, 20 and 50 for every actor a restricted case is decided for", async () => {
    await client.query("savepoint page_cut_matrix");
    try {
      await pageCutMatrix();
    } finally {
      // Undoes the fixtures and any role or claims a failed assertion left set,
      // so one failure here cannot cascade into the cases after it.
      await client.query("rollback to savepoint page_cut_matrix");
      await client.query("release savepoint page_cut_matrix");
    }
  }, 60_000);

  async function pageCutMatrix() {
    const T = PAGE_CUT_TOKEN;
    // Ranked first for its owner, its assigned steward and the granted
    // coordinator: the token three times in the title and twice in articles.
    const sealed = await seedCase({
      owner: world.stranger.id,
      reference: "SG-2026-6000",
      title: `${T} ${T} ${T} sealed discipline file`,
      articles: `${T} Article 9 ${T}`,
      restricted: true,
      steward: world.steward.id,
    });
    // Restricted with no steward and no grant: only its owner is admitted,
    // and it ranks inside the owner's first twenty.
    const ownerOnly = await seedCase({
      owner: world.stranger.id,
      reference: "SG-2026-6001",
      title: `${T} ${T} withheld transfer`,
      restricted: true,
    });
    const orgOfCase = (await client.query("select organization_id, chapter_id from public.member_cases where id=$1", [sealed])).rows[0];
    await client.query(
      `insert into public.casework_access_grants(case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason)
       values ($1,$2,$3,$4,$5,'Proof run page-cut access grant')`,
      [sealed, orgOfCase.organization_id, orgOfCase.chapter_id, world.grantedCoordinator.id, world.stranger.id],
    );
    await client.query("insert into public.member_case_updates(case_id,user_id,body) values ($1,$2,$3)",
      [sealed, world.stranger.id, `Owner statement for the ${T} file.`]);

    // Ninety open cases in three rank bands: the token in the title (weight
    // A), only in the articles line (weight C), or only in a case note. The
    // steward is assigned to two of every three. Every fifth case also carries
    // a steward-authored note: the coordinators and the assigned steward can
    // read it, the case owner cannot (member_case_updates_select_own is the
    // note author's own row), so the same case ranks differently per caller
    // and the note-visibility half of the ranking is part of the comparison.
    await client.query(
      `insert into public.member_cases(user_id,reference,title,case_type,articles,step,steward_user_id)
       select $1, 'SG-2026-6'||(100 + g)::text,
              case when g % 3 = 0 then $3||' open grievance '||g else 'open grievance '||g end,
              'Grievance',
              case when g % 3 = 1 then $3||' Article '||g else 'Article '||g end,
              'Intake',
              case when g % 3 <> 1 then $2::uuid end
       from generate_series(0, 89) g`,
      [world.stranger.id, world.steward.id, T],
    );
    await client.query(
      `insert into public.member_case_updates(case_id,user_id,body)
       select id, $1, 'Member note '||substr(reference, 10)||' naming the '||$2||' entry.'
       from public.member_cases
       where reference like 'SG-2026-6%' and substr(reference, 10)::int >= 100 and (substr(reference, 10)::int - 100) % 3 = 2`,
      [world.stranger.id, T],
    );
    await client.query(
      `insert into public.member_case_updates(case_id,user_id,body)
       select id, $1, 'Steward follow-up '||substr(reference, 10)||': '||$2||' '||$2||' reviewed.'
       from public.member_cases
       where reference like 'SG-2026-6%' and substr(reference, 10)::int >= 100 and (substr(reference, 10)::int - 100) % 5 = 0`,
      [world.steward.id, T],
    );

    const matrix = [
      ["owner of the restricted case", world.stranger, { sealed: true, ownerOnly: true }],
      ["assigned steward", world.steward, { sealed: true, ownerOnly: false }],
      ["granted coordinator", world.grantedCoordinator, { sealed: true, ownerOnly: false }],
      ["ungranted coordinator", world.coordinator, { sealed: false, ownerOnly: false }],
    ];
    for (const [label, person, admitted] of matrix) {
      await become(person);
      // (rank, updated_at, id) is a total order, so the oracle's page at any
      // limit is a prefix of its whole ranked list.
      const everything = await rankedThroughRls(T, 1000);
      const pages = {};
      for (const limit of [1, 20, 50]) pages[limit] = await rankedThroughSearch(T, limit);
      await asPostgres();
      // More matches than the largest page, so p_limit 50 is a real cut.
      expect({ label, over50: everything.length > 50 }).toEqual({ label, over50: true });
      for (const limit of [1, 20, 50]) {
        expect({ label, limit, page: pages[limit] }).toEqual({ label, limit, page: everything.slice(0, limit) });
        expect({ label, limit, rows: pages[limit].length }).toEqual({ label, limit, rows: limit });
      }
      const ids = (limit) => pages[limit].map((row) => row.id);
      if (admitted.sealed) expect({ label, top: ids(1) }).toEqual({ label, top: [sealed] });
      else expect({ label, sealed: ids(50).includes(sealed) }).toEqual({ label, sealed: false });
      expect({ label, ownerOnly: ids(20).includes(ownerOnly) }).toEqual({ label, ownerOnly: admitted.ownerOnly });
      if (!admitted.ownerOnly) expect({ label, ownerOnly: ids(50).includes(ownerOnly) }).toEqual({ label, ownerOnly: false });
    }
  }

  // The static half proves private.staff_visible_chapter_scope is
  // public.staff_can_see_user's own text with the target lifted out. This
  // proves the two forms actually answer the same question, exhaustively: every
  // actor in the matrix against every member profile the fixture carries,
  // including the profiles with no chapter and the actors with no hat. Both
  // functions are SECURITY DEFINER and read no RLS-protected path, so the
  // comparison runs in the definer context the RPC itself uses.
  it("resolves the coordinator chapter scope to exactly public.staff_can_see_user", async () => {
    const targets = (await client.query("select id from public.member_profiles order by id")).rows.map((row) => row.id);
    expect(targets.length).toBeGreaterThan(5);
    let sawTrue = false;
    let sawFalse = false;
    for (const who of ["owner", "stranger", "steward", "lockedOutSteward", "coordinator", "grantedCoordinator"]) {
      await claimsOf(world[who]);
      const { rows } = await client.query(
        `select t.id,
                public.staff_can_see_user(t.id, 'coordinator') as helper,
                exists (
                  select 1 from public.member_profiles p
                  where p.id = t.id
                    and p.chapter_id = any(array(select private.staff_visible_chapter_scope('coordinator')))
                ) as lifted
           from pg_catalog.unnest($1::uuid[]) as t(id)`,
        [targets]);
      for (const row of rows) {
        expect({ who, id: row.id, lifted: row.lifted }).toEqual({ who, id: row.id, lifted: row.helper });
        if (row.helper) sawTrue = true; else sawFalse = true;
      }
    }
    await asPostgres();
    // Two sets that are empty for every actor would agree for the wrong reason.
    expect(sawTrue).toBe(true);
    expect(sawFalse).toBe(true);
  });

  // EXPLAIN cannot reach inside a plpgsql body, so the statement under test is
  // cut out of the migration file rather than restated here: a rewrite of the
  // RPC's query cannot quietly slip past this pin, and there is no second copy
  // of the SQL to drift.
  function searchStatement(token, limit = 10) {
    const from = raw.indexOf("  return query\n");
    const bodyEnd = raw.indexOf("\nend;\n$function$;", from);
    const to = raw.lastIndexOf(";", bodyEnd) + 1;
    if (from === -1 || bodyEnd === -1 || to < from) throw new Error("the search_member_cases return query could not be located");
    // The three plpgsql variables the statement reads. Everything else the
    // predicate needs now lives in the actor_scope CTE inside the statement
    // itself, so the cut-out copy resolves the caller exactly as the function
    // does — there is no scope to restate here and therefore none to drift.
    return raw.slice(from, to)
      .replace("  return query\n", "")
      .replace(/\bv_query\b/g, `pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig,'${token}')`)
      .replace(/\bv_limit\b/g, String(limit))
      .replace(/\bv_actor\b/g, "(select auth.uid())");
  }

  function planStatement(token) {
    return `explain (costs off)\n${searchStatement(token)}`;
  }

  it("takes both GIN index paths instead of scanning every case", async () => {
    // Four thousand rows is enough for an index path to be a real choice; the
    // proof corpus alone is small enough that a sequential scan is genuinely
    // cheapest and the plan would say nothing.
    await client.query(
      `insert into public.member_cases(user_id,reference,title,case_type,articles,step)
       select $1, 'SG-2026-7'||lpad(g::text,4,'0'), 'plan shape filler '||g, 'Grievance', 'filler article '||g, 'Intake'
       from generate_series(1,4000) g`,
      [world.stranger.id],
    );
    // The notes table needs the same treatment: with only the handful of
    // proof notes in it, a full walk of the btree on (case_id, created_at)
    // plus a filter is cheaper than the GIN index even with sequential scans
    // disabled, and the pin below would pass or fail on statistics alone.
    await client.query(
      `insert into public.member_case_updates(case_id,user_id,body)
       select id, user_id, 'plan shape filler note for '||reference
       from public.member_cases where reference like 'SG-2026-7%'`,
    );
    await client.query("analyze public.member_cases");
    await client.query("analyze public.member_case_updates");
    // enable_seqscan=off asks whether an index path EXISTS, which is the fact
    // that regressed: with the case-side @@ test stranded above the lateral
    // there was nothing to give member_cases_search_document_idx, at any size.
    // (A default-settings plan is not a usable pin at this size: the planner
    // prices a few hundred heap pages below a GIN bitmap. The latency case
    // below pins the default-settings plan on the 80,000-case corpus.)
    await client.query("set local enable_seqscan = off");
    const { rows } = await client.query(planStatement("zzplanshapetoken"));
    await client.query("set local enable_seqscan = on");
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    // Both candidate branches are driven by their expression index, and neither
    // falls back to reading the table: "the index name appears somewhere in the
    // plan" would also be satisfied by a recheck line above a sequential scan.
    expect(plan).toMatch(/Bitmap Index Scan on member_cases_search_document_idx/);
    expect(plan).toMatch(/Bitmap Index Scan on member_case_updates_search_document_idx/);
    expect(plan).not.toMatch(/Seq Scan on member_cases\b/);
    expect(plan).not.toMatch(/Seq Scan on member_case_updates\b/);
    // Every case row this statement reads is fetched by primary key from the
    // candidate list, so nothing scales with the size of the case table.
    expect(plan).toMatch(/Index Cond: \(id = k(_\d+)?\.candidate_id\)/);
    // The visibility step calls NOTHING per row. This is the pin the 2026-09-17
    // re-review asked for: the previous revision's plan carried
    // `Filter: private.member_case_visible_to_actor(c.*)` over every candidate,
    // which called public.staff_can_see_user at ~3 ms a row and cost an
    // in-scope coordinator 75.7 s on an 8,001-hit term. No visibility helper
    // may appear in any Filter, Index Cond or Join Filter of this plan.
    for (const helper of [
      "member_case_visible_to_actor",
      "staff_can_see_user",
      "staff_visible_chapter_scope",
      "has_organization_role",
      "member_has_chapter_role",
      "casework_actor_has_active_grant",
      "member_has_role",
      "mfa_satisfied",
    ]) {
      expect(plan).not.toContain(helper);
    }
    // What replaced it: the staff branch is a hashed semijoin against the
    // precomputed visible-case set, and the caller's scope reaches the row
    // predicates as InitPlan constants.
    expect(plan).toMatch(/hashed SubPlan/);
    expect(plan).toMatch(/CTE Scan on actor_scope/);
    expect(plan).toMatch(/CTE actor_scope/);
  });

  // LATENCY PIN — the property the 2026-09-17 delta re-review made a merge
  // blocker. Its construction: one term matching 8,001 cases, each with a note
  // that matches too, and four callers. Against the per-row mirror this
  // migration used to carry, that corpus cost the owner 1.4 s, a member owning
  // one of the hits 44.5 s and an in-scope coordinator 75.7 s, against an
  // authenticated statement_timeout of 8 s.
  //
  // The pin is written so statistics cannot decide it, in the same sense the
  // plan pin above is: the corpus is a fixed shape, ANALYZEd, and the assertion
  // is made twice — once about the shape of the work (no visibility helper may
  // appear in any node of the executed plan, so a regression cannot pass by
  // being run on a fast machine) and once about the clock, with a bound four
  // times the measured figure. The 8,001 matching cases sit in the 80,000-row
  // table, one note per case, that the standalone probe and
  // PERF-UG-CASE-SEARCH-VISIBILITY-PER-CANDIDATE-ROW-20260917 measured (see
  // the padding below for how one transaction gets there).
  //
  // The selective term matches one case. The record measured it at 4 ms; here
  // it is 5-15 ms wall clock per actor including the round trip (the staff
  // actors resolve their chapter scope once), and it must stay under a ceiling
  // an order of magnitude below the broad one: any plan that reads the 80,000
  // rows instead of the two GIN indexes costs far more than 50 ms.
  const LATENCY_BUDGET_MS = runnerTimeout(500);
  const SELECTIVE_BUDGET_MS = runnerTimeout(50);
  const BROAD = "filler";
  const SELECTIVE = "distribution";

  async function medianSearchMs(person, term, runs = 3) {
    await become(person);
    const samples = [];
    let rowCount = 0;
    for (let index = 0; index < runs; index += 1) {
      const started = process.hrtime.bigint();
      const result = await client.query("select count(*)::int as hits from public.search_member_cases($1, 20)", [term]);
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      rowCount = result.rows[0].hits;
    }
    await asPostgres();
    samples.sort((left, right) => left - right);
    return { ms: samples[Math.floor(samples.length / 2)], rowCount };
  }

  it("answers every actor well inside the authenticated statement timeout on an 8,001-hit term in an 80,000-case corpus", async () => {
    // The plan pin above seeded 4,000 filler cases owned by `stranger`, each
    // with one matching note. Top that up to 8,000 and hand exactly one of the
    // 8,001 hits to `owner`, which is the re-review's "member owning one hit".
    await client.query(
      `insert into public.member_cases(user_id,reference,title,case_type,articles,step)
       select $1, 'SG-2026-8'||lpad(g::text,4,'0'), 'plan shape filler '||g, 'Grievance', 'filler article '||g, 'Intake'
       from generate_series(4001,8000) g`,
      [world.stranger.id],
    );
    await client.query(
      `insert into public.member_case_updates(case_id,user_id,body)
       select id, user_id, 'plan shape filler note for '||reference
       from public.member_cases where reference like 'SG-2026-8%'`,
    );
    world.oneHitCase = await seedCase({
      owner: world.owner.id,
      reference: "SG-2026-0108",
      title: "plan shape filler owned by the member",
      articles: "filler article for the one-hit member",
    });

    // A coordinator whose staff scope is a different organization entirely:
    // the hat is real, the corpus is not theirs, and the repaired predicate
    // must decide that without touching a candidate.
    const otherOrg = randomUUID();
    const otherChapter = `p57x-${otherOrg}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [otherOrg, otherChapter]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9903)", [otherChapter, otherOrg]);
    const outsider = { id: randomUUID(), session: randomUUID(), aal: "aal2" };
    await client.query("insert into auth.users(id,email) values ($1,$2)", [outsider.id, `${outsider.id}-outside@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [outsider.session, outsider.id]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [outsider.id, otherChapter]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [outsider.id, otherChapter]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'coordinator',$2)", [outsider.id, otherChapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'coordinator',$2)", [outsider.id, otherChapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [otherOrg, outsider.id]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), outsider.id]);

    // PERF-UG-CASE-SEARCH-VISIBILITY-PER-CANDIDATE-ROW-20260917,
    // acceptance 2: the corpus the record measured is an 80,000-row
    // public.member_cases table with one case note per case, not just the
    // 8,001 hits. Pad the table to that size with cases (and one note each)
    // that match neither term, owned by the corpus owner so they sit inside
    // the in-scope coordinator's staff scope too. A plan that scales with the
    // table rather than with the candidates reads all of them.
    //
    // Each case row takes a per-case advisory lock from its
    // z99_case_graph_keys row trigger (and each note one for its case), and one
    // transaction runs out of shared lock memory between 8,005 and 14,005 of
    // them. That lock serializes concurrent writers of one case graph; this
    // transaction is the only writer and is rolled back, so the two lock
    // triggers are disabled for the padding statements alone and re-enabled
    // before anything is measured. ALTER TABLE ... DISABLE TRIGGER is
    // transactional and every other trigger still runs.
    const PADDED_CORPUS_ROWS = 80_000;
    const { rows: [{ existing }] } = await client.query("select count(*)::int as existing from public.member_cases");
    await client.query("alter table public.member_cases disable trigger z99_case_graph_keys");
    await client.query("alter table public.member_case_updates disable trigger z99_case_graph_keys");
    for (let from = 1; from <= PADDED_CORPUS_ROWS - existing; from += 12_000) {
      const to = Math.min(from + 11_999, PADDED_CORPUS_ROWS - existing);
      await client.query(
        `insert into public.member_cases(user_id,reference,title,case_type,articles,step)
         select $1, 'SG-2026-P'||lpad(g::text,5,'0'), 'archive padding '||g, 'Grievance', 'Article 7 padding '||g, 'Intake'
         from generate_series($2::int, $3::int) g`,
        [world.stranger.id, from, to],
      );
      await client.query(
        `insert into public.member_case_updates(case_id,user_id,body)
         select id, user_id, 'archived padding note for '||reference
         from public.member_cases
         where reference like 'SG-2026-P%' and substr(reference, 10)::int between $1 and $2`,
        [from, to],
      );
    }
    await client.query("alter table public.member_cases enable trigger z99_case_graph_keys");
    await client.query("alter table public.member_case_updates enable trigger z99_case_graph_keys");
    const corpus = (await client.query(
      `select (select count(*)::int from public.member_cases) as cases,
              (select count(*)::int from public.member_cases c
                where not exists (select 1 from public.member_case_updates u where u.case_id = c.id)) as unnoted`)).rows[0];
    expect(corpus.cases).toBeGreaterThanOrEqual(PADDED_CORPUS_ROWS);
    // Every padding and filler case carries its note; only the handful of
    // hand-built fixture cases above do not.
    expect(corpus.unnoted).toBeLessThan(100);

    await client.query("analyze public.member_cases");
    await client.query("analyze public.member_case_updates");
    await client.query("analyze public.member_profiles");

    const hits = await client.query(
      `select count(*)::int as n from public.member_cases c
        where (pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
            || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
            || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
            || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C'))
              @@ pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig, $1)`, [BROAD]);
    expect(hits.rows[0].n).toBe(8001);

    const measured = {};
    for (const [label, person, expectedRows] of [
      ["owner of the corpus", world.stranger, 20],
      ["member owning one hit", world.owner, 1],
      ["in-scope coordinator", world.coordinator, 20],
      ["out-of-scope coordinator", outsider, 0],
    ]) {
      const broad = await medianSearchMs(person, BROAD);
      const selective = await medianSearchMs(person, SELECTIVE);
      measured[label] = { broad: Number(broad.ms.toFixed(1)), selective: Number(selective.ms.toFixed(1)), rows: broad.rowCount };
      expect({ label, rows: broad.rowCount }).toEqual({ label, rows: expectedRows });
      expect(broad.ms, `${label}: broad term`).toBeLessThan(LATENCY_BUDGET_MS);
      expect(selective.ms, `${label}: selective term`).toBeLessThan(SELECTIVE_BUDGET_MS);
    }
    process.stdout.write(`search_member_cases latency, 8,001 hits in ${corpus.cases} cases: ${JSON.stringify(measured)}\n`);

    // The clock is the symptom; this is the cause. With real statistics and
    // sequential scans enabled, the executed plan for the caller the old shape
    // cost 75.7 s must contain no visibility helper at all.
    // The cut-out statement reads private.staff_visible_chapter_scope, which is
    // revoked from `authenticated`; inside the real function that call happens
    // in the SECURITY DEFINER context, so the plan is taken there — the
    // caller's claims, the definer's role, exactly as the RPC executes it.
    await claimsOf(world.coordinator);
    const executed = await client.query(`explain (analyze, costs off, timing off)\n${searchStatement(BROAD, 20)}`);
    await asPostgres();
    const plan = executed.rows.map((row) => row["QUERY PLAN"]).join("\n");
    for (const helper of [
      "member_case_visible_to_actor",
      "staff_can_see_user",
      "staff_visible_chapter_scope",
      "has_organization_role",
      "member_has_chapter_role",
      "casework_actor_has_active_grant",
      "member_has_role",
      "mfa_satisfied",
    ]) {
      expect(plan).not.toContain(helper);
    }
    expect(plan).toMatch(/hashed SubPlan/);

    // The plan pin above has to switch sequential scans off, because at 4,000
    // rows a heap walk is genuinely cheaper. At 80,000 rows with real
    // statistics it is not, so here the same pin holds with default planner
    // settings, for both terms: each candidate branch is driven by its GIN
    // expression index and neither case table is read sequentially.
    for (const term of [BROAD, SELECTIVE]) {
      await claimsOf(world.coordinator);
      const shape = await client.query(`explain (analyze, costs off, timing off)\n${searchStatement(term, 20)}`);
      await asPostgres();
      const executedPlan = shape.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(executedPlan, term).toMatch(/Bitmap Index Scan on member_cases_search_document_idx/);
      expect(executedPlan, term).toMatch(/Bitmap Index Scan on member_case_updates_search_document_idx/);
      expect(executedPlan, term).not.toMatch(/Seq Scan on member_cases\b/);
      expect(executedPlan, term).not.toMatch(/Seq Scan on member_case_updates\b/);
    }
  }, 300_000);

  it("installs both GIN expression indexes, and no generated column, on the live catalogue", async () => {
    const { rows } = await client.query("select indexname, indexdef from pg_indexes where indexname in ('member_cases_search_document_idx','member_case_updates_search_document_idx') order by indexname");
    expect(rows.map((row) => row.indexname)).toEqual(["member_case_updates_search_document_idx", "member_cases_search_document_idx"]);
    const byName = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.member_cases_search_document_idx).toContain("USING gin (");
    for (const column of ["reference", "title", "case_type", "articles"]) {
      expect(byName.member_cases_search_document_idx).toContain(`COALESCE(${column}, ''::text)`);
    }
    for (const weight of ["'A'::\"char\"", "'B'::\"char\"", "'C'::\"char\""]) {
      expect(byName.member_cases_search_document_idx).toContain(`setweight(to_tsvector('english'::regconfig, COALESCE`);
      expect(byName.member_cases_search_document_idx).toContain(weight);
    }
    expect(byName.member_case_updates_search_document_idx)
      .toContain("USING gin (to_tsvector('english'::regconfig, COALESCE(body, ''::text)))");
    // The index is an expression, not a column: attnum 0 in pg_index.indkey.
    const keys = await client.query(
      `select i.relname as name, x.indkey::text as indkey
         from pg_index x join pg_class i on i.oid = x.indexrelid
        where i.relname in ('member_cases_search_document_idx','member_case_updates_search_document_idx')`);
    for (const row of keys.rows) expect(row.indkey).toBe("0");
    const columns = await client.query(
      `select attname from pg_attribute
        where attrelid in ('public.member_cases'::regclass,'public.member_case_updates'::regclass)
          and attname = 'search_document'`);
    expect(columns.rows).toEqual([]);
  });

  it("leaves the account-lifecycle BEFORE UPDATE guards able to see an unchanged row", async () => {
    // The defect this migration was reworked for. A stored generated column is
    // computed AFTER the BEFORE triggers, so NEW.<column> is null inside them
    // while OLD carries the stored value: the whole-row comparisons in
    // private.guard_casework_restriction_update() and
    // private.touch_member_case_updated_at() (20260907150000:567 and :520) are
    // then unconditionally distinct, the nested-Auth-detachment arm can never
    // be reached, and the referential SET NULL below raises 42501
    // "restricted-case attribution cannot be detached". Reproduced and repaired
    // on a disposable stack; this is the standing guard.
    const generated = await client.query(
      `select attrelid::regclass::text as rel, attname from pg_attribute
        where attrelid in ('public.member_cases'::regclass,'public.member_case_updates'::regclass)
          and attgenerated <> '' order by 1, 2`);
    expect(generated.rows).toEqual([]);

    await client.query("savepoint attribution_detachment");
    const restrictor = await actor("restrictor@example.invalid");
    const detached = await seedCase({
      owner: world.stranger.id,
      reference: "SG-2026-0107",
      title: `${CORPUS_TOKEN} attribution detachment`,
      restricted: true,
      restrictedBy: restrictor.id,
    });
    // restricted_by REFERENCES auth.users ON DELETE SET NULL, so this delete
    // performs a nested UPDATE that leaves the case restricted with no actor —
    // the one shape private.guard_casework_restriction_update() admits, and
    // only while every other column of the row is identical.
    await client.query("delete from auth.users where id=$1", [restrictor.id]);
    const row = (await client.query(
      "select is_restricted, restricted_by from public.member_cases where id=$1", [detached])).rows[0];
    expect(row).toEqual({ is_restricted: true, restricted_by: null });
    await client.query("rollback to savepoint attribution_detachment");
    await client.query("release savepoint attribution_detachment");
  });
});
