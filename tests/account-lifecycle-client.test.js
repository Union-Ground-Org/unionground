// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_DELETION_CLIENT_TIMEOUT_MS,
  downloadMemberDataExport,
  requestAccountDeletion,
} from "../src/lib/accountLifecycleApi.js";
import { ACCOUNT_DELETION_SERVER_TIMEOUT_MS } from "../src/lib/accountLifecycleBudget.js";
import { generateMemberDataExport } from "../src/lib/memberApi.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("member account lifecycle client", () => {
  it("requests a server-generated export rather than assembling browser state", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { schemaVersion: 1, account: { userId: "member-1" } }, error: null });
    await expect(generateMemberDataExport({ rpc })).resolves.toEqual({ schemaVersion: 1, account: { userId: "member-1" } });
    expect(rpc).toHaveBeenCalledWith("get_member_data_export");
  });

  it("downloads the export as JSON and revokes its object URL", () => {
    const click = vi.fn();
    const createElement = vi.spyOn(document, "createElement").mockReturnValue({ click, remove: vi.fn() });
    const createObjectURL = vi.fn().mockReturnValue("blob:member-export");
    const revokeObjectURL = vi.fn();
    downloadMemberDataExport({ schemaVersion: 1 }, { document, URL: { createObjectURL, revokeObjectURL }, now: new Date("2026-08-12T12:00:00Z") });
    expect(createElement).toHaveBeenCalledWith("a");
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:member-export");
  });

  it("sends only the typed confirmation and maps deletion failures without reflecting provider content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "account-delete-failed", providerBody: "must not escape" }),
    });
    const session = { access_token: "member-token", user: { id: "ignored-user-id" } };
    await expect(requestAccountDeletion(session, "DELETE MY ACCOUNT", fetchImpl)).rejects.toThrow("account-delete-failed");
    expect(fetchImpl).toHaveBeenCalledWith("/api/account-lifecycle", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer member-token" }),
      body: JSON.stringify({ confirmation: "DELETE MY ACCOUNT" }),
    }));
    expect(fetchImpl.mock.calls[0][1].body).not.toContain("ignored-user-id");
  });

  it("bounds native requests without AbortSignal.timeout and uses the configured endpoint", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(undefined);
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ deleted: true }) });
    await requestAccountDeletion({ access_token: "token" }, "DELETE MY ACCOUNT", fetchImpl, "https://portal.example/api/account-lifecycle");
    expect(fetchImpl).toHaveBeenCalledWith("https://portal.example/api/account-lifecycle", expect.objectContaining({ credentials: "omit", redirect: "error", signal: expect.any(AbortSignal) }));
  });

  it("covers default download dependencies and successful deletion responses", async () => {
    const click = vi.fn();
    vi.spyOn(document, "createElement").mockReturnValue({ click });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:default-export");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    expect(downloadMemberDataExport({ records: [] })).toEqual({ downloaded: true });
    expect(click).toHaveBeenCalledOnce();

    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ deleted: true }) });
    await expect(requestAccountDeletion({ access_token: "token" }, "DELETE MY ACCOUNT", fetchImpl))
      .resolves.toEqual({ deleted: true });
    await expect(requestAccountDeletion(null, "DELETE MY ACCOUNT", fetchImpl)).rejects.toThrow("unauthenticated");
  });

  it.each([200, 502, 503])("treats an unreadable deletion response at status %i as indeterminate", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => { throw new Error("bad json"); },
    });
    await expect(requestAccountDeletion({ access_token: "token" }, "DELETE MY ACCOUNT", fetchImpl))
      .rejects.toMatchObject({
        code: "account-delete-indeterminate",
        indeterminate: true,
        verifyAction: "sign-in",
      });
  });

  it.each([
    {},
    { deleted: false },
    { deleted: "true" },
  ])("treats a readable but unconfirmed 2xx deletion response as indeterminate", async (payload) => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    await expect(requestAccountDeletion(
      { access_token: "token" },
      "DELETE MY ACCOUNT",
      fetchImpl,
    )).rejects.toMatchObject({
      code: "account-delete-indeterminate",
      indeterminate: true,
      verifyAction: "sign-in",
    });
  });

  it("keeps a recognized pre-deletion server failure definitive", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: "account-lifecycle-unavailable" }),
    });
    await expect(requestAccountDeletion({ access_token: "token" }, "DELETE MY ACCOUNT", fetchImpl))
      .rejects.toThrow("account-lifecycle-unavailable");
  });

  it("preserves a definitive server error code for outcome-safe UI copy", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "not-permitted" }),
    });
    await expect(requestAccountDeletion({ access_token: "token" }, "DELETE MY ACCOUNT", fetchImpl))
      .rejects.toMatchObject({
        message: "not-permitted",
        code: "not-permitted",
      });
  });

  it("waits beyond the server's composite deadline and marks browser timeouts as indeterminate", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error("deadline exceeded"), {
      name: "TimeoutError",
    }));

    await expect(requestAccountDeletion(
      { access_token: "token" },
      "DELETE MY ACCOUNT",
      fetchImpl,
    )).rejects.toMatchObject({
      message: "account-delete-indeterminate",
      code: "account-delete-indeterminate",
      indeterminate: true,
      verifyAction: "sign-in",
    });

    expect(ACCOUNT_DELETION_CLIENT_TIMEOUT_MS).toBeGreaterThan(ACCOUNT_DELETION_SERVER_TIMEOUT_MS);
    expect(timeout).toHaveBeenCalledWith(ACCOUNT_DELETION_CLIENT_TIMEOUT_MS);
    expect(fetchImpl.mock.calls[0][1].signal).toBe(signal);
  });

  it("treats transport failures as indeterminate because the request may have crossed the deletion boundary", async () => {
    const transportError = new TypeError("network unavailable");
    const fetchImpl = vi.fn().mockRejectedValue(transportError);

    await expect(requestAccountDeletion(
      { access_token: "token" },
      "DELETE MY ACCOUNT",
      fetchImpl,
    )).rejects.toMatchObject({
      message: "account-delete-indeterminate",
      code: "account-delete-indeterminate",
      indeterminate: true,
      verifyAction: "sign-in",
    });
  });

  it("aborts the fallback request at its deadline and clears its timer after an indeterminate result", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout");
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });
    const fetchImpl = vi.fn((_endpoint, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" })), { once: true });
    }));
    const deletion = requestAccountDeletion({ access_token: "token" }, "DELETE MY ACCOUNT", fetchImpl);
    const observed = expect(deletion).rejects.toMatchObject({
      code: "account-delete-indeterminate", indeterminate: true, verifyAction: "sign-in",
    });
    await vi.advanceTimersByTimeAsync(ACCOUNT_DELETION_CLIENT_TIMEOUT_MS);
    await observed;
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves an ordinary fetch refusal rather than manufacturing a deletion outcome", async () => {
    const refusal = new Error("request blocked before transport");
    const fetchImpl = vi.fn().mockRejectedValue(refusal);
    await expect(requestAccountDeletion({ access_token: "token" }, "DELETE MY ACCOUNT", fetchImpl)).rejects.toBe(refusal);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("maps an AbortError cancellation to the indeterminate verification path", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError"));
    await expect(requestAccountDeletion({ access_token: "token" }, "DELETE MY ACCOUNT", fetchImpl))
      .rejects.toMatchObject({ code: "account-delete-indeterminate", indeterminate: true });
  });

  it.each([
    { status: 502, payload: { error: "account-delete-indeterminate" } },
    { status: 504, payload: null },
    { status: 503, payload: { error: "unexpected-gateway-contract" } },
  ])("maps post-boundary server uncertainty to the safe verification path", async ({ status, payload }) => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => payload,
    });

    await expect(requestAccountDeletion(
      { access_token: "token" },
      "DELETE MY ACCOUNT",
      fetchImpl,
    )).rejects.toMatchObject({
      code: "account-delete-indeterminate",
      indeterminate: true,
      verifyAction: "sign-in",
    });
  });
});
