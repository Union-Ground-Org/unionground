// @vitest-environment node
//
// Branch coverage for the issue-intelligence RPC wrappers
// (REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001): the two reads, the
// unavailable client guard, error propagation, and the governed Compass
// summary request including its session, failure and parse-error paths.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadIssueSignals, loadWeeklyDigests, requestDigestSummary } from "../src/features/issueIntelligence/api.js";
import { normalizeIssueSignals, normalizeWeeklyDigests } from "../src/features/issueIntelligence/model.js";

const DIGEST_ID = "00000000-0000-4000-8000-0000000000d1";

function clientReturning(result) {
  return { rpc: vi.fn(async () => result) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadIssueSignals", () => {
  it("reads the signals for the default member hat and normalizes the answer", async () => {
    const data = { enabled: true, viewer: "member", signals: [{ family: "contract_rights_confusion" }] };
    const client = clientReturning({ data, error: null });
    const result = await loadIssueSignals(client);
    expect(client.rpc).toHaveBeenCalledWith("get_issue_intelligence_signals", { p_selected_hat: "member" });
    expect(result).toEqual(normalizeIssueSignals(data));
    expect(result.enabled).toBe(true);
  });

  it("passes a staff hat through and reads an empty answer as switched off", async () => {
    const client = clientReturning({ data: null, error: null });
    const result = await loadIssueSignals(client, "steward");
    expect(client.rpc).toHaveBeenCalledWith("get_issue_intelligence_signals", { p_selected_hat: "steward" });
    expect(result).toEqual({ enabled: false, viewer: "member", signals: [] });
  });

  it("throws the database error untouched", async () => {
    const error = { code: "42501", message: "denied" };
    await expect(loadIssueSignals(clientReturning({ data: null, error }))).rejects.toBe(error);
  });

  it("refuses to run without a client or without an rpc function", async () => {
    await expect(loadIssueSignals(null)).rejects.toThrow("issue-intelligence-unavailable");
    await expect(loadIssueSignals(undefined, "admin")).rejects.toThrow("issue-intelligence-unavailable");
    await expect(loadIssueSignals({ rpc: "not a function" })).rejects.toThrow("issue-intelligence-unavailable");
    await expect(loadIssueSignals({})).rejects.toThrow("issue-intelligence-unavailable");
  });
});

describe("loadWeeklyDigests", () => {
  it("reads the stored digests for the hat and normalizes them", async () => {
    const data = { enabled: true, digests: [] };
    const client = clientReturning({ data, error: null });
    const result = await loadWeeklyDigests(client, "admin");
    expect(client.rpc).toHaveBeenCalledWith("get_issue_intelligence_weekly_digests", { p_selected_hat: "admin" });
    expect(result).toEqual(normalizeWeeklyDigests(data));
    expect(result).toEqual({ enabled: true, digests: [] });
  });

  it("treats a switched-off or missing payload as no digests", async () => {
    expect(await loadWeeklyDigests(clientReturning({ data: { enabled: false, digests: [{}] }, error: null }), "steward"))
      .toEqual({ enabled: false, digests: [] });
    expect(await loadWeeklyDigests(clientReturning({ data: undefined, error: null }), "steward"))
      .toEqual({ enabled: false, digests: [] });
  });

  it("throws the database error untouched", async () => {
    const error = new Error("rpc failed");
    await expect(loadWeeklyDigests(clientReturning({ data: null, error }), "steward")).rejects.toBe(error);
  });

  it("refuses to run without a usable client", async () => {
    await expect(loadWeeklyDigests(null, "steward")).rejects.toThrow("issue-intelligence-unavailable");
    await expect(loadWeeklyDigests({ rpc: 1 }, "steward")).rejects.toThrow("issue-intelligence-unavailable");
  });
});

describe("requestDigestSummary", () => {
  function fetcherReturning(status, body, { badJson = false } = {}) {
    return vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: badJson ? async () => { throw new SyntaxError("Unexpected token"); } : async () => body,
    }));
  }

  it("rejects before any request when the session has no access token", async () => {
    const fetcher = vi.fn();
    for (const session of [null, undefined, {}, { access_token: "" }]) {
      await expect(requestDigestSummary(session, "steward", DIGEST_ID, fetcher)).rejects.toMatchObject({ message: "session_expired", status: 401 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("posts the governed issue_digest request with the bearer session", async () => {
    const token = ["session", "token", "value"].join("-");
    const fetcher = fetcherReturning(200, { digest: { id: DIGEST_ID } });
    const payload = await requestDigestSummary({ access_token: token }, "steward", DIGEST_ID, fetcher);
    expect(payload).toEqual({ digest: { id: DIGEST_ID } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/guide");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ mode: "issue_digest", hat: "steward", digestId: DIGEST_ID });
  });

  it("uses the global fetch when no fetcher is passed", async () => {
    const fetchStub = fetcherReturning(200, { ok: true });
    vi.stubGlobal("fetch", fetchStub);
    expect(await requestDigestSummary({ access_token: "abc" }, "admin", DIGEST_ID)).toEqual({ ok: true });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("raises the server's error message, status and code on a refused request", async () => {
    const fetcher = fetcherReturning(429, { error: "quota_exceeded", code: "quota" });
    await expect(requestDigestSummary({ access_token: "abc" }, "steward", DIGEST_ID, fetcher))
      .rejects.toMatchObject({ message: "quota_exceeded", status: 429, code: "quota" });
  });

  it("falls back to a generic message and a null code when the error body is bare", async () => {
    const fetcher = fetcherReturning(503, {});
    await expect(requestDigestSummary({ access_token: "abc" }, "steward", DIGEST_ID, fetcher))
      .rejects.toMatchObject({ message: "compass_unavailable", status: 503, code: null });
  });

  it("survives an unreadable response body", async () => {
    const failing = fetcherReturning(502, null, { badJson: true });
    await expect(requestDigestSummary({ access_token: "abc" }, "steward", DIGEST_ID, failing))
      .rejects.toMatchObject({ message: "compass_unavailable", status: 502, code: null });
    const succeeding = fetcherReturning(200, null, { badJson: true });
    expect(await requestDigestSummary({ access_token: "abc" }, "steward", DIGEST_ID, succeeding)).toEqual({});
  });
});
