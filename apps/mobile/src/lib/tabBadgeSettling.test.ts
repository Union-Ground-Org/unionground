import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { DemoChannel } from '../data/demoChannels';
import type { MemberConversation } from '../models/member';
import { inboxUnreadBadgeSettles, nativeInboxUnreadItemCount, settleInboxUnreadBadge, type InboxChannelLoadStatus } from './messageInbox';
import { rememberSettledBadge, resetSettledBadgeForTests, settledBadgeFor } from './tabBadgeSettled';

// BUG-UG-MOBILE-MESSAGES-TAB-BADGE-COUNTS-DIRECT-THREADS-ONLY-20260914:
// Android window 4 (2026-09-26) caught the badge at "2" (the direct-thread
// count) while the Unread filter held 3 and the fixture was unchanged - the
// live channel store had published an empty channel list mid-load. The badge
// must never present that channel-less sum in authenticated mode.

const directs: MemberConversation[] = [
  { id: 'd1', title: 'Sam Okafor', initials: 'SO', createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-26T15:00:00.000Z', unreadCount: 2, latestMessage: 'After your shift?' },
  { id: 'd2', title: 'Dana Whitfield', initials: 'DW', createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-26T14:00:00.000Z', unreadCount: 1, latestMessage: 'Minutes posted.' },
];
const channels: DemoChannel[] = [
  { id: 'c1', name: 'chapter-updates', unread: 1, topic: 'Campaign updates', messages: [{ id: 'p1', author: 'Jordan Patel', initials: 'JP', time: '9:00 AM', createdAt: '2026-09-26T13:00:00.000Z', body: 'Bargaining update.' }] },
];
const tabs = readFileSync(fileURLToPath(new URL('../../app/(tabs)/_layout.tsx', import.meta.url)), 'utf8');

describe('Messages tab badge settling', () => {
  const computedWithChannels = nativeInboxUnreadItemCount(directs, channels);
  const computedWithoutChannels = nativeInboxUnreadItemCount(directs, []);

  it('is the mixed fixture the device windows use: 2 directs + 1 channel unread', () => {
    expect(computedWithChannels).toBe(3);
    expect(computedWithoutChannels).toBe(2);
  });

  it('never shows the direct-only sum while the live store is idle or loading with no channels', () => {
    const unsettled: InboxChannelLoadStatus[] = ['idle', 'loading'];
    for (const status of unsettled) {
      expect(settleInboxUnreadBadge({ authenticated: true, status, channelCount: 0, computed: computedWithoutChannels, lastSettled: null })).toBeNull();
      expect(settleInboxUnreadBadge({ authenticated: true, status, channelCount: 0, computed: computedWithoutChannels, lastSettled: 3 })).toBe(3);
    }
  });

  it('applies the shared formula once the store is ready, including the authorized-empty reading', () => {
    expect(settleInboxUnreadBadge({ authenticated: true, status: 'ready', channelCount: 1, computed: computedWithChannels, lastSettled: null })).toBe(3);
    // Zero channels at 'ready' is the truth (authorized-empty): the direct sum is right.
    expect(settleInboxUnreadBadge({ authenticated: true, status: 'ready', channelCount: 0, computed: computedWithoutChannels, lastSettled: 3 })).toBe(2);
  });

  it('applies the shared formula after a failed load, where the inbox screen shows the fault', () => {
    expect(settleInboxUnreadBadge({ authenticated: true, status: 'error', channelCount: 0, computed: computedWithoutChannels, lastSettled: 3 })).toBe(2);
  });

  it('keeps a loading store with channels already cached on the shared formula (a refresh, not a cold load)', () => {
    expect(settleInboxUnreadBadge({ authenticated: true, status: 'loading', channelCount: 1, computed: computedWithChannels, lastSettled: null })).toBe(3);
  });

  it('leaves preview mode untouched (the demo store is always ready)', () => {
    expect(settleInboxUnreadBadge({ authenticated: false, status: 'idle', channelCount: 0, computed: computedWithoutChannels, lastSettled: null })).toBe(2);
  });

  it('remembers a count only from a completed load', () => {
    expect(inboxUnreadBadgeSettles('ready')).toBe(true);
    const notSettled: InboxChannelLoadStatus[] = ['idle', 'loading', 'error'];
    for (const status of notSettled) expect(inboxUnreadBadgeSettles(status)).toBe(false);
  });

  it('remembers the settled count per signed-in user, across a remount, and forgets it on a user change', () => {
    resetSettledBadgeForTests();
    expect(settledBadgeFor('user-a')).toBeNull();
    rememberSettledBadge('user-a', 3);
    expect(settledBadgeFor('user-a')).toBe(3);
    // A remounted tab host (deep link + back) reads the same module state.
    expect(settledBadgeFor('user-a')).toBe(3);
    // Another account, or no account (preview / signed out), never inherits it.
    expect(settledBadgeFor('user-b')).toBeNull();
    expect(settledBadgeFor('user-a')).toBeNull();
    rememberSettledBadge('user-a', 2);
    expect(settledBadgeFor(null)).toBeNull();
    rememberSettledBadge(null, 9);
    expect(settledBadgeFor('user-a')).toBeNull();
    resetSettledBadgeForTests();
  });

  it('is what the native tab host renders, keyed by the signed-in user', () => {
    expect(tabs).toContain("import { inboxUnreadBadgeSettles, nativeInboxUnreadItemCount, settleInboxUnreadBadge } from '../../src/lib/messageInbox';");
    expect(tabs).toContain("import { rememberSettledBadge, settledBadgeFor } from '../../src/lib/tabBadgeSettled';");
    expect(tabs).toContain('const computedUnread = nativeInboxUnreadItemCount(conversations, channels);');
    expect(tabs).toContain('const settledKey = authenticated ? session?.user.id ?? null : null;');
    expect(tabs).toContain('if (authenticated && inboxUnreadBadgeSettles(storeStatus)) rememberSettledBadge(settledKey, computedUnread);');
    expect(tabs).toContain('lastSettled: settledBadgeFor(settledKey),');
    // No React ref: the host may remount on a deep link + back, and the
    // drawer-surface harness drives TabLayout as a plain function.
    expect(tabs).not.toContain('useRef');
    expect(tabs).toContain('const unreadMessages = settleInboxUnreadBadge({');
    expect(tabs).toContain('channelCount: store.channels().length,');
    // A null settle hides the badge; it never renders a number.
    expect(tabs).toContain('<NativeTabs.Trigger.Badge hidden={unreadMessages === null || unreadMessages === 0}>');
  });
});
