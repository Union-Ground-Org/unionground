import { confirmEvidenceUpload } from "./helpers/confirm-evidence-upload.js";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAX_STROKES } from "../src/components/SignaturePad.jsx";
import { FormFilingControls } from "../src/components/FormFilingControls.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const copy = {
  title: "Official filing",
  attachments: "Supporting attachments",
  addFile: "Attach file",
  noFiles: "No files attached.",
  openFile: "Open {name}",
  pendingFile: "Upload pending",
  openError: "Could not open that attachment. Try again.",
  removeFile: "Remove {name}",
  uploading: "Uploading…",
  uploadSuccess: "Attachment added.",
  uploadError: "Could not attach the file.",
  signature: "Draw your signature",
  signatureInstructions: "Use pointer or keyboard.",
  clearSignature: "Clear signature",
  emptySignature: "No signature drawn.",
  strokeCount: "Signature strokes: {n}",
  signatureCapReached: catalogue.en["forms.filing.signatureCapReached"],
  consent: "I intend this drawing to be my signature.",
  saveSignature: "Save signature",
  savingSignature: "Saving…",
  signatureRequired: "Draw and consent before saving.",
  signatureSaved: "Signature saved for this version.",
  signatureStale: "Your signature must be saved again after changes.",
  download: "Download filing copy",
  downloading: "Preparing copy…",
  share: "Share by email or another app",
  downloadReady: "Filing copy ready.",
  downloadOnly: "This device cannot share files here. Use the downloaded filing copy.",
  downloadError: "Could not prepare the filing copy.",
  shared: "Share sheet closed. Delivery is not confirmed.",
  demo: "Preview data only. Files and signatures reset with the demo.",
  checking: "Checking this file for safety…",
  rejected: "This file was rejected by the safety check and was not attached.",
  pendingCheck: "The safety check did not finish, so this file was not attached. Try again.",
  staleFile: "This file needs a fresh safety check before it can open.",
  rateLimited: "You have reached the hourly limit of 20 file checks, so this file was not attached. Try again later.",
  staleBadge: "Needs a fresh safety check",
  recheck: "Re-check this file",
  rechecking: "Re-checking…",
  unsupportedFormat: "This browser cannot convert that photo. Save it as JPEG or PNG, then attach it.",
};
const t = (key, vars = {}) => (copy[key] || key)
  .replace("{name}", vars.name || "")
  .replace("{n}", vars.n ?? "");
const fileRow = { id: "file-1", filename: "proof.pdf", sizeBytes: 2048 };

// The editor owns the pair the filing surface reports through: clearing the
// signature both disables Submit and paints the "save it again" warning, so a
// harness that wires them the way FormsView does is what makes a false stale
// visible in a test.
function SigningHarness({ onAddFile }) {
  const [ready, setReady] = useState(true);
  const [stale, setStale] = useState(false);
  return (
    <FormFilingControls
      t={t}
      editable
      files={[]}
      signatureCurrent={ready}
      signatureStale={stale}
      onAddFile={onAddFile}
      onSaveSignature={vi.fn()}
      onSignatureStateChange={(current) => { setReady(current); setStale(!current); }}
    />
  );
}

async function attach(name = "photo.heic", type = "image/heic") {
  fireEvent.change(screen.getByLabelText("Attach file"), { target: { files: [new File(["x"], name, { type })] } });
  if (!/\.hei[cf]$/i.test(name)) await confirmEvidenceUpload();
}

describe("FormFilingControls", () => {
  it("adds, opens and removes files with explicit pending and success status", async () => {
    let finish;
    const onAddFile = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const onOpenFile = vi.fn();
    const onRemoveFile = vi.fn().mockResolvedValue(undefined);
    render(<FormFilingControls t={t} editable files={[fileRow]} onAddFile={onAddFile} onOpenFile={onOpenFile} onRemoveFile={onRemoveFile} />);

    fireEvent.click(screen.getByRole("button", { name: "Open proof.pdf" }));
    expect(onOpenFile).toHaveBeenCalledWith(fileRow);
    await waitFor(() => expect(screen.getByLabelText("Attach file")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Attach file"), { target: { files: [new File(["pdf"], "new.pdf", { type: "application/pdf" })] } });
    await confirmEvidenceUpload();
    expect(screen.getByRole("status")).toHaveTextContent("Uploading…");
    expect(onAddFile).toHaveBeenCalledWith(expect.any(File), { onPhase: expect.any(Function) });
    finish({ id: "file-2", filename: "new.pdf", sizeBytes: 3 });
    expect(await screen.findByText("Attachment added.")).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("button", { name: "Remove proof.pdf" }));
    await waitFor(() => expect(onRemoveFile).toHaveBeenCalledWith(fileRow));
  });

  it("requires drawn strokes and explicit consent before saving a signature", async () => {
    const onSaveSignature = vi.fn().mockResolvedValue({ signedAt: "now" });
    render(<FormFilingControls t={t} editable files={[]} onSaveSignature={onSaveSignature} />);
    const save = screen.getByRole("button", { name: "Save signature" });
    expect(save).toHaveAttribute("aria-disabled", "true");

    const canvas = screen.getByLabelText("Draw your signature");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("checkbox", { name: copy.consent }));
    fireEvent.click(save);

    await waitFor(() => expect(onSaveSignature).toHaveBeenCalledWith(expect.any(Array), true, []));
    expect(screen.getByRole("status")).toHaveTextContent("Signature saved for this version.");
    expect(screen.getAllByText("Signature saved for this version.")).toHaveLength(1);
  });

  // #8702: the attachments on screen travel with the signature, and a refusal
  // because another session changed the form says so instead of asking for a
  // signature the member already drew.
  it.each(["en", "es"])("names the attachments shown and explains a changed-since-review refusal in %s", async (lang) => {
    const filingT = (key) => catalogue[lang][`forms.filing.${key}`] || key;
    const onSaveSignature = vi.fn().mockRejectedValue(Object.assign(new Error("form changed since review"), { code: "PT409", details: "form_changed_since_review" }));
    render(<FormFilingControls t={filingT} editable files={[{ id: "file-1", filename: "proof.pdf", sizeBytes: 3 }]} onSaveSignature={onSaveSignature} />);
    const canvas = screen.getByLabelText(catalogue[lang]["forms.filing.signature"]);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("checkbox", { name: catalogue[lang]["forms.filing.consent"] }));
    fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["forms.filing.saveSignature"] }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(catalogue[lang]["forms.filing.changedSinceReview"]));
    expect(onSaveSignature).toHaveBeenCalledWith(expect.any(Array), true, ["file-1"]);
    expect(screen.queryByText(catalogue[lang]["forms.filing.signatureRequired"])).toBeNull();
  });

  // #9462 W3b-8: a failed save said "Sign by drawing or by typing your name"
  // to someone who had just signed. Only sign_member_form's own replies,
  // matched whole, name a cause.
  const fail = (reply, code = "22023") => Object.assign(new Error(`Form signature: ${reply}`), { code });
  it.each([
    ["en", fail("Failed to fetch", null), "signatureNotSaved"],
    ["es", fail("Failed to fetch", null), "signatureNotSaved"],
    ["en", fail("authentication required", "42501"), "signatureSignIn"],
    ["es", fail("authentication required", "42501"), "signatureSignIn"],
    ["en", fail("JWT expired", "PGRST301"), "signatureSignIn"],
    ["es", fail("wait for every attachment upload to finish"), "signatureWaitFiles"],
    ["en", fail("wait for attachment deletion to finish"), "signatureWaitFiles"],
    ["en", fail("form not found or not signable"), "signatureNotSignable"],
    ["es", fail("form not found or not signable"), "signatureNotSignable"],
    ["en", fail("this form is not signable yet"), "signatureNotSaved"],
    ["en", { code: null }, "signatureNotSaved"],
  ])("in %s, says the signature was not saved and why (%s)", async (lang, failure, key) => {
    const c = (name) => catalogue[lang][`forms.filing.${name}`];
    render(<FormFilingControls t={(name) => c(name) || name} editable files={[]} onSaveSignature={vi.fn().mockRejectedValue(failure)} />);
    const canvas = screen.getByLabelText(c("signature"));
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("checkbox", { name: c("consent") }));
    fireEvent.click(screen.getByRole("button", { name: c("saveSignature") }));
    expect(c(key)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(c(key)));
    expect(screen.queryByText(c("signatureRequired"))).toBeNull();
  });

  // #9462 W3b-9: a failed removal said "Could not attach that file".
  it.each(["en", "es"])("in %s, says a failed removal did not remove the file", async (lang) => {
    const filingT = (name, vars = {}) => (catalogue[lang][`forms.filing.${name}`] || name).replace("{name}", vars.name || "");
    render(<FormFilingControls t={filingT} editable files={[fileRow]} onAddFile={vi.fn()} onOpenFile={vi.fn()} onRemoveFile={vi.fn().mockRejectedValue(new Error("Remove file: Failed to fetch"))} />);
    fireEvent.click(screen.getByRole("button", { name: filingT("removeFile", { name: "proof.pdf" }) }));
    expect(catalogue[lang]["forms.filing.removeError"]).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(catalogue[lang]["forms.filing.removeError"]));
    expect(screen.queryByText(catalogue[lang]["forms.filing.uploadError"])).toBeNull();
    expect(screen.getByText("proof.pdf")).toBeInTheDocument();
  });

  it.each(["en", "es"])("announces the filing pad cap notice in %s and clears it", (lang) => {
    const filingT = (key, vars = {}) => (catalogue[lang][`forms.filing.${key}`] || key)
      .replace("{name}", vars.name || "")
      .replace("{n}", vars.n ?? "");
    render(<FormFilingControls t={filingT} editable files={[]} onSaveSignature={vi.fn()} />);
    const canvas = screen.getByLabelText(catalogue[lang]["forms.filing.signature"]);
    for (let i = 0; i < MAX_STROKES; i += 1) {
      fireEvent.keyDown(canvas, { key: " " });
      fireEvent.keyDown(canvas, { key: " " });
    }
    fireEvent.keyDown(canvas, { key: " " });
    expect(screen.getByRole("note")).toHaveTextContent(catalogue[lang]["forms.filing.signatureCapReached"]);
    fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["forms.filing.clearSignature"] }));
    expect(screen.getByRole("note")).toHaveTextContent(catalogue[lang]["forms.filing.emptySignature"]);
  });

  it("offers truthful download/share controls only for an approved artifact", async () => {
    const pdf = new File(["%PDF"], "filing.pdf", { type: "application/pdf" });
    const onDownload = vi.fn().mockResolvedValue(pdf);
    const onShare = vi.fn().mockResolvedValue({ status: "shared" });
    render(<FormFilingControls t={t} approved demo files={[]} onDownload={onDownload} canShare={() => true} onShare={onShare} />);

    expect(screen.getByText(copy.demo)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download filing copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Share by email or another app" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Share by email or another app" }));
    await waitFor(() => expect(onShare).toHaveBeenCalledWith(pdf));
    expect(screen.getByRole("status")).toHaveTextContent("Delivery is not confirmed");
  });

  it("keeps retryable upload and download failures visible", async () => {
    render(<FormFilingControls t={t} editable approved files={[]} onAddFile={vi.fn().mockRejectedValue(new Error("offline"))} onDownload={vi.fn().mockRejectedValue(new Error("offline"))} />);
    fireEvent.change(screen.getByLabelText("Attach file"), { target: { files: [new File(["x"], "x.txt", { type: "text/plain" })] } });
    await confirmEvidenceUpload();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This file could not be attached right now."));
    expect(screen.getByLabelText("File name")).toHaveValue("x");
    fireEvent.click(screen.getByRole("button", { name: "Download filing copy" }));
    expect(await screen.findByText(copy.downloadError)).toHaveAttribute("role", "alert");
  });

  it("marks persisted pending uploads and reports an open failure", async () => {
    const onOpenFile = vi.fn().mockRejectedValue(new Error("expired"));
    render(<FormFilingControls t={t} editable files={[{ ...fileRow, confirmedAt: null }]} onOpenFile={onOpenFile} />);
    expect(screen.getByText(copy.pendingFile)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open proof.pdf" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy.openError));
  });

  it("explains the downloaded-file fallback when native sharing is unavailable", async () => {
    const pdf = new File(["%PDF"], "filing.pdf", { type: "application/pdf" });
    render(<FormFilingControls t={t} approved files={[]} onDownload={vi.fn().mockResolvedValue(pdf)} canShare={() => false} />);
    fireEvent.click(screen.getByRole("button", { name: "Download filing copy" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(copy.downloadOnly));
    expect(screen.queryByRole("button", { name: "Share by email or another app" })).toBeNull();
  });

  it("shows a checking state while a verdict is pending and nothing is attached yet", async () => {
    let release;
    const onAddFile = vi.fn((_file, { onPhase }) => new Promise((resolve) => {
      onPhase("checking");
      release = () => resolve({ id: "file-2", filename: "new.pdf", sizeBytes: 3 });
    }));
    render(<FormFilingControls t={t} editable files={[]} onAddFile={onAddFile} />);
    fireEvent.change(screen.getByLabelText("Attach file"), { target: { files: [new File(["pdf"], "new.pdf", { type: "application/pdf" })] } });
    await confirmEvidenceUpload();
    expect(await screen.findByText(copy.checking)).toHaveAttribute("role", "status");
    release();
    await waitFor(() => expect(screen.queryByText(copy.checking)).toBeNull());
  });

  it("states an upload rejection permanently and offers no retry", async () => {
    const rejected = Object.assign(new Error("refused"), { privateFileCode: "rejected" });
    render(<FormFilingControls t={t} editable files={[]} onAddFile={vi.fn().mockRejectedValue(rejected)} onRecheckFile={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Attach file"), { target: { files: [new File(["x"], "x.txt", { type: "text/plain" })] } });
    await confirmEvidenceUpload();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy.rejected));
    // A rejection is a decision about these bytes; a re-check cannot change it.
    expect(screen.queryByRole("button", { name: `${copy.recheck}: ${fileRow.filename}` })).toBeNull();
  });

  it("keeps the file unattached and says so when the verdict never arrived", async () => {
    const pending = Object.assign(new Error("scanner down"), { privateFileCode: "pending-check" });
    render(<FormFilingControls t={t} editable files={[]} onAddFile={vi.fn().mockRejectedValue(pending)} />);
    fireEvent.change(screen.getByLabelText("Attach file"), { target: { files: [new File(["x"], "x.txt", { type: "text/plain" })] } });
    await confirmEvidenceUpload();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy.pendingCheck));
  });

  it("offers exactly one re-check when a stale verdict blocks an open, then reopens", async () => {
    const stale = Object.assign(new Error("stale"), { privateFileCode: "stale" });
    const onOpenFile = vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce(undefined);
    const onRecheckFile = vi.fn().mockResolvedValue({ status: "clean" });
    render(<FormFilingControls t={t} editable files={[fileRow]} onOpenFile={onOpenFile} onRecheckFile={onRecheckFile} />);

    fireEvent.click(screen.getByRole("button", { name: "Open proof.pdf" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy.staleFile));
    fireEvent.click(screen.getByRole("button", { name: `${copy.recheck}: ${fileRow.filename}` }));
    await waitFor(() => expect(onRecheckFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: `${copy.recheck}: ${fileRow.filename}` })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open proof.pdf" }));
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(2));
    expect(onRecheckFile).toHaveBeenCalledTimes(1);
  });

  // A quota refusal is a decision about this ACTOR for the rest of the hour, not
  // an unfinished check. Showing "try again" told a member to repeat an
  // operation that cannot succeed.
  it("names the real hourly ceiling instead of inviting a retry", async () => {
    const limited = Object.assign(new Error("quota"), { privateFileCode: "rate-limited" });
    render(<FormFilingControls t={t} editable files={[]} onAddFile={vi.fn().mockRejectedValue(limited)} />);
    fireEvent.change(screen.getByLabelText("Attach file"), { target: { files: [new File(["x"], "x.txt", { type: "text/plain" })] } });
    await confirmEvidenceUpload();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("You have reached the hourly limit of 20 file checks. Try again later."));
    expect(screen.queryByText(copy.pendingCheck)).toBeNull();
  });

  // A submitted form is not editable by its filer, so when an attachment's
  // clean verdict ages out the reviewer is the only person who can renew it —
  // and asking them to try opening the file to discover that is not an
  // affordance. The filing status already reports the ledger verdict per row.
  it("offers the re-check for an attachment the filing status already calls stale", async () => {
    const onRecheckFile = vi.fn().mockResolvedValue({ status: "clean" });
    const stale = { ...fileRow, confirmedAt: "2026-09-05T00:00:00Z", scanCurrent: false };
    render(<FormFilingControls t={t} files={[stale]} onRecheckFile={onRecheckFile} />);

    expect(screen.getByText(copy.staleBadge)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `${copy.recheck}: ${fileRow.filename}` }));
    await waitFor(() => expect(onRecheckFile).toHaveBeenCalledWith(stale));
    await waitFor(() => expect(screen.queryByRole("button", { name: `${copy.recheck}: ${fileRow.filename}` })).toBeNull());
    expect(screen.queryByText(copy.staleBadge)).toBeNull();
  });

  // The local "I watched this one settle" note must never outlive the ledger's
  // own answer. If the refreshed filing status still calls the row stale, the
  // parent keeps Approve disabled and keeps naming the file — so the badge and
  // the button have to come back, or the reviewer is left with a block and no
  // control to clear it until the dialog is closed and reopened.
  it("restores the stale badge when a refreshed row still reports a lapsed verdict", async () => {
    const onRecheckFile = vi.fn().mockResolvedValue({ status: "clean" });
    const stale = { ...fileRow, confirmedAt: "2026-09-05T00:00:00Z", scanCurrent: false };
    const { rerender } = render(<FormFilingControls t={t} files={[stale]} onRecheckFile={onRecheckFile} />);

    fireEvent.click(screen.getByRole("button", { name: `${copy.recheck}: ${fileRow.filename}` }));
    await waitFor(() => expect(screen.queryByRole("button", { name: `${copy.recheck}: ${fileRow.filename}` })).toBeNull());

    // The parent reloads and the ledger still says the verdict has lapsed.
    rerender(<FormFilingControls t={t} files={[{ ...stale }]} onRecheckFile={onRecheckFile} />);
    expect(screen.getByText(copy.staleBadge)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${copy.recheck}: ${fileRow.filename}` })).toBeInTheDocument();

    // A refresh that agrees the verdict is current leaves the row settled.
    rerender(<FormFilingControls t={t} files={[{ ...stale, scanCurrent: true }]} onRecheckFile={onRecheckFile} />);
    expect(screen.queryByText(copy.staleBadge)).toBeNull();
    expect(screen.queryByRole("button", { name: `${copy.recheck}: ${fileRow.filename}` })).toBeNull();
  });

  it("offers no re-check for a current attachment", () => {
    render(<FormFilingControls t={t} files={[{ ...fileRow, confirmedAt: "2026-09-05T00:00:00Z", scanCurrent: true }]} onRecheckFile={vi.fn()} />);
    expect(screen.queryByRole("button", { name: `${copy.recheck}: ${fileRow.filename}` })).toBeNull();
    expect(screen.queryByText(copy.staleBadge)).toBeNull();
  });

  it("explains a format this browser cannot convert", async () => {
    const unsupported = Object.assign(new Error("nope"), { privateFileCode: "unsupported-format" });
    render(<FormFilingControls t={t} editable files={[]} onAddFile={vi.fn().mockRejectedValue(unsupported)} />);
    fireEvent.change(screen.getByLabelText("Attach file"), { target: { files: [new File(["x"], "photo.heic", { type: "image/heic" })] } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy.unsupportedFormat));
  });

  // Only `register_member_form_file` invalidates the stored signature digest.
  // An attempt that fails on its way there — a photo this browser cannot
  // convert, a locked form, the twenty-file ceiling — leaves the digest intact,
  // so the member must keep the signature they already saved and the Submit it
  // enables.
  it("keeps a saved signature when the attachment never reached the server", async () => {
    const unsupported = Object.assign(new Error("nope"), { privateFileCode: "unsupported-format" });
    render(<SigningHarness onAddFile={vi.fn().mockRejectedValue(unsupported)} />);
    expect(screen.getByText(copy.signatureSaved)).toBeInTheDocument();

    await attach();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy.unsupportedFormat));
    expect(screen.getByText(copy.signatureSaved)).toBeInTheDocument();
    expect(screen.queryByText(copy.signatureStale)).toBeNull();
  });

  // The first reported phase is this client's proof the registration call
  // returned, and that call already dropped the digest. Everything after it —
  // the bytes failing to land, a refused safety check — must still show the
  // signature as stale, because the server no longer holds it.
  it("retains a saved signature through preparation and a failed conversion", async () => {
    const onAddFile = vi.fn((_file, { onPhase }) => {
      onPhase("preparing");
      onPhase("converting");
      return Promise.reject(Object.assign(new Error("conversion failed"), { privateFileCode: "unsupported-format" }));
    });
    render(<SigningHarness onAddFile={onAddFile} />);
    await attach("scan.pdf", "application/pdf");
    await screen.findByRole("alert");
    expect(screen.getByText(copy.signatureSaved)).toBeInTheDocument();
    expect(screen.queryByText(copy.signatureStale)).toBeNull();
  });

  it("marks the signature stale once the upload reached the server, even if a later step fails", async () => {
    const rejected = Object.assign(new Error("refused"), { privateFileCode: "rejected" });
    const onAddFile = vi.fn((_file, { onPhase }) => {
      onPhase("uploading");
      return Promise.reject(rejected);
    });
    render(<SigningHarness onAddFile={onAddFile} />);

    await attach("scan.pdf", "application/pdf");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy.rejected));
    expect(screen.getByText(copy.signatureStale)).toBeInTheDocument();
    expect(screen.queryByText(copy.signatureSaved)).toBeNull();
  });

  // The demo session attaches the file without reporting any phase and drops
  // its own signature, so a success has to settle the state on its own.
  it("marks the signature stale after an attachment that reported no phase", async () => {
    const onAddFile = vi.fn().mockResolvedValue({ id: "file-2", filename: "scan.pdf", sizeBytes: 3 });
    render(<SigningHarness onAddFile={onAddFile} />);

    await attach("scan.pdf", "application/pdf");
    expect(await screen.findByText(copy.uploadSuccess)).toHaveAttribute("role", "status");
    expect(screen.getByText(copy.signatureStale)).toBeInTheDocument();
    expect(screen.queryByText(copy.signatureSaved)).toBeNull();
  });
});

describe("filing controls keep focus while their writes run (#8435)", () => {
  it("keeps Download focused while the filing copy is fetched, and says when no copy came back", async () => {
    const onDownload = vi.fn(async () => null);
    render(<FormFilingControls t={t} approved files={[]} onDownload={onDownload} />);
    await expectHeldWriteFocus(onDownload, screen.getByRole("button", { name: "Download filing copy" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Share by email or another app" })).not.toBeInTheDocument();
  });

  it("renders as a section heading with no share or signature callbacks, and keeps Remove focused while it runs", async () => {
    const onRemoveFile = vi.fn(async () => undefined);
    render(<FormFilingControls t={t} editable headingLevel={2} files={[fileRow]} onAddFile={vi.fn()} onOpenFile={vi.fn()} onRemoveFile={onRemoveFile} />);
    expect(document.querySelector("h2")).not.toBeNull();
    await expectHeldWriteFocus(onRemoveFile, screen.getByRole("button", { name: "Remove proof.pdf" }));
    expect(onRemoveFile).toHaveBeenCalledTimes(1);
  });

  it("keeps Remove focused while the file is removed, and removes it once", async () => {
    const onRemoveFile = vi.fn(async () => undefined);
    render(<FormFilingControls t={t} editable files={[fileRow]} onAddFile={vi.fn()} onOpenFile={vi.fn()} onRemoveFile={onRemoveFile} />);
    await expectHeldWriteFocus(onRemoveFile, screen.getByRole("button", { name: "Remove proof.pdf" }));
    expect(onRemoveFile).toHaveBeenCalledTimes(1);
  });
});
