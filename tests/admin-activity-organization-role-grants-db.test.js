// @vitest-environment node
// BUG-UG-RECENT-ADMIN-ACTIVITY-OMITS-ORGANIZATION-ROLE-GRANTS-20261112 (#8534).
// Recent admin activity (public.get_admin_audit) now lists organization-wide
// role grants and revokes from the organization ledger beside chapter role
// grants, for the administrator's own organization only. Two fictional
// organizations; every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";
import { fnBody, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261113131000_admin_activity_lists_organization_role_grants.sql";
const sql = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8");

describe("Recent admin activity lists organization role grants (static)", () => {
  const body = stripComments(fnBody(sql, "public.get_admin_audit(p_limit integer default 50)"));

  it("is one guarded transaction that redefines only the reader", () => {
    expect(sql.trimStart().startsWith("-- BUG-UG-RECENT-ADMIN-ACTIVITY-OMITS-ORGANIZATION-ROLE-GRANTS-20261112")).toBe(true);
    expect(sql).toContain("'public.get_admin_audit(integer)'::regprocedure");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const code = stripComments(sql);
    expect(code.match(/create or replace function/gi)).toHaveLength(1);
    expect(code).not.toMatch(/create (table|policy)|alter table|drop |grant |revoke /i);
  });

  it("merges the two ledger events for the caller's organization, behind the unchanged guard", () => {
    expect(body).toContain("from public.organization_audit_events e");
    expect(body).toContain("e.organization_id = audit_org");
    expect(body).toContain("e.event_type in ('organization_role_granted', 'organization_role_revoked')");
    expect(body).toContain("'scope', 'organization'");
    expect(body).toContain("private.member_has_chapter_role(private.current_member_chapter(), array['admin'])");
    expect(body).toContain("m.organization_id = audit_org");
    expect(body).toContain("limit cap");
  });

  // Gate round 1 (stage 191): a chapter-role undo writes the same ledger
  // events with a chapterId; only the chapter arm lists it. A target with no
  // profile gets no name, so the client's translated wording shows.
  it("leaves out ledger events that name a chapter and fakes no English name for a removed target", () => {
    expect(body).toContain("and not (e.metadata ? 'chapterId')");
    expect(body.match(/'Removed member'/g)).toHaveLength(1);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("Recent admin activity and organization role grants on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "admin-activity-organization-role-grants-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
  });

  afterAll(async () => {
    await client?.end();
  });

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

  function expectOk(result) {
    expect(result.ok, `${result.code}: ${result.message}`).toBe(true);
  }

  async function as(userId, statement, args = []) {
    await actAs(userId);
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, code: error.code, message: error.message };
    } finally {
      await asOwner();
    }
  }

  it("shows organization-wide grants and revokes beside chapter grants, for the caller's organization only", async () => {
    await client.query("begin");
    try {
      const orgs = { a: randomUUID(), b: randomUUID() };
      const chapters = { a: `r8534-${orgs.a}`, b: `r8534-${orgs.b}` };
      await client.query("insert into public.organizations(id,slug,name) values ($1::uuid,$1::text,'Gullwing Gardens Workers'), ($2::uuid,$2::text,'Copperline Transit')", [orgs.a, orgs.b]);
      await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,'Main',$1,'proof',$2,9981), ($3,'Depot',$3,'proof',$4,9982)", [chapters.a, orgs.a, chapters.b, orgs.b]);
      async function person(name, side, admin = false) {
        const id = randomUUID();
        await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
        await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapters[side], name]);
        await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [orgs[side], id]);
        await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapters[side]]);
        await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
        if (admin) {
          await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [orgs[side], id]);
          await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2)", [id, chapters[side]]);
          await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [id, chapters[side]]);
        }
        return id;
      }
      const admin = await person("Callum Proof", "a", true);
      const target = await person("Hannah Proof", "a");
      const member = await person("Plain Proof", "a");
      const foreignAdmin = await person("Foreign Proof", "b", true);
      const foreignTarget = await person("Foreign Target", "b");

      // An organization-wide steward grant is refused since #7663 (20261113115000:
      // stewards need a chapter and unit), so the organization-wide grant here is vp.
      expectOk(await as(admin, "select public.set_member_organization_role($1,'vp',true) as v", [target]));
      expectOk(await as(admin, "select public.set_member_chapter_role($1,$2,'coordinator',true) as v", [target, chapters.a]));
      expectOk(await as(admin, "select public.set_member_organization_role($1,'vp',false) as v", [target]));
      expectOk(await as(foreignAdmin, "select public.set_member_organization_role($1,'advisor',true) as v", [foreignTarget]));

      const feed = await as(admin, "select public.get_admin_audit(50) as v");
      expect(feed.ok, feed.message).toBe(true);
      const roles = feed.value
        .filter((row) => row.action === "grant_role" || row.action === "revoke_role")
        .map((row) => ({ action: row.action, role: row.detail?.role, scope: row.detail?.scope ?? "chapter", actor: row.actorName, target: row.targetName, targetId: row.targetId }));
      expect(roles).toEqual(expect.arrayContaining([
        { action: "grant_role", role: "vp", scope: "organization", actor: "Callum Proof", target: "Hannah Proof", targetId: target },
        { action: "revoke_role", role: "vp", scope: "organization", actor: "Callum Proof", target: "Hannah Proof", targetId: target },
        { action: "grant_role", role: "coordinator", scope: "chapter", actor: "Callum Proof", target: "Hannah Proof", targetId: target },
      ]));
      expect(roles).toHaveLength(3);
      // Newest first, the merged rows interleaved with the chapter rows by time.
      const times = feed.value.map((row) => Date.parse(row.createdAt));
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      const orgRow = feed.value.find((row) => row.detail?.scope === "organization");
      expect(orgRow.detail).toEqual({ role: "vp", scope: "organization", organizationId: orgs.a });

      // The other organization's grant stays in its own feed; a plain member is refused.
      expect(JSON.stringify(feed.value)).not.toContain(foreignTarget);
      const foreign = await as(foreignAdmin, "select public.get_admin_audit(50) as v");
      expect(foreign.ok, foreign.message).toBe(true);
      expect(foreign.value.filter((row) => row.detail?.scope === "organization").map((row) => [row.action, row.detail.role, row.targetId]))
        .toEqual([["grant_role", "advisor", foreignTarget]]);
      expect(JSON.stringify(foreign.value)).not.toContain(target);
      expect(await as(member, "select public.get_admin_audit(50) as v")).toMatchObject({ ok: false, code: "42501" });

      // A chapter role granted and undone in the learning period: the undo
      // writes member_admin_audit and a ledger event with a chapterId. The
      // feed shows the chapter removal once and no organization-wide one.
      const undoTarget = await person("Undo Proof", "a");
      await releaseLearningPeriodHold(client);
      expectOk(await as(admin, "select public.start_organization_learning_period() as v"));
      expectOk(await as(admin, "select public.set_member_chapter_role($1,$2,'vp',true) as v", [undoTarget, chapters.a]));
      const { rows: [entry] } = await client.query(
        "select id from private.learning_action_journal where target_table = 'public.member_role_chapters' and target_id = $1 order by created_at desc, id limit 1",
        [`${undoTarget}:vp:${chapters.a}`],
      );
      expect(entry, "chapter vp grant journalled").toBeTruthy();
      expectOk(await as(admin, "select public.undo_my_learning_action($1, 1) as v", [entry.id]));
      const { rows: ledger } = await client.query(
        "select metadata ->> 'chapterId' as chapter from public.organization_audit_events where organization_id = $1 and event_type = 'organization_role_revoked' and metadata ->> 'userId' = $2",
        [orgs.a, undoTarget],
      );
      expect(ledger).toEqual([{ chapter: chapters.a }]);

      // An account whose profile is gone: the ledger keeps its id.
      const gone = randomUUID();
      await client.query(
        "insert into public.organization_audit_events(organization_id,event_type,actor_user_id,idempotency_key,metadata) values ($1::uuid,'organization_role_revoked',$2::uuid,gen_random_uuid(),jsonb_build_object('organizationId',$4::text,'userId',$3::text,'role','coordinator'))",
        [orgs.a, admin, gone, orgs.a],
      );

      const after = await as(admin, "select public.get_admin_audit(50) as v");
      expect(after.ok, after.message).toBe(true);
      const undoRows = after.value.filter((row) => row.targetId === undoTarget)
        .map((row) => [row.action, row.detail?.role, row.detail?.scope ?? "chapter"].join(" "))
        .sort();
      // One transaction, one now(): compare as a set, not by order.
      expect(undoRows).toEqual(["grant_role vp chapter", "revoke_role vp chapter"]);
      const goneRow = after.value.find((row) => row.targetId === gone);
      expect(goneRow).toMatchObject({ action: "revoke_role", targetName: null, detail: { role: "coordinator", scope: "organization" } });
    } finally {
      await client.query("rollback");
    }
  }, 120_000);
});
