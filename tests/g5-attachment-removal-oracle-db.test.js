// @vitest-environment node
import pg from "pg";
import { expect, it } from "vitest";

const databaseIt = process.env.RUN_G5_ATTACHMENT_REMOVAL_ORACLE_DB_TESTS === "1" ? it : it.skip;

const ids = {
  owner: "50960000-0000-4000-8000-000000000001",
  outsider: "50960000-0000-4000-8000-000000000002",
  ownerSession: "50960000-0000-4000-8000-000000000011",
  outsiderSession: "50960000-0000-4000-8000-000000000012",
  organization: "50960000-0000-4000-8000-000000000021",
  chapter: "g5-attachment-proof-chapter",
  case: "50960000-0000-4000-8000-000000000101",
  task: "50960000-0000-4000-8000-000000000102",
  directFile: "50960000-0000-4000-8000-000000000201",
  reconciledFile: "50960000-0000-4000-8000-000000000202",
  pendingCaseFile: "50960000-0000-4000-8000-000000000203",
  pendingTaskFile: "50960000-0000-4000-8000-000000000204",
  missingTaskFile: "50960000-0000-4000-8000-000000000298",
  missingFile: "50960000-0000-4000-8000-000000000299",
  ownerRemoval: "50960000-0000-4000-8000-000000000301",
  serviceRemoval: "50960000-0000-4000-8000-000000000302",
  outsiderRemoval: "50960000-0000-4000-8000-000000000399",
};

function claims(userId, sessionId) {
  return { sub: userId, session_id: sessionId, role: "authenticated", aal: "aal2" };
}

async function asRole(client, role, jwt = { role }) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(jwt)]);
  await client.query(`set local role ${role}`);
}

let savepointSequence = 0;
async function unavailable(client, statement, values) {
  savepointSequence += 1;
  const savepoint = `g5_attachment_unavailable_${savepointSequence}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(statement, values);
    throw new Error("expected attachment RPC to reject an unavailable file");
  } catch (error) {
    expect(error.code, error.message).toBe("22023");
    return { code: error.code, message: error.message };
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

databaseIt("makes unknown and unauthorized attachment IDs indistinguishable while preserving caller-owned retries", async () => {
  const rawUrl = process.env.SUPABASE_DB_URL;
  expect(rawUrl).toBeTruthy();
  const url = new URL(rawUrl);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);

  const client = new pg.Client({
    connectionString: rawUrl,
    application_name: "g5-attachment-removal-oracle-rollback-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    await client.query(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ($1, 'g5-attachment-owner@example.invalid', '{}'::jsonb),
        ($2, 'g5-attachment-outsider@example.invalid', '{}'::jsonb)
    `, [ids.owner, ids.outsider]);
    await client.query(`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
        ($1, $3, now(), now(), 'aal2'),
        ($2, $4, now(), now(), 'aal2')
    `, [ids.ownerSession, ids.outsiderSession, ids.owner, ids.outsider]);
    await client.query(`
      insert into public.organizations (id, slug, name, created_by)
      values ($1, 'g5-attachment-proof', 'G5 Attachment Proof', $2)
    `, [ids.organization, ids.owner]);
    await client.query(`
      insert into public.chapters
        (id, name, slug, region, is_default, order_index, organization_id)
      values ($1, 'G5 Attachment Proof Chapter', $1, 'proof-region', false, 9601, $2)
    `, [ids.chapter, ids.organization]);
    await client.query(`
      insert into public.organization_memberships (organization_id, user_id, status)
      values ($1, $2, 'active'), ($1, $3, 'active')
    `, [ids.organization, ids.owner, ids.outsider]);
    await client.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status)
      values ($1, $3, 'active'), ($2, $3, 'active')
    `, [ids.owner, ids.outsider, ids.chapter]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = any($1::uuid[])", [
      [ids.owner, ids.outsider],
      ids.chapter,
    ]);
    await client.query(`
      insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
      values ($1, $2, 'steward', $2)
    `, [ids.organization, ids.outsider]);
    await client.query(`
      insert into public.chapter_workstreams (chapter_id, name, created_by)
      values ($1, 'General', $2)
    `, [ids.chapter, ids.owner]);
    await client.query(`
      insert into public.member_cases (id, user_id, reference, title, case_type)
      values ($1, $2, 'G5-ORACLE-PROOF', 'G5 attachment proof', 'other')
    `, [ids.case, ids.owner]);
    await client.query(`
      insert into public.member_case_files
        (id, case_id, user_id, object_name, filename, mime_type, size_bytes,
         uploaded_by, confirmed_at)
      values
        ($1::uuid, $3::uuid, $4::uuid,
         pg_catalog.concat_ws('/', $4::text, $3::text, $1::text, 'direct.pdf'),
         'direct.pdf', 'application/pdf', 128, $4, now()),
        ($2::uuid, $3::uuid, $4::uuid,
         pg_catalog.concat_ws('/', $4::text, $3::text, $2::text, 'service.pdf'),
         'service.pdf', 'application/pdf', 128, $4, now())
    `, [ids.directFile, ids.reconciledFile, ids.case, ids.owner]);

    await asRole(client, "postgres", claims(ids.owner, ids.ownerSession));
    await client.query(`
      insert into public.chapter_tasks (id, chapter_id, title, created_by, updated_by)
      values ($1, $2, 'G5 upload abort oracle proof', $3, $3)
    `, [ids.task, ids.chapter, ids.owner]);
    await client.query(`
      insert into public.member_case_files
        (id, case_id, user_id, object_name, filename, mime_type, size_bytes,
         uploaded_by, confirmed_at, cleanup_requested_at)
      values
        ($1::uuid, $2::uuid, $3::uuid,
         pg_catalog.concat_ws('/', $3::uuid::text, $2::uuid::text, $1::uuid::text, 'pending-case.pdf'),
         'pending-case.pdf', 'application/pdf', 128, $3::uuid, null, null)
    `, [ids.pendingCaseFile, ids.case, ids.owner]);
    await client.query(`
      insert into public.chapter_task_files
        (id, task_id, chapter_id, object_name, filename, mime_type, size_bytes,
         uploaded_by, confirmed_at, cleanup_requested_at)
      values
        ($1::uuid, $2::uuid, $3::text,
         pg_catalog.concat_ws('/', $3::text, $2::uuid::text, $1::uuid::text, 'pending-task.pdf'),
         'pending-task.pdf', 'application/pdf', 128, $4::uuid, null, null)
    `, [ids.pendingTaskFile, ids.task, ids.chapter, ids.owner]);

    await asRole(client, "authenticated", claims(ids.outsider, ids.outsiderSession));
    const abortCaseExisting = (await client.query(
      "select public.abort_member_case_file_upload($1) as value",
      [ids.pendingCaseFile],
    )).rows[0].value;
    const abortCaseMissing = (await client.query(
      "select public.abort_member_case_file_upload($1) as value",
      [ids.missingFile],
    )).rows[0].value;
    expect(abortCaseExisting).toMatchObject({ deleted: false, absent: true, id: ids.pendingCaseFile });
    expect({ ...abortCaseExisting, id: null }).toEqual({ ...abortCaseMissing, id: null });

    const abortTaskExisting = (await client.query(
      "select public.abort_chapter_task_file_upload($1) as value",
      [ids.pendingTaskFile],
    )).rows[0].value;
    const abortTaskMissing = (await client.query(
      "select public.abort_chapter_task_file_upload($1) as value",
      [ids.missingTaskFile],
    )).rows[0].value;
    expect(abortTaskExisting).toMatchObject({ deleted: false, absent: true, id: ids.pendingTaskFile });
    expect({ ...abortTaskExisting, id: null }).toEqual({ ...abortTaskMissing, id: null });

    await asRole(client, "postgres");
    const pendingRowsRemain = (await client.query(`
      select
        exists(select 1 from public.member_case_files where id = $1) as case_file,
        exists(select 1 from public.chapter_task_files where id = $2) as task_file
    `, [ids.pendingCaseFile, ids.pendingTaskFile])).rows[0];
    expect(pendingRowsRemain).toEqual({ case_file: true, task_file: true });

    await asRole(client, "authenticated", claims(ids.outsider, ids.outsiderSession));
    const requestExisting = await unavailable(
      client,
      "select public.request_member_case_file_removal($1, $2)",
      [ids.directFile, ids.outsiderRemoval],
    );
    const requestMissing = await unavailable(
      client,
      "select public.request_member_case_file_removal($1, $2)",
      [ids.missingFile, ids.outsiderRemoval],
    );
    expect(requestExisting).toEqual(requestMissing);

    const finalizeExisting = await unavailable(
      client,
      "select public.finalize_member_case_file_removal($1, $2)",
      [ids.directFile, ids.outsiderRemoval],
    );
    const finalizeMissing = await unavailable(
      client,
      "select public.finalize_member_case_file_removal($1, $2)",
      [ids.missingFile, ids.outsiderRemoval],
    );
    expect(finalizeExisting).toEqual(finalizeMissing);

    await asRole(client, "authenticated", claims(ids.owner, ids.ownerSession));
    const requested = (await client.query(
      "select public.request_member_case_file_removal($1, $2) as value",
      [ids.directFile, ids.ownerRemoval],
    )).rows[0].value;
    expect(requested).toMatchObject({ id: ids.directFile, removalId: ids.ownerRemoval });
    const finalized = (await client.query(
      "select public.finalize_member_case_file_removal($1, $2) as value",
      [ids.directFile, ids.ownerRemoval],
    )).rows[0].value;
    expect(finalized).toMatchObject({ deleted: true, absent: false, id: ids.directFile });

    for (const functionName of [
      "request_member_case_file_removal",
      "finalize_member_case_file_removal",
    ]) {
      const replay = (await client.query(
        `select public.${functionName}($1, $2) as value`,
        [ids.directFile, ids.ownerRemoval],
      )).rows[0].value;
      expect(replay).toMatchObject({ deleted: false, absent: true, id: ids.directFile });
    }

    await asRole(client, "authenticated", claims(ids.outsider, ids.outsiderSession));
    expect(await unavailable(
      client,
      "select public.finalize_member_case_file_removal($1, $2)",
      [ids.directFile, ids.ownerRemoval],
    )).toEqual(finalizeMissing);

    await asRole(client, "postgres");
    await client.query(`
      update public.member_case_files
      set removal_id = $2,
          removal_requested_at = now() - interval '20 minutes',
          removal_requested_by = $3
      where id = $1
    `, [ids.reconciledFile, ids.serviceRemoval, ids.owner]);
    await asRole(client, "service_role");
    const report = (await client.query(
      "select public.reconcile_chapter_task_files(0, '[]'::jsonb) as value",
    )).rows[0].value;
    expect(report.removalRowsRetired).toBeGreaterThanOrEqual(1);

    // UUIDs are caller supplied. Reusing the exact file/removal/caller tuple
    // while its 30-day receipt is still present must refresh that receipt and
    // return it from the reconciler CTE so the new tombstone cannot wedge.
    await asRole(client, "postgres");
    await client.query(`
      insert into public.member_case_files
        (id, case_id, user_id, object_name, filename, mime_type, size_bytes,
         uploaded_by, confirmed_at, removal_id, removal_requested_at, removal_requested_by)
      values
        ($1::uuid, $2::uuid, $3::uuid,
         pg_catalog.concat_ws('/', $3::text, $2::text, $1::text, 'service-reused.pdf'),
         'service-reused.pdf', 'application/pdf', 128, $3, now(),
         $4::uuid, now() - interval '20 minutes', $3)
    `, [ids.reconciledFile, ids.case, ids.owner, ids.serviceRemoval]);
    await client.query(`
      update private.attachment_removal_receipts
      set deleted_at = now() - interval '29 days'
      where file_kind = 'member_case'
        and file_id = $1 and removal_id = $2 and requested_by = $3
    `, [ids.reconciledFile, ids.serviceRemoval, ids.owner]);
    await asRole(client, "service_role");
    const reusedReport = (await client.query(
      "select public.reconcile_chapter_task_files(0, '[]'::jsonb) as value",
    )).rows[0].value;
    expect(reusedReport.removalRowsRetired).toBeGreaterThanOrEqual(1);
    await asRole(client, "postgres");
    const reusedState = (await client.query(`
      select
        exists(select 1 from public.member_case_files where id = $1) as file_exists,
        (select deleted_at > now() - interval '1 minute'
         from private.attachment_removal_receipts
         where file_kind = 'member_case'
           and file_id = $1 and removal_id = $2 and requested_by = $3) as receipt_refreshed
    `, [ids.reconciledFile, ids.serviceRemoval, ids.owner])).rows[0];
    expect(reusedState).toEqual({ file_exists: false, receipt_refreshed: true });

    await asRole(client, "authenticated", claims(ids.owner, ids.ownerSession));
    const reconciledReplay = (await client.query(
      "select public.finalize_member_case_file_removal($1, $2) as value",
      [ids.reconciledFile, ids.serviceRemoval],
    )).rows[0].value;
    expect(reconciledReplay).toMatchObject({
      deleted: false,
      absent: true,
      id: ids.reconciledFile,
      removalId: ids.serviceRemoval,
    });
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
