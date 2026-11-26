// @vitest-environment node
//
// SEC-UG-ACCESS-HISTORY-CHAPTER-ROLE-EVENTS-20260921
//
// public.list_my_access_history showed organization-role changes but not the
// chapter-role grants and revocations public.set_member_chapter_role records
// in public.member_admin_audit. 20260925100200 projects those rows for the
// subject only, limited to chapters of the selected organization, with the
// chapter id as entityId.
//
// The offline half pins the migration text and the db-contract entry. The
// live half (disposable loopback only) grants and revokes a chapter role
// through the real RPC and reads the subject's history.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("access_history_chapter_role_events"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("access history chapter-role events migration", () => {
  it("sorts after the access history function, inside one bounded transaction", () => {
    const name = findMigrationName("access_history_chapter_role_events");
    expect(name).toBe("20260925100200_access_history_chapter_role_events.sql");
    expect(name > "20260828163209_browser_rpc_service_role_acl_repair.sql").toBe(true);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("projects the caller's own chapter-role audit rows for chapters of the selected organization only", () => {
    const body = squash(fnBody(sql, "public.list_my_access_history"));
    expect(body).toContain("from public.member_admin_audit r join public.chapters c on c.id = r.detail ->> 'chapterId'");
    expect(body).toContain("where r.target_user = caller and r.action in ('grant_role', 'revoke_role') and c.organization_id = org");
    expect(body).toContain("r.detail ->> 'chapterId' as \"entityId\"");
    expect(body).toContain("a.event_type in ('organization_role_granted', 'organization_role_revoked')");
    expect(body).toContain("and e.subject_user_id = caller");
    expect(body.indexOf("private.mfa_satisfied()")).toBeLessThan(body.indexOf("member_admin_audit"));
  });

  it("pins the chapter-role arm in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === "public.list_my_access_history(p_range_days integer)");
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "from public.member_admin_audit r",
      "where r.target_user = caller",
      "and c.organization_id = org",
    ]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("access history shows chapter-role grants and revocations to their subject", () => {
  let client;
  const id = Object.fromEntries([
    "admin", "member", "other", "adminSession", "memberSession", "otherSession", "org", "foreignOrg",
  ].map((key) => [key, randomUUID()]));
  const chapter = `ahcr-${id.org}`;
  const foreignChapter = `ahcr-x-${id.foreignOrg}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const history = async (actor, session) => {
    await act(actor, session);
    const result = await client.query("select public.list_my_access_history(30) as out");
    await client.query("reset role");
    return result.rows[0].out.filter((row) => row.entityType === "role_grant");
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "access-history-chapter-role-events-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [[id.admin, id.adminSession], [id.member, id.memberSession], [id.other, id.otherSession]];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{\"full_name\":\"Synthetic Person\"}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic history factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    for (const [org, slug, chapterId, order] of [[id.org, `ahcr-${id.org}`, chapter, 9941], [id.foreignOrg, `ahcr-x-${id.foreignOrg}`, foreignChapter, 9942]]) {
      await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, slug, id.admin]);
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapterId, org, order]);
      await client.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [chapterId, id.admin]);
      await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
    }
    for (const [user] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [id.org, id.admin]);
    // A chapter-role audit row in another organization's chapter must never
    // surface in this organization's history.
    await client.query(
      "insert into public.member_admin_audit(actor,action,target_user,detail) values($1,'grant_role',$2,jsonb_build_object('role','steward','chapterId',$3::text))",
      [id.admin, id.member, foreignChapter],
    );
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("starts with no chapter-role rows, and ignores another organization's chapter", async () => {
    expect(await history(id.member, id.memberSession)).toEqual([]);
  });

  it("shows a chapter-role grant and its revocation to the subject with the chapter as scope", async () => {
    await act(id.admin, id.adminSession);
    // This new steward grant explicitly chooses a real unit.
    await client.query("select public.set_member_access_role($1,$2,'steward',true,((public.get_chapter_access_workspace($2)->'units')->0->>'id')::uuid,null)", [id.member, chapter]);
    await client.query("select public.set_member_chapter_role($1,$2,'steward',false)", [id.member, chapter]);
    await client.query("reset role");
    const rows = await history(id.member, id.memberSession);
    expect(rows.map((row) => row.action).sort()).toEqual(["granted_role", "revoked_role"]);
    for (const row of rows) {
      expect(row).toMatchObject({
        organizationId: id.org,
        subjectUserId: id.member,
        actorRole: "staff",
        actorLabel: "Synthetic",
        entityType: "role_grant",
        entityId: chapter,
      });
    }
  });

  it("never shows one member's chapter-role change to another member", async () => {
    expect(await history(id.other, id.otherSession)).toEqual([]);
  });

  it("applies the requested range to chapter-role rows", async () => {
    await client.query("update public.member_admin_audit set created_at = now() - interval '45 days' where target_user=$1 and detail ->> 'chapterId' = $2", [id.member, chapter]);
    expect(await history(id.member, id.memberSession)).toEqual([]);
  });
});
