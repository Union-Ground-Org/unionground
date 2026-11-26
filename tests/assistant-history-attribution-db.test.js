// @vitest-environment node
//
// REQ-UG-ASSISTANT-HISTORY-LEGACY-ORG-ATTRIBUTION-20261003
//
// 20261003050000 scoped assistant history to its organization and left older
// threads and messages unstamped, so they vanished from every assistant.
// 20261008230000 stamps a legacy thread, and its messages, with the owner's
// organization only when the owner has exactly one active membership in an
// active organization. Owners with none or several keep NULL rows; rows already
// stamped are untouched; the stamp stays immutable afterwards; and the stamp
// gives no administrator or officer a read. The live cases seed legacy rows
// and run the migration's own text inside a transaction that is rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261008230000_assistant_history_legacy_org_attribution";
const migrationSql = loadMigrationSql(MIGRATION);
const TRIGGERS = [
  "public.member_guide_threads disable trigger stamp_retention_scope",
  "public.member_guide_threads disable trigger member_guide_threads_touch_updated_at",
  "public.member_guide_messages disable trigger stamp_retention_scope",
];

describe("assistant history attribution (static)", () => {
  const sql = stripComments(migrationSql);

  it("holds only the two named triggers, inside one transaction, and enables them again", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const disables = [...sql.matchAll(/alter table ([\w.]+ disable trigger \w+);/g)].map((match) => match[1]);
    const enables = [...sql.matchAll(/alter table ([\w.]+) enable trigger (\w+);/g)].map((match) => `${match[1]} disable trigger ${match[2]}`);
    expect(disables).toEqual(TRIGGERS);
    expect(enables).toEqual(TRIGGERS);
    expect(sql.lastIndexOf("disable trigger")).toBeLessThan(sql.indexOf("update public.member_guide_threads"));
    expect(sql.indexOf("enable trigger")).toBeGreaterThan(sql.lastIndexOf("update public.member_guide_messages"));
    expect(sql).not.toMatch(/session_replication_role|disable trigger (all|user)\b/i);
    expect(sql).not.toMatch(/create (or replace )?(function|policy|trigger)|drop |grant |revoke /i);
  });

  it("stamps only NULL rows of owners with exactly one active organization", () => {
    expect(sql).toContain("join public.organizations o on o.id = om.organization_id and o.status = 'active'");
    expect(sql).toContain("where om.status = 'active'");
    expect(sql).toContain("having pg_catalog.count(distinct om.organization_id) = 1");
    expect(sql).toMatch(/update public\.member_guide_threads t\s+set organization_id = s\.organization_id\s+from sole_organization s\s+where t\.organization_id is null\s+and t\.user_id = s\.user_id/);
    expect(sql).toMatch(/update public\.member_guide_messages m\s+set organization_id = st\.organization_id\s+from stamped_threads st\s+where m\.thread_id = st\.id\s+and m\.user_id = st\.user_id\s+and m\.organization_id is null;/);
  });

  it("leaves the immutability trigger function as 20261003050000 defined it", () => {
    const definers = migrationFiles()
      .filter(({ sql: text }) => /function private\.stamp_retention_member_scope\(/.test(stripComments(text)))
      .map(({ name }) => name);
    expect(definers).toEqual(["20261003050000_automation_minutes_exports_retention_sources.sql"]);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("assistant history attribution on a disposable database", () => {
  let client;
  const backfill = migrationSql.replace(/^\s*begin;/, "").replace(/commit;\s*$/, "");

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "assistant-history-attribution-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '30s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const orgC = randomUUID();
    await client.query("insert into public.organizations(id,slug,name,status) values ($1,$2,$3,'active'), ($4,$5,$6,'active'), ($7,$8,$9,'suspended')",
      [orgA, `cpl-${orgA}`, `Copperline Library Workers ${orgA}`, orgB, `pkt-${orgB}`, `Port Kinsey Transit ${orgB}`, orgC, `hvw-${orgC}`, `Halvern Water ${orgC}`]);
    const library = `cpl-main-${orgA}`;
    const depot = `pkt-depot-${orgB}`;
    const plant = `hvw-plant-${orgC}`;
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Main Branch',$1,'proof',$4,9981), ($2,'Depot',$2,'proof',$5,9982), ($3,'Plant',$3,'proof',$6,9983)`,
      [library, depot, plant, orgA, orgB, orgC]);
    return { orgA, orgB, orgC, library, depot, plant };
  }

  async function account() {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set full_name=$2 where id=$1", [id, `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    return id;
  }

  async function join(id, organization, chapter, { role = null, orgRole = null } = {}) {
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [organization, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    if (role) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
    }
    if (orgRole) await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3)", [organization, id, orgRole]);
  }

  // A conversation written as the table owner, as the assistant did before
  // 20261003050000: the insert trigger stamps whatever organization the owner
  // has at that moment, NULL when they have none.
  async function conversation(owner) {
    const thread = (await client.query(
      "insert into public.member_guide_threads(user_id,title,created_at,updated_at) values ($1,'Overtime question','2026-05-01 12:00+00','2026-05-02 12:00+00') returning id",
      [owner])).rows[0].id;
    await client.query(
      "insert into public.member_guide_messages(thread_id,user_id,role,body,created_at) values ($1,$2,'user','How is overtime paid?','2026-05-02 11:59+00'), ($1,$2,'assistant','Article 12 covers overtime.','2026-05-02 12:00+00')",
      [thread, owner]);
    return thread;
  }

  async function stamps(thread) {
    const row = (await client.query("select organization_id, updated_at::text as updated_at from public.member_guide_threads where id=$1", [thread])).rows[0];
    const messages = (await client.query("select organization_id from public.member_guide_messages where thread_id=$1 order by created_at", [thread])).rows;
    return { thread: row.organization_id, updatedAt: row.updated_at, messages: messages.map((message) => message.organization_id) };
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
  }

  async function asOwner() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function capture(statement, args = []) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, rows: result.rowCount, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, rows: 0, code: error.code || "", message: error.message || "" };
    }
  }

  // What `reader` sees of `owner`'s history directly through the tables the
  // assistant reads.
  async function visible(reader, owner) {
    await actAs(reader);
    const threads = (await client.query("select count(*)::int as n from public.member_guide_threads where user_id=$1", [owner])).rows[0].n;
    const messages = (await client.query("select count(*)::int as n from public.member_guide_messages where user_id=$1", [owner])).rows[0].n;
    await asOwner();
    return { threads, messages };
  }

  async function runBackfill() {
    await client.query(backfill);
  }

  it("attributes a single-organization owner's legacy history and shows it in that organization's assistant", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const member = await account();
      const thread = await conversation(member);
      await join(member, t.orgA, t.library);
      // A revoked membership and one in a suspended organization do not count.
      const formerOrgMember = await account();
      const formerThread = await conversation(formerOrgMember);
      await join(formerOrgMember, t.orgB, t.depot);
      await client.query("update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2", [t.orgB, formerOrgMember]);
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [t.orgC, formerOrgMember]);
      await join(formerOrgMember, t.orgA, t.library);

      const before = await stamps(thread);
      expect(before).toEqual({ thread: null, updatedAt: before.updatedAt, messages: [null, null] });
      expect(await visible(member, member)).toEqual({ threads: 0, messages: 0 });

      await runBackfill();

      expect(await stamps(thread)).toEqual({ thread: t.orgA, updatedAt: before.updatedAt, messages: [t.orgA, t.orgA] });
      expect((await stamps(formerThread)).thread).toBe(t.orgA);
      expect(await visible(member, member)).toEqual({ threads: 1, messages: 2 });
      expect(await visible(formerOrgMember, formerOrgMember)).toEqual({ threads: 1, messages: 2 });
    } finally {
      await client.query("rollback");
    }
  });

  it("leaves owners with several organizations or none unattributed and invisible", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const twoOrgs = await account();
      const twoOrgsThread = await conversation(twoOrgs);
      await join(twoOrgs, t.orgB, t.depot);
      await join(twoOrgs, t.orgA, t.library);
      const noOrg = await account();
      const noOrgThread = await conversation(noOrg);
      const suspendedOnly = await account();
      const suspendedThread = await conversation(suspendedOnly);
      await join(suspendedOnly, t.orgC, t.plant);

      await runBackfill();

      for (const thread of [twoOrgsThread, noOrgThread, suspendedThread]) {
        expect(await stamps(thread)).toMatchObject({ thread: null, messages: [null, null] });
      }
      for (const owner of [twoOrgs, noOrg, suspendedOnly]) {
        expect(await visible(owner, owner)).toEqual({ threads: 0, messages: 0 });
      }
      // The rows are retained for the account export.
      const retained = (await client.query("select count(*)::int as n from public.member_guide_messages where user_id = any($1)", [[twoOrgs, noOrg, suspendedOnly]])).rows[0].n;
      expect(retained).toBe(6);
    } finally {
      await client.query("rollback");
    }
  });

  it("does not change rows that already carry a stamp", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const mover = await account();
      const legacy = await conversation(mover);
      await join(mover, t.orgB, t.depot);
      const stampedInB = await conversation(mover);
      await client.query("update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2", [t.orgB, mover]);
      await join(mover, t.orgA, t.library);
      const before = await stamps(stampedInB);
      expect(before).toMatchObject({ thread: t.orgB, messages: [t.orgB, t.orgB] });

      await runBackfill();

      expect(await stamps(stampedInB)).toEqual(before);
      expect((await stamps(legacy)).thread).toBe(t.orgA);
    } finally {
      await client.query("rollback");
    }
  });

  it("keeps the stamp immutable after the backfill", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const member = await account();
      const thread = await conversation(member);
      await join(member, t.orgA, t.library);
      const unattributed = await account();
      const unattributedThread = await conversation(unattributed);

      await runBackfill();

      const enabled = (await client.query(
        "select tgname, tgenabled from pg_trigger where tgrelid in ('public.member_guide_threads'::regclass,'public.member_guide_messages'::regclass) and tgname in ('stamp_retention_scope','member_guide_threads_touch_updated_at') order by 1, 2")).rows;
      expect(enabled).toEqual([
        { tgname: "member_guide_threads_touch_updated_at", tgenabled: "O" },
        { tgname: "stamp_retention_scope", tgenabled: "O" },
        { tgname: "stamp_retention_scope", tgenabled: "O" },
      ]);

      // Even the table owner cannot move, clear or newly set a stamp now.
      const refusals = [
        await capture("update public.member_guide_threads set organization_id=$2 where id=$1", [thread, t.orgB]),
        await capture("update public.member_guide_threads set organization_id=null where id=$1", [thread]),
        await capture("update public.member_guide_messages set organization_id=$2 where thread_id=$1", [thread, t.orgB]),
        await capture("update public.member_guide_threads set organization_id=$2 where id=$1", [unattributedThread, t.orgA]),
      ];
      for (const refused of refusals) expect(refused).toMatchObject({ ok: false, code: "42501", message: "retention ownership is immutable" });

      // A member session has no write path to the table at all.
      await actAs(member);
      const memberMove = await capture("update public.member_guide_threads set organization_id=$2 where id=$1", [thread, t.orgB]);
      await asOwner();
      expect(memberMove).toMatchObject({ ok: false, code: "42501" });

      // An edit that leaves the stamp alone still works, and the updated_at
      // trigger is running again.
      const before = await stamps(thread);
      const rename = await capture("update public.member_guide_threads set title='Overtime pay' where id=$1", [thread]);
      expect(rename).toMatchObject({ ok: true, rows: 1 });
      const after = await stamps(thread);
      expect(after.thread).toBe(t.orgA);
      expect(after.updatedAt).not.toBe(before.updatedAt);
    } finally {
      await client.query("rollback");
    }
  });

  it("gives no administrator or officer of the stamped organization a read of the member's history", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const member = await account();
      await conversation(member);
      await join(member, t.orgA, t.library);
      const chapterAdmin = await account();
      await join(chapterAdmin, t.orgA, t.library, { role: "admin" });
      const vicePresident = await account();
      await join(vicePresident, t.orgA, t.library, { role: "vp" });
      const steward = await account();
      await join(steward, t.orgA, t.library, { role: "steward" });
      const organizationAdmin = await account();
      await join(organizationAdmin, t.orgA, t.library, { orgRole: "admin" });

      await runBackfill();

      expect(await visible(member, member)).toEqual({ threads: 1, messages: 2 });
      for (const reader of [chapterAdmin, vicePresident, steward, organizationAdmin]) {
        expect(await visible(reader, member)).toEqual({ threads: 0, messages: 0 });
      }
    } finally {
      await client.query("rollback");
    }
  });
});
