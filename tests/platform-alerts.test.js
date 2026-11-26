// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_THROTTLE_MS,
  ALERT_WEBHOOK_ENV_VAR,
  assertMetadataOnlyAlert,
  buildPlatformAlertText,
  parseAlertWebhookUrl,
  postPlatformAlert,
  answerPathOutage,
  resetPlatformAlertThrottle,
  schedulePlatformAlert,
} from "../api/_lib/platformAlerts.js";

const NOW = new Date("2026-10-17T05:40:00.000Z");
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/synthetic";
const reservationId = "cbaa9fed-03b5-4e02-b302-05dd019870d3";
const takeover = {
  kind: "fireworks_takeover", environment: "production", route: "guide", cause: "temporary_http",
  gateway: "union-ground-fireworks", model: "accounts/fireworks/models/muse-spark-open", reservationId,
};
const outage = { kind: "answer_path_down", environment: "sample", route: "civic-draft", cause: "gateway_timeout", gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1", reservationId };
const okResponse = () => ({ ok: true, status: 200, json: async () => [] });

beforeEach(() => resetPlatformAlertThrottle());
afterEach(() => { vi.restoreAllMocks(); });

describe("platform alert text", () => {
  it("renders a takeover from closed vocabularies only", () => {
    const text = buildPlatformAlertText(takeover, NOW);
    expect(text).toContain("FAILOVER (production)");
    expect(text).toContain("route: guide | cause: temporary_http | gateway: union-ground-fireworks | model: accounts/fireworks/models/muse-spark-open");
    expect(text).toContain(`reservation: ${reservationId}`);
    expect(text).toContain("ET (2026-10-17T05:40:00.000Z)");
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("never names a contributor model, which the failover can never select", () => {
    const text = buildPlatformAlertText({ ...takeover, model: "accounts/fireworks/models/muse-spark-1p3-contributor" }, NOW);
    expect(text).toContain("model: unknown");
    expect(text).not.toContain("contributor");
  });

  it("replaces anything outside the vocabularies with unknown or none", () => {
    const text = buildPlatformAlertText({
      kind: "answer_path_down", environment: "staging", route: "admin", cause: "Error: secret sk-live-123 leaked",
      gateway: "https://evil.example/?x=1", model: "<script>", reservationId: "not-a-uuid",
    }, NOW);
    expect(text).toContain("OUTAGE (production)");
    expect(text).toContain("route: unknown | cause: unknown | gateway: unknown | model: unknown");
    expect(text).toContain("reservation: none");
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("evil");
  });

  it("refuses an unknown kind and any payload shaped like a secret or URL", () => {
    expect(() => buildPlatformAlertText({ kind: "other" }, NOW)).toThrow(/unknown platform alert kind/);
    expect(() => assertMetadataOnlyAlert("see https://example.test")).toThrow(/a URL/);
    expect(() => assertMetadataOnlyAlert("Bearer abc.def")).toThrow(/bearer/);
    expect(() => assertMetadataOnlyAlert("key fw_abc")).toThrow(/token-shaped/);
  });

  it("accepts only an https hooks.slack.com destination without credentials", () => {
    expect(parseAlertWebhookUrl(WEBHOOK)?.hostname).toBe("hooks.slack.com");
    expect(parseAlertWebhookUrl("")).toBeNull();
    expect(parseAlertWebhookUrl("http://hooks.slack.com/services/x")).toBeNull();
    expect(parseAlertWebhookUrl("https://user:pw@hooks.slack.com/services/x")).toBeNull();
    expect(parseAlertWebhookUrl("https://example.com/services/x")).toBeNull();
  });
});

describe("postPlatformAlert", () => {
  it("does nothing without the webhook variable", async () => {
    const fetchImpl = vi.fn();
    await expect(postPlatformAlert(takeover, { env: {}, fetchImpl, now: NOW })).resolves.toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts a metadata-only message and throttles the same kind for ten minutes", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const env = { [ALERT_WEBHOOK_ENV_VAR]: WEBHOOK };
    await expect(postPlatformAlert(takeover, { env, fetchImpl, now: NOW })).resolves.toBe("posted");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).toEqual(["text"]);
    expect(body.text).toContain("FAILOVER (production)");
    const later = new Date(NOW.getTime() + ALERT_THROTTLE_MS - 1);
    await expect(postPlatformAlert(takeover, { env, fetchImpl, now: later })).resolves.toBe("throttled");
    await expect(postPlatformAlert(outage, { env, fetchImpl, now: later })).resolves.toBe("posted");
    const after = new Date(NOW.getTime() + ALERT_THROTTLE_MS + 1);
    await expect(postPlatformAlert(takeover, { env, fetchImpl, now: after })).resolves.toBe("posted");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("claims the window before posting so overlapping events post once, and releases it when nothing was delivered", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { [ALERT_WEBHOOK_ENV_VAR]: WEBHOOK };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 410 })
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(okResponse());
    await expect(postPlatformAlert(takeover, { env, fetchImpl, now: NOW })).resolves.toBe("rejected");
    await expect(postPlatformAlert(takeover, { env, fetchImpl, now: NOW })).resolves.toBe("failed");
    // Two overlapping events on one warm instance: the first claims the window.
    const overlapping = await Promise.all([
      postPlatformAlert(takeover, { env, fetchImpl, now: NOW }),
      postPlatformAlert(takeover, { env, fetchImpl, now: NOW }),
    ]);
    expect(overlapping.sort()).toEqual(["posted", "throttled"]);
    await expect(postPlatformAlert(takeover, { env, fetchImpl, now: NOW })).resolves.toBe("throttled");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("describes the civic-draft outage without the search-only wording", () => {
    expect(buildPlatformAlertText(outage, NOW)).toContain("the member could not get a draft");
    // Only the question path degrades to search-only; every other guide mode returns an error.
    expect(buildPlatformAlertText({ ...outage, route: "guide", outcome: "search_only" }, NOW)).toContain("the member received the search-only reply");
    expect(buildPlatformAlertText({ ...outage, route: "guide" }, NOW)).toContain("the member received an error instead of an answer");
    expect(buildPlatformAlertText({ ...outage, route: "guide", outcome: "nonsense" }, NOW)).not.toContain("search-only");
  });

  it("describes an unusable completed reply as rejected by the route, not as both providers failing", () => {
    const guide = buildPlatformAlertText({ ...outage, route: "guide", cause: "invalid_result" }, NOW);
    expect(guide).toContain("the provider's completed reply could not be used");
    expect(guide).toContain("The route rejected the provider reply. Check validation errors for the named route and model.");
    expect(guide).not.toMatch(/search-only|both providers/);
    expect(buildPlatformAlertText({ ...outage, cause: "invalid_result" }, NOW)).toContain("the provider's completed draft could not be used");
  });

  it("never throws when the destination rejects or the network fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { [ALERT_WEBHOOK_ENV_VAR]: WEBHOOK };
    await expect(postPlatformAlert(outage, { env, fetchImpl: async () => ({ ok: false, status: 410 }), now: NOW })).resolves.toBe("rejected");
    resetPlatformAlertThrottle();
    await expect(postPlatformAlert(outage, { env, fetchImpl: async () => { throw new TypeError(`fetch failed for ${WEBHOOK}`); }, now: NOW })).resolves.toBe("failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("hooks.slack.com");
  });

  it("classifies answer-path failures for the outage alert and names the provider that failed", () => {
    const mesh = { gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1" };
    const fireworks = { gateway: "union-ground-fireworks", model: "accounts/fireworks/models/muse-spark-open" };
    expect(answerPathOutage(Object.assign(new Error("x"), { failoverRefused: true, cause: "disabled" }), mesh)).toBeNull();
    expect(answerPathOutage(Object.assign(new Error("x"), { failoverRefused: true, cause: "config" }), mesh)).toEqual({ cause: "fallback_refused", ...mesh });
    expect(answerPathOutage(Object.assign(new Error("x"), { failoverRefused: true, cause: "governance_unavailable" }), mesh)).toEqual({ cause: "governance_unavailable", ...mesh });
    expect(answerPathOutage(Object.assign(new Error("x"), { gatewayCause: "no_credits", gatewayResponse: {}, provider: fireworks }), mesh)).toEqual({ cause: "no_credits", ...fireworks });
    expect(answerPathOutage(Object.assign(new Error("x"), { name: "TimeoutError", gatewayCause: "gateway_timeout" }), mesh)).toEqual({ cause: "gateway_timeout", ...mesh });
    expect(answerPathOutage(Object.assign(new Error("x"), { gatewayCause: "gateway_error" }), mesh)).toEqual({ cause: "gateway_error", ...mesh });
    expect(answerPathOutage(Object.assign(new Error("x"), { invalidResult: true, provider: fireworks }), mesh)).toEqual({ cause: "invalid_result", ...fireworks });
    expect(answerPathOutage(Object.assign(new Error("x"), { invalidResult: true }), mesh)).toEqual({ cause: "invalid_result", ...mesh });
    expect(answerPathOutage(Object.assign(new Error("x"), { code: "compass_privacy_unavailable" }), mesh)).toBeNull();
    expect(answerPathOutage(new Error("dispatch-unavailable"), mesh)).toBeNull();
    expect(answerPathOutage(null, mesh)).toBeNull();
    for (const cause of ["fallback_refused", "governance_unavailable"]) {
      expect(buildPlatformAlertText({ ...outage, cause }, NOW)).toContain(`cause: ${cause}`);
    }
  });

  it("schedules through waitUntil and returns the same promise", async () => {
    const waitUntilImpl = vi.fn();
    const pending = schedulePlatformAlert(takeover, { env: {}, waitUntilImpl });
    expect(waitUntilImpl).toHaveBeenCalledWith(pending);
    await expect(pending).resolves.toBe("disabled");
  });
});
