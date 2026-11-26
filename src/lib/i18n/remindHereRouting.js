import { remindHereRoutingCatalogueSpanish } from "./locales/es/namespaces/remindHereRouting.js";
// /remind here (REQ-UG-REMIND-HERE-20261001) and steward email routing
// (REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001) on responsive web, plus the
// admin page copy for their three messaging switches. Split out of the
// src/lib/i18n.js barrel like requestInvite.js; this file is the ONLY
// declaration of every `remindHere.`, `caseEmails.` and `steward.emailRoute`
// key and of these three `settings.def.*` keys.
//
// Copy rules: a reminder notice never repeats the note or names the channel;
// a held email says why in plain words and never quotes the email.
export const remindHereRoutingCatalogue = {
  en: {
    "settings.def.features.messaging.remind_here.label": "Channel staff reminders (/remind here)",
    "settings.def.features.messaging.remind_here.description": "Campaign staff can type /remind here in a channel to remind everyone on the channel's staff at a set time.",
    "settings.def.features.messaging.steward_email_auto_route_cases.label": "Attach committee email to issues",
    "settings.def.features.messaging.steward_email_auto_route_cases.description": "A signed committee email naming one issue and saying timeline, case note or evidence is attached to that issue for staff. Anything unclear stays in review.",
    "settings.def.features.messaging.steward_email_auto_route_knowledge.label": "Committee email to knowledge drafts",
    "settings.def.features.messaging.steward_email_auto_route_knowledge.description": "A signed committee email tagged #knowledge becomes an unpublished knowledge draft for staff review. It is never published automatically.",

    "remindHere.hint": "Staff tip: type /remind here tomorrow 9am … to remind this channel's staff.",
    "remindHere.usage": "Remind this channel's staff: /remind here in 20m <what>, /remind here tomorrow 9am <what>, or /remind here on 2026-07-01 14:30 <what>.",
    "remindHere.set": "This channel's staff will be reminded {when}: {note}",
    "remindHere.error.missing_target": "Start with “/remind here”.",
    "remindHere.error.missing_time": "Add a time: “in 20m”, “tomorrow 9am” or “on 2026-07-01”.",
    "remindHere.error.missing_note": "Add what to remind the channel staff about.",
    "remindHere.error.note_too_long": "Keep the reminder under 500 characters.",
    "remindHere.error.past": "That time has passed. Pick a future time.",
    "remindHere.error.too_far": "Reminders can be set up to a year ahead.",
    "remindHere.error.invalid_time": "“{detail}” is not a valid time.",
    "remindHere.error.invalid_date": "“{detail}” is not a valid date.",
    "remindHere.error.me_not_here": "In a channel, “/remind here” reminds the channel staff. To remind only yourself, use “Remind me…” on a message.",
    "remindHere.refusal.off": "Channel staff reminders are turned off for your organization.",
    "remindHere.refusal.staff": "Only campaign staff can remind this channel's staff.",
    "remindHere.refusal.unavailable": "This channel is not available for reminders.",
    "remindHere.refusal.limit": "You have reached the reminder limit for this channel.",
    "remindHere.refusal.invalid": "Pick a time within the next year and a note of up to 500 characters.",
    "remindHere.refusal.failed": "The reminder could not be set. Try again.",
    "remindHere.inboxTitle": "Reminder from {name} · #{channel}",
    "remindHere.inboxMeta": "Channel staff reminder",
    "remindHere.inboxMine": "Your reminder · #{channel}",

    "steward.emailRouteAuto": "Routed automatically",
    "steward.emailRouteCase": "Attached to issue {reference}",
    "steward.emailRouteCaseHidden": "Attached to an issue you cannot open",
    "steward.emailRouteKnowledge": "Knowledge draft created (unpublished)",
    "steward.emailRouteHold.sender_unknown": "Not routed: no confirmed account uses this sender address.",
    "steward.emailRouteHold.sender_not_steward": "Not routed: the sender is not a committee member or admin of this campaign.",
    "steward.emailRouteHold.case_not_found": "Not routed: the issue number matches no issue in this campaign.",
    "steward.emailRouteHold.case_ambiguous": "Not routed: the email matches more than one issue.",
    "steward.emailRouteHold.case_access": "Not routed: the sender cannot open that issue.",
    "steward.emailRouteHold.route_error": "Not routed: automatic routing failed. Review it here.",

    "caseEmails.title": "Committee email on this issue",
    "caseEmails.help": "Staff only. Attached automatically from committee email intake; the worker does not see it.",
    "caseEmails.loading": "Loading attached email…",
    "caseEmails.unavailable": "Attached email is unavailable.",
    "caseEmails.retry": "Try again",
    "caseEmails.from": "From {from}",
    "caseEmails.noSubject": "No subject",
    "caseHistory.action.entity_linked": "Record linked",
  },
  get es() { return remindHereRoutingCatalogueSpanish; },
};
