import { QA_RPC } from "./contract.js";
import { qaFailure, qaOk } from "./authorization.js";
import {
  normalizeQaBody,
  normalizeQaListQuery,
  normalizeQaTitle,
  normalizeQaVoteTarget,
} from "./validation.js";
import { isConflictRefusalCode } from "../../lib/memberApiError.js";

const UNSET_MESSAGE = "Q&A is unavailable because this backend does not provide the required functions.";

export function isMissingQaRpcError(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || code === "42883" || /could not find the function|does not exist/i.test(message);
}

function mapRpcError(error, fallback = "unavailable") {
  if (isMissingQaRpcError(error)) return qaFailure("unavailable", UNSET_MESSAGE);
  const code = String(error?.code || error?.status || "");
  const message = typeof error?.message === "string" ? error.message : "";
  if (/mfa required/i.test(message)) {
    return qaFailure("mfa_required", "Complete two-step verification to use questions.");
  }
  if (code === "42501") {
    return qaFailure("forbidden", "Q&A authorization could not be verified.");
  }
  // An expired or rejected session token is refused by PostgREST before the
  // RPC runs. It is an authorization failure, not an outage: callers that keep
  // loaded rows through a retryable failure must drop them here.
  if (code === "PGRST301" || code === "PGRST302" || code === "401" || /jwt expired/i.test(message)) {
    return qaFailure("forbidden", "Q&A authorization could not be verified.");
  }
  if (code === "22023" || code === "23514") {
    return qaFailure("invalid_input", "The Q&A input was rejected.");
  }
  if (isConflictRefusalCode(code)) {
    return qaFailure("conflict", "This question changed. Reload it and try again.");
  }
  if (code === "P0002") {
    return qaFailure("not_found", "Question not found.");
  }
  if (code === "503") {
    return qaFailure("unavailable", "Q&A is unavailable.");
  }
  if (/not authorized|permission denied|authentication required|only the question author/i.test(message)) {
    return qaFailure("forbidden", "Q&A authorization could not be verified.");
  }
  if (/invalid|must be|check constraint/i.test(message)) {
    return qaFailure("invalid_input", "The Q&A input was rejected.");
  }
  if (/stale question/i.test(message)) {
    return qaFailure("conflict", "This question changed. Reload it and try again.");
  }
  if (/not found/i.test(message)) return qaFailure("not_found", "Question not found.");
  return qaFailure(fallback, "Q&A is unavailable.");
}

export function createQaRpcAdapter(client) {
  async function call(name, args) {
    if (!client?.rpc) return qaFailure("unavailable", UNSET_MESSAGE);
    try {
      const result = await client.rpc(name, args);
      if (result?.error) return mapRpcError(result.error);
      return qaOk(result.data);
    } catch (error) {
      return mapRpcError(error);
    }
  }

  return {
    async list(queryInput) {
      const query = normalizeQaListQuery(queryInput);
      if (!query.ok) return query;
      return call(QA_RPC.list, {
        p_query: query.value.query,
        p_status: query.value.status === "all" ? null : query.value.status,
        p_sort: query.value.sort,
      });
    },
    get(questionId) {
      return call(QA_RPC.get, { p_question_id: questionId });
    },
    search(queryInput) {
      const query = normalizeQaListQuery(queryInput);
      if (!query.ok) return query;
      return call(QA_RPC.search, {
        p_query: query.value.query,
        p_status: query.value.status === "all" ? null : query.value.status,
        p_sort: query.value.sort,
      });
    },
    async ask({ title, body, idempotencyKey }) {
      const normalizedTitle = normalizeQaTitle(title);
      if (!normalizedTitle.ok) return normalizedTitle;
      const normalizedBody = normalizeQaBody(body, "Question");
      if (!normalizedBody.ok) return normalizedBody;
      return call(QA_RPC.ask, {
        p_title: normalizedTitle.value,
        p_body: normalizedBody.value,
        p_idempotency_key: idempotencyKey ?? null,
      });
    },
    async officialReply({ questionId, body, idempotencyKey }) {
      const normalizedBody = normalizeQaBody(body, "Official reply");
      if (!normalizedBody.ok) return normalizedBody;
      return call(QA_RPC.officialReply, {
        p_question_id: questionId,
        p_body: normalizedBody.value,
        p_idempotency_key: idempotencyKey ?? null,
      });
    },
    async followUp({ questionId, body, idempotencyKey }) {
      const normalizedBody = normalizeQaBody(body, "Follow-up");
      if (!normalizedBody.ok) return normalizedBody;
      return call(QA_RPC.followUp, {
        p_question_id: questionId,
        p_body: normalizedBody.value,
        p_idempotency_key: idempotencyKey ?? null,
      });
    },
    async toggleVote({ targetKind, targetId, voted }) {
      const kind = normalizeQaVoteTarget(targetKind);
      if (!kind.ok) return kind;
      return call(QA_RPC.toggleVote, {
        p_target_kind: kind.value,
        p_target_id: targetId,
        p_voted: Boolean(voted),
      });
    },
    accept({ questionId, replyId, accepted, expectedUpdatedAt }) {
      return call(QA_RPC.accept, {
        p_question_id: questionId,
        p_reply_id: replyId,
        p_accepted: Boolean(accepted),
        p_expected_updated_at: expectedUpdatedAt ?? null,
      });
    },
    async editQuestion({ questionId, title, body }) {
      const normalizedTitle = normalizeQaTitle(title);
      if (!normalizedTitle.ok) return normalizedTitle;
      const normalizedBody = normalizeQaBody(body, "Question");
      if (!normalizedBody.ok) return normalizedBody;
      return call(QA_RPC.editQuestion, {
        p_question_id: questionId,
        p_title: normalizedTitle.value,
        p_body: normalizedBody.value,
      });
    },
    deleteQuestion({ questionId }) {
      return call(QA_RPC.deleteQuestion, { p_question_id: questionId });
    },
    // The reply RPCs are keyed by the reply id alone. A payload may also carry
    // the parent question id for the preview store; this adapter ignores it so
    // one payload shape works against both adapters.
    async editReply({ replyId, body }) {
      const normalizedBody = normalizeQaBody(body);
      if (!normalizedBody.ok) return normalizedBody;
      return call(QA_RPC.editReply, { p_reply_id: replyId, p_body: normalizedBody.value });
    },
    deleteReply({ replyId }) {
      return call(QA_RPC.deleteReply, { p_reply_id: replyId });
    },
    /** @param {{ afterCreatedAt?: string | null, afterId?: string | null, limit?: number }} [options] */
    officerQueue({ afterCreatedAt = null, afterId = null, limit = 50 } = {}) {
      return call(QA_RPC.officerQueue, {
        p_limit: limit,
        p_after_created_at: afterCreatedAt,
        p_after_id: afterId,
      });
    },
  };
}

export function createQaStoreAdapter(store, actor) {
  return {
    async list(queryInput) {
      const query = normalizeQaListQuery(queryInput);
      if (!query.ok) return query;
      return store.list(actor, query.value);
    },
    async get(questionId) {
      return store.get(actor, questionId);
    },
    async search(queryInput) {
      const query = normalizeQaListQuery(queryInput);
      if (!query.ok) return query;
      return store.list(actor, query.value);
    },
    async ask(input) {
      return store.ask(actor, input);
    },
    async officialReply(input) {
      return store.reply(actor, { ...input, kind: "official" });
    },
    async followUp(input) {
      return store.reply(actor, { ...input, kind: "follow_up" });
    },
    async toggleVote(input) {
      return store.toggleVote(actor, input);
    },
    async accept(input) {
      return store.accept(actor, input);
    },
    async editQuestion(input) {
      return store.editQuestion(actor, input);
    },
    async deleteQuestion(input) {
      return store.deleteQuestion(actor, input);
    },
    async editReply(input) {
      return store.editReply(actor, input);
    },
    async deleteReply(input) {
      return store.deleteReply(actor, input);
    },
    async officerQueue(cursor) {
      return store.officerQueue(actor, cursor);
    },
  };
}
