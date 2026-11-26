// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadUsageDigests, requestUsageDigestWording } from "../src/features/analytics/usageDigestApi.js";

afterEach(() => vi.unstubAllGlobals());

describe("usage digest client boundary", () => {
  it.each([null, {}, { rpc: true }])("refuses an unavailable RPC client: %j", async (client) => {
    await expect(loadUsageDigests(client, "admin")).rejects.toThrow("usage-digest-unavailable");
  });

  it("reads the selected hat without sending tenant or person identifiers", async () => {
    const data = { enabled: true, digests: [] };
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    await expect(loadUsageDigests({ rpc }, "advisor")).resolves.toBe(data);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_analytics_usage_digests", { p_selected_hat: "advisor" });
  });

  it("preserves RPC errors for the panel's retry state", async () => {
    const error = { code: "42501", message: "refused" };
    await expect(loadUsageDigests({ rpc: vi.fn().mockResolvedValue({ error }) }, "admin")).rejects.toBe(error);
  });

  it.each([null, {}, { access_token: "" }])("refuses an expired session before a request: %j", async (session) => {
    const fetcher = vi.fn();
    await expect(requestUsageDigestWording(session, "admin", "digest", fetcher)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the default transport and returns the saved digest", async () => {
    const payload = { digest: { id: "digest", ai: { status: "enriched" } } };
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal("fetch", fetcher);
    await expect(requestUsageDigestWording({ access_token: "test-token" }, "steward", "digest")).resolves.toBe(payload);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/guide", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "usage_digest", hat: "steward", digestId: "digest" }),
    });
  });

  it.each([
    [{ error: "Paused", code: "compass_paused" }, "Paused", "compass_paused"],
    [{}, "compass_unavailable", null],
  ])("preserves structured server refusals: %j", async (payload, message, code) => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => payload });
    await expect(requestUsageDigestWording({ access_token: "test-token" }, "admin", "digest", fetcher))
      .rejects.toMatchObject({ message, status: 503, code });
  });

  it("handles a non-JSON gateway error without hiding its HTTP status", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError("HTML"); } });
    await expect(requestUsageDigestWording({ access_token: "test-token" }, "admin", "digest", fetcher))
      .rejects.toMatchObject({ message: "compass_unavailable", status: 502, code: null });
  });
});
