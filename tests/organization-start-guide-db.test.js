// @vitest-environment node
// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029: the org-start
// guide's server read and writers on a live database. Only organization-wide
// role holders with MFA see it; each milestone follows the organization's real
// records; the administrator alone records the switch review; the backup and
// spokespeople are validated; the organization is latched live once all seven
// hold and never reopens; nothing crosses an organization boundary.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// Required proof (scripts/run-required-db-proofs.mjs): live whenever the
// owned disposable stack is named, rolled back afterwards.
const runLive = Boolean(process.env.SUPABASE_DB_URL);
const IDS = {
  orgA: "50913000-0000-4000-8000-000000000001",
  orgB: "50913000-0000-4000-8000-000000000002",
  adminA: "50913000-0000-4000-8000-000000000101",
  stewardA: "50913000-0000-4000-8000-000000000102",
  memberA: "50913000-0000-4000-8000-000000000103",
  adminB: "50913000-0000-4000-8000-000000000201",
};
const CHAPTER_A = "tamarack-org-start-guide-a";
const CHAPTER_B = "tamarack-org-start-guide-b";
const SESSIONS = Object.fromEntries(Object.entries(IDS)
  .filter(([key]) => !key.startsWith("org"))
  .map(([, userId], index) => [userId, `50913000-0000-4000-8000-0000009000${String(index + 10).padStart(2, "0")}`]));
const SWITCHES = [
  "features.guidance_onboarding.feature_guides",
  "features.guidance_onboarding.coach_marks",
  "features.guidance_onboarding.org_start_guide",
];

describe.skipIf(!runLive)("organization start guide live database behavior", () => {
  let client;

  async function callAs(userId, sql, values = []) {
    await client.query("savepoint org_start_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: SESSIONS[userId] }),
      ]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, values);
      await client.query("reset role");
      await client.query("release savepoint org_start_probe");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint org_start_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  async function guideFor(userId) {
    const result = await callAs(userId, "select public.get_organization_start_guide() result");
    expect(result.code, result.message).toBe("");
    return result.rows[0].result;
  }

  const checksOf = (guide) => Object.fromEntries(guide.milestones.flatMap((milestone) => milestone.checks.map((check) => [check.id, check])));

  // Fixture rows skip the tables' write triggers; a failure surfaces its own error.
  async function asFixture(sql, values = []) {
    await client.query("savepoint org_start_fixture");
    await client.query("set local session_replication_role = replica");
    try {
      await client.query(sql, values);
    } catch (error) {
      await client.query("rollback to savepoint org_start_fixture");
      throw error;
    } finally {
      await client.query("set local session_replication_role = origin");
    }
    await client.query("release savepoint org_start_fixture");
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false, application_name: "org-start-guide-test" });
    await client.connect();
    await client.query("begin");
    await client.query(
      `insert into auth.users (id, email) values
       ($1, 'org-start-admin-a@example.test'), ($2, 'org-start-steward-a@example.test'),
       ($3, 'org-start-member-a@example.test'), ($4, 'org-start-admin-b@example.test')`,
      [IDS.adminA, IDS.stewardA, IDS.memberA, IDS.adminB],
    );
    await client.query(
      `insert into public.organizations (id, slug, name, created_by) values
       ($1, 'org-start-a', 'Tamarack Valley Start A', $3), ($2, 'org-start-b', 'Tamarack Valley Start B', $4)`,
      [IDS.orgA, IDS.orgB, IDS.adminA, IDS.adminB],
    );
    await asFixture(
      `insert into public.chapters (id,name,slug,order_index,organization_id) values
       ($1,'Tamarack org-start A',$1,902,$3), ($2,'Tamarack org-start B',$2,902,$4)`,
      [CHAPTER_A, CHAPTER_B, IDS.orgA, IDS.orgB],
    );
    await client.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General'), ($2,'General') on conflict(chapter_id,name) do nothing", [CHAPTER_A, CHAPTER_B]);
    await client.query(
      `update public.member_profiles set chapter_id = fixture.chapter_id, full_name = fixture.full_name
       from (values ($1::uuid, $5::text, 'Stacy Paquette'::text), ($2::uuid, $5::text, 'Rafael Cintron'::text),
                    ($3::uuid, $5::text, 'Aaliyah Brooks'::text), ($4::uuid, $6::text, 'Blair Staff'::text)) fixture(id, chapter_id, full_name)
       where member_profiles.id = fixture.id`,
      [IDS.adminA, IDS.stewardA, IDS.memberA, IDS.adminB, CHAPTER_A, CHAPTER_B],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       values ($1,$5,'active',true,now()), ($2,$5,'active',true,now()), ($3,$5,'active',true,now()), ($4,$6,'active',true,now())
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [IDS.adminA, IDS.stewardA, IDS.memberA, IDS.adminB, CHAPTER_A, CHAPTER_B],
    );
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id) values ($1,$3),($1,$4),($1,$5),($2,$6)`,
      [IDS.orgA, IDS.orgB, IDS.adminA, IDS.stewardA, IDS.memberA, IDS.adminB],
    );
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role, granted_by, granted_at)
       values ($1,$3,'admin',$3, now() - interval '1 day'),($2,$4,'admin',$4, now() - interval '1 day')`,
      [IDS.orgA, IDS.orgB, IDS.adminA, IDS.adminB],
    );
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'org-start-a-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $2, 'org-start-steward-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $3, 'org-start-b-totp', 'totp', 'verified', now(), now())`,
      [IDS.adminA, IDS.stewardA, IDS.adminB],
    );
    await client.query(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal)
       select (value ->> 'sessionId')::uuid, (value ->> 'userId')::uuid, now(), now(), 'aal2'
       from pg_catalog.jsonb_array_elements($1::jsonb) value`,
      [JSON.stringify(Object.entries(SESSIONS).map(([userId, sessionId]) => ({ userId, sessionId })))],
    );
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("defines the three guidance switches member-visible, organization editable and on by default", async () => {
    const { rows } = await client.query(
      `select key, value_kind, default_value, category, member_visible, organization_editable
       from public.platform_setting_definitions where key = any($1::text[]) order by sort_order`,
      [SWITCHES],
    );
    expect(rows.map((row) => row.key)).toEqual(SWITCHES);
    for (const row of rows) {
      expect(row).toMatchObject({ value_kind: "boolean", default_value: true, category: "guidance_onboarding", member_visible: true, organization_editable: true });
    }
    const member = await callAs(IDS.memberA, "select public.get_member_organization_configuration() -> 'switches' switches");
    expect(member.code, member.message).toBe("");
    for (const key of SWITCHES) expect(member.rows[0].switches[key]).toBe(true);
  });

  it("hides the guide and every organization fact from a member without an organization-wide role", async () => {
    expect(await guideFor(IDS.memberA)).toEqual({ state: "hidden" });
    for (const sql of [
      "select public.mark_organization_start_switches_reviewed()",
      "select public.save_organization_start_contacts(null, '{}'::uuid[])",
      "select public.acknowledge_organization_start_celebration()",
    ]) {
      expect((await callAs(IDS.memberA, sql)).code).toBe("42501");
    }
    const direct = await callAs(IDS.memberA, "select * from private.organization_start_guide_state");
    expect(direct.code).toBe("42501");
  });

  // BUG-UG-ORG-START-GUIDE-COUNTS-FOUNDER-RECORDS-20261102 (#6795):
  // the founder's own invitation and starting chapter are not progress, as
  // on the admin launch checklist.
  it("starts a new organization with only its chapter in place and the founder counted as nobody brought in", async () => {
    await asFixture(
      `insert into public.member_invitations (normalized_email, full_name, first_name, initials, chapter_id, expires_at, token_hash, status, kind, sent_at)
       values ('org-start-admin-a@example.test', 'Stacy Paquette', 'Stacy', 'SP', $1, now() + interval '7 days', repeat('f', 64), 'pending', 'founder', now())`,
      [CHAPTER_A],
    );
    const guide = await guideFor(IDS.adminA);
    expect(guide).toMatchObject({ state: "active", organizationId: IDS.orgA, organizationName: "Tamarack Valley Start A", viewer: { isAdmin: true, canNameContacts: true }, adminName: "Stacy Paquette" });
    expect(guide.milestones.map((milestone) => milestone.id)).toEqual(["structure", "people", "onboarding", "content", "ballot", "support", "backups"]);
    const checks = checksOf(guide);
    expect(checks.chapters).toMatchObject({ done: false, count: 1, adminOnly: true });
    expect(checks.invitationsSent).toMatchObject({ done: false, count: 0 });
    expect(guide.milestones.find((milestone) => milestone.id === "structure").checks.every((check) => check.done)).toBe(false);
    expect(checks.worksites).toMatchObject({ done: false, count: 0 });
    expect(checks.staffGrants).toMatchObject({ done: false, count: 0 });
    for (const id of ["invitationsSent", "activeSteps", "switchesReviewed", "announcements", "events", "knowledgeItems", "ballotDraftWithSecrecy", "supportPrograms", "backupNamed", "spokespeople"]) {
      expect(checks[id].done, id).toBe(false);
    }
  });

  it("shares progress with another organization-wide role who cannot do administrator-only work", async () => {
    await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1,$2,'steward',$3)", [IDS.orgA, IDS.stewardA, IDS.adminA]);
    const steward = await guideFor(IDS.stewardA);
    expect(steward).toMatchObject({ state: "active", viewer: { isAdmin: false, canNameContacts: false } });
    expect(steward.members).toEqual([]);
    expect((await guideFor(IDS.adminA)).members.map((member) => member.name)).toEqual(["Aaliyah Brooks", "Rafael Cintron", "Stacy Paquette"]);
    expect(checksOf(steward).staffGrants).toMatchObject({ done: true, count: 1 });
    expect(checksOf(await guideFor(IDS.adminA)).staffGrants.done).toBe(true);
    expect((await callAs(IDS.stewardA, "select public.mark_organization_start_switches_reviewed()")).code).toBe("42501");
    expect((await callAs(IDS.stewardA, "select public.save_organization_start_contacts(null, '{}'::uuid[])")).code).toBe("42501");
  });

  it("records the switch review once for the administrator", async () => {
    const result = await callAs(IDS.adminA, "select public.mark_organization_start_switches_reviewed() result");
    expect(result.code, result.message).toBe("");
    expect(checksOf(result.rows[0].result).switchesReviewed.done).toBe(true);
    const first = await client.query("select switches_reviewed_at from private.organization_start_guide_state where organization_id = $1", [IDS.orgA]);
    await callAs(IDS.adminA, "select public.mark_organization_start_switches_reviewed()");
    const second = await client.query("select switches_reviewed_at from private.organization_start_guide_state where organization_id = $1", [IDS.orgA]);
    expect(second.rows[0].switches_reviewed_at).toEqual(first.rows[0].switches_reviewed_at);
  });

  it("refuses a backup without an organization-wide role and a spokesperson outside the organization", async () => {
    expect((await callAs(IDS.adminA, "select public.save_organization_start_contacts($1, '{}'::uuid[])", [IDS.memberA])).code).toBe("22023");
    expect((await callAs(IDS.adminA, "select public.save_organization_start_contacts(null, array[$1]::uuid[])", [IDS.adminB])).code).toBe("22023");
    const saved = await callAs(IDS.adminA, "select public.save_organization_start_contacts($1, array[$2, $2]::uuid[]) result", [IDS.stewardA, IDS.memberA]);
    expect(saved.code, saved.message).toBe("");
    expect(saved.rows[0].result.contacts).toEqual({ backupUserId: IDS.stewardA, spokespersonUserIds: [IDS.memberA] });
    expect(checksOf(saved.rows[0].result)).toMatchObject({ backupNamed: { done: true }, spokespeople: { done: true, count: 1 } });
  });

  it("never shows one organization's facts to another organization's administrator", async () => {
    const other = await guideFor(IDS.adminB);
    expect(other.organizationId).toBe(IDS.orgB);
    const checks = checksOf(other);
    expect(checks.switchesReviewed.done).toBe(false);
    expect(checks.backupNamed.done).toBe(false);
  });

  it("goes live once every milestone holds, celebrates once, and never reopens", async () => {
    await client.query(
      `insert into public.organization_setting_values (organization_id, setting_key, value)
       values ($1, 'lists.organizing.worksites', '["North Clinic"]'::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [IDS.orgA],
    );
    await asFixture(
      `insert into public.member_invitations (normalized_email, full_name, first_name, initials, chapter_id, expires_at, token_hash, status)
       values ('org-start-invite@example.test', 'Jordan Rivera', 'Jordan', 'JR', $1, now() + interval '7 days', repeat('a', 64), 'pending'),
              ('org-start-unsent@example.test', 'Riley Moss', 'Riley', 'RM', $2, now() + interval '7 days', repeat('b', 64), 'pending'),
              ('org-start-bounced@example.test', 'Casey Lane', 'Casey', 'CL', $2, now() + interval '7 days', null, 'delivery_failed')`,
      [CHAPTER_A, CHAPTER_B],
    );
    // Created but never delivered (no sent_at), or failed: not sent.
    expect(checksOf(await guideFor(IDS.adminB)).invitationsSent.done).toBe(false);
    expect(checksOf(await guideFor(IDS.adminA)).invitationsSent.done).toBe(false);
    await client.query("update public.member_invitations set sent_at = now() where normalized_email = 'org-start-invite@example.test'");
    // The founder's sent founder invitation is still not counted.
    expect(checksOf(await guideFor(IDS.adminA)).invitationsSent).toMatchObject({ done: true, count: 1 });
    // Worksites alone do not finish structure; a chapter besides the starting one does.
    expect(checksOf(await guideFor(IDS.adminA)).chapters).toMatchObject({ done: false, count: 1 });
    await asFixture(
      `insert into public.chapters (id,name,slug,order_index,organization_id) values ($1,'Tamarack org-start A second',$1,903,$2)`,
      [`${CHAPTER_A}-second`, IDS.orgA],
    );
    expect(checksOf(await guideFor(IDS.adminA)).chapters).toMatchObject({ done: true, count: 2 });
    await client.query(
      `insert into public.organization_onboarding_steps (id, organization_id, title, position, active)
       values (gen_random_uuid(), $1, 'Meet your steward', 10, true)`,
      [IDS.orgA],
    );
    await asFixture(
      `insert into public.member_broadcasts (id, sender, title, body, published_at, order_index, organization_id, chapter_id, audience_scope)
       values ('org-start-broadcast-a', 'Tamarack Valley', 'Welcome', 'Welcome to the chapter.', now(), 990001, $1, $2, 'organization')`,
      [IDS.orgA, CHAPTER_A],
    );
    await asFixture(
      `insert into public.member_events (id, title, starts_at, location, summary, check_in_code, order_index, chapter_id)
       values ('org-start-event-a', 'First meeting', now() + interval '3 days', 'North Clinic', 'Meet your stewards.', 'SG-ORG1', 990001, $1)`,
      [CHAPTER_A],
    );
    await asFixture(
      `insert into public.organization_knowledge_files (organization_id, title, file_name, byte_size, storage_path, review_status)
       values ($1, 'Contract summary', 'contract-summary.pdf', 1024, 'org-start/contract-summary.pdf', 'quarantined'),
              ($1, 'Grievance guide', 'grievance-guide.pdf', 2048, 'org-start/grievance-guide.pdf', 'approved')`,
      [IDS.orgA],
    );
    await asFixture(
      `insert into public.member_ballots (id, title, closes_at, order_index, organization_id, campaign_state, active)
       values ('org-start-ballot-a', 'Ratify the side letter', now() + interval '14 days', 990001, $1, 'draft', false)`,
      [IDS.orgA],
    );
    // Every milestone but one: still active.
    const almost = await guideFor(IDS.adminA);
    expect(almost.state).toBe("active");
    expect(checksOf(almost).supportPrograms.done).toBe(false);
    await client.query(
      `insert into public.organization_hr_directory (organization_id, name, title) values ($1, 'Dana Ortiz', 'Member support lead')`,
      [IDS.orgA],
    );
    expect(await guideFor(IDS.stewardA)).toMatchObject({ state: "live", organizationName: "Tamarack Valley Start A" });
    // A fact that later becomes untrue never reopens the guide.
    await client.query("delete from public.organization_hr_directory where organization_id = $1", [IDS.orgA]);
    expect((await guideFor(IDS.adminA)).state).toBe("live");
    const done = await callAs(IDS.stewardA, "select public.acknowledge_organization_start_celebration() result");
    expect(done.code, done.message).toBe("");
    expect(done.rows[0].result).toMatchObject({ state: "done" });
    expect((await guideFor(IDS.adminA)).state).toBe("done");
    // Organization B is untouched.
    expect((await guideFor(IDS.adminB)).state).toBe("active");
  });

  it("answers off when the organization turns the guide off", async () => {
    await client.query(
      `insert into public.organization_setting_values (organization_id, setting_key, value)
       values ($1, 'features.guidance_onboarding.org_start_guide', 'false'::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [IDS.orgB],
    );
    expect(await guideFor(IDS.adminB)).toEqual({ state: "off", organizationId: IDS.orgB });
  });
});

// BUG-UG-START-GUIDE-READ-TAKES-LIFECYCLE-GATE-20261107 (#7366): the
// read took the global lifecycle gate on every desk load, so it failed with
// 55P03 at the gate's forced 3 s lock_timeout while another transaction held
// the gate. Reads now return without the gate; only the one-time latch waits.
// The suite above holds the gate for its whole transaction through its
// fixtures' write triggers, so this one runs after it on its own sessions,
// with fixture rows written without triggers.
describe.skipIf(!runLive)("organization start guide beside a held lifecycle gate", () => {
  const GATE = {
    org: "50913100-0000-4000-8000-000000000001",
    admin: "50913100-0000-4000-8000-000000000101",
    steward: "50913100-0000-4000-8000-000000000102",
    outsider: "50913100-0000-4000-8000-000000000103",
  };
  const GATE_SESSIONS = {
    [GATE.admin]: "50913100-0000-4000-8000-000000000901",
    [GATE.steward]: "50913100-0000-4000-8000-000000000902",
    [GATE.outsider]: "50913100-0000-4000-8000-000000000903",
  };
  const GATE_CHAPTER = "tamarack-org-start-gate-a";
  let reader;
  let holder;

  const connect = async (name) => {
    const c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: name });
    await c.connect();
    return c;
  };

  async function triggerless(statements) {
    await reader.query("set local session_replication_role = replica");
    try {
      for (const [sql, values = []] of statements) await reader.query(sql, values);
    } finally {
      await reader.query("set local session_replication_role = origin");
    }
  }

  // The probe keeps the default lock_timeout, so the gate forces its 3 s wait.
  async function guideWhileHeld(userId) {
    await reader.query("savepoint org_start_gate_probe");
    try {
      await reader.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: GATE_SESSIONS[userId] }),
      ]);
      await reader.query("set local role authenticated");
      const { rows } = await reader.query("select public.get_organization_start_guide() result");
      return { code: "", guide: rows[0].result };
    } catch (error) {
      return { code: error.code || "?", message: error.message || "" };
    } finally {
      await reader.query("rollback to savepoint org_start_gate_probe");
      await reader.query("release savepoint org_start_gate_probe");
    }
  }

  beforeAll(async () => {
    reader = await connect("org-start-guide-gate-reader");
    holder = await connect("org-start-guide-gate-holder");
    await reader.query("begin");
    await reader.query("set local statement_timeout = '20s'");
    await triggerless([
      [`insert into auth.users (id, email) values ($1, 'org-start-gate-admin@example.test'), ($2, 'org-start-gate-steward@example.test'), ($3, 'org-start-gate-outsider@example.test')`, [GATE.admin, GATE.steward, GATE.outsider]],
      [`insert into public.organizations (id, slug, name, created_by) values ($1, 'org-start-gate', 'Tamarack Valley Gate', $2)`, [GATE.org, GATE.admin]],
      [`insert into public.chapters (id,name,slug,order_index,organization_id) values ($1,'Tamarack org-start gate',$1,904,$2)`, [GATE_CHAPTER, GATE.org]],
      [`insert into public.organization_memberships (organization_id, user_id) values ($1,$2),($1,$3)`, [GATE.org, GATE.admin, GATE.steward]],
      [`insert into public.organization_role_grants (organization_id, user_id, role, granted_by, granted_at)
        values ($1,$2,'admin',$2, now() - interval '1 day'), ($1,$3,'steward',$2, now())`, [GATE.org, GATE.admin, GATE.steward]],
      [`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
        values (gen_random_uuid(), $1, 'org-start-gate-admin-totp', 'totp', 'verified', now(), now()),
               (gen_random_uuid(), $2, 'org-start-gate-steward-totp', 'totp', 'verified', now(), now())`, [GATE.admin, GATE.steward]],
      [`insert into auth.sessions (id, user_id, created_at, updated_at, aal)
        select (value ->> 'sessionId')::uuid, (value ->> 'userId')::uuid, now(), now(), 'aal2'
        from pg_catalog.jsonb_array_elements($1::jsonb) value`,
      [JSON.stringify(Object.entries(GATE_SESSIONS).map(([userId, sessionId]) => ({ userId, sessionId })))]],
    ]);
  }, 30_000);

  afterAll(async () => {
    await holder?.query("rollback").catch(() => {});
    await holder?.end();
    if (!reader) return;
    await reader.query("rollback");
    await reader.end();
  });

  it("answers every read while another session holds the gate and waits only to latch live", async () => {
    await holder.query("begin");
    await holder.query("select private.lock_case_graph(array[]::uuid[], array[]::uuid[])");

    // In progress, hidden and celebrated reads take no gate.
    const active = await guideWhileHeld(GATE.admin);
    expect(active.code, active.message).toBe("");
    expect(active.guide).toMatchObject({ state: "active", organizationId: GATE.org, viewer: { isAdmin: true } });
    const steward = await guideWhileHeld(GATE.steward);
    expect(steward.code, steward.message).toBe("");
    expect(steward.guide).toMatchObject({ state: "active", viewer: { isAdmin: false } });
    expect(await guideWhileHeld(GATE.outsider)).toEqual({ code: "", guide: { state: "hidden" } });
    await reader.query("savepoint org_start_celebrated");
    await triggerless([[`insert into private.organization_start_guide_state (organization_id, live_at, celebrated_at) values ($1, now(), now())`, [GATE.org]]]);
    expect((await guideWhileHeld(GATE.steward)).guide).toMatchObject({ state: "done", organizationId: GATE.org });
    await reader.query("rollback to savepoint org_start_celebrated");
    await reader.query("release savepoint org_start_celebrated");

    // Every milestone holding and not live yet: the one-time latch waits for the gate.
    await triggerless([
      [`insert into public.chapters (id,name,slug,order_index,organization_id) values ($1,'Tamarack org-start gate second',$1,905,$2)`, [`${GATE_CHAPTER}-second`, GATE.org]],
      [`insert into public.organization_setting_values (organization_id, setting_key, value) values ($1, 'lists.organizing.worksites', '["North Clinic"]'::jsonb)`, [GATE.org]],
      [`insert into public.member_invitations (normalized_email, full_name, first_name, initials, chapter_id, expires_at, token_hash, status, sent_at)
        values ('org-start-gate-invite@example.test', 'Jordan Rivera', 'Jordan', 'JR', $1, now() + interval '7 days', repeat('c', 64), 'pending', now())`, [GATE_CHAPTER]],
      [`insert into public.organization_onboarding_steps (id, organization_id, title, position, active) values (gen_random_uuid(), $1, 'Meet your steward', 10, true)`, [GATE.org]],
      [`insert into private.organization_start_guide_state (organization_id, switches_reviewed_at, backup_user_id, contacts_saved_at) values ($1, now(), $2, now())`, [GATE.org, GATE.steward]],
      [`insert into private.organization_start_spokespeople (organization_id, user_id) values ($1, $2)`, [GATE.org, GATE.steward]],
      [`insert into public.member_broadcasts (id, sender, title, body, published_at, order_index, organization_id, chapter_id, audience_scope)
        values ('org-start-gate-broadcast', 'Tamarack Valley', 'Welcome', 'Welcome to the chapter.', now(), 990011, $1, $2, 'organization')`, [GATE.org, GATE_CHAPTER]],
      [`insert into public.member_events (id, title, starts_at, location, summary, check_in_code, order_index, chapter_id)
        values ('org-start-gate-event', 'First meeting', now() + interval '3 days', 'North Clinic', 'Meet your stewards.', 'SG-GATE1', 990011, $1)`, [GATE_CHAPTER]],
      [`insert into public.organization_knowledge_files (organization_id, title, file_name, byte_size, storage_path, review_status)
        values ($1, 'Grievance guide', 'grievance-guide.pdf', 2048, 'org-start-gate/grievance-guide.pdf', 'approved')`, [GATE.org]],
      [`insert into public.member_ballots (id, title, closes_at, order_index, organization_id, campaign_state, active)
        values ('org-start-gate-ballot', 'Ratify the side letter', now() + interval '14 days', 990011, $1, 'draft', false)`, [GATE.org]],
      [`insert into public.organization_hr_directory (organization_id, name, title) values ($1, 'Dana Ortiz', 'Member support lead')`, [GATE.org]],
    ]);
    const started = Date.now();
    const latch = await guideWhileHeld(GATE.admin);
    expect(latch.code, latch.message).toBe("55P03");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);

    await holder.query("rollback");
    const live = await guideWhileHeld(GATE.admin);
    expect(live.code, live.message).toBe("");
    expect(live.guide).toMatchObject({ state: "live", organizationId: GATE.org, organizationName: "Tamarack Valley Gate" });
  }, 30_000);
});
