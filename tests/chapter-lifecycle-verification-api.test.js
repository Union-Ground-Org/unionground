// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/_lib/backend.js", () => ({
  resolveSupabaseBackend: vi.fn(() => ({
    url: "https://example.supabase.co",
    publishableKey: "publishable",
    serviceRoleKey: "service-role",
  })),
}));

vi.mock("../api/_lib/http.js", async () => {
  const actual = await vi.importActual("../api/_lib/http.js");
  return { ...actual, supabaseRpc: vi.fn(), authenticateCaller: vi.fn() };
});

import handler from "../api/chapter-lifecycle-verification.js";
import { authenticateCaller, supabaseRpc } from "../api/_lib/http.js";

const resolved = (user) => ({ outcome: "resolved", user });
const rejected = { outcome: "rejected", user: null };
const unavailable = { outcome: "unavailable", user: null };

const REVIEWER = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function response() {
  return {
    statusCode: 0,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() { return this; },
    end(value) { this.payload = value ? JSON.parse(value) : null; },
  };
}

function request(body) {
  return {
    method: "POST",
    body,
    headers: { authorization: "Bearer member-token", host: "localhost", origin: "http://localhost" },
  };
}

describe("chapter lifecycle verification endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
    authenticateCaller.mockResolvedValue(resolved({ id: REVIEWER }));
  });

  it("authorizes a binding decision as a platform operator, with the caller's token, before using service role", async () => {
    supabaseRpc
      .mockResolvedValueOnce({ canManage: true })
      .mockResolvedValueOnce({ verified: true, chapterId: "wor" });
    const res = response();
    await handler(request({ action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true, publicNote: "Reviewed" }), res);
    expect(res.statusCode).toBe(200);
    expect(supabaseRpc.mock.calls).toEqual([
      ["https://example.supabase.co", "publishable", "member-token", "get_compass_platform_ai"],
      ["https://example.supabase.co", "service-role", "service-role", "verify_chapter_union_org_binding", {
        p_chapter_id: "wor", p_union_org_id: "org-1", p_verified: true, p_public_note: "Reviewed",
        p_verified_by: REVIEWER,
      }],
    ]);
  });

  // SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101: an
  // organization's own administrator cannot vouch that its chapter is a union
  // office. Organization-wide scope over the chapter is not consulted at all.
  it("refuses an organization administrator's binding verify and reject without touching service role", async () => {
    for (const verified of [true, false]) {
      vi.clearAllMocks();
      authenticateCaller.mockResolvedValue(resolved({ id: REVIEWER }));
      supabaseRpc.mockResolvedValueOnce({ canManage: false });
      const res = response();
      await handler(request({ action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified, publicNote: "" }), res);
      expect(res.statusCode).toBe(403);
      expect(res.payload).toEqual({ error: "not-permitted" });
      expect(supabaseRpc.mock.calls).toEqual([
        ["https://example.supabase.co", "publishable", "member-token", "get_compass_platform_ai"],
      ]);
    }
  });

  it("answers 403 when the database refuses the forwarded reviewer as no operator", async () => {
    supabaseRpc
      .mockResolvedValueOnce({ canManage: true })
      .mockRejectedValueOnce(Object.assign(new Error("platform operator required"), { status: 403 }));
    const res = response();
    await handler(request({ action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true }), res);
    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ error: "not-permitted" });
  });

  // The service role is a machine credential; the RPC refuses a null verifier,
  // so the endpoint must resolve the reviewer from their own token and forward
  // it. Without this the binding row keeps verified_by = null and the audit row
  // names nobody.
  it("forwards the authenticated reviewer's user id to the connection verifier", async () => {
    supabaseRpc
      .mockResolvedValueOnce({ scope: "organization", chapters: [{ id: "wor" }] })
      .mockResolvedValueOnce({ chapter_id: "wor", capability: "sms", status: "active", verified_by: REVIEWER });
    const res = response();
    await handler(request({ action: "verify-connection", chapterId: "wor", capability: "sms", status: "active", publicMessage: "Ready" }), res);
    expect(res.statusCode).toBe(200);
    expect(authenticateCaller).toHaveBeenCalledWith("https://example.supabase.co", "publishable", "member-token");
    expect(supabaseRpc.mock.calls[1]).toEqual([
      "https://example.supabase.co", "service-role", "service-role", "verify_chapter_connection_setup", {
        p_chapter_id: "wor", p_capability: "sms", p_status: "active", p_public_message: "Ready",
        p_verified_by: REVIEWER,
      },
    ]);
  });

  // A refused token and an unreachable Auth gateway are both fail-closed, but
  // they are not the same fact: during an outage every call here used to answer
  // 401, so an operator reading the logs could not tell an expired session from
  // an unavailable dependency.
  it("keeps 401 for a token the Auth gateway refused or resolved to no usable id", async () => {
    for (const identity of [rejected, resolved(null), resolved({}), resolved({ id: "not-a-uuid" }), resolved({ id: "" })]) {
      vi.clearAllMocks();
      authenticateCaller.mockResolvedValue(identity);
      const res = response();
      await handler(request({ action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true, publicNote: "" }), res);
      expect(res.statusCode).toBe(401);
      expect(res.payload).toEqual({ error: "unauthenticated" });
      expect(supabaseRpc).not.toHaveBeenCalled();
    }
  });

  it("answers 503 verification-unavailable when the Auth gateway is unreachable, times out or returns 5xx", async () => {
    for (const _case of ["transport failure", "timeout", "gateway 5xx"]) {
      vi.clearAllMocks();
      // `authenticateCaller` collapses all three into one outcome by design;
      // this asserts the handler maps that outcome to 503 and never to 401.
      authenticateCaller.mockResolvedValue(unavailable);
      const res = response();
      await handler(request({ action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true, publicNote: "" }), res);
      expect(res.statusCode, _case).toBe(503);
      expect(res.payload).toEqual({ error: "verification-unavailable" });
      expect(supabaseRpc).not.toHaveBeenCalled();
    }
  });

  it("refuses chapter-scoped admins without touching service-role verification", async () => {
    supabaseRpc.mockResolvedValueOnce({ scope: "chapter", chapters: [{ id: "wor" }] });
    const res = response();
    await handler(request({ action: "verify-connection", chapterId: "wor", capability: "sms", status: "active", publicMessage: "Ready" }), res);
    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ error: "not-permitted" });
    expect(supabaseRpc).toHaveBeenCalledTimes(1);
  });

  it("refuses a target outside the organization-wide admin's returned chapters", async () => {
    supabaseRpc.mockResolvedValueOnce({ scope: "organization", chapters: [{ id: "bos" }] });
    const res = response();
    await handler(request({ action: "verify-connection", chapterId: "wor", capability: "sms", status: "active", publicMessage: "Mismatch" }), res);
    expect(res.statusCode).toBe(403);
    expect(supabaseRpc).toHaveBeenCalledTimes(1);
  });

  it("refuses any method other than POST before reading the body", async () => {
    const res = response();
    await handler({ ...request({ action: "verify-binding" }), method: "GET" }, res);
    expect(res.statusCode).toBe(405);
    expect(supabaseRpc).not.toHaveBeenCalled();
  });

  it("refuses a browser request whose origin is not the trusted origin", async () => {
    const res = response();
    await handler({
      method: "POST",
      body: { action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true },
      headers: { authorization: "Bearer member-token", host: "localhost", origin: "https://evil.example" },
    }, res);
    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ error: "untrusted-origin" });
    expect(supabaseRpc).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    const res = response();
    await handler({
      method: "POST",
      body: { action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true },
      headers: { host: "localhost", origin: "http://localhost" },
    }, res);
    expect(res.statusCode).toBe(401);
    expect(supabaseRpc).not.toHaveBeenCalled();
  });

  it("refuses a malformed chapter identifier before it reaches any RPC", async () => {
    const res = response();
    await handler(request({ action: "verify-binding", chapterId: "../wor", unionOrgId: "org-1", verified: true }), res);
    expect(res.statusCode).toBe(400);
    expect(supabaseRpc).not.toHaveBeenCalled();
  });

  it("refuses an unknown action, an unknown capability and an unknown status", async () => {
    for (const body of [
      { action: "delete-binding", chapterId: "wor" },
      { action: "verify-connection", chapterId: "wor", capability: "telepathy", status: "active" },
      { action: "verify-connection", chapterId: "wor", capability: "sms", status: "verified" },
      { action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: "yes" },
      { action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true, publicNote: "x".repeat(501) },
    ]) {
      supabaseRpc.mockResolvedValueOnce(body.action === "verify-binding"
        ? { canManage: true }
        : { scope: "organization", chapters: [{ id: "wor" }] });
      const res = response();
      await handler(request(body), res);
      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ error: "invalid-request" });
    }
  });

  it("answers 409 when the binding changed under the reviewer and 503 when the backend is unavailable", async () => {
    supabaseRpc
      .mockResolvedValueOnce({ canManage: true })
      .mockRejectedValueOnce(Object.assign(new Error("binding unavailable"), { status: 400 }));
    const changed = response();
    await handler(request({ action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true }), changed);
    expect(changed.statusCode).toBe(409);
    expect(changed.payload).toEqual({ error: "request-changed" });

    supabaseRpc
      .mockResolvedValueOnce({ scope: "organization", chapters: [{ id: "wor" }] })
      .mockRejectedValueOnce(Object.assign(new Error("gateway"), { status: 502 }));
    const unavailable = response();
    await handler(request({ action: "verify-connection", chapterId: "wor", capability: "sms", status: "error", publicMessage: "" }), unavailable);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.payload).toEqual({ error: "verification-unavailable" });
  });

  it("refuses when the admin oracle answers a refusal, rather than assuming authority", async () => {
    for (const status of [401, 403, 404]) {
      vi.clearAllMocks();
      authenticateCaller.mockResolvedValue(resolved({ id: REVIEWER }));
      supabaseRpc.mockRejectedValueOnce(Object.assign(new Error("admin role required"), { status }));
      const res = response();
      await handler(request({ action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true }), res);
      expect(res.statusCode, `oracle ${status}`).toBe(403);
      expect(res.payload).toEqual({ error: "not-permitted" });
      expect(supabaseRpc).toHaveBeenCalledTimes(1);
    }
  });

  // An oracle that never answered has refused nobody. Mapping its outage to 403
  // told the reviewer their authority had been withdrawn and told the operator
  // nothing at all.
  it("answers 503 when the admin oracle is unreachable, times out or fails to answer", async () => {
    for (const rejection of [
      new Error("fetch failed"),
      Object.assign(new Error("timeout"), { name: "TimeoutError" }),
      Object.assign(new Error("gateway"), { status: 502 }),
      Object.assign(new Error("gateway"), { status: 503 }),
      Object.assign(new Error("too many requests"), { status: 429 }),
      Object.assign(new Error("request timeout"), { status: 408 }),
    ]) {
      vi.clearAllMocks();
      authenticateCaller.mockResolvedValue(resolved({ id: REVIEWER }));
      supabaseRpc.mockRejectedValueOnce(rejection);
      const res = response();
      await handler(request({ action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true }), res);
      expect(res.statusCode, rejection.message).toBe(503);
      expect(res.payload).toEqual({ error: "verification-unavailable" });
      // The service role is never reached: the scope read is the only call.
      expect(supabaseRpc).toHaveBeenCalledTimes(1);
    }
  });

  // The outage split may only ADD 503s, and a binding decision succeeds only
  // for a platform operator: an organization-wide administrator, who used to
  // succeed here, is now refused.
  it("returns a 2xx on exactly the platform operator's path", async () => {
    const outcomes = [];
    const cases = [
      { identity: resolved({ id: REVIEWER }), scope: { canManage: true }, rpc: { ok: true } },
      { identity: resolved({ id: REVIEWER }), scope: { canManage: false } },
      { identity: resolved({ id: REVIEWER }), scope: { scope: "organization", chapters: [{ id: "wor" }] } },
      { identity: rejected },
      { identity: unavailable },
      { identity: resolved({ id: "not-a-uuid" }) },
      { identity: resolved({ id: REVIEWER }), scopeError: Object.assign(new Error("denied"), { status: 403 }) },
      { identity: resolved({ id: REVIEWER }), scopeError: Object.assign(new Error("gateway"), { status: 502 }) },
    ];
    for (const item of cases) {
      vi.clearAllMocks();
      authenticateCaller.mockResolvedValue(item.identity);
      if (item.scopeError) supabaseRpc.mockRejectedValueOnce(item.scopeError);
      else if (item.scope) supabaseRpc.mockResolvedValueOnce(item.scope);
      if (item.rpc) supabaseRpc.mockResolvedValueOnce(item.rpc);
      const res = response();
      await handler(request({ action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true, publicNote: "Reviewed" }), res);
      outcomes.push(res.statusCode);
    }
    expect(outcomes).toEqual([200, 403, 403, 401, 503, 401, 403, 503]);
  });
});
