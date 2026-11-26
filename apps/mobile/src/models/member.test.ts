import { describe, expect, it } from 'vitest';

import type { DemoChannel } from '../data/demoChannels';
import { nativeInboxUnreadItemCount } from '../lib/messageInbox';
import type { MemberCase, MemberDashboard } from './member';
import { dashboardMetrics, initialsForName, messagesWorkWidgetModel, nextActiveCase, reportsUnreadMessagesCard } from './member';

const base: MemberCase = {
  id: '1', reference: 'UB-1', title: 'One', deadline: null,
  caseType: 'General', step: 'Review', status: 'active', updatedAt: '2026-08-10T12:00:00Z',
};

describe('mobile worker dashboard policy', () => {
  it('selects the nearest deadline from active issues instead of the first loaded row', () => {
    expect(nextActiveCase([
      { ...base, id: 'closed', status: 'closed', deadline: '2026-08-01' },
      { ...base, id: 'later', deadline: '2026-08-30' },
      { ...base, id: 'next', deadline: '2026-08-20' },
    ])?.id).toBe('next');
  });

  it('sorts a dated issue ahead of a more recently updated undated issue', () => {
    expect(nextActiveCase([
      { ...base, id: 'undated', updatedAt: '2026-08-14T12:00:00Z' },
      { ...base, id: 'dated', deadline: '2026-08-20', updatedAt: '2026-08-01T12:00:00Z' },
    ])?.id).toBe('dated');
  });

  it('returns no next issue when every record is inactive', () => {
    expect(nextActiveCase([{ ...base, status: 'closed' }])).toBeNull();
  });

  it('counts only unread committee member messages and unread notifications', () => {
    const dashboard = {
      member: { id: 'member', firstName: 'Sam', fullName: 'Sam Okafor', initials: 'SO', roleLine: 'Worker', memberSince: 2022, chapterID: null, language: 'en' },
      notifications: [
        { id: 'n1', title: 'One', body: 'One', kind: 'general', readAt: null, createdAt: '2026-08-18T12:00:00Z' },
        { id: 'n2', title: 'Two', body: 'Two', kind: 'general', readAt: '2026-08-18T12:01:00Z', createdAt: '2026-08-18T12:00:00Z' },
      ],
      cases: [base],
      conversations: [
        { id: 'c1', title: 'Committee', initials: 'CS', createdAt: '2026-08-18T12:00:00Z', updatedAt: '2026-08-18T12:00:00Z', unreadCount: 2, latestMessage: 'Reply' },
      ],
      weeklyActions: [],
    } satisfies MemberDashboard;

    expect(dashboardMetrics(dashboard)).toMatchObject({ unreadNotifications: 1, unreadMessages: 2 });
  });

  // BUG-UG-MOBILE-HOME-MESSAGES-METRIC-COUNTS-CONVERSATIONS-ONLY-20260915:
  // the Home Messages metric and the Messages tab badge describe one inbox, so
  // they may not be two different derivations of it.
  it('gives Home the same Messages number the tab badge shows for a mixed inbox', () => {
    const dashboard = {
      member: { id: 'member', firstName: 'Sam', fullName: 'Sam Okafor', initials: 'SO', roleLine: 'Worker', memberSince: 2022, chapterID: null, language: 'en' },
      notifications: [],
      cases: [base],
      conversations: [
        { id: 'c1', title: 'Committee', initials: 'CS', createdAt: '2026-08-18T12:00:00Z', updatedAt: '2026-08-18T12:00:00Z', unreadCount: 5, latestMessage: 'Reply' },
        { id: 'c2', title: 'Read thread', initials: 'RT', createdAt: '2026-08-18T12:00:00Z', updatedAt: '2026-08-18T12:00:00Z', unreadCount: 0, latestMessage: 'Seen' },
      ],
      weeklyActions: [],
    } satisfies MemberDashboard;
    const channels: DemoChannel[] = [
      { id: 'chapter', name: 'chapter-updates', unread: 3, topic: 'Campaign updates', messages: [] },
      { id: 'quiet', name: 'quiet-channel', unread: 0, topic: 'Nothing new', messages: [] },
    ];

    const badge = nativeInboxUnreadItemCount(dashboard.conversations, channels);
    // One unread thread and one unread channel: two unread inbox items.
    expect(badge).toBe(2);
    expect(dashboardMetrics(dashboard, channels).unreadInboxItems).toBe(badge);
    // The direct-thread total the preview Unread stat reads is a different
    // quantity and stays what it was.
    expect(dashboardMetrics(dashboard, channels).unreadMessages).toBe(5);
    // With no channels in hand the metric is still the badge's arithmetic over
    // the conversations alone, never the old sum.
    expect(dashboardMetrics(dashboard).unreadInboxItems).toBe(1);
  });

  // BUG-UG-MOBILE-WORK-WIDGET-UNREAD-DISAGREES-WITH-HOME-METRIC-20260918:
  // Home, the Work Messages widget, and the reports card must not publish the
  // direct-thread sum under a label that does not say so. They may share the
  // inbox item count, or label a conversation-only figure explicitly.
  it('keeps the Work widget and reports card on the Home Messages inbox quantity', () => {
    const dashboard = {
      member: { id: 'member', firstName: 'Sam', fullName: 'Sam Okafor', initials: 'SO', roleLine: 'Worker', memberSince: 2022, chapterID: null, language: 'en' },
      notifications: [],
      cases: [base],
      conversations: [
        { id: 'c1', title: 'Committee', initials: 'CS', createdAt: '2026-08-18T12:00:00Z', updatedAt: '2026-08-18T12:00:00Z', unreadCount: 5, latestMessage: 'Reply' },
        { id: 'c2', title: 'Read thread', initials: 'RT', createdAt: '2026-08-18T12:00:00Z', updatedAt: '2026-08-18T12:00:00Z', unreadCount: 0, latestMessage: 'Seen' },
      ],
      weeklyActions: [],
    } satisfies MemberDashboard;
    const channels: DemoChannel[] = [
      { id: 'chapter', name: 'chapter-updates', unread: 3, topic: 'Campaign updates', messages: [] },
      { id: 'quiet', name: 'quiet-channel', unread: 0, topic: 'Nothing new', messages: [] },
    ];

    const home = dashboardMetrics(dashboard, channels).unreadInboxItems;
    const directSum = dashboardMetrics(dashboard, channels).unreadMessages;
    expect(home).toBe(2);
    expect(directSum).toBe(5);
    expect(home).not.toBe(directSum);

    const widget = messagesWorkWidgetModel(dashboard, channels);
    expect(widget.quantity).toBe(home);
    expect(widget.badge).toBe(`${home} unread`);
    expect(widget.badge).not.toBe(`${directSum} unread`);
    expect(widget.rows.some((row) => row.href === '/channel/chapter')).toBe(true);
    expect(widget.rows.some((row) => row.href.startsWith('/conversation/'))).toBe(true);

    const reports = reportsUnreadMessagesCard(dashboard, channels);
    expect(reports.value).toBe(String(home));
    expect(reports.value).not.toBe(String(directSum));
    expect(reports.label.toLowerCase()).not.toMatch(/direct|conversation-only|thread-only/);
  });

  it('derives compact initials without retaining extra name parts', () => {
    expect(initialsForName('  María   de la Cruz ')).toBe('MD');
    expect(initialsForName('')).toBe('');
  });
});


describe('K7 Messages work-widget thread labels', () => {
  const dashboard: MemberDashboard = { member: { id: 'sam', firstName: 'Sam', fullName: 'Sam Okafor', initials: 'SO', roleLine: 'Worker', memberSince: 2022, chapterID: null, language: 'en' }, cases: [], conversations: [], notifications: [], weeklyActions: [] };
  it.each(['The October Ledger is out', '  Which staffing topic?  ', '#21 — Chapter news'])('preserves the actual title %s without a decorative channel prefix or repeated preview', (name) => {
    const rows = messagesWorkWidgetModel(dashboard, [{ id: 'thread', name, topic: name, unread: 1, messages: [
      { id: 'post', author: 'Sam', initials: 'SO', time: '9 AM', body: name.trim() },
    ] }]).rows;
    expect(rows[0]?.primary).toBe(name);
    expect(rows[0]?.secondary).toBeUndefined();
    expect(rows[0]?.href).toBe('/channel/thread');
  });
  it('retains destination kinds when a private conversation and channel share their title and preview', () => {
    const title = 'Campaign committee member';
    const preview = 'Meeting tomorrow';
    const rows = messagesWorkWidgetModel({ ...dashboard, conversations: [{
      id: 'direct', title, initials: 'CS', unreadCount: 0, latestMessage: preview,
      createdAt: '2026-11-20T16:00:00Z', updatedAt: '2026-11-20T16:00:00Z',
    }] }, [{ id: 'channel', name: title, topic: preview, unread: 0, messages: [] }]).rows;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ primary: title, secondary: preview, kind: 'direct', href: '/conversation/direct' }),
      expect.objectContaining({ primary: title, secondary: preview, kind: 'channel', href: '/channel/channel' }),
    ]));
  });
  it('retains a distinct message preview and member-written punctuation', () => {
    const [row] = messagesWorkWidgetModel(dashboard, [{ id: 'thread', name: '#21 — Chapter news', topic: 'A new date', unread: 1, messages: [] }]).rows;
    expect(row?.primary).toBe('#21 — Chapter news');
    expect(row?.secondary).toBe('A new date');
  });
});
