// @vitest-environment node
// REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118 (owner
// option b): live proof on the disposable stack that an intake_review
// operator passes one stored invite request to an organization's
// administrators as an invitation suggestion under Requests; that the pass
// is refused for other kinds of rows, stopped addresses, unknown, inactive
// and chapterless organizations and organizations nobody can decide for;
// that it is one pass per request and organization, audited, and moves the
// request to contacted; that the administrators see it, decline it or
// approve it into an invitation exactly like a member's suggestion; and that
// a confirmed stop deletes it. Ordinary cases roll back; the two-connection
// stop regression commits its owned fixtures and removes them in finally.
// The offline pins are tests/intake-review-pass-migration.test.js.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const TAG = "intake-pass-proof";
const INVITE = `${TAG}-invite@example.invalid`;

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

function submitInvite(client, email, seed, patch = {}) {
  const f = { name: "Alex Fixtureperson", organization: "Example Workers Local 12", note: "North site.\r\nStarting soon.", ...patch };
  return call(client, "public.submit_invite_request($1, $2, $3, $4, 'en', '', $5, $6)", [
    email, f.name, f.organization, f.note, hex(`network:${seed}`), hex(`email:${email}:${seed}`),
  ]);
}

async function inviteRow(client, email = INVITE, seed = "first", patch = {}) {
  expect(await submitInvite(client, email, seed, patch)).toMatchObject({ stored: true });
  const [row] = await sql(client, "select id, status from public.public_interest_submissions where email = $1 and source = 'request-invite'", [email]);
  return row;
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

// A fictional organization with a default chapter and, unless asked
// otherwise, one active organization administrator.
async function organization(client, { name = `Fictional Pass Union ${randomUUID().slice(0, 6)}`, status = "active", defaultChapter = true, admin = true } = {}) {
  const org = randomUUID();
  const chapter = `pass-proof-${org.slice(0, 12)}`;
  await sql(client, "insert into public.organizations(id, slug, name, status) values ($1, $2, $3, $4)", [org, chapter, name, status]);
  await sql(client, "insert into public.chapters(id, name, slug, region, organization_id, order_index, is_default) values ($1, 'Fictional pass chapter', $1, 'proof', $2, 9981, $3)", [chapter, org, defaultChapter]);
  let administrator = null;
  if (admin) {
    administrator = await person(client);
    await sql(client, "update public.member_profiles set chapter_id = $2, full_name = 'Fictional pass admin' where id = $1", [administrator.user, chapter]);
    await sql(client, "insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active') on conflict do nothing", [org, administrator.user]);
    await sql(client, "insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active') on conflict do nothing", [administrator.user, chapter]);
    await sql(client, "insert into public.organization_role_grants(organization_id, user_id, role) values ($1, $2, 'admin')", [org, administrator.user]);
  }
  return { org, chapter, name, administrator };
}

const pass = (client, who, id, org) => call(client, "public.pass_intake_invite_request($1, $2, $3, $4)", [who.user, who.session, id, org]);
const search = (client, who, prefix) => call(client, "public.search_intake_pass_organizations($1, $2, $3)", [who.user, who.session, prefix]);
const passes = (client, who, ids) => call(client, "public.list_intake_request_passes($1, $2, $3::uuid[])", [who.user, who.session, ids]);

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

live("intake review pass of an invite request (live)", () => {
  it("refuses a pass when the sole notification recipient cannot decide in the default chapter", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const target = await organization(client);
      const first = await inviteRow(client, `${TAG}-first@example.invalid`, "before-membership-revoked");
      await pass(client, reviewer, first.id, target.org);
      const [suggestion] = await sql(client, "select id from public.member_requests where intake_submission_id=$1", [first.id]);
      const other = `${target.chapter}-other`;
      await sql(client, "insert into public.chapters(id,name,slug,region,organization_id,order_index) values($1,'Other fictional chapter',$1,'proof',$2,9982)", [other, target.org]);
      await sql(client, "insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [target.administrator.user, other]);
      await asMember(client, target.administrator);
      await call(client, "public.revoke_member_chapter_membership($1,$2)", [target.administrator.user, target.chapter]);
      expect((await call(client, "public.list_member_requests('pending',20,null,null)")).items).toEqual([]);
      await expectRefusal(client, () => call(client, "public.decide_member_request($1,'declined')", [suggestion.id]), "P0002");
      await asRole(client, "service_role");
      const next = await inviteRow(client, `${TAG}-next@example.invalid`, "after-membership-revoked");
      expect(await pass(client, reviewer, next.id, target.org)).toEqual({ passed: false, refusal: "no-administrator" });
      expect(await sql(client, "select count(*)::int n from public.member_requests where intake_submission_id=$1", [next.id])).toEqual([{ n: 0 }]);
      expect(await sql(client, "select status from public.public_interest_submissions where id=$1", [next.id])).toEqual([{ status: "new" }]);
    });
  });

  it("keeps the organization President's ability to decide across chapters without default-chapter membership", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const target = await organization(client);
      const other = `${target.chapter}-other`;
      await sql(client, "insert into public.chapters(id,name,slug,region,organization_id,order_index) values($1,'Other fictional chapter',$1,'proof',$2,9982)", [other, target.org]);
      await sql(client, "insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [target.administrator.user, other]);
      await asMember(client, target.administrator);
      await call(client, "public.revoke_member_chapter_membership($1,$2)", [target.administrator.user, target.chapter]);
      await sql(client, "update public.organization_role_grants set role='vp' where organization_id=$1 and user_id=$2", [target.org, target.administrator.user]);
      const { id } = await inviteRow(client);
      expect(await pass(client, reviewer, id, target.org)).toMatchObject({ passed: true });
      await asMember(client, target.administrator);
      const listed = await call(client, "public.list_member_requests('pending',20,null,null)");
      expect(listed.items).toHaveLength(1);
      expect(await call(client, "public.decide_member_request($1,'declined')", [listed.items[0].id])).toMatchObject({ status: "declined" });
    });
  });

  it.each(["admin", "vp"])("accepts a chapter %s who can actually list and decide the default chapter's suggestion", async (role) => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const target = await organization(client, { admin: false });
      const decider = await person(client);
      await sql(client, "update public.member_profiles set chapter_id=$2 where id=$1", [decider.user, target.chapter]);
      await sql(client, "insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [target.org, decider.user]);
      await sql(client, "insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [decider.user, target.chapter]);
      await sql(client, "insert into public.member_roles(user_id,role,chapter_id,granted_by) values($1,$2,$3,$1)", [decider.user, role, target.chapter]);
      await sql(client, "insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,$2,$3,$1)", [decider.user, role, target.chapter]);
      const { id } = await inviteRow(client);
      expect(await pass(client, reviewer, id, target.org)).toMatchObject({ passed: true });
      await asMember(client, decider);
      const listed = await call(client, "public.list_member_requests('pending',20,null,null)");
      expect(listed.items).toHaveLength(1);
      expect(await call(client, "public.decide_member_request($1,'declined')", [listed.items[0].id])).toMatchObject({ status: "declined" });
    });
  });

  it.each(["deleted", "banned"])("does not treat a %s account as the only eligible decider", async (state) => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const target = await organization(client);
      await sql(client, "update auth.users set deleted_at=case when $2='deleted' then now() end, banned_until=case when $2='banned' then now()+interval '1 day' end where id=$1", [target.administrator.user, state]);
      const { id } = await inviteRow(client);
      expect(await pass(client, reviewer, id, target.org)).toEqual({ passed: false, refusal: "no-administrator" });
    });
  });

  it("serializes an immediate stop with a concurrent pass without losing the suppression", async () => {
    const passer = await connect();
    const stopper = await connect();
    const email = `${TAG}-${randomUUID()}@example.invalid`;
    let reviewer, target, request;
    let stopResult;
    let primaryError;
    try {
      await passer.query("begin");
      await asRole(passer, "service_role");
      reviewer = await operator(passer);
      target = await organization(passer);
      request = await inviteRow(passer, email, email);
      await pass(passer, reviewer, request.id, target.org);
      await passer.query("commit");

      // A pass takes this gate as its first statement. Hold that first step
      // while the other connection enters the real immediate-stop RPC.
      await passer.query("begin");
      await asRole(passer, "postgres");
      await passer.query("select private.lock_case_graph(array[]::uuid[],array[]::uuid[])");
      await asRole(passer, "service_role");
      await stopper.query("begin");
      await stopper.query("set local statement_timeout='8s'");
      await stopper.query("set local deadlock_timeout='100ms'");
      await asRole(stopper, "service_role");
      stopResult = call(stopper, "public.stop_public_interest($1,'en','public-landing','',$2,$3)", [email, hex(`stop-network:${email}`), hex(`stop-email:${email}`)])
        .then((value) => ({ value }), (error) => ({ error: { code: error.code, message: error.message } }));
      // Bounded lock synchronization, not a timing guess: wait until the
      // stop is blocked by the transaction doing the pass's first step.
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await passer.query("select $1::int=any(pg_blocking_pids($2::int)) blocked", [passer.processID, stopper.processID]);
        if (rows[0].blocked) { blocked = true; break; }
        await delay(10);
      }
      expect(blocked).toBe(true);
      const repeated = await pass(passer, reviewer, request.id, target.org);
      expect(repeated).toMatchObject({ passed: true, repeated: true });
      await passer.query("commit");
      const stopped = await stopResult;
      if (stopped.error) await stopper.query("rollback");
      else await stopper.query("commit");
      expect(stopped).toEqual({ value: { accepted: true } });
      expect(await sql(passer, "select count(*)::int n from private.public_interest_suppressions where suppression_scope_hash=private.public_interest_suppression_scope($1)", [email])).toEqual([{ n: 1 }]);
      expect(await sql(passer, "select count(*)::int n from public.public_interest_submissions where email=$1", [email])).toEqual([{ n: 0 }]);
      expect(await sql(passer, "select count(*)::int n from public.member_requests where invitee_email=$1", [email])).toEqual([{ n: 0 }]);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await passer.query("rollback").catch(() => {});
      if (stopResult) await stopResult;
      await stopper.query("rollback").catch(() => {});
      try {
        await asRole(passer, "postgres");
        await passer.query("begin");
        await passer.query("delete from public.public_interest_submissions where email=$1", [email]);
        await passer.query("delete from private.public_interest_suppressions where suppression_scope_hash=private.public_interest_suppression_scope($1)", [email]);
        if (reviewer) await passer.query("delete from private.intake_review_events where actor_user_id=$1 or subject_user_id=$1", [reviewer.user]);
        const users = [reviewer?.user, target?.administrator?.user].filter(Boolean);
        if (target) {
          await passer.query("delete from public.organization_role_grants where organization_id=$1", [target.org]);
          await passer.query("delete from public.organization_memberships where organization_id=$1", [target.org]);
        }
        await passer.query("delete from auth.users where id=any($1::uuid[])", [users]);
        if (target) {
          await passer.query("delete from public.chapters where organization_id=$1", [target.org]);
          await passer.query("delete from public.dues_member_subjects where organization_id=$1", [target.org]);
          await passer.query("delete from public.organizations where id=$1", [target.org]);
        }
        await passer.query("commit");
      } catch (error) {
        await passer.query("rollback").catch(() => {});
        if (!primaryError) throw error;
        console.error("Immediate-stop regression fixture cleanup failed", error.code, error.message);
      } finally {
        await stopper.end();
        await passer.end();
      }
    }
  }, 20_000);

  it("passes an invite request to an organization's administrators, once, audited, and moves it to contacted", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const target = await organization(client);
      const { id } = await inviteRow(client);

      const first = await pass(client, reviewer, id, target.org);
      expect(first).toMatchObject({
        passed: true, repeated: false,
        pass: { submissionId: id, organizationId: target.org, organizationName: target.name, chapterName: "Fictional pass chapter", status: "pending" },
        request: { id, kind: "invite", status: "contacted" },
      });

      const [suggestion] = await sql(client, "select * from public.member_requests where intake_submission_id = $1", [id]);
      expect(suggestion).toMatchObject({
        organization_id: target.org, chapter_id: target.chapter, kind: "invitation_suggestion", requester_user_id: null,
        invitee_name: "Alex Fixtureperson", invitee_email: INVITE, note: "North site.\nStarting soon.", status: "pending",
      });

      const repeat = await pass(client, reviewer, id, target.org);
      expect(repeat).toMatchObject({ passed: true, repeated: true, pass: { organizationId: target.org } });
      expect(await sql(client, "select count(*)::int as n from public.member_requests where intake_submission_id = $1", [id])).toEqual([{ n: 1 }]);

      expect(await sql(client, "select action, actor_user_id, submission_id, organization_id, member_request_id, from_status, to_status from private.intake_review_events where action = 'pass'")).toEqual([{
        action: "pass", actor_user_id: reviewer.user, submission_id: id, organization_id: target.org,
        member_request_id: suggestion.id, from_status: "new", to_status: "contacted",
      }]);

      // The administrator is told under Requests, named as Union Ground.
      expect(await sql(client, "select title, body from public.member_notifications where user_id = $1 and title = 'Invitation suggested'", [target.administrator.user])).toEqual([{
        title: "Invitation suggested", body: "Union Ground suggested inviting someone to Fictional pass chapter. Approve or decline it under Requests.",
      }]);

      // A second organization is a second pass; an invited request stays invited.
      const other = await organization(client);
      await sql(client, "update public.public_interest_submissions set status = 'invited' where id = $1", [id]);
      expect(await pass(client, reviewer, id, other.org)).toMatchObject({ passed: true, repeated: false, request: { status: "invited" } });
      const listed = await passes(client, reviewer, [id]);
      expect(listed.passes.map((p) => p.organizationId).sort()).toEqual([target.org, other.org].sort());
    });
  });

  it("refuses rows that are not invite requests, stopped addresses and organizations that cannot take it", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const target = await organization(client);
      const { id } = await inviteRow(client);

      expect(await pass(client, reviewer, randomUUID(), target.org)).toEqual({ passed: false, refusal: "not-found" });
      const [updates] = await sql(client, "insert into public.public_interest_submissions (email, interest, locale, source) values ($1, 'chapter_updates', 'en', 'public-landing') returning id", [`${TAG}-updates@example.invalid`]);
      expect(await pass(client, reviewer, updates.id, target.org)).toEqual({ passed: false, refusal: "not-invite" });
      const [tenantLead] = await sql(client, "insert into public.public_interest_submissions (email, interest, locale, source, organization_id) values ($1, 'chapter_updates', 'en', 'public-landing', $2) returning id", [`${TAG}-tenant@example.invalid`, target.org]);
      expect(await pass(client, reviewer, tenantLead.id, target.org)).toEqual({ passed: false, refusal: "not-found" });

      expect(await pass(client, reviewer, id, randomUUID())).toEqual({ passed: false, refusal: "organization-unavailable" });
      const suspended = await organization(client, { status: "suspended", admin: false });
      expect(await pass(client, reviewer, id, suspended.org)).toEqual({ passed: false, refusal: "organization-unavailable" });
      const chapterless = await organization(client, { defaultChapter: false });
      expect(await pass(client, reviewer, id, chapterless.org)).toEqual({ passed: false, refusal: "organization-unavailable" });
      const unattended = await organization(client, { admin: false });
      expect(await pass(client, reviewer, id, unattended.org)).toEqual({ passed: false, refusal: "no-administrator" });

      // A stopped address: the suppression row exists even if the row survived.
      await sql(client, "insert into private.public_interest_suppressions (suppression_scope_hash, source, locale) values (private.public_interest_suppression_scope($1), 'public-landing', 'en')", [INVITE]);
      expect(await pass(client, reviewer, id, target.org)).toEqual({ passed: false, refusal: "stopped" });

      expect(await sql(client, "select count(*)::int as n from public.member_requests where intake_submission_id is not null")).toEqual([{ n: 0 }]);
      expect(await sql(client, "select count(*)::int as n from private.intake_review_events where action = 'pass'")).toEqual([{ n: 0 }]);
      expect(await sql(client, "select status from public.public_interest_submissions where id = $1", [id])).toEqual([{ status: "new" }]);
    });
  });

  it("needs an intake_review operator on the service role for the search, the pass and the passes", async () => {
    await withCase(async (client) => {
      const target = await organization(client, { name: "Fictional Passworthy Union" });
      const { id } = await inviteRow(client);
      const stranger = await person(client);
      for (const attempt of [
        () => pass(client, stranger, id, target.org),
        () => search(client, stranger, "Fictional"),
        () => passes(client, stranger, [id]),
      ]) await expectRefusal(client, attempt, "42501", "intake reviewer required");

      const reviewer = await operator(client);
      for (const role of ["anon", "authenticated"]) {
        await asRole(client, role);
        for (const attempt of [
          () => pass(client, reviewer, id, target.org),
          () => search(client, reviewer, "Fictional"),
          () => passes(client, reviewer, [id]),
        ]) await expectRefusal(client, attempt, "42501");
      }
      await asRole(client, "service_role");

      await expectRefusal(client, () => search(client, reviewer, "F"), "22023", "invalid search");
      await expectRefusal(client, () => passes(client, reviewer, []), "22023", "invalid request ids");
      await expectRefusal(client, () => pass(client, reviewer, id, null), "22023", "organization id required");
    });
  });

  it("finds active organizations with a default chapter by name prefix, at most 20", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const prefix = `Fictional Prefix ${randomUUID().slice(0, 6)}`;
      for (let n = 0; n < 22; n += 1) await organization(client, { name: `${prefix} ${String(n).padStart(2, "0")}`, admin: false });
      await organization(client, { name: `${prefix} suspended`, status: "suspended", admin: false });
      await organization(client, { name: `${prefix} chapterless`, defaultChapter: false, admin: false });
      const found = await search(client, reviewer, `  ${prefix.toLowerCase()} `);
      expect(found.organizations).toHaveLength(20);
      expect(found.organizations[0].name).toBe(`${prefix} 00`);
      expect(found.organizations.every((o) => /^Fictional Prefix .* \d\d$/.test(o.name) && Object.keys(o).sort().join() === "id,name")).toBe(true);
      expect((await search(client, reviewer, `${prefix} 2`)).organizations.map((o) => o.name)).toEqual([`${prefix} 20`, `${prefix} 21`]);
    });
  });

  it("lands with the administrators like a member's suggestion: listed as from Union Ground, declined or approved into an invitation", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const target = await organization(client);
      const { id } = await inviteRow(client);
      await pass(client, reviewer, id, target.org);

      await asMember(client, target.administrator);
      const listed = await call(client, "public.list_member_requests('pending', 20, null, null)");
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({ kind: "invitation_suggestion", inviteeEmail: INVITE, fromIntake: true, status: "pending" });

      await client.query("savepoint approve_probe");
      const created = await call(client, "public.approve_member_request_invitation($1, $2, 'en', $3)", [listed.items[0].id, INVITE, hex("token:approve")]);
      expect(created).toBeTruthy();
      await asRole(client, "service_role");
      expect(await sql(client, "select status, decided_by from public.member_requests where id = $1", [listed.items[0].id])).toEqual([{ status: "approved", decided_by: target.administrator.user }]);
      expect(await sql(client, "select count(*)::int as n from public.member_invitations where normalized_email = $1 and chapter_id = $2", [INVITE, target.chapter])).toEqual([{ n: 1 }]);
      expect((await passes(client, reviewer, [id])).passes).toMatchObject([{ status: "approved" }]);
      await client.query("rollback to savepoint approve_probe");

      await asMember(client, target.administrator);
      expect(await call(client, "public.decide_member_request($1, 'declined')", [listed.items[0].id])).toMatchObject({ status: "declined", fromIntake: true });
      await asRole(client, "service_role");
      expect((await passes(client, reviewer, [id])).passes).toMatchObject([{ status: "declined" }]);
    });
  });

  it("keeps a closed invite request closed when passing it to an organization", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const target = await organization(client);
      const { id } = await inviteRow(client);
      await sql(client, "update public.public_interest_submissions set status = 'closed' where id = $1", [id]);
      expect(await pass(client, reviewer, id, target.org)).toMatchObject({ passed: true, request: { status: "closed" } });
      expect(await sql(client, "select from_status, to_status from private.intake_review_events where action = 'pass' and submission_id = $1", [id]))
        .toEqual([{ from_status: "closed", to_status: "closed" }]);
    });
  });

  it("does not show a pass to another organization's administrator or the same organization's steward, or let either decide it", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const target = await organization(client);
      const other = await organization(client);
      const steward = await person(client);
      await sql(client, "update public.member_profiles set chapter_id = $2 where id = $1", [steward.user, target.chapter]);
      await sql(client, "insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [target.org, steward.user]);
      await sql(client, "insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [steward.user, target.chapter]);
      await sql(client, "insert into public.member_roles(user_id, role, chapter_id, granted_by) values ($1, 'steward', $2, $1)", [steward.user, target.chapter]);
      await sql(client, "insert into public.member_role_chapters(user_id, role, chapter_id, granted_by) values ($1, 'steward', $2, $1)", [steward.user, target.chapter]);
      const { id } = await inviteRow(client);
      await pass(client, reviewer, id, target.org);
      const [suggestion] = await sql(client, "select id from public.member_requests where intake_submission_id = $1", [id]);
      for (const [who, code] of [[other.administrator, "P0002"], [steward, "P0002"]]) {
        await asMember(client, who);
        expect((await call(client, "public.list_member_requests('pending', 20, null, null)")).items).toEqual([]);
        await expectRefusal(client, () => call(client, "public.decide_member_request($1, 'declined')", [suggestion.id]), code);
      }
      expect(await sql(client, "select status from public.member_requests where id = $1", [suggestion.id])).toEqual([{ status: "pending" }]);
    });
  });

  it("deletes the passed-on suggestion with the request on a confirmed stop", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const target = await organization(client);
      const { id } = await inviteRow(client, INVITE, "stop");
      await pass(client, reviewer, id, target.org);
      expect(await call(client, "public.request_public_interest_stop($1, 'en', 'public-landing', '', $2, $3, $4)", [
        INVITE, hex("network:stop"), hex("stop-email:stop"), hex("token:stop"),
      ])).toEqual({ accepted: true, pending: true });
      expect(await call(client, "public.confirm_public_interest_stop($1, $2)", [hex("token:stop"), hex("network:stop-confirm")])).toEqual({ confirmed: true });
      expect(await sql(client, "select count(*)::int as n from public.member_requests where invitee_email = $1", [INVITE])).toEqual([{ n: 0 }]);
    });
  });

  // apply forecast: the read-only probes the database lane runs
  // before the apply (the first three read only columns that exist before
  // it; the fourth is the partial unique index after it) find no row the new
  // checks or the index refuse.
  it("finds no existing row the new checks would refuse", async () => {
    await withCase(async (client) => {
      expect(await sql(client, `select
          (select count(*)::int from public.member_requests where requester_user_id is null) as no_requester,
          (select count(*)::int from public.member_requests where note is not null and (char_length(note) not between 1 and 500
            or note ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')) as long_note,
          (select count(*)::int from private.intake_review_events where action not in
            -- founder_invite: the later action of migration 20261121005701,
            -- which the founder invitation proofs write before this case runs.
            ('operator_granted', 'operator_revoked', 'list', 'export', 'status', 'note', 'pass', 'founder_invite')) as unknown_action,
          (select count(*)::int from (select intake_submission_id, organization_id from public.member_requests
            where intake_submission_id is not null group by 1, 2 having count(*) > 1) d) as duplicate_pass`)).toEqual([
        { no_requester: 0, long_note: 0, unknown_action: 0, duplicate_pass: 0 },
      ]);
    });
  });

  it("keeps a member's own suggestion shape: a member request still needs its member", async () => {
    await withCase(async (client) => {
      const target = await organization(client);
      await client.query("savepoint shape_probe");
      const error = await sql(client, "insert into public.member_requests (organization_id, chapter_id, kind, invitee_name, invitee_email) values ($1, $2, 'invitation_suggestion', 'No One', 'no.one@example.invalid')", [target.org, target.chapter]).then(() => null, (caught) => caught);
      await client.query("rollback to savepoint shape_probe");
      expect(error?.constraint).toBe("member_requests_requester_or_intake");
      await asRole(client, "service_role");
    });
  });
});
