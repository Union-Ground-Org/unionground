// @vitest-environment jsdom
import { createContext, useContext } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HatKey } from '../../lib/hatFunctions';
import type { HomeTakeover } from '../../lib/memberHomeShared';
import type { AppMode } from '../../state/AppProvider';
import { useSharedDemoVisit } from '../../state/useSharedDemoVisit';
import { press, render, type Rendered } from '../../testing/reactNativeStandIn';
import { HomeTakeoverCards } from './HomeTakeoverCards';

const VisitContext = createContext<ReturnType<typeof useSharedDemoVisit>>(null);

const port = vi.hoisted(() => ({
  mode: 'authenticated' as AppMode,
  sampleHat: null as HatKey | null,
  liveSampleBackend: false,
  session: null as { user: { id: string }; access_token: string } | null,
  dashboardReady: true,
  load: vi.fn(),
  markConversationRead: vi.fn(),
  markMemberBroadcastRead: vi.fn(),
  refresh: vi.fn(),
  writer: {},
}));

vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../components/ui', () => import('../../testing/uiStandIn'));
vi.mock('../../theme/ThemeProvider', async () => {
  const { defaultThemeKey, resolveTheme } = await import('../../theme/tokens');
  return { useTheme: () => resolveTheme(defaultThemeKey) };
});
vi.mock('../../state/AppProvider', () => ({
  useApp: () => ({
    mode: port.mode,
    sampleHat: port.sampleHat,
    sharedDemoVisit: useContext(VisitContext),
    liveSampleBackend: port.liveSampleBackend,
    session: port.session,
    refresh: port.refresh,
    captureAuthenticatedSessionGuard: () => () => true,
  }),
}));
vi.mock('../../services/haptics', () => ({ haptics: { success: vi.fn() } }));
vi.mock('../../services/memberHome', () => ({
  loadMemberHomeTakeover: port.load,
  markMemberBroadcastRead: port.markMemberBroadcastRead,
}));
vi.mock('../../services/supabase', () => ({
  captureSessionWriter: () => port.writer,
  markConversationRead: port.markConversationRead,
}));

const takeover: HomeTakeover = {
  enabled: true,
  message: {
    id: 'message-a', conversationId: 'conversation-a', senderName: 'Avery',
    body: 'Fixture committee member message', truncated: false, createdAt: '2026-11-23T16:00:00Z',
  },
  broadcast: {
    id: 'broadcast-a', title: 'Fixture campaign announcement', body: 'Fixture announcement body',
    sender: null, truncated: false, publishedAt: '2026-11-23T16:00:00Z', audience: 'chapter',
  },
};
let screen: Rendered | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  port.mode = 'authenticated';
  port.dashboardReady = true;
  port.sampleHat = null;
  port.liveSampleBackend = false;
  port.session = { user: { id: 'fixture-member' }, access_token: 'fixture-token' };
  port.load.mockResolvedValue(takeover);
});

afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
});

function markReadButtons() {
  return Array.from(screen!.container.querySelectorAll('[role="button"][aria-label="Mark read"]'));
}

function HomePage() {
  const visit = useSharedDemoVisit(port.mode, port.session?.user.id, port.sampleHat);
  return (
    <VisitContext.Provider value={visit}>
      {port.mode === 'authenticated' && port.dashboardReady ? <HomeTakeoverCards /> : null}
    </VisitContext.Provider>
  );
}

describe('native Home takeover read marks', () => {
  it.each([
    { index: 0, dismissed: 'Fixture committee member message', remaining: 'Fixture campaign announcement' },
    { index: 1, dismissed: 'Fixture campaign announcement', remaining: 'Fixture committee member message' },
  ])('dismisses "$dismissed" on a shared demo account without writing or refreshing', async ({ index, dismissed, remaining }) => {
    port.sampleHat = 'member';
    port.liveSampleBackend = true;
    screen = await render(<HomePage />);
    const buttons = markReadButtons();
    expect(buttons).toHaveLength(2);

    await press(buttons[index]!);
    expect(screen.container.textContent).not.toContain(dismissed);
    expect(screen.container.textContent).toContain(remaining);
    expect(markReadButtons()).toHaveLength(1);

    expect(port.markConversationRead).not.toHaveBeenCalled();
    expect(port.markMemberBroadcastRead).not.toHaveBeenCalled();
    expect(port.refresh).not.toHaveBeenCalled();
    expect(port.load).toHaveBeenCalledTimes(1);
  });

  it('keeps a shared demo dismissal from hiding the next account’s card', async () => {
    port.sampleHat = 'member';
    port.liveSampleBackend = true;
    screen = await render(<HomePage />);
    const [button] = markReadButtons();
    expect(button).toBeDefined();
    await press(button!);
    expect(screen.container.textContent).not.toContain('Fixture committee member message');

    port.sampleHat = null;
    port.session = { user: { id: 'fixture-next-member' }, access_token: 'fixture-next-token' };
    await screen.rerender(<HomePage />);
    expect(screen.container.textContent).toContain('Fixture committee member message');
  });

  it.each(['foreground resume', 'campaign switch'])('keeps both read marks through a %s', async (transition) => {
    port.sampleHat = 'member';
    port.liveSampleBackend = true;
    screen = await render(<HomePage />);
    const buttons = markReadButtons();
    expect(buttons).toHaveLength(2);
    await press(buttons[0]!);
    await press(buttons[1]!);
    expect(markReadButtons()).toHaveLength(0);

    port.dashboardReady = false;
    if (transition === 'foreground resume') {
      port.mode = 'booting';
      port.sampleHat = null;
    }
    await screen.rerender(<HomePage />);
    expect(screen.container.textContent).toBe('');
    port.dashboardReady = true;
    port.mode = 'authenticated';
    port.sampleHat = 'member';
    await screen.rerender(<HomePage />);

    expect(port.load).toHaveBeenCalledTimes(2);
    expect(markReadButtons()).toHaveLength(0);
    expect(port.markConversationRead).not.toHaveBeenCalled();
    expect(port.markMemberBroadcastRead).not.toHaveBeenCalled();
    expect(port.refresh).not.toHaveBeenCalled();
  });

  it.each(['sign out', 'different user', 'different persona'])('shows unread cards again after %s', async (transition) => {
    port.sampleHat = 'member';
    port.liveSampleBackend = true;
    screen = await render(<HomePage />);
    const buttons = markReadButtons();
    expect(buttons).toHaveLength(2);
    await press(buttons[0]!);
    await press(buttons[1]!);
    expect(markReadButtons()).toHaveLength(0);

    const previousSession = port.session;
    if (transition === 'sign out') {
      port.mode = 'signedOut';
      port.session = null;
      port.sampleHat = null;
    } else if (transition === 'different user') {
      port.session = { user: { id: 'fixture-next-member' }, access_token: 'fixture-next-token' };
    } else {
      port.sampleHat = 'steward';
    }
    await screen.rerender(<HomePage />);
    expect(markReadButtons()).toHaveLength(transition === 'sign out' ? 0 : 2);
    port.mode = 'authenticated';
    port.session = previousSession;
    port.sampleHat = 'member';
    await screen.rerender(<HomePage />);
    expect(markReadButtons()).toHaveLength(2);
  });

  it.each([
    { interruption: 'same user', restoredCards: 0 },
    { interruption: 'sign-out', restoredCards: 2 },
    { interruption: 'another user', restoredCards: 2 },
  ])('restores $restoredCards cards after a failed session check with $interruption', async ({ interruption, restoredCards }) => {
    port.sampleHat = 'member';
    port.liveSampleBackend = true;
    screen = await render(<HomePage />);
    const buttons = markReadButtons();
    expect(buttons).toHaveLength(2);
    await press(buttons[0]!);
    await press(buttons[1]!);
    expect(markReadButtons()).toHaveLength(0);

    const previousSession = port.session;
    port.dashboardReady = false;
    port.sampleHat = null;
    port.mode = 'booting';
    await screen.rerender(<HomePage />);
    port.mode = 'mfaRequired';
    await screen.rerender(<HomePage />);
    expect(screen.container.textContent).toBe('');

    if (interruption === 'sign-out') {
      port.mode = 'signedOut';
      port.session = null;
      await screen.rerender(<HomePage />);
    } else if (interruption === 'another user') {
      // The provider can publish a replacement account while still restricted.
      port.session = { user: { id: 'fixture-next-member' }, access_token: 'fixture-next-token' };
      await screen.rerender(<HomePage />);
    }

    // The original user returns. A sign-out or a replacement during the
    // challenge must have dropped the old marks before authentication returns.
    port.session = previousSession;
    port.mode = 'booting';
    await screen.rerender(<HomePage />);
    port.mode = 'authenticated';
    port.sampleHat = 'member';
    port.dashboardReady = true;
    await screen.rerender(<HomePage />);

    expect(port.load).toHaveBeenCalledTimes(2);
    expect(markReadButtons()).toHaveLength(restoredCards);
    expect(port.markConversationRead).not.toHaveBeenCalled();
    expect(port.markMemberBroadcastRead).not.toHaveBeenCalled();
    expect(port.refresh).not.toHaveBeenCalled();
  });

  it.each([false, true])('saves both marks and refreshes for an ordinary account (SAMPLE backend: %s)', async (liveSampleBackend) => {
    port.liveSampleBackend = liveSampleBackend;
    screen = await render(<HomePage />);
    const buttons = markReadButtons();
    expect(buttons).toHaveLength(2);

    await press(buttons[0]!);
    await press(buttons[1]!);

    expect(port.markConversationRead).toHaveBeenCalledExactlyOnceWith(port.writer, 'fixture-member', 'conversation-a');
    expect(port.markMemberBroadcastRead).toHaveBeenCalledExactlyOnceWith('fixture-member', 'broadcast-a');
    expect(port.refresh).toHaveBeenCalledTimes(2);
    expect(markReadButtons()).toHaveLength(0);
  });
});
