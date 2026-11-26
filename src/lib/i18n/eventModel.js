import { eventModelCatalogueSpanish } from "./locales/es/namespaces/eventModel.js";
export const eventModelCatalogue = {
  en: {
    "events.kind": 'Meeting type',
    "events.meeting": 'Meeting with a time',
    "events.date": 'Date',
    "events.ends": 'Ends (optional)',
    "events.endInvalid": 'End time must be after the start.',
    "events.repeat": 'Monthly dates (including the first)',
    "events.repeatHelp": 'A single date means a one-time meeting. Each date has separate RSVPs. Check-in codes are optional. Missing month days use that month’s last day. When a code is supplied, later dates get their own codes in Manage meeting.',
    "events.timezone": 'Timezone',
    "events.oneDate": 'Changes apply to this date only.',
  },
  get es() { return eventModelCatalogueSpanish; },
};
