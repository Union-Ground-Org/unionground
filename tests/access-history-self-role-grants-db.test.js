// @vitest-environment node
//
// BUG-UG-HOME-AND-TOP-BAR-CALL-OFFICERS-MEMBER-20261006
//
// An officer who gave themselves a staff role read "Renata gave you a staff
// role". 20261008061000 adds "actorIsSelf" to public.list_my_access_history:
// true only when the caller made the role grant or revocation, always false
// for member_access_events rows, and still no actor user id to the subject.
//
// The offline half pins the migration text and the db-contract entry. The
// live half (disposable loopback only) reads the subject's history over
// self-made and staff-made audit rows in both role arms.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("access_history_self_role_grants"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("access history self role grants migration", () => {
  it("sorts after the definition it replaces, inside one bounded transaction", () => {
    const name = findMigrationName("access_history_self_role_grants");
    expect(name).toBe("20261008061000_access_history_self_role_grants.sql");
    expect(name > "20261008034500_cron_job_health_bounded_lookup.sql").toBe(true);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("flags only the caller's own role changes and never returns an actor id", () => {
    const body = squash(fnBody(sql, "public.list_my_access_history"));
    expect(body).toContain('false as "actorIsSelf" from public.member_access_events e');
    expect(body).toContain('coalesce(a.actor_user_id = caller, false) as "actorIsSelf" from public.organization_audit_events a');
    expect(body).toContain('coalesce(r.actor = caller, false) as "actorIsSelf" from public.member_admin_audit r');
    expect(body).not.toMatch(/as "actorUserId"/);
    expect(body.indexOf("private.mfa_satisfied()")).toBeLessThan(body.indexOf("member_admin_audit"));
    expect(body).toContain("where r.target_user = caller and r.action in ('grant_role', 'revoke_role') and c.organization_id = org");
  });

  it("pins the self flag in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === "public.list_my_access_history(p_range_days integer)");
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      'coalesce(a.actor_user_id = caller, false) as "actorIsSelf"',
      'coalesce(r.actor = caller, false) as "actorIsSelf"',
    ]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("access history marks a role change the subject made themselves", () => {
  let client;
  const id = Object.fromEntries(["admin", "member", "adminSession", "memberSession", "org"].map((key) => [key, randomUUID()]));
  const chapter = `ahsr-${id.org}`;

  const history = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    const result = await client.query("select public.list_my_access_history(30) as out");
    await client.query("reset role");
    return result.rows[0].out.filter((row) => row.entityType === "role_grant");
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "access-history-self-role-grants-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    const people = [[id.admin, id.adminSession], [id.member, id.memberSession]];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{\"full_name\":\"Synthetic Person\"}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic history factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, chapter, id.admin]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9943)", [chapter, id.org]);
    await client.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [chapter, id.admin]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    // Chapter-role arm: one change the member made to themselves, one by staff.
    for (const actor of [id.member, id.admin]) {
      await client.query(
        "insert into public.member_admin_audit(actor,action,target_user,detail) values($1,'grant_role',$2,jsonb_build_object('role','steward','chapterId',$3::text))",
        [actor, id.member, chapter],
      );
    }
    // Organization-role arm: the same split.
    for (const [actor, type] of [[id.member, "organization_role_granted"], [id.admin, "organization_role_revoked"]]) {
      await client.query(
        "insert into public.organization_audit_events(organization_id,event_type,actor_user_id,idempotency_key,metadata) values($1,$2,$3,$4,jsonb_build_object('userId',$5::text,'role','admin'))",
        [id.org, type, actor, randomUUID(), id.member],
      );
    }
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("marks only the subject's own role changes as self, in both arms, with no actor id", async () => {
    const rows = await history(id.member, id.memberSession);
    expect(rows).toHaveLength(4);
    const self = rows.filter((row) => row.actorIsSelf === true);
    const staff = rows.filter((row) => row.actorIsSelf === false);
    expect(self.map((row) => row.entityId === chapter ? "chapter" : "organization").sort()).toEqual(["chapter", "organization"]);
    expect(staff.map((row) => row.entityId === chapter ? "chapter" : "organization").sort()).toEqual(["chapter", "organization"]);
    for (const row of rows) expect(row).not.toHaveProperty("actorUserId");
  });

  it("shows the member's role changes to no one else", async () => {
    expect(await history(id.admin, id.adminSession)).toEqual([]);
  });
});
