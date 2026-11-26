// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrivateFileError,
  downloadPrivateFileBlob,
  requestPrivateFileInspection,
  withObjectUrl,
} from "../src/lib/privateFileAccess.js";

const FILE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let session;
let fetchMock;
let storage;
let client;

function reply(status, options = {}) {
  const fallback = status === 200 ? { fileId: FILE, status: "clean" } : { error: "x" };
  const payload = Object.hasOwn(options, "payload") ? options.payload : fallback;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(options.headers || {}),
    json: async () => payload,
  };
}

function bodyOf(call) {
  return JSON.parse(call[1].body);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function stalledInspection(stage) {
  const late = deferred();
  if (stage === "session") client.auth.getSession.mockReturnValue(late.promise);
  if (stage === "headers") fetchMock.mockReturnValue(late.promise);
  if (stage === "body") fetchMock.mockResolvedValue({ ...reply(200), json: () => late.promise });
  return () => late.resolve(stage === "session" ? session
    : stage === "headers" ? reply(200) : { fileId: FILE, status: "clean" });
}

beforeEach(() => {
  vi.useFakeTimers();
  session = { data: { session: { access_token: "member-token" } }, error: null };
  fetchMock = vi.fn(async () => reply(200));
  vi.stubGlobal("fetch", fetchMock);
  storage = {
    download: vi.fn(async () => ({ data: new Blob(["bytes"]), error: null })),
    createSignedUrl: vi.fn(),
  };
  client = {
    auth: { getSession: vi.fn(async () => session) },
    storage: { from: vi.fn(() => storage) },
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requestPrivateFileInspection", () => {
  it("sends the caller's bearer and exactly {kind, fileId} — no path, URL, digest, verdict or cookie", async () => {
    await expect(requestPrivateFileInspection(client, "case", FILE)).resolves.toEqual({ fileId: FILE, status: "clean" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/private-files");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer member-token");
    expect(init.credentials).toBe("omit");
    expect(init.headers).not.toHaveProperty("Cookie");
    // The entire request. Anything more would let a caller name someone else's
    // object or assert its own verdict.
    expect(Object.keys(bodyOf(fetchMock.mock.calls[0]))).toEqual(["kind", "fileId"]);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ kind: "case", fileId: FILE });
    expect(JSON.stringify(init.body)).not.toMatch(/bucket|objectName|signedUrl|sha256|status/i);
  });

  it("rejects an unknown kind or a non-uuid file id before any request", async () => {
    for (const attempt of [
      requestPrivateFileInspection(client, "packet", FILE),
      requestPrivateFileInspection(client, "case", "../case-files/other"),
      requestPrivateFileInspection(client, "case", ""),
    ]) {
      await expect(attempt).rejects.toMatchObject({ name: "PrivateFileError", code: "invalid", retryable: false });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send a request without a session", async () => {
    session = { data: { session: null }, error: null };
    await expect(requestPrivateFileInspection(client, "task", FILE))
      .rejects.toMatchObject({ code: "reauth-required", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A `busy` answer is a CONCURRENT INSPECTION HOLDING THE 60-SECOND ATTEMPT
  // LEASE, not a momentary hiccup. Spending the three ordinary attempts on it
  // meant giving up about five seconds into somebody else's legitimate scan —
  // which can run for a 10 s privileged download plus a 20 s scan — and telling
  // the member their file was not attached. Busy therefore polls.
  it("polls a busy check through the whole attempt lease instead of spending attempts", async () => {
    fetchMock.mockResolvedValue(reply(409, { headers: { "Retry-After": "5" } }));
    const pending = requestPrivateFileInspection(client, "case", FILE);
    const assertion = expect(pending).rejects.toMatchObject({ code: "busy", retryable: true, retryAfterMs: 5000 });

    // Three attempts on the old backoff would have been spent by now.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // The wait outlasts the server's own 60 s lease before it gives up, so an
    // inspection that is genuinely running is waited out rather than lost.
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(13);
    // Polling costs no quota: the server answers `busy` before it charges.
    expect(fetchMock.mock.calls.every(([, init]) => JSON.parse(init.body).fileId === FILE)).toBe(true);
  });

  it("resolves a busy check that clears part-way through the lease", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(409, { headers: { "Retry-After": "5" } }))
      .mockResolvedValueOnce(reply(409, { headers: { "Retry-After": "5" } }))
      .mockResolvedValueOnce(reply(200));
    const pending = requestPrivateFileInspection(client, "case", FILE);
    await vi.advanceTimersByTimeAsync(20000);
    await expect(pending).resolves.toEqual({ fileId: FILE, status: "clean" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honours a server wait longer than the poll interval", async () => {
    fetchMock.mockResolvedValue(reply(409, { headers: { "Retry-After": "20" } }));
    const pending = requestPrivateFileInspection(client, "case", FILE);
    const assertion = expect(pending).rejects.toMatchObject({ code: "busy" });
    await vi.advanceTimersByTimeAsync(19000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120000);
    await assertion;
  });

  it("still makes exactly one request when the caller asked for one attempt", async () => {
    fetchMock.mockResolvedValue(reply(409, { headers: { "Retry-After": "5" } }));
    const pending = requestPrivateFileInspection(client, "case", FILE, { attempts: 1 });
    await expect(pending).rejects.toMatchObject({ code: "busy", retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries an unavailable check on the documented backoff", async () => {
    fetchMock.mockResolvedValue(reply(503));
    const pending = requestPrivateFileInspection(client, "knowledge", FILE);
    const assertion = expect(pending).rejects.toMatchObject({ code: "unavailable", retryable: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await assertion;
  });

  it("never retries a rejection, a quota refusal or a denial", async () => {
    for (const [status, code, retryAfterMs] of [
      [422, "rejected", null],
      [429, "rate-limited", 3600000],
      [403, "not-authorized", null],
      // 401 is the endpoint saying "your MFA session is stale" — a fact about
      // this caller's session, decided before it looks at the file — while 403
      // is the merged answer for unknown, foreign, removed and unauthorized
      // rows. They must not share a code.
      [401, "reauth-required", null],
      [400, "invalid", null],
    ]) {
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(reply(status, { headers: status === 429 ? { "Retry-After": "3600" } : {} }));
      await expect(requestPrivateFileInspection(client, "form", FILE))
        .rejects.toMatchObject({ code, retryable: false, retryAfterMs });
      expect(fetchMock, `${status} must not be retried`).toHaveBeenCalledTimes(1);
    }
  });

  it("fails closed on a 2xx that does not name this file as clean", async () => {
    for (const payload of [
      { fileId: FILE, status: "pending" },
      { fileId: OTHER, status: "clean" },
      { status: "clean" },
      null,
    ]) {
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(reply(200, { payload }));
      const pending = requestPrivateFileInspection(client, "case", FILE);
      const assertion = expect(pending).rejects.toBeInstanceOf(PrivateFileError);
      await vi.advanceTimersByTimeAsync(10000);
      await assertion;
    }
  });

  it("treats a transport failure as unavailable and never as success", async () => {
    fetchMock.mockRejectedValue(new TypeError("network"));
    const pending = requestPrivateFileInspection(client, "case", FILE, { attempts: 1 });
    await expect(pending).rejects.toMatchObject({ code: "unavailable", retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["session", "headers", "body"])("expires a stalled %s read after 45 seconds and ignores its late result", async (stage) => {
    const finishLate = stalledInspection(stage);
    let outcome = "pending";
    const observed = requestPrivateFileInspection(client, "case", FILE, { attempts: 1 })
      .then((value) => { outcome = "clean"; return value; }, (error) => { outcome = "failed"; return error; });

    await vi.advanceTimersByTimeAsync(44999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("failed");
    expect(await observed).toMatchObject({ code: "unavailable", retryable: true });
    if (stage !== "session") expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);

    finishLate();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(stage === "session" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["session", "headers", "body"])("cancels a stalled %s read immediately with the caller's reason", async (stage) => {
    const finishLate = stalledInspection(stage);
    const controller = new AbortController();
    const reason = new Error("member left the upload");
    let outcome = "pending";
    const observed = requestPrivateFileInspection(client, "task", FILE, { signal: controller.signal })
      .then(() => { outcome = "clean"; }, (error) => { outcome = "failed"; return error; });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("failed");
    expect(await observed).toBe(reason);
    if (stage !== "session") expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    finishLate();
    await vi.advanceTimersByTimeAsync(600000);
    expect(fetchMock).toHaveBeenCalledTimes(stage === "session" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not read the session or start transport for an already cancelled inspection", async () => {
    const controller = new AbortController();
    controller.abort();
    const observed = requestPrivateFileInspection(client, "form", FILE, { signal: controller.signal })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await observed).toBe(controller.signal.reason);
    expect(client.auth.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses an already cancelled signal that does not expose an abort reason", async () => {
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "reason", { value: undefined });
    controller.abort();
    await expect(requestPrivateFileInspection(client, "form", FILE, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(client.auth.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a running inspection when the caller signal has no abort reason", async () => {
    const finishLate = stalledInspection("headers");
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "reason", { value: undefined });
    const observed = requestPrivateFileInspection(client, "case", FILE, { signal: controller.signal })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await observed).toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    finishLate();
    await vi.advanceTimersByTimeAsync(600000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a deadline unavailable when aborting the transport rejects with AbortError", async () => {
    fetchMock.mockImplementation((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Transport aborted", "AbortError")), { once: true });
    }));
    const observed = requestPrivateFileInspection(client, "task", FILE, { attempts: 1 })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(45000);
    expect(await observed).toMatchObject({ name: "PrivateFileError", code: "unavailable", retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("spends only the ordinary three attempts when every response stalls", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    let outcome = "pending";
    const observed = requestPrivateFileInspection(client, "knowledge", FILE)
      .catch((error) => { outcome = "failed"; return error; });
    await vi.advanceTimersByTimeAsync(45000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(45000);
    expect(outcome).toBe("failed");
    expect(await observed).toMatchObject({ code: "unavailable", retryable: true });
    expect(fetchMock.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
    expect(fetchMock.mock.calls.every((call) => JSON.stringify(bodyOf(call)) === JSON.stringify({ kind: "knowledge", fileId: FILE }))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans the request deadline and caller listener after a completed inspection", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(requestPrivateFileInspection(client, "case", FILE, { signal: controller.signal }))
      .resolves.toEqual({ fileId: FILE, status: "clean" });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    await vi.advanceTimersByTimeAsync(45000);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
  });
});

describe("downloadPrivateFileBlob", () => {
  it("reads bytes with the caller's own session and never mints a signed URL", async () => {
    const blob = await downloadPrivateFileBlob(client, { bucketId: "case-files", objectName: "a/b.pdf" });
    expect(blob).toBeInstanceOf(Blob);
    expect(client.storage.from).toHaveBeenCalledWith("case-files");
    expect(storage.download).toHaveBeenCalledWith("a/b.pdf");
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it("reports a 4xx as a stale verdict the caller can re-check", async () => {
    storage.download.mockResolvedValue({ data: null, error: { status: 400, message: "row not found" } });
    await expect(downloadPrivateFileBlob(client, { bucketId: "case-files", objectName: "a/b.pdf" }))
      .rejects.toMatchObject({ code: "unavailable", staleVerdict: true });
  });

  it("does not offer a re-check for a server outage", async () => {
    storage.download.mockResolvedValue({ data: null, error: { statusCode: "500", message: "upstream" } });
    await expect(downloadPrivateFileBlob(client, { bucketId: "case-files", objectName: "a/b.pdf" }))
      .rejects.toMatchObject({ code: "unavailable", staleVerdict: false });
  });

  it("refuses a missing target instead of guessing one", async () => {
    await expect(downloadPrivateFileBlob(client, {})).rejects.toMatchObject({ code: "invalid" });
    expect(client.storage.from).not.toHaveBeenCalled();
  });
});

describe("withObjectUrl", () => {
  it("hands the consumer a URL and defers the revoke past the viewer's first paint", () => {
    const createObjectURL = vi.fn(() => "blob:synthetic");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    const consumed = withObjectUrl(new Blob(["bytes"]), (url) => `opened ${url}`);
    expect(consumed).toBe("opened blob:synthetic");
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(59999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
  });

  it("still revokes when the consumer throws", () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:synthetic", revokeObjectURL });
    expect(() => withObjectUrl(new Blob(["bytes"]), () => { throw new Error("popup blocked"); })).toThrow("popup blocked");
    vi.advanceTimersByTime(60000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
  });
});
