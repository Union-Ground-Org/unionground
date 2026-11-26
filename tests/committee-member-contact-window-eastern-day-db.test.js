// @vitest-environment node
//
// BUG-UG-COMMITTEE-MEMBER-CONTACT-CHECK-USES-THE-UTC-DAY-20261118 (#9130):
// private.chapter_member_contact_container_allowed reads a committee's window
// on the Eastern day. A test cannot move now(), so it pins the session time
// zone instead, as tests/committee-window-eastern-day-db.test.js does: the
// zone it picks always sits on a different date from Eastern at the moment
// the test runs (UTC+14 when its date is already tomorrow, otherwise UTC-12,
// which is still yesterday). A committee open for exactly one day, today's
// Eastern date, then stays open in every zone only when the helper uses the
// Eastern day; the session-day helper found it already ended (UTC+14, the
// hosted case after 7 PM Eastern on its last day) or not yet started (UTC-12).
// Since #7663 a steward grant always names a unit, so the staff kind that
// reaches a committee's member-contact records through one committee scope
// is a coordinator, advisor, admin or VP; the proof uses a coordinator.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { sourceTransactionProblem } from "../scripts/hosted-migration-apply-runner.mjs";
import { fnBody, latestFnBody, loadMigrationSql } from "./helpers/migration.js";

const HELPER = "private.chapter_member_contact_container_allowed";
const sql = loadMigrationSql("committee_member_contact_window_eastern_day");
const predecessor = loadMigrationSql("20261113147000_unit_steward_member_contact_records_in_unit");

describe("committee member-contact window migration (static)", () => {
  it("is one guarded transaction that restates only the helper", () => {
    expect(sourceTransactionProblem(sql)).toBeNull();
    expect(sql).toContain(`raise exception 'unreviewed predecessor: ${HELPER}' using errcode = '55000';`);
    expect(sql).toContain(`raise exception 'stale trigger receipt: ${HELPER}' using errcode = '55000';`);
    expect(sql.match(/create\s+(?:or\s+replace\s+)?function\s+/giu)).toHaveLength(1);
    expect(sql).not.toMatch(/^\s*(?:grant|revoke|alter|drop)\s/imu);
    expect(latestFnBody(HELPER)).toBe(fnBody(sql, HELPER));
  });

  it("changes only the two committee window comparisons and drops their utc-day comments", () => {
    const before = fnBody(predecessor, HELPER);
    const after = fnBody(sql, HELPER);
    expect(after).not.toContain("current_date");
    expect(after).not.toMatch(/utc-day/iu);
    expect(after).toContain("(committee.starts_on is null or committee.starts_on<=(select private.eastern_day()))");
    expect(after).toContain("(committee.ends_on is null or committee.ends_on>=(select private.eastern_day()))");
    const normalise = (body) => body
      .replace(/^CREATE FUNCTION /u, "CREATE OR REPLACE FUNCTION ")
      .replace(/\s*--\s*utc-day:[^\n]*/gu, "")
      .replaceAll("current_date", "(select private.eastern_day())");
    expect(after).toBe(normalise(before));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the committee member-contact check reads the Eastern day on a disposable database", () => {
  let db;
  let easternToday;
  let offZone;
  const f = { org: randomUUID(), people: {}, committees: {} };
  f.chapter = `committee-contact-${f.org.slice(0, 8)}`;
  const ZONES = () => ["UTC", offZone, "America/New_York"];

  // Runs fn as the named person in a session pinned to timeZone, inside a
  // savepoint that is always rolled back unless keep is set.
  async function inZone(name, timeZone, fn, { keep = false } = {}) {
    await db.query("savepoint committee_contact_zone");
    try {
      await db.query("select set_config('TimeZone', $1, true)", [timeZone]);
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: f.people[name].id, session_id: f.people[name].session, role: "authenticated", aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const value = await fn();
      await db.query("reset role");
      if (keep) await db.query("release savepoint committee_contact_zone");
      else await db.query("rollback to savepoint committee_contact_zone");
      return { code: "", value, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint committee_contact_zone");
      return { code: error.code || "?", value: undefined, message: error.message || "" };
    } finally {
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
    }
  }
  const one = async (query, values = []) => (await db.query(query, values)).rows[0]?.v;
  const save = (id, body, version, committee) => one(
    "select public.save_scoped_institutional_record($1,'member_contact','Fictional committee contact',$2,now(),'staff','save',false,null,$3,'[]'::jsonb,null,$4) v",
    [id, body, version, committee],
  );
  const helper = (committee) => one(`select ${HELPER}($1, null, $2::uuid) v`, [f.chapter, committee]);
  const workspaceIds = async () => new Set(((await one("select public.get_institutional_records_workspace() v"))?.records ?? []).map((row) => row.id));
  const policyIds = async () => new Set((await db.query("select id from public.chapter_records where chapter_id=$1", [f.chapter])).rows.map((row) => row.id));

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "committee-member-contact-eastern-day-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    const { rows: [clock] } = await db.query(
      `select (now() at time zone 'America/New_York')::date::text as today,
              case when (now() at time zone 'Etc/GMT-14')::date <> (now() at time zone 'America/New_York')::date
                   then 'Etc/GMT-14' else 'Etc/GMT+12' end as off_zone`,
    );
    easternToday = clock.today;
    offZone = clock.off_zone;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Committee Contact Local')", [f.org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9931)", [f.chapter, f.org]);
    // One coordinator per committee: a person holds one scope per chapter and role.
    for (const name of ["today", "ended", "later", "member"]) {
      const id = randomUUID();
      const session = randomUUID();
      f.people[name] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, f.chapter, `Fictional ${name}`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, f.chapter]);
    }
    // today: open on today's Eastern date only. ended: ended yesterday
    // (Eastern). later: starts tomorrow (Eastern).
    for (const [key, start, end] of [["today", 0, 0], ["ended", -3, -1], ["later", 1, 3]]) {
      const id = randomUUID();
      f.committees[key] = id;
      await db.query(
        `insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on,ends_on)
         values($1,$2,$3,'Committee window proof',$4::date+$5::integer,$4::date+$6::integer)`,
        [id, f.chapter, `Fictional ${key} committee`, easternToday, start, end],
      );
      await db.query("insert into private.chapter_committee_members(committee_id,chapter_id,user_id) values($1,$2,$3)", [id, f.chapter, f.people.member.id]);
      for (const table of ["member_roles", "member_role_chapters"]) {
        await db.query(`insert into public.${table}(user_id,role,chapter_id) values($1,'coordinator',$2)`, [f.people[key].id, f.chapter]);
      }
      await db.query(
        "insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id,committee_id) values($1,$2,'coordinator',null,$3)",
        [f.people[key].id, f.chapter, id],
      );
    }
    // A member-contact record of the one-day committee, saved in an Eastern session.
    const created = await inZone("today", "America/New_York", () => save(null, "Fictional first contact", null, f.committees.today), { keep: true });
    expect(created.code, created.message).toBe("");
    f.record = created.value.id;
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("picks a session time zone that sits on another date from Eastern right now", async () => {
    const { rows: [zone] } = await db.query("select (now() at time zone $1)::date::text as there", [offZone]);
    expect(zone.there).not.toBe(easternToday);
  });

  it("admits a coordinator scoped to a committee open today, in every session time zone", async () => {
    for (const timeZone of ZONES()) {
      const result = await inZone("today", timeZone, () => helper(f.committees.today));
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      expect(result.value, timeZone).toBe(true);
    }
  });

  it("refuses a coordinator whose committee ended yesterday or starts tomorrow on the Eastern day, in every session time zone", async () => {
    for (const timeZone of ZONES()) {
      for (const key of ["ended", "later"]) {
        const result = await inZone(key, timeZone, () => helper(f.committees[key]));
        expect(result.code, `${timeZone} ${key}: ${result.message}`).toBe("");
        expect(result.value, `${timeZone} ${key}`).toBe(false);
      }
    }
  });

  it("keeps the record in the records workspace and the chapter_records_select policy, in every session time zone", async () => {
    for (const timeZone of ZONES()) {
      const result = await inZone("today", timeZone, async () => ({ workspace: await workspaceIds(), policy: await policyIds() }));
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      expect(result.value.workspace.has(f.record), `${timeZone} workspace`).toBe(true);
      expect(result.value.policy.has(f.record), `${timeZone} policy`).toBe(true);
    }
  });

  it("saves a new and an existing member-contact record of the committee, in every session time zone", async () => {
    for (const timeZone of ZONES()) {
      const result = await inZone("today", timeZone, async () => ({
        created: await save(null, `Fictional contact in ${timeZone}`, null, f.committees.today),
        updated: await save(f.record, `Fictional follow-up in ${timeZone}`, 1, f.committees.today),
      }));
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      expect(result.value.created?.id, timeZone).toBeTruthy();
      expect(result.value.updated?.id, timeZone).toBe(f.record);
    }
  });

  it("leaves no other committee window reading the session day", async () => {
    const { rows } = await db.query(
      `select p.oid::regprocedure::text as fn
         from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and p.prosrc ~* '(starts_on|ends_on)[^;]{0,40}current_date|current_date[^;]{0,40}(starts_on|ends_on)'
          and p.prosrc ~* 'committee'
        order by 1`,
    );
    expect(rows.map((row) => row.fn)).toEqual([]);
  });
});
