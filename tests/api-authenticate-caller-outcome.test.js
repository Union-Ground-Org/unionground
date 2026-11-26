// @vitest-environment node
//
// BUG-UG-CHAPTER-VERIFICATION-AUTH-OUTAGE-AS-401-20260917.
//
// `authenticate` answers `null` for a refused token and for a 5xx from the Auth
// gateway alike, and throws on a transport failure or a timeout, which every
// caller catches into the same `null`. `authenticateCaller` is the helper that
// keeps the three apart so a handler can answer 503 for an outage and 401 only
// for a token the gateway actually refused. The chapter-verification handler
// test mocks this helper, so the status-to-outcome mapping is proved here
// against the real module with a stubbed `fetch`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate, authenticateCaller } from "../api/_lib/http.js";

const USER = { id: "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" };

function reply(status, { body = USER, unreadable = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (unreadable) throw new SyntaxError("Unexpected end of JSON input");
      return body;
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("Auth gateway outage is not an unauthenticated caller", () => {
  it("resolves the user and sends the token in Authorization with the publishable apikey", async () => {
    const fetchMock = vi.fn(async () => reply(200));
    vi.stubGlobal("fetch", fetchMock);
    await expect(authenticateCaller("https://example.supabase.co", "publishable", "member-token"))
      .resolves.toEqual({ outcome: "resolved", user: USER });
    expect(fetchMock).toHaveBeenCalledWith("https://example.supabase.co/auth/v1/user", expect.objectContaining({
      headers: { apikey: "publishable", Authorization: "Bearer member-token" },
    }));
  });

  it("reports a refused token as rejected", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      vi.stubGlobal("fetch", vi.fn(async () => reply(status)));
      await expect(authenticateCaller("https://example.supabase.co", "publishable", "token"))
        .resolves.toEqual({ outcome: "rejected", user: null });
    }
  });

  it("reports a transport failure, a timeout, a 5xx, a 429 and a 408 as unavailable", async () => {
    const failures = [
      () => { throw new TypeError("fetch failed"); },
      () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); },
      () => reply(500),
      () => reply(502),
      () => reply(503),
      () => reply(504),
      () => reply(429),
      () => reply(408),
    ];
    for (const failure of failures) {
      vi.stubGlobal("fetch", vi.fn(async () => failure()));
      await expect(authenticateCaller("https://example.supabase.co", "publishable", "token"))
        .resolves.toEqual({ outcome: "unavailable", user: null });
    }
  });

  it("reports a 200 whose body cannot be read as unavailable rather than as a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { unreadable: true })));
    await expect(authenticateCaller("https://example.supabase.co", "publishable", "token"))
      .resolves.toEqual({ outcome: "unavailable", user: null });
  });

  it("treats a reply with no status as 0 and reports it as rejected when the gateway did not ok it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => USER,
    })));
    await expect(authenticateCaller("https://example.supabase.co", "publishable", "token"))
      .resolves.toEqual({ outcome: "rejected", user: null });
  });

  it("treats an explicit status 0 the same as a missing status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(0)));
    await expect(authenticateCaller("https://example.supabase.co", "publishable", "token"))
      .resolves.toEqual({ outcome: "rejected", user: null });
  });

  it("reports an ok:false 401 as rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(401)));
    await expect(authenticateCaller("https://example.supabase.co", "publishable", "token"))
      .resolves.toEqual({ outcome: "rejected", user: null });
  });

  it("reports ok:true as resolved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200)));
    await expect(authenticateCaller("https://example.supabase.co", "publishable", "token"))
      .resolves.toEqual({ outcome: "resolved", user: USER });
  });

  it("reports ok:true whose json() throws as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { unreadable: true })));
    await expect(authenticateCaller("https://example.supabase.co", "publishable", "token"))
      .resolves.toEqual({ outcome: "unavailable", user: null });
  });

  it("reports a thrown fetch and an AbortSignal timeout as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(authenticateCaller("https://example.supabase.co", "publishable", "token"))
      .resolves.toEqual({ outcome: "unavailable", user: null });
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      init?.signal?.throwIfAborted?.();
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }));
    await expect(authenticateCaller("https://example.supabase.co", "publishable", "token"))
      .resolves.toEqual({ outcome: "unavailable", user: null });
  });

  // The other eleven handlers still use `authenticate`. Adding the typed helper
  // must not have changed what they see.
  it("leaves authenticate() returning the user, null on a refusal, and throwing on transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200)));
    await expect(authenticate("https://example.supabase.co", "publishable", "token")).resolves.toEqual(USER);
    vi.stubGlobal("fetch", vi.fn(async () => reply(401)));
    await expect(authenticate("https://example.supabase.co", "publishable", "token")).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => reply(500)));
    await expect(authenticate("https://example.supabase.co", "publishable", "token")).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(authenticate("https://example.supabase.co", "publishable", "token")).rejects.toThrow("fetch failed");
  });
});
