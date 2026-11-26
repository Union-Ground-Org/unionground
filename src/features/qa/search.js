function haystack(question) {
  const replies = Array.isArray(question.replies) ? question.replies : [];
  return [
    question.title,
    question.body,
    ...replies.filter((reply) => !reply.deletedAt).map((reply) => reply.body),
  ].join("\n").toLowerCase();
}

export function questionMatchesQaSearch(question, query) {
  if (!query) return true;
  return haystack(question).includes(query.toLowerCase());
}

export function compareQaQuestions(left, right, sort) {
  if (sort === "votes") {
    return (right.upvoteCount ?? 0) - (left.upvoteCount ?? 0)
      || Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || String(right.id).localeCompare(String(left.id));
  }
  if (sort === "unanswered") {
    const leftOpen = left.status === "open" ? 0 : 1;
    const rightOpen = right.status === "open" ? 0 : 1;
    return leftOpen - rightOpen
      || Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || String(right.id).localeCompare(String(left.id));
  }
  return Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || String(right.id).localeCompare(String(left.id));
}

export function searchQaHistory(questions, query) {
  const visible = (questions ?? []).filter((question) => !question.deletedAt);
  if (!query.query) {
    return visible
      .filter((question) => query.status === "all" || question.status === query.status)
      .sort((left, right) => compareQaQuestions(left, right, query.sort));
  }
  return visible
    .filter((question) => query.status === "all" || question.status === query.status)
    .filter((question) => questionMatchesQaSearch(question, query.query))
    .sort((left, right) => compareQaQuestions(left, right, query.sort));
}
