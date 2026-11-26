// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripSqlComments } from "../scripts/lib/sql-text.mjs";
import { protectArguments, revealRow, revealFormAnswers, sealFormAnswers } from "../api/_lib/sensitiveContent.js";
import { scanSensitivePatterns } from "../api/_lib/sensitivePatterns.js";
import { sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { encryptCaseDocument } from "../api/_lib/sensitiveCaseDocuments.js";
import { maintainSealedForms } from "../scripts/sensitive-form-maintenance.mjs";

const databaseIt = process.env.RUN_SENSITIVE_CONTENT_DB_TESTS === "1" ? it : it.skip;
databaseIt("rejects an overlapping stale no-op under the form lock and lets a fresh retry restore the requested answers", async () => {
  const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const admin = new pg.Client({ connectionString: url }), first = new pg.Client({ connectionString: url }), second = new pg.Client({ connectionString: url });
  const user = randomUUID(), org = randomUUID(), session = randomUUID(), chapter = `sealed-race-${randomUUID()}`;
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  await Promise.all([admin.connect(), first.connect(), second.connect()]);
  const actor = async (client) => {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
    await client.query("set local role authenticated");
  };
  const stage = async (args, envelopes) => {
    await admin.query("begin; set local role service_role");
    const result = await admin.query("select public.stage_sensitive_write($1,'save_sealed_form_draft',$2,$3) as ticket", [user, args, envelopes]);
    await admin.query("commit");
    return result.rows[0].ticket;
  };
  const write = (client, args, envelopes, ticket) => client.query("select public.write_sensitive_content('save_sealed_form_draft',$1,$2,$3) as id", [args, envelopes, ticket]);
  try {
    // All committed fixtures belong to this disposable stack; its owner stops
    // and destroys the stack after the proofs, even when a case fails.
    await admin.query("begin");
    await admin.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@example.invalid`]);
    await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic sealed-form factor','totp','verified',now(),now())", [randomUUID(), user]);
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, chapter, user]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9903)", [chapter, org]);
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [user, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [org]);
    await admin.query("commit");
    await actor(first);
    const form = (await first.query("select public.prepare_sealed_form('fmla_self') as draft")).rows[0].draft;
    await first.query("commit");
    const row = { id: form.formId, organization_id: org };
    const initial = sealFormAnswers({ reason: "initial" }, row, ring);
    const makeArgs = (envelope, expected, changed = true) => ({ p_form_id: row.id, p_step: 1, p_changed: changed,
      p_filled: ["reason"], p_data_version: envelope?.dataVersion ?? null, p_expected_data_version: expected });
    const initialArgs = makeArgs(initial, null);
    const initialTicket = await stage(initialArgs, { answers: initial });
    await actor(first); await write(first, initialArgs, { answers: initial }, initialTicket); await first.query("commit");
    // Both requests prepare the same earlier version in separate transactions.
    await actor(first);
    const preparedA = (await first.query("select public.prepare_sealed_form('fmla_self') as draft")).rows[0].draft;
    await first.query("commit");
    await actor(second);
    const preparedB = (await second.query("select public.prepare_sealed_form('fmla_self') as draft")).rows[0].draft;
    await second.query("commit");
    expect(preparedA.envelope.dataVersion).toBe(preparedB.envelope.dataVersion);
    const revised = sealFormAnswers({ reason: "revised" }, row, ring);
    const argsA = makeArgs(revised, preparedA.envelope.dataVersion);
    const argsB = makeArgs(null, preparedB.envelope.dataVersion, false);
    const ticketA = await stage(argsA, { answers: revised }), ticketB = await stage(argsB, {});
    await actor(first); await write(first, argsA, { answers: revised }, ticketA);
    await actor(second);
    const stale = write(second, argsB, {}, ticketB).then(() => ({ code: "unexpected-success" }), (error) => ({ code: error.code }));
    await expect.poll(async () => (await admin.query("select pg_blocking_pids($1) as blockers", [second.processID])).rows[0].blockers,
      { timeout: 5000 }).toContain(first.processID);
    await first.query("commit");
    expect(await stale).toEqual({ code: "PT409" });
    await second.query("rollback");
    const stored = async () => (await admin.query("select * from public.member_forms where id=$1", [row.id])).rows[0];
    expect(revealFormAnswers(await stored(), ring)).toEqual({ reason: "revised" });
    const restored = sealFormAnswers({ reason: "initial" }, row, ring);
    const retryArgs = makeArgs(restored, revised.dataVersion);
    const retryTicket = await stage(retryArgs, { answers: restored });
    await actor(second); await write(second, retryArgs, { answers: restored }, retryTicket); await second.query("commit");
    expect(revealFormAnswers(await stored(), ring)).toEqual({ reason: "initial" });
    const unchanged = await stored(), noOpArgs = makeArgs(null, restored.dataVersion, false);
    const noOpTicket = await stage(noOpArgs, {});
    await actor(second); await write(second, noOpArgs, {}, noOpTicket); await second.query("commit");
    expect((await stored()).encrypted_content).toEqual(unchanged.encrypted_content);
    const unversioned = { ...noOpArgs };
    delete unversioned.p_expected_data_version;
    const unversionedTicket = await stage(unversioned, {});
    await actor(second);
    await expect(write(second, unversioned, {}, unversionedTicket)).rejects.toMatchObject({ code: "PT409" });
    await second.query("rollback");
  } finally {
    await Promise.allSettled([first.query("rollback"), second.query("rollback"), admin.query("rollback")]);
    await Promise.all([first.end(), second.end(), admin.end()]);
  }
}, 30000);
// SEC-UG-FORM-DRAFT-RETRY-BASELINE-VERSION-CAS-20261027 (#6233):
// replay of round 10's race. Retry B is already past the client's withdrawal
// check, held at the API, when C commits from elsewhere. B resumes with the
// baseline it was built on; save_sealed_form_draft compares that under the
// form lock and refuses, so C survives. Naming the version a fresh prepare
// reads (the old API) would have written B over C.
databaseIt("refuses a dispatched retry whose baseline version moved under the form lock, so newer answers survive", async () => {
  const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const admin = new pg.Client({ connectionString: url }), tab = new pg.Client({ connectionString: url }), elsewhere = new pg.Client({ connectionString: url });
  const user = randomUUID(), org = randomUUID(), session = randomUUID(), chapter = `sealed-baseline-${randomUUID()}`;
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  await Promise.all([admin.connect(), tab.connect(), elsewhere.connect()]);
  const actor = async (client) => {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
    await client.query("set local role authenticated");
  };
  // The API's sequence for one save: prepare, stage the ticket, write through the dispatcher.
  const prepare = async (client) => {
    await actor(client);
    const draft = (await client.query("select public.prepare_sealed_form('fmla_self') as draft")).rows[0].draft;
    await client.query("commit");
    return draft;
  };
  const save = async (client, formId, answers, expected) => {
    const envelope = sealFormAnswers(answers, { id: formId, organization_id: org }, ring);
    const args = { p_form_id: formId, p_step: 1, p_changed: true, p_filled: Object.keys(answers),
      p_data_version: envelope.dataVersion, p_expected_data_version: expected };
    await admin.query("begin; set local role service_role");
    const ticket = (await admin.query("select public.stage_sensitive_write($1,'save_sealed_form_draft',$2,$3) as ticket", [user, args, { answers: envelope }])).rows[0].ticket;
    await admin.query("commit");
    await actor(client);
    await client.query("select public.write_sensitive_content('save_sealed_form_draft',$1,$2,$3)", [args, { answers: envelope }, ticket]);
    return envelope.dataVersion;
  };
  const stored = async (formId) => revealFormAnswers((await admin.query("select * from public.member_forms where id=$1", [formId])).rows[0], ring);
  try {
    // Committed fixtures belong to this disposable stack, like the race case above.
    await admin.query("begin");
    await admin.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@example.invalid`]);
    await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic sealed-form factor','totp','verified',now(),now())", [randomUUID(), user]);
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, chapter, user]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9905)", [chapter, org]);
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [user, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [org]);
    await admin.query("commit");
    const formId = (await prepare(tab)).formId;
    const baseline = await save(tab, formId, { reason: "Saved A" }, null);
    await tab.query("commit");
    // B was built on A's version and dispatched; it is held at the API while C commits elsewhere.
    const atC = await prepare(elsewhere);
    const versionC = await save(elsewhere, formId, { reason: "Saved elsewhere C" }, atC.envelope.dataVersion);
    await elsewhere.query("commit");
    expect(versionC).not.toBe(baseline);
    // B resumes: its prepare now reads C, but it names the baseline it was built on.
    const atB = await prepare(tab);
    expect(atB.envelope.dataVersion).toBe(versionC);
    await expect(save(tab, formId, { reason: "Retry B" }, baseline)).rejects.toMatchObject({ code: "PT409" });
    await tab.query("rollback");
    expect(await stored(formId)).toEqual({ reason: "Saved elsewhere C" });
    // The old API named the version prepare read; that write would have overwritten C.
    await save(tab, formId, { reason: "Retry B" }, atB.envelope.dataVersion);
    expect((await tab.query("select answers->>'dataVersion' as version from public.member_forms where id=$1", [formId])).rows[0].version).not.toBe(versionC);
    await tab.query("rollback");
    expect(await stored(formId)).toEqual({ reason: "Saved elsewhere C" });
  } finally {
    await Promise.allSettled([tab.query("rollback"), elsewhere.query("rollback"), admin.query("rollback")]);
    await Promise.all([tab.end(), elsewhere.end(), admin.end()]);
  }
}, 30000);
// SEC-UG-FORM-DRAFT-LANE-RETIRE-ELSEWHERE-AND-LEGACY-SEALED-SAVE-20261028
// (#6329, #6289 round 2 P1): the legacy plaintext save refuses sealed
// templates, so an empty save from a cached bundle can neither create an
// organizationless FMLA draft nor clear a sealed one. #6320: the marker guard
// accepts the template contract's 360 answers and refuses 361.
databaseIt("refuses legacy saves of sealed templates and bounds sealed answers by the template contract", async () => {
  const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const admin = new pg.Client({ connectionString: url }), tab = new pg.Client({ connectionString: url });
  const user = randomUUID(), org = randomUUID(), session = randomUUID(), chapter = `sealed-legacy-${randomUUID()}`;
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  await Promise.all([admin.connect(), tab.connect()]);
  const actor = async () => {
    await tab.query("begin");
    await tab.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
    await tab.query("set local role authenticated");
  };
  const save = async (formId, answers, expected, filled = Object.keys(answers)) => {
    const envelope = sealFormAnswers(answers, { id: formId, organization_id: org }, ring);
    const args = { p_form_id: formId, p_step: 1, p_changed: true, p_filled: filled,
      p_data_version: envelope.dataVersion, p_expected_data_version: expected };
    await admin.query("begin; set local role service_role");
    const ticket = (await admin.query("select public.stage_sensitive_write($1,'save_sealed_form_draft',$2,$3) as ticket", [user, args, { answers: envelope }])).rows[0].ticket;
    await admin.query("commit");
    await actor();
    await tab.query("select public.write_sensitive_content('save_sealed_form_draft',$1,$2,$3)", [args, { answers: envelope }, ticket]);
    return envelope.dataVersion;
  };
  const drafts = async () => (await admin.query("select id, organization_id, answers from public.member_forms where user_id=$1 and template_key='fmla_self'", [user])).rows;
  const answersOf = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`field_${index}`, "x"]));
  try {
    await admin.query("begin");
    await admin.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@example.invalid`]);
    await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic sealed-form factor','totp','verified',now(),now())", [randomUUID(), user]);
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, chapter, user]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9906)", [chapter, org]);
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [user, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [org]);
    await admin.query("commit");
    // No open draft: the empty legacy save is refused and creates nothing.
    await actor();
    await expect(tab.query("select public.save_form_draft('fmla_self','{}'::jsonb,0)")).rejects.toMatchObject({ code: "22023" });
    await tab.query("rollback");
    expect(await drafts()).toEqual([]);
    // A fresh draft through prepare_sealed_form still saves, here with 360 answers.
    await actor();
    const formId = (await tab.query("select public.prepare_sealed_form('fmla_self') as draft")).rows[0].draft.formId;
    await tab.query("commit");
    const version = await save(formId, answersOf(360), null);
    await tab.query("commit");
    expect(await drafts()).toMatchObject([{ id: formId, organization_id: org }]);
    // An empty legacy save cannot clear the sealed draft either.
    await actor();
    await expect(tab.query("select public.save_form_draft('fmla_self','{}'::jsonb,0)")).rejects.toMatchObject({ code: "22023" });
    await tab.query("rollback");
    const [stored] = await drafts();
    expect(stored.answers).toMatchObject({ sealed: true, dataVersion: version });
    expect(stored.answers.filled).toHaveLength(360);
    // One answer beyond the contract is refused by the marker guard.
    await expect(save(formId, answersOf(360), version, [...Object.keys(answersOf(360)), "field_360"])).rejects.toMatchObject({ code: "22023" });
    await tab.query("rollback");
    expect((await drafts())[0].answers.dataVersion).toBe(version);
  } finally {
    await Promise.allSettled([tab.query("rollback"), admin.query("rollback")]);
    await Promise.all([tab.end(), admin.end()]);
  }
}, 30000);
// #6363 round 1: answers.sealed, filled and legacyDigest are authoritative only
// on a sealed template's enveloped row. On an ordinary form they are answers a
// caller chose, so they can neither stand in for required answers nor pick the
// content digest; a legacy FMLA checkbox named "sealed" still backfills, even
// on an approved form.
databaseIt("trusts sealed-marker fields only on an enveloped sealed-template row", async () => {
  const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const admin = new pg.Client({ connectionString: url }), tab = new pg.Client({ connectionString: url });
  const user = randomUUID(), org = randomUUID(), session = randomUUID(), chapter = `sealed-marker-${randomUUID()}`;
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  await Promise.all([admin.connect(), tab.connect()]);
  const actor = async () => {
    await tab.query("begin");
    await tab.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
    await tab.query("set local role authenticated");
  };
  try {
    await admin.query("begin");
    await admin.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@example.invalid`]);
    await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic sealed-form factor','totp','verified',now(),now())", [randomUUID(), user]);
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, chapter, user]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9907)", [chapter, org]);
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [user, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [org]);
    await admin.query("commit");
    // An ordinary grievance whose answers forge the sealed marker fields.
    const required = (await admin.query("select private.form_required_keys('grievance', (select max(version) from public.form_templates where key='grievance' and is_platform_seed)) keys")).rows[0].keys;
    expect(required.length).toBeGreaterThan(0);
    await actor();
    const formId = (await tab.query("select public.save_form_draft('grievance',$1,0) id", [{ sealed: true, filled: required, legacyDigest: "chosen-digest" }])).rows[0].id;
    await tab.query("commit");
    const digest = (await admin.query("select private.form_content_digest($1) digest", [formId])).rows[0].digest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    await admin.query("insert into private.member_form_signatures(form_id,signer_kind,signer_user_id,content_digest,signature_digest,strokes,consented_at) values($1,'filer',$2,$3,private.form_signature_digest($3,$2,'[]'::jsonb),'[]'::jsonb,now())", [formId, user, digest]);
    await actor();
    await expect(tab.query("select public.submit_form($1)", [formId])).rejects.toThrow(/form incomplete/);
    await tab.query("rollback");
    // An approved legacy FMLA form (written before the rollout, so no envelope)
    // answered a checkbox named "sealed"; the backfill still seals it.
    const legacyId = "ffffffff-ffff-4fff-8fff-fffffffffff7", legacy = { sealed: true, reason: "Legacy leave reason" };
    await admin.query("begin; set local session_replication_role = replica");
    await admin.query("insert into public.member_forms(id,user_id,template_key,template_version,status,answers,step) values($1,$2,'fmla_self',1,'approved',$3,0)", [legacyId, user, legacy]);
    await admin.query("update public.member_forms set content_digest = private.form_content_digest(id) where id=$1", [legacyId]);
    await admin.query("commit");
    const frozen = (await admin.query("select content_digest from public.member_forms where id=$1", [legacyId])).rows[0].content_digest;
    await maintainSealedForms(admin, { ring, cursor: "ffffffff-ffff-4fff-8fff-fffffffffff6", limit: 1 });
    const sealed = (await admin.query("select * from public.member_forms where id=$1", [legacyId])).rows[0];
    expect(sealed.answers).toMatchObject({ sealed: true, legacyDigest: frozen });
    expect(sealed.organization_id).toBe(org);
    expect(revealFormAnswers(sealed, ring)).toEqual(legacy);
  } finally {
    await Promise.allSettled([tab.query("rollback"), admin.query("rollback")]);
    await Promise.all([tab.end(), admin.end()]);
  }
}, 30000);
// #5827 round 7 (Sol 6.1) r7s1: a new sealed draft pins the organization's own
// template, as save_form_draft and the registry do, even when a platform seed
// has a higher version. Everything stays inside one rolled-back transaction.
databaseIt("pins a new sealed draft to the organization's own template over a newer platform seed", async () => {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  const user = randomUUID(), org = randomUUID(), session = randomUUID(), chapter = `sealed-precedence-${randomUUID()}`;
  await client.connect();
  try {
    await client.query("begin");
    await client.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic sealed-form factor','totp','verified',now(),now())", [randomUUID(), user]);
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, chapter, user]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9904)", [chapter, org]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [user, chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [org]);
    // The organization's copy, then a newer platform seed above it.
    const top = Number((await client.query("select max(version) v from public.form_templates where key='fmla_self'")).rows[0].v);
    const copy = (version, owner) => client.query(`insert into public.form_templates
      (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema, is_platform_seed, organization_id)
      select key, $1, label_en, label_es, blurb_en, blurb_es, icon, points, true, sort, field_schema, $2::uuid is null, $2::uuid
      from public.form_templates where key='fmla_self' and version=$3`, [version, owner, top]);
    await copy(top + 1, org);
    await copy(top + 2, null);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
    await client.query("set local role authenticated");
    const draft = (await client.query("select public.prepare_sealed_form('fmla_self') as draft")).rows[0].draft;
    await client.query("reset role");
    const pinned = (await client.query("select template_version, organization_id from public.member_forms where id=$1", [draft.formId])).rows[0];
    expect(pinned).toEqual({ template_version: top + 1, organization_id: org });
    // Version order alone would have pinned the platform seed.
    expect((await client.query("select is_platform_seed from public.form_templates where key='fmla_self' order by version desc limit 1")).rows[0].is_platform_seed).toBe(true);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}, 30000);
databaseIt("removes only the four hosted-default service-role RPC grants and preserves caller and staging access", async () => {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  const signatures = [
    "public.sensitive_pattern_source(text, uuid)",
    "public.sensitive_data_organization()",
    "public.write_sensitive_content(text, jsonb, jsonb, uuid)",
    "public.sensitive_case_upload_target(uuid)",
  ];
  const migration = readFileSync(new URL("../supabase/migrations/20260909060128_sensitive_rpc_service_role_execute_revoke.sql", import.meta.url), "utf8");
  // This five-statement ACL migration has a deliberately fixed grammar. Check
  // its complete body before executing the original inner bytes, so its own
  // COMMIT cannot release this proof's transaction or leave shared DB fixtures.
  const wrapped = /^begin;\r?\n([\s\S]*)\r?\ncommit;$/i.exec(migration.trim());
  expect(wrapped, "the forward migration must contain one outer BEGIN/COMMIT pair").not.toBeNull();
  const migrationBody = wrapped[1];
  expect(stripSqlComments(migrationBody).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)).toEqual([
    ...signatures.map((signature) => `revoke execute on function ${signature} from service_role;`),
    "notify pgrst, 'reload schema';",
  ]);
  const probe = `sensitive_acl_probe_${randomUUID().replaceAll("-", "")}`;
  const snapshot = async () => (await client.query(`
    select p.oid::text as oid, n.nspname as schema, p.proname as name,
      pg_get_userbyid(p.proowner) as owner, md5(pg_get_functiondef(p.oid)) as definition_md5,
      p.prosecdef as security_definer,
      coalesce(p.proconfig, '{}'::text[]) as config,
      coalesce(p.proacl, acldefault('f', p.proowner))::text as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prokind = 'f'
    order by p.oid`)).rows;
  const otherState = async () => (await client.query(`select
    (select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d) as defaults,
    (select count(*)::integer from supabase_migrations.schema_migrations) as migration_count,
    (select md5(jsonb_agg(to_jsonb(m) order by m.version)::text)
      from supabase_migrations.schema_migrations m) as migration_digest`)).rows[0];
  const ticketState = async () => (await client.query(`select count(*)::integer as count,
    md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text, '[]')) as digest
    from private.sensitive_write_tickets t`)).rows[0];
  const permissions = async () => (await client.query(`
    select p.oid::text as oid,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public
    from pg_proc p where p.oid = any($1::regprocedure[]) order by p.oid`, [signatures])).rows;
  await client.connect();
  try {
    const original = await snapshot();
    const originalOther = await otherState();
    const originalTickets = await ticketState();
    await client.query("begin; set local lock_timeout = '5s'");
    // Reproduce the hosted creation environment without dropping real RPCs.
    // The probe proves the implicit direct grant; the four GRANTs restore the
    // exact observed defect on the real definitions, inside this rollback only.
    await client.query(`alter default privileges for role postgres in schema public
      grant execute on functions to anon, authenticated, service_role;
      create function public.${probe}() returns integer language sql as 'select 1';
      grant execute on function ${signatures.join(", ")} to service_role`);
    const inherited = (await client.query(`select exists (
      select 1 from pg_proc p, lateral aclexplode(p.proacl) a
      where p.oid = $1::regprocedure and a.grantee = 'service_role'::regrole
        and a.privilege_type = 'EXECUTE') as direct_grant`, [`public.${probe}()`])).rows[0];
    expect(inherited.direct_grant).toBe(true);
    const beforePermissions = await permissions();
    expect(beforePermissions).toHaveLength(4);
    for (const row of beforePermissions) {
      expect(row).toMatchObject({ authenticated: true, anon: false, service_role: true, public: false });
    }
    const targets = new Set(beforePermissions.map((row) => row.oid));
    const before = await snapshot();
    const beforeOther = await otherState();
    await client.query(migrationBody);
    const after = await snapshot();
    const repairedDefinitions = after.filter((row) => targets.has(row.oid));
    expect(repairedDefinitions).toHaveLength(4);
    for (const row of repairedDefinitions) {
      expect(row.security_definer).toBe(true);
      expect(row.config).toContain('search_path=""');
    }
    // A blanket revoke, body rewrite, owner change, function replacement or
    // collateral staging/probe ACL change must fail, even when the four pass.
    expect(after.map(({ acl: _acl, ...row }) => row)).toEqual(before.map(({ acl: _acl, ...row }) => row));
    expect(after.filter((row) => !targets.has(row.oid))).toEqual(before.filter((row) => !targets.has(row.oid)));
    expect(after.filter((row, index) => row.acl !== before[index].acl).map((row) => row.oid).sort()).toEqual([...targets].sort());
    expect(await otherState()).toEqual(beforeOther);
    for (const row of await permissions()) {
      expect(row).toMatchObject({ authenticated: true, anon: false, service_role: false, public: false });
    }
    // Prove denial at EXECUTE before any function body can run, including the
    // writer. All arguments and the successful staging ticket are disposable.
    for (const [name, call] of [
      ["sensitive_pattern_source", "select public.sensitive_pattern_source(null::text, null::uuid)"],
      ["sensitive_data_organization", "select public.sensitive_data_organization()"],
      ["write_sensitive_content", "select public.write_sensitive_content(null::text, '{}'::jsonb, '{}'::jsonb, null::uuid)"],
      ["sensitive_case_upload_target", "select public.sensitive_case_upload_target(null::uuid)"],
    ]) {
      await client.query("savepoint denied_rpc; set local role service_role");
      await expect(client.query(call)).rejects.toMatchObject({
        code: "42501", message: expect.stringContaining(`permission denied for function ${name}`),
      });
      await client.query("rollback to savepoint denied_rpc; release savepoint denied_rpc");
    }
    await client.query("set local role service_role");
    expect((await client.query(`select public.${probe}() as value`)).rows).toEqual([{ value: 1 }]);
    const ticket = (await client.query("select public.stage_sensitive_write($1, 'acl-proof', '{}'::jsonb, '{}'::jsonb) as id", [randomUUID()])).rows[0].id;
    await client.query("reset role");
    expect((await client.query("select count(*)::integer as count from private.sensitive_write_tickets where id = $1", [ticket])).rows).toEqual([{ count: 1 }]);
    await client.query(migrationBody);
    expect(await snapshot()).toEqual(after);
    expect(await otherState()).toEqual(beforeOther);
    await client.query("rollback");
    // Verify actual restoration after PostgreSQL has ended the transaction,
    // including the default grants, probe and staging ticket created above.
    expect(await snapshot()).toEqual(original);
    expect(await otherState()).toEqual(originalOther);
    expect(await ticketState()).toEqual(originalTickets);
    expect((await client.query("select to_regprocedure($1)::text as signature", [`public.${probe}()`])).rows).toEqual([{ signature: null }]);
    expect((await client.query("select count(*)::integer as count from private.sensitive_write_tickets where id = $1", [ticket])).rows).toEqual([{ count: 0 }]);
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}, 30000);

databaseIt("proves actual accommodation and retaliation RPC writes, RLS reads, plaintext rejection and atomic envelope binding", async () => {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  const org = randomUUID(), otherOrg = randomUUID(), user = randomUUID(), staff = randomUUID(), otherUser = randomUUID(), caseId = randomUUID();
  const sessions = new Map([[staff, randomUUID()], [user, randomUUID()], [otherUser, randomUUID()]]);
  const chapter = `enc-${randomUUID()}`;
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  await client.connect();
  const as = async (actor, sql, values = [], aal = "aal2") => {
    await client.query("savepoint enc_probe");
    try {
      await client.query("update auth.sessions set aal=$2 where id=$1", [sessions.get(actor),aal]);
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: "authenticated", session_id: sessions.get(actor), aal })]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, values);
      await client.query("reset role"); await client.query("release savepoint enc_probe");
      return { rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint enc_probe");
      return { code: error.code, message: error.message, rows: [] };
    }
  };
  try {
    await client.query("begin");
    await client.query("insert into auth.users(id,email) values($1,$2),($3,$4)", [user, `${user}@example.invalid`, otherUser, `${otherUser}@example.invalid`]);
    await client.query("insert into auth.users(id,email) values($1,$2)", [staff, `${staff}@example.invalid`]);
    for (const [actor, session] of sessions) {
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, actor]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic ENC factor','totp','verified',now(),now())", [randomUUID(), actor]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,'Synthetic ENC proof',$3),($4,$5,'Synthetic foreign proof',$6)", [org, `enc-${org}`, user, otherOrg, `enc-${otherOrg}`, otherUser]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,'Synthetic ENC',$1,$2,false,9902)", [chapter, org]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active'),($3,$4,'active')", [org, user, otherOrg, otherUser]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [user, chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false),(true,$2,false)", [org, otherOrg]);
    await client.query("insert into public.member_cases(id,user_id,reference,title,case_type) values($1,$2,$3,'Synthetic ENC case','other')", [caseId, user, `enc-${caseId}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, staff]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [staff, chapter]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)", [staff, chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [staff, chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [org, staff]);
    const report = randomUUID();
    const accommodation = protectArguments("create_member_accommodation_request", { p_idempotency_key: report, p_description: "Synthetic private accommodation", p_request_type: "schedule" }, org, ring);
    const call = async (actor, value, aal = "aal2") => {
      const ticket = await client.query("select public.stage_sensitive_write($1,$2,$3,$4) id", [actor, value.p_operation, value.p_arguments, value.p_envelopes]);
      return as(actor, "select public.write_sensitive_content($1,$2,$3,$4) value", [value.p_operation, value.p_arguments, value.p_envelopes, ticket.rows[0].id], aal);
    };
    // AAL1 member create/owner withdrawal remain available; staff and casework
    // operations retain their existing MFA boundary under an enabled policy.
    await client.query("update public.org_security_policy set require_staff_mfa=true where organization_id=$1",[org]);
    await client.query("delete from auth.mfa_factors where user_id=$1",[user]);
    const aal1Id = randomUUID();
    const aal1Create = protectArguments("create_member_accommodation_request", { p_idempotency_key:aal1Id,p_request_type:"schedule",p_description:"Synthetic AAL1 request" },org,ring);
    const aal1Created = await call(user,aal1Create,"aal1");
    expect(aal1Created.code,aal1Created.message).toBeUndefined();
    const aal1Transition = protectArguments("transition_member_accommodation_request", { p_request_id:aal1Id,p_status:"under_review",p_staff_note:"Synthetic assessment",p_idempotency_key:randomUUID() },org,ring);
    expect((await call(staff,aal1Transition,"aal1")).code).toBe("42501");
    expect((await call(staff,aal1Transition)).code).toBeUndefined();
    const aal1Withdraw = protectArguments("transition_member_accommodation_request", { p_request_id:aal1Id,p_status:"withdrawn",p_staff_note:"",p_idempotency_key:randomUUID() },org,ring);
    expect((await call(staff,aal1Withdraw,"aal1")).code).toBeDefined();
    expect((await call(user,aal1Withdraw,"aal1")).code).toBeUndefined();
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic restored factor','totp','verified',now(),now())",[randomUUID(),user]);
    expect((await call(user,aal1Create,"aal1")).code).toBe("42501");
    const enrolledId = randomUUID();
    expect((await call(user,protectArguments("create_member_accommodation_request", { p_idempotency_key:enrolledId,p_request_type:"schedule",p_description:"Synthetic enrolled request" },org,ring))).code).toBeUndefined();
    const enrolledWithdraw = protectArguments("transition_member_accommodation_request", { p_request_id:enrolledId,p_status:"withdrawn",p_staff_note:"",p_idempotency_key:randomUUID() },org,ring);
    expect((await call(user,enrolledWithdraw,"aal1")).code).toBe("42501");
    expect((await call(user,enrolledWithdraw)).code).toBeUndefined();
    // The established restrictive RLS predicate has this same assurance boundary;
    // casework_require_mfa is a wrapper around it, not an AAL2 enrollment demand.
    expect((await as(user,"select private.mfa_satisfied() allowed",[],"aal1")).rows).toEqual([{allowed:false}]);
    await client.query("update public.org_security_policy set require_staff_mfa=false where organization_id=$1",[org]);
    const created = await call(user, accommodation);
    expect(created.code, created.message).toBeUndefined();
    const rows = await as(user, "select * from public.member_accommodation_requests where id=$1", [report]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].description).toBe("[encrypted]");
    expect(revealRow("member_accommodation_requests", rows.rows[0], ring).description).toBe("Synthetic private accommodation");
    expect((await as(otherUser, "select * from public.member_accommodation_requests where id=$1", [report])).rows).toHaveLength(0);
    expect((await as(user, "select public.create_member_accommodation_request('schedule','plaintext',$1)", [randomUUID()])).code).toBe("22023");
    const wrong = protectArguments("create_member_accommodation_request", { p_idempotency_key: randomUUID(), p_description: "Synthetic private accommodation", p_request_type: "schedule" }, otherOrg, ring);
    expect((await call(user, wrong)).code).toBe("22023");
    const assessment = protectArguments("transition_member_accommodation_request", { p_request_id: report, p_status: "under_review", p_staff_note: "Synthetic staff assessment", p_idempotency_key: randomUUID() }, org, ring);
    expect((await call(staff, assessment)).code).toBeUndefined();
    const beforeWithdrawal = (await client.query("select encrypted_content from public.member_accommodation_requests where id=$1", [report])).rows[0].encrypted_content;
    const withdraw = protectArguments("transition_member_accommodation_request", { p_request_id: report, p_status: "withdrawn", p_staff_note: "Synthetic attacker replacement", p_idempotency_key: randomUUID() }, org, ring);
    const withdrew = await call(user, withdraw);
    expect(withdrew.code).toBeUndefined();
    expect(withdrew.rows[0].value.status).toBe("withdrawn");
    const afterWithdrawal = (await client.query("select encrypted_content from public.member_accommodation_requests where id=$1", [report])).rows[0].encrypted_content;
    expect.soft(afterWithdrawal.staff_note).toEqual(beforeWithdrawal.staff_note);
    // Regression: a member could mint a shaped but unauthentic envelope.
    const forged = protectArguments("create_member_accommodation_request", { p_idempotency_key: randomUUID(), p_description: "Synthetic forged content", p_request_type: "schedule" }, org, ring);
    forged.p_envelopes.description.payload = {};
    forged.p_envelopes.description.wrappedKey = {};
    expect.soft((await as(user, "select public.write_sensitive_content($1,$2,$3)", [forged.p_operation, forged.p_arguments, forged.p_envelopes])).code).toBe("42501");
    const retaliation = protectArguments("casework_submit_retaliation_report", { p_idempotency_key: randomUUID(), p_case_id: caseId, p_incident_at: new Date().toISOString(),
      p_management_person: "Synthetic person", p_protected_activity: "Synthetic protected activity", p_adverse_action: "Synthetic adverse action", p_requested_support: "Synthetic support" }, org, ring);
    expect((await call(user,retaliation,"aal1")).code).toBe("42501");
    const written = await call(user, retaliation);
    expect(written.code).toBeUndefined();
    expect(written.rows[0].value.id).toBe(retaliation.p_arguments.p_idempotency_key);
    expect(revealRow("casework_retaliation_reports", written.rows[0].value, ring).protected_activity).toBe("Synthetic protected activity");
    expect((await call(user, retaliation)).rows[0].value.id).toBe(written.rows[0].value.id);
    const changedReplay = protectArguments("casework_submit_retaliation_report", { ...retaliation.p_arguments, p_protected_activity: "Changed replay must not persist" }, org, ring);
    expect(revealRow("casework_retaliation_reports", (await call(user, changedReplay)).rows[0].value, ring).protected_activity).toBe("Synthetic protected activity");
    const workspace = await as(user, "select public.get_member_support_workspace() value");
    expect(workspace.rows[0].value.accommodations.some((row) => row.id === report && row.description === "[encrypted]")).toBe(true);
    expect((await as(otherUser, "select * from public.casework_retaliation_reports where id=$1", [written.rows[0].value.id])).rows).toHaveLength(0);
    // R3: report RLS and the source RPC must agree for a restricted singleton.
    // An unassigned coordinator may not restrict a case away from herself
    // (BUG-UG-WEB-CASE-RESTRICT-LOCKS-OUT-COORDINATOR-20261003), so the
    // restriction under test is made while assigned, then the assignment is
    // removed.
    expect((await as(staff, "select public.casework_set_restriction($1,true,'Synthetic restriction')", [caseId])).code).toBe("22023");
    await client.query("update public.member_cases set coordinator_user_id=$2 where id=$1", [caseId, staff]);
    expect((await as(staff, "select public.casework_set_restriction($1,true,'Synthetic restriction')", [caseId])).code).toBeUndefined();
    await client.query("update public.member_cases set coordinator_user_id=null where id=$1", [caseId]);
    expect((await as(staff, "select * from public.casework_retaliation_reports where case_id=$1", [caseId])).rows).toHaveLength(0);
    const restrictedSource = await as(staff, "select * from public.sensitive_pattern_source($1)", [chapter]);
    expect(restrictedSource.code, restrictedSource.message).toBeUndefined();
    expect(restrictedSource.rows).toHaveLength(0);
    const deniedSources = { p_operation: "casework_scan_retaliation_patterns", p_arguments: { p_chapter_id: chapter,
      sources: [{ id: written.rows[0].value.id, version: written.rows[0].value.encrypted_content.management_person.dataVersion }] }, p_envelopes: { groups: [] } };
    expect((await call(staff, deniedSources)).code).toBe("PT409");
    const pendingFile = randomUUID();
    await client.query("insert into public.member_case_files(id,case_id,user_id,object_name,filename,mime_type,size_bytes,uploaded_by) values($1,$2,$3,'synthetic/pending','synthetic.txt','text/plain',4,$4)", [pendingFile,caseId,user,staff]);
    expect((await as(staff, "select public.sensitive_case_upload_target($1)", [pendingFile])).code).toBe("42501");
    expect((await as(otherUser, "select public.sensitive_case_read_current($1) current", [pendingFile])).rows[0].current).toBeNull();
    // Explicit assignment restores the same access in RLS and the scanner.
    await client.query("update public.member_cases set coordinator_user_id=$2 where id=$1", [caseId, staff]);
    expect((await as(staff, "select * from public.sensitive_pattern_source($1)", [chapter])).rows).toHaveLength(1);
    expect((await call(staff, deniedSources)).code).toBeUndefined();
    expect((await as(staff, "select public.sensitive_case_upload_target($1)", [pendingFile])).code).toBeUndefined();
    // Pending-file inspection uses an authorized lease, without opening either
    // application table to direct service-role reads.
    const encrypted = encryptCaseDocument(Buffer.from("test"), { id: pendingFile, organization_id: org, size_bytes: 4 }, ring);
    await client.query("select public.set_sensitive_case_envelope($1,$2)", [pendingFile, encrypted.envelope]);
    await client.query("insert into storage.objects(bucket_id,name,owner,version,metadata) values('case-files','synthetic/pending',$1,'enc-proof-version','{\"size\":4,\"mimetype\":\"text/plain\"}')", [staff]);
    const authorization = await as(staff, "select public.authorize_private_upload_inspection('case',$1) value", [pendingFile]);
    expect(authorization.code, authorization.message).toBeUndefined();
    const attempt = authorization.rows[0].value.attemptId;
    expect(attempt).toBeTruthy();
    expect((await client.query("select has_table_privilege('service_role','public.member_case_files','SELECT') allowed")).rows[0].allowed).toBe(false);
    for (const role of ["anon", "authenticated"]) {
      expect((await client.query("select has_function_privilege($1,'public.sensitive_case_inspection_metadata(uuid,uuid)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false);
    }
    const metadata = async (fileId = pendingFile, attemptId = attempt) => {
      await client.query("savepoint enc_metadata");
      try {
        await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
        await client.query("set local role service_role");
        return (await client.query("select public.sensitive_case_inspection_metadata($1,$2) value", [fileId, attemptId])).rows[0].value;
      } finally {
        await client.query("rollback to savepoint enc_metadata");
        await client.query("release savepoint enc_metadata");
      }
    };
    expect(await metadata()).toEqual({ id: pendingFile, size_bytes: 4, object_name: "synthetic/pending", organization_id: org, encrypted_content: encrypted.envelope });
    expect(await metadata(randomUUID())).toBeNull();
    expect(await metadata(pendingFile, randomUUID())).toBeNull();
    for (const statement of [
      "update private.private_upload_inspection_attempts set expires_at=clock_timestamp()-interval '1 second' where id=$1",
      "update private.private_upload_inspection_attempts set completed_at=clock_timestamp() where id=$1",
      "update private.private_upload_inspection_attempts set object_version='different-version' where id=$1",
      "update private.private_upload_inspection_attempts set bucket_id='member-form-files' where id=$1",
      "update private.private_upload_inspection_attempts set object_name='different/path' where id=$1",
    ]) {
      await client.query("savepoint enc_lease");
      await client.query(statement, [attempt]);
      expect(await metadata()).toBeNull();
      await client.query("rollback to savepoint enc_lease");
      await client.query("release savepoint enc_lease");
    }
    for (const column of ["removal_requested_at", "cleanup_requested_at"]) {
      await client.query("savepoint enc_lifecycle");
      await client.query(`update public.member_case_files set ${column}=clock_timestamp() where id=$1`, [pendingFile]);
      expect(await metadata()).toBeNull();
      await client.query("rollback to savepoint enc_lifecycle");
      await client.query("release savepoint enc_lifecycle");
    }
    await client.query("savepoint enc_missing_attempt");
    await client.query("delete from private.private_upload_inspection_attempts where id=$1", [attempt]);
    expect(await metadata()).toBeNull();
    await client.query("rollback to savepoint enc_missing_attempt");
    await client.query("release savepoint enc_missing_attempt");
    const second = protectArguments("casework_submit_retaliation_report", { ...retaliation.p_arguments, p_idempotency_key: randomUUID(), p_management_person: "Synthetic person", p_protected_activity: "Synthetic protected activity", p_adverse_action: "Synthetic adverse action", p_requested_support: "Synthetic support" }, org, ring);
    expect((await call(user,second)).code).toBeUndefined();
    const scanner = (actor) => ({
      auth: { getUser: async () => ({ data: { user: { id: actor } } }) },
      rpc: async (operation,args) => {
        if (operation === "sensitive_pattern_source") {
          const read = await as(actor,"select * from public.sensitive_pattern_source($1,$2)",[args.p_chapter_id,args.p_after]);
          return { data: read.rows,error: read.code };
        }
        if (operation === "stage_sensitive_write") {
          const staged = await client.query("select public.stage_sensitive_write($1,$2,$3,$4) id",[args.p_actor,args.p_operation,args.p_arguments,args.p_envelopes]);
          return { data: staged.rows[0].id };
        }
        const written = await as(actor,"select public.write_sensitive_content($1,$2,$3,$4) value",[args.p_operation,args.p_arguments,args.p_envelopes,args.p_ticket]);
        return { data: written.rows[0]?.value,error: written.code };
      },
    });
    await expect(scanSensitivePatterns(scanner(user),scanner(user),chapter,org,ring)).rejects.toThrow("scan-refused");
    await expect(scanSensitivePatterns(scanner(otherUser),scanner(otherUser),chapter,otherOrg,ring)).rejects.toThrow("scan-refused");
    await client.query("savepoint before_r2_scanner");
    await client.query(readFileSync(new URL("./fixtures/sensitive-pattern-scanner-before-r2.sql",import.meta.url),"utf8"));
    await expect(scanSensitivePatterns(scanner(staff),scanner(staff),chapter,org,ring)).rejects.toThrow("scan-refused");
    await client.query("rollback to savepoint before_r2_scanner");
    expect(await scanSensitivePatterns(scanner(staff),scanner(staff),chapter,org,ring)).toBe(1);
    const pattern = (await as(staff,"select * from public.casework_retaliation_patterns where chapter_id=$1",[chapter])).rows[0];
    expect(pattern.subject_label).toBe("[encrypted]");
    expect(pattern.fingerprint).toBe(pattern.id);
    expect(revealRow("casework_retaliation_patterns",pattern,ring).subject_label).toBe("synthetic person");
    expect((await as(user,"select * from public.casework_retaliation_patterns where id=$1",[pattern.id])).rows).toHaveLength(0);
    // A second coordinator's broader detection survives a partial overlapping scan.
    const broad = randomUUID(), hiddenCase = randomUUID();
    sessions.set(broad,randomUUID());
    await client.query("insert into auth.users(id,email) values($1,$2)",[broad,`${broad}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",[sessions.get(broad),broad]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic broad factor','totp','verified',now(),now())",[randomUUID(),broad]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[org,broad]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())",[broad,chapter]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)",[broad,chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1",[broad,chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)",[org,broad]);
    await client.query("insert into public.member_cases(id,user_id,reference,title,case_type) values($1,$2,$3,'Synthetic restricted source','other')",[hiddenCase,user,`enc-${hiddenCase}`]);
    expect((await as(broad,"select public.casework_set_restriction($1,true,'Synthetic restriction')",[hiddenCase])).code).toBe("22023");
    await client.query("update public.member_cases set coordinator_user_id=$2 where id=$1",[hiddenCase,broad]);
    expect((await as(broad,"select public.casework_set_restriction($1,true,'Synthetic restriction')",[hiddenCase])).code).toBeUndefined();
    await client.query("insert into public.casework_access_grants(case_id,organization_id,grantee_user_id,granted_by,chapter_id,reason) values($1,$2,$3,$4,$5,'Synthetic broad access')",[caseId,org,broad,staff,chapter]);
    const third = protectArguments("casework_submit_retaliation_report", { ...retaliation.p_arguments,p_case_id:hiddenCase,p_idempotency_key:randomUUID(),p_management_person:"Synthetic person",p_protected_activity:"Synthetic activity",p_adverse_action:"Synthetic action",p_requested_support:"Synthetic support" },org,ring);
    expect((await call(user,third)).code).toBeUndefined();
    expect(await scanSensitivePatterns(scanner(broad),scanner(broad),chapter,org,ring)).toBe(1);
    const broader = (await client.query("select id from public.casework_retaliation_patterns where chapter_id=$1",[chapter])).rows[0].id;
    expect((await as(staff,"select * from public.sensitive_pattern_source($1)",[chapter])).rows).toHaveLength(2);
    const definition = (await client.query("select pg_get_functiondef('public.casework_scan_retaliation_patterns(text)'::regprocedure) body")).rows[0].body;
    const containment = "      and not exists(select 1 from public.casework_retaliation_pattern_reports link\n        where link.pattern_id = p.id\n          and not sources @> jsonb_build_array(jsonb_build_object('id',link.report_id)))\n";
    expect(definition).toContain(containment);
    await client.query("savepoint former_overlap_delete");
    await client.query(definition.replace(containment,""));
    expect(await scanSensitivePatterns(scanner(staff),scanner(staff),chapter,org,ring)).toBe(1);
    expect((await client.query("select id from public.casework_retaliation_patterns where id=$1",[broader])).rows).toHaveLength(0);
    await client.query("rollback to savepoint former_overlap_delete");
    expect(await scanSensitivePatterns(scanner(staff),scanner(staff),chapter,org,ring)).toBe(1);
    expect((await client.query("select report_count from public.casework_retaliation_patterns where id=$1",[broader])).rows).toEqual([{ report_count:3 }]);
    expect((await client.query("select report_id from public.casework_retaliation_pattern_reports where pattern_id=$1",[broader])).rows).toHaveLength(3);

    expect((await as(user,"select public.stage_sensitive_write($1,$2,$3,$4)",[user,accommodation.p_operation,accommodation.p_arguments,accommodation.p_envelopes])).code).toBe("42501");
    expect((await as(user,"select public.casework_scan_retaliation_patterns($1)",[chapter])).code).toBe("42501");
    // Independently exercise the direct RPC from an under-review state.
    const directId = randomUUID();
    expect((await call(user,protectArguments("create_member_accommodation_request", { p_idempotency_key:directId,p_request_type:"schedule",p_description:"Synthetic direct withdrawal" },org,ring))).code).toBeUndefined();
    expect((await call(staff,protectArguments("transition_member_accommodation_request", { p_request_id:directId,p_status:"under_review",p_staff_note:"Synthetic staff-only direct assessment",p_idempotency_key:randomUUID() },org,ring))).code).toBeUndefined();
    const directBefore = (await client.query("select encrypted_content from public.member_accommodation_requests where id=$1",[directId])).rows[0].encrypted_content;
    const direct = await as(user,"select public.transition_member_accommodation_request($1,'withdrawn','injected',$2) value",[directId,randomUUID()]);
    expect(direct.code).toBeUndefined();
    expect(direct.rows[0].value.status).toBe("withdrawn");
    expect((await client.query("select encrypted_content from public.member_accommodation_requests where id=$1",[directId])).rows[0].encrypted_content).toEqual(directBefore);
    const unusedTicket = (await client.query("select public.stage_sensitive_write($1,$2,$3,$4) id",[user,accommodation.p_operation,accommodation.p_arguments,accommodation.p_envelopes])).rows[0].id;
    expect((await as(otherUser,"select public.write_sensitive_content($1,$2,$3,$4)",[accommodation.p_operation,accommodation.p_arguments,accommodation.p_envelopes,unusedTicket])).code).toBe("42501");
    await client.query("update private.sensitive_write_tickets set expires_at=now()-interval '1 minute' where id=$1",[unusedTicket]);
    expect((await as(user,"select public.write_sensitive_content($1,$2,$3,$4)",[accommodation.p_operation,accommodation.p_arguments,accommodation.p_envelopes,unusedTicket])).code).toBe("42501");
    const withdrawal = protectArguments("casework_withdraw_retaliation_report", { p_report_id: written.rows[0].value.id, p_reason: "Synthetic private withdrawal" }, org, ring);
    expect((await call(user,withdrawal,"aal1")).code).toBe("42501");
    expect(revealRow("casework_retaliation_reports", (await call(user, withdrawal)).rows[0].value, ring).withdrawal_reason).toBe("Synthetic private withdrawal");
    expect((await as(user, "select public.set_sensitive_case_envelope($1,'{}')", [randomUUID()])).code).toBe("42501");
    const catalogs = await client.query("select relrowsecurity from pg_class where oid in ('public.member_accommodation_requests'::regclass,'public.casework_retaliation_reports'::regclass,'public.member_case_files'::regclass)");
    expect(catalogs.rows.every((row) => row.relrowsecurity)).toBe(true);
  } finally { await client.query("rollback"); await client.end(); }
}, 30000);
