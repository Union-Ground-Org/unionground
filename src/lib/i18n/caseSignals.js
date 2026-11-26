import { caseSignalsCatalogueSpanish } from "./locales/es/namespaces/caseSignals.js";
// Case queue next actions and the steward attention queue
// (REQ-UG-CASE-QUEUE-SIGNALS-AND-NEXT-ACTION-20261001,
// REQ-UG-STEWARD-ATTENTION-TREND-20261001). Copy restored from the old
// lib/crm/next-action-digest.ts, workflow-queues.ts and lib/attention/*.
import { lookup } from "./runtime.js";

export const caseSignalsCatalogue = {
  en: {
    "caseSignals.loading": "Checking what needs action…",
    "caseSignals.unavailable": "Next actions could not be loaded.",
    "caseSignals.retry": "Try again",
    "caseSignals.openCase": "Open issue",
    "caseSignals.openCaseFor": "Open issue {reference}",
    "caseSignals.caseFallback": "Issue",
    "caseSignals.memberFallback": "Worker",
    "caseSignals.caseNotLoaded": "That issue is outside the loaded issue list. Find it in the issue list.",
    "caseSignals.nextTitle": "What to do next",
    "caseSignals.nextIntro": "Deadlines, owner gaps, stale worker contact, missing evidence and weak issues across every issue you can open, most urgent first.",
    "caseSignals.nextSummary": "{total} next actions · {urgent}",
    "caseSignals.nextSummary.one": "{total} next action · {urgent}",
    "caseSignals.nextSummaryTop": "Top {shown} of {total} next actions · {urgent}",
    "caseSignals.nextSummaryTop.one": "Top 1 of {total} next actions · {urgent}",
    "caseSignals.nextUrgent": "{count} urgent",
    "caseSignals.nextUrgent.one": "1 urgent",
    "caseSignals.nextEmpty": "Nothing needs action right now.",
    "caseSignals.nextScopeOrganization": "This role covers the whole organization, so this list looks for next actions across all campaigns. The Active issues, Upcoming deadlines and Escalation funnel pages show the open campaign, and any issue from another campaign this role was granted.",
    "caseSignals.caseOutsideChapterQueue": "That issue is not in the issue queue loaded for the open campaign. It may belong to another campaign of the organization, or come after the issues loaded here.",
    "caseSignals.severity.critical": "Critical",
    "caseSignals.severity.high": "High",
    "caseSignals.severity.medium": "Medium",
    "caseSignals.severity.low": "Low",
    "caseSignals.due.none": "no deadline",
    "caseSignals.due.overdue": "{count} days overdue",
    "caseSignals.due.overdueOne": "1 day overdue",
    "caseSignals.due.today": "due today",
    "caseSignals.due.inOne": "due in 1 day",
    "caseSignals.due.inDays": "due in {count} days",
    "caseSignals.title.deadline_risk": "Issue {reference} deadline is {due}",
    "caseSignals.title.missing_owner": "Issue {reference} needs an owner",
    "caseSignals.title.stale_contact": "{name} needs a contact update",
    "caseSignals.title.missing_evidence": "Issue {reference} has no evidence and is {due}",
    // BUG-UG-WHAT-TO-DO-NEXT-OVERDUE-ITEMS-SAY-ACT-BEFORE-DEADLINE-20261110
    // and BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110:
    // which deadline a dated item is about and its date, without "is due".
    // The member's My cases card and Home read the same wording.
    "caseSignals.title.deadline_named": "Issue {reference}: {deadline}",
    "caseSignals.title.missing_evidence_named": "Issue {reference} has no evidence: {deadline}",
    "caseSignals.deadline.unnamed": "deadline",
    "caseSignals.deadline.step": "{label} deadline",
    "caseSignals.deadline.stepFallback": "Step",
    "caseSignals.deadline.case": "issue deadline",
    "caseSignals.deadline.phrase": "{name} {when} ({date})",
    "caseSignals.deadline.phraseUndated": "{name} ({date})",
    "caseSignals.deadline.passedOne": "passed 1 day ago",
    "caseSignals.deadline.passed": "passed {count} days ago",
    "caseSignals.deadline.today": "today",
    "caseSignals.deadline.inOne": "in 1 day",
    "caseSignals.deadline.inDays": "in {count} days",
    "caseSignals.title.weak_strength": "Issue {reference} strength is {score}/100",
    "caseSignals.reason.deadline_risk": "Act before the deadline passes.",
    "caseSignals.reason.missing_owner": "Assign an owner before the next follow-up.",
    "caseSignals.activeCases": "{count} active issues",
    "caseSignals.activeCases.one": "1 active issue",
    "caseSignals.reason.stale_contact": "Last contact {days} days ago across {cases}. Log contact or plan the next outreach.",
    "caseSignals.reason.stale_contact_never": "No contact recorded across {cases}. Log contact or plan the next outreach.",
    "caseSignals.reason.missing_evidence": "Attach evidence before the filing deadline.",
    "caseSignals.reason.deadline_risk_passed": "This deadline has passed. Act now, or record an extension or waiver.",
    "caseSignals.reason.missing_evidence_passed": "Attach evidence now; the deadline has passed.",
    // #9901: a deadline item for a case with no evidence yet. The server counts
    // a file once its upload has finished (confirmed_at, set by the confirm
    // step of src/lib/memberApi.js); a row without it is an upload that has
    // not finished and is shown on no screen, so it is not evidence.
    "caseSignals.deadlineNoEvidence": "This issue has no evidence yet.",
    "caseSignals.reason.weak_strength": "Strengthen this issue before advancing a step.",
    "caseSignals.attention.title": "Workers who need attention",
    "caseSignals.attention.unavailable": "The attention queue could not be loaded.",
    "caseSignals.attention.count": "{count} workers need attention",
    "caseSignals.attention.countOne": "1 worker needs attention",
    "caseSignals.attention.noChange": "No change since your last visit.",
    "caseSignals.attention.up": "Up {count} since your last visit.",
    "caseSignals.attention.down": "Down {count} since your last visit.",
    "caseSignals.attention.reason.deadline_risk": "Deadline risk is driving the biggest change.",
    "caseSignals.attention.reason.open_case": "Open issues make up most of the movement.",
    "caseSignals.attention.breakdown": "Attention breakdown",
    "caseSignals.attention.dueSoon": "Due soon: {count}",
    "caseSignals.attention.openOnly": "Open without deadline risk: {count}",
    "caseSignals.attention.badgeUrgent": "Needs attention",
    "caseSignals.attention.badgeOpen": "Follow up",
    "caseSignals.attention.meta": "{count} open issues · {step}",
    "caseSignals.attention.metaOne": "1 open issue · {step}",
    "caseSignals.attention.stepPending": "Step pending",
    "caseSignals.attention.deadlineLine": "Deadline {due} on issue {reference}.",
    "caseSignals.attention.openMany": "{count} open issues still need follow-up.",
    "caseSignals.attention.openOne": "Open issue still needs follow-up.",
    "caseSignals.attention.empty": "Nobody on your issue list needs attention right now.",
    "caseSignals.shortcut.attention": "Review workers needing attention",
    "caseSignals.shortcut.actions": "Review the action queue",
    "caseSignals.shortcut.risk": "Review issue deadline risk",
  },
  get es() { return caseSignalsCatalogueSpanish; },
};

export function caseSignalsT(lang, key, vars) {
  return lookup(caseSignalsCatalogue, lang, key, vars);
}
