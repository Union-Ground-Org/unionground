import { homeTakeoverCatalogueSpanish } from "./locales/es/namespaces/homeTakeover.js";
// Member Home takeover for the newest unread steward message and broadcast
// (REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001), split out of the
// src/lib/i18n.js barrel like getApp.js. This file is the ONLY declaration of
// every `homeTakeover.` key and of this record's `settings.def.` keys; the
// barrel spreads it back into `catalogue`, so `t()` is unchanged.
export const homeTakeoverCatalogue = {
  en: {
    "homeTakeover.region": "Unread updates",
    "homeTakeover.messageEyebrow": "Message from a committee member",
    "homeTakeover.messageFrom": "{name} wrote to you",
    "homeTakeover.messageFromSteward": "A committee member wrote to you",
    "homeTakeover.broadcastEyebrow": "Announcement",
    "homeTakeover.broadcastEyebrowChapter": "Campaign announcement",
    "homeTakeover.openConversation": "Open conversation",
    "homeTakeover.openBroadcast": "Read announcement",
    "homeTakeover.markRead": "Mark read",
    "homeTakeover.marking": "Marking read…",
    "homeTakeover.markFailed": "That couldn't be marked read. Try again.",
    "settings.def.features.home.unread_message_takeover.label": "Unread committee message takes over Home",
    "settings.def.features.home.unread_message_takeover.description": "Show the newest unread committee message and the newest unread broadcast at the top of worker Home until the worker marks them read.",
  },
  get es() { return homeTakeoverCatalogueSpanish; },
};
