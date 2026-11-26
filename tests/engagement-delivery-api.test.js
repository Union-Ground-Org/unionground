// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/engagement-delivery.js";
import { ENGAGEMENT_EMAIL_CLASSES } from "../api/_lib/engagementEmail.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
import { unauthenticatedCronTickHeaders, vercelCronTickHeaders } from "./helpers/vercelCronTick.js";

const TOKEN = `00000000-0000-4000-8000-0000000000aa.announcements.1790000000.${"A".repeat(43)}`;

function responseRecorder() {
  const out = { status: 0, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader() {},
    end(value) { out.body = JSON.parse(value); },
  };
}

function request(token = "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx") {
  return {
    method: "GET",
    query: {},
    headers: { ...vercelCronTickHeaders(token, "*/15 * * * *"), host: PORTAL_HOST },
  };
}

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value), json: async () => value };
}

function claimOnce(deliveries) {
  let claimed = false;
  return () => {
    if (claimed) return [];
    claimed = true;
    return deliveries;
  };
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx");
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.stubEnv("ENGAGEMENT_EMAIL_WEBHOOK_URL", "https://mail.example.test/send");
  vi.stubEnv("ENGAGEMENT_EMAIL_WEBHOOK_TOKEN", "provider-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("engagement delivery API", () => {
  it("requires the timing-safe cron bearer before database access; an x-vercel-cron marker never stands in for it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = responseRecorder();
    await handler(request("wrong"), response);
    expect(response.out.status).toBe(401);
    for (const headers of [unauthenticatedCronTickHeaders("*/15 * * * *"), { ...request("wrong").headers, "x-vercel-cron": "1" }]) {
      const refused = responseRecorder();
      await handler({ method: "GET", query: {}, headers: { ...headers, host: "unionground.net" } }, refused);
      expect(refused.out.status).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the staff status probe through the predicate, never the staff snapshot", async () => {
    const statusRequest = { method: "GET", query: { status: "1" }, headers: { authorization: "Bearer staff-token", host: PORTAL_HOST } };
    const cases = [
      [jsonResponse(true), 200, null],
      [jsonResponse({ code: "42501", message: "not authorized" }, 403), 403, { error: "A staff role is required." }],
      [jsonResponse({ message: "upstream unavailable" }, 503), 503, { error: "Delivery status is unavailable right now. Try again shortly." }],
      [Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), 503, { error: "Delivery status is unavailable right now. Try again shortly." }],
    ];
    for (const [gate, status, body] of cases) {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "staff-user" }));
      if (gate instanceof Error) fetchMock.mockRejectedValueOnce(gate);
      else fetchMock.mockResolvedValueOnce(gate);
      vi.stubGlobal("fetch", fetchMock);
      const response = responseRecorder();
      await handler(statusRequest, response);
      expect(response.out.status).toBe(status);
      if (body) expect(response.out.body).toEqual(body);
      expect(String(fetchMock.mock.calls[1][0])).toContain("/rpc/authorize_engagement_staff");
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("get_staff_engagement_snapshot"))).toBe(false);
    }
  });

  it("fails before leasing when the optional provider is not activated", async () => {
    vi.stubEnv("ENGAGEMENT_EMAIL_WEBHOOK_TOKEN", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out.status).toBe(503);
    expect(response.out.body.error).toContain("not activated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leases, resolves sensitive content just in time, sends with idempotency, and records success", async () => {
    const calls = [];
    const claim = claimOnce([{
      id: "00000000-0000-4000-8000-000000000101",
      deliveryKind: "broadcast", sourceKind: "broadcast", sourceId: "broadcast-1",
    }]);
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("claim_engagement_delivery_batch")) return jsonResponse(claim());
      if (String(url).includes("get_engagement_delivery_payload")) return jsonResponse({
        available: true, email: "member@example.test", locale: "en",
        subject: "Campaign update", body: "Meeting starts at six.", path: "/m/messages?broadcast=broadcast-1",
        category: "announcements", transactional: false, unsubscribeToken: TOKEN,
      });
      if (String(url) === "https://mail.example.test/send") return { ok: true, status: 202 };
      if (String(url).includes("complete_engagement_delivery")) return jsonResponse({ state: "sent" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out).toEqual({ status: 200, body: { claimed: 1, sent: 1, failed: 0, suppressed: 0 } });
    const providerCall = calls.find((call) => call.url === "https://mail.example.test/send");
    expect(providerCall.init.headers).toMatchObject({ Authorization: "Bearer provider-token", "Idempotency-Key": "00000000-0000-4000-8000-000000000101" });
    expect(JSON.parse(providerCall.init.body)).toMatchObject({ to: "member@example.test", subject: "Campaign update", metadata: { deliveryId: "00000000-0000-4000-8000-000000000101", kind: "broadcast" } });
    // RFC 2369 / RFC 8058 one-click unsubscribe rides on every message.
    const unsubscribeUrl = `${PORTAL_ORIGIN}/api/email-unsubscribe?t=${TOKEN}`;
    expect(JSON.parse(providerCall.init.body)).toMatchObject({
      category: "announcements",
      unsubscribeUrl,
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    const complete = calls.find((call) => call.url.includes("complete_engagement_delivery"));
    expect(JSON.parse(complete.init.body)).toMatchObject({ p_success: true });
  });

  // #9507: the sending organization's own footer address rides with its
  // message ("" when it has none on file); a payload from a database not yet
  // migrated has no key, and the request then carries none either.
  it("forwards each payload's own postal address, \"\" for none on file, and no key when the payload has none", async () => {
    const ids = ["00000000-0000-4000-8000-000000000111", "00000000-0000-4000-8000-000000000112", "00000000-0000-4000-8000-000000000113", "00000000-0000-4000-8000-000000000114"];
    const addresses = { [ids[0]]: "1 Alder Way, Fictionville", [ids[1]]: "2 Birch Road, Exampletown", [ids[3]]: null };
    const queue = ids.map((id) => ({ id, deliveryKind: "broadcast", sourceKind: "broadcast", sourceId: `b-${id}` }));
    const claim = () => queue.splice(0, 1);
    const sent = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).includes("claim_engagement_delivery_batch")) return jsonResponse(claim());
      if (String(url).includes("get_engagement_delivery_payload")) {
        const id = JSON.parse(init.body).p_delivery_id;
        return jsonResponse({
          available: true, email: "member@example.test", locale: "en", subject: "S", body: "B", path: "/m/messages",
          category: "announcements", unsubscribeToken: TOKEN, ...(Object.hasOwn(addresses, id) ? { postalAddress: addresses[id] } : {}),
        });
      }
      if (String(url) === "https://mail.example.test/send") {
        sent.push(JSON.parse(init.body));
        return { ok: true, status: 202 };
      }
      if (String(url).includes("complete_engagement_delivery")) return jsonResponse({ state: "sent" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out.body).toMatchObject({ claimed: 4, sent: 4, failed: 0 });
    const byId = Object.fromEntries(sent.map((body) => [body.metadata.deliveryId, body]));
    expect(byId[ids[0]].postalAddress).toBe("1 Alder Way, Fictionville");
    expect(byId[ids[1]].postalAddress).toBe("2 Birch Road, Exampletown");
    expect(Object.keys(byId[ids[2]])).not.toContain("postalAddress");
    expect(byId[ids[3]].postalAddress).toBe("");
  });

  it("records a bounded provider error without logging recipient content", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = [];
    const claim = claimOnce([{ id: "00000000-0000-4000-8000-000000000102", deliveryKind: "broadcast" }]);
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("claim_engagement_delivery_batch")) return jsonResponse(claim());
      if (String(url).includes("get_engagement_delivery_payload")) return jsonResponse({ available: true, email: "private@example.test", subject: "Private subject", body: "Private body", locale: "en", path: "/m/messages", category: "announcements", unsubscribeToken: TOKEN });
      if (String(url) === "https://mail.example.test/send") return { ok: false, status: 429 };
      if (String(url).includes("complete_engagement_delivery")) return jsonResponse({ state: "failed" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out.status).toBe(503);
    expect(response.out.body).toEqual({ claimed: 1, sent: 0, failed: 1, suppressed: 0 });
    const complete = calls.find((call) => call.url.includes("complete_engagement_delivery"));
    expect(JSON.parse(complete.init.body)).toMatchObject({ p_success: false, p_error_code: "provider_rate_limited", p_retry_after_seconds: 900 });
    expect(logged).not.toHaveBeenCalled();
  });

  it.each([null, {}, [{ id: "first" }, { id: "second" }]])("refuses a malformed or oversized single-row claim %#", async (result) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out).toEqual({ status: 503, body: { error: "Delivery queue is unavailable." } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("claim_engagement_delivery_batch");
  });

  it("leaves every row unclaimed if an invocation pause consumed the claim and delivery allowance", async () => {
    const started = 1800000000000;
    vi.spyOn(Date, "now").mockReturnValueOnce(started).mockReturnValue(started + 232001);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out).toEqual({ status: 503, body: { claimed: 0, sent: 0, failed: 0, suppressed: 0, error: "delivery_time_budget_exhausted" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a retry without reading payloads when a delayed claim consumed the lease allowance", async () => {
    let elapsed = 0;
    const calls = [];
    vi.spyOn(Date, "now").mockImplementation(() => 1800000000000 + elapsed);
    vi.stubGlobal("fetch", vi.fn(async (raw, init) => {
      const url = String(raw), args = JSON.parse(init.body);
      calls.push({ url, args });
      if (url.includes("claim_engagement_delivery_batch")) {
        // A long event-loop pause can delay processing beyond the fetch timeout.
        elapsed += 204001;
        return jsonResponse([{ id: "delayed-claim", deliveryKind: "broadcast" }]);
      }
      if (url.includes("complete_engagement_delivery")) {
        elapsed += 8000;
        return jsonResponse({ state: "failed" });
      }
      throw new Error(`unexpected request after delayed claim: ${url}`);
    }));
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out).toEqual({ status: 503, body: { claimed: 1, sent: 0, failed: 1, suppressed: 0, error: "delivery_time_budget_exhausted" } });
    expect(calls.map(call => call.url.split("/").at(-1))).toEqual(["claim_engagement_delivery_batch", "complete_engagement_delivery"]);
    expect(calls[1].args).toEqual({ p_delivery_id: "delayed-claim", p_lease_token: calls[0].args.p_lease_token, p_success: false, p_error_code: "delivery_time_budget_exhausted", p_retry_after_seconds: 300 });
    expect(elapsed).toBeLessThan(240000);
  });

  it.each([true, false])("reserves both outcome attempts after provider acceptance, even if retry recording succeeds=%s", async (retryRecorded) => {
    let elapsed = 0;
    let outcomes = 0;
    const calls = [];
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(Date, "now").mockImplementation(() => 1800000000000 + elapsed);
    vi.stubGlobal("fetch", vi.fn(async (raw, init) => {
      const url = String(raw), args = JSON.parse(init.body);
      calls.push({ url, args, init });
      if (url.includes("claim_engagement_delivery_batch")) {
        elapsed += 12000;
        return jsonResponse([{ id: "outcome-reserve", deliveryKind: "broadcast" }]);
      }
      if (url.includes("get_engagement_delivery_payload")) {
        // Resume just before the provider + two outcome-write reserves cease to fit.
        elapsed += 199999;
        return jsonResponse({ available: true, email: "member@example.test", locale: "en", subject: "S", body: "B", path: "/m/messages", category: "announcements", unsubscribeToken: TOKEN });
      }
      if (url === "https://mail.example.test/send") {
        elapsed += 12000;
        return jsonResponse({ accepted: true }, 202);
      }
      if (url.includes("complete_engagement_delivery")) {
        elapsed += 8000;
        outcomes += 1;
        if (outcomes === 1 || !retryRecorded) throw new Error("outcome recording timed out");
        return jsonResponse({ state: "failed" });
      }
      throw new Error(`unexpected URL ${url}`);
    }));
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out).toEqual({ status: 503, body: { claimed: 1, sent: 0, failed: 1, suppressed: 0, error: "delivery_time_budget_exhausted" } });
    expect(calls.map(call => call.url.split("/").at(-1))).toEqual(["claim_engagement_delivery_batch", "get_engagement_delivery_payload", "send", "complete_engagement_delivery", "complete_engagement_delivery"]);
    expect(calls[2].init.headers["Idempotency-Key"]).toBe("outcome-reserve");
    expect(calls[3].args).toMatchObject({ p_delivery_id: "outcome-reserve", p_success: true });
    expect(calls[4].args).toEqual({ p_delivery_id: "outcome-reserve", p_lease_token: calls[0].args.p_lease_token, p_success: false, p_error_code: "provider_unavailable", p_retry_after_seconds: 300 });
    expect(timeouts.mock.calls.map(([duration]) => duration)).toEqual([12000, 8000, 12000, 8000, 8000]);
    expect(elapsed).toBe(239999);
    expect(elapsed).toBeLessThan(240000);
    expect(elapsed).toBeLessThan(280000);
  });

  it.each([
    ["four-second calls", { claim: 4000, payload: 4000, provider: 4000, complete: 4000 }],
    ["successful calls near their timeouts", { claim: 11000, payload: 7000, provider: 11000, complete: 7000 }],
  ])("leaves excess work unclaimed and drains 50 rows over later ticks with %s", async (_label, duration) => {
    let elapsed = 0;
    let invocationStarted = 0;
    let expiredReads = 0;
    const sent = [];
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, state: "queued", attempts: 0,
    }));
    vi.spyOn(Date, "now").mockImplementation(() => 1800000000000 + elapsed);
    vi.stubGlobal("fetch", vi.fn(async (raw, init) => {
      const url = String(raw), args = JSON.parse(init.body);
      if (url.includes("claim_engagement_delivery_batch")) {
        elapsed += duration.claim;
        const leased = rows.filter(row => row.state === "queued").slice(0, args.p_limit);
        for (const row of leased) Object.assign(row, { state: "leased", attempts: row.attempts + 1,
          expires: elapsed + args.p_lease_seconds * 1000, token: args.p_lease_token });
        return jsonResponse(leased.map(row => ({ id: row.id, deliveryKind: "broadcast" })));
      }
      if (url.includes("get_engagement_delivery_payload")) {
        const row = rows.find(item => item.id === args.p_delivery_id);
        expect(args.p_lease_token).toBe(row.token);
        elapsed += duration.payload;
        if (elapsed > row.expires) { expiredReads += 1; return jsonResponse({ code: "P0002" }, 404); }
        return jsonResponse({ available: true, email: "member@example.test", locale: "en", subject: "S", body: "B",
          path: "/m/messages", category: "announcements", unsubscribeToken: TOKEN });
      }
      if (url === "https://mail.example.test/send") {
        const row = rows.find(item => item.id === init.headers["Idempotency-Key"]);
        expect(sent).not.toContain(row.id);
        elapsed += duration.provider;
        expect(elapsed).toBeLessThan(row.expires);
        sent.push(row.id);
        return jsonResponse({ accepted: true }, 202);
      }
      if (url.includes("complete_engagement_delivery")) {
        const row = rows.find(item => item.id === args.p_delivery_id);
        expect(args.p_success).toBe(true);
        expect(args.p_lease_token).toBe(row.token);
        elapsed += duration.complete;
        expect(elapsed - invocationStarted).toBeLessThan(300000);
        expect(elapsed).toBeLessThan(row.expires);
        row.state = "sent";
        return jsonResponse({ state: "sent" });
      }
      throw new Error(`unexpected URL ${url}`);
    }));
    const results = [];
    for (let tick = 0; tick < 10 && rows.some(row => row.state !== "sent"); tick += 1) {
      invocationStarted = elapsed;
      const response = responseRecorder();
      await handler(request(), response);
      results.push(response.out);
      expect(elapsed - invocationStarted).toBeLessThan(300000);
      expect(rows.filter(row => row.state === "leased")).toHaveLength(0);
      expect(rows.filter(row => row.state === "queued").every(row => row.attempts === 0)).toBe(true);
      expect(response.out.body.claimed).toBe(response.out.body.sent);
    }
    expect(expiredReads).toBe(0);
    expect(rows.every(row => row.state === "sent" && row.attempts === 1)).toBe(true);
    expect(new Set(sent).size).toBe(50);
    expect(results[0].status).toBe(503);
    expect(results[0].body.error).toBe("delivery_time_budget_exhausted");
    expect(results.at(-1).status).toBe(200);
  });

  it("reserves the outcome write instead of sending after a payload consumed its lease budget", async () => {
    let elapsed = 0;
    const calls = [];
    const claim = claimOnce([{ id: "00000000-0000-4000-8000-000000000105", deliveryKind: "broadcast" }]);
    vi.spyOn(Date, "now").mockImplementation(() => 1800000000000 + elapsed);
    vi.stubGlobal("fetch", vi.fn(async (raw, init) => {
      const url = String(raw);
      calls.push({ url, args: JSON.parse(init.body) });
      if (url.includes("claim_engagement_delivery_batch")) { elapsed += 4000; return jsonResponse(claim()); }
      if (url.includes("get_engagement_delivery_payload")) {
        elapsed += 220000;
        return jsonResponse({ available: true, email: "member@example.test", locale: "en", subject: "S", body: "B",
          path: "/m/messages", category: "announcements", unsubscribeToken: TOKEN });
      }
      if (url.includes("complete_engagement_delivery")) { elapsed += 4000; return jsonResponse({ state: "failed" }); }
      throw new Error("provider must not be called without enough remaining lease budget");
    }));
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out.status).toBe(503);
    expect(response.out.body).toEqual({ claimed: 1, sent: 0, failed: 1, suppressed: 0, error: "delivery_time_budget_exhausted" });
    expect(calls.filter(call => call.url.includes("claim_engagement_delivery_batch"))).toHaveLength(1);
    expect(calls.some(call => call.url === "https://mail.example.test/send")).toBe(false);
    expect(calls.find(call => call.url.includes("complete_engagement_delivery")).args).toMatchObject({ p_success: false, p_error_code: "delivery_time_budget_exhausted" });
    expect(elapsed).toBeLessThan(300000);
  });

  it("classifies every outbox kind as optional engagement mail, none transactional", () => {
    expect(Object.keys(ENGAGEMENT_EMAIL_CLASSES).sort()).toEqual(["broadcast", "survey_invitation", "survey_reminder", "welcome"]);
    expect(Object.values(ENGAGEMENT_EMAIL_CLASSES).every((entry) => entry.transactional === false)).toBe(true);
    // REQ-UG-WELCOME-SEQUENCE-SCHEDULER-20261001: welcome mail has its own choice.
    expect(ENGAGEMENT_EMAIL_CLASSES.welcome.category).toBe("welcome");
    expect(ENGAGEMENT_EMAIL_CLASSES.broadcast.category).toBe("announcements");
    expect(ENGAGEMENT_EMAIL_CLASSES.survey_reminder.category).toBe("surveys");
  });

  it.each(["recipient_opted_out", "recipient_access_revoked"])("records %s as suppressed without contacting the provider", async (reason) => {
    const calls = [];
    const claim = claimOnce([{ id: "00000000-0000-4000-8000-000000000103", deliveryKind: "survey_reminder" }]);
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("claim_engagement_delivery_batch")) return jsonResponse(claim());
      if (String(url).includes("get_engagement_delivery_payload")) return jsonResponse({ available: false, suppressed: true, reason });
      if (String(url).includes("complete_engagement_delivery")) return jsonResponse({ state: "suppressed" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out.body).toEqual({ claimed: 1, sent: 0, failed: 0, suppressed: 1 });
    expect(calls.some((call) => call.url === "https://mail.example.test/send")).toBe(false);
    const complete = calls.find((call) => call.url.includes("complete_engagement_delivery"));
    expect(JSON.parse(complete.init.body)).toEqual({
      p_delivery_id: "00000000-0000-4000-8000-000000000103", p_lease_token: expect.any(String), p_success: false, p_error_code: reason,
    });
  });

  it.each([
    ["a missing unsubscribe token", { unsubscribeToken: null }, "broadcast", "unsubscribe_unavailable"],
    ["a malformed unsubscribe token", { unsubscribeToken: "not-a-token" }, "broadcast", "unsubscribe_unavailable"],
    ["an unclassified delivery kind", {}, "sms_blast", "unclassified_kind"],
    ["a category that disagrees with the kind", { category: "surveys" }, "broadcast", "unclassified_kind"],
  ])("never sends with %s", async (_label, override, deliveryKind, code) => {
    const calls = [];
    const claim = claimOnce([{ id: "00000000-0000-4000-8000-000000000104", deliveryKind }]);
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("claim_engagement_delivery_batch")) return jsonResponse(claim());
      if (String(url).includes("get_engagement_delivery_payload")) return jsonResponse({
        available: true, email: "member@example.test", subject: "S", body: "B", locale: "en", path: "/m/messages",
        category: "announcements", unsubscribeToken: TOKEN, ...override,
      });
      if (String(url).includes("complete_engagement_delivery")) return jsonResponse({ state: "failed" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out.body).toEqual({ claimed: 1, sent: 0, failed: 1, suppressed: 0 });
    expect(calls.some((call) => call.url === "https://mail.example.test/send")).toBe(false);
    const complete = calls.find((call) => call.url.includes("complete_engagement_delivery"));
    expect(JSON.parse(complete.init.body)).toMatchObject({ p_success: false, p_error_code: code });
  });

  // #9050 / gate r1s2: the database ends a survey email whose survey has
  // closed instead of scheduling a retry; the tick counts it as suppressed
  // and answers 200. An open survey's refusal is still a failed retry.
  it.each([
    ["the database ends it (closed survey)", "suppressed", 200, { claimed: 1, sent: 0, failed: 0, suppressed: 1 }],
    ["the database schedules a retry", "failed", 503, { claimed: 1, sent: 0, failed: 1, suppressed: 0 }],
    ["the outcome write is unavailable", null, 503, { claimed: 1, sent: 0, failed: 1, suppressed: 0 }],
  ])("counts a refused survey payload by what the database recorded: %s", async (_label, state, status, body) => {
    const calls = [];
    const claim = claimOnce([{ id: "00000000-0000-4000-8000-000000000105", deliveryKind: "survey_reminder" }]);
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("claim_engagement_delivery_batch")) return jsonResponse(claim());
      if (String(url).includes("get_engagement_delivery_payload")) return jsonResponse({ available: false });
      if (String(url).includes("complete_engagement_delivery")) {
        return state ? jsonResponse({ id: "00000000-0000-4000-8000-000000000105", state }) : jsonResponse({ message: "unavailable" }, 503);
      }
      throw new Error(`unexpected URL ${url}`);
    }));
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.out).toEqual({ status, body });
    expect(calls.some((call) => call.url === "https://mail.example.test/send")).toBe(false);
    const complete = calls.find((call) => call.url.includes("complete_engagement_delivery"));
    expect(JSON.parse(complete.init.body)).toMatchObject({ p_success: false, p_error_code: "payload_unavailable" });
  });
});
