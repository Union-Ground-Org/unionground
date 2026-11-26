// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-ENGINE-20261103 (#6940), slice 1 of #6805.
//
// Offline half: what the migration says. Live half (disposable loopback
// only): one period per organization, only an active administrator with the
// extra verification step starts or ends it, the journal records only the
// caller's own registered actions while the period runs by the wall clock,
// the practice marker follows the owner's Nov 3 ruling, closing is
// idempotent, and the audit trail only grows.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold, whileLearningPeriodReleased } from "./helpers/learningPeriodHold.js";

const FILE = "20261103163000_learning_period_engine.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);
const TABLES = ["organization_learning_periods", "learning_action_kinds", "learning_action_journal"];

describe("learning period engine migration (offline)", () => {
  it("is one atomic migration whose writers take the case-graph gate first", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    const functions = parseFunctions(sql);
    for (const name of ["public.start_organization_learning_period", "public.end_organization_learning_period_early", "private.close_learning_period"]) {
      expect(helperFirst(functions.find((fn) => fn.name === name).source), name).toBe(true);
    }
  });

  it("keeps all three tables private, without grants, under forced RLS and the restrictive session policy", () => {
    for (const table of TABLES) {
      expect(code).toContain(`create table private.${table} (`);
      expect(code).toContain(`alter table private.${table} force row level security;`);
      expect(code).toContain(`revoke all on table private.${table} from public, anon, authenticated, service_role;`);
      expect(code).toContain(`create policy mfa_assurance on private.${table} as restrictive for all to authenticated`);
      expect(code).not.toMatch(new RegExp(`grant [a-z, ]+ on (table )?private\\.${table}`));
    }
    for (const table of ["organization_learning_periods", "learning_action_journal"]) {
      expect(code).toContain(`create trigger a00_case_graph_lock before insert or update or delete on private.${table}`);
      expect(code).toContain(`create trigger b20_unverified_organization_boundary before insert or update on private.${table}`);
    }
    expect(code).toContain("constraint organization_learning_periods_one_per_organization unique (organization_id)");
  });

  it("uses the wall clock for every running check and never touches an audit row", () => {
    const running = parseFunctions(sql).find((fn) => fn.name === "private.learning_period_running").source;
    expect(running).toContain("pg_catalog.clock_timestamp() < coalesce(p.ended_early_at, p.ends_at)");
    expect(code).not.toMatch(/(update|delete from)\s+public\.organization_audit_(ledger|events)/);
    expect(code).not.toMatch(/casework_record_versions|member_message/);
    // Notices are only ever added, never changed or withdrawn.
    expect(code).not.toMatch(/(update|delete from)\s+public\.member_notifications/);
    expect(code).toContain("insert into public.member_notifications (user_id, title, body, kind, organization_id)");
  });

  it("keeps content and secrets out of before-images by construction", () => {
    for (const column of ["'body'", "'content'", "'token'", "'secret'", "'password'", "'file_content'"]) expect(code).toContain(column);
    expect(code).toContain("constraint learning_action_journal_image check");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period engine on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-engine-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  // asOwner keeps the owning role with the person's claims: a domain
  // slice's definer RPC calls the engine helpers that way.
  async function call(text, values = [], user = null, aal = "aal2", asOwner = false) {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal }
        : { role: "anon" })]);
      if (!asOwner) await c.query(user ? "set local role authenticated" : "set local role anon");
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("release savepoint call");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, message: error.message };
    }
  }
  const one = async (...args) => { const result = await call(...args); expect(result, JSON.stringify(result)).toMatchObject({ ok: true }); return Object.values(result.rows[0] ?? {})[0]; };
  const owned = async (text, values, user) => { const result = await call(text, values, user, "aal2", true); expect(result, JSON.stringify(result)).toMatchObject({ ok: true }); return Object.values(result.rows[0] ?? {})[0]; };
  const start = (user, days = 14, aal = "aal2") => call("select public.start_organization_learning_period($1) as r", [days], user, aal);
  const endEarly = (user, aal = "aal2") => call("select public.end_organization_learning_period_early() as r", [], user, aal);
  const append = (user, kind, table, id, extra = {}) => call(
    "select private.learning_journal_append($1, $2, $3, $4, $5, $6, $7::jsonb) as r",
    [kind, table, id, extra.parent ?? null, extra.fingerprint ?? null, extra.ref ?? null, extra.image ? JSON.stringify(extra.image) : null], user, "aal2", true);
  const flags = async (table, ids) => Object.fromEntries((await c.query("select target_id, flag from private.learning_practice_flags($1, $2)", [table, ids])).rows.map((row) => [row.target_id, row.flag]));
  const counts = async () => (await c.query("select (select count(*)::int from public.organization_audit_ledger) as ledger, (select count(*)::int from public.organization_audit_events) as events")).rows[0];
  const fingerprint = "a".repeat(64);

  async function organization(label, kind = "union") {
    const org = { id: randomUUID(), chapter: `learning-${label}-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name,kind) values ($1,$2,$2,$3)", [org.id, org.chapter, kind]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98313)", [org.chapter, org.id]);
    return org;
  }
  async function person(org, role) {
    const user = { id: randomUUID(), session: randomUUID(), org };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, org.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, org.chapter]);
    if (role !== "member") {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org.id, user.id, role]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, org.chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    const a = await organization("a");
    const b = await organization("b");
    world = { a, b, admin: await person(a, "admin"), steward: await person(a, "steward"), member: await person(a, "member"), otherMember: await person(a, "member"), adminB: await person(b, "admin") };
    // Fixture kinds standing in for a domain slice; they roll back with the test.
    await c.query(`insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
      ('proof_item_create', 'tasks', 'reverse', 'public.proof_items', true, 'private.learning_undo_proof_item', array['title'], 'fixture'),
      ('proof_item_edit', 'tasks', 'reverse', 'public.proof_items', false, 'private.learning_undo_proof_item', array['title', 'status'], 'fixture'),
      ('proof_item_send', 'messages', 'permanent', 'public.proof_items', true, null, array[]::text[], 'fixture'),
      ('proof_item_preview', 'messages', 'simulate', 'public.proof_items', false, null, array[]::text[], 'fixture'),
      ('proof_item_ignored', 'settings', 'excluded', null, false, null, array[]::text[], 'fixture')`);
  });
  afterEach(async () => { await c.query("rollback"); });

  it("lets only an active administrator in a verified session start the one period, for 7 or 14 days", async () => {
    for (const [user, aal] of [[world.member, "aal2"], [world.steward, "aal2"], [world.admin, "aal1"], [null, "aal2"]]) {
      expect(await start(user, 14, aal), `${user?.id ?? "anon"} ${aal}`).toMatchObject({ ok: false, code: "42501" });
    }
    expect(await start(world.admin, 10)).toMatchObject({ ok: false, code: "22023" });
    const before = await counts();
    const started = await one("select public.start_organization_learning_period() as r", [], world.admin);
    expect(started).toMatchObject({ organizationId: world.a.id, used: true, running: true, lengthDays: 14, isAdmin: true, endedEarlyAt: null, closedAt: null });
    expect(Date.parse(started.endsAt) - Date.parse(started.startsAt)).toBe(14 * 86400000);
    expect(await start(world.admin, 7)).toMatchObject({ ok: false, code: "55000" });
    expect(await one("select public.start_organization_learning_period(7) as r", [], world.adminB)).toMatchObject({ lengthDays: 7, running: true });
    const after = await counts();
    expect(after.ledger).toBe(before.ledger + 2);
    expect(after.events).toBe(before.events);
    const ledger = (await c.query("select event_type, action, entity_type, actor_user_id, metadata from public.organization_audit_ledger where organization_id = $1 and entity_type = 'learning_period'", [world.a.id])).rows;
    expect(ledger).toEqual([{ event_type: "learning_period_started", action: "settings_change", entity_type: "learning_period", actor_user_id: world.admin.id, metadata: { periodId: started.periodId, lengthDays: 14 } }]);
    // Every member sees the period; only the administrator is told they administer it.
    expect(await one("select public.get_organization_learning_period() as r", [], world.member)).toMatchObject({ running: true, isAdmin: false, periodId: started.periodId });
    expect(await call("select public.get_organization_learning_period()", [], null)).toMatchObject({ ok: false, code: "42501" });
  });

  it("serves an administrator with one organization and no chapter, and refuses an ambiguous one", async () => {
    async function chapterless(orgs) {
      const user = { id: randomUUID(), session: randomUUID() };
      await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
      for (const org of orgs) {
        await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
        await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [org.id, user.id]);
      }
      await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
      await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
      expect((await c.query("select chapter_id from public.member_profiles where id = $1", [user.id])).rows[0]?.chapter_id ?? null).toBeNull();
      return user;
    }
    const sole = await chapterless([world.a]);
    expect((await start(sole, 7)).rows?.[0].r).toMatchObject({ organizationId: world.a.id, running: true, lengthDays: 7 });
    expect(await one("select public.get_organization_learning_period() as r", [], sole)).toMatchObject({ organizationId: world.a.id, running: true });
    expect((await endEarly(sole)).rows?.[0].r).toMatchObject({ organizationId: world.a.id, running: false });
    const both = await chapterless([world.a, world.b]);
    expect(await start(both)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.get_organization_learning_period()", [], both)).toMatchObject({ ok: false, code: "42501" });
  });

  it("never starts a period for the platform organization", async () => {
    const existing = (await c.query("select id from public.organizations where kind = 'platform'")).rows[0];
    const platform = existing ? { id: existing.id, chapter: (await c.query("select id from public.chapters where organization_id = $1 limit 1", [existing.id])).rows[0]?.id } : await organization("platform", "platform");
    if (!platform.chapter) {
      platform.chapter = `learning-platform-${randomUUID().slice(0, 8)}`;
      await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98314)", [platform.chapter, platform.id]);
    }
    const operator = await person(platform, "admin");
    expect(await start(operator)).toMatchObject({ ok: false, code: "42501" });
    // The boundary refuses the row itself too.
    await c.query("savepoint direct");
    await expect(c.query("insert into private.organization_learning_periods(organization_id, length_days, starts_at, ends_at) values ($1, 7, now(), now() + interval '7 days')", [platform.id]))
      .rejects.toMatchObject({ code: "42501" });
    await c.query("rollback to savepoint direct");
  });

  it("journals only the caller's own registered actions while the period runs", async () => {
    expect(await owned("select private.learning_journal_append('proof_item_create', 'public.proof_items', 'x1', null, $1, null, '{\"title\":\"A\"}'::jsonb) as r", [fingerprint], world.member)).toBeNull();
    await one("select public.start_organization_learning_period() as r", [], world.admin);
    const created = await owned("select private.learning_journal_append('proof_item_create', 'public.proof_items', 'x1', null, $1, null, '{\"title\":\"A\"}'::jsonb) as r", [fingerprint], world.member);
    expect(created).toMatch(/^[0-9a-f-]{36}$/);
    const edited = await append(world.member, "proof_item_edit", "public.proof_items", "x1", { parent: created, fingerprint, image: { title: "A", status: "open" } });
    expect(edited).toMatchObject({ ok: true });
    for (const [kind, table, id, extra, codeWanted] of [
      ["proof_item_edit", "public.proof_items", "x1", { fingerprint, image: { title: "A", body: "secret" } }, "22023"],
      ["proof_item_edit", "public.proof_items", "x1", { image: { title: "A" } }, "22023"],
      ["proof_item_send", "public.proof_items", "x2", { fingerprint }, "22023"],
      ["proof_item_preview", "public.proof_items", "x2", { image: { title: "A" } }, "22023"],
      ["proof_item_create", "public.other_items", "x2", { fingerprint, image: { title: "A" } }, "22023"],
      ["proof_item_unknown", "public.proof_items", "x2", {}, "22023"],
      ["proof_item_edit", "public.proof_items", "x1", { parent: created, fingerprint, image: { title: "A" } }, null],
    ]) {
      const result = await append(codeWanted ? world.member : world.otherMember, kind, table, id, extra);
      if (codeWanted) expect(result, kind).toMatchObject({ ok: false, code: codeWanted });
      else expect(result, "another person's parent").toMatchObject({ ok: false, code: "22023" });
    }
    expect((await append(world.member, "proof_item_ignored", null, "x2")).rows[0].r).toBeNull();
    const sent = (await append(world.member, "proof_item_send", "public.proof_items", "x3")).rows[0].r;
    const entries = (await c.query("select id, actor_user_id, state, before_image, after_fingerprint, kept_at is not null as kept from private.learning_action_journal where organization_id = $1 order by created_at, id", [world.a.id])).rows;
    expect(entries.map((row) => [row.id, row.actor_user_id, row.state, row.kept])).toEqual([
      [created, world.member.id, "active", false], [edited.rows[0].r, world.member.id, "active", false], [sent, world.member.id, "kept", true],
    ]);
    expect(entries[2]).toMatchObject({ before_image: null, after_fingerprint: null });
    // Another organization's member is never journalled into this period.
    expect((await append(world.adminB, "proof_item_send", "public.proof_items", "x4")).rows[0].r).toBeNull();
  });

  it("stops journalling by the wall clock even inside a transaction that began before the end", async () => {
    // A period that ends in a second and a half: the fixture row is written
    // directly, the way only migration-owned code could.
    await c.query("insert into private.organization_learning_periods(organization_id, length_days, starts_at, ends_at, started_by) select $1, 7, t.at - interval '168 hours', t.at, $2 from (select clock_timestamp() + interval '1.5 seconds' as at) t", [world.a.id, world.admin.id]);
    expect((await append(world.member, "proof_item_send", "public.proof_items", "x5")).rows[0].r).toMatch(/^[0-9a-f-]{36}$/);
    await c.query("select pg_sleep(2)");
    // now() is still the transaction start, before the end; the clock is not.
    expect((await c.query("select now() < (select ends_at from private.organization_learning_periods where organization_id = $1) as before", [world.a.id])).rows[0].before).toBe(true);
    expect((await append(world.member, "proof_item_send", "public.proof_items", "x6")).rows[0].r).toBeNull();
    expect((await c.query("select private.learning_period_running($1) as r", [world.a.id])).rows[0].r).toBeNull();
  });

  it("marks created items as practice for good and changed items only while the period runs", async () => {
    await one("select public.start_organization_learning_period() as r", [], world.admin);
    await append(world.member, "proof_item_create", "public.proof_items", "made", { fingerprint, image: { title: "A" } });
    await append(world.member, "proof_item_edit", "public.proof_items", "changed", { fingerprint, image: { title: "B" } });
    await append(world.member, "proof_item_send", "public.proof_items", "sent");
    const undone = (await append(world.member, "proof_item_create", "public.proof_items", "gone", { fingerprint, image: { title: "C" } })).rows[0].r;
    await c.query("update private.learning_action_journal set state = 'undone', undone_at = clock_timestamp(), version = version + 1 where id = $1", [undone]);
    expect(await flags("public.proof_items", ["made", "changed", "sent", "gone", "never"])).toEqual({ made: "practice", changed: "practice_edit", sent: "practice" });
    expect(await flags("public.other_items", ["made"])).toEqual({});

    const before = await counts();
    const ended = await one("select public.end_organization_learning_period_early() as r", [], world.admin);
    expect(ended).toMatchObject({ running: false, used: true });
    expect(ended.endedEarlyAt).not.toBeNull();
    expect(ended.closedAt).not.toBeNull();
    expect(await flags("public.proof_items", ["made", "changed", "sent", "gone"])).toEqual({ made: "practice", sent: "practice" });
    const states = (await c.query("select target_id, state, before_image from private.learning_action_journal where organization_id = $1 order by target_id", [world.a.id])).rows;
    expect(states).toEqual([
      { target_id: "changed", state: "kept", before_image: null }, { target_id: "gone", state: "undone", before_image: null },
      { target_id: "made", state: "kept", before_image: null }, { target_id: "sent", state: "kept", before_image: null },
    ]);
    const after = await counts();
    expect(after.ledger).toBe(before.ledger + 2);
    expect(after.events).toBe(before.events);
    const closed = (await c.query("select event_type, actor_user_id, metadata from public.organization_audit_ledger where organization_id = $1 and event_type in ('learning_period_ended_early', 'learning_period_closed') order by event_type", [world.a.id])).rows;
    expect(closed).toEqual([
      { event_type: "learning_period_closed", actor_user_id: null, metadata: { periodId: ended.periodId, keptCount: 2, undoneCount: 1, imagesCleared: 3 } },
      { event_type: "learning_period_ended_early", actor_user_id: world.admin.id, metadata: { periodId: ended.periodId } },
    ]);
    // Closing again, twice, changes nothing and appends nothing.
    for (let run = 0; run < 2; run += 1) {
      expect((await c.query("select private.close_learning_period($1) as r", [ended.periodId])).rows[0].r).toEqual({ periodId: ended.periodId, closed: true, changed: false,
        // Slice 6 (20261104111500) reports what it finished; nothing here.
        heldRemovalsRedacted: 0, heldRemovalsSuspended: 0, heldRevokesFinished: 0 });
    }
    expect(await counts()).toEqual(after);
    // One-way: no second end, no restart.
    expect(await endEarly(world.admin)).toMatchObject({ ok: false, code: "55000" });
    expect(await start(world.admin)).toMatchObject({ ok: false, code: "55000" });
  });

  it("keeps an entry still active when a closed period is closed again, and changes nothing after", async () => {
    const started = await one("select public.start_organization_learning_period() as r", [], world.admin);
    await one("select public.end_organization_learning_period_early() as r", [], world.admin);
    const straggler = (await c.query("insert into private.learning_action_journal (organization_id, period_id, actor_user_id, action_kind, target_table, target_id, after_fingerprint, before_image, state) values ($1, $2, $3, 'proof_item_edit', 'public.proof_items', 's1', $4, '{\"title\":\"A\"}', 'active') returning id", [world.a.id, started.periodId, world.member.id, fingerprint])).rows[0].id;
    expect((await c.query("select private.close_learning_period($1) as r", [started.periodId])).rows[0].r).toMatchObject({ closed: true, changed: true });
    expect((await c.query("select state, before_image, kept_at is not null as kept from private.learning_action_journal where id = $1", [straggler])).rows[0]).toEqual({ state: "kept", before_image: null, kept: true });
    expect((await c.query("select private.close_learning_period($1) as r", [started.periodId])).rows[0].r).toMatchObject({ closed: true, changed: false });
  });

  it("lets only an administrator in a verified session end the period early", async () => {
    await one("select public.start_organization_learning_period() as r", [], world.admin);
    for (const [user, aal] of [[world.member, "aal2"], [world.steward, "aal2"], [world.admin, "aal1"], [world.adminB, "aal2"], [null, "aal2"]]) {
      expect(await endEarly(user, aal), `${user?.id ?? "anon"} ${aal}`).toMatchObject({ ok: false, code: user === world.adminB ? "55000" : "42501" });
    }
    expect(await endEarly(world.admin)).toMatchObject({ ok: true });
    // A running period cannot be closed before its end.
    const other = await one("select public.start_organization_learning_period() as r", [], world.adminB);
    await c.query("savepoint early");
    await expect(c.query("select private.close_learning_period($1)", [other.periodId])).rejects.toMatchObject({ code: "55000" });
    await c.query("rollback to savepoint early");
  });

  it("keeps a period's dates fixed and its journal entries' identity fixed", async () => {
    const started = await one("select public.start_organization_learning_period() as r", [], world.admin);
    for (const statement of [
      "update private.organization_learning_periods set ends_at = ends_at + interval '168 hours', length_days = 21 where id = $1",
      "update private.organization_learning_periods set starts_at = starts_at - interval '24 hours', ends_at = ends_at - interval '24 hours' where id = $1",
      "update private.organization_learning_periods set started_by = gen_random_uuid() where id = $1",
    ]) {
      await c.query("savepoint fixed");
      await expect(c.query(statement, [started.periodId])).rejects.toMatchObject({ code: expect.stringMatching(/^(55000|23503)$/) });
      await c.query("rollback to savepoint fixed");
    }
    const entry = (await append(world.member, "proof_item_edit", "public.proof_items", "fixed", { fingerprint, image: { title: "A" } })).rows[0].r;
    for (const statement of [
      "update private.learning_action_journal set target_id = 'other' where id = $1",
      "update private.learning_action_journal set state = 'kept', kept_at = now() where id = $1",
      "update private.learning_action_journal set before_image = '{\"title\":\"Z\"}' where id = $1",
    ]) {
      await c.query("savepoint fixed");
      await expect(c.query(statement, [entry])).rejects.toMatchObject({ code: "55000" });
      await c.query("rollback to savepoint fixed");
    }
  });

  // ---- Undo, with a fixture domain standing in for a slice ---------------
  async function fixtureDomain() {
    await c.query("create table public.proof_items (id text primary key, title text not null, status text not null default 'open', deleted_at timestamptz)");
    await c.query("create table public.proof_holds (id text primary key)");
    await c.query(`create function private.learning_undo_proof_item(p_mode text, p_entry jsonb) returns jsonb
      language plpgsql security definer set search_path = '' as $f$
      declare item public.proof_items%rowtype;
      begin
        if p_mode = 'lock' then
          perform 1 from public.proof_items i where i.id = p_entry ->> 'target_id' for update;
          -- A key another session can hold without seeing this row.
          perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('proof-target:' || (p_entry ->> 'target_id')));
          return null;
        end if;
        if p_mode = 'state' then
          select * into item from public.proof_items i where i.id = p_entry ->> 'target_id' and i.deleted_at is null;
          return case when found then pg_catalog.jsonb_build_object('title', item.title, 'status', item.status) end;
        end if;
        if p_mode = 'before' then return case when p_entry ->> 'action_kind' = 'proof_item_create' then null else p_entry -> 'before_image' end; end if;
        if p_mode = 'check' then
          if exists (select 1 from public.proof_holds h where h.id = p_entry ->> 'target_id') then raise exception 'legal hold' using errcode = 'P0001'; end if;
          return null;
        end if;
        if p_entry ->> 'action_kind' = 'proof_item_create' then
          update public.proof_items i set deleted_at = pg_catalog.clock_timestamp() where i.id = p_entry ->> 'target_id';
        else
          update public.proof_items i set title = p_entry -> 'before_image' ->> 'title', status = p_entry -> 'before_image' ->> 'status' where i.id = p_entry ->> 'target_id';
        end if;
        return null;
      end $f$`);
    // A slice re-emits the dispatcher with one branch per handler; so does the fixture.
    await c.query(`create or replace function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb) returns jsonb
      language plpgsql volatile security definer set search_path = '' as $f$
      begin
        if p_mode is null or p_mode not in ('lock', 'state', 'before', 'check', 'apply') then
          raise exception 'invalid learning undo dispatch' using errcode = '22023';
        end if;
        case p_handler
          when 'private.learning_undo_proof_item' then return private.learning_undo_proof_item(p_mode, p_entry);
          else raise exception 'learning undo handler unavailable: %', p_handler using errcode = '55000';
        end case;
      end $f$`);
  }
  const stateOf = async (id) => (await c.query("select title, status, deleted_at is not null as deleted from public.proof_items where id = $1", [id])).rows[0];
  const print = async (state) => (await c.query("select private.learning_fingerprint($1::jsonb) as f", [JSON.stringify(state)])).rows[0].f;
  async function create(user, id, title) {
    await c.query("insert into public.proof_items(id, title) values ($1, $2)", [id, title]);
    return (await append(user, "proof_item_create", "public.proof_items", id, { fingerprint: await print({ title, status: "open" }), image: { title } })).rows[0].r;
  }
  async function edit(user, id, title, status = "open") {
    const before = await stateOf(id);
    await c.query("update public.proof_items set title = $2, status = $3 where id = $1", [id, title, status]);
    const result = await append(user, "proof_item_edit", "public.proof_items", id, { fingerprint: await print({ title, status }), image: { title: before.title, status: before.status } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0].r;
  }
  const undo = (user, entry, version = 1) => call("select public.undo_my_learning_action($1, $2) as r", [entry, version], user);
  const journal = async (ids) => Object.fromEntries((await c.query("select id, state, version from private.learning_action_journal where id = any($1::uuid[])", [ids])).rows.map((row) => [row.id, `${row.state}@${row.version}`]));

  it("undoes your own action with every later step of yours on it, newest first, against the projected state", async () => {
    await fixtureDomain();
    await one("select public.start_organization_learning_period() as r", [], world.admin);
    const made = await create(world.member, "p1", "A");
    const first = await edit(world.member, "p1", "B");
    const second = await edit(world.member, "p1", "C", "done");
    const before = await counts();
    // Anyone else's entry reads as not found, exactly like a missing one.
    for (const [user, entry] of [[world.otherMember, first], [world.admin, first], [world.member, randomUUID()]]) {
      expect(await undo(user, entry), user.id).toMatchObject({ ok: false, code: "P0002" });
    }
    expect(await undo(world.member, first, 2)).toMatchObject({ ok: false, code: "PT409" });
    const result = await one("select public.undo_my_learning_action($1, 1) as r", [first], world.member);
    expect(result).toEqual({ status: "undone", entryId: first, version: 2, undoneCount: 2 });
    expect(await stateOf("p1")).toEqual({ title: "A", status: "open", deleted: false });
    expect(await journal([made, first, second])).toEqual({ [made]: "active@1", [first]: "undone@2", [second]: "undone@2" });
    const after = await counts();
    expect(after.ledger).toBe(before.ledger + 2);
    expect(after.events).toBe(before.events);
    const rows = (await c.query("select metadata from public.organization_audit_ledger where organization_id = $1 and event_type = 'learning_action_undone' order by occurred_at, id", [world.a.id])).rows.map((row) => row.metadata.entryId);
    expect(rows.sort()).toEqual([first, second].sort());
    // Repeating is harmless; undoing the creation now hides the item without deleting it.
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [first], world.member)).toEqual({ status: "already_undone", entryId: first, version: 2 });
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [made], world.member)).toMatchObject({ status: "undone", undoneCount: 1 });
    expect(await stateOf("p1")).toEqual({ title: "A", status: "open", deleted: true });
    expect(await flags("public.proof_items", ["p1"])).toEqual({});
  });

  it("undoes a whole bulk action when any step of it is in the chain, and refuses when its parent cannot be undone", async () => {
    await fixtureDomain();
    await one("select public.start_organization_learning_period() as r", [], world.admin);
    await create(world.member, "x1", "A");
    await create(world.member, "y1", "P");
    const earlier = await edit(world.member, "x1", "B");
    // One bulk action: a parent entry and one child per row it changed.
    const bulk = (await append(world.member, "proof_item_preview", "public.proof_items", "bulk-1")).rows[0].r;
    async function child(parent, id, title) {
      const before = await stateOf(id);
      await c.query("update public.proof_items set title = $2 where id = $1", [id, title]);
      const result = await append(world.member, "proof_item_edit", "public.proof_items", id, { parent, fingerprint: await print({ title, status: "open" }), image: { title: before.title, status: before.status } });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      return result.rows[0].r;
    }
    const onX = await child(bulk, "x1", "C");
    const onY = await child(bulk, "y1", "Q");
    // Undoing the earlier edit reaches the bulk child on x1, so the parent and
    // its child on y1 are undone with it.
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [earlier], world.member)).toMatchObject({ status: "undone", undoneCount: 4 });
    expect(await journal([earlier, bulk, onX, onY])).toEqual({ [earlier]: "undone@2", [bulk]: "undone@2", [onX]: "undone@2", [onY]: "undone@2" });
    expect(await stateOf("x1")).toEqual({ title: "A", status: "open", deleted: false });
    expect(await stateOf("y1")).toEqual({ title: "P", status: "open", deleted: false });
    // A child whose parent was sent (kept from the start) is never undone alone.
    const sent = (await append(world.member, "proof_item_send", "public.proof_items", "bulk-2")).rows[0].r;
    const underSent = await child(sent, "y1", "R");
    expect(await undo(world.member, underSent)).toMatchObject({ ok: false, code: "55000" });
    expect((await journal([underSent]))[underSent]).toBe("active@1");
  });

  it("refuses when someone else changed the item, when a hold covers it, or when the action was sent, and changes nothing", async () => {
    await fixtureDomain();
    await one("select public.start_organization_learning_period() as r", [], world.admin);
    await create(world.member, "p2", "A");
    const mine = await edit(world.member, "p2", "B");
    // A change nobody journalled (another person, a worker): the fingerprint no longer matches.
    await c.query("update public.proof_items set title = 'X' where id = 'p2'");
    expect(await undo(world.member, mine)).toMatchObject({ ok: false, code: "PT409" });
    await c.query("update public.proof_items set title = 'B' where id = 'p2'");
    // Another person sending something about the item does not block; it stays sent.
    await append(world.otherMember, "proof_item_send", "public.proof_items", "p2");
    expect(await undo(world.member, mine)).toMatchObject({ ok: true });
    await c.query("update public.proof_items set title = 'B' where id = 'p2'");
    const mineAgain = await edit(world.member, "p2", "B2");
    // Another person's later journalled change on the same item does.
    await c.query("update public.proof_items set title = 'D' where id = 'p2'");
    await append(world.otherMember, "proof_item_edit", "public.proof_items", "p2", { fingerprint: await print({ title: "D", status: "open" }), image: { title: "B2", status: "open" } });
    expect(await undo(world.member, mineAgain)).toMatchObject({ ok: false, code: "PT409" });
    expect((await journal([mineAgain]))[mineAgain]).toBe("active@1");
    // A legal hold, checked by the domain handler after the locks: everything rolls back.
    await create(world.member, "p3", "A");
    const held = await edit(world.member, "p3", "B");
    const again = await edit(world.member, "p3", "C");
    await c.query("insert into public.proof_holds values ('p3')");
    const before = await counts();
    expect(await undo(world.member, held)).toMatchObject({ ok: false, code: "P0001" });
    expect(await stateOf("p3")).toEqual({ title: "C", status: "open", deleted: false });
    expect(await journal([held, again])).toEqual({ [held]: "active@1", [again]: "active@1" });
    expect(await counts()).toEqual(before);
    // Already sent: metadata only, never undoable.
    const sent = (await append(world.member, "proof_item_send", "public.proof_items", "p4")).rows[0].r;
    expect(await undo(world.member, sent)).toMatchObject({ ok: false, code: "55000" });
    // A simulated action has no effect to reverse; undo just retires it.
    const preview = (await append(world.member, "proof_item_preview", "public.proof_items", "p5")).rows[0].r;
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [preview], world.member)).toMatchObject({ status: "undone", undoneCount: 1 });
  });

  it("lists your own practice history only, newest first, with Undo where it is open", async () => {
    await fixtureDomain();
    await one("select public.start_organization_learning_period() as r", [], world.admin);
    const made = await create(world.member, "h1", "A");
    const sent = (await append(world.member, "proof_item_send", "public.proof_items", "h2")).rows[0].r;
    await create(world.otherMember, "h3", "Z");
    const history = await one("select public.list_my_learning_history(10) as r", [], world.member);
    expect(history.running).toBe(true);
    expect(history.entries.map((entry) => [entry.id, entry.state, entry.undoable, entry.sent])).toEqual([[sent, "kept", false, true], [made, "active", true, false]]);
    expect((await one("select public.list_my_learning_history(1) as r", [], world.member)).entries).toHaveLength(1);
    await one("select public.end_organization_learning_period_early() as r", [], world.admin);
    const after = await one("select public.list_my_learning_history() as r", [], world.member);
    expect(after.running).toBe(false);
    expect(after.entries.map((entry) => [entry.state, entry.undoable])).toEqual([["kept", false], ["kept", false]]);
    expect(await undo(world.member, made)).toMatchObject({ ok: false, code: "55000" });
  });

  it("runs the end job once per step: reminders before the end, then close and one ended notice to every member", async () => {
    await fixtureDomain();
    const notices = async () => (await c.query("select user_id, title from public.member_notifications where organization_id = $1 order by created_at, id", [world.a.id])).rows;
    // A period two days from its end, with one person's practice actions.
    await c.query("insert into private.organization_learning_periods(organization_id, length_days, starts_at, ends_at, started_by) select $1, 7, t.at - interval '168 hours', t.at, $2 from (select clock_timestamp() + interval '48 hours' as at) t", [world.a.id, world.admin.id]);
    await create(world.member, "e1", "A");
    await create(world.member, "e2", "B");
    // The scheduler runs it with no request claims.
    const job = async () => {
      await c.query("select set_config('request.jwt.claims', '', true)");
      return (await c.query("select public.run_learning_period_end_job() as r")).rows[0].r;
    };
    expect(await job()).toMatchObject({ reminded: 1 });
    expect(await job()).toMatchObject({ reminded: 0, finished: 0 });
    expect(await notices()).toEqual([{ user_id: world.member.id, title: "Your learning period ends soon" }]);
    // The same organization's period is ended (the fixture moves the clock by rewriting the row).
    await c.query("alter table private.organization_learning_periods disable trigger b10_learning_period_guard");
    // One captured instant for both ends: the length check is exact.
    await c.query("update private.organization_learning_periods p set starts_at = t.at - interval '169 hours', ends_at = t.at - interval '1 hour' from (select clock_timestamp() as at) t where p.organization_id = $1", [world.a.id]);
    await c.query("alter table private.organization_learning_periods enable trigger b10_learning_period_guard");
    const before = await counts();
    expect(await job()).toMatchObject({ finished: 1 });
    const members = (await c.query("select count(*)::int as n from public.organization_memberships where organization_id = $1 and status = 'active'", [world.a.id])).rows[0].n;
    expect((await notices()).filter((row) => row.title === "The learning period has ended")).toHaveLength(members);
    for (let run = 0; run < 2; run += 1) expect(await job()).toEqual({ reminded: 0, finished: 0 });
    const after = await counts();
    expect(after.ledger).toBe(before.ledger + 1);
    expect(after.events).toBe(before.events);
    expect((await c.query("select count(*)::int as n from public.member_notifications where organization_id = $1", [world.a.id])).rows[0].n).toBe(members + 1);
    expect(await flags("public.proof_items", ["e1", "e2"])).toEqual({ e1: "practice", e2: "practice" });
    expect(await call("select public.run_learning_period_end_job()", [], world.admin)).toMatchObject({ ok: false, code: "42501" });
  });

  it("refuses an undo that waited on a lock past the end, by the wall clock read after the locks", async () => {
    await fixtureDomain();
    await c.query("insert into private.organization_learning_periods(organization_id, length_days, starts_at, ends_at, started_by) select $1, 7, t.at - interval '168 hours', t.at, $2 from (select clock_timestamp() + interval '1.5 seconds' as at) t", [world.a.id, world.admin.id]);
    await create(world.member, "w1", "A");
    const late = await edit(world.member, "w1", "B");
    const holder = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-lock-holder" });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('proof-target:w1'))");
      const release = new Promise((resolve) => setTimeout(() => holder.query("rollback").then(resolve), 2500));
      const result = await undo(world.member, late);
      await release;
      expect(result).toMatchObject({ ok: false, code: "55000" });
    } finally {
      await holder.end();
    }
    expect((await journal([late]))[late]).toBe("active@1");
    expect(await stateOf("w1")).toEqual({ title: "B", status: "open", deleted: false });
  }, 30000);

  it("ships a dispatcher that calls no handler until a slice adds one", async () => {
    await one("select public.start_organization_learning_period() as r", [], world.admin);
    const entry = (await append(world.member, "proof_item_edit", "public.proof_items", "d1", { fingerprint, image: { title: "A" } })).rows[0].r;
    expect(await undo(world.member, entry)).toMatchObject({ ok: false, code: "55000", message: "learning undo handler unavailable: private.learning_undo_proof_item" });
    expect((await journal([entry]))[entry]).toBe("active@1");
  });

  it("gives clients no direct access to any learning table", async () => {
    for (const table of TABLES) {
      for (const user of [world.admin, null]) {
        expect(await call(`select * from private.${table}`, [], user), `${table} ${user ? "admin" : "anon"}`).toMatchObject({ ok: false, code: "42501" });
      }
    }
    for (const fn of ["private.learning_journal_append('proof_item_send', 'public.proof_items', 'x', null, null, null, null)", "private.learning_practice_flags('public.proof_items', array['x'])", "private.close_learning_period(gen_random_uuid())"]) {
      expect(await call(`select ${fn}`, [], world.admin), fn).toMatchObject({ ok: false, code: "42501" });
    }
  });
});

// Two sessions need committed rows to see each other's work, so this block
// commits its own fixtures and removes every one of them afterwards.
live("learning period undo across two sessions", () => {
  let one;
  let two;
  const ids = { org: randomUUID(), member: randomUUID(), session: randomUUID(), admin: randomUUID(), adminSession: randomUUID() };
  const chapter = `learning-concurrency-${ids.org.slice(0, 8)}`;
  const as = async (client, user, session, text, values = []) => {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: user, session_id: session, aal: "aal2" })]);
    await client.query("set local role authenticated");
    const rows = (await client.query(text, values)).rows;
    await client.query("reset role");
    return rows;
  };
  beforeAll(async () => {
    one = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-concurrency-one" });
    two = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-concurrency-two" });
    await one.connect();
    await two.connect();
    await one.query("begin");
    await one.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [ids.org, chapter]);
    await one.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98315)", [chapter, ids.org]);
    for (const [user, session, role] of [[ids.member, ids.session, null], [ids.admin, ids.adminSession, "admin"]]) {
      await one.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
      await one.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [ids.org, user]);
      await one.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user, chapter]);
      await one.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
      if (role) await one.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [ids.org, user, role]);
      await one.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
      await one.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, user]);
    }
    await one.query("insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values ('proof_concurrent_edit', 'tasks', 'simulate', 'public.proof_concurrent', false, null, array[]::text[], 'fixture')");
    await one.query("commit");
    await one.query("begin");
    await whileLearningPeriodReleased(one, () => as(one, ids.admin, ids.adminSession, "select public.start_organization_learning_period()"));
    await one.query("commit");
    await one.query("begin");
    await one.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: ids.member, session_id: ids.session, aal: "aal2" })]);
    ids.entry = (await one.query("select private.learning_journal_append('proof_concurrent_edit', 'public.proof_concurrent', 'c1') as id")).rows[0].id;
    await one.query("commit");
  });
  afterAll(async () => {
    // Fixture removal only: the append-only ledger and the period guard are
    // bypassed for this throwaway organization alone.
    await one.query("begin");
    await one.query("set local session_replication_role = replica");
    // Every row that names the fixture organization or people, including the
    // ones triggers created for them, then the people, chapter and organization.
    const children = (await one.query(`select c.conrelid::regclass::text as child, a.attname as col, c.confrelid = 'public.organizations'::regclass as org
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and pg_catalog.cardinality(c.conkey) = 1
        and c.confrelid in ('public.organizations'::regclass, 'auth.users'::regclass)
        and c.conrelid not in ('public.organizations'::regclass, 'auth.users'::regclass)`)).rows;
    for (const { child, col, org } of children) {
      await one.query(`delete from ${child} where ${col}::text = any($1::text[])`, [org ? [ids.org] : [ids.member, ids.admin]]);
    }
    await one.query("delete from private.learning_action_kinds where action_kind = 'proof_concurrent_edit'");
    await one.query("delete from auth.users where id = any($1::uuid[])", [[ids.member, ids.admin]]);
    await one.query("delete from public.chapters where id = $1", [chapter]);
    await one.query("delete from public.organizations where id = $1", [ids.org]);
    await one.query("commit");
    expect((await one.query("select count(*)::int as n from public.organizations where id = $1", [ids.org])).rows[0].n).toBe(0);
    await one?.end();
    await two?.end();
  });

  it("serializes two simultaneous undos of one entry and the second sees it undone", async () => {
    await one.query("begin");
    const first = await as(one, ids.member, ids.session, "select public.undo_my_learning_action($1, 1) as r", [ids.entry]);
    expect(first[0].r).toMatchObject({ status: "undone", undoneCount: 1 });
    await two.query("begin");
    const second = as(two, ids.member, ids.session, "select public.undo_my_learning_action($1, 1) as r", [ids.entry]);
    let settled = false;
    second.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(settled).toBe(false);
    await one.query("commit");
    expect((await second)[0].r).toEqual({ status: "already_undone", entryId: ids.entry, version: 2 });
    await two.query("commit");
    const ledger = (await one.query("select count(*)::int as n from public.organization_audit_ledger where organization_id = $1 and event_type = 'learning_action_undone'", [ids.org])).rows[0].n;
    expect(ledger).toBe(1);
  }, 30000);

  const pending = (promise) => {
    const state = { settled: false };
    promise.then(() => { state.settled = true; }, () => { state.settled = true; });
    return state;
  };
  const claimsAsMember = (client) => client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: ids.member, session_id: ids.session, aal: "aal2" })]);
  const settle = async () => { await one.query("rollback").catch(() => {}); await two.query("rollback").catch(() => {}); };

  it("keeps an entry journalled while the period was closing: the close waits for it", async () => {
    try {
      await one.query("begin");
      // The definer RPC that appends runs as the owner with the person's claims.
      await claimsAsMember(one);
      const entry = (await one.query("select private.learning_journal_append('proof_concurrent_edit', 'public.proof_concurrent', 'c2') as id")).rows[0].id;
      expect(entry).toBeTruthy();
      await two.query("begin");
      const ending = as(two, ids.admin, ids.adminSession, "select public.end_organization_learning_period_early() as r");
      const state = pending(ending);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(state.settled).toBe(false);
      await one.query("commit");
      expect((await ending)[0].r).toMatchObject({ running: false });
      expect((await two.query("select state, before_image from private.learning_action_journal where id = $1", [entry])).rows[0]).toEqual({ state: "kept", before_image: null });
      // Roll the close back so the next order can be proved on the same period.
      await two.query("rollback");
      await one.query("begin");
      await as(one, ids.member, ids.session, "select public.undo_my_learning_action($1, 1)", [entry]);
      await one.query("commit");
    } finally {
      await settle();
    }
  }, 30000);

  it("never journals into a period that closed after the writer's snapshot", async () => {
    try {
      // A repeatable-read writer whose snapshot predates the close: its
      // first clock read still sees the period running, and the hold on the
      // period row refuses it instead of leaving an active entry behind.
      await one.query("begin isolation level repeatable read");
      await one.query("select count(*) from private.organization_learning_periods where organization_id = $1", [ids.org]);
      await two.query("begin");
      await as(two, ids.admin, ids.adminSession, "select public.end_organization_learning_period_early()");
      await two.query("commit");
      await claimsAsMember(one);
      await expect(one.query("select private.learning_journal_append('proof_concurrent_edit', 'public.proof_concurrent', 'c3') as id")).rejects.toMatchObject({ code: "40001" });
      await one.query("rollback");
      // A read-committed writer reads the close and journals nothing.
      await one.query("begin");
      await claimsAsMember(one);
      expect((await one.query("select private.learning_journal_append('proof_concurrent_edit', 'public.proof_concurrent', 'c4') as id")).rows[0].id).toBeNull();
      await one.query("commit");
      const left = (await one.query("select count(*)::int as n from private.learning_action_journal where organization_id = $1 and state = 'active'", [ids.org])).rows[0].n;
      expect(left).toBe(0);
    } finally {
      await settle();
    }
  }, 30000);
});
