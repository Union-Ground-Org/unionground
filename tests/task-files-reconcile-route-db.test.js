// @vitest-environment node
// BUG-UG-REMOVED-ATTACHMENTS-NEVER-CLEANED-SERVER-SIDE-20261018.
// Disposable-stack proof of the server cleanup route for removed attachments:
// the identity-pinned tick configuration, the exact bearer the scheduled tick
// sends, and the reconciler retiring removal-requested case and task files
// only after their Storage objects are gone. Every case runs in one rolled-back
// transaction and never sends a network request: the tick command runs with
// net.http_post replaced by a transaction-local capture.
import pg from "pg";
import { expect, it } from "vitest";
import { PORTAL_ORIGIN, SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";

const databaseIt = process.env.RUN_TASK_FILES_RECONCILE_ROUTE_DB_TESTS === "1" ? it : it.skip;

const SAAS_ENDPOINT = `${PORTAL_ORIGIN}/api/task-files-reconcile`;
const DEMO_ENDPOINT = `${SAMPLE_ORIGIN}/api/task-files-reconcile`;
const RECONCILE_SECRET = "t".repeat(48);
const LEGACY_SECRET = "l".repeat(48);

const ids = {
  owner: "50970000-0000-4000-8000-000000000001",
  steward: "50970000-0000-4000-8000-000000000002",
  ownerSession: "50970000-0000-4000-8000-000000000011",
  organization: "50970000-0000-4000-8000-000000000021",
  chapter: "removed-attachment-proof-chapter",
  case: "50970000-0000-4000-8000-000000000101",
  task: "50970000-0000-4000-8000-000000000102",
  caseFile: "50970000-0000-4000-8000-000000000201",
  taskFile: "50970000-0000-4000-8000-000000000202",
  freshTaskFile: "50970000-0000-4000-8000-000000000203",
  caseRemoval: "50970000-0000-4000-8000-000000000301",
  taskRemoval: "50970000-0000-4000-8000-000000000302",
  freshRemoval: "50970000-0000-4000-8000-000000000303",
};

async function asRole(client, role, jwt = { role }) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(jwt)]);
  await client.query(`set local role ${role}`);
}

let savepointSequence = 0;
async function refusal(client, statement, values) {
  savepointSequence += 1;
  const savepoint = `task_files_route_refusal_${savepointSequence}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(statement, values);
    throw new Error(`expected refusal: ${statement}`);
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    return { code: error.code, message: error.message };
  } finally {
    await client.query(`release savepoint ${savepoint}`);
  }
}

async function inRollback(name, proof) {
  const rawUrl = process.env.SUPABASE_DB_URL;
  expect(rawUrl).toBeTruthy();
  const url = new URL(rawUrl);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  const client = new pg.Client({ connectionString: rawUrl, application_name: name });
  await client.connect();
  await client.query("begin");
  try {
    await asRole(client, "postgres");
    await client.query("update private.notification_controls set files_reconcile_url = null where id");
    await client.query("delete from vault.secrets where name in ('task-files-reconcile-secret', 'notifications-dispatch-secret')");
    await client.query("delete from private.demo_seed_installation_bindings");
    await proof(client);
  } finally {
    await client.query("rollback");
    await client.end();
  }
}

async function bindAsSample(client) {
  await asRole(client, "postgres");
  await client.query(`insert into private.demo_seed_installation_bindings(project_ref, system_identifier, database_oid)
    select 'sampledemoprojectref', c.system_identifier::numeric, d.oid
    from pg_control_system() c cross join pg_database d where d.datname = current_database()`);
}

async function controlState(client) {
  await asRole(client, "postgres");
  return (await client.query(`
    select c.files_reconcile_url,
      (select pg_catalog.array_agg(s.decrypted_secret) from vault.decrypted_secrets s
       where s.name = 'task-files-reconcile-secret') as secrets
    from private.notification_controls c where c.id
  `)).rows[0];
}

// Runs the scheduled command text itself with the outbound call swapped for a
// capture, so the proof covers exactly what pg_cron would execute.
async function runTickCapture(client) {
  await asRole(client, "postgres");
  const command = (await client.query(
    "select command from cron.job where jobname = 'task-files-reconcile-tick'",
  )).rows[0]?.command;
  expect(command).toContain("net.http_post(");
  await client.query("create temp table if not exists reconcile_tick_capture (url text, headers jsonb) on commit drop");
  await client.query("truncate reconcile_tick_capture");
  await client.query(`
    create or replace function pg_temp.capture_post(
      url text, headers jsonb, body jsonb, timeout_milliseconds integer
    ) returns bigint language sql as $capture$
      insert into reconcile_tick_capture values (url, headers);
      select 9000000000000 + (select count(*) from reconcile_tick_capture);
    $capture$
  `);
  await client.query(command.replace("net.http_post(", "pg_temp.capture_post("));
  return (await client.query("select url, headers from reconcile_tick_capture")).rows;
}

// This edition has no deployment endpoint to configure: both setup RPCs refuse
// for every caller and every database binding, before any Vault or control-row
// write (20261019100000; 20261015120000 for notification dispatch).
databaseIt("refuses to configure the reconcile tick or notification dispatch, and writes nothing", async () => {
  await inRollback("task-files-route-refusal-proof", async (client) => {
    await asRole(client, "authenticated", { role: "authenticated", sub: ids.owner });
    expect((await refusal(
      client,
      "select public.configure_task_files_reconcile($1, $2)",
      [SAAS_ENDPOINT, RECONCILE_SECRET],
    )).code).toBe("42501");
    for (const binding of ["unbound", "sample"]) {
      if (binding === "sample") await bindAsSample(client);
      await asRole(client, "service_role");
      for (const endpoint of [SAAS_ENDPOINT, DEMO_ENDPOINT]) {
        expect(await refusal(
          client,
          "select public.configure_task_files_reconcile($1, $2)",
          [endpoint, RECONCILE_SECRET],
        )).toEqual({ code: "55000", message: "task-files reconcile has no Union Ground endpoint to configure" });
      }
      expect((await refusal(
        client,
        "select public.configure_notification_dispatch($1, $2)",
        [`${SAMPLE_ORIGIN}/api/notifications-dispatch`, LEGACY_SECRET],
      )).message).toBe("notification dispatch has no Union Ground endpoint to configure");
      expect(await controlState(client)).toEqual({ files_reconcile_url: null, secrets: null });
    }
  });
});

// The setup RPC refuses in this edition (above), so the tick stays inert. The
// scheduled command still reads the control row and Vault, so its bearer
// choice is proved with both written directly by the database owner.
databaseIt("stays inert without a URL, sends the dedicated bearer, and falls back to the legacy name", async () => {
  await inRollback("task-files-route-tick-proof", async (client) => {
    await asRole(client, "postgres");
    await client.query("select vault.create_secret($1, 'notifications-dispatch-secret', 'proof legacy bearer')", [LEGACY_SECRET]);
    expect(await runTickCapture(client)).toEqual([]);
    expect((await refusal(client, "select public.configure_task_files_reconcile($1, $2)", [SAAS_ENDPOINT, RECONCILE_SECRET])).code)
      .toBe("55000");
    expect(await runTickCapture(client)).toEqual([]);

    await asRole(client, "postgres");
    await client.query("update private.notification_controls set files_reconcile_url = $1 where id", [SAAS_ENDPOINT]);
    await client.query("select vault.create_secret($1, 'task-files-reconcile-secret', 'proof dedicated bearer')", [RECONCILE_SECRET]);
    expect(await runTickCapture(client)).toEqual([{
      url: SAAS_ENDPOINT,
      headers: { Authorization: `Bearer ${RECONCILE_SECRET}`, "Content-Type": "application/json" },
    }]);

    await asRole(client, "postgres");
    await client.query("delete from vault.secrets where name = 'task-files-reconcile-secret'");
    expect((await runTickCapture(client)).map((row) => row.headers.Authorization))
      .toEqual([`Bearer ${LEGACY_SECRET}`]);
  });
});

databaseIt("retires removal-requested case and task files only after their objects are gone", async () => {
  await inRollback("task-files-route-removal-proof", async (client) => {
    await client.query(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ($1, 'removed-attachment-owner@example.invalid', '{}'::jsonb),
        ($2, 'removed-attachment-steward@example.invalid', '{}'::jsonb)
    `, [ids.owner, ids.steward]);
    await client.query(`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal)
      values ($1, $2, now(), now(), 'aal2')
    `, [ids.ownerSession, ids.owner]);
    await client.query(`
      insert into public.organizations (id, slug, name, created_by)
      values ($1, 'removed-attachment-proof', 'Removed Attachment Proof', $2)
    `, [ids.organization, ids.owner]);
    await client.query(`
      insert into public.chapters (id, name, slug, region, is_default, order_index, organization_id)
      values ($1, 'Removed Attachment Proof Chapter', $1, 'proof-region', false, 9701, $2)
    `, [ids.chapter, ids.organization]);
    await client.query(`
      insert into public.organization_memberships (organization_id, user_id, status)
      values ($1, $2, 'active'), ($1, $3, 'active')
    `, [ids.organization, ids.owner, ids.steward]);
    await client.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status)
      values ($1, $3, 'active'), ($2, $3, 'active')
    `, [ids.owner, ids.steward, ids.chapter]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = any($1::uuid[])", [
      [ids.owner, ids.steward],
      ids.chapter,
    ]);
    await client.query(`
      insert into public.chapter_workstreams (chapter_id, name, created_by)
      values ($1, 'General', $2)
    `, [ids.chapter, ids.owner]);
    await client.query(`
      insert into public.member_cases (id, user_id, reference, title, case_type)
      values ($1, $2, 'REMOVED-ATTACHMENT-PROOF', 'Removed attachment proof', 'other')
    `, [ids.case, ids.owner]);
    await asRole(client, "postgres", {
      role: "authenticated", sub: ids.owner, session_id: ids.ownerSession, aal: "aal2",
    });
    await client.query(`
      insert into public.chapter_tasks (id, chapter_id, title, created_by, updated_by)
      values ($1, $2, 'Removed attachment proof', $3, $3)
    `, [ids.task, ids.chapter, ids.owner]);

    await asRole(client, "postgres");
    const caseObject = `${ids.owner}/${ids.case}/${ids.caseFile}/scan.jpg`;
    const taskObject = `${ids.chapter}/${ids.task}/${ids.taskFile}/scan.jpg`;
    const freshObject = `${ids.chapter}/${ids.task}/${ids.freshTaskFile}/fresh.jpg`;
    await client.query(`
      insert into public.member_case_files
        (id, case_id, user_id, object_name, filename, mime_type, size_bytes, uploaded_by,
         confirmed_at, removal_id, removal_requested_at, removal_requested_by)
      values ($1, $2, $3, $4, 'scan.jpg', 'image/jpeg', 64, $3,
        now() - interval '1 hour', $5, now() - interval '20 minutes', $3)
    `, [ids.caseFile, ids.case, ids.owner, caseObject, ids.caseRemoval]);
    await client.query(`
      insert into public.chapter_task_files
        (id, task_id, chapter_id, object_name, filename, mime_type, size_bytes, uploaded_by,
         confirmed_at, removal_id, removal_requested_at, removal_requested_by)
      values
        ($1, $3, $4, $5, 'scan.jpg', 'image/jpeg', 64, $6,
         now() - interval '1 hour', $7, now() - interval '20 minutes', $6),
        ($2, $3, $4, $8, 'fresh.jpg', 'image/jpeg', 64, $6,
         now() - interval '1 hour', $9, now() - interval '5 minutes', $6)
    `, [ids.taskFile, ids.freshTaskFile, ids.task, ids.chapter, taskObject, ids.owner,
      ids.taskRemoval, freshObject, ids.freshRemoval]);
    for (const [bucket, name] of [
      ["case-files", caseObject],
      ["chapter-task-files", taskObject],
      ["chapter-task-files", freshObject],
    ]) {
      await client.query(
        "insert into storage.objects (bucket_id, name, owner, version, metadata) values ($1, $2, $3, 'removed-attachment-proof', $4::jsonb)",
        [bucket, name, ids.owner, JSON.stringify({ size: 64, mimetype: "image/jpeg" })],
      );
    }

    const caseTarget = { bucketId: "case-files", objectName: caseObject };
    const taskTarget = { bucketId: "chapter-task-files", objectName: taskObject };
    const freshTarget = { bucketId: "chapter-task-files", objectName: freshObject };

    await asRole(client, "service_role");
    const first = (await client.query("select public.reconcile_chapter_task_files(500) as value")).rows[0].value;
    expect(first.objectDeletes).toEqual(expect.arrayContaining([caseTarget, taskTarget]));
    expect(first.objectDeletes).not.toContainEqual(freshTarget);
    expect(first.removalObjectTotal).toBeGreaterThanOrEqual(2);

    await asRole(client, "postgres");
    const rowsWhileBytesRemain = (await client.query(`
      select
        exists(select 1 from public.member_case_files where id = $1) as case_file,
        exists(select 1 from public.chapter_task_files where id = $2) as task_file
    `, [ids.caseFile, ids.taskFile])).rows[0];
    expect(rowsWhileBytesRemain).toEqual({ case_file: true, task_file: true });

    // The endpoint deletes these through the Storage API; the disposable stack
    // stands in for that call with the catalog delete Storage itself performs.
    await client.query("select set_config('storage.allow_delete_query', 'true', true)");
    await client.query(
      "delete from storage.objects where (bucket_id, name) in (('case-files', $1), ('chapter-task-files', $2))",
      [caseObject, taskObject],
    );

    await asRole(client, "service_role");
    const second = (await client.query(
      "select public.reconcile_chapter_task_files(0, $1::jsonb) as value",
      [JSON.stringify([caseTarget, taskTarget])],
    )).rows[0].value;
    expect(second.expectedObjectsRemaining).toEqual([]);
    expect(second.removalRowsRetired).toBeGreaterThanOrEqual(2);

    await asRole(client, "postgres");
    const disposition = (await client.query(`
      select
        exists(select 1 from public.member_case_files where id = $1) as case_file,
        exists(select 1 from public.chapter_task_files where id = $2) as task_file,
        exists(select 1 from public.chapter_task_files where id = $3) as fresh_file,
        exists(select 1 from storage.objects where bucket_id = 'chapter-task-files' and name = $4) as fresh_object,
        (select count(*)::int from private.attachment_removal_receipts
         where (file_kind, file_id, removal_id, requested_by) in
           (('member_case', $1::uuid, $5::uuid, $7::uuid), ('chapter_task', $2::uuid, $6::uuid, $7::uuid))) as receipts,
        exists(select 1 from public.chapter_task_activity
         where task_id = $8 and action = 'file_removed' and from_value = 'scan.jpg') as activity
    `, [ids.caseFile, ids.taskFile, ids.freshTaskFile, freshObject, ids.caseRemoval,
      ids.taskRemoval, ids.owner, ids.task])).rows[0];
    expect(disposition).toEqual({
      case_file: false,
      task_file: false,
      fresh_file: true,
      fresh_object: true,
      receipts: 2,
      activity: true,
    });
  });
});
