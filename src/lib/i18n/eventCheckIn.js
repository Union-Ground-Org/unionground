import { eventCheckInCatalogueSpanish } from "./locales/es/namespaces/eventCheckIn.js";
// Optional event check-in codes (BUG-UG-EVENT-SAVE-SILENT-WITHOUT-CHECKIN-CODE-20261006).
// Split out of the src/lib/i18n.js barrel like requestInvite.js. A deadline or
// reminder saves with no code, and the database then refuses every check-in
// for it with the checkin_not_offered token, on the door-code, personal-code
// and steward-scan paths alike.
export const eventCheckInCatalogue = {
  en: {
    "rpcError.checkin_not_offered": "This meeting has no check-in.",
    "admin.fieldCodeOptionalHelp": "Optional. Leave it blank for a deadline or reminder. Without a code, nobody can check in.",
    "admin.fieldCodeRemoveHelp": "Clear it to remove the code. Without a code, nobody can check in.",
    "admin.eventNoCheckIn": "No check-in",
    "mevents.noCheckIn": "No check-in",
    // REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030: door code,
    // RSVP switch, staff-only drafts, time zone, past dates, required marks.
    "rpcError.rsvp_closed": "This meeting is not collecting RSVPs.",
    "mevents.rsvpClosed": "Not collecting RSVPs",
    "admin.eventRequiredNote": "Fields marked * are required.",
    "admin.eventTimeZone": "Times are in {zone}.",
    "admin.eventPastWarning": "This date has already passed. Check it before you save: workers will see the meeting as past.",
    "admin.fieldCodeGeneratedHelp": "Workers enter this code at the door to check in. One was made for you: keep it, change it, or clear it for a deadline or reminder. Without a code, nobody can check in.",
    "admin.generateCode": "Make a new code",
    "admin.eventRsvpOpen": "Collect RSVPs",
    "admin.eventRsvpOpenHelp": "Workers can say they are going, and staff see the count on this list.",
    "admin.eventRsvpClosed": "Not collecting RSVPs",
    "admin.eventRsvpUpdated": "Meeting updated.",
    "admin.eventDoorCode": "Door check-in code",
    "admin.showDoorDisplay": "Show door display",
    "admin.doorDisplayLabel": "Door display for {title}",
    "admin.doorDisplayHelp": "Open Meetings in Union Ground and enter this code to check in.",
    "admin.doorDisplayClose": "Close door display",
    "admin.saveDraft": "Save as staff-only draft",
    "admin.eventDraftNeedsTitle": "Give the draft a title first.",
    "admin.eventDraftSaved": "Draft saved. Only staff can see it until you publish it.",
    "admin.eventDraftsTitle": "Staff-only drafts",
    "admin.eventDraftsHelp": "Workers cannot see these. Review one and publish it to share it.",
    "admin.eventDraftBadge": "Draft",
    "admin.eventDraftUnscheduled": "No date yet",
    "admin.publishDraft": "Review and publish",
    "admin.publishEvent": "Publish",
    "admin.deleteDraft": "Delete draft",
    "admin.eventDraftDeleted": "Draft deleted.",
  },
  get es() { return eventCheckInCatalogueSpanish; },
};
