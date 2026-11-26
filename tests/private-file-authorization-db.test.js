// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.RUN_PRIVATE_FILE_AUTHORIZATION_DB_TESTS === "1" ? it : it.skip;
const authorize = "select public.authorize_private_upload_inspection($1,$2) value";
const finish = "select public.finish_private_upload_inspection($1,$2,$3,'ClamAV 1.5.4',28113,now(),clock_timestamp()) value";
const digest = "a".repeat(64);

databaseIt("derives four authorized file targets, enforces quotas and rejects stale or caller-written scan results", async () => {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect();
  await client.query("begin");
  const ids = Object.fromEntries(["actor", "outsider", "peer", "session", "otherSession", "peerSession", "org", "otherOrg", "case", "task", "form"].map((key) => [key, randomUUID()]));
  const chapter = `upload-proof-${ids.org}`;
  const otherChapter = `upload-proof-${ids.otherOrg}`;
  const role = async (name, actor = ids.actor, session = ids.session, aal = "aal2") => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: name, sub: actor, session_id: session, aal })]);
    await client.query(`set local role ${name}`);
  };
  let savepoint = 0;
  const denied = async (statement, params, expected = "42501") => {
    const label = `upload_denied_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    let caught;
    try { await client.query(statement, params); } catch (error) { caught = error; }
    finally { await client.query(`rollback to savepoint ${label}`); await client.query(`release savepoint ${label}`); }
    expect(caught?.code).toBe(expected);
    return caught.message;
  };
  try {
    await client.query("select public.authorize_private_upload_inspection(null,null)").catch((error) => {
      // A missing function is a real red test; do not let it become a skip.
      if (error.code === "42883") throw error;
    });
    // Reset the intentional pre-auth rejection before creating rollback-only fixtures.
    await client.query("rollback"); await client.query("begin");
    for (const [user, session, org, selectedChapter] of [[ids.actor, ids.session, ids.org, chapter], [ids.outsider, ids.otherSession, ids.otherOrg, otherChapter]]) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic upload factor','totp','verified',now(),now())", [randomUUID(), user]);
      await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, `upload-proof-${org}`, user]);
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9900)", [selectedChapter, org]);
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, selectedChapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, selectedChapter]);
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [org, user]);
      await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
    }
    // Same organization and chapter as the actor, with an aal2 session and a
    // verified factor, but no organization_role_grants row and no owned file.
    // require_staff_mfa is already true on this org; mfa_satisfied() does not
    // consult it, so this peer's case refusal stays the merged row answer.
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [ids.peer, `${ids.peer}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids.peerSession, ids.peer]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic upload factor','totp','verified',now(),now())", [randomUUID(), ids.peer]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, ids.peer]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ids.peer, chapter]);
    expect((await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.peer, chapter])).rowCount).toBe(1);
    await client.query("insert into public.member_cases(id,user_id,reference,title,case_type) values($1,$2,$3,'Synthetic upload case','other')", [ids.case, ids.actor, `UPLOAD-${ids.case}`]);
    await client.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [chapter, ids.actor]);
    await role("postgres");
    await client.query("insert into public.chapter_tasks(id,chapter_id,title,created_by,updated_by) values($1,$2,'Synthetic upload task',$3,$3)", [ids.task, chapter, ids.actor]);
    await client.query("insert into public.member_forms(id,user_id,template_key) values($1,$2,'grievance')", [ids.form, ids.actor]);
    await role("authenticated");
    const files = [];
    // Case and task seed through the two-phase checkpoints. 20260906023000
    // gates the legacy one-step registrations on a current verdict, which no
    // object can hold at registration time, so they now fail closed for every
    // caller. The form kind keeps its registration RPC, which is ungated by
    // design: it leaves confirmed_at null and the gate lives in
    // confirm_member_form_file.
    for (const [kind, statement, params] of [
      ["case", "select public.begin_member_case_file_upload($1,$2,'synthetic.txt','text/plain',9) value", [randomUUID(), ids.case]],
      ["task", "select public.begin_chapter_task_file_upload($1,$2,'synthetic.txt','text/plain',9) value", [randomUUID(), ids.task]],
      ["form", "select public.register_member_form_file($1,'synthetic.txt','text/plain',9) value", [ids.form]],
    ]) {
      const row = (await client.query(statement, params)).rows[0].value;
      files.push({ kind, id: row.id, bucket: row.bucketId, path: row.objectName });
    }
    const prepared = (await client.query("select public.prepare_steward_library_upload('synthetic.txt',9,$1,'Synthetic upload','Authorization proof','contract',$2,$3) value", [digest, randomUUID(), chapter])).rows[0].value;
    const storage = (await client.query("select public.get_knowledge_file_storage_target($1,$2,'upload') value", [prepared.fileId, prepared.storageHandle])).rows[0].value;
    files.push({ kind: "knowledge", id: prepared.fileId, bucket: storage.bucketId, path: storage.objectName });
    await role("postgres");
    for (const file of files) {
      const object = (await client.query("insert into storage.objects(bucket_id,name,owner,version,metadata) values($1,$2,$3,'synthetic-version','{\"size\":9,\"mimetype\":\"text/plain\"}') returning id", [file.bucket, file.path, ids.actor])).rows[0];
      file.objectId = object.id;
    }

    // These use the deployed feature helpers, with two separate organizations.
    // A claim that pairs this actor with somebody else's session id does not
    // satisfy MFA, which since 20260906024000 answers as the caller-scoped
    // refusal it always was rather than borrowing the row-shaped one. It still
    // grants nothing at all.
    await role("authenticated", ids.actor, ids.otherSession);
    expect((await client.query(authorize, ["case", files[0].id])).rows[0].value)
      .toEqual({ reauthRequired: true });
    // The outsider's own matched session IS MFA-satisfied, so everything below
    // is a genuine tenancy refusal: unknown and foreign answer identically.
    await role("authenticated", ids.outsider, ids.otherSession);
    const missing = await denied(authorize, ["case", randomUUID()]);
    for (const file of files) expect(await denied(authorize, [file.kind, file.id])).toBe(missing);
    // A stale MFA session is a fact about the CALLER, decided before p_file_id
    // is looked at, so since 20260906024000 it answers distinctly rather than
    // wearing the same refusal an unknown or foreign row wears. It still grants
    // nothing: no attempt, no quota charge, no target.
    await role("authenticated", ids.actor, ids.session, "aal1");
    expect((await client.query(authorize, ["case", files[0].id])).rows[0].value)
      .toEqual({ reauthRequired: true });
    expect((await client.query(authorize, ["case", randomUUID()])).rows[0].value)
      .toEqual({ reauthRequired: true });
    // Callers that are not an authenticated end user at all are still refused
    // outright, and the row-shaped refusals above stay indistinguishable.
    await role("anon"); await denied(authorize, ["case", files[0].id]);
    await role("service_role"); await denied(authorize, ["case", files[0].id]);

    for (const file of files) {
      await role("authenticated");
      const target = (await client.query(authorize, [file.kind, file.id])).rows[0].value;
      expect(target).toMatchObject({ fileId: file.id, bucketId: file.bucket, objectName: file.path, objectId: file.objectId,
        objectVersion: "synthetic-version", filename: "synthetic.txt", mimeType: "text/plain", sizeBytes: 9, current: false });
      expect((await client.query(authorize, [file.kind, file.id])).rows[0].value).toEqual({ busy: true });
      await denied(finish, [target.attemptId, "clean", digest]);
      await role("service_role");
      expect((await client.query(finish, [target.attemptId, "clean", digest])).rows[0].value.status).toBe("clean");
      await denied(finish, [target.attemptId, "failed", null], "22023");
      await role("authenticated");
      expect((await client.query(authorize, [file.kind, file.id])).rows[0].value).toEqual({ fileId: file.id, current: true });
    }
    // Confirm the case and task rows so the peer hits the ownership-or-staff
    // condition, not the pending-upload gate. can_read_chapter_task_object
    // then admits any member of the task chapter, with or without a role.
    await role("authenticated");
    expect((await client.query("select public.confirm_member_case_file_upload($1) value", [files[0].id])).rows[0].value.confirmedAt).toBeTruthy();
    expect((await client.query("select public.confirm_chapter_task_file_upload($1) value", [files[1].id])).rows[0].value.confirmedAt).toBeTruthy();
    await role("postgres");
    expect((await client.query("select count(*)::int as n from public.organization_role_grants where user_id=$1", [ids.peer])).rows[0].n).toBe(0);
    await role("authenticated", ids.peer, ids.peerSession);
    expect(await denied(authorize, ["case", files[0].id])).toBe(missing);
    expect((await client.query(authorize, ["task", files[1].id])).rows[0].value).toEqual({ fileId: files[1].id, current: true });
    await role("postgres");
    expect((await client.query("select hour_count from private.private_upload_inspection_limits where user_id=$1", [ids.actor])).rows[0].hour_count).toBe(4);
    const file = files[0];
    await client.query("update private.private_upload_scans set status='pending',clean_until=null where object_id=$1", [file.objectId]);
    await role("authenticated");
    const old = (await client.query(authorize, [file.kind, file.id])).rows[0].value;
    await role("postgres");
    await client.query("update private.private_upload_inspection_attempts set expires_at=now()-interval '1 second' where id=$1", [old.attemptId]);
    await role("authenticated");
    const latest = (await client.query(authorize, [file.kind, file.id])).rows[0].value;
    expect(latest.attemptId).not.toBe(old.attemptId);
    await role("service_role");
    await denied(finish, [old.attemptId, "clean", digest], "22023");
    expect((await client.query(finish, [latest.attemptId, "failed", null])).rows[0].value.status).toBe("failed");

    await role("postgres");
    await client.query("update private.private_upload_inspection_limits set hour_count=20 where user_id=$1", [ids.actor]);
    await role("authenticated");
    expect((await client.query(authorize, [file.kind, file.id])).rows[0].value).toEqual({ rateLimited: true });
    await role("postgres");
    await client.query("update private.private_upload_inspection_limits set hour_started=now()-interval '2 hours' where user_id=$1", [ids.actor]);
    await role("authenticated");
    const last = (await client.query(authorize, [file.kind, file.id])).rows[0].value;
    expect(last.attemptId).toBeTruthy();
    await role("postgres");
    // These are rollback-only SQL metadata fixtures with no backing bytes.
    // Real byte deletion is covered by the separate Storage API proof.
    await client.query("select set_config('storage.allow_delete_query','true',true)");
    await client.query("delete from storage.objects where id=$1", [file.objectId]);
    await role("service_role"); await denied(finish, [last.attemptId, "clean", digest], "22023");
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 60000);
