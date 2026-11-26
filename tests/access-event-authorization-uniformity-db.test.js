// @vitest-environment node
//
// SEC-UG-ACCESS-EVENT-AUTHORIZATION-RESPONSES-DISCLOSE-MEMBERSHIP-STATE-DISTINCTIONS-20260921
//
// public.record_member_access_event still refuses a subject who is not an
// active organization member. The latest generation raises the same 42501
// outcome the caller-role check uses, so unauthorized results do not vary
// with membership state. Authorized staff recording and the tenant audit
// write stay intact.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helperFirst } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("access_event_uniform_refusal"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const body = squash(stripComments(fnBody(sql, "public.record_member_access_event")));
// The plpgsql source as Postgres stores it, for the entry-gate pin below:
// helperFirst reads a prosrc, not a create statement.
const prosrc = sql.slice(sql.indexOf("as $function$") + "as $function$".length, sql.lastIndexOf("$function$"));

describe("access-event uniform refusal migration", () => {
  it("sorts after the original access-history migration and takes a bounded lock", () => {
    const name = findMigrationName("access_event_uniform_refusal");
    expect(name).toBe("20260925010200_access_event_uniform_refusal.sql");
    // Sequences after every earlier generation of this writer so it carries
    // their changes (entityId audit key, selected-chapter hat audience).
    expect(name > "20260924160300_member_access_event_chapter_hat_audience.sql").toBe(true);
    expect(name > "20260828021500_mi1_member_access_history.sql").toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(sql.trimStart().startsWith("begin;") || flat.startsWith("begin;")).toBe(true);
  });

  it("keeps the membership check and emits the same 42501 refusal as the caller-role path", () => {
    expect(body).toContain("create or replace function public.record_member_access_event(");
    expect(body).toContain("private.has_organization_role( org, array['steward', 'coordinator', 'advisor', 'admin', 'vp'] )");
    expect(body).toContain("raise exception 'not authorized' using errcode = '42501'");
    expect(body).not.toContain("subject not authorized");
    expect(body).toContain("membership.organization_id = org");
    expect(body).toContain("membership.user_id = p_subject_user_id");
    expect(body).toContain("membership.status = 'active'");
    expect(body.indexOf("cannot record self access")).toBeLessThan(
      body.indexOf("from public.organization_memberships membership"),
    );
    expect(body).toContain("if p_action is null or p_action not in (");
    expect(body).toContain("if p_entity_type is null or p_entity_type not in ('member', 'case') then");
    expect(body.indexOf("if p_entity_type is null")).toBeLessThan(
      body.indexOf("from public.organization_memberships membership"),
    );
    expect(body).toContain("private.mi1_write_tenant_audit(org, 'member_access_recorded'");
    expect(flat).toContain(
      "grant execute on function public.record_member_access_event(uuid, uuid, text, text, text) to authenticated;",
    );
    expect(flat).toContain(
      "revoke execute on function public.record_member_access_event(uuid, uuid, text, text, text) from service_role;",
    );
  });

  it("keeps private.lock_case_graph as the first operation of the replacement", () => {
    // 20260907151000_account_deletion_finalization_reconciliation.sql wrapped
    // this signature with the case-graph entry gate. A create or replace that
    // dropped the call would let the membership and role reads run before the
    // lifecycle gate, so the replacement carries it in an outer block and
    // keeps every initialized declaration in the inner block, after the lock.
    const lock = "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);";
    expect(prosrc).toContain(lock);
    expect(helperFirst(prosrc)).toBe(true);
    expect(prosrc.indexOf(lock)).toBeLessThan(prosrc.indexOf("declare"));
    expect(prosrc.indexOf(lock)).toBeLessThan(prosrc.indexOf(":="));
  });

  it("keeps the selected-chapter hat audience of the earlier generation", () => {
    expect(body).toContain("selected_chapter text := private.current_member_chapter();");
    expect(body).toContain("private.member_has_chapter_role( selected_chapter,");
    expect(body).toContain("from public.member_role_chapters rc");
    expect(body).toContain("'entityId', nullif(p_entity_id, '')");
  });

  it("pins the normalized refusal in the database contract", () => {
    const entry = contract.functions.find((row) => (
      row.sig === "public.record_member_access_event(p_expected_organization_id uuid, p_subject_user_id uuid, p_action text, p_entity_type text, p_entity_id text)"
    ));
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated" });
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);",
      "raise exception 'not authorized' using errcode = '42501'",
      "membership.user_id = p_subject_user_id",
      "membership.status = 'active'",
      "member_access_recorded",
    ]));
    expect(entry.bodyForbids).toEqual(expect.arrayContaining([
      "subject not authorized",
    ]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("access-event unauthorized outcomes are invariant across membership states", () => {
  let client;
  const id = Object.fromEntries([
    "staff", "memberIn", "memberOut",
    "staffSession", "memberInSession", "memberOutSession",
    "org",
  ].map((key) => [key, randomUUID()]));
  const chapter = `aeu-${id.org}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const attempt = async (sqlText, params = []) => {
    await client.query("savepoint access_event_uniform");
    try {
      const result = await client.query(sqlText, params);
      await client.query("release savepoint access_event_uniform");
      return { ok: true, rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      await client.query("rollback to savepoint access_event_uniform");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  const record = (organizationId, subjectUserId) => attempt(
    "select public.record_member_access_event($1,$2,'viewed_profile','member',null) as value",
    [organizationId, subjectUserId],
  );

  const asOwner = async (fn) => {
    const previous = (await client.query("select current_user as u")).rows[0].u;
    await client.query("reset role");
    try {
      return await fn();
    } finally {
      if (previous === "authenticated") await client.query("set local role authenticated");
    }
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "access-event-authorization-uniformity-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.staff, id.staffSession],
      [id.memberIn, id.memberInSession],
      [id.memberOut, id.memberOutSession],
    ];
    for (const [user, session] of people) {
      await client.query(
        "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')",
        [user, `${user}@example.invalid`],
      );
      await client.query(
        "insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",
        [session, user],
      );
      await client.query(
        "insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic access-event factor','totp','verified',now(),now())",
        [randomUUID(), user],
      );
    }
    await client.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,$4)",
      [id.org, `aeu-${id.org}`, `Access Event Uniform ${id.org}`, id.staff],
    );
    await client.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$2,$1,$3,false,8821)",
      [chapter, `Access Event Uniform Chapter ${id.org}`, id.org],
    );
    await client.query(
      "insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)",
      [id.org],
    );
    for (const user of [id.staff, id.memberIn]) {
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",
        [id.org, user],
      );
      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",
        [user, chapter],
      );
      await client.query(
        "update public.member_profiles set chapter_id=$2 where id=$1",
        [user, chapter],
      );
    }
    await client.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",
      [id.org, id.staff],
    );

    // This broad-reader fixture is an
    // existing legacy grant; exercise its actual migration carry-over.
    await migrateLegacyStewardFixtures(client);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("returns the same unauthorized outcome for in-organization and out-of-organization subjects", async () => {
    await act(id.memberIn, id.memberInSession);
    const inOrg = await record(id.org, id.staff);
    const outOrg = await record(id.org, id.memberOut);
    expect(inOrg.ok).toBe(false);
    expect(outOrg.ok).toBe(false);
    expect({ code: inOrg.code, message: inOrg.message }).toEqual({
      code: outOrg.code,
      message: outOrg.message,
    });
    expect(inOrg.code).toBe("42501");
    expect(inOrg.message).toBe("not authorized");

    await act(id.staff, id.staffSession);
    const staffOut = await record(id.org, id.memberOut);
    expect(staffOut.ok).toBe(false);
    expect({ code: staffOut.code, message: staffOut.message }).toEqual({
      code: inOrg.code,
      message: inOrg.message,
    });

    // NOT IN yields NULL for a NULL argument; the explicit null checks keep
    // both refusals in 22023 ahead of the membership check, so an active
    // subject cannot surface a distinguishable 23502 from the insert.
    for (const [action, entityType, message] of [
      [null, "member", "invalid action"],
      ["viewed_profile", null, "invalid entity"],
    ]) {
      const outcomes = [];
      for (const subject of [id.memberIn, id.memberOut]) {
        outcomes.push(await attempt(
          "select public.record_member_access_event($1,$2,$3,$4,null) as value",
          [id.org, subject, action, entityType],
        ));
      }
      for (const outcome of outcomes) {
        expect({ ok: outcome.ok, code: outcome.code, message: outcome.message }).toEqual({
          ok: false,
          code: "22023",
          message,
        });
      }
    }
  });

  it("lets supported staff record an in-organization subject and write the tenant audit", async () => {
    await act(id.staff, id.staffSession);
    const recorded = await record(id.org, id.memberIn);
    expect(recorded.ok).toBe(true);
    expect(recorded.rows[0].value).toMatchObject({
      ok: true,
      organizationId: id.org,
    });
    expect(recorded.rows[0].value.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const events = await asOwner(() => client.query(
      `select id, subject_user_id, actor_user_id, actor_role, action, entity_type
         from public.member_access_events
        where organization_id = $1`,
      [id.org],
    ));
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      subject_user_id: id.memberIn,
      actor_user_id: id.staff,
      actor_role: "steward",
      action: "viewed_profile",
      entity_type: "member",
    });

    const audits = await asOwner(() => client.query(
      `select event_type, actor_user_id, metadata
         from public.organization_audit_events
        where organization_id = $1
          and event_type = 'member_access_recorded'`,
      [id.org],
    ));
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].actor_user_id).toBe(id.staff);
    expect(audits.rows[0].metadata).toMatchObject({
      organizationId: id.org,
      userId: id.memberIn,
      action: "viewed_profile",
      entityType: "member",
    });
  });
});
