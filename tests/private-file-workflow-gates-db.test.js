// @vitest-environment node
//
// Required disposable-database proof for the private-upload workflow gates
// (SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904, slice 4).
//
// Style is copied deliberately from tests/private-file-authorization-db.test.js:
// one pg.Client, begin/rollback-only fixtures, set_config('request.jwt.claims')
// plus `set local role` to switch identity, a savepoint-wrapped denied() helper
// that asserts SQLSTATE, and a deliberate 42883 re-throw so a MISSING function
// is a red test rather than a silent skip.
//
// Actor fixtures are disjoint from that file's on purpose: it asserts an exact
// private_upload_inspection_limits.hour_count for its own actor, and the runner
// executes both files against one shared disposable schema under --maxWorkers=1.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const databaseIt = process.env.RUN_PRIVATE_FILE_WORKFLOW_GATE_DB_TESTS === "1" ? it : it.skip;
const authorize = "select public.authorize_private_upload_inspection($1,$2) value";
const finish = "select public.finish_private_upload_inspection($1,$2,$3,'ClamAV 1.5.4',28113,now(),clock_timestamp()) value";
// Disjoint from the authorization proof's digest so a cross-file fixture leak
// would surface as an immutable-digest refusal rather than a silent pass.
const digest = "b".repeat(64);
const OBJECT_METADATA = '{"size":9,"mimetype":"text/plain"}';

// Section 1 of 20260906029000, verbatim: the decision-source column, the drop
// of the pre-repair candidate check, the three backfill UPDATEs, the three
// replacement constraints, the column comments and the index. The backfill
// replay proof below executes exactly this text, so a reordered or edited
// migration is exercised here rather than described.
const provenanceMigrationSql = loadMigrationSql("20260906029000_retirement_candidate_provenance");
const BACKFILL_SECTION = provenanceMigrationSql.slice(
  provenanceMigrationSql.indexOf("alter table public.member_kb_article_revisions\n  add column reconciled_by_source_id"),
  provenanceMigrationSql.indexOf("-- 2. CBA reconciliation"),
);
// The check 20260906028000 left on the hosted databases, re-added so the
// fixture's schema really is the one this migration will meet there.
const PRIOR_CANDIDATE_CHECK = "add constraint member_kb_article_revisions_candidate_is_derived"
  + " check ( import_candidate_key is null"
  + " or (content_origin = 'derived' and knowledge_source_id is not null) )";

// Every relation the committed race fixture can touch. The race proof takes a
// census before it seeds and asserts the same census after teardown, so a table
// left dirty for the other proofs in this shared disposable schema is a red
// test rather than a delayed, confusing failure somewhere else.
const CENSUS_TABLES = [
  "auth.users", "auth.sessions", "auth.mfa_factors", "public.member_profiles",
  "public.organizations", "public.chapters", "public.organization_memberships",
  "public.organization_role_grants", "public.org_security_policy",
  "public.member_chapter_memberships", "public.member_cases", "public.member_case_files",
  "public.chapter_workstreams", "public.chapter_tasks", "public.chapter_task_files",
  "public.chapter_task_activity", "public.member_forms", "public.member_form_files",
  "public.organization_knowledge_files", "public.organization_knowledge_sources",
  "public.organization_knowledge_chunks",
  "public.member_kb_articles", "public.member_kb_article_revisions",
  "public.organization_audit_events", "public.member_notifications",
  "storage.objects", "private.private_upload_scans",
  "private.private_upload_inspection_attempts", "private.private_upload_inspection_limits",
  "private.mi1_w2_operation_receipts",
];

async function census(client) {
  const counts = {};
  for (const table of CENSUS_TABLES) {
    counts[table] = (await client.query(`select pg_catalog.count(*)::integer c from ${table}`)).rows[0].c;
  }
  return counts;
}

// Teardown for the two proofs that must COMMIT so a second session can see the
// fixture. Triggers and FK order are suspended: the tenancy guards that protect
// real data (last-admin, storage delete guard, ledger tombstones) would
// otherwise refuse a teardown, and every row named here was created by this
// file on an owned disposable stack. The census equality at the end is what
// makes "nothing was left behind" an assertion rather than a hope.
async function teardownCommittedFixture(client, ids, seeded, before) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims',null,false)");
  await client.query("select set_config('storage.allow_delete_query','true',false)");
  await client.query("set session_replication_role = replica");
  try {
    for (const [table, column, value] of [
      ["private.private_upload_inspection_attempts", "actor_user_id", ids.owner],
      ["private.private_upload_inspection_limits", "user_id", ids.owner],
      ["storage.objects", "id", null],
      ["private.private_upload_scans", "object_name", null],
      ["public.member_kb_article_revisions", "chapter_id", ids.chapter],
      ["public.member_kb_articles", "chapter_id", ids.chapter],
      ["public.organization_knowledge_chunks", "organization_id", ids.org],
      ["public.organization_knowledge_sources", "organization_id", ids.org],
      ["public.organization_knowledge_files", "organization_id", ids.org],
      ["public.member_form_files", "form_id", ids.form],
      ["public.member_forms", "id", ids.form],
      ["public.chapter_task_files", "task_id", ids.task],
      ["public.chapter_task_activity", "task_id", ids.task],
      ["public.chapter_tasks", "id", ids.task],
      ["public.chapter_workstreams", "chapter_id", ids.chapter],
      ["public.member_case_files", "case_id", ids.case],
      ["public.member_cases", "id", ids.case],
      ["public.organization_audit_events", "organization_id", ids.org],
      ["private.mi1_w2_operation_receipts", "organization_id", ids.org],
      ["public.org_security_policy", "organization_id", ids.org],
      ["public.organization_role_grants", "organization_id", ids.org],
      ["public.organization_memberships", "organization_id", ids.org],
      ["public.member_chapter_memberships", "chapter_id", ids.chapter],
      ["public.chapters", "organization_id", ids.org],
      ["public.organizations", "id", ids.org],
      ["public.member_notifications", "user_id", null],
      ["public.member_profiles", "id", null],
      ["auth.mfa_factors", "user_id", null],
      ["auth.sessions", "user_id", null],
      ["auth.users", "id", null],
    ]) {
      if (value === null && table === "storage.objects") {
        await client.query("delete from storage.objects where id = any($1)", [seeded.files.map((file) => file.objectId)]);
      } else if (value === null && table === "private.private_upload_scans") {
        await client.query("delete from private.private_upload_scans where object_name = any($1)", [seeded.files.map((file) => file.path)]);
      } else if (value === null) {
        await client.query(`delete from ${table} where ${column} = any($1)`, [[ids.owner, ids.reviewer]]);
      } else {
        await client.query(`delete from ${table} where ${column} = $1`, [value]);
      }
    }
  } finally {
    await client.query("set session_replication_role = origin");
  }
  expect(await census(client)).toEqual(before);
}

function connect() {
  return new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    application_name: "private-file-workflow-gates-proof",
  });
}

function makeIds(tag) {
  const ids = Object.fromEntries([
    "owner", "reviewer", "ownerSession", "reviewerSession", "org", "case", "task", "form",
  ].map((key) => [key, randomUUID()]));
  ids.tag = tag;
  ids.chapter = `gate-${tag}-home-${ids.org}`;
  ids.spareChapter = `gate-${tag}-spare-${ids.org}`;
  return ids;
}

function harness(client, ids) {
  // Identity switching mirrors tests/private-file-authorization-db.test.js: the
  // JWT claims stay attached even under `postgres`, because several fixture
  // triggers read auth.uid() and would otherwise refuse the seed rows.
  const role = async (name, actor = ids.owner, session = ids.ownerSession, aal = "aal2") => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: name, sub: actor, session_id: session, aal }),
    ]);
    await client.query(`set local role ${name}`);
  };
  let savepoint = 0;
  const denied = async (statement, params, expected = "42501") => {
    const label = `gate_denied_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    let caught;
    try { await client.query(statement, params); } catch (error) { caught = error; }
    finally {
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
    }
    expect(caught, `expected SQLSTATE ${expected} from: ${statement}`).toBeTruthy();
    expect(caught.code, `${statement} -> ${caught.message}`).toBe(expected);
    return caught.message;
  };
  return { role, denied };
}

// Rollback-only SQL metadata fixtures with no backing bytes. Real Storage byte
// operations are covered by the separate Storage API proof.
async function seed(client, ids, role) {
  await role("postgres");
  for (const [user, session] of [[ids.owner, ids.ownerSession], [ids.reviewer, ids.reviewerSession]]) {
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic gate factor','totp','verified',now(),now())", [randomUUID(), user]);
  }
  await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, `gate-proof-${ids.org}`, ids.owner]);
  for (const [chapter, order] of [[ids.chapter, 9901], [ids.spareChapter, 9902]]) {
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapter, ids.org, order]);
  }
  await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ids.org]);
  for (const [user, grant] of [[ids.owner, "admin"], [ids.reviewer, "steward"]]) {
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, ids.chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, ids.chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [ids.org, user, grant]);
  }
  await client.query("insert into public.member_cases(id,user_id,reference,title,case_type) values($1,$2,$3,'Synthetic gate case','other')", [ids.case, ids.owner, `GATE-${ids.case}`]);
  await client.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [ids.chapter, ids.owner]);
  await client.query("insert into public.chapter_tasks(id,chapter_id,title,created_by,updated_by) values($1,$2,'Synthetic gate task',$3,$3)", [ids.task, ids.chapter, ids.owner]);
  await client.query("insert into public.member_forms(id,user_id,template_key) values($1,$2,'grievance')", [ids.form, ids.owner]);

  // This gate reviewer is an existing broad grant.
  await migrateLegacyStewardFixtures(client);
  await role("authenticated", ids.owner, ids.ownerSession);
  const files = [];
  const caseFileId = randomUUID();
  const caseRow = (await client.query("select public.begin_member_case_file_upload($1,$2,'synthetic.txt','text/plain',9) value", [caseFileId, ids.case])).rows[0].value;
  files.push({ kind: "case", id: caseRow.id, bucket: caseRow.bucketId, path: caseRow.objectName });
  const taskFileId = randomUUID();
  const taskRow = (await client.query("select public.begin_chapter_task_file_upload($1,$2,'synthetic.txt','text/plain',9) value", [taskFileId, ids.task])).rows[0].value;
  files.push({ kind: "task", id: taskRow.id, bucket: taskRow.bucketId, path: taskRow.objectName });
  const formRow = (await client.query("select public.register_member_form_file($1,'synthetic.txt','text/plain',9) value", [ids.form])).rows[0].value;
  files.push({ kind: "form", id: formRow.id, bucket: formRow.bucketId, path: formRow.objectName });
  const prepared = (await client.query("select public.prepare_steward_library_upload('synthetic.txt',9,$1,'Synthetic gate upload','Workflow gate proof','contract',$2,$3) value", [digest, randomUUID(), ids.chapter])).rows[0].value;
  const target = (await client.query("select public.get_knowledge_file_storage_target($1,$2,'upload') value", [prepared.fileId, prepared.storageHandle])).rows[0].value;
  files.push({ kind: "knowledge", id: prepared.fileId, bucket: target.bucketId, path: target.objectName, storageHandle: prepared.storageHandle });

  await role("postgres");
  for (const file of files) {
    const inserted = await client.query(
      "insert into storage.objects(bucket_id,name,owner,version,metadata) values($1,$2,$3,$4,$5::jsonb) returning id",
      [file.bucket, file.path, ids.owner, `gate-version-${ids.tag}`, OBJECT_METADATA],
    );
    file.objectId = inserted.rows[0].id;
  }
  return { files, byKind: Object.fromEntries(files.map((file) => [file.kind, file])) };
}

async function inspectClean(client, role, ids, file) {
  await role("authenticated", ids.owner, ids.ownerSession);
  const target = (await client.query(authorize, [file.kind, file.id])).rows[0].value;
  expect(target.attemptId, `authorize(${file.kind}) returned ${JSON.stringify(target)}`).toBeTruthy();
  await role("service_role");
  expect((await client.query(finish, [target.attemptId, "clean", digest])).rows[0].value.status).toBe("clean");
  return target;
}

databaseIt("denies every gated workflow without a current verdict and keeps denying when authorization is revoked", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("revoked");
  const { role, denied } = harness(client, ids);
  try {
    await client.query("select public.confirm_member_case_file_upload(null)").catch((error) => {
      // A missing function is a real red test; do not let it become a skip.
      if (error.code === "42883") throw error;
    });
    await client.query("rollback"); await client.query("begin");
    const { byKind } = await seed(client, ids, role);

    // 1. A fully authorized actor is denied while the ledger row is pending.
    await role("authenticated", ids.owner, ids.ownerSession);
    expect(await denied("select public.confirm_member_case_file_upload($1)", [byKind.case.id]))
      .toContain("file inspection required");
    await denied("select public.confirm_chapter_task_file_upload($1)", [byKind.task.id]);
    await denied("select public.confirm_member_form_file($1)", [byKind.form.id]);
    await denied("select public.complete_steward_library_upload($1,$2)", [byKind.knowledge.id, randomUUID()]);
    await denied("select public.review_steward_library_file($1,'approved')", [byKind.knowledge.id]);
    await denied("select public.download_steward_library_file($1)", [byKind.knowledge.id]);
    await denied("select public.get_knowledge_file_storage_target($1,$2,'steward_download')", [byKind.knowledge.id, byKind.knowledge.storageHandle]);
    // Rejection and quarantine must stay reachable for an unscanned file.
    await client.query("savepoint quarantine_remains_reachable");
    expect((await client.query("select public.review_steward_library_file($1,'quarantined') value", [byKind.knowledge.id])).rows[0].value.reviewStatus).toBe("quarantined");
    await client.query("rollback to savepoint quarantine_remains_reachable");
    await client.query("release savepoint quarantine_remains_reachable");

    // 2. With a current verdict the same calls succeed.
    for (const file of Object.values(byKind)) await inspectClean(client, role, ids, file);
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await client.query("select public.confirm_member_case_file_upload($1) value", [byKind.case.id])).rows[0].value.confirmedAt).toBeTruthy();
    expect((await client.query("select public.confirm_chapter_task_file_upload($1) value", [byKind.task.id])).rows[0].value.confirmedAt).toBeTruthy();
    expect((await client.query("select public.confirm_member_form_file($1) value", [byKind.form.id])).rows[0].value.confirmedAt).toBeTruthy();
    await client.query("select public.complete_steward_library_upload($1,$2)", [byKind.knowledge.id, randomUUID()]);
    await client.query("select public.review_steward_library_file($1,'approved')", [byKind.knowledge.id]);
    await client.query("select public.publish_steward_file_to_catalog($1,'general',$2)", [byKind.knowledge.id, randomUUID()]);
    expect((await client.query("select public.download_steward_library_file($1) value", [byKind.knowledge.id])).rows[0].value.href).toContain("knowledge:");
    const catalog = (await client.query("select public.list_resource_catalog_page(null,null,null,null) value")).rows[0].value;
    expect(catalog.map((row) => row.id)).toContain(byKind.knowledge.id);
    expect((await client.query("select public.download_resource_catalog_item($1) value", [byKind.knowledge.id])).rows[0].value.href)
      .toContain("knowledge:");

    // 2b. Submission, approval and the service-role filing copy each refuse an
    //     attachment whose verdict has lapsed, and each get past that gate the
    //     moment it is current again.
    await role("postgres");
    await client.query("savepoint form_workflow");
    const lapse = () => client.query(
      "update private.private_upload_scans set scanned_at=now()-interval '25 hours', clean_until=now()-interval '1 second' where object_id=$1",
      [byKind.form.objectId]);
    const restore = () => client.query(
      "update private.private_upload_scans set scanned_at=now(), clean_until=now()+interval '1 hour' where object_id=$1",
      [byKind.form.objectId]);
    await lapse();
    await role("authenticated", ids.owner, ids.ownerSession);
    expect(await denied("select public.submit_form($1)", [ids.form], "22023"))
      .toContain("wait for every attachment inspection to finish");
    await role("postgres");
    await client.query("update public.member_forms set status='submitted', submitted_at=now() where id=$1", [ids.form]);
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    expect(await denied("select public.approve_form($1)", [ids.form], "22023"))
      .toContain("attachment without a current inspection");
    await role("postgres");
    await restore();
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    // Past the attachment gate, approval now stops at the next unmet
    // precondition — proof the refusal above was the inspection gate itself.
    expect(await denied("select public.approve_form($1)", [ids.form], "22023"))
      .toContain("current filer signature");

    await role("postgres");
    // Filing runs with a service credential that has no member subject. A
    // case-linked approved form must revalidate the explicit owner argument.
    await client.query("update public.member_forms set case_id=$2 where id=$1", [ids.form, ids.case]);
    const contentDigest = (await client.query("select private.form_content_digest($1) value", [ids.form])).rows[0].value;
    const strokes = JSON.stringify([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]);
    const signatureDigest = (await client.query("select private.form_signature_digest($1,$2,$3::jsonb) value", [contentDigest, ids.owner, strokes])).rows[0].value;
    await client.query(
      "insert into private.member_form_signatures(form_id,signer_kind,signer_user_id,strokes,content_digest,signature_digest,consented_at) values($1,'filer',$2,$3::jsonb,$4,$5,now())",
      [ids.form, ids.owner, strokes, contentDigest, signatureDigest]);
    await client.query(`update public.member_forms f set
        status='approved', review_note=null, reviewed_by=$2, reviewed_at=t.at,
        content_digest=$3, filer_signature_digest=$4, filer_signed_at=t.at,
        artifact_digest=private.form_artifact_digest($1,$3,$4,null,$2,t.at),
        artifact_approved_at=t.at, artifact_approved_by=$2
      from (select now() as at) t where f.id=$1`,
      [ids.form, ids.reviewer, contentDigest, signatureDigest]);
    await role("service_role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
    expect((await client.query("select public.get_form_filing_payload($1,$2) value", [ids.form, ids.owner])).rows[0].value.attachments).toHaveLength(1);
    expect(await denied("select public.get_form_filing_payload($1,$2)", [ids.form, randomUUID()], "22023"))
      .toContain("filing unavailable");
    await role("postgres");
    await lapse();
    await role("service_role");
    // A filing copy is an integrity attestation. It is not rendered from an
    // attachment the ledger no longer vouches for, and it does not silently
    // drop it either.
    expect(await denied("select public.get_form_filing_payload($1,$2)", [ids.form, ids.owner], "22023"))
      .toContain("filing integrity check failed");
    await role("postgres");
    await client.query("rollback to savepoint form_workflow");
    await client.query("release savepoint form_workflow");

    // 3. Losing feature authorization closes the workflow even though the
    //    ledger row is still 'clean'. A verdict is not a permission.
    await role("postgres");
    expect((await client.query("select status from private.private_upload_scans where object_id=$1", [byKind.task.objectId])).rows[0].status).toBe("clean");
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.owner, ids.spareChapter]);
    await role("authenticated", ids.owner, ids.ownerSession);
    // Moving the task out of the actor's chapter revokes the staff scope the
    // confirmation depends on, clean ledger row or not.
    await denied("select public.confirm_chapter_task_file_upload($1)", [byKind.task.id]);
    await role("postgres");
    await client.query("delete from public.organization_role_grants where organization_id=$1 and user_id=$2", [ids.org, ids.owner]);
    await role("authenticated", ids.owner, ids.ownerSession);
    await denied("select public.confirm_chapter_task_file_upload($1)", [byKind.task.id]);
    await denied("select public.review_steward_library_file($1,'approved')", [byKind.knowledge.id]);
    await denied("select public.publish_steward_file_to_catalog($1,'general',$2)", [byKind.knowledge.id, randomUUID()]);
    await denied("select public.download_steward_library_file($1)", [byKind.knowledge.id]);
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 120000);

databaseIt("fails closed on a scanner outage and on a lease that expires with no verdict", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("outage");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);

    // A recorded engine failure grants nothing.
    await role("authenticated", ids.owner, ids.ownerSession);
    const attempt = (await client.query(authorize, ["task", byKind.task.id])).rows[0].value;
    await role("service_role");
    expect((await client.query(finish, [attempt.attemptId, "failed", null])).rows[0].value.status).toBe("failed");
    await role("postgres");
    expect((await client.query("select status, clean_until from private.private_upload_scans where object_id=$1", [byKind.task.objectId])).rows[0])
      .toMatchObject({ status: "failed", clean_until: null });
    await role("authenticated", ids.owner, ids.ownerSession);
    await denied("select public.confirm_chapter_task_file_upload($1)", [byKind.task.id]);

    // A lease that expires without any completion leaves the ledger pending
    // and every gate closed — an interrupted inspection is not a verdict.
    const stalled = (await client.query(authorize, ["case", byKind.case.id])).rows[0].value;
    expect(stalled.attemptId).toBeTruthy();
    await role("postgres");
    await client.query("update private.private_upload_inspection_attempts set expires_at=now()-interval '1 second' where id=$1", [stalled.attemptId]);
    expect((await client.query("select status from private.private_upload_scans where object_id=$1", [byKind.case.objectId])).rows[0].status).toBe("pending");
    await role("service_role");
    await denied(finish, [stalled.attemptId, "clean", digest], "22023");
    await role("authenticated", ids.owner, ids.ownerSession);
    await denied("select public.confirm_member_case_file_upload($1)", [byKind.case.id]);
    await denied("select public.complete_steward_library_upload($1,$2)", [byKind.knowledge.id, randomUUID()]);

    // A structural refusal carries no scanner provenance at all and must still
    // be recordable as 'blocked'; a PARTIAL provenance claim must not be.
    const structural = (await client.query(authorize, ["form", byKind.form.id])).rows[0].value;
    await role("service_role");
    await denied(
      "select public.finish_private_upload_inspection($1,'blocked',$2,null,null,null,null)",
      [structural.attemptId, digest], "22023",
    );
    expect((await client.query(
      "select public.finish_private_upload_inspection($1,'blocked',null,null,null,null,null) value",
      [structural.attemptId],
    )).rows[0].value).toEqual({ status: "blocked", cleanUntil: null });
    await role("authenticated", ids.owner, ids.ownerSession);
    await denied("select public.confirm_member_form_file($1)", [byKind.form.id]);
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 120000);

databaseIt("issues a fresh attempt on retry, retires the superseded one, and never charges quota for a current re-check", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("retry");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    const file = byKind.task;

    await role("authenticated", ids.owner, ids.ownerSession);
    const first = (await client.query(authorize, [file.kind, file.id])).rows[0].value;
    await role("service_role");
    expect((await client.query(finish, [first.attemptId, "failed", null])).rows[0].value.status).toBe("failed");

    await role("authenticated", ids.owner, ids.ownerSession);
    await denied("select public.confirm_chapter_task_file_upload($1)", [file.id]);
    const second = (await client.query(authorize, [file.kind, file.id])).rows[0].value;
    expect(second.attemptId).toBeTruthy();
    expect(second.attemptId).not.toBe(first.attemptId);
    await role("service_role");
    await denied(finish, [first.attemptId, "clean", digest], "22023");
    expect((await client.query(finish, [second.attemptId, "clean", digest])).rows[0].value.status).toBe("clean");

    // Exactly the previously denied gate opens, and nothing else moved.
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await client.query("select public.confirm_chapter_task_file_upload($1) value", [file.id])).rows[0].value.confirmedAt).toBeTruthy();
    await denied("select public.confirm_member_case_file_upload($1)", [byKind.case.id]);

    // Quota is charged once per authorization that actually leases an
    // inspection: two here, and never for the current:true short circuit.
    await role("postgres");
    expect((await client.query("select hour_count, day_count from private.private_upload_inspection_limits where user_id=$1", [ids.owner])).rows[0])
      .toMatchObject({ hour_count: 2, day_count: 2 });
    await role("authenticated", ids.owner, ids.ownerSession);
    for (let recheck = 0; recheck < 3; recheck += 1) {
      expect((await client.query(authorize, [file.kind, file.id])).rows[0].value).toEqual({ fileId: file.id, current: true });
    }
    await role("postgres");
    expect((await client.query("select hour_count, day_count from private.private_upload_inspection_limits where user_id=$1", [ids.owner])).rows[0])
      .toMatchObject({ hour_count: 2, day_count: 2 });
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 120000);

databaseIt("serializes a concurrent confirmation against a verdict change and commits only the safe outcome", async () => {
  // The only proof in this file that commits: two sessions must see one row set.
  // Everything created here is removed in the finally block, and the target is
  // an owned disposable stack that CI destroys after the run regardless.
  const client = connect();
  const rival = connect();
  await client.connect();
  await rival.connect();
  const ids = makeIds("race");
  const { role } = harness(client, ids);
  let seeded = null;
  let before = null;
  try {
    before = await census(client);
    await client.query("begin");
    seeded = await seed(client, ids, role);
    const file = seeded.byKind.task;
    await inspectClean(client, role, ids, file);
    await role("postgres");
    await client.query("commit");

    // Session B takes the Storage row lock first, then quarantines the object.
    await rival.query("begin");
    await rival.query("select * from storage.objects where id=$1 for update", [file.objectId]);

    // Session A now blocks inside confirm_chapter_task_file_upload on exactly
    // that row, so the verdict it reads cannot predate B's write.
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: ids.owner, session_id: ids.ownerSession, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    const contended = client.query("select public.confirm_chapter_task_file_upload($1) value", [file.id]);
    let settled = false;
    contended.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 750); });
    expect(settled, "confirm must block on the locked storage row").toBe(false);

    // The ledger row is quarantined inside the same lock B already holds. The
    // write is issued directly rather than through
    // finish_private_upload_inspection because the interleaving under test is
    // the GATE's, not the writer's; the writer's own ACL, provenance and
    // supersession rules are proved by the other cases in this file.
    expect((await rival.query(
      "update private.private_upload_scans set status='blocked', clean_until=null where object_id=$1 returning status",
      [file.objectId],
    )).rows[0].status).toBe("blocked");
    await rival.query("commit");

    let raced;
    try { await contended; } catch (error) { raced = error; }
    expect(raced, "the confirmation must not commit against a blocked verdict").toBeTruthy();
    expect(raced.code).toBe("42501");
    await client.query("rollback");

    await client.query("select set_config('request.jwt.claims',null,true)");
    expect((await client.query("select confirmed_at from public.chapter_task_files where id=$1", [file.id])).rows[0].confirmed_at).toBeNull();
    expect((await client.query("select pg_catalog.count(*)::integer c from public.chapter_task_activity where task_id=$1 and action='file_added'", [ids.task])).rows[0].c).toBe(0);

    // Control: the same call succeeds once the verdict is current again, so the
    // refusal above was caused by the verdict change and not by the lock.
    await client.query("update private.private_upload_scans set status='clean', clean_until=now()+interval '1 hour' where object_id=$1", [file.objectId]);
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: ids.owner, session_id: ids.ownerSession, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    expect((await client.query("select public.confirm_chapter_task_file_upload($1) value", [file.id])).rows[0].value.confirmedAt).toBeTruthy();
    await client.query("rollback");
    await client.query("select set_config('request.jwt.claims',null,true)");

    // The concurrent inspection caller is told the object is busy rather than
    // being handed a second lease on the same object.
    await client.query("update private.private_upload_scans set status='pending', clean_until=null where object_id=$1", [file.objectId]);
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: ids.owner, session_id: ids.ownerSession, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    const held = (await client.query(authorize, [file.kind, file.id])).rows[0].value;
    expect(held.attemptId).toBeTruthy();
    await rival.query("begin");
    await rival.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: ids.owner, session_id: ids.ownerSession, aal: "aal2" }),
    ]);
    await rival.query("set local role authenticated");
    await client.query("commit");
    expect((await rival.query(authorize, [file.kind, file.id])).rows[0].value).toEqual({ busy: true });
    await rival.query("reset role");
    await rival.query("rollback");
  } finally {
    try { await client.query("rollback"); } catch { /* already closed */ }
    try { await rival.query("rollback"); } catch { /* already closed */ }
    if (seeded) await teardownCommittedFixture(client, ids, seeded, before);
    await client.end();
    await rival.end();
  }
}, 120000);

databaseIt("binds a clean verdict to one object version and expires it on supersession, staleness or deletion", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("supersede");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    const file = byKind.case;
    const current = async () => {
      await role("authenticated", ids.owner, ids.ownerSession);
      return (await client.query("select private.private_upload_is_current($1,$2) value", [file.bucket, file.path])).rows[0].value;
    };
    await inspectClean(client, role, ids, file);
    expect(await current()).toBe(true);

    // (a) The stored object is immutable: a version change is refused outright.
    await role("postgres");
    await denied("update storage.objects set version='gate-version-2' where id=$1", [file.objectId], "42501");

    // (b) An expired clean_until stops being current.
    await client.query("savepoint expired_clean_until");
    await client.query("update private.private_upload_scans set scanned_at=now()-interval '25 hours', clean_until=now()-interval '1 second' where object_id=$1", [file.objectId]);
    expect(await current()).toBe(false);
    await role("authenticated", ids.owner, ids.ownerSession);
    await denied("select public.confirm_member_case_file_upload($1)", [file.id]);
    await role("postgres");
    await client.query("rollback to savepoint expired_clean_until");
    await client.query("release savepoint expired_clean_until");

    // (c) Signatures older than 48 hours expire every verdict signed with them.
    await client.query("savepoint stale_signatures");
    await client.query("update private.private_upload_scans set signature_updated_at=now()-interval '49 hours' where object_id=$1", [file.objectId]);
    expect(await current()).toBe(false);
    await role("postgres");
    await client.query("rollback to savepoint stale_signatures");
    await client.query("release savepoint stale_signatures");

    // (d) A newer scan cannot be undercut by an older one, and the digest is
    //     pinned to the object for as long as the object exists.
    await role("postgres");
    await client.query("update private.private_upload_scans set scanned_at=now()-interval '25 hours', clean_until=now()-interval '1 second' where object_id=$1", [file.objectId]);
    await role("authenticated", ids.owner, ids.ownerSession);
    const retry = (await client.query(authorize, [file.kind, file.id])).rows[0].value;
    await role("service_role");
    await denied(
      "select public.finish_private_upload_inspection($1,'clean',$2,'ClamAV 1.5.4',28113,now(),clock_timestamp())",
      [retry.attemptId, "c".repeat(64)], "22023",
    );
    await denied(
      "select public.finish_private_upload_inspection($1,'clean',$2,'ClamAV 1.5.4',1,now(),clock_timestamp())",
      [retry.attemptId, digest], "22023",
    );
    expect((await client.query(finish, [retry.attemptId, "clean", digest])).rows[0].value.status).toBe("clean");
    expect(await current()).toBe(true);

    // (e) Deleting the object tombstones the ledger row and closes every gate.
    await role("postgres");
    await client.query("select set_config('storage.allow_delete_query','true',true)");
    await client.query("delete from storage.objects where id=$1", [file.objectId]);
    expect((await client.query("select status, clean_until from private.private_upload_scans where object_id=$1", [file.objectId])).rows[0])
      .toMatchObject({ status: "deleted", clean_until: null });
    expect(await current()).toBe(false);
    await role("authenticated", ids.owner, ids.ownerSession);
    await denied("select public.confirm_member_case_file_upload($1)", [file.id], "22023");
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 120000);

// Drives one knowledge file all the way to a published catalog entry and hands
// the caller its ledger row id. Shared by the three repair proofs below.
async function publishKnowledge(client, role, ids, byKind) {
  await inspectClean(client, role, ids, byKind.knowledge);
  await role("authenticated", ids.owner, ids.ownerSession);
  await client.query("select public.complete_steward_library_upload($1,$2)", [byKind.knowledge.id, randomUUID()]);
  await client.query("select public.review_steward_library_file($1,'approved')", [byKind.knowledge.id]);
  await client.query("select public.publish_steward_file_to_catalog($1,'general',$2)", [byKind.knowledge.id, randomUUID()]);
}

databaseIt("lists a published catalog file through the paginated reader only while its verdict is current", async () => {
  // The paginated reader is the one the web client actually calls
  // (src/features/knowledge/knowledgeApi.js). The unpaged list_resource_catalog
  // twin and get_resource_catalog_item were retired in
  // 20260917051000_retire_dormant_catalog_handoff_reads; download_resource_catalog_item
  // is the item-level gate a member actually hits. The page was the last live
  // reader of organization_knowledge_files.scan_status, which
  // complete_steward_library_upload now pins at 'pending' forever — so it listed
  // nothing new and kept listing SAMPLE's fabricated 'clean' rows with no ledger
  // consultation at all. Listing and download must both consult the ledger.
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("catalog");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    await publishKnowledge(client, role, ids, byKind);

    const ledgerIds = async () => {
      await role("authenticated", ids.owner, ids.ownerSession);
      const page = (await client.query("select public.list_resource_catalog_page(null,null,null,null) value")).rows[0].value;
      return page.map((row) => row.id);
    };
    expect(await ledgerIds()).toContain(byKind.knowledge.id);
    expect((await client.query("select public.download_resource_catalog_item($1) value", [byKind.knowledge.id])).rows[0].value.href)
      .toContain("knowledge:");

    const setStatus = async (patch) => {
      await role("postgres");
      await client.query(`update private.private_upload_scans set ${patch} where object_id=$1`, [byKind.knowledge.objectId]);
    };
    // (a) An expired clean_until removes it from the page and the download.
    await setStatus("scanned_at=now()-interval '25 hours', clean_until=now()-interval '1 second'");
    expect(await ledgerIds()).not.toContain(byKind.knowledge.id);
    await denied("select public.download_resource_catalog_item($1)", [byKind.knowledge.id], "P0002");

    // (b) A blocked verdict removes it from the page.
    await setStatus("status='blocked', clean_until=null");
    expect(await ledgerIds()).not.toContain(byKind.knowledge.id);
    await denied("select public.download_resource_catalog_item($1)", [byKind.knowledge.id], "P0002");

    // (c) A restored current verdict returns it to the page and the download.
    //     The row's own scan_status never moved off 'pending' through any of this.
    await setStatus("status='clean', scanned_at=now(), signature_updated_at=now(), clean_until=now()+interval '1 hour'");
    expect(await ledgerIds()).toContain(byKind.knowledge.id);
    expect((await client.query("select public.download_resource_catalog_item($1) value", [byKind.knowledge.id])).rows[0].value.href)
      .toContain("knowledge:");
    await role("postgres");
    expect((await client.query("select scan_status from public.organization_knowledge_files where id=$1", [byKind.knowledge.id])).rows[0].scan_status)
      .toBe("pending");
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 120000);

databaseIt("drops the four unused catalog and member-handoff readers", async () => {
  const client = connect();
  await client.connect();
  try {
    const { rows } = await client.query(`
      select pg_catalog.to_regprocedure('public.list_resource_catalog(text, text)') is null as catalog_list,
             pg_catalog.to_regprocedure('public.get_resource_catalog_item(uuid)') is null as catalog_item,
             pg_catalog.to_regprocedure('public.get_steward_library_file(uuid)') is null as library_file,
             pg_catalog.to_regprocedure('public.get_member_steward_relationship(uuid)') is null as relationship,
             pg_catalog.to_regprocedure('public.list_resource_catalog_page(text, text, timestamptz, uuid)') is not null as catalog_page,
             pg_catalog.to_regprocedure('public.download_resource_catalog_item(uuid)') is not null as catalog_download,
             pg_catalog.to_regprocedure('public.list_steward_library_files_page(text, text, text, timestamptz, uuid)') is not null as library_page,
             pg_catalog.to_regprocedure('public.download_steward_library_file(uuid)') is not null as library_download,
             pg_catalog.to_regprocedure('public.list_member_handoffs_v2(text, text, timestamptz, uuid, integer)') is not null as handoffs
    `);
    expect(rows[0]).toEqual({
      catalog_list: true,
      catalog_item: true,
      library_file: true,
      relationship: true,
      catalog_page: true,
      catalog_download: true,
      library_page: true,
      library_download: true,
      handoffs: true,
    });
  } finally {
    await client.end();
  }
}, 120000);

databaseIt("lets a plain member renew a lapsed catalog verdict while the bytes stay quarantined", async () => {
  // private.can_read_organization_knowledge_object is the knowledge-kind ACL
  // inside authorize_private_upload_inspection. A verdict conjunct on its member
  // branch is circular: clean_until lapses within 24 h by design, and the member
  // would then be refused the very inspection that renews it, needing a steward
  // daily. Removing the conjunct opens no read — the restrictive
  // private_upload_quarantine_read policy evaluates private_upload_is_current on
  // every authenticated download, which is what this proof asserts directly.
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("renew");
  const { role, denied } = harness(client, ids);
  const member = randomUUID();
  const memberSession = randomUUID();
  try {
    const { byKind } = await seed(client, ids, role);
    await publishKnowledge(client, role, ids, byKind);

    // A plain organization member: active membership and chapter, no role grant.
    await role("postgres");
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [member, `${member}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [memberSession, member]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic member factor','totp','verified',now(),now())", [randomUUID(), member]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, member]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [member, ids.chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [member, ids.chapter]);
    expect((await client.query("select count(*)::integer c from public.organization_role_grants where user_id=$1", [member])).rows[0].c).toBe(0);

    await client.query(
      "update private.private_upload_scans set scanned_at=now()-interval '25 hours', clean_until=now()-interval '1 second' where object_id=$1",
      [byKind.knowledge.objectId]);

    await role("authenticated", member, memberSession);
    // The helper still answers true for the member: it governs who may ASK.
    expect((await client.query("select private.can_read_organization_knowledge_object('organization-knowledge',$1) value", [byKind.knowledge.path])).rows[0].value)
      .toBe(true);
    // The read boundary itself is closed, independently, by the ledger.
    expect((await client.query("select private.private_upload_is_current('organization-knowledge',$1) value", [byKind.knowledge.path])).rows[0].value)
      .toBe(false);
    // ...and the metadata and download readers refuse it too, so nothing leaks meanwhile.
    expect((await client.query("select public.list_resource_catalog_page(null,null,null,null) value")).rows[0].value
      .map((row) => row.id)).not.toContain(byKind.knowledge.id);
    await denied("select public.download_resource_catalog_item($1)", [byKind.knowledge.id], "P0002");

    // The member can obtain the inspection that renews the verdict, alone.
    const renewal = (await client.query(authorize, ["knowledge", byKind.knowledge.id])).rows[0].value;
    expect(renewal.attemptId, `member authorize returned ${JSON.stringify(renewal)}`).toBeTruthy();
    expect(renewal.bucketId).toBe("organization-knowledge");
    await role("service_role");
    expect((await client.query(finish, [renewal.attemptId, "clean", digest])).rows[0].value.status).toBe("clean");
    await role("authenticated", member, memberSession);
    expect((await client.query("select private.private_upload_is_current('organization-knowledge',$1) value", [byKind.knowledge.path])).rows[0].value)
      .toBe(true);
    expect((await client.query("select public.list_resource_catalog_page(null,null,null,null) value")).rows[0].value
      .map((row) => row.id)).toContain(byKind.knowledge.id);
    expect((await client.query("select public.download_resource_catalog_item($1) value", [byKind.knowledge.id])).rows[0].value.href)
      .toContain("knowledge:");

    // A non-member of this organization is still refused outright.
    await role("authenticated", ids.owner, ids.ownerSession);
    await role("postgres");
    await client.query("delete from public.organization_memberships where organization_id=$1 and user_id=$2", [ids.org, member]);
    await client.query("delete from public.member_chapter_memberships where user_id=$1", [member]);
    await role("authenticated", member, memberSession);
    expect((await client.query("select private.can_read_organization_knowledge_object('organization-knowledge',$1) value", [byKind.knowledge.path])).rows[0].value)
      .toBe(false);
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 120000);

databaseIt("bounds the uploader's own knowledge cleanup window by ingest state rather than the retired scan_status", async () => {
  // Retiring scan_status as a verdict left `scan_status = 'pending'` permanently
  // true in cancel_steward_library_upload and can_delete_organization_knowledge_object,
  // which silently widened both windows to "until a steward reviews it". The
  // decision recorded in 20260906021000 is to keep the pre-retirement lifecycle
  // exactly, expressed as index_status: open before ingest, closed on both
  // ingest outcomes. Deleting quarantined bytes before ingest stays possible.
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("window");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    await inspectClean(client, role, ids, byKind.knowledge);
    await role("authenticated", ids.owner, ids.ownerSession);
    const completed = (await client.query("select public.complete_steward_library_upload($1,$2) value", [byKind.knowledge.id, randomUUID()])).rows[0].value;
    const sourceId = completed.sourceId;
    expect(sourceId).toBeTruthy();

    const lifecycle = async () => {
      await role("postgres");
      const row = (await client.query("select scan_status, index_status, review_status from public.organization_knowledge_files where id=$1", [byKind.knowledge.id])).rows[0];
      await role("authenticated", ids.owner, ids.ownerSession);
      const deletable = (await client.query("select private.can_delete_organization_knowledge_object('organization-knowledge',$1) value", [byKind.knowledge.path])).rows[0].value;
      return { ...row, deletable };
    };

    // Before ingest: scan_status is the retired 'pending' marker, index_status
    // is what actually bounds the window, and the window is open.
    expect(await lifecycle()).toEqual({
      scan_status: "pending", index_status: "pending", review_status: "pending_scan", deletable: true,
    });
    await client.query("savepoint cancel_before_ingest");
    expect((await client.query("select public.cancel_steward_library_upload($1,$2) value", [byKind.knowledge.id, byKind.knowledge.storageHandle])).rows[0].value.cancelled)
      .toBe(true);
    await client.query("rollback to savepoint cancel_before_ingest");
    await client.query("release savepoint cancel_before_ingest");

    // After a successful ingest the window closes, exactly as the scan_status
    // write used to close it — even though scan_status never moves again.
    await role("service_role");
    await client.query("select public.replace_knowledge_source_chunks($1,$2,$3,$4::jsonb,null)", [ids.org, sourceId, ids.owner, JSON.stringify(["Synthetic gate chunk."])]);
    expect(await lifecycle()).toEqual({
      scan_status: "pending", index_status: "chunked", review_status: "pending_scan", deletable: false,
    });
    await role("authenticated", ids.owner, ids.ownerSession);
    await denied("select public.cancel_steward_library_upload($1,$2)", [byKind.knowledge.id, byKind.knowledge.storageHandle], "P0002");

    // A failed ingest closes it too: the file is ingested-and-broken, not
    // pre-ingest, and its cleanup belongs to review rather than the uploader.
    await role("service_role");
    await client.query("select public.replace_knowledge_source_chunks($1,$2,$3,'[]'::jsonb,'knowledge-extraction-failed')", [ids.org, sourceId, ids.owner]);
    expect(await lifecycle()).toEqual({
      scan_status: "pending", index_status: "failed", review_status: "pending_scan", deletable: false,
    });
    await role("authenticated", ids.owner, ids.ownerSession);
    await denied("select public.cancel_steward_library_upload($1,$2)", [byKind.knowledge.id, byKind.knowledge.storageHandle], "P0002");
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 120000);

databaseIt("refuses the legacy one-step registrations for bytes nothing has inspected, and keeps their grants and error shapes", async () => {
  // Design decision A2 keeps public.register_member_case_file and
  // public.register_chapter_task_file only for rolling-deploy compatibility and
  // says they are "gated in slice 4 too". 20260906020000 gated the three
  // confirm_* RPCs and missed these two, which mint an ALREADY-CONFIRMED row:
  // there is no later confirmation for a gate to sit in, so the gate has to be
  // inside the registration, over the row it just inserted. Nothing can hold a
  // verdict at that moment — the RPC mints the object path itself — so the
  // honest description of 20260906023000 is that a stale client now fails
  // closed with the same typed refusal the inspected path raises, instead of
  // publishing a confirmed, never-inspected attachment that `authenticated`
  // reads through its direct SELECT grant. Byte access was never the exposure
  // (private_upload_quarantine_read denies the download independently); the
  // durable, coordinator-visible metadata row was.
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("legacy");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    await role("authenticated", ids.owner, ids.ownerSession);

    // The grants are deliberately untouched: this is a runtime verdict gate,
    // not a revoke. A revoked EXECUTE would refuse with a different error and
    // would also refuse the service-role callers the contract still records.
    expect((await client.query(
      "select has_function_privilege('authenticated',$1,'execute') a,"
      + " has_function_privilege('authenticated',$2,'execute') b",
      ["public.register_member_case_file(uuid,text,text,bigint)", "public.register_chapter_task_file(uuid,text,text,bigint)"],
    )).rows[0]).toEqual({ a: true, b: true });

    // An ungated registration of an uninspected object must be refused, with
    // the gate's exact shape: 42501 and 'file inspection required'.
    expect(await denied("select public.register_member_case_file($1,'legacy.txt','text/plain',9)", [ids.case]))
      .toContain("file inspection required");
    expect(await denied("select public.register_chapter_task_file($1,'legacy.txt','text/plain',9)", [ids.task]))
      .toContain("file inspection required");

    // Nothing survives the refusal: no attachment row, and no 'file_added'
    // activity row in the chapter-visible task timeline.
    await role("postgres");
    expect((await client.query("select pg_catalog.count(*)::integer c from public.member_case_files where case_id=$1 and filename='legacy.txt'", [ids.case])).rows[0].c).toBe(0);
    expect((await client.query("select pg_catalog.count(*)::integer c from public.chapter_task_files where task_id=$1 and filename='legacy.txt'", [ids.task])).rows[0].c).toBe(0);
    expect((await client.query("select pg_catalog.count(*)::integer c from public.chapter_task_activity where task_id=$1 and action='file_added'", [ids.task])).rows[0].c).toBe(0);

    // The refusal is the gate and nothing else: every earlier check still
    // raises its own message, so the error shapes callers branch on survive.
    await role("authenticated", ids.owner, ids.ownerSession);
    expect(await denied("select public.register_member_case_file($1,'legacy.txt','text/plain',9)", [randomUUID()], "22023"))
      .toContain("case unavailable");
    expect(await denied("select public.register_member_case_file($1,'','text/plain',9)", [ids.case], "22023"))
      .toContain("file name must be 1-160 characters");
    expect(await denied("select public.register_member_case_file($1,'legacy.txt','text/plain',0)", [ids.case], "22023"))
      .toContain("file must be between 1 byte and 10 MB");
    await role("authenticated", ids.owner, ids.ownerSession, "aal1");
    expect(await denied("select public.register_chapter_task_file($1,'legacy.txt','text/plain',9)", [ids.task]))
      .toContain("authentication required");

    // And the denial is specific, not a blanket one: the same actor, in the
    // same transaction, still completes the inspected two-phase path.
    await inspectClean(client, role, ids, byKind.case);
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await client.query("select public.confirm_member_case_file_upload($1) value", [byKind.case.id])).rows[0].value.confirmedAt)
      .toBeTruthy();
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 120000);

databaseIt("states one accepted-type policy at the RPC boundary and the bucket boundary", async () => {
  // Decision E2 dropped image/heic because the inspector permanently refuses
  // it, so an accepted HEIC upload could only ever become a quarantined object
  // that burns quota on every retry. 20260906010000 applied that at the bucket
  // boundary; five registration RPCs kept advertising image/heic in their own
  // per-call allowlist, so the RPC told the caller the type was fine, minted a
  // row and an object name, and Storage then refused the bytes with an
  // unrelated error — and on register_member_case_file it left a confirmed row
  // behind for an object that was never created. Both boundaries now state the
  // same policy.
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("mime");
  const { role, denied } = harness(client, ids);
  try {
    await seed(client, ids, role);
    await role("postgres");
    const buckets = (await client.query(
      "select id, allowed_mime_types from storage.buckets"
      + " where id in ('case-files','chapter-task-files','member-form-files','organization-knowledge') order by id",
    )).rows;
    expect(buckets.map((bucket) => bucket.id)).toEqual([
      "case-files", "chapter-task-files", "member-form-files", "organization-knowledge",
    ]);
    for (const bucket of buckets) {
      expect(bucket.allowed_mime_types, `${bucket.id} must refuse HEIC`).not.toContain("image/heic");
      expect(bucket.allowed_mime_types, `${bucket.id} keeps the supported types`).toContain("image/jpeg");
    }

    // Every registration RPC refuses the same type the buckets refuse, and it
    // refuses it as a TYPE refusal (22023) rather than falling through to the
    // verdict gate — so the caller is told the real reason.
    await role("authenticated", ids.owner, ids.ownerSession);
    for (const [statement, params] of [
      ["select public.begin_member_case_file_upload($1,$2,'photo.heic','image/heic',9)", [randomUUID(), ids.case]],
      ["select public.begin_chapter_task_file_upload($1,$2,'photo.heic','image/heic',9)", [randomUUID(), ids.task]],
      ["select public.register_member_form_file($1,'photo.heic','image/heic',9)", [ids.form]],
      ["select public.register_member_case_file($1,'photo.heic','image/heic',9)", [ids.case]],
      ["select public.register_chapter_task_file($1,'photo.heic','image/heic',9)", [ids.task]],
    ]) {
      expect(await denied(statement, params, "22023"), statement).toContain("file type is not accepted");
    }

    // A type both boundaries accept still passes the RPC boundary, so this is
    // an allowlist narrowing rather than a broken registration path.
    const acceptedId = randomUUID();
    expect((await client.query(
      "select public.begin_member_case_file_upload($1,$2,'photo.jpg','image/jpeg',9) value", [acceptedId, ids.case],
    )).rows[0].value.mimeType).toBe("image/jpeg");
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 120000);

// Drives one contract knowledge file through inspection, completion, CBA
// reconciliation and publication, and hands the caller everything the two
// lifecycle proofs below need to talk about it.
async function publishImportedClause(client, role, ids, byKind) {
  await inspectClean(client, role, ids, byKind.knowledge);
  await role("authenticated", ids.owner, ids.ownerSession);
  const completed = (await client.query(
    "select public.complete_steward_library_upload($1,$2) value", [byKind.knowledge.id, randomUUID()],
  )).rows[0].value;
  const sourceId = completed.sourceId;
  expect(sourceId).toBeTruthy();

  await role("service_role");
  const clause = [{
    clauseKey: "article:i",
    articleRef: "Article I",
    title: "Recognition",
    body: "Imported recognition language about a uniquely searchable narwhal provision.",
    keywords: ["narwhal"],
  }];
  expect((await client.query(
    "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
    [ids.org, sourceId, ids.owner, ids.chapter, JSON.stringify(clause)],
  )).rows[0].value.articleCount).toBe(1);

  await role("postgres");
  const article = (await client.query(
    "select id, status from public.member_kb_articles where knowledge_source_id=$1", [sourceId],
  )).rows[0];
  expect(article.status).toBe("draft");
  const revisionId = (await client.query(
    "select id from public.member_kb_article_revisions where article_id=$1 order by id desc limit 1", [article.id],
  )).rows[0].id;

  // Publication is a staff decision taken through the ordinary revision
  // workflow, which is exactly the operation the lifecycle must be able to
  // refuse once the originating file loses its verdict.
  await role("authenticated", ids.owner, ids.ownerSession);
  expect((await client.query(
    "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
    [article.id, revisionId, randomUUID(), ids.chapter],
  )).rows[0].value.status).toBe("published");

  // A collection placement, so the metadata surfaces have something real to
  // project and the placement writer has something real to refuse.
  await client.query(
    "select public.save_knowledge_collection(null,$1,'Workflow gate proof collection','staff','chapter',$2)",
    [`Gate ${ids.tag}`, ids.chapter],
  );
  await role("postgres");
  const collectionId = (await client.query(
    "select id from public.knowledge_collections where organization_id=$1 order by created_at desc limit 1", [ids.org],
  )).rows[0].id;
  await role("authenticated", ids.owner, ids.ownerSession);
  await client.query(
    "select public.set_knowledge_collection_item($1,'kb_article',$2,true,10,$3)",
    [collectionId, article.id, ids.chapter],
  );
  return { sourceId, articleId: article.id, revisionId, clause, collectionId };
}

databaseIt("keeps storage-derived knowledge indexable, reviewable, publishable and retrievable only while its source file's verdict is current", async () => {
  // The gap this closes. 20260906020000 exempted search_member_kb and the
  // review snapshot as "not Storage-backed", but 20260903030000 gave
  // member_kb_articles and member_kb_article_revisions a knowledge_source_id
  // pointing at an organization-knowledge object, so an imported CBA clause is
  // Storage-DERIVED text. Once the extractor had run nothing consulted the
  // ledger again, and a source that went stale, failed, blocked or deleted
  // stayed indexed, reviewable, publishable and retrievable.
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("lifecycle");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    const imported = await publishImportedClause(client, role, ids, byKind);

    // Every surface that can carry the derived clause to a caller, read in one
    // place. The member corpus and the direct RLS select are the two that a
    // first repair round gated only in their definer twins: this snapshot
    // returns the full `body` to an ordinary chapter member (p_published_only
    // needs no staff role), and `authenticated` holds a direct select grant on
    // public.member_kb_articles that both clients already use to read `body`
    // (src/lib/memberApi.js on web boot, apps/mobile/src/services/livedIn.ts).
    const retrieved = async () => {
      await role("authenticated", ids.owner, ids.ownerSession);
      const search = (await client.query("select source_id from public.search_member_kb('narwhal',6)")).rows
        .map((row) => row.source_id);
      const snapshot = (await client.query(
        "select public.list_knowledge_review_articles_snapshot($1) value", [ids.chapter],
      )).rows[0].value.map((row) => row.id);
      const memberCorpus = (await client.query(
        "select public.list_accessible_knowledge_articles_snapshot(true,null) value",
      )).rows[0].value.map((row) => row.id);
      const staffCorpus = (await client.query(
        "select public.list_accessible_knowledge_articles_snapshot(false,$1) value", [ids.chapter],
      )).rows[0].value.map((row) => row.id);
      const directRls = (await client.query(
        "select id from public.member_kb_articles where id=$1", [imported.articleId],
      )).rows.map((row) => row.id);
      const placed = (await client.query(
        "select public.list_knowledge_collections($1) value", [ids.chapter],
      )).rows[0].value.flatMap((collection) => collection.items)
        .filter((item) => item.kind === "kb_article").map((item) => item.itemId);
      return { search, snapshot, memberCorpus, staffCorpus, directRls, placed };
    };
    const setVerdict = async (patch) => {
      await role("postgres");
      await client.query(
        `update private.private_upload_scans set ${patch} where object_id=$1`, [byKind.knowledge.objectId],
      );
    };

    // A current verdict: the clause grounds Compass, appears in the staff
    // review snapshot, and its revision history is readable.
    const live = await retrieved();
    expect(live.search.some((id) => id.startsWith("kb:cba-"))).toBe(true);
    expect(live.snapshot).toContain(imported.articleId);
    expect(live.memberCorpus).toContain(imported.articleId);
    expect(live.staffCorpus).toContain(imported.articleId);
    expect(live.directRls).toContain(imported.articleId);
    expect(live.placed).toContain(imported.articleId);
    expect((await client.query(
      "select public.list_chapter_kb_revisions($1,$2) value", [imported.articleId, ids.chapter],
    )).rows[0].value.length).toBeGreaterThan(0);

    // The other publication route to the same row succeeds while the verdict
    // is current, so its refusal below is the ledger and not the role check.
    await client.query("savepoint lifecycle_save_control");
    expect((await client.query(
      `select (public.save_chapter_kb_article($1,'contract','Recognition','Article I',
         'Imported recognition language about a uniquely searchable narwhal provision.',
         array['narwhal']::text[],'published',true,$2)).status status`,
      [imported.articleId, ids.chapter],
    )).rows[0].status).toBe("published");
    await client.query("rollback to savepoint lifecycle_save_control");
    await client.query("release savepoint lifecycle_save_control");

    // clean -> stale, failed, blocked and deleted. Every one of them closes
    // retrieval, the review snapshot, the revision history, publication and
    // both service-role completion RPCs, and nothing else had to change.
    const lapses = [
      ["stale", "scanned_at=now()-interval '25 hours', clean_until=now()-interval '1 second'"],
      ["stale signatures", "signature_updated_at=now()-interval '49 hours'"],
      ["failed", "status='failed', clean_until=null"],
      ["blocked", "status='blocked', clean_until=null"],
    ];
    for (const [label, patch] of lapses) {
      await client.query(`savepoint lifecycle_${label.replace(/\W/g, "_")}`);
      await setVerdict(patch);
      const closed = await retrieved();
      expect(closed.search.some((id) => id.startsWith("kb:cba-")), `${label}: Compass must not retrieve it`).toBe(false);
      expect(closed.snapshot, `${label}: the review snapshot must not list it`).not.toContain(imported.articleId);
      expect(closed.memberCorpus, `${label}: the member corpus must not carry its body`).not.toContain(imported.articleId);
      expect(closed.staffCorpus, `${label}: the staff corpus must not carry its body`).not.toContain(imported.articleId);
      expect(closed.directRls, `${label}: the direct RLS select must return no row`).not.toContain(imported.articleId);
      expect(closed.placed, `${label}: the collection projection must not list it`).not.toContain(imported.articleId);
      await denied("select public.list_chapter_kb_revisions($1,$2)", [imported.articleId, ids.chapter], "P0002");
      expect(await denied(
        "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
        [imported.articleId, imported.revisionId, randomUUID(), ids.chapter],
      ), `${label}: publication must be refused`).toContain("file inspection required");
      expect(await denied(
        `select public.save_chapter_kb_article($1,'contract','Recognition','Article I','Republished body.',
           array['narwhal']::text[],'published',true,$2)`,
        [imported.articleId, ids.chapter],
      ), `${label}: the second publication route must refuse too`).toContain("file inspection required");
      await denied(
        "select public.set_knowledge_collection_item($1,'kb_article',$2,true,20,$3)",
        [imported.collectionId, imported.articleId, ids.chapter], "P0002",
      );
      // Removal stays reachable on purpose: a lapse must not strand a
      // placement row that staff can no longer see in the projection.
      await client.query(`savepoint lifecycle_remove_${label.replace(/\W/g, "_")}`);
      await client.query(
        "select public.set_knowledge_collection_item($1,'kb_article',$2,false,20,$3)",
        [imported.collectionId, imported.articleId, ids.chapter],
      );
      await client.query(`rollback to savepoint lifecycle_remove_${label.replace(/\W/g, "_")}`);
      await client.query(`release savepoint lifecycle_remove_${label.replace(/\W/g, "_")}`);
      await role("service_role");
      expect(await denied(
        "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb)",
        [ids.org, imported.sourceId, ids.owner, ids.chapter, JSON.stringify(imported.clause)],
      ), `${label}: CBA reconciliation must be refused`).toContain("file inspection required");
      await denied(
        "select public.replace_knowledge_source_chunks($1,$2,$3,$4::jsonb,null)",
        [ids.org, imported.sourceId, ids.owner, JSON.stringify(["Imported chunk."])],
      );
      // Retirement is removal-shaped, like the collection REMOVE path above, so
      // 20260906027000 keeps it reachable during a lapse rather than stranding a
      // published clause nobody can take off the shelf — but it hands back no
      // derived content on the way out. `returns member_kb_articles` used to
      // carry the whole row, body included, past every gate in this loop.
      await role("authenticated", ids.owner, ids.ownerSession);
      await client.query(`savepoint lifecycle_retire_${label.replace(/\W/g, "_")}`);
      const retiredDuringLapse = (await client.query(
        "select pg_catalog.to_jsonb(public.retire_chapter_kb_article($1,$2)) value",
        [imported.articleId, ids.chapter],
      )).rows[0].value;
      expect(retiredDuringLapse.id, `${label}: staff cleanup must stay reachable`).toBe(imported.articleId);
      expect(retiredDuringLapse.status, `${label}: the article must really be retired`).toBe("retired");
      for (const field of ["title", "article_ref", "body", "keywords"]) {
        expect(retiredDuringLapse[field], `${label}: retire must not return ${field}`).toBeNull();
      }
      // Suppression is about what crosses the boundary, not about destroying
      // evidence: the stored row keeps the text for a later re-inspection.
      await role("postgres");
      expect((await client.query(
        "select body from public.member_kb_articles where id=$1", [imported.articleId],
      )).rows[0].body, `${label}: the stored row must be untouched`).toBe(imported.clause[0].body);
      await client.query(`rollback to savepoint lifecycle_retire_${label.replace(/\W/g, "_")}`);
      await client.query(`release savepoint lifecycle_retire_${label.replace(/\W/g, "_")}`);
      await role("postgres");
      await client.query(`rollback to savepoint lifecycle_${label.replace(/\W/g, "_")}`);
      await client.query(`release savepoint lifecycle_${label.replace(/\W/g, "_")}`);
    }

    // The verdict is intact again after each rollback, so the refusals above
    // were the ledger and nothing else.
    const restored = await retrieved();
    expect(restored.search.some((id) => id.startsWith("kb:cba-"))).toBe(true);
    expect(restored.snapshot).toContain(imported.articleId);
    expect(restored.memberCorpus).toContain(imported.articleId);
    expect(restored.directRls).toContain(imported.articleId);
    expect(restored.placed).toContain(imported.articleId);

    // Deleting the object tombstones the ledger row, which is the one lapse
    // that cannot be undone: the derived text outlives bytes nobody can
    // re-inspect, and must stop being served the moment they are gone.
    await role("postgres");
    await client.query("select set_config('storage.allow_delete_query','true',true)");
    await client.query("delete from storage.objects where id=$1", [byKind.knowledge.objectId]);
    expect((await client.query(
      "select status from private.private_upload_scans where object_id=$1", [byKind.knowledge.objectId],
    )).rows[0].status).toBe("deleted");
    const gone = await retrieved();
    expect(gone.search.some((id) => id.startsWith("kb:cba-"))).toBe(false);
    expect(gone.snapshot).not.toContain(imported.articleId);
    expect(gone.memberCorpus).not.toContain(imported.articleId);
    expect(gone.staffCorpus).not.toContain(imported.articleId);
    expect(gone.directRls).not.toContain(imported.articleId);
    expect(gone.placed).not.toContain(imported.articleId);
    await denied("select public.list_chapter_kb_revisions($1,$2)", [imported.articleId, ids.chapter], "P0002");
    expect(await denied(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
      [imported.articleId, imported.revisionId, randomUUID(), ids.chapter],
    )).toContain("file inspection required");
    expect(await denied(
      `select public.save_chapter_kb_article($1,'contract','Recognition','Article I','Republished body.',
         array['narwhal']::text[],'published',true,$2)`,
      [imported.articleId, ids.chapter],
    )).toContain("file inspection required");
    await denied(
      "select public.set_knowledge_collection_item($1,'kb_article',$2,true,20,$3)",
      [imported.collectionId, imported.articleId, ids.chapter], "P0002",
    );

    // The one lapse that cannot be undone is exactly when staff most need the
    // clause off the shelf, so retirement still runs — and still returns
    // nothing that came out of the file. This is the residual an independent
    // round-2 verification found: `returns member_kb_articles` handed the whole
    // row, body included, to a staff caller in the very transaction in which
    // every surface above refused.
    const retiredAfterDelete = (await client.query(
      "select pg_catalog.to_jsonb(public.retire_chapter_kb_article($1,$2)) value",
      [imported.articleId, ids.chapter],
    )).rows[0].value;
    expect(retiredAfterDelete.id).toBe(imported.articleId);
    expect(retiredAfterDelete.status).toBe("retired");
    for (const field of ["title", "article_ref", "body", "keywords"]) {
      expect(retiredAfterDelete[field], `retire must not return ${field} for a deleted source`).toBeNull();
    }
    await role("postgres");
    const persisted = (await client.query(
      "select status, body from public.member_kb_articles where id=$1", [imported.articleId],
    )).rows[0];
    expect(persisted.status, "the retirement itself must have been written").toBe("retired");
    expect(persisted.body, "the stored text survives for a re-inspection").toBe(imported.clause[0].body);
    // The appended revision keeps the faithful snapshot. It is the history of
    // what was retired, and `authenticated` holds no grant on that table while
    // list_chapter_kb_revisions carries the provenance conjunct.
    expect((await client.query(
      "select body from public.member_kb_article_revisions where article_id=$1 order by id desc limit 1",
      [imported.articleId],
    )).rows[0].body).toBe(imported.clause[0].body);

    // Authored knowledge with no Storage provenance keeps its old semantics
    // exactly: the gate is about derived text, not about the corpus.
    await role("postgres");
    await client.query(
      `insert into public.member_kb_articles (
         slug, kind, title, article_ref, body, keywords, order_index, chapter_id,
         status, is_sample, version, created_by, updated_by, verified_by, verified_at,
         content_origin
       ) values ($1,'faq','Authored','Guide','Authored guidance about a narwhal provision.',
         array['narwhal'],700,$2,'published',false,1,$3,$3,$3,now(),
         'authored')`,
      [`authored-${ids.tag}-${ids.org}`, ids.chapter, ids.owner],
    );
    await role("authenticated", ids.owner, ids.ownerSession);
    const authoredSlug = `authored-${ids.tag}-${ids.org}`;
    expect((await client.query("select source_id from public.search_member_kb('narwhal',6)")).rows
      .some((row) => row.source_id === `kb:${authoredSlug}`)).toBe(true);
    // ...and every surface the derived clause just lost still serves it: the
    // member corpus, the direct RLS select and the collection placement writer
    // all answer for authored content in the very same transaction in which the
    // Storage-derived row is gone.
    const authoredId = (await client.query(
      "select id from public.member_kb_articles where slug=$1", [authoredSlug],
    )).rows[0].id;
    expect((await client.query(
      "select public.list_accessible_knowledge_articles_snapshot(true,null) value",
    )).rows[0].value.map((row) => row.id)).toContain(authoredId);
    expect((await client.query(
      "select id from public.member_kb_articles where id=$1", [authoredId],
    )).rows.map((row) => row.id)).toContain(authoredId);
    expect((await client.query(
      "select (public.save_chapter_kb_article($1,'faq','Authored','Guide','Authored guidance about a narwhal provision.',array['narwhal']::text[],'published',true,$2)).status status",
      [authoredId, ids.chapter],
    )).rows[0].status).toBe("published");
    await client.query(
      "select public.set_knowledge_collection_item($1,'kb_article',$2,true,30,$3)",
      [imported.collectionId, authoredId, ids.chapter],
    );
    // ...retirement included: an authored article has no provenance, so it
    // comes back whole, exactly as it did before 20260906027000.
    const retiredAuthored = (await client.query(
      "select pg_catalog.to_jsonb(public.retire_chapter_kb_article($1,$2)) value",
      [authoredId, ids.chapter],
    )).rows[0].value;
    expect(retiredAuthored.status).toBe("retired");
    expect(retiredAuthored.title).toBe("Authored");
    expect(retiredAuthored.article_ref).toBe("Guide");
    expect(retiredAuthored.body).toBe("Authored guidance about a narwhal provision.");
    expect(retiredAuthored.keywords).toEqual(["narwhal"]);
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 180000);

// A second inspected contract upload in the same chapter. A replacement
// agreement arrives as its own object with its own ledger row, which is what
// lets a clause lineage move from one source to another.
async function stageContractSource(client, role, ids, label, contentDigest) {
  await role("authenticated", ids.owner, ids.ownerSession);
  const prepared = (await client.query(
    "select public.prepare_steward_library_upload($1,9,$2,$3,'Replacement agreement','contract',$4,$5) value",
    [`${label}.txt`, contentDigest, `Replacement upload ${label}`, randomUUID(), ids.chapter],
  )).rows[0].value;
  const target = (await client.query(
    "select public.get_knowledge_file_storage_target($1,$2,'upload') value",
    [prepared.fileId, prepared.storageHandle],
  )).rows[0].value;
  await role("postgres");
  const objectId = (await client.query(
    "insert into storage.objects(bucket_id,name,owner,version,metadata) values($1,$2,$3,$4,$5::jsonb) returning id",
    [target.bucketId, target.objectName, ids.owner, `gate-version-${ids.tag}-${label}`, OBJECT_METADATA],
  )).rows[0].id;
  const file = {
    kind: "knowledge", id: prepared.fileId, bucket: target.bucketId,
    path: target.objectName, storageHandle: prepared.storageHandle, objectId,
  };
  await inspectClean(client, role, ids, file);
  await role("authenticated", ids.owner, ids.ownerSession);
  const sourceId = (await client.query(
    "select public.complete_steward_library_upload($1,$2) value", [file.id, randomUUID()],
  )).rows[0].value.sourceId;
  expect(sourceId).toBeTruthy();
  return { file, sourceId };
}

databaseIt("keeps a lapsed source's canonical history off every surface after the clause moves to a clean replacement source", async () => {
  // The round-2 escape. member_kb_article_revisions_import_candidate_complete
  // forced every POSITIVE-version revision to knowledge_source_id = NULL, and a
  // null source is read as "authored, nothing to check". So source A's
  // published text survived A going stale/blocked/deleted as long as the
  // article had since moved to a clean source B: the article-level check read
  // B, the per-revision check read NULL, and restoring A's revision
  // republished A's text while `coalesce` kept B's provenance on the row.
  //
  // 20260906028000 gives every revision an explicit content_origin and, for a
  // derived one, the exact source it came out of. This proof drives a real
  // A -> B -> A-lapses lineage on a live database.
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("provenance");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    const imported = await publishImportedClause(client, role, ids, byKind);

    // Everything source A has written so far — the import snapshot and the
    // publication snapshot — names A. Neither is "authored".
    await role("postgres");
    const fromA = (await client.query(
      `select id, version, content_origin, knowledge_source_id, body
         from public.member_kb_article_revisions
        where article_id = $1 and version > 0 order by version`,
      [imported.articleId],
    )).rows;
    expect(fromA.length).toBeGreaterThanOrEqual(2);
    for (const revision of fromA) {
      expect(revision.content_origin, `version ${revision.version} must be derived`).toBe("derived");
      expect(revision.knowledge_source_id, `version ${revision.version} must name source A`).toBe(imported.sourceId);
    }

    // A replacement agreement is uploaded and inspected on its own terms...
    const replacement = await stageContractSource(client, role, ids, "replacement", "c".repeat(64));
    await role("service_role");
    const replacementClause = [{
      clauseKey: "article:i", articleRef: "Article I", title: "Recognition",
      body: "Replacement recognition language about a uniquely searchable pangolin provision.",
      keywords: ["pangolin"],
    }];
    expect((await client.query(
      "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
      [ids.org, replacement.sourceId, ids.owner, ids.chapter, JSON.stringify(replacementClause)],
    )).rows[0].value.stagedPublishedCount).toBe(1);
    await role("postgres");
    const candidate = (await client.query(
      "select id, content_origin, knowledge_source_id from public.member_kb_article_revisions"
      + " where article_id = $1 and version = 0", [imported.articleId],
    )).rows[0];
    expect(candidate).toMatchObject({ content_origin: "derived", knowledge_source_id: replacement.sourceId });

    // ...and restoring its candidate moves the clause onto B. The restored
    // article takes the REVISION's own source, not a coalesce onto whatever it
    // was carrying.
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [imported.articleId, candidate.id, randomUUID(), ids.chapter],
    )).rows[0].value.knowledge_source_id).toBe(replacement.sourceId);
    await role("postgres");
    const fromB = (await client.query(
      `select id, version from public.member_kb_article_revisions
        where article_id = $1 and version > 0 and knowledge_source_id = $2 order by version`,
      [imported.articleId, replacement.sourceId],
    )).rows;
    expect(fromB).toHaveLength(1);

    // An authored article in the same chapter, written through the ordinary
    // staff path, so the refusals below are provenance and not chapter or role.
    await role("authenticated", ids.owner, ids.ownerSession);
    const authoredId = (await client.query(
      `select (public.save_chapter_kb_article(null,'faq','Authored guide','Guide',
         'Authored guidance about a pangolin provision.',array['pangolin']::text[],'draft',false,$1)).id id`,
      [ids.chapter],
    )).rows[0].id;
    await client.query(
      `select public.save_chapter_kb_article($1,'faq','Authored guide','Guide',
         'A second authored draft about a pangolin provision.',array['pangolin']::text[],'draft',false,$2)`,
      [authoredId, ids.chapter],
    );
    await role("postgres");
    const authoredRevisions = (await client.query(
      "select id, version, content_origin, knowledge_source_id from public.member_kb_article_revisions"
      + " where article_id = $1 order by version", [authoredId],
    )).rows;
    expect(authoredRevisions).toHaveLength(2);
    for (const revision of authoredRevisions) {
      expect(revision.content_origin).toBe("authored");
      expect(revision.knowledge_source_id).toBeNull();
    }

    // A historical row this schema cannot attribute: exactly the shape EVERY
    // positive-version revision had before 20260906028000 — Storage-derived
    // text with a null source, which the ledger predicate answers `true` for.
    // The backfill classifies rows like this 'unresolved', never 'authored'.
    await client.query(
      `insert into public.member_kb_article_revisions (
         article_id, chapter_id, version, status, kind, title, article_ref, body,
         keywords, changed_by, content_origin
       ) values ($1,$2,99,'published','contract','Recognition','Article I',
         'Unattributable recognition language about a uniquely searchable pangolin provision.',
         array['pangolin'],$3,'unresolved')`,
      [imported.articleId, ids.chapter, ids.owner],
    );
    const unresolvedId = (await client.query(
      "select id from public.member_kb_article_revisions where article_id = $1 and version = 99",
      [imported.articleId],
    )).rows[0].id;

    // And the two ways provenance could go missing again are refused by the
    // schema itself rather than by a reader that might be forgotten.
    await denied(
      `insert into public.member_kb_article_revisions (article_id, chapter_id, version, status,
         kind, title, article_ref, body, keywords, changed_by, content_origin)
       values ($1,$2,98,'draft','contract','Recognition','Article I','Body','{}',$3,'derived')`,
      [imported.articleId, ids.chapter, ids.owner], "23514",
    );
    await denied(
      `insert into public.member_kb_article_revisions (article_id, chapter_id, version, status,
         kind, title, article_ref, body, keywords, changed_by, content_origin, knowledge_source_id)
       values ($1,$2,97,'draft','contract','Recognition','Article I','Body','{}',$3,'authored',$4)`,
      [imported.articleId, ids.chapter, ids.owner, imported.sourceId], "23514",
    );

    const listed = async (articleId) => (await client.query(
      "select public.list_chapter_kb_revisions($1,$2) value", [articleId, ids.chapter],
    )).rows[0].value;

    // While both sources are current the reviewer sees the derived history and
    // its origin, and never the unattributable row.
    await role("authenticated", ids.owner, ids.ownerSession);
    let history = await listed(imported.articleId);
    expect(history.every((revision) => revision.contentOrigin === "derived")).toBe(true);
    expect(history.map((revision) => String(revision.id))).not.toContain(String(unresolvedId));
    expect(history.map((revision) => String(revision.id)))
      .toEqual(expect.arrayContaining(fromA.map((revision) => String(revision.id))));
    await denied(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
      [imported.articleId, unresolvedId, randomUUID(), ids.chapter], "P0002",
    );

    // Source A lapses. B is untouched, so the article itself stays readable.
    await role("postgres");
    await client.query(
      "update private.private_upload_scans set status='blocked', clean_until=null where object_id=$1",
      [byKind.knowledge.objectId],
    );
    await role("authenticated", ids.owner, ids.ownerSession);
    history = await listed(imported.articleId);
    expect(history.map((revision) => String(revision.id)))
      .toEqual(fromB.map((revision) => String(revision.id)));
    for (const stale of fromA) {
      expect(history.map((revision) => String(revision.id)), `version ${stale.version} came out of the lapsed source`)
        .not.toContain(String(stale.id));
      expect(await denied(
        "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
        [imported.articleId, stale.id, randomUUID(), ids.chapter],
      ), `version ${stale.version} must not be republishable`).toContain("file inspection required");
    }
    // The surviving history is still restorable, so the refusals above are
    // per-revision provenance and not a blanket denial of the article.
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [imported.articleId, fromB[0].id, randomUUID(), ids.chapter],
    )).rows[0].value.knowledge_source_id).toBe(replacement.sourceId);

    // Authored history on the same chapter is untouched by A's lapse: listed,
    // labelled, and restorable in the same transaction.
    const authoredHistory = await listed(authoredId);
    expect(authoredHistory).toHaveLength(2);
    expect(authoredHistory.every((revision) => revision.contentOrigin === "authored")).toBe(true);
    expect(authoredHistory.map((revision) => String(revision.id)))
      .toEqual(expect.arrayContaining(authoredRevisions.map((revision) => String(revision.id))));
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [authoredId, authoredRevisions[0].id, randomUUID(), ids.chapter],
    )).rows[0].value).toMatchObject({ status: "published", knowledge_source_id: null });
    // ...and its new canonical revision is authored too: nothing in this
    // transaction laundered provenance in either direction.
    await role("postgres");
    expect((await client.query(
      `select content_origin, knowledge_source_id from public.member_kb_article_revisions
        where article_id = $1 order by version desc limit 1`, [authoredId],
    )).rows[0]).toEqual({ content_origin: "authored", knowledge_source_id: null });
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 180000);

databaseIt("keeps an omitted-clause retirement candidate on the article's own source and refuses it once that source lapses", async () => {
  // The round-3 finding. replace_cba_knowledge_drafts stages a version-zero
  // retirement candidate for a published clause the REPLACEMENT agreement omits
  // by copying the ARTICLE's own title/article_ref/body/keywords — text derived
  // from source A — and 20260906028000 stamped that copy
  // knowledge_source_id = p_source_id, i.e. B. Confirming it then wrote A's text
  // onto the article under B's provenance and minted a canonical retirement
  // revision naming B, so once A lapsed while B stayed current the A-derived
  // history was still listable and still restorable.
  //
  // 20260906029000 splits content provenance from decision provenance: the
  // candidate keeps the article's own knowledge_source_id and records the
  // reconciling agreement in reconciled_by_source_id. This proof drives the
  // whole sequence — stage, list, dismiss, withhold, re-ingest, confirm, lapse —
  // on a live database.
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("retirement");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    const imported = await publishImportedClause(client, role, ids, byKind);
    const replacement = await stageContractSource(client, role, ids, "successor", "d".repeat(64));

    // The successor agreement reconciles the chapter WITHOUT the published
    // clause, which is the only way a retirement candidate is ever staged.
    await role("service_role");
    const successorClause = [{
      clauseKey: "article:ii", articleRef: "Article II", title: "Hours of work",
      body: "Successor hours language about a uniquely searchable pangolin provision.",
      keywords: ["pangolin"],
    }];
    expect((await client.query(
      "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
      [ids.org, replacement.sourceId, ids.owner, ids.chapter, JSON.stringify(successorClause)],
    )).rows[0].value).toMatchObject({ stagedRetirementCount: 1, stagedPublishedCount: 0 });

    await role("postgres");
    const successorArticleId = (await client.query(
      "select id from public.member_kb_articles where knowledge_source_id=$1 and chapter_id=$2",
      [replacement.sourceId, ids.chapter],
    )).rows[0].id;
    const candidate = (await client.query(
      `select revision.id, revision.status, revision.body, revision.content_origin,
              revision.knowledge_source_id, revision.reconciled_by_source_id,
              revision.import_candidate_key,
              pg_catalog.md5('retire:' || $2::text || ':' || article.import_key) expected_key
         from public.member_kb_article_revisions revision
         join public.member_kb_articles article on article.id = revision.article_id
        where revision.article_id = $1 and revision.version = 0`,
      [imported.articleId, replacement.sourceId],
    )).rows[0];
    // The candidate's bytes are the article's own published bytes, so its
    // CONTENT provenance is source A...
    expect(candidate.body).toBe(imported.clause[0].body);
    expect(candidate.status).toBe("retired");
    expect(candidate.content_origin).toBe("derived");
    expect(candidate.knowledge_source_id, "the retirement candidate must keep the article's own source")
      .toBe(imported.sourceId);
    // ...and B is recorded as the reconciliation that PROPOSED the removal, in
    // its own column, which is also what the candidate key already binds it to.
    expect(candidate.reconciled_by_source_id).toBe(replacement.sourceId);
    expect(candidate.import_candidate_key).toBe(candidate.expected_key);

    const listed = async (articleId) => (await client.query(
      "select public.list_chapter_kb_revisions($1,$2) value", [articleId, ids.chapter],
    )).rows[0].value;
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await listed(imported.articleId)).find((revision) => revision.importCandidate))
      .toMatchObject({
        status: "retired",
        contentOrigin: "derived",
        reconciledBySourceId: replacement.sourceId,
      });

    // The dismiss path leaves the canonical publication exactly as it was, on A.
    await client.query("savepoint retirement_dismissed");
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,false,$3,$4) value",
      [imported.articleId, candidate.id, randomUUID(), ids.chapter],
    )).rows[0].value).toMatchObject({ status: "published", knowledge_source_id: imported.sourceId });
    await role("postgres");
    expect((await client.query(
      "select pg_catalog.count(*)::integer c from public.member_kb_article_revisions"
      + " where article_id=$1 and version=0", [imported.articleId],
    )).rows[0].c).toBe(0);
    await client.query("rollback to savepoint retirement_dismissed");
    await client.query("release savepoint retirement_dismissed");

    // ...and dismissal is refused, like every other content-bearing answer,
    // once the article's own source lapses: it returns to_jsonb(article).
    await client.query("savepoint retirement_dismiss_lapsed");
    await role("postgres");
    await client.query(
      "update private.private_upload_scans set status='blocked', clean_until=null where object_id=$1",
      [byKind.knowledge.objectId],
    );
    await role("authenticated", ids.owner, ids.ownerSession);
    expect(await denied(
      "select public.restore_chapter_kb_revision($1,$2,false,$3,$4)",
      [imported.articleId, candidate.id, randomUUID(), ids.chapter],
    )).toContain("file inspection required");
    await client.query("rollback to savepoint retirement_dismiss_lapsed");
    await client.query("release savepoint retirement_dismiss_lapsed");

    // A candidate the backfill could not attribute is withheld from every
    // reader — and withholding never becomes a permanent block, because the
    // next reconciliation still overwrites the single version-zero slot.
    await client.query("savepoint retirement_unresolved");
    await role("postgres");
    await client.query(
      "update public.member_kb_article_revisions"
      + " set content_origin='unresolved', knowledge_source_id=null where id=$1", [candidate.id],
    );
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await listed(imported.articleId)).map((revision) => String(revision.id)))
      .not.toContain(String(candidate.id));
    await denied(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
      [imported.articleId, candidate.id, randomUUID(), ids.chapter], "P0002",
    );
    await role("service_role");
    await client.query(
      "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb)",
      [ids.org, replacement.sourceId, ids.owner, ids.chapter, JSON.stringify([{
        clauseKey: "article:i", articleRef: "Article I", title: "Recognition",
        body: "Successor recognition language about a uniquely searchable pangolin provision.",
        keywords: ["pangolin"],
      }])],
    );
    await role("postgres");
    expect((await client.query(
      `select content_origin, status, knowledge_source_id, reconciled_by_source_id
         from public.member_kb_article_revisions where article_id=$1 and version=0`,
      [imported.articleId],
    )).rows).toEqual([{
      content_origin: "derived",
      status: "draft",
      knowledge_source_id: replacement.sourceId,
      reconciled_by_source_id: replacement.sourceId,
    }]);
    await client.query("rollback to savepoint retirement_unresolved");
    await client.query("release savepoint retirement_unresolved");

    // Confirming the retirement keeps the article on A and writes the canonical
    // retirement revision derived from A. Before this repair the article moved
    // to B here, and that is what made the next four assertions impossible.
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [imported.articleId, candidate.id, randomUUID(), ids.chapter],
    )).rows[0].value).toMatchObject({ status: "retired", knowledge_source_id: imported.sourceId });
    await role("postgres");
    expect((await client.query(
      `select content_origin, knowledge_source_id, reconciled_by_source_id
         from public.member_kb_article_revisions where article_id=$1 order by version desc limit 1`,
      [imported.articleId],
    )).rows[0]).toEqual({
      content_origin: "derived",
      knowledge_source_id: imported.sourceId,
      reconciled_by_source_id: null,
    });
    expect((await client.query(
      "select pg_catalog.count(*)::integer c from public.member_kb_article_revisions"
      + " where article_id=$1 and version=0", [imported.articleId],
    )).rows[0].c).toBe(0);
    const aDerived = (await client.query(
      "select id, version from public.member_kb_article_revisions"
      + " where article_id=$1 and version>0 order by version", [imported.articleId],
    )).rows;
    expect(aDerived.length).toBeGreaterThanOrEqual(3);
    for (const revision of aDerived) {
      expect((await client.query(
        "select knowledge_source_id from public.member_kb_article_revisions where id=$1", [revision.id],
      )).rows[0].knowledge_source_id, `version ${revision.version} must name source A`)
        .toBe(imported.sourceId);
    }

    // Source A lapses. B remains current, and stays usable.
    await client.query(
      "update private.private_upload_scans set status='blocked', clean_until=null where object_id=$1",
      [byKind.knowledge.objectId],
    );
    await role("authenticated", ids.owner, ids.ownerSession);
    // The article itself is on A, so its whole A-derived history is off the
    // listing rather than partially visible...
    await denied(
      "select public.list_chapter_kb_revisions($1,$2)", [imported.articleId, ids.chapter], "P0002",
    );
    // ...and no row of it is republishable, including the retirement revision.
    for (const revision of aDerived) {
      expect(await denied(
        "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
        [imported.articleId, revision.id, randomUUID(), ids.chapter],
      ), `version ${revision.version} must not be republishable`).toContain("file inspection required");
    }
    // The refusals are per-source provenance, not a blanket denial: the
    // successor agreement's own clause is listed and restorable throughout.
    const successorHistory = await listed(successorArticleId);
    expect(successorHistory).toHaveLength(1);
    expect(successorHistory[0].contentOrigin).toBe("derived");
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [successorArticleId, successorHistory[0].id, randomUUID(), ids.chapter],
    )).rows[0].value.knowledge_source_id).toBe(replacement.sourceId);

    // Staff are not stuck behind the lapse: retire_chapter_kb_article stays
    // reachable for cleanup and hands back no derived text with the row.
    const cleaned = (await client.query(
      "select pg_catalog.to_jsonb(public.retire_chapter_kb_article($1,$2)) value",
      [imported.articleId, ids.chapter],
    )).rows[0].value;
    expect(cleaned.status).toBe("retired");
    expect(cleaned.body).toBeNull();
    expect(cleaned.title).toBeNull();
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 180000);

// The round-3 verifier's second finding. Nothing in the repository exercised
// 20260906029000's ONE-SHOT BACKFILL against non-empty history: CI's disposable
// stack, verify:db and verify:migrations all start from an empty database where
// every backfill statement matches zero rows, and the offline pins in
// tests/retirement-candidate-provenance-migration.test.js read the file as
// text. The migration therefore shipped green while writing ('unresolved',
// null) onto candidate rows BEFORE dropping the 20260906028000 check that
// forbids exactly that, which aborted the whole transaction on the first
// candidate it could not attribute — on the hosted databases, where no
// 202609060xxxxx migration has been applied and this file runs once against
// real history.
//
// This proof replays section 1 of the migration VERBATIM, on a table put back
// into its exact pre-029000 shape and carrying real 028000-era history, and
// asserts the outcomes the header promises. It is a live regression for both
// the statement order (a reordered file aborts here) and the classifier.
//
// ROUND 4 CHANGED WHAT THE CLASSIFIER MAY PROMISE. It used to call a
// retirement candidate attributable when no positive-version revision carried
// a later-or-equal changed_at; that is transaction-START time, not lock or
// commit order, so it could be inverted. Every legacy retirement candidate is
// now withheld outright, and this proof holds it to that: the article that
// never moved is withheld exactly like the two that did. The specific
// inverted-order counterexample gets its own proof below.
databaseIt("replays the 029000 backfill over real pre-migration history and withholds every legacy retirement candidate", async () => {
  // Both the replayed text and the pre-repair schema come from the migration
  // files rather than being restated here.
  expect(BACKFILL_SECTION).toContain("drop constraint member_kb_article_revisions_candidate_is_derived;");
  expect(stripComments(loadMigrationSql("20260906028000_knowledge_revision_provenance")).replace(/\s+/g, " "))
    .toContain(PRIOR_CANDIDATE_CHECK);
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("backfill");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);

    // Source A publishes four clauses through the ordinary import workflow.
    await inspectClean(client, role, ids, byKind.knowledge);
    await role("authenticated", ids.owner, ids.ownerSession);
    const sourceA = (await client.query(
      "select public.complete_steward_library_upload($1,$2) value", [byKind.knowledge.id, randomUUID()],
    )).rows[0].value.sourceId;
    expect(sourceA).toBeTruthy();
    const numerals = ["i", "ii", "iii", "iv"];
    await role("service_role");
    expect((await client.query(
      "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
      [ids.org, sourceA, ids.owner, ids.chapter, JSON.stringify(numerals.map((numeral) => ({
        clauseKey: `article:${numeral}`,
        articleRef: `Article ${numeral.toUpperCase()}`,
        title: `Imported clause ${numeral}`,
        body: `Imported clause ${numeral} language about a uniquely searchable narwhal provision.`,
        keywords: ["narwhal"],
      })))],
    )).rows[0].value.articleCount).toBe(4);
    await role("postgres");
    const articles = Object.fromEntries((await client.query(
      "select id, import_key, article_ref from public.member_kb_articles"
      + " where knowledge_source_id=$1 order by order_index", [sourceA],
    )).rows.map((article, index) => [numerals[index], article]));
    expect(Object.keys(articles)).toHaveLength(4);
    for (const numeral of numerals) {
      await role("postgres");
      const revisionId = (await client.query(
        "select id from public.member_kb_article_revisions where article_id=$1 and version>0"
        + " order by version desc limit 1", [articles[numeral].id],
      )).rows[0].id;
      await role("authenticated", ids.owner, ids.ownerSession);
      expect((await client.query(
        "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
        [articles[numeral].id, revisionId, randomUUID(), ids.chapter],
      )).rows[0].value.status).toBe("published");
    }

    // NOTHING IS AGED. The round-4 repair removed every timestamp from the
    // classifier, so this fixture no longer has to manufacture an ordering for
    // the backfill to read: one transaction's single now() on every row would
    // once have decided three of these four cases, and now decides none.
    await role("postgres");
    const articleIds = numerals.map((numeral) => articles[numeral].id);

    // Replacement agreement B keeps only clause iii, with changed text: three
    // retirement candidates and one changed-clause candidate.
    const replacement = await stageContractSource(client, role, ids, "backfill-successor", "e".repeat(64));
    await role("service_role");
    expect((await client.query(
      "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
      [ids.org, replacement.sourceId, ids.owner, ids.chapter, JSON.stringify([{
        clauseKey: "article:iii",
        articleRef: "Article III",
        title: "Imported clause iii",
        body: "Successor clause iii language about a uniquely searchable pangolin provision.",
        keywords: ["pangolin"],
      }])],
    )).rows[0].value).toMatchObject({ stagedRetirementCount: 3, stagedPublishedCount: 1 });

    // Two of the three articles are then moved, in the two ways the retired
    // predicate used to notice. The point of keeping them is the opposite of
    // what it was: all three retirement candidates must now land in exactly the
    // same withheld place, whether their article moved or not.
    await role("authenticated", ids.owner, ids.ownerSession);
    await client.query(
      "select public.save_chapter_kb_article($1,'contract',$2,$3,$4,$5::text[],'published',true,$6)",
      [articles.i.id, "Imported clause i", "Article I",
        "Staff-edited clause i language about a uniquely searchable narwhal provision.",
        ["narwhal"], ids.chapter],
    );
    await role("postgres");
    // ...and a bare status move, with no revision to say who moved it.
    await client.query("update public.member_kb_articles set status='draft' where id=$1", [articles.ii.id]);

    const candidates = {};
    for (const numeral of numerals) {
      candidates[numeral] = (await client.query(
        "select id, status, knowledge_source_id, reconciled_by_source_id, content_origin"
        + " from public.member_kb_article_revisions where article_id=$1 and version=0",
        [articles[numeral].id],
      )).rows[0];
    }
    expect(candidates.iii.status).toBe("draft");
    for (const numeral of ["i", "ii", "iv"]) expect(candidates[numeral].status).toBe("retired");
    const canonicalBefore = (await client.query(
      "select id, version, content_origin, knowledge_source_id from public.member_kb_article_revisions"
      + " where version > 0 and article_id = any($1::uuid[]) order by id", [articleIds],
    )).rows;
    expect(canonicalBefore.length).toBeGreaterThanOrEqual(9);

    // Put the table back into its exact pre-029000 shape and re-stamp the
    // retirement candidates the way 20260906028000 stamped them: with the
    // REPLACEMENT agreement's id in the content column. Dropping the column
    // takes the iff constraint and the index with it.
    await client.query("reset role");
    await client.query(
      "alter table public.member_kb_article_revisions"
      + " drop constraint member_kb_article_revisions_candidate_origin_known,"
      + " drop constraint member_kb_article_revisions_unresolved_names_no_source,"
      + " drop column reconciled_by_source_id",
    );
    await client.query(
      "update public.member_kb_article_revisions set knowledge_source_id=$1"
      + " where version = 0 and status = 'retired' and article_id = any($2::uuid[])",
      [replacement.sourceId, articleIds],
    );
    // NOT VALID only skips the initial table scan; the constraint is still
    // enforced on every row the replay writes, which is the whole point. It is
    // needed because this shared disposable schema also carries committed rows
    // from the other required proofs, which this fixture must not re-validate.
    await client.query(`alter table public.member_kb_article_revisions ${PRIOR_CANDIDATE_CHECK} not valid`);

    // The replay itself. A file that withholds before it widens aborts here
    // with a 23514 on member_kb_article_revisions_candidate_is_derived.
    await client.query(BACKFILL_SECTION);

    const after = {};
    for (const numeral of numerals) {
      after[numeral] = (await client.query(
        "select content_origin, knowledge_source_id, reconciled_by_source_id"
        + " from public.member_kb_article_revisions where id=$1", [candidates[numeral].id],
      )).rows[0];
    }
    // EVERY legacy retirement candidate is withheld — the one whose article
    // never moved (iv) exactly like the two whose articles did (i, ii). Where
    // the copied text came from was never recorded, and the round-4 review
    // showed that no timestamp on these rows can recover it, so the only fact
    // retained is the decision source the old writer left in the content
    // column: the replacement agreement that proposed the removal.
    for (const numeral of ["i", "ii", "iv"]) {
      expect(after[numeral], `article ${numeral} must be withheld, not guessed`).toEqual({
        content_origin: "unresolved",
        knowledge_source_id: null,
        reconciled_by_source_id: replacement.sourceId,
      });
    }
    // A changed-clause candidate carries B's own text — the writer inserted
    // B's normalized clause, not a copy off the article — so both columns name
    // B and the row stays derived and gated on B.
    expect(after.iii).toEqual({
      content_origin: "derived",
      knowledge_source_id: replacement.sourceId,
      reconciled_by_source_id: replacement.sourceId,
    });
    // No canonical revision is touched, and none carries a decision source.
    expect((await client.query(
      "select id, version, content_origin, knowledge_source_id from public.member_kb_article_revisions"
      + " where version > 0 and article_id = any($1::uuid[]) order by id", [articleIds],
    )).rows).toEqual(canonicalBefore);
    expect((await client.query(
      "select pg_catalog.count(*)::integer c from public.member_kb_article_revisions"
      + " where version > 0 and reconciled_by_source_id is not null",
    )).rows[0].c).toBe(0);

    // And the withheld rows are inert rather than merely mislabelled: they are
    // off the listing and refused by restore — with the same P0002 a revision
    // that is not there gets — on BOTH the confirm and the dismiss path, so
    // neither can republish a copy whose source was never recorded.
    await role("authenticated", ids.owner, ids.ownerSession);
    for (const numeral of ["i", "ii", "iv"]) {
      const listed = (await client.query(
        "select public.list_chapter_kb_revisions($1,$2) value", [articles[numeral].id, ids.chapter],
      )).rows[0].value;
      expect(listed.map((revision) => String(revision.id)))
        .not.toContain(String(candidates[numeral].id));
      for (const confirm of [true, false]) {
        await denied(
          "select public.restore_chapter_kb_revision($1,$2,$3,$4,$5)",
          [articles[numeral].id, candidates[numeral].id, confirm, randomUUID(), ids.chapter],
          "P0002",
        );
      }
    }
    // The changed-clause candidate is untouched by the withholding: it is
    // still listed and still restorable, so the repair withdrew exactly the
    // unprovable claim and nothing else.
    expect(((await client.query(
      "select public.list_chapter_kb_revisions($1,$2) value", [articles.iii.id, ids.chapter],
    )).rows[0].value).map((revision) => String(revision.id))).toContain(String(candidates.iii.id));
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 180000);

// THE ROUND-4 COUNTEREXAMPLE, DRIVEN FOR REAL. The first draft of
// 20260906029000 called a legacy retirement candidate attributable when no
// positive-version revision of its article carried
// `changed_at >= the candidate's changed_at`, and read that as "the article's
// source has not moved since the candidate was staged". changed_at defaults to
// now(), which PostgreSQL fixes at TRANSACTION START — not at lock acquisition
// and not at commit — so the implication is false whenever a source-moving
// transaction BEGINS first, blocks on the article row, and commits last.
//
// This proof builds exactly that interleaving out of the real writers:
//
//   * source A publishes a clause (narwhal text);
//   * source C reconciles it with CHANGED text and a reviewer restores C's
//     candidate, so the article and its text are now C's (pangolin text);
//   * T1 BEGINS FIRST and asks to restore the still-published A revision — a
//     SOURCE-MOVING restore, which does not delete a candidate it did not
//     select;
//   * T2 begins later, reconciles with replacement B, which omits the clause
//     and therefore stages a version-zero retirement candidate holding the
//     article's C-derived text, and commits;
//   * T1 only then acquires the article lock and commits, appending a
//     canonical revision whose changed_at is EARLIER than the candidate's.
//
// The retired predicate sees no later canonical revision and would have stamped
// the candidate with the article's current source, A — text that came out of C
// labelled as A's, so a lapse of C with A current would have put C's language
// back on the listing and back through restore. The repair withholds it.
databaseIt("withholds a legacy retirement candidate whose article moved under an EARLIER transaction timestamp", async () => {
  const client = connect();
  const mover = connect();
  const stager = connect();
  await client.connect();
  await mover.connect();
  await stager.connect();
  const ids = makeIds("invert");
  const { role, denied } = harness(client, ids);
  const claims = (name, actor = ids.owner, session = ids.ownerSession) => JSON.stringify({
    role: name, sub: actor, session_id: session, aal: "aal2",
  });
  const asRole = async (session, name) => {
    await session.query("select set_config('request.jwt.claims',$1,true)", [claims(name)]);
    await session.query(`set local role ${name}`);
  };
  const narwhal = "Recognition language about a uniquely searchable narwhal provision.";
  const pangolin = "Recognition language about a uniquely searchable pangolin provision.";
  let seeded = null;
  let before = null;
  try {
    before = await census(client);
    await client.query("begin");
    const base = await seed(client, ids, role);

    // Source A imports and publishes the clause.
    await inspectClean(client, role, ids, base.byKind.knowledge);
    await role("authenticated", ids.owner, ids.ownerSession);
    const sourceA = (await client.query(
      "select public.complete_steward_library_upload($1,$2) value", [base.byKind.knowledge.id, randomUUID()],
    )).rows[0].value.sourceId;
    await role("service_role");
    expect((await client.query(
      "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
      [ids.org, sourceA, ids.owner, ids.chapter, JSON.stringify([{
        clauseKey: "article:i", articleRef: "Article I", title: "Recognition",
        body: narwhal, keywords: ["narwhal"],
      }])],
    )).rows[0].value.articleCount).toBe(1);
    await role("postgres");
    const articleId = (await client.query(
      "select id from public.member_kb_articles where knowledge_source_id=$1", [sourceA],
    )).rows[0].id;
    const draftOnA = (await client.query(
      "select id from public.member_kb_article_revisions where article_id=$1 and version=1", [articleId],
    )).rows[0].id;
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [articleId, draftOnA, randomUUID(), ids.chapter],
    )).rows[0].value.status).toBe("published");
    await role("postgres");
    // The published snapshot on A. This is what T1 will restore, and it is
    // canonical, so restoring it deletes no candidate.
    const publishedOnA = (await client.query(
      "select id from public.member_kb_article_revisions"
      + " where article_id=$1 and version=2 and knowledge_source_id=$2", [articleId, sourceA],
    )).rows[0].id;

    // Source C reconciles the same clause with CHANGED text; a reviewer accepts
    // it, so the article, and the text a later retirement candidate will copy,
    // are C's.
    const sourceC = await stageContractSource(client, role, ids, "invert-c", "c".repeat(64));
    await role("service_role");
    expect((await client.query(
      "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
      [ids.org, sourceC.sourceId, ids.owner, ids.chapter, JSON.stringify([{
        clauseKey: "article:i", articleRef: "Article I", title: "Recognition",
        body: pangolin, keywords: ["pangolin"],
      }])],
    )).rows[0].value).toMatchObject({ stagedPublishedCount: 1 });
    await role("postgres");
    const candidateFromC = (await client.query(
      "select id from public.member_kb_article_revisions where article_id=$1 and version=0", [articleId],
    )).rows[0].id;
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [articleId, candidateFromC, randomUUID(), ids.chapter],
    )).rows[0].value).toMatchObject({ status: "published", body: pangolin, knowledge_source_id: sourceC.sourceId });

    // Replacement B, which will omit the clause entirely.
    const sourceB = await stageContractSource(client, role, ids, "invert-b", "d".repeat(64));
    await role("postgres");
    seeded = { files: [...base.files, sourceC.file, sourceB.file] };
    await client.query("commit");

    // ---- T1 BEGINS FIRST. Its now() is fixed here, before T2 exists. --------
    await mover.query("begin");
    await asRole(mover, "authenticated");
    const t1 = (await mover.query("select pg_catalog.now() t")).rows[0].t;
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    // ---- T2 begins later, stages the retirement candidate, holds the lock ---
    await stager.query("begin");
    await asRole(stager, "service_role");
    const t2 = (await stager.query("select pg_catalog.now() t")).rows[0].t;
    expect(t2.getTime(), "T2 must begin after T1").toBeGreaterThan(t1.getTime());
    expect((await stager.query(
      "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
      [ids.org, sourceB.sourceId, ids.owner, ids.chapter, JSON.stringify([{
        clauseKey: "article:z", articleRef: "Article Z", title: "Successor only clause",
        body: "Successor-only language about a uniquely searchable pangolin provision.",
        keywords: ["pangolin"],
      }])],
    )).rows[0].value).toMatchObject({ stagedRetirementCount: 1 });

    // T1 now asks for the article and blocks on the row T2 is holding.
    const contended = mover.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [articleId, publishedOnA, randomUUID(), ids.chapter],
    );
    let settled = false;
    contended.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 750); });
    expect(settled, "the source-moving restore must block on the staged article row").toBe(false);

    await stager.query("commit");
    const moved = (await contended).rows[0].value;
    expect(moved.knowledge_source_id, "T1 moves the article back onto A").toBe(sourceA);
    expect(moved.body).toBe(narwhal);
    await mover.query("commit");

    // ---- The inversion is now a fact on the rows. ---------------------------
    await client.query("begin");
    await client.query("reset role");
    const candidate = (await client.query(
      "select id, status, body, changed_at, knowledge_source_id, reconciled_by_source_id, content_origin"
      + " from public.member_kb_article_revisions where article_id=$1 and version=0", [articleId],
    )).rows[0];
    expect(candidate.status).toBe("retired");
    // The candidate copied C's text, and the article no longer carries C.
    expect(candidate.body).toBe(pangolin);
    expect((await client.query(
      "select knowledge_source_id, status from public.member_kb_articles where id=$1", [articleId],
    )).rows[0]).toEqual({ knowledge_source_id: sourceA, status: "published" });
    // ...and the canonical revision T1 appended really does carry the EARLIER
    // timestamp, so the retired predicate's premise is satisfied while its
    // conclusion is false. This is the whole counterexample, asserted rather
    // than described.
    expect((await client.query(
      "select pg_catalog.count(*)::integer c from public.member_kb_article_revisions"
      + " where article_id=$1 and version>0 and changed_at >= $2", [articleId, candidate.changed_at],
    )).rows[0].c).toBe(0);
    expect((await client.query(
      "select knowledge_source_id from public.member_kb_article_revisions"
      + " where article_id=$1 order by version desc limit 1", [articleId],
    )).rows[0].knowledge_source_id).toBe(sourceA);

    // Put the table back into its exact pre-029000 shape, with the candidate
    // stamped the way 20260906028000's writer stamped it: the REPLACEMENT's id
    // in the content column.
    await client.query(
      "alter table public.member_kb_article_revisions"
      + " drop constraint member_kb_article_revisions_candidate_origin_known,"
      + " drop constraint member_kb_article_revisions_unresolved_names_no_source,"
      + " drop column reconciled_by_source_id",
    );
    await client.query(
      "update public.member_kb_article_revisions set knowledge_source_id=$1 where id=$2",
      [sourceB.sourceId, candidate.id],
    );
    await client.query(`alter table public.member_kb_article_revisions ${PRIOR_CANDIDATE_CHECK} not valid`);

    await client.query(BACKFILL_SECTION);

    // Withheld: no content source named, only the decision source retained.
    expect((await client.query(
      "select content_origin, knowledge_source_id, reconciled_by_source_id"
      + " from public.member_kb_article_revisions where id=$1", [candidate.id],
    )).rows[0]).toEqual({
      content_origin: "unresolved",
      knowledge_source_id: null,
      reconciled_by_source_id: sourceB.sourceId,
    });
    // The specific mislabelling the retired predicate would have produced.
    expect((await client.query(
      "select pg_catalog.count(*)::integer c from public.member_kb_article_revisions"
      + " where id=$1 and knowledge_source_id in ($2,$3)", [candidate.id, sourceA, sourceC.sourceId],
    )).rows[0].c).toBe(0);

    // Inert on every surface: hidden from the listing, refused by restore on
    // both the confirm and the dismiss path.
    await role("authenticated", ids.owner, ids.ownerSession);
    expect(((await client.query(
      "select public.list_chapter_kb_revisions($1,$2) value", [articleId, ids.chapter],
    )).rows[0].value).map((revision) => String(revision.id))).not.toContain(String(candidate.id));
    for (const confirm of [true, false]) {
      await denied(
        "select public.restore_chapter_kb_revision($1,$2,$3,$4,$5)",
        [articleId, candidate.id, confirm, randomUUID(), ids.chapter], "P0002",
      );
    }
    await client.query("reset role");
    await client.query("rollback");
  } finally {
    try { await mover.query("rollback"); } catch { /* already closed */ }
    try { await stager.query("rollback"); } catch { /* already closed */ }
    try { await client.query("rollback"); } catch { /* already closed */ }
    if (seeded) await teardownCommittedFixture(client, ids, seeded, before);
    await client.end();
    await mover.end();
    await stager.end();
  }
}, 180000);

databaseIt("stores no article content in a restore receipt and revalidates every replay of it", async () => {
  // The second round-2 finding. restore_chapter_kb_revision cached
  // `to_jsonb(restored)` — title, article_ref, body, keywords — and returned it
  // from the idempotency branch BEFORE the article lookup, the chapter/sample
  // check and both provenance checks. Replaying the key after the source went
  // stale, blocked, failed or deleted handed back the whole derived text with
  // the ledger never consulted.
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("receipt");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    const imported = await publishImportedClause(client, role, ids, byKind);
    await role("postgres");
    const target = (await client.query(
      "select id from public.member_kb_article_revisions where article_id=$1 and version=1",
      [imported.articleId],
    )).rows[0].id;

    const key = randomUUID();
    await role("authenticated", ids.owner, ids.ownerSession);
    const first = (await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [imported.articleId, target, key, ids.chapter],
    )).rows[0].value;
    expect(first.body).toBe(imported.clause[0].body);
    expect(first.status).toBe("published");

    // The receipt is lifecycle metadata and nothing that came out of the file.
    // That is what makes the replay below a gated re-read rather than a cache hit.
    await role("postgres");
    const receipt = (await client.query(
      "select request_payload, result from private.mi1_w2_operation_receipts"
      + " where operation='restore_chapter_kb_revision' and idempotency_key=$1", [key],
    )).rows[0];
    expect(Object.keys(receipt.result).sort())
      .toEqual(["action", "articleId", "newVersion", "restoredRevisionId", "status"]);
    for (const field of ["title", "article_ref", "body", "keywords", "slug"]) {
      expect(receipt.result[field], `the receipt must not carry ${field}`).toBeUndefined();
    }
    expect(receipt.request_payload.actorId, "the receipt must be bound to its actor").toBe(ids.owner);

    // A replay by the same actor while the verdict is current answers with the
    // same row, reconstructed through the gate.
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [imported.articleId, target, key, ids.chapter],
    )).rows[0].value).toEqual(first);

    // A second staff member replaying that key cannot receive the first actor's
    // result, and the real mechanism is the NAMESPACE, not a refusal.
    // private.mi1_w2_operation_receipts is a view filtered on auth.uid() and
    // its backing PK carries actor_user_id, so the second actor's lookup finds
    // NO receipt at all: the replay is a distinct operation that succeeds and
    // writes its own receipt. It is not 22023 — 22023 arises only when a
    // receipt IS visible under the caller's own actor id and carries a
    // different payload, which the savepoint after this one drives directly.
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    await client.query("savepoint receipt_second_actor");
    const otherActor = (await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [imported.articleId, target, key, ids.chapter],
    )).rows[0].value;
    expect(otherActor.version).toBeGreaterThan(first.version);
    expect(otherActor.updated_by).toBe(ids.reviewer);
    await role("postgres");
    const namespaced = (await client.query(
      `select actor_user_id, request_payload from private.mi1_w2_operation_receipt_rows
        where operation='restore_chapter_kb_revision' and idempotency_key=$1`, [key],
    )).rows;
    expect(namespaced).toHaveLength(2);
    expect(namespaced.map((row) => row.request_payload.actorId).sort())
      .toEqual([ids.owner, ids.reviewer].sort());
    await client.query("rollback to savepoint receipt_second_actor");
    await client.query("release savepoint receipt_second_actor");

    // The payload binding 20260906028000 adds is load-bearing on its own, not
    // merely a restatement of that namespace. THIS is the only shape that
    // yields 22023: re-attribute the stored row to the second actor so the
    // receipt becomes VISIBLE under that actor — the shape any receipt would
    // have if the actor namespace were ever widened, or if a row were written
    // by an older build — and the replay is REFUSED rather than served,
    // because auth.uid() is now part of the compared request payload.
    await client.query("savepoint receipt_cross_actor");
    await role("postgres");
    await client.query(
      "update private.mi1_w2_operation_receipt_rows set actor_user_id=$2 where idempotency_key=$1",
      [key, ids.reviewer],
    );
    await role("authenticated", ids.reviewer, ids.reviewerSession);
    expect(await denied(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
      [imported.articleId, target, key, ids.chapter], "22023",
    )).toContain("idempotency key reused for a different request");
    await client.query("rollback to savepoint receipt_cross_actor");
    await client.query("release savepoint receipt_cross_actor");

    // A receipt whose article is no longer in this chapter is not a response
    // either — the replay re-reads, it does not remember.
    await client.query("savepoint receipt_article_moved");
    await role("postgres");
    await client.query(
      "update public.member_kb_articles set chapter_id=$2 where id=$1", [imported.articleId, ids.spareChapter],
    );
    await role("authenticated", ids.owner, ids.ownerSession);
    await denied(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
      [imported.articleId, target, key, ids.chapter], "P0002",
    );
    await client.query("rollback to savepoint receipt_article_moved");
    await client.query("release savepoint receipt_article_moved");

    // The source lapses. Same key, same actor, and the cached text is refused
    // with the same SQLSTATE and message the primary path raises.
    await role("postgres");
    await client.query(
      "update private.private_upload_scans set status='blocked', clean_until=null where object_id=$1",
      [byKind.knowledge.objectId],
    );
    await role("authenticated", ids.owner, ids.ownerSession);
    expect(await denied(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
      [imported.articleId, target, key, ids.chapter],
    )).toContain("file inspection required");

    // ...including the lapse that cannot be undone.
    await role("postgres");
    await client.query(
      "update private.private_upload_scans set status='clean', clean_until=now()+interval '1 hour' where object_id=$1",
      [byKind.knowledge.objectId],
    );
    await client.query("select set_config('storage.allow_delete_query','true',true)");
    await client.query("delete from storage.objects where id=$1", [byKind.knowledge.objectId]);
    await role("authenticated", ids.owner, ids.ownerSession);
    expect(await denied(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
      [imported.articleId, target, key, ids.chapter],
    )).toContain("file inspection required");
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 180000);

databaseIt("serializes a knowledge ingest completion against a concurrent verdict change and writes nothing against the loser", async () => {
  // The authorization-versus-completion race. authorize_knowledge_ingest reads
  // the ledger once and hands a bucket/objectName to a service-role worker that
  // downloads bytes and comes back later; the completion RPC used to write
  // chunks on the strength of that one reading. Deriving the file server-side
  // and taking `for update` on the owning storage.objects row before reading
  // private_upload_is_current is what turns the race into a serialization.
  //
  // This is the second proof in this file that COMMITS: two sessions have to
  // see one row set. Everything it creates is removed in the finally block, and
  // the target is an owned disposable stack CI destroys after the run anyway.
  const client = connect();
  const rival = connect();
  await client.connect();
  await rival.connect();
  const ids = makeIds("ingestrace");
  const { role } = harness(client, ids);
  let seeded = null;
  let before = null;
  let sourceId;
  try {
    before = await census(client);
    await client.query("begin");
    seeded = await seed(client, ids, role);
    const file = seeded.byKind.knowledge;
    await inspectClean(client, role, ids, file);
    await role("authenticated", ids.owner, ids.ownerSession);
    sourceId = (await client.query(
      "select public.complete_steward_library_upload($1,$2) value", [file.id, randomUUID()],
    )).rows[0].value.sourceId;
    expect(sourceId).toBeTruthy();
    await role("postgres");
    await client.query("commit");

    const asServiceRole = async (session) => {
      await session.query("begin");
      await session.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ role: "service_role", sub: ids.owner, session_id: ids.ownerSession, aal: "aal2" }),
      ]);
      await session.query("set local role service_role");
    };

    // Session B takes the owning Storage row lock first, exactly as a
    // concurrent finish_private_upload_inspection would.
    await rival.query("begin");
    await rival.query("select * from storage.objects where id=$1 for update", [file.objectId]);

    // Session A now blocks INSIDE the completion RPC, so the verdict it reads
    // cannot predate B's write.
    await asServiceRole(client);
    const contended = client.query(
      "select public.replace_knowledge_source_chunks($1,$2,$3,$4::jsonb,null) value",
      [ids.org, sourceId, ids.owner, JSON.stringify(["Extracted contract text."])],
    );
    let settled = false;
    contended.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 750); });
    expect(settled, "the ingest completion must block on the locked storage row").toBe(false);

    expect((await rival.query(
      "update private.private_upload_scans set status='blocked', clean_until=null where object_id=$1 returning status",
      [file.objectId],
    )).rows[0].status).toBe("blocked");
    await rival.query("commit");

    let raced;
    try { await contended; } catch (error) { raced = error; }
    expect(raced, "the completion must not commit against a blocked verdict").toBeTruthy();
    expect(raced.code).toBe("42501");
    expect(raced.message).toContain("file inspection required");
    await client.query("rollback");

    await client.query("select set_config('request.jwt.claims',null,true)");
    expect((await client.query(
      "select pg_catalog.count(*)::integer c from public.organization_knowledge_chunks where source_id=$1", [sourceId],
    )).rows[0].c).toBe(0);
    expect((await client.query(
      "select index_status from public.organization_knowledge_files where id=$1", [file.id],
    )).rows[0].index_status).toBe("pending");

    // Control: the same call succeeds once the verdict is current again, so the
    // refusal above was the verdict change and not the lock.
    await client.query(
      "update private.private_upload_scans set status='clean', clean_until=now()+interval '1 hour' where object_id=$1",
      [file.objectId]);
    await asServiceRole(client);
    expect((await client.query(
      "select public.replace_knowledge_source_chunks($1,$2,$3,$4::jsonb,null) value",
      [ids.org, sourceId, ids.owner, JSON.stringify(["Extracted contract text."])],
    )).rows[0].value.chunkCount).toBe(1);
    await client.query("rollback");
    await client.query("select set_config('request.jwt.claims',null,true)");

    // And the same serialization protects the CBA draft writer, which turns
    // extracted bytes into reviewable, publishable member-facing language.
    await client.query(
      "update private.private_upload_scans set status='blocked', clean_until=null where object_id=$1",
      [file.objectId]);
    await asServiceRole(client);
    let refusedDrafts;
    try {
      await client.query(
        "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb)",
        [ids.org, sourceId, ids.owner, ids.chapter, JSON.stringify([{
          clauseKey: "article:i", articleRef: "Article I", title: "Recognition",
          body: "Imported recognition language.", keywords: ["recognition"],
        }])],
      );
    } catch (error) { refusedDrafts = error; }
    expect(refusedDrafts?.code).toBe("42501");
    expect(refusedDrafts?.message).toContain("file inspection required");
    await client.query("rollback");
    await client.query("select set_config('request.jwt.claims',null,true)");
    expect((await client.query(
      "select pg_catalog.count(*)::integer c from public.member_kb_articles where knowledge_source_id=$1", [sourceId],
    )).rows[0].c).toBe(0);
  } finally {
    try { await client.query("rollback"); } catch { /* already closed */ }
    try { await rival.query("rollback"); } catch { /* already closed */ }
    if (seeded) await teardownCommittedFixture(client, ids, seeded, before);
    await client.end();
    await rival.end();
  }
}, 180000);

// ===========================================================================
// 20260906030000 — THE ARTICLE ROW.
//
// The adversarial red-team pass over d5adc33c found the provenance repair was
// REVISION-ONLY. 20260906028000 and 20260906029000 gave
// member_kb_article_revisions an explicit content origin and withheld every row
// whose true source could not be proved; neither touched public
// .member_kb_articles, and the base-head coalescing restore
// (20260903030000:868) had already been putting one source's TEXT on the
// article row under another source's id. Every article-level gate then read
// that id, answered true, and served the first source's text once it lapsed.
//
// These two proofs are the live regression. They are the only proofs in the
// repository that build the LEGACY state through the PRE-BRANCH writers rather
// than describing it, so the sequence the finding names is executed rather than
// asserted about.
//
// HOW "A STACK WITH MIGRATIONS TRUNCATED BEFORE 20260906028000" IS BUILT.
// Inside the proof's own rolled-back transaction the schema is put back into
// its exact 20260906027000 shape — the three columns and constraints
// 028000/029000/030000 add are dropped, the equality constraint 028000 dropped
// is restored, and public.replace_cba_knowledge_drafts and
// public.restore_chapter_kb_revision are re-installed from 20260906024000's
// own text through fnBody — and the three migrations are then re-applied
// VERBATIM, statement for statement, minus their outer BEGIN/COMMIT. Every
// name the revert drops is asserted against the migration that adds it, so a
// migration that grows a fourth constraint makes this red rather than making
// the revert quietly incomplete.
const ARTICLE_PROVENANCE_MIGRATION = "20260906030000_knowledge_article_provenance";
// This later policy also depends on the article predicate. Remove it during
// the historical replay, then restore the exact reviewed definition once the
// current predicate exists again; do not use DROP CASCADE to hide new dependents.
const EMBEDDING_MEMBER_READ_POLICY = loadMigrationSql("20260930030000_compass_hybrid_retrieval_pgvector")
  .match(/create policy member_kb_article_embeddings_member_read\b[\s\S]*?;/)?.[0];

// One migration's executable body, without the outer transaction control, so it
// can be replayed inside the proof's own transaction exactly as written.
function migrationStatements(fragment) {
  const sql = loadMigrationSql(fragment);
  const begin = sql.indexOf("begin;");
  const commit = sql.lastIndexOf("commit;");
  expect(begin, `${fragment} must open a transaction`).toBeGreaterThan(-1);
  expect(commit, `${fragment} must close it`).toBeGreaterThan(begin);
  return sql.slice(begin + "begin;".length, commit);
}

// The pre-branch head, reconstructed. Nothing here is invented: every dropped
// name is checked against the migration that introduces it first.
async function truncateBefore028000(client) {
  const revisionProvenance = stripComments(loadMigrationSql("20260906028000_knowledge_revision_provenance"));
  const candidateProvenance = stripComments(loadMigrationSql("20260906029000_retirement_candidate_provenance"));
  const articleProvenance = stripComments(loadMigrationSql(ARTICLE_PROVENANCE_MIGRATION));
  for (const [migration, names] of [
    [revisionProvenance, [
      "add column content_origin text;",
      "member_kb_article_revisions_content_origin_known",
      "member_kb_article_revisions_derived_names_its_source",
      "member_kb_article_revisions_authored_has_no_source",
      "create function private.knowledge_revision_restore_receipt(",
    ]],
    [candidateProvenance, [
      "add column reconciled_by_source_id uuid",
      "member_kb_article_revisions_candidate_origin_known",
      "member_kb_article_revisions_unresolved_names_no_source",
      "member_kb_article_revisions_reconciled_by_is_candidate",
    ]],
    [articleProvenance, [
      "add column content_origin text;",
      "member_kb_articles_content_origin_known",
      "member_kb_articles_derived_names_its_source",
      "member_kb_articles_authored_has_no_source",
      "create function private.knowledge_article_content_current(",
      "create function private.knowledge_article_reestablishment_candidate(",
      "create policy member_kb_articles_member_read",
      "create policy member_kb_articles_staff_read",
    ]],
  ]) {
    for (const name of names) {
      expect(migration, `the revert below must stay complete: ${name}`).toContain(name);
    }
  }
  await client.query("reset role");
  // The historical schema has no content_origin. Disable only the later
  // Compass ingestion trigger while replaying that schema; this entire proof
  // is rolled back. Restore it before asserting any current retrieval gate.
  await client.query("alter table public.member_kb_articles disable trigger compass_document_ingestion_classification");
  // Policies first: these objects hold a real dependency on the predicate.
  expect(EMBEDDING_MEMBER_READ_POLICY).toBeTruthy();
  await client.query("drop policy member_kb_article_embeddings_member_read on public.member_kb_article_embeddings");
  // 20261028210000 merged the two read policies into member_kb_articles_select;
  // the 030000 replay below re-creates the two it declared.
  await client.query("drop policy member_kb_articles_select on public.member_kb_articles");
  await client.query("drop function private.knowledge_article_reestablishment_candidate(public.member_kb_articles)");
  await client.query("drop function private.knowledge_article_content_current(public.member_kb_articles)");
  await client.query("drop function private.knowledge_revision_restore_receipt(text, jsonb)");
  await client.query(
    "alter table public.member_kb_articles"
    + " drop constraint member_kb_articles_content_origin_known,"
    + " drop constraint member_kb_articles_derived_names_its_source,"
    + " drop constraint member_kb_articles_authored_has_no_source,"
    + " drop column content_origin",
  );
  await client.query(
    "alter table public.member_kb_article_revisions"
    + " drop constraint member_kb_article_revisions_candidate_origin_known,"
    + " drop constraint member_kb_article_revisions_unresolved_names_no_source,"
    + " drop constraint member_kb_article_revisions_reconciled_by_is_candidate,"
    + " drop constraint member_kb_article_revisions_content_origin_known,"
    + " drop constraint member_kb_article_revisions_derived_names_its_source,"
    + " drop constraint member_kb_article_revisions_authored_has_no_source,"
    + " drop column reconciled_by_source_id,"
    + " drop column content_origin",
  );
  // THE DATA IS REVERTED TOO, NOT ONLY THE SCHEMA. These proof files share one
  // disposable schema and some of them COMMIT fixtures, so the table can hold
  // rows a 20260906027000 database could never have held: a positive-version
  // revision that NAMES a source, and a version-zero candidate that names none.
  // Both are shapes only a post-20260906028000 writer produces, and the
  // pre-repair equality constraint below forbids both — the first of them is
  // precisely why the coalescing restore fell through to the article's stale
  // source, so a fixture that left it in place would not be reverted at all.
  // Everything here is confined to this proof's own rolled-back transaction.
  await client.query(
    "update public.member_kb_article_revisions set knowledge_source_id = null"
    + " where version > 0 and knowledge_source_id is not null",
  );
  await client.query(
    "delete from public.member_kb_article_revisions"
    + " where version = 0 and knowledge_source_id is null",
  );
  // 20260903030000's equality constraint, which 20260906028000 drops and which
  // is what forced every positive-version revision to a null source. It has to
  // exist by that name for the replay's `drop constraint` to succeed, and it is
  // added VALIDATED rather than NOT VALID: the whole table now really is in the
  // shape the pre-branch head permitted, and every row the pre-branch writers
  // below produce is checked against it, which is what makes their null-source
  // canonical revisions a fact of this fixture rather than a claim about it.
  await client.query(
    "alter table public.member_kb_article_revisions"
    + " add constraint member_kb_article_revisions_import_candidate_complete"
    + " check ((import_candidate_key is null) = (knowledge_source_id is null))",
  );
  // And the two writers, from 20260906024000's own text.
  const preBranch = loadMigrationSql("20260906024000_knowledge_source_verdict_gates");
  await client.query(fnBody(preBranch, "public.replace_cba_knowledge_drafts"));
  await client.query(fnBody(preBranch, "public.restore_chapter_kb_revision"));
  expect(stripComments(fnBody(preBranch, "public.restore_chapter_kb_revision")))
    .toContain("knowledge_source_id = coalesce(revision.knowledge_source_id, article.knowledge_source_id)");
}

const T_A = "Source A overtime language about a uniquely searchable quokka provision.";
const T_B = "Source B overtime language about a uniquely searchable quokka provision.";
const T_AY = "Source A recognition language about a uniquely searchable quokka provision.";
const T_AZ = "Source A discipline language about a uniquely searchable quokka provision.";

// S1-S5 of the red-team scenario, plus the retirement variant and an omitted
// clause that keeps its legacy retirement candidate, driven through the
// PRE-BRANCH RPCs on the reverted schema. Returns the ids the assertions need.
async function buildLegacyLaunderedChapter(client, role, ids, byKind) {
  const clause = (key, ref, title, body) => ({
    clauseKey: key, articleRef: ref, title, body, keywords: ["quokka"],
  });
  await inspectClean(client, role, ids, byKind.knowledge);
  await role("authenticated", ids.owner, ids.ownerSession);
  const sourceA = (await client.query(
    "select public.complete_steward_library_upload($1,$2) value", [byKind.knowledge.id, randomUUID()],
  )).rows[0].value.sourceId;
  expect(sourceA).toBeTruthy();

  await truncateBefore028000(client);

  // S1. Source A imports three clauses.
  await role("service_role");
  expect((await client.query(
    "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
    [ids.org, sourceA, ids.owner, ids.chapter, JSON.stringify([
      clause("article:xii", "Article XII", "Overtime", T_A),
      clause("article:xiii", "Article XIII", "Recognition", T_AY),
      clause("article:xiv", "Article XIV", "Discipline", T_AZ),
    ])],
  )).rows[0].value.articleCount).toBe(3);
  await role("postgres");
  const articles = Object.fromEntries((await client.query(
    "select import_key, id from public.member_kb_articles where knowledge_source_id=$1", [sourceA],
  )).rows.map((row) => [row.import_key, row.id]));
  const keyOf = async (clauseKey) => (await client.query(
    "select pg_catalog.md5('clause:' || $1::text) value", [clauseKey],
  )).rows[0].value;
  const articleX = articles[await keyOf("article:xii")];
  const articleY = articles[await keyOf("article:xiii")];
  const articleZ = articles[await keyOf("article:xiv")];
  expect([articleX, articleY, articleZ].every(Boolean)).toBe(true);

  // S2. A reviewer publishes all three through the ordinary workflow. Every
  // canonical revision written here carries a NULL source: the equality
  // constraint restored above forces it, which is the round-2 defect.
  const canonical = {};
  for (const id of [articleX, articleY, articleZ]) {
    await role("postgres");
    const revisionId = (await client.query(
      "select id from public.member_kb_article_revisions where article_id=$1 and version>0"
      + " order by version desc limit 1", [id],
    )).rows[0].id;
    await role("authenticated", ids.owner, ids.ownerSession);
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [id, revisionId, randomUUID(), ids.chapter],
    )).rows[0].value.status).toBe("published");
    await role("postgres");
    canonical[id] = (await client.query(
      "select id, body, knowledge_source_id from public.member_kb_article_revisions"
      + " where article_id=$1 and version>0 order by version desc limit 1", [id],
    )).rows[0];
    expect(canonical[id].knowledge_source_id).toBeNull();
  }

  // S3. Replacement agreement B carries article:xii with DIFFERENT text and
  // omits the other two, so one changed-clause candidate and two retirement
  // candidates are staged — all three stamped with B by the pre-branch writer.
  const replacement = await stageContractSource(client, role, ids, "article-successor", "f".repeat(64));
  await role("service_role");
  expect((await client.query(
    "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
    [ids.org, replacement.sourceId, ids.owner, ids.chapter, JSON.stringify([
      clause("article:xii", "Article XII", "Overtime", T_B),
    ])],
  )).rows[0].value).toMatchObject({ stagedPublishedCount: 1, stagedRetirementCount: 2 });

  // S4. The reviewer restores B's candidate: the article moves to B, holding
  // B's text. Still consistent at this point.
  await role("postgres");
  const changedCandidate = (await client.query(
    "select id from public.member_kb_article_revisions where article_id=$1 and version=0", [articleX],
  )).rows[0].id;
  await role("authenticated", ids.owner, ids.ownerSession);
  expect((await client.query(
    "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
    [articleX, changedCandidate, randomUUID(), ids.chapter],
  )).rows[0].value).toMatchObject({ body: T_B, knowledge_source_id: replacement.sourceId });

  // S5. The reviewer reverts to the older canonical revision — the everyday
  // "restore this earlier version" action. Its source is NULL, so
  // coalesce(NULL, B) keeps B while the body written is A's text. THE LAUNDER.
  expect((await client.query(
    "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
    [articleX, canonical[articleX].id, randomUUID(), ids.chapter],
  )).rows[0].value).toMatchObject({ body: T_A, knowledge_source_id: replacement.sourceId });

  // THE RETIREMENT VARIANT, which needs no revert at all: the candidate copies
  // the ARTICLE's own A-derived text while naming B, and confirming it drives
  // the same coalesce.
  await role("postgres");
  const retirementCandidateY = (await client.query(
    "select id, body, knowledge_source_id from public.member_kb_article_revisions"
    + " where article_id=$1 and version=0", [articleY],
  )).rows[0];
  expect(retirementCandidateY).toMatchObject({ body: T_AY, knowledge_source_id: replacement.sourceId });
  await role("authenticated", ids.owner, ids.ownerSession);
  expect((await client.query(
    "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
    [articleY, retirementCandidateY.id, randomUUID(), ids.chapter],
  )).rows[0].value).toMatchObject({
    status: "retired", body: T_AY, knowledge_source_id: replacement.sourceId,
  });

  // Article Z keeps its legacy retirement candidate undecided, which is the
  // state 20260906029000's backfill withholds.
  await role("postgres");
  const retirementCandidateZ = (await client.query(
    "select id from public.member_kb_article_revisions where article_id=$1 and version=0", [articleZ],
  )).rows[0].id;

  // An authored article in the same chapter, to prove throughout that the
  // withholding is about unprovable provenance and not about the corpus.
  const authoredSlug = `authored-article-${ids.tag}-${ids.org}`;
  await client.query(
    `insert into public.member_kb_articles (
       slug, kind, title, article_ref, body, keywords, order_index, chapter_id,
       status, is_sample, version, created_by, updated_by, verified_by, verified_at
     ) values ($1,'faq','Authored','Guide','Authored guidance about a uniquely searchable quokka provision.',
       array['quokka'],800,$2,'published',false,1,$3,$3,$3,now())`,
    [authoredSlug, ids.chapter, ids.owner],
  );
  const authoredId = (await client.query(
    "select id from public.member_kb_articles where slug=$1", [authoredSlug],
  )).rows[0].id;

  // THE STATE THE MIGRATIONS MEET. Two published/retired articles holding
  // source A's text under source B's id, and one untouched.
  expect((await client.query(
    "select id, body, knowledge_source_id, status from public.member_kb_articles"
    + " where id = any($1::uuid[]) order by order_index", [[articleX, articleY, articleZ]],
  )).rows).toEqual([
    { id: articleX, body: T_A, knowledge_source_id: replacement.sourceId, status: "published" },
    { id: articleY, body: T_AY, knowledge_source_id: replacement.sourceId, status: "retired" },
    { id: articleZ, body: T_AZ, knowledge_source_id: sourceA, status: "published" },
  ]);

  // APPLY 028000, 029000 AND 030000 VERBATIM, in order, minus their outer
  // transaction control. Nothing about them is paraphrased here.
  for (const fragment of [
    "20260906028000_knowledge_revision_provenance",
    "20260906029000_retirement_candidate_provenance",
    ARTICLE_PROVENANCE_MIGRATION,
  ]) {
    await client.query("reset role");
    await client.query(migrationStatements(fragment));
  }
  await client.query(EMBEDDING_MEMBER_READ_POLICY);
  await client.query("alter table public.member_kb_articles enable trigger compass_document_ingestion_classification");
  // Reclassify only this synthetic chapter after restoring its current schema.
  // The real trigger, provenance and search gates all operate in the assertions.
  await client.query("update public.member_kb_articles set compass_classification=null where chapter_id=$1", [ids.chapter]);

  return {
    sourceA, sourceB: replacement.sourceId, articleX, articleY, articleZ,
    authoredId, authoredSlug, canonical, retirementCandidateZ,
  };
}

// Source A loses its verdict while B keeps one. 20260905021500 seeds every
// pre-existing object non-clean and clean_until is capped at now()+24h, so
// "the superseded agreement is not current while the live one is" is the
// ordinary steady state rather than a contrived one.
async function lapseSource(client, objectId) {
  await client.query("reset role");
  await client.query(
    "update private.private_upload_scans set scanned_at=now()-interval '25 hours',"
    + " clean_until=now()-interval '1 second' where object_id=$1", [objectId],
  );
}

databaseIt("withholds every legacy article the pre-branch coalescing restore could have laundered, on every article-level gate", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("articleorigin");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    const built = await buildLegacyLaunderedChapter(client, role, ids, byKind);

    // The backfill withholds every legacy article that carries a source, and
    // leaves the source value on the row: nulling it would make the row MORE
    // visible, because a null source answers true by design (invariant 6).
    await role("postgres");
    expect((await client.query(
      "select id, content_origin, knowledge_source_id from public.member_kb_articles"
      + " where id = any($1::uuid[]) order by order_index",
      [[built.articleX, built.articleY, built.articleZ, built.authoredId]],
    )).rows).toEqual([
      { id: built.articleX, content_origin: "unresolved", knowledge_source_id: built.sourceB },
      { id: built.articleY, content_origin: "unresolved", knowledge_source_id: built.sourceB },
      { id: built.articleZ, content_origin: "unresolved", knowledge_source_id: built.sourceA },
      { id: built.authoredId, content_origin: "authored", knowledge_source_id: null },
    ]);

    // A is never re-inspected — it is the superseded agreement — while B stays
    // clean. Every gate below therefore reads a CURRENT source on articles X
    // and Y, which is exactly what used to make them answer true.
    await lapseSource(client, byKind.knowledge.objectId);
    expect((await client.query(
      "select private.knowledge_source_verdict_current($1) a, private.knowledge_source_verdict_current($2) b",
      [built.sourceA, built.sourceB],
    )).rows[0]).toEqual({ a: false, b: true });

    // A collection placement, written directly so the projection has something
    // real to drop.
    await client.query(
      "insert into public.knowledge_collections(id,organization_id,chapter_id,title,visibility,sort_order,created_by,updated_by)"
      + " values(extensions.gen_random_uuid(),$1,$2,'Article provenance proof','organization',10,$3,$3)",
      [ids.org, ids.chapter, ids.owner],
    );
    const collectionId = (await client.query(
      "select id from public.knowledge_collections where organization_id=$1 order by created_at desc limit 1", [ids.org],
    )).rows[0].id;
    for (const articleId of [built.articleX, built.authoredId]) {
      await client.query(
        "insert into public.knowledge_collection_items(organization_id,collection_id,item_kind,kb_article_id,sort_order,added_by)"
        + " values($1,$2,'kb_article',$3,10,$4)",
        [ids.org, collectionId, articleId, ids.owner],
      );
    }

    await role("authenticated", ids.owner, ids.ownerSession);
    const snapshot = async (publishedOnly, chapter) => ((await client.query(
      "select public.list_accessible_knowledge_articles_snapshot($1,$2) value", [publishedOnly, chapter],
    )).rows[0].value).map((article) => article.id);
    // The member Library/Search read — the surface that carries clause BODY to
    // a browser and needs no staff role — and its staff branch.
    for (const [publishedOnly, chapter] of [[true, null], [false, ids.chapter]]) {
      const listed = await snapshot(publishedOnly, chapter);
      expect(listed, `snapshot(${publishedOnly}) must withhold the laundered article`)
        .not.toContain(built.articleX);
      expect(listed).not.toContain(built.articleY);
      expect(listed).not.toContain(built.articleZ);
      expect(listed, "authored knowledge is untouched").toContain(built.authoredId);
    }
    // The ordinary PostgREST select both clients already issue, under both read
    // policies at once: this caller is a chapter member AND organization staff.
    expect((await client.query(
      "select id from public.member_kb_articles where id = any($1::uuid[])",
      [[built.articleX, built.articleY, built.articleZ, built.authoredId]],
    )).rows.map((row) => row.id)).toEqual([built.authoredId]);
    // Compass retrieval. All four rows carry the same searchable token, so a
    // gate that had moved would show up as a hit rather than as silence.
    expect((await client.query("select source_id from public.search_member_kb('quokka',6)")).rows
      .map((row) => row.source_id)).toEqual([`kb:${built.authoredSlug}`]);
    // The staff review listing, with no re-establishment candidate pending.
    expect(((await client.query(
      "select public.list_knowledge_review_articles_snapshot($1) value", [ids.chapter],
    )).rows[0].value).map((article) => article.id)).toEqual([built.authoredId]);
    // The collection projection.
    expect(((await client.query(
      "select public.list_knowledge_collections($1) value", [ids.chapter],
    )).rows[0].value)[0].items.map((item) => item.itemId)).toEqual([built.authoredId]);
    // ...and placement refuses to ADD one, with the shape an absent row gets.
    await denied(
      "select public.set_knowledge_collection_item($1,'kb_article',$2,true,20,$3)",
      [collectionId, built.articleY, ids.chapter], "P0002",
    );

    // Publication and retirement. A withheld article answers exactly as an
    // absent one does — never 'file inspection required', which would report
    // the existence of content this record is refusing to describe.
    for (const articleId of [built.articleX, built.articleY, built.articleZ]) {
      expect(await denied(
        "select public.save_chapter_kb_article($1,'contract','Rewritten','Article XII',"
        + "'Staff rewrite of withheld text.',array['quokka']::text[],'published',true,$2)",
        [articleId, ids.chapter],
      )).toBe("knowledge article is not available in this chapter");
      expect(await denied(
        "select public.retire_chapter_kb_article($1,$2)", [articleId, ids.chapter],
      )).toBe("knowledge article is not available in this chapter");
      await denied("select public.list_chapter_kb_revisions($1,$2)", [articleId, ids.chapter], "P0002");
    }
    // Restore, on every revision each withheld article still has — including
    // article Z's legacy retirement candidate, whose own origin 20260906029000
    // withheld, so the re-establishment door stays shut for it on BOTH the
    // confirm and the dismiss path.
    await role("postgres");
    const everyRevision = (await client.query(
      "select id, article_id from public.member_kb_article_revisions where article_id = any($1::uuid[])",
      [[built.articleX, built.articleY, built.articleZ]],
    )).rows;
    expect(everyRevision.length).toBeGreaterThanOrEqual(8);
    await role("authenticated", ids.owner, ids.ownerSession);
    for (const revision of everyRevision) {
      for (const confirm of [true, false]) {
        await denied(
          "select public.restore_chapter_kb_revision($1,$2,$3,$4,$5)",
          [revision.article_id, revision.id, confirm, randomUUID(), ids.chapter], "P0002",
        );
      }
    }
    expect(everyRevision.some((revision) => revision.id === String(built.retirementCandidateZ)
      || revision.id === built.retirementCandidateZ)).toBe(true);

    // The authored control is fully usable in the same transaction, through
    // the same functions that just refused every withheld row.
    expect(((await client.query(
      "select public.list_chapter_kb_revisions($1,$2) value", [built.authoredId, ids.chapter],
    )).rows[0].value).every((revision) => revision.contentOrigin === "authored")).toBe(true);
    expect((await client.query(
      "select pg_catalog.to_jsonb(public.save_chapter_kb_article($1,'faq','Authored','Guide',"
      + "'Authored guidance about a uniquely searchable quokka provision, edited.',"
      + "array['quokka']::text[],'published',true,$2)) value",
      [built.authoredId, ids.chapter],
    )).rows[0].value).toMatchObject({ content_origin: "authored", knowledge_source_id: null });
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 300000);

databaseIt("re-establishes a withheld article only through a reviewed reconciliation from an inspected source", async () => {
  const client = connect();
  await client.connect();
  await client.query("begin");
  const ids = makeIds("rearticle");
  const { role, denied } = harness(client, ids);
  try {
    const { byKind } = await seed(client, ids, role);
    const built = await buildLegacyLaunderedChapter(client, role, ids, byKind);
    await lapseSource(client, byKind.knowledge.objectId);

    // A third agreement S is uploaded and inspected, and it carries article:xii
    // with text BYTE-IDENTICAL to what the withheld article already holds.
    // Byte-identity proves nothing about where the withheld bytes came from —
    // that is the entire content of the finding — so the reconciliation must
    // still stage a candidate carrying S's own inspected text.
    const reconciler = await stageContractSource(client, role, ids, "article-reconciler", "0".repeat(64));
    await role("service_role");
    expect((await client.query(
      "select public.replace_cba_knowledge_drafts($1,$2,$3,$4,$5::jsonb) value",
      [ids.org, reconciler.sourceId, ids.owner, ids.chapter, JSON.stringify([{
        clauseKey: "article:xii", articleRef: "Article XII", title: "Overtime",
        body: T_A, keywords: ["quokka"],
      }])],
    )).rows[0].value).toMatchObject({
      preservedPublishedCount: 1,
      stagedPublishedCount: 1,
      // Articles Y and Z are withheld, so no retirement candidate is staged for
      // either: that candidate copies the ARTICLE's text under the ARTICLE's
      // own source, which is exactly the claim this record withdrew.
      stagedRetirementCount: 0,
    });
    await role("postgres");
    const candidate = (await client.query(
      "select id, status, content_origin, knowledge_source_id, reconciled_by_source_id, body"
      + " from public.member_kb_article_revisions where article_id=$1 and version=0", [built.articleX],
    )).rows[0];
    expect(candidate).toMatchObject({
      status: "draft", content_origin: "derived", body: T_A,
      knowledge_source_id: reconciler.sourceId, reconciled_by_source_id: reconciler.sourceId,
    });
    // Article Z's legacy withheld candidate is untouched, and article Z is
    // still withheld.
    expect((await client.query(
      "select content_origin, knowledge_source_id from public.member_kb_article_revisions where id=$1",
      [built.retirementCandidateZ],
    )).rows[0]).toEqual({ content_origin: "unresolved", knowledge_source_id: null });

    // The reviewer can now reach the pending decision, and only it. The review
    // listing reports the article under THE CANDIDATE's naming, flagged, and
    // the revision listing shows the candidate alone — every row of the
    // article's own history is 'unresolved' and stays off it.
    await role("authenticated", ids.owner, ids.ownerSession);
    const review = (await client.query(
      "select public.list_knowledge_review_articles_snapshot($1) value", [ids.chapter],
    )).rows[0].value;
    expect(review.map((article) => article.id).sort())
      .toEqual([built.articleX, built.authoredId].sort());
    expect(review.find((article) => article.id === built.articleX))
      .toMatchObject({ contentWithheld: true, title: "Overtime", articleRef: "Article XII" });
    expect(review.find((article) => article.id === built.authoredId))
      .toMatchObject({ contentWithheld: false });
    const history = (await client.query(
      "select public.list_chapter_kb_revisions($1,$2) value", [built.articleX, ids.chapter],
    )).rows[0].value;
    expect(history.map((revision) => String(revision.id))).toEqual([String(candidate.id)]);
    expect(history[0]).toMatchObject({
      contentOrigin: "derived", importCandidate: true, reconciledBySourceId: reconciler.sourceId,
    });
    // The door admits that revision and nothing else: the article's own
    // canonical history is still refused with the absent shape.
    await denied(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4)",
      [built.articleX, built.canonical[built.articleX].id, randomUUID(), ids.chapter], "P0002",
    );
    // Articles Y and Z have no candidate at all, so they stay shut.
    for (const articleId of [built.articleY, built.articleZ]) {
      await denied("select public.list_chapter_kb_revisions($1,$2)", [articleId, ids.chapter], "P0002");
    }

    // THE RE-ESTABLISHMENT. A reviewer's restore re-sources the article from
    // the file whose bytes it now holds.
    expect((await client.query(
      "select public.restore_chapter_kb_revision($1,$2,true,$3,$4) value",
      [built.articleX, candidate.id, randomUUID(), ids.chapter],
    )).rows[0].value).toMatchObject({
      status: "published", body: T_A,
      content_origin: "derived", knowledge_source_id: reconciler.sourceId,
    });

    // ...and every gate that withheld it now serves it, on S's verdict alone.
    expect(((await client.query(
      "select public.list_accessible_knowledge_articles_snapshot(true,null) value",
    )).rows[0].value).map((article) => article.id)).toContain(built.articleX);
    expect((await client.query(
      "select id from public.member_kb_articles where id=$1", [built.articleX],
    )).rows).toHaveLength(1);
    expect((await client.query("select source_id from public.search_member_kb('quokka',6)")).rows
      .map((row) => row.source_id)).toContain(`kb:${(await client.query(
        "select slug from public.member_kb_articles where id=$1", [built.articleX],
      )).rows[0].slug}`);
    // The canonical revision the restore appended is bound to S, not to the
    // source the withheld row used to name.
    await role("postgres");
    expect((await client.query(
      "select content_origin, knowledge_source_id from public.member_kb_article_revisions"
      + " where article_id=$1 order by version desc limit 1", [built.articleX],
    )).rows[0]).toEqual({ content_origin: "derived", knowledge_source_id: reconciler.sourceId });
    // Articles Y and Z stay withheld: re-establishment is per article, through
    // a reconciliation that actually carried that clause.
    expect((await client.query(
      "select content_origin from public.member_kb_articles where id = any($1::uuid[])",
      [[built.articleY, built.articleZ]],
    )).rows.map((row) => row.content_origin)).toEqual(["unresolved", "unresolved"]);
    // And S's own verdict is what gates the re-established row now: lapse S and
    // it is refused with 'file inspection required', the derived-and-lapsed
    // shape, rather than with the withheld shape.
    await lapseSource(client, reconciler.file.objectId);
    await role("authenticated", ids.owner, ids.ownerSession);
    expect(await denied(
      "select public.save_chapter_kb_article($1,'contract','Overtime','Article XII',"
      + "'Another rewrite.',array['quokka']::text[],'published',true,$2)",
      [built.articleX, ids.chapter],
    )).toBe("file inspection required");
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 300000);
