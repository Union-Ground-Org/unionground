import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { DemoChannel } from '../data/demoChannels';
import type { MemberConversation } from '../models/member';
import { buildMessageInbox, countMessageFilters, filterMessageInbox, nativeInboxUnreadItemCount } from './messageInbox';
import { channelActionNotice, channelLoadFailureNotice, inboxChannelLoadNotice, messageInboxCopy } from './messageInboxCopy';

const conversations: MemberConversation[] = [
  {
    id: 'direct-1',
    title: 'Sam Okafor',
    initials: 'SO',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-23T15:00:00.000Z',
    unreadCount: 2,
    latestMessage: 'I can meet after your shift.',
  },
];

const channels: DemoChannel[] = [
  {
    id: 'chapter',
    name: 'chapter-updates',
    unread: 0,
    topic: 'Campaign updates',
    messages: [{
      id: 'post-1',
      author: 'Jordan Patel',
      initials: 'JP',
      time: '4:15 PM',
      createdAt: '2026-08-23T16:15:00.000Z',
      body: 'The meeting agenda is ready.',
    }],
  },
];

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('native message inbox', () => {
  it('merges authorized direct conversations and channels newest first', () => {
    const items = buildMessageInbox(conversations, channels);

    expect(items.map((item) => item.key)).toEqual(['channel-chapter', 'direct-direct-1']);
    expect(items[0]).toMatchObject({ kind: 'channel', meta: 'Campaign channel', preview: 'The meeting agenda is ready.' });
  });

  it('counts filters and composes source filters with search', () => {
    const items = buildMessageInbox(conversations, channels);

    expect(countMessageFilters(items)).toEqual({ all: 2, unread: 1, direct: 1, channel: 1 });
    expect(nativeInboxUnreadItemCount(conversations, channels)).toBe(1);
    expect(filterMessageInbox(items, 'direct', 'after your shift')).toHaveLength(1);
    expect(filterMessageInbox(items, 'channel', 'after your shift')).toHaveLength(0);
  });

  it('falls back safely when timestamps or messages are absent', () => {
    const [item] = buildMessageInbox([], [{
      id: 'empty',
      name: 'empty-channel',
      unread: 0,
      topic: 'No posts yet',
      messages: [],
    }]);

    expect(item).toMatchObject({ timestamp: 0, preview: 'No posts yet', fallbackTime: '' });
  });

  it('folds accents in search and localizes source labels', () => {
    const localizedChannels: DemoChannel[] = [{
      id: 'committee',
      name: 'comité',
      unread: 1,
      topic: 'Actualizaciones',
      messages: [],
    }];
    const items = buildMessageInbox([], localizedChannels, messageInboxCopy.es, 'es-US');

    expect(items[0]?.meta).toBe('Canal de la campaña');
    expect(filterMessageInbox(items, 'channel', 'comite', 'es-US')).toHaveLength(1);
    expect(messageInboxCopy.es.resultCount(1)).toBe('1 resultado');
    expect(messageInboxCopy.en.unreadCount(2)).toBe('2 unread messages');
    expect(messageInboxCopy.en.filterCount('channel', 'Channels', 2, true)).toBe('2 channels');
    expect(messageInboxCopy.en.filterCount('channel', 'Channels', 2, false)).toBe('2 channels');
    expect(messageInboxCopy.es.filterCount('all', 'Todos', 1, true)).toBe('1 elemento');
    expect(messageInboxCopy.es.filterCount('all', 'Todos', 1, false)).toBe('1 elemento');
  });

  it('keeps classified chapter-channel load notices distinct in English and Spanish', () => {
    expect(channelLoadFailureNotice(messageInboxCopy.en, 'authorized-empty')).toBeNull();
    expect(channelLoadFailureNotice(messageInboxCopy.es, null)).toBeNull();
    expect(channelLoadFailureNotice(messageInboxCopy.en, 'schema')).toContain('this app needs an update');
    expect(channelLoadFailureNotice(messageInboxCopy.en, 'transport')).toContain('couldn’t reach Union Ground');
    expect(channelLoadFailureNotice(messageInboxCopy.en, 'unknown')).toContain('didn’t load. Pull to refresh and try again.');
    expect(channelLoadFailureNotice(messageInboxCopy.en, 'authentication')).toContain('your sign-in ended');
    expect(channelLoadFailureNotice(messageInboxCopy.en, 'request')).toContain('didn’t load. Pull to refresh, and use Help');
    expect(channelLoadFailureNotice(messageInboxCopy.es, 'request')).toContain('rechazó esta solicitud');
    expect(channelLoadFailureNotice(messageInboxCopy.es, 'schema')).toContain('ya no coincide');
    expect(channelLoadFailureNotice(messageInboxCopy.es, 'transport')).toContain('no pudo conectar');
    expect(channelLoadFailureNotice(messageInboxCopy.es, 'unknown')).toContain('forma segura');
    expect(channelLoadFailureNotice(messageInboxCopy.es, 'authentication')).toContain('ya no está autorizada');
    expect(messageInboxCopy.en.pollUnavailable).toContain('poll is unavailable');
    expect(messageInboxCopy.es.pollUnavailable).toContain('encuesta');
    expect(messageInboxCopy.en.markReadError).toContain('could not be marked read');
    expect(messageInboxCopy.es.markReadError).toContain('marcar este canal como leído');
  });

  // BUG-UG-MOBILE-HOME-MESSAGES-METRIC-COUNTS-CONVERSATIONS-ONLY-20260915:
  // the two surfaces that publish an unread Messages number must both read this
  // module, and neither may reintroduce its own arithmetic over the inbox.
  it('publishes the Home metric and the tab badge from this module only', () => {
    const tabs = source('../../app/(tabs)/_layout.tsx');
    const home = source('../../app/(tabs)/home.tsx');
    const metrics = source('../models/member.ts');

    expect(tabs).toContain('nativeInboxUnreadItemCount(conversations, channels)');
    expect(metrics).toContain('unreadInboxItems: nativeInboxUnreadItemCount(dashboard.conversations, channels)');
    expect(home).toContain('dashboardMetrics(dashboard, channelStoreForMetrics.channels())');
    expect(home).toContain("<Metric value={metrics.unreadInboxItems} label={t(\"Unread messages\")}");
    expect(home).not.toContain("<Metric value={metrics.unreadMessages} label={t(\"Unread messages\")}");
  });

  // UX-UG-DIRECT-STEWARD-CONVERSATION-UNREAD-HAS-NO-REALTIME-OR-POLLING-PATH-THE-MESSAGES-20260921:
  // badge freshness must be uniform across its channel and conversation
  // components — the channel half subscribes to the channel store's
  // versioned surface, so the conversation half must subscribe to its own
  // versioned store fed by fetchDashboard and the bounded foreground poll,
  // never a bare dashboard snapshot.
  it('subscribes the badge conversation half to the same versioned-store shape as the channel half', () => {
    const tabs = source('../../app/(tabs)/_layout.tsx');
    const provider = source('../state/AppProvider.tsx');
    const poller = source('./conversationUnread.ts');

    expect(tabs).toContain('useSyncExternalStore(store.subscribe, store.getVersion)');
    expect(tabs).toContain('useSyncExternalStore(conversationUnreadStore.subscribe, conversationUnreadStore.getVersion)');
    expect(tabs).toContain("import { conversationUnreadStore } from '../../src/lib/conversationUnread'");
    // One store feeds both producers: the full dashboard refresh and the
    // bounded poll publish through it, and it resets on sign-out.
    expect(provider).toContain('conversationUnreadStore.publish(nextDashboard.conversations)');
    expect(provider).toContain('createConversationUnreadPoller');
    expect(provider).toContain('conversationUnreadStore.reset()');
    // The store carries the subscribe/getVersion surface the badge hooks.
    expect(poller).toContain('subscribe(listener: Listener): () => void');
    expect(poller).toContain('getVersion: (): number => version');
  });

  it('keeps the Work widget and reports card on the shared inbox quantity, not the direct-thread sum', () => {
    const widgets = source('../components/WorkWidgets.tsx');
    const feature = source('../features/FeatureScreen.tsx');
    const carousel = source('../components/HomeCarousel.tsx');
    const work = source('../features/WorkScreen.tsx');
    const metrics = source('../models/member.ts');
    const tabs = source('../../app/(tabs)/_layout.tsx');

    expect(widgets).toContain('messagesWorkWidgetModel(dashboard, channels)');
    expect(widgets).not.toContain('metrics.unreadMessages > 0 ? `${metrics.unreadMessages} unread`');
    expect(widgets).not.toContain('dashboard.conversations.slice(0, 5)');
    expect(feature).toContain('reportsUnreadMessagesCard(dashboard, inboxChannels)');
    expect(feature).not.toContain('value: String(metrics.unreadMessages)');
    expect(carousel).toContain('channels={inboxChannels}');
    expect(work).toContain('channels={inboxChannels}');
    expect(metrics).toContain('unreadInboxItems: nativeInboxUnreadItemCount(dashboard.conversations, channels)');
    expect(tabs).toContain('nativeInboxUnreadItemCount(conversations, channels)');
  });

  it('keeps send failures and untranslated store errors out of the inbox load notice', () => {
    const sendFailure = 'Your message could not be sent securely. Try again.';
    const unconfigured = 'The secure mobile backend is not configured.';
    expect(inboxChannelLoadNotice(messageInboxCopy.en, null, false)).toBeNull();
    expect(inboxChannelLoadNotice(messageInboxCopy.es, null, false)).toBeNull();
    expect(inboxChannelLoadNotice(messageInboxCopy.en, null, true)).toBe(messageInboxCopy.en.channelError.unknown);
    expect(inboxChannelLoadNotice(messageInboxCopy.es, null, true)).toBe(messageInboxCopy.es.channelError.unknown);
    expect(inboxChannelLoadNotice(messageInboxCopy.es, 'transport', true)).toBe(messageInboxCopy.es.channelError.transport);
    expect(inboxChannelLoadNotice(messageInboxCopy.en, 'authentication', false)).toBe(messageInboxCopy.en.channelError.authentication);
    expect(inboxChannelLoadNotice(messageInboxCopy.es, null, true)).not.toBe(unconfigured);
    expect(inboxChannelLoadNotice(messageInboxCopy.es, null, true)).not.toBe(sendFailure);
    expect(inboxChannelLoadNotice(messageInboxCopy.es, null, false)).not.toBe(sendFailure);
  });
});

describe('channel action notices (send, reaction, vote)', () => {
  it('localizes send, reaction, and vote notices in English and Spanish', () => {
    expect(channelActionNotice(messageInboxCopy.en, 'send')).toBe('Your message could not be sent securely. Try again.');
    expect(channelActionNotice(messageInboxCopy.es, 'send')).toBe('Tu mensaje no se pudo enviar de forma segura. Inténtalo de nuevo.');
    expect(channelActionNotice(messageInboxCopy.en, 'reaction')).toBe('That reaction could not be saved securely. Try again.');
    expect(channelActionNotice(messageInboxCopy.es, 'reaction')).toContain('reacción');
    expect(channelActionNotice(messageInboxCopy.en, 'vote')).toBe('That vote could not be saved securely. Try again.');
    expect(channelActionNotice(messageInboxCopy.es, 'vote')).toContain('voto');
    expect(channelActionNotice(messageInboxCopy.en, 'send')).not.toBe(channelActionNotice(messageInboxCopy.es, 'send'));
    expect(channelActionNotice(messageInboxCopy.en, 'reaction')).not.toBe(channelActionNotice(messageInboxCopy.en, 'vote'));
  });

  it('shows the localized send notice only on the composer, never as an inbox load fault', () => {
    const send = channelActionNotice(messageInboxCopy.en, 'send');
    const reaction = channelActionNotice(messageInboxCopy.en, 'reaction');
    const vote = channelActionNotice(messageInboxCopy.en, 'vote');
    expect(inboxChannelLoadNotice(messageInboxCopy.en, null, false)).not.toBe(send);
    expect(inboxChannelLoadNotice(messageInboxCopy.en, null, true)).not.toBe(send);
    expect(inboxChannelLoadNotice(messageInboxCopy.es, null, true)).not.toBe(channelActionNotice(messageInboxCopy.es, 'send'));
    expect(inboxChannelLoadNotice(messageInboxCopy.en, 'schema', true)).not.toBe(send);
    expect(inboxChannelLoadNotice(messageInboxCopy.en, 'schema', true)).not.toBe(reaction);
    expect(inboxChannelLoadNotice(messageInboxCopy.en, 'schema', true)).not.toBe(vote);

    const channelScreen = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
    const messages = readFileSync(fileURLToPath(new URL('../../app/messages.tsx', import.meta.url)), 'utf8');
    expect(channelScreen).toContain("channelActionNotice(copy, 'send')");
    expect(channelScreen).toContain('{sendError ? <Notice>{catalogLabel(sendError)}</Notice> : null}');
    expect(channelScreen).toContain('{actionNotice ? <Notice>{actionNotice}</Notice> : null}');
    expect(channelScreen).not.toContain('Your message could not be sent securely. Try again.');
    expect(messages).not.toContain('channelActionNotice');
    expect(messages).not.toContain('sendDiagnosis');
    expect(messages).not.toContain('actionDiagnosis');
    expect(messages).not.toContain('actionNotice');
  });

  it('brings a reaction or vote failure into view instead of appending it out of sight', () => {
    const channelScreen = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
    // The notice renders at the end of the channel's scroll content, and
    // anchorCurrentMessages fires once per channel, so the screen has to scroll
    // the new notice into view and announce it where the live region does not.
    expect(channelScreen).toContain('channelScrollRef.current?.scrollToEnd({ animated: true })');
    expect(channelScreen).toContain('announceForAccessibility(channelActionNotice(copy, op))');
    expect(channelScreen).toContain('announcedActionFault');
  });

  it('renders only the action failure the store retains for this route\'s channel', () => {
    const channelScreen = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
    // The store keys each failure by action, channel and target, so the screen
    // must read it scoped to its own route id and never clear it itself.
    expect(channelScreen).toContain("const actionDiagnosis = liveChannelStore.actionDiagnosis(id ?? '');");
    expect(channelScreen).not.toMatch(/liveChannelStore\.actionDiagnosis\(\)/);
    expect(channelScreen).not.toMatch(/clearActionFailure/);
    expect(channelScreen).toContain('const actionNotice = actionDiagnosis && (actionDiagnosis.op === \'reaction\' || actionDiagnosis.op === \'vote\')');
  });
});
