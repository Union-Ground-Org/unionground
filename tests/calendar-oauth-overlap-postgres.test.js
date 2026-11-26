// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/calendar-oauth.js";
import { hashOAuthBrowserBinding } from "../api/_lib/calendarOAuth.js";
import { startCalendarOAuth } from "../src/lib/calendarOAuthClient.js";
import { SHELL_LOAD_DEADLINE_MS } from "../src/lib/loadDeadline.js";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const original = readFileSync(new URL("../supabase/migrations/20260828073000_mi1_calendar_freebusy_oauth.sql", import.meta.url), "utf8");
const repair = readFileSync(new URL("../supabase/migrations/20261021020116_calendar_oauth_independent_pending_states.sql", import.meta.url), "utf8");
const appointments = readFileSync(new URL("../supabase/migrations/20260801120000_steward_appointments.sql", import.meta.url), "utf8");
const removal = readFileSync(new URL("../supabase/migrations/20260925080300_calendar_sync_steward_grant_scope.sql", import.meta.url), "utf8");
const steward = "11111111-1111-4111-8111-111111111111";
const saveSignature = "public.save_calendar_oauth_state(text,uuid,text,text,text,text,timestamp with time zone)";
const authorizeSignature = "public.authorize_calendar_oauth_start(text)";
const contracts = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8")).functions;
const contract = contracts.find((entry) => entry.sig.startsWith("public.save_calendar_oauth_state("));
const reply = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) });

describe.skipIf(!postgresBin)("calendar OAuth timeout and overlapping server starts", () => {
  let db;
  beforeAll(async () => {
    db = await offlinePostgres({ durable: false });
    await db.client.query(`
      create schema private; create schema auth;
      create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      create function private.mfa_satisfied() returns boolean language sql stable as
        $$ select coalesce(nullif(current_setting('test.calendar_mfa',true),''),'true')::boolean $$;
      create function public.member_has_role(text[]) returns boolean language sql stable as
        $$ select coalesce(nullif(current_setting('test.calendar_steward',true),''),'true')::boolean $$;
      create function private.lock_case_graph(uuid[],uuid[]) returns void language sql set search_path = '' as
        $$ select pg_catalog.pg_advisory_xact_lock(509,700) $$;
      create table public.member_calendar_connections (
        id uuid default gen_random_uuid(), steward_id uuid, provider text,
        status text default 'pending', updated_at timestamptz default now(), unique(steward_id,provider));
      create table public.member_calendar_busy (steward_id uuid, provider text);
      create table public.member_calendar_import_events (steward_id uuid, provider text);
      insert into auth.users values ('${steward}');
    `);
    await db.client.query(appointments.slice(appointments.indexOf("create function public.request_calendar_connection"), appointments.indexOf("create function public.remove_calendar_connection")));
    await db.client.query(original.slice(0, original.indexOf("create function public.upsert_steward_calendar_oauth_token")));
    await db.client.query(`revoke all on function ${saveSignature} from public, anon, authenticated;
      grant execute on function ${saveSignature} to service_role;`);
    await db.client.query(repair);
    await db.client.query(removal.slice(removal.indexOf("create or replace function public.remove_calendar_connection"), removal.indexOf("notify pgrst")));
    await db.client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false)");
  }, 120000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.client.query("truncate private.calendar_oauth_states, public.member_calendar_connections");
    await db.client.query("insert into public.member_calendar_connections(steward_id,provider) values ($1,'google')", [steward]);
  });
  afterEach(async () => {
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await db.client.query("reset role; select set_config('test.calendar_mfa','true',false), set_config('test.calendar_steward','true',false), set_config('request.jwt.claims','{\"role\":\"service_role\"}',false)");
  });

  const save = async (body) => (await db.client.query(`select ${saveSignature.split("(")[0]}($1,$2,$3,$4,$5,$6,$7) value`, [
    body.p_state, body.p_steward, body.p_provider, body.p_code_verifier,
    body.p_redirect_uri, body.p_browser_binding_hash, body.p_expires_at,
  ])).rows[0].value;
  const consume = async (state, binding) => (await db.client.query(
    "select public.consume_calendar_oauth_state($1,$2) value", [state, binding])).rows[0].value;
  const memberCall = async (name, provider, subject = steward) => {
    await db.client.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: "authenticated", sub: subject })]);
    try {
      return (await db.client.query(`select public.${name}($1) value`, [provider])).rows[0].value;
    } finally {
      await db.client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false)");
    }
  };

  it.each(["pending", "active", "revoked"])("authorizes only the existing %s connection and preserves reconnect behavior", async (status) => {
    const { rows: [before] } = await db.client.query("update public.member_calendar_connections set status=$1 returning id", [status]);
    await expect(memberCall("authorize_calendar_oauth_start", "google")).resolves.toEqual({
      id: before.id, provider: "google", status: status === "revoked" ? "pending" : status,
    });
    expect((await db.client.query("select id from public.member_calendar_connections")).rows).toEqual([{ id: before.id }]);
  });

  it("refuses absent, foreign and unauthenticated intent and preserves MFA and steward checks", async () => {
    for (const provider of [null, "other", "microsoft"]) {
      await expect(memberCall("authorize_calendar_oauth_start", provider)).rejects.toMatchObject({ code: "22023" });
    }
    await expect(memberCall("authorize_calendar_oauth_start", "google", null)).rejects.toMatchObject({ code: "42501" });
    await expect(memberCall("authorize_calendar_oauth_start", "google", "22222222-2222-4222-8222-222222222222")).rejects.toMatchObject({ code: "22023" });
    await db.client.query("select set_config('test.calendar_mfa','false',false)");
    await expect(memberCall("authorize_calendar_oauth_start", "google")).rejects.toMatchObject({ code: "42501" });
    await db.client.query("select set_config('test.calendar_mfa','true',false), set_config('test.calendar_steward','false',false)");
    await expect(memberCall("authorize_calendar_oauth_start", "google")).rejects.toMatchObject({ code: "42501" });
    expect((await db.client.query("select count(*)::int n from public.member_calendar_connections")).rows[0].n).toBe(1);
  });

  it("installs the existing-only RPC with scoped grants, an empty search path and lifecycle locking", async () => {
    const { rows: [access] } = await db.client.query(`select
      has_function_privilege('anon',$1,'EXECUTE') anon,
      has_function_privilege('authenticated',$1,'EXECUTE') member,
      has_function_privilege('service_role',$1,'EXECUTE') service`, [authorizeSignature]);
    expect(access).toEqual({ anon: false, member: true, service: true });
    const { rows: [installed] } = await db.client.query("select prosecdef, proconfig, lower(prosrc) body from pg_proc where oid=$1::regprocedure", [authorizeSignature]);
    expect(installed.prosecdef).toBe(true);
    expect(installed.proconfig).toEqual(['search_path=""']);
    const pin = contracts.find((entry) => entry.sig.startsWith("public.authorize_calendar_oauth_start("));
    for (const needle of pin.bodyContains) expect(installed.body).toContain(needle.toLowerCase());
    for (const needle of pin.bodyForbids) expect(installed.body).not.toContain(needle.toLowerCase());
    await db.client.query("set role anon");
    await expect(db.client.query("select public.authorize_calendar_oauth_start('google')")).rejects.toMatchObject({ code: "42501" });
  });

  it.each(["retry", "Remove"])("keeps a newer %s effective when a timed-out start finishes afterward", async (action) => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "chapter.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "chapter-secret-value-16");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    let releaseOldIntent;
    let intentEntered;
    const entered = new Promise((resolve) => { intentEntered = resolve; });
    const heldIntent = new Promise((resolve) => { releaseOldIntent = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/auth/v1/user")) return reply({ id: steward });
      if (/\/(?:request_calendar_connection|authorize_calendar_oauth_start)$/.test(String(url))) {
        if (init.headers.Authorization === "Bearer old-token") { intentEntered(); await heldIntent; }
        try {
          return reply(await memberCall(String(url).split("/").at(-1), "google"));
        } catch (error) {
          return reply({ message: error.message, code: error.code }, error.code === "42501" ? 403 : 400);
        }
      }
      if (String(url).endsWith("/save_calendar_oauth_state")) return reply(await save(JSON.parse(init.body)));
      throw new Error(`Unexpected request: ${url}`);
    }));
    const serverRuns = [];
    const replies = [];
    const fetcher = (_url, init) => new Promise((resolve, reject) => {
      const response = {
        headers: {}, statusCode: 0, body: "",
        status(code) { this.statusCode = code; return this; },
        setHeader(key, value) { this.headers[key] = value; },
        end(body) { this.body = body; },
      };
      replies.push(response);
      const onAbort = () => reject(init.signal.reason);
      init.signal.addEventListener("abort", onAbort, { once: true });
      const run = handler({ method: "POST", headers: { authorization: init.headers.Authorization, host: PORTAL_HOST }, body: init.body }, response)
        .then(() => {
          init.signal.removeEventListener("abort", onAbort);
          if (!init.signal.aborted) resolve({ ok: response.statusCode === 200, status: response.statusCode, json: async () => JSON.parse(response.body) });
        }, reject);
      serverRuns.push(run);
    });
    const client = (token) => ({ auth: { getSession: async () => ({ data: { session: { access_token: token } } }) } });
    vi.useFakeTimers();
    const abandoned = startCalendarOAuth(client("old-token"), "google", fetcher).catch((error) => error);
    await entered;
    await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS);
    expect(await abandoned).toMatchObject({ name: "TimeoutError" });
    const retry = action === "retry" ? await startCalendarOAuth(client("new-token"), "google", fetcher) : null;
    if (retry) expect(retry.ok).toBe(true);
    else {
      await memberCall("remove_calendar_connection", "google");
      expect((await db.client.query("select count(*)::int n from public.member_calendar_connections")).rows[0].n).toBe(0);
    }
    releaseOldIntent();
    await Promise.all(serverRuns);
    if (!retry) {
      expect((await db.client.query("select count(*)::int n from public.member_calendar_connections")).rows[0].n).toBe(0);
      expect(replies[0].statusCode).toBe(503);
      expect(replies[0].headers["Set-Cookie"]).toBeUndefined();
      expect((await db.client.query("select count(*)::int n from private.calendar_oauth_states")).rows[0].n).toBe(0);
      return;
    }
    const retryState = new URL(retry.authorizationUrl).searchParams.get("state");
    const binding = replies[1].headers["Set-Cookie"].match(/^calendar_oauth_binding_google=([^;]+)/)[1];
    await expect(consume(retryState, hashOAuthBrowserBinding(binding))).resolves.toMatchObject({ stewardId: steward, provider: "google" });
    await expect(consume(retryState, hashOAuthBrowserBinding(binding))).rejects.toThrow("state unavailable");
  });

  it("keeps expiry cleanup, browser binding and service-only execution", async () => {
    const body = { p_state: "s".repeat(32), p_steward: steward, p_provider: "google", p_code_verifier: "v".repeat(43), p_redirect_uri: `${PORTAL_ORIGIN}/api/calendar-oauth`, p_browser_binding_hash: "h".repeat(43), p_expires_at: new Date(Date.now() + 600000) };
    await save({ ...body, p_state: "e".repeat(32), p_expires_at: new Date(Date.now() - 1000) });
    await save(body);
    expect((await db.client.query("select count(*)::int n from private.calendar_oauth_states")).rows[0].n).toBe(1);
    await expect(consume(body.p_state, "x".repeat(43))).rejects.toThrow("state unavailable");
    await expect(consume(body.p_state, body.p_browser_binding_hash)).resolves.toMatchObject({ stewardId: steward });
    const { rows: [access] } = await db.client.query(`select
      has_function_privilege('anon',$1,'EXECUTE') anon,
      has_function_privilege('authenticated',$1,'EXECUTE') member,
      has_function_privilege('service_role',$1,'EXECUTE') service`, [saveSignature]);
    expect(access).toEqual({ anon: false, member: false, service: true });
    const { rows: [installed] } = await db.client.query("select prosecdef, proconfig, lower(prosrc) body from pg_proc where oid=$1::regprocedure", [saveSignature]);
    expect(installed.prosecdef).toBe(true);
    expect(installed.proconfig).toEqual(['search_path=""']);
    for (const needle of contract.bodyContains) expect(installed.body).toContain(needle.toLowerCase());
    for (const needle of contract.bodyForbids) expect(installed.body).not.toContain(needle.toLowerCase());
    await db.client.query("select set_config('request.jwt.claims','{\"role\":\"authenticated\"}',false)");
    await expect(save(body)).rejects.toMatchObject({ code: "42501" });
    await db.client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false)");
  });
});
