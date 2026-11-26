import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { assertDisposableProofUrl, assertDisposableStorageStatus } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";
import { scopeFixtureSteward } from "../tests/helpers/steward-unit-fixtures.js";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  filer: "50900000-0000-4000-8000-000000000111",
  cosigner: "50900000-0000-4000-8000-000000000112",
  other: "50900000-0000-4000-8000-000000000113",
  steward: "50900000-0000-4000-8000-000000000114",
  acceptForm: "50900000-0000-4000-8000-000000000211",
  withdrawForm: "50900000-0000-4000-8000-000000000212",
  inviteForm: "50900000-0000-4000-8000-000000000213",
  deletionForm: "50900000-0000-4000-8000-000000000214",
  pendingApprovalForm: "50900000-0000-4000-8000-000000000215",
  expectationForm: "50900000-0000-4000-8000-000000000216",
  acceptCosigner: "50900000-0000-4000-8000-000000000311",
  withdrawCosigner: "50900000-0000-4000-8000-000000000312",
  deletionFile: "50900000-0000-4000-8000-000000000411",
  pendingApprovalFile: "50900000-0000-4000-8000-000000000412",
  organization: "50900000-0000-4000-8000-000000000511",
};
// The proof owns its organization and chapter: the agency chapters it once
// borrowed were retired (20261018060300), and a chapter needs an owner (#8732).
const chapter = "form-concurrency-proof";
const userIds = [ids.filer, ids.cosigner, ids.other, ids.steward];
// Every claim names a live session: private.mfa_satisfied() refuses one
// without it since 20261030201100 (#8732).
const sessions = Object.fromEntries(userIds.map((id, index) => [id, `50900000-0000-4000-8000-00000000061${index + 1}`]));
const formIds = [ids.acceptForm, ids.withdrawForm, ids.inviteForm, ids.deletionForm, ids.pendingApprovalForm, ids.expectationForm];
const fixturePrefix = "509-form-concurrency/";
const strokes = [[{ x: 100, y: 100 }, { x: 180, y: 140 }, { x: 260, y: 120 }]];
const answers = {
  summary: "Local concurrency proof",
  incident_date: "2026-08-01",
  narrative: "A deterministic local-only official filing fixture.",
  affected: "Fixture members",
  remedy: "Preserve the approved artifact.",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function configuredSupabaseStatus() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
      && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_JWT_SECRET) {
    return {
      API_URL: process.env.SUPABASE_URL,
      ANON_KEY: process.env.SUPABASE_ANON_KEY,
      SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
    };
  }
  return JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }));
}

// The Storage API receives the service key, including from the failure
// cleanup, so it must be the API of the same owned disposable stack as
// SUPABASE_DB_URL (loopback, port = database port - 1). This runs before any
// client exists or any database connection is attempted.
function localSupabaseConfig() {
  const status = configuredSupabaseStatus();
  const disposable = assertDisposableStorageStatus(status, databaseUrl);
  if (typeof status?.JWT_SECRET !== "string" || status.JWT_SECRET.length === 0) {
    throw new Error("Disposable Supabase status is missing JWT_SECRET");
  }
  return { ...disposable, JWT_SECRET: status.JWT_SECRET };
}

function signedUserToken(secret, userId, email) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    aud: "authenticated",
    role: "authenticated",
    sub: userId,
    email,
    session_id: sessions[userId],
    aal: "aal2",
    iat: now,
    exp: now + 600,
  })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

const supabaseConfig = localSupabaseConfig();
const storageAdmin = createClient(supabaseConfig.API_URL, supabaseConfig.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
function storageAs(userId, email) {
  const token = signedUserToken(supabaseConfig.JWT_SECRET, userId, email);
  return createClient(supabaseConfig.API_URL, supabaseConfig.ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function beginAs(client, userId, email) {
  await client.query("begin");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, email, role: "authenticated", session_id: sessions[userId], aal: "aal2" }),
  ]);
  await client.query("set local role authenticated");
}

async function waitForAdvisory(admin, applicationName) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await admin.query(`
      select wait_event_type, wait_event
      from pg_catalog.pg_stat_activity
      where datname = current_database() and application_name = $1
    `, [applicationName]);
    if (activity.rows.some((row) => row.wait_event_type === "Lock" && row.wait_event === "advisory")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${applicationName} never waited on the form advisory lock`);
}

async function expectState(promise, label, state = "22023") {
  try {
    await promise;
    throw new Error(`${label}: expected SQLSTATE ${state}`);
  } catch (error) {
    assert(error.code === state, `${label}: expected SQLSTATE ${state}, got ${error.code || "no-code"} (${error.message})`);
  }
}

// What the approving steward reviewed, read as stored before the race starts:
// approve_form compares it under the form lock (#8707). Every approval here
// names it, as the website and the phone do (#8728). These forms are ordinary
// (alliance_grievance), so the review is their answers.
async function reviewedExpectation(admin, formId) {
  return (await admin.query(`
    select jsonb_build_object(
      'answers', f.answers,
      'attachmentIds', coalesce((select jsonb_agg(ff.id) from public.member_form_files ff
        where ff.form_id = f.id and ff.confirmed_at is not null), '[]'::jsonb),
      'cosignerIds', coalesce((select jsonb_agg(c.id) from public.member_form_cosigners c
        where c.form_id = f.id and c.status = 'accepted'), '[]'::jsonb)) as expected
    from public.member_forms f where f.id = $1
  `, [formId])).rows[0].expected;
}

async function cleanup(admin) {
  await admin.query("reset role").catch(() => {});
  await storageAdmin.storage.from("member-form-files").remove([
    `${fixturePrefix}${ids.deletionFile}.pdf`,
    `${fixturePrefix}${ids.pendingApprovalFile}.pdf`,
  ]);
  await admin.query("delete from public.member_forms where id = any($1::uuid[])", [formIds]);
  // Role rows go before the chapter: deleting it would null their chapter,
  // which the role guard refuses.
  await admin.query("delete from public.organization_role_grants where organization_id = $1", [ids.organization]);
  for (const table of ["member_roles", "member_role_chapters", "member_chapter_memberships"]) {
    await admin.query(`delete from public.${table} where user_id = any($1::uuid[])`, [userIds]);
  }
  await admin.query("update public.member_profiles set chapter_id = null where id = any($1::uuid[])", [userIds]);
  await admin.query("delete from public.chapters where id = $1", [chapter]);
  for (const table of ["organization_memberships", "dues_member_subjects", "org_security_policy"]) {
    await admin.query(`delete from public.${table} where organization_id = $1`, [ids.organization]);
  }
  await admin.query("delete from public.organizations where id = $1", [ids.organization]);
  await admin.query("delete from auth.users where id = any($1::uuid[])", [userIds]);
}

async function seed(admin) {
  await cleanup(admin);
  const emails = {
    [ids.filer]: "form-concurrency-filer@example.invalid",
    [ids.cosigner]: "form-concurrency-cosigner@example.invalid",
    [ids.other]: "form-concurrency-other@example.invalid",
    [ids.steward]: "form-concurrency-steward@example.invalid",
  };
  for (const id of userIds) {
    await admin.query("insert into auth.users (id, email) values ($1, $2)", [id, emails[id]]);
    await admin.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')",
      [sessions[id], id]);
  }
  await admin.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $3, $4)",
    [ids.organization, chapter, "Fictional Form Concurrency Proof Local", ids.filer]);
  await admin.query(`
    insert into public.chapters (id, name, slug, organization_id, is_default, order_index)
    values ($1, $1, $1, $2, false, 9951)
  `, [chapter, ids.organization]);
  for (const id of userIds) {
    await admin.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')",
      [ids.organization, id]);
    await admin.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')",
      [id, chapter]);
  }
  await admin.query(`
    update public.member_profiles
    set chapter_id = $2, full_name = 'Official form concurrency proof'
    where id = any($1::uuid[])
  `, [userIds, chapter]);
  // A steward needs a unit since #8589: grant and scope it in one transaction.
  await admin.query("begin");
  await admin.query("insert into public.organization_role_grants (organization_id, user_id, role) values ($1, $2, 'steward')",
    [ids.organization, ids.steward]);
  await admin.query("insert into public.member_roles (user_id, role, chapter_id) values ($1, 'steward', $2)",
    [ids.steward, chapter]);
  await admin.query("insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, 'steward', $2)",
    [ids.steward, chapter]);
  await scopeFixtureSteward(admin, ids.steward, chapter);
  await admin.query("commit");
  await admin.query(`
    insert into auth.mfa_factors
      (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (extensions.gen_random_uuid(), $1, 'official-form-concurrency-proof', 'totp', 'verified', now(), now())
  `, [ids.steward]);

  await admin.query(`
    insert into public.member_forms
      (id, user_id, template_key, template_version, status, answers, submitted_at)
    select form_id, $1, 'alliance_grievance', 1, status, $2::jsonb,
           case when status = 'submitted' then now() else null end
    from unnest($3::uuid[], $4::text[]) as fixture(form_id, status)
  `, [ids.filer, JSON.stringify(answers), formIds,
    ["submitted", "submitted", "submitted", "draft", "submitted", "submitted"]]);

  await admin.query(`
    insert into public.member_form_cosigners
      (id, form_id, invited_email, cosigner_user_id, status, invited_by, responded_at, signed_at)
    values
      ($1, $2, $3, null, 'invited', $4, null, null),
      ($5, $6, $3, $7, 'accepted', $4, now(), now())
  `, [ids.acceptCosigner, ids.acceptForm, emails[ids.cosigner], ids.filer,
    ids.withdrawCosigner, ids.withdrawForm, ids.cosigner]);

  await admin.query(`
    insert into public.member_form_files
      (id, form_id, object_name, filename, mime_type, size_bytes, uploaded_by, confirmed_at,
       deletion_requested_at, deletion_requested_by)
    values
      ($1, $2, $3, 'delete-me.pdf', 'application/pdf', 128, $4, now(), null, null),
      ($5, $6, $7, 'pending.pdf', 'application/pdf', 256, $4, now(), now(), $4)
  `, [ids.deletionFile, ids.deletionForm, `${fixturePrefix}${ids.deletionFile}.pdf`, ids.filer,
    ids.pendingApprovalFile, ids.pendingApprovalForm, `${fixturePrefix}${ids.pendingApprovalFile}.pdf`]);
  const upload = await storageAdmin.storage.from("member-form-files").upload(
    `${fixturePrefix}${ids.deletionFile}.pdf`,
    new Uint8Array(128),
    { contentType: "application/pdf", upsert: true },
  );
  assert(!upload.error, `could not seed the local Storage object: ${upload.error?.message}`);

  for (const formId of formIds) {
    const digest = (await admin.query("select private.form_content_digest($1) as value", [formId])).rows[0].value;
    const signature = (await admin.query(
      "select private.form_signature_digest($1, $2, $3::jsonb) as value",
      [digest, ids.filer, JSON.stringify(strokes)],
    )).rows[0].value;
    await admin.query(`
      insert into private.member_form_signatures
        (form_id, signer_kind, signer_user_id, strokes, content_digest, signature_digest, consented_at)
      values ($1, 'filer', $2, $3::jsonb, $4, $5, now())
    `, [formId, ids.filer, JSON.stringify(strokes), digest, signature]);
    await admin.query(`
      update public.member_forms set content_digest = $2, filer_signature_digest = $3, filer_signed_at = now()
      where id = $1
    `, [formId, digest, signature]);
  }
  const withdrawDigest = (await admin.query(
    "select content_digest from public.member_forms where id = $1",
    [ids.withdrawForm],
  )).rows[0].content_digest;
  const cosignerDigest = (await admin.query(
    "select private.form_signature_digest($1, $2, $3::jsonb) as value",
    [withdrawDigest, ids.withdrawCosigner, JSON.stringify(strokes)],
  )).rows[0].value;
  await admin.query(`
    insert into private.member_form_signatures
      (form_id, signer_kind, signer_user_id, cosigner_id, strokes, content_digest, signature_digest, consented_at)
    values ($1, 'cosigner', $2, $3, $4::jsonb, $5, $6, now())
  `, [ids.withdrawForm, ids.cosigner, ids.withdrawCosigner, JSON.stringify(strokes), withdrawDigest, cosignerDigest]);
  await admin.query("update public.member_form_cosigners set signature_digest = $2 where id = $1", [ids.withdrawCosigner, cosignerDigest]);
}

const admin = new Client({ connectionString: databaseUrl, application_name: "form-concurrency-proof-admin" });
const approver = new Client({ connectionString: databaseUrl, application_name: "form-concurrency-proof-approver" });
const action = new Client({ connectionString: databaseUrl, application_name: "form-concurrency-proof-action" });
const remover = new Client({ connectionString: databaseUrl, application_name: "form-concurrency-proof-remover" });
const signer = new Client({ connectionString: databaseUrl, application_name: "form-concurrency-proof-signer" });
const clients = [admin, approver, action, remover, signer];

try {
  await Promise.all(clients.map((client) => client.connect()));
  await Promise.all(clients.map((client) => client.query("set statement_timeout = '10s'")));
  await seed(admin);

  const races = [
    {
      label: "accept",
      formId: ids.acceptForm,
      userId: ids.cosigner,
      email: "form-concurrency-cosigner@example.invalid",
      sql: "select public.respond_to_cosign($1, true, $2::jsonb, true)",
      params: [ids.acceptForm, JSON.stringify(strokes)],
    },
    {
      label: "withdraw",
      formId: ids.withdrawForm,
      userId: ids.cosigner,
      email: "form-concurrency-cosigner@example.invalid",
      sql: "select public.withdraw_cosign($1)",
      params: [ids.withdrawForm],
    },
    {
      label: "invite",
      formId: ids.inviteForm,
      userId: ids.filer,
      email: "form-concurrency-filer@example.invalid",
      sql: "select public.invite_cosigner($1, 'new-cosigner@example.invalid')",
      params: [ids.inviteForm],
    },
  ];

  for (const race of races) {
    const expected = await reviewedExpectation(admin, race.formId);
    await approver.query("begin");
    // The server's order: approve_form enters through lock_case_graph, then
    // takes the form lock. Holding the form lock alone deadlocks with a writer
    // that is already inside the case-graph gate (#8732).
    await approver.query("select private.lock_case_graph(array[$1]::uuid[], array[]::uuid[])", [ids.steward]);
    await approver.query("select private.lock_member_form($1)", [race.formId]);
    await approver.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
      sub: ids.steward,
      email: "form-concurrency-steward@example.invalid",
      role: "authenticated",
      session_id: sessions[ids.steward],
      aal: "aal2",
    })]);
    await approver.query("set local role authenticated");

    await beginAs(action, race.userId, race.email);
    const losingAction = action.query(race.sql, race.params);
    await waitForAdvisory(admin, "form-concurrency-proof-action");
    await approver.query("select public.approve_form($1, 'Concurrency proof', $2::jsonb)", [race.formId, JSON.stringify(expected)]);
    await approver.query("commit");
    await expectState(losingAction, `approval vs ${race.label}`);
    await action.query("rollback");
  }

  const approved = await admin.query("select id, status from public.member_forms where id = any($1::uuid[])", [
    [ids.acceptForm, ids.withdrawForm, ids.inviteForm],
  ]);
  assert(approved.rows.length === 3 && approved.rows.every((row) => row.status === "approved"),
    "all three approval winners must commit");
  assert((await admin.query("select status from public.member_form_cosigners where id = $1", [ids.acceptCosigner])).rows[0].status === "invited",
    "losing accept must not mutate the approved invitation");
  assert((await admin.query("select status from public.member_form_cosigners where id = $1", [ids.withdrawCosigner])).rows[0].status === "accepted",
    "losing withdraw must not mutate the approved co-signer");
  assert((await admin.query("select count(*)::int as n from public.member_form_cosigners where form_id = $1", [ids.inviteForm])).rows[0].n === 0,
    "losing invite must not add an approved child");
  await expectState(
    admin.query("update public.member_form_cosigners set status = 'declined' where id = $1", [ids.acceptCosigner]),
    "direct approved-child mutation",
  );

  await beginAs(remover, ids.filer, "form-concurrency-filer@example.invalid");
  await remover.query("select public.request_member_form_file_removal($1)", [ids.deletionFile]);
  await beginAs(signer, ids.filer, "form-concurrency-filer@example.invalid");
  const losingSign = signer.query(
    "select public.sign_member_form($1, $2::jsonb, true)",
    [ids.deletionForm, JSON.stringify(strokes)],
  );
  await waitForAdvisory(admin, "form-concurrency-proof-signer");
  await remover.query("commit");
  await expectState(losingSign, "file removal vs signing");
  await signer.query("rollback");

  await beginAs(signer, ids.filer, "form-concurrency-filer@example.invalid");
  await expectState(signer.query("select public.submit_form($1)", [ids.deletionForm]), "pending deletion vs submit");
  await signer.query("rollback");
  const pendingExpected = await reviewedExpectation(admin, ids.pendingApprovalForm);
  await beginAs(approver, ids.steward, "form-concurrency-steward@example.invalid");
  await expectState(
    approver.query("select public.approve_form($1, null, $2::jsonb)", [ids.pendingApprovalForm, JSON.stringify(pendingExpected)]),
    "pending deletion vs approval",
  );
  await approver.query("rollback");

  // An approval names what the steward reviewed (#8707, #8732): one that names
  // anything else is refused and approves nothing; the stored review approves.
  const reviewed = await reviewedExpectation(admin, ids.expectationForm);
  const differing = { ...reviewed, answers: { ...reviewed.answers, summary: "Not what is on file" } };
  await beginAs(approver, ids.steward, "form-concurrency-steward@example.invalid");
  try {
    await approver.query("select public.approve_form($1, null, $2::jsonb)", [ids.expectationForm, JSON.stringify(differing)]);
    throw new Error("an approval naming other answers must be refused");
  } catch (error) {
    assert(error.code === "PT409" && error.detail === "form_changed_since_review",
      `a differing expectation: expected PT409 form_changed_since_review, got ${error.code || "no-code"} ${error.detail ?? ""} (${error.message})`);
  }
  await approver.query("rollback");
  assert((await admin.query("select status from public.member_forms where id = $1", [ids.expectationForm])).rows[0].status === "submitted",
    "a refused approval must leave the form submitted");
  await beginAs(approver, ids.steward, "form-concurrency-steward@example.invalid");
  await approver.query("select public.approve_form($1, null, $2::jsonb)", [ids.expectationForm, JSON.stringify(reviewed)]);
  await approver.query("commit");
  assert((await admin.query("select status from public.member_forms where id = $1", [ids.expectationForm])).rows[0].status === "approved",
    "the approval naming the stored review must approve");

  await beginAs(remover, ids.filer, "form-concurrency-filer@example.invalid");
  await expectState(
    remover.query("select public.finalize_member_form_file_removal($1)", [ids.deletionFile]),
    "metadata finalization before byte deletion",
  );
  await remover.query("rollback");

  const deletionPath = `${fixturePrefix}${ids.deletionFile}.pdf`;
  const otherStorage = storageAs(ids.other, "form-concurrency-other@example.invalid");
  await otherStorage.storage.from("member-form-files").remove([deletionPath]);
  const afterOther = await storageAdmin.storage.from("member-form-files").download(deletionPath);
  assert(!afterOther.error, "another tab must not consume the filer's deletion capability");
  const filerStorage = storageAs(ids.filer, "form-concurrency-filer@example.invalid");
  const byteDelete = await filerStorage.storage.from("member-form-files").remove([deletionPath]);
  assert(!byteDelete.error, `the tombstone owner could not delete through the Storage API: ${byteDelete.error?.message}`);
  const afterFiler = await storageAdmin.storage.from("member-form-files").download(deletionPath);
  assert(afterFiler.error, "the server-authorized Storage byte deletion did not remove the object");
  const resurrection = await filerStorage.storage.from("member-form-files").upload(
    deletionPath,
    new Uint8Array(128),
    { contentType: "application/pdf", upsert: false },
  );
  assert(resurrection.error, "a tombstoned path must not be uploadable again before metadata finalization");
  await beginAs(remover, ids.filer, "form-concurrency-filer@example.invalid");
  await remover.query("select public.finalize_member_form_file_removal($1)", [ids.deletionFile]);
  await remover.query("commit");
  assert((await admin.query("select count(*)::int as n from public.member_form_files where id = $1", [ids.deletionFile])).rows[0].n === 0,
    "metadata must finalize only after byte deletion");

  await cleanup(admin);
  const residue = await admin.query("select count(*)::int as n from auth.users where id = any($1::uuid[])", [userIds]);
  assert(residue.rows[0].n === 0, "official-form concurrency proof left identity residue");
  const tenantResidue = await admin.query(`
    select (select count(*)::int from public.organizations where id = $1)
         + (select count(*)::int from public.chapters where id = $2) as n
  `, [ids.organization, chapter]);
  assert(tenantResidue.rows[0].n === 0, "official-form concurrency proof left its organization or chapter");
  console.log("PASS: approval/child and attachment-deletion races serialized across live connections; an approval naming other content was refused and the stored review approved; local fixtures removed.");
} catch (error) {
  await Promise.all(clients.map((client) => client.query("rollback").catch(() => {})));
  await cleanup(admin).catch(() => {});
  throw error;
} finally {
  await Promise.all(clients.map((client) => client.end().catch(() => {})));
}
