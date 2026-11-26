// @vitest-environment node
// REQ-UG-NEUTRAL-NOTIFICATION-AND-CASE-ROWS-SERVER-COPY-20261104 (#7015):
// notification rows, case list rows and case search hits carry a neutral line
// (reference, type, status, step, due date) and never the case topic, the
// member's name on the member's own rows, or free text. The topic stays in the
// case record read. Each proof runs as the case owner, a same-chapter steward
// and an unrelated member of the same chapter.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "neutral_case_rows_and_notifications";
// Unique words that exist only in the case topics, the description, the
// steward's return note and the owner's name, so a row that leaks any of them
// is caught by a plain substring test.
const TOPIC = "quillfeatherdispute";
const DESCRIPTION = "marrowlanternstatement";
const NOTE = "copperwillowcorrection";
const OWNER_NAME = "Ondine Vasquelle";

describe("neutral case rows migration", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("moves the search body unchanged and keeps every client grant off it", () => {
    expect(sql).toContain("alter function public.search_member_cases(text, integer) set schema private;");
    expect(sql).toContain("revoke all on function private.search_member_cases(text, integer) from public, anon, authenticated, service_role;");
    expect(sql).toContain("revoke all on function public.search_member_cases(text, integer) from public, anon, service_role;");
    expect(sql).toContain("grant execute on function public.search_member_cases(text, integer) to authenticated;");
    expect(sql).toContain("revoke all on function private.case_row_line(text, text) from public, anon, authenticated, service_role;");
  });

  it("reads no case topic into any list row it redefines", () => {
    expect(sql).not.toMatch(/\bc\.title\b|open_case\.title|due\.title/);
    expect(sql).not.toContain("Note: ' || clean_note");
    expect(sql).not.toContain("Nota: ' || clean_note");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

function connectionUrl() {
  const url = new URL(process.env.SUPABASE_DB_URL);
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  return url.toString();
}

function leaks(value) {
  const text = JSON.stringify(value);
  return [TOPIC, DESCRIPTION, NOTE].filter((word) => text.includes(word));
}

live("neutral notification, case list and search rows over a disposable database", () => {
  let client;
  const world = {};

  async function actor(email, fullName = null) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${email}`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=coalesce($3, full_name) where id=$1", [id, world.chapter, fullName]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, world.chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [world.org, id]);
    return { id, session };
  }

  async function become(person) {
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: person.id, role: "authenticated", aal: "aal2", session_id: person.session,
    })]);
    await client.query("set local role authenticated");
  }

  async function asPostgres() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  // Runs one statement as a person; a refusal comes back as { code } instead
  // of aborting the outer transaction.
  async function as(person, text, values = []) {
    await client.query("savepoint attempt");
    await become(person);
    try {
      const { rows } = await client.query(text, values);
      await asPostgres();
      await client.query("release savepoint attempt");
      return { rows };
    } catch (error) {
      await client.query("rollback to savepoint attempt");
      await asPostgres();
      return { code: error.code, message: error.message };
    }
  }

  // Case calendar deadlines use the Eastern date, including late evenings.
  async function seedCase(fields) {
    const { rows } = await client.query(
      `insert into public.member_cases(user_id,reference,title,description,case_type,articles,step,deadline,steward_user_id)
       values ($1,$2,$3,$4,$5,$6,'Intake',(pg_catalog.now() at time zone 'America/New_York')::date + 2,$7) returning id`,
      [world.owner.id, fields.reference, `${TOPIC} ${fields.topic}`, `${DESCRIPTION} statement`, "Discipline",
        `${TOPIC} Article 9`, fields.steward ?? null],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: connectionUrl(), application_name: "neutral-case-rows-proof" });
    await client.connect();
    await client.query("set statement_timeout = '60s'");
    await client.query("begin");

    world.org = randomUUID();
    world.chapter = `n7015-${world.org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, world.chapter]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9915)", [world.chapter, world.org]);

    world.owner = await actor("owner@example.invalid", OWNER_NAME);
    world.steward = await actor("steward@example.invalid");
    world.unrelated = await actor("unrelated@example.invalid");
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [world.steward.id, world.chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [world.steward.id, world.chapter]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), world.steward.id]);

    world.assignedCase = await seedCase({ reference: "NC-2026-0001", topic: "overtime withheld", steward: world.steward.id });
    world.waitingCase = await seedCase({ reference: "NC-2026-0002", topic: "schedule change" });
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("keeps the topic in the case record read", async () => {
    const owner = await as(world.owner, "select title, description from public.member_cases where id=$1", [world.assignedCase]);
    expect(owner.rows).toEqual([{ title: `${TOPIC} overtime withheld`, description: `${DESCRIPTION} statement` }]);
    const unrelated = await as(world.unrelated, "select id from public.member_cases where id = any($1::uuid[])", [[world.assignedCase, world.waitingCase]]);
    expect(unrelated.rows).toEqual([]);
  });

  it("returns a neutral search hit to the owner and the steward, and none to an unrelated member", async () => {
    const owner = await as(world.owner, "select * from public.search_member_cases($1, 50)", [TOPIC]);
    expect(owner.code, owner.message).toBeUndefined();
    expect(owner.rows.map((row) => row.reference).sort()).toEqual(["NC-2026-0001", "NC-2026-0002"]);
    for (const row of owner.rows) {
      expect(row).toMatchObject({ title: "Discipline · Intake", case_type: "Discipline", step: "Intake", status: "active", articles: null, headline: null });
      expect(row.headline_source).toEqual(expect.any(String));
    }
    expect(leaks(owner.rows)).toEqual([]);

    const steward = await as(world.steward, "select * from public.search_member_cases($1, 50)", [TOPIC]);
    expect(steward.code, steward.message).toBeUndefined();
    expect(steward.rows.map((row) => row.case_id)).toContain(world.assignedCase);
    expect(leaks(steward.rows)).toEqual([]);
    expect(JSON.stringify(steward.rows)).not.toContain(OWNER_NAME);

    const unrelated = await as(world.unrelated, "select * from public.search_member_cases($1, 50)", [TOPIC]);
    expect(unrelated.rows).toEqual([]);

    // The full body (with its snippet) is reachable only through the wrapper.
    const direct = await as(world.owner, "select * from private.search_member_cases($1, 50)", [TOPIC]);
    expect(direct.code).toBe("42501");
  });

  it("returns neutral case list rows, keeping the member's name only on the steward's queue", async () => {
    const queue = await as(world.steward, "select public.list_unassigned_chapter_cases() as rows");
    expect(queue.code, queue.message).toBeUndefined();
    const waiting = queue.rows[0].rows.filter((row) => row.id === world.waitingCase);
    expect(waiting).toEqual([expect.objectContaining({
      reference: "NC-2026-0002", title: "Discipline · Intake", caseType: "Discipline", step: "Intake", memberName: OWNER_NAME,
    })]);
    expect(leaks(queue.rows)).toEqual([]);
    expect((await as(world.owner, "select public.list_unassigned_chapter_cases()")).code).toBe("42501");
    expect((await as(world.unrelated, "select public.list_unassigned_chapter_cases()")).code).toBe("42501");

    const deadlines = await as(world.steward, "select public.list_steward_case_deadlines() as payload");
    expect(deadlines.code, deadlines.message).toBeUndefined();
    const own = deadlines.rows[0].payload.rows.filter((row) => row.caseId === world.assignedCase);
    expect(own).toEqual([expect.objectContaining({
      reference: "NC-2026-0001", title: "Discipline · Intake", caseType: "Discipline", step: "Intake", kind: "case", label: "Case deadline",
    })]);
    expect(leaks(deadlines.rows)).toEqual([]);

    for (const person of [world.owner, world.steward]) {
      const destinations = await as(person, "select * from public.list_share_case_destinations(100)");
      expect(destinations.code, destinations.message).toBeUndefined();
      expect(destinations.rows.map((row) => row.id)).toContain(world.assignedCase);
      for (const row of destinations.rows.filter((r) => [world.assignedCase, world.waitingCase].includes(r.id))) {
        expect(row.title).toBe("Discipline · Intake");
      }
      expect(leaks(destinations.rows)).toEqual([]);
    }
    const unrelated = await as(world.unrelated, "select id from public.list_share_case_destinations(100)");
    expect(unrelated.rows.map((row) => row.id)).not.toContain(world.assignedCase);
    expect(unrelated.rows.map((row) => row.id)).not.toContain(world.waitingCase);
  });

  it("writes neutral case notifications for the owner and the steward, and shows an unrelated member none", async () => {
    await client.query("savepoint sweep");
    await client.query("select private.case_deadline_notice_sweep()");
    const read = "select title, body, copy_key from public.member_notifications where user_id = auth.uid() and kind = 'deadlines'";
    const owner = await as(world.owner, read);
    const steward = await as(world.steward, read);
    const unrelated = await as(world.unrelated, "select id from public.member_notifications where user_id <> auth.uid()");
    await client.query("rollback to savepoint sweep");

    expect(owner.rows.map((row) => row.copy_key)).toContain("deadline.case.days");
    expect(steward.rows.map((row) => row.copy_key)).toContain("deadline.staff.days");
    for (const rows of [owner.rows, steward.rows]) {
      expect(leaks(rows)).toEqual([]);
      expect(JSON.stringify(rows)).not.toContain(OWNER_NAME);
      expect(JSON.stringify(rows)).not.toContain("NC-2026-");
    }
    expect(unrelated.rows).toEqual([]);
  });

  it("returns a form without quoting the steward's note in the owner's notification", async () => {
    const { rows } = await client.query(
      `insert into public.member_forms(user_id,template_key,status,submitted_at,organization_id)
       values ($1,'grievance','submitted',now(),$2) returning id`,
      [world.owner.id, world.org],
    );
    const formId = rows[0].id;
    const returned = await as(world.steward, "select public.return_form($1,$2)", [formId, `Please add the ${NOTE} date.`]);
    expect(returned.code, returned.message).toBeUndefined();

    const owner = await as(world.owner, "select title, body from public.member_notifications where user_id = auth.uid() and kind = 'forms'");
    expect(owner.rows).toEqual([{ title: "Form returned", body: expect.stringMatching(/ — returned by your steward for changes\. Open Forms to read the note\.$/) }]);
    expect(leaks(owner.rows)).toEqual([]);
    // The note itself stays on the form record the owner can open.
    const form = await as(world.owner, "select review_note from public.member_forms where id=$1", [formId]);
    expect(form.rows).toEqual([{ review_note: `Please add the ${NOTE} date.` }]);

    const others = await as(world.unrelated, "select id from public.member_notifications where user_id = $1", [world.owner.id]);
    expect(others.rows).toEqual([]);
    const stewardView = await as(world.steward, "select id from public.member_notifications where user_id = $1", [world.owner.id]);
    expect(stewardView.rows).toEqual([]);
  });
});
