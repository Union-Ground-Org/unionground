// @vitest-environment node
//
// BUG-UG-HELD-MEMBER-PIN-STILL-SHOWS-20261112 (#8586).
//
// While features.security.member_pin_signin is held for its release day, no
// member may be told anything about PIN sign-in. private.member_pin_ineligibility
// used to answer 'mfa_enrolled' before it read the switch, so a member with
// two-step sign-in still got a card explaining it. The switch is now read
// first, through the hold-aware private.organization_feature_enabled.
// Restricted PIN sessions is deliberately not held: its restriction keeps
// applying to live PIN sessions whatever the parent's hold.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "member_pin_switch_before_two_step";
const SWITCH = "features.security.member_pin_signin";
const RESTRICTED = "features.security.member_pin_restricted_sessions";
const FUNCTION = "private.member_pin_ineligibility";

const lines = (body) => stripComments(body).split("\n").map((line) => line.trim()).filter(Boolean);

describe("member PIN switch-before-two-step migration (offline)", () => {
  const sql = loadMigrationSql(MIGRATION);
  const body = stripComments(latestFnBody(FUNCTION));

  it("is one atomic migration and the newest definition of the eligibility read", () => {
    const code = stripComments(sql).trim();
    expect(code.startsWith("begin;")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
    expect(stripComments(fnBody(sql, FUNCTION))).toBe(body);
    expect(code).toContain("revoke all on function private.member_pin_ineligibility(uuid) from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/\bgrant\b/);
  });

  it("reads the switch through the hold-aware read before the two-step check, and nothing else moves", () => {
    const switchAt = body.indexOf(`not private.organization_feature_enabled(m.organization_id, '${SWITCH}')`);
    expect(switchAt).toBeGreaterThan(body.indexOf("return 'staff_role';"));
    expect(switchAt).toBeLessThan(body.indexOf("auth.mfa_factors"));
    expect(body.indexOf("return 'mfa_enrolled';")).toBeLessThan(body.indexOf("return 'no_organization';"));
    expect(body).not.toMatch(/release_at|organization_setting_values|default_value|lock_case_graph|\binsert\b|\bupdate\b|\bdelete\b/);
    // The same statements as 20261003040000, in the new order.
    const original = fnBody(loadMigrationSql("20261003040000_member_pin_signin"), FUNCTION)
      .replace(/^create function/, "create or replace function");
    expect(lines(body).sort()).toEqual(lines(original).sort());
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member PIN sign-in held on a disposable database", () => {
  let client;
  const names = ["memberMfa", "memberPlain"];
  const ids = Object.fromEntries([...names, ...names.map((name) => `${name}Session`), "org"].map((key) => [key, randomUUID()]));
  const slug = `pin-held-${ids.org.slice(0, 8)}`;

  async function asPostgres(text, values = []) {
    await client.query("reset role");
    return (await client.query(text, values)).rows;
  }

  async function reason(name) {
    return (await asPostgres("select private.member_pin_ineligibility($1) r", [ids[name]]))[0].r;
  }

  async function status(name, aal = "aal1") {
    await client.query("reset role");
    const claims = { sub: ids[name], role: "authenticated", aal, session_id: ids[`${name}Session`],
      amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - 60 }] };
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("set local role authenticated");
    const row = (await client.query("select public.get_my_member_pin_status() s")).rows[0].s;
    await client.query("reset role");
    return row;
  }

  const hold = (key, at) => asPostgres("update public.platform_setting_definitions set release_at = $2 where key = $1", [key, at]);
  const store = (key, value) => asPostgres(
    `insert into public.organization_setting_values (organization_id, setting_key, value) values ($1, $2, $3::jsonb)
     on conflict (organization_id, setting_key) do update set value = excluded.value`,
    [ids.org, key, JSON.stringify(value)],
  );
  const restrictionApplies = async (name) => (await asPostgres("select private.member_pin_restriction_applies($1) a", [ids[name]]))[0].a;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-pin-held-switch-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '120s'");
    await client.query("set local lock_timeout = '15s'");
    // Start released whatever Main holds; every change rolls back.
    await hold(SWITCH, null);
    for (const name of names) {
      await client.query(
        "insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, created_at) values ($1, $2, now(), '{}', now())",
        [ids[name], `${ids[name]}@example.invalid`],
      );
      await client.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal1')", [ids[`${name}Session`], ids[name]]);
    }
    await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [ids.org, slug, ids.memberPlain]);
    await client.query("insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9913)", [slug, ids.org]);
    for (const name of names) {
      await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids.org, ids[name]]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ids[name], slug]);
    }
    await client.query(
      "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'Held PIN proof', 'totp', 'verified', now(), now())",
      [randomUUID(), ids.memberMfa],
    );
    await store(SWITCH, true);
  }, 120_000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("released and on: unchanged, a two-step member is still told why", async () => {
    expect(await reason("memberPlain")).toBeNull();
    expect(await reason("memberMfa")).toBe("mfa_enrolled");
    expect(await status("memberMfa", "aal2")).toMatchObject({ available: false, reason: "mfa_enrolled", hasPin: false });
    expect(await status("memberPlain")).toMatchObject({ available: true, reason: null });
  });

  it("held: every member is answered as off, whatever their two-step state, and the restriction still applies", async () => {
    await hold(SWITCH, "infinity");
    expect(await reason("memberPlain")).toBe("disabled_by_organization");
    expect(await reason("memberMfa")).toBe("disabled_by_organization");
    expect(await status("memberMfa", "aal2")).toMatchObject({ available: false, reason: "disabled_by_organization", hasPin: false });
    // Not held itself: on by default for live PIN sessions, and an
    // organization's own choice still counts.
    expect((await asPostgres("select release_at from public.platform_setting_definitions where key = $1", [RESTRICTED]))[0].release_at).toBeNull();
    expect(await restrictionApplies("memberMfa")).toBe(true);
    await store(RESTRICTED, false);
    expect(await restrictionApplies("memberMfa")).toBe(false);
    await asPostgres("delete from public.organization_setting_values where organization_id = $1 and setting_key = $2", [ids.org, RESTRICTED]);
    expect(await restrictionApplies("memberMfa")).toBe(true);
  });

  it("an organization that switched it off names no other cause either", async () => {
    await hold(SWITCH, null);
    await store(SWITCH, false);
    expect(await reason("memberMfa")).toBe("disabled_by_organization");
    await store(SWITCH, true);
  });

  it("releases on its own when the release time passes", async () => {
    await hold(SWITCH, "infinity");
    expect(await reason("memberMfa")).toBe("disabled_by_organization");
    await hold(SWITCH, new Date(Date.now() - 60_000).toISOString());
    expect(await reason("memberMfa")).toBe("mfa_enrolled");
    expect(await reason("memberPlain")).toBeNull();
  });
});
