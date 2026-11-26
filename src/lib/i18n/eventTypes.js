import { eventTypeCatalogueSpanish } from "./locales/es/namespaces/eventTypes.js";
import { lookup } from './runtime.js';

// Shared by native and web without importing the authoring-form catalogue.
export const eventTypeCatalogue = {
  en: {
    "events.deadline": 'Deadline',
    "events.date_only": 'Date only · time not set',
  },
  get es() { return eventTypeCatalogueSpanish; },
};
export const eventTypeText = (lang, kind) => lookup(eventTypeCatalogue, lang, `events.${kind}`);
