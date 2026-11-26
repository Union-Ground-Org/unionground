// @vitest-environment node
//
// PERF-UG-CLAUSE-GRIEVANCE-COUNT-CROSS-JOIN-20260921
// public.list_contract_clause_grievance_counts (20260925110500) joined
// contract_clauses to member_cases on a LIKE over a per-row regexp_replace, so
// the planner ran a nested loop that re-evaluated the regexp for every
// (clause, case) pair. 20260925620000 tokenizes each visible case's articles
// once and joins on equality.
//
// The offline half pins the shape of the latest definition. The live half
// (disposable loopback only) seeds 5,000 cases and 200 clauses in one
// organization, then, for a coordinator:
//   * the RPC returns exactly what the 20260925110500 query returns for every
//     clause article without a LIKE wildcard, and the wildcard article
//     'Article 1_' is no longer counted against 'article 10'..'article 19';
//   * EXPLAIN ANALYZE of the function's query (read out of the latest
//     migration, with the plpgsql variables bound to the caller's hoisted
//     values) scans member_cases once, has no join filter that runs the
//     regexp per pair, and joins clauses to per-token counts (bounded by
//     clauses x distinct tokens, not cases). The same check fails on the
//     20260925110500 query.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, latestFnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const FN = "public.list_contract_clause_grievance_counts";
const PREVIOUS = "20260925110500_clause_grievance_counts_case_visibility";
const REPAIR = "20260925620000_clause_grievance_counts_equality_join";
const squash = (text) => text.replace(/\s+/g, " ").trim();

// The plpgsql variables the returned query reads, in bind order.
const VARIABLES = [
  ["org", "uuid"],
  ["v_actor", "uuid"],
  ["staff", "boolean"],
  ["steward_hat", "boolean"],
  ["coordinator_chapters", "text[]"],
  ["staff_organization", "uuid"],
  ["organization_officer", "boolean"],
  ["granted_cases", "uuid[]"],
];

// The function's returned expression as a standalone statement with $n binds.
function countsQuery(body) {
  const start = body.indexOf("return coalesce((");
  const end = body.indexOf("), '[]'::jsonb);", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  let query = `select coalesce((${body.slice(start + "return coalesce((".length, end)}), '[]'::jsonb) as counts`;
  VARIABLES.forEach(([name, type], index) => {
    query = query.replace(new RegExp(`(?<![.\\w])${name}(?![\\w(])`, "g"), `$${index + 1}::${type}`);
  });
  // The scoped reader no longer uses every legacy authorization hoist. Give
  // every supplied parameter an explicit type even when absent from its query.
  return `${query} from (select ${VARIABLES.map(([, type], index) => `$${index + 1}::${type}`).join(", ")}) as proof_inputs`;
}

// #6277: the platform organization boundary re-emits the function with one
// refusal after the membership gate; everything else is the repair's body.
const PLATFORM_REFUSAL = "if private.organization_is_platform(org) then raise exception 'platform organization is private' using errcode = '42501'; end if; ";

describe("clause grievance counts equality join (offline pins)", () => {
  const body = squash(latestFnBody(FN));
  // PIN and platform gates precede aggregation. Scoped access replaces the
  // old inline policy mirror; tokenization and the equality join stay intact.
  const withoutPinWrapper = body
    .replace(PLATFORM_REFUSAL, "")
    .replace("as $function$ begin perform private.member_pin_require_full_session(); declare", "as $function$ declare")
    .replace("end; end; $function$;", "end; $function$;");

  it("refuses a platform organization right after the membership gate, before any aggregation", () => {
    expect(body).toContain(PLATFORM_REFUSAL);
    expect(body.indexOf(PLATFORM_REFUSAL)).toBeGreaterThan(body.indexOf("if not private.is_organization_member(org) then"));
    expect(body.indexOf(PLATFORM_REFUSAL)).toBeLessThan(body.indexOf("return coalesce(("));
  });

  it("keeps the equality repair after the restricted-session and scope guards", () => {
    const names = migrationNames();
    expect(names.indexOf(`${REPAIR}.sql`)).toBeGreaterThan(names.indexOf(`${PREVIOUS}.sql`));
    expect(body).toContain("perform private.member_pin_require_full_session();");
    expect(body.indexOf("perform private.member_pin_require_full_session();")).toBeLessThan(body.indexOf("org uuid :="));
    const aggregationShape = (text) => text.slice(text.indexOf("visible_cases as ("))
      .replace(/from .*?\), case_articles as/, "from visible_cases_scope), case_articles as")
      .replace(/end;\s*end;/, "end;")
      .replace(/\$function\$\s*;/, "$function$;");
    expect(aggregationShape(body)).toBe(aggregationShape(squash(fnBody(stripComments(loadMigrationSql(REPAIR)), FN))));
  });

  it("normalizes each case once and joins clause articles on equality", () => {
    expect(body.match(/pg_catalog\.regexp_replace\(/g)).toHaveLength(1);
    expect(body).not.toMatch(/\blike\b/i);
    expect(body).toContain("pg_catalog.string_to_array(pg_catalog.btrim(v.line, ','), ',')");
    expect(body).toContain("token_counts as materialized (");
    expect(body).toContain("pg_catalog.count(distinct ca.case_id)::integer as n from case_articles ca group by ca.article");
    expect(body).toContain("join token_counts t on t.article = a.article");
  });

  it("keeps the tenant gates and uses the shared scoped case visibility rule", () => {
    for (const needle of [
      "org uuid := private.mi1_require_selected_organization();",
      "if not private.mfa_satisfied() then",
      "if not private.is_organization_member(org) then",
      "and (staff or c.status = 'published')",
      "private.chapter_case_readable(cs)",
      "with actor_scope as materialized (",
      "array(select private.staff_visible_chapter_scope('coordinator'))",
    ]) expect(body).toContain(needle);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path (?:=|to) ''/i);
    // The declarations and hoists are unchanged; only the returned query moved.
    const previous = squash(fnBody(stripComments(loadMigrationSql(PREVIOUS)), FN));
    const head = (text) => text.slice(text.indexOf("declare "), text.indexOf("return coalesce(("));
    expect(head(withoutPinWrapper)).toBe(head(previous));
  });

  it("changes no grant", () => {
    const sql = loadMigrationSql(REPAIR);
    expect(sql).not.toMatch(/^\s*(grant|revoke)\b/im);
    expect(sql).toMatch(/create or replace function public\.list_contract_clause_grievance_counts\(\)/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("list_contract_clause_grievance_counts at volume", () => {
  let client;
  const world = {};
  const CASES = 5000;
  const ARTICLES = 200;
  const WILDCARD = "Article 1_";

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

  async function claims(person) {
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: person.id,
      role: "authenticated",
      aal: "aal2",
      session_id: person.session,
    })]);
  }

  // The caller's hoisted values, resolved exactly as the function resolves them.
  async function binds(person) {
    await client.query("reset role");
    await claims(person);
    const { rows } = await client.query(`
      select private.mi1_require_selected_organization() as org,
             (select auth.uid()) as actor,
             private.has_organization_role(private.mi1_require_selected_organization(),
               array['steward', 'coordinator', 'advisor', 'admin', 'vp']) as staff,
             coalesce(public.member_has_role(array['steward']), false) as steward_hat,
             array(select private.staff_visible_chapter_scope('coordinator')) as chapters,
             private.current_mobile_staff_organization() as staff_org,
             coalesce(private.has_organization_role(private.current_mobile_staff_organization(),
               array['advisor', 'admin', 'vp']), false) as officer,
             array(select g.case_id from public.casework_access_grants g
                    where g.grantee_user_id = (select auth.uid()) and g.revoked_at is null) as granted`);
    const row = rows[0];
    return [row.org, row.actor, row.staff, row.steward_hat, row.chapters, row.staff_org, row.officer, row.granted];
  }

  async function rpc(person) {
    await client.query("reset role");
    await claims(person);
    await client.query("set local role authenticated");
    const start = process.hrtime.bigint();
    const { rows } = await client.query("select public.list_contract_clause_grievance_counts() as counts");
    if (process.env.CLAUSE_TIMING_REPORT) appendFileSync(process.env.CLAUSE_TIMING_REPORT,
      JSON.stringify({cases:CASES,articles:ARTICLES,wallMs:Number(process.hrtime.bigint()-start)/1e6})+"\n");
    await client.query("reset role");
    return rows[0].counts;
  }

  function planNodes(node, out = []) {
    out.push(node);
    for (const child of node.Plans ?? []) planNodes(child, out);
    return out;
  }

  async function analyze(query, params) {
    const { rows } = await client.query(`explain (analyze, format json) ${query}`, params);
    return planNodes(rows[0]["QUERY PLAN"][0].Plan);
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "clause-grievance-counts-equality-join-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '120s'");
    await client.query("set local lock_timeout = '15s'");

    world.org = randomUUID();
    world.chapter = `cge-${world.org.slice(0, 8)}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, world.chapter]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97432)", [world.chapter, world.org]);

    world.owner = await actor("owner");
    world.coordinator = await actor("coordinator");
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'coordinator',$2)", [world.coordinator.id, world.chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'coordinator',$2)", [world.coordinator.id, world.chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'coordinator',$2)", [world.org, world.coordinator.id]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), world.coordinator.id]);

    // Two articles per case with every separator form the normalizer folds,
    // leading/trailing separators, and every 50th case restricted.
    await client.query(
      `insert into public.member_cases(user_id,reference,title,case_type,articles,step,is_restricted,restriction_reason,restricted_at,restricted_by)
       select $1, 'CGE-' || g, 'Proof case', 'Grievance',
              (array['', ', ', ' ;'])[1 + g % 3]
                || 'Article ' || (g % $3::integer)
                || (array[', ', ';', ' / ', ' ,; '])[1 + g % 4]
                || 'Article ' || ((g * 7 + 3) % $3::integer)
                || (array['', ';', ''])[1 + g % 3],
              'Intake', g % 50 = 0,
              case when g % 50 = 0 then 'Restricted for this proof run' end,
              case when g % 50 = 0 then now() end,
              case when g % 50 = 0 then $1::uuid end
       from pg_catalog.generate_series(1, $2::integer) g`,
      [world.owner.id, CASES, ARTICLES],
    );
    // One published clause per article (the last one retired), and a
    // published article carrying a LIKE wildcard.
    await client.query(
      `insert into public.contract_clauses(organization_id,article,category,title,summary,status)
       select $1, 'Article ' || g, 'Proof', 'Proof clause', 'Proof clause summary',
              case when g = $2::integer - 1 then 'retired' else 'published' end
       from pg_catalog.generate_series(0, $2::integer - 1) g`,
      [world.org, ARTICLES],
    );
    await client.query(
      `insert into public.contract_clauses(organization_id,article,category,title,summary,status)
       values ($1,$2,'Proof','Proof clause','Proof clause summary','published')`,
      [world.org, WILDCARD],
    );
    // No ANALYZE: its pg_class.reltuples update is not rolled back with the
    // fixture, and the planner already sees the volume through page counts.
    world.binds = await binds(world.coordinator);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("returns the 20260925110500 counts for every non-wildcard article and stops pattern-matching the wildcard", async () => {
    const counts = await rpc(world.coordinator);
    const { rows } = await client.query(countsQuery(fnBody(stripComments(loadMigrationSql(PREVIOUS)), FN)), world.binds);
    const previous = rows[0].counts;
    // The coordinator is staff: every article, the retired one included.
    expect(counts).toHaveLength(ARTICLES);
    expect(counts.some((row) => row.article === `article ${ARTICLES - 1}`)).toBe(true);
    // Restricted cases are not counted: ~1/50 of each article's cases are withheld.
    expect(counts.reduce((sum, row) => sum + row.count, 0)).toBeLessThan(2 * CASES);
    expect(counts).toEqual(previous.filter((row) => row.article !== WILDCARD.toLowerCase()));
    // 'article 1_' matched 'article 10'..'article 19' as a LIKE pattern before.
    expect(previous.find((row) => row.article === WILDCARD.toLowerCase())?.count).toBeGreaterThan(0);
    expect(counts.find((row) => row.article === WILDCARD.toLowerCase())).toBeUndefined();
  });

  it("returns the same counts through the RPC and through its query read from the latest migration", async () => {
    const { rows } = await client.query(countsQuery(latestFnBody(FN)), world.binds);
    expect(rows[0].counts).toEqual(await rpc(world.coordinator));
  });

  it(`scans member_cases once and never runs the regexp as a per-pair join filter at ${CASES} cases x ${ARTICLES} clauses`, async () => {
    const nodes = await analyze(countsQuery(latestFnBody(FN)), world.binds);
    const caseScans = nodes.filter((node) => node["Relation Name"] === "member_cases");
    expect(caseScans).toHaveLength(1);
    expect(caseScans[0]["Actual Loops"]).toBe(1);
    expect(nodes.filter((node) => /regexp_replace/.test(node["Join Filter"] ?? ""))).toEqual([]);
    // The clause join reads the per-token counts, never the per-case rows:
    // however it is planned, its inner work is bounded by clauses x distinct
    // tokens, not by the number of cases.
    const tokenScans = nodes.filter((node) => node["Node Type"] === "CTE Scan" && node["CTE Name"] === "token_counts");
    expect(tokenScans).toHaveLength(1);
    expect(tokenScans[0]["Actual Rows"] * tokenScans[0]["Actual Loops"]).toBeLessThanOrEqual((ARTICLES + 1) * ARTICLES);
    expect(nodes.some((node) => node["Node Type"] === "CTE Scan" && node["CTE Name"] === "case_articles")).toBe(false);
  });

  it("fails the same plan check on the 20260925110500 query (the check is not vacuous)", async () => {
    const nodes = await analyze(countsQuery(fnBody(stripComments(loadMigrationSql(PREVIOUS)), FN)), world.binds);
    const perPair = nodes.filter((node) => /regexp_replace/.test(node["Join Filter"] ?? ""));
    const rescans = nodes.filter((node) => node["Relation Name"] === "member_cases" && node["Actual Loops"] > 1);
    expect(perPair.length + rescans.length).toBeGreaterThan(0);
  });
});
