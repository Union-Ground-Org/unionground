// @vitest-environment node
// UX-UG-DUES-CHECKOUT-IN-FLIGHT-IS-AN-OPAQUE-REFUSAL-20260920: a second
// checkout for an obligation that already has a live reservation must surface
// a named condition, and the member workspace must say which obligations have
// one. Only a live apply can prove the raw 23505 no longer escapes and that
// the active index predicate still covers every non-terminal state.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const NON_TERMINAL = ["creating", "open", "cancel_requested", "reconciling", "attention_required"];

const id = Object.freeze({
  member: "09220100-0000-4000-8000-000000000001",
  session: "09220100-0000-4000-8000-000000000002",
  org: "09220100-0000-4000-8000-00000000000a",
  liveObligation: "09220100-0000-4000-8000-000000000011",
  releasedObligation: "09220100-0000-4000-8000-000000000012",
  settledObligation: "09220100-0000-4000-8000-000000000013",
});
const chapter = "dues-in-flight-proof";

live("dues checkout in-flight named condition", () => {
  let client;

  const act = async () => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: id.member, session_id: id.session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const reservation = async (obligationId, state, key) => {
    await client.query("reset role");
    await client.query(`
      insert into public.dues_checkout_reservations (
        organization_id, obligation_id, requested_by, idempotency_key, state, reserved_cents,
        connected_account_id, receipt_description, success_url, cancel_url, request_hash,
        provider_idempotency_key, stripe_idempotency_replay_until, expires_at
      ) values ($1, $2, $3, $4, $5, 7500, 'acct_in_flight_proof', 'Dues payment',
        'https://sibling-saas.example/m/dues?payment=success', 'https://sibling-saas.example/m/dues?payment=cancel',
        $6, $7, now() + interval '24 hours', now() + interval '23 hours')
    `, [id.org, obligationId, id.member, key, state, "a".repeat(64), `dues:${randomUUID()}`]);
  };

  const reservationCount = async (obligationId) => {
    await client.query("reset role");
    return Number((await client.query(
      "select count(*)::int as n from public.dues_checkout_reservations where obligation_id = $1",
      [obligationId],
    )).rows[0].n);
  };

  const createCheckout = async (obligationId, key) => {
    await act();
    await client.query("savepoint attempt");
    try {
      const value = (await client.query(
        "select public.create_dues_checkout_reservation($1, $2) as value",
        [obligationId, key],
      )).rows[0].value;
      await client.query("release savepoint attempt");
      return { value };
    } catch (error) {
      await client.query("rollback to savepoint attempt");
      return { error };
    }
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-checkout-in-flight-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [id.member, "dues-in-flight@example.invalid"]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [id.session, id.member]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic dues factor','totp','verified',now(),now())", [randomUUID(), id.member]);
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, "dues-in-flight-proof", id.member]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9922)", [chapter, id.org]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, id.member]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.member, chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id.member, chapter]);
    // The active membership already provisions the member's dues subject.
    const subject = (await client.query(`
      insert into public.dues_member_subjects(organization_id,user_id) values($1,$2)
      on conflict (organization_id,user_id) do update set user_id = excluded.user_id
      returning id
    `, [id.org, id.member])).rows[0].id;
    // One obligation per member per batch, so each obligation has its own batch.
    for (const [index, obligation] of [id.liveObligation, id.releasedObligation, id.settledObligation].entries()) {
      const batch = randomUUID();
      await client.query(`
        insert into public.dues_assessment_batches(id,organization_id,title,scope_kind,amount_cents,due_on,eligibility_fingerprint,idempotency_key,created_by)
        values ($1,$2,'September dues','organization',7500,current_date + 30,$3,$4,$5)
      `, [batch, id.org, "b".repeat(64), `dues-in-flight-proof-batch-${index}`, id.member]);
      await client.query(`
        insert into public.dues_obligations(id,organization_id,batch_id,member_subject_id,issued_cents,due_on)
        values ($1,$2,$3,$4,7500,current_date + 30)
      `, [obligation, id.org, batch, subject]);
    }
    await client.query(`
      insert into public.dues_provider_connections(organization_id,state,stripe_account_id,charges_enabled,connected_at,updated_at)
      values ($1,'ready','acct_in_flight_proof',true,now(),now())
    `, [id.org]);
    await reservation(id.liveObligation, "open", "dues-in-flight-live-key-0001");
    await reservation(id.releasedObligation, "released", "dues-in-flight-released-key-01");
    await reservation(id.settledObligation, "settled", "dues-in-flight-settled-key-001");
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("keeps the active-checkout index predicate on exactly the non-terminal states", async () => {
    await client.query("reset role");
    const definition = (await client.query(
      "select pg_catalog.pg_get_indexdef('public.dues_one_active_checkout_per_obligation'::regclass) as def",
    )).rows[0].def;
    const states = [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]).sort();
    expect(states).toEqual([...NON_TERMINAL].sort());
  });

  it("names a fresh-key checkout for an obligation with a live reservation instead of a raw 23505", async () => {
    const attempt = await createCheckout(id.liveObligation, "dues-in-flight-fresh-key-0002");
    expect(attempt.error?.code).toBe("55006");
    expect(attempt.error?.message).toBe("dues checkout in flight");
    expect(await reservationCount(id.liveObligation)).toBe(1);
  });

  it("still returns the existing reservation for its own idempotency key", async () => {
    const attempt = await createCheckout(id.liveObligation, "dues-in-flight-live-key-0001");
    expect(attempt.error).toBeUndefined();
    expect(attempt.value).toMatchObject({ state: "open", idempotent: true });
  });

  it("marks only obligations with a non-terminal reservation as in flight in the member workspace", async () => {
    await act();
    const workspace = (await client.query("select public.get_my_dues_workspace(null, 25) as value")).rows[0].value;
    const flags = Object.fromEntries(workspace.obligations.items.map((item) => [item.id, item.checkoutInFlight]));
    expect(flags).toEqual({
      [id.liveObligation]: true,
      [id.releasedObligation]: false,
      [id.settledObligation]: false,
    });
  });

  it("lets an obligation whose only reservation was released start a new checkout", async () => {
    const attempt = await createCheckout(id.releasedObligation, "dues-in-flight-retry-key-0003");
    expect(attempt.error).toBeUndefined();
    expect(attempt.value?.reservationId).toEqual(expect.any(String));
    expect(await reservationCount(id.releasedObligation)).toBe(2);
  });
});
