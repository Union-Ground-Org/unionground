import { connectionProfilePublishCatalogueSpanish } from "./locales/es/namespaces/connectionProfilePublish.js";

// The native suggestions screen shares the connection catalogue without this editor.
export const connectionProfilePublishCatalogue = {
  en: {
    "connectionProfilePublish.country": "Enter a two-letter country code.",
    "connectionProfilePublish.region": "Enter a two- or three-letter region code.",
    "connectionProfilePublish.metroRegion": "Enter a region code for the city or metro area.",
    "connectionProfilePublish.consent": "Check the authorization box to publish this profile.",
  },
  get es() { return connectionProfilePublishCatalogueSpanish; },
};
