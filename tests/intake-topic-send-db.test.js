// @vitest-environment node
// REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118: live proof on
// the disposable stack that a topic update reaches only the landing opt-ins
// for that topic with organization_id NULL and no suppression, one per
// address; that a list send needs the same operator's delivered test of the
// same content and happens at most once per topic per Eastern day; that the
// drain re-checks every address, never sends a delivery twice, records each
// outcome and its counts on the send, clears the address once settled and
// gives every delivery a stop confirmation the one-click unsubscribe turns
// into the existing stop. Every case runs in one transaction that rolls back.
// The offline pins are tests/intake-topic-send-migration.test.js.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const TAG = "intake-topic-proof";
const ADA = `${TAG}-ada@example.invalid`;
const BEA = `${TAG}-bea@example.invalid`;
const CAL = `${TAG}-cal@example.invalid`;
const DEE = `${TAG}-dee@example.invalid`;
const TENANT = `${TAG}-tenant@example.invalid`;
const UPDATE = Object.freeze({ topic: "chapter_updates", subject: "Spring meeting dates", body: "Hello.\r\n\r\nThe spring meetings are set." });

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

async function asPostgres(client, sql, params = []) {
  await asRole(client, "postgres");
  const { rows } = await client.query(sql, params);
  await asRole(client, "service_role");
  return rows;
}

async function optIn(client, email, { interest = "chapter_updates", locale = "en", organizationId = null } = {}) {
  await asPostgres(client,
    "insert into public.public_interest_submissions (email, interest, locale, source, organization_id) values ($1, $2, $3, 'public-landing', $4)",
    [email, interest, locale, organizationId]);
}

async function suppress(client, email) {
  await asPostgres(client,
    "insert into private.public_interest_suppressions (suppression_scope_hash, source, locale) values (private.public_interest_suppression_scope($1), 'public-landing', 'en') on conflict do nothing",
    [email]);
}

// An auth user with a verified factor and a live aal2 session.
async function person(client, { aal = "aal2" } = {}) {
  const user = randomUUID();
  const session = randomUUID();
  await asRole(client, "postgres");
  await client.query("insert into auth.users(id, email) values ($1, $2)", [user, `Operator.${user.slice(0, 8)}@Fixture-Operator.example`]);
  await client.query("insert into auth.mfa_factors(id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), user]);
  await client.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, $3, now(), now())", [session, user, aal]);
  await asRole(client, "service_role");
  return { user, session };
}

async function operator(client, options) {
  const who = await person(client, options);
  await call(client, "public.set_platform_operator_intake_review($1, true, 'Fixture intake reviewer', $2)", [who.user, randomUUID()]);
  return who;
}

const overview = (client, who) => call(client, "public.intake_topic_send_overview($1, $2)", [who.user, who.session]);
const beginTest = (client, who, update = UPDATE, key = randomUUID()) =>
  call(client, "public.begin_intake_topic_test_send($1, $2, $3, $4, $5, $6)", [who.user, who.session, update.topic, update.subject, update.body, key]);
const finishTest = (client, who, id, delivered = true) =>
  call(client, "public.finish_intake_topic_test_send($1, $2, $3, $4)", [who.user, who.session, id, delivered]);
const queue = (client, who, testId, update = UPDATE, key = randomUUID()) =>
  call(client, "public.queue_intake_topic_send($1, $2, $3, $4, $5, $6, $7)", [who.user, who.session, update.topic, update.subject, update.body, testId, key]);
const claim = (client, lease, seeds) =>
  call(client, "public.claim_intake_topic_send_batch($1, $2::text[])", [lease, seeds.map((seed) => hex(`token:${seed}`))]);
const finish = (client, lease, id, outcome) =>
  call(client, "public.finish_intake_topic_send_delivery($1, $2, $3)", [lease, id, outcome]);

async function deliveredTest(client, who, update = UPDATE) {
  const begun = await beginTest(client, who, update);
  expect(begun.started).toBe(true);
  await finishTest(client, who, begun.send.id, true);
  return begun.send.id;
}

async function sendRow(client, id) {
  const [row] = await asPostgres(client,
    "select kind, topic, status, queued_count, sent_count, failed_count, skipped_count, completed_at is not null as done from private.intake_topic_sends where id = $1", [id]);
  return row;
}

async function recipients(client, sendId) {
  return asPostgres(client,
    "select email, locale, state, attempts, unsubscribe_token_hash from private.intake_topic_send_recipients where send_id = $1 order by id", [sendId]);
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
    // Only this case's fixtures are on the list while it runs (rolled back).
    await client.query("delete from public.public_interest_submissions where source = 'public-landing'");
    await client.query("delete from private.intake_topic_sends");
    await asRole(client, "service_role");
    await run(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

live("topic update email (live)", () => {
  it("counts only Union Ground's unsuppressed opt-ins for the topic, one per address", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      await optIn(client, ADA);
      await optIn(client, BEA, { locale: "es" });
      await optIn(client, BEA, { interest: "union_news" });
      await optIn(client, CAL);
      await suppress(client, CAL);
      await optIn(client, TENANT, { organizationId: randomUUID() });
      await optIn(client, DEE, { interest: "public_meetings" });
      const view = await overview(client, reviewer);
      expect(view.topics).toEqual([
        { topic: "chapter_updates", recipients: 2, sentToday: false },
        { topic: "public_meetings", recipients: 1, sentToday: false },
        { topic: "union_news", recipients: 1, sentToday: false },
      ]);
      expect(view.sends).toEqual([]);
      expect(JSON.stringify(view)).not.toContain(TAG);
    });
  });

  it("answers the operator's own address for a test, ten a day, and records the outcome once", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const key = randomUUID();
      const begun = await beginTest(client, reviewer, UPDATE, key);
      expect(begun).toMatchObject({
        started: true,
        to: `operator.${reviewer.user.slice(0, 8)}@fixture-operator.example`,
        subject: "Spring meeting dates",
        body: "Hello.\n\nThe spring meetings are set.",
        send: { kind: "test", topic: "chapter_updates", status: "sending", queued: 1, sent: 0 },
      });
      expect(await beginTest(client, reviewer, UPDATE, key)).toMatchObject({ started: false, refusal: "repeat" });
      expect(await beginTest(client, reviewer, { ...UPDATE, subject: "Other" }, key)).toEqual({ started: false, refusal: "key-reused" });
      expect(await finishTest(client, reviewer, begun.send.id, true)).toMatchObject({ recorded: true, send: { status: "done", sent: 1, failed: 0 } });
      expect(await finishTest(client, reviewer, begun.send.id, false)).toMatchObject({ recorded: false, refusal: "already-recorded" });
      const other = await operator(client);
      expect(await finishTest(client, other, begun.send.id, true)).toEqual({ recorded: false, refusal: "not-found" });
      for (let n = 2; n <= 10; n += 1) expect((await beginTest(client, reviewer)).started).toBe(true);
      expect(await beginTest(client, reviewer)).toEqual({ started: false, refusal: "test-limit" });
      expect((await beginTest(client, other)).started).toBe(true);
    });
  });

  it("validates the update and refuses anyone who is not an intake reviewer on a stepped-up session", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      await expectRefusal(client, () => beginTest(client, reviewer, { ...UPDATE, topic: "request_invite" }), "22023", "invalid topic");
      await expectRefusal(client, () => beginTest(client, reviewer, { ...UPDATE, subject: "  " }), "22023", "invalid subject");
      await expectRefusal(client, () => beginTest(client, reviewer, { ...UPDATE, subject: "x".repeat(151) }), "22023", "invalid subject");
      await expectRefusal(client, () => beginTest(client, reviewer, { ...UPDATE, subject: "line\nbreak" }), "22023", "invalid subject");
      await expectRefusal(client, () => beginTest(client, reviewer, { ...UPDATE, body: "x".repeat(5001) }), "22023", "invalid body");
      await expectRefusal(client, () => beginTest(client, reviewer, { ...UPDATE, body: "bell\u0007" }), "22023", "invalid body");
      const stranger = await person(client);
      const stepDown = await operator(client, { aal: "aal1" });
      for (const who of [stranger, stepDown]) {
        await expectRefusal(client, () => overview(client, who), "42501", "intake reviewer required");
        await expectRefusal(client, () => beginTest(client, who), "42501", "intake reviewer required");
        await expectRefusal(client, () => queue(client, who, randomUUID()), "42501", "intake reviewer required");
      }
    });
  });

  it("queues a list send only after the same operator's delivered test of the same content, once per topic per Eastern day", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      const other = await operator(client);
      await optIn(client, ADA);
      await optIn(client, BEA, { locale: "es" });
      const undelivered = await beginTest(client, reviewer);
      await finishTest(client, reviewer, undelivered.send.id, false);
      expect(await queue(client, reviewer, undelivered.send.id)).toEqual({ queued: false, refusal: "test-required" });
      const pending = await beginTest(client, reviewer);
      expect(await queue(client, reviewer, pending.send.id)).toEqual({ queued: false, refusal: "test-required" });
      const testId = await deliveredTest(client, reviewer);
      expect(await queue(client, reviewer, testId, { ...UPDATE, body: "Changed after the test." })).toEqual({ queued: false, refusal: "test-required" });
      expect(await queue(client, reviewer, testId, { ...UPDATE, topic: "union_news" })).toEqual({ queued: false, refusal: "test-required" });
      expect(await queue(client, other, testId)).toEqual({ queued: false, refusal: "test-required" });
      await asPostgres(client, "update private.intake_topic_sends set created_at = now() - interval '25 hours' where id = $1", [testId]);
      expect(await queue(client, reviewer, testId)).toEqual({ queued: false, refusal: "test-required" });

      const freshTest = await deliveredTest(client, reviewer);
      const key = randomUUID();
      const queued = await queue(client, reviewer, freshTest, UPDATE, key);
      expect(queued).toMatchObject({ queued: true, send: { kind: "list", topic: "chapter_updates", status: "sending", queued: 2, sent: 0 } });
      expect(await queue(client, reviewer, freshTest, UPDATE, key)).toMatchObject({ queued: false, refusal: "repeat", send: { id: queued.send.id } });
      expect(await queue(client, reviewer, freshTest)).toEqual({ queued: false, refusal: "already-sent-today" });
      expect((await overview(client, reviewer)).topics[0]).toEqual({ topic: "chapter_updates", recipients: 2, sentToday: true });
      expect(await recipients(client, queued.send.id)).toEqual([
        { email: ADA, locale: "en", state: "queued", attempts: 0, unsubscribe_token_hash: null },
        { email: BEA, locale: "es", state: "queued", attempts: 0, unsubscribe_token_hash: null },
      ]);

      const emptyTest = await deliveredTest(client, reviewer, { ...UPDATE, topic: "public_meetings" });
      expect(await queue(client, reviewer, emptyTest, { ...UPDATE, topic: "public_meetings" })).toEqual({ queued: false, refusal: "no-recipients" });
    });
  });

  it("drains in batches, never sends twice, retries only what the provider could not take, and keeps the counts", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      await optIn(client, ADA);
      await optIn(client, BEA, { locale: "es" });
      await optIn(client, CAL);
      const sendId = (await queue(client, reviewer, await deliveredTest(client, reviewer))).send.id;

      const lease = randomUUID();
      const first = await claim(client, lease, ["a1", "a2"]);
      expect(first.deliveries.map((d) => [d.email, d.locale, d.token, d.attempt, d.subject])).toEqual([
        [ADA, "en", 1, 1, "Spring meeting dates"],
        [BEA, "es", 2, 1, "Spring meeting dates"],
      ]);
      const pendingStops = await asPostgres(client,
        "select normalized_email, expires_at - created_at as window from private.public_interest_stop_confirmations where token_hash = any($1) order by normalized_email",
        [[hex("token:a1"), hex("token:a2")]]);
      expect(pendingStops.map((row) => [row.normalized_email, row.window.days])).toEqual([[ADA, 60], [BEA, 60]]);

      const [ada, bea] = first.deliveries;
      expect(await finish(client, lease, ada.id, "sent")).toEqual({ recorded: true, state: "sent" });
      expect(await finish(client, lease, ada.id, "sent")).toEqual({ recorded: false });
      expect(await finish(client, randomUUID(), bea.id, "sent")).toEqual({ recorded: false });
      expect(await finish(client, lease, bea.id, "retry")).toEqual({ recorded: true, state: "queued" });
      expect(await asPostgres(client, "select count(*)::integer as n from private.public_interest_stop_confirmations where token_hash = $1", [hex("token:a2")])).toEqual([{ n: 0 }]);

      // CAL is next; BEA waits five minutes for its second attempt.
      const second = await claim(client, randomUUID(), ["b1", "b2"]);
      expect(second.deliveries.map((d) => d.email)).toEqual([CAL]);
      // CAL's lease runs out with no outcome: counted failed, never retried.
      await asPostgres(client, "update private.intake_topic_send_recipients set leased_until = now() - interval '1 second' where state = 'sending'");
      await asPostgres(client, "update private.intake_topic_send_recipients set next_attempt_at = now() - interval '1 second' where state = 'queued'");
      const lease3 = randomUUID();
      const third = await claim(client, lease3, ["c1"]);
      expect(third.expired).toBe(1);
      expect(third.deliveries.map((d) => [d.email, d.attempt])).toEqual([[BEA, 2]]);
      expect(await finish(client, randomUUID(), second.deliveries[0].id, "sent")).toEqual({ recorded: false });
      expect(await finish(client, lease3, third.deliveries[0].id, "failed")).toEqual({ recorded: true, state: "failed" });
      expect(await sendRow(client, sendId)).toEqual({
        kind: "list", topic: "chapter_updates", status: "done", queued_count: 3, sent_count: 1, failed_count: 2, skipped_count: 0, done: true,
      });
      expect(await recipients(client, sendId)).toEqual([
        { email: null, locale: "en", state: "sent", attempts: 1, unsubscribe_token_hash: null },
        { email: null, locale: "es", state: "failed", attempts: 2, unsubscribe_token_hash: null },
        { email: null, locale: "en", state: "failed", attempts: 1, unsubscribe_token_hash: null },
      ]);
      expect(await claim(client, randomUUID(), ["d1"])).toEqual({ deliveries: [], skipped: 0, expired: 0 });
      const view = await overview(client, reviewer);
      expect(view.sends[0]).toMatchObject({ id: sendId, kind: "list", status: "done", queued: 3, sent: 1, failed: 2, skipped: 0, mine: true });
      expect(JSON.stringify(view)).not.toContain(TAG);
    });
  });

  it("gives up after three attempts", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      await optIn(client, ADA);
      const sendId = (await queue(client, reviewer, await deliveredTest(client, reviewer))).send.id;
      for (const attempt of [1, 2, 3]) {
        await asPostgres(client, "update private.intake_topic_send_recipients set next_attempt_at = now() - interval '1 second' where state = 'queued'");
        const lease = randomUUID();
        const [delivery] = (await claim(client, lease, [`r${attempt}`])).deliveries;
        expect(delivery.attempt).toBe(attempt);
        expect((await finish(client, lease, delivery.id, "retry")).state).toBe(attempt < 3 ? "queued" : "failed");
      }
      expect(await sendRow(client, sendId)).toMatchObject({ status: "done", failed_count: 1 });
    });
  });

  // Gate round 1 (r1s2/r2s1) and the final (r3s1/r4s1): the deliveries a
  // dispatcher ran out of time for go back in ONE call per lease. Each gives
  // its attempt back and loses its unused stop confirmation; another lease's
  // or an already settled delivery is left alone, and deferring any number of
  // times still leaves all three real attempts.
  it("releases a lease's untried deliveries in one call, giving each its attempt back", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      for (const who of [ADA, BEA, CAL]) await optIn(client, who);
      const sendId = (await queue(client, reviewer, await deliveredTest(client, reviewer))).send.id;
      const lease = randomUUID();
      const taken = (await claim(client, lease, ["rel1", "rel2", "rel3"])).deliveries;
      expect(taken.map((d) => d.attempt)).toEqual([1, 1, 1]);
      expect(await finish(client, lease, taken[0].id, "sent")).toEqual({ recorded: true, state: "sent" });
      const release = (leaseToken, ids) => call(client, "public.release_intake_topic_send_deliveries($1, $2::bigint[])", [leaseToken, ids]);
      expect(await release(randomUUID(), [taken[1].id, taken[2].id])).toEqual({ released: 0 });
      expect(await release(lease, [taken[0].id, taken[1].id, taken[2].id, 999999999])).toEqual({ released: 2 });
      expect(await release(lease, [taken[1].id, taken[2].id])).toEqual({ released: 0 });
      expect(await asPostgres(client, "select count(*)::integer as n from private.public_interest_stop_confirmations where token_hash = any($1)", [[hex("token:rel2"), hex("token:rel3")]])).toEqual([{ n: 0 }]);
      expect(await asPostgres(client, "select count(*)::integer as n from private.public_interest_stop_confirmations where token_hash = $1", [hex("token:rel1")])).toEqual([{ n: 1 }]);
      expect((await recipients(client, sendId)).map((r) => [r.state, r.attempts])).toEqual([["sent", 1], ["queued", 0], ["queued", 0]]);
      expect(await sendRow(client, sendId)).toMatchObject({ status: "sending", sent_count: 1, failed_count: 0 });
      for (const round of [1, 2, 3]) {
        const again = randomUUID();
        const back = (await claim(client, again, [`rel-again-${round}a`, `rel-again-${round}b`])).deliveries;
        expect(back.map((d) => d.attempt)).toEqual([1, 1]);
        expect(await release(again, back.map((d) => d.id))).toEqual({ released: 2 });
      }
      for (const ids of [[], Array.from({ length: 51 }, (_, i) => i + 1), [null]]) {
        await expectRefusal(client, () => release(lease, ids), "22023", "invalid release");
      }
      await expectRefusal(client, () => release(null, [taken[1].id]), "22023", "invalid release");
      // The per-delivery "deferred" outcome is gone; the release replaces it.
      await expectRefusal(client, () => finish(client, lease, taken[1].id, "deferred"), "22023", "invalid outcome");
    });
  });

  // The final, r3s2: two dispatchers finishing the last two deliveries of a
  // send at the same moment. The send row is locked before counting, so the
  // completion that waits counts the other one too: the send ends done with
  // both counted, never "sending" with a stale count. This case needs two
  // real connections, so its rows are committed: a back-dated test and list
  // send (2001, so no other case's day, recent list or recipients see them)
  // and two leased deliveries, all deleted at the end.
  it("settles two overlapping completions of one send to done with both counted", async () => {
    const setup = await connect();
    const first = await connect();
    const second = await connect();
    const testId = randomUUID();
    const sendId = randomUUID();
    const leases = [randomUUID(), randomUUID()];
    const cleanup = async () => {
      await setup.query("delete from private.intake_topic_sends where id = any($1::uuid[])", [[sendId, testId]]);
    };
    try {
      await cleanup();
      await setup.query(
        "insert into private.intake_topic_sends (id, kind, topic, subject, body, content_sha256, operator_user_id, idempotency_key, eastern_day, status, queued_count, sent_count, created_at, completed_at) values ($1, 'test', 'union_news', 'Overlap proof', 'Body', $2, $3, $4, date '2001-01-01', 'done', 1, 1, timestamptz '2001-01-01 12:00Z', timestamptz '2001-01-01 12:00Z')",
        [testId, hex("overlap-content"), randomUUID(), randomUUID()]);
      await setup.query(
        "insert into private.intake_topic_sends (id, kind, topic, subject, body, content_sha256, operator_user_id, idempotency_key, eastern_day, test_send_id, queued_count, created_at) values ($1, 'list', 'union_news', 'Overlap proof', 'Body', $2, $3, $4, date '2001-01-02', $5, 2, timestamptz '2001-01-02 12:00Z')",
        [sendId, hex("overlap-content"), randomUUID(), randomUUID(), testId]);
      const { rows: queued } = await setup.query(
        "insert into private.intake_topic_send_recipients (send_id, email, locale, state, attempts, lease_token, leased_until, unsubscribe_token_hash) values ($1, $2, 'en', 'sending', 1, $3, now() + interval '1 hour', $4), ($1, $5, 'en', 'sending', 1, $6, now() + interval '1 hour', $7) returning id",
        [sendId, `${TAG}-overlap-a@example.invalid`, leases[0], hex("overlap-a"), `${TAG}-overlap-b@example.invalid`, leases[1], hex("overlap-b")]);
      for (const connection of [first, second]) {
        await connection.query("begin");
        await asRole(connection, "service_role");
      }
      const done = (connection, index) => connection.query("select public.finish_intake_topic_send_delivery($1, $2, 'sent') as result", [leases[index], queued[index].id]);
      expect((await done(first, 0)).rows[0].result).toEqual({ recorded: true, state: "sent" });
      const { rows: [{ pid }] } = await second.query("select pg_backend_pid() as pid");
      const waiting = done(second, 1);
      for (let tries = 0; tries < 100; tries += 1) {
        const { rows } = await setup.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
        if (rows[0]?.wait_event_type === "Lock") break;
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      await first.query("commit");
      expect((await waiting).rows[0].result).toEqual({ recorded: true, state: "sent" });
      await second.query("commit");
      const { rows: [row] } = await setup.query("select status, sent_count, failed_count, completed_at is not null as done from private.intake_topic_sends where id = $1", [sendId]);
      expect(row).toEqual({ status: "done", sent_count: 2, failed_count: 0, done: true });
    } finally {
      for (const connection of [first, second]) await connection.query("rollback").catch(() => {});
      await cleanup().catch(() => {});
      await Promise.all([setup.end(), first.end(), second.end()]);
    }
  });

  // Gate round 1, r1s3/r2s2: with no definite answer the email may have been
  // delivered, so it is counted failed, never claimed again, and its stop
  // confirmation stays valid for its unsubscribe link and header.
  it("records an unknown outcome as failed, never resends it and keeps its stop confirmation", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      await optIn(client, ADA);
      const sendId = (await queue(client, reviewer, await deliveredTest(client, reviewer))).send.id;
      const lease = randomUUID();
      const [delivery] = (await claim(client, lease, ["unknown1"])).deliveries;
      expect(await finish(client, lease, delivery.id, "unknown")).toEqual({ recorded: true, state: "failed" });
      expect(await asPostgres(client, "select normalized_email from private.public_interest_stop_confirmations where token_hash = $1", [hex("token:unknown1")])).toEqual([{ normalized_email: ADA }]);
      await asPostgres(client, "update private.intake_topic_send_recipients set next_attempt_at = now() - interval '1 second'");
      expect(await claim(client, randomUUID(), ["unknown2"])).toEqual({ deliveries: [], skipped: 0, expired: 0 });
      expect(await sendRow(client, sendId)).toMatchObject({ status: "done", sent_count: 0, failed_count: 1, queued_count: 1 });
      // An outcome outside the five is refused before anything is read.
      await expectRefusal(client, () => finish(client, lease, delivery.id, "maybe"), "22023", "invalid outcome");
    });
  });

  // Gate round 1, r1s1/r2s3: the send's queued_count and its queue rows come
  // from one read of the recipient set (pinned in the migration test), so they
  // always agree and settlement never violates intake_topic_sends_counts.
  it("queues exactly as many deliveries as its queued count", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      for (const who of [ADA, BEA, CAL]) await optIn(client, who);
      const send = (await queue(client, reviewer, await deliveredTest(client, reviewer))).send;
      const [{ n }] = await asPostgres(client, "select count(*)::integer as n from private.intake_topic_send_recipients where send_id = $1", [send.id]);
      expect(n).toBe(3);
      expect((await sendRow(client, send.id)).queued_count).toBe(3);
    });
  });

  it("skips an address that stopped or left the topic after the send was queued", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      await optIn(client, ADA);
      await optIn(client, BEA);
      await optIn(client, CAL);
      const sendId = (await queue(client, reviewer, await deliveredTest(client, reviewer))).send.id;
      await suppress(client, BEA);
      await asPostgres(client, "delete from public.public_interest_submissions where email = $1", [CAL]);
      const batch = await claim(client, randomUUID(), ["s1", "s2", "s3"]);
      expect(batch.skipped).toBe(2);
      expect(batch.deliveries.map((d) => [d.email, d.token])).toEqual([[ADA, 1]]);
      expect(await sendRow(client, sendId)).toMatchObject({ status: "sending", queued_count: 3, skipped_count: 2 });
    });
  });

  it("turns the one-click unsubscribe into the existing stop, once, and refuses unknown tokens before any write", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      await optIn(client, ADA);
      await optIn(client, ADA, { interest: "union_news" });
      await queue(client, reviewer, await deliveredTest(client, reviewer));
      const lease = randomUUID();
      const [delivery] = (await claim(client, lease, ["u1"])).deliveries;
      await finish(client, lease, delivery.id, "sent");

      const limitsBefore = await asPostgres(client, "select count(*)::integer as n from private.public_interest_submission_limits");
      expect(await call(client, "public.confirm_public_interest_unsubscribe($1, $2)", [hex("token:unknown"), hex("network:one-click")]))
        .toEqual({ confirmed: false, refusal: "unavailable" });
      expect(await asPostgres(client, "select count(*)::integer as n from private.public_interest_submission_limits"))
        .toEqual([{ n: limitsBefore[0].n + 1 }]);

      expect(await call(client, "public.confirm_public_interest_unsubscribe($1, $2)", [hex("token:u1"), hex("network:one-click")])).toEqual({ confirmed: true });
      expect(await asPostgres(client, "select count(*)::integer as n from public.public_interest_submissions where email = $1", [ADA])).toEqual([{ n: 0 }]);
      expect(await asPostgres(client, "select count(*)::integer as n from private.public_interest_suppressions where suppression_scope_hash = private.public_interest_suppression_scope($1)", [ADA])).toEqual([{ n: 1 }]);
      expect(await call(client, "public.confirm_public_interest_unsubscribe($1, $2)", [hex("token:u1"), hex("network:one-click")]))
        .toEqual({ confirmed: false, refusal: "unavailable" });
      await expectRefusal(client, () => call(client, "public.confirm_public_interest_unsubscribe($1, $2)", [hex("token:u1"), "not-a-scope"]), "22023", "invalid rate scope");
    });
  });

  it("limits one-click posts per network under its own operation", async () => {
    await withCase(async (client) => {
      await asPostgres(client,
        "insert into private.public_interest_submission_limits (scope_hash, operation, window_started_at, request_count) values ($1, 'unsubscribe-network-15m', now(), 300)",
        [hex("network:busy")]);
      expect(await call(client, "public.confirm_public_interest_unsubscribe($1, $2)", [hex("token:any"), hex("network:busy")]))
        .toEqual({ confirmed: false, refusal: "rate-limited" });
    });
  });

  // Cursor security review on #9186 (r4623645726): the route derives its scope
  // the way the stop form does, so sharing stop-network-15m would let junk
  // unsubscribe posts lock a network out of the landing stop form.
  it("never spends the landing stop form's allowance for the same network", async () => {
    await withCase(async (client) => {
      const network = hex("network:shared");
      for (let n = 0; n < 25; n += 1) {
        expect(await call(client, "public.confirm_public_interest_unsubscribe($1, $2)", [hex(`token:junk:${n}`), network]))
          .toEqual({ confirmed: false, refusal: "unavailable" });
      }
      expect(await asPostgres(client,
        "select operation, request_count from private.public_interest_submission_limits where scope_hash = $1 order by operation", [network]))
        .toEqual([{ operation: "unsubscribe-network-15m", request_count: 25 }]);
      expect(await call(client, "public.request_public_interest_stop($1, 'en', 'public-landing', '', $2, $3, $4)", [
        ADA, network, hex("stop-email:shared"), hex("token:stop-form"),
      ])).toEqual({ accepted: true, pending: true });
      expect(await asPostgres(client,
        "select request_count from private.public_interest_submission_limits where scope_hash = $1 and operation = 'stop-network-15m'", [network]))
        .toEqual([{ request_count: 1 }]);
      // And a network that used up the stop form's allowance can still unsubscribe.
      await asPostgres(client,
        "insert into private.public_interest_submission_limits (scope_hash, operation, window_started_at, request_count) values ($1, 'stop-network-15m', now(), 20)",
        [hex("network:stop-spent")]);
      expect(await call(client, "public.confirm_public_interest_unsubscribe($1, $2)", [hex("token:none"), hex("network:stop-spent")]))
        .toEqual({ confirmed: false, refusal: "unavailable" });
    });
  });

  it("is executable by the service role only and keeps both tables away from every client role", async () => {
    await withCase(async (client) => {
      const reviewer = await operator(client);
      for (const role of ["anon", "authenticated"]) {
        await asRole(client, role);
        for (const probe of [
          () => overview(client, reviewer),
          () => beginTest(client, reviewer),
          () => queue(client, reviewer, randomUUID()),
          () => claim(client, randomUUID(), ["x"]),
          () => finish(client, randomUUID(), 1, "sent"),
          () => call(client, "public.confirm_public_interest_unsubscribe($1, $2)", [hex("token:x"), hex("network:x")]),
          () => client.query("select count(*) from private.intake_topic_sends"),
          () => client.query("select count(*) from private.intake_topic_send_recipients"),
        ]) {
          await client.query("savepoint role_probe");
          await expect(probe()).rejects.toThrow(/permission denied/);
          await client.query("rollback to savepoint role_probe");
        }
      }
      await asRole(client, "service_role");
      for (const probe of [
        () => client.query("select count(*) from private.intake_topic_sends"),
        () => client.query("select count(*) from private.intake_topic_send_recipients"),
        () => client.query("select * from private.intake_topic_recipients('chapter_updates')"),
        () => client.query("select private.intake_topic_send_settle($1)", [randomUUID()]),
      ]) {
        await client.query("savepoint service_probe");
        await expect(probe()).rejects.toThrow(/permission denied/);
        await client.query("rollback to savepoint service_probe");
      }
      await expectRefusal(client, () => claim(client, randomUUID(), []), "22023", "invalid batch");
      await expectRefusal(client, () => claim(client, randomUUID(), ["same", "same"]), "22023", "invalid batch");
      await expectRefusal(client, () => finish(client, randomUUID(), 1, "maybe"), "22023", "invalid outcome");
    });
  });
});
