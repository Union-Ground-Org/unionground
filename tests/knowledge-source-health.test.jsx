// @vitest-environment jsdom
// REQ-UG-TRUSTED-SOURCE-STALENESS-CHECK-20261001: the hourly trusted-source
// roll-up in the knowledge ingestion health card, and its soft read.
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const api = vi.hoisted(() => ({
  loadKnowledgeWorkspace: vi.fn(), saveKnowledgeCollection: vi.fn(),
  setKnowledgeCollectionItem: vi.fn(), deleteKnowledgeCollection: vi.fn(),
  beginGoogleDriveConnection: vi.fn(), clearKnowledgeSource: vi.fn(),
  disconnectGoogleDrive: vi.fn(), downloadConnectedDriveFile: vi.fn(),
  knowledgeFileBlob: vi.fn(), recheckKnowledgeFile: vi.fn(), listConnectedDriveFiles: vi.fn(),
  listKnowledgeReviewArticles: vi.fn(), listKnowledgeRevisions: vi.fn(), publishStewardLibraryFile: vi.fn(),
  restoreKnowledgeRevision: vi.fn(), retryKnowledgeSource: vi.fn(),
  getKnowledgeIngestSource: vi.fn(), retryKnowledgeIngestSource: vi.fn(),
  listKnowledgeConversions: vi.fn(), reviewKnowledgeConversion: vi.fn(),
  rejectKnowledgeConversion: vi.fn(),
  knowledgeConversionReviewColumnsAvailable: vi.fn(() => true),
  isMissingConversionReviewColumnError: vi.fn(() => false),
  reviewStewardLibraryFile: vi.fn(), uploadConnectedDriveFile: vi.fn(),
  uploadStewardLibraryFile: vi.fn(),
}));

vi.mock("../src/features/knowledge/knowledgeApi.js", () => api);
import { KnowledgeWorkspacePanel } from "../src/features/knowledge/KnowledgeWorkspacePanel.jsx";

const base = {
  collections: [], catalog: [], sources: [], files: [], chapters: [],
  embedding: { status: "unset", connected: false },
  drive: { status: "unset", connected: false },
};

function show(sourceHealth, lang = "en") {
  api.loadKnowledgeWorkspace.mockResolvedValue({ ...base, sourceHealth });
  return render(<LanguageProvider lang={lang}><KnowledgeWorkspacePanel client={{}} organizationId="org-1" canStaff={false} canHealth /></LanguageProvider>);
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset().mockResolvedValue({});
  api.listKnowledgeConversions.mockResolvedValue({ section: "settled", conversions: [], hasMore: false, nextCursor: null });
});

describe("trusted source health check", () => {
  it("shows the last hourly roll-up and the oldest items that need attention", async () => {
    show({
      enabled: true, staleDays: 180, checkedStaleDays: 180, checkedAt: "2026-10-02T14:15:00.000Z",
      articles: { total: 4, stale: 1 },
      documents: { total: 3, stale: 1, pending: 1, failed: 0 },
      sources: { total: 2, stale: 0, pending: 0, failed: 1 },
      attention: [
        { kind: "source", id: "source-1", label: "Contract source", reason: "failed" },
        { kind: "article", id: "article-1", label: "Weingarten rights", reason: "stale" },
      ],
    });
    expect(await screen.findByText("Source health check")).toBeInTheDocument();
    expect(screen.getByText("Hourly")).toBeInTheDocument();
    expect(screen.getByText(/stale after 180 days/)).toBeInTheDocument();
    expect(screen.getByText("Articles: 4 published, 1 stale")).toBeInTheDocument();
    expect(screen.getByText("Library documents: 3 approved, 1 stale, 1 pending, 0 failed")).toBeInTheDocument();
    expect(screen.getByText("Ingested sources: 2, 0 stale, 0 pending, 1 failed")).toBeInTheDocument();
    expect(screen.getByText("Contract source")).toBeInTheDocument();
    expect(screen.getByText("Ingested source · Failed")).toBeInTheDocument();
    expect(screen.getByText("Article · Not updated within the stale window")).toBeInTheDocument();
  });

  it("says when the check has not run yet and when the organization turned it off", async () => {
    const { unmount } = show({ enabled: true, staleDays: 180, checkedAt: null, attention: [] });
    expect(await screen.findByText(/Not checked yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Articles:/)).not.toBeInTheDocument();
    unmount();
    show({ enabled: false, staleDays: 365, checkedAt: null, attention: [{ kind: "source", label: "Hidden attention", reason: "failed" }] }, "es");
    expect(await screen.findByText(/La revisión horaria del estado de las fuentes está desactivada/)).toBeInTheDocument();
    expect(screen.getByText("Desactivada")).toBeInTheDocument();
    expect(screen.queryByText("Hidden attention")).not.toBeInTheDocument();
  });

  it("keeps the card without the roll-up when the read is unavailable", async () => {
    show(null);
    expect(await screen.findByText("Embedding provider")).toBeInTheDocument();
    expect(screen.queryByText("Source health check")).not.toBeInTheDocument();
  });
});
