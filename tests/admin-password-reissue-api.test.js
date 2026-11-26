// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/admin-password-reissue.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SUPABASE = "https://project.supabase.co";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const OPERATION_ID = "20000000-0000-4000-8000-000000000002";
const STALE_OPERATION_ID = "30000000-0000-4000-8000-000000000003";

function upstream(payload, status = 200) {
  const body = payload === null ? "" : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

function recorder() {
  const out = { status: 0, headers: {}, body: null };
  return { out, status(code) { out.status = code; return this; }, setHeader(name, value) { out.headers[name] = value; }, end(body) { out.body = JSON.parse(body); } };
}

async function run(body = { userId: USER_ID, identityVerified: true }, token = "admin-token") {
  const response = recorder();
  await handler({ method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body }, response);
  return response.out;
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("RESEND_API_KEY", "resend-secret");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <members@unionground.test>");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("admin emailed-password reissue", () => {
  it("requires an authenticated, explicitly verified request before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run({}, null)).status).toBe(403);
    expect((await run({ userId: USER_ID, identityVerified: false })).status).toBe(400);
    expect((await run({ userId: "not-a-uuid", identityVerified: true })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a retryable failure when the first Auth read throws", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("begin_member_password_reissue")) {
        return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}`) throw new Error("provider timeout");
      if (String(url).includes("fail_member_password_reissue")) return upstream({ completed: false });
      throw new Error(`unexpected ${url}`);
    }));

    expect(await run()).toMatchObject({ status: 502, body: { error: "reissue-incomplete" } });
    expect(calls.at(-1).body).toEqual({
      p_operation_id: OPERATION_ID,
      p_failure_code: "auth_unavailable",
    });
  });

  it("stages the password under a ban, emails it, activates it, and finalizes without returning it", async () => {
    const calls = [];
    const baseUser = {
      id: USER_ID, email: "member@example.com", banned_until: null,
      user_metadata: { language: "en" }, app_metadata: { union_ground_provisioning: "active" },
    };
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body, headers: init.headers });
      if (String(url).includes("begin_member_password_reissue")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") return upstream(baseUser);
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "876000h" && !body?.password) {
        return upstream({
          ...baseUser,
          banned_until: "2126-08-21T00:00:00Z",
          app_metadata: {
            ...baseUser.app_metadata,
            concurrent_provider_metadata: "preserved",
            member_signin_recovery_operation_id: OPERATION_ID,
          },
        });
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ ended: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.password) {
        return upstream({ id: USER_ID, banned_until: "2126-08-21T00:00:00Z", app_metadata: body.app_metadata });
      }
      if (String(url) === "https://api.resend.com/emails") return upstream({ id: "email-1" });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "none") {
        return upstream({ id: USER_ID, banned_until: null, app_metadata: body.app_metadata });
      }
      if (String(url).includes("finalize_member_password_reissue")) return upstream({ completed: true });
      throw new Error(`unexpected ${init.method || "GET"} ${url}`);
    }));

    const out = await run();
    expect(out).toEqual(expect.objectContaining({ status: 200, body: { completed: true } }));
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${SUPABASE}/rest/v1/rpc/begin_member_password_reissue`],
      ["GET", `${SUPABASE}/auth/v1/admin/users/${USER_ID}`],
      ["PUT", `${SUPABASE}/auth/v1/admin/users/${USER_ID}`],
      ["POST", `${SUPABASE}/rest/v1/rpc/end_member_auth_sessions`],
      ["PUT", `${SUPABASE}/auth/v1/admin/users/${USER_ID}`],
      ["POST", "https://api.resend.com/emails"],
      ["PUT", `${SUPABASE}/auth/v1/admin/users/${USER_ID}`],
      ["POST", `${SUPABASE}/rest/v1/rpc/finalize_member_password_reissue`],
    ]);
    expect(calls[4].body.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(calls[4].body.ban_duration).toBe("876000h");
    expect(calls[4].body.app_metadata).toMatchObject({
      concurrent_provider_metadata: "preserved",
      union_ground_provisioning: "active",
      union_ground_password_reissue_operation_id: OPERATION_ID,
      member_signin_recovery_operation_id: OPERATION_ID,
    });
    expect(calls[5].body.text).toContain("Temporary password:");
    expect(calls[5].body.text).toContain(calls[4].body.password);
    expect(calls[5].headers["Idempotency-Key"]).toMatch(new RegExp(`^ug-password-${OPERATION_ID}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));
    // REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006 (reissue half):
    // the reissue says it replaces every earlier temporary password and when
    // it was sent, so a member with several can tell which one is current.
    expect(calls[5].body.subject).toBe("Your new Union Ground sign-in password");
    expect(calls[5].body.text).toMatch(/This password replaces any temporary password sent to you before\. Sent [A-Z][a-z]+ \d{1,2}, \d{4}(,| at) \d{1,2}:\d{2}:\d{2}\.\d{3}\s[AP]M E[DS]T \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC\)\. If you have several of these emails, only the newest one works\./);
    expect(calls[6].body).toMatchObject({
      ban_duration: "none",
      app_metadata: {
        union_ground_provisioning: "active",
        union_ground_password_reissue_operation_id: OPERATION_ID,
        member_signin_recovery_operation_id: null,
      },
    });
    expect(calls[6].body).not.toHaveProperty("password");
    expect(JSON.stringify(out)).not.toMatch(/member@example|password|operation/i);
  });

  it("keeps the staged credential provider-banned and records failure when delivery fails", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).includes("begin_member_password_reissue")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") {
        return upstream({ id: USER_ID, email: "member@example.com", user_metadata: {}, app_metadata: {} });
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "876000h" && !body?.password) {
        return upstream({ id: USER_ID, banned_until: "2126-08-21T00:00:00Z", app_metadata: { member_signin_recovery_operation_id: OPERATION_ID } });
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ ended: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.password) {
        return upstream({ id: USER_ID, banned_until: "2126-08-21T00:00:00Z", app_metadata: body.app_metadata });
      }
      if (String(url) === "https://api.resend.com/emails") return upstream({ error: "down" }, 503);
      if (String(url).includes("fail_member_password_reissue")) return upstream({ completed: false });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run()).toMatchObject({ status: 502, body: { error: "reissue-incomplete" } });
    expect(calls.at(-1).body).toEqual({ p_operation_id: OPERATION_ID, p_failure_code: "provider_unavailable" });
    expect(calls.findIndex((call) => call.body?.password)).toBeLessThan(calls.findIndex((call) => call.url === "https://api.resend.com/emails"));
    expect(calls.some((call) => call.body?.ban_duration === "none")).toBe(false);
    expect(calls.some((call) => call.url.includes("finalize_member_password_reissue"))).toBe(false);
  });

  it("releases its unstaged recovery ban before recording a failed session revocation", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).includes("begin_member_password_reissue")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") return upstream({ id: USER_ID, email: "member@example.com", user_metadata: {}, app_metadata: {} });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "876000h") {
        return upstream({ id: USER_ID, banned_until: "2126-08-21T00:00:00Z", app_metadata: { member_signin_recovery_operation_id: OPERATION_ID } });
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "none") {
        return upstream({ id: USER_ID, banned_until: null, app_metadata: { member_signin_recovery_operation_id: null } });
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ error: "temporary" }, 503);
      if (String(url).includes("fail_member_password_reissue")) return upstream({ completed: false });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run()).toMatchObject({ status: 502, body: { error: "reissue-incomplete" } });
    expect(calls.some((call) => call.body?.password)).toBe(false);
    expect(calls.some((call) => call.url === "https://api.resend.com/emails")).toBe(false);
    expect(calls.some((call) => call.url.includes("finalize_member_password_reissue"))).toBe(false);
    const releaseIndex = calls.findIndex((call) => call.body?.ban_duration === "none");
    const failureIndex = calls.findIndex((call) => call.url.includes("fail_member_password_reissue"));
    expect(releaseIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeLessThan(failureIndex);
  });

  it("re-reads and releases an operation-owned ban when the lock response is missing", async () => {
    const calls = [];
    let authReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).includes("begin_member_password_reissue")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") {
        authReads += 1;
        if (authReads === 1) return upstream({ id: USER_ID, email: "member@example.com", user_metadata: {}, app_metadata: {} });
        return upstream({ id: USER_ID, email: "member@example.com", banned_until: "2126-08-21T00:00:00Z", user_metadata: {}, app_metadata: { member_signin_recovery_operation_id: OPERATION_ID } });
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "876000h") return upstream(null);
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "none") return upstream({ id: USER_ID, banned_until: null, app_metadata: { member_signin_recovery_operation_id: null } });
      if (String(url).includes("fail_member_password_reissue")) return upstream({ completed: false });
      throw new Error(`unexpected ${url}`);
    }));

    expect(await run()).toMatchObject({ status: 502, body: { error: "reissue-incomplete" } });
    expect(authReads).toBe(2);
    expect(calls.some((call) => call.body?.ban_duration === "none")).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/rpc/end_member_auth_sessions"))).toBe(false);
  });

  it("never emails when credential staging fails and leaves the recovery ban in place", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).includes("begin_member_password_reissue")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") {
        return upstream({ id: USER_ID, email: "member@example.com", user_metadata: {}, app_metadata: {} });
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && !body?.password) {
        return upstream({ id: USER_ID, banned_until: "2126-08-21T00:00:00Z", app_metadata: { member_signin_recovery_operation_id: OPERATION_ID } });
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ ended: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.password) {
        return upstream({ error: "temporary" }, 503);
      }
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run()).toMatchObject({ status: 502, body: { error: "reissue-incomplete" } });
    expect(calls.some((call) => call.url === "https://api.resend.com/emails")).toBe(false);
    expect(calls.some((call) => call.body?.ban_duration === "none")).toBe(false);
  });

  it("preserves the live lease when activation and its confirming re-read both fail", async () => {
    const calls = [];
    let authReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).includes("begin_member_password_reissue")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") {
        authReads += 1;
        if (authReads > 1) throw new Error("confirmation unavailable");
        return upstream({ id: USER_ID, email: "member@example.com", user_metadata: {}, app_metadata: {} });
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "876000h" && !body?.password) {
        return upstream({ id: USER_ID, banned_until: "2126-08-21T00:00:00Z", app_metadata: { member_signin_recovery_operation_id: OPERATION_ID } });
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ ended: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.password) {
        return upstream({ id: USER_ID, banned_until: "2126-08-21T00:00:00Z", app_metadata: body.app_metadata });
      }
      if (String(url) === "https://api.resend.com/emails") return upstream({ id: "email-3" });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.ban_duration === "none") {
        return upstream({ error: "temporary" }, 503);
      }
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run()).toMatchObject({ status: 502, body: { error: "reissue-incomplete" } });
    expect(calls.findIndex((call) => call.body?.password)).toBeLessThan(calls.findIndex((call) => call.url === "https://api.resend.com/emails"));
    expect(calls.some((call) => call.url.includes("finalize_member_password_reissue"))).toBe(false);
    expect(calls.some((call) => call.url.includes("fail_member_password_reissue"))).toBe(false);
  });

  it("recovers a committed activation after its provider response is lost", async () => {
    const calls = [];
    let authReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).includes("begin_member_password_reissue")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") {
        authReads += 1;
        if (authReads === 1) return upstream({ id: USER_ID, email: "member@example.com", user_metadata: {}, app_metadata: {} });
        return upstream({
          id: USER_ID, email: "member@example.com", banned_until: null, user_metadata: {},
          app_metadata: {
            union_ground_provisioning: "active",
            union_ground_password_reissue_operation_id: OPERATION_ID,
            member_signin_recovery_operation_id: null,
          },
        });
      }
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "876000h" && !body?.password) {
        return upstream({ id: USER_ID, banned_until: "2126-08-21T00:00:00Z", app_metadata: { member_signin_recovery_operation_id: OPERATION_ID } });
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ ended: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.password) {
        return upstream({ id: USER_ID, banned_until: "2126-08-21T00:00:00Z", app_metadata: body.app_metadata });
      }
      if (String(url) === "https://api.resend.com/emails") return upstream({ id: "email-4" });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.ban_duration === "none") {
        return upstream(null, 504);
      }
      if (String(url).includes("finalize_member_password_reissue")) return upstream({ completed: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run()).toMatchObject({ status: 200, body: { completed: true } });
    expect(authReads).toBe(2);
    expect(calls.filter((call) => call.url.includes("finalize_member_password_reissue"))).toHaveLength(1);
    expect(calls.some((call) => call.url.includes("fail_member_password_reissue"))).toBe(false);
  });

  it("finalizes an already-activated retry without rotating or emailing another password", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).includes("begin_member_password_reissue")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID, retry: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}`) {
        return upstream({
          id: USER_ID, email: "member@example.com", banned_until: null, user_metadata: {},
          app_metadata: {
            union_ground_provisioning: "active",
            union_ground_password_reissue_operation_id: OPERATION_ID,
            member_signin_recovery_operation_id: null,
          },
        });
      }
      if (String(url).includes("finalize_member_password_reissue")) return upstream({ completed: true });
      throw new Error(`unexpected ${url}`);
    }));
    expect(await run()).toMatchObject({ status: 200, body: { completed: true } });
    expect(calls.map((call) => call.url)).toEqual([
      `${SUPABASE}/rest/v1/rpc/begin_member_password_reissue`,
      `${SUPABASE}/auth/v1/admin/users/${USER_ID}`,
      `${SUPABASE}/rest/v1/rpc/finalize_member_password_reissue`,
    ]);
  });

  it("does not treat a stale operation marker as an idempotent completion", async () => {
    const calls = [];
    const initial = {
      id: USER_ID, email: "member@example.com", banned_until: null, user_metadata: {},
      app_metadata: {
        union_ground_provisioning: "active",
        union_ground_password_reissue_operation_id: STALE_OPERATION_ID,
        member_signin_recovery_operation_id: null,
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method || "GET", body });
      if (String(url).includes("begin_member_password_reissue")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && (init.method || "GET") === "GET") return upstream(initial);
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "876000h" && !body?.password) {
        return upstream({ ...initial, banned_until: "2126-08-21T00:00:00Z", app_metadata: { ...initial.app_metadata, member_signin_recovery_operation_id: OPERATION_ID } });
      }
      if (String(url).endsWith("/rpc/end_member_auth_sessions")) return upstream({ ended: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT" && body?.password) {
        return upstream({ id: USER_ID, banned_until: "2126-08-21T00:00:00Z", app_metadata: body.app_metadata });
      }
      if (String(url) === "https://api.resend.com/emails") return upstream({ id: "email-stale" });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}` && init.method === "PUT"
          && body?.ban_duration === "none") return upstream({ id: USER_ID, banned_until: null, app_metadata: body.app_metadata });
      if (String(url).includes("finalize_member_password_reissue")) return upstream({ completed: true });
      throw new Error(`unexpected ${url}`);
    }));

    expect(await run()).toMatchObject({ status: 200, body: { completed: true } });
    expect(calls.some((call) => call.body?.password)).toBe(true);
    expect(calls.some((call) => call.url === "https://api.resend.com/emails")).toBe(true);
  });

  it("fails closed when finalization returns an unexpected success shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("begin_member_password_reissue")) return upstream({ accepted: true, adminRank: "checked", operationId: OPERATION_ID, retry: true });
      if (String(url) === `${SUPABASE}/auth/v1/admin/users/${USER_ID}`) {
        return upstream({
          id: USER_ID, email: "member@example.com", banned_until: null, user_metadata: {},
          app_metadata: {
            union_ground_provisioning: "active",
            union_ground_password_reissue_operation_id: OPERATION_ID,
            member_signin_recovery_operation_id: null,
          },
        });
      }
      if (String(url).includes("finalize_member_password_reissue")) return upstream({ completed: false });
      throw new Error(`unexpected ${url}`);
    }));

    expect(await run()).toMatchObject({ status: 502, body: { error: "reissue-incomplete" } });
  });
});
