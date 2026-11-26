// @vitest-environment node
//
// SEC-UG-COORDINATOR-CASE-WRITE-RESTRICTION-GATE-20260917
//
// public.member_cases.is_restricted hides a case row from an in-scope
// coordinator who holds no casework_access_grants row. The write helpers
// never consulted that SELECT surface: private.coordinator_case_for_update
// (behind the four coordinator RPCs) and private.can_write_member_case_object
// / private.can_delete_member_case_object (behind case-files Storage insert
// and delete) authorized on staff_can_see_user alone. 20260917104000 gates
// those three helpers on parent-case visibility.
//
// The offline half pins the migration text and the db-contract needles so the
// suite still guards the SQL without a database. The live half is the part
// that matters: a SECURITY DEFINER helper is only ever proved by calling it.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const sql = stripComments(loadMigrationSql("coordinator_case_write_restriction_gate"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const helperBody = stripComments(fnBody(sql, "private.member_case_visible_to_caller"));

describe("coordinator case write-restriction gate migration", () => {
  it("sorts after the pg_net tick request-id migration it was written against, after the sibling read-side gate, and takes a bounded lock", () => {
    const name = findMigrationName("coordinator_case_write_restriction_gate");
    expect(name > "20260915180000_pg_net_tick_request_id_idempotency.sql").toBe(true);
    // PR #2113's read-side gate landed as 20260917103000 (it was renumbered at
    // merge, so cite the filename that is in the tree, not the reviewed one).
    expect(name > "20260917103000_case_child_row_restriction_gate.sql").toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
  });

  it("does not redefine the read-side helper or any policy PR 2113 emits", () => {
    expect(flat).not.toContain("private.member_case_restriction_cleared");
    expect(flat).not.toContain("create policy");
    expect(flat).not.toContain("drop policy");
    expect(flat).not.toContain("alter policy");
  });

  it("states the definer visibility predicate as the union of the member_cases SELECT restriction branches", () => {
    expect(flat).toContain("create or replace function private.member_case_visible_to_caller(p_case_id uuid)");
    expect(helperBody).toContain("security definer");
    expect(helperBody).not.toContain("set role");
    for (const branch of [
      "not c.is_restricted",
      "c.user_id = (select auth.uid())",
      "c.steward_user_id = (select auth.uid())",
      "c.coordinator_user_id = (select auth.uid())",
      "private.has_organization_role(c.organization_id, array['advisor','admin','vp'])",
      "private.casework_actor_has_active_grant(c.id)",
    ]) expect(helperBody).toContain(branch);
    expect(flat).toContain(
      "revoke all on function private.member_case_visible_to_caller(uuid) from public, anon, authenticated, service_role;",
    );
    expect(flat).not.toContain("grant execute on function private.member_case_visible_to_caller");
  });

  it("re-emits coordinator_case_for_update with the lock wrapper first and the visibility conjunct", () => {
    const gate = squash(stripComments(fnBody(sql, "private.coordinator_case_for_update")));
    expect(gate.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);"))
      .toBeLessThan(gate.indexOf("declare found"));
    expect(gate).toContain(
      "where c.id = p_case_id and public.staff_can_see_user(c.user_id, 'coordinator') and private.member_case_visible_to_caller(c.id)",
    );
    expect(gate).toContain("if not private.member_case_visible_to_caller(p_case_id) then");
    expect(gate).toContain("raise exception 'case unavailable' using errcode = '42501'");
    expect(flat).toContain(
      "revoke all on function private.coordinator_case_for_update(uuid) from public, anon, authenticated, service_role;",
    );
  });

  it("narrows the coordinator branch of the attachment write and delete helpers and leaves the owner branch", () => {
    for (const name of ["private.can_write_member_case_object", "private.can_delete_member_case_object"]) {
      const body = squash(stripComments(fnBody(sql, name)));
      expect(body, name).toContain("f.user_id = (select auth.uid())");
      expect(body, name).toContain(
        "or (public.staff_can_see_user(f.user_id, 'coordinator') and private.member_case_visible_to_caller(f.case_id))",
      );
    }
    expect(squash(stripComments(fnBody(sql, "private.can_write_member_case_object"))))
      .toContain("f.uploaded_by = (select auth.uid())");
    expect(squash(stripComments(fnBody(sql, "private.can_delete_member_case_object"))))
      .not.toContain("f.uploaded_by = (select auth.uid())");
  });

  it("pins the repaired shapes in the database contract", () => {
    const visible = contract.functions.find((entry) => (
      entry.sig === "private.member_case_visible_to_caller(p_case_id uuid)"
    ));
    expect(visible).toMatchObject({
      secdef: true,
      exec: "",
    });
    expect(visible.config).toBeUndefined();
    // 20260925995000 made this helper a by-id wrapper over the single row-typed
    // predicate private.member_case_row_visible; the branches now live there.
    expect(visible.bodyContains).toEqual(expect.arrayContaining([
      "c.id = p_case_id",
      "private.member_case_row_visible(c)",
    ]));
    expect(visible.bodyForbids).toEqual(expect.arrayContaining([
      "set role",
    ]));

    const gate = contract.functions.find((entry) => (
      entry.sig === "private.coordinator_case_for_update(p_case_id uuid)"
    ));
    expect(gate.bodyContains).toEqual(expect.arrayContaining([
      "staff_can_see_user(c.user_id, 'coordinator')",
      "private.member_case_visible_to_caller(p_case_id)",
      "private.member_case_visible_to_caller(c.id)",
      "for update of c",
    ]));

    const write = contract.functions.find((entry) => (
      entry.sig === "private.can_write_member_case_object(p_bucket text, p_name text)"
    ));
    expect(write.bodyContains).toContain("private.member_case_visible_to_caller(f.case_id)");
    expect(write.bodyContains).toContain("f.user_id = (select auth.uid())");

    const remove = contract.functions.find((entry) => (
      entry.sig === "private.can_delete_member_case_object(p_bucket text, p_name text)"
    ));
    expect(remove.bodyContains).toContain("private.member_case_visible_to_caller(f.case_id)");
    expect(remove.bodyContains).toContain("f.user_id = (select auth.uid())");

    const insert = contract.policies.find((entry) => (
      entry.table === "storage.objects" && entry.name === "member_case_files_storage_insert"
    ));
    expect(insert).toMatchObject({ cmd: "a", roles: "authenticated" });
    expect(insert.withCheckContains).toEqual(expect.arrayContaining([
      "private.can_write_member_case_object(bucket_id, name)",
    ]));
    const del = contract.policies.find((entry) => (
      entry.table === "storage.objects" && entry.name === "member_case_files_storage_delete"
    ));
    expect(del).toMatchObject({ cmd: "d", roles: "authenticated" });
    expect(del.qualContains).toEqual(expect.arrayContaining([
      "private.can_delete_member_case_object(bucket_id, name)",
    ]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("a restricted case's writes follow the case row", () => {
  let client;
  const id = Object.fromEntries([
    "owner", "coordinator", "steward", "ownerSession", "coordinatorSession", "stewardSession",
    "org", "openCase", "restrictedCase",
  ].map((key) => [key, randomUUID()]));
  const chapter = `case-write-gate-${id.org}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const asOwner = async (fn) => {
    const previous = (await client.query("select current_user as u")).rows[0].u;
    await client.query("reset role");
    try {
      return await fn();
    } finally {
      if (previous === "authenticated") await client.query("set local role authenticated");
    }
  };

  const attempt = async (sqlText, params = []) => {
    await client.query("savepoint write_gate");
    try {
      const result = await client.query(sqlText, params);
      await client.query("release savepoint write_gate");
      return { ok: true, rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      await client.query("rollback to savepoint write_gate");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  const auditCount = (caseId) => asOwner(() => client.query(
    "select count(*)::int as n from public.coordinator_case_audit where case_id = $1",
    [caseId],
  )).then((result) => result.rows[0].n);

  const noteCount = (caseId) => asOwner(() => client.query(
    "select count(*)::int as n from public.member_case_updates where case_id = $1",
    [caseId],
  )).then((result) => result.rows[0].n);

  const contactCount = (caseId) => asOwner(() => client.query(
    "select count(*)::int as n from public.member_case_contacts where case_id = $1",
    [caseId],
  )).then((result) => result.rows[0].n);

  const outcomeCount = (caseId) => asOwner(() => client.query(
    "select count(*)::int as n from public.member_case_outcomes where case_id = $1",
    [caseId],
  )).then((result) => result.rows[0].n);

  const caseStatus = (caseId) => asOwner(() => client.query(
    "select status, step from public.member_cases where id = $1",
    [caseId],
  )).then((result) => result.rows[0]);

  const readable = async (caseId) => {
    const result = await client.query("select 1 from public.member_cases where id = $1", [caseId]);
    return result.rowCount === 1;
  };

  const objectAcl = async (caseId) => {
    const name = `${caseId}/evidence.txt`;
    const write = await client.query(
      "select private.can_write_member_case_object('case-files', $1) as ok",
      [name],
    );
    const remove = await client.query(
      "select private.can_delete_member_case_object('case-files', $1) as ok",
      [name],
    );
    return { write: write.rows[0].ok, delete: remove.rows[0].ok };
  };

  const rpcWrites = async (caseId, label) => {
    const before = {
      audit: await auditCount(caseId),
      notes: await noteCount(caseId),
      contacts: await contactCount(caseId),
      outcomes: await outcomeCount(caseId),
      status: await caseStatus(caseId),
    };
    // p_step is null on purpose. 20260917133000 (W2 retirement) made
    // coordinator_update_case refuse any step change — "step changes go through
    // the procedure transition", 22023 — and put configured steps behind
    // public.casework_advance_case_step plus the member_cases BEFORE UPDATE OF
    // step trigger. The status/reason write this proof needs still runs through
    // private.coordinator_case_for_update, which is the gate under test, so the
    // restriction boundary is proved exactly as before; only the retired step
    // argument is dropped.
    const update = await attempt(
      "select public.coordinator_update_case($1, 'active', null, null, $2)",
      [caseId, `${label} reason`],
    );
    const note = await attempt(
      "select public.coordinator_add_case_note($1, $2)",
      [caseId, `${label} note`],
    );
    const contact = await attempt(
      "select public.coordinator_log_case_contact($1, 'meeting', 'internal', $2, now())",
      [caseId, `${label} contact`],
    );
    const outcome = await attempt(
      "select public.coordinator_record_case_outcome($1, 'settled', $2)",
      [caseId, `${label} outcome`],
    );
    return {
      update,
      note,
      contact,
      outcome,
      after: {
        audit: await auditCount(caseId),
        notes: await noteCount(caseId),
        contacts: await contactCount(caseId),
        outcomes: await outcomeCount(caseId),
        status: await caseStatus(caseId),
      },
      before,
    };
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "coordinator-case-write-restriction-gate-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.owner, id.ownerSession],
      [id.coordinator, id.coordinatorSession],
      [id.steward, id.stewardSession],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic write-gate factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `case-write-gate-${id.org}`, id.owner]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9902)", [chapter, id.org]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.coordinator]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)", [id.org, id.steward]);

    for (const [caseId, reference, restricted] of [
      [id.openCase, "CASE-WRITE-OPEN", false],
      [id.restrictedCase, "CASE-WRITE-RESTRICTED", true],
    ]) {
      await client.query(
        `insert into public.member_cases(
           id,user_id,reference,title,case_type,organization_id,chapter_id,steward_user_id,
           is_restricted,restriction_reason,restricted_at,restricted_by)
         values($1,$2,$3,$3,'other',$4,$5,$6,$7,$8,$9,$10)`,
        [caseId, id.owner, reference, id.org, chapter, id.steward,
          restricted, restricted ? "sensitive investigation" : null,
          restricted ? new Date() : null, restricted ? id.owner : null],
      );
      await client.query(
        `insert into public.member_case_files(
           id,case_id,user_id,bucket_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
         values($1,$2,$3,'case-files',$4,$5,'text/plain',9,$3,now())`,
        [randomUUID(), caseId, id.owner, `${caseId}/evidence.txt`, `${reference}.txt`],
      );
      await client.query(
        "insert into storage.objects(bucket_id,name,owner,version,metadata) values('case-files',$1,$2,$3,$4::jsonb)",
        [`${caseId}/evidence.txt`, id.owner, `write-gate-${caseId}`, JSON.stringify({ size: 9, mimetype: "text/plain" })],
      );
    }

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(client);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("refuses every coordinator write on a restricted case the caller cannot read, with no row and no audit", async () => {
    await act(id.coordinator, id.coordinatorSession);
    expect((await client.query("select public.staff_can_see_user($1,'coordinator') as ok", [id.owner])).rows[0].ok).toBe(true);
    expect(await readable(id.openCase)).toBe(true);
    expect(await readable(id.restrictedCase)).toBe(false);

    const writes = await rpcWrites(id.restrictedCase, "restricted-denied");
    for (const path of ["update", "note", "contact", "outcome"]) {
      expect(writes[path], path).toMatchObject({ ok: false, code: "42501" });
    }
    expect(writes.after).toEqual(writes.before);
    expect(await objectAcl(id.restrictedCase)).toEqual({ write: false, delete: false });
    // Authenticated sessions cannot DELETE storage.objects in SQL
    // ("Use the Storage API instead"). The insert/delete policies still
    // name can_write/can_delete, so the helper return is the write/delete
    // oracle for those paths.
  });

  it("keeps the grant-less coordinator's authority on a non-restricted case", async () => {
    await act(id.coordinator, id.coordinatorSession);
    expect(await objectAcl(id.openCase)).toEqual({ write: true, delete: true });
    const writes = await rpcWrites(id.openCase, "open-allowed");
    expect(writes.update.ok, writes.update.message).toBe(true);
    expect(writes.note.ok, writes.note.message).toBe(true);
    expect(writes.contact.ok, writes.contact.message).toBe(true);
    expect(writes.outcome.ok, writes.outcome.message).toBe(true);
    expect(writes.after.audit).toBe(writes.before.audit + 4);
    expect(writes.after.notes).toBe(writes.before.notes + 1);
    expect(writes.after.contacts).toBe(writes.before.contacts + 1);
    expect(writes.after.outcomes).toBe(writes.before.outcomes + 1);
    expect(writes.after.status.status).toBe("resolved");
    // 20260917133000 (W2 retirement) routes configured step changes through the
    // procedure transition. Prove that boundary here so the promoted proof still
    // exercises p_step; it stays inside this `it`, so the file remains 11 cases.
    // The same call with p_step null succeeded above for this caller and case,
    // so the refusal is the step argument's alone, and the message match keeps
    // another 22023 from the same RPC from standing in for it.
    const stepChange = await attempt(
      "select public.coordinator_update_case($1, 'active', 'escalation', null, $2)",
      [id.openCase, "open-allowed step bypass"],
    );
    expect(stepChange).toMatchObject({ ok: false, code: "22023" });
    expect(stepChange.message).toMatch(/procedure transition/i);
  });

  it("restores restricted-case writes for an active grant and withdraws them on revoke", async () => {
    await client.query("reset role");
    const grant = randomUUID();
    await client.query(
      `insert into public.casework_access_grants(id,case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason)
       values($1,$2,$3,$4,$5,$6,'escalation cover for the assigned coordinator')`,
      [grant, id.restrictedCase, id.org, chapter, id.coordinator, id.owner],
    );

    await act(id.coordinator, id.coordinatorSession);
    expect(await readable(id.restrictedCase)).toBe(true);
    expect(await objectAcl(id.restrictedCase)).toEqual({ write: true, delete: true });
    const writes = await rpcWrites(id.restrictedCase, "restricted-granted");
    expect(writes.update.ok, writes.update.message).toBe(true);
    expect(writes.note.ok, writes.note.message).toBe(true);
    expect(writes.contact.ok, writes.contact.message).toBe(true);
    expect(writes.outcome.ok, writes.outcome.message).toBe(true);
    expect(writes.after.audit).toBe(writes.before.audit + 4);

    await client.query("reset role");
    await client.query("update public.casework_access_grants set revoked_at=now(), revoked_by=$2 where id=$1", [grant, id.owner]);

    await act(id.coordinator, id.coordinatorSession);
    expect(await readable(id.restrictedCase)).toBe(false);
    const refused = await rpcWrites(id.restrictedCase, "restricted-revoked");
    for (const path of ["update", "note", "contact", "outcome"]) {
      expect(refused[path], path).toMatchObject({ ok: false, code: "42501" });
    }
    expect(refused.after).toEqual(refused.before);
    expect(await objectAcl(id.restrictedCase)).toEqual({ write: false, delete: false });
  });

  it("leaves the case owner's attachment write and delete authority intact", async () => {
    await act(id.owner, id.ownerSession);
    expect(await readable(id.restrictedCase)).toBe(true);
    expect(await objectAcl(id.restrictedCase)).toEqual({ write: true, delete: true });
    const rpc = await attempt(
      "select public.coordinator_add_case_note($1, 'owner must not gain coordinator writes')",
      [id.restrictedCase],
    );
    expect(rpc).toMatchObject({ ok: false, code: "42501" });
    expect(rpc.message).toMatch(/coordinator role required/i);
  });

  it("leaves the assigned steward's caseload intact and does not grant coordinator writes", async () => {
    await act(id.steward, id.stewardSession);
    expect(await readable(id.restrictedCase)).toBe(true);
    expect(await readable(id.openCase)).toBe(true);
    const rpc = await attempt(
      "select public.coordinator_add_case_note($1, 'steward must not gain coordinator writes')",
      [id.restrictedCase],
    );
    expect(rpc).toMatchObject({ ok: false, code: "42501" });
    expect(rpc.message).toMatch(/coordinator role required/i);
    // Stewards were never on the coordinator object ACL; do not widen it.
    expect(await objectAcl(id.restrictedCase)).toEqual({ write: false, delete: false });
  });
});
