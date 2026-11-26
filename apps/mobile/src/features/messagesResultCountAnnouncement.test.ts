// @vitest-environment jsdom
import { act, createElement as h, StrictMode, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A11Y-UG-FOCUS-AND-ACCESSIBLE-NAME-GAPS-FROM-REVIEWS-20261117
// : the real Messages screen, mounted on
// iOS with drawing, preferences, routing and the task-discussion transport
// replaced. Its result count is spoken after the member's own search change,
// including a clear back to the empty search, and never for a background
// refresh. Harness derived from messageWorkflowPreference.test.ts.
const fixture = vi.hoisted(() => ({
  values: new Map<string, string>(),
  change: (_text: string) => undefined as void,
  items: [] as Array<{ taskID: string; title: string; reference: string; latestAt: string; latestPreview: string; latestFromYou: boolean }>,
  announce: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => fixture.values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { fixture.values.set(key, value); }),
}));
vi.mock('../features/guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ setParams: vi.fn() }), useIsFocused: () => true, useRouter: () => ({ push: vi.fn() }), Redirect: () => null, useLocalSearchParams: () => ({}) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../components/MessageWorkflowPicker', () => ({ MessageWorkflowPicker: () => null }));
vi.mock('../components/RowHighlight', () => ({ HighlightList: () => null, HighlightRow: () => null }));
vi.mock('../components/SupportLink', () => ({ SupportLink: () => null }));
vi.mock('../components/TaskDiscussionsSection', () => ({ TaskDiscussionsSection: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), initialWindowMetrics: null })); // the Messages organize sheet pads the window's safe area (#9608)
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 0 }));
// Public Messages is a pushed screen inside the pinned header, whose frosted
// chrome loads a native module; these cases render only the inbox body.
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children: unknown }) => children }));
vi.mock('../services/haptics', () => ({ haptics: {} }));
vi.mock('../features/useTaskDiscussions', () => ({ useTaskDiscussions: () => ({ items: fixture.items, failed: false }) }));
vi.mock('../services/supabase', () => ({ startMemberConversation: vi.fn() }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ dashboard: { conversations: [] }, mode: 'authenticated',
  session: { user: { id: 'fixture-member' } }, authorizedRoles: [], refreshing: false, refresh: vi.fn() }) }));
vi.mock('../data/useChannels', () => {
  const store = { channels: () => [], status: () => 'ready', loadFault: () => null,
    subscribe: () => () => undefined, getVersion: () => 0 };
  return { useChannelStore: () => store };
});
vi.mock('../data/channelControls', () => ({ useChannelControls: () => ({ controls: { switches: { channelPinning: false } } }) }));
vi.mock('../components/ui', async () => {
  const { createElement } = await import('react');
  const element = ({ children }: PropsWithChildren) => createElement('div', null, children);
  return { Avatar: element, Body: element, Card: element, Heading: element, Notice: element, Screen: element,
    SearchField: ({ onChangeText }: { onChangeText: (text: string) => void }) => { fixture.change = onChangeText; return null; },
    StateMessage: ({ title }: { title: string }) => createElement('div', null, title),
    Button: ({ label, onPress }: { label: string; onPress: () => void }) => createElement('button', { onClick: onPress }, label) };
});
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const element = ({ children }: PropsWithChildren) => createElement('div', null, children);
  return { AccessibilityInfo: { announceForAccessibility: (message: string) => fixture.announce(message) }, Platform: { OS: 'ios' },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Pressable: element, ScrollView: element, Text: element, View: element, TextInput: () => null };
});

import MessagesScreen from '../../app/messages';

const onboardingKey = `org.unionground.app.messaging-workflow-onboarded-v1.${Array.from('fixture-member', char => char.codePointAt(0)!.toString(16)).join('-')}`;
const discussion = { taskID: 'fixture-task', title: 'Final discussion', reference: 'CHAPTER-1', latestAt: '2026-11-17T17:00:00.000Z', latestPreview: 'A task message', latestFromYou: false };

let root: Root;
let container: HTMLDivElement;
const mount = () => act(async () => { root.render(h(StrictMode, null, h(MessagesScreen))); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  fixture.values.clear();
  fixture.values.set(onboardingKey, 'complete');
  fixture.items = [];
  fixture.announce.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('mounted Messages result count announcement on iOS', () => {
  it('review: iOS announces the restored query count', async () => {
    await mount();
    await act(async () => { fixture.change('x'); });
    await wait(100);
    fixture.items = [discussion];
    await act(async () => { fixture.change(''); });
    await wait(450);
    expect(container.textContent).toContain('1 result');
    expect(fixture.announce).toHaveBeenCalledExactlyOnceWith('1 result');
  });

  it('says nothing when a background refresh changes the count', async () => {
    await mount();
    await wait(1_000);
    fixture.items = [discussion];
    await mount();
    await wait(1_000);
    expect(container.textContent).toContain('1 result');
    expect(fixture.announce).not.toHaveBeenCalled();
  });
});
