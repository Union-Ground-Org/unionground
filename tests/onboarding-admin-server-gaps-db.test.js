// @vitest-environment node
// REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104 (#7013): the admin
// onboarding desk's three server pieces. By-chapter counts behind a privacy
// floor of at least 25 (a chapter at 24 and at 25, and a small chapter that
// cannot be recovered by subtraction); one reminder per member per day to a
// stalled member, refused for an opted-out member and for callers outside
// onboarding staff; and a required reason on every skip.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Required proof (scripts/run-required-db-proofs.mjs): live whenever the owned
// disposable stack is named, rolled back afterwards.
const runLive = Boolean(process.env.SUPABASE_DB_URL);
const PREFIX = "50913013-0000-4000-8000-";
const id = (n) => `${PREFIX}${String(n).padStart(12, "0")}`;
const IDS = {
  orgA: id(1),
  orgB: id(2),
  staffA: id(101),
  memberA: id(102),
  optedOutA: id(103),
  freshA: id(104),
  staffB: id(201),
};
// Plan holders for the chapter counts: 24 in the big chapter, 3 in the small one.
const BIG = Array.from({ length: 25 }, (_, index) => id(1000 + index));
const SMALL = Array.from({ length: 3 }, (_, index) => id(2000 + index));
const STEPS = [id(501), id(502), id(503), id(504)];
const CHAPTERS = { big: "tamarack-onboarding-gaps-big", small: "tamarack-onboarding-gaps-small", b: "tamarack-onboarding-gaps-b" };
const FLOOR_KEY = "limits.analytics.anonymity_floor";
const SESSIONS = Object.fromEntries(Object.entries(IDS)
  .filter(([key]) => !key.startsWith("org"))
  .map(([, userId], index) => [userId, id(900000 + index)]));

describe.skipIf(!runLive)("onboarding admin server gaps live database behavior", () => {
  let client;

  async function callAs(userId, sql, values = []) {
    await client.query("savepoint onboarding_gaps_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: SESSIONS[userId] }),
      ]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, values);
      await client.query("reset role");
      await client.query("release savepoint onboarding_gaps_probe");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint onboarding_gaps_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  async function oversight(userId = IDS.staffA) {
    const result = await callAs(userId, "select public.get_member_onboarding_oversight() result");
    expect(result.code, result.message).toBe("");
    return result.rows[0].result;
  }

  async function addPlans(userIds, chapterId, { stalled = false } = {}) {
    await client.query(
      `insert into auth.users (id, email) select user_id, 'onboarding-gaps-' || user_id || '@example.test' from unnest($1::uuid[]) user_id`,
      [userIds],
    );
    await client.query("update public.member_profiles set chapter_id = $2 where id = any($1::uuid[])", [userIds, chapterId]);
    await client.query(
      `insert into public.member_onboarding_plans (id, organization_id, member_user_id, assigned_by, status, created_at)
       select gen_random_uuid(), $1, user_id, $3, 'not_started', now() - make_interval(days => $4)
       from unnest($2::uuid[]) user_id`,
      [IDS.orgA, userIds, IDS.staffA, stalled ? 20 : 1],
    );
  }

  async function planFor(userId) {
    const { rows } = await client.query(
      "select * from public.member_onboarding_plans where organization_id = $1 and member_user_id = $2",
      [IDS.orgA, userId],
    );
    return rows[0] ?? null;
  }

  const remind = (userId, planId, key = crypto.randomUUID()) =>
    callAs(userId, "select public.send_member_onboarding_reminder($1, $2) result", [planId, key]);

  const staffChange = (userId, planId, action, stepId, reason) => callAs(
    userId,
    "select public.staff_update_member_onboarding_plan($1, $2, $3, $4, $5) result",
    [planId, action, stepId, crypto.randomUUID(), reason],
  );

  async function reminderRows(userId) {
    const { rows } = await client.query(
      `select (select count(*) from public.member_notifications where user_id = $1)::int notifications,
              (select count(*) from public.organization_audit_ledger
                where organization_id = $2 and event_type = 'onboarding_reminder_sent' and entity_id = $1::text)::int ledger`,
      [userId, IDS.orgA],
    );
    return rows[0];
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false, application_name: "onboarding-admin-server-gaps-test" });
    await client.connect();
    await client.query("begin");
    await client.query(
      `insert into auth.users (id, email) select user_id, 'onboarding-gaps-' || ordinality || '@example.test'
       from unnest($1::uuid[]) with ordinality user_id`,
      [Object.entries(IDS).filter(([key]) => !key.startsWith("org")).map(([, userId]) => userId)],
    );
    // Isolate the onboarding notices from this edition's account welcome.
    await client.query(
      "delete from public.member_notifications where user_id = any($1::uuid[]) and kind = 'general' and title = 'Welcome to your private organizing workspace'",
      [Object.entries(IDS).filter(([key]) => !key.startsWith("org")).map(([, userId]) => userId)],
    );
    await client.query(
      `insert into public.organizations (id, slug, name, created_by) values
       ($1, 'onboarding-gaps-org-a', 'Onboarding Gaps Org A', $3), ($2, 'onboarding-gaps-org-b', 'Onboarding Gaps Org B', $4)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.staffB],
    );
    await client.query("set local session_replication_role = replica");
    await client.query(
      `insert into public.chapters (id, name, slug, order_index, organization_id) values
       ($1, 'Tamarack onboarding gaps big', $1, 901, $4), ($2, 'Tamarack onboarding gaps small', $2, 902, $4), ($3, 'Tamarack onboarding gaps B', $3, 903, $5)`,
      [CHAPTERS.big, CHAPTERS.small, CHAPTERS.b, IDS.orgA, IDS.orgB],
    );
    await client.query(
      "insert into public.chapter_workstreams (chapter_id, name) values ($1, 'General'), ($2, 'General'), ($3, 'General') on conflict (chapter_id, name) do nothing",
      [CHAPTERS.big, CHAPTERS.small, CHAPTERS.b],
    );
    await client.query("set local session_replication_role = origin");
    await client.query(
      `update public.member_profiles set chapter_id = fixture.chapter_id, full_name = fixture.full_name
       from (values ($1::uuid, $6::text, 'Alex Staff'::text), ($2::uuid, $6::text, 'Morgan Member'::text),
                    ($3::uuid, $6::text, 'Riley Quiet'::text), ($4::uuid, $6::text, 'Casey New'::text),
                    ($5::uuid, $7::text, 'Blair Staff'::text)) fixture(id, chapter_id, full_name)
       where member_profiles.id = fixture.id`,
      [IDS.staffA, IDS.memberA, IDS.optedOutA, IDS.freshA, IDS.staffB, CHAPTERS.big, CHAPTERS.b],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       select fixture.user_id, fixture.chapter_id, 'active', true, now()
       from (values ($1::uuid, $6::text), ($2::uuid, $6::text), ($3::uuid, $6::text), ($4::uuid, $6::text), ($5::uuid, $7::text)) fixture(user_id, chapter_id)
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [IDS.staffA, IDS.memberA, IDS.optedOutA, IDS.freshA, IDS.staffB, CHAPTERS.big, CHAPTERS.b],
    );
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'gaps-a-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $2, 'gaps-b-totp', 'totp', 'verified', now(), now())`,
      [IDS.staffA, IDS.staffB],
    );
    await client.query(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal)
       select (value ->> 'sessionId')::uuid, (value ->> 'userId')::uuid, now(), now(), 'aal2'
       from pg_catalog.jsonb_array_elements($1::jsonb) value`,
      [JSON.stringify(Object.entries(SESSIONS).map(([userId, sessionId]) => ({ userId, sessionId })))],
    );
    // Memberships first, while organization A has no active step, so
    // automatic enrollment assigns nobody; plans below are written directly.
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id)
       values ($1,$3),($1,$4),($1,$5),($1,$6),($2,$7)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.memberA, IDS.optedOutA, IDS.freshA, IDS.staffB],
    );
    await client.query(
      `insert into public.organization_onboarding_steps (id, organization_id, title, position, active)
       select step_id, $1, 'Step ' || ordinality, ordinality::integer * 10, true
       from unnest($2::uuid[]) with ordinality step_id`,
      [IDS.orgA, STEPS],
    );
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
       values ($1,$3,'admin',$3),($1,$3,'steward',$3),($2,$4,'admin',$4),($2,$4,'steward',$4)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.staffB],
    );
    // Three roster members in the big chapter: two stalled, one assigned yesterday.
    await client.query(
      `insert into public.member_onboarding_plans (id, organization_id, member_user_id, assigned_by, status, completed_step_ids, started_at, created_at)
       values (gen_random_uuid(), $1, $2, $5, 'in_progress', $6::uuid[], now() - interval '20 days', now() - interval '20 days'),
              (gen_random_uuid(), $1, $3, $5, 'not_started', '{}', null, now() - interval '20 days'),
              (gen_random_uuid(), $1, $4, $5, 'not_started', '{}', null, now() - interval '1 day')`,
      [IDS.orgA, IDS.memberA, IDS.optedOutA, IDS.freshA, IDS.staffA, [STEPS[0]]],
    );
    await client.query(
      "update public.member_profiles set notification_prefs = notification_prefs || '{\"onboarding\": false}'::jsonb where id = $1",
      [IDS.optedOutA],
    );
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("withholds a chapter at 24 plans and shows it at 25", async () => {
    // Three roster plans are already in the big chapter; 21 more make 24.
    await addPlans(BIG.slice(0, 21), CHAPTERS.big);
    let summary = (await oversight()).chapterSummary;
    expect(summary).toMatchObject({ floor: 25, withheld: true, chapters: [], otherChapters: null });
    expect(JSON.stringify(summary)).not.toContain("24");

    await addPlans(BIG.slice(21, 22), CHAPTERS.big);
    summary = (await oversight()).chapterSummary;
    expect(summary).toMatchObject({ floor: 25, withheld: false, otherChapters: null, withheldChapters: 0 });
    expect(summary.chapters).toEqual([{
      chapterId: CHAPTERS.big,
      name: "Tamarack onboarding gaps big",
      enrolled: 25,
      notStarted: 24,
      inProgress: 1,
      completed: 0,
      stalled: 2,
    }]);
  });

  it("pools a small chapter with the smallest shown one so its count cannot be subtracted out", async () => {
    await addPlans(SMALL, CHAPTERS.small);
    const roster = await oversight();
    expect(roster.memberCount).toBe(28);
    // 3 alone would be recoverable as 28 - 25, so the big chapter joins the pool.
    expect(roster.chapterSummary).toMatchObject({
      withheld: false,
      chapters: [],
      otherChapters: { enrolled: 28 },
      withheldChapters: 2,
    });
    expect(roster.members.every((row) => !("chapterId" in row))).toBe(true);
    await client.query("delete from public.member_onboarding_plans where organization_id = $1 and member_user_id = any($2::uuid[])", [IDS.orgA, SMALL]);
  });

  it("uses a higher organization floor and never a floor under 25", async () => {
    await client.query(
      `insert into public.organization_setting_values (organization_id, setting_key, value) values ($1, $2, '30'::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [IDS.orgA, FLOOR_KEY],
    );
    expect((await oversight()).chapterSummary).toMatchObject({ floor: 30, withheld: true, chapters: [] });
    // Organizations could once store 10; the server-side floor work may now
    // refuse that value outright. Either way the summary never uses it.
    await client.query("savepoint low_floor");
    try {
      await client.query("update public.organization_setting_values set value = '10'::jsonb where organization_id = $1 and setting_key = $2", [IDS.orgA, FLOOR_KEY]);
      await client.query("release savepoint low_floor");
    } catch {
      await client.query("rollback to savepoint low_floor");
      await client.query("delete from public.organization_setting_values where organization_id = $1 and setting_key = $2", [IDS.orgA, FLOOR_KEY]);
    }
    const summary = (await oversight()).chapterSummary;
    expect(summary.floor).toBe(25);
    expect(summary.chapters.map((row) => row.enrolled)).toEqual([25]);
    await client.query("delete from public.organization_setting_values where organization_id = $1 and setting_key = $2", [IDS.orgA, FLOOR_KEY]);
  });

  it("sends one reminder to a stalled member, notifies in the member's organization and audits it", async () => {
    const plan = await planFor(IDS.memberA);
    const before = await reminderRows(IDS.memberA);
    const key = crypto.randomUUID();
    const sent = await remind(IDS.staffA, plan.id, key);
    expect(sent.code, sent.message).toBe("");
    expect(sent.rows[0].result).toMatchObject({ planId: plan.id, memberUserId: IDS.memberA });
    expect(await reminderRows(IDS.memberA)).toEqual({ notifications: before.notifications + 1, ledger: before.ledger + 1 });
    const { rows: [notice] } = await client.query(
      "select title, body, kind, organization_id from public.member_notifications where user_id = $1 order by created_at desc limit 1",
      [IDS.memberA],
    );
    expect(notice).toEqual({
      title: "Your onboarding checklist is waiting",
      body: "You have 3 onboarding steps left. Open Union Ground to pick up where you left off.",
      kind: "general",
      organization_id: IDS.orgA,
    });
    const { rows: [audit] } = await client.query(
      `select domain, action, actor_user_id, entity_type, metadata from public.organization_audit_ledger
       where organization_id = $1 and event_type = 'onboarding_reminder_sent' and entity_id = $2`,
      [IDS.orgA, IDS.memberA],
    );
    expect(audit).toEqual({ domain: "communications", action: "send", actor_user_id: IDS.staffA, entity_type: "member", metadata: { userId: IDS.memberA, entityId: plan.id, count: 3 } });

    // A retry with the same key returns the first answer and sends nothing new.
    const replay = await remind(IDS.staffA, plan.id, key);
    expect(replay.rows[0].result).toEqual(sent.rows[0].result);
    expect(await reminderRows(IDS.memberA)).toEqual({ notifications: before.notifications + 1, ledger: before.ledger + 1 });
    const row = (await oversight()).members.find((item) => item.memberUserId === IDS.memberA);
    expect(row.reminderSentAt).not.toBeNull();
    expect(row.reminderOptedOut).toBe(false);
  });

  it("rate-limits a second reminder for the same member inside 24 hours and allows one after", async () => {
    const plan = await planFor(IDS.memberA);
    const before = await reminderRows(IDS.memberA);
    const again = await remind(IDS.staffA, plan.id);
    expect(again.code, again.message).toBe("54000");
    expect(await reminderRows(IDS.memberA)).toEqual(before);
    // The ledger is append-only, so age the window by moving the clock check:
    // a reminder older than 24 hours no longer counts.
    await client.query("savepoint aged_window");
    await client.query("set local session_replication_role = replica");
    await client.query(
      "update public.organization_audit_ledger set occurred_at = now() - interval '25 hours' where organization_id = $1 and event_type = 'onboarding_reminder_sent' and entity_id = $2",
      [IDS.orgA, IDS.memberA],
    );
    await client.query("set local session_replication_role = origin");
    const later = await remind(IDS.staffA, plan.id);
    expect(later.code, later.message).toBe("");
    await client.query("rollback to savepoint aged_window");
  });

  it("refuses an opted-out member and a member who is not stalled", async () => {
    const quiet = await planFor(IDS.optedOutA);
    const before = await reminderRows(IDS.optedOutA);
    const refused = await remind(IDS.staffA, quiet.id);
    expect(refused.code, refused.message).toBe("55000");
    expect(await reminderRows(IDS.optedOutA)).toEqual(before);
    expect((await oversight()).members.find((row) => row.memberUserId === IDS.optedOutA).reminderOptedOut).toBe(true);
    expect((await remind(IDS.staffA, (await planFor(IDS.freshA)).id)).code).toBe("22023");
  });

  it("refuses callers outside the organization's onboarding staff", async () => {
    const plan = await planFor(IDS.memberA);
    expect((await remind(IDS.memberA, plan.id)).code).toBe("42501");
    expect((await remind(IDS.staffB, plan.id)).code).toBe("22023");
    const { rows } = await client.query(
      `select has_function_privilege('anon', 'public.send_member_onboarding_reminder(uuid,uuid)', 'EXECUTE') anon_remind,
              has_function_privilege('anon', 'public.staff_update_member_onboarding_plan(uuid,text,uuid,uuid,text)', 'EXECUTE') anon_update,
              has_function_privilege('authenticated', 'private.member_onboarding_chapter_summary(uuid,integer,boolean,integer,integer,integer)', 'EXECUTE') summary,
              to_regprocedure('public.staff_update_member_onboarding_plan(uuid,text,uuid,uuid)') is null old_signature_gone,
              has_table_privilege('authenticated', 'private.member_onboarding_skip_reasons', 'SELECT') skip_select`,
    );
    expect(rows[0]).toEqual({ anon_remind: false, anon_update: false, summary: false, old_signature_gone: true, skip_select: false });
  });

  it("refuses a skip without a reason and shows a given reason read-only until a reset", async () => {
    const plan = await planFor(IDS.memberA);
    // Every whitespace character counts as blank, not only spaces.
    for (const reason of [null, "", "   ", "\t", "\n\r\n", " \t\u00a0\u3000 ", "x".repeat(501)]) {
      const refused = await staffChange(IDS.staffA, plan.id, "skip", STEPS[2], reason);
      expect(refused.code, String(reason)).toBe("22023");
    }
    expect((await planFor(IDS.memberA)).completed_step_ids).toEqual([STEPS[0]]);

    const skipped = await staffChange(IDS.staffA, plan.id, "skip", STEPS[2], "\n\t Already trained on this at orientation.\u00a0\n");
    expect(skipped.code, skipped.message).toBe("");
    // The table refuses untrimmed or whitespace-only text from any writer.
    for (const reason of ["\t", "\nLeading newline", "Trailing tab\t"]) {
      await client.query("savepoint skip_reason_check");
      const refused = await client.query("update private.member_onboarding_skip_reasons set reason = $2 where plan_id = $1", [plan.id, reason]).then(() => null, (error) => error.code);
      await client.query("rollback to savepoint skip_reason_check");
      expect(refused, JSON.stringify(reason)).toBe("23514");
    }
    const row = (await oversight()).members.find((item) => item.memberUserId === IDS.memberA);
    expect(row.skippedSteps).toEqual([{ stepId: STEPS[2], reason: "Already trained on this at orientation.", skippedAt: expect.any(String) }]);
    // A complete needs no reason; a four-argument call still resolves.
    const completed = await callAs(IDS.staffA, "select public.staff_update_member_onboarding_plan($1, 'complete', $2, $3) result", [plan.id, STEPS[1], crypto.randomUUID()]);
    expect(completed.code, completed.message).toBe("");

    expect((await staffChange(IDS.staffA, plan.id, "reset", null, null)).code).toBe("");
    const { rows } = await client.query("select count(*)::int n from private.member_onboarding_skip_reasons where plan_id = $1", [plan.id]);
    expect(rows[0].n).toBe(0);
    expect((await oversight()).members.find((item) => item.memberUserId === IDS.memberA).skippedSteps).toEqual([]);
  });

  it("keeps a stored onboarding opt-out when a writer replaces the preferences without it", async () => {
    await client.query(
      `update public.member_profiles set notification_prefs = '{"deadlines": true, "cases": true, "forms": true, "votes": true, "events": true}'::jsonb where id = $1`,
      [IDS.optedOutA],
    );
    const { rows } = await client.query("select notification_prefs -> 'onboarding' onboarding from public.member_profiles where id = $1", [IDS.optedOutA]);
    expect(rows[0].onboarding).toBe(false);
  });
});
