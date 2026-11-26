import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_ARTICLE_SNAPSHOT_RPC } from "../src/features/knowledge/knowledgeArticlesApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

vi.mock("../src/features/knowledge/KnowledgeWorkspacePanel.jsx", () => ({
  KnowledgeWorkspacePanel: ({
    onKnowledgeChanged,
    onReviewChapterChange,
    reviewChapterId,
    collectionChapterId,
  }) => (
    <>
      <button type="button" onClick={onKnowledgeChanged}>Complete knowledge ingestion</button>
      <button type="button" onClick={() => onReviewChapterChange("chapter-b")}>Review Chapter B</button>
      <output aria-label="Selected review chapter">{reviewChapterId || "none"}</output>
      <output aria-label="Collection chapter">{collectionChapterId || "none"}</output>
    </>
  ),
}));

import { ProductHubView } from "../src/views/ProductHubView.jsx";

function snapshotClient(rows = []) {
  const rpc = vi.fn((name) => {
    if (name !== KNOWLEDGE_ARTICLE_SNAPSHOT_RPC) return Promise.resolve({ data: [], error: null });
    const request = {
      abortSignal: vi.fn(() => request),
      then(resolve, reject) {
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return request;
  });
  return { rpc };
}

describe("knowledge ingestion refresh", () => {
  it("invalidates the canonical Library snapshot after the workspace reports a change", async () => {
    const client = snapshotClient();
    const onKnowledgeChanged = vi.fn().mockResolvedValue();
    render(<LanguageProvider lang="en"><ProductHubView
      data={{
        member: { id: "staff-1", organizationId: "org-1", chapterId: "chapter-1" },
        roles: ["steward"],
        product: {
          spaces: [], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [],
          compassKnowledge: [],
        },
      }}
      knowledgeClient={client}
      onKnowledgeChanged={onKnowledgeChanged}
    /></LanguageProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Complete knowledge ingestion" }));

    await waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(2));
    expect(onKnowledgeChanged).toHaveBeenCalledTimes(1);
  });

  it("binds the canonical Library and editor to the explicitly reviewed chapter", async () => {
    const client = snapshotClient();
    const onSaveKnowledge = vi.fn().mockResolvedValue({});
    render(<LanguageProvider lang="en"><ProductHubView
      data={{
        member: { id: "staff-1", organizationId: "org-1", chapterId: "chapter-a" },
        roles: ["admin"],
        product: {
          spaces: [], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [],
          compassKnowledge: [],
        },
      }}
      knowledgeClient={client}
      onSaveKnowledge={onSaveKnowledge}
    /></LanguageProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith(
      KNOWLEDGE_ARTICLE_SNAPSHOT_RPC,
      { p_published_only: false, p_chapter_id: "chapter-a" },
    ));
    fireEvent.click(screen.getByRole("button", { name: "Review Chapter B" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith(
      KNOWLEDGE_ARTICLE_SNAPSHOT_RPC,
      { p_published_only: false, p_chapter_id: "chapter-b" },
    ));
    expect(screen.getByRole("status", { name: "Collection chapter" })).toHaveTextContent("chapter-b");

    fireEvent.click(screen.getByRole("button", { name: "Add Guide source" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Chapter B source" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Source reference" }), { target: { value: "Article B" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Source text" }), { target: { value: "Chapter B text." } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(onSaveKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      articleId: null,
      chapterId: "chapter-b",
      title: "Chapter B source",
    })));
  });

  it("does not carry a selected review chapter into another identity in the same organization", async () => {
    const client = snapshotClient();
    const firstData = {
      member: { id: "staff-1", organizationId: "org-1", chapterId: "chapter-a" },
      roles: ["admin"],
      product: {
        spaces: [], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [],
        compassKnowledge: [],
      },
    };
    const view = render(<LanguageProvider lang="en"><ProductHubView
      data={firstData}
      knowledgeClient={client}
    /></LanguageProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    fireEvent.click(screen.getByRole("button", { name: "Review Chapter B" }));
    expect(screen.getByRole("status", { name: "Selected review chapter" })).toHaveTextContent("chapter-b");

    view.rerender(<LanguageProvider lang="en"><ProductHubView
      data={{ ...firstData, member: { ...firstData.member, id: "staff-2" } }}
      knowledgeClient={client}
    /></LanguageProvider>);

    expect(screen.getByRole("status", { name: "Selected review chapter" })).toHaveTextContent("none");
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith(
      KNOWLEDGE_ARTICLE_SNAPSHOT_RPC,
      { p_published_only: false, p_chapter_id: "chapter-a" },
    ));
  });
});
