// @vitest-environment node
//
// SEC-UG-CLAUSE-GRIEVANCE-COUNTS-LEAK-RESTRICTED-CASES-20260920
// public.list_contract_clause_grievance_counts is SECURITY DEFINER, so the
// member_cases SELECT policies do not run inside it. This proof executes the
// RPC for an owner, an unrelated member, an assigned steward, a coordinator and
// a coordinator with an explicit casework grant, and requires each per-article
// count to equal the number of matching cases that caller can select through
// RLS: restricted cases are not counted, retired clauses are not surfaced to
// members, and a case is counted once however many sectioned clause rows share
// its article.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const repairSql = stripComments(loadMigrationSql("clause_grievance_counts_case_visibility")).replace(/\s+/g, " ");

describe("clause grievance counts visibility (offline pins)", () => {
  it("counts distinct visible cases over caller-visible clauses", () => {
    expect(repairSql).toContain("pg_catalog.count(distinct cs.id)::integer as n");
    expect(repairSql).toContain("and (staff or c.status = 'published')");
    expect(repairSql).toContain("array(select private.staff_visible_chapter_scope('coordinator'))");
    expect(repairSql).toContain("or (cs.steward_user_id = v_actor and steward_hat)");
    expect(repairSql).toContain("not cs.is_restricted");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("list_contract_clause_grievance_counts over a disposable database", () => {
  let client;
  const world = {};
  const ARTICLE = "Article 12";
  const RETIRED_ARTICLE = "Article 30";

  async function actor(label) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${label}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, world.chapter]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, world.chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [world.org, id]);
    return { id, session };
  }

  async function grantRole(person, role) {
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [person.id, role, world.chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [person.id, role, world.chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [world.org, person.id, role]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), person.id]);
  }

  async function become(person) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: person.id,
      role: "authenticated",
      aal: "aal2",
      session_id: person.session,
    })]);
    await client.query("set local role authenticated");
  }

  async function seedCase({ owner, articles, restricted = false, steward = null }) {
    const id = randomUUID();
    await client.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,articles,step,is_restricted,restriction_reason,restricted_at,restricted_by,steward_user_id)
       values ($1,$2,$3,'Proof case','Grievance',$4,'Intake',$5,$6,$7,$8,$9)`,
      [id, owner, `CG-${id.slice(0, 8)}`, articles, restricted, restricted ? "Restricted for this proof run" : null,
        restricted ? new Date().toISOString() : null, restricted ? owner : null, steward],
    );
    return id;
  }

  async function countsFor(person) {
    await become(person);
    const { rows } = await client.query("select public.list_contract_clause_grievance_counts() as counts");
    return Object.fromEntries(rows[0].counts.map((row) => [row.article, row.count]));
  }

  async function rlsCount(person, article) {
    await become(person);
    const { rows } = await client.query(
      "select count(*)::int as n from public.member_cases where id = any($1::uuid[]) and articles ilike $2",
      [world.cases, `%${article}%`],
    );
    return rows[0].n;
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "clause-grievance-counts-visibility-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");

    world.org = randomUUID();
    world.chapter = `cg-${world.org.slice(0, 8)}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, world.chapter]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97431)", [world.chapter, world.org]);

    world.owner = await actor("owner");
    world.stranger = await actor("stranger");
    world.steward = await actor("steward");
    world.coordinator = await actor("coordinator");
    world.grantedCoordinator = await actor("granted");
    await grantRole(world.steward, "steward");
    await grantRole(world.coordinator, "coordinator");
    await grantRole(world.grantedCoordinator, "coordinator");

    world.ownerCase = await seedCase({ owner: world.owner.id, articles: `${ARTICLE}, ${RETIRED_ARTICLE}` });
    world.stewardCase = await seedCase({ owner: world.owner.id, articles: ARTICLE, steward: world.steward.id });
    world.strangerCase = await seedCase({ owner: world.stranger.id, articles: ARTICLE });
    world.restrictedCase = await seedCase({ owner: world.stranger.id, articles: `${ARTICLE}; ${RETIRED_ARTICLE}`, restricted: true });
    world.cases = [world.ownerCase, world.stewardCase, world.strangerCase, world.restrictedCase];

    const bound = (await client.query("select organization_id, chapter_id from public.member_cases where id=$1", [world.restrictedCase])).rows[0];
    expect(bound.organization_id).toBe(world.org);
    await client.query(
      `insert into public.casework_access_grants(case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason)
       values ($1,$2,$3,$4,$5,'Proof run explicit access grant')`,
      [world.restrictedCase, bound.organization_id, bound.chapter_id, world.grantedCoordinator.id, world.stranger.id],
    );

    // Two published sectioned rows for one article, and one retired article.
    for (const [section, status, article] of [["1", "published", ARTICLE], ["2", "published", ARTICLE], [null, "retired", RETIRED_ARTICLE]]) {
      await client.query(
        `insert into public.contract_clauses(organization_id,article,section,category,title,summary,status)
         values ($1,$2,$3,'Proof','Proof clause','Proof clause summary',$4)`,
        [world.org, article, section, status],
      );
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  for (const who of ["owner", "stranger", "steward", "coordinator", "grantedCoordinator"]) {
    it(`counts for ${who} equal the cases ${who} can select, once each`, async () => {
      const counts = await countsFor(world[who]);
      expect(counts[ARTICLE.toLowerCase()] ?? 0).toBe(await rlsCount(world[who], ARTICLE));
    });
  }

  it("never counts a restricted case for an ordinary member and hides retired clause articles", async () => {
    expect(await countsFor(world.owner)).toEqual({ [ARTICLE.toLowerCase()]: 2 });
    expect(await countsFor(world.stranger)).toEqual({ [ARTICLE.toLowerCase()]: 2 });
    const coordinator = await countsFor(world.coordinator);
    expect(coordinator[ARTICLE.toLowerCase()]).toBe(3);
    expect(coordinator[RETIRED_ARTICLE.toLowerCase()]).toBe(1);
    const granted = await countsFor(world.grantedCoordinator);
    expect(granted[ARTICLE.toLowerCase()]).toBe(4);
    expect(granted[RETIRED_ARTICLE.toLowerCase()]).toBe(2);
  });
});
