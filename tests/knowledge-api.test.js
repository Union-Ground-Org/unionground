import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginGoogleDriveConnection,
  clearKnowledgeSource,
  deleteKnowledgeCollection,
  disconnectGoogleDrive,
  downloadConnectedDriveFile,
  knowledgeFileBlob,
  listConnectedDriveFiles,
  isMissingConversionReviewColumnError,
  knowledgeConversionReviewColumnsAvailable,
  listKnowledgeConversions,
  listKnowledgeReviewArticles,
  listKnowledgeRevisions,
  loadKnowledgeWorkspace,
  publishStewardLibraryFile,
  recheckKnowledgeFile,
  rejectKnowledgeConversion,
  resetKnowledgeConversionReviewColumnProbe,
  restoreKnowledgeRevision,
  retryKnowledgeSource,
  getKnowledgeIngestSource,
  retryKnowledgeIngestSource,
  reviewKnowledgeConversion,
  reviewStewardLibraryFile,
  saveKnowledgeCollection,
  setKnowledgeCollectionItem,
  uploadConnectedDriveFile,
  uploadStewardLibraryFile,
} from "../src/features/knowledge/knowledgeApi.js";

// A real knowledge file id is a UUID: the inspection contract refuses anything
// else before a request is made, so the fixture must be one.
const KNOWLEDGE_FILE_ID = "b41f0d2e-9c73-4a15-8f60-2d5c7e918a34";

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

// Two endpoints share the ambient fetch on this path: the inspection endpoint
// and the ingest worker. Routing by URL keeps each assertion honest about which
// one was called, and the inspection reply echoes the file id back the way the
// real endpoint does.
function routedFetch({ inspect = (body) => jsonResponse(200, { status: "clean", fileId: body.fileId }) } = {}) {
  const inspections = [];
  const impl = vi.fn(async (url, init) => {
    if (String(url).startsWith("/api/private-files")) {
      const body = JSON.parse(init.body);
      inspections.push(body);
      return typeof inspect === "function" ? inspect(body) : inspect;
    }
    return impl.ingest ? impl.ingest(url, init) : jsonResponse(200, { source: { id: "s1" } });
  });
  impl.inspections = inspections;
  return impl;
}

function clientWith(responses = {}) {
  const rpc = vi.fn(async (name, params) => {
    const configured = responses[name];
    const value = typeof configured === "function" ? configured(params) : configured;
    return value instanceof Error ? { data: null, error: value } : { data: value ?? [], error: null };
  });
  const storageApi = {
    upload: vi.fn().mockResolvedValue({ error: null }),
    remove: vi.fn().mockResolvedValue({ error: null }),
    download: vi.fn().mockResolvedValue({ data: new Blob(["bytes"]), error: null }),
    createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: "https://storage.example/signed" }, error: null }),
  };
  // The conversion read is a PostgREST filter chain, so the fake builder has to
  // carry every link the read uses; `limit` is its only terminal. A configured
  // function receives the builder, which is how a paged test answers the second
  // page differently from the first.
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => {
      const configured = responses.organization_knowledge_conversions;
      const value = typeof configured === "function" ? configured(query) : configured;
      return value instanceof Error ? { data: null, error: value } : { data: value ?? [], error: null };
    }),
  };
  return {
    rpc,
    from: vi.fn(() => query),
    query,
    storage: { from: vi.fn(() => storageApi) },
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "user-token" } }, error: null }) },
    storageApi,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetKnowledgeConversionReviewColumnProbe();
  vi.stubGlobal("fetch", vi.fn());
  if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => "blob:test");
  else vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
  else vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

describe("knowledge workspace API", () => {
  it("loads the member, staff, and health projections without widening role access", async () => {
    await expect(loadKnowledgeWorkspace(null)).resolves.toMatchObject({ collections: [], files: [], sources: [] });
    const client = clientWith({
      list_knowledge_collections: [{ id: "c1" }], list_resource_catalog_page: [{ id: "f1" }],
      get_google_drive_activation: { status: "unset" }, list_steward_library_files_page: [{ id: "f2" }],
      list_knowledge_upload_chapters: [{ id: "chapter-a", name: "Chapter A" }],
      list_knowledge_ingest_sources_page: [{ id: "s1" }], get_knowledge_embedding_activation: { status: "unset" },
    });
    await expect(loadKnowledgeWorkspace(client, {
      staff: true,
      health: true,
      chapterId: "chapter-b",
    })).resolves.toMatchObject({
      collections: [{ id: "c1" }], catalog: [{ id: "f1" }], files: [{ id: "f2" }], sources: [{ id: "s1" }],
      chapters: [{ id: "chapter-a", name: "Chapter A" }],
    });
    expect(client.rpc).toHaveBeenCalledWith("list_knowledge_collections", {
      p_chapter_id: "chapter-b",
    });
    const names = client.rpc.mock.calls.map(([name]) => name);
    expect(names).not.toContain("list_resource_catalog");
    expect(names).not.toContain("get_resource_catalog_item");
    expect(names).not.toContain("get_steward_library_file");
    expect(client.rpc).toHaveBeenCalledWith("list_knowledge_ingest_sources_page", {
      p_cursor_created_at: null,
      p_cursor_id: null,
    });

    const failed = clientWith({ list_knowledge_collections: new Error("tenant denied") });
    await expect(loadKnowledgeWorkspace(failed)).rejects.toThrow("tenant denied");
  });

  it("loads subsequent pages until every authorized knowledge row is reachable", async () => {
    const page = (prefix, size) => Array.from({ length: size }, (_, index) => ({
      id: `${prefix}-${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 29) - index * 1000).toISOString(),
    }));
    const client = clientWith({
      list_knowledge_collections: [],
      get_google_drive_activation: { status: "unset" },
      get_knowledge_embedding_activation: { status: "unset" },
      list_resource_catalog_page: ({ p_cursor_id }) => p_cursor_id === null ? page("catalog-a", 80) : page("catalog-b", 3),
      list_steward_library_files_page: ({ p_cursor_id }) => p_cursor_id === null ? page("file-a", 80) : page("file-b", 2),
      list_knowledge_ingest_sources_page: ({ p_cursor_id }) => p_cursor_id === null ? page("source-a", 100) : page("source-b", 4),
    });
    await expect(loadKnowledgeWorkspace(client, { staff: true, health: true })).resolves.toMatchObject({
      catalog: { length: 83 }, files: { length: 82 }, sources: { length: 104 },
    });
    expect(client.rpc).toHaveBeenCalledWith("list_resource_catalog_page", expect.objectContaining({
      p_cursor_id: "catalog-a-79",
      p_cursor_created_at: "2026-08-28T23:58:41.000Z",
    }));
    expect(client.rpc).toHaveBeenCalledWith("list_steward_library_files_page", expect.objectContaining({
      p_cursor_id: "file-a-79",
      p_cursor_created_at: "2026-08-28T23:58:41.000Z",
    }));
    expect(client.rpc).toHaveBeenCalledWith("list_knowledge_ingest_sources_page", {
      p_cursor_id: "source-a-99",
      p_cursor_created_at: "2026-08-28T23:58:21.000Z",
    });
  });

  // REQ-UG-TRUSTED-SOURCE-STALENESS-CHECK-20261001: the hourly roll-up is
  // a soft read beside the health lists.
  it("adds the trusted-source roll-up to the health read and survives its absence", async () => {
    const rows = {
      list_knowledge_collections: [],
      get_google_drive_activation: { status: "unset" },
      get_knowledge_embedding_activation: { status: "unset" },
      list_resource_catalog_page: [],
      list_knowledge_ingest_sources_page: [],
    };
    const health = { enabled: true, staleDays: 180, attention: [] };
    const client = clientWith({ ...rows, get_knowledge_source_health: health });
    await expect(loadKnowledgeWorkspace(client, { health: true })).resolves.toMatchObject({ sourceHealth: health });
    const missing = clientWith(rows);
    await expect(loadKnowledgeWorkspace(missing, { health: true })).resolves.toMatchObject({ sourceHealth: null });
    await expect(loadKnowledgeWorkspace(client, { health: false })).resolves.toMatchObject({ sourceHealth: null });
  });

  it("rejects full pages that cannot advance a stable cursor", async () => {
    const client = clientWith({
      list_knowledge_collections: [],
      get_google_drive_activation: { status: "unset" },
      list_resource_catalog_page: Array.from({ length: 80 }, (_, index) => ({ id: `row-${index}` })),
    });
    await expect(loadKnowledgeWorkspace(client)).rejects.toThrow("invalid page cursor");
  });

  it("loads every selected-chapter review article from one statement snapshot", async () => {
    const snapshot = Array.from({ length: 501 }, (_, index) => ({
      id: `review-${index}`,
      orderIndex: index,
    }));
    const client = clientWith({
      list_knowledge_review_articles_snapshot: snapshot,
    });

    await expect(listKnowledgeReviewArticles(client, "chapter-b")).resolves.toHaveLength(501);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("list_knowledge_review_articles_snapshot", {
      p_chapter_id: "chapter-b",
    });
  });

  it("continues beyond the former fixed page ceiling while cursors advance", async () => {
    let request = 0;
    const client = clientWith({
      list_knowledge_collections: [],
      get_google_drive_activation: { status: "unset" },
      list_resource_catalog_page: () => {
        const page = request;
        request += 1;
        if (page === 127) return [];
        return Array.from({ length: 80 }, (_, index) => ({
          id: `row-${page}-${index}`,
          createdAt: new Date(Date.UTC(2026, 7, 29) - (page * 80 + index) * 1000).toISOString(),
        }));
      },
    });

    await expect(loadKnowledgeWorkspace(client)).resolves.toMatchObject({
      catalog: { length: 10_160 },
    });
    expect(request).toBe(128);
  });

  it("maps collection, revision, health, review, publish, and disconnect mutations to bounded RPCs", async () => {
    const client = clientWith();
    await saveKnowledgeCollection(client, { title: "Basics", description: "Read", visibility: "staff", scope: "organization", chapterId: "chapter-b" });
    await setKnowledgeCollectionItem(client, { collectionId: "c1", itemKind: "kb_article", itemId: "a1", include: false, sortOrder: 12, chapterId: "chapter-b" });
    await deleteKnowledgeCollection(client, "c1", "chapter-b");
    await listKnowledgeRevisions(client, "a1", "chapter-b");
    await restoreKnowledgeRevision(client, "a1", 7, true, "chapter-b");
    await clearKnowledgeSource(client, "s1");
    await reviewStewardLibraryFile(client, "f1", "approved");
    await publishStewardLibraryFile(client, "f1", "forms");
    await disconnectGoogleDrive(client);
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "save_knowledge_collection", "set_knowledge_collection_item", "delete_knowledge_collection",
      "list_chapter_kb_revisions", "restore_chapter_kb_revision", "clear_knowledge_ingest_source_chunks",
      "review_steward_library_file", "publish_steward_file_to_catalog", "disconnect_google_drive",
    ]);
    expect(client.rpc.mock.calls[4][1].p_idempotency_key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(client.rpc).toHaveBeenCalledWith("list_chapter_kb_revisions", {
      p_article_id: "a1",
      p_chapter_id: "chapter-b",
    });
    expect(client.rpc).toHaveBeenCalledWith("restore_chapter_kb_revision", expect.objectContaining({
      p_article_id: "a1",
      p_chapter_id: "chapter-b",
    }));
    expect(client.rpc).toHaveBeenCalledWith("save_knowledge_collection", {
      p_collection_id: null, p_title: "Basics", p_description: "Read",
      p_visibility: "staff", p_scope: "organization", p_chapter_id: "chapter-b",
    });
    expect(client.rpc).toHaveBeenCalledWith("set_knowledge_collection_item", {
      p_collection_id: "c1", p_item_kind: "kb_article", p_item_id: "a1",
      p_include: false, p_sort_order: 12, p_chapter_id: "chapter-b",
    });
    expect(client.rpc).toHaveBeenCalledWith("delete_knowledge_collection", {
      p_collection_id: "c1",
      p_chapter_id: "chapter-b",
    });
  });

  // BUG-UG-KNOWLEDGE-COLLECTION-TESTS-IGNORE-INTENT-20261020: the RPC
  // name and chapter alone cannot distinguish staff visibility from a wider
  // audience or a placement removal from inclusion. Check defaults separately
  // so they cannot overwrite an explicit choice, including sort order zero.
  it("saves the existing collection identity and defaults omitted fields", async () => {
    const saved = { id: "c2", title: "Updated" };
    const client = clientWith({ save_knowledge_collection: saved });

    await expect(saveKnowledgeCollection(client, { collectionId: "c2", title: "Updated" }))
      .resolves.toEqual(saved);
    expect(client.rpc.mock.calls).toEqual([["save_knowledge_collection", {
      p_collection_id: "c2", p_title: "Updated", p_description: "",
      p_visibility: "organization", p_scope: "chapter", p_chapter_id: null,
    }]]);
  });

  it.each([
    { scenario: "omitted placement options", options: {}, include: true, sortOrder: 500 },
    { scenario: "explicit removal at sort order zero", options: { include: false, sortOrder: 0 }, include: false, sortOrder: 0 },
  ])("preserves $scenario", async ({ options, include, sortOrder }) => {
    const client = clientWith();
    await setKnowledgeCollectionItem(client, {
      collectionId: "c2", itemKind: "knowledge_file", itemId: "resource-2", ...options,
    });
    expect(client.rpc.mock.calls).toEqual([["set_knowledge_collection_item", {
      p_collection_id: "c2", p_item_kind: "knowledge_file", p_item_id: "resource-2",
      p_include: include, p_sort_order: sortOrder, p_chapter_id: null,
    }]]);
  });

  it("loads, retries, and reviews knowledge ingest and conversion RPCs", async () => {
    const client = clientWith({
      get_knowledge_ingest_source: { id: "s1", health: "unset_embedding" },
      retry_knowledge_ingest_source: { id: "s1", health: "unset_embedding" },
      review_knowledge_conversion: { id: "c1", reviewedAt: "2026-09-16T12:00:00Z" },
    });
    client.query.limit.mockResolvedValue({
      data: [{
        id: "c1", organization_id: "org-1", source_id: "s1", file_id: "f1",
        attempt: 1, outcome: "succeeded", error_code: null, change_kind: "initial",
        converted_at: "2026-09-16T11:00:00Z", conversion_reviewed_at: null, conversion_reviewed_by: null,
      }],
      error: null,
    });

    await expect(getKnowledgeIngestSource(client, "s1")).resolves.toMatchObject({ id: "s1" });
    await expect(retryKnowledgeIngestSource(client, "s1", "11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({ id: "s1" });
    await expect(listKnowledgeConversions(client, "org-1")).resolves.toMatchObject({
      section: "needs_review",
      hasMore: false,
      nextCursor: null,
      conversions: [expect.objectContaining({ id: "c1", organizationId: "org-1", sourceId: "s1", reviewedAt: null })],
    });
    await expect(reviewKnowledgeConversion(client, "org-1", "c1")).resolves.toMatchObject({ id: "c1" });
    expect(client.rpc).toHaveBeenCalledWith("get_knowledge_ingest_source", { p_source_id: "s1" });
    expect(client.rpc).toHaveBeenCalledWith("retry_knowledge_ingest_source", {
      p_source_id: "s1",
      p_idempotency_key: "11111111-1111-4111-8111-111111111111",
    });
    expect(client.rpc).toHaveBeenCalledWith("review_knowledge_conversion", {
      p_organization_id: "org-1",
      p_conversion_id: "c1",
    });
  });

  it("lists conversion provenance and persists approve or reject through the review RPCs", async () => {
    const client = clientWith({
      organization_knowledge_conversions: [{
        id: "c1", organization_id: "org-1", source_id: "s1", file_id: "f1",
        attempt: 1, outcome: "succeeded", error_code: null, change_kind: "initial",
        converted_at: "2026-09-16T12:00:00Z", conversion_reviewed_at: null,
        conversion_reviewed_by: null, review_status: null, rejection_reason: null,
      }],
      review_knowledge_conversion: { id: "c1", reviewStatus: "approved" },
      reject_knowledge_conversion: { id: "c1", reviewStatus: "rejected", rejectionReason: "Wrong extract." },
    });
    await expect(listKnowledgeConversions(client, "org-1")).resolves.toEqual({
      section: "needs_review",
      hasMore: false,
      nextCursor: null,
      conversions: [{
        id: "c1", organizationId: "org-1", sourceId: "s1", fileId: "f1",
        attempt: 1, outcome: "succeeded", errorCode: null, changeKind: "initial",
        convertedAt: "2026-09-16T12:00:00Z", reviewedAt: null, reviewedBy: null,
        reviewStatus: null, rejectionReason: null, reviewColumnsAvailable: true,
      }],
    });
    expect(client.from).toHaveBeenCalledWith("organization_knowledge_conversions");
    await reviewKnowledgeConversion(client, "org-1", "c1");
    await rejectKnowledgeConversion(client, "org-1", "c1", "Wrong extract.");
    expect(client.rpc).toHaveBeenCalledWith("review_knowledge_conversion", {
      p_organization_id: "org-1",
      p_conversion_id: "c1",
    });
    expect(client.rpc).toHaveBeenCalledWith("reject_knowledge_conversion", {
      p_organization_id: "org-1",
      p_conversion_id: "c1",
      p_reason: "Wrong extract.",
    });
  });

  // UX-UG-KNOWLEDGE-CONVERSION-CARD-POLISH-20260917. The read used to take
  // only the client and apply a bare newest-50 window, so a reviewer who is
  // staff in two organizations got both interleaved with no way to page.
  it("binds the conversion list to one organization and refuses a read without one", async () => {
    const client = clientWith({ organization_knowledge_conversions: [] });
    await expect(listKnowledgeConversions(client)).rejects.toThrow(/requires an organization id/);
    await expect(listKnowledgeConversions(client, "")).rejects.toThrow(/requires an organization id/);
    expect(client.from).not.toHaveBeenCalled();

    await listKnowledgeConversions(client, "org-1");
    expect(client.query.eq).toHaveBeenCalledWith("organization_id", "org-1");
    // The default section is the actionable one: a settled decision may not
    // spend a page the reviewer needs for work.
    expect(client.query.is).toHaveBeenCalledWith("conversion_reviewed_at", null);
    expect(client.query.not).not.toHaveBeenCalled();
    expect(client.query.limit).toHaveBeenCalledWith(20);
    expect(client.query.order.mock.calls).toEqual([
      ["converted_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  });

  it("reaches a second page through the returned cursor and then the settled section", async () => {
    const page = (start, count, reviewed = null) => Array.from({ length: count }, (_, index) => ({
      id: `${String(start + index).padStart(8, "0")}-0000-4000-8000-${String(start + index).padStart(12, "0")}`,
      organization_id: "org-1", source_id: "s1", file_id: "f1",
      attempt: start + index, outcome: "succeeded", error_code: null, change_kind: "initial",
      converted_at: `2026-09-16T12:00:${String(59 - start - index).padStart(2, "0")}+00:00`,
      conversion_reviewed_at: reviewed, conversion_reviewed_by: reviewed && "u1",
      review_status: reviewed && "approved", rejection_reason: null,
    }));
    const client = clientWith();
    let call = 0;
    client.query.limit.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { data: page(0, 20), error: null };
      if (call === 2) return { data: page(20, 3), error: null };
      return { data: page(40, 2, "2026-09-16T13:00:00+00:00"), error: null };
    });

    const first = await listKnowledgeConversions(client, "org-1");
    expect(first.section).toBe("needs_review");
    expect(first.conversions).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({
      convertedAt: "2026-09-16T12:00:40+00:00",
      id: "00000019-0000-4000-8000-000000000019",
    });

    const second = await listKnowledgeConversions(client, "org-1", { section: first.section, cursor: first.nextCursor });
    // The keyset is spelled out because PostgREST has no row-value comparison,
    // and the instant is quoted because `or` takes a filter expression.
    expect(client.query.or).toHaveBeenCalledWith(
      'converted_at.lt."2026-09-16T12:00:40+00:00",and(converted_at.eq."2026-09-16T12:00:40+00:00",id.lt.00000019-0000-4000-8000-000000000019)',
    );
    expect(second.conversions).toHaveLength(3);
    expect(second.hasMore).toBe(false);

    const settled = await listKnowledgeConversions(client, "org-1", { section: "settled", cursor: null });
    expect(client.query.not).toHaveBeenCalledWith("conversion_reviewed_at", "is", null);
    expect(settled.section).toBe("settled");
    expect(settled.conversions.map((row) => row.reviewStatus)).toEqual(["approved", "approved"]);
  });

  // Review of #2176, LOW-3. The whole point of this read is a bounded window, so
  // the caller's page size may not be handed to .limit() unchecked: -1, 1000000
  // and the string "10" all reached it verbatim, and hasMore compares
  // rows.length === pageSize, which a non-integer silently breaks.
  it("bounds a caller-supplied page size instead of passing it to the query", async () => {
    const client = clientWith({ organization_knowledge_conversions: [] });
    for (const [given, expected] of [
      [undefined, 20], [null, 20], [0, 20], [-1, 20], [1.5, 20], ["10", 20], [Number.NaN, 20],
      [1, 1], [50, 50], [100, 100], [1000000, 100],
    ]) {
      client.query.limit.mockClear();
      await listKnowledgeConversions(client, "org-1", { pageSize: given });
      expect(client.query.limit, `pageSize=${String(given)}`).toHaveBeenCalledWith(expected);
    }
  });

  it("refuses an unknown section and a cursor that is not a real page key", async () => {
    const client = clientWith({ organization_knowledge_conversions: [] });
    await expect(listKnowledgeConversions(client, "org-1", { section: "everything" }))
      .rejects.toThrow(/unknown section/);
    for (const cursor of [
      { convertedAt: "2026-09-16T12:00:00+00:00", id: "not-a-uuid" },
      { convertedAt: "yesterday", id: "00000019-0000-4000-8000-000000000019" },
      { convertedAt: '2026-09-16T12:00:00+00:00")--', id: "00000019-0000-4000-8000-000000000019" },
    ]) {
      await expect(listKnowledgeConversions(client, "org-1", { cursor }))
        .rejects.toThrow(/invalid page cursor/);
    }
    expect(client.query.or).not.toHaveBeenCalled();
  });

  it("refuses conversion review and ingest retry errors with their RPC codes", async () => {
    const denied = clientWith({
      get_knowledge_ingest_source: Object.assign(new Error("not authorized"), { code: "42501" }),
      retry_knowledge_ingest_source: Object.assign(new Error("idempotency key required"), { code: "22023" }),
      review_knowledge_conversion: Object.assign(new Error("conversion is not awaiting review"), { code: "P0002" }),
    });
    await expect(getKnowledgeIngestSource(denied, "s1")).rejects.toMatchObject({ code: "42501" });
    await expect(retryKnowledgeIngestSource(denied, "s1")).rejects.toMatchObject({ code: "22023" });
    await expect(reviewKnowledgeConversion(denied, "org-1", "c1")).rejects.toMatchObject({ code: "P0002" });
  });

  it("retries the conversion list without review columns when hosted schema is pre-cutover", async () => {
    const missing = Object.assign(
      new Error("column organization_knowledge_conversions.review_status does not exist"),
      { code: "42703" },
    );
    expect(isMissingConversionReviewColumnError(missing)).toBe(true);
    expect(isMissingConversionReviewColumnError({
      code: "PGRST204",
      message: "Could not find the 'review_status' column of 'organization_knowledge_conversions' in the schema cache",
    })).toBe(true);
    expect(isMissingConversionReviewColumnError({ code: "42501", message: "not authorized" })).toBe(false);

    const client = clientWith();
    client.query.limit.mockImplementation(async () => {
      const columns = String(client.query.select.mock.calls.at(-1)?.[0] || "");
      if (columns.includes("review_status")) return { data: null, error: missing };
      return {
        data: [{
          id: "c1", organization_id: "org-1", source_id: "s1", file_id: "f1",
          attempt: 1, outcome: "succeeded", error_code: null, change_kind: "initial",
          converted_at: "2026-09-16T12:00:00Z", conversion_reviewed_at: null,
          conversion_reviewed_by: null,
        }],
        error: null,
      };
    });

    const listed = await listKnowledgeConversions(client, "org-1");
    expect(listed.conversions).toEqual([{
      id: "c1", organizationId: "org-1", sourceId: "s1", fileId: "f1",
      attempt: 1, outcome: "succeeded", errorCode: null, changeKind: "initial",
      convertedAt: "2026-09-16T12:00:00Z", reviewedAt: null, reviewedBy: null,
      reviewStatus: null, rejectionReason: null, reviewColumnsAvailable: false,
    }]);
    expect(client.query.select.mock.calls.map(([columns]) => columns)).toEqual([
      expect.stringContaining("review_status"),
      expect.not.stringContaining("review_status"),
    ]);

    await listKnowledgeConversions(client, "org-1");
    expect(client.query.select.mock.calls).toHaveLength(3);
    expect(client.query.select.mock.calls[2][0]).not.toContain("review_status");
    expect(knowledgeConversionReviewColumnsAvailable()).toBe(false);
    resetKnowledgeConversionReviewColumnProbe();
    expect(knowledgeConversionReviewColumnsAvailable()).toBe(true);
  });

  it("reports the cutover state from the probe, not from an empty conversion list", async () => {
    const missing = Object.assign(
      new Error("column organization_knowledge_conversions.review_status does not exist"),
      { code: "42703" },
    );
    const client = clientWith();
    client.query.limit.mockImplementation(async () => {
      const columns = String(client.query.select.mock.calls.at(-1)?.[0] || "");
      if (columns.includes("review_status")) return { data: null, error: missing };
      return { data: [], error: null };
    });
    await expect(listKnowledgeConversions(client, "org-1")).resolves.toMatchObject({ conversions: [] });
    expect(knowledgeConversionReviewColumnsAvailable()).toBe(false);
  });

  it("still raises conversion list errors that are not a missing-column cutover", async () => {
    const client = clientWith({
      organization_knowledge_conversions: Object.assign(new Error("not authorized"), { code: "42501" }),
    });
    await expect(listKnowledgeConversions(client, "org-1")).rejects.toMatchObject({
      code: "42501",
      message: "not authorized",
    });
  });

  it("uploads, inspects, completes, ingests, and resolves protected library downloads", async () => {
    const client = clientWith({
      prepare_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, storageHandle: "handle-1" },
      get_knowledge_file_storage_target: { bucketId: "organization-knowledge", objectName: "org/o/f", fileName: "guide.txt", mimeType: "text/plain" },
      complete_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, sourceId: "s1" },
      download_steward_library_file: { href: `knowledge:handle-1:${KNOWLEDGE_FILE_ID}` },
      download_resource_catalog_item: { href: `knowledge:handle-1:${KNOWLEDGE_FILE_ID}` },
    });
    const routed = routedFetch();
    vi.stubGlobal("fetch", routed);
    const file = new File(["safe guide"], "guide.txt", { type: "text/plain" });
    const phases = [];
    await expect(uploadStewardLibraryFile(client, file, { title: "Agreement", category: "contract", chapterId: "chapter-a" }, {
      onPhase: (phase) => phases.push(phase),
    })).resolves.toMatchObject({ sourceId: "s1" });
    expect(client.rpc).toHaveBeenCalledWith("prepare_steward_library_upload", expect.objectContaining({
      p_title: "Agreement",
      p_category: "contract",
      p_chapter_id: "chapter-a",
    }));
    // The server's declared type, not the browser's guess.
    expect(client.storageApi.upload).toHaveBeenCalledWith("org/o/f", file, {
      contentType: "text/plain", upsert: false,
    });
    // Inspected between the bytes and the metadata completion that makes them
    // indexable, publishable and downloadable.
    expect(routed.inspections).toEqual([{ kind: "knowledge", fileId: KNOWLEDGE_FILE_ID }]);
    expect(phases).toEqual(["checking"]);
    const names = client.rpc.mock.calls.map(([name]) => name);
    expect(names.indexOf("complete_steward_library_upload")).toBeGreaterThan(-1);
    expect(routed.mock.invocationCallOrder[0])
      .toBeLessThan(client.rpc.mock.invocationCallOrder[names.indexOf("complete_steward_library_upload")]);
    expect(routed).toHaveBeenCalledWith("/api/knowledge-ingest", expect.objectContaining({ method: "POST" }));

    // Downloads come back as bytes read with the reader's own session; no
    // signed URL is minted, because one could outlive a later quarantine.
    await expect(knowledgeFileBlob(client, KNOWLEDGE_FILE_ID, "steward"))
      .resolves.toEqual({ blob: expect.any(Blob), fileName: "guide.txt" });
    await expect(knowledgeFileBlob(client, KNOWLEDGE_FILE_ID, "catalog"))
      .resolves.toEqual({ blob: expect.any(Blob), fileName: "guide.txt" });
    expect(client.storageApi.download).toHaveBeenCalledWith("org/o/f");
    expect(client.storageApi.createSignedUrl).not.toHaveBeenCalled();
  });

  it("rolls the upload back when the inspection refuses the bytes", async () => {
    const client = clientWith({
      prepare_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, storageHandle: "handle-1" },
      get_knowledge_file_storage_target: { bucketId: "organization-knowledge", objectName: "org/o/f", mimeType: "text/plain" },
      complete_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, sourceId: "s1" },
    });
    vi.stubGlobal("fetch", routedFetch({ inspect: () => jsonResponse(422, { error: "private-file-executable" }) }));
    await expect(uploadStewardLibraryFile(client, new File(["x"], "x.txt", { type: "text/plain" }), {}))
      .rejects.toMatchObject({ code: "rejected" });
    // The existing rollback: the pending object and its metadata row both go,
    // and nothing unscanned is ever completed.
    expect(client.storageApi.remove).toHaveBeenCalledWith(["org/o/f"]);
    expect(client.rpc).toHaveBeenCalledWith("cancel_steward_library_upload", expect.any(Object));
    expect(client.rpc).not.toHaveBeenCalledWith("complete_steward_library_upload", expect.any(Object));
  });

  it("re-checks a stale knowledge verdict by id alone", async () => {
    const client = clientWith();
    const routed = routedFetch();
    vi.stubGlobal("fetch", routed);
    await expect(recheckKnowledgeFile(client, KNOWLEDGE_FILE_ID))
      .resolves.toEqual({ fileId: KNOWLEDGE_FILE_ID, status: "clean" });
    expect(routed.inspections).toEqual([{ kind: "knowledge", fileId: KNOWLEDGE_FILE_ID }]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("does not complete a knowledge upload when its safety check answers 503", async () => {
    const client = clientWith({
      prepare_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, storageHandle: "handle-1" },
      get_knowledge_file_storage_target: { bucketId: "organization-knowledge", objectName: "org/o/f", mimeType: "text/plain" },
    });
    vi.stubGlobal("fetch", routedFetch({ inspect: () => jsonResponse(503, { error: "file-check-unavailable" }) }));
    await expect(uploadStewardLibraryFile(client, new File(["x"], "x.txt", { type: "text/plain" }), {}))
      .rejects.toThrow();
    expect(client.storageApi.remove).toHaveBeenCalledWith(["org/o/f"]);
    expect(client.rpc).toHaveBeenCalledWith("cancel_steward_library_upload", expect.any(Object));
    expect(client.rpc).not.toHaveBeenCalledWith("complete_steward_library_upload", expect.any(Object));
  });

  it("binds contract upload preparation to the chapter selected by staff", async () => {
    const client = clientWith({
      prepare_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, storageHandle: "handle-1" },
      get_knowledge_file_storage_target: { bucketId: "organization-knowledge", objectName: "org/o/f", mimeType: "text/plain" },
      complete_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, sourceId: "s1" },
    });
    vi.stubGlobal("fetch", routedFetch());

    await uploadStewardLibraryFile(
      client,
      new File(["ARTICLE I\nRecognition"], "agreement.txt", { type: "text/plain" }),
      { category: "contract", chapterId: "chapter-b" },
    );

    expect(client.rpc).toHaveBeenCalledWith("prepare_steward_library_upload", expect.objectContaining({
      p_category: "contract",
      p_chapter_id: "chapter-b",
    }));
  });

  // BUG-UG-WEB-CATALOG-EXTERNAL-URL-FILES-UNDOWNLOADABLE-20261003: a
  // file recorded as an outside link is refused by the storage-target RPC; the
  // bucket download is never attempted and the token reaches the caller.
  it("never takes the bucket path for a file the server says is not stored here", async () => {
    const refusal = Object.assign(new Error("file is not stored here"), { code: "22023", details: "knowledge_file_external_unsupported" });
    const client = clientWith({
      download_resource_catalog_item: { href: "knowledge:handle-1:file" },
      get_knowledge_file_storage_target: refusal,
    });
    await expect(knowledgeFileBlob(client, KNOWLEDGE_FILE_ID, "catalog"))
      .rejects.toMatchObject({ code: "22023", details: "knowledge_file_external_unsupported" });
    expect(client.storageApi.download).not.toHaveBeenCalled();
  });

  it("cleans up a failed pending upload and rejects malformed opaque downloads", async () => {
    const client = clientWith({
      prepare_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, storageHandle: "handle-1" },
      get_knowledge_file_storage_target: { bucketId: "organization-knowledge", objectName: "org/o/f", mimeType: "text/plain" },
      complete_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, sourceId: "s1" },
      download_steward_library_file: { href: "not-a-handle" },
    });
    vi.stubGlobal("fetch", routedFetch());
    client.storageApi.upload.mockResolvedValue({ error: new Error("upload failed") });
    await expect(uploadStewardLibraryFile(client, new File(["x"], "x.txt"), {})).rejects.toThrow("upload failed");
    expect(client.storageApi.remove).toHaveBeenCalledWith(["org/o/f"]);
    expect(client.rpc).toHaveBeenCalledWith("cancel_steward_library_upload", expect.any(Object));
    await expect(knowledgeFileBlob(client, KNOWLEDGE_FILE_ID, "steward")).rejects.toThrow("opaque handle");
  });

  it("retains a completed upload and failed-source health when ingestion fails", async () => {
    const client = clientWith({
      prepare_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, storageHandle: "handle-1" },
      get_knowledge_file_storage_target: { bucketId: "organization-knowledge", objectName: "org/o/f", mimeType: "application/msword" },
      complete_steward_library_upload: { fileId: KNOWLEDGE_FILE_ID, sourceId: "s1" },
    });
    const routed = routedFetch();
    // Only the ingest leg fails; the inspection still returns a clean verdict.
    routed.ingest = async () => jsonResponse(422, { error: "knowledge-file-no-extractable-text" });
    vi.stubGlobal("fetch", routed);

    await expect(uploadStewardLibraryFile(client, new File(["legacy"], "legacy.doc"), {}))
      .resolves.toMatchObject({ sourceId: "s1", ingestionError: "knowledge-file-no-extractable-text" });
    expect(client.storageApi.remove).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("cancel_steward_library_upload", expect.any(Object));
  });

  it("uses the authenticated server routes for source retries and Drive operations", async () => {
    const client = clientWith();
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ source: { id: "s1" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ files: [{ id: "d1" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ file: { id: "d2" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ contentBase64: "c2FmZQ==" }) });
    await expect(retryKnowledgeSource(client, "s1")).resolves.toMatchObject({ id: "s1" });
    await expect(listConnectedDriveFiles(client)).resolves.toEqual([{ id: "d1" }]);
    await expect(uploadConnectedDriveFile(client, new File(["safe"], "safe.txt", { type: "text/plain" })))
      .resolves.toMatchObject({ file: { id: "d2" } });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await downloadConnectedDriveFile(client, { id: "d1", name: "safe.txt", mimeType: "text/plain" });
    expect(click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
    await expect(downloadConnectedDriveFile(client, {
      id: "d2", name: "large.bin", mimeType: "application/octet-stream", size: 3 * 1024 * 1024 + 1,
    })).rejects.toThrow("limited to 3 MB");
    expect(fetch).toHaveBeenCalledTimes(4);
    const authenticatedPost = (url) => [
      url,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer user-token" }),
      }),
    ];
    expect(fetch.mock.calls[0]).toEqual(authenticatedPost("/api/knowledge-ingest"));
    expect(fetch.mock.calls[1]).toEqual(authenticatedPost(`/api/google-drive?action=${encodeURIComponent("list")}`));
    expect(fetch.mock.calls[2]).toEqual(authenticatedPost(`/api/google-drive?action=${encodeURIComponent("upload")}`));
    expect(fetch.mock.calls[3]).toEqual(authenticatedPost(`/api/google-drive?action=${encodeURIComponent("download")}`));
  });

  it("issues no request without a session token", async () => {
    const client = clientWith();
    client.auth.getSession.mockResolvedValue({ data: { session: {} }, error: null });
    await expect(listConnectedDriveFiles(client)).rejects.toThrow("Session unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports bounded route/session failures and validates Drive setup inputs", async () => {
    const client = clientWith();
    fetch.mockResolvedValue({ ok: false, status: 422, json: async () => ({ error: "knowledge-file-no-extractable-text" }) });
    await expect(retryKnowledgeSource(client, "s1")).rejects.toThrow("knowledge-file-no-extractable-text");

    client.auth.getSession.mockResolvedValue({ data: {}, error: new Error("session unavailable") });
    await expect(listConnectedDriveFiles(client)).rejects.toThrow("session unavailable");
    await expect(uploadConnectedDriveFile(client, new File([new Uint8Array(3 * 1024 * 1024 + 1)], "large.bin")))
      .rejects.toThrow("limited to 3 MB");

    const validClient = clientWith();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ authorizationUrl: "https://evil.example/consent" }) });
    await expect(beginGoogleDriveConnection(validClient)).rejects.toThrow("authorization URL is invalid");
  });

  it("opens the Drive connect on the site address when started from another host (#9557)", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    try {
      fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "use-site-address", siteAddress: "https://unionground.net" }) });
      await beginGoogleDriveConnection(clientWith());
      expect(assign).toHaveBeenCalledWith("https://unionground.net/m/organize/library");
      fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "use-site-address", siteAddress: "https://evil.example/path" }) });
      await expect(beginGoogleDriveConnection(clientWith())).rejects.toThrow("use-site-address");
      expect(assign).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
