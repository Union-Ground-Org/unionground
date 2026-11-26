// @vitest-environment node
// REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001 (CR-090): organization OAuth,
// the scheduled copy job and the administrator status route.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/google-activations.js";
import { unauthenticatedCronTickHeaders, vercelCronTickHeaders } from "./helpers/vercelCronTick.js";
import {
  applyCalendarOperation,
  buildOrganizationCalendarAuthorizationUrl,
  exchangeOrganizationCalendarCode,
  googleEventBody,
  organizationCalendarConfig,
  organizationCalendarEnvNames,
  refreshOrganizationCalendarToken,
  runOrganizationCalendarPush,
} from "../api/_lib/organizationCalendar.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const backendUrl = SUPABASE_ORIGIN;
const redirectUri = `${PORTAL_ORIGIN}/api/google-activations?action=calendar-callback`;
const cronSecret = "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx";
// The starting browser's binding cookie (#9557); a callback without it is refused.
const binding = "B".repeat(43);
const bindingCookie = `org_calendar_oauth_binding=${binding}`;
let fetcher;

function reply(body, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

async function invoke({ method = "POST", query = {}, headers = {}, body = "{}" } = {}) {
  const response = {
    statusCode: 0, headers: {}, body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body = value === undefined ? undefined : JSON.parse(value); },
  };
  await handler({ method, query, body, headers: {
    host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer admin-token", ...headers,
  } }, response);
  return response;
}

const config = { clientId: "org-calendar-client", clientSecret: "s".repeat(24), redirectUri };

beforeEach(() => {
  for (const [key, value] of Object.entries({
    VITE_SUPABASE_URL: backendUrl, UNIONGROUND_SUPABASE_PROJECT_REF: "psgfictionalproject", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture", CRON_SECRET: cronSecret,
    GOOGLE_ORG_CALENDAR_CLIENT_ID: config.clientId, GOOGLE_ORG_CALENDAR_CLIENT_SECRET: config.clientSecret,
    GOOGLE_ORG_CALENDAR_REDIRECT_URI: redirectUri,
  })) vi.stubEnv(key, value);
  fetcher = vi.fn(() => { throw new Error("Unexpected external request"); });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("configuration", () => {
  it("is unset without a client id, a real secret and an https redirect", () => {
    expect(organizationCalendarConfig("saas", {})).toBeNull();
    expect(organizationCalendarConfig("saas", { GOOGLE_ORG_CALENDAR_CLIENT_ID: "a", GOOGLE_ORG_CALENDAR_CLIENT_SECRET: "short", GOOGLE_ORG_CALENDAR_REDIRECT_URI: redirectUri })).toBeNull();
    expect(organizationCalendarConfig("saas", { GOOGLE_ORG_CALENDAR_CLIENT_ID: "a", GOOGLE_ORG_CALENDAR_CLIENT_SECRET: "s".repeat(20), GOOGLE_ORG_CALENDAR_REDIRECT_URI: "http://x" })).toBeNull();
    expect(organizationCalendarConfig("saas", process.env)).toEqual(config);
    expect(organizationCalendarEnvNames("demo").every((name) => name.startsWith("SAMPLE_"))).toBe(true);
  });

  it("asks Google for calendar.events with PKCE and offline access", () => {
    const url = new URL(buildOrganizationCalendarAuthorizationUrl({ clientId: "c", redirectUri, state: "st", codeChallenge: "ch" }));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/calendar.events");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });
});

describe("token handling", () => {
  it("refuses a grant without the calendar.events scope or a refresh token", async () => {
    const local = vi.fn()
      .mockResolvedValueOnce(reply({ access_token: "a", refresh_token: "r".repeat(30), scope: "openid email" }))
      .mockResolvedValueOnce(reply({ access_token: "a" }))
      .mockResolvedValueOnce(reply({ access_token: "a", refresh_token: "r".repeat(30), scope: "openid https://www.googleapis.com/auth/calendar.events", id_token: "x.y.z" }));
    await expect(exchangeOrganizationCalendarCode({ fetchImpl: local, config, code: "c", codeVerifier: "v", redirectUri })).rejects.toThrow(/scope_not_granted/);
    await expect(exchangeOrganizationCalendarCode({ fetchImpl: local, config, code: "c", codeVerifier: "v", redirectUri })).rejects.toThrow(/code_exchange_failed/);
    expect(await exchangeOrganizationCalendarCode({ fetchImpl: local, config, code: "c", codeVerifier: "v", redirectUri })).toMatchObject({ refreshToken: "r".repeat(30), idToken: "x.y.z" });
  });

  it("separates a revoked grant from a transient refresh failure", async () => {
    const local = vi.fn()
      .mockResolvedValueOnce(reply({ error: "invalid_grant" }, 400))
      .mockResolvedValueOnce(reply({ error: "server_error" }, 500))
      .mockResolvedValueOnce(reply({ access_token: "fresh" }));
    await expect(refreshOrganizationCalendarToken({ fetchImpl: local, config, refreshToken: "r" })).rejects.toMatchObject({ code: "grant_revoked" });
    await expect(refreshOrganizationCalendarToken({ fetchImpl: local, config, refreshToken: "r" })).rejects.toMatchObject({ code: "token_refresh_failed" });
    expect(await refreshOrganizationCalendarToken({ fetchImpl: local, config, refreshToken: "r" })).toBe("fresh");
  });
});

describe("calendar operations", () => {
  const upsert = {
    op: "upsert", eventId: "evt-1", googleEventId: null, calendarId: "team@group.calendar.google.com", contentHash: "a".repeat(32),
    event: { title: "Rally", startsAt: "2026-10-05T17:00:00Z", location: "Hall", summary: "Bring signs" },
  };

  it("builds a two-hour event with only title, time, place, summary and our event id", () => {
    expect(googleEventBody(upsert)).toEqual({
      summary: "Rally",
      description: "Bring signs\n\nShared from Union Ground.",
      location: "Hall",
      start: { dateTime: "2026-10-05T17:00:00.000Z" },
      end: { dateTime: "2026-10-05T19:00:00.000Z" },
      extendedProperties: { private: { unionGroundEventId: "evt-1" } },
    });
    expect(() => googleEventBody({ ...upsert, event: { ...upsert.event, startsAt: "nope" } })).toThrow(/invalid_event_time/);
  });

  it("sends the stored end instant when updating the mapped Google event", async () => {
    const local = vi.fn().mockResolvedValueOnce(reply({ id: "gcal1" }));
    const operation = {
      ...upsert,
      googleEventId: "gcal1",
      event: { ...upsert.event, endsAt: "2026-10-05T14:30:00-04:00" },
    };
    await expect(applyCalendarOperation({ fetchImpl: local, accessToken: "t", operation })).resolves.toEqual({ outcome: "upserted", googleEventId: "gcal1" });
    expect(local).toHaveBeenCalledTimes(1);
    expect(local.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(local.mock.calls[0][1].body)).toMatchObject({
      start: { dateTime: "2026-10-05T17:00:00.000Z" },
      end: { dateTime: "2026-10-05T18:30:00.000Z" },
    });
  });

  it.each([
    ["2026-10-05T18:30:00.1Z", "2026-10-05T18:30:00.100Z"],
    ["2026-10-05T18:30:00.123456Z", "2026-10-05T18:30:00.123Z"],
    ["2026-10-05T14:30:00.123456-04:00", "2026-10-05T18:30:00.123Z"],
    ["2026-10-05T20:30:00.123456+0200", "2026-10-05T18:30:00.123Z"],
  ])("uses the instant in end %s", (endsAt, expected) => {
    expect(googleEventBody({ ...upsert, event: { ...upsert.event, endsAt } }).end.dateTime).toBe(expected);
  });

  it.each([
    null, "invalid", "2026-10-05T18:30:00", "2026-10-06", "2026-10-05T17:00:00Z", "2026-10-05T16:55:00Z",
  ])("falls back to two hours for end %s", (endsAt) => {
    expect(googleEventBody({ ...upsert, event: { ...upsert.event, endsAt } }).end.dateTime).toBe("2026-10-05T19:00:00.000Z");
  });

  it("creates, updates, re-creates a vanished copy and deletes idempotently", async () => {
    const local = vi.fn()
      .mockImplementationOnce(async (_url, init) => reply({ id: JSON.parse(init.body).id }))
      .mockResolvedValueOnce(reply({ id: "gcal1" }))
      .mockResolvedValueOnce(reply({ error: { code: 404 } }, 404))
      .mockImplementationOnce(async (_url, init) => reply({ id: JSON.parse(init.body).id }))
      .mockResolvedValueOnce(reply(undefined, 410))
      .mockResolvedValueOnce(reply({}, 403));
    const created = await applyCalendarOperation({ fetchImpl: local, accessToken: "t", operation: upsert });
    expect(created).toEqual({ outcome: "upserted", googleEventId: JSON.parse(local.mock.calls[0][1].body).id });
    expect(local.mock.calls[0][0]).toBe("https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events");
    expect(local.mock.calls[0][1].method).toBe("POST");
    expect(await applyCalendarOperation({ fetchImpl: local, accessToken: "t", operation: { ...upsert, googleEventId: "gcal1" } })).toEqual({ outcome: "upserted", googleEventId: "gcal1" });
    expect(local.mock.calls[1][1].method).toBe("PUT");
    const recreated = await applyCalendarOperation({ fetchImpl: local, accessToken: "t", operation: { ...upsert, googleEventId: "gone" } });
    expect(recreated).toEqual({ outcome: "upserted", googleEventId: JSON.parse(local.mock.calls[3][1].body).id });
    expect(await applyCalendarOperation({ fetchImpl: local, accessToken: "t", operation: { op: "delete", eventId: "evt-1", googleEventId: "gcal1", calendarId: "primary" } })).toEqual({ outcome: "deleted" });
    await expect(applyCalendarOperation({ fetchImpl: local, accessToken: "t", operation: { op: "delete", eventId: "evt-1", googleEventId: "gcal1", calendarId: "primary" } })).rejects.toMatchObject({ code: "calendar_forbidden" });
  });

  it("maps provider failures to short codes", async () => {
    for (const [status, code] of [[429, "calendar_rate_limited"], [500, "calendar_unavailable"], [400, "calendar_rejected"]]) {
      const local = vi.fn().mockResolvedValueOnce(reply({}, status));
      await expect(applyCalendarOperation({ fetchImpl: local, accessToken: "t", operation: upsert })).rejects.toMatchObject({ code });
    }
    const missingId = vi.fn().mockResolvedValueOnce(reply({}));
    await expect(applyCalendarOperation({ fetchImpl: missingId, accessToken: "t", operation: upsert })).rejects.toMatchObject({ code: "calendar_unavailable" });
  });

  it("runs a pass: records each result, a failing item and token failures without leaking text", async () => {
    const calls = [];
    const service = vi.fn(async (name, args) => {
      calls.push([name, args]);
      if (name === "list_organization_calendar_push_work") return [
        { organizationId: "org-a", calendarId: "primary", operations: [upsert, { ...upsert, eventId: "evt-2" }, { op: "delete", eventId: "evt-3", googleEventId: "old", calendarId: "primary" }] },
        { organizationId: "org-b", calendarId: "primary", operations: [upsert] },
        { organizationId: "org-c", calendarId: "primary", operations: [upsert] },
      ];
      if (name === "read_organization_calendar_refresh_token") {
        if (args.p_organization_id === "org-c") throw new Error("vault");
        return { refreshToken: "refresh" };
      }
      return null;
    });
    const local = vi.fn(async (url, options) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return String(options.body).includes("refresh") && calls.at(-1)?.[1]?.p_organization_id === "org-b"
          ? reply({ error: "invalid_grant" }, 400)
          : reply({ access_token: "access" });
      }
      if (options.method === "DELETE") return reply(undefined, 204);
      return JSON.parse(options.body).extendedProperties.private.unionGroundEventId === "evt-2" ? reply({}, 500) : reply({ id: JSON.parse(options.body).id });
    });
    const summary = await runOrganizationCalendarPush({ service, config, fetchImpl: local });
    expect(summary).toEqual({ organizations: 3, upserted: 1, deleted: 1, failed: 1, tokenFailures: 2, skippedBudget: 0 });
    const results = calls.filter(([name]) => name === "record_organization_calendar_push_result").map(([, args]) => [args.p_event_id, args.p_outcome, args.p_error_code]);
    expect(results).toEqual([["evt-1", "upserted", null], ["evt-2", "failed", "calendar_unavailable"], ["evt-3", "deleted", null]]);
    const runs = calls.filter(([name]) => name === "record_organization_calendar_push_run").map(([, args]) => [args.p_organization_id, args.p_status, args.p_error_code]);
    expect(runs).toEqual([["org-a", "ok", null], ["org-b", "error", "grant_revoked"], ["org-c", "error", "token_refresh_failed"]]);
    expect(JSON.stringify(calls)).not.toContain("Bring signs");
  });

  it("stops starting work when the time budget is spent", async () => {
    let clock = 0;
    const service = vi.fn(async (name) => name === "list_organization_calendar_push_work"
      ? [{ organizationId: "org-a", operations: [] }, { organizationId: "org-b", operations: [] }]
      : { refreshToken: "r" });
    const local = vi.fn(async () => { clock += 60_000; return reply({ access_token: "a" }); });
    const summary = await runOrganizationCalendarPush({ service, config, fetchImpl: local, now: () => clock });
    expect(summary).toMatchObject({ organizations: 1, skippedBudget: 1 });
  });
});

describe("google-activations route", () => {
  it("requires the cron secret for a sync and skips cleanly while unset", async () => {
    expect((await invoke({ query: { action: "calendar-sync" } })).statusCode).toBe(401);
    vi.stubEnv("GOOGLE_ORG_CALENDAR_CLIENT_ID", "");
    const unset = await invoke({ query: { action: "calendar-sync" }, headers: { origin: "", authorization: `Bearer ${cronSecret}` } });
    expect(unset).toMatchObject({ statusCode: 200, body: { ok: true, skipped: "activation_unset" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("runs the documented Vercel cron GET (the bearer, no x-vercel-cron marker) through the service work list", async () => {
    fetcher.mockResolvedValueOnce(reply([]));
    const response = await invoke({ method: "GET", headers: { origin: "", ...vercelCronTickHeaders(cronSecret, "*/15 * * * *") } });
    expect(response).toMatchObject({ statusCode: 200, body: { ok: true, organizations: 0 } });
    expect(fetcher.mock.calls[0][0]).toBe(`${backendUrl}/rest/v1/rpc/list_organization_calendar_push_work`);
    fetcher.mockResolvedValueOnce(reply({ message: "down" }, 500));
    expect((await invoke({ method: "GET", headers: { origin: "", ...vercelCronTickHeaders(cronSecret, "*/15 * * * *") } })).statusCode).toBe(502);
    // Without the cron bearer the scheduled GET answers 401 and never runs,
    // whatever cron headers it carries.
    expect(await invoke({ method: "GET" })).toMatchObject({ statusCode: 401, body: { error: "unauthorized" } });
    expect((await invoke({ method: "GET", headers: { origin: "", authorization: "", ...unauthenticatedCronTickHeaders("*/15 * * * *") } })).statusCode).toBe(401);
    expect((await invoke({ method: "GET", headers: { origin: "", ...vercelCronTickHeaders("not-the-secret", "*/15 * * * *"), "x-vercel-cron": "1" } })).statusCode).toBe(401);
    // A GET naming any other action is still not a scheduled tick.
    expect((await invoke({ method: "GET", query: { action: "status" }, headers: { origin: "", ...vercelCronTickHeaders(cronSecret, "*/15 * * * *") } })).statusCode).toBe(405);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses an untrusted origin and other methods, reads an array action, and answers 503 when status is unavailable", async () => {
    expect(await invoke({ query: { action: "status" }, headers: { origin: "https://attacker.invalid" } })).toMatchObject({ statusCode: 403, body: { error: "untrusted-origin" } });
    expect(await invoke({ method: "DELETE", query: { action: "status" } })).toMatchObject({ statusCode: 405, body: { error: "method-not-allowed" } });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(reply({ message: "down" }, 500));
    expect(await invoke({ query: { action: ["status", "calendar-start"] } })).toMatchObject({ statusCode: 503, body: { error: "unavailable" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${backendUrl}/rest/v1/rpc/get_organization_calendar_push_status`);
  });

  it("returns the administrator status with configured flags and no secrets", async () => {
    fetcher.mockResolvedValueOnce(reply({ organizationId: "org-a", enabled: true, scope: "public_events", connection: null, copiedEvents: 0, failingEvents: 0 }));
    const response = await invoke({ query: { action: "status" } });
    expect(response.statusCode).toBe(200);
    // Union Ground has no membership card, so the status carries no wallet.
    expect(response.body).toEqual({
      calendar: { configured: true, organizationId: "org-a", enabled: true, scope: "public_events", connection: null, copiedEvents: 0, failingEvents: 0 },
    });
    expect(JSON.stringify(response.body)).not.toContain(config.clientSecret);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer admin-token");
    fetcher.mockResolvedValueOnce(reply({ code: "42501" }, 403));
    expect(await invoke({ query: { action: "status" } })).toMatchObject({ statusCode: 403, body: { error: "not-authorized" } });
    expect((await invoke({ query: { action: "status" }, headers: { authorization: "" } })).statusCode).toBe(401);
    expect((await invoke({ query: { action: "nope" } })).statusCode).toBe(404);
  });

  it("starts OAuth with hashed state stored under the administrator's own token", async () => {
    fetcher.mockResolvedValueOnce(reply({ organizationId: "org-a", status: "requested" }));
    const response = await invoke({ query: { action: "calendar-start" } });
    expect(response.statusCode).toBe(200);
    const consent = new URL(response.body.authorizationUrl);
    const saved = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(fetcher.mock.calls[0][0]).toBe(`${backendUrl}/rest/v1/rpc/begin_organization_calendar_oauth`);
    const startedBinding = /^org_calendar_oauth_binding=([A-Za-z0-9_-]{43});/.exec(response.headers["Set-Cookie"])[1];
    expect(saved.p_state_hash).toBe(createHash("sha256").update(`${consent.searchParams.get("state")}.${startedBinding}`).digest("hex"));
    expect(saved.p_redirect_uri).toBe(redirectUri);
    expect(consent.searchParams.get("code_challenge")).toBe(createHash("sha256").update(saved.p_code_verifier).digest("base64url"));
    fetcher.mockResolvedValueOnce(reply({ code: "42501" }, 403));
    expect((await invoke({ query: { action: "calendar-start" } })).statusCode).toBe(403);
    vi.stubEnv("GOOGLE_ORG_CALENDAR_CLIENT_SECRET", "");
    expect(await invoke({ query: { action: "calendar-start" } })).toMatchObject({ statusCode: 409, body: { error: "activation-unset" } });
  });

  it("completes the callback through claim, exchange and service completion", async () => {
    const idToken = ["e30", Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: config.clientId, exp: Math.floor(Date.now() / 1000) + 300, email: "Union.Office@example.org", email_verified: true })).toString("base64url"), "sig"].join(".");
    fetcher
      .mockResolvedValueOnce(reply({ organizationId: "org-a", userId: "admin-1", codeVerifier: "v".repeat(64), redirectUri }))
      .mockResolvedValueOnce(reply({ access_token: "a", refresh_token: "r".repeat(40), scope: "openid email https://www.googleapis.com/auth/calendar.events", id_token: idToken }))
      .mockResolvedValueOnce(reply({ status: "connected" }));
    const response = await invoke({ method: "GET", query: { action: "calendar-callback", code: "code", state: "state" }, headers: { origin: "", cookie: bindingCookie } });
    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toBe(`${PORTAL_ORIGIN}/m/integrations?calendar_push=connected`);
    const completion = JSON.parse(fetcher.mock.calls[2][1].body);
    expect(completion).toMatchObject({ p_organization_id: "org-a", p_user_id: "admin-1", p_account_email: "union.office@example.org" });
  });

  it("redirects a refused callback without logging the code or state", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = await invoke({ method: "GET", query: { action: "calendar-callback", error: "access_denied" }, headers: { origin: "" } });
    expect(missing.headers.Location).toBe(`${PORTAL_ORIGIN}/m/integrations?calendar_push=failed`);
    fetcher.mockResolvedValueOnce(reply({ organizationId: "org-a", userId: "admin-1", codeVerifier: "v".repeat(64), redirectUri: "https://evil.invalid/cb" }));
    const mismatch = await invoke({ method: "GET", query: { action: "calendar-callback", code: "secret-code", state: "secret-state" }, headers: { origin: "", cookie: bindingCookie } });
    expect(mismatch.headers.Location).toContain("calendar_push=failed");
    fetcher.mockResolvedValueOnce(reply({ organizationId: "org-a", userId: "admin-1", codeVerifier: "v".repeat(64), redirectUri }))
      .mockResolvedValueOnce(reply({ access_token: "a", refresh_token: "r".repeat(40), scope: "openid email" }));
    const narrow = await invoke({ method: "GET", query: { action: "calendar-callback", code: "secret-code", state: "secret-state" }, headers: { origin: "", cookie: bindingCookie } });
    expect(narrow.headers.Location).toContain("calendar_push=failed");
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret-code|secret-state/);
    expect(spy.mock.calls.map((args) => args[1].reason)).toEqual(["provider_denied", "redirect_mismatch", "scope_not_granted"]);
    vi.stubEnv("GOOGLE_ORG_CALENDAR_REDIRECT_URI", "");
    const unset = await invoke({ method: "GET", query: { action: "calendar-callback", code: "c", state: "s" }, headers: { origin: "" } });
    expect(unset.headers.Location).toBe(`${PORTAL_ORIGIN}/m/integrations?calendar_push=unset`);
  });
});
