// REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001 — the Expo app reads the same
// channel-control rules responsive web does, and its channel list honours pins.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as web from '../../../../src/features/messaging/channelControls.js';
import type { DemoChannel } from '../data/demoChannels';
import {
  CHANNEL_MUTE_DURATIONS,
  CHANNEL_NOTIFICATION_LEVELS,
  containsHereMention,
  isMuteActive,
  normalizeChannelControls,
  segmentChannelText,
} from './channelControlsShared';
import { buildMessageInbox, filterMessageInbox } from './messageInbox';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

function channel(id: string, createdAt: string, pinnedAt: string | null = null): DemoChannel {
  return {
    id,
    name: id,
    unread: 0,
    topic: 'Campaign',
    pinnedAt: pinnedAt ?? undefined,
    messages: [{ id: `${id}-post`, author: 'Ana', initials: 'A', time: '9:00', createdAt, body: 'Hello' }],
  };
}

describe('shared channel-control rules', () => {
  it('re-exports the web module rather than restating it', () => {
    expect(CHANNEL_NOTIFICATION_LEVELS).toBe(web.CHANNEL_NOTIFICATION_LEVELS);
    expect(CHANNEL_MUTE_DURATIONS).toBe(web.CHANNEL_MUTE_DURATIONS);
    expect(containsHereMention('@here please')).toBe(true);
    expect(containsHereMention('team@here.org')).toBe(false);
    expect(segmentChannelText('the overtime list', { keywords: ['overtime'] })).toEqual([
      { text: 'the ', highlight: null },
      { text: 'overtime', highlight: 'keyword' },
      { text: ' list', highlight: null },
    ]);
    expect(isMuteActive({ muted: true, mutedUntil: null })).toBe(true);
    expect(normalizeChannelControls(undefined).available).toBe(false);
  });
});

describe('pinned threads in the native channel list', () => {
  const channels = [
    channel('newest', '2026-10-02T12:00:00.000Z'),
    channel('pinned', '2026-09-01T12:00:00.000Z', '2026-10-01T09:00:00.000Z'),
    channel('older', '2026-09-30T12:00:00.000Z'),
  ];

  it('keeps the inbox chronological and leads the Channels filter with pinned threads', () => {
    const items = buildMessageInbox([], channels, undefined, 'en-US', true);
    expect(filterMessageInbox(items, 'all', '').map((item) => item.id)).toEqual(['newest', 'older', 'pinned']);
    expect(filterMessageInbox(items, 'channel', '').map((item) => item.id)).toEqual(['pinned', 'newest', 'older']);
    expect(items.find((item) => item.id === 'pinned')?.meta).toMatch(/^Pinned · /);
  });

  it('ignores pins while the organization switch is off', () => {
    const items = buildMessageInbox([], channels, undefined, 'en-US', false);
    expect(filterMessageInbox(items, 'channel', '').map((item) => item.id)).toEqual(['newest', 'older', 'pinned']);
    expect(items.some((item) => item.meta.startsWith('Pinned'))).toBe(false);
  });
});

describe('native channel screens', () => {
  it('offer settings, mentions, highlighting and pinning only with a live session', () => {
    const screen = read('../../app/channel/[id].tsx');
    expect(screen).toContain('controlsLive && channelControls.canPin');
    expect(screen).toContain('controlsLive && switches.mentions && spaceID');
    expect(screen).toContain('<ChannelHighlightedBody');
    const mentions = read('../../app/mentions.tsx');
    expect(mentions).toContain("if (mode === 'signedOut') return <Redirect href=\"/sign-in\" />;");
    expect(mentions).toContain('controls.switches.mentionSearch');
  });
});

describe('K7 compact native message chrome', () => {
  const channel = read('../../app/channel/[id].tsx');
  const inbox = read('../../app/messages.tsx');
  const controls = read('../components/ChannelControls.tsx');
  it('keeps long thread names out of the Back row and shows the full name below it', () => {
    expect(channel).toContain('<PinnedHeaderScreen title={t(\'Messages\')}');
    expect(channel).toContain('<Heading2 name={channel.name}');
    expect(channel).not.toContain('>#{name}</Text>');
  });

  it('puts channel notifications and pin behind an expandable header menu', () => {
    const header = channel.slice(channel.indexOf('<View style={styles.header}>'), channel.indexOf('{markReadDiagnosis ?'));
    expect(header).toContain("accessibilityLabel={t('Channel actions')}");
    expect(header).toContain('accessibilityState={{ expanded: actionsOpen }}');
    const menu = header.slice(header.indexOf('{actionsOpen ?'));
    expect(menu).toContain("t('Channel notifications')");
    expect(menu).toContain("t('Pin thread')");
  });

  it('offers mention as a labelled, 48-point icon inside the composer', () => {
    const composer = channel.slice(channel.indexOf('<View style={[styles.composer,'), channel.indexOf('{sendError ?'));
    expect(composer).toContain("accessibilityLabel={t('Mention someone')}");
    expect(composer).toContain('name="at-outline"');
    expect(composer).toContain('accessibilityState={{ disabled: sending, expanded: mentionOpen }}');
    expect(composer).toContain('styles.mentionButton');
    expect(channel).toMatch(/mentionButton: \{[^}]*minWidth: minimumTouchTarget[^}]*minHeight: minimumTouchTarget/);
    expect(controls).not.toContain("if (!open) return <Button label={t('Mention someone')}");
  });

  it('puts wrapping inbox shortcuts below the title without shrinking or clipping their labels', () => {
    const title = inbox.indexOf('{copy.title}');
    const shortcuts = inbox.indexOf('<View style={styles.shortcuts}>');
    expect(shortcuts).toBeGreaterThan(title);
    const row = inbox.slice(shortcuts, inbox.indexOf('<SearchField', shortcuts));
    expect(row).toContain("t('Reminders')");
    expect(row).toContain("t('Your mentions')");
    expect(row).not.toContain('<Button');
    expect(row).not.toMatch(/numberOfLines|maxFontSizeMultiplier|adjustsFontSizeToFit/);
    expect(inbox).toMatch(/shortcuts: \{[^}]*flexDirection: 'row'[^}]*flexWrap: 'wrap'/);
    expect(inbox).toMatch(/shortcut: \{[^}]*minHeight: minimumTouchTarget[^}]*maxWidth: '100%'/);
  });
});
