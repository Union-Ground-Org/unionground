// CR-018 member Q&A contract. Organization is always derived from the
// selected chapter session. Callers never supply organization_id.
// Stable RPC contract implemented by the landed W1 persistence migration and
// the additive CR-018 delivery repair migration.

import { ORGANIZATION_ROLES } from "../tenancy/organizationScope.js";

export const QA_MAX_TITLE_LENGTH = 200;
export const QA_MAX_BODY_LENGTH = 10_000;
export const QA_MIN_TITLE_LENGTH = 8;
export const QA_MIN_BODY_LENGTH = 12;
export const QA_MAX_SEARCH_LENGTH = 120;
export const QA_LIST_LIMIT = 50;

export const QA_QUESTION_STATUSES = Object.freeze(["open", "replied", "accepted"]);
export const QA_REPLY_KINDS = Object.freeze(["official", "follow_up"]);
export const QA_VOTE_TARGETS = Object.freeze(["question", "reply"]);
export const QA_SORTS = Object.freeze(["newest", "votes", "unanswered"]);
export const QA_OFFICER_ROLES = ORGANIZATION_ROLES;

export const QA_RPC = Object.freeze({
  list: "list_member_qa_questions",
  get: "get_member_qa_question",
  search: "search_member_qa_history",
  ask: "ask_member_qa_question",
  officialReply: "reply_member_qa_official",
  followUp: "reply_member_qa_follow_up",
  toggleVote: "toggle_member_qa_vote",
  accept: "accept_member_qa_answer",
  editQuestion: "edit_member_qa_question",
  deleteQuestion: "delete_member_qa_question",
  editReply: "edit_member_qa_reply",
  deleteReply: "delete_member_qa_reply",
  officerQueue: "list_member_qa_officer_queue",
});

export const QA_AUDIT_ACTIONS = Object.freeze({
  asked: "qa_question_asked",
  officialReplied: "qa_official_replied",
  followUpReplied: "qa_follow_up_replied",
  accepted: "qa_answer_accepted",
  unaccepted: "qa_answer_unaccepted",
  voted: "qa_vote_toggled",
  edited: "qa_edited",
  deleted: "qa_deleted",
});

export const QA_AUDIT_METADATA_KEYS = Object.freeze([
  "organizationId",
  "chapterId",
  "questionId",
  "replyId",
  "targetKind",
  "voted",
  "status",
  "kind",
]);

export const QA_DONOR_BASELINE = "donor-baseline-20260721";

export function isQaQuestionStatus(value) {
  return QA_QUESTION_STATUSES.includes(value);
}

export function isQaReplyKind(value) {
  return QA_REPLY_KINDS.includes(value);
}

export function isQaVoteTarget(value) {
  return QA_VOTE_TARGETS.includes(value);
}

export function isQaSort(value) {
  return QA_SORTS.includes(value);
}

export function isQaOfficerRole(role) {
  return QA_OFFICER_ROLES.includes(role);
}
