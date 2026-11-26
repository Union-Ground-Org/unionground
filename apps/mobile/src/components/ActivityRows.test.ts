// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberNotification } from '../models/member';
import NotificationsScreen from '../../app/notifications';

const mocks = vi.hoisted(() => ({
  notifications: [] as MemberNotification[],
  memberLanguage: undefined as 'en' | 'es' | undefined,
  setRead: vi.fn<(id: string, read: boolean, options?: { silent?: boolean }) => Promise<void>>(),
  select: vi.fn(async () => {}),
  push: vi.fn(),
}));

type HostProps = { children?: ReactNode; accessibilityLabel?: string; disabled?: boolean; onPress?: () => void };
vi.mock('react-native', () => {
  const View = ({ children, accessibilityLabel }: HostProps) => createElement('div', { 'aria-label': accessibilityLabel }, children);
  return {
    View, Text: View, useWindowDimensions: () => ({ fontScale: 1 }),
    Pressable: ({ children, accessibilityLabel, disabled, onPress }: HostProps) =>
      createElement('button', { 'aria-label': accessibilityLabel, disabled, onClick: onPress }, children),
    Platform: { select: (options: { ios: string }) => options.ios },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ Redirect: () => null, useRouter: () => ({ push: mocks.push }) }));
vi.mock('../services/haptics', () => ({ haptics: { select: mocks.select } }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  dashboard: { member: { language: 'en' }, notifications: mocks.notifications },
  memberLanguage: mocks.memberLanguage,
  mode: 'authenticated', setNotificationRead: mocks.setRead,
}) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('./PinnedHeader', () => ({
  PinnedHeaderScreen: ({ children }: HostProps) => createElement('main', null, children),
  useScreenNameAlreadySpoken: () => ({ duplicate: true, hiddenProps: {} }),
}));
vi.mock('./ui', () => {
  const Wrapper = ({ children }: HostProps) => createElement('div', null, children);
  return { Body: Wrapper, Card: Wrapper, Group: Wrapper, GroupRow: Wrapper, Notice: Wrapper, Screen: Wrapper, StateMessage: Wrapper };
});

// Two separately dated records with the exact copy in the retained iPhone
// updates.json tree. IDs are local fixtures; no hosted data is read or changed.
const result: MemberNotification = {
  id: 'ballot-result-sep24', kind: 'votes', title: 'Vote results are in',
  body: 'Results are available for a recent vote. Open Voice to see them.',
  createdAt: '2026-09-24T10:15:00-04:00', readAt: null, href: '/feature/voting',
};
const older: MemberNotification = { ...result, id: 'ballot-result-sep1', createdAt: '2026-09-01T00:30:00-04:00' };

// Run the actual provider callback: a fake setRead would miss its per-ID
// haptics. Only native feedback and the backend write are replaced here.
const providerSource = readFileSync(new NodeURL('../state/AppProvider.tsx', import.meta.url), 'utf8');
const providerTree = ts.createSourceFile('AppProvider.tsx', providerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let readCallback = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(providerTree) === 'setNotificationRead'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    readCallback = node.initializer.arguments[0]!.getText(providerTree);
  }
  ts.forEachChild(node, visit);
}
visit(providerTree);
function providerRead(mode: 'preview' | 'authenticated' = 'preview') {
  type Dashboard = { member: { id: string }; notifications: MemberNotification[] };
  return runInNewContext(ts.transpile(`(${readCallback})`, { target: ts.ScriptTarget.ES2022 }), {
    get dashboard() { return { notifications: mocks.notifications }; },
    mode, session: { user: { id: 'offline-member' } }, haptics: { select: mocks.select },
    captureSessionWriter: () => ({ userId: 'offline-member', check: async () => 'current' }),
    captureAccountSessionGuard: () => () => true,
    currentReadChapter: () => 'chapter-a', profileSaveOwnership: { current: { owner: { scope: 'chapter-a' } } },
    providerMounted: { current: true },
    setDashboard: (update: (current: Dashboard) => Dashboard | null) => {
      mocks.notifications = update({ member: { id: 'offline-member' }, notifications: mocks.notifications })?.notifications ?? [];
    },
    setNotificationReadState: async (_writer: unknown, _userID: string, id: string, read: boolean) => {
      const item = mocks.notifications.find(item => item.id === id);
      if (!item) throw new Error('unavailable');
      return { ...item, readAt: read ? '2026-10-17T12:00:00-04:00' : null };
    },
  }) as (id: string, read: boolean, options?: { silent?: boolean }) => Promise<void>;
}
let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => { root.render(createElement(NotificationsScreen)); });
}
function buttons(prefix: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .filter(node => node.getAttribute('aria-label')?.startsWith(prefix));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.memberLanguage = undefined;
  mocks.notifications = [result, older];
  mocks.push.mockClear();
  mocks.select.mockClear();
  mocks.setRead.mockReset().mockImplementation(providerRead());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Activity row identity', () => {
  it('shows the evidence-shaped vote notices once with their count and date range', async () => {
    await render();
    expect(buttons('Mark Vote results are in read')).toHaveLength(1);
    expect(container.textContent).toContain('2 updates');
    expect(container.textContent).toContain('Sep 1');
    expect(container.textContent).toContain('Sep 24');
    expect(buttons('Vote results are in, unread')[0]?.getAttribute('aria-label')).toContain('2 updates');
  });

  it('renders known system notices and grouped counts in Spanish while keeping authored text', async () => {
    mocks.memberLanguage = 'es';
    mocks.notifications = [
      result, older,
      { ...result, id: 'appointment', kind: 'appointments', title: 'One-on-one coming up',
        body: 'You have a one-on-one within the next day. Open One-on-ones for the details.', href: '/feature/appointments' },
      { ...result, id: 'new-message', kind: 'messages', title: 'New message', body: 'You have a new message in Union Ground.' },
      { ...result, id: 'form', kind: 'forms', title: 'Form approved',
        body: 'Safety intake — reviewed and approved by the committee. Your Union Base official filing copy is ready to download.' },
      { ...result, id: 'authored', kind: 'general', title: 'New message', body: 'The picnic is still on.' },
    ];
    await render();
    for (const text of ['Cita próxima', 'Abre Citas para ver los detalles.', 'Nuevo mensaje',
      'Tienes un mensaje nuevo en Union Ground.', 'Formulario aprobado', 'Safety intake',
      'Los resultados de la votación ya están disponibles', '2 novedades', 'The picnic is still on.']) {
      expect(container.textContent).toContain(text);
    }
    expect(container.textContent).not.toMatch(/Appointment coming up|within the next day|Form approved|Your Union Base|Ballot results are in|2 updates/);
    expect(buttons('Cita próxima, sin leer')).toHaveLength(1);
    expect(buttons('New message, sin leer, The picnic is still on.')).toHaveLength(1);
  });

  const modes: Array<'preview' | 'authenticated'> = ['preview', 'authenticated'];
  it.each(modes)('preserves feedback for existing single-ID callers in %s', async mode => {
    await providerRead(mode)(result.id, true);
    expect(mocks.notifications.find(item => item.id === result.id)?.readAt).toBeTruthy();
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it.each(modes)('emits one haptic per grouped read/unread action in %s', async mode => {
    mocks.setRead.mockImplementation(providerRead(mode));
    await render();
    await act(async () => { buttons('Mark Vote results are in read')[0]!.click(); });
    expect(mocks.notifications.every(item => item.readAt)).toBe(true);
    expect(mocks.select).toHaveBeenCalledTimes(1);
    await render();
    expect(buttons('Mark Vote results are in unread')).toHaveLength(1);
    await act(async () => { buttons('Mark Vote results are in unread')[0]!.click(); });
    expect(mocks.notifications.every(item => item.readAt === null)).toBe(true);
    expect(mocks.select).toHaveBeenCalledTimes(2);
  });

  it('opens the destination once and marks every grouped unread notice read', async () => {
    await render();
    await act(async () => { buttons('Vote results are in, unread')[0]!.click(); });
    expect(mocks.push.mock.calls).toEqual([['/feature/voting']]);
    expect(mocks.notifications.every(item => item.readAt)).toBe(true);
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it('keeps different bodies, kinds, destinations and read states independent', async () => {
    mocks.notifications = [result, older,
      { ...result, id: 'different-body', body: 'Another result is available.' },
      { ...result, id: 'different-kind', kind: 'cases' },
      { ...result, id: 'different-href', href: '/work' },
      { ...result, id: 'read', readAt: '2026-10-01T12:00:00-04:00' },
    ];
    await render();
    expect(buttons('Mark Vote results are in read')).toHaveLength(4);
    expect(buttons('Mark Vote results are in unread')).toHaveLength(1);
    await act(async () => { buttons('Show votes updates')[0]!.click(); });
    expect(buttons('Mark Vote results are in read')).toHaveLength(3);
  });

  it('does not count a repeated ID as another update', async () => {
    mocks.notifications = [result, result];
    await render();
    expect(buttons('Mark Vote results are in read')).toHaveLength(1);
    expect(container.textContent).not.toContain('2 updates');
  });

  it('keeps text-only notices grouped and includes both dates when data arrives oldest first', async () => {
    mocks.notifications = [{ ...older, href: undefined }, { ...result, href: undefined }];
    await render();
    expect(buttons('Mark Vote results are in read')).toHaveLength(1);
    expect(buttons('Vote results are in, unread')).toHaveLength(0);
    expect(container.textContent).toContain('2 updates');
    expect(container.textContent).toContain('Sep 1');
    expect(container.textContent).toContain('Sep 24');
  });

  it('disables repeat actions until every grouped read finishes', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    mocks.setRead.mockImplementation(async (id, read) => {
      await pending;
      mocks.notifications = mocks.notifications.map(item => item.id === id
        ? { ...item, readAt: read ? '2026-10-17T12:00:00-04:00' : null } : item);
    });
    await render();
    await act(async () => { buttons('Mark Vote results are in read')[0]!.click(); });
    expect(buttons('Mark Vote results are in read')[0]!.disabled).toBe(true);
    expect(buttons('Vote results are in, unread')[0]!.disabled).toBe(true);
    await act(async () => { release(); });
    expect(mocks.notifications.every(item => item.readAt)).toBe(true);
    await render();
    expect(buttons('Mark Vote results are in unread')[0]!.disabled).toBe(false);
  });

  it('keeps an unrelated row operable during a grouped save', async () => {
    mocks.notifications.push({ ...result, id: 'separate', title: 'Votes is open' });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const read = providerRead();
    mocks.setRead.mockImplementation(async (id, value, options) => {
      if (id === result.id) await pending;
      await read(id, value, options);
    });
    await render();
    await act(async () => { buttons('Mark Vote results are in read')[0]!.click(); });
    expect(buttons('Votes is open, unread')[0]!.disabled).toBe(false);
    await act(async () => { buttons('Votes is open, unread')[0]!.click(); });
    expect(mocks.notifications.find(item => item.id === 'separate')?.readAt).toBeTruthy();
    expect(buttons('Mark Vote results are in read')[0]!.disabled).toBe(true);
    await act(async () => { release(); });
    expect(mocks.notifications.every(item => item.readAt)).toBe(true);
  });

  it('finishes later IDs when an earlier group worker fails', async () => {
    mocks.notifications.push({ ...older, id: 'last' });
    const read = providerRead();
    mocks.setRead.mockImplementation(async (id, value, options) => {
      if (id === older.id) throw new Error('unavailable');
      await read(id, value, options);
    });
    await render();
    await act(async () => { buttons('Mark Vote results are in read')[0]!.click(); });
    expect(mocks.notifications.find(item => item.id === 'last')?.readAt).toBeTruthy();
    expect(mocks.notifications.find(item => item.id === older.id)?.readAt).toBeNull();
    expect(container.textContent).toContain('That update could not be changed.');
  });

  it('distinguishes years and avoids repeating the same displayed minute', async () => {
    mocks.notifications = [result, { ...older, createdAt: '2025-09-24T10:15:00-04:00' }];
    await render();
    expect(container.textContent).toContain('2025');
    expect(container.textContent).toContain('2026');
    mocks.notifications = [result, { ...older, createdAt: '2026-09-24T10:15:30-04:00' }];
    await render();
    expect(container.textContent).toContain('2 updates');
    expect(container.textContent).not.toContain(' – ');
  });

  it.each(modes)('keeps a failed final ID unread with one partial-success haptic in %s', async mode => {
    const update = providerRead(mode);
    mocks.setRead.mockImplementation(async (id, read, options) => {
      if (id === older.id) throw new Error('offline');
      await update(id, read, options);
    });
    await render();
    await act(async () => { buttons('Mark Vote results are in read')[0]!.click(); });
    expect(container.textContent).toContain('That update could not be changed.');
    expect(mocks.notifications.find(item => item.id === older.id)?.readAt).toBeNull();
    expect(mocks.select).toHaveBeenCalledTimes(1);
    await render();
    expect(buttons('Mark Vote results are in read')).toHaveLength(1);
    expect(buttons('Mark Vote results are in unread')).toHaveLength(1);
  });

  it('shows an error without success feedback when every ID fails', async () => {
    mocks.setRead.mockRejectedValue(new Error('offline'));
    await render();
    await act(async () => { buttons('Mark Vote results are in read')[0]!.click(); });
    expect(container.textContent).toContain('That update could not be changed.');
    expect(mocks.notifications.every(item => item.readAt === null)).toBe(true);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
