// @vitest-environment node
// Live proof of
// 20261003053000_integrations_wallet_calendar_drive_checkoff on an owned
// disposable database. Every fixture rolls back with the outer transaction.
//   REQ-UG-GOOGLE-WALLET-PASS-20261001
//   REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001
//   REQ-UG-DRIVE-PER-CASE-FOLDERS-20261001
//   REQ-UG-COOP-CHECKOFF-LISTS-20261001
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stripOuterTransaction } from "../scripts/hosted-migration-apply-runner.mjs";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("restored integrations on an owned disposable database", () => {
  let db;
  const people = ["admin", "steward", "steward2", "member1", "member2", "outsider"];
  const id = Object.fromEntries([...people, ...people.map((p) => `${p}Session`), "org", "otherOrg", "task", "task2", "case", "restrictedCase"].map((key) => [key, randomUUID()]));
  const chapter = `l10-${id.org}`;
  const otherChapter = `l10-other-${id.otherOrg}`;
  const publicEvent = `l10-pub-${id.org}`.slice(0, 60);
  const privateEvent = `l10-priv-${id.org}`.slice(0, 60);

  async function as(actor, sql, params = []) {
    await db.query("savepoint l10_call");
    try {
      if (actor === "service") {
        await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
        await db.query("set local role service_role");
      } else if (actor === "anon") {
        await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "anon" })]);
        await db.query("set local role anon");
      } else {
        await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id[actor], role: "authenticated", session_id: id[`${actor}Session`], aal: "aal2" })]);
        await db.query("set local role authenticated");
      }
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint l10_call");
      return { code: "", rows: result.rows, data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint l10_call");
      await db.query("release savepoint l10_call");
      return { code: error.code, message: error.message };
    }
  }

  const setting = (key, value, org = id.org) => db.query(
    "insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,$3::jsonb,$4) on conflict (organization_id,setting_key) do update set value=excluded.value",
    [org, key, JSON.stringify(value), id.admin],
  );

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect();
    await db.query("begin");
    await releaseCalendarHolds(db);
    for (const person of people) {
      await db.query("insert into auth.users(id,email) values($1,$2)", [id[person], `${id[person]}@example.invalid`]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [id[`${person}Session`], id[person]]);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'L10 proof','totp','verified',now(),now())", [randomUUID(), id[person]]);
    }
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,'Riverside Workers',$3)", [id.org, `l10-${id.org}`, id.admin]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,'Other Union',$3)", [id.otherOrg, `l10-other-${id.otherOrg}`, id.outsider]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,'North Chapter',$1,$2,false,9970)", [chapter, id.org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,'Other Chapter',$1,$2,false,9971)", [otherChapter, id.otherOrg]);
    for (const person of people) {
      const [org, ch] = person === "outsider" ? [id.otherOrg, otherChapter] : [id.org, chapter];
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id[person]]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id[person], ch]);
      await db.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id[person], ch, `Person ${person}`]);
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [id.org, id.admin]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$3)", [id.org, id.steward, id.admin]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$3)", [id.org, id.steward2, id.admin]);

    await db.query("set local session_replication_role = replica");
    await db.query("insert into public.chapter_tasks(id,chapter_id,task_number,title,created_by,updated_by,workstream) values($1,$3,99001,'Phone bank',$4,$4,'General'),($2,$3,99002,'Door knock',$4,$4,'General')", [id.task, id.task2, chapter, id.steward]);
    await db.query(
      `insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id,is_public)
       values($1,'Rally',now()+interval '3 days','Hall','Bring signs','SG-L10A',99901,$3,true),
             ($2,'Chapter meeting',now()+interval '5 days','Room 2','Members only','SG-L10B',99902,$3,false)`,
      [publicEvent, privateEvent, chapter],
    );
    await db.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,steward_user_id,is_restricted,restriction_reason,restricted_at,restricted_by)
       values($1,$3,'GR-7','Overtime','grievance',$4,$5,'Step 1','Art 5','active',$6,false,null,null,null),
             ($2,$3,'GR-8','Sensitive','grievance',$4,$5,'Step 1','Art 9','active',$6,true,'Sensitive matter',now(),$7)`,
      [id.case, id.restrictedCase, id.member1, id.org, chapter, id.steward, id.admin],
    );
    await db.query(
      "insert into public.organization_integrations(organization_id,provider,status,credential_ref,default_settings) values($1,'google_drive','connected',$2,$3::jsonb)",
      [id.org, randomUUID(), JSON.stringify({ rootFolderId: "rootFolder1" })],
    );
    await db.query("set local session_replication_role = origin");

    //  re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, 60000);

  beforeEach(async () => { await db.query("savepoint l10_test"); });
  afterEach(async () => { await db.query("rollback to savepoint l10_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("reserves one durable Drive folder per organization, root and target", async () => {
    const sql = "select public.reserve_google_drive_filing_folder($1,$2,$3,$4,$5,$6) data";
    const group = [id.org,'rootFolder1','rootFolder1','group:Cases','Cases','generatedFirst'];
    expect((await as('admin',sql,group)).code).toBe('42501');
    expect(await as('service',sql,group)).toMatchObject({code:'',data:{folderId:'generatedFirst'}});
    expect((await as('service',sql,[...group.slice(0,5),'generatedSecond'])).data).toEqual({folderId:'generatedFirst'});
    expect((await as('service',sql,[...group.slice(0,5),null])).data).toEqual({folderId:'generatedFirst'});
    const target = [id.org,'rootFolder1','generatedFirst',`case:${id.case}`,'Case GR-7','caseGenerated'];
    expect((await as('service',sql,target)).data).toEqual({folderId:'caseGenerated'});
    expect((await as('service',sql,[...target.slice(0,4),'Renamed case','anotherId'])).data).toEqual({folderId:'caseGenerated'});
    expect((await as('service',sql,[id.otherOrg,...group.slice(1)])).code).toBe('42501');
    expect((await as('service',sql,[id.org,'otherRoot',...group.slice(2)])).code).toBe('42501');
    expect((await as('service',sql,[id.org,'rootFolder1','rootFolder1',`case:${id.case}`,'Case','badParent'])).code).toBe('42501');
    expect((await as('service',sql,[id.org,'rootFolder1','generatedFirst',`case:${id.restrictedCase}`,'Restricted','id'])).code).toBe('42501');
  });

  it("registers the five switches with the old effective defaults", async () => {
    const { rows } = await db.query("select key, default_value, category, member_visible, allowed_values from public.platform_setting_definitions where key in ('features.integrations.google_wallet_pass','features.integrations.org_calendar_push','limits.integrations.org_calendar_push_scope','features.integrations.drive_case_meeting_folders','features.tasks.coop_checkoff_lists') order by key");
    expect(rows.map((row) => [row.key, row.default_value, row.category])).toEqual([
      ["features.integrations.drive_case_meeting_folders", true, "integrations"],
      ["features.integrations.google_wallet_pass", true, "integrations"],
      ["features.integrations.org_calendar_push", true, "integrations"],
      ["features.tasks.coop_checkoff_lists", false, "general"],
      ["limits.integrations.org_calendar_push_scope", "public_events", "integrations"],
    ]);
    expect(rows.every((row) => row.member_visible === false)).toBe(true);
  });

  describe("Google Wallet pass", () => {
    it("returns the caller's own membership names and the organization switch", async () => {
      const result = await as("member1", "select public.get_my_membership_wallet_pass() data");
      expect(result.data).toEqual({ enabled: true, organizationId: id.org, chapterId: chapter, organizationName: "Riverside Workers", chapterName: "North Chapter", memberName: "Person member1" });
      await setting("features.integrations.google_wallet_pass", false);
      expect((await as("member1", "select public.get_my_membership_wallet_pass() data")).data.enabled).toBe(false);
    });

    it("refuses a caller without an active selected membership and anonymous callers", async () => {
      await db.query("update public.member_profiles set chapter_id=null where id=$1", [id.member2]);
      expect((await as("member2", "select public.get_my_membership_wallet_pass() data")).code).toBe("42501");
      expect((await as("anon", "select public.get_my_membership_wallet_pass() data")).code).toBe("42501");
    });
  });

  describe("organization calendar push", () => {
    async function connect() {
      const state = `state-${randomUUID()}`;
      const begun = await as("admin", "select public.begin_organization_calendar_oauth($1,$2,$3,now()+interval '10 minutes') data", [
        createHash("sha256").update(state).digest("hex"), "v".repeat(64), "https://example.org/api/google-activations?action=calendar-callback",
      ]);
      expect(begun.code).toBe("");
      const claimed = await as("service", "select public.claim_organization_calendar_oauth_state($1) data", [state]);
      expect(claimed.data).toMatchObject({ organizationId: id.org, userId: id.admin, codeVerifier: "v".repeat(64) });
      expect((await as("service", "select public.claim_organization_calendar_oauth_state($1) data", [state])).code).toBe("42501");
      const completed = await as("service", "select public.complete_organization_calendar_oauth($1,$2,$3,$4,$5) data", [
        id.org, id.admin, "r".repeat(40), "openid email https://www.googleapis.com/auth/calendar.events", "office@example.org",
      ]);
      expect(completed.data).toEqual({ status: "connected", provider: "google_calendar_push" });
    }
    const work = async () => (await as("service", "select public.list_organization_calendar_push_work(50, 100) data")).data
      .filter((item) => item.organizationId === id.org);

    it("shows administrators an unset connection and refuses stewards", async () => {
      const status = await as("admin", "select public.get_organization_calendar_push_status() data");
      expect(status.data).toMatchObject({ organizationId: id.org, enabled: true, scope: "public_events", connection: null, copiedEvents: 0, failingEvents: 0 });
      expect((await as("steward", "select public.get_organization_calendar_push_status() data")).code).toBe("42501");
      expect((await as("steward", "select public.begin_organization_calendar_oauth($1,$2,$3,now()+interval '5 minutes') data", ["a".repeat(64), "v".repeat(64), "https://x.invalid/cb"])).code).toBe("42501");
    });

    it("keeps service functions away from members and refuses a narrow or non-admin grant", async () => {
      expect((await as("admin", "select public.list_organization_calendar_push_work(1,1) data")).code).toBe("42501");
      expect((await as("admin", "select public.read_organization_calendar_refresh_token($1) data", [id.org])).code).toBe("42501");
      expect((await as("service", "select public.complete_organization_calendar_oauth($1,$2,$3,$4,null) data", [id.org, id.admin, "r".repeat(40), "openid email"])).code).toBe("22023");
      expect((await as("service", "select public.complete_organization_calendar_oauth($1,$2,$3,$4,null) data", [id.org, id.steward, "r".repeat(40), "https://www.googleapis.com/auth/calendar.events"])).code).toBe("42501");
    });

    it("adopts a synced legacy copy without a push, then detects an end edit and clear", async () => {
      const predecessor = fnBody(loadMigrationSql("20261003053000_"), "public.list_organization_calendar_push_work");
      await db.query(predecessor.replace("create function", "create or replace function"));
      await connect();
      await db.query("update public.member_events set ends_at = starts_at + interval '1 hour' where id = $1", [publicEvent]);
      const [{ operations: [legacy] }] = await work();
      const saveCopy = async (hash) => {
        const result = await as("service", "select public.record_organization_calendar_push_result($1,$2,'upserted','gcal1','primary',$3,null)", [id.org, publicEvent, hash]);
        expect(result.code).toBe("");
        expect(await work()).toEqual([]);
      };
      await saveCopy(legacy.contentHash);

      await db.query(stripOuterTransaction(loadMigrationSql("_preserve_organization_calendar_event_end.sql")));
      expect(await work()).toEqual([]);

      const { rows: [event] } = await db.query(
        "update public.member_events set ends_at = starts_at + interval '90 minutes' where id = $1 returning ends_at",
        [publicEvent],
      );
      const [{ operations: [edited] }] = await work();
      expect(edited).toMatchObject({ op: "upsert", eventId: publicEvent, googleEventId: "gcal1" });
      expect(new Date(edited.event.endsAt)).toEqual(event.ends_at);
      await saveCopy(edited.contentHash);

      await db.query("update public.member_events set ends_at = null where id = $1", [publicEvent]);
      const [{ operations: [cleared] }] = await work();
      expect(cleared).toMatchObject({
        op: "upsert", eventId: publicEvent, googleEventId: "gcal1",
        contentHash: legacy.contentHash, event: { endsAt: null },
      });
      await saveCopy(cleared.contentHash);
    });

    it("queues another update when only an event end changes or is cleared", async () => {
      await connect();
      const recordCopy = async (hash) => {
        const result = await as("service", "select public.record_organization_calendar_push_result($1,$2,'upserted','gcal1','primary',$3,null)", [id.org, publicEvent, hash]);
        expect(result.code).toBe("");
        expect(await work()).toEqual([]);
      };
      const [initial] = await work();
      const originalHash = initial.operations[0].contentHash;
      await recordCopy(originalHash);

      const mappedCopy = { op: "upsert", eventId: publicEvent, googleEventId: "gcal1" };
      const setEnd = async (duration) => {
        const { rows: [event] } = await db.query(
          "update public.member_events set ends_at = starts_at + $2::interval where id = $1 returning starts_at, ends_at",
          [publicEvent, duration],
        );
        const pending = await work();
        expect(pending).toEqual([expect.objectContaining({
          operations: [expect.objectContaining(mappedCopy)],
        })]);
        const update = pending[0].operations[0];
        expect(new Date(update.event.startsAt)).toEqual(event.starts_at);
        expect(new Date(update.event.endsAt)).toEqual(event.ends_at);
        return update.contentHash;
      };

      const firstEnd = await setEnd("1 hour");
      expect(firstEnd).not.toBe(originalHash);
      await recordCopy(firstEnd);

      const editedEnd = await setEnd("90 minutes");
      expect(editedEnd).not.toBe(firstEnd);
      await recordCopy(editedEnd);

      await db.query("update public.member_events set ends_at = null where id = $1", [publicEvent]);
      const [{ operations: [cleared] }] = await work();
      expect(cleared).toMatchObject({
        ...mappedCopy, contentHash: originalHash, event: { endsAt: null },
      });
      await recordCopy(cleared.contentHash);
    });

    it("connects, copies public events, follows edits, cancellations, scope and calendar changes, and disconnects", async () => {
      await connect();
      const token = await as("service", "select public.read_organization_calendar_refresh_token($1) data", [id.org]);
      expect(token.data).toEqual({ refreshToken: "r".repeat(40), calendarId: "primary" });

      let [org] = await work();
      expect(org.operations.map((op) => [op.op, op.eventId])).toEqual([["upsert", publicEvent]]);
      expect(org.operations[0].event).toMatchObject({ title: "Rally", location: "Hall", summary: "Bring signs" });
      const hash = org.operations[0].contentHash;

      expect((await as("service", "select public.record_organization_calendar_push_result($1,$2,'upserted','gcal1','primary',$3,null)", [id.org, publicEvent, hash])).code).toBe("");
      expect(await work()).toEqual([]);

      await db.query("update public.member_events set title='Rally (moved)' where id=$1", [publicEvent]);
      [org] = await work();
      expect(org.operations).toEqual([expect.objectContaining({ op: "upsert", eventId: publicEvent, googleEventId: "gcal1" })]);

      await setting("limits.integrations.org_calendar_push_scope", "all_events");
      [org] = await work();
      expect(org.operations.map((op) => op.eventId).sort()).toEqual([privateEvent, publicEvent].sort());
      await setting("limits.integrations.org_calendar_push_scope", "public_events");

      await db.query("update public.member_events set cancelled_at=now(), cancelled_reason='Weather' where id=$1", [publicEvent]);
      [org] = await work();
      expect(org.operations).toEqual([{ op: "delete", eventId: publicEvent, googleEventId: "gcal1", calendarId: "primary" }]);
      expect((await as("service", "select public.record_organization_calendar_push_result($1,$2,'deleted',null,null,null,null)", [id.org, publicEvent])).code).toBe("");
      expect(await work()).toEqual([]);

      await db.query("update public.member_events set cancelled_at=null, cancelled_reason=null where id=$1", [publicEvent]);
      expect((await as("service", "select public.record_organization_calendar_push_result($1,$2,'upserted','gcal2','primary',$3,null)", [id.org, publicEvent, "b".repeat(32)])).code).toBe("");
      const moved = await as("admin", "select public.set_organization_calendar_push_calendar('team@group.calendar.google.com') data");
      expect(moved.data.connection).toMatchObject({ calendarId: "team@group.calendar.google.com", accountEmail: "office@example.org", status: "connected" });
      [org] = await work();
      expect(org.operations[0]).toEqual({ op: "delete", eventId: publicEvent, googleEventId: "gcal2", calendarId: "primary" });

      await setting("features.integrations.org_calendar_push", false);
      expect(await work()).toEqual([]);
      await setting("features.integrations.org_calendar_push", true);

      const disconnected = await as("admin", "select public.disconnect_organization_calendar_push() data");
      expect(disconnected.data).toMatchObject({ connection: null, copiedEvents: 0 });
      expect((await as("service", "select public.read_organization_calendar_refresh_token($1) data", [id.org])).code).toBe("P0002");
      expect(await work()).toEqual([]);
    });

    it("backs off a failing event and records run errors", async () => {
      await connect();
      expect((await as("service", "select public.record_organization_calendar_push_result($1,$2,'failed',null,null,null,'calendar_unavailable')", [id.org, publicEvent])).code).toBe("");
      expect(await work()).toEqual([]);
      const status = await as("admin", "select public.get_organization_calendar_push_status() data");
      expect(status.data.failingEvents).toBe(1);
      await as("service", "select public.record_organization_calendar_push_run($1,'error','grant_revoked')", [id.org]);
      expect((await as("admin", "select public.get_organization_calendar_push_status() data")).data.connection).toMatchObject({ status: "error", lastErrorCode: "grant_revoked" });
      await db.query("update private.organization_calendar_event_pushes set last_failed_at = now() - interval '2 hours' where organization_id=$1", [id.org]);
      expect(await work()).toEqual([]);
      await as("service", "select public.record_organization_calendar_push_run($1,'ok',null)", [id.org]);
      expect((await work())[0].operations[0]).toMatchObject({ op: "upsert", eventId: publicEvent });
      expect((await as("service", "select public.record_organization_calendar_push_result($1,$2,'upserted','bad id!','primary',$3,null)", [id.org, publicEvent, "a".repeat(32)])).code).toBe("22023");
    });
  });

  describe("Drive case and meeting folders", () => {
    it("lists only unrestricted cases the steward can work and the chapter's meetings", async () => {
      const result = await as("steward", "select public.list_google_drive_filing_targets() data");
      expect(result.data.enabled).toBe(true);
      expect(result.data.cases).toEqual([{ id: id.case, reference: "GR-7", folderName: `Case GR-7 · ${id.case.slice(0, 8)}` }]);
      expect(result.data.meetings.map((item) => item.id).sort()).toEqual([privateEvent, publicEvent].sort());
      expect(result.data.meetings.find((item) => item.id === publicEvent).folderName).toMatch(/^Meeting \d{4}-\d{2}-\d{2} · Rally · [0-9a-f]{6}$/);
      expect((await as("member1", "select public.list_google_drive_filing_targets() data")).code).toBe("42501");
    });

    it("authorizes a case or meeting target and refuses restricted cases and other people", async () => {
      const filed = await as("steward", "select public.authorize_google_drive_filing('upload','case',$1) data", [id.case]);
      expect(filed.data).toMatchObject({ organizationId: id.org, rootFolderId: "rootFolder1", targetKind: "case", groupFolderName: "Cases", folderName: `Case GR-7 · ${id.case.slice(0, 8)}` });
      const meeting = await as("steward", "select public.authorize_google_drive_filing('list','meeting',$1) data", [publicEvent]);
      expect(meeting.data).toMatchObject({ groupFolderName: "Meetings", targetId: publicEvent });
      const restricted = await as("steward2", "select public.authorize_google_drive_filing('upload','case',$1) data", [id.restrictedCase]);
      expect(restricted.code).toBe("42501");
      expect((await as("steward", "select public.authorize_google_drive_filing('upload','case',$1) data", [id.restrictedCase])).message).toMatch(/restricted case files stay in Union Ground/);
      expect((await as("steward", "select public.authorize_google_drive_filing('upload','case','not-a-uuid') data")).code).toBe("22023");
      expect((await as("steward", "select public.authorize_google_drive_filing('upload','member',$1) data", [id.case])).code).toBe("22023");
      expect((await as("member1", "select public.authorize_google_drive_filing('upload','case',$1) data", [id.case])).code).toBe("42501");
      expect((await as("outsider", "select public.authorize_google_drive_filing('upload','meeting',$1) data", [publicEvent])).code).toBe("42501");
    });

    it("turns off with the switch while plain resources filing stays", async () => {
      await setting("features.integrations.drive_case_meeting_folders", false);
      expect((await as("steward", "select public.list_google_drive_filing_targets() data")).data).toMatchObject({ enabled: false, connected: true, cases: [] });
      expect((await as("steward", "select public.authorize_google_drive_filing('list','case',$1) data", [id.case])).code).toBe("55000");
      expect((await as("steward", "select public.authorize_google_drive_operation('list') data")).data).toMatchObject({ organizationId: id.org, rateLimited: false });
    });
  });

  describe("member check-off lists", () => {
    const create = (actor, mode, members, stewards = [], manual = {}, task = id.task) => as(actor,
      "select public.create_task_checkoff_list($1,$2,$3::uuid[],$4::uuid[],$5::jsonb) data",
      [task, mode, members, stewards, JSON.stringify(manual)]);
    const setEntry = (actor, entryId, status, expected, note = "") => as(actor,
      "select public.set_task_checkoff_entry($1,$2,$3,$4) data", [entryId, status, note, expected]);

    it("is off by default and refuses everyone", async () => {
      expect((await as("steward", "select public.get_task_checkoff_list($1) data", [id.task])).data).toEqual({ enabled: false, list: null });
      expect((await create("steward", "shared", [id.member1])).code).toBe("55000");
    });

    it("splits the roster evenly, guards check-offs and audits status changes", async () => {
      await setting("features.tasks.coop_checkoff_lists", true);
      expect((await as("member1", "select public.get_task_checkoff_list($1) data", [id.task])).code).toBe("42501");
      expect((await as("outsider", "select public.get_task_checkoff_list($1) data", [id.task])).code).toBe("42501");

      const candidates = (await as("steward", "select public.list_task_checkoff_candidates($1) data", [id.task])).data.members;
      expect(candidates.find((row) => row.id === id.steward2)).toMatchObject({ steward: true, name: "Person steward2" });
      expect(candidates.find((row) => row.id === id.member1)).toMatchObject({ steward: false });
      expect(candidates.some((row) => row.id === id.outsider)).toBe(false);

      expect((await create("steward", "split_even", [id.member1, id.outsider], [id.steward])).code).toBe("22023");
      expect((await create("steward", "split_even", [id.member1], [id.member2])).code).toBe("22023");
      expect((await create("steward", "split_even", [id.member1], [])).code).toBe("22023");

      const made = await create("steward", "split_even", [id.member1, id.member2, id.member1, id.admin], [id.steward, id.steward2]);
      expect(made.code).toBe("");
      const entries = made.data.list.entries;
      expect(entries.map((row) => [row.memberUserId, row.assignedStewardId])).toEqual([
        [id.member1, id.steward], [id.member2, id.steward2], [id.admin, id.steward],
      ]);
      expect(made.data.list).toMatchObject({ mode: "split_even", status: "open", createdBy: id.steward, canManage: true });
      expect((await create("steward", "shared", [id.member1])).code).toBe("23505");

      const byMember = Object.fromEntries(entries.map((row) => [row.memberUserId, row.id]));
      expect((await setEntry("steward2", byMember[id.member1], "done", "pending")).message).toMatch(/checkoff:assigned_to_other/);
      expect((await setEntry("steward2", byMember[id.member2], "done", "done")).code).toBe("PT409");
      const followUp = await setEntry("steward2", byMember[id.member2], "follow_up", "pending", "Call Friday");
      expect(followUp.data.list.entries.find((row) => row.id === byMember[id.member2])).toMatchObject({ status: "follow_up", note: "Call Friday", actionedBy: id.steward2, actionedByName: "Person steward2" });
      expect((await setEntry("steward2", byMember[id.member2], "pending", "follow_up")).message).toMatch(/checkoff:reset_requires_manager/);
      expect((await setEntry("steward2", byMember[id.member2], "done", "follow_up")).code).toBe("");
      expect((await setEntry("steward2", byMember[id.member2], "unreachable", "done")).message).toMatch(/checkoff:already_actioned/);
      const reset = await setEntry("steward", byMember[id.member2], "pending", "done");
      expect(reset.data.list.entries.find((row) => row.id === byMember[id.member2])).toMatchObject({ status: "pending", actionedBy: null, actionedAt: null });

      expect((await as("steward2", "select public.set_task_checkoff_list_status($1,'closed') data", [id.task])).message).toMatch(/checkoff:manager_required/);
      expect((await as("admin", "select public.set_task_checkoff_list_status($1,'closed') data", [id.task])).data.list.status).toBe("closed");
      expect((await setEntry("steward2", byMember[id.member2], "done", "pending")).message).toMatch(/checkoff:list_closed/);

      const { rows } = await db.query("select action, from_value, to_value from public.chapter_task_activity where task_id=$1 and action like 'checkoff%' order by id", [id.task]);
      expect(rows.map((row) => [row.action, row.from_value, row.to_value])).toEqual([
        ["checkoff_list_created", null, "split_even"],
        ["checkoff_entry_changed", "pending", "follow_up"],
        ["checkoff_entry_changed", "follow_up", "done"],
        ["checkoff_entry_changed", "done", "pending"],
        ["checkoff_list_status_changed", "open", "closed"],
      ]);
    });

    it("supports shared and manual lists and hides lists while the switch is off", async () => {
      await setting("features.tasks.coop_checkoff_lists", true);
      const shared = await create("steward2", "shared", [id.member1, id.member2], [id.steward], {}, id.task2);
      expect(shared.data.list.entries.every((row) => row.assignedStewardId === null)).toBe(true);
      const anyone = await setEntry("steward", shared.data.list.entries[0].id, "done", "pending");
      expect(anyone.code).toBe("");
      expect((await create("steward", "manual", [id.member1], [], { [id.member1]: id.member2 })).code).toBe("22023");
      expect((await create("steward", "manual", [id.member1, id.member2], [], { [id.member1]: id.steward2 })).code).toBe("22023");
      const manual = await create("steward", "manual", [id.member1], [], { [id.member1]: id.steward2 });
      expect(manual.data.list.entries[0]).toMatchObject({ memberUserId: id.member1, assignedStewardId: id.steward2 });
      await setting("features.tasks.coop_checkoff_lists", false);
      expect((await as("steward", "select public.get_task_checkoff_list($1) data", [id.task])).data).toEqual({ enabled: false, list: null });
      expect((await setEntry("steward2", manual.data.list.entries[0].id, "done", "pending")).code).toBe("55000");
    });

    it("removes a member's rows with the account and keeps the outcome when a steward leaves", async () => {
      await setting("features.tasks.coop_checkoff_lists", true);
      const made = await create("steward", "split_even", [id.member1, id.member2], [id.steward2]);
      const member2Entry = made.data.list.entries.find((row) => row.memberUserId === id.member2);
      await setEntry("steward2", member2Entry.id, "done", "pending");
      await db.query("delete from auth.users where id=$1", [id.member1]);
      await db.query("delete from auth.users where id=$1", [id.steward2]);
      const { rows } = await db.query("select member_user_id, assigned_steward_id, actioned_by, status from private.task_checkoff_entries where task_id=$1", [id.task]);
      expect(rows).toEqual([{ member_user_id: id.member2, assigned_steward_id: null, actioned_by: null, status: "done" }]);
    });
  });

  it("grants every client function to authenticated only and every service function to service_role only", async () => {
    const { rows } = await db.query(`
      select p.proname,
        has_function_privilege('anon', p.oid, 'execute') anon,
        has_function_privilege('authenticated', p.oid, 'execute') auth,
        has_function_privilege('service_role', p.oid, 'execute') service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[]) order by p.proname`, [[
      "get_my_membership_wallet_pass", "get_organization_calendar_push_status", "begin_organization_calendar_oauth",
      "set_organization_calendar_push_calendar", "disconnect_organization_calendar_push", "list_google_drive_filing_targets",
      "authorize_google_drive_filing", "get_task_checkoff_list", "list_task_checkoff_candidates", "create_task_checkoff_list",
      "set_task_checkoff_entry", "set_task_checkoff_list_status", "claim_organization_calendar_oauth_state",
      "complete_organization_calendar_oauth", "read_organization_calendar_refresh_token", "list_organization_calendar_push_work",
      "record_organization_calendar_push_result", "record_organization_calendar_push_run",
    ]]);
    const service = new Set(["claim_organization_calendar_oauth_state", "complete_organization_calendar_oauth", "read_organization_calendar_refresh_token", "list_organization_calendar_push_work", "record_organization_calendar_push_result", "record_organization_calendar_push_run"]);
    expect(rows).toHaveLength(18);
    for (const row of rows) {
      expect([row.proname, row.anon, row.auth, row.service]).toEqual([row.proname, false, !service.has(row.proname), service.has(row.proname)]);
    }
    const tables = await db.query(`select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        has_table_privilege('authenticated', c.oid, 'select') auth_select
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='private' and c.relname = any($1::text[]) order by c.relname`, [["organization_calendar_oauth_states", "organization_calendar_push_connections", "organization_calendar_event_pushes", "task_checkoff_lists", "task_checkoff_entries"]]);
    expect(tables.rows.map((row) => [row.relname, row.relrowsecurity, row.relforcerowsecurity, row.auth_select])).toEqual([
      ["organization_calendar_event_pushes", true, true, false],
      ["organization_calendar_oauth_states", true, true, false],
      ["organization_calendar_push_connections", true, true, false],
      ["task_checkoff_entries", true, true, false],
      ["task_checkoff_lists", true, true, false],
    ]);
  });
});
