// @vitest-environment node
//
// REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030 (#6580)
//
// 20261030213002: organization setting changes appear in Recent admin
// activity, the organization ledger can name its actors, and an organization
// administrator can follow a collective action's goal by shift and
// classification. Two fictional tenants; every refusal has an allowed
// control; every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261030213002_admin_activity_names_and_goal_breakdown";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("admin activity, ledger names and goal breakdown (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));
  const audit = stripComments(fnBody(sql, "public.get_admin_audit(p_limit integer default 50)"));
  const names = stripComments(fnBody(sql, "public.list_organization_audit_actor_names(p_user_ids uuid[])"));
  const goal = stripComments(fnBody(sql, "public.get_digital_action_goal_breakdown(p_action_id uuid)"));

  it("is one transaction guarded against an unreviewed predecessor", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("'public.get_admin_audit(integer)'::regprocedure");
    expect(sql).not.toMatch(/create (table|policy)|alter table|drop policy/i);
  });

  it("adds setting changes to the admin activity without their values", () => {
    expect(audit).toContain("from public.organization_configuration_audit c");
    expect(audit).toContain("c.organization_id = audit_org");
    expect(audit).not.toMatch(/previous_value|new_value/);
    // The existing guard and tenant filter are unchanged.
    expect(audit).toContain("private.member_has_chapter_role(private.current_member_chapter(), array['admin'])");
    expect(audit).toContain("m.organization_id = audit_org");
  });

  it("names only members of the administrator's organization and counts only shared details", () => {
    expect(names).toContain("private.has_organization_role(org, array['admin'])");
    expect(names).toContain("membership.organization_id = org");
    expect(names).not.toMatch(/email|phone/);
    expect(goal).toContain("perform private.member_pin_require_full_session();");
    expect(goal).toContain("private.has_organization_role(org, array['admin'])");
    expect(goal).toContain("case when detail.details_visibility = 'admins' then nullif(pg_catalog.btrim(detail.shift), '') end");
    // Platform organizations stay private and former members' details never count (gate r1).
    expect(goal).toContain("if not private.organization_is_union(org) then");
    expect(goal).toContain("membership.status = 'active'");
    expect(sql).toContain("'public.list_failed_login_operations_inbox(text,integer)'::regprocedure");
    expect(stripComments(fnBody(sql, "public.list_failed_login_operations_inbox(p_status text default null, p_limit integer default 50)"))).toContain("'openCount'");
    expect(goal).not.toMatch(/full_name|email|phone/);
  });

  it("pins both new readers in the database contract", () => {
    for (const sig of ["public.list_organization_audit_actor_names(p_user_ids uuid[])", "public.get_digital_action_goal_breakdown(p_action_id uuid)"]) {
      expect(contract.functions.find((row) => row.sig === sig), sig).toMatchObject({ secdef: true, exec: "authenticated" });
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("admin activity, ledger names and goal breakdown on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "admin-activity-goal-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const main = `mwh-main-${orgA}`;
    const other = `pkt-${orgB}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `mwh-${orgA}`, `Millrace Warehouse Workers ${orgA}`, orgB, `pkt-${orgB}`, `Port Kinsey Transit ${orgB}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Main Floor',$1,'proof',$3,9961), ($2,'Depot',$2,'proof',$4,9962)`,
      [main, other, orgA, orgB]);
    return { orgA, orgB, main, other };
  }

  async function person(t, chapter, { organization = t.orgA, admin = false, name = null } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, name ?? `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organization, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    if (admin) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [organization, id]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2)", [id, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [id, chapter]);
    }
    return id;
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
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "" };
    }
  }

  const as = async (userId, statement, args = []) => {
    await actAs(userId);
    const result = await capture(statement, args);
    await asOwner();
    return result;
  };

  it("lists an organization setting change in Recent admin activity, for that organization only", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await person(t, t.main, { admin: true, name: "Callum Reyes" });
      const foreignAdmin = await person(t, t.other, { organization: t.orgB, admin: true, name: "Foreign Admin" });
      const member = await person(t, t.main, { name: "Plain Member" });
      const key = (await client.query("select key from public.platform_setting_definitions order by key limit 1")).rows[0].key;
      await client.query(
        `insert into public.organization_configuration_audit(organization_id,actor_user_id,action,item_key,previous_value,new_value)
         values ($1,$2,'setting_updated',$3,'false'::jsonb,'true'::jsonb), ($1,$2,'setting_reset',$3,'true'::jsonb,'false'::jsonb)`,
        [t.orgA, admin, key]);

      const feed = await as(admin, "select public.get_admin_audit(50) as v");
      expect(feed.ok, feed.message).toBe(true);
      const settings = feed.value.filter((row) => row.action.startsWith("organization_setting_"));
      expect(settings.map((row) => row.action).sort()).toEqual(["organization_setting_reset", "organization_setting_updated"]);
      expect(settings[0]).toMatchObject({ actorName: "Callum Reyes", targetName: null, detail: { item: key } });
      expect(JSON.stringify(settings)).not.toMatch(/previous|newValue|new_value/);

      // The other organization's administrator sees none of it; a plain member is refused.
      const foreign = await as(foreignAdmin, "select public.get_admin_audit(50) as v");
      expect(foreign.ok, foreign.message).toBe(true);
      expect(foreign.value.filter((row) => row.action.startsWith("organization_setting_"))).toEqual([]);
      expect(await as(member, "select public.get_admin_audit(50) as v")).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await client.query("rollback");
    }
  });

  it("names ledger actors for an organization administrator, never people outside the organization", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await person(t, t.main, { admin: true, name: "Callum Reyes" });
      const member = await person(t, t.main, { name: "Imani Clarke" });
      const former = await person(t, t.main, { name: "Former Member" });
      await client.query("update public.organization_memberships set status='revoked', revoked_at=now() where user_id=$1 and organization_id=$2", [former, t.orgA]);
      const outsider = await person(t, t.other, { organization: t.orgB, name: "Outside Person" });

      const named = await as(admin, "select public.list_organization_audit_actor_names($1::uuid[]) as v", [[admin, member, former, outsider, randomUUID()]]);
      expect(named.ok, named.message).toBe(true);
      expect(named.value).toEqual({ [admin]: "Callum Reyes", [member]: "Imani Clarke", [former]: "Former Member" });

      expect(await as(member, "select public.list_organization_audit_actor_names($1::uuid[]) as v", [[admin]])).toMatchObject({ ok: false, code: "42501" });
      const tooMany = Array.from({ length: 201 }, () => randomUUID());
      expect(await as(admin, "select public.list_organization_audit_actor_names($1::uuid[]) as v", [tooMany])).toMatchObject({ ok: false, code: "22023" });
      expect(await as(admin, "select public.list_organization_audit_actor_names($1::uuid[]) as v", [[]])).toMatchObject({ ok: true, value: {} });
    } finally {
      await client.query("rollback");
    }
  });

  it("counts a collective action against its goal by shift and classification, using only shared details", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await person(t, t.main, { admin: true, name: "Ruthie Calloway" });
      const signers = [];
      for (let index = 0; index < 4; index += 1) signers.push(await person(t, t.main, { name: `Signer ${index}` }));
      // Two share with administrators, one keeps details to themself, one has none.
      await client.query("insert into public.member_profile_details(user_id,shift,classification,details_visibility) values ($1,'Night','Picker','admins'), ($2,'Night','Loader','admins'), ($3,'Day','Picker','only_me')",
        [signers[0], signers[1], signers[2]]);
      const actionId = randomUUID();
      await client.query(
        `insert into public.digital_actions(id,organization_id,action_kind,title,summary,status,target_count,published_at,created_by,updated_by)
         values ($1,$2,'petition','Card count','Sign your union card','published',221,now(),$3,$3)`,
        [actionId, t.orgA, admin]);
      for (const signer of signers) {
        await client.query("insert into public.digital_action_participants(organization_id,action_id,user_id,participation_kind) values ($1,$2,$3,'signature')", [t.orgA, actionId, signer]);
      }

      const breakdown = await as(admin, "select public.get_digital_action_goal_breakdown($1) as v", [actionId]);
      expect(breakdown.ok, breakdown.message).toBe(true);
      expect(breakdown.value).toMatchObject({ actionId, title: "Card count", targetCount: 221, participantCount: 4 });
      expect(breakdown.value.byShift).toEqual([{ label: "Night", count: 2 }, { label: null, count: 2 }]);
      expect(breakdown.value.byClassification).toEqual([{ label: "Loader", count: 1 }, { label: "Picker", count: 1 }, { label: null, count: 2 }]);
      expect(JSON.stringify(breakdown.value)).not.toMatch(/Signer|Day/);

      // A former member's later profile changes never reach this organization (gate r1).
      await client.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1", [signers[1]]);
      await client.query("update public.organization_memberships set status='revoked', revoked_at=now() where user_id=$1 and organization_id=$2", [signers[1], t.orgA]);
      await client.query("update public.member_profile_details set shift='Night B', classification='Driver' where user_id=$1", [signers[1]]);
      const after = await as(admin, "select public.get_digital_action_goal_breakdown($1) as v", [actionId]);
      expect(after.ok, after.message).toBe(true);
      expect(after.value.participantCount).toBe(4);
      expect(after.value.byShift).toEqual([{ label: "Night", count: 1 }, { label: null, count: 3 }]);
      expect(JSON.stringify(after.value)).not.toMatch(/Night B|Driver/);

      // A signer is refused; another organization's administrator cannot find it.
      expect(await as(signers[0], "select public.get_digital_action_goal_breakdown($1) as v", [actionId])).toMatchObject({ ok: false, code: "42501" });
      const foreignAdmin = await person(t, t.other, { organization: t.orgB, admin: true });
      expect(await as(foreignAdmin, "select public.get_digital_action_goal_breakdown($1) as v", [actionId])).toMatchObject({ ok: false, code: "P0002" });
    } finally {
      await client.query("rollback");
    }
  });
});
