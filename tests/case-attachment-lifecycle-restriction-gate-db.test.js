// @vitest-environment node
//
// SEC-UG-CASE-ATTACHMENT-LIFECYCLE-RPCS-IGNORE-RESTRICTION-20260917
//
// PR #2119 gated private.coordinator_case_for_update and the legacy
// exact-path Storage predicates. The live attachment path never reaches
// those helpers: begin_member_case_file_upload, confirm_member_case_file_upload
// and request_member_case_file_removal still authorized a grant-less in-scope
// coordinator on staff_can_see_user alone. 20260917105000 adds
// private.member_case_visible_to_caller to the coordinator branch of each
// lookup (and of the sibling register/remove writers) and leaves the owner
// and uploaded_by branches unchanged. sensitive_case_upload_target is not
// re-emitted: its staff branch already ANDs private.casework_staff_can_access,
// so the live half only proves that existing refusal cannot regress.
//
// The offline half pins the migration text and the db-contract needles so the
// suite still guards the SQL without a database. The live half is the part
// that matters: a SECURITY DEFINER RPC is only ever proved by calling it.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const sql = stripComments(loadMigrationSql("case_attachment_lifecycle_restriction_gate"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const helperBody = stripComments(fnBody(sql, "private.member_case_visible_to_caller"));

describe("case attachment lifecycle restriction-gate migration", () => {
  it("sorts after the pg_net tick request-id migration it was written against and after both sibling restriction gates, and takes a bounded lock", () => {
    const name = findMigrationName("case_attachment_lifecycle_restriction_gate");
    expect(name > "20260915180000_pg_net_tick_request_id_idempotency.sql").toBe(true);
    // PR #2113's read-side gate landed as 20260917103000 and PR #2119's
    // write-side gate as 20260917104000. Both were renumbered at merge, so
    // cite the filenames that are in the tree, not the reviewed ones.
    expect(name > "20260917103000_case_child_row_restriction_gate.sql").toBe(true);
    expect(name > "20260917104000_coordinator_case_write_restriction_gate.sql").toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
  });

  it("reuses PR 2119's visibility helper and does not redefine the read-side helper or any policy", () => {
    expect(flat).toContain("create or replace function private.member_case_visible_to_caller(p_case_id uuid)");
    expect(flat).not.toContain("private.member_case_restriction_cleared");
    expect(flat).not.toContain("create policy");
    expect(flat).not.toContain("drop policy");
    expect(flat).not.toContain("alter policy");
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

  it("gates the coordinator branch of every attachment lifecycle writer and leaves owner and uploaded_by branches", () => {
    const begin = squash(stripComments(fnBody(sql, "public.begin_member_case_file_upload")));
    expect(begin.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);"))
      .toBeLessThan(begin.indexOf("declare caller"));
    expect(begin).toContain("c.user_id = caller");
    expect(begin).toContain(
      "or (public.staff_can_see_user(c.user_id, 'coordinator') and private.member_case_visible_to_caller(c.id))",
    );

    const register = squash(stripComments(fnBody(sql, "public.register_member_case_file")));
    expect(register.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);"))
      .toBeLessThan(register.indexOf("declare caller"));
    expect(register).toContain("c.user_id = caller");
    expect(register).toContain(
      "or (public.staff_can_see_user(c.user_id, 'coordinator') and private.member_case_visible_to_caller(c.id))",
    );
    expect(register).toContain("private.private_upload_is_current(inserted.bucket_id, inserted.object_name)");

    // The upload target is already gated by private.casework_staff_can_access
    // (20260906190000:322) and the record keeps it out of scope: this
    // migration must not re-emit it.
    expect(flat).not.toContain("function public.sensitive_case_upload_target");

    const confirm = squash(stripComments(fnBody(sql, "public.confirm_member_case_file_upload")));
    expect(confirm.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);"))
      .toBeLessThan(confirm.indexOf("declare caller"));
    expect(confirm).toContain("f.uploaded_by = caller");
    expect(confirm).toContain("c.user_id = caller");
    expect(confirm).toContain(
      "or (public.staff_can_see_user(c.user_id, 'coordinator') and private.member_case_visible_to_caller(c.id))",
    );

    const request = squash(stripComments(fnBody(sql, "public.request_member_case_file_removal")));
    expect(request.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);"))
      .toBeLessThan(request.indexOf("declare caller"));
    expect(request).toContain("f.user_id = caller");
    expect(request).toContain(
      "or (public.staff_can_see_user(f.user_id, 'coordinator') and private.member_case_visible_to_caller(f.case_id))",
    );
    expect(request).toContain("f.removal_id = p_removal_id and f.removal_requested_by = caller");

    const remove = squash(stripComments(fnBody(sql, "public.remove_member_case_file")));
    expect(remove.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);"))
      .toBeLessThan(remove.indexOf("declare caller"));
    expect(remove).toContain("f.user_id = caller");
    expect(remove).toContain(
      "or (public.staff_can_see_user(f.user_id, 'coordinator') and private.member_case_visible_to_caller(f.case_id))",
    );
  });

  it("pins the repaired shapes in the database contract", () => {
    const visible = contract.functions.find((entry) => (
      entry.sig === "private.member_case_visible_to_caller(p_case_id uuid)"
    ));
    expect(visible).toMatchObject({
      secdef: true,
      exec: "",
    });
    // 20260925995000 made this helper a by-id wrapper over the single row-typed
    // predicate private.member_case_row_visible; the branches now live there.
    expect(visible.bodyContains).toEqual(expect.arrayContaining([
      "c.id = p_case_id",
      "private.member_case_row_visible(c)",
    ]));
    expect(visible.bodyForbids).toEqual(expect.arrayContaining([
      "set role",
    ]));

    const bySig = new Map(contract.functions.map((entry) => [entry.sig, entry]));
    expect(bySig.get("public.begin_member_case_file_upload(p_file_id uuid, p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint)")
      .bodyContains).toEqual(expect.arrayContaining([
      "private.member_case_visible_to_caller(c.id)",
      "c.user_id = caller",
    ]));
    expect(bySig.get("public.register_member_case_file(p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint)")
      .bodyContains).toEqual(expect.arrayContaining([
      "private.member_case_visible_to_caller(c.id)",
      "c.user_id = caller",
    ]));
    // The already-gated upload target keeps its existing conjunct pinned and
    // gains no second predicate.
    const target = bySig.get("public.sensitive_case_upload_target(p_file_id uuid)");
    expect(target.bodyContains).toEqual(expect.arrayContaining([
      "private.casework_staff_can_access(f.case_id)",
      "uploaded_by = (select auth.uid())",
    ]));
    expect(target.bodyContains).not.toContain("private.member_case_visible_to_caller(f.case_id)");
    expect(bySig.get("public.confirm_member_case_file_upload(p_file_id uuid)")
      .bodyContains).toEqual(expect.arrayContaining([
      "private.member_case_visible_to_caller(c.id)",
      "f.uploaded_by = caller",
    ]));
    expect(bySig.get("public.request_member_case_file_removal(p_file_id uuid, p_removal_id uuid)")
      .bodyContains).toEqual(expect.arrayContaining([
      "private.member_case_visible_to_caller(f.case_id)",
      "f.user_id = caller",
    ]));
    expect(bySig.get("public.remove_member_case_file(p_file_id uuid)")
      .bodyContains).toEqual(expect.arrayContaining([
      "private.member_case_visible_to_caller(f.case_id)",
      "f.user_id = caller",
    ]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("a restricted case's attachment lifecycle follows the case row", () => {
  let client;
  const id = Object.fromEntries([
    "owner", "coordinator", "grantedCoordinator", "ownCoordinator", "advisor", "steward",
    "ownerSession", "coordinatorSession", "grantedCoordinatorSession", "ownCoordinatorSession",
    "advisorSession", "stewardSession",
    "org", "openCase", "restrictedCase",
    "restrictedConfirmed", "restrictedConfirmedForOwnCoordinator", "restrictedPending", "openConfirmed",
  ].map((key) => [key, randomUUID()]));
  const chapter = `case-attach-gate-${id.org}`;

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
    await client.query("savepoint attach_gate");
    try {
      const result = await client.query(sqlText, params);
      await client.query("release savepoint attach_gate");
      return { ok: true, rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      await client.query("rollback to savepoint attach_gate");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  const fileCount = (caseId) => asOwner(() => client.query(
    "select count(*)::int as n from public.member_case_files where case_id = $1",
    [caseId],
  )).then((result) => result.rows[0].n);

  const fileRow = (fileId) => asOwner(() => client.query(
    `select removal_requested_at is not null as requested,
            removal_requested_by, removal_id, confirmed_at is not null as confirmed
       from public.member_case_files where id = $1`,
    [fileId],
  )).then((result) => result.rows[0] ?? null);

  const readable = (caseId) => client.query(
    "select exists(select 1 from public.member_cases where id = $1) as ok",
    [caseId],
  ).then((result) => result.rows[0].ok);

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "case-attachment-lifecycle-restriction-gate-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.owner, id.ownerSession],
      [id.coordinator, id.coordinatorSession],
      [id.grantedCoordinator, id.grantedCoordinatorSession],
      [id.ownCoordinator, id.ownCoordinatorSession],
      [id.advisor, id.advisorSession],
      [id.steward, id.stewardSession],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic attach-gate factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `case-attach-gate-${id.org}`, id.owner]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9903)", [chapter, id.org]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.coordinator]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.grantedCoordinator]);
    // The case's own coordinator_user_id and an organization advisor holding
    // the coordinator hat: neither holds a casework_access_grants row.
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.ownCoordinator]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.advisor]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'advisor',$2)", [id.org, id.advisor]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)", [id.org, id.steward]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2),($3,'coordinator',$2),($4,'coordinator',$2),($5,'coordinator',$2),($6,'steward',$2)", [
      id.coordinator, chapter, id.grantedCoordinator, id.ownCoordinator, id.advisor, id.steward,
    ]);

    for (const [caseId, reference, restricted] of [
      [id.openCase, "CASE-ATTACH-OPEN", false],
      [id.restrictedCase, "CASE-ATTACH-RESTRICTED", true],
    ]) {
      await client.query(
        `insert into public.member_cases(
           id,user_id,reference,title,case_type,organization_id,chapter_id,steward_user_id,
           coordinator_user_id,is_restricted,restriction_reason,restricted_at,restricted_by)
         values($1,$2,$3,$3,'other',$4,$5,$6,$7,$8,$9,$10,$11)`,
        [caseId, id.owner, reference, id.org, chapter, id.steward,
          restricted ? id.ownCoordinator : null,
          restricted, restricted ? "sensitive investigation" : null,
          restricted ? new Date() : null, restricted ? id.owner : null],
      );
    }

    await client.query(
      `insert into public.member_case_files(
         id,case_id,user_id,bucket_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
       values($1,$2,$3,'case-files',$4,'restricted.txt','text/plain',9,$3,now())`,
      [id.restrictedConfirmed, id.restrictedCase, id.owner, `${id.restrictedCase}/restricted.txt`],
    );
    await client.query(
      `insert into public.member_case_files(
         id,case_id,user_id,bucket_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
       values($1,$2,$3,'case-files',$4,'restricted-own.txt','text/plain',9,$3,now())`,
      [id.restrictedConfirmedForOwnCoordinator, id.restrictedCase, id.owner, `${id.restrictedCase}/restricted-own.txt`],
    );
    await client.query(
      `insert into public.member_case_files(
         id,case_id,user_id,bucket_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
       values($1,$2,$3,'case-files',$4,'open.txt','text/plain',9,$3,now())`,
      [id.openConfirmed, id.openCase, id.owner, `${id.openCase}/open.txt`],
    );
    // Leftover pending row as if the grant-less coordinator had begun before
    // this gate. Target and confirm must still refuse on the restricted case.
    await client.query(
      `insert into public.member_case_files(
         id,case_id,user_id,bucket_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
       values($1,$2,$3,'case-files',$4,'pending.txt','text/plain',9,$5,null)`,
      [id.restrictedPending, id.restrictedCase, id.owner, `${id.restrictedCase}/pending.txt`, id.coordinator],
    );

    await client.query(
      `insert into public.casework_access_grants(id,case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason)
       values($1,$2,$3,$4,$5,$6,'escalation cover for the assigned coordinator')`,
      [randomUUID(), id.restrictedCase, id.org, chapter, id.grantedCoordinator, id.owner],
    );

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(client);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("refuses the grant-less coordinator on begin, upload-target, confirm, request-removal and remove, with no row and no tombstone", async () => {
    await act(id.coordinator, id.coordinatorSession);
    expect((await client.query("select public.staff_can_see_user($1,'coordinator') as ok", [id.owner])).rows[0].ok).toBe(true);
    expect(await readable(id.openCase)).toBe(true);
    expect(await readable(id.restrictedCase)).toBe(false);

    const before = await fileCount(id.restrictedCase);
    const begin = await attempt(
      "select public.begin_member_case_file_upload($1,$2,'denied.txt','text/plain',9)",
      [randomUUID(), id.restrictedCase],
    );
    expect(begin).toMatchObject({ ok: false, code: "22023" });
    expect(begin.message).toMatch(/case unavailable/i);
    expect(await fileCount(id.restrictedCase)).toBe(before);

    const target = await attempt(
      "select public.sensitive_case_upload_target($1)",
      [id.restrictedPending],
    );
    expect(target).toMatchObject({ ok: false, code: "42501" });
    expect(target.message).toMatch(/file unavailable/i);

    const confirm = await attempt(
      "select public.confirm_member_case_file_upload($1)",
      [id.restrictedPending],
    );
    expect(confirm).toMatchObject({ ok: false, code: "22023" });
    expect(confirm.message).toMatch(/file unavailable/i);
    expect((await fileRow(id.restrictedPending)).confirmed).toBe(false);

    const beforeRemoval = await fileRow(id.restrictedConfirmed);
    expect(beforeRemoval.requested).toBe(false);
    const request = await attempt(
      "select public.request_member_case_file_removal($1,$2)",
      [id.restrictedConfirmed, randomUUID()],
    );
    expect(request).toMatchObject({ ok: false, code: "22023" });
    expect(request.message).toMatch(/file unavailable/i);
    const afterRemoval = await fileRow(id.restrictedConfirmed);
    expect(afterRemoval.requested).toBe(false);
    expect(afterRemoval.removal_requested_by).toBeNull();
    expect(afterRemoval.removal_id).toBeNull();

    const remove = await attempt(
      "select public.remove_member_case_file($1)",
      [id.restrictedConfirmed],
    );
    expect(remove).toMatchObject({ ok: false, code: "22023" });
    expect(await fileCount(id.restrictedCase)).toBe(before);
  });

  it("keeps the grant-less coordinator's authority on a non-restricted case", async () => {
    await act(id.coordinator, id.coordinatorSession);
    const beginId = randomUUID();
    const begin = await attempt(
      "select public.begin_member_case_file_upload($1,$2,'open-allowed.txt','text/plain',9)",
      [beginId, id.openCase],
    );
    expect(begin.ok, begin.message).toBe(true);
    const abort = await attempt("select public.abort_member_case_file_upload($1)", [beginId]);
    expect(abort.ok, abort.message).toBe(true);

    const request = await attempt(
      "select public.request_member_case_file_removal($1,$2)",
      [id.openConfirmed, randomUUID()],
    );
    expect(request.ok, request.message).toBe(true);
    const after = await fileRow(id.openConfirmed);
    expect(after.requested).toBe(true);
    expect(after.removal_requested_by).toBe(id.coordinator);
  });

  it("restores restricted-case attachment writes for a granted coordinator", async () => {
    await act(id.grantedCoordinator, id.grantedCoordinatorSession);
    expect(await readable(id.restrictedCase)).toBe(true);

    const beginId = randomUUID();
    const begin = await attempt(
      "select public.begin_member_case_file_upload($1,$2,'granted.txt','text/plain',9)",
      [beginId, id.restrictedCase],
    );
    expect(begin.ok, begin.message).toBe(true);

    const target = await attempt(
      "select public.sensitive_case_upload_target($1)",
      [beginId],
    );
    expect(target.ok, target.message).toBe(true);

    // No Storage object: confirm must pass the lookup and then refuse on the
    // missing object, which is the authorization oracle without uploading bytes.
    const confirm = await attempt(
      "select public.confirm_member_case_file_upload($1)",
      [beginId],
    );
    expect(confirm).toMatchObject({ ok: false, code: "22023" });
    expect(confirm.message).toMatch(/uploaded file was not found/i);

    const request = await attempt(
      "select public.request_member_case_file_removal($1,$2)",
      [id.restrictedConfirmed, randomUUID()],
    );
    expect(request.ok, request.message).toBe(true);
    const after = await fileRow(id.restrictedConfirmed);
    expect(after.requested).toBe(true);
    expect(after.removal_requested_by).toBe(id.grantedCoordinator);
  });

  it("keeps the case's own coordinator and an advisor holding the coordinator hat, both grant-less", async () => {
    // Acceptance: the case's own coordinator_user_id and an organization
    // advisor/admin/vp keep exactly their current authority without a
    // casework_access_grants row. Both clear the visibility helper on their
    // own branch of the member_cases SELECT policy.
    for (const [actor, session] of [
      [id.ownCoordinator, id.ownCoordinatorSession],
      [id.advisor, id.advisorSession],
    ]) {
      await act(actor, session);
      expect(await readable(id.restrictedCase)).toBe(true);
      const beginId = randomUUID();
      const begin = await attempt(
        "select public.begin_member_case_file_upload($1,$2,'hat.txt','text/plain',9)",
        [beginId, id.restrictedCase],
      );
      expect(begin.ok, begin.message).toBe(true);
      const target = await attempt("select public.sensitive_case_upload_target($1)", [beginId]);
      expect(target.ok, target.message).toBe(true);
      const confirm = await attempt("select public.confirm_member_case_file_upload($1)", [beginId]);
      expect(confirm).toMatchObject({ ok: false, code: "22023" });
      expect(confirm.message).toMatch(/uploaded file was not found/i);
      const abort = await attempt("select public.abort_member_case_file_upload($1)", [beginId]);
      expect(abort.ok, abort.message).toBe(true);
    }

    await act(id.ownCoordinator, id.ownCoordinatorSession);
    const request = await attempt(
      "select public.request_member_case_file_removal($1,$2)",
      [id.restrictedConfirmedForOwnCoordinator, randomUUID()],
    );
    expect(request.ok, request.message).toBe(true);
    const after = await fileRow(id.restrictedConfirmedForOwnCoordinator);
    expect(after.requested).toBe(true);
    expect(after.removal_requested_by).toBe(id.ownCoordinator);
  });

  it("leaves the case owner's attachment authority intact on a restricted case", async () => {
    await act(id.owner, id.ownerSession);
    expect(await readable(id.restrictedCase)).toBe(true);
    const beginId = randomUUID();
    const begin = await attempt(
      "select public.begin_member_case_file_upload($1,$2,'owner.txt','text/plain',9)",
      [beginId, id.restrictedCase],
    );
    expect(begin.ok, begin.message).toBe(true);
    const abort = await attempt("select public.abort_member_case_file_upload($1)", [beginId]);
    expect(abort.ok, abort.message).toBe(true);
  });

  it("leaves the assigned steward's caseload intact and does not grant attachment writes", async () => {
    await act(id.steward, id.stewardSession);
    expect(await readable(id.restrictedCase)).toBe(true);
    expect(await readable(id.openCase)).toBe(true);
    const begin = await attempt(
      "select public.begin_member_case_file_upload($1,$2,'steward.txt','text/plain',9)",
      [randomUUID(), id.restrictedCase],
    );
    expect(begin).toMatchObject({ ok: false, code: "22023" });
    const request = await attempt(
      "select public.request_member_case_file_removal($1,$2)",
      [id.restrictedConfirmed, randomUUID()],
    );
    expect(request).toMatchObject({ ok: false, code: "22023" });
  });
});
