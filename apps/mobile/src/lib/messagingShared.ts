// Bridge to the shared messaging contract in src/features/messaging.
//
// The Expo app must not restate a rule the database owns. Reaction kinds,
// unread predicates and redaction projection all arrive from the same module
// responsive web imports, so the two clients cannot disagree about which
// reactions exist, what counts as unread, or how a removed body reads.
export {
  MESSAGE_BODY_RETENTION,
  MESSAGE_REACTION_KINDS,
  MESSAGE_REDACTION_REASONS,
} from '../../../../src/features/messaging/generated/messagingContract.js';
export {
  MESSAGE_REACTIONS,
  MESSAGE_REACTION_CHOICES,
  messageReactionLabel,
  aggregateMessageReactions,
  isMessageReactionKind,
  reactionKindForGlyph,
  toggleAggregatedReaction,
} from '../../../../src/features/messaging/reactions.js';
import { MESSAGE_REACTIONS } from '../../../../src/features/messaging/reactions.js';

// TypeScript consumers get the same glyphs from the shared entries without
// keeping a JavaScript-only export alive solely for the static analyzer.
export const MESSAGE_REACTION_GLYPHS: Record<string, string> = Object.freeze(
  Object.fromEntries(MESSAGE_REACTIONS.map((entry) => [entry.kind, entry.glyph])),
);
export {
  INBOX_TYPES,
  channelUnreadCount,
  countUnreadInboxItems,
  directUnreadCount,
  inboxUnreadCount,
  isAnnouncementUnread,
  isChannelPostUnread,
  isDirectMessageUnread,
  isInboxItemUnread,
  isTaskMessageUnread,
  messageTimestamp,
  readCursor,
} from '../../../../src/features/messaging/unread.js';
export {
  isRedactedMessage,
  projectMessageBody,
  projectMessagePreview,
  redactionReasonOf,
} from '../../../../src/features/messaging/bodyLifecycle.js';
export {
  UNREAD_CONFORMANCE_CASES,
  runUnreadConformance,
} from '../../../../src/features/messaging/unreadFixtures.js';
