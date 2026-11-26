// @vitest-environment node
// #9160: real founder RPC, operator boundary, suppression and atomic intake link.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrationFiles } from "./helpers/migration.js";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const TAG = "intake-founder-proof";


function hex(seed) {
  return createHash("sha256").update(`${TAG}:${seed}`).digest("hex");
}

async function connect() {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: TAG,
  });
  await client.connect();
  return client;
}

async function asRole(client, role, claims = {}) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, ...claims })]);
  if (role !== "postgres") await client.query(`set local role ${role}`);
}

async function asMember(client, who) {
  await asRole(client, "authenticated", { sub: who.user, aal: "aal2", session_id: who.session, amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] });
}

async function call(client, sql, params = []) {
  const { rows } = await client.query(`select ${sql} as result`, params);
  return rows[0].result;
}

async function sql(client, text, params = []) {
  await asRole(client, "postgres");
  const { rows } = await client.query(text, params);
  await asRole(client, "service_role");
  return rows;
}

// An auth user with a verified factor and a live aal2 session.
async function person(client) {
  const user = randomUUID();
  const session = randomUUID();
  await sql(client, "insert into auth.users(id, email) values ($1, $2)", [user, `${TAG}.${user.slice(0, 8)}@example.invalid`]);
  await sql(client, "insert into auth.mfa_factors(id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), user]);
  await sql(client, "insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [session, user]);
  return { user, session };
}

async function operator(client) {
  const who = await person(client);
  await call(client, "public.set_platform_operator_intake_review($1, true, 'Fixture intake reviewer', $2)", [who.user, randomUUID()]);
  return who;
}

async function expectRefusal(client, attempt, code, message) {
  await client.query("savepoint refusal_probe");
  const error = await attempt().then(() => null, (caught) => caught);
  await client.query("rollback to savepoint refusal_probe");
  expect(error, `expected ${code} ${message ?? ""}`).not.toBeNull();
  expect(error.code).toBe(code);
  if (message) expect(error.message).toBe(message);
}

async function withCase(run) {
  const client = await connect();
  try {
    await client.query("begin");
    await client.query("set local statement_timeout = '20s'");
    await asRole(client, "postgres");
    await client.query("delete from public.public_interest_submissions where email like $1", [`${TAG}%`]);
    await asRole(client, "service_role");
    await run(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

async function joinRow(client, patch = {}) {
  const email = `${TAG}-${randomUUID()}@example.invalid`;
  const [row] = await sql(client, `insert into public.public_interest_submissions
    (email, interest, source, locale, organization_name, role, status)
    values ($1, 'request_to_join', 'request-to-join', 'en', 'Fictional Intake Union', 'officer', 'new') returning *`, [email]);
  if (patch.status) await sql(client, "update public.public_interest_submissions set status = $2 where id = $1", [row.id, patch.status]);
  return row;
}
// Random hex UUIDs sometimes contain phone-like digit runs. Organization-name
// validation correctly rejects those; use letters for the unique fixture name.
const uniqueName = () => randomUUID().replace(/[0-9]/g, digit => "abcdefghij"[Number(digit)]);
const invite = (client, who, id, name = `Fictional Intake ${uniqueName()}`, full = " Alex Fixtureperson ") =>
  call(client, "public.create_intake_founder_invitation($1,$2,$3,$4,$5,$6)", [who.user, who.session, id, name, full, hex(randomUUID())]);
async function stopToken(client, email) {
  const token = hex(randomUUID());
  expect(await call(client, "public.request_public_interest_stop($1,'en','public-landing','',$2,$3,$4)",
    [email, hex(randomUUID()), hex(randomUUID()), token])).toEqual({ accepted: true, pending: true });
  return token;
}
const operatorStop = (client, email) => call(client, "public.stop_public_interest($1,'en','public-landing','',$2,$3)", [email, hex(randomUUID()), hex(randomUUID())]);
const stop = (client, token) => call(client, "public.confirm_public_interest_stop($1,$2)", [token, hex(randomUUID())]);

async function claimFounder(client, invitationId) {
  const [invitation] = await sql(client, "select * from public.member_invitations where id=$1", [invitationId]);
  expect(await call(client, "public.claim_member_invitation($1)", [invitation.token_hash]))
    .toMatchObject({ available: true, kind: "founder", invitationId });
  return invitation;
}

async function provisionalFounder(client, invitation) {
  const user = randomUUID();
  await sql(client, `insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,raw_app_meta_data,banned_until)
    values ($1,$2,now(),$3,$4,now()+interval '100 years')`, [user, invitation.normalized_email,
    JSON.stringify({ full_name: invitation.full_name, first_name: invitation.first_name, initials: invitation.initials,
      chapter_id: invitation.chapter_id, union_base_invitation_id: invitation.id }),
    JSON.stringify({ union_ground_provisioning: "pending" })]);
  return user;
}

async function finishFounder(client, invitation) {
  const user = await provisionalFounder(client, invitation);
  expect(await call(client, "public.finalize_member_invitation($1,$2)", [invitation.id, user])).toMatchObject({ prepared: true });
  await sql(client, "update auth.users set raw_app_meta_data='{\"union_ground_provisioning\":\"active\"}', banned_until=null where id=$1", [user]);
  expect(await call(client, "public.complete_member_invitation_activation($1,$2)", [invitation.id, user]))
    .toMatchObject({ accepted: true, userId: user });
  return user;
}

async function storedDelivery(client, id) {
  const [result] = await sql(client, `select jsonb_build_object('id',id,'status',status,
    'expiresAt',expires_at,'sentAt',sent_at) as invitation from public.member_invitations where id=$1`, [id]);
  return result.invitation;
}

live("founder from a join row (live)", () => {
  it("accepts all reviewed installed predecessors and rejects drift in each restated function", async () => {
    const files = migrationFiles();
    const current = files.find((file) => file.name.endsWith("_intake_founder_invitation.sql"));
    const guard = current.sql.match(/do \$predecessor\$[\s\S]*?\$predecessor\$;/)?.[0];
    expect(guard).toBeTypeOf("string");
    const names = ["private.intake_review_row", "public.confirm_public_interest_stop", "public.stop_public_interest",
      "public.resend_organization_founder_invitation", "public.record_organization_founder_invitation_delivery"];
    const prior = new Map();
    for (const file of files.filter((file) => file.name < current.name)) {
      for (const fn of parseFunctions(file.sql).filter((fn) => names.includes(fn.name))) {
        const definition = file.sql.slice(fn.offset).match(/^[\s\S]*?\bas\s+(\$\w*\$)[\s\S]*?\1;/i)?.[0];
        expect(definition, fn.name).toBeTypeOf("string");
        prior.set(fn.name, { ...fn, definition: definition.replace(/^\s*create\s+(?:or\s+replace\s+)?function/i, "create or replace function") });
      }
    }
    expect([...prior.keys()].sort()).toEqual([...names].sort());
    await withCase(async (client) => {
      await asRole(client, "postgres");
      await client.query("set local search_path=pg_catalog");
      for (const { definition } of prior.values()) await client.query(definition);
      await client.query(guard);
      for (const [name, { definition, source }] of prior) {
        await client.query("savepoint predecessor_drift");
        await client.query(definition.replace(source, () => `${source}\n-- unreviewed installed drift\n`));
        await expect(client.query(guard)).rejects.toMatchObject({ code: "55000", message: `unreviewed predecessor: ${name}` });
        await client.query("rollback to savepoint predecessor_drift");
      }
      await client.query(guard);
    });
  });
  it.each(["sent", "failed"])("returns authoritative persisted founder delivery fields (%s)", async (outcome) => {
    await withCase(async (client) => {
      const who = await operator(client), row = await joinRow(client), issued = await invite(client, who, row.id);
      const receipt = await call(client, "public.record_organization_founder_invitation_delivery($1,1,$2)", [issued.invitationId, outcome]);
      expect(receipt).toEqual({ recorded: true, invitation: await storedDelivery(client, issued.invitationId) });
      expect(receipt.invitation.status).toBe(outcome === "sent" ? "pending" : "delivery_failed");
      if (outcome === "sent") expect(receipt.invitation.sentAt).not.toBeNull();
    });
  });
  it.each(["pending", "accepted", "delivery_failed"])("projects the current resend descendant after failed delivery (%s)", async (status) => {
    await withCase(async (client) => {
      const who = await operator(client), row = await joinRow(client), issued = await invite(client, who, row.id);
      await call(client, "public.record_organization_founder_invitation_delivery($1,1,'failed')", [issued.invitationId]);
      const resent = await call(client, "public.resend_organization_founder_invitation($1,$2)", [issued.invitationId, hex(randomUUID())]);
      expect(resent).toMatchObject({ status: "invited", send: true, deliveryVersion: 2 });
      if (status === "accepted") await finishFounder(client, await claimFounder(client, resent.invitationId));
      else await call(client, "public.record_organization_founder_invitation_delivery($1,2,$2)", [resent.invitationId, status === "pending" ? "sent" : "failed"]);
      const list = await call(client, "public.list_intake_requests($1,$2,'join',null,null,null,null,100)", [who.user, who.session]);
      const expected = await storedDelivery(client, resent.invitationId);
      expect(list.requests.find((request) => request.id === row.id).founderInvitation).toEqual(expected);
      expect(expected).toMatchObject({ id: resent.invitationId, status });
      expect(await invite(client, who, row.id)).toMatchObject({ repeated: true, send: false,
        invitationId: resent.invitationId, request: { founderInvitation: expected } });
      expect(await sql(client, "select invitation_id from private.intake_review_events where action='founder_invite' and submission_id=$1", [row.id]))
        .toEqual([{ invitation_id: issued.invitationId }]);
    });
  });
  it.each(["intake", "cli"].flatMap((origin) => ["operator", "confirmed", "no-stop"].map((method) => ({ origin, method }))))
    ("refuses a founder resend after accepting, stop and failed acceptance; no-stop control still sends ($origin / $method)", async ({ origin, method }) => {
      await withCase(async (client) => {
        const who = await operator(client), row = await joinRow(client);
        const issued = origin === "intake" ? await invite(client, who, row.id)
          : await call(client, "public.create_organization_founder_invitation($1,$2,'Alex Fixtureperson','en',$3,$4)",
            [`Fictional Intake ${uniqueName()}`, row.email, hex(randomUUID()), randomUUID()]);
        const token = await stopToken(client, row.email);
        const invitation = await claimFounder(client, issued.invitationId);
        const provisional = await provisionalFounder(client, invitation);
        if (method !== "no-stop") {
          expect(method === "operator" ? await operatorStop(client, row.email) : await stop(client, token))
            .toEqual(method === "operator" ? { accepted: true } : { confirmed: true });
          expect(await sql(client, "select status from public.member_invitations where id=$1", [issued.invitationId])).toEqual([{ status: "accepting" }]);
          expect(await sql(client, "select count(*)::int n from public.public_interest_submissions where id=$1", [row.id])).toEqual([{ n: 0 }]);
        }
        // Same recovery order as the acceptance endpoint's password-mail failure.
        await sql(client, "delete from auth.users where id=$1", [provisional]);
        expect(await call(client, "public.fail_member_invitation_accept($1,'provider_unavailable')", [issued.invitationId])).toEqual({ recorded: true });
        const resent = await call(client, "public.resend_organization_founder_invitation($1,$2)", [issued.invitationId, hex(randomUUID())]);
        if (method === "no-stop") expect(resent).toMatchObject({ status: "invited", send: true });
        else {
          expect(resent).toEqual({ status: "unavailable", send: false });
          expect(await sql(client, "select count(*)::int n from public.member_invitations where replaces_id=$1", [issued.invitationId])).toEqual([{ n: 0 }]);
        }
      });
    });
  it.each(["operator", "confirmed"])("allows an acceptance already in progress to finish after a %s stop", async (method) => {
    await withCase(async (client) => {
      const who = await operator(client), row = await joinRow(client), issued = await invite(client, who, row.id);
      const token = await stopToken(client, row.email), invitation = await claimFounder(client, issued.invitationId);
      expect(method === "operator" ? await operatorStop(client, row.email) : await stop(client, token))
        .toEqual(method === "operator" ? { accepted: true } : { confirmed: true });
      const user = await finishFounder(client, invitation);
      expect(await storedDelivery(client, issued.invitationId)).toMatchObject({ status: "accepted" });
      expect(await sql(client, "select user_id from public.organization_role_grants where organization_id=$1 and role='admin'", [issued.organizationId]))
        .toEqual([{ user_id: user }]);
    });
  });
  it("reuses the founder function, binds the address, links the invitation, audits only ids and status, and repeats without another organization", async () => {
    await withCase(async (client) => {
      const who = await operator(client), row = await joinRow(client);
      const first = await invite(client, who, row.id);
      expect(first).toMatchObject({ invited: true, repeated: false, send: true, normalizedEmail: row.email,
        request: { id: row.id, name: null, status: "invited", founderInvitation: { id: first.invitationId, status: "pending" } } });
      const [invitation] = await sql(client, "select full_name, normalized_email, kind, invited_by from public.member_invitations where id=$1", [first.invitationId]);
      expect(invitation).toEqual({ full_name: "Alex Fixtureperson", normalized_email: row.email, kind: "founder", invited_by: null });
      expect(await invite(client, who, row.id)).toMatchObject({ invited: true, repeated: true, send: false, invitationId: first.invitationId });
      const [audit] = await sql(client, "select action, actor_user_id, submission_id, invitation_id, from_status, to_status from private.intake_review_events where submission_id=$1 and action='founder_invite'", [row.id]);
      expect(audit).toEqual({ action: "founder_invite", actor_user_id: who.user, submission_id: row.id, invitation_id: first.invitationId, from_status: "new", to_status: "invited" });
      expect(await sql(client, "select count(*)::int n from public.organization_audit_ledger where idempotency_key=$1", [row.id])).toEqual([{ n: 1 }]);
      const list = await call(client, "public.list_intake_requests($1,$2,'join',null,null,null,null,100)", [who.user, who.session]);
      expect(list.requests.find(r => r.id === row.id).founderInvitation).toMatchObject({ id: first.invitationId, status: "pending" });
      expect(await sql(client, "select count(*)::int n from auth.users where email=$1", [row.email])).toEqual([{ n: 0 }]);
    });
  });
  it("refuses nonoperators, another organization's administrator, missing or revoked or non-aal2 sessions, anon, authenticated and a bare service role", async () => {
    await withCase(async (client) => {
      const row = await joinRow(client), stranger = await person(client), who = await operator(client);
      await expectRefusal(client, () => invite(client, stranger, row.id), "42501", "intake reviewer required");
      // Being an administrator of a different tenant confers no platform capability.
      await sql(client, "insert into public.organizations(id, slug, name) values ($1,$2,'Fictional Foreign Tenant')", [stranger.user, `foreign-${stranger.user}`]);
      await sql(client, "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$1,'active')", [stranger.user]);
      await sql(client, "insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$1,'admin')", [stranger.user]);
      await expectRefusal(client, () => invite(client, stranger, row.id), "42501", "intake reviewer required");
      for (const role of ["anon", "authenticated"]) {
        await asRole(client, role, { sub: who.user, session_id: who.session, aal: "aal2" });
        await expectRefusal(client, () => invite(client, who, row.id), "42501");
      }
      await asRole(client, "service_role");
      await expectRefusal(client, () => invite(client, { user: null, session: null }, row.id), "42501", "intake reviewer required");
      await call(client, "public.set_platform_operator_intake_review($1, false, 'Fixture revoke', $2)", [who.user, randomUUID()]);
      await expectRefusal(client, () => invite(client, who, row.id), "42501", "intake reviewer required");
      await call(client, "public.set_platform_operator_intake_review($1, true, 'Fixture restore', $2)", [who.user, randomUUID()]);
      await sql(client, "update auth.sessions set aal='aal1' where id=$1", [who.session]);
      await expectRefusal(client, () => invite(client, who, row.id), "42501", "intake reviewer required");
      await sql(client, "delete from auth.sessions where id=$1", [who.session]);
      await expectRefusal(client, () => invite(client, who, row.id), "42501", "intake reviewer required");
    });
  });
  it("refuses wrong kind, tenant rows, closed rows and suppressed addresses; preserves all founder validation", async () => {
    await withCase(async (client) => {
      const who = await operator(client), row = await joinRow(client);
      expect(await invite(client, who, randomUUID())).toEqual({ invited: false, refusal: "not-found" });
      await sql(client, "update public.public_interest_submissions set status='closed' where id=$1", [row.id]);
      expect(await invite(client, who, row.id)).toEqual({ invited: false, refusal: "closed" });
      await sql(client, "update public.public_interest_submissions set status='new' where id=$1", [row.id]);
      for (const full of [null, "x", "x".repeat(121), "Alex\u0007"]) await expectRefusal(client, () => invite(client, who, row.id, "Fictional Intake", full), "22023");
      await expectRefusal(client, () => invite(client, who, row.id, "Fictional Intake 1234567"), "22023", "invalid founder invitation");
      await sql(client, "insert into private.public_interest_suppressions(suppression_scope_hash,source,locale) values(private.public_interest_suppression_scope($1),'public-landing','en')", [row.email]);
      expect(await invite(client, who, row.id)).toEqual({ invited: false, refusal: "stopped" });
      expect(await sql(client, "select count(*)::int n from private.intake_review_events where action='founder_invite' and submission_id=$1", [row.id])).toEqual([{ n: 0 }]);
      const [updates] = await sql(client, "insert into public.public_interest_submissions(email,interest,source,locale) values($1,'union_news','public-landing','en') returning id", [`${TAG}-updates@example.invalid`]);
      expect(await invite(client, who, updates.id)).toEqual({ invited: false, refusal: "not-join" });
      const tenant = randomUUID();
      await sql(client, "insert into public.organizations(id,slug,name) values($1,$2,'Fictional Tenant Lead')", [tenant, `tenant-${tenant}`]);
      await sql(client, "update public.public_interest_submissions set organization_id=$2 where id=$1", [updates.id, tenant]);
      expect(await invite(client, who, updates.id)).toEqual({ invited: false, refusal: "not-found" });
    });
  });
  it("keeps the founder's existing-account and taken-organization checks atomic", async () => {
    await withCase(async (client) => {
      const who = await operator(client), one = await joinRow(client), two = await joinRow(client);
      const name = `Fictional Collision ${uniqueName()}`;
      const created = await invite(client, who, one.id, name);
      expect(created.invited).toBe(true);
      expect(await invite(client, who, two.id, name)).toEqual({ invited: false, refusal: "name_unavailable" });
      await sql(client, "insert into auth.users(id,email) values($1,$2)", [randomUUID(), two.email]);
      expect(await invite(client, who, two.id)).toEqual({ invited: false, refusal: "email_unavailable" });
      expect(await sql(client, "select status,name from public.public_interest_submissions where id=$1", [two.id])).toEqual([{ status: "new", name: null }]);
    });
  });
  it.each(["invite-first", "stop-first", "two-operators"])("serializes %s without two invitations or a live link after stop", async (order) => {
    const a = await connect(), b = await connect();
    let row;
    try {
      await a.query("begin"); await asRole(a, "service_role");
      const who = await operator(a), other = await operator(a);
      row = await joinRow(a);
      const token = await stopToken(a, row.email);
      await a.query("commit"); await a.query("begin"); await b.query("begin");
      await asRole(a, "service_role"); await asRole(b, "service_role");
      const first = order === "stop-first" ? await stop(a, token) : await invite(a, who, row.id);
      const pending = order === "two-operators" ? invite(b, other, row.id) : order === "stop-first" ? invite(b, who, row.id) : stop(b, token);
      await a.query("commit");
      const second = await pending; await b.query("commit");
      if (order === "two-operators") {
        expect(second).toMatchObject({ invited: true, repeated: true, send: false, invitationId: first.invitationId });
      } else if (order === "stop-first") {
        expect(first).toEqual({ confirmed: true }); expect(second).toEqual({ invited: false, refusal: "not-found" });
      } else {
        expect(second).toEqual({ confirmed: true });
        expect(await sql(a, "select status,token_hash from public.member_invitations where id=$1", [first.invitationId])).toEqual([{ status: "revoked", token_hash: null }]);
        expect(await sql(a, "select count(*)::int n from public.public_interest_submissions where id=$1", [row.id])).toEqual([{ n: 0 }]);
      }
    } finally {
      await a.query("rollback").catch(() => {}); await b.query("rollback").catch(() => {});
      try {
        // The two-operator variant commits without a stop deleting its row.
        // Remove only this case's fixture before the global join-list proofs.
        if (row) {
          await asRole(a, "postgres");
          await a.query("delete from public.public_interest_submissions where id=$1", [row.id]);
        }
      } finally { await a.end(); await b.end(); }
    }
  });
  it.each(["operator", "confirmed"])("revokes the founder resend chain after the intake row is gone (%s stop)", async (method) => {
    await withCase(async (client) => {
      const who = await operator(client), row = await joinRow(client);
      const issued = await invite(client, who, row.id), token = await stopToken(client, row.email);
      await sql(client, "update public.member_invitations set expires_at=now()-interval '1 minute' where id=$1", [issued.invitationId]);
      const resent = await call(client, "public.resend_organization_founder_invitation($1,$2)", [issued.invitationId, hex(randomUUID())]);
      expect(resent).toMatchObject({ status: "invited", send: true });
      // Stop must find the retained ids-only audit link through the invitation
      // address, even after an earlier operation has removed the intake row.
      await sql(client, "delete from public.public_interest_submissions where id=$1", [row.id]);
      expect(method === "operator" ? await operatorStop(client, row.email) : await stop(client, token))
        .toEqual(method === "operator" ? { accepted: true } : { confirmed: true });
      expect(await sql(client, "select status,token_hash from public.member_invitations where id=any($1::uuid[]) order by delivery_version", [[issued.invitationId, resent.invitationId]]))
        .toEqual([{ status: "superseded", token_hash: null }, { status: "revoked", token_hash: null }]);
      for (const id of [issued.invitationId, resent.invitationId]) {
        expect(await call(client, "public.resend_organization_founder_invitation($1,$2)", [id, hex(randomUUID())]))
          .toEqual({ status: "unavailable", send: false });
      }
    });
  });
  it.each(["invite-first", "operator-stop-first"])("serializes founder invitation against operator stop (%s)", async (order) => {
    const a = await connect(), b = await connect();
    try {
      await a.query("set statement_timeout='20s'"); await b.query("set statement_timeout='20s'");
      await a.query("begin"); await asRole(a, "service_role");
      const who = await operator(a), row = await joinRow(a);
      await a.query("commit"); await a.query("begin"); await b.query("begin");
      await asRole(a, "service_role"); await asRole(b, "service_role");
      const first = order === "invite-first" ? await invite(a, who, row.id) : await operatorStop(a, row.email);
      const pending = order === "invite-first" ? operatorStop(b, row.email) : invite(b, who, row.id);
      await a.query("commit");
      const second = await pending; await b.query("commit");
      await a.query("begin"); await asRole(a, "service_role");
      if (order === "operator-stop-first") {
        expect(first).toEqual({ accepted: true });
        expect(second).toEqual({ invited: false, refusal: "not-found" });
      } else {
        expect(second).toEqual({ accepted: true });
        expect(await sql(a, "select status,token_hash from public.member_invitations where id=$1", [first.invitationId]))
          .toEqual([{ status: "revoked", token_hash: null }]);
        expect(await call(a, "public.resend_organization_founder_invitation($1,$2)", [first.invitationId, hex(randomUUID())]))
          .toEqual({ status: "unavailable", send: false });
      }
      expect(await sql(a, "select count(*)::int n from public.public_interest_submissions where id=$1", [row.id])).toEqual([{ n: 0 }]);
    } finally {
      await a.query("rollback").catch(() => {}); await b.query("rollback").catch(() => {});
      await a.end(); await b.end();
    }
  });
  it("allows a direct stop and one-click unsubscribe of the same token to finish with one consistent refusal", async () => {
    const a = await connect(), b = await connect();
    try {
      await a.query("begin"); await asRole(a, "service_role");
      const row = await joinRow(a), who = await operator(a);
      const issued = await invite(a, who, row.id), token = await stopToken(a, row.email);
      await a.query("commit");
      await a.query("begin"); await asRole(a, "postgres");
      await a.query("select token_hash from private.public_interest_stop_confirmations where token_hash=$1 for update", [token]);
      await asRole(a, "service_role"); await b.query("begin"); await asRole(b, "service_role");
      const other = call(b, "public.confirm_public_interest_unsubscribe($1,$2)", [token, hex(randomUUID())]);
      expect(await stop(a, token)).toEqual({ confirmed: true });
      await a.query("commit");
      expect(await other).toEqual({ confirmed: false, refusal: "unavailable" });
      await b.query("commit");
      expect(await sql(a, "select status,token_hash from public.member_invitations where id=$1", [issued.invitationId])).toEqual([{ status: "revoked", token_hash: null }]);
    } finally {
      await a.query("rollback").catch(() => {}); await b.query("rollback").catch(() => {});
      await a.end(); await b.end();
    }
  });
});
