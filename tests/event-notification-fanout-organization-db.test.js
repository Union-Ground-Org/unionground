// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { verifyHistoricalEventModelReplay } from "./helpers/event-model-replay.js";

const migration = readFileSync(
  new URL("../supabase/migrations/20260924020000_event_notification_fanout_organization_bound.sql", import.meta.url),
  "utf8",
);
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

describe("event notification fan-out organization bound (static)", () => {
  it("joins active organization membership before chapter, region, or across-agency visibility", () => {
    const start = migration.indexOf("select recipient.id");
    const recipientQuery = migration.slice(start, migration.indexOf("loop", start));
    const membership = recipientQuery.indexOf("join public.organization_memberships recipient_membership");
    const membershipStatus = recipientQuery.indexOf("recipient_membership.status = 'active'");
    const tenantBound = recipientQuery.indexOf(
      "recipient_chapter.organization_id = publisher_chapter.organization_id",
    );
    const acrossAgencies = recipientQuery.indexOf("p_is_public_across_agencies");
    const region = recipientQuery.indexOf("recipient_chapter.region = publisher_chapter.region");
    expect(membership).toBeGreaterThan(-1);
    expect(membershipStatus).toBeGreaterThan(membership);
    expect(tenantBound).toBeGreaterThan(membershipStatus);
    expect(acrossAgencies).toBeGreaterThan(tenantBound);
    expect(region).toBeGreaterThan(acrossAgencies);
    expect(recipientQuery).toContain("recipient_membership.user_id = recipient.id");
    expect(recipientQuery).toContain(
      "recipient_membership.organization_id = publisher_chapter.organization_id",
    );
    expect(recipientQuery).toContain("recipient.chapter_id = caller_chapter");
  });
});

async function seed(client) {
  const ids = Object.fromEntries([
    "orgA", "orgB", "admin", "memberA1", "memberA2", "memberA3", "memberB",
    "adminSession", "memberA1Session", "memberA2Session", "memberA3Session", "memberBSession",
  ].map((key) => [key, randomUUID()]));
  ids.chapterA1 = `fanout-a1-${ids.orgA.slice(0, 8)}`;
  ids.chapterA2 = `fanout-a2-${ids.orgA.slice(0, 8)}`;
  ids.chapterA3 = `fanout-a3-${ids.orgA.slice(0, 8)}`;
  ids.chapterB = `fanout-b1-${ids.orgB.slice(0, 8)}`;

  const people = [
    [ids.admin, ids.adminSession, ids.chapterA1, ids.orgA, ["admin"]],
    [ids.memberA1, ids.memberA1Session, ids.chapterA1, ids.orgA, []],
    [ids.memberA2, ids.memberA2Session, ids.chapterA2, ids.orgA, []],
    [ids.memberA3, ids.memberA3Session, ids.chapterA3, ids.orgA, []],
    [ids.memberB, ids.memberBSession, ids.chapterB, ids.orgB, []],
  ];

  for (const [user, session] of people) {
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [
      user,
      `${user}@example.invalid`,
    ]);
    await client.query(
      "insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",
      [session, user],
    );
    await client.query(
      "insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic fan-out factor','totp','verified',now(),now())",
      [randomUUID(), user],
    );
  }

  await client.query(
    "insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3),($4,$5,$5,$6)",
    [ids.orgA, `fanout-a-${ids.orgA}`, ids.admin, ids.orgB, `fanout-b-${ids.orgB}`, ids.memberB],
  );
  await client.query(
    `insert into public.chapters(id,name,slug,region,organization_id,is_default,order_index) values
      ($1,$1,$1,'west',$5,false,9911),
      ($2,$2,$2,'west',$5,false,9912),
      ($3,$3,$3,'east',$5,false,9913),
      ($4,$4,$4,'west',$6,false,9914)`,
    [ids.chapterA1, ids.chapterA2, ids.chapterA3, ids.chapterB, ids.orgA, ids.orgB],
  );
  await client.query(
    "insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true),(true,$2,true)",
    [ids.orgA, ids.orgB],
  );

  for (const [user, , chapter, org, roles] of people) {
    await client.query(
      "insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",
      [org, user],
    );
    await client.query(
      "insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",
      [user, chapter],
    );
    await client.query(
      "update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1",
      [user, chapter, `Fanout ${user.slice(0, 8)}`],
    );
    for (const role of roles) {
      await client.query(
        "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)",
        [org, user, role],
      );
      await client.query(
        "insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing",
        [user, role, chapter],
      );
      await client.query(
        "insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing",
        [user, role, chapter],
      );
    }
  }

  return ids;
}

async function asUser(client, user, session) {
  await client.query("reset role");
  await client.query(
    "select set_config('request.jwt.claims',$1,true)",
    [JSON.stringify({ role: "authenticated", sub: user, session_id: session, aal: "aal2" })],
  );
  await client.query("set local role authenticated");
}

async function eventRecipients(client, userIds, excludeIds = []) {
  const result = await client.query(
    `select n.id, n.user_id, recipient_chapter.organization_id
       from public.member_notifications n
       join public.member_profiles recipient on recipient.id = n.user_id
       join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      where n.user_id = any($1::uuid[])
        and n.kind = 'events'
        and not (n.id = any($2::uuid[]))`,
    [userIds, excludeIds],
  );
  return result.rows;
}

async function withFanoutDb(run) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
  });
  await client.connect();
  await client.query("begin");
  try {
    const ids = await seed(client);
    await run(client, ids);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

async function createEvent(client, ids, { id, title, code, isPublic, isPublicAcrossAgencies }) {
  await asUser(client, ids.admin, ids.adminSession);
  await client.query(
    "select public.create_member_event($1,$2,now() + interval '1 day','Hall',$3,$4,$5,$6)",
    [id, title, `${title} fan-out bound proof`, code, isPublic, isPublicAcrossAgencies],
  );
  await client.query("reset role");
}

function expectOrgBound(rows, ids, expectedUserIds) {
  expect(new Set(rows.map((row) => row.organization_id))).toEqual(new Set([ids.orgA]));
  expect(new Set(rows.map((row) => row.user_id))).toEqual(new Set(expectedUserIds));
  expect(rows.some((row) => row.user_id === ids.memberB)).toBe(false);
}

live("event notification fan-out on a disposable database", () => {
  it("attributes each visibility class to its own create_member_event call", async () => {
    await withFanoutDb(async (client, ids) => {
      const audience = [ids.admin, ids.memberA1, ids.memberA2, ids.memberA3, ids.memberB];
      const suffix = ids.orgA.slice(0, 8);
      const seen = [];

      await createEvent(client, ids, {
        id: `fanout-chapter-${suffix}`,
        title: "Chapter bound proof",
        code: "SG-CHP1",
        isPublic: false,
        isPublicAcrossAgencies: false,
      });
      const chapterOnly = await eventRecipients(client, audience, seen);
      expectOrgBound(chapterOnly, ids, [ids.memberA1]);
      seen.push(...chapterOnly.map((row) => row.id));

      await createEvent(client, ids, {
        id: `fanout-public-${suffix}`,
        title: "Public bound proof",
        code: "SG-PUB1",
        isPublic: true,
        isPublicAcrossAgencies: false,
      });
      const regionalPublic = await eventRecipients(client, audience, seen);
      expectOrgBound(regionalPublic, ids, [ids.memberA1, ids.memberA2]);
      seen.push(...regionalPublic.map((row) => row.id));

      await createEvent(client, ids, {
        id: `fanout-across-${suffix}`,
        title: "Across bound proof",
        code: "SG-XAG1",
        isPublic: false,
        isPublicAcrossAgencies: true,
      });
      const acrossAgency = await eventRecipients(client, audience, seen);
      expectOrgBound(acrossAgency, ids, [ids.memberA1, ids.memberA2, ids.memberA3]);
    });
  });

  it("excludes a revoked organization member whose chapter_id is still set", async () => {
    await withFanoutDb(async (client, ids) => {
      const audience = [ids.admin, ids.memberA1, ids.memberA2, ids.memberA3, ids.memberB];
      const suffix = ids.orgA.slice(0, 8);

      await client.query(
        "update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2",
        [ids.orgA, ids.memberA1],
      );
      const leftoverChapter = await client.query(
        "select chapter_id from public.member_profiles where id = $1",
        [ids.memberA1],
      );
      expect(leftoverChapter.rows[0].chapter_id).toBe(ids.chapterA1);

      await createEvent(client, ids, {
        id: `fanout-revoked-${suffix}`,
        title: "Revoked membership bound proof",
        code: "SG-REV1",
        isPublic: false,
        isPublicAcrossAgencies: true,
      });
      const rows = await eventRecipients(client, audience);
      expectOrgBound(rows, ids, [ids.memberA2, ids.memberA3]);
      expect(rows.some((row) => row.user_id === ids.memberA1)).toBe(false);
    });
  });
});

async function refused(client, sql, args = []) {
  await client.query('savepoint event_refusal');
  try { await client.query(sql, args); return null; }
  catch (error) { await client.query('rollback to savepoint event_refusal'); return error.code; }
  finally { await client.query('release savepoint event_refusal'); }
}

live('event model on a disposable database', () => {
  it('reapplies without error and preserves the installed definitions', async () => {
    const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
    await client.connect();
    try {
      await verifyHistoricalEventModelReplay(client);
    } finally { await client.end(); }
  });
  it('stores dates without hours/codes and rejects attendance and invalid ranges', async () => {
    await withFanoutDb(async (client, ids) => {
      await asUser(client, ids.admin, ids.adminSession);
      for (const kind of ['deadline', 'date_only']) {
        const id = `${kind.replace('_', '-')}-${ids.orgA.slice(0, 8)}`;
        await client.query("select public.create_member_event_model($1,'Dated item',null,'Online','Submit',null,false,false,$2,'2027-02-01')", [id, kind]);
        await client.query('reset role');
        const row = (await client.query('select starts_at,ends_at,event_date::text,check_in_code from public.member_events where id=$1', [id])).rows[0];
        expect(row).toEqual({ starts_at: null, ends_at: null, event_date: '2027-02-01', check_in_code: null });
        await asUser(client, ids.memberA1, ids.memberA1Session);
        for (const sql of ["select public.rsvp_to_event($1,'going')", "select public.check_in_to_event($1,'SG-FAKE')", "select public.request_event_checkin_token($1)"]) expect(await refused(client, sql, [id])).toBe('22023');
        await asUser(client, ids.admin, ids.adminSession);
      }
      expect(await refused(client, "select public.create_member_event_model('bad-range','Meeting',now(),'Hall','Agenda','SG-ABC',false,false,'meeting',null,now()-interval '1 hour')")).toBe('22023');
      expect(await refused(client, "select public.create_member_event_model('bad-count','Meeting',now(),'Hall','Agenda','SG-ABC',false,false,'meeting',null,null,13)")).toBe('22023');
      await client.query('reset role');
      expect((await client.query("select count(*)::int n from public.member_event_rsvps where event_id like $1 or event_id like $2", [`deadline-${ids.orgA.slice(0,8)}`, `date-only-${ids.orgA.slice(0,8)}`])).rows[0].n).toBe(0);
    });
  });
  it('clamps monthly dates, preserves wall time across DST, and isolates each RSVP/code/lifecycle', async () => {
    await withFanoutDb(async (client, ids) => {
      await asUser(client, ids.admin, ids.adminSession);
      const value = (await client.query("select public.create_member_event_model($1,'Monthly meeting','2027-01-31T15:00:00Z','Hall','Agenda','SG-FIRST',false,true,'meeting',null,'2027-01-31T16:00:00Z',3,'America/New_York') value", [`monthly-${ids.orgA.slice(0,8)}`])).rows[0].value;
      const [first, second, third] = value.occurrenceIds;
      await client.query('reset role');
      const notices = await eventRecipients(client, [ids.memberA1, ids.memberA2, ids.memberA3, ids.memberB]);
      expectOrgBound(notices, ids, [ids.memberA1, ids.memberA2, ids.memberA3]);
      expect(notices).toHaveLength(3); // One notice per recipient, not per occurrence.
      const events = (await client.query("select id,starts_at,ends_at,check_in_code,series_id,chapter_id from public.member_events where id=any($1::text[]) order by starts_at", [value.occurrenceIds])).rows;
      expect(events.map((e) => e.starts_at.toISOString())).toEqual(['2027-01-31T15:00:00.000Z','2027-02-28T15:00:00.000Z','2027-03-31T14:00:00.000Z']);
      expect(new Set(events.map((e) => e.series_id)).size).toBe(1);
      expect(new Set(events.map((e) => e.check_in_code)).size).toBe(3);
      expect(events.every((e) => e.chapter_id === ids.chapterA1 && e.ends_at - e.starts_at === 3600000)).toBe(true);
      // Bring only these two dates into the real check-in window.
      const inWindow = (await client.query("update public.member_events set starts_at=now()+interval '1 hour',ends_at=now()+interval '2 hours' where id=any($1::text[]) returning id,starts_at", [[first, second]])).rows;
      events[0].starts_at = inWindow.find((e) => e.id === first).starts_at;
      await asUser(client, ids.memberA1, ids.memberA1Session);
      await client.query("select public.rsvp_to_event($1,'going')", [first]);
      await client.query('select public.check_in_to_event($1,$2)', [first, events[0].check_in_code]);
      expect((await client.query('select public.check_in_to_event($1,$2) value', [second, events[0].check_in_code])).rows[0].value.refused).toBe(true);
      await client.query('reset role');
      expect((await client.query('select event_id from public.member_event_rsvps where event_id=any($1::text[])', [value.occurrenceIds])).rows).toEqual([{ event_id: first }]);
      await asUser(client, ids.admin, ids.adminSession);
      const counts = (await client.query('select public.get_admin_events() value')).rows[0].value.filter((e) => value.occurrenceIds.includes(e.id));
      expect(counts.find((e) => e.id === first).rsvpCount).toBe(1);
      expect(counts.find((e) => e.id === second).rsvpCount).toBe(0);
      expect(counts.find((e) => e.id === first).checkinCount).toBe(1);
      expect(counts.find((e) => e.id === second).checkinCount).toBe(0);
      await client.query("select public.update_member_event_model($1,p_title => 'Second date changed')", [second]);
      await client.query("select public.cancel_member_event($1,'Only this date')", [third]);
      await client.query('reset role');
      const unchanged = (await client.query('select title,cancelled_at,starts_at from public.member_events where id=$1', [first])).rows[0];
      expect(unchanged).toMatchObject({ title: 'Monthly meeting', cancelled_at: null, starts_at: events[0].starts_at });
      await asUser(client, ids.memberB, ids.memberBSession);
      expect((await client.query('select id from public.member_events where id=any($1::text[])', [value.occurrenceIds])).rows).toEqual([]);
      expect(await refused(client, "select public.rsvp_to_event($1,'going')", [second])).toBe('22023');
    });
  });
  it('keeps check-in unavailable on every monthly date when no code is supplied', async () => {
    await withFanoutDb(async (client, ids) => {
      await asUser(client, ids.admin, ids.adminSession);
      const value = (await client.query("select public.create_member_event_model($1,'Monthly reminder',now()+interval '1 hour','Online','Agenda',null,false,false,'meeting',null,null,3,'America/New_York') value", [`no-code-${ids.orgA.slice(0,8)}`])).rows[0].value;
      expect(value.occurrenceIds).toHaveLength(3);
      await client.query('reset role');
      const rows = (await client.query('select check_in_code,check_in_offered from public.member_events where id=any($1::text[])', [value.occurrenceIds])).rows;
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.check_in_code === null && row.check_in_offered === false)).toBe(true);
      await asUser(client, ids.memberA1, ids.memberA1Session);
      for (const id of value.occurrenceIds) {
        expect(await refused(client, "select public.check_in_to_event($1,'SG-FAKE')", [id])).toBe('22023');
        expect(await refused(client, 'select public.request_event_checkin_token($1)', [id])).toBe('22023');
      }
      await client.query("select public.rsvp_to_event($1,'going')", [value.occurrenceIds[0]]);
      await client.query('reset role');
      expect((await client.query('select event_id from public.member_event_rsvps where event_id=any($1::text[])', [value.occurrenceIds])).rows).toEqual([{ event_id: value.occurrenceIds[0] }]);
    });
  });
  it('allows an end to be cleared and refuses cross-organization authoring', async () => {
    await withFanoutDb(async (client, ids) => {
      await asUser(client, ids.admin, ids.adminSession);
      const id = `end-${ids.orgA.slice(0,8)}`;
      await client.query("select public.create_member_event_model($1,'Meeting','2027-01-31T15:00:27Z','Hall','Agenda','SG-FIRST',false,false,'meeting',null,'2027-01-31T16:00:37Z')", [id]);
      await client.query('select public.update_member_event_model($1,p_schedule => $2::jsonb)', [id, JSON.stringify({ kind: 'meeting', startsAt: '2027-01-31T15:00:27Z', eventDate: null, endsAt: null })]);
      await client.query('reset role');
      expect((await client.query('select starts_at,ends_at from public.member_events where id=$1', [id])).rows[0]).toEqual({ starts_at: new Date('2027-01-31T15:00:27Z'), ends_at: null });
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2)", [ids.memberB, ids.chapterB]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2)", [ids.memberB, ids.chapterB]);
      await asUser(client, ids.memberB, ids.memberBSession);
      expect(await refused(client, "select public.update_member_event_model($1,p_title => 'Foreign edit')", [id])).toBe('22023');
    });
  });
});
