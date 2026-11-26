import { useCallback, useEffect, useMemo, useState } from "react";
import { SHELL_LOAD_DEADLINE_MS, withLoadDeadline } from "../../lib/loadDeadline.js";
import { loadAccessibleKnowledgeArticles, visibleKnowledgeFallback } from "./knowledgeArticlesApi.js";

const EMPTY_ARTICLES = Object.freeze([]);

// The fallback's content, not its array identity. Every member-data projection
// rebuilds data.kbArticles, so keying the request on the array aborted and
// restarted it each time and /m/search could sit on "Loading the complete
// chapter knowledge index…" for as long as projections kept arriving
// (REQ-UG-PAGE-LOADING-STALLS-20261030). A real change to the
// fallback articles still refetches the snapshot.
export function knowledgeFallbackSignature(articles) {
  return JSON.stringify((Array.isArray(articles) ? articles : []).map((article) => [
    article?.id ?? null,
    article?.version ?? null,
    article?.updatedAt ?? null,
    article?.status ?? null,
  ]));
}

// Keep remote results bound to the exact client, identity scope, selected-hat
// visibility, and fallback content that requested them. The render-time key
// check prevents one frame of the previous identity's corpus before the effect
// cleanup runs; AbortController also releases an obsolete snapshot request.
// A snapshot that has not answered by the shell deadline is abandoned as an
// error, and `retry` asks again.
export function useAccessibleKnowledgeArticles({
  client = null,
  enabled = true,
  fallbackArticles = EMPTY_ARTICLES,
  publishedOnly = false,
  chapterId = null,
  scopeKey = "",
  deadlineMs = SHELL_LOAD_DEADLINE_MS,
} = {}) {
  const sourceArticles = Array.isArray(fallbackArticles) ? fallbackArticles : EMPTY_ARTICLES;
  const fallback = useMemo(() => visibleKnowledgeFallback(sourceArticles, {
    live: Boolean(client),
    publishedOnly,
    chapterId,
  }), [chapterId, client, publishedOnly, sourceArticles]);
  const fallbackKey = useMemo(() => knowledgeFallbackSignature(fallback), [fallback]);
  const [remote, setRemote] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const matches = remote
    && remote.client === client
    && remote.fallbackKey === fallbackKey
    && remote.publishedOnly === publishedOnly
    && remote.chapterId === chapterId
    && remote.scopeKey === scopeKey;
  const shouldLoad = Boolean(client && enabled);

  useEffect(() => {
    if (!shouldLoad) {
      setRemote(null);
      return undefined;
    }

    let current = true;
    const controller = new AbortController();
    const request = { client, fallbackKey, publishedOnly, chapterId, scopeKey };
    setRemote({ ...request, articles: null, phase: "loading", error: null });
    withLoadDeadline(loadAccessibleKnowledgeArticles(client, {
      publishedOnly,
      chapterId,
      signal: controller.signal,
    }), deadlineMs).then((articles) => {
      if (current) setRemote({ ...request, articles, phase: "ready", error: null });
    }).catch((error) => {
      if (current && !controller.signal.aborted) {
        setRemote({ ...request, articles: null, phase: "error", error });
      }
      controller.abort();
    });

    return () => {
      current = false;
      controller.abort();
    };
  }, [attempt, chapterId, client, deadlineMs, fallbackKey, publishedOnly, scopeKey, shouldLoad]);

  if (!shouldLoad) return { articles: fallback, phase: "fallback", error: null, retry };
  if (!matches) return { articles: fallback, phase: "loading", error: null, retry };
  return { articles: remote.articles ?? fallback, phase: remote.phase, error: remote.error, retry };
}
