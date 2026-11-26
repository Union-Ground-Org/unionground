// @vitest-environment node
//
// BUG-UG-KNOWLEDGE-ARTICLES-POLICY-REBUILDS-SCOPE-PER-ROW-20261106 (#7361)
// The app's boot read of public.member_kb_articles (select, order by
// order_index and id, limit 100) took 3.1 s on SAMPLE at 1,002 accounts: the
// member branch of member_kb_articles_select called
// private.compass_scope_specificity once per article, and each call rebuilt
// the caller's scope paths with private.compass_member_scope_paths.
// 20261107153700 resolves the caller once per statement.
//
// 1. Every hat (member, verified unit member, member of two chapters, member
//    of an agency sibling, steward, coordinator, admin, aal1 session,
//    revoked organization, revoked chapter, another organization)
//    sees exactly the articles the 20261028210000 policy showed it, over
//    chapter, local, agency and unit scopes and draft, unverified, sample,
//    withheld, stale-classification and stale-scope rows.
// 2. At 1,000 accounts with 160 articles in the organization, the boot read
//    runs compass_member_scope_paths at most once per statement for every
//    hat (the predecessor ran it once per article) and answers in under 1 s
//    (runner-scaled) with the predecessor's rows.
// Everything runs in one transaction that is rolled back.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PREDECESSOR = new URL("../supabase/migrations/20261028210000_rls_merge_multiple_permissive_select_policies.sql", import.meta.url);
const BOOT = `select id,slug,chapter_id,kind,title,article_ref,body,keywords,order_index,status,is_sample,version,created_by,updated_by,verified_by,verified_at,created_at,updated_at
  from public.member_kb_articles order by order_index, id limit 100`;
const ALL = "select id from public.member_kb_articles order by id";
const P = "a7361000";
const MEMBERS = 1000;
const OTHER_MEMBERS = 50;
const CHAPTERS = 6;

// The predecessor policy exactly as 20261028210000 installed it.
function predecessor() {
  const sql = readFileSync(PREDECESSOR, "utf8");
  const head = "create policy member_kb_articles_select on public.member_kb_articles for select to authenticated using (";
  const start = sql.indexOf(head);
  const end = sql.indexOf("\n);\n", start);
  if (start < 0 || end < 0) throw new Error("predecessor member_kb_articles_select not found");
  return `alter policy member_kb_articles_select on public.member_kb_articles using (${sql.slice(start + head.length, end)}\n)`;
}

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (n) => id(P, n);
const chapter = (n) => `${P}-ch-${n}`;
const proof = { source: "https://example.invalid/k7361-scope", sha256: "b".repeat(64) };

live("knowledge article reads resolve the caller's scope once per statement (#7361)", () => {
  let db;

  async function read(caller, sql, { aal = "aal2" } = {}) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller.id, role: "authenticated", aal, session_id: caller.session })]);
      await db.query("set local role authenticated");
      // The hosted authenticated role's limit.
      await db.query("set local statement_timeout = '30s'");
      const started = performance.now();
      const { rows } = await db.query(sql);
      return { ms: performance.now() - started, ids: rows.map((row) => row.id) };
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  async function scopeCalls(run) {
    const calls = async () => (await db.query(
      `select coalesce(sum(calls),0)::integer calls from pg_stat_xact_user_functions
        where schemaname = 'private' and funcname = 'compass_member_scope_paths'`,
    )).rows[0].calls;
    const before = await calls();
    const result = await run();
    return { result, scope: (await calls()) - before };
  }

  async function article(slug, chapterId, { level = "chapter", unit = null, status = "published", verified = true, sample = false, origin = "authored", order = 1 } = {}) {
    const { rows } = await db.query(`insert into public.member_kb_articles(slug,kind,title,article_ref,body,keywords,order_index,chapter_id,status,is_sample,
        verified_by,verified_at,content_origin,compass_scope_level,compass_scope_unit_key,created_by,updated_by)
      values ($1,'contract','Leave','Article 12','The employer shall provide paid leave.','{}',$2,$3,$4,$5,
        case when $6 then $7::uuid end,case when $6 then now() end,$8,$9,$10,$7,$7) returning id`,
    [slug, order, chapterId, status, sample, verified, user(19), origin, level, unit]);
    return rows[0].id;
  }

  let hats;
  let staleClassification;
  let staleScope;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "knowledge-articles-scope-once-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");

    const organization = id(`${P.slice(0, 7)}f`, 1);
    const other = id(`${P.slice(0, 7)}f`, 2);
    // Fixture rows only; triggers resume before the bindings and articles.
    await db.query("set local session_replication_role = replica");
    await db.query("insert into public.organizations(id,slug,name,status) values ($1,'k7361-scale','k7361-scale','active'),($2,'k7361-other','k7361-other','active')", [organization, other]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${P}-ch-'||n,'Scale chapter '||n,'scale',false,9800+n,case when n <= $3 then $1::uuid else $2::uuid end,'${P}-ch-'||n
      from generate_series(1, $3 + 1) n`, [organization, other, CHAPTERS]);
    // Member n is in chapter ((n - 1) mod 6) + 1; the other organization's
    // members are in chapter 7.
    const home = `case when n > ${MEMBERS} then ${CHAPTERS + 1} else ((n - 1) % ${CHAPTERS}) + 1 end`;
    const uid = `('${P}-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid`;
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select ${uid},'authenticated','authenticated','${P}-'||n||chr(64)||'example.invalid','{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from generate_series(1, $1::integer) n`, [MEMBERS + OTHER_MEMBERS]);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select ${uid},'Scale','Scale member '||lpad(n::text,5,'0'),'SM','${P}-ch-'||(${home}),'Member',2020,'en','{}',false,'UTC',true,'{}','{}',now(),now()
      from generate_series(1, $1::integer) n`, [MEMBERS + OTHER_MEMBERS]);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select ${uid},'${P}-ch-'||(${home}),'active',true,now() from generate_series(1, $1::integer) n`, [MEMBERS + OTHER_MEMBERS]);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when n > $2::integer then $3::uuid else $1::uuid end,${uid},'active' from generate_series(1, $4::integer) n`,
    [organization, MEMBERS, other, MEMBERS + OTHER_MEMBERS]);
    // Member 13 also belongs to chapter 3.
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at) values ($1,$2,'active',false,now())", [user(13), chapter(3)]);
    for (const [n, role] of [[19, "steward"], [25, "coordinator"], [31, "admin"]]) {
      for (const table of ["member_roles", "member_role_chapters"]) {
        await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)`, [user(n), role, chapter(1)]);
      }
    }
    await db.query("update public.organization_memberships set status = 'revoked', revoked_at = now() where user_id = $1", [user(43)]);
    await db.query("update public.member_chapter_memberships set status = 'revoked', revoked_at = now() where user_id = $1", [user(55)]);
    await db.query("set local session_replication_role = origin");

    // Chapters 1 and 2 share an agency; chapter 1 has two sourced units, and
    // member 7 holds a verified assignment to the first.
    await db.query(`insert into private.compass_chapter_scope_bindings(chapter_id,organization_id,agency_key,unit_keys,provenance) values
      ($1,$3,'agency:k7361',array['unit:k1','unit:k2'],$4),($2,$3,'agency:k7361','{}',$4)`, [chapter(1), chapter(2), organization, proof]);
    await db.query("update public.member_chapter_memberships set compass_unit_keys = array['unit:k1'], compass_scope_verification = $2 where user_id = $1", [user(7), proof]);

    // 160 articles in the organization: 22 per chapter at chapter scope,
    // organization-wide, agency and unit articles, and every row the policy
    // must refuse; 8 in the other organization.
    let order = 0;
    for (let c = 1; c <= CHAPTERS; c += 1) {
      for (let k = 1; k <= 22; k += 1) await article(`${P}-c${c}-${k}`, chapter(c), { order: (order += 1) });
    }
    for (let k = 1; k <= 4; k += 1) await article(`${P}-local-${k}`, chapter(3), { level: "local", order: (order += 1) });
    for (let k = 1; k <= 3; k += 1) await article(`${P}-agency1-${k}`, chapter(1), { level: "agency", order: (order += 1) });
    for (let k = 1; k <= 2; k += 1) await article(`${P}-agency2-${k}`, chapter(2), { level: "agency", order: (order += 1) });
    for (const unit of ["unit:k1", "unit:k2"]) {
      for (let k = 1; k <= 2; k += 1) await article(`${P}-${unit.slice(5)}-${k}`, chapter(1), { level: "unit", unit, order: (order += 1) });
    }
    await article(`${P}-draft`, chapter(1), { status: "draft", order: (order += 1) });
    await article(`${P}-unverified`, chapter(1), { status: "draft", verified: false, order: (order += 1) });
    // A sample row has no chapter and is never published (table checks).
    await article(`${P}-sample`, null, { status: "draft", verified: false, sample: true, order: (order += 1) });
    await article(`${P}-withheld`, chapter(1), { origin: "unresolved", order: (order += 1) });
    staleClassification = await article(`${P}-stale-classification`, chapter(1), { order: (order += 1) });
    staleScope = await article(`${P}-stale-scope`, chapter(2), { order: (order += 1) });
    for (let k = 1; k <= 8; k += 1) await article(`${P}-other-${k}`, chapter(CHAPTERS + 1), { order: (order += 1) });
    await db.query("set local session_replication_role = replica");
    await db.query("update public.member_kb_articles set compass_classification = compass_classification || '{\"input_sha256\":\"stale\"}' where id = $1", [staleClassification]);
    await db.query("update public.member_kb_articles set compass_scope_path = array_append(compass_scope_path, 'unit:forged') where id = $1", [staleScope]);
    await db.query("set local session_replication_role = origin");

    const callers = { member: 1, unitMember: 7, twoChapters: 13, agencySibling: 2, steward: 19, coordinator: 25, admin: 31, aal1Session: 37, revokedOrganization: 43, revokedChapter: 55, otherOrganization: MEMBERS + 1 };
    hats = {};
    for (const [hat, n] of Object.entries(callers)) {
      const session = id(`${P.slice(0, 7)}5`, n);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'scale','totp','verified','scale',now(),now())", [user(n)]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),$3)", [session, user(n), hat === "aal1Session" ? "aal1" : "aal2"]);
      hats[hat] = { id: user(n), session, aal: hat === "aal1Session" ? "aal1" : "aal2" };
    }
    await db.query(`analyze public.member_kb_articles, public.member_profiles, public.member_chapter_memberships, public.organization_memberships,
      public.chapters, public.organizations, public.member_roles, public.member_role_chapters, private.compass_chapter_scope_bindings`);
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  async function everyHat(sql) {
    const result = {};
    for (const [hat, caller] of Object.entries(hats)) result[hat] = await read(caller, sql, { aal: caller.aal });
    return result;
  }

  it("shows every hat exactly the articles the predecessor policy showed it", async () => {
    const installed = await everyHat(ALL);
    const slugs = Object.fromEntries((await db.query("select id, slug from public.member_kb_articles where slug like $1", [`${P}-%`])).rows.map((row) => [row.id, row.slug]));
    const seen = (hat) => installed[hat].ids.map((articleId) => slugs[articleId]).filter(Boolean);
    const count = (hat, pattern) => seen(hat).filter((slug) => pattern.test(slug)).length;

    // A chapter one member: its 22 chapter articles, the 4 organization-wide
    // ones and both agencies' agency articles; no unit, draft, sample,
    // withheld, stale or foreign row.
    expect(seen("member")).toHaveLength(31);
    expect(count("member", /-agency[12]-/)).toBe(5);
    expect(count("member", /-k[12]-|draft|unverified|sample|withheld|stale|other/)).toBe(0);
    // The verified unit assignment adds that unit's two articles only.
    expect(seen("unitMember")).toHaveLength(33);
    expect(count("unitMember", /-k1-/)).toBe(2);
    expect(count("unitMember", /-k2-/)).toBe(0);
    // A second membership adds chapter three's articles.
    expect(seen("twoChapters")).toHaveLength(53);
    // Chapter two shares the agency: its own 22 (not the stale-scope row),
    // the organization-wide 4 and all 5 agency articles.
    expect(seen("agencySibling")).toHaveLength(31);
    // Chapter staff also see their chapter's unpublished, unverified and
    // unit-scoped rows, never the sample or withheld ones.
    for (const hat of ["steward", "coordinator", "admin"]) {
      expect(count(hat, /draft|unverified|-k1-|-k2-/), hat).toBe(6);
      expect(count(hat, /sample|withheld/), hat).toBe(0);
    }
    for (const hat of ["aal1Session", "revokedOrganization", "revokedChapter"]) {
      expect(seen(hat), hat).toEqual([]);
    }
    expect(seen("otherOrganization")).toHaveLength(8);

    await db.query("savepoint predecessor");
    try {
      await db.query(predecessor());
      const before = await everyHat(ALL);
      for (const hat of Object.keys(installed)) expect(installed[hat].ids, hat).toEqual(before[hat].ids);
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(60_000));

  it("resolves the caller's scope at most once per boot read at 1,000 accounts, in under 1 s", async () => {
    const budget = runnerTimeout(1_000);
    const installed = {};
    for (const hat of ["member", "unitMember", "twoChapters", "steward", "coordinator", "otherOrganization"]) {
      await read(hats[hat], BOOT);
      const { result, scope } = await scopeCalls(() => read(hats[hat], BOOT));
      expect(result.ids.length, hat).toBeGreaterThan(0);
      expect(scope, hat).toBeLessThanOrEqual(1);
      expect(result.ms, hat).toBeLessThan(budget);
      installed[hat] = result.ids;
    }

    await db.query("savepoint predecessor");
    try {
      await db.query(predecessor());
      for (const hat of Object.keys(installed)) {
        const { result, scope } = await scopeCalls(() => read(hats[hat], BOOT));
        expect(result.ids, hat).toEqual(installed[hat]);
        // The predecessor rebuilt the scope paths for each of the caller's
        // organization's non-local articles.
        if (hat !== "otherOrganization") expect(scope, hat).toBeGreaterThan(100);
      }
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(120_000));
});
