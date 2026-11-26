// @vitest-environment node
//
// BUG-UG-WEB-ENGAGEMENT-SURVEYS-UNPAGED-20261002
// BUG-UG-WEB-ENGAGEMENT-CHANNEL-CARDS-OMIT-CHAPTER-20261002
//
// 20261003046000 bounds the staff survey read and names each channel's
// chapter. Static pins: the snapshot keeps every other key exactly as
// 20261002015000 emitted it, the survey page is clamped to 1..100 and keeps
// the review-lane privacy floor, and the grants are unchanged. Live proof on a
// disposable database (one rolled-back transaction): the snapshot carries the
// first 20 surveys (open, draft, closed), the server counts and a cursor; the
// cursor walk reaches every survey once in that order; the status filter, the
// limit clamp and bad input behave; another organization's staff and a member
// are refused; channels carry the chapter in chapter order.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("staff_engagement_survey_pages_and_channel_chapters"));
const previous = stripComments(loadMigrationSql("20261002015000_survey_review_privacy_floor_and_signin_throttle"));
const snapshotBody = fnBody(sql, "public.get_staff_engagement_snapshot");
const pageBody = fnBody(sql, "private.staff_engagement_survey_page");
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

// The snapshot text between two keys, whitespace-normalized.
function section(body, from, to) {
  const start = body.indexOf(from);
  const end = body.indexOf(to, start);
  expect(start, from).toBeGreaterThan(-1);
  expect(end, to).toBeGreaterThan(start);
  return body.slice(start, end).replace(/\s+/g, " ");
}

describe("staff engagement survey pages and channel chapters (static)", () => {
  it("changes only the survey keys and the channel projection of the snapshot", () => {
    const before = fnBody(previous, "public.get_staff_engagement_snapshot");
    expect(section(snapshotBody, "'pulsePrompts'", "'channels'")).toBe(section(before, "'pulsePrompts'", "'channels'"));
    expect(snapshotBody).toContain("perform private.engagement_require_staff(org);");
    expect(snapshotBody).toContain("survey_page := private.staff_engagement_survey_page(org, null, null, 20);");
    expect(snapshotBody).toContain("'surveys', survey_page -> 'surveys'");
    expect(snapshotBody).toContain("'surveyCounts', survey_page -> 'counts'");
    expect(snapshotBody).toContain("'surveyCursor', survey_page -> 'nextCursor'");
    expect(snapshotBody.indexOf("perform private.engagement_require_staff(org);"))
      .toBeLessThan(snapshotBody.indexOf("private.staff_engagement_survey_page("));
  });

  it("names each channel's chapter and orders channels by chapter", () => {
    const channels = section(snapshotBody, "'channels'", "$function$");
    expect(channels).toContain("'chapterId', chapter.id, 'chapterName', chapter.name");
    expect(channels).toContain("order by chapter.order_index, chapter.name, chapter.id, space.name, space.id");
    expect(channels).toContain("join public.chapters chapter on chapter.id = space.chapter_id and chapter.organization_id = org");
  });

  it("bounds the survey page and keeps the 20261002015000 survey projection and privacy floor", () => {
    expect(pageBody).toContain("least(greatest(coalesce(p_limit, 20), 1), 100)");
    expect(pageBody).toContain("limit page_limit + 1");
    expect(pageBody).toContain("case survey.status when 'open' then 0 when 'draft' then 1 else 2 end as status_rank");
    expect(pageBody).toContain("order by ranked.status_rank, ranked.updated_at desc, ranked.id desc");
    expect(pageBody).toContain("survey.organization_id = p_organization_id");
    const before = fnBody(previous, "public.get_staff_engagement_snapshot");
    expect(section(pageBody, "'id', survey.id", "order by question.sort_index)")).toBe(section(before, "'id', survey.id", "order by question.sort_index)"));
    expect(section(pageBody, "'id', survey.id", "'questions'")).toContain("'reviews', case when lane.value ->> 'state' = 'ready' then");
    expect(pageBody).toContain("private.organization_survey_review_lane(p_organization_id, survey.id)");
  });

  it("keeps the helper private and the new read behind the staff gate for authenticated callers only", () => {
    expect(sql).toContain("revoke all on function private.staff_engagement_survey_page(uuid, text, jsonb, integer)\n  from public, anon, authenticated, service_role;");
    expect(sql).toContain("revoke all on function public.get_staff_engagement_surveys(text, jsonb, integer)\n  from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.get_staff_engagement_surveys(text, jsonb, integer) to authenticated;");
    const read = fnBody(sql, "public.get_staff_engagement_surveys");
    expect(read).toContain("org uuid := private.engagement_selected_organization();");
    expect(read.indexOf("perform private.engagement_require_staff(org);")).toBeLessThan(read.indexOf("private.staff_engagement_survey_page(org, p_status, p_after, p_limit)"));
    expect(read).toContain("security definer");
    expect(read).toContain("set search_path = ''");
  });
});

live("staff engagement survey pages and channel chapters on a disposable database", () => {
  let client;
  const ids = {
    orgA: randomUUID(), orgB: randomUUID(), adminA: randomUUID(), adminB: randomUUID(), member: randomUUID(),
  };
  const suffix = ids.orgA.slice(0, 8);
  ids.chapterA1 = `pages-a1-${suffix}`;
  ids.chapterA2 = `pages-a2-${suffix}`;
  ids.chapterB = `pages-b-${suffix}`;
  const sessions = new Map();
  const surveys = [];

  async function as(user, statement, args = []) {
    await client.query("savepoint proof");
    try {
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", session_id: sessions.get(user) })]);
      await client.query("set local role authenticated");
      const { rows } = await client.query(statement, args);
      await client.query("release savepoint proof");
      return { value: rows[0]?.value };
    } catch (error) {
      await client.query("rollback to savepoint proof");
      return { code: error.code, message: error.message };
    } finally {
      await client.query("reset role");
    }
  }

  async function person(user, org, chapter) {
    const session = randomUUID();
    sessions.set(user, session);
    await client.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [user, chapter]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, user]);
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "staff-engagement-survey-pages-proof" });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2),($3,$4,$4)", [ids.orgA, `pages-a-${suffix}`, ids.orgB, `pages-b-${suffix}`]);
    for (const [chapter, org, order] of [[ids.chapterA1, ids.orgA, 9971], [ids.chapterA2, ids.orgA, 9970], [ids.chapterB, ids.orgB, 9972]]) {
      await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,$3)", [chapter, org, order]);
    }
    await person(ids.adminA, ids.orgA, ids.chapterA1);
    await person(ids.adminB, ids.orgB, ids.chapterB);
    await person(ids.member, ids.orgA, ids.chapterA1);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin'),($3,$4,'admin') on conflict do nothing", [ids.orgA, ids.adminA, ids.orgB, ids.adminB]);
    // 45 surveys: 5 open, 10 draft, 30 closed, each a minute apart.
    for (let index = 0; index < 45; index += 1) {
      const status = index < 5 ? "open" : index < 15 ? "draft" : "closed";
      const id = randomUUID();
      const updatedAt = new Date(Date.UTC(2026, 8, 1, 12, 0) + index * 60000).toISOString();
      await client.query(
        "insert into public.organization_surveys(id,organization_id,chapter_id,title,status,privacy_min_responses,created_by,created_at,updated_at) values ($1,$2,$3,$4,$5,3,$6,$7,$7)",
        [id, ids.orgA, ids.chapterA1, `Pages proof ${index}`, status, ids.adminA, updatedAt],
      );
      surveys.push({ id, status, updatedAt });
    }
    await client.query("update public.organization_surveys set updated_at = fixture.at from (select unnest($1::uuid[]) id, unnest($2::timestamptz[]) at) fixture where organization_surveys.id = fixture.id",
      [surveys.map((survey) => survey.id), surveys.map((survey) => survey.updatedAt)]);
    // Transaction-only fixture: the space trigger stamps the caller's chapter,
    // so the two chapters' spaces are written with row triggers off.
    await client.query("set local session_replication_role = replica");
    for (const chapter of [ids.chapterA1, ids.chapterA2]) {
      await client.query("insert into public.chapter_spaces(chapter_id,name) values ($1,'Actions & turnout'),($1,'General')", [chapter]);
    }
    await client.query("set local session_replication_role = origin");
  });

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  const rank = { open: 0, draft: 1, closed: 2 };
  const expectedOrder = () => [...surveys]
    .sort((a, b) => (rank[a.status] - rank[b.status]) || b.updatedAt.localeCompare(a.updatedAt))
    .map((survey) => survey.id);
  const proofIds = (rows) => rows.map((row) => row.id).filter((id) => surveys.some((survey) => survey.id === id));

  it("puts the first 20 surveys, the counts and a cursor in the snapshot", async () => {
    const { value, code, message } = await as(ids.adminA, "select public.get_staff_engagement_snapshot() as value");
    expect(code, message).toBeUndefined();
    expect(value.surveys).toHaveLength(20);
    expect(proofIds(value.surveys)).toEqual(expectedOrder().slice(0, 20));
    expect(value.surveys.slice(0, 5).every((survey) => survey.status === "open")).toBe(true);
    expect(value.surveyCounts).toEqual({ all: 45, open: 5, draft: 10, closed: 30 });
    expect(value.surveyCursor).toMatchObject({ rank: 2, id: value.surveys[19].id });
    expect(value.surveys[0].reviewLane).toEqual({ state: "collecting", responseCount: 0, privacyMinResponses: 25 });
    expect(value.surveys[0].reviews).toEqual([]);
  });

  it("walks every survey exactly once in the staff order", async () => {
    const snapshot = (await as(ids.adminA, "select public.get_staff_engagement_snapshot() as value")).value;
    const walked = snapshot.surveys.map((survey) => survey.id);
    let cursor = snapshot.surveyCursor;
    let pages = 0;
    while (cursor && pages < 10) {
      const page = (await as(ids.adminA, "select public.get_staff_engagement_surveys(null, $1::jsonb, 20) as value", [JSON.stringify(cursor)])).value;
      expect(page.surveys.length).toBeLessThanOrEqual(20);
      expect(page.counts).toEqual(snapshot.surveyCounts);
      walked.push(...page.surveys.map((survey) => survey.id));
      cursor = page.nextCursor;
      pages += 1;
    }
    expect(pages).toBe(2);
    expect(walked).toEqual(expectedOrder());
  });

  it("filters by status, clamps the page size and refuses bad input", async () => {
    const closed = (await as(ids.adminA, "select public.get_staff_engagement_surveys('closed', null, 100) as value")).value;
    expect(closed.surveys).toHaveLength(30);
    expect(closed.surveys.every((survey) => survey.status === "closed")).toBe(true);
    expect(closed.nextCursor).toBeNull();
    expect((await as(ids.adminA, "select public.get_staff_engagement_surveys(null, null, 0) as value")).value.surveys).toHaveLength(1);
    expect((await as(ids.adminA, "select public.get_staff_engagement_surveys(null, null, 1000) as value")).value.limit).toBe(100);
    expect((await as(ids.adminA, "select public.get_staff_engagement_surveys() as value")).value.surveys).toHaveLength(20);
    expect((await as(ids.adminA, "select public.get_staff_engagement_surveys('archived') as value")).code).toBe("22023");
    expect((await as(ids.adminA, "select public.get_staff_engagement_surveys(null, '{\"rank\":\"x\"}'::jsonb) as value")).code).toBe("22023");
    expect((await as(ids.adminA, "select public.get_staff_engagement_surveys(null, '{\"rank\":1}'::jsonb) as value")).code).toBe("22023");
  });

  it("keeps another organization's staff and a member out", async () => {
    const other = (await as(ids.adminB, "select public.get_staff_engagement_snapshot() as value")).value;
    expect(other.surveyCounts).toEqual({ all: 0, open: 0, draft: 0, closed: 0 });
    expect(JSON.stringify(other)).not.toContain(surveys[0].id);
    const otherPage = (await as(ids.adminB, "select public.get_staff_engagement_surveys(null, $1::jsonb, 100) as value",
      [JSON.stringify({ rank: 0, updatedAt: "2099-01-01T00:00:00Z", id: surveys[0].id })])).value;
    expect(otherPage.surveys).toEqual([]);
    expect((await as(ids.member, "select public.get_staff_engagement_surveys() as value")).code).toBe("42501");
    expect((await as(ids.member, "select public.get_staff_engagement_snapshot() as value")).code).toBe("42501");
  });

  it("names each channel's chapter, in chapter order", async () => {
    const { value } = await as(ids.adminA, "select public.get_staff_engagement_snapshot() as value");
    const proof = value.channels.filter((channel) => [ids.chapterA1, ids.chapterA2].includes(channel.chapterId));
    expect(proof.map((channel) => [channel.chapterName, channel.name])).toEqual([
      [ids.chapterA2, "Actions & turnout"], [ids.chapterA2, "General"],
      [ids.chapterA1, "Actions & turnout"], [ids.chapterA1, "General"],
    ]);
    const same = proof.filter((channel) => channel.name === "Actions & turnout");
    expect(new Set(same.map((channel) => channel.chapterId)).size).toBe(2);
    expect(value.channels.some((channel) => channel.chapterId === ids.chapterB)).toBe(false);
  });
});
