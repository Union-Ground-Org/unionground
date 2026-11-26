// @vitest-environment jsdom
//
// REQ-UG-EVIDENCE-UPLOAD-NAMES-PREVIEWS-20260928.
//
// The property under test is that choosing a file and uploading it are two
// separate decisions, and that the member's half of them survives everything
// the server can answer. Three of these cases exist because the single-step
// upload path lost work: a rate-limited attempt discarded the selection, a
// permanent rejection invited a retry that could only spend another inspection
// attempt, and a renamed file was never actually delivered under its new name.
//
// The boundaries pinned here are copied from the server and must not drift:
// 10485760 bytes exactly, the post-conversion extension allowlist, and HEIC
// conversion BEFORE naming and validation.
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceUpload } from "../src/components/EvidenceUpload.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import {
  EVIDENCE_UPLOAD_ACCEPT,
  EVIDENCE_UPLOAD_COPY,
  EVIDENCE_UPLOAD_EXTENSIONS,
  EVIDENCE_UPLOAD_MAX_BYTES,
  EVIDENCE_UPLOAD_TEXT_PREVIEW_BYTES,
  evidenceUploadText,
  readBoundedUploadText,
  renameUploadFile,
  sanitizeUploadStem,
  splitUploadName,
  uploadErrorIsPermanent,
  uploadErrorToken,
  uploadExtensionKey,
  uploadFinalName,
  uploadPreviewKind,
  validatePreparedUpload,
} from "../src/lib/evidenceUpload.js";

const en = (key, vars) => evidenceUploadText("en", key, vars);
const es = (key, vars) => evidenceUploadText("es", key, vars);

beforeEach(() => {
  // jsdom has object URLs, but the panel must not depend on a real one: the
  // preview is the only consumer and it is revoked by hand.
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:evidence-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fileOf(name, { type = "", body = "evidence-bytes", size = null } = {}) {
  const file = new File([body], name, { type });
  // A ten-megabyte Uint8Array per boundary case buys nothing: every check on
  // this path reads `size`, never the bytes.
  if (size !== null) Object.defineProperty(file, "size", { value: size });
  return file;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function stubHeicDecoder({ encodes = true } = {}) {
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 3, height: 2, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
    callback(encodes ? new Blob(["jpeg-bytes"], { type }) : null);
  });
}

function renderPanel(props = {}, lang = "en") {
  const merged = { onUpload: vi.fn().mockResolvedValue({}), ...props };
  const view = render(
    <LanguageProvider lang={lang}><EvidenceUpload {...merged} /></LanguageProvider>,
  );
  return {
    props: merged,
    ...view,
    rescope: (scopeKey) => view.rerender(
      <LanguageProvider lang={lang}><EvidenceUpload {...merged} scopeKey={scopeKey} /></LanguageProvider>,
    ),
  };
}

// The picker's accessible name is the only thing that changes between an empty
// panel and a staged one, so one regex reaches it in both states.
const picker = () => screen.getByLabelText(/Choose a/);
const nameField = () => screen.getByLabelText(en("evidenceUpload.nameLabel"));
const status = () => screen.getByRole("status");

async function stage(file) {
  fireEvent.change(picker(), { target: { files: [file] } });
  await waitFor(() => expect(status()).toHaveTextContent(en("evidenceUpload.stage.staged")));
  // A pending control stays enabled (record 8435): wait for its busy state to clear.
  await waitFor(() => { const control = screen.getByRole("button", { name: en("evidenceUpload.upload") }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
}

describe("evidence upload naming", () => {
  // REQ-UG-SINGLE-SIGHTING-DEFECTS-20261030 (finding 112): a member
  // reported the name box showing only ".png". A picked PNG stages with its
  // own stem in the box, and a box emptied by hand comes back as a real name,
  // so the stored name is never the bare extension.
  it("stages a picked photo under its own name and never stores a bare extension", async () => {
    renderPanel();
    await stage(fileOf("blackout_posting_photo.png", { type: "image/png" }));
    expect(nameField()).toHaveValue("blackout_posting_photo");
    expect(screen.getByText(en("evidenceUpload.finalName")).parentElement).toHaveTextContent("blackout_posting_photo.png");
    fireEvent.change(nameField(), { target: { value: "" } });
    fireEvent.blur(nameField());
    expect(nameField()).toHaveValue("evidence");
    expect(screen.getByText(en("evidenceUpload.finalName")).parentElement).toHaveTextContent("evidence.png");
  });

  it("splits the editable stem from the extension the inspector holds the file to", () => {
    expect(splitUploadName("scan.2026.09.28.pdf")).toEqual({ stem: "scan.2026.09.28", extension: ".pdf" });
    // A leading dot is a stem, not an extension.
    expect(splitUploadName(".htaccess")).toEqual({ stem: ".htaccess", extension: "" });
    expect(splitUploadName("noextension")).toEqual({ stem: "noextension", extension: "" });
    expect(splitUploadName(undefined)).toEqual({ stem: "", extension: "" });
    expect(uploadExtensionKey("Photo.JPEG")).toBe("jpeg");
  });

  it("removes what a stored filename must never carry and keeps what a member typed", () => {
    // Path separators are refused by the row constraint outright; degrading them
    // to spaces leaves a legible name instead of a silent deletion.
    expect(sanitizeUploadStem("../../etc/passwd")).toBe("etc passwd");
    expect(sanitizeUploadStem("notes\\draft")).toBe("notes draft");
    // A right-to-left override makes the visible name disagree with the stored
    // bytes — a filename that lies about its own extension to every later reader.
    expect(sanitizeUploadStem("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeUploadStem("report\u0000\u0007 v2")).toBe("report v2");
    expect(sanitizeUploadStem("  Step 2  evidence  ")).toBe("Step 2 evidence");
    expect(sanitizeUploadStem("acuerdo  días")).toBe("acuerdo días");
    // Nothing usable left, and the empty cases: never an empty filename.
    expect(sanitizeUploadStem("...")).toBe("evidence");
    expect(sanitizeUploadStem("")).toBe("evidence");
    expect(sanitizeUploadStem(null)).toBe("evidence");
  });

  it("bounds the stem by code point and the whole name by the row ceiling", () => {
    const long = sanitizeUploadStem("a".repeat(200));
    expect(long).toHaveLength(96);
    // Slicing UTF-16 units would cut a surrogate pair in half and leave the very
    // class of character the sanitizer just removed.
    const emoji = sanitizeUploadStem("🧾".repeat(200));
    expect([...emoji]).toHaveLength(96);
    expect(emoji.includes("�")).toBe(false);
    const name = uploadFinalName(fileOf(`${"b".repeat(400)}.pdf`), "b".repeat(400));
    expect(name.length).toBeLessThanOrEqual(160);
    expect(name.endsWith(".pdf")).toBe(true);
  });

  it("delivers the sanitized stem under the prepared file's own extension", () => {
    const file = fileOf("IMG_0042.jpg", { type: "image/jpeg" });
    const renamed = renameUploadFile(file, "  Delegate meeting/notes ");
    expect(renamed.name).toBe("Delegate meeting notes.jpg");
    expect(renamed.type).toBe("image/jpeg");
    expect(renamed.size).toBe(file.size);
    // An untouched name delivers the object that was validated, not a copy.
    expect(renameUploadFile(file, "IMG_0042")).toBe(file);
  });
});

describe("evidence upload refusals", () => {
  it("accepts exactly the 10 MiB ceiling and refuses one byte past it", () => {
    expect(validatePreparedUpload(fileOf("a.pdf", { size: EVIDENCE_UPLOAD_MAX_BYTES }))).toBeNull();
    expect(EVIDENCE_UPLOAD_MAX_BYTES).toBe(10485760);
    expect(validatePreparedUpload(fileOf("a.pdf", { size: EVIDENCE_UPLOAD_MAX_BYTES + 1 }))).toBe("tooLarge");
    expect(validatePreparedUpload(fileOf("a.pdf", { size: 1 }))).toBeNull();
    expect(validatePreparedUpload(fileOf("a.pdf", { size: 0 }))).toBe("empty");
    expect(validatePreparedUpload(null)).toBe("empty");
  });

  it("holds the post-conversion allowlist, which is not the picker's accept list", () => {
    // The extension half of the inspector's exact MIME-to-extension pairing
    // (api/_lib/privateFileSafety.js). Pinned by value: a drift here is a
    // refusal the member reads only after the upload has been spent.
    expect([...EVIDENCE_UPLOAD_EXTENSIONS])
      .toEqual(["pdf", "jpg", "jpeg", "png", "webp", "txt", "csv", "docx", "xlsx"]);
    for (const extension of EVIDENCE_UPLOAD_EXTENSIONS) {
      expect(validatePreparedUpload(fileOf(`a.${extension}`))).toBeNull();
    }
    expect(validatePreparedUpload(fileOf("a.PDF"))).toBeNull();
    // HEIC is offered by the picker and refused here on purpose: the buckets do
    // not accept it, so anything reaching validation must already be converted.
    expect(validatePreparedUpload(fileOf("photo.heic"))).toBe("unsupportedExtension");
    expect(validatePreparedUpload(fileOf("photo.heif"))).toBe("unsupportedExtension");
    expect(validatePreparedUpload(fileOf("setup.exe"))).toBe("unsupportedExtension");
    expect(validatePreparedUpload(fileOf("archive.zip"))).toBe("unsupportedExtension");
    expect(validatePreparedUpload(fileOf("noextension"))).toBe("unsupportedExtension");
    expect(EVIDENCE_UPLOAD_ACCEPT).toContain(".heic");
    expect(EVIDENCE_UPLOAD_ACCEPT).toContain(".heif");
  });

  it("maps every server answer to its own sentence, and an unknown one to the retryable sentence", () => {
    expect(uploadErrorToken({ privateFileCode: "rejected" })).toBe("rejected");
    expect(uploadErrorToken({ privateFileCode: "pending-check" })).toBe("pendingCheck");
    expect(uploadErrorToken({ privateFileCode: "rate-limited" })).toBe("rateLimited");
    expect(uploadErrorToken({ privateFileCode: "stale" })).toBe("stale");
    expect(uploadErrorToken({ privateFileCode: "unavailable" })).toBe("unavailable");
    expect(uploadErrorToken({ privateFileCode: "invalid-format" })).toBe("unsupportedExtension");
    expect(uploadErrorToken({ details: "private_file_invalid_size" })).toBe("invalidSize");
    // The same decision spelled as the i18n token a re-wrapping caller keeps.
    expect(uploadErrorToken({ details: "private_file_rejected" })).toBe("rejected");
    expect(uploadErrorToken({ details: "private_file_rate_limited" })).toBe("rateLimited");
    expect(uploadErrorToken({ code: "unsupported-format" })).toBe("unsupportedFormat");
    expect(uploadErrorToken({ details: "private_file_unsupported_format" })).toBe("unsupportedFormat");
    // A dropped connection is not evidence that these bytes were refused.
    expect(uploadErrorToken(new TypeError("Failed to fetch"))).toBe("unavailable");
    expect(uploadErrorToken({ privateFileCode: "toString" })).toBe("unavailable");
    expect(uploadErrorToken(undefined)).toBe("unavailable");
    for (const token of ["rejected", "unsupportedFormat", "tooLarge", "unsupportedExtension", "empty", "invalidSize"]) {
      expect(uploadErrorIsPermanent(token)).toBe(true);
    }
    for (const token of ["pendingCheck", "rateLimited", "stale", "unavailable", null]) {
      expect(uploadErrorIsPermanent(token)).toBe(false);
    }
  });

  it("chooses a preview by extension and bounds the text it reads", async () => {
    expect(uploadPreviewKind(fileOf("a.png"))).toBe("image");
    expect(uploadPreviewKind(fileOf("a.webp"))).toBe("image");
    expect(uploadPreviewKind(fileOf("a.csv"))).toBe("text");
    expect(uploadPreviewKind(fileOf("a.pdf"))).toBe("document");
    expect(uploadPreviewKind(fileOf("a.docx"))).toBe("document");

    const short = await readBoundedUploadText(fileOf("a.txt", { body: "line one\r\nline two\u0000" }));
    expect(short.text).toBe("line one\nline two");
    expect(short.truncated).toBe(false);
    const long = await readBoundedUploadText(fileOf("a.txt", { body: "x".repeat(40) }), 10);
    expect(long.text).toBe("x".repeat(10));
    expect(long.truncated).toBe(true);
    // The default bound is the one the panel uses; a preview is reassurance
    // that the right file was picked, not a document viewer.
    expect(EVIDENCE_UPLOAD_TEXT_PREVIEW_BYTES).toBe(2048);
    const defaulted = await readBoundedUploadText(fileOf("a.txt", { body: "y".repeat(EVIDENCE_UPLOAD_TEXT_PREVIEW_BYTES + 50) }));
    expect(defaulted.text).toHaveLength(EVIDENCE_UPLOAD_TEXT_PREVIEW_BYTES);
    expect(defaulted.truncated).toBe(true);
    // An unreadable local file leaves the preview empty; it does not fail the
    // upload the member can still send.
    const unreadable = fileOf("a.txt");
    vi.spyOn(unreadable, "slice").mockReturnValue({ text: () => Promise.reject(new Error("gone")) });
    expect((await readBoundedUploadText(unreadable)).text).toBe("");
  });
});

// src/lib/i18n.js is not touched by this component, so tests/i18n.test.js
// cannot see this dictionary. These are the two guarantees it would otherwise
// give: both locales carry the same keys, and every key the component asks for
// exists.
describe("evidence upload copy", () => {
  it("carries the same keys in English and Spanish, with no English left in the Spanish table", () => {
    const keys = Object.keys(EVIDENCE_UPLOAD_COPY.en).sort();
    expect(keys.length).toBeGreaterThan(20);
    expect(Object.keys(EVIDENCE_UPLOAD_COPY.es).sort()).toEqual(keys);
    for (const key of keys) {
      expect(EVIDENCE_UPLOAD_COPY.es[key], key).toBeTypeOf("string");
      expect(EVIDENCE_UPLOAD_COPY.es[key].trim(), key).not.toBe("");
      // "{kilobytes} KB" is the one string that is the same in both languages.
      if (key !== "evidenceUpload.size.kb") {
        expect(EVIDENCE_UPLOAD_COPY.es[key], key).not.toBe(EVIDENCE_UPLOAD_COPY.en[key]);
      }
      // An interpolation that exists in one language and not the other prints a
      // sentence with a hole in it.
      const vars = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      expect(vars(EVIDENCE_UPLOAD_COPY.es[key]), key).toEqual(vars(EVIDENCE_UPLOAD_COPY.en[key]));
    }
  });

  it("defines every key the component asks for, including the interpolated families", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/EvidenceUpload.jsx"), "utf8");
    const quoted = [...source.matchAll(/"(evidenceUpload\.[\w.]+)"/g)].map((match) => match[1]);
    expect(quoted.length).toBeGreaterThan(10);
    for (const key of quoted) expect(Object.hasOwn(EVIDENCE_UPLOAD_COPY.en, key), key).toBe(true);
    // The two families built from a token rather than written out.
    for (const stage of ["preparing", "converting", "staged", "uploading", "checking", "confirming", "done"]) {
      expect(Object.hasOwn(EVIDENCE_UPLOAD_COPY.en, `evidenceUpload.stage.${stage}`), stage).toBe(true);
    }
    for (const token of ["empty", "tooLarge", "unsupportedExtension", "unsupportedFormat", "rejected", "pendingCheck", "rateLimited", "stale", "unavailable"]) {
      expect(Object.hasOwn(EVIDENCE_UPLOAD_COPY.en, `evidenceUpload.error.${token}`), token).toBe(true);
    }
    // An unknown language falls back to English rather than printing the key.
    expect(evidenceUploadText("fr", "evidenceUpload.upload")).toBe(en("evidenceUpload.upload"));
  });
});

describe("EvidenceUpload panel", () => {
  it("hides the previous record's preview before passive scope cleanup runs", async () => {
    const observed = [];
    function Host({ scope }) {
      useLayoutEffect(() => {
        if (scope === "new") observed.push(screen.queryByRole("img"), screen.queryByLabelText(en("evidenceUpload.nameLabel")));
      }, [scope]);
      return <LanguageProvider lang="en"><EvidenceUpload scopeKey={scope} onUpload={vi.fn()} /></LanguageProvider>;
    }
    const view = render(<Host scope="old" />);
    await stage(fileOf("private.png", { type: "image/png" }));
    expect(screen.getByRole("img")).toBeInTheDocument();
    view.rerender(<Host scope="new" />);
    expect(observed).toEqual([null, null]);
  });

  it("retains an ambiguous attempt and checks its status using the locked original name", async () => {
    const resume = vi.fn().mockResolvedValue({ id: "same-file" });
    const onUpload = vi.fn(async (_file, options) => {
      if (options.retryUpload) return options.retryUpload(options.onPhase);
      throw Object.assign(new Error("confirmation lost"), { retryUpload: resume });
    });
    renderPanel({ onUpload });
    await stage(fileOf("original.pdf", { type: "application/pdf" }));
    fireEvent.change(nameField(), { target: { value: "Evidence title" } });
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    const check = await screen.findByRole("button", { name: en("evidenceUpload.reconcile") });
    expect(nameField()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(en("evidenceUpload.error.reconcile"));
    fireEvent.click(check);
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[1][0]).toBe(onUpload.mock.calls[0][0]);
    expect(onUpload.mock.calls[1][0].name).toBe("Evidence title.pdf");
  });

  it("states the formats, the ceiling, the conversion caveat and the server check before anything is picked", () => {
    const { props } = renderPanel({ label: "Attach case evidence" });
    expect(screen.getByRole("heading", { name: en("evidenceUpload.title") })).toBeInTheDocument();
    expect(screen.getByText(en("evidenceUpload.formats"))).toBeInTheDocument();
    expect(screen.getByText(en("evidenceUpload.size"))).toBeInTheDocument();
    expect(screen.getByText(en("evidenceUpload.conversion"))).toBeInTheDocument();
    // The honesty line: the client allowlist is a courtesy, the server decides.
    expect(screen.getByText(en("evidenceUpload.inspection"))).toBeInTheDocument();
    expect(screen.getByLabelText("Attach case evidence")).toHaveAttribute("accept", EVIDENCE_UPLOAD_ACCEPT);
    // Nothing is staged, so there is no name to edit and nothing to send.
    expect(screen.queryByLabelText(en("evidenceUpload.nameLabel"))).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en("evidenceUpload.upload") })).not.toBeInTheDocument();
    expect(props.onUpload).not.toHaveBeenCalled();
  });

  it("stages a pick without uploading, previews it, and delivers the edited name on Upload", async () => {
    const gate = deferred();
    const onUpload = vi.fn(() => gate.promise);
    renderPanel({ onUpload });

    await stage(fileOf("Screenshot 2026-09-28.png", { type: "image/png" }));
    // Picking is not uploading. This is the whole point of the panel.
    expect(onUpload).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent(en("evidenceUpload.stage.staged"));
    expect(screen.getByRole("img", { name: /Screenshot 2026-09-28\.png/ })).toHaveAttribute("src", "blob:evidence-preview");
    expect(nameField()).toHaveValue("Screenshot 2026-09-28");

    fireEvent.change(nameField(), { target: { value: "../../etc/Step 2 evidence" } });
    // The name that will actually be stored is shown before the member commits.
    expect(screen.getByText("etc Step 2 evidence.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    const [delivered, options] = onUpload.mock.calls[0];
    expect(delivered.name).toBe("etc Step 2 evidence.png");
    expect(delivered.type).toBe("image/png");
    expect(options.onPhase).toBeTypeOf("function");

    // The host's phase tokens name the stage the member is waiting on.
    act(() => options.onPhase("checking"));
    await waitFor(() => expect(status()).toHaveTextContent(en("evidenceUpload.stage.checking")));
    // A failure token arriving on the same callback must not pre-empt the
    // promise: it is the rejection that decides what the member reads.
    act(() => options.onPhase("pending-check"));
    expect(status()).toHaveTextContent(en("evidenceUpload.stage.checking"));

    await act(async () => { gate.resolve({ id: "file-1" }); });
    await waitFor(() => expect(status()).toHaveTextContent(en("evidenceUpload.stage.done")));
    expect(screen.queryByLabelText(en("evidenceUpload.nameLabel"))).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:evidence-preview");
  });

  it("keeps the file and the edited name for a retry after a retryable failure", async () => {
    const onUpload = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("hourly limit"), { privateFileCode: "rate-limited" }))
      .mockResolvedValue({ id: "file-2" });
    renderPanel({ onUpload });

    await stage(fileOf("grievance.pdf", { type: "application/pdf" }));
    fireEvent.change(nameField(), { target: { value: "Step 2 packet" } });
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(en("evidenceUpload.error.rateLimited"));
    // The recovery this panel exists for: the selection and the typed name are
    // still here, so the retry costs one press and not a trip to the folder.
    expect(nameField()).toHaveValue("Step 2 packet");
    expect(screen.queryByText(en("evidenceUpload.permanent"))).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.retry") }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls[1][0].name).toBe("Step 2 packet.pdf");
    await waitFor(() => expect(status()).toHaveTextContent(en("evidenceUpload.stage.done")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("withholds retry after a rejection and recovers only when a different file is chosen", async () => {
    const onUpload = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("refused"), { privateFileCode: "rejected" }))
      .mockResolvedValue({ id: "file-3" });
    renderPanel({ onUpload });

    await stage(fileOf("macro.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en("evidenceUpload.error.rejected"));
    // A decision about these bytes. Another attempt can only spend another
    // inspection attempt to be told the same thing.
    expect(within(alert).getByText(en("evidenceUpload.permanent"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en("evidenceUpload.upload") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en("evidenceUpload.retry") })).not.toBeInTheDocument();
    // The refused file stays visible, so the member can see which one it was.
    expect(nameField()).toHaveValue("macro");
    expect(onUpload).toHaveBeenCalledTimes(1);

    await stage(fileOf("clean.pdf", { type: "application/pdf" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls[1][0].name).toBe("clean.pdf");
  });

  it("refuses an oversized file before the upload and stages one exactly at the ceiling", async () => {
    const { props } = renderPanel();
    fireEvent.change(picker(), { target: { files: [fileOf("huge.pdf", { size: EVIDENCE_UPLOAD_MAX_BYTES + 1 })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(en("evidenceUpload.error.tooLarge"));
    expect(screen.queryByLabelText(en("evidenceUpload.nameLabel"))).not.toBeInTheDocument();
    expect(props.onUpload).not.toHaveBeenCalled();

    await stage(fileOf("exact.pdf", { size: EVIDENCE_UPLOAD_MAX_BYTES, type: "application/pdf" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));
    expect(props.onUpload.mock.calls[0][0].size).toBe(EVIDENCE_UPLOAD_MAX_BYTES);
  });

  it("refuses a type outside the allowlist without spending an upload", async () => {
    const { props } = renderPanel();
    fireEvent.change(picker(), { target: { files: [fileOf("setup.exe", { type: "application/octet-stream" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(en("evidenceUpload.error.unsupportedExtension"));
    expect(props.onUpload).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: en("evidenceUpload.upload") })).not.toBeInTheDocument();
  });

  it("converts a HEIC photo before naming and validation, and delivers the JPEG", async () => {
    stubHeicDecoder();
    const { props } = renderPanel();
    await stage(fileOf("IMG_0042.HEIC", { type: "image/heic" }));
    // The extension the member cannot edit is the CONVERTED one, because it is
    // what the inspector compares against the bytes.
    expect(nameField()).toHaveValue("IMG_0042");
    expect(screen.getByText(".jpg")).toBeInTheDocument();
    expect(screen.getByText("IMG_0042.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));
    const delivered = props.onUpload.mock.calls[0][0];
    expect(delivered.name).toBe("IMG_0042.jpg");
    expect(delivered.type).toBe("image/jpeg");
  });

  it("says one specific sentence when this browser cannot convert the photo", async () => {
    // No createImageBitmap: Chrome and Firefox on most platforms.
    const { props } = renderPanel();
    fireEvent.change(picker(), { target: { files: [fileOf("IMG_0043.heic", { type: "image/heic" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(en("evidenceUpload.error.unsupportedFormat"));
    expect(screen.getByText(en("evidenceUpload.permanent"))).toBeInTheDocument();
    expect(props.onUpload).not.toHaveBeenCalled();
  });

  it("shows a bounded, escaped text preview and never a frame for uninspected bytes", async () => {
    renderPanel();
    await stage(fileOf("rows.csv", { type: "text/csv", body: "name,<script>alert(1)</script>\n=WEBSERVICE(\"x\")" }));
    const preview = screen.getByText(/WEBSERVICE/);
    expect(preview.tagName).toBe("PRE");
    // React renders it as text; the markup in the file is content, not markup.
    expect(preview.textContent).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    await stage(fileOf("contract.pdf", { type: "application/pdf" }));
    // No inline renderer exists here that is safe to point at bytes nothing has
    // inspected, so the honest answer is a file card.
    expect(screen.getByText(en("evidenceUpload.preview.document"))).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("embed")).toBeNull();
    expect(document.querySelector("object")).toBeNull();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("revokes the preview URL when the selection is replaced, cancelled and unmounted", async () => {
    URL.createObjectURL.mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
    const { unmount } = renderPanel();
    await stage(fileOf("first.png", { type: "image/png" }));
    await stage(fileOf("second.png", { type: "image/png" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:first");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:second");

    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.cancel") }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:second");
    expect(screen.queryByLabelText(en("evidenceUpload.nameLabel"))).not.toBeInTheDocument();

    URL.createObjectURL.mockReturnValue("blob:third");
    await stage(fileOf("third.png", { type: "image/png" }));
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:third");
  });

  it("falls back to a file card when the browser refuses an object URL", async () => {
    URL.createObjectURL.mockImplementation(() => { throw new Error("blob quota exceeded"); });
    renderPanel();
    await stage(fileOf("photo.png", { type: "image/png" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(en("evidenceUpload.preview.document"))).toBeInTheDocument();
    // The upload itself is unaffected by a missing preview.
    expect(screen.getByRole("button", { name: en("evidenceUpload.upload") })).toBeEnabled();
  });

  it("discards the staged file on a scope change and lets a late result land on the floor", async () => {
    const gate = deferred();
    const onUpload = vi.fn(() => gate.promise);
    const { rescope } = renderPanel({ onUpload, scopeKey: "case-1" });
    await stage(fileOf("case-one.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));

    rescope("case-2");
    // The panel now points at another entity; the staged file belonged to the
    // previous one.
    expect(screen.queryByLabelText(en("evidenceUpload.nameLabel"))).not.toBeInTheDocument();
    expect(status()).toHaveTextContent("");

    await act(async () => { gate.resolve({ id: "file-late" }); });
    await Promise.resolve();
    await waitFor(() => expect(status()).toHaveTextContent(""));
    expect(screen.queryByText(en("evidenceUpload.stage.done"))).not.toBeInTheDocument();
  });

  it("does not surface a late failure from an upload the scope change abandoned", async () => {
    const gate = deferred();
    const onUpload = vi.fn(() => gate.promise);
    const { rescope } = renderPanel({ onUpload, scopeKey: "case-1" });
    await stage(fileOf("case-one.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));

    rescope("case-2");
    await act(async () => { gate.reject(Object.assign(new Error("gone"), { privateFileCode: "pending-check" })); });
    await waitFor(() => expect(status()).toHaveTextContent(""));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // Record 8435: the previous scope's upload holds its own
  // lock; a file staged for the new scope uploads at once, as on Main.
  it("uploads at once in a new scope while the previous scope's upload is still running", async () => {
    const gate = deferred();
    const onUpload = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue({ id: "file-2" });
    const { rescope } = renderPanel({ onUpload, scopeKey: "case-1" });
    await stage(fileOf("case-one.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));

    rescope("case-2");
    await stage(fileOf("case-two.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls[1][0].name).toBe("case-two.pdf");
    await act(async () => { gate.resolve({ id: "file-late" }); });
  });

  // Record 8435 (review P1 of #8887): the lock is the entity's. Leaving the case
  // and coming back while its upload still runs refuses a second upload to it.
  it("refuses a second upload to a case the panel left and came back to while its upload runs", async () => {
    const gate = deferred();
    const onUpload = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue({ id: "file-2" });
    const { rescope } = renderPanel({ onUpload, scopeKey: "case-a" });
    await stage(fileOf("case-a.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));

    rescope("case-b");
    rescope("case-a");
    await stage(fileOf("case-a-again.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await act(async () => { await Promise.resolve(); });
    expect(onUpload).toHaveBeenCalledTimes(1);
    await act(async () => { gate.resolve({ id: "file-1" }); });
  });

  it("ignores a superseded pick when a second file is chosen while the first is still preparing", async () => {
    const { props } = renderPanel();
    // Both changes fire before either conversion probe settles.
    fireEvent.change(picker(), { target: { files: [fileOf("first.png", { type: "image/png" })] } });
    fireEvent.change(picker(), { target: { files: [fileOf("second.png", { type: "image/png" })] } });
    await waitFor(() => expect(status()).toHaveTextContent(en("evidenceUpload.stage.staged")));
    expect(nameField()).toHaveValue("second");
    expect(screen.getAllByLabelText(en("evidenceUpload.nameLabel"))).toHaveLength(1);
    // The abandoned pick stops before it mints a preview, so there is no object
    // URL for the one that lost to be leaked under the one that won.
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));
    expect(props.onUpload.mock.calls[0][0].name).toBe("second.png");
  });

  it("reports busy to the host, and a host lock arriving mid-upload does not invalidate the upload", async () => {
    const gate = deferred();
    const onUpload = vi.fn(() => gate.promise);
    const seen = [];
    // The realistic host: it mirrors our busy flag straight back as `disabled`.
    function Host() {
      const [busy, setBusy] = useState(false);
      return <LanguageProvider lang="en">
        <EvidenceUpload
          onUpload={onUpload}
          disabled={busy}
          onBusyChange={(value) => { seen.push(value); setBusy(value); }}
        />
      </LanguageProvider>;
    }
    render(<Host />);
    await stage(fileOf("evidence.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(seen).toContain(true);
    // disabled is now true because of our own onBusyChange. The in-flight
    // upload must still finish and clear; only STARTING work is gated.
    expect(screen.getByRole("button", { name: en("evidenceUpload.upload") })).toHaveAttribute("aria-disabled", "true");
    expect(picker()).toBeDisabled();

    await act(async () => { gate.resolve({ id: "file-4" }); });
    await waitFor(() => expect(status()).toHaveTextContent(en("evidenceUpload.stage.done")));
    await waitFor(() => expect(picker()).toBeEnabled());
    expect(seen.at(-1)).toBe(false);
  });

  it("unlocks the host if the panel is unmounted while an upload is running", async () => {
    const gate = deferred();
    const seen = [];
    const { unmount } = renderPanel({ onUpload: vi.fn(() => gate.promise), onBusyChange: (value) => seen.push(value) });
    await stage(fileOf("evidence.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(seen).toContain(true));
    unmount();
    expect(seen.at(-1)).toBe(false);
    // A host whose state update throws must not break the upload transaction.
    await act(async () => { gate.resolve({}); });
  });

  it("keeps the file locked after the API reports done until the host finishes refreshing", async () => {
    const gate = deferred();
    renderPanel({ onUpload: (_file, { onPhase }) => { onPhase("done"); return gate.promise; } });
    await stage(fileOf("evidence.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(status()).toHaveTextContent(en("evidenceUpload.stage.confirming")));
    expect(nameField()).toBeEnabled();
    expect(nameField()).toHaveAttribute("aria-disabled", "true");
    expect(nameField()).toHaveAttribute("readonly");
    expect(picker()).toBeDisabled();
    expect(screen.getByRole("button", { name: en("evidenceUpload.upload") })).toHaveAttribute("aria-disabled", "true");
    await act(async () => { gate.resolve({}); });
    await waitFor(() => expect(status()).toHaveTextContent(en("evidenceUpload.stage.done")));
    expect(picker()).toBeEnabled();
  });

  // The name field stays focused while the upload runs; it is
  // read-only and refuses edits rather than disabling under the keyboard.
  it("keeps the focused name field in place and read-only while the upload runs", async () => {
    enableFocusFixup();
    const gate = deferred();
    const onUpload = vi.fn(() => gate.promise);
    renderPanel({ onUpload });
    await stage(fileOf("evidence.pdf", { type: "application/pdf" }));
    const name = nameField();
    name.focus();
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    expect(onUpload).toHaveBeenCalledOnce();
    await act(async () => { await afterRenderingUpdate(); });
    expect(name).toBeEnabled();
    expect(name).toHaveAttribute("aria-disabled", "true");
    expect(name).toHaveFocus();
    const before = name.value;
    fireEvent.change(name, { target: { value: "renamed" } });
    expect(name).toHaveValue(before);
    await act(async () => { gate.resolve({}); });
    await waitFor(() => expect(status()).toHaveTextContent(en("evidenceUpload.stage.done")));
  });

  it("releases a failed image preview and retains the file for inspection on upload", async () => {
    const { props } = renderPanel();
    await stage(fileOf("image.png", { type: "image/png" }));
    fireEvent.error(screen.getByRole("img"));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:evidence-preview");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(en("evidenceUpload.preview.document"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));
  });

  it("survives a host callback that throws", async () => {
    const onUpload = vi.fn().mockResolvedValue({});
    renderPanel({ onUpload, onBusyChange: () => { throw new Error("host state is gone"); } });
    await stage(fileOf("evidence.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(status()).toHaveTextContent(en("evidenceUpload.stage.done")));
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it("stays inert while the host has it disabled, and never uploads from the picker alone", async () => {
    const { props } = renderPanel({ disabled: true });
    expect(picker()).toBeDisabled();
    expect(props.onUpload).not.toHaveBeenCalled();
  });

  it("reads the same panel in Spanish, including the failure sentence", async () => {
    const onUpload = vi.fn().mockRejectedValue(Object.assign(new Error("no"), { details: "private_file_pending_check" }));
    render(<LanguageProvider lang="es"><EvidenceUpload onUpload={onUpload} /></LanguageProvider>);
    expect(screen.getByText(es("evidenceUpload.formats"))).toBeInTheDocument();
    expect(screen.getByText(es("evidenceUpload.inspection"))).toBeInTheDocument();
    const input = screen.getByLabelText(es("evidenceUpload.choose"));
    fireEvent.change(input, { target: { files: [fileOf("recibo.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(es("evidenceUpload.stage.staged")));
    expect(screen.getByLabelText(es("evidenceUpload.nameLabel"))).toHaveValue("recibo");
    fireEvent.click(screen.getByRole("button", { name: es("evidenceUpload.upload") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(es("evidenceUpload.error.pendingCheck"));
    expect(screen.getByRole("button", { name: es("evidenceUpload.retry") })).toBeInTheDocument();
  });

  it("normalizes the typed name on blur and never delivers an empty one", async () => {
    const { props } = renderPanel();
    await stage(fileOf("notes.txt", { type: "text/plain", body: "hello" }));
    fireEvent.change(nameField(), { target: { value: "   ...   " } });
    fireEvent.blur(nameField());
    expect(nameField()).toHaveValue("evidence");
    fireEvent.click(screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));
    expect(props.onUpload.mock.calls[0][0].name).toBe("evidence.txt");
  });
});

describe("EvidenceUpload keeps Upload focused while it uploads (record 8435)", () => {
  it("does nothing when the file picker closes without a file", () => {
    const onUpload = vi.fn();
    render(<LanguageProvider lang="en"><EvidenceUpload onUpload={onUpload} /></LanguageProvider>);
    fireEvent.change(picker(), { target: { files: [] } });
    expect(screen.queryByRole("button", { name: en("evidenceUpload.upload") })).toBeNull();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("keeps Upload focused through the upload even when the host mirrors busy back as disabled", async () => {
    const onUpload = vi.fn(async () => ({}));
    function Host() {
      const [busy, setBusy] = useState(false);
      return <LanguageProvider lang="en"><EvidenceUpload onUpload={onUpload} disabled={busy} onBusyChange={setBusy} /></LanguageProvider>;
    }
    render(<Host />);
    await stage(fileOf("evidence.pdf", { type: "application/pdf" }));
    await expectHeldWriteFocus(onUpload, screen.getByRole("button", { name: en("evidenceUpload.upload") }));
    expect(onUpload).toHaveBeenCalledTimes(1);
  });
});
