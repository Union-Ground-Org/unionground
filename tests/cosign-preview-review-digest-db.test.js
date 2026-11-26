// @vitest-environment node
//
// BUG-UG-COSIGNER-SIGNATURE-COVERS-CONTENT-THE-PREVIEW-NEVER-SHOWED-20261114 (#8703).
// A co-signature covers the form exactly as it stood when the invitation
// preview was shown. respond_to_cosign signed the row as it stood when it took
// the form lock, so a filer save between the co-signer's preview and accept was
// co-signed unseen. cosign_invite_preview now returns reviewDigest (HMAC over
// the invitation id and the full content digest with a database-held key) and
// respond_to_cosign takes an optional p_expected_digest, compared under the
// form lock before anything is stored. Null keeps the previous behaviour.
//
// Full migrated disposable database only. Fixtures are fictional and committed
// to the owned stack, and removed afterwards.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const STEM = "cosign_preview_review_digest";
const SIG = "public.respond_to_cosign(p_form_id uuid, p_accept boolean, p_strokes jsonb, p_consent boolean, p_typed_name text DEFAULT NULL::text, p_expected_digest text DEFAULT NULL::text)";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("respond_to_cosign compares the previewed version (static)", () => {
  let migration = "";
  beforeAll(() => { migration = stripComments(loadMigrationSql(STEM)); });

  it("replaces the five-argument function with one whose sixth argument defaults to null, with the same grants", () => {
    expect(findMigrationName(STEM) > "20261113122500").toBe(true);
    expect(migration).toContain("drop function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text);");
    expect(migration).toContain("p_typed_name text default null, p_expected_digest text default null");
    expect(migration).toContain("revoke all on function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text, text) from public, anon;");
    expect(migration).toContain("grant execute on function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text, text) to authenticated, service_role;");
  });

  it("keeps the case-graph entry and compares under the form lock after the invitation is found, before anything is stored", () => {
    const respond = migration.slice(migration.indexOf("create function public.respond_to_cosign("));
    const at = (needle) => {
      const index = respond.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(at("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBeLessThan(at("private.mfa_satisfied()"));
    expect(at("perform private.lock_member_form(p_form_id);")).toBeLessThan(at("from public.member_form_cosigners c"));
    expect(at("'no pending co-sign invitation for you on this form'")).toBeLessThan(at("p_expected_digest is not null"));
    expect(at("detail = 'cosign_changed_since_preview'")).toBeLessThan(at("insert into private.member_form_signatures"));
    expect(at("detail = 'cosign_changed_since_preview'")).toBeLessThan(at("update public.member_form_cosigners"));
    expect(respond).toContain("private.cosign_review_digest(inv.id, current_digest)");
    expect(respond).toContain("errcode = 'PT409'");
  });

  it("keys the review digest with a database-held key no client role can read", () => {
    expect(migration).toContain("revoke all on private.cosign_review_digest_key from public, anon, authenticated, service_role;");
    expect(migration).toContain("extensions.gen_random_bytes(32)");
    expect(migration).toContain("extensions.hmac(");
    expect(migration).toContain("revoke all on function private.cosign_review_digest(uuid, text) from public, anon, authenticated, service_role;");
    const preview = migration.slice(migration.indexOf("create or replace function public.cosign_invite_preview("), migration.indexOf("drop function public.respond_to_cosign("));
    expect(preview.indexOf("private.member_pin_require_full_session()")).toBeLessThan(preview.indexOf("private.mfa_satisfied()"));
    expect(preview.indexOf("private.mfa_satisfied()")).toBeLessThan(preview.indexOf("from public.member_form_cosigners"));
    // The digest is read in the same statement as the answers (gate stage 173, r1s1 and r2s1).
    expect(preview).toMatch(/select f\.user_id, f\.template_key, f\.answers,\s+private\.form_content_digest\(f\.id\) as content_digest\s+into frec/);
    expect(preview).toContain("'reviewDigest', private.cosign_review_digest(inv.id, frec.content_digest)");
    expect(preview.match(/form_content_digest/g)).toHaveLength(1);
    // The preview still discloses only the summary and the filer's name.
    expect(preview).not.toMatch(/answers->>'(?:narrative|remedy|affected)'/);
  });

  it("pins the new signature in the database contract and the required proof lane", () => {
    const entry = contract.functions.find((row) => row.sig === "public.respond_to_cosign(p_form_id uuid, p_accept boolean, p_strokes jsonb, p_consent boolean, p_typed_name text, p_expected_digest text)");
    expect(entry?.exec).toBe("authenticated,service_role");
    expect(entry.bodyContains).toEqual(expect.arrayContaining(["cosign_changed_since_preview", "private.lock_member_form(p_form_id)", "if caller is null or not private.mfa_satisfied() then"]));
    for (const needle of entry.bodyContains) expect(migration, needle).toContain(needle);
    expect(contract.functions.some((row) => row.sig === "public.respond_to_cosign(p_form_id uuid, p_accept boolean, p_strokes jsonb, p_consent boolean, p_typed_name text)")).toBe(false);
    expect(contract.functionsAbsent.some((row) => row.sig === "public.respond_to_cosign(p_form_id uuid, p_accept boolean, p_strokes jsonb, p_consent boolean, p_typed_name text)")).toBe(true);
    expect(entry.bodyContains).toContain("private.normalize_form_typed_signature(p_typed_name)");
    const preview = contract.functions.find((row) => row.sig === "public.cosign_invite_preview(p_form_id uuid)");
    expect(preview.bodyContains).toEqual(expect.arrayContaining(["private.form_content_digest(f.id) as content_digest", "private.cosign_review_digest(inv.id, frec.content_digest)"]));
    expect(PROOF_FILES).toContain("tests/cosign-preview-review-digest-db.test.js");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("respond_to_cosign compares the previewed version on a disposable database", () => {
  let admin, filer, cosigner, second;
  const ids = {
    filer: randomUUID(), cosigner: randomUUID(), second: randomUUID(), org: randomUUID(),
    filerSession: randomUUID(), cosignerSession: randomUUID(), secondSession: randomUUID(),
  };
  const email = (id) => `${id}@cosign-preview-proof.invalid`;
  const chapter = `cosign-preview-${ids.org.slice(0, 8)}`;
  const strokes = JSON.stringify([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]);
  const forms = [];

  const claims = (who) => ({
    filer: { sub: ids.filer, session_id: ids.filerSession, email: email(ids.filer) },
    cosigner: { sub: ids.cosigner, session_id: ids.cosignerSession, email: email(ids.cosigner) },
    second: { sub: ids.second, session_id: ids.secondSession, email: email(ids.second) },
  })[who];
  const begin = async (client, who) => {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ ...claims(who), role: "authenticated", aal: "aal2" })]);
    await client.query("set local role authenticated");
  };
  const call = async (client, who, sql, values = []) => {
    await begin(client, who);
    try {
      const result = await client.query(sql, values);
      await client.query("commit");
      return { rows: result.rows };
    } catch (error) {
      await client.query("rollback");
      return { code: error.code, message: error.message, detail: error.detail };
    }
  };
  const ok = (result) => {
    expect(result.code, result.message).toBeUndefined();
    return result.rows[0];
  };
  const save = async (answers) => ok(await call(filer, "filer", "select public.save_form_draft('alliance_grievance',$1,0) id", [answers])).id;
  // save_form_draft without a form id updates the filer's newest open draft,
  // so each case starts from none.
  const newGrievance = async (summary) => {
    const open = (await admin.query("select id from public.member_forms where user_id=$1", [ids.filer])).rows.map((row) => row.id);
    for (const id of open) await discard(id);
    const formId = await save({ summary, narrative: `Fictional narrative for ${summary}` });
    forms.push(formId);
    for (const who of [ids.cosigner, ids.second]) {
      ok(await call(filer, "filer", "select public.invite_cosigner($1,$2) v", [formId, email(who)]));
    }
    return formId;
  };
  const preview = async (formId, client = cosigner, who = "cosigner") =>
    ok(await call(client, who, "select public.cosign_invite_preview($1) v", [formId])).v;
  const accept = (formId, expected, client = cosigner, who = "cosigner") => expected === undefined
    ? call(client, who, "select public.respond_to_cosign(p_form_id => $1, p_accept => true, p_strokes => $2::jsonb, p_consent => true) v", [formId, strokes])
    : call(client, who, "select public.respond_to_cosign(p_form_id => $1, p_accept => true, p_strokes => $2::jsonb, p_consent => true, p_expected_digest => $3) v", [formId, strokes, expected]);
  const state = async (formId, userEmail = email(ids.cosigner)) => (await admin.query(`select c.status, c.signature_digest,
      (select count(*)::int from private.member_form_signatures s where s.cosigner_id = c.id and s.signer_kind = 'cosigner') rows,
      (select s.content_digest from private.member_form_signatures s where s.cosigner_id = c.id and s.signer_kind = 'cosigner') signed_content,
      private.form_content_digest(c.form_id) content
    from public.member_form_cosigners c where c.form_id = $1 and c.invited_email = $2`, [formId, userEmail])).rows[0];
  const expectRefused = (result) => {
    expect(result.code, result.message).toBe("PT409");
    expect(result.detail).toBe("cosign_changed_since_preview");
  };
  const expectNothingStored = async (formId) => {
    const after = await state(formId);
    expect(after.status).toBe("invited");
    expect(after.signature_digest).toBeNull();
    expect(after.rows).toBe(0);
  };
  // Waits (bounded) until the given backend is blocked on a lock.
  const waitingOnLock = async (pid) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await admin.query("select wait_event_type = 'Lock' w from pg_stat_activity where pid=$1", [pid])).rows[0]?.w === true) return true;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    return false;
  };
  const discard = async (formId) => {
    await admin.query("delete from public.member_form_files where form_id=$1", [formId]);
    await admin.query("delete from private.private_upload_scans where object_name like $1", [`${formId}/%`]);
    await admin.query("begin; set local session_replication_role=replica");
    await admin.query("delete from storage.objects where bucket_id='member-form-files' and name like $1", [`${formId}/%`]);
    await admin.query("commit");
    await admin.query("delete from private.member_form_signatures where form_id=$1", [formId]);
    await admin.query("delete from public.member_form_cosigners where form_id=$1", [formId]);
    await admin.query("delete from public.member_forms where id=$1", [formId]);
  };

  // A confirmed, currently inspected attachment, installed the way the upload
  // pipeline leaves it (as in sign-member-form-expected-review-db.test.js).
  async function attach(formId, objectName) {
    await admin.query("begin");
    try {
      const object = (await admin.query(`insert into storage.objects(bucket_id,name,owner,version,metadata)
        values('member-form-files',$1,$2,'proof-version','{"size":1024,"mimetype":"application/pdf"}') returning id`, [objectName, ids.filer])).rows[0].id;
      await admin.query(`insert into private.private_upload_scans(bucket_id,object_name,object_id,object_version,status,sha256,engine,signature_version,signature_updated_at,scanned_at,clean_until)
        values('member-form-files',$1,$2,'proof-version','clean',repeat('a',64),'clamav',1,now(),now(),now() + interval '1 day')
        on conflict (bucket_id, object_name) do update set object_id=excluded.object_id, object_version=excluded.object_version, status='clean', sha256=excluded.sha256,
          engine=excluded.engine, signature_version=excluded.signature_version, signature_updated_at=excluded.signature_updated_at, scanned_at=excluded.scanned_at, clean_until=excluded.clean_until, deleted_at=null`, [objectName, object]);
      await admin.query(`insert into public.member_form_files(form_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
        values($1,$2,'statement.pdf','application/pdf',1024,$3,now())`, [formId, objectName, ids.filer]);
      await admin.query("commit");
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
  }

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    [admin, filer, cosigner, second] = [0, 1, 2, 3].map(() => new pg.Client({ connectionString: url }));
    await Promise.all([admin.connect(), filer.connect(), cosigner.connect(), second.connect()]);
    await admin.query("begin");
    for (const [user, session] of [[ids.filer, ids.filerSession], [ids.cosigner, ids.cosignerSession], [ids.second, ids.secondSession]]) {
      await admin.query("insert into auth.users(id,email) values($1,$2)", [user, email(user)]);
      await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,$4)", [ids.org, chapter, `Fictional Co-sign Proof Local ${chapter}`, ids.filer]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9909)", [chapter, ids.org]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [ids.org]);
    for (const user of [ids.filer, ids.cosigner, ids.second]) {
      await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, user]);
      await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [user, chapter]);
      await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    await admin.query("update public.member_profiles set full_name='Fictional Filer' where id=$1", [ids.filer]);
    await admin.query("commit");
  });

  afterAll(async () => {
    try {
      const owned = (await admin.query("select id from public.member_forms where user_id=$1", [ids.filer])).rows.map((row) => row.id);
      // Best effort: the disposable stack is torn down after the run anyway.
      for (const formId of new Set([...forms, ...owned])) await discard(formId).catch(() => {});
    } finally {
      await Promise.all([admin, filer, cosigner, second].map((client) => client?.end()));
    }
  });

  it("exposes only the six-argument function, and no client role reaches the key or the digest helper", async () => {
    const row = (await admin.query(`select to_regprocedure('public.respond_to_cosign(uuid,boolean,jsonb,boolean,text)') old,
      pg_get_function_arguments('public.respond_to_cosign(uuid,boolean,jsonb,boolean,text,text)'::regprocedure) args,
      has_function_privilege('anon','public.respond_to_cosign(uuid,boolean,jsonb,boolean,text,text)','execute') anon,
      has_function_privilege('authenticated','public.respond_to_cosign(uuid,boolean,jsonb,boolean,text,text)','execute') authed,
      has_function_privilege('anon','public.cosign_invite_preview(uuid)','execute') preview_anon,
      has_function_privilege('authenticated','public.cosign_invite_preview(uuid)','execute') preview_authed`)).rows[0];
    expect(row.old).toBeNull();
    expect(`public.respond_to_cosign(${row.args})`).toBe(SIG);
    expect([row.anon, row.authed, row.preview_anon, row.preview_authed]).toEqual([false, true, false, true]);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const reach = (await admin.query(`select has_table_privilege($1,'private.cosign_review_digest_key','select') key_read,
        has_function_privilege($1,'private.cosign_review_digest(uuid,text)','execute') helper`, [role])).rows[0];
      expect(reach, role).toEqual({ key_read: false, helper: false });
    }
  });

  it("co-signs when the stored form is the previewed one, and the preview still shows only the summary and the filer", async () => {
    const formId = await newGrievance("Fictional overtime rotation skipped");
    const shown = await preview(formId);
    expect(Object.keys(shown).sort()).toEqual(["filerName", "formId", "inviteStatus", "reviewDigest", "summary", "template"]);
    expect(shown.reviewDigest).toMatch(/^[0-9a-f]{64}$/);
    const accepted = ok(await accept(formId, shown.reviewDigest)).v;
    expect(accepted.status).toBe("accepted");
    const after = await state(formId);
    expect(after.status).toBe("accepted");
    expect(after.rows).toBe(1);
    // The co-signature still covers the full content digest approval checks.
    expect(after.signed_content).toBe(after.content);
  });

  it("refuses a filer save between the preview and the accept, and stores no co-signature", async () => {
    const formId = await newGrievance("Fictional schedule change without notice");
    const shown = await preview(formId);
    await save({ summary: "Fictional schedule change without notice", narrative: "Fictional narrative, edited after the invitation" });
    expectRefused(await accept(formId, shown.reviewDigest));
    await expectNothingStored(formId);
    // The fresh preview co-signs.
    const fresh = await preview(formId);
    expect(fresh.reviewDigest).not.toBe(shown.reviewDigest);
    expect(ok(await accept(formId, fresh.reviewDigest)).v.status).toBe("accepted");
    expect((await state(formId)).rows).toBe(1);
  });

  it("pairs the summary with the digest of its own version when a save commits while the preview runs", async () => {
    // Gate stage 173 (r1s1, r2s1): the preview read the answers and the digest
    // in two statements, so a save committed between them returned summary A
    // with the digest of version B. Another session holds the member profiles
    // table, which the preview reads after the answers, so the preview stops
    // there while the filer's save commits.
    const formId = await newGrievance("Fictional race summary A");
    await second.query("begin");
    await second.query("lock table public.member_profiles in access exclusive mode");
    const cosignerPid = (await cosigner.query("select pg_backend_pid() pid")).rows[0].pid;
    const pending = preview(formId);
    try {
      expect(await waitingOnLock(cosignerPid)).toBe(true);
      await save({ summary: "Fictional race summary B", narrative: "Fictional narrative, saved while the preview ran" });
    } finally {
      await second.query("commit");
    }
    const shown = await pending;
    expect(shown.summary).toBe("Fictional race summary A");
    // The digest names version A, so against the stored version B it refuses.
    expectRefused(await accept(formId, shown.reviewDigest));
    await expectNothingStored(formId);
    const fresh = await preview(formId);
    expect(fresh.summary).toBe("Fictional race summary B");
    expect(ok(await accept(formId, fresh.reviewDigest)).v.status).toBe("accepted");
  });

  it("refuses an accept that waited on the form lock while the filer saved", async () => {
    const formId = await newGrievance("Fictional seniority bypass");
    const shown = await preview(formId);
    // The filer's save holds the form lock, uncommitted.
    await begin(filer, "filer");
    await filer.query("select public.save_form_draft('alliance_grievance',$1,0)", [{ summary: "Fictional seniority bypass", narrative: "Fictional narrative, saved while the co-signer signed" }]);
    const cosignerPid = (await cosigner.query("select pg_backend_pid() pid")).rows[0].pid;
    const pending = accept(formId, shown.reviewDigest);
    expect(await waitingOnLock(cosignerPid)).toBe(true);
    await filer.query("commit");
    expectRefused(await pending);
    await expectNothingStored(formId);
  });

  it("refuses when an attachment was confirmed after the preview", async () => {
    const formId = await newGrievance("Fictional missed break");
    const shown = await preview(formId);
    await attach(formId, `${formId}/statement.pdf`);
    expectRefused(await accept(formId, shown.reviewDigest));
    await expectNothingStored(formId);
  });

  it("binds the value to the invitation: one co-signer's digest does not sign for another, and it is not the content digest", async () => {
    const formId = await newGrievance("Fictional unpaid call-in");
    const mine = await preview(formId);
    const theirs = await preview(formId, second, "second");
    expect(mine.reviewDigest).not.toBe(theirs.reviewDigest);
    const { content } = await state(formId);
    expect(mine.reviewDigest).not.toBe(content);
    // Not a bare hash a client could rebuild from the content digest and its
    // invitation id: only the database-held key makes it.
    const invitation = (await admin.query("select id from public.member_form_cosigners where form_id=$1 and invited_email=$2", [formId, email(ids.cosigner)])).rows[0].id;
    expect(mine.reviewDigest).not.toBe(createHash("sha256").update(`cosign-review:${invitation}:${content}`).digest("hex"));
    expectRefused(await accept(formId, theirs.reviewDigest));
    await expectNothingStored(formId);
    expect(ok(await accept(formId, theirs.reviewDigest, second, "second")).v.status).toBe("accepted");
  });

  it("refuses a reaffirmation with the version before the filer's edit, and takes the one after it", async () => {
    const formId = await newGrievance("Fictional shift swap denied");
    ok(await accept(formId, (await preview(formId)).reviewDigest));
    const before = await preview(formId);
    await save({ summary: "Fictional shift swap denied", narrative: "Fictional narrative, edited after the co-signature" });
    expect((await state(formId)).status).toBe("reaffirm_needed");
    const refused = await accept(formId, before.reviewDigest);
    expectRefused(refused);
    expect((await state(formId)).status).toBe("reaffirm_needed");
    const fresh = await preview(formId);
    expect(fresh.inviteStatus).toBe("reaffirm_needed");
    expect(ok(await accept(formId, fresh.reviewDigest)).v.status).toBe("accepted");
    const after = await state(formId);
    expect(after.signed_content).toBe(after.content);
  });

  it("checks a typed co-signature (#8701) the same way", async () => {
    const formId = await newGrievance("Fictional typed co-signature");
    const shown = await preview(formId);
    const typed = (expected) => call(cosigner, "cosigner", `select public.respond_to_cosign(p_form_id => $1, p_accept => true, p_strokes => null,
      p_consent => true, p_typed_name => 'Fictional Co Signer', p_expected_digest => $2) v`, [formId, expected]);
    await save({ summary: "Fictional typed co-signature", narrative: "Fictional narrative, edited before the typed accept" });
    expectRefused(await typed(shown.reviewDigest));
    await expectNothingStored(formId);
    const accepted = ok(await typed((await preview(formId)).reviewDigest)).v;
    expect([accepted.status, accepted.signatureKind]).toEqual(["accepted", "typed"]);
    const after = await state(formId);
    expect(after.signed_content).toBe(after.content);
  });

  it("keeps the previous behaviour without the argument, and a decline never needs it", async () => {
    const formId = await newGrievance("Fictional posting skipped");
    const shown = await preview(formId);
    await save({ summary: "Fictional posting skipped", narrative: "Fictional narrative, edited before a shipped build accepts" });
    // A store build that sends only the four named arguments co-signs the row as it stands.
    expect(ok(await accept(formId)).v.status).toBe("accepted");
    expect((await state(formId)).rows).toBe(1);
    // The second co-signer declines with a stale value: a decline is not refused.
    const declined = await call(second, "second", "select public.respond_to_cosign(p_form_id => $1, p_accept => false, p_strokes => null, p_consent => false, p_expected_digest => $2) v", [formId, shown.reviewDigest]);
    expect(ok(declined).v.status).toBe("declined");
  });
});
