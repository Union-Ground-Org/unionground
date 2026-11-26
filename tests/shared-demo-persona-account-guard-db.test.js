// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107 (gate r1s2/r2s2 on
// #7375). The SAMPLE demo entry releases aal2 sessions for the seven shared
// persona accounts in config/sample-backend.json, so their durable sign-in
// state is guarded in the database itself: whatever path reaches Auth, a
// persona's email, password, phone, factors,
// passkeys and existence cannot change, while sign-in bookkeeping
// still can. Every case runs inside one transaction that is rolled back.
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PERSONA = "maya.thompson@example.invalid";

live("shared demo persona account guard", () => {
  let client;
  let persona;
  let other;
  let verifiedFactor;

  async function refused(sql, params = []) {
    await client.query("savepoint attempt");
    try {
      await client.query(sql, params);
    } catch (error) {
      await client.query("rollback to savepoint attempt");
      expect(error.code).toBe("42501");
      expect(error.hint).toBe("shared-demo-account");
      return;
    }
    await client.query("rollback to savepoint attempt");
    throw new Error(`Expected the guard to refuse: ${sql}`);
  }

  async function allowed(sql, params = []) {
    await client.query("savepoint attempt");
    try {
      return await client.query(sql, params);
    } finally {
      await client.query("rollback to savepoint attempt");
    }
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "shared-demo-persona-guard" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
    await client.query("begin");
    persona = randomUUID();
    other = randomUUID();
    verifiedFactor = randomUUID();
    await client.query("insert into auth.users(id, email, encrypted_password, phone) values ($1, $2, 'seed-hash', null), ($3, $4, 'seed-hash', null)",
      [persona, PERSONA, other, `${other}@${["example", "invalid"].join(".")}`]);
    // Seed-time state is written under the operator override, as an operator
    // re-enrolling a persona's authenticator would.
    await client.query("set local union_ground.shared_demo_persona_maintenance = 'on'");
    await client.query(`insert into auth.mfa_factors(id, user_id, factor_type, status, created_at, updated_at, secret)
      values ($1, $2, 'totp', 'verified', now(), now(), 'seed-secret')`, [verifiedFactor, persona]);
    await client.query(`insert into auth.identities(provider_id, user_id, identity_data, provider)
      values ($1::text, $1::uuid, jsonb_build_object('sub', $1::text, 'email', $2::text), 'email')`, [persona, PERSONA]);
    await client.query("set local union_ground.shared_demo_persona_maintenance = 'off'");
  });

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("refuses every change to the persona's email, password, phone and existence", async () => {
    await refused("update auth.users set encrypted_password = 'visitor-hash' where id = $1", [persona]);
    await refused("update auth.users set email = 'visitor@example.invalid' where id = $1", [persona]);
    await refused("update auth.users set email_change = 'visitor@example.invalid' where id = $1", [persona]);
    await refused("update auth.users set phone = '15555550100' where id = $1", [persona]);
    await refused("update auth.users set phone_change = '15555550100' where id = $1", [persona]);
    await refused("update auth.users set deleted_at = now() where id = $1", [persona]);
    await refused("delete from auth.users where id = $1", [persona]);
  });

  // Gate r3s2/r4s2 on #7375: address recovery and password reissue ban the
  // account first (ban_duration plus the recovery lock in one Auth update);
  // that first write is refused, so nothing commits before the refusal.
  it("refuses the recovery ban that address recovery and password reissue write first", async () => {
    await refused(`update auth.users set banned_until = now() + interval '100 years',
      raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"union_ground_recovery_lock":"op"}'::jsonb
      where id = $1`, [persona]);
    await refused("update auth.users set banned_until = now() + interval '1 hour' where id = $1", [persona]);
  });

  // Gate r3s1/r4s1 on #7375: no recovery code can be generated or claimed for
  // a persona, so MFA recovery never reaches the service-role preparation
  // that installs its account-wide lock.
  it("refuses generating or claiming a persona recovery code", async () => {
    await refused("insert into public.mfa_recovery_code_sets (user_id) values ($1)", [persona]);
    await refused(`insert into public.mfa_recovery_codes (user_id, generation, code_prefix, code_hash)
      values ($1, 1, 'ABCDEF01', 'hash')`, [persona]);
    await client.query("savepoint legacy");
    await client.query("set local union_ground.shared_demo_persona_maintenance = 'on'");
    await client.query("insert into public.mfa_recovery_code_sets (user_id) values ($1)", [persona]);
    await client.query(`insert into public.mfa_recovery_codes (user_id, generation, code_prefix, code_hash)
      values ($1, 1, 'ABCDEF01', 'hash')`, [persona]);
    await client.query("set local union_ground.shared_demo_persona_maintenance = 'off'");
    await refused(`update public.mfa_recovery_codes set claimed_at = now(), claim_expires_at = now() + interval '2 minutes',
      claim_token_hash = 'claim' where user_id = $1`, [persona]);
    await refused("update public.mfa_recovery_code_sets set failed_attempts = 1 where user_id = $1", [persona]);
    await client.query("rollback to savepoint legacy");
    expect((await allowed("insert into public.mfa_recovery_code_sets (user_id) values ($1)", [other])).rowCount).toBe(1);
  });

  it("lets sign-in bookkeeping through", async () => {
    const result = await allowed(`update auth.users set last_sign_in_at = now(), updated_at = now(),
      raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb), email_change = coalesce(email_change, '')
      where id = $1`, [persona]);
    expect(result.rowCount).toBe(1);
    expect((await allowed("update auth.mfa_factors set last_challenged_at = now(), updated_at = now() where id = $1", [verifiedFactor])).rowCount).toBe(1);
    expect((await allowed("update auth.identities set last_sign_in_at = now() where user_id = $1", [persona])).rowCount).toBe(1);
  });

  it("refuses enrolling, removing or rewriting the persona's factors", async () => {
    await refused(`insert into auth.mfa_factors(id, user_id, factor_type, status, created_at, updated_at, secret)
      values (gen_random_uuid(), $1, 'totp', 'unverified', now(), now(), 'visitor-secret')`, [persona]);
    await refused("delete from auth.mfa_factors where id = $1", [verifiedFactor]);
    await refused("update auth.mfa_factors set secret = 'visitor-secret' where id = $1", [verifiedFactor]);
    await refused("update auth.mfa_factors set status = 'unverified' where id = $1", [verifiedFactor]);
    await refused("update auth.mfa_factors set user_id = $2 where id = $1", [verifiedFactor, other]);
  });

  it("refuses registering a passkey and leaves the Auth bookkeeping identities table unguarded", async () => {
    expect((await allowed(`insert into auth.identities(provider_id, user_id, identity_data, provider)
      values ('google-visitor', $1, '{"sub":"google-visitor"}'::jsonb, 'google')`, [persona])).rowCount).toBe(1);
    await refused("insert into auth.webauthn_credentials(user_id, credential_id, public_key) values ($1, '\\x01', '\\x02')", [persona]);
  });

  it("leaves every other account alone", async () => {
    expect((await allowed("update auth.users set encrypted_password = 'new-hash', email = $2 where id = $1",
      [other, `${randomUUID()}@${["example", "invalid"].join(".")}`])).rowCount).toBe(1);
    expect((await allowed(`insert into auth.mfa_factors(id, user_id, factor_type, status, created_at, updated_at, secret)
      values (gen_random_uuid(), $1, 'totp', 'verified', now(), now(), 'own-secret')`, [other])).rowCount).toBe(1);
    expect((await allowed("insert into auth.webauthn_credentials(user_id, credential_id, public_key) values ($1, '\\x01', '\\x02')", [other])).rowCount).toBe(1);
    expect((await allowed("delete from auth.users where id = $1", [other])).rowCount).toBe(1);
  });

  it("lets an operator lift the guard for one transaction only", async () => {
    await client.query("savepoint maintenance");
    await client.query("set local union_ground.shared_demo_persona_maintenance = 'on'");
    expect((await client.query("update auth.users set encrypted_password = 'operator-hash' where id = $1", [persona])).rowCount).toBe(1);
    await client.query("rollback to savepoint maintenance");
    await client.query("set local union_ground.shared_demo_persona_maintenance = 'off'");
    await refused("update auth.users set encrypted_password = 'visitor-hash' where id = $1", [persona]);
  });

  it("keeps the database list equal to the seven entry personas", async () => {
    const { readFileSync } = await import("node:fs");
    const config = JSON.parse(readFileSync(new URL("../config/sample-backend.json", import.meta.url), "utf8"));
    expect(config.samplePersonas).toHaveLength(7);
    for (const { email } of config.samplePersonas) {
      expect((await client.query("select private.is_shared_demo_persona_email($1) as hit", [email.toUpperCase()])).rows[0].hit).toBe(true);
    }
    expect((await client.query("select private.is_shared_demo_persona_email('kayla.doyle@loadtest.example.com') as hit")).rows[0].hit).toBe(false);
    expect((await client.query("select private.is_shared_demo_persona_email(null) as hit")).rows[0].hit).toBe(false);
  });
});
