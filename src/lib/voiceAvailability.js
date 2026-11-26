// Open describes the campaign window, not whether this member has responded.
// Count only the authorized plan items supplied to both Home and Voice, plus
// the organization surveys (Engagement studio) open to this viewer: those live
// in get_member_engagement_snapshot, not in member_surveys, so leaving them out
// said "0 open surveys" on Home while Voice listed one to answer
// (BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111).
// Voting lists only the plan's ballots and pulses,
// so the organization surveys are named as their own part of the line, never
// added into "open surveys": Home said "8 open surveys" and Voting "6" a click
// later (BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122, B-4).
export function voiceAvailabilityLabel(planItems, t, organizationSurveys = [], now = Date.now()) {
  const votes = planItems.filter((item) => item.kind === "ballot" && !item.closed).length;
  const surveys = planItems.filter((item) => item.kind === "pulse" && !item.closed).length;
  const voiceSurveys = openOrganizationSurveys(organizationSurveys, now).length;
  const line = `${t(votes === 1 ? "voting.openVotesOne" : "voting.openVotesMany", { count: votes })} · ${t(surveys === 1 ? "voting.openSurveysOne" : "voting.openSurveysMany", { count: surveys })}`;
  return voiceSurveys > 0
    ? `${line} · ${t(voiceSurveys === 1 ? "voting.voiceSurveysOne" : "voting.voiceSurveysMany", { count: voiceSurveys })}`
    : line;
}

// The server checks a survey's window only when it is read; a cached list can
// outlive a close. Every count applies the window again at render time, so a
// survey whose closing time has passed is not counted as open.
export function openOrganizationSurveys(organizationSurveys, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  return (Array.isArray(organizationSurveys) ? organizationSurveys : []).filter((item) => {
    const closesAt = Date.parse(item?.closesAt);
    return !Number.isFinite(closesAt) || closesAt > nowMs;
  });
}

// The organization surveys in a get_member_engagement_snapshot answer. The
// server already narrows that list to surveys open to the viewer (status open,
// inside its window, eligible), so every row here is open; `answered` is the
// viewer's own submitted session. Anything unreadable is an empty list.
export function organizationSurveysFromSnapshot(snapshot) {
  const rows = Array.isArray(snapshot?.surveys) ? snapshot.surveys : [];
  return rows
    .filter((row) => row && typeof row.id === "string" && row.id && typeof row.title === "string" && row.title)
    .map((row) => ({
      id: row.id,
      title: row.title,
      closesAt: typeof row.closesAt === "string" && row.closesAt ? row.closesAt : null,
      answered: row.session?.status === "submitted",
    }));
}
