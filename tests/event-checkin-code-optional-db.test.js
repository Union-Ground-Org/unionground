// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// BUG-UG-EVENT-SAVE-SILENT-WITHOUT-CHECKIN-CODE-20261006. Only a live
// apply proves 20261008235000: a deadline or reminder saves with no check-in
// code, an update tells an omitted code (keep it) from an empty one (remove
// it), and an event without a code admits nobody. Before the migration a NULL
// code would have compared as unknown in check_in_to_event and fallen through
// to admission, so every path is exercised: the door code, the personal code
// and the steward scan, with cancellation, the window, a lockout, tenant scope
// and chapter authorization. Every case runs in one transaction and rolls back.
const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const ids = Object.freeze({
  admin: "0d981300-0000-4000-8000-000000000001",
  memberA: "0d981300-0000-4000-8000-000000000002",
  steward: "0d981300-0000-4000-8000-000000000003",
  otherAdmin: "0d981300-0000-4000-8000-000000000004",
  outsider: "0d981300-0000-4000-8000-000000000005",
  adminSession: "0d981300-0000-4000-8000-000000000011",
  memberASession: "0d981300-0000-4000-8000-000000000012",
  stewardSession: "0d981300-0000-4000-8000-000000000013",
  otherAdminSession: "0d981300-0000-4000-8000-000000000014",
  outsiderSession: "0d981300-0000-4000-8000-000000000015",
  org: "0d981300-0000-4000-8000-000000000101",
  otherOrg: "0d981300-0000-4000-8000-000000000102",
});
const CHAPTER = "checkin-optional-proof-a1";
const OTHER_CHAPTER = "checkin-optional-proof-b1";
const OUTSIDE_CHAPTER = "checkin-optional-proof-x1";
const CODED = "checkin-optional-coded";
const DEADLINE = "checkin-optional-deadline";
const CODE = "SG-OPTION1";
const NOT_OFFERED = Object.freeze({ code: "22023", detail: "checkin_not_offered" });
const REFUSAL = Object.freeze({ checkedIn: false, refused: true, code: "22023", message: "invalid check-in code", token: "checkin_code_invalid" });

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

const admin = (client) => as(client, ids.admin, ids.adminSession, "aal2");
const memberA = (client) => as(client, ids.memberA, ids.memberASession, "aal1");
const steward = (client) => as(client, ids.steward, ids.stewardSession, "aal2");

async function provision(client) {
  const users = [ids.admin, ids.memberA, ids.steward, ids.otherAdmin, ids.outsider];
  await client.query(`
    insert into auth.users (id, email, raw_user_meta_data)
    select u, 'checkin-optional-' || u || '@example.invalid', '{}'::jsonb from unnest($1::uuid[]) u
  `, [users]);
  await client.query(`
    insert into public.organizations (id, slug, name, created_by) values
      ($1, 'checkin-optional-proof-org', 'Check-in optional proof organization', $3),
      ($2, 'checkin-optional-proof-other', 'Check-in optional other organization', $4)
  `, [ids.org, ids.otherOrg, ids.admin, ids.outsider]);
  await client.query(`
    insert into public.chapters (id, name, slug, region, is_default, order_index, organization_id) values
      ($1, 'Optional proof A1', $1, 'optional-proof-region', false, 9811, $4),
      ($2, 'Optional proof B1', $2, 'optional-proof-region', false, 9812, $4),
      ($3, 'Optional proof X1', $3, 'optional-proof-region', false, 9813, $5)
  `, [CHAPTER, OTHER_CHAPTER, OUTSIDE_CHAPTER, ids.org, ids.otherOrg]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status) values
      ($1, $3, 'active'), ($1, $4, 'active'), ($1, $5, 'active'), ($1, $6, 'active'), ($2, $7, 'active')
  `, [ids.org, ids.otherOrg, ids.admin, ids.memberA, ids.steward, ids.otherAdmin, ids.outsider]);
  const homes = [[ids.admin, CHAPTER], [ids.memberA, CHAPTER], [ids.steward, CHAPTER], [ids.otherAdmin, OTHER_CHAPTER], [ids.outsider, OUTSIDE_CHAPTER]];
  for (const [user, chapter] of homes) {
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [user, chapter]);
    await client.query("update public.member_profiles set chapter_id = $2, full_name = coalesce(nullif(full_name, ''), 'Optional proof member') where id = $1", [user, chapter]);
  }
  for (const [user, role, chapter] of [[ids.admin, "admin", CHAPTER], [ids.otherAdmin, "admin", OTHER_CHAPTER], [ids.steward, "steward", CHAPTER]]) {
    await client.query("insert into public.member_roles (user_id, role, chapter_id) values ($1, $2, $3)", [user, role, chapter]);
    await client.query("insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, $2, $3)", [user, role, chapter]);
  }
  await client.query(`
    insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
      ($1, $6, now() - interval '1 hour', now(), 'aal2'),
      ($2, $7, now() - interval '1 hour', now(), 'aal1'),
      ($3, $8, now() - interval '1 hour', now(), 'aal2'),
      ($4, $9, now() - interval '1 hour', now(), 'aal2'),
      ($5, $10, now() - interval '1 hour', now(), 'aal1')
  `, [ids.adminSession, ids.memberASession, ids.stewardSession, ids.otherAdminSession, ids.outsiderSession,
    ids.admin, ids.memberA, ids.steward, ids.otherAdmin, ids.outsider]);
  for (const user of [ids.admin, ids.steward, ids.otherAdmin]) {
    await client.query(`
      insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      values (gen_random_uuid(), $1::uuid, 'checkin-optional-totp-' || $1::text, 'totp', 'verified', now(), now())
    `, [user]);
  }
  // Both events start now, inside the check-in window, and are shared across
  // agencies so the outsider's refusal can only come from the tenant boundary.
  await client.query(`
    insert into public.member_events
      (id, title, starts_at, location, summary, check_in_code, order_index, chapter_id, is_public, is_public_across_agencies)
    values
      ($1, 'Coded meeting', now(), 'Hall', 'Has a door code', $3, 9811, $4, true, true),
      ($2, 'Survey deadline', now(), 'Online', 'No door code', null, 9812, $4, true, true)
  `, [CODED, DEADLINE, CODE, CHAPTER]);
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
    return { code: error.code, detail: error.detail ?? null, message: error.message };
  }
}

async function eventCode(client, eventId) {
  await client.query("reset role");
  return (await client.query("select check_in_code from public.member_events where id = $1", [eventId])).rows[0]?.check_in_code;
}

async function admissions(client, eventId) {
  await client.query("reset role");
  return {
    checkins: (await client.query("select 1 from public.member_event_checkins where event_id = $1", [eventId])).rowCount,
    attempts: (await client.query("select 1 from private.member_event_checkin_attempts where event_id = $1", [eventId])).rowCount,
    awards: (await client.query("select 1 from public.member_action_log where action_key = $1", [`checkin-${eventId}`])).rowCount,
  };
}

const createSql = "select public.create_member_event($1, $2, now() + interval '3 days', 'Online', 'Contract expiry reminder', $3, false, false) as value";
const updateSql = "select public.update_member_event(p_id => $1, p_title => $2, p_check_in_code => $3) as value";
const checkInSql = "select public.check_in_to_event($1, $2) as value";

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

live("optional event check-in code", () => {
  it("reapplies the installed migration without error", async () => {
    // The disposable stack already applied it once. Remove only the outer
    // transaction so this second application and its fixtures roll back.
    const migration = readFileSync(new URL("../supabase/migrations/20261008235000_event_checkin_code_optional.sql", import.meta.url), "utf8")
      .replace(/^begin;$/m, "")
      .replace(/^commit;$/m, "");
    // Once a later migration re-emits check_in_to_event (20261104110000, the
    // learning-period journal call), this file's predecessor guard must
    // refuse to overwrite that newer body rather than reinstall its own.
    const migrations = new URL("../supabase/migrations/", import.meta.url);
    const superseded = readdirSync(migrations).some((name) => name > "20261008235000_event_checkin_code_optional.sql"
      && /function\s+public\.check_in_to_event\s*\(/i.test(readFileSync(new URL(name, migrations), "utf8").replace(/--[^\n]*/g, "")));
    await withTransaction("checkin-optional-reapply-proof", async (client) => {
      if (superseded) {
        await expect(client.query(migration)).rejects.toMatchObject({ code: "55000", message: expect.stringContaining("unreviewed public.check_in_to_event(text,text) body") });
      } else {
        await expect(client.query(migration)).resolves.toBeDefined();
      }
    });
  }, 60_000);

  it("exposes availability through scoped reads while denying the secret", async () => {
    await withTransaction("checkin-optional-read-proof", async (client) => {
      const read = "select id, check_in_offered from public.member_events where id = any($1::text[]) order by id";
      const readAvailability = async () => (await client.query(read, [[CODED, DEADLINE]])).rows;
      await memberA(client);
      expect(await readAvailability()).toEqual([
        { id: CODED, check_in_offered: true },
        { id: DEADLINE, check_in_offered: false },
      ]);
      expect(await refusal(client, "select check_in_code from public.member_events where id = $1", [CODED])).toMatchObject({ code: "42501" });
      await admin(client);
      await value(client, updateSql, [CODED, null, ""]);
      await memberA(client);
      expect((await readAvailability())[0].check_in_offered).toBe(false);
      await admin(client);
      await value(client, updateSql, [CODED, null, CODE]);
      await memberA(client);
      expect((await readAvailability())[0].check_in_offered).toBe(true);
      await as(client, ids.outsider, ids.outsiderSession, "aal1");
      expect(await readAvailability()).toEqual([]);
    });
  }, 60_000);

  it("saves a deadline or reminder with no code and still enforces the pattern when a code is given", async () => {
    await withTransaction("checkin-optional-create-proof", async (client) => {
      await admin(client);
      expect(await value(client, createSql, ["optional-null-code", "Survey closes", null])).toEqual({ id: "optional-null-code", created: true });
      expect(await value(client, createSql, ["optional-empty-code", "Contract expires", ""])).toEqual({ id: "optional-empty-code", created: true });
      expect(await value(client, createSql, ["optional-with-code", "Monthly meeting", "SG-MEET42"])).toEqual({ id: "optional-with-code", created: true });
      expect(await refusal(client, createSql, ["optional-bad-code", "Bad code", "sg-meet"])).toMatchObject({ code: "22023", message: "invalid check-in code" });
      expect(await refusal(client, createSql, ["optional-space-code", "Space code", " "])).toMatchObject({ code: "22023", message: "invalid check-in code" });
      expect(await eventCode(client, "optional-null-code")).toBeNull();
      expect(await eventCode(client, "optional-empty-code")).toBeNull();
      expect(await eventCode(client, "optional-with-code")).toBe("SG-MEET42");
      expect(await eventCode(client, "optional-bad-code")).toBeUndefined();
      // The column constraint still holds a present code to the pattern.
      expect(await refusal(client, "update public.member_events set check_in_code = 'not-a-code' where id = $1", [CODED]))
        .toMatchObject({ code: "23514" });
    });
  }, 60_000);

  it("keeps the code when an update omits it and removes it only when the update sends it empty", async () => {
    await withTransaction("checkin-optional-update-proof", async (client) => {
      await admin(client);
      // Each update returns the version it leaves (REQ-UG-LEARNING-PERIOD-EVENTS-20261103).
      expect(await value(client, updateSql, [CODED, "Coded meeting renamed", null])).toEqual({ id: CODED, updated: true, version: 2 });
      expect(await eventCode(client, CODED)).toBe(CODE);

      await admin(client);
      expect(await value(client, updateSql, [CODED, null, ""])).toEqual({ id: CODED, updated: true, version: 3 });
      expect(await eventCode(client, CODED)).toBeNull();
      await client.query("reset role");
      // One transaction stamps both audit rows with the same now(), so read
      // them as a set: the rename, then the removal, never the code value.
      const audit = (await client.query(
        "select detail->'fields' as fields, detail::text as text from public.member_admin_audit where action = 'update_event' and detail->>'eventId' = $1",
        [CODED],
      )).rows;
      expect(audit.map((row) => row.fields).sort()).toEqual([["check_in_code"], ["title"]]);
      for (const row of audit) expect(row.text).not.toContain(CODE);

      await admin(client);
      expect(await value(client, updateSql, [CODED, null, ""])).toEqual({ id: CODED, updated: false, version: 3 });
      expect(await refusal(client, updateSql, [CODED, null, "SG-x"])).toMatchObject({ code: "22023", message: "invalid check-in code" });
      expect(await value(client, updateSql, [CODED, null, "SG-AGAIN1"])).toEqual({ id: CODED, updated: true, version: 4 });
      expect(await eventCode(client, CODED)).toBe("SG-AGAIN1");
    });
  }, 60_000);

  it("lets no admin outside the event's chapter remove its code", async () => {
    await withTransaction("checkin-optional-chapter-proof", async (client) => {
      await as(client, ids.otherAdmin, ids.otherAdminSession, "aal2");
      expect(await refusal(client, updateSql, [CODED, null, ""])).toMatchObject({ code: "22023", message: "unknown event" });
      await memberA(client);
      expect(await refusal(client, updateSql, [CODED, null, ""])).toMatchObject({ code: "42501" });
      expect(await eventCode(client, CODED)).toBe(CODE);
    });
  }, 60_000);

  it("refuses a door-code check-in for an event without a code on every input and counts nothing", async () => {
    await withTransaction("checkin-optional-door-proof", async (client) => {
      for (const guess of [null, "", " ", "SG-ANY1", CODE]) {
        await memberA(client);
        expect(await refusal(client, checkInSql, [DEADLINE, guess]), String(guess)).toMatchObject(NOT_OFFERED);
      }
      expect(await admissions(client, DEADLINE)).toEqual({ checkins: 0, attempts: 0, awards: 0 });
    });
  }, 60_000);

  it("still refuses cancelled and out-of-scope events first, and a lockout survives a code removed and restored", async () => {
    await withTransaction("checkin-optional-order-proof", async (client) => {
      await as(client, ids.outsider, ids.outsiderSession, "aal1");
      expect(await refusal(client, checkInSql, [DEADLINE, null])).toMatchObject({ code: "22023", message: "event not found" });
      expect(await refusal(client, "select public.request_event_checkin_token($1)", [DEADLINE])).toMatchObject({ code: "22023", message: "event not found" });

      await client.query("reset role");
      await client.query("update public.member_events set cancelled_at = now() where id = $1", [DEADLINE]);
      await memberA(client);
      expect(await refusal(client, checkInSql, [DEADLINE, null])).toMatchObject({ code: "22023", detail: "event_cancelled" });

      // A no-code event outside the window is refused as having no check-in.
      await client.query("reset role");
      await client.query("update public.member_events set cancelled_at = null, starts_at = now() + interval '3 days' where id = $1", [DEADLINE]);
      await memberA(client);
      expect(await refusal(client, checkInSql, [DEADLINE, "SG-ANY1"])).toMatchObject(NOT_OFFERED);

      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await memberA(client);
        expect(await value(client, checkInSql, [CODED, `SG-WRONG${attempt}`])).toEqual(REFUSAL);
      }
      await admin(client);
      await value(client, updateSql, [CODED, null, ""]);
      await memberA(client);
      expect(await refusal(client, checkInSql, [CODED, CODE])).toMatchObject(NOT_OFFERED);
      await admin(client);
      await value(client, updateSql, [CODED, null, CODE]);
      await memberA(client);
      expect(await value(client, checkInSql, [CODED, CODE])).toEqual(REFUSAL);
      expect(await admissions(client, CODED)).toMatchObject({ checkins: 0, awards: 0 });
    });
  }, 60_000);

  it("mints no personal code for an event without one and will not scan a code minted before its removal", async () => {
    await withTransaction("checkin-optional-scan-proof", async (client) => {
      await memberA(client);
      expect(await refusal(client, "select public.request_event_checkin_token($1)", [DEADLINE])).toMatchObject(NOT_OFFERED);

      await memberA(client);
      const { token } = await value(client, "select public.request_event_checkin_token($1) as value", [CODED]);
      await admin(client);
      await value(client, updateSql, [CODED, null, ""]);
      await steward(client);
      expect(await refusal(client, "select public.scan_event_checkin($1, $2)", [CODED, token])).toMatchObject(NOT_OFFERED);
      await client.query("reset role");
      expect((await client.query(
        "select consumed_at from private.member_event_checkin_tokens where event_id = $1 and user_id = $2",
        [CODED, ids.memberA],
      )).rows).toEqual([{ consumed_at: null }]);
      expect(await admissions(client, CODED)).toMatchObject({ checkins: 0 });

      // Only the missing code refused it: restored, the same token scans.
      await admin(client);
      await value(client, updateSql, [CODED, null, CODE]);
      await steward(client);
      expect(await value(client, "select public.scan_event_checkin($1, $2) as value", [CODED, token])).toMatchObject({ checkedIn: true });
      expect(await admissions(client, CODED)).toMatchObject({ checkins: 1 });
    });
  }, 60_000);
});
