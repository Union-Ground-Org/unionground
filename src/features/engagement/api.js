import { MemberApiError } from "../../lib/memberApi.js";

function resultOrThrow(result, label) {
  if (result?.error) throw new MemberApiError(label, result.error);
  return result?.data;
}

async function rpc(client, name, args = {}, label = name) {
  return resultOrThrow(await client.rpc(name, args), label);
}

export const engagementApi = {
  loadMember: (client) => rpc(client, "get_member_engagement_snapshot", {}, "Member engagement"),
  loadStaff: (client) => rpc(client, "get_staff_engagement_snapshot", {}, "Engagement operations"),
  saveSurveySession: (client, surveyId, answers) => rpc(client, "save_organization_survey_session", {
    p_survey_id: surveyId,
    p_answers: answers,
  }, "Save survey progress"),
  submitSurveySession: (client, surveyId, answers) => rpc(client, "submit_organization_survey_session", {
    p_survey_id: surveyId,
    p_answers: answers,
  }, "Submit survey"),
  saveSurveyDraft: (client, draft) => rpc(client, "save_organization_survey_draft", {
    p_draft: draft,
  }, "Save survey draft"),
  // BUG-UG-SURVEY-PUBLISH-NON-ATOMIC-20260920: one RPC commits the status
  // transition and the operating configuration together; the old
  // publish-then-configure pair could strand an unconfigured survey at
  // status 'open' when the second call failed.
  publishSurvey: (client, draft, operations) => rpc(client, "publish_organization_survey_with_operations", {
    p_draft: draft,
    p_operations: operations,
  }, "Publish survey"),
  closeSurvey: (client, surveyId) => rpc(client, "close_organization_survey", {
    p_survey_id: surveyId,
  }, "Close survey"),
  reopenSurvey: (client, surveyId) => rpc(client, "reopen_organization_survey", {
    p_survey_id: surveyId,
  }, "Reopen survey"),
  configureSurvey: (client, surveyId, operations) => rpc(client, "configure_organization_survey_operations", {
    p_survey_id: surveyId,
    p_operations: operations,
  }, "Configure survey operations"),
  prepareDistribution: (client, surveyId, userIds = null) => rpc(client, "prepare_organization_survey_distribution", {
    p_survey_id: surveyId,
    p_recipient_user_ids: userIds,
  }, "Prepare survey distribution"),
  queueReminders: (client, surveyId) => rpc(client, "queue_organization_survey_reminders", {
    p_survey_id: surveyId,
  }, "Queue survey reminders"),
  updateSurveyTask: (client, taskId, fields) => rpc(client, "update_organization_survey_task", {
    p_task_id: taskId,
    p_status: fields.status,
    p_assigned_to: fields.assignedTo || null,
    p_due_at: fields.dueAt || null,
  }, "Update survey task"),
  updateSurveyReview: (client, reviewId, fields) => rpc(client, "update_organization_survey_review", {
    p_review_id: reviewId,
    p_state: fields.state,
    p_assigned_to: fields.assignedTo || null,
    p_disposition: fields.disposition || null,
    p_follow_up_due_at: fields.followUpDueAt || null,
  }, "Update survey review"),
  loadSurveyReview: (client, sessionId) => rpc(client, "get_organization_survey_review_detail", {
    p_session_id: sessionId,
  }, "Survey response"),
  loadSurveyDraft: (client, surveyId) => rpc(client, "get_organization_survey_draft", {
    p_survey_id: surveyId,
  }, "Survey draft"),
  loadSurveyReport: (client, surveyId) => rpc(client, "get_organization_survey_report", {
    p_survey_id: surveyId,
  }, "Survey report"),
  // REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030: the meetings a
  // live poll may be tied to, and the links on the organization's polls.
  loadLivePollMeetings: (client) => rpc(client, "get_live_poll_meetings", {}, "Poll meetings"),
  setLivePollMeeting: (client, pollId, eventId) => rpc(client, "set_organization_live_poll_event", {
    p_poll_id: pollId,
    p_event_id: eventId || null,
  }, "Poll meeting"),
  exportSurvey: (client, surveyId) => rpc(client, "export_organization_survey_results", {
    p_survey_id: surveyId,
  }, "Export survey"),
  // BUG-UG-WEB-ENGAGEMENT-SURVEYS-UNPAGED-20261002: the survey pages
  // after the snapshot's first one (status filter, keyset cursor, 1..100 rows).
  loadStaffSurveys: (client, { status = null, after = null, limit = 20 } = {}) => rpc(client, "get_staff_engagement_surveys", {
    p_status: status, p_after: after, p_limit: limit,
  }, "Engagement surveys"),
  // list_weekly_question_editorial has no client wrapper: the weekly tab reads
  // get_weekly_question_selection_workspace, and the editorial RPC stays for
  // scripts/verify-voice-survey-completion.mjs.
  loadWeeklySelection: (client) => rpc(client, "get_weekly_question_selection_workspace", {}, "Weekly question operations"),
  loadWeeklySelectionPage: (client, view, cursor = null) => rpc(client, "list_weekly_question_selection_page", {
    p_view: view,
    p_before_created_at: cursor?.createdAt || null,
    p_before_id: cursor?.id || null,
    p_limit: 26,
  }, "Weekly question page"),
  saveWeeklySelectionPolicy: (client, policy) => rpc(client, "save_weekly_question_selection_policy", {
    p_enabled: Boolean(policy.enabled),
    p_cadence_days: Number(policy.cadenceDays),
    p_minimum_pool_size: Number(policy.minimumPoolSize),
    p_selection_count: Number(policy.selectionCount),
    p_priority_rule: policy.priorityRule || "weighted_random",
    p_next_run_at: policy.nextRunAt || null,
  }, "Save weekly selection policy"),
  runWeeklySelection: (client) => rpc(client, "run_weekly_question_selection", {
    p_idempotency_key: globalThis.crypto.randomUUID(),
  }, "Run weekly selection"),
  reviewWeeklyQuestion: (client, questionId, state, note = null) => rpc(client, "review_weekly_poll_question", {
    p_question_id: questionId,
    p_editorial_state: state,
    p_editor_note: note,
  }, "Review weekly question"),
  publishWeeklyQuestion: (client, questionId, privacyMinResponses = 5) => rpc(client, "publish_weekly_poll_question", {
    p_question_id: questionId,
    p_privacy_min_responses: Number(privacyMinResponses),
  }, "Publish weekly question"),
  savePulsePrompt: (client, prompt) => rpc(client, "save_organization_pulse_prompt", {
    p_prompt: prompt,
  }, "Save contextual prompt"),
  evaluatePulse: (client, eventKey, contextKey) => rpc(client, "evaluate_contextual_pulse", {
    p_event_key: eventKey,
    p_context_key: contextKey,
  }, "Evaluate contextual prompt"),
  respondPulse: (client, eventId, response = null, dismiss = false) => rpc(client, "respond_contextual_pulse", {
    p_event_id: eventId,
    p_response: response,
    p_dismiss: dismiss,
  }, "Respond to contextual prompt"),
  saveLivePoll: (client, poll) => rpc(client, "save_organization_live_poll", {
    p_poll: poll,
  }, "Save live poll"),
  transitionLivePoll: (client, pollId, action) => rpc(client, "transition_organization_live_poll", {
    p_poll_id: pollId,
    p_action: action,
  }, "Update live poll"),
  setLivePollRoster: (client, pollId, userIds) => rpc(client, "set_organization_live_poll_roster", {
    p_poll_id: pollId,
    p_user_ids: userIds,
  }, "Set live-poll roster"),
  rsvpLivePoll: (client, pollId, rsvp) => rpc(client, "rsvp_organization_live_poll", {
    p_poll_id: pollId,
    p_rsvp: rsvp,
  }, "Save RSVP"),
  checkInLivePoll: (client, pollId, userId = null) => rpc(client, "check_in_organization_live_poll", {
    p_poll_id: pollId,
    p_user_id: userId,
  }, "Check in"),
  castLivePollVote: (client, pollId, optionId) => rpc(client, "cast_organization_live_poll_vote", {
    p_poll_id: pollId,
    p_option_id: optionId,
  }, "Cast live-poll vote"),
  heartbeat: (client, status = "online") => rpc(client, "heartbeat_member_presence", {
    p_status: status,
  }, "Update presence"),
  setChannelControls: (client, spaceId, controls) => rpc(client, "set_chapter_space_controls", {
    p_space_id: spaceId,
    p_posting_mode: controls.postingMode,
    p_slow_mode_seconds: Number(controls.slowModeSeconds) || 0,
    p_approvals_required: Boolean(controls.approvalsRequired),
  }, "Update channel controls"),
  saveWorkspace: (client, moduleOrder, hiddenModules) => rpc(client, "save_compass_workspace_preferences", {
    p_module_order: moduleOrder,
    p_hidden_modules: hiddenModules,
  }, "Save Guide workspace"),
  proposeAction: (client, sourceKind, sourceId, title) => rpc(client, "propose_compass_workspace_action", {
    p_source_kind: sourceKind,
    p_source_id: sourceId,
    p_title: title,
  }, "Propose Guide action"),
  decideAction: (client, actionId, decision) => rpc(client, "decide_compass_workspace_action", {
    p_action_id: actionId,
    p_decision: decision,
  }, "Decide Guide action"),
  // Inventory A2 (REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001): the
  // per-survey anonymity floor after publish (3..50, enforced by the RPC).
  // Last in the object so line-pinned readers above do not move.
  setSurveyPrivacyFloor: (client, surveyId, privacyMinResponses) => rpc(client, "set_organization_survey_privacy_floor", {
    p_survey_id: surveyId,
    p_privacy_min_responses: Number(privacyMinResponses),
  }, "Set survey privacy floor"),
  // REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001: the server decides the
  // "give to view" gate (switch, admin exemption, survey answerability).
  loadQuarterlyGate: (client) => rpc(client, "get_quarterly_survey_gate", {}, "Quarterly survey gate"),
  // Member-safe organization configuration; its `switches` map carries the
  // member-visible feature switches (REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001).
  loadOrganizationSwitches: (client) => rpc(client, "get_member_organization_configuration", {}, "Organization configuration"),
  // REQ-UG-SURVEY-AND-FILTERED-EXPORTS-XLSX-20261001: a dated report and
  // export; the privacy floor applies inside the window on the server.
  loadSurveyReportWindow: (client, surveyId, from = null, to = null) => rpc(client, "get_organization_survey_report_window", {
    p_survey_id: surveyId, p_from: from, p_to: to,
  }, "Survey report"),
  exportSurveyWindow: (client, surveyId, from, to, format) => rpc(client, "export_organization_survey_window", {
    p_survey_id: surveyId, p_from: from, p_to: to, p_format: format,
  }, "Export survey"),
  // REQ-UG-SURVEY-ESCALATION-AND-FOLLOWUP-TASKS-20261001.
  loadSurveyAttention: (client) => rpc(client, "get_survey_operations_attention", {}, "Survey attention"),
  // REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001: a reading-screen
  // quick check. Last in the object so line-pinned readers above do not move.
  evaluatePulseInContext: (client, contextKey, sessionKey, dwellSeconds, scrollPercent) => rpc(client, "evaluate_contextual_pulse_in_context", {
    p_context_key: contextKey,
    p_session_key: sessionKey,
    p_dwell_seconds: Math.max(0, Math.min(86400, Math.round(Number(dwellSeconds) || 0))),
    p_scroll_percent: Math.max(0, Math.min(100, Math.round(Number(scrollPercent) || 0))),
  }, "Evaluate quick check"),
  // REQ-UG-BARGAINING-SURVEY-20261012: totals for a survey started
  // from the bargaining template; the server withholds every group under 25.
  // Last in the object so line-pinned readers above do not move.
  loadBargainingResults: (client, surveyId) => rpc(client, "get_bargaining_survey_results", {
    p_survey_id: surveyId,
  }, "Bargaining survey results"),
};

// /api/guide labels every refusal with a machine-readable `code` beside an
// English `error` sentence. Only the sentence used to survive the throw, so a
// caller had nothing to translate with and painted the server's own English
// into the page. The message is still built exactly as before — logs and the
// existing "session expired" assertions read it — but the class rides along:
// `code` where the endpoint sets one, and the HTTP `status` for the branches
// that predate the codes (400 invalid thread, 403 staff role, 404 unavailable).
async function authorizedJson(session, body) {
  if (!session?.access_token) throw Object.assign(new Error("Your session expired. Sign in again."), { code: "session_expired", status: 401 });
  const response = await fetch("/api/guide", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || "The Guide is unavailable right now."), {
      code: payload.code ?? null,
      status: response.status,
    });
  }
  return payload;
}

export function requestPollDraft(session, topic) {
  return authorizedJson(session, { mode: "poll_draft", topic });
}

export function requestMessageBriefing(session, sourceKind, targetId) {
  return authorizedJson(session, { mode: "message_briefing", sourceKind, targetId });
}

export async function loadEngagementDeliveryStatus(session) {
  if (!session?.access_token) throw new Error("Your session expired. Sign in again.");
  const response = await fetch("/api/engagement-delivery?status=1", {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Delivery status is unavailable.");
  return payload;
}

export function subscribeToLivePolls(client, onChange) {
  const channel = client.channel(`engagement-live-polls-${globalThis.crypto?.randomUUID?.() || Date.now()}`)
    .on("postgres_changes", {
      event: "UPDATE",
      schema: "public",
      table: "organization_live_polls",
    }, (payload) => onChange(payload.new))
    .subscribe();
  return () => client.removeChannel(channel);
}

export function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}
