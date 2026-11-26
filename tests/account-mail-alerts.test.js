// @vitest-environment node
//
// REQ-UG-SIGNUP-AND-ACCOUNT-MAIL-FAILURES-RAISE-NO-PRIVATE-ALERT-20261111:
// every signup or account mail failure writes one content-free line (kind and
// count) and a sustained failure raises one metadata-only ug-alerts post per
// kind per window, through an injected sender here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_MAIL_ALERT_WINDOW_MS, ACCOUNT_MAIL_FAILURE_KINDS, buildAccountMailAlertText, recordAccountMailFailure,
  resetAccountMailAlerts,
} from "../api/_lib/accountMailAlerts.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/synthetic";
const NOW = new Date("2026-11-11T19:30:00Z");
const env = { UG_ALERTS_SLACK_WEBHOOK_URL: WEBHOOK, VERCEL_ENV: "production" };

function sender(status = 200) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status });
}

let warn;
beforeEach(() => {
  resetAccountMailAlerts();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("account mail failure records", () => {
  it("names the closed vocabulary of failure kinds", () => {
    expect(ACCOUNT_MAIL_FAILURE_KINDS).toEqual([
      "signup_confirmation_send_failed", "signup_turnstile_unavailable", "reset_send_failed", "reset_send_unconfirmed",
      "recovery_notice_send_failed", "provider_bounced", "provider_failed", "provider_suppressed", "provider_complained", "provider_delivery_delayed",
    ]);
  });

  it("logs one content-free line per event with the running count, and nothing for an unknown kind", async () => {
    const fetchImpl = sender();
    const waitUntilImpl = vi.fn();
    expect(await recordAccountMailFailure("reset_send_failed", { env: {}, fetchImpl, now: NOW, waitUntilImpl })).toBe("disabled");
    await recordAccountMailFailure("reset_send_failed", { env: {}, fetchImpl, now: NOW, waitUntilImpl });
    expect(recordAccountMailFailure("person@example.invalid", { env, fetchImpl, now: NOW, waitUntilImpl })).toBeNull();
    expect(warn.mock.calls).toEqual([
      [JSON.stringify({ event: "account-mail-failure", kind: "reset_send_failed", count: 1 })],
      [JSON.stringify({ event: "account-mail-failure", kind: "reset_send_failed", count: 2 })],
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(waitUntilImpl).toHaveBeenCalledTimes(2);
  });

  it("posts one metadata-only alert per kind per window and reports the events held back", async () => {
    const fetchImpl = sender();
    const options = { env, fetchImpl, waitUntilImpl: () => {} };
    expect(await recordAccountMailFailure("provider_bounced", { ...options, now: NOW })).toBe("posted");
    expect(await recordAccountMailFailure("provider_bounced", { ...options, now: new Date(NOW.getTime() + 60_000) })).toBe("throttled");
    expect(await recordAccountMailFailure("provider_bounced", { ...options, now: new Date(NOW.getTime() + 120_000) })).toBe("throttled");
    // Another kind has its own window.
    expect(await recordAccountMailFailure("provider_complained", { ...options, now: NOW })).toBe("posted");
    const later = new Date(NOW.getTime() + ACCOUNT_MAIL_ALERT_WINDOW_MS);
    expect(await recordAccountMailFailure("provider_bounced", { ...options, now: later })).toBe("posted");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(WEBHOOK);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
    const texts = fetchImpl.mock.calls.map(([, call]) => JSON.parse(call.body).text);
    expect(texts[0]).toContain("kind: provider_bounced | events on this instance since its last alert: 1");
    expect(texts[0]).toContain("(production)");
    expect(texts[0]).toContain("2:30:00 PM ET");
    // The two held-back events and the new one are reported together.
    expect(texts[2]).toContain("kind: provider_bounced | events on this instance since its last alert: 3");
  });

  it("releases the window when the destination rejects or fails, so nothing is silenced", async () => {
    const options = { env, waitUntilImpl: () => {}, now: NOW };
    expect(await recordAccountMailFailure("signup_turnstile_unavailable", { ...options, fetchImpl: sender(500) })).toBe("rejected");
    expect(await recordAccountMailFailure("signup_turnstile_unavailable", { ...options, fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) })).toBe("failed");
    const fetchImpl = sender();
    expect(await recordAccountMailFailure("signup_turnstile_unavailable", { ...options, fetchImpl })).toBe("posted");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).text).toContain("since its last alert: 3");
  });

  it("refuses any destination but an https Slack webhook", async () => {
    const fetchImpl = sender();
    for (const value of ["http://hooks.slack.com/services/x", "https://example.invalid/hook", "not a url"]) {
      expect(await recordAccountMailFailure("reset_send_failed", { env: { UG_ALERTS_SLACK_WEBHOOK_URL: value }, fetchImpl, now: NOW, waitUntilImpl: () => {} })).toBe("disabled");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws into the route, even when scheduling or logging fails", () => {
    warn.mockImplementation(() => { throw new Error("log sink down"); });
    const pending = recordAccountMailFailure("reset_send_failed", { env, fetchImpl: sender(), now: NOW, waitUntilImpl: () => { throw new Error("no runtime"); } });
    expect(pending).toBeInstanceOf(Promise);
    return expect(pending).resolves.toBe("posted");
  });
});

describe("account mail alert text", () => {
  it("is built only from the kind, an integer and the time, for every kind", () => {
    for (const kind of ACCOUNT_MAIL_FAILURE_KINDS) {
      const text = buildAccountMailAlertText(kind, 4, "production", NOW);
      expect(text).toContain(`kind: ${kind} | events on this instance since its last alert: 4`);
      expect(text).not.toMatch(/@|:\/\/|token=|Bearer/);
    }
    expect(buildAccountMailAlertText("reset_send_failed", -1, "preview", NOW)).toContain("(preview)");
    expect(buildAccountMailAlertText("reset_send_failed", Number.NaN, undefined, NOW)).toContain("since its last alert: 1");
    expect(() => buildAccountMailAlertText("person@example.invalid", 1, "production", NOW)).toThrow("unknown account mail failure kind");
  });
});
