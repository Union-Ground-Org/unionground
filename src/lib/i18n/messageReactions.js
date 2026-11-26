import { messageReactionsCatalogueSpanish } from "./locales/es/namespaces/messageReactions.js";
// The shared reaction label namespace: native imports only these catalogue keys.
export const messageReactionsCatalogue = {
  en: {
    "inbox.reaction.seen": "Seen",
    "inbox.reaction.agreed": "Agreed",
    "inbox.reaction.care": "Care",
    "inbox.reaction.grievance": "Workplace issue",
    "inbox.reaction.victory": "Victory",
    "inbox.reaction.like": "Like",
    "inbox.reaction.support": "Support",
    "inbox.reaction.celebrate": "Celebrate",
    "inbox.reaction.solidarity": "Solidarity",
    "inbox.reaction.strength": "Strength",
  },
  get es() { return messageReactionsCatalogueSpanish; },
};
