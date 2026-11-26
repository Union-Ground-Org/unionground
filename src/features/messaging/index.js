// One import surface for the messaging contract. apps/mobile bridges to this
// module through apps/mobile/src/lib/messagingShared.ts, so both clients read
// the same generated rules and the same predicates.
export {
  MESSAGE_BODY_RETENTION,
  MESSAGE_REACTION_KINDS,
  MESSAGE_REDACTION_REASONS,
} from "./generated/messagingContract.js";
export {
  MESSAGE_REACTIONS,
  MESSAGE_REACTION_CHOICES,
  messageReactionLabel,
  aggregateMessageReactions,
  isMessageReactionKind,
  reactionKindForGlyph,
  toggleAggregatedReaction,
} from "./reactions.js";
export {
  INBOX_TYPES,
  INBOX_TYPES_WITH_COUNTS,
  channelUnreadCount,
  countUnreadInboxItems,
  inboxUnreadCount,
  isAnnouncementUnread,
  isDirectMessageUnread,
  isInboxItemUnread,
  isTaskMessageUnread,
  messageTimestamp,
  readCursor,
  taskUnreadCount,
} from "./unread.js";
export {
  LEGAL_HOLD_REASONS,
  isRedactedMessage,
  projectMessageBody,
  projectMessagePreview,
  redactionReasonOf,
} from "./bodyLifecycle.js";
export { UNREAD_CONFORMANCE_CASES, runUnreadConformance } from "./unreadFixtures.js";
