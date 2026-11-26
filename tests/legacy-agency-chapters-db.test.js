// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { offlinePostgres } from "./tamarack-postgres-helper.mjs";

const ids = ["wor", "bos", "spr", "law", "nbd", "dds-hyn", "dds-pit", "dcf-bos", "dcf-wor", "dcf-spr", "dcf-law", "dcf-brk", "dcf-hol", "dta-bos", "dta-spr", "dta-wor", "dta-fal", "dta-lyn", "dmh-bos", "dmh-wor", "dmh-tau", "dmh-nth", "mrc-bos", "mrc-wor", "mrc-spr", "dph-bos", "dph-tew", "dys-bos", "dys-wor"];
const seedEvents = [{"id": "evt-2026-chapter-meeting", "chapter_id": "wor"}, {"id": "evt-2026-steward-training", "chapter_id": "bos"}, {"id": "evt-2026-office-hours", "chapter_id": "spr"}, {"id": "evt-2026-relief-rally", "chapter_id": "law"}, {"id": "evt-2026-ratification-call", "chapter_id": "nbd"}, {"id": "evt-2025-fall-assembly", "chapter_id": "dds-hyn"}, {"id": "evt-2025-caseload-forum", "chapter_id": "dds-pit"}, {"id": "evt-2026-winter-training", "chapter_id": "dcf-bos"}, {"id": "evt-2026-lobby-day", "chapter_id": "dcf-wor"}];
const sql = readFileSync(new URL("../supabase/migrations/20261018060300_retire_legacy_agency_chapters.sql", import.meta.url), "utf8");
let database;
let client;

beforeAll(async () => {
  database = await offlinePostgres();
  client = database.client;
}, 120_000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  // Minimal real PostgreSQL boundary fixture; the full migration replay is
  // exercised separately. No hosted URL or shared database is accepted here.
  await client.query(`
    rollback;
    drop schema if exists private cascade;
    drop schema public cascade;
    create schema public;
    create schema private;
    create table public.chapters (
      id text primary key, name text not null, organization_id uuid
    );
    create table public.member_events (
      id text primary key, chapter_id text references public.chapters(id), organizer_id uuid
    );
    create table public.chapter_workstreams (
      id text primary key, chapter_id text references public.chapters(id), name text, created_by uuid,
      unique(chapter_id, name)
    );
    create table private.member_stress_chapter_plan (
      chapter_id text primary key references public.chapters(id) on delete cascade
    );
    create table public.member_profiles (
      id text primary key, chapter_id text default 'wor' references public.chapters(id) on delete set null
    );
    create table public.member_event_rsvps (
      id text primary key, event_id text references public.member_events(id) on delete cascade
    );
    create table private.chapter_connection_hides (
      chapter_id text references public.chapters(id) on delete cascade,
      hidden_chapter_id text references public.chapters(id) on delete cascade
    );
    create table public.chapter_handshakes (
      chapter_id text references public.chapters(id) on delete cascade,
      receiving_chapter_id text references public.chapters(id) on delete cascade
    );
    insert into public.chapters values
      ('union-ground-llc','Union Ground LLC workspace','11111111-1111-4111-8111-111111111111'),
      ('tamarack-kept','Tamarack chapter','22222222-2222-4222-8222-222222222222');
    insert into public.member_events values ('tamarack-event','tamarack-kept',null);
    insert into public.chapter_workstreams values ('tamarack-work','tamarack-kept','General',null);
  `);
  for (const table of ["public.coalition_handshakes", "public.coalition_partners", "public.member_capacity_commitments", "public.member_learning_assignments", "public.member_learning_sessions", "public.member_membership_periods", "public.member_onboarding_steps", "public.member_participation_completions", "public.member_participation_events", "public.member_recognition_events", "public.organizing_campaigns", "public.union_employers", "public.union_lifecycle_audit_events", "public.union_worksites"]) {
    await client.query(`create table ${table} (chapter_id text references public.chapters(id) on delete cascade)`);
  }
  await client.query("insert into public.chapters select id, id, null from unnest($1::text[]) id", [ids]);
  await client.query("insert into public.chapter_workstreams select id, id, 'General', null from unnest($1::text[]) id", [ids]);
  await client.query("insert into private.member_stress_chapter_plan select unnest($1::text[])", [ids]);
  for (const event of seedEvents) {
    await client.query("insert into public.member_events values ($1,$2,null)", [event.id, event.chapter_id]);
  }
});

async function snapshot() {
  const result = {};
  for (const table of ["public.chapters", "public.member_events", "public.chapter_workstreams", "private.member_stress_chapter_plan", "public.member_profiles", "public.member_event_rsvps", "private.chapter_connection_hides", "public.chapter_handshakes"]) {
    result[table] = (await client.query(`select to_jsonb(t) row from ${table} t order by to_jsonb(t)::text`)).rows;
  }
  return result;
}
async function refused(message) {
  const before = await snapshot();
  await expect(client.query(sql)).rejects.toThrow(message);
  await client.query("rollback");
  expect(await snapshot()).toEqual(before);
}

it("removes the exact 29 seeded IDs, preserves workspace and unrelated rows, and reapplies", async () => {
  expect(ids).toHaveLength(29);
  expect(seedEvents).toHaveLength(9);
  expect(new Set(ids).size).toBe(29);
  const before = await snapshot();
  await client.query(sql);
  const after = await snapshot();
  expect(after["public.chapters"]).toEqual(before["public.chapters"].filter(({ row }) => !ids.includes(row.id)));
  expect(after["public.member_events"]).toEqual(before["public.member_events"].filter(({ row }) => row.chapter_id === "tamarack-kept"));
  expect(after["public.chapter_workstreams"]).toEqual(before["public.chapter_workstreams"].filter(({ row }) => row.chapter_id === "tamarack-kept"));
  expect(after["private.member_stress_chapter_plan"]).toEqual([]);
  await client.query(sql);
  expect(await snapshot()).toEqual(after);
  await client.query("insert into public.member_profiles (id) values ('tamarack-new-profile')");
  expect((await client.query("select chapter_id from public.member_profiles where id='tamarack-new-profile'")).rows[0].chapter_id).toBeNull();
});

it("rejects recreation of every exact ID, including upsert and rename, but permits a new Tamarack chapter", async () => {
  await client.query(sql);
  for (const id of ids) {
    await expect(client.query("insert into public.chapters values ($1,$1,null) on conflict(id) do update set name=excluded.name", [id]))
      .rejects.toMatchObject({ code: "23514", constraint: "chapters_legacy_agency_ids_retired" });
    await expect(client.query("update public.chapters set id=$1 where id='union-ground-llc'", [id]))
      .rejects.toMatchObject({ code: "23514" });
  }
  await client.query("insert into public.chapters values ('tamarack-new','Tamarack new chapter',null)");
  expect((await client.query("select count(*)::int n from public.chapters")).rows[0].n).toBe(3);
});

it("preserves a non-legacy profile default on reapplication", async () => {
  await client.query("alter table public.member_profiles alter column chapter_id set default 'tamarack-kept'");
  await client.query(sql);
  await client.query("insert into public.member_profiles (id) values ('tamarack-profile')");
  expect((await client.query("select chapter_id from public.member_profiles where id='tamarack-profile'")).rows[0].chapter_id).toBe("tamarack-kept");
});

it("refuses a claimed target identity atomically", async () => {
  await client.query("update public.chapters set organization_id='33333333-3333-4333-8333-333333333333' where id='wor'");
  await refused("target belongs to an organization");
});

it("refuses an unknown direct dependent even when its FK would silently set null", async () => {
  await client.query("insert into public.member_profiles values ('member','wor')");
  await refused("attached rows");
});

it("refuses non-seed events and attributed workstreams", async () => {
  await client.query("insert into public.member_events values ('tamarack-added-event','wor',null)");
  await refused("non-seed event");
  await client.query("delete from public.member_events where id='tamarack-added-event'");
  await client.query("update public.chapter_workstreams set created_by='33333333-3333-4333-8333-333333333333' where id='wor'");
  await refused("non-seed workstream");
});

it("refuses event descendants that CASCADE would otherwise destroy", async () => {
  await client.query("insert into public.member_event_rsvps values ('attendance','evt-2026-chapter-meeting')");
  await refused("seed descendants");
});

it.each([
  ["private.chapter_connection_hides", "hidden_chapter_id"],
  ["public.chapter_handshakes", "receiving_chapter_id"],
])("refuses incoming legacy references in %s without cascading a keeper's row", async (table, column) => {
  await client.query(`insert into ${table} (chapter_id, ${column}) values ('tamarack-kept','wor')`);
  await refused("attached rows");
});

it("cannot create the duplicate General workstream scenario under the actual unique key", async () => {
  await expect(client.query("insert into public.chapter_workstreams values ('second-general','wor','General',null)"))
    .rejects.toMatchObject({ code: "23505" });
});

it("refuses workstream descendants and newly introduced FK tables", async () => {
  await client.query("create table public.future_task (id text, workstream_id text references public.chapter_workstreams(id) on delete cascade)");
  await client.query("insert into public.future_task values ('task','wor')");
  await refused("unrecognized foreign key");
});

it("refuses composite chapter references rather than guessing at a safe deletion", async () => {
  await client.query("alter table public.chapters add unique (id,name)");
  await client.query("create table public.future_chapter_use (id text, name text, foreign key(id,name) references public.chapters(id,name) on delete cascade)");
  await refused("unrecognized foreign key");
});


it.each(["public.coalition_handshakes", "public.coalition_partners", "public.member_capacity_commitments", "public.member_learning_assignments", "public.member_learning_sessions", "public.member_membership_periods", "public.member_onboarding_steps", "public.member_participation_completions", "public.member_participation_events", "public.member_recognition_events", "public.organizing_campaigns", "public.union_employers", "public.union_lifecycle_audit_events", "public.union_worksites"]) ("refuses Union Ground lifecycle references in %s atomically", async (table) => {
  await client.query(`insert into ${table} values ('wor')`);
  await refused(`attached rows in ${table}`);
  expect((await client.query(`select chapter_id from ${table}`)).rows).toEqual([{ chapter_id: "wor" }]);
});
