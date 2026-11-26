// @vitest-environment node
// REQ-UG-INTAKE-QUEUE-STORE-INVITE-REQUESTS-AND-OPERATOR-READ-20261118:
// live proof on the disposable stack that a request for an invite is stored
// behind the landing limits and the suppression check and deleted by a
// confirmed stop; that the intake_review capability lives beside
// claim_verification without either grant clobbering the other; and that the
// operator queue (list, summary, export, status, note) needs an intake_review
// operator on a live stepped-up session, reads only Union Ground's own rows
// (organization_id NULL), and audits every list, export, status and note
// change. Every case runs in one transaction that rolls back. The offline pins
// are tests/intake-review-migration.test.js.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const TAG = "intake-review-proof";
const INVITE = `${TAG}-invite@example.invalid`;
const JOIN = `${TAG}-join@example.invalid`;
const UPDATES = `${TAG}-updates@example.invalid`;
const TENANT = `${TAG}-tenant@example.invalid`;

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

async function asRole(client, role) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
  if (role !== "postgres") await client.query(`set local role ${role}`);
}

async function call(client, sql, params = []) {
  const { rows } = await client.query(`select ${sql} as result`, params);
  return rows[0].result;
}

const INVITE_FIELDS = Object.freeze({ name: "Alex Fixtureperson", organization: "Example Workers Local 12", note: "North site.\r\nStarting soon.", locale: "es" });

function submitInvite(client, email, seed, patch = {}) {
  const f = { ...INVITE_FIELDS, ...patch };
  return call(client, "public.submit_invite_request($1, $2, $3, $4, $5, $6, $7, $8)", [
    email, f.name, f.organization, f.note, f.locale, f.website ?? "", hex(`network:${seed}`), hex(`email:${email}:${seed}`),
  ]);
}

async function rowsFor(client, email) {
  await asRole(client, "postgres");
  const { rows } = await client.query(
    "select source, interest, locale, status, organization_id, name, organization_name, note, role, phone, operator_note, status_changed_at from public.public_interest_submissions where email = $1 order by interest",
    [email],
  );
  await asRole(client, "service_role");
  return rows;
}

async function seedRow(client, email, { source = "public-landing", interest = "chapter_updates", organizationId = null, status = "new" } = {}) {
  await asRole(client, "postgres");
  const { rows } = await client.query(
    "insert into public.public_interest_submissions (email, interest, locale, source, organization_id, status) values ($1, $2, 'en', $3, $4, $5) returning id",
    [email, interest, source, organizationId, status],
  );
  await asRole(client, "service_role");
  return rows[0].id;
}

async function seedJoin(client, email) {
  const result = await call(client, "public.submit_join_request($1, 'Proof Council 9', 'officer', '', '', '', '', '', '', $2, $3)", [
    email, hex(`network:join:${email}`), hex(`email:join:${email}`),
  ]);
  expect(result).toEqual({ accepted: true, stored: true });
  const [row] = await rowsFor(client, email);
  return row;
}

// An auth user with a verified factor and a live aal2 session.
async function person(client, { factor = true, aal = "aal2" } = {}) {
  const user = randomUUID();
  const session = randomUUID();
  await asRole(client, "postgres");
  await client.query("insert into auth.users(id, email) values ($1, $2)", [user, `operator.${user.slice(0, 8)}@fixture-operator.example`]);
  if (factor) {
    await client.query("insert into auth.mfa_factors(id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), user]);
  }
  await client.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, $3, now(), now())", [session, user, aal]);
  await asRole(client, "service_role");
  return { user, session };
}

function grantIntake(client, user, active = true, key = randomUUID()) {
  return call(client, "public.set_platform_operator_intake_review($1, $2, $3, $4)", [user, active, active ? "Fixture intake reviewer" : null, key]);
}

async function operator(client, options) {
  const who = await person(client, options);
  await grantIntake(client, who.user);
  return who;
}

async function capabilities(client, user) {
  await asRole(client, "postgres");
  const { rows } = await client.query("select capabilities, revoked_at from private.platform_operators where user_id = $1", [user]);
  await asRole(client, "service_role");
  return rows[0] ?? null;
}

const list = (client, who, { kind = null, status = null, search = TAG, before = null, beforeId = null, limit = 50 } = {}) =>
  call(client, "public.list_intake_requests($1, $2, $3, $4, $5, $6, $7, $8)", [who.user, who.session, kind, status, search, before, beforeId, limit]);
const summary = (client, who) => call(client, "public.intake_request_summary($1, $2)", [who.user, who.session]);
const exportRows = (client, who, { kind = null, status = null, search = TAG } = {}) =>
  call(client, "public.export_intake_requests($1, $2, $3, $4, $5)", [who.user, who.session, kind, status, search]);
const setStatus = (client, who, id, status, expected = null) =>
  call(client, "public.set_intake_request_status($1, $2, $3, $4, $5)", [who.user, who.session, id, status, expected]);
const setNote = (client, who, id, note) =>
  call(client, "public.set_intake_request_note($1, $2, $3, $4)", [who.user, who.session, id, note]);

async function events(client) {
  await asRole(client, "postgres");
  const { rows } = await client.query(
    "select action, actor_user_id, subject_user_id, kind_filter, status_filter, searched, row_count, submission_id, from_status, to_status from private.intake_review_events order by id",
  );
  await asRole(client, "service_role");
  return rows;
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
    await asRole(client, "postgres");
    await client.query("delete from public.public_interest_submissions where email like $1", [`${TAG}%`]);
    await client.query("delete from private.intake_review_events");
    await asRole(client, "service_role");
    await run(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

live("intake review (live)", () => {
  it("stores one invite request per address, refreshes it on a repeat and keeps the operator's status and note", async () => {
    await withCase(async (client) => {
      expect(await submitInvite(client, ` ${INVITE.toUpperCase()} `, "first")).toEqual({ accepted: true, stored: true, notify: true });
      expect(await rowsFor(client, INVITE)).toEqual([{
        source: "request-invite", interest: "request_invite", locale: "es", status: "new", organization_id: null,
        name: "Alex Fixtureperson", organization_name: "Example Workers Local 12", note: "North site.\nStarting soon.",
        role: null, phone: null, operator_note: null, status_changed_at: null,
      }]);
      const reviewer = await operator(client);
      const [{ id }] = (await list(client, reviewer, { kind: "invite" })).requests;
      await setStatus(client, reviewer, id, "contacted");
      await setNote(client, reviewer, id, "Called back.");
      expect(await submitInvite(client, INVITE, "second", { organization: "Example Council 9", note: "", locale: "en" })).toEqual({ accepted: true, stored: true, notify: true });
      expect((await rowsFor(client, INVITE))[0]).toMatchObject({
        organization_name: "Example Council 9", note: null, locale: "en", status: "contacted", operator_note: "Called back.",
      });
    });
  });

  it("stores every same-day correction, and stops only the support emails after three", async () => {
    await withCase(async (client) => {
      const answers = [];
      for (const n of [1, 2, 3, 4, 5]) answers.push(await submitInvite(client, INVITE, "cap", { organization: `Example Council ${n}` }));
      expect(answers.map((a) => a.notify)).toEqual([true, true, true, false, false]);
      expect(answers.every((a) => a.accepted === true && a.stored === true)).toBe(true);
      expect(await rowsFor(client, INVITE)).toMatchObject([{ organization_name: "Example Council 5" }]);
    });
  });

  it("stores nothing for an invalid payload, a honeypot or a stopped address, and answers the same", async () => {
    await withCase(async (client) => {
      for (const [seed, patch] of [
        ["short-name", { name: "A" }],
        ["long-name", { name: "x".repeat(121) }],
        ["control-name", { name: "Alex\u0007" }],
        ["no-organization", { organization: " " }],
        ["long-note", { note: "x".repeat(1001) }],
        ["control-note", { note: "bell\u0007" }],
      ]) {
        expect(await submitInvite(client, INVITE, seed, patch)).toEqual({ accepted: true, stored: false, notify: false });
      }
      expect(await submitInvite(client, "not-an-address", "bad-email")).toEqual({ accepted: true, stored: false, notify: false });
      expect(await submitInvite(client, INVITE, "honeypot", { website: "https://spam.example" })).toEqual({ accepted: true, stored: false, notify: false });
      expect(await rowsFor(client, INVITE)).toEqual([]);
      await asRole(client, "postgres");
      await client.query(
        "insert into private.public_interest_suppressions (suppression_scope_hash, source, locale) values (private.public_interest_suppression_scope($1), 'public-landing', 'en') on conflict do nothing",
        [INVITE],
      );
      await asRole(client, "service_role");
      expect(await submitInvite(client, INVITE, "suppressed")).toEqual({ accepted: true, stored: false, notify: false });
      expect(await rowsFor(client, INVITE)).toEqual([]);
    });
  });

  it("deletes a stored invite request on a confirmed stop", async () => {
    await withCase(async (client) => {
      await submitInvite(client, INVITE, "stop");
      expect(await call(client, "public.request_public_interest_stop($1, 'en', 'public-landing', '', $2, $3, $4)", [
        INVITE, hex("network:stop"), hex("stop-email:stop"), hex("token:stop"),
      ])).toEqual({ accepted: true, pending: true });
      expect(await call(client, "public.confirm_public_interest_stop($1, $2)", [hex("token:stop"), hex("network:stop-confirm")])).toEqual({ confirmed: true });
      expect(await rowsFor(client, INVITE)).toEqual([]);
    });
  });

  it("keeps intake_review and claim_verification side by side through every grant and revoke", async () => {
    await withCase(async (client) => {
      const { user } = await person(client);
      await call(client, "public.set_platform_operator($1, true, 'Fixture verifier', $2)", [user, randomUUID()]);
      expect(await grantIntake(client, user)).toMatchObject({ active: true, idempotent: false });
      expect((await capabilities(client, user)).capabilities.sort()).toEqual(["claim_verification", "intake_review"]);
      // Re-granting claim_verification keeps intake_review.
      await call(client, "public.set_platform_operator($1, true, 'Fixture verifier again', $2)", [user, randomUUID()]);
      expect((await capabilities(client, user)).capabilities.sort()).toEqual(["claim_verification", "intake_review"]);
      // Revoking claim_verification leaves an active intake_review row.
      await call(client, "public.set_platform_operator($1, false, null, $2)", [user, randomUUID()]);
      expect(await capabilities(client, user)).toEqual({ capabilities: ["intake_review"], revoked_at: null });
      // Revoking the last capability revokes the row.
      const revokeKey = randomUUID();
      expect(await grantIntake(client, user, false, revokeKey)).toMatchObject({ active: false, idempotent: false });
      expect((await capabilities(client, user)).revoked_at).not.toBeNull();
      expect(await grantIntake(client, user, false, revokeKey)).toEqual({ userId: user, active: false, idempotent: true });
      await expectRefusal(client, () => grantIntake(client, user, true, revokeKey), "22023", "idempotency key reused");
      await expectRefusal(client, () => grantIntake(client, user, false), "22023", "operator unavailable");
      // A revoked row comes back with intake_review only.
      await grantIntake(client, user);
      expect(await capabilities(client, user)).toEqual({ capabilities: ["intake_review"], revoked_at: null });
      const audit = (await events(client)).map((e) => [e.action, e.subject_user_id]);
      expect(audit).toEqual([["operator_granted", user], ["operator_revoked", user], ["operator_granted", user]]);
    });
  });

  it("refuses every queue call without a live stepped-up intake_review operator", async () => {
    await withCase(async (client) => {
      const id = await seedRow(client, UPDATES);
      const verifierOnly = await person(client);
      await call(client, "public.set_platform_operator($1, true, 'Fixture verifier', $2)", [verifierOnly.user, randomUUID()]);
      const nobody = await person(client);
      const aal1 = await operator(client, { aal: "aal1" });
      const noFactor = await operator(client, { factor: false });
      const expired = await operator(client);
      await asRole(client, "postgres");
      await client.query("update auth.sessions set not_after = now() - interval '1 second' where id = $1", [expired.session]);
      await asRole(client, "service_role");
      const revoked = await operator(client);
      await grantIntake(client, revoked.user, false);
      const wrongSession = await operator(client);
      wrongSession.session = randomUUID();
      for (const who of [verifierOnly, nobody, aal1, noFactor, expired, revoked, wrongSession, { user: null, session: null }]) {
        await expectRefusal(client, () => list(client, who), "42501", "intake reviewer required");
        await expectRefusal(client, () => summary(client, who), "42501", "intake reviewer required");
        await expectRefusal(client, () => exportRows(client, who), "42501", "intake reviewer required");
        await expectRefusal(client, () => setStatus(client, who, id, "contacted"), "42501", "intake reviewer required");
        await expectRefusal(client, () => setNote(client, who, id, "x"), "42501", "intake reviewer required");
      }
      expect(await events(client)).toEqual(expect.not.arrayContaining([expect.objectContaining({ action: "list" })]));
    });
  });

  it("lists only Union Ground's own rows, by kind, status and search, in reachable pages, with one audit row per call", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      await submitInvite(client, INVITE, "list");
      await seedJoin(client, JOIN);
      await seedRow(client, UPDATES, { interest: "chapter_updates" });
      await seedRow(client, UPDATES, { interest: "union_news" });
      await seedRow(client, TENANT, { organizationId: randomUUID() });

      const all = await list(client, reviewer);
      expect(all.hasMore).toBe(false);
      expect(all.requests.map((r) => r.email).sort()).toEqual([INVITE, JOIN, UPDATES, UPDATES].sort());
      expect(JSON.stringify(all)).not.toContain(TENANT);
      expect(all.requests.find((r) => r.kind === "invite")).toMatchObject({
        name: "Alex Fixtureperson", organizationName: "Example Workers Local 12", topic: null, status: "new", operatorNote: null,
      });
      expect(all.requests.filter((r) => r.kind === "updates").map((r) => r.topic).sort()).toEqual(["chapter_updates", "union_news"]);

      expect((await list(client, reviewer, { kind: "join" })).requests.map((r) => r.email)).toEqual([JOIN]);
      expect((await list(client, reviewer, { search: "COUNCIL 9" })).requests.map((r) => r.email)).toEqual([JOIN]);
      expect((await list(client, reviewer, { search: `${TAG}%_x` })).requests).toEqual([]);
      expect((await list(client, reviewer, { status: "closed" })).requests).toEqual([]);

      const first = await list(client, reviewer, { limit: 3 });
      expect(first.requests).toHaveLength(3);
      expect(first.hasMore).toBe(true);
      const second = await list(client, reviewer, { limit: 3, before: first.cursorSubmittedAt, beforeId: first.cursorId });
      expect(second.hasMore).toBe(false);
      expect([...first.requests, ...second.requests].map((r) => r.id).sort()).toEqual(all.requests.map((r) => r.id).sort());

      await expectRefusal(client, () => list(client, reviewer, { kind: "tenant" }), "22023", "invalid kind");
      await expectRefusal(client, () => list(client, reviewer, { status: "done" }), "22023", "invalid status");
      await expectRefusal(client, () => list(client, reviewer, { limit: 101 }), "22023", "invalid page size");
      await expectRefusal(client, () => list(client, reviewer, { before: first.cursorSubmittedAt }), "22023", "cursor needs both parts");

      const audit = (await events(client)).filter((e) => e.action === "list");
      expect(audit).toHaveLength(7);
      expect(audit[0]).toMatchObject({ actor_user_id: reviewer.user, kind_filter: null, searched: true, row_count: 4 });
      expect(audit[1]).toMatchObject({ kind_filter: "join", row_count: 1 });
    });
  });

  it("moves a row through new, contacted, invited and closed, refusing stale and foreign changes, with one audit row each", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const join = await seedJoin(client, JOIN);
      const [{ id }] = (await list(client, reviewer, { kind: "join" })).requests;
      const tenantId = await seedRow(client, TENANT, { organizationId: randomUUID() });
      expect(join.status).toBe("new");

      expect(await setStatus(client, reviewer, id, "contacted", "new")).toMatchObject({ updated: true, request: { id, status: "contacted" } });
      expect(await setStatus(client, reviewer, id, "invited", "new")).toMatchObject({ updated: false, refusal: "changed", request: { status: "contacted" } });
      expect(await setStatus(client, reviewer, id, "contacted")).toMatchObject({ updated: false, refusal: "unchanged" });
      expect(await setStatus(client, reviewer, id, "invited", "contacted")).toMatchObject({ updated: true, request: { status: "invited" } });
      expect(await setStatus(client, reviewer, tenantId, "closed")).toEqual({ updated: false, refusal: "not-found" });
      expect(await setStatus(client, reviewer, randomUUID(), "closed")).toEqual({ updated: false, refusal: "not-found" });
      await expectRefusal(client, () => setStatus(client, reviewer, id, "done"), "22023", "invalid status");
      expect((await rowsFor(client, JOIN))[0].status_changed_at).not.toBeNull();

      // The owner's command-line path still moves an Invited row.
      expect(await call(client, "public.set_join_request_status($1, 'closed', 'intake-review-proof')", [id])).toMatchObject({ updated: true, from: "invited", status: "closed" });

      const audit = (await events(client)).filter((e) => e.action === "status");
      expect(audit.map((e) => [e.submission_id, e.from_status, e.to_status, e.actor_user_id])).toEqual([
        [id, "new", "contacted", reviewer.user],
        [id, "contacted", "invited", reviewer.user],
      ]);
    });
  });

  it("keeps a private note, clears it when empty, refuses one too long and never logs its text", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const id = await seedRow(client, UPDATES);
      expect(await setNote(client, reviewer, id, "  Wants\r\nmeeting dates.  ")).toMatchObject({ updated: true, request: { operatorNote: "Wants\nmeeting dates." } });
      expect(await setNote(client, reviewer, id, "Wants\nmeeting dates.")).toMatchObject({ updated: false, refusal: "unchanged" });
      await expectRefusal(client, () => setNote(client, reviewer, id, "x".repeat(2001)), "22023", "invalid note");
      await expectRefusal(client, () => setNote(client, reviewer, id, "bell\u0007"), "22023", "invalid note");
      expect(await setNote(client, reviewer, id, "   ")).toMatchObject({ updated: true, request: { operatorNote: null } });
      expect(await setNote(client, reviewer, await seedRow(client, TENANT, { organizationId: randomUUID() }), "x")).toEqual({ updated: false, refusal: "not-found" });
      const audit = (await events(client)).filter((e) => e.action === "note");
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain("meeting");
    });
  });

  it("summarizes counts per kind, status, topic and Eastern day with no contact details", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const before = await summary(client, reviewer);
      await submitInvite(client, INVITE, "summary");
      await seedJoin(client, JOIN);
      await seedRow(client, UPDATES, { interest: "chapter_updates" });
      await seedRow(client, UPDATES, { interest: "public_meetings", status: "contacted" });
      await seedRow(client, TENANT, { organizationId: randomUUID() });
      const after = await summary(client, reviewer);

      const count = (s, kind, status) => s.counts.find((c) => c.kind === kind && c.status === status)?.count ?? 0;
      expect(count(after, "invite", "new") - count(before, "invite", "new")).toBe(1);
      expect(count(after, "join", "new") - count(before, "join", "new")).toBe(1);
      expect(count(after, "updates", "new") - count(before, "updates", "new")).toBe(1);
      expect(count(after, "updates", "contacted") - count(before, "updates", "contacted")).toBe(1);
      expect(after.updatePeople - before.updatePeople).toBe(1);
      const topic = (s, name) => s.topics.find((t) => t.topic === name)?.count ?? 0;
      expect(topic(after, "public_meetings") - topic(before, "public_meetings")).toBe(1);

      expect(after.daily).toHaveLength(90);
      const today = after.daily.at(-1);
      const todayBefore = before.daily.at(-1);
      expect(today.day).toBe(after.today);
      expect([today.updates - todayBefore.updates, today.join - todayBefore.join, today.invite - todayBefore.invite]).toEqual([2, 1, 1]);
      await asRole(client, "postgres");
      const { rows } = await client.query("select (now() at time zone 'America/New_York')::date::text as day");
      await asRole(client, "service_role");
      expect(after.today).toBe(rows[0].day);
      expect(JSON.stringify(after)).not.toContain("@");
      expect(await events(client)).toEqual([expect.objectContaining({ action: "operator_granted" })]);
    });
  });

  it("exports every matching row with one audit row", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      await submitInvite(client, INVITE, "export");
      await seedRow(client, UPDATES);
      await seedRow(client, TENANT, { organizationId: randomUUID() });
      const result = await exportRows(client, reviewer);
      expect(result.truncated).toBe(false);
      expect(result.requests.map((r) => r.email).sort()).toEqual([INVITE, UPDATES].sort());
      expect((await exportRows(client, reviewer, { kind: "invite" })).requests).toHaveLength(1);
      const audit = (await events(client)).filter((e) => e.action === "export");
      expect(audit.map((e) => [e.kind_filter, e.row_count, e.searched])).toEqual([[null, 2, true], ["invite", 1, true]]);
    });
  });

  it("keeps every function and the ledger away from browser roles", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const id = await seedRow(client, UPDATES);
      for (const role of ["anon", "authenticated"]) {
        await asRole(client, role);
        for (const probe of [
          () => submitInvite(client, INVITE, `roles:${role}`),
          () => list(client, reviewer),
          () => summary(client, reviewer),
          () => exportRows(client, reviewer),
          () => setStatus(client, reviewer, id, "closed"),
          () => setNote(client, reviewer, id, "x"),
          () => grantIntake(client, reviewer.user),
          () => client.query("select count(*) from private.intake_review_events"),
        ]) {
          await client.query("savepoint role_probe");
          await expect(probe()).rejects.toThrow(/permission denied/);
          await client.query("rollback to savepoint role_probe");
        }
      }
      await asRole(client, "service_role");
      await client.query("savepoint service_probe");
      await expect(client.query("select count(*) from private.intake_review_events")).rejects.toThrow(/permission denied/);
      await client.query("rollback to savepoint service_probe");
      await client.query("savepoint service_probe");
      await expect(client.query("select private.intake_review_require_operator($1, $2)", [reviewer.user, reviewer.session])).rejects.toThrow(/permission denied/);
      await client.query("rollback to savepoint service_probe");
    });
  });
});
