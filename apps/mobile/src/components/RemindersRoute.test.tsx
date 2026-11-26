// @vitest-environment jsdom
import { createElement as h, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, View, Text, Pressable, type Rendered } from '../testing/reactNativeStandIn';
import type { ConnectedReminder } from '../lib/connectedWorkflows';

const port = vi.hoisted(() => ({
  language: 'en', list: vi.fn(), update: vi.fn(), history: vi.fn(), push: vi.fn(),
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('expo-router', () => ({ Redirect: () => null, useRouter: () => ({ push: port.push }) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ mode: 'authenticated', session: { user: { id: 'member-a' } }, organizationID: 'org-a', authorizedRoles: [], chapterRoles: [], organizationRoles: [], dashboard: { member: { chapterID: 'chapter-a', language: port.language } } }) }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => ({}) }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => ({ listReminders: port.list, updateReminder: port.update }) }));
vi.mock('../../../../src/features/messaging/remindHere.js', () => ({ listChannelHereReminders: port.history }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: PropsWithChildren) => h(View, null, children) }));
vi.mock('../components/ReminderPicker', () => ({ ReminderPicker: () => null }));
vi.mock('../components/ui', () => ({
  Screen: ({ children }: PropsWithChildren) => h(View, null, children),
  Card: ({ children }: PropsWithChildren) => h(View, { testID: 'reminder-card' }, children),
  Heading: ({ children }: PropsWithChildren) => h(Text, { accessibilityRole: 'header' }, children),
  Body: ({ children }: PropsWithChildren) => h(Text, null, children),
  StateMessage: ({ title, body }: { title: string; body: string }) => h(Text, null, title, body),
  Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => h(Pressable, { accessibilityLabel: label, onPress, disabled }, h(Text, null, label)),
}));

import RemindersRoute from '../../app/reminders';

const reminder = (id: string, fields: Partial<ConnectedReminder> = {}): ConnectedReminder => ({
  id, kind: 'event', sourceId: id, remindAt: '2026-11-19T15:00:00Z', note: '',
  status: 'scheduled', snoozeCount: 0, completedAt: null, createdAt: '', updatedAt: '',
  available: true, sourceState: 'available', href: '/m/events', title: null, ...fields,
});
let screen: Rendered | null = null;
beforeEach(() => {
  vi.clearAllMocks(); port.language = 'en'; port.history.mockResolvedValue([]);
  port.list.mockResolvedValue({ items: [], nextCursor: null });
  port.update.mockResolvedValue({ available: false });
});
afterEach(async () => { await screen?.unmount(); screen = null; vi.unstubAllEnvs(); setPlatform('ios'); });

describe.each(['ios', 'android'] as const)('Reminders context on %s', (os) => {
  it('distinguishes two meeting reminders by their source titles and preserves their notes and actions', async () => {
    setPlatform(os);
    vi.stubEnv('TZ', 'America/New_York');
    port.list.mockResolvedValue({ items: [
      reminder('shift', { title: 'Quillmere shift meeting', note: 'Bring the schedule proposal' }),
      reminder('safety', { title: 'Quillmere safety meeting', note: 'Bring the inspection notes' }),
    ], nextCursor: null });
    screen = await render(h(RemindersRoute));
    const cards = screen.container.querySelectorAll<HTMLElement>('[data-testid="reminder-card"]');
    expect(cards).toHaveLength(2);
    expect(cards.item(0).textContent).toContain('Quillmere shift meeting');
    expect(cards.item(0).textContent).toContain('Bring the schedule proposal');
    expect(cards.item(1).textContent).toContain('Quillmere safety meeting');
    expect(cards.item(1).textContent).toContain('Bring the inspection notes');
    expect(cards.item(0).textContent).toMatch(/10:00\sAM · ET/);
    await press(getExposed(cards.item(0), 'Open original'));
    expect(port.update).toHaveBeenCalledWith('shift', 'open', undefined);
  });

  it('shows a valid stored reminder time when Intl cannot name the zone', async () => {
    setPlatform(os);
    vi.stubEnv('TZ', 'America/New_York');
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([]);
    try {
      port.list.mockResolvedValue({ items: [
        reminder('valid', { remindAt: '2026-11-19 15:00:00.123456+00' }),
        reminder('invalid', { remindAt: 'unreadable' }),
      ], nextCursor: null });
      screen = await render(h(RemindersRoute));
      const cards = screen.container.querySelectorAll<HTMLElement>('[data-testid="reminder-card"]');
      expect(cards.item(0).textContent).toMatch(/Nov 19, 2026, 10:00\sAM/);
      expect(cards.item(0).textContent).not.toMatch(/Time unavailable| · /);
      expect(cards.item(1).textContent).toContain('Time unavailable');
    } finally {
      parts.mockRestore();
    }
  });

  it.each(['en', 'es'])('uses honest %s fallbacks for missing or unavailable metadata while retaining a worker note', async (language) => {
    setPlatform(os); port.language = language;
    port.list.mockResolvedValue({ items: [
      reminder('untitled', { title: '  ' }),
      reminder('removed', { available: false, title: 'Stale source title', note: 'My retained note' }),
    ], nextCursor: null });
    screen = await render(h(RemindersRoute));
    const cards = screen.container.querySelectorAll<HTMLElement>('[data-testid="reminder-card"]');
    expect(cards.item(0).textContent).toContain(language === 'es' ? 'Recordatorio' : 'Reminder');
    expect(cards.item(1).textContent).toContain(language === 'es' ? 'Origen no disponible' : 'Original unavailable');
    expect(cards.item(1).textContent).toContain('My retained note');
    expect(screen.container.textContent).not.toContain('Stale source title');
  });

  it('keeps channel context, deduplicates owned history and offers only channel management actions', async () => {
    setPlatform(os);
    port.list.mockResolvedValue({ items: [reminder('channel', { kind: 'channel_here', title: 'shift-team', note: 'Channel note' })], nextCursor: null });
    port.history.mockResolvedValue([
      { id: 'channel', mine: true, spaceName: 'shift-team', note: 'Channel note' },
      { id: 'received', mine: false, authorName: 'Alex', spaceName: 'shift-team', note: 'Received note' },
    ]);
    screen = await render(h(RemindersRoute));
    const cards = screen.container.querySelectorAll<HTMLElement>('[data-testid="reminder-card"]');
    expect(cards).toHaveLength(2);
    expect(screen.container.textContent?.match(/Channel note/g)).toHaveLength(1);
    expect(screen.container.textContent).toContain('#shift-team');
    expect(screen.container.textContent).toContain('Received note');
    expect(screen.container.textContent).not.toContain('Open original');
    expect(screen.container.textContent).not.toContain('Snooze');
    await press(getExposed(screen.container, 'Complete'));
    expect(port.update).toHaveBeenCalledWith('channel', 'complete', undefined);
  });
});

// BUG-UG-PHONE-CHANNEL-REMINDERS-AND-QUESTION-QUEUE-FAILED-READ-LOOKS-EMPTY-20261125
// (#9941, carved from #9465): when the channel staff reminders failed to load,
// the "For channel staff" heading and its reminders vanished, as if there were none.
const CHANNEL_FAILURE_CASES: Array<[string, string, string, string]> = [
  ['en', 'For channel staff', 'Channel staff reminders could not be loaded.', 'Try again'],
  ['es', 'Para el equipo del canal', 'No se pudieron cargar los recordatorios del equipo del canal.', 'Reintentar'],
];
describe.each(CHANNEL_FAILURE_CASES)('a failed channel reminder read, in %s', (language, heading, failed, retry) => {
  it('says the channel reminders could not be loaded and loads them on Try again', async () => {
    port.language = language;
    port.history.mockRejectedValueOnce(new Error('fixture offline')).mockResolvedValue([
      { id: 'received', mine: false, authorName: 'Alex', spaceName: 'shift-team', note: 'Received note' },
    ]);
    screen = await render(h(RemindersRoute));
    expect(screen.container.textContent).toContain(heading);
    expect(screen.container.textContent).toContain(failed);
    expect(screen.container.textContent).not.toContain('Received note');
    expect(port.list).toHaveBeenCalledTimes(1);
    await press(getExposed(screen.container, retry));
    expect(port.history).toHaveBeenCalledTimes(2);
    // Only the channel read runs again; the person's own reminders are not re-read.
    expect(port.list).toHaveBeenCalledTimes(1);
    expect(screen.container.textContent).toContain('Received note');
    expect(screen.container.textContent).not.toContain(failed);
  });

  it('keeps the section away when the channel read answers with none', async () => {
    port.language = language;
    screen = await render(h(RemindersRoute));
    expect(screen.container.textContent).not.toContain(heading);
    expect(screen.container.textContent).not.toContain(failed);
  });
});
