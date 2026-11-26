import {
  buildLearningItemPayload,
  normalizeLearningHistoryPage,
  normalizeLearningHomeHidden,
  normalizeLearningItem,
  normalizeLearningPage,
  normalizeLearningPolicy,
  normalizeLearningScopePolicy,
  normalizeLearningWorkspace,
} from "./model.js";

// The nine authenticated RPCs behind governed quotes and mini-lessons. The
// client is the caller's own session client handed down from App; nothing
// here reads a global credential. Every response is normalized by the shared
// model and a malformed envelope is an error, never an empty success.
export class LearningContentError extends Error {
  constructor(code) {
    super(code);
    this.name = "LearningContentError";
    this.code = code;
  }
}

async function settle(request, normalize) {
  if (!request || typeof request.then !== "function") throw new LearningContentError("learning_client_unavailable");
  const { data, error } = await request;
  if (error) throw error;
  const value = normalize(data);
  if (value == null) throw new LearningContentError("invalid_learning_response");
  return value;
}

export function createLearningContentApi(client) {
  const usable = client && typeof client.rpc === "function" ? client : null;
  return {
    preview: false,
    getPolicy({ chapterId }) {
      return settle(usable?.rpc("get_learning_policy", { p_chapter_id: chapterId }), normalizeLearningPolicy);
    },
    async listContent({ chapterId, locale, kind = null, offset = 0, limit }) {
      const page = await settle(usable?.rpc("list_learning_content", {
        p_chapter_id: chapterId, p_locale: locale, p_kind: kind, p_offset: offset, p_limit: limit,
      }), normalizeLearningPage);
      // Defense in depth: a row in another language or of another kind than
      // the one asked for is dropped, never shown as a fallback.
      const items = page.items.filter((item) => item.locale === locale && (kind == null || item.kind === kind));
      return { ...page, items, dropped: page.dropped + (page.items.length - items.length) };
    },
    getWorkspace({ chapterId, scope, offset = 0 }) {
      return settle(usable?.rpc("get_learning_workspace", { p_chapter_id: chapterId, p_scope: scope, p_offset: offset }), normalizeLearningWorkspace);
    },
    // Reviewed items a manager may pick for a selection (platform library,
    // organization and, for a chapter, that chapter), 40 per page, readable
    // even while a module is off. Editorial fields are never included.
    listChoices({ chapterId, scope, offset = 0 }) {
      return settle(usable?.rpc("list_learning_choices", { p_chapter_id: chapterId, p_scope: scope, p_offset: offset }), normalizeLearningPage);
    },
    savePolicy({ chapterId, scope, quotesEnabled, lessonsEnabled, selectedIds, expectedRevision }) {
      return settle(usable?.rpc("save_learning_policy", {
        p_chapter_id: chapterId, p_scope: scope, p_quotes_enabled: quotesEnabled, p_lessons_enabled: lessonsEnabled,
        p_selected_ids: selectedIds == null ? null : [...selectedIds],
        p_expected_revision: expectedRevision,
      }), normalizeLearningScopePolicy);
    },
    saveContent({ chapterId, scope, draft, expectedRevision = null }) {
      return settle(usable?.rpc("save_learning_content", {
        p_chapter_id: chapterId, p_scope: scope, p_item: buildLearningItemPayload(draft), p_expected_revision: expectedRevision,
      }), normalizeLearningItem);
    },
    transition({ chapterId, id, action, expectedRevision, startsAt = null, endsAt = null }) {
      return settle(usable?.rpc("transition_learning_content", {
        p_chapter_id: chapterId, p_id: id, p_action: action, p_expected_revision: expectedRevision,
        p_starts_at: startsAt, p_ends_at: endsAt,
      }), normalizeLearningItem);
    },
    getHistory({ chapterId, id, offset = 0 }) {
      return settle(usable?.rpc("get_learning_history", { p_chapter_id: chapterId, p_id: id, p_offset: offset }), normalizeLearningHistoryPage);
    },
    setHomeHidden({ chapterId, hidden }) {
      return settle(usable?.rpc("set_learning_home_hidden", { p_chapter_id: chapterId, p_hidden: hidden }), normalizeLearningHomeHidden);
    },
  };
}
