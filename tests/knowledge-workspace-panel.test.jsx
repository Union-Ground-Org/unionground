import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const api = vi.hoisted(() => ({
  loadKnowledgeWorkspace: vi.fn(), saveKnowledgeCollection: vi.fn(),
  setKnowledgeCollectionItem: vi.fn(), deleteKnowledgeCollection: vi.fn(),
  beginGoogleDriveConnection: vi.fn(), clearKnowledgeSource: vi.fn(),
  disconnectGoogleDrive: vi.fn(), downloadConnectedDriveFile: vi.fn(),
  knowledgeFileBlob: vi.fn(), recheckKnowledgeFile: vi.fn(), listConnectedDriveFiles: vi.fn(),
  listGoogleDriveFilingTargets: vi.fn(),
  listKnowledgeReviewArticles: vi.fn(), listKnowledgeRevisions: vi.fn(), publishStewardLibraryFile: vi.fn(),
  restoreKnowledgeRevision: vi.fn(), retryKnowledgeSource: vi.fn(),
  getKnowledgeIngestSource: vi.fn(), retryKnowledgeIngestSource: vi.fn(),
  listKnowledgeConversions: vi.fn(), reviewKnowledgeConversion: vi.fn(),
  rejectKnowledgeConversion: vi.fn(),
  knowledgeConversionReviewColumnsAvailable: vi.fn(() => true),
  isMissingConversionReviewColumnError: vi.fn((error) => {
    const code = String(error?.code || error?.status || "");
    const message = String(error?.message || error || "");
    return code === "42703" || code === "PGRST204"
      || /column .* does not exist/i.test(message);
  }),
  reviewStewardLibraryFile: vi.fn(), uploadConnectedDriveFile: vi.fn(),
  uploadStewardLibraryFile: vi.fn(),
}));

vi.mock("../src/features/knowledge/knowledgeApi.js", () => api);
import { KnowledgeWorkspacePanel } from "../src/features/knowledge/KnowledgeWorkspacePanel.jsx";

let anchorClick;

// The conversion read answers one page of one section, not a bare array.
function conversionPage(conversions, { section = "needs_review", hasMore = false, nextCursor = null } = {}) {
  return { section, conversions, hasMore, nextCursor };
}

const snapshot = {
  collections: [{ id: "collection-1", title: "Contract basics", description: "Start here", visibility: "organization", items: [{ id: "placement-1", itemId: "article-1", kind: "kb_article", title: "Deadlines", status: "published" }] }],
  catalog: [{ id: "file-1", title: "Request form", category: "forms", fileName: "request.pdf", summary: "Standard request" }],
  sources: [{ id: "source-1", label: "Request form", chunkCount: 2, embeddedCount: 0, health: "unset_embedding", lastError: null }],
  files: [{ id: "file-1", title: "Request form", fileName: "request.pdf", category: "forms", reviewStatus: "approved", indexStatus: "skipped_unset", publishedToCatalog: false }],
  chapters: [{ id: "chapter-a", name: "Chapter A" }, { id: "chapter-b", name: "Chapter B" }],
  embedding: { status: "unset", connected: false },
  drive: { status: "unset", connected: false },
};

// The panel holds its controls busy while a load or save settles; act once
// the control is enabled again.
const ready = (getElement) => waitFor(() => {
  const element = getElement();
  expect(element).toBeEnabled();
  return element;
});

describe.each(["en", "es"])("two Tamarack library files in %s", (lang) => {
  it.each(["download", "approve"])("keeps an ordinary %s refusal separate from a stale file", async (action) => {
    const file = { id: "tamarack-refused", title: "Tamarack agenda", fileName: "agenda.pdf", category: "forms", reviewStatus: "pending" };
    api.loadKnowledgeWorkspace.mockResolvedValue({ ...snapshot, files: [file], catalog: [file] });
    render(<LanguageProvider lang={lang}><KnowledgeWorkspacePanel client={{}} canStaff canAdmin articles={[]} /></LanguageProvider>);
    const t = (key) => translate(lang, `knowledge.${key}`);
    const failure = new Error("Tamarack file unavailable");
    if (action === "download") api.knowledgeFileBlob.mockRejectedValueOnce(failure);
    else api.reviewStewardLibraryFile.mockRejectedValueOnce(failure);
    fireEvent.click((await screen.findAllByRole("button", { name: `${t(action)}: agenda.pdf` }))[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent(failure.message);
    expect(screen.queryAllByRole("button", { name: `${t("recheck")}: agenda.pdf` })).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: `${t("download")}: agenda.pdf` })[0]).toBeEnabled();
  });
  it.each(["clean", "rejected", "offline"])("keeps file context while pending and after a %s re-check", async (outcome) => {
    const file = { id: "tamarack-pending", title: "Tamarack agenda", fileName: "agenda.pdf", category: "forms", reviewStatus: "pending" };
    api.loadKnowledgeWorkspace.mockResolvedValue({ ...snapshot, files: [file], catalog: [file] });
    render(<LanguageProvider lang={lang}><KnowledgeWorkspacePanel client={{}} canStaff canAdmin articles={[]} /></LanguageProvider>);
    const t = (key) => translate(lang, `knowledge.${key}`);
    api.knowledgeFileBlob.mockRejectedValueOnce(Object.assign(new Error("file inspection required"), { code: "42501" }));
    fireEvent.click(await screen.findAllByRole("button", { name: `${t("download")}: agenda.pdf` }).then((buttons) => buttons[0]));
    const checks = await screen.findAllByRole("button", { name: `${t("recheck")}: agenda.pdf` });
    let resolveCheck, rejectCheck;
    api.recheckKnowledgeFile.mockImplementation(() => new Promise((resolve, reject) => { resolveCheck = resolve; rejectCheck = reject; }));
    fireEvent.click(checks[0]);
    const pending = await screen.findAllByRole("button", { name: `${t("rechecking")}: agenda.pdf` });
    expect(pending).toHaveLength(2);
    // Unavailable while the re-check runs, but still focusable .
    pending.forEach((button) => { expect(button).toHaveAttribute("aria-disabled", "true"); expect(button).toBeEnabled(); });
    expect(api.recheckKnowledgeFile).toHaveBeenCalledWith({}, file.id);
    if (outcome === "clean") {
      resolveCheck({ status: "clean" });
      await waitFor(() => expect(screen.queryAllByRole("button", { name: `${t("recheck")}: agenda.pdf` })).toHaveLength(0));
    } else {
      rejectCheck(Object.assign(new Error("scanner"), { code: outcome }));
      expect(await screen.findByRole("alert")).toHaveTextContent(t(outcome === "rejected" ? "rejected" : "recheckFailed"));
      screen.getAllByRole("button", { name: `${t("recheck")}: agenda.pdf` }).forEach((button) => expect(button).toBeEnabled());
    }
  });
  it.each(["pending", "approved"])("names every download, re-check and %s review action by file", async (reviewStatus) => {
    const files = ["agenda.pdf", "minutes.pdf"].map((fileName, index) => ({ id: `tamarack-${index}`, title: `Tamarack ${index}`, fileName, category: "forms", reviewStatus, publishedToCatalog: false }));
    api.loadKnowledgeWorkspace.mockResolvedValue({ ...snapshot, files, catalog: files });
    render(<LanguageProvider lang={lang}><KnowledgeWorkspacePanel client={{}} canStaff canAdmin articles={[]} /></LanguageProvider>);
    const t = (key) => translate(lang, `knowledge.${key}`);
    await screen.findByRole("heading", { name: t("catalog") });
    for (const file of files) {
      const downloads = screen.getAllByRole("button", { name: `${t("download")}: ${file.fileName}` });
      expect(downloads).toHaveLength(2);
      for (const key of ["reject", "quarantine", reviewStatus === "approved" ? "publish" : "approve"]) expect(screen.getByRole("button", { name: `${t(key)}: ${file.fileName}` })).toBeInTheDocument();
      api.knowledgeFileBlob.mockRejectedValueOnce(Object.assign(new Error("file inspection required"), { code: "42501" }));
      fireEvent.click(await ready(() => downloads[0]));
      await waitFor(() => expect(screen.getAllByRole("button", { name: `${t("recheck")}: ${file.fileName}` })).toHaveLength(2));
    }
  });
});
const submitButton = (form) => form.querySelector('button:not([type="button"])');

function show(props = {}) {
  return render(<LanguageProvider lang="en"><KnowledgeWorkspacePanel
    client={{}}
    organizationId="org-1"
    canStaff
    collectionChapterId="chapter-b"
    articles={[{ id: "article-1", title: "Deadlines", version: 2, isSample: false }]}
    {...props}
  /></LanguageProvider>);
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset().mockResolvedValue({});
  api.loadKnowledgeWorkspace.mockResolvedValue(snapshot);
  api.listKnowledgeConversions.mockResolvedValue(conversionPage([]));
  api.knowledgeConversionReviewColumnsAvailable.mockReturnValue(true);
  api.isMissingConversionReviewColumnError.mockImplementation((error) => {
    const code = String(error?.code || error?.status || "");
    const message = String(error?.message || error || "");
    return code === "42703" || code === "PGRST204"
      || /column .* does not exist/i.test(message);
  });
  api.getKnowledgeIngestSource.mockResolvedValue(snapshot.sources[0]);
  api.retryKnowledgeIngestSource.mockResolvedValue(snapshot.sources[0]);
  api.listKnowledgeReviewArticles.mockResolvedValue([{ id: "article-1", title: "Deadlines", version: 2, status: "draft" }]);
  api.deleteKnowledgeCollection.mockResolvedValue([]);
  api.setKnowledgeCollectionItem.mockResolvedValue([]);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "open").mockImplementation(() => null);
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:knowledge");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); });

describe("knowledge workspace surface", () => {
  // BUG-UG-WEB-KNOWLEDGE-DRIVE-STATUS-RAW-TOKEN-20261003: the Drive
  // card printed the stored token ("requested") instead of the catalogue label.
  it.each([
    ["unset", "Unset", "Sin configurar"],
    ["requested", "Setup requested", "Alta solicitada"],
    ["connected", "Connected", "Conectado"],
    ["revoked", "Disconnected", "Desconectado"],
  ])("shows the Drive status %s as its translated label", async (status, english, spanish) => {
    for (const [lang, label] of [["en", english], ["es", spanish]]) {
      api.loadKnowledgeWorkspace.mockResolvedValue({ ...snapshot, drive: { status, connected: status === "connected", accountEmail: "drive@example.test" } });
      const view = render(<LanguageProvider lang={lang}><KnowledgeWorkspacePanel client={{}} organizationId="org-1" canStaff canAdmin collectionChapterId="chapter-b" articles={[]} /></LanguageProvider>);
      const row = (await screen.findByText("drive@example.test")).closest(".knowledge-workspace__row");
      expect(row.querySelector(".knowledge-workspace__status")).toHaveTextContent(new RegExp(`^${label}$`));
      view.unmount();
    }
  });

  it("separates ordinary staff tools from admin-only health and Drive activation", async () => {
    show({ canAdmin: false, canHealth: false });
    expect(await screen.findByRole("heading", { name: "Knowledge workspace" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Committee file library" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ingestion health" })).not.toBeInTheDocument();
    expect(screen.getByText("An Admin or VP role must complete Drive setup.")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Organization" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete collection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(api.loadKnowledgeWorkspace).toHaveBeenCalledWith({}, {
      staff: true,
      health: false,
      chapterId: "chapter-b",
    });
  });

  it("renders the honest unset health state only for an authorized health hat", async () => {
    show({ canAdmin: true, canHealth: true });
    expect(await screen.findByRole("heading", { name: "Ingestion health" })).toBeInTheDocument();
    expect(screen.getAllByText("unset").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeInTheDocument();
  });

  it("removes placements and collections without deleting source content", async () => {
    show({ canAdmin: true, canHealth: true, reviewChapterId: "chapter-b" });
    expect((await screen.findAllByText("Contract basics")).length).toBeGreaterThan(0);
    expect(api.loadKnowledgeWorkspace).toHaveBeenCalledWith({}, {
      staff: true, health: true, chapterId: "chapter-b",
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.setKnowledgeCollectionItem).toHaveBeenCalledWith({}, {
      collectionId: "collection-1", itemKind: "kb_article", itemId: "article-1", include: false,
      chapterId: "chapter-b",
    }));
    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Delete collection" })));
    await waitFor(() => expect(api.deleteKnowledgeCollection).toHaveBeenCalledWith({}, "collection-1", "chapter-b"));
  });

  it("creates collections and placements and exercises protected file actions", async () => {
    api.saveKnowledgeCollection.mockResolvedValue([{ id: "new" }]);
    api.setKnowledgeCollectionItem.mockResolvedValue([]);
    api.uploadStewardLibraryFile.mockResolvedValue({ id: "file-2" });
    api.knowledgeFileBlob.mockResolvedValue({ blob: new Blob(["bytes"]), fileName: "request.pdf" });
    show({ canAdmin: true, canHealth: true, reviewChapterId: "chapter-b" });
    await screen.findByRole("heading", { name: "Knowledge workspace" });

    const collectionForm = screen.getByRole("heading", { name: "New collection" }).closest("form");
    fireEvent.change(collectionForm.querySelector('[name="title"]'), { target: { value: "Safety" } });
    fireEvent.submit(collectionForm);
    await waitFor(() => expect(api.saveKnowledgeCollection).toHaveBeenCalledWith({}, expect.objectContaining({
      title: "Safety",
      chapterId: "chapter-b",
    })));

    const placementForm = screen.getByRole("heading", { name: "Add a placement" }).closest("form");
    fireEvent.change(placementForm.querySelector('[name="collectionId"]'), { target: { value: "collection-1" } });
    fireEvent.change(placementForm.querySelector('[name="item"]'), { target: { value: "kb_article:article-1" } });
    await ready(() => submitButton(placementForm));
    fireEvent.submit(placementForm);
    await waitFor(() => expect(api.setKnowledgeCollectionItem).toHaveBeenCalledWith({}, expect.objectContaining({
      include: true,
      chapterId: "chapter-b",
    })));

    const stewardCard = screen.getByRole("heading", { name: "Committee file library" }).closest("article");
    const uploadForm = stewardCard.querySelector("form");
    const file = new File(["guide"], "guide.txt", { type: "text/plain" });
    fireEvent.change(uploadForm.querySelector('[name="file"]'), { target: { files: [file] } });
    await ready(() => submitButton(uploadForm));
    fireEvent.submit(uploadForm);
    await waitFor(() => expect(api.uploadStewardLibraryFile).toHaveBeenCalled());

    fireEvent.click(await ready(() => screen.getAllByRole("button", { name: /^Download(?:: |$)/ })[1]));
    // The signed URL is gone: bytes come back through the reader's own session
    // and reach the disk via an <a download>, because the URL's `download:`
    // disposition went with it.
    await waitFor(() => expect(api.knowledgeFileBlob).toHaveBeenCalledWith({}, "file-1", "steward"));
    await waitFor(() => expect(anchorClick).toHaveBeenCalled());
    expect(window.open).not.toHaveBeenCalled();
    fireEvent.click(await ready(() => screen.getByRole("button", { name: /^Reject(?:: |$)/ })));
    await waitFor(() => expect(api.reviewStewardLibraryFile).toHaveBeenCalledTimes(1));
    fireEvent.click(await ready(() => screen.getByRole("button", { name: /^Quarantine(?:: |$)/ })));
    await waitFor(() => expect(api.reviewStewardLibraryFile).toHaveBeenCalledTimes(2));
    fireEvent.click(await ready(() => screen.getByRole("button", { name: /^Publish\ to\ catalog(?:: |$)/ })));
    await waitFor(() => expect(api.publishStewardLibraryFile).toHaveBeenCalledTimes(1));
    expect(api.publishStewardLibraryFile).toHaveBeenCalledWith({}, "file-1", "forms");
  });

  it("treats a download RPC inspection refusal as the same stale verdict a Storage 4xx is", async () => {
    // `mi1_w2_download_knowledge_file` now consults the ledger, so a lapsed
    // verdict refuses before Storage is ever reached. Matching only on the
    // Storage 4xx would leave that refusal without a re-check affordance.
    show({ canAdmin: true, canHealth: true });
    await screen.findByRole("heading", { name: "Committee file library" });
    api.knowledgeFileBlob.mockRejectedValueOnce(
      Object.assign(new Error("file inspection required"), { code: "42501" }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: /^Download(?:: |$)/ })[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file needs a fresh safety check before it can download.",
    );
    fireEvent.click(screen.getAllByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ })[1]);
    await waitFor(() => expect(api.recheckKnowledgeFile).toHaveBeenCalledWith({}, "file-1"));
  });

  // BUG-UG-WEB-CATALOG-EXTERNAL-URL-FILES-UNDOWNLOADABLE-20261003: a
  // file stored as an outside link is not a stale verdict; it gets its own
  // plain sentence and no re-check.
  it.each([
    ["en", "This file can't be opened here; ask your organization to re-upload it."],
    ["es", "Este archivo no se puede abrir aquí; pídele a tu organización volver a subirlo."],
  ])("explains a file that is not stored here without offering a safety re-check (%s)", async (lang, sentence) => {
    render(<LanguageProvider lang={lang}><KnowledgeWorkspacePanel client={{}} organizationId="org-1" canStaff canAdmin canHealth collectionChapterId="chapter-b" articles={[]} /></LanguageProvider>);
    await screen.findAllByRole("heading");
    api.knowledgeFileBlob.mockRejectedValueOnce(Object.assign(new Error("file is not stored here"), { code: "22023", details: "knowledge_file_external_unsupported" }));
    const download = await screen.findAllByRole("button", { name: lang === "en" ? /^Download:/ : /Descargar/ });
    fireEvent.click(download[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
    expect(screen.queryByRole("button", { name: lang === "en" ? /^Re-check this file(?:: |$)/ : /Volver a revisar/ })).toBeNull();
    expect(api.recheckKnowledgeFile).not.toHaveBeenCalled();
  });

  it("offers approve and publish on the ledger verdict, not on the retired scan_status column", async () => {
    // `replace_knowledge_source_chunks` no longer writes scan_status, so every
    // steward file now sits at 'pending' forever. Gating the two buttons on
    // 'clean' would hide them permanently; the server RPC is the authority.
    show({ canAdmin: true, canHealth: true });
    const stewardCard = (await screen.findByRole("heading", { name: "Committee file library" })).closest("article");
    expect(stewardCard).not.toHaveTextContent("pending");
    expect(screen.getByRole("button", { name: /^Publish\ to\ catalog(?:: |$)/ })).toBeInTheDocument();

    api.publishStewardLibraryFile.mockRejectedValueOnce(
      Object.assign(new Error("only approved clean files can be published"), { code: "22023" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Publish\ to\ catalog(?:: |$)/ }));
    // The refusal lands on the same one-tap re-check a stale download offers,
    // never on a raw Postgres sentence.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file needs a fresh safety check before it can be approved or published.",
    );
    // The catalog and steward lists both carry file-1, so both rows offer the
    // affordance; the steward one is the second.
    fireEvent.click(screen.getAllByRole("button", { name: /^Re\-check\ this\ file(?:: |$)/ })[1]);
    await waitFor(() => expect(api.recheckKnowledgeFile).toHaveBeenCalledWith({}, "file-1"));
  });

  it("shows approve for an unapproved file and routes its inspection refusal to a re-check", async () => {
    api.loadKnowledgeWorkspace.mockResolvedValue({
      ...snapshot,
      files: [{ ...snapshot.files[0], reviewStatus: "pending_scan" }],
    });
    show({ canAdmin: true, canHealth: true });
    expect(await screen.findByRole("button", { name: /^Approve(?:: |$)/ })).toBeInTheDocument();
    api.reviewStewardLibraryFile.mockRejectedValueOnce(
      Object.assign(new Error("file inspection required"), { code: "42501" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Approve(?:: |$)/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file needs a fresh safety check before it can be approved or published.",
    );
    expect(api.reviewStewardLibraryFile).toHaveBeenCalledWith({}, "file-1", "approved");
  });

  it("keeps a completed file visible and announces a durable ingestion failure", async () => {
    api.uploadStewardLibraryFile.mockResolvedValue({
      fileId: "file-2", sourceId: "source-2", ingestionError: "knowledge-file-no-extractable-text",
    });
    show({ canAdmin: true, canHealth: true });
    const stewardCard = (await screen.findByRole("heading", { name: "Committee file library" })).closest("article");
    const uploadForm = stewardCard.querySelector("form");
    fireEvent.change(uploadForm.querySelector('[name="file"]'), {
      target: { files: [new File(["legacy"], "legacy.doc")] },
    });
    fireEvent.submit(uploadForm);
    expect(await screen.findByRole("alert")).toHaveTextContent("knowledge-file-no-extractable-text");
  });

  // Union Ground has no CBA ingest: there is
  // no collective bargaining agreement before a first contract, so the upload
  // form offers no "contract" category and never asks for a contract chapter.
  it("offers no contract category or contract chapter on the upload form", async () => {
    api.uploadStewardLibraryFile.mockResolvedValue({ fileId: "file-2", sourceId: "source-2" });
    show({ canAdmin: true, canHealth: true });
    const stewardCard = (await screen.findByRole("heading", { name: "Committee file library" })).closest("article");
    const uploadForm = stewardCard.querySelector("form");
    const category = screen.getByLabelText("Category");
    const values = [...category.options].map((option) => option.value);
    expect(values).toEqual(["general", "forms", "guides", "health_safety", "meetings", "steward_tools", "training"]);
    expect(values).not.toContain("contract");
    for (const value of values) {
      fireEvent.change(category, { target: { value } });
      expect(screen.queryByLabelText("Contract chapter"), value).not.toBeInTheDocument();
      expect(uploadForm.querySelector('[name="chapterId"]'), value).toBeNull();
    }

    fireEvent.change(uploadForm.querySelector('[name="file"]'), {
      target: { files: [new File(["agreement"], "agreement.txt", { type: "text/plain" })] },
    });
    fireEvent.submit(uploadForm);
    await waitFor(() => expect(api.uploadStewardLibraryFile).toHaveBeenCalledTimes(1));
    const [, , fields] = api.uploadStewardLibraryFile.mock.calls[0];
    expect(fields.category).toBe("training");
    expect(fields).not.toHaveProperty("chapterId");
    expect(api.uploadStewardLibraryFile.mock.calls[0][3]).toEqual({ onPhase: expect.any(Function) });
  });

  it("does not reload the review chapter or canonical corpus after an ordinary upload", async () => {
    api.listKnowledgeReviewArticles
      .mockResolvedValueOnce([{ id: "article-old", title: "Prior clause", version: 1, status: "published" }])
      .mockResolvedValueOnce([{ id: "article-new", title: "Imported clause", version: 1, status: "draft" }]);
    api.uploadStewardLibraryFile.mockResolvedValue({ fileId: "file-2", sourceId: "source-2" });
    const onKnowledgeChanged = vi.fn().mockResolvedValue();
    show({ canAdmin: true, canHealth: true, onKnowledgeChanged });

    fireEvent.change(await screen.findByLabelText("Review campaign"), { target: { value: "chapter-b" } });
    expect(await screen.findByRole("option", { name: "Prior clause · v1 · published" })).toBeInTheDocument();

    const stewardCard = screen.getByRole("heading", { name: "Committee file library" }).closest("article");
    const uploadForm = stewardCard.querySelector("form");
    fireEvent.change(uploadForm.querySelector('[name="file"]'), {
      target: { files: [new File(["successor"], "successor.txt", { type: "text/plain" })] },
    });
    fireEvent.submit(uploadForm);

    await waitFor(() => expect(api.uploadStewardLibraryFile).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    // No article drafts are minted from an upload, so nothing is re-read.
    expect(api.listKnowledgeReviewArticles).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("option", { name: "Imported clause · v1 · draft" })).not.toBeInTheDocument();
    expect(onKnowledgeChanged).not.toHaveBeenCalled();
  });

  it("refreshes the selected review chapter and canonical corpus after a source retry", async () => {
    api.listKnowledgeReviewArticles
      .mockResolvedValueOnce([{ id: "article-old", title: "Prior clause", version: 1, status: "published" }])
      .mockResolvedValueOnce([{ id: "article-new", title: "Retried clause", version: 2, status: "draft" }]);
    api.retryKnowledgeIngestSource.mockResolvedValue({ id: "source-1" });
    const onKnowledgeChanged = vi.fn().mockResolvedValue();
    show({ canAdmin: true, canHealth: true, onKnowledgeChanged });

    fireEvent.change(await screen.findByLabelText("Review campaign"), { target: { value: "chapter-b" } });
    expect(await screen.findByRole("option", { name: "Prior clause · v1 · published" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(api.listKnowledgeReviewArticles).toHaveBeenCalledTimes(2));
    expect(api.listKnowledgeReviewArticles).toHaveBeenLastCalledWith({}, "chapter-b");
    expect(await screen.findByRole("option", { name: "Retried clause · v2 · draft" })).toBeInTheDocument();
    expect(screen.getByLabelText("Review campaign")).toHaveValue("chapter-b");
    expect(onKnowledgeChanged).toHaveBeenCalledTimes(1);
  });

  it("carries an explicitly selected chapter through review, verification, and health controls", async () => {
    api.listKnowledgeRevisions.mockResolvedValue([{ id: 9, version: 1, title: "Earlier", articleRef: "Article I", body: "Reviewed agreement language.", keywords: ["recognition"], status: "published", changedAt: "2026-08-01T12:00:00Z" }]);
    api.restoreKnowledgeRevision.mockResolvedValue({ version: 3 });
    api.retryKnowledgeIngestSource.mockResolvedValue({ id: "source-1" });
    api.clearKnowledgeSource.mockResolvedValue({ id: "source-1" });
    const onKnowledgeChanged = vi.fn().mockResolvedValue();
    const onReviewChapterChange = vi.fn();
    show({ canAdmin: true, canHealth: true, onKnowledgeChanged, onReviewChapterChange });
    await screen.findByRole("heading", { name: "Version restoration" });
    fireEvent.change(screen.getByLabelText("Review campaign"), { target: { value: "chapter-b" } });
    expect(onReviewChapterChange).toHaveBeenCalledWith("chapter-b");
    await waitFor(() => expect(api.listKnowledgeReviewArticles).toHaveBeenCalledWith({}, "chapter-b"));
    await waitFor(() => expect(screen.getByLabelText("Knowledge article").querySelector('option[value="article-1"]')).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Knowledge article"), { target: { value: "article-1" } });
    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Load history" })));
    await waitFor(() => expect(api.listKnowledgeRevisions).toHaveBeenCalledWith({}, "article-1", "chapter-b"));
    expect(await screen.findByText(/v1 · Earlier/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Review clause content"));
    expect(screen.getByText("Reviewed agreement language.")).toBeInTheDocument();
    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Restore as draft" })));
    await waitFor(() => expect(api.restoreKnowledgeRevision).toHaveBeenCalledWith({}, "article-1", 9, false, "chapter-b"));
    await waitFor(() => expect(onKnowledgeChanged).toHaveBeenCalledWith());
    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Restore and verify" })));
    await waitFor(() => expect(api.restoreKnowledgeRevision).toHaveBeenCalledWith({}, "article-1", 9, true, "chapter-b"));
    await waitFor(() => expect(onKnowledgeChanged).toHaveBeenCalledTimes(2));

    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(api.getKnowledgeIngestSource).toHaveBeenCalledWith({}, "source-1"));
    await waitFor(() => expect(api.retryKnowledgeIngestSource).toHaveBeenCalledWith({}, "source-1"));
    // The audited RPC resets health; only the HTTP route re-ingests, so the
    // control has to run both, and the reset has to come first.
    await waitFor(() => expect(api.retryKnowledgeSource).toHaveBeenCalledWith({}, "source-1"));
    expect(api.retryKnowledgeIngestSource.mock.invocationCallOrder[0])
      .toBeLessThan(api.retryKnowledgeSource.mock.invocationCallOrder[0]);
    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Clear chunks" })));
    await waitFor(() => expect(api.clearKnowledgeSource).toHaveBeenCalledWith({}, "source-1"));
  });

  it("keeps only the latest chapter review response when selections overlap", async () => {
    let resolveChapterA;
    let resolveChapterB;
    const chapterA = new Promise((resolve) => { resolveChapterA = resolve; });
    const chapterB = new Promise((resolve) => { resolveChapterB = resolve; });
    api.listKnowledgeReviewArticles.mockImplementation((_client, chapterId) => (
      chapterId === "chapter-a" ? chapterA : chapterB
    ));
    show({ canAdmin: true, canHealth: true });
    const chapterPicker = await screen.findByLabelText("Review campaign");

    fireEvent.change(chapterPicker, { target: { value: "chapter-a" } });
    await waitFor(() => expect(api.listKnowledgeReviewArticles).toHaveBeenCalledWith({}, "chapter-a"));
    expect(await screen.findByText("Working…")).toBeInTheDocument();
    fireEvent.change(chapterPicker, { target: { value: "chapter-b" } });
    expect(api.listKnowledgeReviewArticles).toHaveBeenCalledWith({}, "chapter-b");

    await act(async () => {
      resolveChapterB([{ id: "article-b", title: "Chapter B clause", version: 2, status: "draft" }]);
      await chapterB;
    });
    expect(await screen.findByRole("option", { name: "Chapter B clause · v2 · draft" })).toBeInTheDocument();

    await act(async () => {
      resolveChapterA([{ id: "article-a", title: "Chapter A clause", version: 1, status: "draft" }]);
      await chapterA;
    });
    expect(screen.queryByRole("option", { name: "Chapter A clause · v1 · draft" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Chapter B clause · v2 · draft" })).toBeInTheDocument();
    expect(chapterPicker).toHaveValue("chapter-b");
  });

  it("keeps collections on the latest selected chapter when workspace loads overlap", async () => {
    let resolveChapterA;
    let resolveChapterB;
    const chapterA = new Promise((resolve) => { resolveChapterA = resolve; });
    const chapterB = new Promise((resolve) => { resolveChapterB = resolve; });
    api.loadKnowledgeWorkspace.mockImplementation((_client, { chapterId }) => (
      chapterId === "chapter-a" ? chapterA : chapterB
    ));
    const view = show({ canAdmin: true, canHealth: true, collectionChapterId: "chapter-a" });
    await waitFor(() => expect(api.loadKnowledgeWorkspace).toHaveBeenCalledWith({}, {
      staff: true,
      health: true,
      chapterId: "chapter-a",
    }));

    view.rerender(<LanguageProvider lang="en"><KnowledgeWorkspacePanel
      client={{}}
      canStaff
      canAdmin
      canHealth
      collectionChapterId="chapter-b"
      articles={[{ id: "article-1", title: "Deadlines", version: 2, isSample: false }]}
    /></LanguageProvider>);
    await waitFor(() => expect(api.loadKnowledgeWorkspace).toHaveBeenCalledWith({}, {
      staff: true,
      health: true,
      chapterId: "chapter-b",
    }));

    await act(async () => {
      resolveChapterB({
        ...snapshot,
        collections: [{ ...snapshot.collections[0], id: "collection-b", title: "Chapter B collection" }],
      });
      await chapterB;
    });
    expect((await screen.findAllByText("Chapter B collection")).length).toBeGreaterThan(0);

    await act(async () => {
      resolveChapterA({
        ...snapshot,
        collections: [{ ...snapshot.collections[0], id: "collection-a", title: "Chapter A collection" }],
      });
      await chapterA;
    });
    expect(screen.queryByText("Chapter A collection")).not.toBeInTheDocument();
    expect(screen.getAllByText("Chapter B collection").length).toBeGreaterThan(0);
  });

  it("clears the prior chapter snapshot when the current chapter load fails", async () => {
    let rejectChapterB;
    const chapterB = new Promise((_resolve, reject) => { rejectChapterB = reject; });
    api.loadKnowledgeWorkspace.mockImplementation((_client, { chapterId }) => (
      chapterId === "chapter-a" ? Promise.resolve(snapshot) : chapterB
    ));
    const view = show({ canAdmin: true, canHealth: true, collectionChapterId: "chapter-a" });
    expect(await screen.findAllByText("Contract basics")).not.toHaveLength(0);

    view.rerender(<LanguageProvider lang="en"><KnowledgeWorkspacePanel
      client={{}}
      canStaff
      canAdmin
      canHealth
      collectionChapterId="chapter-b"
      articles={[{ id: "article-1", title: "Deadlines", version: 2, isSample: false }]}
    /></LanguageProvider>);
    await waitFor(() => expect(api.loadKnowledgeWorkspace).toHaveBeenCalledWith({}, {
      staff: true,
      health: true,
      chapterId: "chapter-b",
    }));
    expect(screen.getByRole("button", { name: "Delete collection" })).toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      rejectChapterB(new Error("Chapter B unavailable"));
      await chapterB.catch(() => {});
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Chapter B unavailable");
    expect(screen.queryByText("Contract basics")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete collection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "New collection" })).not.toBeInTheDocument();
  });

  it("makes imported removals an explicit keep-or-retire decision", async () => {
    api.listKnowledgeRevisions.mockResolvedValue([{
      id: 10, version: 0, title: "Removed clause", status: "retired",
      importCandidate: true, changedAt: "2026-09-03T12:00:00Z",
    }]);
    api.restoreKnowledgeRevision.mockResolvedValue({ version: 3 });
    show({ canAdmin: true, canHealth: true });
    await screen.findByRole("heading", { name: "Version restoration" });
    fireEvent.change(screen.getByLabelText("Review campaign"), { target: { value: "chapter-b" } });
    await waitFor(() => expect(api.listKnowledgeReviewArticles).toHaveBeenCalledWith({}, "chapter-b"));
    await waitFor(() => expect(screen.getByLabelText("Knowledge article").querySelector('option[value="article-1"]')).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Knowledge article"), { target: { value: "article-1" } });
    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Load history" })));
    expect(await screen.findByText(/Imported removal · review required/)).toBeInTheDocument();

    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Keep published" })));
    await waitFor(() => expect(api.restoreKnowledgeRevision).toHaveBeenCalledWith({}, "article-1", 10, false, "chapter-b"));
    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Retire article" })));
    await waitFor(() => expect(api.restoreKnowledgeRevision).toHaveBeenCalledWith({}, "article-1", 10, true, "chapter-b"));
  });

  it("covers Drive connection, connected operations, and failure recovery states", async () => {
    api.beginGoogleDriveConnection.mockResolvedValue();
    const disconnected = show({ canAdmin: true, canHealth: true });
    await screen.findByRole("button", { name: "Connect Google Drive" });
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    await waitFor(() => expect(api.beginGoogleDriveConnection).toHaveBeenCalledWith({}));
    disconnected.unmount();

    api.loadKnowledgeWorkspace.mockResolvedValue({ ...snapshot, drive: { status: "connected", connected: true, accountEmail: "docs@example.test" } });
    api.listConnectedDriveFiles.mockResolvedValue([{ id: "drive-1", name: "Guide.pdf", mimeType: "application/pdf", size: 20 }]);
    api.uploadConnectedDriveFile.mockResolvedValue({ file: { id: "drive-2" } });
    api.downloadConnectedDriveFile.mockResolvedValue();
    api.disconnectGoogleDrive.mockResolvedValue({ status: "revoked" });
    const connected = show({ canAdmin: true, canDriveOperate: true, canHealth: true });
    fireEvent.click(await screen.findByRole("button", { name: "Refresh files" }));
    expect(await screen.findByText("docs@example.test")).toBeInTheDocument();
    expect(await screen.findByText("Guide.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download: Guide.pdf" }));
    await waitFor(() => expect(api.downloadConnectedDriveFile).toHaveBeenCalled());
    const driveCard = screen.getByRole("heading", { name: "Google Drive" }).closest("article");
    const driveForm = driveCard.querySelector("form");
    fireEvent.change(driveForm.querySelector('[name="file"]'), { target: { files: [new File(["x"], "x.txt")] } });
    await ready(() => submitButton(driveForm));
    fireEvent.submit(driveForm);
    await waitFor(() => expect(api.uploadConnectedDriveFile).toHaveBeenCalled());
    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Disconnect" })));
    await waitFor(() => expect(api.disconnectGoogleDrive).toHaveBeenCalledWith({}));
    connected.unmount();

    api.loadKnowledgeWorkspace.mockRejectedValueOnce(new Error("Load failed"));
    show({ canAdmin: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("Load failed");
    api.loadKnowledgeWorkspace.mockResolvedValue(snapshot);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Knowledge workspace" })).toBeInTheDocument();
  });

  // BUG-UG-CHAPTER-HAT-STEWARD-COORDINATOR-ADVISOR-OFFERED-GOOGLE-DRIVE-LIST-20260921.
  // authorize_google_drive_operation gates list/upload/download on an
  // organization_role_grants hat, so a chapter-only steward -- staff in every
  // other library card -- could only ever get 42501 from these three controls.
  it("withholds connected-Drive list, upload, and download from a chapter-only staff hat", async () => {
    api.loadKnowledgeWorkspace.mockResolvedValue({ ...snapshot, drive: { status: "connected", connected: true, accountEmail: "docs@example.test" } });
    api.listConnectedDriveFiles.mockResolvedValue([{ id: "drive-1", name: "Guide.pdf", mimeType: "application/pdf", size: 20 }]);

    const chapterOnly = show({ canAdmin: false, canDriveOperate: false });
    const chapterCard = (await screen.findByRole("heading", { name: "Google Drive" })).closest("article");
    expect(within(chapterCard).getByText(/A campaign-only role cannot browse, upload, or download them\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload to Drive" })).not.toBeInTheDocument();
    expect(chapterCard.querySelector("form")).toBeNull();
    expect(within(chapterCard).queryByRole("button", { name: /^Download(?:: |$)/ })).not.toBeInTheDocument();
    expect(api.listConnectedDriveFiles).not.toHaveBeenCalled();
    chapterOnly.unmount();

    show({ canAdmin: false, canDriveOperate: true });
    fireEvent.click(await screen.findByRole("button", { name: "Refresh files" }));
    expect(await screen.findByText("Guide.pdf")).toBeInTheDocument();
    const grantCard = screen.getByRole("heading", { name: "Google Drive" }).closest("article");
    expect(within(grantCard).getByRole("button", { name: "Upload to Drive" })).toBeInTheDocument();
    expect(within(grantCard).getByRole("button", { name: /^Download(?:: |$)/ })).toBeInTheDocument();
    expect(within(grantCard).queryByText(/A campaign-only role cannot browse/)).not.toBeInTheDocument();
    // Connect and Disconnect stay Admin/VP work either way.
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  // REQ-UG-DRIVE-PER-CASE-FOLDERS-20261001.
  it("files Drive list, upload and download into a chosen case or meeting folder", async () => {
    api.loadKnowledgeWorkspace.mockResolvedValue({ ...snapshot, drive: { status: "connected", connected: true, accountEmail: "docs@example.test" } });
    api.listGoogleDriveFilingTargets.mockResolvedValue({
      enabled: true,
      cases: [{ id: "case-1", reference: "GR-7", folderName: "Case GR-7 · case-1ab" }],
      meetings: [{ id: "evt-1", title: "Rally", folderName: "Meeting 2026-10-05 · Rally · abc123" }],
    });
    api.listConnectedDriveFiles.mockResolvedValue([{ id: "drive-9", name: "Statement.pdf", mimeType: "application/pdf", size: 20 }]);
    api.uploadConnectedDriveFile.mockResolvedValue({ file: { id: "drive-10" } });
    api.downloadConnectedDriveFile.mockResolvedValue();
    show({ canAdmin: false, canDriveOperate: true });
    const folder = await screen.findByRole("combobox", { name: /Folder/ });
    expect(within(folder).getByRole("option", { name: "Shared resources folder" })).toBeInTheDocument();
    fireEvent.change(folder, { target: { value: "case:case-1" } });
    await waitFor(() => expect(api.listConnectedDriveFiles).toHaveBeenLastCalledWith({}, { kind: "case", id: "case-1" }));
    const statementRow = (await screen.findByText("Statement.pdf")).closest("li");
    fireEvent.click(within(statementRow).getByRole("button", { name: /^Download(?:: |$)/ }));
    await waitFor(() => expect(api.downloadConnectedDriveFile).toHaveBeenCalledWith({}, expect.objectContaining({ id: "drive-9" }), { kind: "case", id: "case-1" }));
    const driveForm = screen.getByRole("heading", { name: "Google Drive" }).closest("article").querySelector("form");
    fireEvent.change(driveForm.querySelector('[name="file"]'), { target: { files: [new File(["x"], "x.txt")] } });
    await ready(() => submitButton(driveForm));
    fireEvent.submit(driveForm);
    await waitFor(() => expect(api.uploadConnectedDriveFile).toHaveBeenCalledWith({}, expect.any(File), { kind: "case", id: "case-1" }));
    await ready(() => folder);
    fireEvent.change(folder, { target: { value: "" } });
    await waitFor(() => expect(api.listConnectedDriveFiles).toHaveBeenLastCalledWith({}, null));
  });

  it("hides the folder choice while case and meeting folders are off", async () => {
    api.loadKnowledgeWorkspace.mockResolvedValue({ ...snapshot, drive: { status: "connected", connected: true, accountEmail: "docs@example.test" } });
    api.listGoogleDriveFilingTargets.mockResolvedValue({ enabled: false, cases: [], meetings: [] });
    show({ canAdmin: false, canDriveOperate: true });
    await screen.findByRole("button", { name: "Refresh files" });
    await waitFor(() => expect(api.listGoogleDriveFilingTargets).toHaveBeenCalled());
    expect(screen.queryByRole("combobox", { name: /Folder/ })).not.toBeInTheDocument();
  });

  it("announces both OAuth callback outcomes in the workspace", async () => {
    const connected = show({ canAdmin: true, driveOutcome: "connected" });
    expect(await screen.findByText("Google Drive connected.")).toHaveAttribute("role", "status");
    // Let each mount's workspace load finish so no read lands in a later test.
    await waitFor(() => expect(api.listKnowledgeConversions).toHaveBeenCalledTimes(1));
    connected.unmount();

    show({ canAdmin: true, driveOutcome: "failed" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Google Drive connection failed. Try connecting again.");
    await waitFor(() => expect(api.listKnowledgeConversions).toHaveBeenCalledTimes(2));
  });

  it("renders the no-client boundary without issuing RPCs", () => {
    render(<LanguageProvider lang="en"><KnowledgeWorkspacePanel client={null} canStaff={false} canAdmin={false} /></LanguageProvider>);
    expect(screen.getByText(/unavailable in this local visual fixture/)).toBeInTheDocument();
    expect(api.loadKnowledgeWorkspace).not.toHaveBeenCalled();
  });

  it("approves a pending conversion and persists a denial with its reason", async () => {
    api.listKnowledgeConversions.mockResolvedValue(conversionPage([
      {
        id: "conv-1", organizationId: "org-1", sourceId: "source-1", fileId: "file-1",
        attempt: 1, outcome: "succeeded", errorCode: null, changeKind: "initial",
        convertedAt: "2026-09-16T12:00:00Z", reviewedAt: null, reviewedBy: null,
        reviewStatus: null, rejectionReason: null,
      },
      {
        id: "conv-2", organizationId: "org-1", sourceId: "source-1", fileId: "file-1",
        attempt: 2, outcome: "failed", errorCode: "knowledge-no-text", changeKind: "changed-source",
        convertedAt: "2026-09-16T13:00:00Z", reviewedAt: "2026-09-16T14:00:00Z", reviewedBy: "reviewer-1",
        reviewStatus: "rejected", rejectionReason: "No extractable text.",
      },
    ]));
    api.reviewKnowledgeConversion.mockResolvedValue({
      id: "conv-1", reviewedAt: "2026-09-16T15:00:00Z", reviewStatus: "approved",
    });
    show({ canAdmin: true, canHealth: true });

    expect(await screen.findByRole("heading", { name: "Conversion review" })).toBeInTheDocument();
    expect(api.listKnowledgeConversions).toHaveBeenCalledWith({}, "org-1");
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.getByText("Reason: No extractable text.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Approve(?:: |$)/ }));
    await waitFor(() => expect(api.reviewKnowledgeConversion).toHaveBeenCalledWith({}, "org-1", "conv-1"));
    expect(await screen.findByText("Conversion approved.")).toBeInTheDocument();
    // The decided row leaves the needs-review list without a workspace reload,
    // so a reviewer who has paged deep keeps their position (review LOW-4).
    await waitFor(() => expect(screen.queryByText("Awaiting review")).not.toBeInTheDocument());
    expect(api.listKnowledgeConversions).toHaveBeenCalledTimes(1);
    expect(api.loadKnowledgeWorkspace).toHaveBeenCalledTimes(1);
  });

  it("persists a denial with its reason", async () => {
    api.listKnowledgeConversions.mockResolvedValue(conversionPage([
      {
        id: "conv-1", organizationId: "org-1", sourceId: "source-1", fileId: "file-1",
        attempt: 1, outcome: "succeeded", errorCode: null, changeKind: "initial",
        convertedAt: "2026-09-16T12:00:00Z", reviewedAt: null, reviewedBy: null,
        reviewStatus: null, rejectionReason: null,
      },
    ]));
    api.rejectKnowledgeConversion.mockResolvedValue({
      id: "conv-1", reviewStatus: "rejected", rejectionReason: "Extracted text does not match the signed agreement.",
    });
    show({ canAdmin: true, canHealth: true });

    expect(await screen.findByRole("heading", { name: "Conversion review" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.change(screen.getByLabelText("Reason for denial"), {
      target: { value: "Extracted text does not match the signed agreement." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save denial" }));
    await waitFor(() => expect(api.rejectKnowledgeConversion).toHaveBeenCalledWith(
      {}, "org-1", "conv-1", "Extracted text does not match the signed agreement.",
    ));
    expect(await screen.findByText("Conversion rejected.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Awaiting review")).not.toBeInTheDocument());
    expect(api.listKnowledgeConversions).toHaveBeenCalledTimes(1);
  });

  // UX-UG-KNOWLEDGE-CONVERSION-CARD-POLISH-20260917. The needs-review page
  // is exhausted first, then the settled section; the reviewer reaches both.
  it("walks the needs-review pages and then the settled section from the card", async () => {
    const row = (id, reviewed = null) => ({
      id, organizationId: "org-1", sourceId: "source-1", fileId: "file-1",
      attempt: 1, outcome: "succeeded", errorCode: null, changeKind: "initial",
      convertedAt: "2026-09-16T12:00:00+00:00",
      reviewedAt: reviewed, reviewedBy: reviewed && "reviewer-1",
      reviewStatus: reviewed ? "approved" : null, rejectionReason: null,
    });
    const cursor = { convertedAt: "2026-09-16T12:00:00+00:00", id: "conv-1" };
    api.listKnowledgeConversions
      .mockResolvedValueOnce(conversionPage([row("conv-1")], { hasMore: true, nextCursor: cursor }))
      .mockResolvedValueOnce(conversionPage([row("conv-2")]))
      .mockResolvedValueOnce(conversionPage([row("conv-3", "2026-09-16T14:00:00+00:00")], { section: "settled" }));
    show({ canAdmin: true, canHealth: true });

    expect(await screen.findByRole("heading", { name: "Conversion review" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Show more conversions" }));
    await waitFor(() => expect(api.listKnowledgeConversions).toHaveBeenNthCalledWith(
      2, {}, "org-1", { section: "needs_review", cursor },
    ));

    // The needs-review section ended without a full page, so the next request
    // opens the settled section rather than ending the list.
    fireEvent.click(await ready(() => screen.getByRole("button", { name: "Show more conversions" })));
    await waitFor(() => expect(api.listKnowledgeConversions).toHaveBeenNthCalledWith(
      3, {}, "org-1", { section: "settled", cursor: null },
    ));
    await waitFor(() => expect(screen.getAllByText("Awaiting review")).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByText("Approved")).toHaveLength(1));
    await waitFor(() => expect(
      screen.queryByRole("button", { name: "Show more conversions" }),
    ).not.toBeInTheDocument());
  });

  // Review of, MEDIUM-1 at panel level. Signing off the last pending
  // attempt used to reload into an empty needs-review page whose card claimed
  // the ledger was empty and offered no way forward, so the decision just
  // recorded -- and every earlier one -- became unreachable.
  it("signs off the last pending attempt and can still reach the settled section", async () => {
    const pendingRow = {
      id: "conv-1", organizationId: "org-1", sourceId: "source-1", fileId: "file-1",
      attempt: 1, outcome: "succeeded", errorCode: null, changeKind: "initial",
      convertedAt: "2026-09-16T12:00:00+00:00", reviewedAt: null, reviewedBy: null,
      reviewStatus: null, rejectionReason: null,
    };
    const settledRow = {
      ...pendingRow, id: "conv-0", attempt: 0,
      convertedAt: "2026-09-15T12:00:00+00:00",
      reviewedAt: "2026-09-15T14:00:00+00:00", reviewedBy: "reviewer-1", reviewStatus: "approved",
    };
    api.listKnowledgeConversions
      .mockResolvedValueOnce(conversionPage([pendingRow]))
      .mockResolvedValueOnce(conversionPage([settledRow], { section: "settled" }));
    api.reviewKnowledgeConversion.mockResolvedValue({ id: "conv-1", reviewStatus: "approved" });
    show({ canAdmin: true, canHealth: true });

    expect(await screen.findByRole("heading", { name: "Conversion review" })).toBeInTheDocument();
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Approve(?:: |$)/ }));
    await waitFor(() => expect(api.reviewKnowledgeConversion).toHaveBeenCalledWith({}, "org-1", "conv-1"));
    expect(await screen.findByText("Conversion approved.")).toBeInTheDocument();

    // The needs-review section is now empty, and the card says so honestly
    // while still offering the settled section.
    await waitFor(() => expect(screen.getByText("Nothing is awaiting review.")).toBeInTheDocument());
    expect(screen.queryByText("No conversions have been recorded yet.")).not.toBeInTheDocument();
    // The decision did NOT reload the workspace back to page one.
    expect(api.listKnowledgeConversions).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Show more conversions" }));
    await waitFor(() => expect(api.listKnowledgeConversions).toHaveBeenNthCalledWith(
      2, {}, "org-1", { section: "settled", cursor: null },
    ));
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    await waitFor(() => expect(
      screen.queryByRole("button", { name: "Show more conversions" }),
    ).not.toBeInTheDocument());
  });

  it("does not append a row a second time when it settles under the reader", async () => {
    const row = (id, reviewed = null) => ({
      id, organizationId: "org-1", sourceId: "source-1", fileId: "file-1",
      attempt: 1, outcome: "succeeded", errorCode: null, changeKind: "initial",
      convertedAt: "2026-09-16T12:00:00+00:00",
      reviewedAt: reviewed, reviewedBy: reviewed && "reviewer-1",
      reviewStatus: reviewed ? "approved" : null, rejectionReason: null,
    });
    api.listKnowledgeConversions
      .mockResolvedValueOnce(conversionPage([row("conv-1")]))
      // Another reviewer settled conv-1 between the two reads, so it comes back
      // in the settled section too.
      .mockResolvedValueOnce(conversionPage(
        [row("conv-1", "2026-09-16T13:00:00+00:00"), row("conv-0", "2026-09-15T13:00:00+00:00")],
        { section: "settled" },
      ));
    show({ canAdmin: true, canHealth: true });

    expect(await screen.findByRole("heading", { name: "Conversion review" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Show more conversions" }));
    await waitFor(() => expect(api.listKnowledgeConversions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText("Attempt 1")).toHaveLength(2));
  });

  it("does not read the conversion ledger at all without an organization to bind it to", async () => {
    show({ canAdmin: true, canHealth: true, organizationId: null });
    expect(await screen.findByRole("heading", { name: "Knowledge workspace" })).toBeInTheDocument();
    expect(api.loadKnowledgeWorkspace).toHaveBeenCalled();
    expect(api.listKnowledgeConversions).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders conversions without a rejected state when review columns are not on the hosted schema yet", async () => {
    api.listKnowledgeConversions.mockResolvedValue(conversionPage([
      {
        id: "conv-1", organizationId: "org-1", sourceId: "source-1", fileId: "file-1",
        attempt: 1, outcome: "succeeded", errorCode: null, changeKind: "initial",
        convertedAt: "2026-09-16T12:00:00Z", reviewedAt: null, reviewedBy: null,
        reviewStatus: null, rejectionReason: null, reviewColumnsAvailable: false,
      },
    ]));
    show({ canAdmin: true, canHealth: true });

    expect(await screen.findByRole("heading", { name: "Conversion review" })).toBeInTheDocument();
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
    expect(screen.queryByText("Rejected")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Available after the next database update")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Approve(?:: |$)/ })).toBeEnabled();
  });

  it("keeps the cutover hint on an empty pre-cutover conversion list", async () => {
    api.listKnowledgeConversions.mockResolvedValue(conversionPage([]));
    api.knowledgeConversionReviewColumnsAvailable.mockReturnValue(false);
    show({ canAdmin: true, canHealth: true });

    expect(await screen.findByRole("heading", { name: "Conversion review" })).toBeInTheDocument();
    // The needs-review section is empty; the settled section has not been read,
    // so the card says what it actually knows rather than that the ledger is
    // empty (review LOW-1).
    expect(screen.getByText("Nothing is awaiting review.")).toBeInTheDocument();
    expect(screen.getByText("Available after the next database update")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports an empty ledger only once the settled section has been read too", async () => {
    api.listKnowledgeConversions
      .mockResolvedValueOnce(conversionPage([]))
      .mockResolvedValueOnce(conversionPage([], { section: "settled" }));
    show({ canAdmin: true, canHealth: true });

    expect(await screen.findByRole("heading", { name: "Conversion review" })).toBeInTheDocument();
    expect(screen.getByText("Nothing is awaiting review.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more conversions" }));
    await waitFor(() => expect(
      screen.getByText("No conversions have been recorded yet."),
    ).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Show more conversions" })).not.toBeInTheDocument();
  });

  it("does not surface a raw PostgREST missing-column refusal as a panel alert", async () => {
    api.listKnowledgeConversions.mockRejectedValueOnce(Object.assign(
      new Error("column organization_knowledge_conversions.review_status does not exist"),
      { code: "42703" },
    ));
    show({ canAdmin: true, canHealth: true });

    expect(await screen.findByRole("heading", { name: "Knowledge workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/does not exist/i)).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Conversion review" })).toBeInTheDocument();
    expect(screen.getByText("Available after the next database update")).toBeInTheDocument();
  });

  it("surfaces an ingest retry refusal without calling the retry RPC", async () => {
    api.getKnowledgeIngestSource.mockRejectedValueOnce(Object.assign(new Error("not authorized"), { code: "42501" }));
    show({ canAdmin: true, canHealth: true });
    await screen.findByRole("heading", { name: "Ingestion health" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not authorized");
    expect(api.retryKnowledgeIngestSource).not.toHaveBeenCalled();
    expect(api.retryKnowledgeSource).not.toHaveBeenCalled();
  });

  it("skips the retry when the pre-flight reports the source is already healthy", async () => {
    api.getKnowledgeIngestSource.mockResolvedValue({ ...snapshot.sources[0], health: "healthy", embeddedCount: 2 });
    show({ canAdmin: true, canHealth: true });
    await screen.findByRole("heading", { name: "Ingestion health" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(api.getKnowledgeIngestSource).toHaveBeenCalledWith({}, "source-1"));
    expect(await screen.findByText("This source is already healthy. Nothing was re-ingested.")).toBeInTheDocument();
    expect(api.retryKnowledgeIngestSource).not.toHaveBeenCalled();
    expect(api.retryKnowledgeSource).not.toHaveBeenCalled();
  });

  it("announces a failed re-ingest after the reset RPC and reloads the health list", async () => {
    api.retryKnowledgeIngestSource.mockResolvedValue({ id: "source-1", health: "unset_embedding" });
    api.retryKnowledgeSource.mockRejectedValueOnce(new Error("knowledge-ingest-failed"));
    show({ canAdmin: true, canHealth: true });
    await screen.findByRole("heading", { name: "Ingestion health" });
    await waitFor(() => expect(api.loadKnowledgeWorkspace).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(api.retryKnowledgeSource).toHaveBeenCalledWith({}, "source-1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("knowledge-ingest-failed");
    // The reset is durable even though the re-ingest failed, so the list is
    // reloaded before the refusal is announced.
    await waitFor(() => expect(api.loadKnowledgeWorkspace).toHaveBeenCalledTimes(2));
  });
});

describe("knowledge workspace controls keep focus while their writes run (#8435)", () => {
  const settled = async (name) => {
    const button = await screen.findByRole("button", { name });
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    return button;
  };

  it("keeps a library file's Reject focused while the review is saved", async () => {
    render(<LanguageProvider lang="en"><KnowledgeWorkspacePanel client={{}} canStaff canAdmin articles={[]} /></LanguageProvider>);
    const reject = await settled("Reject: request.pdf");
    await expectHeldWriteFocus(api.reviewStewardLibraryFile, reject);
    await waitFor(() => expect(api.reviewStewardLibraryFile).toHaveBeenCalledWith({}, "file-1", "rejected"));
    expect(api.reviewStewardLibraryFile).toHaveBeenCalledTimes(1);
  });

  it("keeps Delete collection focused while the collection is deleted", async () => {
    render(<LanguageProvider lang="en"><KnowledgeWorkspacePanel client={{}} canStaff canAdmin canHealth collectionChapterId="chapter-a" articles={[]} /></LanguageProvider>);
    const remove = await settled("Delete collection");
    await expectHeldWriteFocus(api.deleteKnowledgeCollection, remove);
    await waitFor(() => expect(api.deleteKnowledgeCollection).toHaveBeenCalledTimes(1));
  });

  it("sends one review when two activations land before the first one commits", async () => {
    render(<LanguageProvider lang="en"><KnowledgeWorkspacePanel client={{}} canStaff canAdmin articles={[]} /></LanguageProvider>);
    const reject = await settled("Reject: request.pdf");
    let finish;
    api.reviewStewardLibraryFile.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    // Both clicks arrive in one React batch, before `busy` commits, so only
    // run()'s own lock can refuse the second.
    act(() => {
      reject.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      reject.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(api.reviewStewardLibraryFile).toHaveBeenCalledTimes(1));
    await act(async () => { finish({}); });
    expect(api.reviewStewardLibraryFile).toHaveBeenCalledTimes(1);
  });
});
