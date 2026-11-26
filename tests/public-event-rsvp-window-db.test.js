// @vitest-environment node
//
// BUG-UG-PUBLIC-EVENT-RSVP-RPC-ACCEPTS-SUBMISSIONS-ENDED-FAR-PAST-PUBLISHED-20260921
//
// The behavioural half of the repair, against a disposable database: the same
// service-role call that /api/public/event-rsvp makes must persist a lead row
// for a meeting that has not ended and persist nothing for one that has, while
// returning the identical accepted envelope either way.
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const ID = {
  org: "50902201-0000-4000-8000-000000000001",
  staff: "50902201-0000-4000-8000-000000000101",
};
const UPCOMING = "rsvp-window-upcoming";
const ENDED = "rsvp-window-ended";
const OPEN_ENDED_PAST = "rsvp-window-open-ended-past";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

function scope(label) {
  return createHash("sha256").update(`public-event-rsvp-window:${label}`).digest("hex");
}

live("public event RSVP time window on a disposable database", () => {
  let db;

  async function rsvp(eventId, email) {
    await db.query("savepoint rsvp_window");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await db.query("set local role service_role");
      const result = await db.query(
        "select public.submit_public_event_rsvp($1,$2,$3,'en','public-event-rsvp','',$4,$5) as reply",
        [eventId, email, "Ada Lovelace", scope("network"), scope(email)],
      );
      await db.query("reset role");
      await db.query("release savepoint rsvp_window");
      return { code: "", reply: result.rows[0].reply, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint rsvp_window");
      return { code: error.code || "?", reply: null, message: error.message || "" };
    }
  }

  async function rows(eventId) {
    return (await db.query("select count(*)::int count from public.public_event_rsvps where event_id=$1", [eventId]))
      .rows[0].count;
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "public-event-rsvp-window-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query("insert into auth.users(id,email) values($1,'rsvp-window-staff@example.invalid')", [ID.staff]);
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'rsvp-window-org','RSVP window proof',$2)",
      [ID.org, ID.staff],
    );
    await db.query(
      `insert into public.public_site_records(
         id,kind,title_en,title_es,body_en,body_es,starts_at,ends_at,location_en,location_es,
         is_published,published_at,created_by,organization_id
       ) values
        ($1,'meeting','Upcoming meeting','Reunión próxima','Meeting body','Contenido',
         now() + interval '1 day', now() + interval '2 days','Proof hall','Salón',true,now(),$4,$5),
        ($2,'meeting','Ended meeting','Reunión terminada','Meeting body','Contenido',
         now() - interval '120 days', now() - interval '119 days','Proof hall','Salón',true,now(),$4,$5),
        ($3,'meeting','Open ended meeting','Reunión sin fin','Meeting body','Contenido',
         now() - interval '3 hours', null,'Proof hall','Salón',true,now(),$4,$5)`,
      [UPCOMING, ENDED, OPEN_ENDED_PAST, ID.staff, ID.org],
    );
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("records an RSVP for a published meeting that has not ended", async () => {
    const result = await rsvp(UPCOMING, "upcoming@example.invalid");
    expect(result.code, result.message).toBe("");
    expect(result.reply).toEqual({ accepted: true });
    expect(await rows(UPCOMING)).toBe(1);
  });

  it("records nothing for a published meeting that ended months ago, and still answers accepted", async () => {
    const result = await rsvp(ENDED, "ended@example.invalid");
    expect(result.code, result.message).toBe("");
    expect(result.reply).toEqual({ accepted: true });
    expect(await rows(ENDED)).toBe(0);
  });

  it("falls back to starts_at when a meeting carries no end time", async () => {
    const result = await rsvp(OPEN_ENDED_PAST, "open-ended@example.invalid");
    expect(result.code, result.message).toBe("");
    expect(result.reply).toEqual({ accepted: true });
    expect(await rows(OPEN_ENDED_PAST)).toBe(0);
  });

  it("consumes no per-event rate-limit budget for an ended meeting", async () => {
    const eventScope = (await db.query(
      `select pg_catalog.encode(
         extensions.digest(pg_catalog.convert_to($1::text || ':' || $2::text, 'UTF8'), 'sha256'), 'hex') as hash`,
      [ID.org, ENDED],
    )).rows[0].hash;
    expect((await db.query(
      "select count(*)::int count from private.public_event_rsvp_limits where scope_hash=$1",
      [eventScope],
    )).rows[0].count).toBe(0);
  });
});
