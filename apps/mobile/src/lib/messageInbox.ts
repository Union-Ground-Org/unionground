import type { DemoChannel } from '../data/demoChannels';
import type { MemberConversation } from '../models/member';
import { countUnreadInboxItems, inboxUnreadCount, isInboxItemUnread } from './messagingShared';
import { peerInitials, type PeerConversation } from './peerConversations';

export const MESSAGE_FILTERS = ['all', 'unread', 'direct', 'channel'] as const;

export type MessageFilter = (typeof MESSAGE_FILTERS)[number];

export type MessageInboxItem = {
  key: string;
  id: string;
  kind: 'direct' | 'channel';
  ownerUserId?: string;
  title: string;
  /** Channel name without the decorative display prefix; retain real punctuation. */
  accessibilityTitle?: string;
  meta: string;
  preview: string;
  initials: string | null;
  unread: number;
  timestamp: number;
  fallbackTime: string;
  /** Channel rows only: staff pinned this thread and the organization's pinning switch is on. */
  pinned?: boolean;
  /** Direct rows only: a private two-person conversation (public.member_peer_*), opened on its own screen (#9162). */
  peer?: boolean;
};

export type MessageInboxSourceCopy = {
  privateConversation: string;
  privateStaffChannel: string;
  chapterChannel: string;
  authorizedMessages: string;
  privatePeerConversation: string;
  peerConversationEmpty: string;
};

const defaultSourceCopy: MessageInboxSourceCopy = {
  privateConversation: 'Private conversation',
  privateStaffChannel: 'Private staff channel',
  chapterChannel: 'Campaign channel',
  authorizedMessages: 'Open to read the messages.',
  privatePeerConversation: 'Private worker conversation',
  peerConversationEmpty: 'Accepted — write the first message.',
};

function timestampOf(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function buildMessageInbox(
  conversations: readonly MemberConversation[],
  channels: readonly DemoChannel[],
  copy: MessageInboxSourceCopy = defaultSourceCopy,
  locale = 'en-US',
  pinningOn = false,
  peers: readonly PeerConversation[] = [],
): MessageInboxItem[] {
  return [
    ...conversations.map((conversation): MessageInboxItem => ({
      key: `direct-${conversation.id}`,
      id: conversation.id,
      kind: 'direct',
      ...(conversation.ownerUserId ? { ownerUserId: conversation.ownerUserId } : {}),
      title: conversation.title,
      meta: copy.privateConversation,
      preview: conversation.latestMessage ?? copy.authorizedMessages,
      initials: conversation.initials,
      // TEST-UG-SHARED-UNREAD-CONTRACT: normalized through the same module
      // responsive web uses, so a phone badge and a browser badge cannot mean
      // different things.
      unread: inboxUnreadCount('direct', conversation.unreadCount),
      timestamp: timestampOf(conversation.updatedAt),
      fallbackTime: '',
    })),
    // Every two-person conversation of the signed-in person, listed as the
    // website lists it: a direct row named for the other person (#9162). The
    // projection carries no read state, so these rows show no unread count.
    ...peers.map((conversation): MessageInboxItem => {
      const latest = conversation.messages.at(-1);
      return {
        key: `peer-${conversation.id}`,
        id: conversation.id,
        kind: 'direct',
        peer: true,
        // A conversation whose other person has no name from the server still
        // gets a readable row title, never a blank one.
        title: conversation.peerName || copy.privatePeerConversation,
        meta: copy.privatePeerConversation,
        preview: latest?.body ?? copy.peerConversationEmpty,
        initials: peerInitials(conversation),
        unread: 0,
        timestamp: timestampOf(conversation.updatedAt ?? latest?.createdAt),
        fallbackTime: '',
      };
    }),
    ...channels.map((channel): MessageInboxItem => {
      const latest = channel.messages.at(-1);
      return {
        key: `channel-${channel.id}`,
        id: channel.id,
        kind: 'channel',
        title: `# ${channel.name}`,
        accessibilityTitle: channel.name,
        meta: `${pinningOn && channel.pinnedAt ? 'Pinned · ' : ''}${channel.locked ? copy.privateStaffChannel : copy.chapterChannel}`,
        pinned: pinningOn && Boolean(channel.pinnedAt),
        preview: latest?.body ?? channel.topic,
        initials: null,
        unread: inboxUnreadCount('channel', channel.unread),
        timestamp: timestampOf(latest?.createdAt),
        fallbackTime: latest?.time ?? '',
      };
    }),
  ].sort((left, right) => right.timestamp - left.timestamp || left.title.localeCompare(right.title, locale));
}

export function countMessageFilters(items: readonly MessageInboxItem[]): Record<MessageFilter, number> {
  return {
    all: items.length,
    unread: countUnreadInboxItems(items.map((item) => ({ type: item.kind, unread: item.unread }))),
    direct: items.filter((item) => item.kind === 'direct').length,
    channel: items.filter((item) => item.kind === 'channel').length,
  };
}

export function nativeInboxUnreadItemCount(
  conversations: readonly MemberConversation[],
  channels: readonly DemoChannel[],
): number {
  return countMessageFilters(buildMessageInbox(conversations, channels)).unread;
}

// BUG-UG-MOBILE-MESSAGES-TAB-BADGE-COUNTS-DIRECT-THREADS-ONLY-20260914
// (Android window 4, 2026-09-26): once, on a tab re-entry, the badge read the
// direct-thread count alone while the live channel store was still loading.
// In authenticated mode the store publishes an EMPTY channel list while it is
// 'idle' or 'loading' (a fresh acquire, a session reset, a chapter switch),
// and the shared formula over that list is exactly the direct-only sum the
// record describes. This settles the badge instead: while the store has not
// completed a load in this session and holds no channels, the badge shows the
// last count a completed load produced, or nothing at all - never the
// channel-less sum. Once the store is 'ready' (including the authorized-empty
// reading, where zero channels is the truth) or has failed ('error', where the
// inbox screen shows the fault), the shared formula applies unchanged. Preview
// mode is untouched: the demo store is always ready.
export type InboxChannelLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export function settleInboxUnreadBadge({ authenticated, status, channelCount, computed, lastSettled }: {
  authenticated: boolean;
  status: InboxChannelLoadStatus;
  channelCount: number;
  computed: number;
  lastSettled: number | null;
}): number | null {
  if (!authenticated) return computed;
  if (channelCount === 0 && (status === 'idle' || status === 'loading')) return lastSettled;
  return computed;
}

// The badge remembers a count only from a completed load ('ready'); a count
// computed while loading or after a failure is never carried forward.
export function inboxUnreadBadgeSettles(status: InboxChannelLoadStatus): boolean {
  return status === 'ready';
}

// One search rule for the Messages tab: accents folded away and case
// lowered, so "comite" finds "Comité" in every row kind, task discussions
// included.
export function foldMessageSearch(value: string, locale = 'en-US'): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase(locale);
}

export function filterMessageInbox(
  items: readonly MessageInboxItem[],
  filter: MessageFilter,
  query: string,
  locale = 'en-US',
): MessageInboxItem[] {
  const fold = (value: string) => foldMessageSearch(value, locale);
  const needle = fold(query.trim());
  const kept = items.filter((item) => {
    if (filter === 'unread' && !isInboxItemUnread({ type: item.kind, unread: item.unread })) return false;
    if (filter !== 'all' && filter !== 'unread' && item.kind !== filter) return false;
    if (!needle) return true;
    return fold(`${item.title} ${item.meta} ${item.preview}`).includes(needle);
  });
  // The inbox stays chronological; the Channels filter is the channel list, so
  // pinned threads lead it (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001).
  if (filter !== 'channel') return kept;
  return [...kept.filter((item) => item.pinned), ...kept.filter((item) => !item.pinned)];
}
