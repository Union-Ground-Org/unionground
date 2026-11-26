import { describe, expect, it } from 'vitest';

import {
  MESSAGE_REACTIONS,
  MESSAGE_REACTION_GLYPHS,
  MESSAGE_REACTION_KINDS,
  MESSAGE_REDACTION_REASONS,
  UNREAD_CONFORMANCE_CASES,
  aggregateMessageReactions,
  isMessageReactionKind,
  isRedactedMessage,
  projectMessageBody,
  projectMessagePreview,
  runUnreadConformance,
} from './messagingShared';
import { buildMessageInbox, countMessageFilters, filterMessageInbox, nativeInboxUnreadItemCount } from './messageInbox';

// TEST-UG-SHARED-UNREAD-CONTRACT-20260904: the phone runs the SAME fixture
// matrix responsive web runs (tests/messaging-shared-contract.test.js). If a
// case is added on either side it becomes binding on both, which is the whole
// point of a shared contract rather than two lookalike suites.
describe('shared messaging contract on the phone', () => {
  it('passes the unread conformance matrix', () => {
    expect(runUnreadConformance()).toEqual([]);
  });

  it('runs the same issues the browser runs', () => {
    expect(UNREAD_CONFORMANCE_CASES.length).toBeGreaterThanOrEqual(25);
  });

  it('exposes exactly the database reaction kinds, with a glyph each', () => {
    expect(MESSAGE_REACTION_KINDS).toHaveLength(10);
    expect(MESSAGE_REACTIONS.map((entry) => entry.kind)).toEqual([...MESSAGE_REACTION_KINDS]);
    for (const kind of MESSAGE_REACTION_KINDS) {
      expect(MESSAGE_REACTION_GLYPHS[kind], kind).toBeTruthy();
      expect(isMessageReactionKind(kind)).toBe(true);
    }
    expect(isMessageReactionKind('shrug')).toBe(false);
  });

  it('offers every kind on a message with no reactions at all', () => {
    // The native defect: reactions were reachable only where one already
    // existed, so a fresh post could not be reacted to from a phone.
    const aggregate = aggregateMessageReactions([], 'me');
    expect(aggregate).toHaveLength(10);
    expect(aggregate.every((entry) => entry.count === 0)).toBe(true);
  });
});

describe('redacted bodies on the phone', () => {
  it('never yields the removed text', () => {
    const row = {
      body: '',
      redacted_at: '2026-09-06T00:00:00.000Z',
      redaction_reason: 'staff_removed',
    };
    expect(isRedactedMessage(row)).toBe(true);
    const projected = projectMessageBody(row);
    expect(projected.body).toBe('');
    expect(projected.reason).toBe('staff_removed');
    expect(projected.noticeKey).toBe('inbox.redacted.staff_removed');
  });

  it('falls back to a known reason rather than rendering an unknown code', () => {
    const projected = projectMessageBody({ body: '', redacted_at: 'now', redaction_reason: 'mystery' });
    expect(MESSAGE_REDACTION_REASONS).toContain(projected.reason);
  });

  it('leaves a live message untouched', () => {
    const projected = projectMessageBody({ body: 'Bring the posted schedules.', redacted_at: null });
    expect(projected.redacted).toBe(false);
    expect(projected.body).toBe('Bring the posted schedules.');
  });

  it('blanks the preview a saved message or inbox row would show', () => {
    const preview = projectMessagePreview({ body: '', redacted_at: 'now', redaction_reason: 'sender_removed' });
    expect(preview.preview).toBe('');
    expect(preview.noticeKey).toBe('inbox.redacted.short');
  });
});

describe('the phone inbox counts through the shared normalizer', () => {
  const conversations = [
    { id: 'c1', counterpartRole: 'steward' as const, title: 'Sam Okafor', initials: 'SO', createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z', unreadCount: 2, latestMessage: 'Step 2 filed.' },
    { id: 'c2', counterpartRole: 'steward' as const, title: 'Jordan Patel', initials: 'JP', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', unreadCount: 0, latestMessage: null },
  ];
  const channels = [
    { id: 'general', name: 'general', unread: 3, topic: 'campaign wide', messages: [] },
    { id: 'stewards', name: 'stewards', locked: true, unread: 0, topic: 'private', messages: [] },
  ];

  it('counts only rows the contract calls unread', () => {
    const items = buildMessageInbox(conversations, channels);
    expect(countMessageFilters(items)).toEqual({ all: 4, unread: 2, direct: 2, channel: 2 });
    expect(nativeInboxUnreadItemCount(conversations, channels)).toBe(2);
    expect(nativeInboxUnreadItemCount(conversations, channels)).toBe(countMessageFilters(items).unread);
  });

  it('filters to the same rows the counter counted', () => {
    const items = buildMessageInbox(conversations, channels);
    expect(filterMessageInbox(items, 'unread', '').map((item) => item.id)).toEqual(['c1', 'general']);
  });

  it('clamps a nonsense count from the backend instead of rendering it', () => {
    const [firstConversation] = conversations;
    const [firstChannel] = channels;
    const items = buildMessageInbox(
      [{ ...firstConversation!, unreadCount: -5 }],
      [{ ...firstChannel!, unread: 2.7 }],
    );
    expect(items.find((item) => item.id === 'c1')?.unread).toBe(0);
    expect(items.find((item) => item.id === 'general')?.unread).toBe(2);
  });
});
