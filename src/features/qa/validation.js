import {
  QA_MAX_BODY_LENGTH,
  QA_MAX_SEARCH_LENGTH,
  QA_MAX_TITLE_LENGTH,
  QA_MIN_BODY_LENGTH,
  QA_MIN_TITLE_LENGTH,
  isQaQuestionStatus,
  isQaSort,
  isQaVoteTarget,
} from "./contract.js";
import { qaFailure, qaOk } from "./authorization.js";

function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// Default-ignorable and bidi-control code points occupy no visible width, so a
// title can satisfy the visible-length floor while rendering as a handful of
// characters — or as nothing at all — and a bidi override can reverse how the
// rest of the line reads in the question list. Titles carry none of them.
// The matching database constraint for callers that skip this seam needs a
// migration and is left to a DB lane.
// SEC-UG-QA-INVISIBLE-TITLE-VALIDATION-20260921
const INVISIBLE_TEXT =
  /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/u;

function rejectInvisibleChars(value, field) {
  if (INVISIBLE_TEXT.test(value)) {
    return qaFailure("invalid_text", `${field} cannot include invisible formatting characters.`);
  }
  return null;
}

function rejectControlChars(value, field) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code <= 31 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return qaFailure("invalid_text", `${field} cannot include control characters.`);
    }
  }
  return null;
}

export function normalizeQaTitle(title) {
  const raw = String(title ?? "");
  const hidden = rejectInvisibleChars(raw, "Title");
  if (hidden) return hidden;
  const value = collapseWhitespace(raw);
  const invalid = rejectControlChars(value, "Title");
  if (invalid) return invalid;
  if (value.length < QA_MIN_TITLE_LENGTH) {
    return qaFailure("title_too_short", `Title must be at least ${QA_MIN_TITLE_LENGTH} characters.`);
  }
  if (value.length > QA_MAX_TITLE_LENGTH) {
    return qaFailure("title_too_long", `Title must be ${QA_MAX_TITLE_LENGTH} characters or fewer.`);
  }
  return qaOk(value);
}

export function normalizeQaBody(body, label = "Body") {
  const value = String(body ?? "").replace(/\r\n/g, "\n").trim();
  const invalid = rejectControlChars(value, label);
  if (invalid) return invalid;
  if (value.length < QA_MIN_BODY_LENGTH) {
    return qaFailure("body_too_short", `${label} must be at least ${QA_MIN_BODY_LENGTH} characters.`);
  }
  if (value.length > QA_MAX_BODY_LENGTH) {
    return qaFailure("body_too_long", `${label} must be ${QA_MAX_BODY_LENGTH.toLocaleString()} characters or fewer.`);
  }
  return qaOk(value);
}

export function normalizeQaSearchQuery(query) {
  const value = collapseWhitespace(query);
  const invalid = rejectControlChars(value, "Search");
  if (invalid) return invalid;
  if (value.length > QA_MAX_SEARCH_LENGTH) {
    return qaFailure("search_too_long", `Search must be ${QA_MAX_SEARCH_LENGTH} characters or fewer.`);
  }
  return qaOk(value);
}

export function normalizeQaListQuery(input = {}) {
  const search = normalizeQaSearchQuery(input.query ?? "");
  if (!search.ok) return search;
  const status = input.status == null || input.status === "all" ? "all" : input.status;
  if (status !== "all" && !isQaQuestionStatus(status)) {
    return qaFailure("invalid_status", "Unknown question status.");
  }
  const sort = input.sort ?? "newest";
  if (!isQaSort(sort)) return qaFailure("invalid_sort", "Unknown sort.");
  return qaOk({ query: search.value, status, sort });
}

export function normalizeQaVoteTarget(targetKind) {
  if (!isQaVoteTarget(targetKind)) return qaFailure("invalid_vote_target", "Vote target is invalid.");
  return qaOk(targetKind);
}

export function redactQaDisplayName(name) {
  const parts = collapseWhitespace(name).split(" ").filter(Boolean);
  if (parts.length === 0) return "Worker";
  const first = parts[0];
  if (parts.length === 1) return first;
  return `${first} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}
