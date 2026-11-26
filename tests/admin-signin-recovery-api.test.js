// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/admin-signin-recovery.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SUPABASE = "https://project.supabase.co";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const OPERATION_ID = "20000000-0000-4000-8000-000000000002";
const OTHER_OPERATION_ID = "30000000-0000-4000-8000-000000000003";
const RECOVERY_LOCK_KEY = "member_signin_recovery_operation_id";

function authUser(email, { banned = false, lock = null } = {}) {
  return {
    id: USER_ID,
    email,
    banned_until: banned ? "2126-08-13T00:00:00.000Z" : null,
    app_metadata: lock ? { [RECOVERY_LOCK_KEY]: lock } : {},
  };
}

function upstream(payload, status = 200) {
  const body = payload === null ? "" : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

function recorder() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(body) { out.body = JSON.parse(body); },
  };
}

function request(body, token = "admin-token") {
  return { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body };
}

async function run(req) {
  const res = recorder();
  await handler(req, res);
  return res.out;
}

const valid = {
  userId: USER_ID,
  newEmail: " New.Inbox@Example.com ",
  reason: "lost_inbox",
  identityVerified: true,
};

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("admin sign-in recovery endpoint", () => {
  it("rejects method, token, invalid input and missing identity attestation before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run({ method: "GET", headers: {}, body: {} })).status).toBe(405);
    expect((await run(request(valid, null))).status).toBe(403);
    expect((await run(request({ ...valid, identityVerified: false }))).status).toBe(400);
    expect((await run(request({ ...valid, newEmail: "not-email" }))).status).toBe(400);
    expect((await run(request({ ...valid, reason: "free text" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102.
  it("refuses a government replacement address with email-domain-blocked before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await run(request({ ...valid, newEmail: "member@city.gov" })))
      .toMatchObject({ status: 400, body: { error: "email-domain-blocked" } });
    expect(await run(request({ ...valid, newEmail: "member@ci.boston.ma.us" })))
      .toMatchObject({ status: 400, body: { error: "email-domain-blocked" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("holds a provider ban across the address change, revokes sessions, then releases it before finalize", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const call = { url: String(url), method: init.method || "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      if (call.url.includes("begin_member_signin_recovery")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID, retry: false });
      if (call.url === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && call.method === "GET") return upstream({ id: USER_ID, email: "old@example.com" });
      if (call.url === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && call.method === "PUT" && call.body?.ban_duration === "876000h") {
        return upstream(authUser("old@example.com", { banned: true, lock: OPERATION_ID }));
      }
      if (call.url === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && call.method === "PUT" && call.body?.email) {
        return upstream(authUser("new.inbox@example.com", { banned: true, lock: OPERATION_ID }));
      }
      if (call.url === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && call.method === "PUT" && call.body?.ban_duration === "none") {
        return upstream(authUser("new.inbox@example.com"));
      }
      if (call.url === `${SUPABASE}/rest/v1/rpc/end_member_auth_sessions`) return upstream({ ended: true });
      if (call.url.includes("finalize_member_signin_recovery")) return upstream({ completed: true, operationId: OPERATION_ID });
      throw new Error(`unexpected ${call.method} ${call.url}`);
    }));

    const out = await run(request(valid));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ completed: true });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${SUPABASE}/rest/v1/rpc/begin_member_signin_recovery`],
      ["GET", `${SUPABASE}/auth/v1/admin/users/${USER_ID}`],
      ["PUT", `${SUPABASE}/auth/v1/admin/users/${USER_ID}`],
      ["POST", `${SUPABASE}/rest/v1/rpc/end_member_auth_sessions`],
      ["PUT", `${SUPABASE}/auth/v1/admin/users/${USER_ID}`],
      ["POST", `${SUPABASE}/rest/v1/rpc/end_member_auth_sessions`],
      ["PUT", `${SUPABASE}/auth/v1/admin/users/${USER_ID}`],
      ["POST", `${SUPABASE}/rest/v1/rpc/finalize_member_signin_recovery`],
    ]);
    expect(calls[0].headers).toMatchObject({ apikey: "publishable-key", Authorization: "Bearer admin-token" });
    expect(calls[0].body).toMatchObject({ p_target_user: USER_ID, p_reason: "lost_inbox" });
    expect(calls[0].body.p_new_email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(calls[0])).not.toContain("new.inbox@example.com");
    expect(calls[2].body).toEqual({
      ban_duration: "876000h",
      app_metadata: { [RECOVERY_LOCK_KEY]: OPERATION_ID },
    });
    expect(calls[4].body).toEqual({ email: "new.inbox@example.com", email_confirm: true });
    expect(calls[6].body).toEqual({
      ban_duration: "none",
      app_metadata: { [RECOVERY_LOCK_KEY]: null },
    });
    expect(calls[4].headers).toMatchObject({ apikey: "server-secret-key" });
    expect(calls[7].body).toEqual({ p_operation_id: OPERATION_ID, p_sessions_revoked: true });
    expect(JSON.stringify(out)).not.toMatch(/example\.com|operation/i);
  });

  it("recovers an ambiguous already-applied update without updating twice", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET" });
      if (String(url).includes("begin_member_signin_recovery")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID, retry: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}`) return upstream({ id: USER_ID, email: "NEW.INBOX@example.com" });
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ ended: true });
      if (String(url).includes("finalize_member_signin_recovery")) return upstream({ completed: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect((await run(request(valid))).status).toBe(200);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("flattens caller/MFA/chapter denials before service-role access", async () => {
    const fetchMock = vi.fn(async () => upstream({ message: "foreign target private detail" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request(valid));
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: "not-permitted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(out)).not.toContain("foreign target");
  });

  it("closes a definite address rejection with a generic failure and no address echo", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("begin_member_signin_recovery")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") return upstream({ id: USER_ID, email: "old@example.com" });
      const body = init.body ? JSON.parse(init.body) : null;
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.ban_duration === "876000h") {
        return upstream(authUser("old@example.com", { banned: true, lock: OPERATION_ID }));
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ ended: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.email) {
        return upstream({ message: "email new.inbox@example.com already exists" }, 422);
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.ban_duration === "none") {
        return upstream(authUser("old@example.com"));
      }
      if (String(url).includes("fail_member_signin_recovery")) return upstream({ completed: false });
      throw new Error(`unexpected ${url}`);
    }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await run(request(valid));
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ error: "recovery-unavailable" });
    expect(calls.at(-1).body).toEqual({ p_operation_id: OPERATION_ID, p_failure_code: "address_unavailable" });
    expect(JSON.stringify(out)).not.toContain("example.com");
    expect(logged).not.toHaveBeenCalled();
  });

  it("keeps the recovery ban when post-update logout fails and never falsely finalizes", async () => {
    const calls = [];
    let logoutCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push(String(url));
      if (String(url).includes("begin_member_signin_recovery")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") return upstream({ id: USER_ID, email: "old@example.com" });
      const body = init.body ? JSON.parse(init.body) : null;
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.ban_duration === "876000h") {
        return upstream(authUser("old@example.com", { banned: true, lock: OPERATION_ID }));
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.email) {
        return upstream(authUser("new.inbox@example.com", { banned: true, lock: OPERATION_ID }));
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.ban_duration === "none") {
        throw new Error("must not release recovery ban after failed logout");
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) {
        logoutCalls += 1;
        return logoutCalls === 1 ? upstream({ ended: true }) : upstream({ message: "temporary" }, 503);
      }
      throw new Error(`unexpected ${url}`);
    }));
    const out = await run(request(valid));
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: "recovery-incomplete" });
    expect(calls.some((url) => url.includes("finalize_member_signin_recovery"))).toBe(false);
    expect(calls.some((url) => url.includes("fail_member_signin_recovery"))).toBe(false);
    expect(calls.filter((url) => url === `${SUPABASE}/auth/v1/admin/users/${USER_ID}`).length).toBe(3);
  });

  it("retries a provider-banned applied address by revoking before unban and finalize", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).includes("begin_member_signin_recovery")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID, retry: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") {
        return upstream(authUser("new.inbox@example.com", { banned: true, lock: OPERATION_ID }));
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ ended: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.ban_duration === "none") {
        return upstream(authUser("new.inbox@example.com"));
      }
      if (String(url).includes("finalize_member_signin_recovery")) return upstream({ completed: true });
      throw new Error(`unexpected ${init.method || "GET"} ${url}`);
    }));

    expect((await run(request(valid))).status).toBe(200);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${SUPABASE}/rest/v1/rpc/begin_member_signin_recovery`],
      ["GET", `${SUPABASE}/auth/v1/admin/users/${USER_ID}`],
      ["POST", `${SUPABASE}/rest/v1/rpc/end_member_auth_sessions`],
      ["PUT", `${SUPABASE}/auth/v1/admin/users/${USER_ID}`],
      ["POST", `${SUPABASE}/rest/v1/rpc/finalize_member_signin_recovery`],
    ]);
    expect(calls[3].body).toEqual({
      ban_duration: "none",
      app_metadata: { [RECOVERY_LOCK_KEY]: null },
    });
  });

  it("never adopts or releases an unrelated provider ban on retry", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).includes("begin_member_signin_recovery")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID, retry: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}`) {
        return upstream(authUser("old@example.com", { banned: true, lock: OTHER_OPERATION_ID }));
      }
      if (String(url).includes("fail_member_signin_recovery")) return upstream({ completed: false });
      throw new Error(`unexpected ${init.method || "GET"} ${url}`);
    }));

    const out = await run(request(valid));
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ error: "recovery-unavailable" });
    expect(calls.map((call) => call.url)).toEqual([
      `${SUPABASE}/rest/v1/rpc/begin_member_signin_recovery`,
      `${SUPABASE}/auth/v1/admin/users/${USER_ID}`,
      `${SUPABASE}/rest/v1/rpc/fail_member_signin_recovery`,
    ]);
    expect(calls.some((call) => call.body?.ban_duration === "none")).toBe(false);
  });

  it("holds the provider ban and does not change the address when pre-change revocation fails", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET" });
      if (String(url).includes("begin_member_signin_recovery")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") return upstream({ id: USER_ID, email: "old@example.com" });
      const body = init.body ? JSON.parse(init.body) : null;
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.ban_duration === "876000h") {
        return upstream(authUser("old@example.com", { banned: true, lock: OPERATION_ID }));
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ message: "temporary" }, 503);
      throw new Error(`unexpected ${url}`);
    }));

    const out = await run(request(valid));

    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: "recovery-incomplete" });
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(calls.find((call) => call.method === "PUT")?.url).toBe(`${SUPABASE}/auth/v1/admin/users/${USER_ID}`);
    expect(calls.some((call) => call.url.includes("finalize_member_signin_recovery"))).toBe(false);
  });
});
