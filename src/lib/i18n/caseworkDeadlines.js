import { caseworkDeadlinesCatalogueSpanish } from "./locales/es/namespaces/caseworkDeadlines.js";
// Case deadline reminders and recorded outcomes
// (BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001), split out of
// the src/lib/i18n.js barrel like ./caseworkUlp.js. This file is the ONLY
// declaration of every `caseworkDeadlines.` key and of the deadline setting
// labels; the barrel spreads it back into `catalogue`.
export const caseworkDeadlinesCatalogue = {
  en: {
    "caseworkDeadlines.reminderScheduled": "Reminder {date}",
    "caseworkDeadlines.reminderSent": "Reminder sent {date}",
    "caseworkDeadlines.reminderNotSent.expired": "Reminder {date} not sent: it was out of date when it came due",
    "caseworkDeadlines.reminderNotSent.suppressed": "Reminder {date} not sent: deadline reminders were switched off",
    "caseworkDeadlines.reminderNotSent.no_recipient": "Reminder {date} not sent: nobody listed could open this case",
    "caseworkDeadlines.markMet": "Mark met",
    "caseworkDeadlines.editStepOrDeadline": "Change step or add a deadline",
    "caseworkDeadlines.private.title": "My private reminders",
    "caseworkDeadlines.private.note": "Only you see these. Write a date before a case exists, like a filing date, and attach it to the case once one is opened.",
    "caseworkDeadlines.private.noteNoCases": "Only you see these. Write a date before an issue exists, like a filing date. Once an issue is assigned to you, each reminder here gets a control to attach it to that issue.",
    "caseworkDeadlines.private.titleLabel": "What to remember",
    "caseworkDeadlines.private.dateLabel": "Date",
    "caseworkDeadlines.private.dateUnavailable": "Date unavailable",
    "caseworkDeadlines.private.add": "Save reminder",
    "caseworkDeadlines.private.empty": "No private reminders yet.",
    "caseworkDeadlines.private.unavailable": "Your private reminders could not be loaded.",
    "caseworkDeadlines.private.retry": "Try again",
    "caseworkDeadlines.private.caseLabel": "Attach to case",
    "caseworkDeadlines.private.attach": "Attach",
    "caseworkDeadlines.private.attached": "Attached to {reference}",
    "caseworkDeadlines.private.delete": "Delete",
    "caseworkDeadlines.private.saved": "Private reminders updated.",
    "caseworkDeadlines.private.failed": "That reminder could not be saved.",
    "caseworkDeadlines.waive": "Waive",
    "caseworkDeadlines.reopen": "Reopen",
    "settings.def.features.casework.deadline_reminders.label": "Deadline reminders",
    "settings.def.features.casework.deadline_reminders.description": "Send the reminder staff set on an issue deadline to the deadline's creator and the assigned committee member and campaign lead.",
    "settings.def.features.casework.mark_missed_deadlines.label": "Mark passed deadlines missed",
    "settings.def.features.casework.mark_missed_deadlines.description": "Move an active issue deadline to Missed once its due time has passed and it was not recorded met or waived.",
    "settings.def.limits.casework.deadline_missed_grace_hours.label": "Missed deadline grace (hours)",
    "settings.def.limits.casework.deadline_missed_grace_hours.description": "Hours after a deadline's due time before an unmet deadline is marked missed.",
  },
  get es() { return caseworkDeadlinesCatalogueSpanish; },
};
