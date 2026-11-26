// @vitest-environment node
//
// BUG-UG-NOTIFICATION-EMAIL-DROPPED-AFTER-HOUR-LONG-MAIL-OUTAGE-20261112
// (#8488) on a disposable database. A notification email that fails on every
// attempt while the mail provider is down keeps its place past the 6th attempt
// (the last backoff step) while it is younger than 23 hours, and is sent
// exactly once when the provider answers again; a provider refusal stays final
// at the 6th attempt; a delivery still failing at 23 hours is marked for
// replay, never dropped without a trace.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idempotencyKey } from "../api/notifications-dispatch.js";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const REPLAY = "mail provider unavailable for 23 hours; replay needed: ";

live("notification email delivery through a mail provider outage, on a disposable database", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false,
      application_name: "notification-email-outage-retry-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function inTransaction(body) {
    await client.query("begin");
    try {
      await client.query("set local role service_role");
      return await body();
    } finally {
      await client.query("rollback");
    }
  }

  // One member with one queued notification email, outbound sending on.
  async function queuedEmail() {
    await client.query("reset role");
    await client.query("update private.notification_controls set outbound_enabled = true where id");
    const user = randomUUID();
    await client.query("insert into auth.users(id,email,created_at) values ($1,$2,now())", [user, `${user}@outage.invalid`]);
    const notification = randomUUID();
    await client.query("insert into public.member_notifications(id,user_id,title,body,kind) values ($1,$2,'Fictional proof','Fictional proof','events')", [notification, user]);
    // Inserting the notification queues its email delivery.
    await client.query("insert into public.member_notification_deliveries(notification_id,user_id,channel) values ($1,$2,'email') on conflict (notification_id, channel) do nothing",
      [notification, user]);
    const delivery = (await client.query("select id from public.member_notification_deliveries where notification_id = $1 and channel = 'email'", [notification])).rows[0].id;
    await client.query("set local role service_role");
    return delivery;
  }

  const row = async (id) => (await client.query("select status, attempts, last_error from public.member_notification_deliveries where id = $1", [id])).rows[0];

  // The next attempt is due now: the backoff is skipped, not the attempt count.
  async function claim(id) {
    await client.query("reset role");
    await client.query("update public.member_notification_deliveries set next_attempt_at = now() where id = $1 and status = 'pending'", [id]);
    await client.query("set local role service_role");
    const claimed = (await client.query("select public.claim_notification_deliveries('email', 50) as rows")).rows[0].rows;
    return claimed.find((entry) => entry.deliveryId === id) ?? null;
  }

  async function record(entry, status, error = null) {
    await client.query("select public.record_notification_delivery_results($1::jsonb)",
      [JSON.stringify([{ deliveryId: entry.deliveryId, attempt: entry.attempt, leaseEpoch: entry.leaseEpoch, status, providerMessageId: null, error }])]);
  }

  async function age(id, interval) {
    await client.query("reset role");
    await client.query(`update public.member_notification_deliveries set created_at = now() - interval '${interval}' where id = $1`, [id]);
    await client.query("set local role service_role");
  }

  it("keeps an email through an outage longer than the last backoff step and sends it once when the provider answers", () => inTransaction(async () => {
    const id = await queuedEmail();
    const keys = new Set();
    for (const [index, error] of ["resend http 503", "resend timeout", "resend network", "resend http 502", "resend http 429", "resend error", "resend http 503", "resend http 500"].entries()) {
      const entry = await claim(id);
      expect(entry, `attempt ${index + 1} is claimed`).toBeTruthy();
      keys.add(idempotencyKey(entry.deliveryId));
      await record(entry, "failed", error);
      expect(await row(id), `after attempt ${index + 1}`).toMatchObject({ status: "pending", attempts: index + 1 });
    }
    const recovered = await claim(id);
    keys.add(idempotencyKey(recovered.deliveryId));
    await record(recovered, "sent");
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 9, last_error: null });
    // One delivery row, one key: the provider can deduplicate every retry.
    expect(keys.size).toBe(1);
    expect(await claim(id)).toBeNull();
  }));

  it("keeps a provider refusal final at the 6th attempt", () => inTransaction(async () => {
    const id = await queuedEmail();
    for (let attempt = 1; attempt <= 6; attempt += 1) await record(await claim(id), "failed", "resend http 422");
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 6, last_error: "resend http 422" });
    expect(await claim(id)).toBeNull();
  }));

  it("marks a delivery still failing at 23 hours for replay, from the result and from the expiry sweep", () => inTransaction(async () => {
    const atResult = await queuedEmail();
    for (let attempt = 1; attempt <= 6; attempt += 1) await record(await claim(atResult), "failed", "resend http 503");
    expect(await row(atResult)).toMatchObject({ status: "pending", attempts: 6 });
    const last = await claim(atResult);
    await age(atResult, "23 hours 1 minute");
    await record(last, "failed", "resend http 503");
    expect(await row(atResult)).toMatchObject({ status: "failed", attempts: 7, last_error: `${REPLAY}resend http 503` });

    const atExpiry = await queuedEmail();
    for (let attempt = 1; attempt <= 6; attempt += 1) await record(await claim(atExpiry), "failed", "resend network");
    await age(atExpiry, "23 hours 1 minute");
    expect(await claim(atExpiry)).toBeNull();
    await client.query("select public.expire_notification_deliveries()");
    expect(await row(atExpiry)).toMatchObject({ status: "failed", attempts: 6, last_error: `${REPLAY}resend network` });
  }));

  it("keeps the outage as the cause across a deferral, so the 23-hour replay mark still lands", () => inTransaction(async () => {
    const id = await queuedEmail();
    for (let attempt = 1; attempt <= 6; attempt += 1) await record(await claim(id), "failed", "resend http 503");
    // A budget hold near the end sends nothing and must not erase the outage.
    await record(await claim(id), "deferred", "deferred: email channel budget");
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 6, last_error: "resend http 503" });
    await age(id, "23 hours 1 minute");
    await client.query("select public.expire_notification_deliveries()");
    expect(await row(id)).toMatchObject({ status: "failed", last_error: `${REPLAY}resend http 503` });
  }));

  it("records a deferral's own reason when no outage came before it", () => inTransaction(async () => {
    const id = await queuedEmail();
    await record(await claim(id), "deferred", "deferred: email channel budget");
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 0, last_error: "deferred: email channel budget" });
  }));

  // #8781: the first sweep after an outage email turns 23 hours old may come
  // late; past 48 hours it still marks the email for replay, never skipped.
  it("marks an outage email for replay when the first sweep comes at 30 or 60 hours, and still skips a 60-hour email that never failed (#8781)", () => inTransaction(async () => {
    const sweptAt = {};
    for (const hours of ["30", "60"]) {
      const id = await queuedEmail();
      for (let attempt = 1; attempt <= 6; attempt += 1) await record(await claim(id), "failed", "resend http 503");
      await age(id, `${hours} hours`);
      sweptAt[hours] = id;
    }
    // A deferral after the outage keeps the outage as the cause with fewer than six attempts.
    const deferred = await queuedEmail();
    await record(await claim(deferred), "failed", "resend timeout");
    await record(await claim(deferred), "deferred", "deferred: email channel budget");
    expect(await row(deferred)).toMatchObject({ status: "pending", attempts: 1, last_error: "resend timeout" });
    await age(deferred, "60 hours");
    const neverFailed = await queuedEmail();
    await age(neverFailed, "60 hours");
    const budgetOnly = await queuedEmail();
    await record(await claim(budgetOnly), "deferred", "deferred: email channel budget");
    await age(budgetOnly, "60 hours");

    const result = (await client.query("select public.expire_notification_deliveries() as r")).rows[0].r;
    expect(result.exhausted).toBeGreaterThanOrEqual(3);
    expect(await row(sweptAt["30"])).toMatchObject({ status: "failed", attempts: 6, last_error: `${REPLAY}resend http 503` });
    expect(await row(sweptAt["60"])).toMatchObject({ status: "failed", attempts: 6, last_error: `${REPLAY}resend http 503` });
    expect(await row(deferred)).toMatchObject({ status: "failed", attempts: 1, last_error: `${REPLAY}resend timeout` });
    expect(await row(neverFailed)).toMatchObject({ status: "skipped", attempts: 0, last_error: "expired before dispatch" });
    expect(await row(budgetOnly)).toMatchObject({ status: "skipped", last_error: "expired before dispatch" });
    // The operator's replay list finds every outage email.
    const replay = (await client.query(
      "select id from public.member_notification_deliveries where id = any($1::uuid[]) and status = 'failed' and last_error like 'mail provider unavailable for 23 hours; replay needed: %'",
      [[sweptAt["30"], sweptAt["60"], deferred, neverFailed, budgetOnly]])).rows.map((entry) => entry.id).sort();
    expect(replay).toEqual([sweptAt["30"], sweptAt["60"], deferred].sort());
  }));

  it("leaves a young email in an outage alone in the expiry sweep", () => inTransaction(async () => {
    const id = await queuedEmail();
    for (let attempt = 1; attempt <= 7; attempt += 1) await record(await claim(id), "failed", "resend http 503");
    await client.query("select public.expire_notification_deliveries()");
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 7 });
  }));
});
