// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/admin-mfa-reset.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://unionground.supabase.co"));

// A fictional project on the hosted Supabase domain. unionGroundProvider()
// accepts it only because UNIONGROUND_SUPABASE_PROJECT_REF names the same
// ref below; no real project is ever named in this suite.
const SUPABASE_REF = "unionground";
const SUPABASE = `https://${SUPABASE_REF}.supabase.co`;
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const FACTOR_ID = "20000000-0000-4000-8000-000000000002";

const logoutOutcomes = [
  {
    label: "provider logout succeeds",
    result: upstream({ ended: true }),
    revoked: true,
  },
  {
    label: "provider logout returns HTTP 503",
    result: upstream({ error: "provider unavailable" }, 503),
    revoked: false,
  },
  {
    label: "provider logout times out",
    error: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    revoked: false,
  },
];

function upstream(payload, status = 200) {
  const body = payload === null ? "" : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : null),
  };
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

async function run() {
  const response = recorder();
  await handler({
    method: "POST",
    headers: { host: "unionground.invalid", authorization: "Bearer admin-aal2-token" },
    body: { userId: USER_ID },
  }, response);
  return response.out;
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("administrator MFA reset session boundary", () => {
  it.each(logoutOutcomes)("blocks stale sessions before factor deletion when $label", async ({ result, error, revoked }) => {
    // Break caught: replacing begin_mfa_reset with an authorization-only RPC,
    // moving it after factor deletion, or returning early on provider failure
    // reopens stale AAL1 JWT access or hides the completed reset from its audit.
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const call = {
        url: String(url),
        method: init.method || "GET",
        headers: init.headers || {},
        body: init.body ? JSON.parse(init.body) : null,
      };
      calls.push(call);

      if (call.url.endsWith("/auth/v1/user")) return upstream({ id: ADMIN_ID });
      if (call.url.endsWith("/rpc/authorize_mfa_reset")) return upstream({ authorized: true, adminRank: "checked" });
      if (call.url.endsWith("/rpc/begin_mfa_reset")) {
        return upstream({ userId: USER_ID, authorized: true, staleSessionsBlocked: true });
      }
      if (call.url.endsWith(`/admin/users/${USER_ID}/factors`) && call.method === "GET") {
        return upstream([{ id: FACTOR_ID, factor_type: "totp" }]);
      }
      if (call.url.endsWith(`/admin/users/${USER_ID}/factors/${FACTOR_ID}`)) {
        return upstream(null, 204);
      }
      if (call.url.endsWith("/rpc/end_member_auth_sessions")) {
        if (error) throw error;
        return result;
      }
      if (call.url.endsWith("/rpc/record_mfa_reset")) {
        return upstream({ recorded: true });
      }
      if (call.url.endsWith("/rpc/notify_member_mfa_reset")) {
        return upstream({ userId: USER_ID, notified: true });
      }
      if (call.url.endsWith("/rpc/drain_member_mfa_reset_notice")) {
        return upstream({ userId: USER_ID, drained: false, notified: false, pending: false });
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    }));

    const out = await run();

    expect(out).toEqual({
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: {
        removed: 1,
        audited: true,
        notified: true,
        pendingNotice: false,
        revoked,
        staleSessionsBlocked: true,
      },
    });
    // The member's notice is LAST: after the factors are gone, after the
    // sessions are revoked, and after the audit row it is bound to exists.
    // The drain that follows it owes this reset nothing — it is the retry that
    // clears a debt an EARLIER reset of this member left pending, and it never
    // marks a new one when the notice already landed.
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${SUPABASE}/auth/v1/user`],
      ["POST", `${SUPABASE}/rest/v1/rpc/authorize_mfa_reset`],
      ["POST", `${SUPABASE}/rest/v1/rpc/begin_mfa_reset`],
      ["GET", `${SUPABASE}/auth/v1/admin/users/${USER_ID}/factors`],
      ["DELETE", `${SUPABASE}/auth/v1/admin/users/${USER_ID}/factors/${FACTOR_ID}`],
      ["POST", `${SUPABASE}/rest/v1/rpc/end_member_auth_sessions`],
      ["POST", `${SUPABASE}/rest/v1/rpc/record_mfa_reset`],
      ["POST", `${SUPABASE}/rest/v1/rpc/notify_member_mfa_reset`],
      ["POST", `${SUPABASE}/rest/v1/rpc/drain_member_mfa_reset_notice`],
    ]);
    expect(calls[2].body).toEqual({ p_user_id: USER_ID });
    expect(calls[6].body).toEqual({ p_user_id: USER_ID, p_factors: 1 });
    expect(calls[7].body).toEqual({ p_user_id: USER_ID });
    expect(calls[8].body).toEqual({ p_user_id: USER_ID });
    // The notice runs as the CALLER, like the audit — never with the secret.
    expect(calls[7].headers.Authorization).toBe("Bearer admin-aal2-token");
    expect(calls[7].headers.apikey).toBe("publishable-key");
    expect(calls[8].headers.Authorization).toBe("Bearer admin-aal2-token");
    expect(calls[8].headers.apikey).toBe("publishable-key");
  });
});

// A JWS compact token whose payload carries `sub`. Signature is garbage on
// purpose: the handler reads the subject only to REFUSE, never to authorize.
function tokenWithSubject(sub) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub, role: "authenticated", aal: "aal2" })}.not-a-signature`;
}

describe("self-reset is refused at the endpoint, independently of the RPC", () => {
  // Break caught: dropping the subject check makes the refusal depend on
  // begin_mfa_reset alone. Deleting your own factors needs only an aal1
  // session, so an admin who could reset themselves hands any thief of an
  // admin password a one-call MFA bypass.
  it("refuses a target equal to the bearer's subject before any provider call", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("must not be reached"); });
    vi.stubGlobal("fetch", fetchSpy);
    const response = recorder();
    await handler({
      method: "POST",
      headers: { host: "unionground.invalid", authorization: `Bearer ${tokenWithSubject(USER_ID)}` },
      body: { userId: USER_ID },
    }, response);
    expect(response.out.status).toBe(403);
    // Flat: the same answer as "not an admin" and "unknown member".
    expect(response.out.body).toEqual({ error: "not-permitted" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is case-insensitive on the UUID and still reaches the RPC for a different subject", async () => {
    const seen = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      seen.push(String(url));
      return upstream({ error: "denied" }, 403);
    }));
    const self = recorder();
    await handler({
      method: "POST",
      headers: { host: "unionground.invalid", authorization: `Bearer ${tokenWithSubject(USER_ID.toUpperCase())}` },
      body: { userId: USER_ID },
    }, self);
    expect(self.out.status).toBe(403);
    expect(seen).toEqual([]);

    const other = recorder();
    await handler({
      method: "POST",
      headers: { host: "unionground.invalid", authorization: `Bearer ${tokenWithSubject("30000000-0000-4000-8000-000000000003")}` },
      body: { userId: USER_ID },
    }, other);
    // Reached the database, which is the authority for everything else.
    expect(seen).toEqual([`${SUPABASE}/auth/v1/user`]);
    expect(other.out.status).toBe(401);
  });

  it.each([
    ["an opaque token", "admin-aal2-token"],
    ["a token with no sub", `${Buffer.from("{}").toString("base64url")}.${Buffer.from("{}").toString("base64url")}.x`],
    ["a token whose sub is not a UUID", tokenWithSubject("not-a-uuid")],
  ])("leaves %s to the database rather than guessing", async (_, token) => {
    const seen = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      seen.push(String(url));
      return upstream({ error: "denied" }, 403);
    }));
    const response = recorder();
    await handler({
      method: "POST",
      headers: { host: "unionground.invalid", authorization: `Bearer ${token}` },
      body: { userId: USER_ID },
    }, response);
    expect(seen).toEqual([`${SUPABASE}/auth/v1/user`]);
  });
});

// BUG-UG-MFA-RESET-PARTIAL-NO-MEMBER-NOTICE-20260917.
//
// Three paths used to finish a reset and write the member nothing, with
// nothing durable left to retry: the notice writer is bound to a
// member_admin_audit row from this caller inside a fifteen-minute window, and
// a partial factor delete, a failed audit write and a failed notice each leave
// that window without one. Every one of them now marks the debt on the reset
// boundary (queue_member_mfa_reset_notice) and then delivers it
// (drain_member_mfa_reset_notice) — two calls, two transactions, because a
// mark that commits with its own delivery cannot survive a delivery that never
// happens.
//
// `routes` is the whole happy flow; each case overrides exactly the step it is
// about, so a break anywhere else in the chain fails loudly rather than
// silently changing what the case proves.
function routes(overrides = {}) {
  const table = {
    "/auth/v1/user": () => upstream({ id: ADMIN_ID }),
    "/rpc/authorize_mfa_reset": () => upstream({ authorized: true, adminRank: "checked" }),
    "/rpc/begin_mfa_reset": () => upstream({ authorized: true, staleSessionsBlocked: true }),
    "factors-list": () => upstream([]),
    "factor-delete": () => upstream(null, 204),
    "/rpc/end_member_auth_sessions": () => upstream({ ended: true }),
    "/rpc/record_mfa_reset": () => upstream({ recorded: true }),
    "/rpc/notify_member_mfa_reset": () => upstream({ userId: USER_ID, notified: true }),
    "/rpc/queue_member_mfa_reset_notice": () => upstream({ userId: USER_ID, pending: true }),
    "/rpc/drain_member_mfa_reset_notice": () => upstream({ userId: USER_ID, drained: false, notified: false, pending: false }),
    ...overrides,
  };
  const seen = [];
  const fetchStub = vi.fn(async (url, init = {}) => {
    const target = String(url);
    const method = init.method || "GET";
    const key = target.endsWith(`/admin/users/${USER_ID}/factors`) && method === "GET" ? "factors-list"
      : target.includes(`/admin/users/${USER_ID}/factors/`) ? "factor-delete"
        : Object.keys(table).find((route) => route.startsWith("/") && target.endsWith(route));
    if (!key || !table[key]) throw new Error(`unexpected ${method} ${target}`);
    seen.push(key);
    return table[key](init.body ? JSON.parse(init.body) : null);
  });
  vi.stubGlobal("fetch", fetchStub);
  return seen;
}

describe("member notice", () => {
  it("marks the notice owed and drains it when a factor delete fails partway", async () => {
    // Break caught: returning 502 without the queue leaves a member whose
    // sessions and push targets are already closed, and whose authenticator is
    // partly gone, with no notice and nothing to retry.
    const seen = routes({
      "factors-list": () => upstream([{ id: FACTOR_ID, factor_type: "totp" }]),
      "factor-delete": () => upstream({ error: "gone" }, 500),
      "/rpc/drain_member_mfa_reset_notice": () => upstream({ userId: USER_ID, drained: true, notified: true, pending: false }),
    });
    const out = await run();
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      error: "partial-reset",
      removed: 0,
      total: 1,
      staleSessionsBlocked: true,
      notified: true,
      pendingNotice: false,
    });
    // Durable first, delivery second — never the other way round.
    expect(seen.slice(-2)).toEqual([
      "/rpc/queue_member_mfa_reset_notice",
      "/rpc/drain_member_mfa_reset_notice",
    ]);
    // The notice never rides on notify_member_mfa_reset here: no audit row for
    // this caller need exist, which is exactly why that RPC cannot serve it.
    expect(seen).not.toContain("/rpc/notify_member_mfa_reset");
  });

  it("marks the notice owed and drains it when the audit write fails", async () => {
    // Break caught: the 200 audited:false path returned notified:false with
    // nothing owed, so the notice could never be written for that reset — the
    // audit row it is bound to was never going to exist.
    const seen = routes({
      "/rpc/record_mfa_reset": () => upstream({ error: "boom" }, 503),
      "/rpc/drain_member_mfa_reset_notice": () => upstream({ userId: USER_ID, drained: true, notified: true, pending: false }),
    });
    const out = await run();
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      removed: 0,
      audited: false,
      notified: true,
      pendingNotice: false,
      revoked: true,
      staleSessionsBlocked: true,
    });
    expect(seen).not.toContain("/rpc/notify_member_mfa_reset");
    expect(seen.slice(-2)).toEqual([
      "/rpc/queue_member_mfa_reset_notice",
      "/rpc/drain_member_mfa_reset_notice",
    ]);
  });

  it("marks the notice owed and drains it when the notice RPC fails", async () => {
    // Break caught: a failed notify left the member with nothing and the
    // fifteen-minute window as the only way back.
    const seen = routes({
      "/rpc/notify_member_mfa_reset": () => upstream({ error: "boom" }, 503),
      "/rpc/drain_member_mfa_reset_notice": () => upstream({ userId: USER_ID, drained: true, notified: true, pending: false }),
    });
    const out = await run();
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      removed: 0,
      audited: true,
      notified: true,
      pendingNotice: false,
      revoked: true,
      staleSessionsBlocked: true,
    });
    expect(seen.slice(-3)).toEqual([
      "/rpc/notify_member_mfa_reset",
      "/rpc/queue_member_mfa_reset_notice",
      "/rpc/drain_member_mfa_reset_notice",
    ]);
  });

  it("reports the notice as still pending when the drain itself cannot run", async () => {
    // The point of the two calls: the mark is committed, so the next reset for
    // this member drains it. The response says so rather than claiming the
    // member was told.
    routes({
      "/rpc/notify_member_mfa_reset": () => upstream({ error: "boom" }, 503),
      "/rpc/drain_member_mfa_reset_notice": () => upstream({ error: "boom" }, 503),
    });
    const out = await run();
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ audited: true, notified: false, pendingNotice: true });
  });

  it("reports nothing pending when the queue RPC is the call that fails", async () => {
    // Nothing durable was written, so claiming a pending notice would promise
    // a retry that has nothing to find.
    routes({
      "/rpc/notify_member_mfa_reset": () => upstream({ error: "boom" }, 503),
      "/rpc/queue_member_mfa_reset_notice": () => upstream({ error: "boom" }, 503),
    });
    const out = await run();
    expect(out.body).toMatchObject({ notified: false, pendingNotice: false });
  });

  it("never turns a duplicate into a second reset, and reports the member as told", async () => {
    // The drain recognises the notice this reset already has and settles the
    // row without writing a second one. `duplicate` is a notice the member
    // HAS: reporting not-notified here would send an administrator to phone
    // somebody who already has it in their inbox (admin.mfaResetUnnotified).
    const seen = routes({
      "/rpc/notify_member_mfa_reset": () => upstream({ notified: false, duplicate: true }),
      "/rpc/drain_member_mfa_reset_notice": () => upstream({ userId: USER_ID, drained: true, notified: false, duplicate: true, pending: false }),
    });
    const out = await run();
    expect(out.body.notified).toBe(true);
    expect(out.body.audited).toBe(true);
    expect(out.body.pendingNotice).toBe(false);
    expect(seen.slice(-2)).toEqual([
      "/rpc/queue_member_mfa_reset_notice",
      "/rpc/drain_member_mfa_reset_notice",
    ]);
  });

  it("reports the member as told when the drain finds the notice on the partial-reset path too", async () => {
    // Break caught: mapping only `notified === true` leaves every duplicate
    // answer reading as a failure to notify, on all three paths — the drain
    // settles the debt and the response still says the member was not told.
    const seen = routes({
      "factors-list": () => upstream([{ id: FACTOR_ID, factor_type: "totp" }]),
      "factor-delete": () => upstream({ error: "gone" }, 500),
      "/rpc/drain_member_mfa_reset_notice": () => upstream({ userId: USER_ID, drained: true, notified: false, duplicate: true, pending: false }),
    });
    const out = await run();
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      error: "partial-reset",
      removed: 0,
      total: 1,
      staleSessionsBlocked: true,
      notified: true,
      pendingNotice: false,
    });
    expect(seen.slice(-2)).toEqual([
      "/rpc/queue_member_mfa_reset_notice",
      "/rpc/drain_member_mfa_reset_notice",
    ]);
  });

  it("still reports not-notified when the drain had nothing to deliver and nothing to recognise", async () => {
    // The other side of the same line: `drained:false` is "no debt here", not
    // "the member was told". Only a delivery or a recognised notice counts.
    routes({
      "/rpc/notify_member_mfa_reset": () => upstream({ error: "boom" }, 503),
      "/rpc/queue_member_mfa_reset_notice": () => upstream({ userId: USER_ID, pending: false }),
      "/rpc/drain_member_mfa_reset_notice": () => upstream({ userId: USER_ID, drained: false, notified: false, pending: false }),
    });
    const out = await run();
    expect(out.body).toMatchObject({ notified: false, pendingNotice: false });
  });
});

// BUG-UG-MFA-RESET-FOURTH-EXIT-NO-NOTICE-NO-DEBT-20260918.
//
// The fourth exit: begin_mfa_reset already closed the member's sessions and
// push targets, then the provider's factor inventory failed, so nothing was
// removed. efused queue-only here — the pending-notice
// debt drains as "an administrator removed the authenticator", which is false
// when the authenticator is still there. The exit sends its own true notice
// instead, and never touches the removed-copy writers.
describe("inventory failure after the reset boundary", () => {
  const REMOVED_COPY_WRITERS = [
    "/rpc/queue_member_mfa_reset_notice",
    "/rpc/drain_member_mfa_reset_notice",
    "/rpc/notify_member_mfa_reset",
  ];

  it.each([
    ["the inventory returns HTTP 503", () => upstream({ error: "down" }, 503)],
    ["the inventory is malformed", () => upstream([{ id: "../other" }])],
  ])("tells the member the reset did not finish when %s", async (_, inventory) => {
    const bodies = [];
    const seen = routes({
      "factors-list": inventory,
      "/rpc/notify_member_mfa_reset_incomplete": (body) => {
        bodies.push(body);
        return upstream({ userId: USER_ID, notified: true, duplicate: false });
      },
    });
    const out = await run();
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      error: "auth-service-unavailable",
      removed: 0,
      staleSessionsBlocked: true,
      notified: true,
      pendingNotice: false,
    });
    expect(seen).toEqual([
      "/auth/v1/user",
      "/rpc/authorize_mfa_reset",
      "/rpc/begin_mfa_reset",
      "factors-list",
      "/rpc/notify_member_mfa_reset_incomplete",
    ]);
    expect(bodies).toEqual([{ p_user_id: USER_ID }]);
  });

  it("never sends the authenticator-removed copy, nor marks a debt that would drain with it", async () => {
    // Break caught: calling settleMemberNotice(…, true) on this exit — the
    // queue-only delivery decision 34 refused — would tell a member whose
    // authenticator still works that it was removed.
    const seen = routes({
      "factors-list": () => upstream({ error: "down" }, 503),
      "/rpc/notify_member_mfa_reset_incomplete": () => upstream({ userId: USER_ID, notified: true, duplicate: false }),
    });
    await run();
    for (const writer of REMOVED_COPY_WRITERS) expect(seen).not.toContain(writer);
    expect(seen).not.toContain("/rpc/record_mfa_reset");
    expect(seen).not.toContain("factor-delete");
  });

  it("reports the member as told when this reset already has its notice", async () => {
    routes({
      "factors-list": () => upstream({ error: "down" }, 503),
      "/rpc/notify_member_mfa_reset_incomplete": () => upstream({ userId: USER_ID, notified: false, duplicate: true }),
    });
    const out = await run();
    expect(out.body).toMatchObject({ error: "auth-service-unavailable", notified: true, pendingNotice: false });
  });

  it("reports not-notified, and still does not fall back to the removed copy, when the notice cannot be written", async () => {
    const seen = routes({
      "factors-list": () => upstream({ error: "down" }, 503),
      "/rpc/notify_member_mfa_reset_incomplete": () => upstream({ error: "boom" }, 503),
    });
    const out = await run();
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      error: "auth-service-unavailable",
      removed: 0,
      staleSessionsBlocked: true,
      notified: false,
      pendingNotice: false,
    });
    for (const writer of REMOVED_COPY_WRITERS) expect(seen).not.toContain(writer);
  });
});

// Carried from the Union Ground suite, rewritten for this endpoint's flow:
// the provider boundary, UUID canonicalization, GoTrue's raw factor payload,
// and the service-role DELETE path guard all still apply.
describe("Union Ground provider boundary and request hardening", () => {
  it.each([
    ["the project ref is not pinned", () => vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "")],
    ["the URL names a different project", () => vi.stubEnv("VITE_SUPABASE_URL", "https://someotherproject.supabase.co")],
    ["the URL is not a hosted Supabase origin", () => vi.stubEnv("VITE_SUPABASE_URL", "https://example.invalid")],
  ])("answers not-configured before any provider call when %s", async (_, configure) => {
    configure();
    const fetchSpy = vi.fn(async () => { throw new Error("must not be reached"); });
    vi.stubGlobal("fetch", fetchSpy);
    const out = await run();
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "not-configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never calls the provider's logout route; sessions end through the database", async () => {
    const urls = [];
    const seen = routes({ "factors-list": () => upstream([{ id: FACTOR_ID }]) });
    const fetchStub = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      urls.push(String(url));
      return fetchStub(url, init);
    }));
    const out = await run();
    expect(out.status).toBe(200);
    expect(seen).toContain("/rpc/end_member_auth_sessions");
    expect(urls.some((url) => url.endsWith("/logout"))).toBe(false);
  });

  it("canonicalizes an uppercase target UUID before the reset boundary", async () => {
    const bodies = {};
    routes({
      "/rpc/authorize_mfa_reset": (body) => { bodies.authorize = body; return upstream({ authorized: true, adminRank: "checked" }); },
      "/rpc/begin_mfa_reset": (body) => { bodies.begin = body; return upstream({ authorized: true, staleSessionsBlocked: true }); },
    });
    const response = recorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer admin-aal2-token" },
      body: { userId: USER_ID.toUpperCase() },
    }, response);
    expect(response.out.status).toBe(200);
    expect(bodies.authorize).toEqual({ p_user_id: USER_ID });
    expect(bodies.begin).toEqual({ p_user_id: USER_ID });
  });

  it("accepts GoTrue's raw factor array and refuses a malformed factor payload", async () => {
    const raw = routes({ "factors-list": () => upstream([{ id: FACTOR_ID }]) });
    const ok = await run();
    expect(ok.status).toBe(200);
    expect(ok.body.removed).toBe(1);
    expect(raw).toContain("factor-delete");

    const malformed = routes({ "factors-list": () => upstream({}) });
    const refused = await run();
    expect(refused.status).toBe(502);
    expect(refused.body).toMatchObject({ error: "auth-service-unavailable", removed: 0 });
    expect(malformed).not.toContain("factor-delete");
  });

  it("never builds a service-role delete path from a malformed factor id", async () => {
    const urls = [];
    routes({ "factors-list": () => upstream([{ id: `../../${USER_ID}` }]) });
    const fetchStub = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      urls.push(String(url));
      return fetchStub(url, init);
    }));
    const out = await run();
    expect(out.status).toBe(502);
    expect(out.body).toMatchObject({ error: "auth-service-unavailable", removed: 0 });
    expect(urls.some((url) => url.includes("/factors/../"))).toBe(false);
    expect(urls.some((url) => url.includes("/factors/"))).toBe(false);
  });
});
