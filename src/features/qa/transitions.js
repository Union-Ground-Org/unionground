import { QA_AUDIT_ACTIONS } from "./contract.js";
import {
  canAcceptQaAnswer,
  canAskQaQuestion,
  canFollowUpOnQa,
  canModerateQa,
  canOfficialReplyOnQa,
  canSeeOfficerQaQueue,
  canSeeQaRecord,
  canVoteOnQa,
  qaFailure,
  qaOk,
  requireActiveQaMember,
} from "./authorization.js";
import { normalizeQaBody, normalizeQaTitle } from "./validation.js";

function nowIso(clock) {
  return new Date(clock?.now?.() ?? Date.now()).toISOString();
}

export function deriveQaQuestionStatus(replies, acceptedReplyId) {
  const live = (replies ?? []).filter((reply) => !reply.deletedAt);
  if (acceptedReplyId && live.some((reply) => reply.id === acceptedReplyId && reply.kind === "official")) {
    return "accepted";
  }
  if (live.some((reply) => reply.kind === "official")) return "replied";
  return "open";
}

export function sortQaReplies(replies) {
  return [...(replies ?? [])].sort((left, right) => {
    if (left.accepted && !right.accepted) return -1;
    if (!left.accepted && right.accepted) return 1;
    if (left.kind === "official" && right.kind !== "official") return -1;
    if (left.kind !== "official" && right.kind === "official") return 1;
    return Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || String(left.id).localeCompare(String(right.id));
  });
}

export function boundedQaAudit(action, metadata) {
  return {
    action,
    metadata: {
      organizationId: metadata.organizationId,
      chapterId: metadata.chapterId,
      questionId: metadata.questionId ?? null,
      replyId: metadata.replyId ?? null,
      targetKind: metadata.targetKind ?? null,
      voted: metadata.voted ?? null,
      status: metadata.status ?? null,
      kind: metadata.kind ?? null,
    },
  };
}

export function planAskQaQuestion(actor, input, clock) {
  const gate = requireActiveQaMember(actor);
  if (!gate.ok) return gate;
  if (!canAskQaQuestion(actor)) return qaFailure("forbidden", "You cannot ask a question here.");
  const title = normalizeQaTitle(input.title);
  if (!title.ok) return title;
  const body = normalizeQaBody(input.body, "Question");
  if (!body.ok) return body;
  const createdAt = nowIso(clock);
  return qaOk({
    question: {
      organizationId: actor.organizationId,
      chapterId: actor.chapterId,
      authorId: actor.userId,
      title: title.value,
      body: body.value,
      status: "open",
      acceptedReplyId: null,
      upvoteCount: 0,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    },
    audit: boundedQaAudit(QA_AUDIT_ACTIONS.asked, {
      organizationId: actor.organizationId,
      chapterId: actor.chapterId,
      status: "open",
    }),
  });
}

export function planQaReply(actor, question, input, clock) {
  const gate = requireActiveQaMember(actor);
  if (!gate.ok) return gate;
  if (!question || question.deletedAt || !canSeeQaRecord(actor, question)) {
    return qaFailure("not_found", "Question not found.");
  }
  const official = input.kind === "official";
  if (official && !canOfficialReplyOnQa(actor, question)) {
    return qaFailure("forbidden", "Only a steward or officer can post an official reply.");
  }
  if (!official && (!canFollowUpOnQa(actor)
    || (question.authoredByMe !== true && question.authorId !== actor.userId))) {
    return qaFailure("forbidden", "You cannot reply here.");
  }
  const body = normalizeQaBody(input.body, official ? "Official reply" : "Follow-up");
  if (!body.ok) return body;
  const createdAt = nowIso(clock);
  const reply = {
    organizationId: question.organizationId,
    chapterId: question.chapterId,
    questionId: question.id,
    authorId: actor.userId,
    kind: official ? "official" : "follow_up",
    body: body.value,
    accepted: false,
    upvoteCount: 0,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  return qaOk({
    reply,
    acceptedReplyId: official ? question.acceptedReplyId : null,
    nextStatus: official
      ? deriveQaQuestionStatus([...(question.replies ?? []), reply], question.acceptedReplyId)
      : "open",
    audit: boundedQaAudit(official ? QA_AUDIT_ACTIONS.officialReplied : QA_AUDIT_ACTIONS.followUpReplied, {
      organizationId: question.organizationId,
      chapterId: question.chapterId,
      questionId: question.id,
      kind: reply.kind,
    }),
  });
}

export function planAcceptQaAnswer(actor, question, replyId, desiredAccepted) {
  const gate = requireActiveQaMember(actor);
  if (!gate.ok) return gate;
  if (!question || question.deletedAt || !canSeeQaRecord(actor, question)) {
    return qaFailure("not_found", "Question not found.");
  }
  if (!canAcceptQaAnswer(actor, question)) {
    return qaFailure("forbidden", "Only the asker or a steward or officer can accept an answer.");
  }
  const reply = (question.replies ?? []).find((item) => item.id === replyId && !item.deletedAt);
  if (!reply || reply.questionId !== question.id || reply.organizationId !== question.organizationId) {
    return qaFailure("not_found", "Reply not found.");
  }
  if (reply.kind !== "official") {
    return qaFailure("invalid_reply", "Only an official steward or officer reply can be accepted.");
  }

  const accept = typeof desiredAccepted === "boolean"
    ? desiredAccepted
    : question.acceptedReplyId !== reply.id;
  const changed = (question.acceptedReplyId === reply.id) !== accept;
  if (!accept) {
    const nextAccepted = null;
    const nextStatus = deriveQaQuestionStatus(question.replies, nextAccepted);
    return qaOk({
      acceptedReplyId: nextAccepted,
      nextStatus,
      changed,
      audit: boundedQaAudit(QA_AUDIT_ACTIONS.unaccepted, {
        organizationId: question.organizationId,
        chapterId: question.chapterId,
        questionId: question.id,
        replyId: reply.id,
        status: nextStatus,
      }),
    });
  }

  const nextStatus = "accepted";
  return qaOk({
    acceptedReplyId: reply.id,
    nextStatus,
    changed,
    audit: boundedQaAudit(QA_AUDIT_ACTIONS.accepted, {
      organizationId: question.organizationId,
      chapterId: question.chapterId,
      questionId: question.id,
      replyId: reply.id,
      status: nextStatus,
    }),
  });
}

export function planToggleQaVote(actor, record, targetKind, desiredVoted) {
  const gate = requireActiveQaMember(actor);
  if (!gate.ok) return gate;
  if (!record || record.deletedAt || !canSeeQaRecord(actor, record)) {
    return qaFailure("not_found", "Record not found.");
  }
  if (!canVoteOnQa(actor)) return qaFailure("forbidden", "You cannot vote here.");
  const voted = typeof desiredVoted === "boolean"
    ? desiredVoted
    : !record.voterIds?.includes(actor.userId);
  const wasVoted = Boolean(record.voterIds?.includes(actor.userId));
  const changed = wasVoted !== voted;
  return qaOk({
    voted,
    changed,
    nextCount: Math.max(0, (record.upvoteCount ?? 0) + (changed ? (voted ? 1 : -1) : 0)),
    audit: boundedQaAudit(QA_AUDIT_ACTIONS.voted, {
      organizationId: record.organizationId,
      chapterId: record.chapterId,
      questionId: record.questionId ?? record.id,
      replyId: targetKind === "reply" ? record.id : null,
      targetKind,
      voted,
    }),
  });
}

export function planEditQaQuestion(actor, question, input) {
  const gate = requireActiveQaMember(actor);
  if (!gate.ok) return gate;
  if (!question || question.deletedAt || !canSeeQaRecord(actor, question)) {
    return qaFailure("not_found", "Question not found.");
  }
  if (!canModerateQa(actor, question)) return qaFailure("forbidden", "You can only edit your own question.");
  const title = normalizeQaTitle(input.title);
  if (!title.ok) return title;
  const body = normalizeQaBody(input.body, "Question");
  if (!body.ok) return body;
  return qaOk({
    title: title.value,
    body: body.value,
    audit: boundedQaAudit(QA_AUDIT_ACTIONS.edited, {
      organizationId: question.organizationId,
      chapterId: question.chapterId,
      questionId: question.id,
      kind: "question",
    }),
  });
}

export function planDeleteQaQuestion(actor, question) {
  const gate = requireActiveQaMember(actor);
  if (!gate.ok) return gate;
  if (!question || question.deletedAt || !canSeeQaRecord(actor, question)) {
    return qaFailure("not_found", "Question not found.");
  }
  if (!canModerateQa(actor, question)) return qaFailure("forbidden", "You can only delete your own question.");
  return qaOk({
    deleted: true,
    audit: boundedQaAudit(QA_AUDIT_ACTIONS.deleted, {
      organizationId: question.organizationId,
      chapterId: question.chapterId,
      questionId: question.id,
      kind: "question",
    }),
  });
}

export function planEditQaReply(actor, question, replyId, bodyInput) {
  const gate = requireActiveQaMember(actor);
  if (!gate.ok) return gate;
  if (!question || question.deletedAt || !canSeeQaRecord(actor, question)) {
    return qaFailure("not_found", "Question not found.");
  }
  const reply = (question.replies ?? []).find((item) => item.id === replyId && !item.deletedAt);
  if (!reply) return qaFailure("not_found", "Reply not found.");
  if (!canModerateQa(actor, reply, question)) return qaFailure("forbidden", "You can only edit your own reply.");
  const body = normalizeQaBody(bodyInput, reply.kind === "official" ? "Official reply" : "Follow-up");
  if (!body.ok) return body;
  return qaOk({
    body: body.value,
    audit: boundedQaAudit(QA_AUDIT_ACTIONS.edited, {
      organizationId: question.organizationId,
      chapterId: question.chapterId,
      questionId: question.id,
      replyId,
      kind: reply.kind,
    }),
  });
}

export function planDeleteQaReply(actor, question, replyId) {
  const gate = requireActiveQaMember(actor);
  if (!gate.ok) return gate;
  if (!question || question.deletedAt || !canSeeQaRecord(actor, question)) {
    return qaFailure("not_found", "Question not found.");
  }
  const reply = (question.replies ?? []).find((item) => item.id === replyId && !item.deletedAt);
  if (!reply) return qaFailure("not_found", "Reply not found.");
  if (!canModerateQa(actor, reply, question)) return qaFailure("forbidden", "You can only delete your own reply.");
  const remaining = (question.replies ?? []).map((item) => (
    item.id === replyId ? { ...item, deletedAt: "pending" } : item
  ));
  const nextAccepted = question.acceptedReplyId === replyId ? null : question.acceptedReplyId;
  return qaOk({
    deleted: true,
    acceptedReplyId: nextAccepted,
    nextStatus: deriveQaQuestionStatus(remaining, nextAccepted),
    audit: boundedQaAudit(QA_AUDIT_ACTIONS.deleted, {
      organizationId: question.organizationId,
      chapterId: question.chapterId,
      questionId: question.id,
      replyId,
      kind: reply.kind,
    }),
  });
}

export function officerQueueVisible(actor, question) {
  return canSeeOfficerQaQueue(actor)
    && canSeeQaRecord(actor, question)
    && question.status === "open";
}
