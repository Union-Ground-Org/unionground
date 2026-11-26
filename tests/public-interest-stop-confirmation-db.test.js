// @vitest-environment node
import { createHash } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921 (owner ruling
// 2026-09-25, SINGLE-USE EMAIL CONFIRMATION). Only a live apply proves the
// order of events: a request records a pending row and suppresses nothing; the
// confirmation of that token writes the suppression, removes the address's
// subscriptions and blocks a later public re-subscription; an expired token, an
// unknown token and a second use of a consumed token all return one identical
// refusal; a request for an address nobody subscribed returns the same payload
// as a request for a subscribed one; and no browser role can reach either
// function. Every case runs in one transaction and rolls back.
const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const KNOWN = "stop-confirmation-proof-known@example.invalid";
const UNKNOWN = "stop-confirmation-proof-unknown@example.invalid";
const REFUSAL = Object.freeze({ confirmed: false, refusal: "unavailable" });

function hex(seed) {
  return createHash("sha256").update(`stop-confirmation-proof:${seed}`).digest("hex");
}

async function connect() {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: "public-interest-stop-confirmation-proof",
  });
  await client.connect();
  return client;
}

async function asRole(client, role) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
  if (role !== "postgres") await client.query(`set local role ${role}`);
}

async function request(client, email, seed) {
  const { rows } = await client.query(
    "select public.request_public_interest_stop($1, 'en', 'public-landing', '', $2, $3, $4) as result",
    [email, hex(`network:${seed}`), hex(`email:${email}:${seed}`), hex(`token:${seed}`)],
  );
  return rows[0].result;
}

async function confirm(client, seed, network = "confirm-network") {
  const { rows } = await client.query(
    "select public.confirm_public_interest_stop($1, $2) as result",
    [hex(`token:${seed}`), hex(`network:${network}`)],
  );
  return rows[0].result;
}

async function state(client, email) {
  await asRole(client, "postgres");
  const { rows } = await client.query(`
    select
      (select count(*)::int from public.public_interest_submissions where email = $1) as subscriptions,
      (select count(*)::int from private.public_interest_suppressions
        where suppression_scope_hash = private.public_interest_suppression_scope($1)) as suppressions,
      (select count(*)::int from private.public_interest_stop_confirmations where normalized_email = $1) as pending
  `, [email]);
  await asRole(client, "service_role");
  return rows[0];
}

async function subscribe(client, email) {
  await client.query(`
    insert into public.public_interest_submissions (email, name, interest, locale, source)
    values ($1, 'Proof', 'chapter_updates', 'en', 'public-landing'), ($1, 'Proof', 'union_news', 'en', 'public-landing')
    on conflict (email, interest) do nothing
  `, [email]);
}

async function withCase(run) {
  const client = await connect();
  try {
    await client.query("begin");
    await asRole(client, "postgres");
    await subscribe(client, KNOWN);
    await asRole(client, "service_role");
    await run(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

live("public-interest stop confirmation (live)", () => {
  it("records a pending request and suppresses nothing until the link is used", async () => {
    await withCase(async (client) => {
      expect(await request(client, KNOWN, "pending")).toEqual({ accepted: true, pending: true });
      expect(await state(client, KNOWN)).toEqual({ subscriptions: 2, suppressions: 0, pending: 1 });
      await asRole(client, "postgres");
      const { rows } = await client.query(
        "select token_hash, locale, source, extract(epoch from expires_at - created_at)::int as ttl_seconds from private.public_interest_stop_confirmations where normalized_email = $1",
        [KNOWN],
      );
      expect(rows).toEqual([{ token_hash: hex("token:pending"), locale: "en", source: "public-landing", ttl_seconds: 24 * 3600 }]);
    });
  });

  it("confirming the token suppresses the address, removes its subscriptions and blocks a later public re-subscription", async () => {
    await withCase(async (client) => {
      await request(client, KNOWN, "confirm");
      expect(await confirm(client, "confirm")).toEqual({ confirmed: true });
      expect(await state(client, KNOWN)).toEqual({ subscriptions: 0, suppressions: 1, pending: 0 });
      const { rows } = await client.query(
        "select public.submit_public_interest($1, 'Proof', 'chapter_updates', 'en', 'public-landing', '', $2, $3) as result",
        [KNOWN, hex("network:resubscribe"), hex("email-interest:resubscribe")],
      );
      expect(rows[0].result).toEqual({ accepted: true });
      expect((await state(client, KNOWN)).subscriptions).toBe(0);
    });
  });

  it("refuses an expired token with the shared refusal, removes it, and leaves the address untouched", async () => {
    await withCase(async (client) => {
      await request(client, KNOWN, "expired");
      await asRole(client, "postgres");
      await client.query(
        "update private.public_interest_stop_confirmations set created_at = clock_timestamp() - interval '25 hours', expires_at = clock_timestamp() - interval '1 hour' where token_hash = $1",
        [hex("token:expired")],
      );
      await asRole(client, "service_role");
      expect(await confirm(client, "expired")).toEqual(REFUSAL);
      expect(await state(client, KNOWN)).toEqual({ subscriptions: 2, suppressions: 0, pending: 0 });
    });
  });

  it("refuses a second use of a consumed token and an unknown token with the same payload", async () => {
    await withCase(async (client) => {
      await request(client, KNOWN, "once");
      expect(await confirm(client, "once")).toEqual({ confirmed: true });
      const second = await confirm(client, "once", "second-network");
      const unknown = await confirm(client, "never-issued", "unknown-network");
      expect(second).toEqual(REFUSAL);
      expect(unknown).toEqual(second);
      expect(await state(client, KNOWN)).toEqual({ subscriptions: 0, suppressions: 1, pending: 0 });
    });
  });

  it("answers a request for an address nobody subscribed exactly like a subscribed one, and stops nothing for either", async () => {
    await withCase(async (client) => {
      const known = await request(client, KNOWN, "compare-known");
      const unknown = await request(client, UNKNOWN, "compare-unknown");
      expect(unknown).toEqual(known);
      expect(await state(client, UNKNOWN)).toEqual({ subscriptions: 0, suppressions: 0, pending: 1 });
      expect(await state(client, KNOWN)).toEqual({ subscriptions: 2, suppressions: 0, pending: 1 });
      // Confirming the unknown address still records the stop so the address
      // can never be added through the public form.
      expect(await confirm(client, "compare-unknown")).toEqual({ confirmed: true });
      expect(await state(client, UNKNOWN)).toEqual({ subscriptions: 0, suppressions: 1, pending: 0 });
    });
  });

  it("bounds the network scope and keeps both functions and the pending table away from browser roles", async () => {
    await withCase(async (client) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        expect(await confirm(client, `bound-${attempt}`, "bound-network")).toEqual(REFUSAL);
      }
      expect(await confirm(client, "bound-21", "bound-network")).toEqual({ confirmed: false, refusal: "rate-limited" });
      for (const role of ["anon", "authenticated"]) {
        await asRole(client, role);
        await client.query("savepoint browser_role");
        await expect(client.query("select public.confirm_public_interest_stop($1, $2)", [hex("token:x"), hex("network:x")]))
          .rejects.toMatchObject({ code: "42501" });
        await client.query("rollback to savepoint browser_role");
        await expect(client.query(
          "select public.request_public_interest_stop($1, 'en', 'public-landing', '', $2, $3, $4)",
          [KNOWN, hex("n"), hex("e"), hex("t")],
        )).rejects.toMatchObject({ code: "42501" });
        await client.query("rollback to savepoint browser_role");
        await expect(client.query("select count(*) from private.public_interest_stop_confirmations"))
          .rejects.toMatchObject({ code: "42501" });
        await client.query("rollback to savepoint browser_role");
      }
    });
  });
});
