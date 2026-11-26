// @vitest-environment node
import pg from "pg";
import { describe, expect, it } from "vitest";
import { caseGraphWrappedSource, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql } from "./helpers/migration.js";

// SEC-UG-EVENT-CHECKIN-CODE-UNBOUNDED-GUESSES-20260920 (owner ruling
// 2026-09-25). Only a live apply proves the bound: the tenth wrong code locks
// the (caller, event) pair out, the correct code is then refused with the
// byte-identical payload a wrong code returns, one audit row names the event
// and the caller without a code value, another caller on the same event is
// unaffected, the correct code works again once the service-role clock
// override passes 15 minutes, and Main's wrapped body accepted unbounded
// guesses. Every case runs in one transaction and rolls back.
const MAIN_PREDECESSOR_DIGEST = "6bfeba86e1bb8afb89346f6f385d758d4b6d4c05878bedb16eda28de8059b6ed";
const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const ids = Object.freeze({
  admin: "0d980000-0000-4000-8000-000000000001",
  memberA: "0d980000-0000-4000-8000-000000000002",
  memberB: "0d980000-0000-4000-8000-000000000003",
  adminSession: "0d980000-0000-4000-8000-000000000011",
  memberASession: "0d980000-0000-4000-8000-000000000012",
  memberBSession: "0d980000-0000-4000-8000-000000000013",
  adminFactor: "0d980000-0000-4000-8000-000000000021",
  org: "0d980000-0000-4000-8000-000000000101",
});
const CHAPTER = "checkin-bound-proof-a1";
const EVENT = "checkin-bound-proof-event";
const QUIET_EVENT = "checkin-bound-proof-quiet-event";
const CODE = "SG-BOUND";
// 20261008080800 added the translatable token; wrong code and lockout still
// share this one payload (BUG-UG-WEB-EVENT-CHECKIN-REFUSALS-ENGLISH-ONLY-20261003).
const REFUSAL = Object.freeze({ checkedIn: false, refused: true, code: "22023", message: "invalid check-in code", token: "checkin_code_invalid" });

function mainDefinitionSql() {
  const original = parseFunctions(loadMigrationSql("20260901153739_event_organization_isolation"), "20260901153739.sql")
    .find((entry) => entry.name === "public.check_in_to_event");
  if (!original) throw new Error("missing Main check-in function");
  return `create or replace function public.check_in_to_event(p_event_id text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $checkin_main_pred$${caseGraphWrappedSource(original.source)}$checkin_main_pred$;`;
}

async function connect(applicationName) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: applicationName,
  });
  await client.connect();
  return client;
}

function claims(userId, sessionId, aal) {
  return { sub: userId, session_id: sessionId, role: "authenticated", aal };
}

async function asRole(client, role, jwt = { role }) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(jwt)]);
  await client.query(`set local role ${role}`);
}

async function provision(client) {
  await client.query(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ($1, 'checkin-bound-admin@example.invalid', '{}'::jsonb),
      ($2, 'checkin-bound-member-a@example.invalid', '{}'::jsonb),
      ($3, 'checkin-bound-member-b@example.invalid', '{}'::jsonb)
  `, [ids.admin, ids.memberA, ids.memberB]);
  await client.query(`
    insert into public.organizations (id, slug, name, created_by)
    values ($1, 'checkin-bound-proof-org', 'Check-in bound proof organization', $2)
  `, [ids.org, ids.admin]);
  await client.query(`
    insert into public.chapters (id, name, slug, region, is_default, order_index, organization_id)
    values ($1, 'Check-in bound proof A1', $1, 'shared-proof-region', false, 9801, $2)
  `, [CHAPTER, ids.org]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status) values
      ($1, $2, 'active'), ($1, $3, 'active'), ($1, $4, 'active')
  `, [ids.org, ids.admin, ids.memberA, ids.memberB]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status) values
      ($1, $4, 'active'), ($2, $4, 'active'), ($3, $4, 'active')
  `, [ids.admin, ids.memberA, ids.memberB, CHAPTER]);
  await client.query("update public.member_profiles set chapter_id = $2 where id = any($1::uuid[])", [[ids.admin, ids.memberA, ids.memberB], CHAPTER]);
  await client.query("insert into public.member_roles (user_id, role, chapter_id) values ($1, 'admin', $2)", [ids.admin, CHAPTER]);
  await client.query("insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, 'admin', $2)", [ids.admin, CHAPTER]);
  await client.query(`
    insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
      ($1, $4, now() - interval '1 hour', now(), 'aal2'),
      ($2, $5, now() - interval '1 hour', now(), 'aal1'),
      ($3, $6, now() - interval '1 hour', now(), 'aal1')
  `, [ids.adminSession, ids.memberASession, ids.memberBSession, ids.admin, ids.memberA, ids.memberB]);
  await client.query(`
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values ($1, $2, 'checkin-bound-admin-totp', 'totp', 'verified', now(), now())
  `, [ids.adminFactor, ids.admin]);
  await client.query(`
    insert into public.member_events
      (id, title, starts_at, location, summary, check_in_code, order_index, chapter_id, is_public, is_public_across_agencies)
    values
      ($1, 'Bounded check-in event', now(), 'Hall', 'Check-in bound proof', $3, 9801, $4, true, false),
      ($2, 'Quiet event', now(), 'Hall', 'No lockouts here', 'SG-QUIET', 9802, $4, true, false)
  `, [EVENT, QUIET_EVENT, CODE, CHAPTER]);
}

async function checkIn(client, userId, sessionId, code, eventId = EVENT) {
  await asRole(client, "authenticated", claims(userId, sessionId, "aal1"));
  const result = (await client.query("select public.check_in_to_event($1, $2) as value", [eventId, code])).rows[0].value;
  await client.query("reset role");
  return result;
}

async function attemptRow(client, userId) {
  await client.query("reset role");
  return (await client.query(
    "select wrong_attempts, locked_until from private.member_event_checkin_attempts where event_id = $1 and user_id = $2",
    [EVENT, userId],
  )).rows[0] ?? null;
}

async function lockoutAudit(client) {
  await client.query("reset role");
  return (await client.query(
    "select actor, target_user, detail, detail::text as detail_text from public.member_admin_audit where action = 'event_checkin_lockout' order by created_at",
  )).rows;
}

async function memberWrites(client, userId) {
  await client.query("reset role");
  const checkins = (await client.query("select 1 from public.member_event_checkins where event_id = $1 and user_id = $2", [EVENT, userId])).rowCount;
  const awards = (await client.query("select 1 from public.member_action_log where user_id = $1 and action_key = $2", [userId, `checkin-${EVENT}`])).rowCount;
  return { checkins, awards };
}

async function lockOut(client) {
  const refusals = [];
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    refusals.push(await checkIn(client, ids.memberA, ids.memberASession, `WRONG-${attempt}`));
  }
  return refusals;
}

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

live("event check-in code attempt bound", () => {
  it("counts each wrong code durably, locks the pair out on the tenth and refuses the correct code with the same payload", async () => {
    await withTransaction("checkin-bound-lockout-proof", async (client) => {
      const refusals = await lockOut(client);
      for (const [index, refusal] of refusals.entries()) {
        expect(refusal, `wrong code ${index + 1}`).toEqual(REFUSAL);
      }
      expect((await attemptRow(client, ids.memberA)).wrong_attempts).toBe(10);
      expect((await attemptRow(client, ids.memberA)).locked_until).not.toBeNull();
      const lockedCorrect = await checkIn(client, ids.memberA, ids.memberASession, CODE);
      expect(lockedCorrect).toEqual(REFUSAL);
      expect(JSON.stringify(lockedCorrect)).toBe(JSON.stringify(refusals[9]));
      expect(await memberWrites(client, ids.memberA)).toEqual({ checkins: 0, awards: 0 });
      // The bound cannot be reset by repeating the call: more attempts during
      // the lockout neither count nor extend it.
      const { locked_until: lockedUntil } = await attemptRow(client, ids.memberA);
      expect(await checkIn(client, ids.memberA, ids.memberASession, "WRONG-11")).toEqual(REFUSAL);
      expect(await attemptRow(client, ids.memberA)).toEqual({ wrong_attempts: 10, locked_until: lockedUntil });
    });
  }, 60_000);

  it("stops counting before the tenth wrong code: nine wrong codes leave the correct code accepted", async () => {
    await withTransaction("checkin-bound-below-bound-proof", async (client) => {
      for (let attempt = 1; attempt <= 9; attempt += 1) {
        expect(await checkIn(client, ids.memberA, ids.memberASession, `WRONG-${attempt}`)).toEqual(REFUSAL);
      }
      expect(await attemptRow(client, ids.memberA)).toEqual({ wrong_attempts: 9, locked_until: null });
      const accepted = await checkIn(client, ids.memberA, ids.memberASession, ` ${CODE.toLowerCase()} `);
      expect(accepted).toMatchObject({ checkedIn: true, alreadyCheckedIn: false });
      expect(await attemptRow(client, ids.memberA)).toBeNull();
      expect(await memberWrites(client, ids.memberA)).toEqual({ checkins: 1, awards: 1 });
      expect(await lockoutAudit(client)).toEqual([]);
    });
  }, 60_000);

  it("writes exactly one audit row per lockout naming the event and the caller and never a code value", async () => {
    await withTransaction("checkin-bound-audit-proof", async (client) => {
      await lockOut(client);
      await checkIn(client, ids.memberA, ids.memberASession, CODE);
      await checkIn(client, ids.memberA, ids.memberASession, "WRONG-AGAIN");
      const rows = await lockoutAudit(client);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: ids.memberA, target_user: ids.memberA });
      expect(rows[0].detail).toMatchObject({ eventId: EVENT, wrongAttempts: 10 });
      expect(typeof rows[0].detail.lockedUntil).toBe("string");
      expect(rows[0].detail_text).not.toContain(CODE);
      expect(rows[0].detail_text).not.toContain("WRONG");
    });
  }, 60_000);

  it("leaves another caller on the same event unaffected by a locked-out caller", async () => {
    await withTransaction("checkin-bound-other-caller-proof", async (client) => {
      await lockOut(client);
      expect(await checkIn(client, ids.memberB, ids.memberBSession, "WRONG-B")).toEqual(REFUSAL);
      expect(await attemptRow(client, ids.memberB)).toEqual({ wrong_attempts: 1, locked_until: null });
      expect(await checkIn(client, ids.memberB, ids.memberBSession, CODE)).toMatchObject({ checkedIn: true });
      expect(await memberWrites(client, ids.memberB)).toEqual({ checkins: 1, awards: 1 });
      expect(await checkIn(client, ids.memberA, ids.memberASession, CODE)).toEqual(REFUSAL);
    });
  }, 60_000);

  it("accepts the correct code once 15 minutes have passed and shows staff the lockout on the events desk", async () => {
    await withTransaction("checkin-bound-expiry-and-desk-proof", async (client) => {
      await lockOut(client);
      // The override is reachable only through the service-role setter: a
      // member cannot move the clock, the service role can.
      await asRole(client, "authenticated", claims(ids.memberA, ids.memberASession, "aal1"));
      await client.query("savepoint member_clock");
      let memberClock = null;
      try {
        await client.query("select public.set_event_checkin_clock_override(now() + interval '1 hour')");
      } catch (error) {
        memberClock = error.code;
      }
      expect(memberClock).toBe("42501");
      await client.query("rollback to savepoint member_clock");
      await asRole(client, "service_role", { role: "service_role" });
      await client.query("select public.set_event_checkin_clock_override(now() + interval '14 minutes')");
      expect(await checkIn(client, ids.memberA, ids.memberASession, CODE)).toEqual(REFUSAL);
      await asRole(client, "service_role", { role: "service_role" });
      await client.query("select public.set_event_checkin_clock_override(now() + interval '15 minutes 1 second')");
      // A wrong code after expiry opens a fresh window at 1 rather than re-locking.
      expect(await checkIn(client, ids.memberA, ids.memberASession, "WRONG-LATE")).toEqual(REFUSAL);
      expect(await attemptRow(client, ids.memberA)).toEqual({ wrong_attempts: 1, locked_until: null });
      expect(await checkIn(client, ids.memberA, ids.memberASession, CODE)).toMatchObject({ checkedIn: true, alreadyCheckedIn: false });
      expect(await memberWrites(client, ids.memberA)).toEqual({ checkins: 1, awards: 1 });
      expect(await lockoutAudit(client)).toHaveLength(1);

      await asRole(client, "authenticated", claims(ids.admin, ids.adminSession, "aal2"));
      const desk = (await client.query("select public.get_admin_events() as value")).rows[0].value;
      const byId = Object.fromEntries(desk.map((row) => [row.id, row]));
      expect(byId[EVENT]).toMatchObject({ checkinLockouts24h: 1, checkinCount: 1 });
      expect(byId[QUIET_EVENT]).toMatchObject({ checkinLockouts24h: 0, checkinCount: 0 });
    });
  }, 60_000);

  it("is a behavior change: Main's wrapped body raised on every wrong code and never bounded them", async () => {
    await withTransaction("checkin-bound-predecessor-proof", async (client) => {
      await client.query("reset role");
      await client.query(mainDefinitionSql());
      const installed = (await client.query(`
        select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex') as digest
          from pg_catalog.pg_proc p
         where p.oid = 'public.check_in_to_event(text, text)'::regprocedure
      `)).rows[0].digest;
      expect(installed).toBe(MAIN_PREDECESSOR_DIGEST);
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        await client.query("savepoint guess");
        let code = null;
        try {
          await checkIn(client, ids.memberA, ids.memberASession, `WRONG-${attempt}`);
        } catch (error) {
          code = error.code;
        }
        expect(code, `guess ${attempt}`).toBe("22023");
        await client.query("rollback to savepoint guess");
      }
      expect(await attemptRow(client, ids.memberA)).toBeNull();
      expect(await checkIn(client, ids.memberA, ids.memberASession, CODE)).toMatchObject({ checkedIn: true });
      expect(await lockoutAudit(client)).toEqual([]);
    });
  }, 60_000);
});
