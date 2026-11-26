// @vitest-environment node
//
// REQ-UG-MEMBER-PIN-SIGNIN-20261001
//
// Offline half: the migration's shape (atomic, case-graph gates on every
// writer, no global lock on the sign-in path, old defaults, exact grants).
// Live half (disposable loopback only; needs the W1-SETTINGS registry and the
// W1-URGENT-B throttle installed): the hash never leaves the database,
// members-only eligibility, a gained staff role deletes the PIN, MFA refusal,
// escalating lockout, throttles, cross-tenant switch semantics, the admin
// failed-login inbox and the audit trail.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { acquisition, codeOnly, helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

const MIGRATION = "supabase/migrations/20261003040000_member_pin_signin.sql";
const sql = readFileSync(MIGRATION, "utf8");
const code = stripComments(sql).replace(/\s+/g, " ");
const functions = parseFunctions(sql);
const fn = (name) => functions.find((entry) => entry.name === name);

describe("member PIN sign-in migration (offline)", () => {
  it("is one atomic migration in the lane block", () => {
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    expect(MIGRATION).toMatch(/\/2026100304[0-4]\d{3}_/);
  });

  it("registers the switch and limits with the old app's effective defaults", () => {
    expect(code).toContain("('features.security.member_pin_signin', 'boolean'");
    expect(code).toMatch(/'features\.security\.member_pin_signin'.*?'false', null, null, null, 210, 'security', true\)/);
    expect(code).toMatch(/'limits\.security\.member_pin_lockout_attempts'.*?'5', 3, 10, null, 220, 'security', false\)/);
    expect(code).toMatch(/'limits\.security\.member_pin_lockout_minutes'.*?'15', 5, 1440, null, 230, 'security', false\)/);
    expect(code).toContain("on conflict (key) do nothing");
    expect(sql).toContain("0079_add_login_visibility_settings.sql:20");
  });

  it("gates every writer behind the case-graph helper and keeps the sign-in path off the global lock", () => {
    for (const name of ["public.set_my_member_pin", "public.remove_my_member_pin", "public.record_member_pin_failure", "private.member_pin_revoke_for_staff"]) {
      expect(fn(name), name).toBeDefined();
      expect(helperFirst(fn(name).source), name).toBe(true);
    }
    for (const name of ["public.verify_member_pin_signin", "private.member_pin_ineligibility", "private.member_pin_attempt_close"]) {
      expect(codeOnly(fn(name).source), name).not.toMatch(/lock_case_graph/);
    }
    // bcrypt runs inside verify; it must not acquire anything a case-graph
    // writer waits on. The only row acquisition is the per-account attempt row.
    expect(acquisition.test(codeOnly(fn("public.verify_member_pin_signin").source))).toBe(false);
    expect(codeOnly(fn("private.member_pin_attempt_open").source)).toContain("from private.member_pin_attempt_state s");
  });

  it("never seeds, derives or logs a PIN", () => {
    expect(code).not.toMatch(/phone[^;]*\bset_my_member_pin|right\(.*phone/i);
    expect(code).toContain("extensions.crypt(p_pin, extensions.gen_salt('bf', 12))");
    expect(code).not.toMatch(/raise [a-z]+ '[^']*%[^']*', [^;]*p_pin/i);
    expect(code).not.toMatch(/insert into private\.member_pin_audit[^;]*p_pin/);
  });

  it("grants exactly: self-service to authenticated, sign-in to service_role, tables to nobody", () => {
    expect(code).toContain("grant execute on function public.get_my_member_pin_status() to authenticated;");
    expect(code).toContain("grant execute on function public.set_my_member_pin(text) to authenticated;");
    expect(code).toContain("grant execute on function public.remove_my_member_pin() to authenticated;");
    expect(code).toContain("grant execute on function public.verify_member_pin_signin(text, text, text) to service_role;");
    expect(code).toContain("grant execute on function public.record_member_pin_failure(text, text, text) to service_role;");
    expect(code).toContain("grant execute on function public.member_pin_signin_offered() to service_role;");
    expect(code).not.toMatch(/grant [^;]* on (table )?private\.member_pin_/);
    expect(code).not.toMatch(/grant execute on function public\.verify_member_pin_signin[^;]*authenticated/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

const PIN = "40719263";
const OTHER_PIN = "905126";
const SWITCH = "features.security.member_pin_signin";

live("member PIN sign-in on a disposable database", () => {
  let client;
  let savepoint = 0;
  const names = ["memberA", "memberA2", "memberMfa", "memberStaff", "memberBoth", "memberB", "stewardA", "memberRole", "memberBan"];
  const ids = Object.fromEntries([...names, ...names.map((name) => `${name}Session`), "orgA", "orgB"].map((key) => [key, randomUUID()]));
  const chapter = { orgA: `pin-a-${ids.orgA.slice(0, 8)}`, orgB: `pin-b-${ids.orgB.slice(0, 8)}` };
  const email = (name) => `${ids[name]}@example.invalid`;
  const homes = {
    memberA: ["orgA"], memberA2: ["orgA"], memberMfa: ["orgA"], memberStaff: ["orgA"], memberRole: ["orgA"], memberBan: ["orgA"],
    memberBoth: ["orgA", "orgB"], memberB: ["orgB"], stewardA: ["orgA"],
  };

  async function as(name, { amrAgeSeconds = 60, aal = "aal1" } = {}) {
    await client.query("reset role");
    const claims = name === "service_role"
      ? { role: "service_role" }
      : { sub: ids[name], role: "authenticated", aal, session_id: ids[`${name}Session`],
        amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - amrAgeSeconds }] };
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query(`set local role ${name === "service_role" ? "service_role" : "authenticated"}`);
  }

  async function attempt(text, values = []) {
    const label = `pin_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    try {
      const { rows } = await client.query(text, values);
      await client.query(`release savepoint ${label}`);
      return { ok: true, rows, code: null, message: null };
    } catch (error) {
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
      return { ok: false, rows: [], code: error.code, message: error.message };
    }
  }

  async function asPostgres(text, values = []) {
    await client.query("reset role");
    return (await client.query(text, values)).rows;
  }

  async function status(name, options) {
    await as(name, options);
    return (await client.query("select public.get_my_member_pin_status() s")).rows[0].s;
  }

  async function setPin(name, pin, options) {
    await as(name, options);
    return attempt("select public.set_my_member_pin($1) r", [pin]);
  }

  let network = 0;
  async function verify(name, pin, address = `ipv4:198.51.100.${(network++ % 200) + 1}`) {
    await as("service_role");
    const target = names.includes(name) ? email(name) : name;
    return (await client.query("select public.verify_member_pin_signin($1, $2, $3) v", [target, pin, address])).rows[0].v;
  }

  async function enable(org, enabled) {
    await asPostgres(
      `insert into public.organization_setting_values (organization_id, setting_key, value) values ($1, $2, $3::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [ids[org], SWITCH, JSON.stringify(enabled)],
    );
  }

  async function audit(name) {
    return (await asPostgres(
      "select action from private.member_pin_audit where subject_hash = private.member_lifecycle_subject_hash($1) order by id",
      [ids[name]],
    )).map((row) => row.action);
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-pin-signin-proof",
    });
    await client.connect();
    await client.query("begin");
    await releaseCalendarHolds(client);
    await client.query("set local statement_timeout = '120s'");
    await client.query("set local lock_timeout = '15s'");
    for (const name of names) {
      await client.query(
        "insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, created_at) values ($1, $2, now(), '{}', now())",
        [ids[name], email(name)],
      );
      // private.mfa_satisfied() admits only a live Auth session.
      await client.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal1')", [ids[`${name}Session`], ids[name]]);
    }
    for (const [org, owner] of [["orgA", "stewardA"], ["orgB", "memberB"]]) {
      await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [ids[org], chapter[org], ids[owner]]);
      await client.query(
        "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9912)",
        [chapter[org], ids[org]],
      );
    }
    for (const name of names) {
      for (const org of homes[name]) {
        await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids[org], ids[name]]);
        await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ids[name], chapter[org]]);
      }
      await client.query("update public.member_profiles set chapter_id = $2, full_name = $3 where id = $1", [ids[name], chapter[homes[name][0]], `Proof ${name}`]);
    }
    await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $2)", [ids.orgA, ids.stewardA]);
    // Valid historical staff rows must not mask the PIN refusal.
    await migrateLegacyStewardFixtures(client);
  }, 120_000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("installs private tables no client role can touch and exact function grants", async () => {
    const tables = await asPostgres(
      `select t.relname,
         has_table_privilege('anon', t.oid, 'SELECT') anon,
         has_table_privilege('authenticated', t.oid, 'SELECT') authenticated,
         has_table_privilege('service_role', t.oid, 'SELECT') service_role
       from pg_class t join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'private' and t.relkind = 'r' and t.relname like 'member_pin_%' order by 1`,
    );
    expect(tables.map((row) => row.relname)).toEqual(["member_pin_attempt_state", "member_pin_audit", "member_pin_credentials", "member_pin_sessions"]);
    for (const row of tables) expect(row).toMatchObject({ anon: false, authenticated: false, service_role: false });
    const grants = await asPostgres(
      `select p.oid::regprocedure::text sig,
         has_function_privilege('anon', p.oid, 'EXECUTE') anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated,
         has_function_privilege('service_role', p.oid, 'EXECUTE') service_role
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'public' and p.proname in ('get_my_member_pin_status', 'set_my_member_pin', 'remove_my_member_pin',
         'verify_member_pin_signin', 'record_member_pin_failure', 'member_pin_signin_offered', 'mark_member_pin_session',
         'get_my_session_restriction', 'end_my_member_pin_sessions'))
         or (n.nspname = 'private' and p.proname like 'member_pin_%') order by 1`,
    );
    const bySig = Object.fromEntries(grants.map((row) => [row.sig, row]));
    for (const sig of ["get_my_member_pin_status()", "set_my_member_pin(text)", "remove_my_member_pin()",
      "get_my_session_restriction()", "end_my_member_pin_sessions()"]) {
      expect(bySig[sig]).toMatchObject({ anon: false, authenticated: true, service_role: false });
    }
    for (const sig of ["verify_member_pin_signin(text,text,text)", "record_member_pin_failure(text,text,text)", "member_pin_signin_offered()",
      "mark_member_pin_session(uuid,uuid)"]) {
      expect(bySig[sig]).toMatchObject({ anon: false, authenticated: false, service_role: true });
    }
    // RLS evaluates the restriction predicate as the querying role, exactly
    // like private.mfa_satisfied(); every other private helper stays closed.
    expect(bySig["private.member_pin_session_restricted()"]).toMatchObject({ anon: false, authenticated: true, service_role: false });
    for (const row of grants.filter((entry) => entry.sig.startsWith("private.") && entry.sig !== "private.member_pin_session_restricted()")) {
      expect(row, row.sig).toMatchObject({ anon: false, authenticated: false, service_role: false });
    }
  });

  it("starts off: nothing is offered and no member may set a PIN", async () => {
    // Isolate the deployment-wide capability from any other proof's rows; the
    // whole file runs in one transaction that is rolled back.
    await asPostgres("delete from public.organization_setting_values where setting_key = $1", [SWITCH]);
    await as("service_role");
    expect((await client.query("select public.member_pin_signin_offered() o")).rows[0].o).toBe(false);
    expect(await status("memberA")).toMatchObject({ available: false, reason: "disabled_by_organization", hasPin: false });
    expect(await setPin("memberA", PIN)).toMatchObject({ ok: false, code: "42501", message: "member-pin-unavailable" });
  });

  it("lets an eligible member set a PIN that is stored only as bcrypt and never returned", async () => {
    await enable("orgA", true);
    await as("service_role");
    expect((await client.query("select public.member_pin_signin_offered() o")).rows[0].o).toBe(true);
    expect(await status("memberA")).toMatchObject({ available: true, reason: null, hasPin: false, minimumLength: 6 });

    for (const [pin, message] of [["12345", "member-pin-format"], ["123456", "member-pin-trivial"], ["121212", "member-pin-trivial"],
      ["112233", "member-pin-trivial"], ["123321", "member-pin-trivial"], ["4071926x", "member-pin-format"]]) {
      expect(await setPin("memberA", pin), pin).toMatchObject({ ok: false, code: "22023", message });
    }
    await asPostgres("insert into private.member_sms_preferences (user_id, organization_id, phone_e164) values ($1, $2, '+15084071926')", [ids.memberA, ids.orgA]);
    expect(await setPin("memberA", "407192")).toMatchObject({ ok: false, code: "22023", message: "member-pin-matches-phone" });
    await asPostgres("update auth.users set phone = '16175550199' where id = $1", [ids.memberA]);
    expect(await setPin("memberA", "755501")).toMatchObject({ ok: false, code: "22023", message: "member-pin-matches-phone" });
    expect(await setPin("memberA", PIN, { amrAgeSeconds: 2 * 24 * 3600 }))
      .toMatchObject({ ok: false, code: "42501", message: "member-pin-reauthentication-required" });

    const saved = await setPin("memberA", PIN);
    expect(saved.ok).toBe(true);
    expect(Object.keys(saved.rows[0].r).sort()).toEqual(["hasPin", "setAt", "updatedAt"]);
    const [stored] = await asPostgres("select pin_hash from private.member_pin_credentials where user_id = $1", [ids.memberA]);
    expect(stored.pin_hash).toMatch(/^\$2a\$12\$/);
    expect(stored.pin_hash).not.toContain(PIN);
    const visible = JSON.stringify(await status("memberA"));
    expect(visible).not.toContain("$2a$");
    expect(visible).not.toContain(PIN);
    expect(await audit("memberA")).toEqual(["pin_set"]);
    const notices = await asPostgres("select title, body from public.member_notifications where user_id = $1 order by created_at", [ids.memberA]);
    expect(notices.map((row) => row.title)).toContain("A sign-in PIN was added to your account");
    expect(JSON.stringify(notices)).not.toContain(PIN);

    // Authenticated callers cannot read the table or call the verifier.
    await as("memberA");
    expect(await attempt("select * from private.member_pin_credentials")).toMatchObject({ ok: false, code: "42501" });
    expect(await attempt("select public.verify_member_pin_signin($1, $2, 'x')", [email("memberA"), PIN])).toMatchObject({ ok: false, code: "42501" });
  });

  it("signs a member in with the right PIN and refuses everything else flatly", async () => {
    expect(await verify("memberA", PIN)).toEqual({ ok: true, userId: ids.memberA, email: email("memberA") });
    expect(await verify(email("memberA").toUpperCase(), PIN)).toMatchObject({ ok: true, userId: ids.memberA });
    const wrong = await verify("memberA", "905126473");
    const unknown = await verify("nobody-pin@example.invalid", PIN);
    const noPin = await verify("memberA2", PIN);
    expect(wrong).toEqual({ ok: false, recordFailure: true });
    expect(unknown).toEqual(wrong);
    expect(noPin).toEqual(wrong);
  });

  it("locks an account after the organization's limit and doubles each repeat lockout", async () => {
    await asPostgres(
      `insert into public.organization_setting_values (organization_id, setting_key, value)
       values ($1, 'limits.security.member_pin_lockout_attempts', '3'::jsonb)`,
      [ids.orgA],
    );
    expect(await setPin("memberA2", PIN)).toMatchObject({ ok: true });
    for (let index = 0; index < 3; index += 1) expect((await verify("memberA2", "905126473")).ok).toBe(false);
    const [first] = await asPostgres(
      "select lockout_level, extract(epoch from locked_until - now())::int seconds from private.member_pin_attempt_state where user_id = $1",
      [ids.memberA2],
    );
    expect(first.lockout_level).toBe(1);
    expect(first.seconds).toBeGreaterThan(14 * 60);
    expect(first.seconds).toBeLessThanOrEqual(15 * 60);
    // The right PIN is refused while locked, with the same answer as a wrong one.
    expect(await verify("memberA2", PIN)).toEqual({ ok: false, recordFailure: true });
    expect((await status("memberA2")).lockedUntil).toBeTruthy();

    await asPostgres("update private.member_pin_attempt_state set locked_until = now() - interval '1 second' where user_id = $1", [ids.memberA2]);
    for (let index = 0; index < 3; index += 1) expect((await verify("memberA2", "905126473")).ok).toBe(false);
    const [second] = await asPostgres(
      "select lockout_level, extract(epoch from locked_until - now())::int seconds from private.member_pin_attempt_state where user_id = $1",
      [ids.memberA2],
    );
    expect(second.lockout_level).toBe(2);
    expect(second.seconds).toBeGreaterThan(29 * 60);
    expect(second.seconds).toBeLessThanOrEqual(30 * 60);
    expect(await audit("memberA2")).toEqual(["pin_set", "pin_locked_out", "pin_locked_out"]);

    await asPostgres("update private.member_pin_attempt_state set locked_until = now() - interval '1 second' where user_id = $1", [ids.memberA2]);
    expect((await verify("memberA2", PIN)).ok).toBe(true);
    const [cleared] = await asPostgres("select failed_attempts, lockout_level, locked_until from private.member_pin_attempt_state where user_id = $1", [ids.memberA2]);
    expect(cleared).toEqual({ failed_attempts: 0, lockout_level: 0, locked_until: null });
  });

  it("throttles one email address before any account decision, identically for unknown addresses", async () => {
    const target = "throttle-pin@example.invalid";
    for (let index = 0; index < 10; index += 1) expect(await verify(target, PIN)).toEqual({ ok: false, recordFailure: true });
    expect(await verify(target, PIN)).toEqual({ ok: false, recordFailure: false });
    for (let index = 0; index < 20; index += 1) await verify(`net-${index}-pin@example.invalid`, PIN, "ipv4:192.0.2.9");
    // The network bucket is spent, so even a correct PIN from it is refused.
    expect(await verify("memberA", PIN, "ipv4:192.0.2.9")).toEqual({ ok: false, recordFailure: false });
  });

  it("refuses an MFA-enrolled account even with the right PIN, and tells the member why", async () => {
    expect(await setPin("memberMfa", PIN)).toMatchObject({ ok: true });
    await asPostgres(
      "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'PIN proof', 'totp', 'verified', now(), now())",
      [randomUUID(), ids.memberMfa],
    );
    expect(await verify("memberMfa", PIN)).toEqual({ ok: false, recordFailure: true });
    expect(await status("memberMfa", { aal: "aal2" })).toMatchObject({ available: false, reason: "mfa_enrolled", hasPin: true });
    // A member who owes a second factor cannot even read or change PIN state.
    await as("memberMfa");
    expect(await attempt("select public.get_my_member_pin_status()")).toMatchObject({ ok: false, code: "42501" });
    expect(await setPin("memberMfa", OTHER_PIN)).toMatchObject({ ok: false, code: "42501" });
  });

  it("deletes the PIN the moment a member gains a staff role and refuses staff at sign-in", async () => {
    expect(await setPin("memberStaff", PIN)).toMatchObject({ ok: true });
    expect((await verify("memberStaff", PIN)).ok).toBe(true);
    await asPostgres("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'coordinator', $3)",
      [ids.orgA, ids.memberStaff, ids.stewardA]);
    expect(await asPostgres("select 1 from private.member_pin_credentials where user_id = $1", [ids.memberStaff])).toEqual([]);
    expect(await audit("memberStaff")).toEqual(["pin_set", "pin_disabled_staff_role"]);
    const notices = await asPostgres("select title from public.member_notifications where user_id = $1", [ids.memberStaff]);
    expect(notices.map((row) => row.title)).toContain("PIN sign-in was turned off for your account");
    expect(await verify("memberStaff", PIN)).toEqual({ ok: false, recordFailure: true });
    expect(await status("memberStaff")).toMatchObject({ available: false, reason: "staff_role", hasPin: false });
    expect(await setPin("memberStaff", PIN)).toMatchObject({ ok: false, message: "member-pin-unavailable" });

    // Defense in depth: even a credential that survived somehow is refused.
    await asPostgres("insert into private.member_pin_credentials (user_id, pin_hash) values ($1, extensions.crypt($2, extensions.gen_salt('bf', 12)))",
      [ids.stewardA, PIN]);
    expect(await verify("stewardA", PIN)).toEqual({ ok: false, recordFailure: true });

    // A legacy chapter-scope role grant also disables the PIN.
    expect(await setPin("memberRole", PIN)).toMatchObject({ ok: true });
    await asPostgres("insert into public.member_roles (user_id, role, chapter_id) values ($1, 'steward', $2)", [ids.memberRole, chapter.orgA]);
    expect(await asPostgres("select 1 from private.member_pin_credentials where user_id = $1", [ids.memberRole])).toEqual([]);
  });

  it("requires the switch in every organization the account belongs to", async () => {
    expect(await status("memberBoth")).toMatchObject({ available: false, reason: "disabled_by_organization" });
    expect(await setPin("memberBoth", PIN)).toMatchObject({ ok: false, message: "member-pin-unavailable" });
    await enable("orgB", true);
    expect(await setPin("memberBoth", PIN)).toMatchObject({ ok: true });
    expect((await verify("memberBoth", PIN)).ok).toBe(true);
    await enable("orgB", false);
    expect(await verify("memberBoth", PIN)).toEqual({ ok: false, recordFailure: true });
    // Organization A's member is unaffected by organization B's switch.
    expect((await verify("memberA", PIN)).ok).toBe(true);
    expect(await status("memberB")).toMatchObject({ available: false, reason: "disabled_by_organization", hasPin: false });
    await enable("orgA", false);
    expect(await verify("memberA", PIN)).toEqual({ ok: false, recordFailure: true });
    await enable("orgA", true);
  });

  it("records a refused PIN in the right organization's inbox without the email or PIN", async () => {
    await as("service_role");
    const [{ id }] = (await client.query("select public.record_member_pin_failure($1, 'native-ios', 'UG Test/1.0') id", [email("memberA")])).rows;
    expect(id).toBeTruthy();
    expect((await client.query("select public.record_member_pin_failure('nobody-pin@example.invalid', 'web-saas', 'x') id")).rows[0].id).toBeNull();
    expect(await attempt("select public.record_member_pin_failure($1, 'smoke-signal', 'x')", [email("memberA")])).toMatchObject({ ok: false, code: "22023" });
    const [row] = await asPostgres("select organization_id, member_user_id, method, source, identity_hash from public.organization_failed_login_attempts where id = $1", [id]);
    expect(row).toMatchObject({ organization_id: ids.orgA, member_user_id: ids.memberA, method: "pin", source: "native-ios" });
    expect(row.identity_hash).not.toContain("@");
    await as("stewardA");
    expect(await attempt("select public.record_member_pin_failure($1, 'web-saas', 'x')", [email("memberA")])).toMatchObject({ ok: false, code: "42501" });

    // BUG-UG-PIN-FAILURE-IDENTITY-TIMESTAMP-TIE-20261021: two live
    // accounts share an email (one SSO) with identical creation times and
    // different organizations. Verification and failure attribution must pick
    // the same one: the lower id, as the telemetry has since 20261021020656.
    await asPostgres("savepoint pin_tie");
    const [low, high] = [randomUUID(), randomUUID()].sort();
    const tied = `tie-${low.slice(0, 8)}@example.invalid`;
    // The higher id is inserted first, so a created_at-only order tends to find it first.
    for (const [id, org, sso] of [[high, "orgA", true], [low, "orgB", false]]) {
      await asPostgres("insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, created_at, is_sso_user) values ($1, $2, now(), '{}', now(), $3)", [id, tied, sso]);
      await asPostgres("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids[org], id]);
      await asPostgres("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [id, chapter[org]]);
      await asPostgres("update public.member_profiles set chapter_id = $2 where id = $1", [id, chapter[org]]);
    }
    expect((await asPostgres("select count(distinct created_at)::int n from auth.users where id = any($1::uuid[])", [[low, high]]))[0].n).toBe(1);
    await enable("orgB", true);
    await asPostgres("insert into private.member_pin_credentials (user_id, pin_hash) values ($1, extensions.crypt($2, extensions.gen_salt('bf', 12)))", [low, PIN]);
    expect(await verify(tied, PIN)).toEqual({ ok: true, userId: low, email: tied });
    await as("service_role");
    const [{ id: tiedFailure }] = (await client.query("select public.record_member_pin_failure($1, 'web-saas', 'x') id", [tied])).rows;
    const [logged] = await asPostgres("select organization_id, member_user_id from public.organization_failed_login_attempts where id = $1", [tiedFailure]);
    expect(logged).toEqual({ organization_id: ids.orgB, member_user_id: low });
    await asPostgres("rollback to savepoint pin_tie");
  });

  it("changes and removes a PIN, clearing its counters and auditing without the PIN", async () => {
    expect(await setPin("memberA", OTHER_PIN)).toMatchObject({ ok: true });
    expect((await verify("memberA", PIN)).ok).toBe(false);
    expect((await verify("memberA", OTHER_PIN)).ok).toBe(true);
    await as("memberA");
    expect((await client.query("select public.remove_my_member_pin() r")).rows[0].r).toEqual({ hasPin: false });
    expect(await asPostgres("select 1 from private.member_pin_attempt_state where user_id = $1", [ids.memberA])).toEqual([]);
    expect(await audit("memberA")).toEqual(["pin_set", "pin_changed", "pin_removed"]);
    expect(JSON.stringify(await asPostgres("select * from private.member_pin_audit"))).not.toMatch(/40719263|905126/);
    expect(await verify("memberA", OTHER_PIN)).toEqual({ ok: false, recordFailure: true });
    // Removing again is a harmless no-op.
    await as("memberA");
    expect((await client.query("select public.remove_my_member_pin() r")).rows[0].r).toEqual({ hasPin: false });
  });

  it("refuses a banned or deletion-pending account", async () => {
    expect(await setPin("memberBan", OTHER_PIN)).toMatchObject({ ok: true });
    await asPostgres("update auth.users set banned_until = now() + interval '1 day' where id = $1", [ids.memberBan]);
    expect(await verify("memberBan", OTHER_PIN)).toEqual({ ok: false, recordFailure: true });
    await asPostgres("update auth.users set banned_until = null where id = $1", [ids.memberBan]);
    expect((await verify("memberBan", OTHER_PIN)).ok).toBe(true);
    // The deletion ledger's guards read the subject's own claims.
    await as("memberBan");
    await asPostgres(
      `insert into private.member_account_deletions (subject_hash, token_hash, status, expires_at, subject_hash_key_fingerprint)
       select private.member_lifecycle_subject_hash($1), repeat('a', 64), 'authorized', now() + interval '1 hour',
         encode(extensions.digest(secret.secret, 'sha256'), 'hex')
       from private.member_account_lifecycle_secret secret where secret.id`,
      [ids.memberBan],
    );
    expect(await verify("memberBan", OTHER_PIN)).toEqual({ ok: false, recordFailure: true });
    expect(await status("memberBan")).toMatchObject({ available: false, reason: "account_unavailable" });
  });
});

// A PIN sign-in is a RESTRICTED session.
// api/auth-pin-signin.js marks the GoTrue session it mints; the database then
// refuses the surfaces the old app hid from PIN sessions, with 42501
// "step-up required", until the member signs in with a password or passkey.
const STEP_UP_TABLES = [
  "member_cases", "member_case_updates", "member_case_files", "member_case_contacts", "member_case_outcomes",
  "member_conversations", "member_messages", "member_scheduled_messages", "member_message_reminders", "member_message_resources",
  "member_steward_requests", "member_forms", "member_form_files", "member_form_cosigners", "member_intake_reports",
  "member_accommodation_requests",
];
const RESTRICT = "features.security.member_pin_restricted_sessions";

describe("restricted PIN sessions migration (offline)", () => {
  it("registers the restriction switch on by default, citing the old app", () => {
    expect(code).toMatch(/'features\.security\.member_pin_restricted_sessions', 'boolean'.*?'true', null, null, null, 215, 'security', true\)/);
    expect(sql).toContain("de7df4b57c^:lib/auth/auth-helpers.ts:136");
  });

  it("puts a restrictive policy and a statement trigger on every hidden table", () => {
    for (const table of STEP_UP_TABLES) {
      expect(code, table).toContain(`create policy member_pin_step_up on public.${table} as restrictive for all to authenticated using (not (select private.member_pin_session_restricted())) with check (not (select private.member_pin_session_restricted()));`);
      expect(code, table).toContain(`create trigger member_pin_step_up before insert or update or delete on public.${table} for each statement execute function private.member_pin_step_up_statement();`);
    }
  });

  it("keeps the mark off the case-graph lock and ends sessions only through the reviewed exclusive helper", () => {
    expect(codeOnly(fn("public.mark_member_pin_session").source)).not.toMatch(/lock_case_graph/);
    expect(codeOnly(fn("private.member_pin_end_sessions").source))
      .toMatch(/^\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\s+perform pg_catalog\.pg_advisory_xact_lock\(509, 701\);/);
    for (const name of ["public.end_my_member_pin_sessions", "public.set_my_member_pin", "public.remove_my_member_pin", "private.member_pin_revoke_for_staff"]) {
      expect(helperFirst(fn(name).source), name).toBe(true);
    }
    // An ordinary role grant never takes the exclusive Auth bookkeeping lock.
    expect(codeOnly(fn("private.member_pin_revoke_for_staff").source))
      .toMatch(/if exists \(select 1 from private\.member_pin_sessions m where m\.user_id = new\.user_id\) then\s+perform private\.member_pin_end_sessions/);
  });
});

live("restricted PIN sessions on a disposable database", () => {
  let client;
  let savepoint = 0;
  const people = ["pinner", "multi", "stewardR"];
  const sessions = ["pinSession", "pinSession2", "fullSession", "multiPin", "multiFull", "stewardSession", "oldSession"];
  const ids = Object.fromEntries([...people, ...sessions, "orgR", "orgS"].map((key) => [key, randomUUID()]));
  const owner = { pinSession: "pinner", pinSession2: "pinner", fullSession: "pinner", oldSession: "pinner",
    multiPin: "multi", multiFull: "multi", stewardSession: "stewardR" };
  const chapter = { orgR: `rst-r-${ids.orgR.slice(0, 8)}`, orgS: `rst-s-${ids.orgS.slice(0, 8)}` };
  const email = (name) => `${ids[name]}@example.invalid`;
  const homes = { pinner: ["orgR"], multi: ["orgR", "orgS"], stewardR: ["orgR"] };

  async function as(session, extra = {}) {
    await client.query("reset role");
    const claims = session === "service_role"
      ? { role: "service_role" }
      : { sub: ids[owner[session]], role: "authenticated", aal: "aal1", session_id: ids[session],
        amr: [{ method: /pin/i.test(session) ? "otp" : "password", timestamp: Math.floor(Date.now() / 1000) - 60 }],
        ...extra };
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query(`set local role ${session === "service_role" ? "service_role" : "authenticated"}`);
  }

  async function attempt(text, values = []) {
    const label = `rst_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    try {
      const { rows } = await client.query(text, values);
      await client.query(`release savepoint ${label}`);
      return { ok: true, rows, code: null, message: null };
    } catch (error) {
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
      return { ok: false, rows: [], code: error.code, message: error.message };
    }
  }

  // GoTrue writes auth tables in its own transaction and these checks are
  // deferred to its COMMIT. SET CONSTRAINTS ALL IMMEDIATE fires them at that
  // point inside this proof's savepoint, after the statements GoTrue runs.
  async function gotrue(statements) {
    await client.query("reset role");
    const label = `gotrue_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    try {
      for (const statement of statements) await client.query(statement);
      await client.query("set constraints all immediate");
      await client.query("set constraints all deferred");
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
      return { ok: true, code: null, message: null };
    } catch (error) {
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
      return { ok: false, code: error.code, message: error.message };
    }
  }

  async function asPostgres(text, values = []) {
    await client.query("reset role");
    return (await client.query(text, values)).rows;
  }

  async function mark(person, session) {
    await as("service_role");
    return (await client.query("select public.mark_member_pin_session($1, $2) m", [ids[person], ids[session]])).rows[0].m;
  }

  async function setting(org, key, value) {
    await asPostgres(
      `insert into public.organization_setting_values (organization_id, setting_key, value) values ($1, $2, $3::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [ids[org], key, JSON.stringify(value)],
    );
  }

  async function restriction(session, extra) {
    await as(session, extra);
    return (await client.query("select public.get_my_session_restriction() r")).rows[0].r;
  }

  async function count(session, table) {
    await as(session);
    return Number((await client.query(`select count(*)::int n from public.${table} where user_id = $1`, [ids[owner[session]]])).rows[0].n);
  }

  async function liveSession(session, createdAgo = "0 seconds") {
    await asPostgres(
      "insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now() - $3::interval, now() - $3::interval, 'aal1')",
      [ids[session], ids[owner[session]], createdAgo],
    );
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-pin-restricted-session-proof",
    });
    await client.connect();
    await client.query("begin");
    await releaseCalendarHolds(client);
    await client.query("set local statement_timeout = '120s'");
    await client.query("set local lock_timeout = '15s'");
    for (const person of people) {
      await client.query(
        `insert into auth.users (id, email, email_confirmed_at, encrypted_password, raw_user_meta_data, raw_app_meta_data, created_at)
         values ($1, $2, now(), extensions.crypt('proof-password-1', extensions.gen_salt('bf', 4)), '{}', '{"provider":"email","providers":["email"]}', now())`,
        [ids[person], email(person)],
      );
    }
    for (const session of sessions) await liveSession(session, session === "oldSession" ? "10 minutes" : "0 seconds");
    for (const org of ["orgR", "orgS"]) {
      await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [ids[org], chapter[org], ids.stewardR]);
      await client.query(
        "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9913)",
        [chapter[org], ids[org]],
      );
      await setting(org, "features.security.member_pin_signin", true);
    }
    for (const person of people) {
      for (const org of homes[person]) {
        await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids[org], ids[person]]);
        await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ids[person], chapter[org]]);
      }
      await client.query("update public.member_profiles set chapter_id = $2, full_name = $3 where id = $1", [ids[person], chapter[homes[person][0]], `Proof ${person}`]);
    }
    await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $2)", [ids.orgR, ids.stewardR]);
    // 20261006030000 refuses a steward message nobody could read; stewardR has
    // no second factor, so a second organization steward who has one reads it.
    const reader = randomUUID();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [reader, `${reader}@example.invalid`]);
    await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids.orgR, reader]);
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [reader, chapter.orgR]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [reader, chapter.orgR]);
    await client.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'totp', 'verified', now(), now())", [reader]);
    await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $2)", [ids.orgR, reader]);
    // The member's own record, created from a full session: a case and a
    // conversation with the chapter steward. Then a PIN, and one verified PIN
    // attempt, which is what opens the attempt-state row a mark needs.
    await as("fullSession");
    await client.query("select public.create_member_case('Proof grievance', null, 'Pay', '')");
    await client.query("select public.start_member_conversation('Proof message to my steward')");
    await client.query("select public.set_my_member_pin('40719263')");
    await as("multiFull");
    await client.query("select public.set_my_member_pin('40719263')");
    await as("service_role");
    for (const person of ["pinner", "multi"]) {
      const { rows } = await client.query("select public.verify_member_pin_signin($1, '40719263', 'ipv4:198.51.100.77') v", [email(person)]);
      if (rows[0].v.ok !== true) throw new Error(`PIN proof setup failed for ${person}`);
    }
    // Valid historical staff rows must not mask the PIN refusal.
    await migrateLegacyStewardFixtures(client);
  }, 120_000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("marks only a fresh session of a verified, eligible PIN account, and only for the service role", async () => {
    await as("fullSession");
    expect(await attempt("select public.mark_member_pin_session($1, $2)", [ids.pinner, ids.pinSession])).toMatchObject({ ok: false, code: "42501" });
    expect(await mark("pinner", "oldSession")).toBe(false);
    expect(await mark("pinner", "stewardSession")).toBe(false);
    expect(await mark("stewardR", "stewardSession")).toBe(false);
    await as("service_role");
    expect((await client.query("select public.mark_member_pin_session($1, $2) m", [ids.pinner, randomUUID()])).rows[0].m).toBe(false);
    expect(await mark("pinner", "pinSession")).toBe(true);
    expect(await mark("pinner", "pinSession2")).toBe(true);
    expect(await mark("multi", "multiPin")).toBe(true);
    expect(await asPostgres("select session_id from private.member_pin_sessions where user_id = $1 order by marked_at", [ids.pinner]))
      .toEqual([{ session_id: ids.pinSession }, { session_id: ids.pinSession2 }]);
  });

  it("tells each session whether it is restricted", async () => {
    expect(await restriction("pinSession")).toEqual({ restricted: true, pinSession: true });
    expect(await restriction("fullSession")).toEqual({ restricted: false, pinSession: false });
    await as("pinSession");
    expect((await client.query("select public.get_my_member_pin_status() s")).rows[0].s)
      .toMatchObject({ hasPin: true, sessionRestricted: true, otherPinSessions: 1 });
    await as("fullSession");
    expect((await client.query("select public.get_my_member_pin_status() s")).rows[0].s)
      .toMatchObject({ sessionRestricted: false, otherPinSessions: 2 });
  });

  it("hides cases and messages from a restricted session and refuses every write to the hidden tables", async () => {
    for (const table of ["member_cases", "member_conversations", "member_messages"]) {
      expect(await count("fullSession", table), table).toBeGreaterThan(0);
      expect(await count("pinSession", table), table).toBe(0);
    }
    // A SECURITY DEFINER RPC writes as the table owner with the caller's JWT
    // still in force; the statement trigger refuses it for a PIN session.
    for (const table of STEP_UP_TABLES) {
      await as("pinSession");
      await client.query("reset role");
      expect(await attempt(`delete from public.${table} where false`), table).toMatchObject({ ok: false, code: "42501", message: "step-up required" });
      await as("fullSession");
      await client.query("reset role");
      expect(await attempt(`delete from public.${table} where false`), table).toMatchObject({ ok: true });
    }
    const policies = await asPostgres(
      `select c.relname, p.polpermissive, p.polroles::regrole[]::text[] roles
       from pg_policy p join pg_class c on c.oid = p.polrelid
       where p.polname = 'member_pin_step_up' order by 1`,
    );
    expect(policies.map((row) => row.relname)).toEqual([...STEP_UP_TABLES, "member_guide_threads", "member_guide_messages"].sort());
    for (const row of policies) expect(row).toMatchObject({ polpermissive: false, roles: ["authenticated"] });
    // The case and form file buckets: their storage read predicates refuse a
    // restricted session even for an object it names directly.
    const [{ id: caseId }] = await asPostgres("select id from public.member_cases where user_id = $1 limit 1", [ids.pinner]);
    const objectName = `${ids.pinner}/${caseId}/${randomUUID()}.txt`;
    await asPostgres(
      `insert into public.member_case_files (case_id, user_id, bucket_id, object_name, filename, mime_type, size_bytes, confirmed_at)
       values ($1, $2, 'case-files', $3, 'proof.txt', 'text/plain', 5, now())`,
      [caseId, ids.pinner, objectName],
    );
    for (const [session, readable] of [["fullSession", true], ["pinSession", false]]) {
      await as(session);
      expect((await client.query("select private.can_read_member_case_object('case-files', $1) r", [objectName])).rows[0].r, session).toBe(readable);
    }
    await as("pinSession");
    expect((await client.query("select private.can_read_member_form_object('member-form-files', 'missing') r")).rows[0].r).toBe(false);
  });


  it.each([["get_member_home_takeover","()"],["get_member_message_actions","('private', $1)"],["get_member_message_replies","('private', $1, null)"],["get_member_message_reply_counts","('private', array[$1]::uuid[])"],["search_member_cases","('Proof', 20)"],["get_my_case_ulp_summary","()"],["get_form_filing_status","(null)"],["cosign_invite_preview","(null)"],["get_member_support_workspace","()"],["get_member_chapter_stewards","()"],["recommend_organization_coverage","($1)"],["list_member_event_contact_messages","(null)"],["list_contract_clause_grievance_counts","()"],["casework_get_case_procedure","($1)"],["list_share_case_destinations","(100)"],["get_my_steward_contact_visibility","()"],["sensitive_case_upload_target","(null)"],["authorize_private_upload_inspection","('case', null)"]])('refuses restricted PIN content through %s and preserves the full-session result', async (name, args) => {
    const caseId = (await asPostgres('select id from public.member_cases where user_id=$1 limit 1', [ids.pinner]))[0].id;
    const messageId = (await asPostgres('select id from public.member_messages where user_id=$1 limit 1', [ids.pinner]))[0].id;
    const values = args.includes('$1') ? [name === 'recommend_organization_coverage' ? chapter.orgR : name === 'casework_get_case_procedure' ? caseId : messageId] : [];
    const query = 'select public.' + name + args + ' as v';
    await as('fullSession');
    const before = await attempt(query, values);
    expect(before.message).not.toBe('step-up required');
    await as('pinSession');
    expect(await attempt(query, values)).toMatchObject({ok:false,code:'42501',message:'step-up required'});
    await as('fullSession');
    expect(await attempt(query, values)).toEqual(before);
  });

  it('refuses case-child ownership and assistant history while preserving a full session', async () => {
    const caseId = (await asPostgres('select id from public.member_cases where user_id=$1 limit 1',[ids.pinner]))[0].id;
    await as('fullSession');
    expect((await client.query('select private.casework_can_read($1) as v',[caseId])).rows[0].v).toBe(true);
    await client.query("select public.save_member_guide_exchange(null, 'Proof question', 'Private answer', '[]')");
    for(const table of ['member_guide_threads','member_guide_messages'])expect(await count('fullSession',table)).toBeGreaterThan(0);
    await as('pinSession');
    expect((await client.query('select private.casework_can_read($1) as v',[caseId])).rows[0].v).toBe(false);
    for(const table of ['member_guide_threads','member_guide_messages'])expect(await count('pinSession',table)).toBe(0);
    await as('pinSession');
    expect(await attempt("select public.save_member_guide_exchange(null,'Question','Answer','[]')")).toMatchObject({ok:false,code:'42501',message:'step-up required'});
  });

  it("refuses the definer RPCs behind cases, messages, the export, devices, the calendar feed and a new PIN", async () => {
    const [{ id: conversationId }] = await asPostgres("select id from public.member_conversations where user_id = $1 limit 1", [ids.pinner]);
    const conversation = "$1::uuid";
    const refused = [
      ["select public.create_member_case('From a PIN', null, 'Pay', '')"],
      [`select public.send_member_message(${conversation}, 'From a PIN')`, [conversationId]],
      ["select public.get_member_data_export()"],
      ["select public.list_my_sessions()"],
      ["select public.rotate_calendar_feed_token()"],
      ["select public.set_my_member_pin('905126')"],
      ["select public.end_my_member_pin_sessions()"],
    ];
    for (const [text, values = []] of refused) {
      await as("pinSession");
      expect(await attempt(text, values), text).toMatchObject({ ok: false, code: "42501", message: "step-up required" });
    }
    // The filing-copy probe answers false, so the route gives its flat 404.
    const [{ id: formProbe }] = await asPostgres("select gen_random_uuid() id");
    await as("pinSession");
    expect(await attempt("select public.can_access_form_filing($1) allowed", [formProbe])).toMatchObject({ ok: true, rows: [{ allowed: false }] });
    expect(await asPostgres("select pg_get_functiondef('public.can_access_form_filing(uuid)'::regprocedure) ~ 'not private.member_pin_session_restricted\\(\\)' pinned"))
      .toEqual([{ pinned: true }]);
    // Account deletion already demands an aal2 session with a second factor.
    await as("pinSession");
    expect(await attempt("select public.authorize_member_account_deletion('DELETE MY ACCOUNT')")).toMatchObject({ ok: false, code: "42501" });
    // The same member on a full session is served.
    for (const [text, values = []] of [["select public.get_member_data_export()"], ["select public.list_my_sessions()"],
      ["select public.rotate_calendar_feed_token()"], [`select public.send_member_message(${conversation}, 'From a full session')`, [conversationId]]]) {
      await as("fullSession");
      expect(await attempt(text, values), text).toMatchObject({ ok: true });
    }
    // Everything else a member does keeps working on the PIN session.
    await as("pinSession");
    expect(await attempt("select public.get_my_member_pin_status()")).toMatchObject({ ok: true });
    expect(await attempt("select count(*) from public.member_notifications where user_id = $1", [ids.pinner])).toMatchObject({ ok: true });
  });

  it("cannot be spoofed: the mark keys on the signed session id, not on claims a client controls", async () => {
    await as("pinSession");
    expect(await attempt("delete from private.member_pin_sessions")).toMatchObject({ ok: false, code: "42501" });
    expect(await attempt("insert into private.member_pin_sessions (session_id, user_id) values ($1, $2)", [randomUUID(), ids.pinner]))
      .toMatchObject({ ok: false, code: "42501" });
    expect(await attempt("select private.member_pin_end_sessions($1, null)", [ids.pinner])).toMatchObject({ ok: false, code: "42501" });
    // Claiming a password sign-in or an app_metadata auth method changes
    // nothing for the PIN session's own session id.
    for (const extra of [
      { amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }] },
      { app_metadata: { auth_method: "password", provider: "email" }, user_metadata: { auth_method: "passkey" } },
      // Assurance claims change nothing either: the restriction keys on the
      // session id, so even an aal2 claim stays restricted.
      { aal: "aal2", amr: [{ method: "passkey", timestamp: Math.floor(Date.now() / 1000) }] },
    ]) {
      expect(await restriction("pinSession", extra)).toMatchObject({ restricted: true });
    }
    // A forged key-assurance claim  is worse than useless: with no live
    // verified-key registry row for this session, private.mfa_satisfied()
    // refuses the session outright, so a PIN session never reaches MFA that way.
    await as("pinSession", { aal: "aal2", ug_key_uv: true, amr: [{ method: "passkey", timestamp: Math.floor(Date.now() / 1000) }] });
    expect(await attempt("select public.get_my_session_restriction()")).toMatchObject({ ok: false, code: "42501" });
    // A session id with no live Auth session is refused outright.
    await as("pinSession", { session_id: randomUUID() });
    expect(await attempt("select public.get_my_session_restriction()")).toMatchObject({ ok: false, code: "42501" });
  });

  it("follows the organization switch, and the strictest organization wins", async () => {
    await setting("orgR", RESTRICT, false);
    expect(await restriction("pinSession")).toMatchObject({ restricted: false, pinSession: true });
    expect(await count("pinSession", "member_cases")).toBeGreaterThan(0);
    // multi belongs to orgR (now off) and orgS (default on): still restricted.
    expect(await restriction("multiPin")).toMatchObject({ restricted: true });
    await setting("orgS", RESTRICT, false);
    expect(await restriction("multiPin")).toMatchObject({ restricted: false });
    await setting("orgR", RESTRICT, true);
    await setting("orgS", RESTRICT, true);
    expect(await restriction("pinSession")).toMatchObject({ restricted: true });
    expect(await count("pinSession", "member_cases")).toBe(0);
  });

  it("refuses account security changes GoTrue makes while a PIN session is live", async () => {
    const password = `update auth.users set encrypted_password = extensions.crypt('changed-password-2', extensions.gen_salt('bf', 4)) where id = '${ids.pinner}'`;
    // From the PIN session: GoTrue signs out every OTHER session, and the PIN session remains.
    expect(await gotrue([`delete from auth.sessions where user_id = '${ids.pinner}' and id <> '${ids.pinSession}'`, password]))
      .toMatchObject({ ok: false, code: "42501", message: "step-up required" });
    // From a full session: the PIN sessions go with the other sessions, so it passes.
    expect(await gotrue([`delete from auth.sessions where user_id = '${ids.pinner}' and id <> '${ids.fullSession}'`, password]))
      .toMatchObject({ ok: true });
    for (const statement of [
      `update auth.users set email_change = 'new-${ids.pinner}@example.invalid' where id = '${ids.pinner}'`,
      `update auth.users set phone_change = '15085550111' where id = '${ids.pinner}'`,
      `update auth.users set raw_app_meta_data = jsonb_set(raw_app_meta_data, '{providers}', '["email","google"]') where id = '${ids.pinner}'`,
      `insert into auth.webauthn_credentials (user_id, credential_id, public_key, attestation_type, sign_count, transports, backup_eligible, backed_up, friendly_name, created_at, updated_at)
       values ('${ids.pinner}', '\\x01', '\\x02', 'none', 0, '[]', false, false, 'Proof key', now(), now())`,
    ]) {
      expect(await gotrue([statement]), statement).toMatchObject({ ok: false, code: "42501", message: "step-up required" });
    }
    // A PIN session at aal2 means it verified a factor itself: refused. A full
    // session verifying its own factor passes even with a PIN session live.
    const factor = `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      values ('${randomUUID()}', '${ids.pinner}', 'Proof', 'totp', 'verified', now(), now())`;
    expect(await gotrue([`update auth.sessions set aal = 'aal2' where id = '${ids.pinSession}'`, factor])).toMatchObject({ ok: false, code: "42501" });
    expect(await gotrue([`update auth.sessions set aal = 'aal2' where id = '${ids.fullSession}'`, factor])).toMatchObject({ ok: true });
    // An idle PIN session (past the inactivity window) no longer blocks.
    expect(await gotrue([
      `update auth.sessions set created_at = now() - interval '10 hours', updated_at = now() - interval '10 hours', refreshed_at = null where id in ('${ids.pinSession}', '${ids.pinSession2}')`,
      `update auth.users set email_change = 'idle-${ids.pinner}@example.invalid' where id = '${ids.pinner}'`,
    ])).toMatchObject({ ok: true });
    // With the restriction off, a PIN session is a full session here too.
    await setting("orgR", RESTRICT, false);
    expect(await gotrue([`update auth.users set email_change = 'off-${ids.pinner}@example.invalid' where id = '${ids.pinner}'`])).toMatchObject({ ok: true });
    await setting("orgR", RESTRICT, true);
  });

  it("ends PIN sessions after a step-up, on removal, on a PIN change and when a staff role arrives", async () => {
    // A full session ends every PIN session of the account (the step-up path).
    await as("fullSession");
    expect((await client.query("select public.end_my_member_pin_sessions() r")).rows[0].r).toEqual({ ended: true });
    expect(await asPostgres("select id from auth.sessions where id in ($1, $2)", [ids.pinSession, ids.pinSession2])).toEqual([]);
    expect(await asPostgres("select 1 from private.member_pin_sessions where user_id = $1", [ids.pinner])).toEqual([]);
    // Its leftover access tokens reach nothing: the Auth session is gone.
    await as("pinSession");
    expect(await attempt("select public.get_my_session_restriction()")).toMatchObject({ ok: false, code: "42501" });
    expect(await count("pinSession", "member_cases")).toBe(0);

    // Removing the PIN from a PIN session keeps that session (still
    // restricted) and ends the account's other PIN sessions.
    await liveSession("pinSession");
    await liveSession("pinSession2");
    expect(await mark("pinner", "pinSession")).toBe(true);
    expect(await mark("pinner", "pinSession2")).toBe(true);
    await as("pinSession");
    expect((await client.query("select public.remove_my_member_pin() r")).rows[0].r).toEqual({ hasPin: false });
    expect(await asPostgres("select id from auth.sessions where id in ($1, $2)", [ids.pinSession, ids.pinSession2])).toEqual([{ id: ids.pinSession }]);
    expect(await restriction("pinSession")).toMatchObject({ restricted: true });

    // Setting a PIN again from a full session ends every PIN session.
    await as("fullSession");
    await client.query("select public.set_my_member_pin('40719263')");
    expect(await asPostgres("select id from auth.sessions where id = $1", [ids.pinSession])).toEqual([]);

    // A staff role ends the multi-organization member's PIN session, so no
    // staff-capable call can ride on it.
    expect(await restriction("multiPin")).toMatchObject({ restricted: true });
    await asPostgres("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $3)",
      [ids.orgR, ids.multi, ids.stewardR]);
    expect(await asPostgres("select id from auth.sessions where id = $1", [ids.multiPin])).toEqual([]);
    await as("multiPin");
    expect((await client.query("select public.member_has_role(array['steward']) r")).rows[0].r).toBe(false);
    expect(await attempt("select public.get_my_session_restriction()")).toMatchObject({ ok: false, code: "42501" });
    // The same member's full session is untouched.
    expect(await restriction("multiFull")).toEqual({ restricted: false, pinSession: false });
  });
});
