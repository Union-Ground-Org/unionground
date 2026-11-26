import { webNameFrom } from "./webName.js";

const ID = { min: 3, max: 64 };
const CODE = { min: 3, max: 12 };
const TITLE = { min: 3, max: 120 };

export const EVENT_FORM_LIMITS = {
  id: {
    ...ID,
    pattern: `[a-z0-9][a-z0-9\\-]{${ID.min - 1},${ID.max - 1}}`,
    rule: "admin.eventIdRule",
  },
  title: { ...TITLE, rule: "admin.eventTitleRule" },
  checkInCode: {
    ...CODE,
    pattern: `SG-[0-9A-Za-z]{${CODE.min},${CODE.max}}`,
    rule: "admin.eventCodeRule",
  },
  occurrences: { min: 1, max: 12, rule: "admin.eventRepeatRule" },
};

export const MESSAGE_EVENT_CODE_LIMIT = {
  ...CODE,
  pattern: `SG-[0-9A-Z]{${CODE.min},${CODE.max}}`,
  maxLength: "SG-".length + CODE.max,
  rule: "admin.messageEventCodeRule",
};

// UX-UG-NEW-EVENT-ASKS-FOR-A-LOWERCASE-SLUG-FIRST-20261125 (#9985):
// the web name a new event gets from its title, in the shape EVENT_FORM_LIMITS.id
// accepts: lowercase a-z, 0-9 and single hyphens, cut to the maximum length.
// The server still refuses a name that is taken; nothing here replaces an event.
export function eventIdFromTitle(title) {
  return webNameFrom(title, EVENT_FORM_LIMITS.id.max);
}

