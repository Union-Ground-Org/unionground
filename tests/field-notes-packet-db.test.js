// @vitest-environment node
//
// REQ-UG-FIELD-NOTES-AI-PACKET-20261001. A live apply proves
// get_compass_field_notes_packet_context refuses members and switched-off
// organizations, reads only the selected field notes on a task in the caller's
// own chapter, returns the task title with note text and day offsets and
// nothing else, and honors limits.ai_assistant.packet_notes.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

const MIGRATION = "supabase/migrations/20261009230000_field_notes_ai_packet.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const PACKET = "features.ai_assistant.field_notes_packet";
const NOTE_LIMIT = "limits.ai_assistant.packet_notes";

describe("field notes packet migration (static)", () => {
  it("registers an OFF switch and a bounded note limit, and locks the case graph before reading", () => {
    const code = stripComments(migration);
    expect(code).toMatch(new RegExp(`\\('${PACKET.replaceAll(".", "\\.")}', 'boolean',[\\s\\S]*?'false', null, null, null, \\d+, 'ai_assistant', true\\)`));
    expect(code).toMatch(new RegExp(`\\('${NOTE_LIMIT.replaceAll(".", "\\.")}', 'integer',[\\s\\S]*?'12', 1, 24, null, \\d+, 'ai_assistant', true\\)`));
    expect(code).toContain("on conflict (key) do nothing;");
    expect(code).toMatch(/security definer\nset search_path = ''\nas \$function\$\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n {2}perform private\.member_pin_require_full_session\(\);\ndeclare/);
    expect(code).toContain("public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(code).toContain("and p.chapter_id = t.chapter_id");
    expect(code).toContain("and t.deleted_at is null");
    expect(code).toContain("limit note_limit");
    expect(code).toContain("revoke all on function public.get_compass_field_notes_packet_context(uuid, uuid[]) from public, anon, authenticated, service_role;");
  });
});

const ID = {
  org: "51002430-0000-4000-8000-000000000001",
  otherOrg: "51002430-0000-4000-8000-000000000002",
  steward: "51002430-0000-4000-8000-000000000101",
  member: "51002430-0000-4000-8000-000000000102",
  outsider: "51002430-0000-4000-8000-000000000103",
  stewardSession: "51002430-0000-4000-8000-000000000201",
  memberSession: "51002430-0000-4000-8000-000000000202",
  outsiderSession: "51002430-0000-4000-8000-000000000203",
  task: "51002430-0000-4000-8000-000000000301",
  otherTask: "51002430-0000-4000-8000-000000000302",
};
const CHAPTER = "field-notes-packet-chapter";
const OTHER_CHAPTER = "field-notes-packet-other";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("field notes packet context on a disposable database", () => {
  let db;
  let noteIds = [];
  let otherNoteId = null;

  async function as(userId, sessionId, sql, values = []) {
    await db.query("savepoint field_notes_packet");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", session_id: sessionId, aal: "aal2" })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint field_notes_packet");
      return result.rows[0];
    } catch (error) {
      await db.query("rollback to savepoint field_notes_packet");
      await db.query("reset role").catch(() => {});
      throw error;
    }
  }

  const context = (userId, sessionId, taskId, notes) => as(
    userId,
    sessionId,
    "select public.get_compass_field_notes_packet_context($1::uuid, $2::uuid[]) c",
    [taskId, notes],
  ).then((row) => row.c);

  async function setSetting(key, value) {
    await db.query(
      `insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,$3::jsonb,$4)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [ID.org, key, JSON.stringify(value), ID.steward],
    );
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "field-notes-packet-proof" });
    await db.connect();
    await db.query("begin");
    await releaseCalendarHolds(db);
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      "insert into auth.users (id,email) values ($1,'fnp-steward@example.invalid'),($2,'fnp-member@example.invalid'),($3,'fnp-outsider@example.invalid')",
      [ID.steward, ID.member, ID.outsider],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'fnp-org','Packet org',$3),($2,'fnp-other','Other org',$4)",
      [ID.org, ID.otherOrg, ID.steward, ID.outsider],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$3,false,92431),($2,$2,$2,$4,false,92432)",
      [CHAPTER, OTHER_CHAPTER, ID.org, ID.otherOrg],
    );
    for (const [userId, org, chapter] of [[ID.steward, ID.org, CHAPTER], [ID.member, ID.org, CHAPTER], [ID.outsider, ID.otherOrg, OTHER_CHAPTER]]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, chapter]);
    }
    await db.query(
      `insert into auth.sessions(id,user_id,aal,created_at,updated_at)
       values ($1,$2,'aal2',now(),now()),($3,$4,'aal2',now(),now()),($5,$6,'aal2',now(),now())`,
      [ID.stewardSession, ID.steward, ID.memberSession, ID.member, ID.outsiderSession, ID.outsider],
    );
    for (const userId of [ID.steward, ID.member, ID.outsider]) {
      await db.query(
        "insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values (gen_random_uuid(),$1,'f','totp','verified',now(),now())",
        [userId],
      );
    }
    await db.query("insert into public.member_roles(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$1),($3,'steward',$4,$3)", [ID.steward, CHAPTER, ID.outsider, OTHER_CHAPTER]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$1),($3,'steward',$4,$3)", [ID.steward, CHAPTER, ID.outsider, OTHER_CHAPTER]);
    // Task triggers require a real caller, stamp that caller's chapter and
    // validate its workstream even for these transactional fixture writes.
    // Create each task under its own author so the foreign-task case really
    // exercises another organization's task, without bypassing the triggers.
    for (const [taskId, chapter, author, session, title] of [
      [ID.task, CHAPTER, ID.steward, ID.stewardSession, "Night shift staffing walkthrough"],
      [ID.otherTask, OTHER_CHAPTER, ID.outsider, ID.outsiderSession, "Other organization task"],
    ]) {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: author, role: "authenticated", session_id: session, aal: "aal2" })]);
      await db.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'Organizing',$2)", [chapter, author]);
      await db.query(
        "insert into public.chapter_tasks(id,chapter_id,title,created_by,updated_by,workstream) values($1,$2,$3,$4,$4,'Organizing')",
        [taskId, chapter, title, author],
      );
    }
    await db.query("select set_config('request.jwt.claims', '', true)");
    for (let index = 0; index < 4; index += 1) {
      const row = await db.query(
        "insert into public.chapter_task_comments(task_id,chapter_id,author_id,body,created_at) values($1,$2,$3,$4,now() - ($5 || ' days')::interval) returning id",
        [ID.task, CHAPTER, ID.steward, `Members reported short staffing on the night shift, note ${index + 1}.`, 3 - index],
      );
      noteIds.push(row.rows[0].id);
    }
    otherNoteId = (await db.query(
      "insert into public.chapter_task_comments(task_id,chapter_id,author_id,body) values($1,$2,$3,'Another organization note.') returning id",
      [ID.otherTask, OTHER_CHAPTER, ID.outsider],
    )).rows[0].id;
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("registers the switch OFF and the note limit with its floor and ceiling", async () => {
    const rows = (await db.query(
      "select key, default_value, minimum, maximum, category, member_visible from public.platform_setting_definitions where key in ($1,$2) order by sort_order",
      [PACKET, NOTE_LIMIT],
    )).rows;
    expect(rows).toEqual([
      { key: PACKET, default_value: false, minimum: null, maximum: null, category: "ai_assistant", member_visible: true },
      { key: NOTE_LIMIT, default_value: 12, minimum: 1, maximum: 24, category: "ai_assistant", member_visible: true },
    ]);
  });

  it("refuses while the packet switch or the Compass switch is off", async () => {
    await expect(context(ID.steward, ID.stewardSession, ID.task, noteIds)).rejects.toMatchObject({ code: "55000" });
    await setSetting(PACKET, true);
    await setSetting("features.ai_assistant.enabled", false);
    await expect(context(ID.steward, ID.stewardSession, ID.task, noteIds)).rejects.toMatchObject({ code: "55000" });
    await setSetting("features.ai_assistant.enabled", true);
  });

  it("returns the task title with the selected notes as text and day offsets only", async () => {
    await setSetting(PACKET, true);
    const result = await context(ID.steward, ID.stewardSession, ID.task, noteIds.slice(0, 2));
    expect(result.organization_id).toBe(ID.org);
    expect(result.noteLimit).toBe(12);
    expect(result.data.title).toBe("Night shift staffing walkthrough");
    expect(result.data.notes).toEqual([
      { daysAgo: 3, body: "Members reported short staffing on the night shift, note 1." },
      { daysAgo: 2, body: "Members reported short staffing on the night shift, note 2." },
    ]);
    // No author identity, note id or timestamp leaves the database.
    expect(Object.keys(result.data.notes[0]).sort()).toEqual(["body", "daysAgo"]);
    expect(JSON.stringify(result)).not.toContain(ID.steward);
  });

  it("honors the organization's per-packet note limit and ignores notes from another task", async () => {
    await setSetting(PACKET, true);
    await setSetting(NOTE_LIMIT, 2);
    const capped = await context(ID.steward, ID.stewardSession, ID.task, noteIds);
    expect(capped.noteLimit).toBe(2);
    expect(capped.data.notes).toHaveLength(2);
    await setSetting(NOTE_LIMIT, 12);
    const foreign = await context(ID.steward, ID.stewardSession, ID.task, [otherNoteId]);
    expect(foreign.data.notes).toEqual([]);
  });

  it("refuses a non-staff member, another organization's task and an empty selection", async () => {
    await setSetting(PACKET, true);
    await expect(context(ID.member, ID.memberSession, ID.task, noteIds)).rejects.toMatchObject({ code: "42501" });
    await expect(context(ID.steward, ID.stewardSession, ID.otherTask, [otherNoteId])).rejects.toMatchObject({ code: "P0002" });
    await expect(context(ID.steward, ID.stewardSession, ID.task, [])).rejects.toMatchObject({ code: "22023" });
  });
});
