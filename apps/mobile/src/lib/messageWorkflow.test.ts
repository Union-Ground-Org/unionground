import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { MemberConversation } from '../models/member';
import type { MessageInboxItem } from './messageInbox';
import {
  findNativeStewardConversation,
  nativeStewardContactRoute,
  groupNativeMessageItems,
  messageWorkflowCopy,
  messageWorkflowDefault,
  messageWorkflowKeys,
  normalizeMessageWorkflow,
} from './messageWorkflow';
import { messageInboxCopy } from './messageInboxCopy';

const items: MessageInboxItem[] = [
  { key: 'direct-read', id: '1', kind: 'direct', title: 'A', meta: '', preview: '', initials: 'A', unread: 0, timestamp: 2, fallbackTime: '' },
  { key: 'direct-unread', id: '2', kind: 'direct', title: 'B', meta: '', preview: '', initials: 'B', unread: 1, timestamp: 3, fallbackTime: '' },
  { key: 'channel', id: '3', kind: 'channel', title: '# C', meta: '', preview: '', initials: null, unread: 0, timestamp: 1, fallbackTime: '' },
];

function conversation(id: string, title: string, counterpartRole?: 'steward', stewardUserId: string | null = null): MemberConversation {
  return { id, counterpartRole, stewardUserId, title, initials: 'CS', createdAt: '', updatedAt: '', unreadCount: 0, latestMessage: null };
}

describe('native messaging workflow model', () => {
  it('words the layout picker as product copy, like the web picker', () => {
    const en = messageWorkflowCopy.en;
    expect(en.conLabel).toBe('Keep in mind');
    const english = JSON.stringify(en, (_key, value: unknown) => (typeof value === 'function' ? undefined : value));
    expect(english).not.toMatch(/tradeoff/i);
    expect(english).not.toMatch(/mental model/i);
  });

  it('exposes workflow choices as selected radio options', () => {
    const picker = readFileSync(fileURLToPath(new URL('../components/MessageWorkflowPicker.tsx', import.meta.url)), 'utf8');
    expect(picker).toContain('accessibilityRole="radio"');
    expect(picker).toContain('accessibilityState={{ selected }}');
    expect(picker).not.toContain('accessibilityState={{ checked: selected }}');
  });

  it('uses workflow 2 whenever the stored value is absent or invalid', () => {
    expect(normalizeMessageWorkflow(null)).toBe(messageWorkflowDefault);
    expect(normalizeMessageWorkflow('unknown')).toBe(messageWorkflowDefault);
    expect(messageWorkflowDefault).toBe('people-spaces-work');
  });

  it.each(messageWorkflowKeys)('keeps every authorized item exactly once in %s', (workflow) => {
    const grouped = groupNativeMessageItems(items, workflow).flatMap((group) => group.items.map((item) => item.key));
    expect(grouped).toHaveLength(items.length);
    expect(new Set(grouped)).toEqual(new Set(items.map((item) => item.key)));
  });

  it('targets the committee member thread instead of the first unrelated thread', () => {
    const conversations = [conversation('peer', 'Alex Rivera'), conversation('steward', 'Maria Santos', 'steward')];
    expect(findNativeStewardConversation(conversations)?.id).toBe('steward');
    expect(findNativeStewardConversation([conversation('peer', 'Alex Rivera')])).toBeNull();
    // A selected-steward thread coexists with the general thread and is never the general target.
    const selected = conversation('selected', 'Dana Lee', 'steward', '00000000-0000-4000-8000-000000000001');
    expect(findNativeStewardConversation([selected, conversation('general', 'Campaign committee member', 'steward')])?.id).toBe('general');
    expect(findNativeStewardConversation([selected])).toBeNull();
    const union = readFileSync(fileURLToPath(new URL('../../app/(tabs)/campaign.tsx', import.meta.url)), 'utf8');
    expect(union).toContain('findNativeStewardConversation(dashboard?.conversations ?? [])');
    expect(union).not.toContain('conversations[0]');
  });
});

// REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922: with a roster the
// member can pick from, "the steward conversation" has to mean the selected
// steward's own conversation.
describe('selected-steward contact routing', () => {
  const first = conversation('thread-1', 'First committee member', 'steward', 'steward-1');
  const second = conversation('thread-2', 'Second committee member', 'steward', 'steward-2');
  const unbound = conversation('thread-0', 'Campaign intake', 'steward');
  const twoStewards = [unbound, first, second];

  it('reaches each committee member of a two-steward campaign through their own conversation', () => {
    expect(findNativeStewardConversation(twoStewards, 'steward-1')?.id).toBe('thread-1');
    expect(findNativeStewardConversation(twoStewards, 'steward-2')?.id).toBe('thread-2');
    expect(nativeStewardContactRoute(twoStewards, 'steward-1')).toEqual({ kind: 'conversation', conversationID: 'thread-1' });
    expect(nativeStewardContactRoute(twoStewards, 'steward-2')).toEqual({ kind: 'conversation', conversationID: 'thread-2' });
  });

  it('never falls back to another committee member or the shared thread when a committee member is selected', () => {
    // 'steward-3' has no conversation yet. The canonical thread is first in the
    // list and would be the tempting answer; it is the wrong person.
    expect(findNativeStewardConversation(twoStewards, 'steward-3')).toBeNull();
    expect(nativeStewardContactRoute(twoStewards, 'steward-3')).toEqual({ kind: 'start' });
  });

  it('keeps the canonical committee member thread for the unscoped issue', () => {
    expect(findNativeStewardConversation(twoStewards)?.id).toBe('thread-0');
    expect(findNativeStewardConversation(twoStewards, null)?.id).toBe('thread-0');
    expect(findNativeStewardConversation(twoStewards, '')?.id).toBe('thread-0');
    expect(nativeStewardContactRoute(twoStewards)).toEqual({ kind: 'conversation', conversationID: 'thread-0' });
    expect(nativeStewardContactRoute([])).toEqual({ kind: 'start' });
  });
});

// PRES-P5 (Nov 6, 2026): the iOS demo signs in as fictional SAMPLE accounts,
// so a first-time viewer reads Messages and My union; their English product
// copy may not speak in access-control or data-pipeline terms.
describe('Messages and My campaign read like a product to a first-time viewer', () => {
  const jargon = /authoriz|metadata|presentation only|reserved ingest/i;
  it('keeps that jargon out of the English workflow and inbox copy a viewer reads', () => {
    const { onboardingBody, settingsBody, briefing } = messageWorkflowCopy.en;
    for (const text of [onboardingBody, settingsBody, briefing.body, briefing.changedValue(1), briefing.changedValue(3),
      messageInboxCopy.en.composerBody, messageInboxCopy.en.authorizedMessages]) {
      expect(text).not.toMatch(jargon);
    }
    expect(briefing.changedValue(1)).toBe('1 inbox item is in this view.');
  });

  it('keeps it out of the Campaign tab', () => {
    // This edition's Campaign tab is public main's screen: no destination
    // cards and no web-handoff subtitle, so the whole screen is checked.
    const campaign = readFileSync(fileURLToPath(new URL('../../app/(tabs)/campaign.tsx', import.meta.url)), 'utf8');
    // Shown words only: quoted strings and JSX text, not identifiers.
    const shown = [...campaign.matchAll(/'([^'\n]*)'|"([^"\n]*)"|>([^<>{}\n]+)</g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
    for (const words of shown) expect(words).not.toMatch(jargon);
  });
});
