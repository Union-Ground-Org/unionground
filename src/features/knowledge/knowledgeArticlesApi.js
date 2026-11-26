import { chapterKnowledgeFromRow, MemberApiError } from "../../lib/memberApi.js";

export const KNOWLEDGE_ARTICLE_SNAPSHOT_RPC = "list_accessible_knowledge_articles_snapshot";

function isLiveArticle(article, publishedOnly, chapterId = null) {
  if (!article.chapterId || article.isSample) return false;
  if (chapterId && article.chapterId !== chapterId) return false;
  if (!publishedOnly) return true;
  return article.status === "published" && Boolean(article.verifiedBy) && Boolean(article.verifiedAt);
}

// Member boot intentionally carries only the first 100 article bodies. Search
// and the canonical Library are user-invoked surfaces, so they request one
// server-side MVCC snapshot instead of inheriting that boot-time window or
// combining independently committed PostgREST pages. RLS remains the
// authorization boundary; the explicit publication predicate keeps a
// member-selected hat fail-closed even when the session can also wear a staff
// hat.
export async function loadAccessibleKnowledgeArticles(client, {
  publishedOnly = false,
  chapterId = null,
  signal = null,
} = {}) {
  if (!client) return [];
  let request = client.rpc(KNOWLEDGE_ARTICLE_SNAPSHOT_RPC, {
    p_published_only: Boolean(publishedOnly),
    p_chapter_id: chapterId || null,
  });
  if (signal && typeof request.abortSignal === "function") {
    request = request.abortSignal(signal);
  }

  const { data, error } = await request;
  if (error) throw new MemberApiError("Load Guide knowledge", error);
  const rows = Array.isArray(data) ? data : [];

  return rows
    .map(chapterKnowledgeFromRow)
    .filter((article) => isLiveArticle(article, publishedOnly, chapterId))
    .sort((left, right) => left.orderIndex - right.orderIndex
      || String(left.id).localeCompare(String(right.id)));
}

export function visibleKnowledgeFallback(articles, {
  live = false,
  publishedOnly = false,
  chapterId = null,
} = {}) {
  const rows = Array.isArray(articles) ? articles : [];
  return live ? rows.filter((article) => isLiveArticle(article, publishedOnly, chapterId)) : rows;
}
