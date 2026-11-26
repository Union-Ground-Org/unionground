// @vitest-environment node
//
// REQ-UG-RELEASE-CALENDAR-SCREEN-WITH-RELEASE-AND-HOLD-BUTTONS-20261117 (#9039).
//
// Offline half: the release calendar read is one atomic migration, callable
// only through the authenticated grant, that checks the caller before reading
// and writes nothing. Live half (disposable loopback only): a stepped-up
// platform operator reads every switch with a release time, the database time
// and the newest audit rows; a Release pressed with that time through
// public.set_platform_setting_release shows up as the operator's own audit
// row; another operator sees it as someone else's with no account id; an
// organization admin, an operator without step-up, an anonymous caller and
// the database owner route are refused.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { RELEASE_CALENDAR_RPCS } from "../src/features/operations/releaseCalendar.js";
import { stripComments } from "./helpers/migration.js";

// Found by name: the controller assigns the stamp.
const MIGRATIONS = readdirSync("supabase/migrations").filter((name) => name.endsWith("_platform_setting_release_calendar_read.sql"));
if (MIGRATIONS.length !== 1) throw new Error(`expected one platform_setting_release_calendar_read migration, found ${MIGRATIONS.length}`);
const code = stripComments(readFileSync(`supabase/migrations/${MIGRATIONS[0]}`, "utf8")).replace(/\s+/g, " ");
const READ = "public.get_platform_setting_release_calendar()";

describe("release calendar read migration (offline)", () => {
  it("is one atomic migration whose read is callable only through the authenticated grant", () => {
    expect(RELEASE_CALENDAR_RPCS.read).toBe("get_platform_setting_release_calendar");
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain(`revoke all on function ${READ} from public, anon, authenticated, service_role;`);
    expect(code).toContain(`grant execute on function ${READ} to authenticated;`);
    expect(code.match(/create (or replace )?function/gu)).toHaveLength(1);
  });

  it("checks the caller before it reads, and writes nothing", () => {
    const open = code.indexOf("as $function$") + "as $function$".length;
    const text = code.slice(open, code.indexOf("$function$", open));
    expect(code).toMatch(/ stable security definer set search_path = '' /u);
    const begin = text.indexOf(" begin ");
    const refuse = text.indexOf("if (select auth.uid()) is null then raise exception 'platform operator required' using errcode = '42501';");
    const caller = text.indexOf("caller := private.platform_setting_release_caller(null);");
    const firstRead = text.indexOf("from public.platform_setting_definitions");
    expect(begin).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(begin);
    expect(caller).toBeGreaterThan(refuse);
    expect(firstRead).toBeGreaterThan(caller);
    expect(text).not.toMatch(/\b(insert|update|delete|truncate)\b/iu);
    // No other operator's account id leaves the database.
    expect(text).not.toContain("'actorUserId'");
    expect(text).toContain("'byYou', c.actor_user_id is not distinct from caller");
    expect(text).toContain("limit 50");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const SWITCH = "features.civic.watchlist";
const DATED = "features.intelligence.weekly_digest";

live("release calendar read on a disposable database", () => {
  let c;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "release-calendar-read-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  const q = async (text, values = []) => (await c.query(text, values)).rows;
  async function call(text, values = [], as = null) {
    await c.query("savepoint call");
    try {
      const claims = as?.id ? { role: "authenticated", sub: as.id, session_id: as.session, aal: as.aal ?? "aal2" } : as?.claims ?? null;
      if (claims) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      if (as?.role || as?.id) await c.query(`set local role ${as.role ?? "authenticated"}`);
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");
      await c.query("release savepoint call");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, message: error.message };
    }
  }

  async function person({ operator = false, admin = false, aal = "aal2" } = {}) {
    const user = { id: randomUUID(), session: randomUUID(), aal };
    await q("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())", [user.session, user.id, aal]);
    if (operator) await q("insert into private.compass_platform_operators(user_id, granted_note) values ($1, 'release calendar read proof operator')", [user.id]);
    if (admin) {
      const org = { id: randomUUID(), chapter: `release-read-${randomUUID().slice(0, 8)}` };
      await q("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
      await q("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98314)", [org.chapter, org.id]);
      await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [org.id, user.id]);
    }
    return user;
  }

  const read = "select public.get_platform_setting_release_calendar() r";
  const setRelease = "select public.set_platform_setting_release($1, $2::timestamptz, $3, $4) r";

  it("shows an operator every switch with a release time, and a Release pressed with its time as the operator's own audit row", async () => {
    await c.query("begin");
    try {
      const operator = await person({ operator: true });
      const other = await person({ operator: true });
      await q("update public.platform_setting_definitions set release_at = 'infinity' where key = $1", [SWITCH]);
      await q("update public.platform_setting_definitions set release_at = now() + interval '30 days' where key = $1", [DATED]);

      const before = await call(read, [], operator);
      expect(before.ok).toBe(true);
      const calendar = before.rows[0].r;
      expect(Number.isNaN(Date.parse(calendar.now))).toBe(false);
      const listed = Object.fromEntries(calendar.switches.map((row) => [row.key, row]));
      expect(listed[SWITCH]).toMatchObject({ releaseAt: "infinity", held: true });
      expect(listed[DATED]).toMatchObject({ held: true });
      expect(typeof listed[SWITCH].label).toBe("string");
      const expected = (await q("select key from public.platform_setting_definitions where release_at is not null order by key")).map((row) => row.key);
      expect(calendar.switches.map((row) => row.key)).toEqual(expected);

      // A release at the read's database time, as an operator (no typed name).
      const pressed = await call(setRelease, [SWITCH, calendar.now, "Owner pressed release", null], operator);
      expect(pressed).toMatchObject({ ok: true, rows: [{ r: { key: SWITCH, held: false, updated: true } }] });

      const after = (await call(read, [], operator)).rows[0].r;
      expect(after.switches.find((row) => row.key === SWITCH)).toMatchObject({ held: false });
      expect(after.changes[0]).toMatchObject({ key: SWITCH, action: "set", previousReleaseAt: "infinity", reason: "Owner pressed release", byYou: true, actorName: null });
      expect(after.changes[0]).not.toHaveProperty("actorUserId");
      expect(JSON.stringify(after)).not.toContain(operator.id);

      // Held again with no date.
      expect((await call(setRelease, [SWITCH, "infinity", "Not yet", null], operator)).ok).toBe(true);
      const seen = (await call(read, [], other)).rows[0].r;
      expect(seen.switches.find((row) => row.key === SWITCH)).toMatchObject({ releaseAt: "infinity", held: true });
      expect(seen.changes[0]).toMatchObject({ key: SWITCH, releaseAt: "infinity", reason: "Not yet", byYou: false, actorName: null });
      expect(JSON.stringify(seen)).not.toContain(operator.id);
    } finally {
      await c.query("rollback");
    }
  });

  it("refuses everyone but a stepped-up platform operator, the database owner route included", async () => {
    await c.query("begin");
    try {
      const admin = await person({ admin: true });
      const stale = await person({ operator: true, aal: "aal1" });
      for (const [label, as] of [["organization admin", admin], ["aal1 operator", stale]]) {
        expect(await call(read, [], as), label).toMatchObject({ ok: false, code: "42501" });
        const refused = await call(setRelease, [SWITCH, "infinity", "x", null], as);
        expect(refused, label).toMatchObject({ ok: false, code: "42501" });
      }
      expect(await call(read, [], { role: "anon", claims: { role: "anon" } })).toMatchObject({ ok: false, code: "42501" });
      // The owner route (no request JWT) has the command line, not this read.
      expect(await call(read)).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await c.query("rollback");
    }
  });
});
