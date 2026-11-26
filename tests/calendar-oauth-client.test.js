// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  loadCalendarOAuthStatus,
  startCalendarOAuth,
} from "../src/lib/calendarOAuthClient.js";

function client({ token = "member-jwt", error = null } = {}) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: token ? { access_token: token } : null },
        error,
      }),
    },
  };
}

function response(payload, { ok = true, status = 200, jsonError = false } = {}) {
  return {
    ok,
    status,
    json: jsonError
      ? vi.fn().mockRejectedValue(new Error("invalid json"))
      : vi.fn().mockResolvedValue(payload),
  };
}

describe("calendar OAuth browser client", () => {
  it("requires an authenticated session before calling the endpoint", async () => {
    const fetcher = vi.fn();
    await expect(loadCalendarOAuthStatus(client({ token: null }), fetcher))
      .rejects.toThrow("Sign in to manage calendar sync.");
    await expect(startCalendarOAuth(client({ error: new Error("expired") }), "google", fetcher))
      .rejects.toThrow("Sign in to manage calendar sync.");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads status with the bearer token and returns successful payloads", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      ok: true,
      providers: { google: { configured: false } },
    }));
    await expect(loadCalendarOAuthStatus(client(), fetcher)).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledWith("/api/calendar-oauth", {
      headers: { Authorization: "Bearer member-jwt" },
      signal: expect.any(AbortSignal),
    });
  });

  it("normalizes status failures and malformed bodies", async () => {
    await expect(loadCalendarOAuthStatus(
      client(),
      vi.fn().mockResolvedValue(response({ ok: false, error: "unauthorized" }, { ok: false, status: 403 })),
    )).resolves.toEqual({ ok: false, error: "unauthorized" });
    await expect(loadCalendarOAuthStatus(
      client(),
      vi.fn().mockResolvedValue(response(null, { ok: false, status: 500, jsonError: true })),
    )).resolves.toEqual({ ok: false, error: "catalog_unavailable" });
  });

  it("starts a provider request without sending credentials to the browser", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      ok: true,
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    }));
    await expect(startCalendarOAuth(client(), "google", fetcher)).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledWith("/api/calendar-oauth", {
      method: "POST",
      headers: {
        Authorization: "Bearer member-jwt",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "google" }),
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps unset activation distinct from generic endpoint failures", async () => {
    await expect(startCalendarOAuth(
      client(),
      "microsoft",
      vi.fn().mockResolvedValue(response({ ok: false }, { ok: false, status: 409 })),
    )).resolves.toEqual({ ok: false, error: "activation_unset", provider: "microsoft" });
    await expect(startCalendarOAuth(
      client(),
      "google",
      vi.fn().mockResolvedValue(response({ ok: false, error: "unauthorized" }, { ok: false, status: 403 })),
    )).resolves.toEqual({ ok: false, error: "unauthorized" });
    await expect(startCalendarOAuth(
      client(),
      "google",
      vi.fn().mockResolvedValue(response(null, { ok: true, status: 200, jsonError: true })),
    )).resolves.toEqual({ ok: false, error: "catalog_unavailable" });
  });
});
