vi.hoisted(() => vi.resetModules());
vi.mock("../src/lib/sensitiveContentApi.js", () => ({ SENSITIVE_CASE_MAX_BYTES: 10 * 1024 * 1024, uploadSensitiveCaseFile: vi.fn(), downloadSensitiveCaseFile: vi.fn() }));
import { uploadSensitiveCaseFile } from "../src/lib/sensitiveContentApi.js";
// @vitest-environment jsdom
//
// HEIC on the web (DECISIONS.md E2): the four private buckets stopped accepting
// `image/heic` because the inspector permanently refuses it, so every HEIC
// upload would otherwise mint an unreachable quarantined object and spend the
// caller's hourly inspection quota on each retry. The client therefore converts
// where the browser can decode, and says one specific sentence where it cannot.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isHeicUpload, normalizeUploadFile, UnsupportedUploadFormatError } from "../src/lib/heicNormalization.js";
import { addMemberCaseFile } from "../src/lib/memberApi.js";

function stubDecoder({ decodes = true, encodes = true } = {}) {
  vi.stubGlobal("createImageBitmap", vi.fn(async () => {
    if (!decodes) throw new Error("The source image cannot be decoded.");
    return { width: 3, height: 2, close: vi.fn() };
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type, quality) => {
    callback(encodes ? Object.assign(new Blob(["jpeg-bytes"], { type }), { quality }) : null);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HEIC upload normalization", () => {
  // The browser's MIME is a claim, not evidence: a picker handing over an
  // iPhone photo quite happily reports `image/jpeg` for `photo.heic`. Trusting
  // it meant uploading the original HEIC bytes under a `.heic` filename, which
  // the server inspector rejects permanently for that MIME — a burned quota and
  // an unreachable quarantined object instead of a conversion.
  it("recognises HEIC from EITHER the MIME or the extension, whatever the other says", () => {
    expect(isHeicUpload({ name: "a.jpg", type: "image/heic" })).toBe(true);
    expect(isHeicUpload({ name: "a.HEIF", type: "" })).toBe(true);
    expect(isHeicUpload({ name: "photo.heic", type: "image/jpeg" })).toBe(true);
    expect(isHeicUpload({ name: "photo.HEIC", type: "application/octet-stream" })).toBe(true);
    expect(isHeicUpload({ name: "notes.pdf", type: "application/pdf" })).toBe(false);
    expect(isHeicUpload({ name: "photo.jpg", type: "image/jpeg" })).toBe(false);
  });

  // The third signal, for the file that lies in both of the others.
  it("converts a mislabelled photo whose container brand is HEIC", async () => {
    stubDecoder();
    const bytes = new Uint8Array(24);
    bytes.set([0, 0, 0, 24], 0);
    bytes.set([..."ftypheic"].map((character) => character.charCodeAt(0)), 4);
    const disguised = new File([bytes], "IMG_0042.jpg", { type: "image/jpeg" });
    const converted = await normalizeUploadFile(disguised);
    expect(converted).not.toBe(disguised);
    // The name already ends in .jpg; a second extension would make the filename
    // disagree with the MIME the inspector checks it against.
    expect(converted.name).toBe("IMG_0042.jpg");
    expect(converted.type).toBe("image/jpeg");
  });

  it("leaves a real JPEG alone even though it shares the picker's declared type", async () => {
    stubDecoder();
    const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0])], "IMG_0043.jpg", { type: "image/jpeg" });
    await expect(normalizeUploadFile(jpeg)).resolves.toBe(jpeg);
    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
  });

  it("passes every accepted format through untouched", async () => {
    const pdf = new File(["%PDF"], "notes.pdf", { type: "application/pdf" });
    stubDecoder();
    await expect(normalizeUploadFile(pdf)).resolves.toBe(pdf);
    // Nothing is re-encoded that the buckets already accept.
    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
  });

  it("converts a decodable HEIC to JPEG, renaming it and dropping its EXIF", async () => {
    stubDecoder();
    const heic = new File(["heic-bytes"], "IMG_0042.HEIC", { type: "image/heic", lastModified: 1_700_000_000_000 });
    const converted = await normalizeUploadFile(heic);
    expect(converted).not.toBe(heic);
    expect(converted.name).toBe("IMG_0042.jpg");
    expect(converted.type).toBe("image/jpeg");
    expect(converted.lastModified).toBe(1_700_000_000_000);
    // A canvas re-encode carries no EXIF block, so GPS coordinates in the
    // original never reach the bucket.
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.82);
  });

  it("refuses in words the member can act on when the browser cannot decode HEIC", async () => {
    stubDecoder({ decodes: false });
    const heic = new File(["heic-bytes"], "IMG_0042.heic", { type: "image/heic" });
    await expect(normalizeUploadFile(heic)).rejects.toBeInstanceOf(UnsupportedUploadFormatError);
    await expect(normalizeUploadFile(heic)).rejects.toMatchObject({
      privateFileCode: "unsupported-format",
      details: "private_file_unsupported_format",
    });
  });

  it("refuses rather than uploading an empty encode", async () => {
    stubDecoder({ encodes: false });
    await expect(normalizeUploadFile(new File(["x"], "a.heic", { type: "image/heic" })))
      .rejects.toBeInstanceOf(UnsupportedUploadFormatError);
  });

  it("refuses when the browser has no createImageBitmap at all", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    await expect(normalizeUploadFile(new File(["x"], "a.heic", { type: "image/heic" })))
      .rejects.toBeInstanceOf(UnsupportedUploadFormatError);
  });

  it("emits preparing for every pick but converting only when a re-encode actually starts", async () => {
    stubDecoder();
    const phases = [];
    const onPhase = (phase) => phases.push(phase);
    // A file the buckets already accept is prepared and passed through; a
    // conversion that never starts must never be announced.
    await normalizeUploadFile(new File(["%PDF"], "notes.pdf", { type: "application/pdf" }), { onPhase });
    expect(phases).toEqual(["preparing"]);
    // The MIME/extension signal converts, and says so exactly once.
    await normalizeUploadFile(new File(["heic"], "IMG_0042.heic", { type: "image/heic" }), { onPhase });
    expect(phases).toEqual(["preparing", "preparing", "converting"]);
  });

  // The header-triggered path: the file lies in both its MIME and its name,
  // so the `ftyp` brand is the only honest signal — and the member still
  // watches a real conversion, announced the moment it actually starts.
  it("emits converting when the container brand alone triggers the conversion", async () => {
    stubDecoder();
    const bytes = new Uint8Array(24);
    bytes.set([0, 0, 0, 24], 0);
    bytes.set([..."ftypheic"].map((character) => character.charCodeAt(0)), 4);
    const phases = [];
    await normalizeUploadFile(new File([bytes], "IMG_0042.jpg", { type: "image/jpeg" }), {
      onPhase: (phase) => phases.push(phase),
    });
    expect(phases).toEqual(["preparing", "converting"]);
  });

  it("lets a throwing view callback never break the conversion", async () => {
    stubDecoder();
    const heic = new File(["heic-bytes"], "IMG_0042.HEIC", { type: "image/heic" });
    const converted = await normalizeUploadFile(heic, {
      onPhase: () => { throw new Error("view state exploded"); },
    });
    expect(converted.name).toBe("IMG_0042.jpg");
    expect(converted.type).toBe("image/jpeg");
  });
});

describe("HEIC through a case attachment", () => {
  it("declares the converted JPEG to the server, never the original HEIC", async () => {
    stubDecoder();
    const rpc = vi.fn(async (name, args) => {
      if (name === "begin_member_case_file_upload") {
        return { data: { id: args.p_file_id, bucketId: "case-files", objectName: "u/c/f/IMG.jpg", mimeType: args.p_mime_type }, error: null };
      }
      return { data: { id: args.p_file_id, confirmedAt: "now" }, error: null };
    });
    const upload = vi.mocked(uploadSensitiveCaseFile).mockReset().mockResolvedValue({ error: null });
    const client = {
      rpc,
      storage: { from: vi.fn(() => ({ upload })) },
      auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "member-token" } }, error: null })) },
    };
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ status: "clean", fileId: JSON.parse(init.body).fileId }),
    })));

    await addMemberCaseFile(client, "case-1", new File(["heic"], "IMG_0042.heic", { type: "image/heic" }));

    // The digest, size and declared MIME must all describe the bytes that
    // actually land in the bucket, so conversion happens before the RPC.
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_filename: "IMG_0042.jpg",
      p_mime_type: "image/jpeg",
    });
    expect(upload.mock.calls[0][2].type).toBe("image/jpeg");
    expect(client.storage.from).not.toHaveBeenCalled();
  });

  it("never reaches the server when the browser cannot convert", async () => {
    stubDecoder({ decodes: false });
    const rpc = vi.fn();
    const client = { rpc, storage: { from: vi.fn() }, auth: { getSession: vi.fn() } };
    await expect(addMemberCaseFile(client, "case-1", new File(["heic"], "a.heic", { type: "image/heic" })))
      .rejects.toBeInstanceOf(UnsupportedUploadFormatError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reports the whole journey: preparing, converting, uploading, checking, confirming, done", async () => {
    stubDecoder();
    const rpc = vi.fn(async (name, args) => {
      if (name === "begin_member_case_file_upload") {
        return { data: { id: args.p_file_id, bucketId: "case-files", objectName: "u/c/f/IMG.jpg", mimeType: args.p_mime_type }, error: null };
      }
      return { data: { id: args.p_file_id, confirmedAt: "now" }, error: null };
    });
    vi.mocked(uploadSensitiveCaseFile).mockReset().mockResolvedValue({ error: null });
    const client = {
      rpc,
      storage: { from: vi.fn(() => ({ upload: vi.fn(async () => ({ error: null })) })) },
      auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "member-token" } }, error: null })) },
    };
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ status: "clean", fileId: JSON.parse(init.body).fileId }),
    })));
    const phases = [];
    await addMemberCaseFile(client, "case-1", new File(["heic"], "IMG_0042.heic", { type: "image/heic" }), {
      onPhase: (phase) => phases.push(phase),
    });
    expect(phases).toEqual(["preparing", "converting", "uploading", "checking", "confirming", "done"]);
  });

  // A file the server can never accept must be refused with ZERO network: no
  // begin RPC, no inspection request, no minted row, no spent quota.
  it("refuses an unsupported format before any network happens", async () => {
    const rpc = vi.fn();
    const client = { rpc, storage: { from: vi.fn() }, auth: { getSession: vi.fn() } };
    vi.stubGlobal("fetch", vi.fn());
    await expect(addMemberCaseFile(client, "case-1", new File(["gif"], "animation.gif", { type: "image/gif" })))
      .rejects.toMatchObject({ privateFileCode: "invalid-format", details: "private_file_invalid_format" });
    expect(rpc).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(client.storage.from).not.toHaveBeenCalled();
  });

  it("refuses a file one byte past the ceiling before any network happens", async () => {
    const rpc = vi.fn();
    const client = { rpc, storage: { from: vi.fn() }, auth: { getSession: vi.fn() } };
    vi.stubGlobal("fetch", vi.fn());
    await expect(addMemberCaseFile(client, "case-1", { name: "evidence.pdf", type: "application/pdf", size: 10485761 }))
      .rejects.toMatchObject({ privateFileCode: "invalid-size", details: "private_file_invalid_size" });
    expect(rpc).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(client.storage.from).not.toHaveBeenCalled();
  });
});
