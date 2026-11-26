vi.hoisted(() => vi.resetModules());
import { uploadSensitiveCaseFile, downloadSensitiveCaseFile } from "../src/lib/sensitiveContentApi.js";
vi.mock("../src/lib/sensitiveContentApi.js", () => ({ SENSITIVE_CASE_MAX_BYTES: 10 * 1024 * 1024, uploadSensitiveCaseFile: vi.fn(), downloadSensitiveCaseFile: vi.fn() }));
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addChapterTaskFile,
  addMemberCaseFile,
  chapterTaskFileBlob,
  memberCaseFileBlob,
  memberCaseFileFromRow,
  recheckPrivateFile,
  removeChapterTaskFile,
  removeMemberCaseFile,
} from "../src/lib/memberApi.js";

const registered = {
  id: "file-1", caseId: "case-1", userId: "user-1", bucketId: "case-files",
  objectName: "user-1/case-1/file-1/evidence.pdf", filename: "evidence.pdf",
  mimeType: "application/pdf", sizeBytes: 4, uploadedBy: "user-1", createdAt: "2026-08-10T00:00:00Z",
};

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => body,
  };
}

// The inspection endpoint, standing in for api/private-files.js. It records
// every request so a test can prove the body carries nothing but {kind,fileId},
// and it echoes the file id back the way the real endpoint does — the client
// refuses a 2xx that does not name the file it asked about.
function inspectionServer(reply = (body) => jsonResponse(200, { status: "clean", fileId: body.fileId })) {
  const impl = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    return typeof reply === "function" ? reply(body, impl.mock.calls.length) : reply;
  });
  return { impl, body: (index = 0) => JSON.parse(impl.mock.calls[index][1].body) };
}

function clientWith({
  uploadError = null,
  downloadError = null,
  removeError = null,
  inspection = null,
  kind = "case",
} = {}) {
  let removalId = null;
  let beganId = null;
  const beginRpc = kind === "case" ? "begin_member_case_file_upload" : "begin_chapter_task_file_upload";
  const confirmRpc = kind === "case" ? "confirm_member_case_file_upload" : "confirm_chapter_task_file_upload";
  const rpc = vi.fn(async (name, args) => {
    if (name === beginRpc) {
      beganId = args.p_file_id;
      return { data: { ...registered, id: beganId, confirmedAt: null }, error: null };
    }
    if (name === confirmRpc) {
      return { data: { ...registered, id: beganId, confirmedAt: "2026-09-05T00:00:00Z" }, error: null };
    }
    if (name === "abort_member_case_file_upload" || name === "abort_chapter_task_file_upload") {
      return { data: { deleted: false, absent: false, cleanupQueued: true, id: beganId }, error: null };
    }
    if (name === "request_member_case_file_removal") {
      removalId = args.p_removal_id;
      return {
        data: { ...registered, removalId, removalRequestedAt: "2026-09-03T20:00:00Z" },
        error: null,
      };
    }
    if (name === "finalize_member_case_file_removal") {
      return { data: { deleted: true, absent: false, id: registered.id, removalId }, error: null };
    }
    return { data: { deleted: true }, error: null };
  });
  const upload = vi.fn(async () => ({ error: uploadError }));
  vi.mocked(uploadSensitiveCaseFile).mockReset().mockImplementation(async (_client, _fileId, file) => upload(file));
  vi.mocked(downloadSensitiveCaseFile).mockReset().mockImplementation(async () => {
    if (downloadError) throw Object.assign(new Error("read unavailable"), { staleVerdict: Number(downloadError.status) >= 400 && Number(downloadError.status) < 500 });
    return new Blob(["data"]);
  });
  const download = vi.fn(async () => (downloadError
    ? { data: null, error: downloadError }
    : { data: new Blob(["data"]), error: null }));
  const remove = vi.fn(async () => ({
    data: removeError ? null : [{ name: registered.objectName }],
    error: removeError,
  }));
  const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: "https://signed.example/file" }, error: null }));
  const from = vi.fn(() => ({ upload, download, remove, createSignedUrl }));
  const auth = { getSession: vi.fn(async () => ({ data: { session: { access_token: "member-token" } }, error: null })) };
  const server = inspection ?? inspectionServer();
  // The client asks the endpoint through the ambient fetch; stubbing it here
  // keeps every assertion on what actually crossed the boundary.
  vi.stubGlobal("fetch", server.impl);
  return {
    client: { rpc, storage: { from }, auth },
    rpc, upload, download, remove, createSignedUrl, auth, server,
    beganId: () => beganId,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resuming an ambiguous evidence upload", () => {
  it.each(["case", "task"])("retains the registered %s upload after an inspection deadline and recovers without resending bytes", async (kind) => {
    vi.useFakeTimers();
    const mock = clientWith({ kind, inspection: inspectionServer(() => new Promise(() => {})) });
    const add = kind === "case" ? addMemberCaseFile : addChapterTaskFile;
    const file = new File(["data"], "proof.pdf", { type: "application/pdf" });
    const phases = [];
    let failure;
    const pending = add(mock.client, "record-1", file, { onPhase: (phase) => phases.push(phase) })
      .catch((error) => { failure = error; });
    await vi.advanceTimersByTimeAsync(139000);
    expect(failure).toMatchObject({ privateFileCode: "pending-check", retryUpload: expect.any(Function) });
    await pending;
    expect(phases).toContain("checking");
    expect(phases.at(-1)).toBe("pending-check");
    expect(phases).not.toContain("confirming");
    expect(mock.rpc.mock.calls.filter(([name]) => name.startsWith("confirm_") || name.startsWith("abort_"))).toHaveLength(0);
    const id = mock.beganId();
    expect(mock.server.impl).toHaveBeenCalledTimes(3);
    expect(mock.server.impl.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);

    mock.server.impl.mockImplementation(async (_url, init) => jsonResponse(200, {
      status: "clean", fileId: JSON.parse(init.body).fileId,
    }));
    const row = await add(mock.client, "record-1", file, { retryUpload: failure.retryUpload });
    expect(row.id).toBe(id);
    expect(mock.server.body(3)).toEqual({ kind, fileId: id });
    expect(mock.rpc.mock.calls.filter(([name]) => name.startsWith("begin_"))).toHaveLength(1);
    expect(kind === "case" ? uploadSensitiveCaseFile : mock.upload).toHaveBeenCalledTimes(1);
    expect(mock.rpc.mock.calls.filter(([name]) => name.startsWith("confirm_")).map(([, args]) => args.p_file_id)).toEqual([id]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["case", "task"])("checks the same %s attempt after quota refusal without uploading again", async (kind) => {
    const mock = clientWith({ kind, inspection: inspectionServer(jsonResponse(429, {})) });
    const add = kind === "case" ? addMemberCaseFile : addChapterTaskFile;
    const file = new File(["data"], "proof.pdf", { type: "application/pdf" });
    const failure = await add(mock.client, "record-1", file).catch((error) => error);
    expect(failure.retryUpload).toEqual(expect.any(Function));
    const id = mock.beganId();
    await expect(add(mock.client, "different-record", file, { retryUpload: failure.retryUpload }))
      .rejects.toThrow("Upload retry does not belong to this record");
    mock.server.impl.mockImplementation(async (_url, init) => jsonResponse(200, {
      status: "clean", fileId: JSON.parse(init.body).fileId,
    }));
    const row = await add(mock.client, "record-1", file, { retryUpload: failure.retryUpload });
    expect(row.id).toBe(id);
    expect(mock.rpc.mock.calls.filter(([name]) => name.startsWith("begin_"))).toHaveLength(1);
    expect(mock.server.body(1).fileId).toBe(id);
    expect(kind === "case" ? uploadSensitiveCaseFile : mock.upload).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost confirmation response without a second registration or byte upload", async () => {
    const mock = clientWith({ kind: "task" });
    const original = mock.rpc.getMockImplementation();
    let lost = true;
    mock.rpc.mockImplementation(async (name, args) => {
      if (name === "confirm_chapter_task_file_upload" && lost) throw new Error("response lost");
      return original(name, args);
    });
    const file = new File(["data"], "proof.pdf", { type: "application/pdf" });
    const failure = await addChapterTaskFile(mock.client, "record-1", file).catch((error) => error);
    lost = false;
    await addChapterTaskFile(mock.client, "record-1", file, { retryUpload: failure.retryUpload });
    expect(mock.upload).toHaveBeenCalledTimes(1);
    expect(mock.rpc.mock.calls.filter(([name]) => name.startsWith("begin_"))).toHaveLength(1);
    expect(mock.rpc.mock.calls.filter(([name]) => name.startsWith("confirm_")).every(([, args]) => args.p_file_id === mock.beganId())).toBe(true);
  });
});

describe("member case file API", () => {
  it("normalizes database and RPC row shapes", () => {
    expect(memberCaseFileFromRow({
      id: "f", case_id: "c", user_id: "u", bucket_id: "case-files", object_name: "u/c/f/a.pdf",
      filename: "a.pdf", mime_type: "application/pdf", size_bytes: 9, uploaded_by: "u", created_at: "now",
    })).toEqual({ id: "f", caseId: "c", userId: "u", bucketId: "case-files", objectName: "u/c/f/a.pdf", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 9, uploadedBy: "u", createdAt: "now" });
  });

  it("begins, uploads, inspects, then confirms — in that order and no other", async () => {
    const mock = clientWith();
    const file = { name: "evidence.pdf", type: "application/pdf", size: 4 };
    const phases = [];
    const row = await addMemberCaseFile(mock.client, "case-1", file, { onPhase: (p) => phases.push(p) });

    const fileId = mock.beganId();
    expect(fileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(row.confirmedAt).toBe("2026-09-05T00:00:00Z");
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "begin_member_case_file_upload", {
      p_file_id: fileId, p_case_id: "case-1", p_filename: "evidence.pdf",
      p_mime_type: "application/pdf", p_size_bytes: 4,
    });
    // The server's mimeType, never the browser's guess: a guess that disagrees
    // with the minted row is a self-inflicted refusal.
    expect(uploadSensitiveCaseFile).toHaveBeenCalledWith(mock.client, fileId, file);
    expect(mock.client.storage.from).not.toHaveBeenCalled();
    expect(mock.rpc).toHaveBeenNthCalledWith(2, "confirm_member_case_file_upload", { p_file_id: fileId });
    expect(mock.rpc).toHaveBeenCalledTimes(2);

    // Bytes land, then the verdict arrives, then the row becomes visible.
    const [begin, confirm] = mock.rpc.mock.invocationCallOrder;
    const [uploaded] = mock.upload.mock.invocationCallOrder;
    const [inspected] = mock.server.impl.mock.invocationCallOrder;
    expect(begin).toBeLessThan(uploaded);
    expect(uploaded).toBeLessThan(inspected);
    expect(inspected).toBeLessThan(confirm);
    expect(phases).toEqual(["preparing", "uploading", "checking", "confirming", "done"]);
  });

  // A LOST CONFIRMATION IS NOT A FAILED ONE.
  //
  // `confirm_*_file_upload` sets `confirmed_at = coalesce(confirmed_at, now())`
  // and returns the row, so re-asking for the same file id reconciles rather
  // than attaching a second copy. Reporting "nothing was attached" for a
  // transaction that committed leaves a live, visible row behind and invites
  // the member to upload a duplicate — the native path already reconciles this
  // way (reconcileAuthorizedAttachmentUpload).
  it("reconciles the exact file id when the confirmation response is lost", async () => {
    const mock = clientWith();
    const confirmations = [];
    const inner = mock.client.rpc;
    mock.client.rpc = vi.fn(async (name, args) => {
      if (name === "confirm_member_case_file_upload") {
        confirmations.push(args.p_file_id);
        if (confirmations.length === 1) throw new TypeError("Failed to fetch");
      }
      return inner(name, args);
    });

    const row = await addMemberCaseFile(mock.client, "case-1", { name: "e.pdf", type: "application/pdf", size: 4 });
    expect(row.confirmedAt).toBe("2026-09-05T00:00:00Z");
    // The SAME file id, twice — never a second begin, never a second upload.
    expect(confirmations).toHaveLength(2);
    expect(new Set(confirmations).size).toBe(1);
    expect(mock.upload).toHaveBeenCalledTimes(1);
  });

  it("re-asks once for an ambiguous confirmation error and then gives up", async () => {
    const mock = clientWith();
    const inner = mock.client.rpc;
    let attempts = 0;
    mock.client.rpc = vi.fn(async (name, args) => {
      if (name === "confirm_member_case_file_upload") {
        attempts += 1;
        return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      }
      return inner(name, args);
    });
    await expect(addMemberCaseFile(mock.client, "case-1", { name: "e.pdf", type: "application/pdf", size: 4 }))
      .rejects.toThrow(/statement timeout/);
    expect(attempts).toBe(2);
  });

  it("does not re-ask when the server actually decided the confirmation", async () => {
    // The row is gone, or the bytes were never found: a second ask cannot
    // change that, and repeating it would only hide the real reason.
    for (const error of [
      { code: "22023", message: "uploaded file was not found" },
      { code: "22023", message: "file unavailable" },
      { code: "42501", message: "authentication required" },
    ]) {
      const mock = clientWith();
      const inner = mock.client.rpc;
      let attempts = 0;
      mock.client.rpc = vi.fn(async (name, args) => {
        if (name === "confirm_member_case_file_upload") {
          attempts += 1;
          return { data: null, error };
        }
        return inner(name, args);
      });
      await expect(addMemberCaseFile(mock.client, "case-1", { name: "e.pdf", type: "application/pdf", size: 4 }))
        .rejects.toThrow(new RegExp(error.message));
      expect(attempts, error.message).toBe(1);
    }
  });

  // A dropped response explains nothing. When the re-ask comes back with the
  // reason the server actually decided, that is what the member must be told —
  // not the transport error that happened to arrive first.
  it("surfaces a decided refusal that follows an ambiguous first attempt", async () => {
    for (const decided of [
      { code: "22023", message: "uploaded file was not found" },
      { code: "42501", message: "file inspection required" },
    ]) {
      const mock = clientWith();
      const inner = mock.client.rpc;
      let attempts = 0;
      mock.client.rpc = vi.fn(async (name, args) => {
        if (name === "confirm_member_case_file_upload") {
          attempts += 1;
          if (attempts === 1) throw new TypeError("Failed to fetch");
          return { data: null, error: decided };
        }
        return inner(name, args);
      });
      await expect(addMemberCaseFile(mock.client, "case-1", { name: "e.pdf", type: "application/pdf", size: 4 }))
        .rejects.toThrow(new RegExp(decided.message));
      expect(attempts, decided.message).toBe(2);
    }
  });

  // Two ambiguous outcomes leave the first one standing: nothing decided, so
  // there is no better answer to promote.
  it("keeps the first ambiguous failure when the re-ask is ambiguous too", async () => {
    const mock = clientWith();
    const inner = mock.client.rpc;
    let attempts = 0;
    mock.client.rpc = vi.fn(async (name, args) => {
      if (name === "confirm_member_case_file_upload") {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      }
      return inner(name, args);
    });
    await expect(addMemberCaseFile(mock.client, "case-1", { name: "e.pdf", type: "application/pdf", size: 4 }))
      .rejects.toThrow(/Failed to fetch/);
    expect(attempts).toBe(2);
  });

  it("refuses a confirmation that does not name the file it asked about", async () => {
    const mock = clientWith();
    const inner = mock.client.rpc;
    mock.client.rpc = vi.fn(async (name, args) => {
      if (name === "confirm_member_case_file_upload") {
        return { data: { ...registered, id: "someone-elses-file", confirmedAt: "2026-09-05T00:00:00Z" }, error: null };
      }
      return inner(name, args);
    });
    await expect(addMemberCaseFile(mock.client, "case-1", { name: "e.pdf", type: "application/pdf", size: 4 }))
      .rejects.toThrow(/did not name this file/);
  });

  it("sends exactly {kind, fileId} with a bearer and no cookies", async () => {
    const mock = clientWith();
    await addMemberCaseFile(mock.client, "case-1", { name: "e.pdf", type: "application/pdf", size: 4 });
    const [request] = mock.server.impl.mock.calls;
    expect(request[0]).toBe("/api/private-files");
    expect(Object.keys(mock.server.body()).sort()).toEqual(["fileId", "kind"]);
    expect(mock.server.body().kind).toBe("case");
    expect(request[1].headers.Authorization).toBe("Bearer member-token");
    expect(request[1].credentials).toBe("omit");
    // No bucket, object name, signed URL, digest or verdict crosses the wire.
    expect(request[1].body).not.toMatch(/case-files|objectName|sha256|status/);
  });

  it("aborts the pending row on a rejection and never confirms it", async () => {
    const mock = clientWith({
      inspection: inspectionServer(jsonResponse(422, { error: "private-file-executable" })),
    });
    const phases = [];
    await expect(addMemberCaseFile(mock.client, "case-1", { name: "e.pdf", type: "application/pdf", size: 4 }, {
      onPhase: (p) => phases.push(p),
    })).rejects.toMatchObject({ privateFileCode: "rejected", details: "private_file_rejected" });

    const names = mock.rpc.mock.calls.map(([name]) => name);
    expect(names).toEqual(["begin_member_case_file_upload", "abort_member_case_file_upload"]);
    expect(names).not.toContain("confirm_member_case_file_upload");
    // No client-side byte deletion: the abort queues the service reconciler.
    expect(mock.remove).not.toHaveBeenCalled();
    expect(phases).toContain("rejected");
  });

  it("leaves the row unconfirmed and unaborted when the verdict is merely unavailable", async () => {
    vi.useFakeTimers();
    const mock = clientWith({ inspection: inspectionServer(jsonResponse(503, { error: "scanner-unavailable" })) });
    const pending = addMemberCaseFile(mock.client, "case-1", { name: "e.pdf", type: "application/pdf", size: 4 });
    const assertion = expect(pending).rejects.toMatchObject({
      privateFileCode: "pending-check",
      details: "private_file_pending_check",
    });
    await vi.runAllTimersAsync();
    await assertion;

    const names = mock.rpc.mock.calls.map(([name]) => name);
    expect(names).toEqual(["begin_member_case_file_upload"]);
    // Neither confirmed (it is unscanned) nor aborted (the bytes may be fine).
    expect(names).not.toContain("confirm_member_case_file_upload");
    expect(names).not.toContain("abort_member_case_file_upload");
    // The retryable class is retried on the documented backoff, and only that.
    expect(mock.server.impl).toHaveBeenCalledTimes(3);
  });

  it("names the real ceiling when the inspection quota refuses", async () => {
    const mock = clientWith({
      inspection: inspectionServer(jsonResponse(429, { error: "rate-limited" }, { "Retry-After": "3600" })),
    });
    await expect(addMemberCaseFile(mock.client, "case-1", { name: "e.pdf", type: "application/pdf", size: 4 }))
      .rejects.toMatchObject({ privateFileCode: "rate-limited", details: "private_file_rate_limited" });
    expect(mock.server.impl).toHaveBeenCalledTimes(1);
    expect(mock.rpc.mock.calls.map(([name]) => name)).toEqual(["begin_member_case_file_upload"]);
  });

  it("aborts the pending row when the byte upload itself fails", async () => {
    const mock = clientWith({ uploadError: { message: "storage down" } });
    await expect(addMemberCaseFile(mock.client, "case-1", { name: "evidence.pdf", type: "application/pdf", size: 4 }))
      .rejects.toThrow("Attach case file: storage down");
    expect(mock.rpc).toHaveBeenLastCalledWith("abort_member_case_file_upload", { p_file_id: mock.beganId() });
    expect(mock.server.impl).not.toHaveBeenCalled();
  });

  it("runs the same contract for chapter task files", async () => {
    const mock = clientWith({ kind: "task" });
    await addChapterTaskFile(mock.client, "task-1", { name: "e.pdf", type: "application/pdf", size: 4 });
    const fileId = mock.beganId();
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "begin_chapter_task_file_upload", {
      p_file_id: fileId, p_task_id: "task-1", p_filename: "e.pdf",
      p_mime_type: "application/pdf", p_size_bytes: 4,
    });
    expect(mock.server.body()).toEqual({ kind: "task", fileId });
    expect(mock.rpc).toHaveBeenNthCalledWith(2, "confirm_chapter_task_file_upload", { p_file_id: fileId });
  });

  // The local pre-flight mirrors the exact server bound the begin RPCs raise
  // on: 1 byte to 10485760 (10 MiB). At the ceiling the upload proceeds; one
  // byte past it the refusal happens with ZERO network — no minted row, no
  // inspection request, no spent quota.
  it("accepts a case file exactly at the 10 MiB ceiling", async () => {
    const mock = clientWith();
    await addMemberCaseFile(mock.client, "case-1", { name: "evidence.pdf", type: "application/pdf", size: 10485760 });
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "begin_member_case_file_upload", {
      p_file_id: mock.beganId(), p_case_id: "case-1", p_filename: "evidence.pdf",
      p_mime_type: "application/pdf", p_size_bytes: 10485760,
    });
  });

  it("refuses a case file one byte past the ceiling before any network happens", async () => {
    const mock = clientWith();
    await expect(addMemberCaseFile(mock.client, "case-1", { name: "evidence.pdf", type: "application/pdf", size: 10485761 }))
      .rejects.toMatchObject({ privateFileCode: "invalid-size", details: "private_file_invalid_size" });
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(mock.server.impl).not.toHaveBeenCalled();
    expect(mock.client.storage.from).not.toHaveBeenCalled();
  });

  it("enforces the same ceiling and format allowlist on chapter task files", async () => {
    const oversized = clientWith({ kind: "task" });
    await expect(addChapterTaskFile(oversized.client, "task-1", { name: "e.pdf", type: "application/pdf", size: 10485761 }))
      .rejects.toMatchObject({ privateFileCode: "invalid-size" });
    expect(oversized.rpc).not.toHaveBeenCalled();
    expect(oversized.server.impl).not.toHaveBeenCalled();

    const unsupported = clientWith({ kind: "task" });
    await expect(addChapterTaskFile(unsupported.client, "task-1", { name: "clip.mov", type: "video/quicktime", size: 4 }))
      .rejects.toMatchObject({ privateFileCode: "invalid-format", details: "private_file_invalid_format" });
    expect(unsupported.rpc).not.toHaveBeenCalled();
    expect(unsupported.server.impl).not.toHaveBeenCalled();
  });

  it("declares the extension's MIME when the picker knew nothing about the type", async () => {
    // Some pickers hand over a real PDF as application/octet-stream. The
    // bytes are preserved exactly and only the meaningless label is
    // normalized, so the begin RPC declares what the extension already states.
    const mock = clientWith();
    const picked = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "evidence.pdf", { type: "application/octet-stream" });
    await addMemberCaseFile(mock.client, "case-1", picked);
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "begin_member_case_file_upload", {
      p_file_id: mock.beganId(), p_case_id: "case-1", p_filename: "evidence.pdf",
      p_mime_type: "application/pdf", p_size_bytes: 4,
    });
  });

  it("refuses a declared MIME that conflicts with the extension before any network", async () => {
    const mock = clientWith();
    await expect(addMemberCaseFile(mock.client, "case-1", { name: "photo.jpg", type: "image/png", size: 4 }))
      .rejects.toMatchObject({ privateFileCode: "invalid-format" });
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(mock.server.impl).not.toHaveBeenCalled();
  });

  it("tombstones immediately and leaves physical deletion to the bounded service reconciler", async () => {
    const { client, rpc, download, remove } = clientWith();
    await expect(removeMemberCaseFile(client, registered)).resolves.toMatchObject({
      id: registered.id,
      removalRequestedAt: "2026-09-03T20:00:00Z",
    });
    expect(download).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("request_member_case_file_removal", {
      p_file_id: "file-1",
      p_removal_id: expect.any(String),
    });
  });

  it("accepts only an exact already-absent receipt from the request RPC", async () => {
    const rpc = vi.fn(async (_name, args) => ({
      data: {
        deleted: false,
        absent: true,
        id: registered.id,
        removalId: args.p_removal_id,
      },
      error: null,
    }));
    const from = vi.fn();
    await expect(removeMemberCaseFile({ rpc, storage: { from } }, registered))
      .resolves.toMatchObject({ absent: true, id: registered.id });
    expect(rpc).toHaveBeenCalledOnce();
    expect(from).not.toHaveBeenCalled();
  });

  it("replays a lost request response under the same exact tombstone id", async () => {
    let removalId = null;
    let requestAttempts = 0;
    const rpc = vi.fn(async (name, args) => {
      if (name === "request_member_case_file_removal") {
        removalId = args.p_removal_id;
        requestAttempts += 1;
        if (requestAttempts === 1) throw new Error("response lost after commit");
        return {
          data: { ...registered, removalId, removalRequestedAt: "2026-09-03T20:00:00Z" },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const from = vi.fn();
    const client = { rpc, storage: { from } };
    await expect(removeMemberCaseFile(client, registered)).resolves.toMatchObject({ id: registered.id });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(2, "request_member_case_file_removal", {
      p_file_id: registered.id,
      p_removal_id: removalId,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("fails closed when two request responses cannot prove the exact tombstone", async () => {
    const rpc = vi.fn(async () => ({ data: { ...registered, removalId: "wrong" }, error: null }));
    const from = vi.fn();
    await expect(removeMemberCaseFile({ rpc, storage: { from } }, registered))
      .rejects.toThrow(/exact removal checkpoint/);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(from).not.toHaveBeenCalled();
  });

  it("uses the same exact tombstone protocol for chapter task files", async () => {
    const taskFile = {
      id: "task-file-1", taskId: "task-1", chapterId: "chapter-1", bucketId: "chapter-task-files",
      objectName: "chapter-1/task-1/task-file-1/evidence.pdf", filename: "evidence.pdf",
      mimeType: "application/pdf", sizeBytes: 4, uploadedBy: "user-1", createdAt: "2026-08-10T00:00:00Z",
    };
    const rpc = vi.fn(async (name, args) => {
      if (name === "request_chapter_task_file_removal") {
        return {
          data: { ...taskFile, removalId: args.p_removal_id, removalRequestedAt: "2026-09-03T20:00:00Z" },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const from = vi.fn();
    const client = { rpc, storage: { from } };

    await expect(removeChapterTaskFile(client, taskFile)).resolves.toMatchObject({ id: taskFile.id });
    expect(rpc).toHaveBeenNthCalledWith(1, "request_chapter_task_file_removal", {
      p_file_id: taskFile.id,
      p_removal_id: expect.any(String),
    });
    expect(rpc).toHaveBeenCalledOnce();
    expect(from).not.toHaveBeenCalled();
  });

  it("does not depend on the authenticated Storage delete path", async () => {
    const { client, rpc, remove } = clientWith({ removeError: { message: "storage down" } });
    await expect(removeMemberCaseFile(client, registered)).resolves.toMatchObject({ id: registered.id });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("request_member_case_file_removal", expect.objectContaining({
      p_file_id: registered.id,
    }));
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("authenticated private file reads", () => {
  it("downloads bytes with the caller's own session instead of minting a signed URL", async () => {
    const { client, download, createSignedUrl } = clientWith();
    await expect(memberCaseFileBlob(client, registered)).resolves.toBeInstanceOf(Blob);
    expect(downloadSensitiveCaseFile).toHaveBeenCalledWith(client, registered.id);
    expect(download).not.toHaveBeenCalled();
    // A signed URL is a decision honoured for its whole life; a later
    // quarantine could not revoke it, so none is ever requested.
    expect(createSignedUrl).not.toHaveBeenCalled();
    const task = clientWith({ kind: "task" });
    await expect(chapterTaskFileBlob(task.client, registered)).resolves.toBeInstanceOf(Blob);
    expect(task.createSignedUrl).not.toHaveBeenCalled();
  });

  it("reports a 4xx from Storage as a stale verdict the member can re-check", async () => {
    const { client } = clientWith({ downloadError: { message: "not found", status: 400 } });
    await expect(memberCaseFileBlob(client, registered)).rejects.toMatchObject({
      privateFileCode: "stale",
      details: "private_file_stale",
    });
  });

  it("keeps a server outage distinct from a stale verdict", async () => {
    const { client } = clientWith({ downloadError: { message: "gateway", status: 502 } });
    await expect(memberCaseFileBlob(client, registered)).rejects.toMatchObject({
      privateFileCode: "unavailable",
    });
  });

  it("re-checks a stale file by id and kind alone", async () => {
    const mock = clientWith();
    const fileId = "0f1e2d3c-4b5a-4968-8776-655443322110";
    await expect(recheckPrivateFile(mock.client, "case", fileId)).resolves.toEqual({ fileId, status: "clean" });
    expect(mock.server.body()).toEqual({ kind: "case", fileId });
    // A re-check touches no RPC and names no object.
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("surfaces a rejection from a re-check as permanent", async () => {
    const mock = clientWith({ inspection: inspectionServer(jsonResponse(422, { error: "private-file-pdf-javascript" })) });
    await expect(recheckPrivateFile(mock.client, "case", "0f1e2d3c-4b5a-4968-8776-655443322110"))
      .rejects.toMatchObject({ privateFileCode: "rejected" });
  });
});
