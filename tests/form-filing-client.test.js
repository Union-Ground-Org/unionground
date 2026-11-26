import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addMemberFormFile, memberFormFileBlob, removeMemberFormFile,
} from "../src/lib/memberApi.js";
import {
  canShareFormFiling, downloadFormFiling, shareFormFiling, triggerFormFilingDownload,
} from "../src/lib/formFilingClient.js";

// A real form file id is a UUID; the inspection contract refuses anything
// else before a request is made, so the fixture must be one too.
const FORM_FILE_ID = "8c2b1a5e-3d47-4f10-9a6b-77e1c2d34f58";

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => body,
  };
}

// Stands in for api/private-files.js, echoing the file id back the way the real
// endpoint does — the client refuses a 2xx that does not name the file it asked
// about, so a mock that omits it would silently prove nothing.
function inspectionServer(reply = (body) => jsonResponse(200, { status: "clean", fileId: body.fileId })) {
  const impl = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    return typeof reply === "function" ? reply(body) : reply;
  });
  return { impl, body: (index = 0) => JSON.parse(impl.mock.calls[index][1].body) };
}

afterEach(() => { vi.unstubAllGlobals(); });

// Stands in for api/sensitive-form-files.js "remove" (#8569): the server marks,
// deletes and finalizes, and answers with finalize's receipt.
function removalServer(reply = (body) => jsonResponse(200, { fileId: body.fileId, status: "removed", receipt: { deleted: true, id: body.fileId } })) {
  return vi.fn(async (_url, init) => reply(JSON.parse(init.body)));
}

function rpcClient({ uploadError = null, confirmError = null, confirmSequence = null, removeError = null, inspection = null, removal = null } = {}) {
  const registered = {
    id: FORM_FILE_ID, formId: "form-1", bucketId: "member-form-files",
    objectName: `form-1/${FORM_FILE_ID}/proof.pdf`, filename: "proof.pdf",
    mimeType: "application/pdf", sizeBytes: 3, confirmedAt: null,
  };
  let confirmCall = 0;
  const rpc = vi.fn(async (name) => {
    if (name === "register_member_form_file") return { data: registered, error: null };
    if (name === "confirm_member_form_file") {
      if (confirmSequence) {
        const step = confirmSequence[Math.min(confirmCall, confirmSequence.length - 1)];
        confirmCall += 1;
        if (step.throws) throw step.throws;
        return { data: step.data ?? null, error: step.error ?? null };
      }
      return { data: confirmError ? null : { id: FORM_FILE_ID, confirmedAt: "now" }, error: confirmError };
    }
    if (name === "request_member_form_file_removal") return {
      data: removeError ? null : {
        id: FORM_FILE_ID, bucketId: "member-form-files", objectName: `form-1/${FORM_FILE_ID}/proof.pdf`,
        deletionRequestedAt: "now",
      },
      error: removeError,
    };
    if (name === "finalize_member_form_file_removal") return { data: { deleted: true, id: FORM_FILE_ID }, error: removeError };
    throw new Error(`unexpected rpc ${name}`);
  });
  const upload = vi.fn().mockResolvedValue({ error: uploadError });
  const remove = vi.fn().mockResolvedValue({ error: removeError });
  const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: "https://signed.test/file" }, error: null });
  const download = vi.fn().mockResolvedValue({ data: new Blob(["pdf"]), error: null });
  const from = vi.fn(() => ({ upload, remove, createSignedUrl, download }));
  // These fixtures exercise ordinary form attachments. FMLA routing now reads
  // the parent template before choosing Storage or the encrypted API.
  const formQuery = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { template_key: "grievance" }, error: null }),
  };
  const formFrom = vi.fn(() => formQuery);
  const auth = { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "member-token" } }, error: null }) };
  const server = inspection ?? inspectionServer();
  const removeRoute = removal ?? removalServer();
  vi.stubGlobal("fetch", (url, init) => (String(url).endsWith("/api/sensitive-form-files") ? removeRoute(url, init) : server.impl(url, init)));
  return { client: { rpc, from: formFrom, storage: { from }, auth }, rpc, upload, remove, createSignedUrl, download, server, removeRoute, formFrom, formQuery };
}

describe("member form file adapters", () => {
  it("resumes the same registered form file after an unfinished check", async () => {
    const mock = rpcClient({ inspection: inspectionServer(jsonResponse(429, {})) });
    const file = new File(["pdf"], "proof.pdf", { type: "application/pdf" });
    const failure = await addMemberFormFile(mock.client, "form-1", file).catch((error) => error);
    expect(failure.retryUpload).toEqual(expect.any(Function));
    mock.server.impl.mockImplementation(async (_url, init) => jsonResponse(200, {
      status: "clean", fileId: JSON.parse(init.body).fileId,
    }));
    const row = await addMemberFormFile(mock.client, "form-1", file, { retryUpload: failure.retryUpload });
    expect(row.id).toBe(FORM_FILE_ID);
    expect(mock.upload).toHaveBeenCalledTimes(1);
    expect(mock.rpc.mock.calls.filter(([name]) => name === "register_member_form_file")).toHaveLength(1);
  });

  it("registers, uploads, inspects, then confirms the exact server-minted object", async () => {
    const mock = rpcClient();
    const file = new File(["pdf"], "proof.pdf", { type: "application/pdf" });
    const phases = [];
    const row = await addMemberFormFile(mock.client, "form-1", file, { onPhase: (p) => phases.push(p) });
    expect(row.confirmedAt).toBe("now");
    expect(mock.formFrom).toHaveBeenCalledWith("member_forms");
    expect(mock.formQuery.select).toHaveBeenCalledWith("template_key");
    expect(mock.formQuery.eq).toHaveBeenCalledWith("id", "form-1");
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "register_member_form_file", {
      p_form_id: "form-1", p_filename: "proof.pdf", p_mime_type: "application/pdf", p_size_bytes: 3,
    });
    expect(mock.upload).toHaveBeenCalledWith(`form-1/${FORM_FILE_ID}/proof.pdf`, file, { contentType: "application/pdf", upsert: false });
    expect(mock.rpc).toHaveBeenNthCalledWith(2, "confirm_member_form_file", { p_file_id: FORM_FILE_ID });

    // The inspection sits strictly between the bytes and the confirmation.
    expect(mock.server.body()).toEqual({ kind: "form", fileId: FORM_FILE_ID });
    expect(mock.upload.mock.invocationCallOrder[0])
      .toBeLessThan(mock.server.impl.mock.invocationCallOrder[0]);
    expect(mock.server.impl.mock.invocationCallOrder[0])
      .toBeLessThan(mock.rpc.mock.invocationCallOrder[1]);
    expect(phases).toEqual(["preparing", "uploading", "checking", "confirming", "done"]);
  });

  it("enforces the same 10 MiB ceiling and allowlist as the case/task paths, before any network", async () => {
    // The form path used to register first and let the server refuse; now the
    // exact server bound is pre-flighted locally, so a file that can never be
    // accepted mints no row and spends no inspection quota.
    const oversized = rpcClient();
    await expect(addMemberFormFile(oversized.client, "form-1", { name: "proof.pdf", type: "application/pdf", size: 10485761 }))
      .rejects.toMatchObject({ privateFileCode: "invalid-size", details: "private_file_invalid_size" });
    expect(oversized.rpc).not.toHaveBeenCalled();
    expect(oversized.server.impl).not.toHaveBeenCalled();

    const unsupported = rpcClient();
    await expect(addMemberFormFile(unsupported.client, "form-1", { name: "proof.gif", type: "image/gif", size: 4 }))
      .rejects.toMatchObject({ privateFileCode: "invalid-format", details: "private_file_invalid_format" });
    expect(unsupported.rpc).not.toHaveBeenCalled();
    expect(unsupported.server.impl).not.toHaveBeenCalled();
  });

  it("accepts a form file exactly at the 10 MiB ceiling", async () => {
    const mock = rpcClient();
    await addMemberFormFile(mock.client, "form-1", { name: "proof.pdf", type: "application/pdf", size: 10485760 });
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "register_member_form_file", {
      p_form_id: "form-1", p_filename: "proof.pdf", p_mime_type: "application/pdf", p_size_bytes: 10485760,
    });
  });

  it("removes a rejected attachment through the existing tombstone and never confirms it", async () => {
    const mock = rpcClient({ inspection: inspectionServer(jsonResponse(422, { error: "private-file-executable" })) });
    await expect(addMemberFormFile(mock.client, "form-1", new File(["x"], "proof.pdf", { type: "application/pdf" })))
      .rejects.toMatchObject({ privateFileCode: "rejected", details: "private_file_rejected" });
    const names = mock.rpc.mock.calls.map(([name]) => name);
    expect(JSON.parse(mock.removeRoute.mock.calls[0][1].body)).toEqual({ action: "remove", fileId: FORM_FILE_ID });
    expect(mock.remove).not.toHaveBeenCalled();
    expect(names).not.toContain("confirm_member_form_file");
  });

  it("retries an ambiguous confirmation and never removes bytes the server may already have accepted", async () => {
    // The round-2 P3. An ambiguous confirmation failure says nothing about
    // whether the statement committed, and this path used to answer it by
    // deleting the row and the object. The case and task paths reconcile
    // instead; so does this one now.
    const mock = rpcClient({
      confirmSequence: [{ throws: new Error("socket hang up") }, { throws: new Error("socket hang up") }],
    });
    await expect(addMemberFormFile(mock.client, "form-1", new File(["x"], "proof.pdf", { type: "application/pdf" })))
      .rejects.toThrow(/Attach form file: socket hang up/);
    const names = mock.rpc.mock.calls.map(([name]) => name);
    expect(names.filter((name) => name === "confirm_member_form_file")).toHaveLength(2);
    expect(names).not.toContain("request_member_form_file_removal");
    expect(names).not.toContain("finalize_member_form_file_removal");
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it("accepts the confirmation that succeeds on the retry", async () => {
    const mock = rpcClient({
      confirmSequence: [
        { throws: new Error("socket hang up") },
        { data: { id: FORM_FILE_ID, confirmedAt: "later" }, error: null },
      ],
    });
    const phases = [];
    const row = await addMemberFormFile(mock.client, "form-1", new File(["x"], "proof.pdf", { type: "application/pdf" }), {
      onPhase: (phase) => phases.push(phase),
    });
    expect(row.confirmedAt).toBe("later");
    expect(phases).toEqual(["preparing", "uploading", "checking", "confirming", "done"]);
    expect(mock.rpc.mock.calls.map(([name]) => name)).not.toContain("request_member_form_file_removal");
  });

  it("reports a decided confirmation refusal without destroying the attachment", async () => {
    // A decided refusal is the server's answer about these bytes, and it stops
    // the retry — but the row is still the member's to keep or remove, so the
    // removal RPCs stay uncalled here too.
    const mock = rpcClient({
      confirmSequence: [{ error: { code: "42501", message: "file inspection required" } }],
    });
    await expect(addMemberFormFile(mock.client, "form-1", new File(["x"], "proof.pdf", { type: "application/pdf" })))
      .rejects.toThrow(/Attach form file: file inspection required/);
    const names = mock.rpc.mock.calls.map(([name]) => name);
    expect(names.filter((name) => name === "confirm_member_form_file")).toHaveLength(1);
    expect(names).not.toContain("request_member_form_file_removal");
  });

  it("keeps an unconfirmed pending row when the verdict is merely unavailable", async () => {
    const mock = rpcClient({ inspection: inspectionServer(jsonResponse(429, { error: "rate-limited" })) });
    await expect(addMemberFormFile(mock.client, "form-1", new File(["x"], "proof.pdf", { type: "application/pdf" })))
      .rejects.toMatchObject({ privateFileCode: "rate-limited" });
    const names = mock.rpc.mock.calls.map(([name]) => name);
    // Nothing confirmed (it is unscanned) and nothing destroyed (it may be fine);
    // the row stays visible only as "Upload pending".
    expect(names).toEqual(["register_member_form_file"]);
  });

  it("keeps a 503 inspection pending and still supports an explicit authorized removal", async () => {
    const mock = rpcClient({ inspection: inspectionServer(jsonResponse(503, { error: "file-check-unavailable" })) });
    const failure = await addMemberFormFile(mock.client, "form-1", new File(["x"], "proof.pdf", { type: "application/pdf" }))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.retryUpload).toEqual(expect.any(Function));
    expect(mock.rpc.mock.calls.map(([name]) => name)).toEqual(["register_member_form_file"]);
    await expect(removeMemberFormFile(mock.client, { id: FORM_FILE_ID }))
      .resolves.toMatchObject({ id: FORM_FILE_ID, deleted: true });
    expect(mock.rpc).not.toHaveBeenCalledWith("confirm_member_form_file", expect.any(Object));
    // #8569: the pending (unconfirmed) file is removed by the server, never by a
    // Storage delete under the member's session, which row security would empty.
    expect(mock.remove).not.toHaveBeenCalled();
    expect(mock.removeRoute).toHaveBeenCalledTimes(1);
  });

  it("removes through the server with the file id only and never deletes through Storage itself", async () => {
    const failed = rpcClient({ uploadError: { message: "offline" } });
    await expect(addMemberFormFile(failed.client, "form-1", new File(["x"], "proof.pdf", { type: "application/pdf" })))
      .rejects.toThrow(/Attach form file: offline/);
    expect(JSON.parse(failed.removeRoute.mock.calls[0][1].body)).toEqual({ action: "remove", fileId: FORM_FILE_ID });

    // The server deletes the object its own removal request names; a bucket or
    // path on the client's row is never sent (api/sensitive-form-files.js).
    const healthy = rpcClient();
    await expect(removeMemberFormFile(healthy.client, {
      id: FORM_FILE_ID, bucketId: "attacker-bucket", objectName: "attacker-path",
    })).resolves.toEqual({ deleted: true, id: FORM_FILE_ID });
    const [url, init] = healthy.removeRoute.mock.calls[0];
    expect(url).toBe("/api/sensitive-form-files");
    expect(init.headers.Authorization).toBe("Bearer member-token");
    expect(JSON.parse(init.body)).toEqual({ action: "remove", fileId: FORM_FILE_ID });
    expect(healthy.remove).not.toHaveBeenCalled();
    expect(healthy.rpc).not.toHaveBeenCalled();
  });

  it("never reports a removal the server did not finish", async () => {
    const wrongFile = rpcClient({ removal: removalServer(() => jsonResponse(200, { fileId: FORM_FILE_ID, status: "removed", receipt: { deleted: true, id: "another-file" } })) });
    await expect(removeMemberFormFile(wrongFile.client, { id: FORM_FILE_ID }))
      .rejects.toThrow("Remove form file: form-file-removal-unavailable");
    const refused = rpcClient({ removal: removalServer(() => jsonResponse(403, { error: "not-authorized" })) });
    await expect(removeMemberFormFile(refused.client, { id: FORM_FILE_ID }))
      .rejects.toThrow("Remove form file: not-authorized");
    // A gateway page instead of the route's JSON is a failure, not a removal.
    const gateway = rpcClient({ removal: removalServer(() => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } })) });
    await expect(removeMemberFormFile(gateway.client, { id: FORM_FILE_ID }))
      .rejects.toThrow("Remove form file: form-file-removal-unavailable");
    const signedOut = rpcClient();
    signedOut.client.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(removeMemberFormFile(signedOut.client, { id: FORM_FILE_ID }))
      .rejects.toThrow("Remove form file: not-authorized");
    expect(signedOut.removeRoute).not.toHaveBeenCalled();
  });

  it("keeps a server refusal and never reports the attachment removed", async () => {
    const mock = rpcClient({ removal: removalServer(() => jsonResponse(403, { error: "not-authorized" })) });
    await expect(removeMemberFormFile(mock.client, { id: FORM_FILE_ID }))
      .rejects.toThrow("Remove form file: not-authorized");
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it("reports a failure when the server could not remove the bytes", async () => {
    const failed = rpcClient({ removal: removalServer(() => jsonResponse(503, { error: "form-file-removal-unavailable" })) });
    await expect(removeMemberFormFile(failed.client, { id: FORM_FILE_ID }))
      .rejects.toThrow("Remove form file: form-file-removal-unavailable");
    expect(failed.remove).not.toHaveBeenCalled();
    expect(failed.rpc).not.toHaveBeenCalled();
  });

  it("reads bytes with the caller's own session instead of minting a signed URL", async () => {
    const mock = rpcClient();
    await expect(memberFormFileBlob(mock.client, { formId: "form-1", bucketId: "member-form-files", objectName: "path" }))
      .resolves.toBeInstanceOf(Blob);
    expect(mock.formQuery.eq).toHaveBeenCalledWith("id", "form-1");
    expect(mock.download).toHaveBeenCalledWith("path");
    expect(mock.createSignedUrl).not.toHaveBeenCalled();
  });

  it("reports a 4xx from Storage as a stale verdict the member can re-check", async () => {
    const mock = rpcClient();
    mock.download.mockResolvedValueOnce({ data: null, error: { message: "denied", status: 400 } });
    await expect(memberFormFileBlob(mock.client, { formId: "form-1", bucketId: "member-form-files", objectName: "path" }))
      .rejects.toMatchObject({ privateFileCode: "stale" });
  });
});

describe("filing PDF download and share", () => {
  const sessionClient = {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "member-token" } }, error: null }) },
  };

  afterEach(() => { vi.useRealTimers(); });

  it.each(["headers", "body"])("aborts a filing stalled at %s at the original deadline", async (stage) => {
    vi.useFakeTimers();
    let signal;
    let bodyStarted = false;
    const fetcher = vi.fn((_url, init) => {
      signal = init.signal;
      const stalled = () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      if (stage === "headers") return stalled();
      return Promise.resolve({
        ok: true,
        headers: { get: () => "application/pdf" },
        blob: () => { bodyStarted = true; return stalled(); },
      });
    });
    const result = downloadFormFiling(sessionClient, "form-1", "en", fetcher)
      .then(() => "resolved", error => error.name);
    await vi.advanceTimersByTimeAsync(14999);
    expect(bodyStarted).toBe(stage === "body");
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await expect(result).resolves.toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "not-found", "server-error", "non-PDF", "body-error", "network-error"])(
    "clears the deadline after %s", async (outcome) => {
      vi.useFakeTimers();
      let signal;
      const fetcher = vi.fn(async (_url, init) => {
        signal = init.signal;
        if (outcome === "network-error") throw new Error("Network failed");
        return {
          ok: !["not-found", "server-error"].includes(outcome),
          status: outcome === "not-found" ? 404 : 503,
          headers: { get: () => outcome === "non-PDF" ? "text/html" : "application/pdf" },
          blob: async () => {
            if (outcome === "body-error") throw new Error("Body failed");
            return new Blob(["%PDF-1.4"], { type: "application/pdf" });
          },
        };
      });
      const request = downloadFormFiling(sessionClient, "form-1", "en", fetcher);
      if (outcome === "success") {
        await expect(request).resolves.toMatchObject({ name: "union-base-filing-form-1.pdf" });
      } else {
        const messages = {
          "not-found": "Filing copy unavailable.",
          "server-error": "Could not download the filing copy.",
          "non-PDF": "The filing service did not return a valid PDF.",
          "body-error": "Body failed",
          "network-error": "Network failed",
        };
        await expect(request).rejects.toThrow(messages[outcome]);
      }
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(15000);
      expect(signal.aborted).toBe(false);
    },
  );

  it("fetches with the session token and returns a named PDF File", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/pdf" : null },
      blob: async () => new Blob(["%PDF-1.4"], { type: "application/pdf" }),
    });
    const file = await downloadFormFiling(sessionClient, "form-1", "es", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/form-filing?formId=form-1&lang=es", {
      headers: { Authorization: "Bearer member-token" }, signal: expect.any(AbortSignal),
    });
    expect(file.name).toBe("union-base-filing-form-1.pdf");
    expect(file.type).toBe("application/pdf");
  });

  it("rejects non-PDF and unauthenticated responses", async () => {
    const signedOut = { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }) } };
    await expect(downloadFormFiling(signedOut, "f", "en", vi.fn())).rejects.toThrow(/Sign in/);
    const fetcher = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "text/html" } });
    await expect(downloadFormFiling(sessionClient, "f", "en", fetcher)).rejects.toThrow(/valid PDF/);
  });

  it("detects file sharing, treats cancellation safely, and triggers a local download", async () => {
    const file = new File(["pdf"], "filing.pdf", { type: "application/pdf" });
    const nav = { canShare: vi.fn(() => true), share: vi.fn().mockResolvedValue(undefined) };
    expect(canShareFormFiling(file, nav)).toBe(true);
    expect(await shareFormFiling(file, nav)).toEqual({ status: "shared" });
    nav.share.mockRejectedValueOnce(Object.assign(new Error("cancel"), { name: "AbortError" }));
    expect(await shareFormFiling(file, nav)).toEqual({ status: "cancelled" });

    const click = vi.fn();
    const anchor = { click, remove: vi.fn(), set href(value) { this._href = value; }, set download(value) { this._download = value; } };
    const doc = { createElement: vi.fn(() => anchor), body: { append: vi.fn() } };
    const urls = { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() };
    triggerFormFilingDownload(file, doc, urls);
    expect(click).toHaveBeenCalledOnce();
    expect(anchor._download).toBe("filing.pdf");
    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });
});
