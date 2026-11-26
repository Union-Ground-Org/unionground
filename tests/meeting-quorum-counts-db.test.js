// @vitest-environment node
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// REQ-UG-MEETING-QUORUM-COUNTS-20261030 (#6629). Only a live apply
// proves 20261030224500: staff who may manage events set a meeting's quorum in
// their own chapter only, with two-step sign-in, and every change is audited;
// get_member_event_quorum returns the quorum and the checked-in count, and
// nothing else, for exactly the meetings member_events RLS lets the caller
// see. Every case runs in one transaction and rolls back.
const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const ids = Object.freeze({
  admin: "0d662900-0000-4000-8000-000000000001",
  memberA: "0d662900-0000-4000-8000-000000000002",
  steward: "0d662900-0000-4000-8000-000000000003",
  otherAdmin: "0d662900-0000-4000-8000-000000000004",
  outsider: "0d662900-0000-4000-8000-000000000005",
  memberFar: "0d662900-0000-4000-8000-000000000006",
  adminSession: "0d662900-0000-4000-8000-000000000011",
  memberASession: "0d662900-0000-4000-8000-000000000012",
  stewardSession: "0d662900-0000-4000-8000-000000000013",
  otherAdminSession: "0d662900-0000-4000-8000-000000000014",
  outsiderSession: "0d662900-0000-4000-8000-000000000015",
  memberFarSession: "0d662900-0000-4000-8000-000000000016",
  org: "0d662900-0000-4000-8000-000000000101",
  otherOrg: "0d662900-0000-4000-8000-000000000102",
});
const CHAPTER = "quorum-proof-a1";
const NEIGHBOUR = "quorum-proof-b1";
const FAR = "quorum-proof-c1";
const OUTSIDE = "quorum-proof-x1";
const HOME_MEETING = "quorum-home-meeting";
const NEIGHBOUR_PUBLIC = "quorum-neighbour-public";
const NEIGHBOUR_PRIVATE = "quorum-neighbour-private";
const FAR_ACROSS = "quorum-far-across";
const FAR_PUBLIC = "quorum-far-public";
const OUTSIDE_ACROSS = "quorum-outside-across";
const HOME_DEADLINE = "quorum-home-deadline";
const MEETINGS = [HOME_MEETING, NEIGHBOUR_PUBLIC, NEIGHBOUR_PRIVATE, FAR_ACROSS, FAR_PUBLIC, OUTSIDE_ACROSS];

async function connect(applicationName) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: applicationName,
  });
  await client.connect();
  return client;
}

async function as(client, userId, sessionId, aal) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, session_id: sessionId, role: "authenticated", aal })]);
  await client.query("set local role authenticated");
}

const admin = (client, aal = "aal2") => as(client, ids.admin, ids.adminSession, aal);
const memberA = (client) => as(client, ids.memberA, ids.memberASession, "aal1");
const steward = (client) => as(client, ids.steward, ids.stewardSession, "aal2");
const otherAdmin = (client) => as(client, ids.otherAdmin, ids.otherAdminSession, "aal2");
const outsider = (client) => as(client, ids.outsider, ids.outsiderSession, "aal1");
const memberFar = (client) => as(client, ids.memberFar, ids.memberFarSession, "aal1");

async function provision(client) {
  const users = [ids.admin, ids.memberA, ids.steward, ids.otherAdmin, ids.outsider, ids.memberFar];
  const sessions = [ids.adminSession, ids.memberASession, ids.stewardSession, ids.otherAdminSession, ids.outsiderSession, ids.memberFarSession];
  await client.query(`
    insert into auth.users (id, email, raw_user_meta_data)
    select u, 'quorum-proof-' || u || '@example.invalid', '{}'::jsonb from unnest($1::uuid[]) u
  `, [users]);
  await client.query(`
    insert into public.organizations (id, slug, name, created_by) values
      ($1, 'quorum-proof-org', 'Quorum proof organization', $3),
      ($2, 'quorum-proof-other', 'Quorum proof other organization', $4)
  `, [ids.org, ids.otherOrg, ids.admin, ids.outsider]);
  // A1 and B1 share a region; C1 is in another region of the same
  // organization; X1 belongs to another organization in A1's region.
  await client.query(`
    insert into public.chapters (id, name, slug, region, is_default, order_index, organization_id) values
      ($1, 'Quorum proof A1', $1, 'quorum-proof-region', false, 9661, $5),
      ($2, 'Quorum proof B1', $2, 'quorum-proof-region', false, 9662, $5),
      ($3, 'Quorum proof C1', $3, 'quorum-proof-far-region', false, 9663, $5),
      ($4, 'Quorum proof X1', $4, 'quorum-proof-region', false, 9664, $6)
  `, [CHAPTER, NEIGHBOUR, FAR, OUTSIDE, ids.org, ids.otherOrg]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status) values
      ($1, $3, 'active'), ($1, $4, 'active'), ($1, $5, 'active'), ($1, $6, 'active'), ($2, $7, 'active'), ($1, $8, 'active')
  `, [ids.org, ids.otherOrg, ids.admin, ids.memberA, ids.steward, ids.otherAdmin, ids.outsider, ids.memberFar]);
  const homes = [[ids.admin, CHAPTER], [ids.memberA, CHAPTER], [ids.steward, CHAPTER], [ids.otherAdmin, NEIGHBOUR], [ids.outsider, OUTSIDE], [ids.memberFar, FAR]];
  for (const [user, chapter] of homes) {
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [user, chapter]);
    await client.query("update public.member_profiles set chapter_id = $2, full_name = coalesce(nullif(full_name, ''), 'Quorum proof member') where id = $1", [user, chapter]);
  }
  for (const [user, role, chapter] of [[ids.admin, "admin", CHAPTER], [ids.otherAdmin, "admin", NEIGHBOUR], [ids.steward, "steward", CHAPTER]]) {
    await client.query("insert into public.member_roles (user_id, role, chapter_id) values ($1, $2, $3)", [user, role, chapter]);
    await client.query("insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, $2, $3)", [user, role, chapter]);
  }
  await client.query(`
    insert into auth.sessions (id, user_id, created_at, updated_at, aal)
    select s, u, now() - interval '1 hour', now(), 'aal2'
    from unnest($1::uuid[], $2::uuid[]) as pair(s, u)
  `, [sessions, users]);
  for (const user of [ids.admin, ids.steward, ids.otherAdmin]) {
    await client.query(`
      insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      values (gen_random_uuid(), $1::uuid, 'quorum-proof-totp-' || $1::text, 'totp', 'verified', now(), now())
    `, [user]);
  }
  await client.query(`
    insert into public.member_events
      (id, title, starts_at, location, summary, order_index, chapter_id, is_public, is_public_across_agencies)
    values
      ($1, 'Home meeting', now(), 'Hall', 'A1 only', 9661, $7, false, false),
      ($2, 'Neighbour public meeting', now(), 'Hall', 'Region-public', 9662, $8, true, false),
      ($3, 'Neighbour private meeting', now(), 'Hall', 'B1 only', 9663, $8, false, false),
      ($4, 'Far across-agencies meeting', now(), 'Hall', 'Whole organization', 9664, $9, false, true),
      ($5, 'Far public meeting', now(), 'Hall', 'Other region', 9665, $9, true, false),
      ($6, 'Outside across-agencies meeting', now(), 'Hall', 'Other organization', 9666, $10, true, true)
  `, [HOME_MEETING, NEIGHBOUR_PUBLIC, NEIGHBOUR_PRIVATE, FAR_ACROSS, FAR_PUBLIC, OUTSIDE_ACROSS, CHAPTER, NEIGHBOUR, FAR, OUTSIDE]);
  await client.query(`
    insert into public.member_events (id, title, event_kind, event_date, location, summary, order_index, chapter_id, is_public, is_public_across_agencies)
    values ($1, 'Survey deadline', 'deadline', current_date + 3, 'Online', 'No meeting', 9667, $2, false, false)
  `, [HOME_DEADLINE, CHAPTER]);
}

async function value(client, sql, params) {
  return (await client.query(sql, params)).rows[0].value;
}

// Runs one statement under a savepoint and returns its refusal, or null.
async function refusal(client, sql, params) {
  await client.query("savepoint attempt");
  try {
    await client.query(sql, params);
    await client.query("release savepoint attempt");
    return null;
  } catch (error) {
    await client.query("rollback to savepoint attempt");
    return { code: error.code, message: error.message };
  }
}

async function storedQuorum(client, eventId) {
  await client.query("reset role");
  return (await client.query("select quorum_count from public.member_events where id = $1", [eventId])).rows[0]?.quorum_count;
}

async function quorumAudit(client) {
  await client.query("reset role");
  return (await client.query(`
    select actor, detail from public.member_admin_audit
    where action = 'update_event' and detail->>'field' = 'quorum' and detail->>'eventId' = any($1::text[])
  `, [[...MEETINGS, HOME_DEADLINE]])).rows;
}

// Raw writes as the table owner: quorum on every meeting and a few check-ins.
async function seedQuorums(client) {
  await client.query("reset role");
  await client.query("update public.member_events set quorum_count = 3 where id = any($1::text[])", [MEETINGS]);
  await client.query(`
    insert into public.member_event_checkins (event_id, user_id)
    select $1, u from unnest($2::uuid[]) u
  `, [HOME_MEETING, [ids.admin, ids.memberA, ids.steward, ids.memberFar]]);
  await client.query("insert into public.member_event_checkins (event_id, user_id) values ($1, $2)", [FAR_ACROSS, ids.memberFar]);
}

const setSql = "select public.set_member_event_quorum($1, $2) as value";
const readSql = "select public.get_member_event_quorum($1::text[]) as value";
const rlsSql = "select id from public.member_events where id = any($1::text[]) order by id";

async function withTransaction(name, work) {
  const client = await connect(name);
  await client.query("begin");
  try {
    await provision(client);
    await work(client);
  } finally {
    await client.query("rollback");
    await client.end();
  }
}

live("meeting quorum counts", () => {
  it("reapplies the installed migration's functions without error", async () => {
    // The disposable stack already applied it once. Replay only the function
    // definitions (the column add is not repeatable) inside a rolled-back
    // transaction.
    const migration = readFileSync(new URL("../supabase/migrations/20261030224500_meeting_quorum_counts.sql", import.meta.url), "utf8");
    const functions = migration.slice(migration.indexOf("create function public.set_member_event_quorum"), migration.lastIndexOf("commit;"))
      .replaceAll("create function", "create or replace function");
    await withTransaction("quorum-reapply-proof", async (client) => {
      await expect(client.query(functions)).resolves.toBeDefined();
    });
  }, 60_000);

  it("keeps the column off client reads and writes", async () => {
    await withTransaction("quorum-grant-proof", async (client) => {
      await seedQuorums(client);
      await memberA(client);
      expect(await refusal(client, "select quorum_count from public.member_events where id = $1", [HOME_MEETING])).toMatchObject({ code: "42501" });
      await admin(client);
      expect(await refusal(client, "update public.member_events set quorum_count = 9 where id = $1", [HOME_MEETING])).toMatchObject({ code: "42501" });
      expect(await storedQuorum(client, HOME_MEETING)).toBe(3);
      expect(await refusal(client, "update public.member_events set quorum_count = 0 where id = $1", [HOME_MEETING])).toMatchObject({ code: "23514" });
    });
  }, 60_000);

  it("lets staff of the meeting's chapter set, change and clear the quorum, each change audited once", async () => {
    await withTransaction("quorum-write-proof", async (client) => {
      await admin(client);
      // Each save returns the version it leaves (REQ-UG-LEARNING-PERIOD-EVENTS-20261103).
      expect(await value(client, setSql, [HOME_MEETING, 20])).toEqual({ id: HOME_MEETING, quorum: 20, changed: true, version: 2 });
      expect(await storedQuorum(client, HOME_MEETING)).toBe(20);
      await steward(client);
      expect(await value(client, setSql, [HOME_MEETING, 20])).toEqual({ id: HOME_MEETING, quorum: 20, changed: false, version: 2 });
      expect(await value(client, setSql, [HOME_MEETING, 12])).toEqual({ id: HOME_MEETING, quorum: 12, changed: true, version: 3 });
      await admin(client);
      expect(await value(client, setSql, [HOME_MEETING, null])).toEqual({ id: HOME_MEETING, quorum: null, changed: true, version: 4 });
      expect(await storedQuorum(client, HOME_MEETING)).toBeNull();
      const audit = await quorumAudit(client);
      // One transaction stamps every audit row with the same now(), so read
      // them as a set.
      const changes = audit.map((row) => JSON.stringify([row.actor, row.detail.from, row.detail.to])).sort();
      expect(changes).toEqual([[ids.admin, null, 20], [ids.steward, 20, 12], [ids.admin, 12, null]].map((row) => JSON.stringify(row)).sort());
      for (const row of audit) expect(row.detail).toMatchObject({ eventId: HOME_MEETING, title: "Home meeting", chapterId: CHAPTER, field: "quorum" });
    });
  }, 60_000);

  it("refuses members, one-step sign-in, other chapters, other organizations, non-meetings and bad figures", async () => {
    await withTransaction("quorum-gate-proof", async (client) => {
      await memberA(client);
      expect(await refusal(client, setSql, [HOME_MEETING, 5])).toMatchObject({ code: "42501" });
      await admin(client, "aal1");
      expect(await refusal(client, setSql, [HOME_MEETING, 5])).toMatchObject({ code: "42501" });
      await otherAdmin(client);
      expect(await refusal(client, setSql, [HOME_MEETING, 5])).toMatchObject({ code: "22023", message: "unknown event" });
      await admin(client);
      for (const foreign of [NEIGHBOUR_PUBLIC, FAR_ACROSS, OUTSIDE_ACROSS, "quorum-no-such-event"]) {
        expect(await refusal(client, setSql, [foreign, 5]), foreign).toMatchObject({ code: "22023", message: "unknown event" });
      }
      expect(await refusal(client, setSql, [HOME_DEADLINE, 5])).toMatchObject({ code: "22023", message: "only a meeting takes a quorum" });
      for (const bad of [0, -1, 100001]) {
        expect(await refusal(client, setSql, [HOME_MEETING, bad]), String(bad)).toMatchObject({ code: "22023" });
      }
      await client.query("reset role");
      expect((await client.query("select id from public.member_events where quorum_count is not null and id = any($1::text[])", [[...MEETINGS, HOME_DEADLINE]])).rows).toEqual([]);
      expect(await quorumAudit(client)).toEqual([]);
      for (const role of ["anon", "service_role"]) {
        await client.query(`set local role ${role}`);
        expect(await refusal(client, setSql, [HOME_MEETING, 5]), role).toMatchObject({ code: "42501" });
        expect(await refusal(client, readSql, [[HOME_MEETING]]), role).toMatchObject({ code: "42501" });
        await client.query("reset role");
      }
    });
  }, 60_000);

  it("returns the quorum and the count for exactly the meetings RLS shows each caller", async () => {
    await withTransaction("quorum-read-proof", async (client) => {
      await seedQuorums(client);
      const probe = [...MEETINGS, HOME_DEADLINE];
      for (const [name, caller] of [["memberA", memberA], ["admin", admin], ["otherAdmin", otherAdmin], ["memberFar", memberFar], ["outsider", outsider]]) {
        await caller(client);
        const visible = (await client.query(rlsSql, [probe])).rows.map((row) => row.id).filter((id) => id !== HOME_DEADLINE);
        const rows = await value(client, readSql, [probe]);
        expect(rows.map((row) => row.eventId), name).toEqual(visible);
        for (const row of rows) expect(Object.keys(row).sort(), name).toEqual(["checkedIn", "eventId", "quorum"]);
      }
      await memberA(client);
      expect(await value(client, readSql, [probe])).toEqual([
        { eventId: FAR_ACROSS, quorum: 3, checkedIn: 1 },
        { eventId: HOME_MEETING, quorum: 3, checkedIn: 4 },
        { eventId: NEIGHBOUR_PUBLIC, quorum: 3, checkedIn: 0 },
      ]);
      await outsider(client);
      expect(await value(client, readSql, [probe])).toEqual([{ eventId: OUTSIDE_ACROSS, quorum: 3, checkedIn: 0 }]);
    });
  }, 60_000);

  it("follows check-ins, omits meetings without a quorum, and bounds the request", async () => {
    await withTransaction("quorum-count-proof", async (client) => {
      await admin(client);
      await value(client, setSql, [HOME_MEETING, 2]);
      await memberA(client);
      expect(await value(client, readSql, [[HOME_MEETING, NEIGHBOUR_PUBLIC]])).toEqual([{ eventId: HOME_MEETING, quorum: 2, checkedIn: 0 }]);
      await client.query("reset role");
      await client.query("insert into public.member_event_checkins (event_id, user_id) values ($1, $2), ($1, $3)", [HOME_MEETING, ids.memberA, ids.steward]);
      await memberA(client);
      expect(await value(client, readSql, [[HOME_MEETING]])).toEqual([{ eventId: HOME_MEETING, quorum: 2, checkedIn: 2 }]);
      expect(await value(client, readSql, [[]])).toEqual([]);
      expect(await refusal(client, readSql, [Array.from({ length: 201 }, (_, index) => `e${index}`)])).toMatchObject({ code: "22023" });
      expect(await refusal(client, "select public.get_member_event_quorum(null) as value")).toMatchObject({ code: "22023" });
      // A member who has a verified authenticator but signed in with one step
      // is refused the read like any other two-step-gated function.
      await admin(client, "aal1");
      expect(await refusal(client, readSql, [[HOME_MEETING]])).toMatchObject({ code: "42501" });
    });
  }, 60_000);
});
