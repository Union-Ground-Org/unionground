// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { personalDateEvents } from "../api/calendar.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

const goodToken = "a".repeat(48);

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// A faithful Response double. A real fetch Response exposes both text() and
// json(); a double that implements only one of them lets a caller change which
// it uses without any test noticing.
function rpcResponse(payload, { status = 200, ok = true } = {}) {
  const body = JSON.stringify(payload);
  return { ok, status, text: async () => body, json: async () => JSON.parse(body) };
}

// BUG-UG-CALENDAR-FEED-TEST-IGNORES-RPC-BEARER-20261020: the deployed
// get_calendar_feed_events is service-role only, so PostgREST refuses a call
// whose apikey or bearer is anything else. This double refuses the same way:
// it answers with the privileged result only when BOTH credentials are the
// selected backend's service key, and otherwise answers 401 like the database.
function serviceOnlyRpc(serviceKey, payload) {
  return vi.fn(async (_url, init) => {
    const headers = init?.headers ?? {};
    if (headers.apikey !== serviceKey || headers.Authorization !== `Bearer ${serviceKey}`) {
      return rpcResponse({ message: "permission denied" }, { status: 401, ok: false });
    }
    return rpcResponse(payload);
  });
}

describe("calendar feed API", () => {
  it("resolves a valid token through the service-role RPC and streams ICS", async () => {
    global.fetch = serviceOnlyRpc("service-role-test-key", {
      valid: true,
      events: [{ id: "evt-1", title: "Chapter meeting", startsAt: "2026-07-30T18:00:00Z", location: "Boston hall", summary: "Update." }],
    });
    const response = responseRecorder();
    await handler({ method: "GET", query: { token: goodToken } }, response);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain("get_calendar_feed_events");
    // Both the apikey and the bearer are the service-role key — the calendar
    // app has no member session; authorization is the opaque token itself.
    expect(global.fetch.mock.calls[0][1].headers.apikey).toBe("service-role-test-key");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer service-role-test-key");
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ p_token: goodToken });
    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/calendar; charset=utf-8");
    expect(response.headers["Cache-Control"]).toBe("private, no-store");
    expect(response.body).toContain("BEGIN:VCALENDAR");
    expect(response.body).toContain("SUMMARY:Chapter meeting");
  });

  // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030.
  it("adds the owner's private dates beside the events, and streams them even when there are no events", async () => {
    global.fetch = serviceOnlyRpc("service-role-test-key", {
      valid: true,
      events: null,
      personalDates: [{ id: "r1", title: "Grading load check", note: "CS 210 final", startsAt: "2099-12-07T14:00:00Z" }],
    });
    const response = responseRecorder();
    await handler({ method: "GET", query: { token: goodToken } }, response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("SUMMARY:Grading load check");
    expect(response.body).toContain("CS 210 final");
  });

  it("turns private dates into 30-minute entries and drops incomplete or non-list input", () => {
    expect(personalDateEvents(null)).toEqual([]);
    expect(personalDateEvents({ id: "r1" })).toEqual([]);
    expect(personalDateEvents([
      { id: "r1", title: "Shift log", startsAt: "2099-11-04T09:00:00Z" },
      { id: "r2", title: "No time" },
      { title: "No id", startsAt: "2099-11-04T09:00:00Z" },
      null,
    ])).toEqual([{ id: "personal-r1", title: "Shift log", startsAt: "2099-11-04T09:00:00Z", location: "", summary: "", durationHours: 0.5 }]);
  });

  it("answers 503, never the feed, when the privileged RPC refuses the credentials it was sent", async () => {
    // The double is keyed to a different service key than the handler holds, so
    // a handler that sent the wrong bearer or apikey would look exactly like this.
    global.fetch = serviceOnlyRpc("some-other-service-key", { valid: true, events: [] });
    const response = responseRecorder();
    await handler({ method: "GET", query: { token: goodToken } }, response);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("BEGIN:VCALENDAR");
  });

  it("rejects short or missing tokens before ever calling the database", async () => {
    global.fetch = vi.fn();
    for (const query of [{}, { token: "short" }, { token: "x".repeat(200) }]) {
      const response = responseRecorder();
      await handler({ method: "GET", query }, response);
      expect(response.statusCode).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown or revoked token, with no internals leaked", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(rpcResponse({ valid: false }));
    const response = responseRecorder();
    await handler({ method: "GET", query: { token: goodToken } }, response);
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("Unknown or revoked calendar link.");
  });

  it("rejects non-GET methods and degrades to 503 when unconfigured or the RPC fails", async () => {
    const post = responseRecorder();
    await handler({ method: "POST", query: { token: goodToken } }, post);
    expect(post.statusCode).toBe(405);

    global.fetch = vi.fn().mockRejectedValueOnce(new Error("down"));
    const failed = responseRecorder();
    await handler({ method: "GET", query: { token: goodToken } }, failed);
    expect(failed.statusCode).toBe(503);

    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const unconfigured = responseRecorder();
    await handler({ method: "GET", query: { token: goodToken } }, unconfigured);
    expect(unconfigured.statusCode).toBe(503);
  });

  // SEC-UG-CALENDAR-KEYSHAPE-LOG-20260817. The failure log used to carry a
  // "keyShape" object — the service-role key's length, its "sb_secret_" prefix
  // class, and a whitespace flag. Each is a confirmed bit about a live
  // credential, written to logs that are read far more widely than the key is.
  // Pin the WHOLE logged object rather than only the absent field: a new
  // key-derived detail under any other name would otherwise land unnoticed.
  it("logs no service-key shape on RPC failure and keeps the response generic", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const serviceRoleKey = "sb_secret_calendar_service_role_value";
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey);
    global.fetch = vi.fn().mockRejectedValueOnce(Object.assign(new Error("down"), { name: "TypeError" }));

    const response = responseRecorder();
    await handler({ method: "GET", query: { token: goodToken } }, response);

    const call = logged.mock.calls.find(([label]) => label === "Calendar feed RPC failed");
    expect(call[1]).toEqual({
      status: null,
      reason: "TypeError",
      cause: null,
      supabaseHost: "project.supabase.co",
    });
    expect(JSON.stringify(call)).not.toContain("keyShape");
    expect(JSON.stringify(call)).not.toContain("sb_secret_");
    expect(JSON.stringify(call)).not.toContain(String(serviceRoleKey.length));
    expect(JSON.stringify(call)).not.toContain(goodToken);
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("Calendar feed is unavailable right now.");
  });
});
