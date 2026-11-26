// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import type { MemberDashboard } from '../models/member';
import { MEMBER_WORK_WIDGETS, STAFF_HAT_FUNCTIONS } from '../lib/hatFunctions';
import { nativeCatalogLabel } from '../lib/nativeUiCopy';

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099 part 4, review R-9235 R3): Invitations remain readable and reachable
// in Spanish. K2 omits the body because its rows are read on the full screen.

const routePush = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('./ui', () => import('../testing/uiStandIn'));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: routePush }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('./FunctionDeck', () => ({ functionIcons: { mail: 'mail' } }));
vi.mock('./NumberFlow', () => ({ NumberFlow: () => null }));
vi.mock('./RowHighlight', () => ({ HighlightList: ({ children }: { children: unknown }) => children, HighlightRow: ({ children }: { children: unknown }) => children }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));

import { WorkWidgets } from './WorkWidgets';

const dashboard: MemberDashboard = {
  member: { id: 'officer', firstName: 'Sam', fullName: 'Sam Okafor', initials: 'SO', roleLine: 'Campaign Administrator', memberSince: 2022, chapterID: null, language: 'es' },
  cases: [], weeklyActions: [], notifications: [], conversations: [],
};
const english = 'Invitations are listed on the full screen.';
let view: Rendered | null = null;

afterEach(async () => {
  await view?.unmount();
  view = null;
  setPlatform('ios');
  routePush.mockClear();
});

it.each<'en' | 'es'>(['es', 'en'])('opens Invitations from its localized header without a placeholder body (%s)', async (language) => {
  const item = STAFF_HAT_FUNCTIONS.admin.find((row) => row.key === 'chapter-invitations');
  if (!item) throw new Error('the Admin list has no Invitations row');
  const shown = { ...item, label: nativeCatalogLabel(language, item.label), blurb: item.blurb ? nativeCatalogLabel(language, item.blurb) : item.blurb };
  view = await render(h(WorkWidgets, { dashboard, desk: null, items: [shown], language }));
  const text = view.container.textContent ?? '';
  expect(text).toBe(shown.label);
  expect(text).not.toContain(english);
  expect(text).not.toContain(nativeCatalogLabel('es', english));
  const header = view.container.querySelector(`[role="button"][aria-label="${shown.label}"]`);
  expect(header).not.toBeNull();
  await press(header!);
  expect(routePush).toHaveBeenLastCalledWith(item.href);
});


// #9317 R1: removing a decorative # must not make different destinations
// indistinguishable. Authored title and preview intentionally match here.
it.each<{ language: 'en' | 'es'; os: 'ios' | 'android' }>([
  { language: 'en', os: 'ios' }, { language: 'es', os: 'ios' },
  { language: 'en', os: 'android' }, { language: 'es', os: 'android' },
])('distinguishes matching channel/private rows visibly and accessibly in $language on $os', async ({ language, os }) => {
  setPlatform(os);
  const item = MEMBER_WORK_WIDGETS.find((row) => row.key === 'messages');
  if (!item) throw new Error('Messages widget missing');
  const title = 'Campaign committee member';
  const preview = 'Meeting tomorrow';
  const directKind = language === 'es' ? 'Conversación privada' : 'Private conversation';
  const channelKind = language === 'es' ? 'Canal' : 'Channel';
  view = await render(h(WorkWidgets, { desk: null,
    dashboard: { ...dashboard, conversations: [{
      id: 'direct-id', title, initials: 'CS', unreadCount: 0,
      createdAt: '2026-11-20T16:00:00Z', updatedAt: '2026-11-20T16:00:00Z', latestMessage: preview,
    }] },
    channels: [{ id: 'channel-id', name: title, unread: 0, topic: preview, messages: [] }],
    items: [item], language,
  }));
  const direct = getExposed(view.container, `${title}. ${directKind}. ${preview}`);
  const channel = getExposed(view.container, `${title}. ${channelKind}. ${preview}`);
  // Inspect rendered text as well as accessible names: a hidden a11y label
  // alone would still leave the visible collision untouched.
  expect(direct.textContent).toBe(`${title}${directKind}${preview}`);
  expect(channel.textContent).toBe(`${title}${channelKind}${preview}`);
  expect(channel.textContent).not.toBe(direct.textContent);
  expect(channel.textContent).not.toContain(`# ${title}`);
  await press(channel);
  expect(routePush).toHaveBeenLastCalledWith('/channel/channel-id');
  await press(direct);
  expect(routePush).toHaveBeenLastCalledWith('/conversation/direct-id');
});

// Combined #9325/#9323 tree: message destination markers must not leak into
// the staff reader's metric rows or restore the duplicate My reports body.
it.each<{ language: 'en' | 'es'; os: 'ios' | 'android' }>([
  { language: 'en', os: 'ios' }, { language: 'es', os: 'ios' },
  { language: 'en', os: 'android' }, { language: 'es', os: 'android' },
])('keeps staff summaries unmarked beside marked Messages rows in $language on $os', async ({ language, os }) => {
  setPlatform(os);
  const desk = STAFF_HAT_FUNCTIONS.coordinator.find((row) => row.key === 'coordinator');
  const reports = MEMBER_WORK_WIDGETS.find((row) => row.key === 'numbers');
  const messages = MEMBER_WORK_WIDGETS.find((row) => row.key === 'messages');
  if (!desk || !reports || !messages) throw new Error('Combined Work widgets missing');
  const label = nativeCatalogLabel(language, 'Open issues');
  const directKind = language === 'es' ? 'Conversación privada' : 'Private conversation';
  const channelKind = language === 'es' ? 'Canal' : 'Channel';
  const title = 'Campaign staff';
  const preview = 'Tomorrow';
  view = await render(h(WorkWidgets, { desk: null,
    dashboard: { ...dashboard, conversations: [{
      id: 'staff-direct', title, initials: 'CS', unreadCount: 0, latestMessage: preview,
      createdAt: '2026-11-20T16:00:00Z', updatedAt: '2026-11-20T16:00:00Z',
    }] },
    channels: [{ id: 'staff-channel', name: title, unread: 0, topic: preview, messages: [] }],
    items: [desk, reports, messages].map((row) => ({ ...row, label: nativeCatalogLabel(language, row.label) })),
    staffRole: 'coordinator', staffNumbers: [{ label: 'Open issues', value: 163 }], language,
  }));
  const metric = getExposed(view.container, `163. ${label}`);
  expect(metric.textContent).toBe(`163${label}`);
  expect(metric.textContent).not.toContain(channelKind);
  expect(metric.textContent).not.toContain(directKind);
  expect(view.container.querySelectorAll(`[aria-label="163. ${label}"]`)).toHaveLength(1);
  getExposed(view.container, `${title}. ${directKind}. ${preview}`);
  getExposed(view.container, `${title}. ${channelKind}. ${preview}`);
  await press(getExposed(view.container, nativeCatalogLabel(language, reports.label)));
  expect(routePush).toHaveBeenLastCalledWith(reports.href);
});
