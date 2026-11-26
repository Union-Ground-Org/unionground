import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_ARTICLE_SNAPSHOT_RPC,
  loadAccessibleKnowledgeArticles,
} from "../src/features/knowledge/knowledgeArticlesApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { SearchView } from "../src/views/SearchView.jsx";

function articleRow(index, overrides = {}) {
  return {
    id: `kb-${String(index).padStart(3, "0")}`,
    slug: `clause-${index}`,
    chapter_id: "chapter-1",
    kind: "contract",
    title: `Agreement clause ${index}`,
    article_ref: `CBA · Article ${index}`,
    body: `Authorized agreement language for clause ${index}.`,
    keywords: [`clause-${index}`],
    order_index: index,
    status: "published",
    is_sample: false,
    version: 1,
    created_by: "staff-1",
    updated_by: "staff-1",
    verified_by: "staff-1",
    verified_at: "2026-09-03T12:00:00Z",
    created_at: "2026-09-03T11:00:00Z",
    updated_at: "2026-09-03T12:00:00Z",
    ...overrides,
  };
}

function serializedRows(rows) {
  return rows.map((row) => ({ ...row, keywords: [...(row.keywords || [])] }));
}

function knowledgeClient(rows, { fail = false, beforeSnapshot = null, afterSnapshot = null } = {}) {
  const calls = [];
  const rpc = vi.fn((name, args) => {
    if (name !== KNOWLEDGE_ARTICLE_SNAPSHOT_RPC) {
      return Promise.resolve({ data: [], error: null });
    }
    const call = { name, args, signal: null };
    calls.push(call);
    const builder = {
      abortSignal: vi.fn((signal) => { call.signal = signal; return builder; }),
      then(resolve, reject) {
        beforeSnapshot?.(rows);
        const snapshot = serializedRows(rows);
        afterSnapshot?.(rows);
        const result = fail
          ? { data: null, error: { message: "snapshot unavailable", code: "08006" } }
          : { data: snapshot, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  });
  const client = {
    rpc,
    from: vi.fn(() => { throw new Error("knowledge snapshot must not use direct table pages"); }),
  };
  return { client, calls };
}

function deferredKnowledgeClient() {
  let settle;
  const result = new Promise((resolve) => { settle = resolve; });
  const client = {
    rpc: vi.fn((name) => {
      if (name !== KNOWLEDGE_ARTICLE_SNAPSHOT_RPC) {
        return Promise.resolve({ data: [], error: null });
      }
      const builder = {
        abortSignal: vi.fn(() => builder),
        then(resolve, reject) { return result.then(resolve, reject); },
      };
      return builder;
    }),
    from: vi.fn(() => { throw new Error("knowledge snapshot must not use direct table pages"); }),
  };
  return {
    client,
    resolve(rows) { settle({ data: rows, error: null }); },
  };
}

function chapterSwitchingKnowledgeClient() {
  const home = articleRow(1, { chapter_id: "chapter-a", title: "Home chapter source" });
  const selected = articleRow(2, { chapter_id: "chapter-b", title: "Selected chapter source" });
  const rpc = vi.fn((name, args = {}) => {
    if (name === KNOWLEDGE_ARTICLE_SNAPSHOT_RPC) {
      const rows = args.p_chapter_id === "chapter-b" ? [selected] : [home];
      const builder = {
        abortSignal: vi.fn(() => builder),
        then(resolve, reject) {
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    }
    if (name === "list_knowledge_upload_chapters") {
      return Promise.resolve({
        data: [
          { id: "chapter-a", name: "Chapter A" },
          { id: "chapter-b", name: "Chapter B" },
        ],
        error: null,
      });
    }
    return Promise.resolve({ data: [], error: null });
  });
  return { client: { rpc }, rpc };
}

describe("complete knowledge article snapshot", () => {
  it("loads one complete server snapshot and applies member publication filters", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => articleRow(index + 1));
    const { client, calls } = knowledgeClient(rows);

    const articles = await loadAccessibleKnowledgeArticles(client, { publishedOnly: true });

    expect(articles).toHaveLength(201);
    expect(articles.at(-1)).toMatchObject({ id: "kb-201", title: "Agreement clause 201" });
    expect(calls).toEqual([expect.objectContaining({
      name: KNOWLEDGE_ARTICLE_SNAPSHOT_RPC,
      args: { p_published_only: true, p_chapter_id: null },
    })]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("carries an explicitly selected staff chapter into the serialized snapshot", async () => {
    const rows = [
      articleRow(1, { chapter_id: "chapter-b" }),
      articleRow(2, { chapter_id: "chapter-a" }),
    ];
    const { client, calls } = knowledgeClient(rows);

    await expect(loadAccessibleKnowledgeArticles(client, {
      publishedOnly: false,
      chapterId: "chapter-b",
    })).resolves.toEqual([expect.objectContaining({ chapterId: "chapter-b" })]);

    expect(calls).toEqual([expect.objectContaining({
      name: KNOWLEDGE_ARTICLE_SNAPSHOT_RPC,
      args: { p_published_only: false, p_chapter_id: "chapter-b" },
    })]);
  });

  it("fails the complete load instead of returning a silently truncated prefix", async () => {
    const rows = Array.from({ length: 150 }, (_, index) => articleRow(index + 1));
    const { client } = knowledgeClient(rows, { fail: true });

    await expect(loadAccessibleKnowledgeArticles(client, { publishedOnly: true }))
      .rejects.toMatchObject({ message: "Load Guide knowledge: snapshot unavailable", code: "08006" });
  });

  it("keeps one serialized database snapshot when reconciliation commits during delivery", async () => {
    const rows = Array.from({ length: 150 }, (_, index) => articleRow(index + 1));
    const { client, calls } = knowledgeClient(rows, {
      afterSnapshot(mutableRows) {
        mutableRows[0].order_index = 300;
        mutableRows[149].order_index = 0;
        mutableRows[1].status = "retired";
      },
    });

    const articles = await loadAccessibleKnowledgeArticles(client);

    // The single-snapshot claim in this test's name must fail on its own, before
    // any row check: a second fetch that happened to return identical rows would
    // still break the serialized-snapshot guarantee.
    expect(calls).toEqual([expect.objectContaining({
      name: KNOWLEDGE_ARTICLE_SNAPSHOT_RPC,
      args: { p_published_only: false, p_chapter_id: null },
    })]);
    expect(new Set(articles.map((article) => article.id)).size).toBe(150);
    expect(articles).toHaveLength(150);
    expect(articles[0].id).toBe("kb-001");
    expect(articles.at(-1).id).toBe("kb-150");
    expect(articles.find((article) => article.id === "kb-002")?.status).toBe("published");
  });

  it("keeps defensive member filtering even if an over-broad client returns unsafe rows", async () => {
    const rows = [
      articleRow(1),
      articleRow(2, { status: "draft", verified_by: null, verified_at: null }),
      articleRow(3, { is_sample: true }),
      articleRow(4, { chapter_id: null }),
    ];
    const { client } = knowledgeClient(rows);

    await expect(loadAccessibleKnowledgeArticles(client, { publishedOnly: true }))
      .resolves.toEqual([expect.objectContaining({ id: "kb-001" })]);
  });

  it("requests and defensively keeps only the explicitly selected staff chapter", async () => {
    const rows = [
      articleRow(1, { chapter_id: "chapter-a" }),
      articleRow(2, { chapter_id: "chapter-b" }),
    ];
    const { client, calls } = knowledgeClient(rows);

    await expect(loadAccessibleKnowledgeArticles(client, { chapterId: "chapter-b" }))
      .resolves.toEqual([expect.objectContaining({ id: "kb-002", chapterId: "chapter-b" })]);
    expect(calls[0].args).toEqual({
      p_published_only: false,
      p_chapter_id: "chapter-b",
    });
  });

  it("makes an article after the boot window searchable with its full body", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => articleRow(index + 1));
    const { client } = knowledgeClient(rows);
    const data = {
      member: { id: "member-1", organizationId: "org-1", chapterId: "chapter-1" },
      kbArticles: rows.slice(0, 100).map((row) => ({
        id: row.id,
        slug: row.slug,
        chapterId: row.chapter_id,
        kind: row.kind,
        title: row.title,
        ref: row.article_ref,
        body: row.body,
        keywords: row.keywords,
        orderIndex: row.order_index,
        status: row.status,
        isSample: row.is_sample,
        version: row.version,
        verifiedBy: row.verified_by,
        verifiedAt: row.verified_at,
      })),
    };
    render(<LanguageProvider lang="en"><SearchView
      data={data}
      knowledgeClient={client}
      onOpenResult={vi.fn()}
      onAskCompass={vi.fn()}
    /></LanguageProvider>);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "clause-101" } });
    const result = await screen.findByRole("button", { name: /Agreement clause 101/ });
    fireEvent.click(result);
    expect(document.querySelector(".search-article"))
      .toHaveTextContent("Authorized agreement language for clause 101.");
  });

  it("reports a complete-index failure without claiming that the query has no matches", async () => {
    const { client } = knowledgeClient([], { fail: true });
    render(<LanguageProvider lang="en"><SearchView
      data={{ kbArticles: [] }}
      knowledgeClient={client}
      onOpenResult={vi.fn()}
      onAskCompass={vi.fn()}
    /></LanguageProvider>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing clause" } });

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("The complete campaign knowledge index could not be loaded");
    expect(screen.queryByText(/No matches for/)).not.toBeInTheDocument();
  });

  it("loads an article after the boot window into the canonical staff editor", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => articleRow(index + 1));
    const { client } = knowledgeClient(rows);
    const product = {
      spaces: [], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [],
      compassKnowledge: rows.slice(0, 100).map((row) => ({
        id: row.id,
        slug: row.slug,
        chapterId: row.chapter_id,
        kind: row.kind,
        title: row.title,
        ref: row.article_ref,
        body: row.body,
        keywords: row.keywords,
        orderIndex: row.order_index,
        status: row.status,
        isSample: row.is_sample,
        version: row.version,
        verifiedBy: row.verified_by,
        verifiedAt: row.verified_at,
      })),
    };
    render(<LanguageProvider lang="en"><ProductHubView
      data={{
        member: { id: "staff-1", organizationId: "org-1", chapterId: "chapter-1" },
        roles: ["steward"],
        product,
      }}
      knowledgeClient={client}
      onSaveKnowledge={vi.fn()}
      onRetireKnowledge={vi.fn()}
    /></LanguageProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    const article = await screen.findByRole("button", { name: /Agreement clause 101/ });
    fireEvent.click(article);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" }))
      .toHaveValue("Agreement clause 101"));
    expect(screen.getByRole("textbox", { name: "Source text" }))
      .toHaveValue("Authorized agreement language for clause 101.");
  });

  it("carries the selected review chapter through the canonical editor and retirement", async () => {
    const { client, rpc } = chapterSwitchingKnowledgeClient();
    const onSaveKnowledge = vi.fn().mockResolvedValue({});
    const onRetireKnowledge = vi.fn().mockResolvedValue({});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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
      onRetireKnowledge={onRetireKnowledge}
    /></LanguageProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await screen.findByRole("button", { name: /Home chapter source/ })).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Review campaign"), {
      target: { value: "chapter-b" },
    });

    const selected = await screen.findByRole("button", { name: /Selected chapter source/ });
    expect(screen.queryByRole("button", { name: /Home chapter source/ })).not.toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith(KNOWLEDGE_ARTICLE_SNAPSHOT_RPC, {
      p_published_only: false,
      p_chapter_id: "chapter-b",
    });

    fireEvent.click(selected);
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(onSaveKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: "kb-002", chapterId: "chapter-b" }),
    ));
    await waitFor(() => expect(rpc.mock.calls.filter(([name, args]) => (
      name === KNOWLEDGE_ARTICLE_SNAPSHOT_RPC && args.p_chapter_id === "chapter-b"
    ))).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: /Selected chapter source/ }));
    fireEvent.click(screen.getByRole("button", { name: "Retire source" }));
    await waitFor(() => expect(onRetireKnowledge).toHaveBeenCalledWith("kb-002", "chapter-b"));
    await waitFor(() => expect(rpc.mock.calls.filter(([name, args]) => (
      name === KNOWLEDGE_ARTICLE_SNAPSHOT_RPC && args.p_chapter_id === "chapter-b"
    ))).toHaveLength(3));
    confirm.mockRestore();
  });

  it("does not let an obsolete identity's late snapshot replace the current corpus", async () => {
    const first = deferredKnowledgeClient();
    const second = deferredKnowledgeClient();
    const props = {
      data: {
        member: { id: "member-1", organizationId: "org-1", chapterId: "chapter-1" },
        kbArticles: [],
      },
      knowledgeClient: first.client,
      onOpenResult: vi.fn(),
      onAskCompass: vi.fn(),
    };
    const view = render(<LanguageProvider lang="en"><SearchView {...props} /></LanguageProvider>);
    view.rerender(<LanguageProvider lang="en"><SearchView
      {...props}
      data={{
        member: { id: "member-2", organizationId: "org-2", chapterId: "chapter-2" },
        kbArticles: [],
      }}
      knowledgeClient={second.client}
    /></LanguageProvider>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "scope-token" } });

    await act(async () => {
      second.resolve([articleRow(2, {
        chapter_id: "chapter-2",
        title: "Current identity source",
        body: "scope-token current",
      })]);
    });
    expect(await screen.findByRole("button", { name: /Current identity source/ })).toBeInTheDocument();

    await act(async () => {
      first.resolve([articleRow(1, {
        title: "Obsolete identity source",
        body: "scope-token obsolete",
      })]);
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: /Current identity source/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Obsolete identity source/ })).not.toBeInTheDocument();
  });

  it("hides draft boot rows immediately when the selected hat is Worker", () => {
    const remote = deferredKnowledgeClient();
    const draft = articleRow(1, {
      status: "draft",
      verified_by: null,
      verified_at: null,
    });
    render(<LanguageProvider lang="en"><ProductHubView
      data={{
        member: { id: "member-1", organizationId: "org-1", chapterId: "chapter-1" },
        roles: ["steward"],
        product: {
          spaces: [], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [],
          compassKnowledge: [{
            id: draft.id,
            slug: draft.slug,
            chapterId: draft.chapter_id,
            title: "Draft must stay hidden",
            ref: draft.article_ref,
            body: draft.body,
            status: draft.status,
            isSample: false,
            verifiedBy: null,
            verifiedAt: null,
          }],
        },
      }}
      staffAccess={false}
      knowledgeClient={remote.client}
    /></LanguageProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(screen.queryByText("Draft must stay hidden")).not.toBeInTheDocument();
    expect(screen.getByText("Loading all authorized Guide sources…"))
      .toHaveAttribute("role", "status");
  });
});
