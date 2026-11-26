// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { orderRowsForSyncFairness } from "../api/calendar-sync.js";
import { decryptRefreshToken, encryptRefreshToken } from "../api/_lib/calendarOAuth.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.body = body || ""; },
  };
}

function jsonBody(response) {
  return JSON.parse(response.body || "{}");
}

function rpcResponse(payload, { status = 200, ok = true } = {}) {
  const body = JSON.stringify(payload);
  return { ok, status, text: async () => body, json: async () => JSON.parse(body) };
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  vi.stubEnv("CRON_SECRET", "cron-secret-value-32-characters-min");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("calendar sync API", () => {
  it("no-ops with activation_unset when no provider app is registered", async () => {
    global.fetch = vi.fn();
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);
    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toEqual({ ok: true, synced: 0, skipped: "activation_unset" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects callers without the cron secret", async () => {
    const response = responseRecorder();
    await handler({ method: "POST", headers: {} }, response);
    expect(response.statusCode).toBe(403);
  });

  it("resolves the Microsoft mailbox before requesting its schedule", async () => {
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_CLIENT_ID", "microsoft-client-id");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_CLIENT_SECRET", "microsoft-client-secret-value");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_TENANT", "organizations");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const wrapped = encryptRefreshToken(process.env, "saas", "provider-refresh-token");
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse([{
        provider: "microsoft",
        refreshTokenCiphertext: wrapped,
        stewardId: "steward-1",
      }]))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "short-lived-access-token",
          refresh_token: "rotated-provider-refresh-token",
          scope: "offline_access User.Read Calendars.ReadBasic",
        }),
      })
      .mockResolvedValueOnce(rpcResponse({ ok: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ mail: "steward@example.org", userPrincipalName: "fallback@example.org" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [{ scheduleItems: [] }] }),
      })
      .mockResolvedValueOnce(rpcResponse({ ok: true }));
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);
    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toEqual({
      ok: true,
      synced: 1,
      failed: 0,
      skipped_unset: 0,
      skipped_budget: 0,
    });
    const rotateCall = global.fetch.mock.calls.find((call) => String(call[0]).includes("upsert_steward_calendar_oauth_token"));
    const rotated = JSON.parse(rotateCall[1].body);
    expect(rotated.p_refresh_token_ciphertext).not.toContain("rotated-provider-refresh-token");
    expect(decryptRefreshToken(
      process.env,
      "saas",
      rotated.p_refresh_token_ciphertext,
    )).toBe("rotated-provider-refresh-token");
    expect(rotated.p_scopes).toBe("offline_access User.Read Calendars.ReadBasic");
    const profileCall = global.fetch.mock.calls.find((call) => String(call[0]).includes("/v1.0/me?$select="));
    expect(profileCall).toBeTruthy();
    const scheduleCall = global.fetch.mock.calls.find((call) => String(call[0]).includes("getSchedule"));
    expect(JSON.parse(scheduleCall[1].body).schedules).toEqual(["steward@example.org"]);
  });

  it.each([
    ["google", { calendars: { primary: { errors: [{ reason: "notFound" }] } } }],
    ["microsoft", { value: [{ error: { responseCode: "ErrorMailRecipientNotFound" } }] }],
  ])("records an embedded %s calendar error without reporting a successful busy refresh", async (provider, payload) => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "google-client-secret-value");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_CLIENT_ID", "microsoft-client-id");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_CLIENT_SECRET", "microsoft-client-secret-value");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_TENANT", "organizations");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const wrapped = encryptRefreshToken(process.env, "saas", "provider-refresh-token");
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse([{ provider, refreshTokenCiphertext: wrapped, stewardId: "steward-unavailable" }]))
      .mockResolvedValueOnce(rpcResponse({ access_token: "short-lived-access-token" }));
    if (provider === "microsoft") global.fetch.mockResolvedValueOnce(rpcResponse({ mail: "steward@example.test" }));
    global.fetch.mockResolvedValueOnce(rpcResponse(payload)).mockResolvedValueOnce(rpcResponse({ ok: true }));
    const response = responseRecorder();
    await handler({
      method: "POST", headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);
    expect(response.statusCode).toBe(207);
    expect(jsonBody(response)).toMatchObject({ ok: false, synced: 0, failed: 1 });
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes("set_calendar_busy"))).toBe(false);
    const errorCall = global.fetch.mock.calls.find(([url]) => String(url).includes("mark_calendar_connection_error"));
    expect(errorCall).toBeTruthy();
    expect(JSON.parse(errorCall[1].body)).toEqual({ p_steward: "steward-unavailable", p_provider: provider });
  });

  it("moves only rows actually attempted behind untouched rows", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      stewardId: `steward-${String(index).padStart(2, "0")}`,
      provider: "google",
      lastSyncAttemptAt: null,
    }));
    const attempted = new Set();

    for (let run = 0; run < 4; run += 1) {
      const ordered = orderRowsForSyncFairness(rows);
      const processed = ordered.slice(0, 5);
      for (const row of processed) {
        attempted.add(row.stewardId);
        row.lastSyncAttemptAt = new Date(Date.UTC(2026, 7, 27 + run, 12)).toISOString();
      }
    }

    expect(attempted).toEqual(new Set(rows.map((row) => row.stewardId)));
    expect(orderRowsForSyncFairness(null)).toEqual([]);
    expect(orderRowsForSyncFairness([rows[0]])).toEqual([rows[0]]);
  });

  it("fails closed when a multi-row inventory predates the persistent fairness cursor", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "google-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    global.fetch = vi.fn().mockResolvedValueOnce(rpcResponse([
      { provider: "google", stewardId: "steward-a", refreshTokenCiphertext: "wrapped-a" },
      { provider: "google", stewardId: "steward-b", refreshTokenCiphertext: "wrapped-b" },
    ]));

    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);

    expect(response.statusCode).toBe(503);
    expect(jsonBody(response)).toEqual({ ok: false, error: "fairness_cursor_unavailable" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("reconciles an explicitly consented provider event window with opaque identifiers", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "google-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const wrapped = encryptRefreshToken(process.env, "saas", "provider-refresh-token");
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse([{
        provider: "google",
        refreshTokenCiphertext: wrapped,
        scopes: "https://www.googleapis.com/auth/calendar.readonly",
        stewardId: "steward-import",
      }]))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "access-token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ calendars: { primary: { busy: [] } } }),
      })
      .mockResolvedValueOnce(rpcResponse({ ok: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [{
          id: "provider-event-id-must-not-be-stored",
          summary: "private title",
          start: { dateTime: "2026-09-01T12:00:00Z" },
          end: { dateTime: "2026-09-01T13:00:00Z" },
          updated: "2026-08-30T12:00:00Z",
        }] }),
      })
      .mockResolvedValueOnce(rpcResponse({ ok: true, imported: 1 }));
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);
    expect(response.statusCode).toBe(200);
    const replaceCall = global.fetch.mock.calls.find((call) => String(call[0]).includes("replace_calendar_import_events"));
    const body = JSON.parse(replaceCall[1].body);
    expect(body.p_events).toEqual([expect.objectContaining({
      eventKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      startsAt: "2026-09-01T12:00:00.000Z",
    })]);
    expect(JSON.stringify(body)).not.toContain("provider-event-id-must-not-be-stored");
    expect(JSON.stringify(body)).not.toContain("private title");
  });

  it("pages event imports and clears only the bounded import view above 500 events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "google-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const wrapped = encryptRefreshToken(process.env, "saas", "provider-refresh-token");
    const events = (offset, count) => Array.from({ length: count }, (_, index) => ({
      id: `event-${offset + index}`,
      start: { dateTime: "2026-09-01T12:00:00Z" },
      end: { dateTime: "2026-09-01T13:00:00Z" },
      updated: "2026-08-30T12:00:00Z",
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse([{
        provider: "google",
        refreshTokenCiphertext: wrapped,
        scopes: "https://www.googleapis.com/auth/calendar.readonly",
        stewardId: "steward-large-calendar",
      }]))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "access-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ calendars: { primary: { busy: [] } } }) })
      .mockResolvedValueOnce(rpcResponse({ ok: true }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: events(0, 200), nextPageToken: "page-2" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: events(200, 200), nextPageToken: "page-3" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: events(400, 101) }) })
      .mockResolvedValueOnce(rpcResponse({ ok: true, cleared: true }));
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);
    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toEqual({
      ok: true, synced: 1, failed: 0, skipped_unset: 0, skipped_budget: 0,
    });
    const eventCalls = global.fetch.mock.calls.filter((call) => String(call[0]).includes("/calendar/v3/calendars/primary/events"));
    expect(eventCalls).toHaveLength(3);
    expect(String(eventCalls[1][0])).toContain("pageToken=page-2");
    expect(String(eventCalls[2][0])).toContain("pageToken=page-3");
    expect(global.fetch.mock.calls.some((call) => String(call[0]).includes("clear_calendar_import_events"))).toBe(true);
    expect(global.fetch.mock.calls.some((call) => String(call[0]).includes("mark_calendar_connection_error"))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("[calendar-sync]", {
      kind: "event_import_capacity_exceeded", provider: "google",
    });
  });

  it("preserves refreshed free/busy and records a secondary event-import failure", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "google-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const wrapped = encryptRefreshToken(process.env, "saas", "provider-refresh-token");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse([{
        provider: "google",
        refreshTokenCiphertext: wrapped,
        scopes: "https://www.googleapis.com/auth/calendar.readonly",
        stewardId: "steward-import-retry",
      }]))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "access-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ calendars: { primary: { busy: [] } } }) })
      .mockResolvedValueOnce(rpcResponse({ ok: true }))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "unavailable" }) })
      .mockResolvedValueOnce(rpcResponse({ ok: true, status: "error" }));
    const response = responseRecorder();

    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);

    expect(response.statusCode).toBe(207);
    expect(jsonBody(response)).toEqual({
      ok: false, synced: 1, failed: 0, event_import_failed: 1,
      skipped_unset: 0, skipped_budget: 0,
    });
    expect(global.fetch.mock.calls.some((call) => String(call[0]).includes("set_calendar_busy"))).toBe(true);
    expect(global.fetch.mock.calls.some((call) => String(call[0]).includes("mark_calendar_import_error"))).toBe(true);
    expect(global.fetch.mock.calls.some((call) => String(call[0]).includes("mark_calendar_connection_error"))).toBe(false);
    const importErrorCall = global.fetch.mock.calls.find((call) => (
      String(call[0]).includes("mark_calendar_import_error")
    ));
    expect(importErrorCall).toBeTruthy();
    expect(JSON.parse(importErrorCall[1].body)).toEqual({
      p_steward: "steward-import-retry",
      p_provider: "google",
    });
    expect(errorSpy).toHaveBeenCalledWith("[calendar-sync]", {
      kind: "event_import_failed", provider: "google", reason: "calendar_import_http",
    });
  });

  it("revokes a dead provider grant and skips it next run without a provider call", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "google-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const wrapped = encryptRefreshToken(process.env, "saas", "revoked-refresh-token");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse([{
        provider: "google",
        refreshTokenCiphertext: wrapped,
        stewardId: "steward-revoked",
        status: "active",
      }]))
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      })
      .mockResolvedValueOnce(rpcResponse({ ok: true, provider: "google", status: "revoked" }));
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toEqual({
      ok: true,
      synced: 0,
      failed: 0,
      revoked: 1,
      skipped_unset: 0,
      skipped_budget: 0,
    });
    const revokeCall = global.fetch.mock.calls.find((call) => (
      String(call[0]).includes("mark_calendar_connection_revoked")
    ));
    expect(JSON.parse(revokeCall[1].body)).toEqual({
      p_steward: "steward-revoked",
      p_provider: "google",
    });
    expect(global.fetch.mock.calls.some((call) => (
      String(call[0]).includes("mark_calendar_connection_error")
    ))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("[calendar-sync]", {
      kind: "row_revoked", provider: "google", reason: "invalid_grant",
    });

    // The connection the first run revoked must never reach the provider again.
    global.fetch = vi.fn().mockResolvedValueOnce(rpcResponse([{
      provider: "google",
      refreshTokenCiphertext: wrapped,
      stewardId: "steward-revoked",
      status: "revoked",
    }]));
    const second = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, second);

    expect(second.statusCode).toBe(200);
    expect(jsonBody(second)).toEqual({
      ok: true,
      synced: 0,
      failed: 0,
      skipped_unset: 0,
      skipped_revoked: 1,
      skipped_budget: 0,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls.some((call) => (
      String(call[0]).includes("oauth2.googleapis.com/token")
    ))).toBe(false);
  });

  it("keeps a transient refresh failure retryable instead of revoking the grant", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "google-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const wrapped = encryptRefreshToken(process.env, "saas", "provider-refresh-token");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse([{
        provider: "google",
        refreshTokenCiphertext: wrapped,
        stewardId: "steward-transient",
      }]))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: "temporarily_unavailable" }),
      })
      .mockResolvedValueOnce(rpcResponse({ ok: true }));
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);

    expect(response.statusCode).toBe(207);
    expect(jsonBody(response)).toEqual({
      ok: false,
      synced: 0,
      failed: 1,
      skipped_unset: 0,
      skipped_budget: 0,
    });
    const markCall = global.fetch.mock.calls.find((call) => (
      String(call[0]).includes("mark_calendar_connection_error")
    ));
    expect(JSON.parse(markCall[1].body)).toEqual({
      p_steward: "steward-transient",
      p_provider: "google",
    });
    expect(global.fetch.mock.calls.some((call) => (
      String(call[0]).includes("mark_calendar_connection_revoked")
    ))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("[calendar-sync]", expect.objectContaining({
      kind: "row_failed",
      provider: "google",
      reason: "refresh_failed",
    }));
  });

  it("logs an unwrap failure without contacting the provider", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "google-client-secret-value");
    const wrapped = encryptRefreshToken({
      CALENDAR_OAUTH_TOKEN_WRAP_KEY: "old-wrap-key-value-32-characters-long!",
    }, "saas", "provider-refresh-token");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "new-wrap-key-value-32-characters-long!");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse([{
        provider: "google",
        refreshTokenCiphertext: wrapped,
        stewardId: "steward-key-rotation",
      }]))
      .mockResolvedValueOnce(rpcResponse({ ok: true }));
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("[calendar-sync]", {
      kind: "row_failed",
      provider: "google",
      reason: "unwrap_failed",
    });
    expect(global.fetch.mock.calls.some((call) => String(call[0]).includes("oauth2.googleapis.com/token"))).toBe(false);
  });

  it("reports and logs rows skipped when the invocation budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "google-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const wrapped = encryptRefreshToken(process.env, "saas", "provider-refresh-token");
    const rows = ["one", "two", "three"].map((id) => ({
      provider: "google",
      refreshTokenCiphertext: wrapped,
      stewardId: `steward-${id}`,
      lastSyncAttemptAt: null,
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse(rows))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "access-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ calendars: { primary: { busy: [] } } }) })
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(51_000);
        return rpcResponse({ ok: true });
      });
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);
    expect(jsonBody(response)).toEqual({
      ok: true,
      synced: 1,
      failed: 0,
      skipped_unset: 0,
      skipped_budget: 2,
    });
    expect(errorSpy).toHaveBeenCalledWith("[calendar-sync]", {
      kind: "budget_exhausted",
      processed: 1,
      remaining: 2,
    });
  });

  it("advances the timed-out row during the reserved cleanup window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "google-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const wrapped = encryptRefreshToken(process.env, "saas", "provider-refresh-token");
    const rows = ["one", "two"].map((id) => ({
      provider: "google",
      refreshTokenCiphertext: wrapped,
      stewardId: `steward-${id}`,
      lastSyncAttemptAt: null,
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse(rows))
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(46_000);
        return { ok: true, json: async () => ({ access_token: "access-token" }) };
      })
      .mockResolvedValueOnce(rpcResponse({ ok: true }));

    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer cron-secret-value-32-characters-min" },
    }, response);

    expect(jsonBody(response)).toEqual({
      ok: true,
      synced: 0,
      failed: 0,
      skipped_unset: 0,
      skipped_budget: 2,
    });
    const cursorCall = global.fetch.mock.calls.find((call) => (
      String(call[0]).includes("mark_steward_calendar_sync_attempt")
    ));
    expect(JSON.parse(cursorCall[1].body)).toEqual({
      p_steward: "steward-one",
      p_provider: "google",
    });
    expect(errorSpy).toHaveBeenCalledWith("[calendar-sync]", {
      kind: "budget_exhausted",
      processed: 0,
      remaining: 2,
    });
  });
});
