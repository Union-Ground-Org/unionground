// @vitest-environment node
import { describe, expect, it } from "vitest";
import { reviewStewardLibraryFile, publishStewardLibraryFile, restoreKnowledgeRevision } from "../src/features/knowledge/knowledgeApi.js";
import { saveChapterKnowledgeArticle } from "../src/lib/memberApi.js";

// Deterministic Supabase transport simulation. This proves the product APIs
// reach the authorized workflow RPCs and propagate their atomic refusals. The
// same APIs run against real PostgreSQL in the required DB proof, where every
// ledger and authorization assertion is evaluated by SQL, not this simulation.
function simulation({ refusal = false } = {}) {
  const calls = [];
  return { calls, client: { rpc: async (name, params) => {
    calls.push({ name, params });
    return refusal
      ? { data: null, error: { code: "42501", message: "not authorized" } }
      : { data: { id: "article", status: "published", keywords: [], version: 2 }, error: null };
  } } };
}

const fields = { articleId: "article", chapterId: "chapter", kind: "contract", title: " Clause ", articleRef: " 1 ", body: " Corrected text ", keywords: [], status: "published", confirmVerified: true };

describe("conversion provenance product API flows", () => {
  it("routes review and publication through their existing session-authorized RPCs", async () => {
    const { client, calls } = simulation();
    await reviewStewardLibraryFile(client, "file", "approved");
    await publishStewardLibraryFile(client, "file", "contract");
    expect(calls.map((call) => call.name)).toEqual(["review_steward_library_file", "publish_steward_file_to_catalog"]);
    expect(calls[0].params).toEqual({ p_file_id: "file", p_decision: "approved" });
    expect(calls[1].params).toEqual({ p_file_id: "file", p_category: "contract", p_idempotency_key: expect.any(String) });
  });

  it("routes corrections and restores without accepting caller-supplied provenance attribution", async () => {
    const { client, calls } = simulation();
    await saveChapterKnowledgeArticle(client, { ...fields, manualCorrection: false, reviewer: "forged", conversionId: "forged" });
    await restoreKnowledgeRevision(client, "article", 42, true, "chapter");
    expect(calls.map((call) => call.name)).toEqual(["save_chapter_kb_article", "restore_chapter_kb_revision"]);
    expect(calls[0].params).toEqual({ p_article_id: "article", p_chapter_id: "chapter", p_kind: "contract", p_title: "Clause", p_article_ref: "1", p_body: "Corrected text", p_keywords: [], p_status: "published", p_confirm_verified: true });
    expect(JSON.stringify(calls)).not.toContain("forged");
    expect(JSON.stringify(calls)).not.toContain("manualCorrection");
  });

  it("propagates workflow denial without a service-role or direct-ledger fallback", async () => {
    const { client, calls } = simulation({ refusal: true });
    for (const operation of [
      () => reviewStewardLibraryFile(client, "file", "approved"),
      () => publishStewardLibraryFile(client, "file", "contract"),
      () => saveChapterKnowledgeArticle(client, fields),
      () => restoreKnowledgeRevision(client, "article", 42, true, "chapter"),
    ]) await expect(operation()).rejects.toMatchObject({ code: "42501" });
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => !call.name.includes("conversion"))).toBe(true);
  });
});
