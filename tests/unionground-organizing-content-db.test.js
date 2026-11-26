// @vitest-environment node
// Union Ground organizing content and access in the database (owner
// decisions D4 and D5, 2026-10-15), proven on the owned disposable stack in
// rolled-back transactions:
//   * seeded rights lessons and Guide rows promise no union representation,
//     steward or grievance procedure, and the weingarten lesson keeps its id;
//   * an Organizer may send and receive a staff peer-contact request, and a
//     worker with no hat still may not;
//   * the coordination snapshot carries no mission leaderboards.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.RUN_UNIONGROUND_ORGANIZING_CONTENT_DB_TESTS === "1" ? describe : describe.skip;
const PROMISES_A_UNION = /union representation|union representative|union assistance|steward|representaci[oó]n sindical|representante sindical|asistencia sindical|delegad[oa]/i;
const NAMES_A_UNION_OR_CONTRACT = /union representation|steward|file a grievance|grievable|step [12]\b|local 509|seiu|\b509\b|fair[- ]share|massability|\bdds\b/i;

live("Union Ground organizing content and access", () => {
  let client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "unionground-organizing-content-proof" });
    await client.connect();
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => { await client.query("begin"); });
  afterEach(async () => { await client.query("rollback"); });

  async function as(user, session, sql, values = []) {
    await client.query("savepoint caller");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
    try {
      const value = (await client.query(sql, values)).rows[0].value;
      await client.query("reset role");
      await client.query("release savepoint caller");
      return { value };
    } catch (error) {
      await client.query("rollback to savepoint caller");
      await client.query("release savepoint caller");
      return { code: error.code, message: error.message };
    }
  }

  async function campaign(people) {
    const organization = randomUUID();
    const chapter = `psg-content-${organization}`;
    await client.query("insert into public.organizations (id, slug, name) values ($1, $2, 'Content Proof Campaign Org')", [organization, chapter]);
    await client.query("insert into public.chapters (id, name, region, order_index, organization_id, slug) values ($1, 'Content Proof Campaign', 'Local proof', 917, $2, $1)", [chapter, organization]);
    const sessions = {};
    for (const [name, role] of Object.entries(people)) {
      const user = randomUUID();
      const session = randomUUID();
      sessions[name] = { user, session };
      await client.query("insert into auth.users (id, email) values ($1, $2)", [user, `${name}-${user}@example.invalid`]);
      await client.query("insert into public.organization_memberships (organization_id, user_id) values ($1, $2)", [organization, user]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id) values ($1, $2)", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [user, chapter]);
      await client.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), user]);
      await client.query("insert into auth.sessions (id, user_id, aal, created_at) values ($1, $2, 'aal2', now())", [session, user]);
      if (role) {
        await client.query("insert into public.member_roles (user_id, role, chapter_id) values ($1, $2, $3)", [user, role, chapter]);
        await client.query("insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [user, role, chapter]);
      }
    }
    return { organization, chapter, sessions };
  }

  it("seeds rights lessons that hold before recognition, keeping the weingarten id", async () => {
    const lessons = (await client.query(`select id, label, title, description, steps, script, title_es, description_es, steps_es, script_es
      from public.member_rights_lessons order by order_index`)).rows;
    expect(lessons.map((lesson) => lesson.id)).toEqual(["loudermill", "weingarten", "harassment", "pip", "safety"]);
    for (const lesson of lessons) {
      expect(JSON.stringify(lesson), lesson.id).not.toMatch(PROMISES_A_UNION);
      expect(lesson.steps_es, lesson.id).toHaveLength(lesson.steps.length);
    }
    const weingarten = lessons.find((lesson) => lesson.id === "weingarten");
    expect(weingarten.title).toBe("Surprise disciplinary meeting");
    expect(weingarten.title_es).toBe("Reunión disciplinaria sorpresa");
    expect(weingarten.steps).toHaveLength(4);
    expect(weingarten.steps[1]).toBe("Ask for a coworker to be present. The employer may say no, but asking is still worth it.");
    expect(weingarten.script).toBe("Could this meeting lead to discipline? If it could, I would like a coworker to be present. I will not sign anything I disagree with, and I would like a copy of anything you give me or ask me to sign.");
    expect(weingarten.script_es).toContain("quisiera que un compañero o compañera de trabajo esté presente");
    // Saved progress keeps pointing at the same lesson.
    const user = randomUUID();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [user, `progress-${user}@example.invalid`]);
    await client.query("insert into public.member_rights_progress (lesson_id, user_id, completed_steps) values ('weingarten', $1, array[0, 3])", [user]);
    expect((await client.query("select completed_steps from public.member_rights_progress where user_id = $1", [user])).rows[0].completed_steps).toEqual([0, 3]);
  });

  it("seeds Guide rows that name no union, contract, steward or grievance procedure", async () => {
    const articles = (await client.query(`select slug, kind, title, article_ref, body, keywords, status
      from public.member_kb_articles where is_sample order by slug`)).rows;
    expect(articles).toHaveLength(9);
    for (const article of articles) {
      // The slug is a stable key (one still reads "fair-share"); every shown field is checked.
      const { slug, ...shown } = article;
      expect(JSON.stringify(shown), slug).not.toMatch(NAMES_A_UNION_OR_CONTRACT);
      expect(article.kind, article.slug).not.toBe("contract");
      expect(article.status, article.slug).toBe("retired");
    }
    const weingarten = articles.find((article) => article.slug === "faq-weingarten-rights");
    expect(weingarten.body).toContain("They generally apply once a union represents the workplace.");
    expect(weingarten.body).toContain("ask for a coworker to be present as a witness");
    expect(weingarten.body).toContain("Section 7 of the National Labor Relations Act");
  });

  it("lets an Organizer send and receive a staff peer-contact request, and still refuses a worker with no hat", async () => {
    const { chapter, sessions } = await campaign({ first: "organizer", second: "organizer", worker: null });
    const eligible = async (name) => (await client.query("select private.member_peer_staff_eligible($1, $2) as ok", [sessions[name].user, chapter])).rows[0].ok;
    expect(await eligible("first")).toBe(true);
    expect(await eligible("second")).toBe(true);
    expect(await eligible("worker")).toBe(false);

    const second = await as(sessions.second.user, sessions.second.session, "select public.list_reward_peer_contact() as value");
    expect(second.value?.canRequest, second.message).toBe(true);
    const requested = await as(sessions.first.user, sessions.first.session, "select public.request_reward_peer_contact($1) as value", [second.value.code]);
    expect(requested.value, requested.message).toMatchObject({ requested: true, status: "pending" });
    const stored = (await client.query("select staff_authorized from public.member_peer_contact_requests where id = $1", [requested.value.id])).rows[0];
    expect(stored.staff_authorized).toBe(true);
    const answered = await as(sessions.second.user, sessions.second.session, "select public.respond_reward_peer_contact($1, true) as value", [requested.value.id]);
    expect(answered.code, answered.message).toBeUndefined();

    const worker = await as(sessions.worker.user, sessions.worker.session, "select public.list_reward_peer_contact() as value");
    expect(worker.value?.canRequest).toBe(false);
    const refused = await as(sessions.worker.user, sessions.worker.session, "select public.request_reward_peer_contact($1) as value", [second.value.code]);
    expect(refused.value).toEqual({ requested: false, reason: "contact request unavailable" });
  });

  it("returns a coordination snapshot with no mission leaderboards, points or ranking aliases", async () => {
    const { organization, sessions } = await campaign({ admin: null });
    await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2), ($1, $2, 'coordinator', $2)", [organization, sessions.admin.user]);
    const mission = randomUUID();
    await client.query(`insert into public.organization_coordination_records (id, organization_id, kind, title, summary, status, visibility, config, created_by, idempotency_key)
      values ($1, $2, 'mission', 'Proof mission', '', 'active', 'members', '{}', $3, extensions.gen_random_uuid())`, [mission, organization, sessions.admin.user]);
    await client.query("set local session_replication_role = replica");
    await client.query(`insert into public.organization_coordination_user_participants (record_id, organization_id, user_id, role, status, points, privacy_alias)
      values ($1, $2, $3, 'participant', 'active', 42, 'Ranked Proof Alias')`, [mission, organization, sessions.admin.user]);
    await client.query("set local session_replication_role = origin");

    const ready = await as(sessions.admin.user, sessions.admin.session, "select public.get_organization_coordination_snapshot() as value");
    expect(ready.code, ready.message).toBeUndefined();
    expect(ready.value.state).toBe("ready");
    expect(ready.value.records.map((record) => record.id)).toContain(mission);
    expect(Object.keys(ready.value)).not.toContain("leaderboards");
    expect(JSON.stringify(ready.value)).not.toMatch(/Ranked Proof Alias|"points"|participantCount/);

    const loner = randomUUID();
    const lonerSession = randomUUID();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [loner, `loner-${loner}@example.invalid`]);
    await client.query("insert into auth.sessions (id, user_id, aal, created_at) values ($1, $2, 'aal2', now())", [lonerSession, loner]);
    const empty = await as(loner, lonerSession, "select public.get_organization_coordination_snapshot() as value");
    expect(empty.value?.state, empty.message).toBe("empty");
    expect(Object.keys(empty.value)).not.toContain("leaderboards");
  });
});
