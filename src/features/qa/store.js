import { QA_LIST_LIMIT } from "./contract.js";
import { canSeeQaRecord, qaFailure, qaOk } from "./authorization.js";
import { redactQaDisplayName } from "./validation.js";
import { searchQaHistory } from "./search.js";
import { notePreview } from "../../lib/notePreview.js";
import {
  officerQueueVisible,
  planAcceptQaAnswer,
  planAskQaQuestion,
  planDeleteQaQuestion,
  planDeleteQaReply,
  planEditQaQuestion,
  planEditQaReply,
  planQaReply,
  planToggleQaVote,
  sortQaReplies,
} from "./transitions.js";

function createId(prefix, clock) {
  const stamp = clock?.now?.() ?? Date.now();
  // Optimistic identifiers are not credentials, but a pseudo-random salt is
  // never the right source for anything that must not collide or be guessed.
  // The Web Crypto API is available in every runtime this module loads in.
  const salt = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${prefix}_${stamp.toString(36)}_${salt}`;
}

function cloneQuestion(question, actor) {
  const replies = sortQaReplies(question.replies ?? []).map((reply) => ({
    ...reply,
    authorId: undefined,
    votedByMe: (reply.voterIds ?? []).includes(actor.userId),
    voterIds: undefined,
  }));
  return {
    ...question,
    authorId: undefined,
    authoredByMe: question.authorId === actor.userId,
    replies,
    votedByMe: (question.voterIds ?? []).includes(actor.userId),
    voterIds: undefined,
    replyCount: replies.filter((reply) => !reply.deletedAt).length,
    officialReplyCount: replies.filter((reply) => !reply.deletedAt && reply.kind === "official").length,
  };
}

export function createInMemoryQaStore({ clock } = {}) {
  const questions = new Map();
  const audits = [];
  const idempotency = new Map();

  function getQuestion(id) {
    return questions.get(id) ?? null;
  }

  // A reply payload carries the reply id in both adapters but the parent
  // question id in neither server RPC, so resolve the parent from the reply
  // itself whenever the payload does not name a question that exists.
  function getReplyQuestion(input) {
    const named = input.questionId ? getQuestion(input.questionId) : null;
    if (named) return named;
    return [...questions.values()]
      .find((item) => item.replies.some((reply) => reply.id === input.replyId)) ?? null;
  }

  function remember(key, result) {
    if (!key) return result;
    idempotency.set(key, result);
    return result;
  }

  function replay(key) {
    return key && idempotency.has(key) ? idempotency.get(key) : null;
  }

  function attachReplies(question) {
    return question;
  }

  function visibleQuestions(actor) {
    return [...questions.values()]
      .filter((question) => canSeeQaRecord(actor, question))
      .map((question) => attachReplies(question));
  }

  return {
    audits,
    ask(actor, input) {
      const replayed = replay(input.idempotencyKey);
      if (replayed) return replayed;
      const planned = planAskQaQuestion(actor, input, clock);
      if (!planned.ok) return planned;
      const question = {
        ...planned.value.question,
        id: createId("q", clock),
        authorDisplayName: redactQaDisplayName(input.authorDisplayName ?? "Member"),
        replies: [],
        voterIds: [],
      };
      questions.set(question.id, question);
      audits.push({ ...planned.value.audit, metadata: { ...planned.value.audit.metadata, questionId: question.id } });
      return remember(input.idempotencyKey, qaOk(cloneQuestion(question, actor)));
    },

    reply(actor, input) {
      const replayed = replay(input.idempotencyKey);
      if (replayed) return replayed;
      const question = getQuestion(input.questionId);
      const planned = planQaReply(actor, question, input, clock);
      if (!planned.ok) return planned;
      const reply = {
        ...planned.value.reply,
        id: createId("r", clock),
        authorDisplayName: redactQaDisplayName(input.authorDisplayName ?? (input.kind === "official" ? "Steward" : "Member")),
        voterIds: [],
      };
      question.replies.push(reply);
      question.acceptedReplyId = planned.value.acceptedReplyId;
      question.status = planned.value.nextStatus;
      question.replies = question.replies.map((item) => ({
        ...item,
        accepted: item.id === planned.value.acceptedReplyId,
      }));
      question.updatedAt = reply.createdAt;
      audits.push({ ...planned.value.audit, metadata: { ...planned.value.audit.metadata, replyId: reply.id } });
      return remember(input.idempotencyKey, qaOk(cloneQuestion(question, actor)));
    },

    accept(actor, input) {
      const question = getQuestion(input.questionId);
      const planned = planAcceptQaAnswer(actor, question, input.replyId, input.accepted);
      if (!planned.ok) return planned;
      question.acceptedReplyId = planned.value.acceptedReplyId;
      question.status = planned.value.nextStatus;
      question.replies = question.replies.map((reply) => ({
        ...reply,
        accepted: reply.id === planned.value.acceptedReplyId,
      }));
      if (planned.value.changed) audits.push(planned.value.audit);
      return qaOk(cloneQuestion(question, actor));
    },

    toggleVote(actor, input) {
      const question = input.targetKind === "question"
        ? getQuestion(input.targetId)
        : [...questions.values()].find((item) => item.replies.some((reply) => reply.id === input.targetId)) ?? null;
      const record = input.targetKind === "question"
        ? question
        : question?.replies.find((reply) => reply.id === input.targetId) ?? null;
      const planned = planToggleQaVote(actor, record, input.targetKind, input.voted);
      if (!planned.ok) return planned;
      const voterIds = new Set(record.voterIds ?? []);
      if (planned.value.voted) voterIds.add(actor.userId);
      else voterIds.delete(actor.userId);
      record.voterIds = [...voterIds];
      record.upvoteCount = planned.value.nextCount;
      if (planned.value.changed) audits.push(planned.value.audit);
      return qaOk({
        voted: planned.value.voted,
        upvoteCount: planned.value.nextCount,
        question: cloneQuestion(question, actor),
      });
    },

    editQuestion(actor, input) {
      const question = getQuestion(input.questionId);
      const planned = planEditQaQuestion(actor, question, input);
      if (!planned.ok) return planned;
      question.title = planned.value.title;
      question.body = planned.value.body;
      question.updatedAt = new Date(clock?.now?.() ?? Date.now()).toISOString();
      audits.push(planned.value.audit);
      return qaOk(cloneQuestion(question, actor));
    },

    deleteQuestion(actor, input) {
      const question = getQuestion(input.questionId);
      const planned = planDeleteQaQuestion(actor, question);
      if (!planned.ok) return planned;
      question.deletedAt = new Date(clock?.now?.() ?? Date.now()).toISOString();
      audits.push(planned.value.audit);
      return qaOk({ deleted: true, id: question.id });
    },

    editReply(actor, input) {
      const question = getReplyQuestion(input);
      const planned = planEditQaReply(actor, question, input.replyId, input.body);
      if (!planned.ok) return planned;
      const reply = question.replies.find((item) => item.id === input.replyId);
      reply.body = planned.value.body;
      reply.updatedAt = new Date(clock?.now?.() ?? Date.now()).toISOString();
      audits.push(planned.value.audit);
      return qaOk(cloneQuestion(question, actor));
    },

    deleteReply(actor, input) {
      const question = getReplyQuestion(input);
      const planned = planDeleteQaReply(actor, question, input.replyId);
      if (!planned.ok) return planned;
      const reply = question.replies.find((item) => item.id === input.replyId);
      reply.deletedAt = new Date(clock?.now?.() ?? Date.now()).toISOString();
      question.acceptedReplyId = planned.value.acceptedReplyId;
      question.status = planned.value.nextStatus;
      question.replies = question.replies.map((item) => ({
        ...item,
        accepted: item.id === planned.value.acceptedReplyId,
      }));
      audits.push(planned.value.audit);
      return qaOk(cloneQuestion(question, actor));
    },

    list(actor, query) {
      const rows = searchQaHistory(visibleQuestions(actor), query).slice(0, QA_LIST_LIMIT);
      return qaOk(rows.map((question) => cloneQuestion(question, actor)));
    },

    get(actor, questionId) {
      const question = getQuestion(questionId);
      if (!question || !canSeeQaRecord(actor, question)) {
        return qaFailure("not_found", "Question not found.");
      }
      return qaOk(cloneQuestion(question, actor));
    },

    officerQueue(actor, { afterCreatedAt = null, afterId = null, limit = QA_LIST_LIMIT } = {}) {
      const rows = visibleQuestions(actor)
        .filter((question) => officerQueueVisible(actor, question))
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))
        .filter((question) => !afterCreatedAt
          || Date.parse(question.createdAt) > Date.parse(afterCreatedAt)
          || (question.createdAt === afterCreatedAt && afterId && question.id > afterId));
      const clamped = Math.max(1, Math.min(Number(limit) || QA_LIST_LIMIT, 200));
      const page = rows.slice(0, clamped);
      const last = page.at(-1);
      return qaOk({
        questions: page.map((question) => cloneQuestion(question, actor)),
        nextAfterCreatedAt: rows.length > clamped ? last?.createdAt ?? null : null,
        nextAfterId: rows.length > clamped ? last?.id ?? null : null,
      });
    },
  };
}

export function projectQaListItem(question) {
  return {
    id: question.id,
    title: question.title,
    preview: notePreview(question.body).slice(0, 180),
    status: question.status,
    upvoteCount: question.upvoteCount,
    replyCount: question.replyCount,
    officialReplyCount: question.officialReplyCount,
    votedByMe: question.votedByMe,
    authorDisplayName: question.authorDisplayName,
    createdAt: question.createdAt,
    accepted: question.status === "accepted",
  };
}
