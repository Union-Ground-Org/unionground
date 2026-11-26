// @vitest-environment jsdom
import { act, createElement as h, StrictMode, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MessagesScreen from '../../app/messages';
import { messageWorkflowCopy, messageWorkflowKeys, type MessageWorkflow } from '../lib/messageWorkflow';
import * as workflowModule from '../lib/messageWorkflow';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import * as SecureStore from 'expo-secure-store';

const values = new Map<string, string>();
const sheetState = vi.hoisted(() => ({ focused: true, language: 'en' as 'en' | 'es', back: null as (() => void) | null, escape: null as (() => void) | null }));

vi.mock('../features/guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
}));

import {
  completeMessageWorkflowOnboarding,
  latestMessageWorkflowRequest,
  readMessageWorkflowOnboarded,
  readMessageWorkflowPreference,
  saveMessageWorkflowPreference,
  subscribeMessageWorkflowPreference,
} from './messageWorkflowPreference';

const workflowKey = 'org.unionground.app.messaging-workflow-v1';
const onboardingKey = 'org.unionground.app.messaging-workflow-onboarded-v1';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

// Records the workflow each write publishes; the request number it carries is
// asserted on its own below.
function observeWorkflow() {
  const listener = vi.fn();
  onTestFinished(subscribeMessageWorkflowPreference((workflow) => listener(workflow)));
  return listener;
}

describe('native messaging workflow preference', () => {
  beforeEach(() => {
    values.clear();
    vi.mocked(SecureStore.getItemAsync).mockReset().mockImplementation(async (key) => values.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockReset().mockImplementation(async (key, value) => { values.set(key, value); });
  });

  it('defaults an undecided user to workflow 2 and completes a skipped onboarding', async () => {
    expect(await readMessageWorkflowPreference()).toBe('people-spaces-work');
    expect(await readMessageWorkflowOnboarded()).toBe(false);
    expect(await completeMessageWorkflowOnboarding()).toBe('people-spaces-work');
    expect(await readMessageWorkflowOnboarded()).toBe(true);
  });

  it('notifies an already-mounted Messages screen when Settings changes the workflow', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMessageWorkflowPreference(listener);
    const saving = saveMessageWorkflowPreference('workstreams');
    const request = latestMessageWorkflowRequest();
    await saving;
    expect(await readMessageWorkflowPreference()).toBe('workstreams');
    expect(listener).toHaveBeenCalledWith('workstreams', request);
    unsubscribe();
  });

  it('numbers every update when it is requested and publishes that number with its write', async () => {
    const listener = vi.fn();
    onTestFinished(subscribeMessageWorkflowPreference(listener));
    const before = latestMessageWorkflowRequest();
    const first = saveMessageWorkflowPreference('attention');
    const completing = completeMessageWorkflowOnboarding();
    const last = saveMessageWorkflowPreference('workstreams');
    expect(latestMessageWorkflowRequest()).toBe(before + 3);
    await Promise.all([first, completing, last]);
    expect(listener.mock.calls).toEqual([['attention', before + 1], ['attention', before + 2], ['workstreams', before + 3]]);
  });

  it('keeps the newest choice and notification when an older native write is delayed', async () => {
    const started = deferred();
    const release = deferred();
    const listener = observeWorkflow();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === workflowKey && value === 'workstreams') {
        started.resolve();
        await release.promise;
      }
      values.set(key, value);
    });

    const earlier = saveMessageWorkflowPreference('workstreams');
    await started.promise;
    const latest = saveMessageWorkflowPreference('attention');
    await nextTurn();
    release.resolve();
    await Promise.all([earlier, latest]);

    expect(await readMessageWorkflowPreference()).toBe('attention');
    expect(await readMessageWorkflowOnboarded()).toBe(true);
    expect(listener).toHaveBeenLastCalledWith('attention');
  });

  it('completes onboarding with the choice whose save is already pending', async () => {
    const started = deferred();
    const release = deferred();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === workflowKey && value === 'workstreams') {
        started.resolve();
        await release.promise;
      }
      values.set(key, value);
    });

    const choice = saveMessageWorkflowPreference('workstreams');
    await started.promise;
    const onboarding = completeMessageWorkflowOnboarding();
    await nextTurn();
    release.resolve();
    await choice;

    expect(await onboarding).toBe('workstreams');
    expect(await readMessageWorkflowPreference()).toBe('workstreams');
  });

  it('does not restore an older onboarding read over a newer choice', async () => {
    values.set(workflowKey, 'workstreams');
    const started = deferred();
    const release = deferred();
    const listener = observeWorkflow();
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(async (key) => {
      const stored = values.get(key) ?? null;
      started.resolve();
      await release.promise;
      return stored;
    });

    const onboarding = completeMessageWorkflowOnboarding();
    await started.promise;
    const latest = saveMessageWorkflowPreference('attention');
    await nextTurn();
    release.resolve();
    await Promise.all([onboarding, latest]);

    expect(await readMessageWorkflowPreference()).toBe('attention');
    expect(listener).toHaveBeenLastCalledWith('attention');
  });

  it('reports a failed preference write and still saves the next choice', async () => {
    const failure = new Error('native preference write refused');
    const listener = observeWorkflow();
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(failure);

    const results = await Promise.allSettled([
      saveMessageWorkflowPreference('workstreams'),
      saveMessageWorkflowPreference('attention'),
    ]);

    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: 'attention' },
    ]);
    expect(await readMessageWorkflowPreference()).toBe('attention');
    expect(listener).toHaveBeenCalledExactlyOnceWith('attention');
  });

  it('does not leave an old write running after an onboarding-marker failure', async () => {
    const failure = new Error('native onboarding write refused');
    const started = deferred();
    const release = deferred();
    const listener = observeWorkflow();
    let failOnboarding = true;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === workflowKey && value === 'workstreams') {
        started.resolve();
        await release.promise;
      }
      if (key === onboardingKey && failOnboarding) {
        failOnboarding = false;
        throw failure;
      }
      values.set(key, value);
    });

    const earlier = saveMessageWorkflowPreference('workstreams').catch((error: unknown) => error);
    await started.promise;
    const latest = saveMessageWorkflowPreference('attention');
    await nextTurn();
    release.resolve();

    expect(await earlier).toBe(failure);
    await latest;
    expect(await readMessageWorkflowPreference()).toBe('attention');
    expect(await readMessageWorkflowOnboarded()).toBe(true);
    expect(listener).toHaveBeenNthCalledWith(1, 'workstreams');
    expect(listener).toHaveBeenNthCalledWith(2, 'attention');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('reports a failed onboarding read without blocking a later choice', async () => {
    const failure = new Error('native preference read refused');
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(failure);
    const results = await Promise.allSettled([
      completeMessageWorkflowOnboarding(),
      saveMessageWorkflowPreference('attention'),
    ]);

    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: 'attention' },
    ]);
    expect(await readMessageWorkflowPreference()).toBe('attention');
  });

  it('publishes the persisted choice when its onboarding marker fails, rejects, and recovers', async () => {
    const listener = observeWorkflow();
    await saveMessageWorkflowPreference('workstreams');
    const failure = new Error('native onboarding write refused');
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === onboardingKey) throw failure;
      values.set(key, value);
    });

    await expect(saveMessageWorkflowPreference('attention')).rejects.toBe(failure);
    expect(await readMessageWorkflowPreference()).toBe('attention');
    expect(listener).toHaveBeenLastCalledWith('attention');

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => { values.set(key, value); });
    await expect(saveMessageWorkflowPreference('people-spaces-work')).resolves.toBe('people-spaces-work');
    expect(await readMessageWorkflowPreference()).toBe('people-spaces-work');
    expect(await readMessageWorkflowOnboarded()).toBe(true);
    expect(listener).toHaveBeenLastCalledWith('people-spaces-work');
  });

  it('keeps storage and subscribers consistent when onboarding completion partially fails', async () => {
    values.set(workflowKey, 'workstreams');
    const listener = observeWorkflow();
    const failure = new Error('native onboarding write refused');
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === onboardingKey) throw failure;
      values.set(key, value);
    });

    await expect(completeMessageWorkflowOnboarding()).rejects.toBe(failure);
    expect(await readMessageWorkflowPreference()).toBe('workstreams');
    expect(await readMessageWorkflowOnboarded()).toBe(false);
    expect(listener).toHaveBeenCalledExactlyOnceWith('workstreams');
  });
});

const fixtureID = 'fixture-member';
const marker = `${onboardingKey}.${Array.from(fixtureID, char => char.codePointAt(0)!.toString(16)).join('-')}`;
vi.mock('expo-router', () => ({ useNavigation: () => ({ setParams: vi.fn() }), useIsFocused: () => sheetState.focused, useRouter: () => ({ push: vi.fn() }), Redirect: () => null, useLocalSearchParams: () => ({}) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => h('span') }));
vi.mock('../components/MessageWorkflowPicker', () => ({ MessageWorkflowPicker: ({ value, language, onChange }: { value: MessageWorkflow; language: 'en' | 'es'; onChange: (value: MessageWorkflow) => void }) =>
  h('div', { 'data-testid': 'workflow-picker', 'data-workflow': value }, messageWorkflowKeys.map(key => h('button', { key, onClick: () => onChange(key) }, messageWorkflowCopy[language].workflow[key].title))) }));
vi.mock('../components/RowHighlight', () => ({ HighlightList: () => null, HighlightRow: () => null }));
vi.mock('../components/SupportLink', () => ({ SupportLink: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), initialWindowMetrics: null })); // the Messages organize sheet pads the window's safe area (#9608)
vi.mock('../lib/chrome', () => ({ useNativeTabContentInset: () => 0, screenBottomInset: () => 0 }));
vi.mock('../components/PinnedHeader', () => ({
  PinnedHeaderScreen: ({ children }: PropsWithChildren) => h('div', null, children),
  useScreenNameAlreadySpoken: () => ({ duplicate: false, hiddenProps: {} }),
}));
vi.mock('../services/haptics', () => ({ haptics: {} }));
// Messages' task discussions poll on their own; this suite covers the workflow chooser.
vi.mock('../features/useTaskDiscussions', () => ({ useTaskDiscussions: () => ({ items: [], failed: false }) }));
vi.mock('../services/supabase', () => ({ startMemberConversation: vi.fn() }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ dashboard: { conversations: [], member: { language: sheetState.language } }, mode: 'authenticated',
  session: { user: { id: 'fixture-member' } }, authorizedRoles: [], refreshing: false, refresh: vi.fn() }) }));
vi.mock('../data/useChannels', () => {
  const store = { channels: () => [], status: () => 'ready', loadFault: () => null,
    subscribe: () => () => undefined, getVersion: () => 0 };
  return { useChannelStore: () => store };
});
vi.mock('../data/channelControls', () => ({ useChannelControls: () => ({ controls: { switches: { channelPinning: false } } }) }));
vi.mock('../components/ui', () => {
  const element = ({ children }: PropsWithChildren) => h('div', null, children);
  return { Avatar: element, Body: element, Card: element, Heading: element, Notice: element, Screen: element,
    SearchField: () => null, StateMessage: ({ title }: { title: string }) => h('div', null, title),
    Button: ({ label, onPress }: { label: string; onPress: () => void }) => h('button', { onClick: onPress }, label) };
});
vi.mock('react-native', () => {
  const element = ({ children }: PropsWithChildren) => h('div', null, children);
  return { AccessibilityInfo: { announceForAccessibility: vi.fn() }, Platform: { OS: 'web' },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Modal: ({ visible, children, onRequestClose }: PropsWithChildren<{ visible?: boolean; onRequestClose?: () => void }>) => { sheetState.back = onRequestClose ?? null; return visible ? h('dialog', { open: true }, children) : null; },
    Pressable: element, ScrollView: element, Text: element, View: ({ children, onAccessibilityEscape }: PropsWithChildren<{ onAccessibilityEscape?: () => void }>) => { if (onAccessibilityEscape) sheetState.escape = onAccessibilityEscape; return h('div', null, children); }, TextInput: () => null };
});


describe('mounted native Messages workflow subscription', () => {
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  values.clear();
  sheetState.focused = true; sheetState.language = 'en'; sheetState.back = null; sheetState.escape = null;
  vi.mocked(SecureStore.getItemAsync).mockReset().mockImplementation(async key => values.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockReset().mockImplementation(async (key, value) => { values.set(key, value); });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const mount = async () => { await act(async () => root.render(h(StrictMode, null, h(MessagesScreen)))); };


  it('keeps onboarding incomplete while publishing the preference that survived a marker-write failure', async () => {
    await mount();
    expect(container.textContent).toContain(messageWorkflowCopy.en.onboardingTitle);
    const failure = new Error('marker write refused');
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === marker) throw failure;
      values.set(key, value);
    });
    await act(async () => { await expect(saveMessageWorkflowPreference('attention', fixtureID)).rejects.toBe(failure); });
    expect(await readMessageWorkflowPreference(fixtureID)).toBe('attention');
    expect(await readMessageWorkflowOnboarded(fixtureID)).toBe(false);
    expect(container.textContent).toContain(messageWorkflowCopy.en.onboardingTitle);
    expect(container.querySelector('[data-testid="workflow-picker"]')?.getAttribute('data-workflow')).toBe('attention');
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => { values.set(key, value); });
    await act(async () => { await saveMessageWorkflowPreference('workstreams', fixtureID); });
    expect(await readMessageWorkflowOnboarded(fixtureID)).toBe(true);
    expect(container.textContent).not.toContain(messageWorkflowCopy.en.onboardingTitle);
  });

  it('keeps the chooser when its marker cannot be read after a preference notification', async () => {
    await mount();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async key => {
      if (key === marker) throw new Error('marker read refused');
      return values.get(key) ?? null;
    });
    await act(async () => { await saveMessageWorkflowPreference('attention', fixtureID); });
    expect(container.textContent).toContain(messageWorkflowCopy.en.onboardingTitle);
    expect(container.querySelector('[data-testid="workflow-picker"]')?.getAttribute('data-workflow')).toBe('attention');
  });
});

describe('Messages chooser focus and storage-failure escape', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    values.clear(); sheetState.focused = true; sheetState.language = 'en'; sheetState.back = null; sheetState.escape = null;
    vi.mocked(SecureStore.getItemAsync).mockReset().mockImplementation(async key => values.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockReset().mockImplementation(async (key, value) => { values.set(key, value); });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const mount = () => act(async () => root.render(h(StrictMode, null, h(MessagesScreen))));
  const press = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === label);
    expect(button, label).toBeTruthy(); await act(async () => { button!.click(); });
  };

  it('does not present from a preloaded inactive tab and follows Messages focus', async () => {
    sheetState.focused = false;
    await mount(); expect(container.querySelector('dialog')).toBeNull();
    sheetState.focused = true;
    await mount(); expect(container.querySelector('dialog')).not.toBeNull();
    sheetState.focused = false;
    await mount(); expect(container.querySelector('dialog')).toBeNull();
    expect(await readMessageWorkflowOnboarded(fixtureID)).toBe(false);
  });

  const languages: Array<'en' | 'es'> = ['en', 'es'];
  it.each(languages)('offers Skip, Back and accessibility escape after a save failure in %s', async language => {
    sheetState.language = language;
    const copy = messageWorkflowCopy[language];
    const exits: Array<'skip' | 'back' | 'escape'> = ['skip', 'back', 'escape'];
    for (const exit of exits) {
      await act(async () => root.render(h('div')));
      values.clear();
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        if (key === marker) throw new Error('keystore refused');
        values.set(key, value);
      });
      await mount(); await press(copy.useChoice);
      expect(container.textContent).toContain(language === 'es'
        ? 'No se pudo guardar tu elección en este teléfono. Se volverá a preguntar la próxima vez.'
        : 'Your choice could not be saved on this phone. It will be asked again next time.');
      const writes = vi.mocked(SecureStore.setItemAsync).mock.calls.length;
      if (exit === 'skip') await press(copy.skip);
      else await act(async () => { (exit === 'back' ? sheetState.back : sheetState.escape)?.(); });
      expect(container.querySelector('dialog'), exit).toBeNull();
      expect(vi.mocked(SecureStore.setItemAsync).mock.calls.length).toBe(writes);
      expect(await readMessageWorkflowOnboarded(fixtureID)).toBe(false);
      await act(async () => root.render(h('div'))); await mount();
      expect(container.querySelector('dialog')).not.toBeNull();
    }
  });
});

describe('R1 r1s1: nondefault failures honor the promised default on every exit', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    values.clear(); sheetState.focused = true; sheetState.language = 'en'; sheetState.back = null; sheetState.escape = null;
    vi.mocked(SecureStore.getItemAsync).mockReset().mockImplementation(async key => values.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockReset().mockImplementation(async (key, value) => { values.set(key, value); });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
  const mount = () => act(async () => root.render(h(StrictMode, null, h(MessagesScreen))));
  const press = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === label);
    expect(button, label).toBeTruthy(); await act(async () => { button!.click(); });
  };
  type Case = ['en' | 'es', 'attention' | 'workstreams', 'choice' | 'marker', 'skip' | 'back' | 'swipe' | 'escape'];
  const cases: Case[] = [];
  const languages: Array<Case[0]> = ['en', 'es'];
  const choices: Array<Case[1]> = ['attention', 'workstreams'];
  const failures: Array<Case[2]> = ['choice', 'marker'];
  const exits: Array<Case[3]> = ['skip', 'back', 'swipe', 'escape'];
  for (const language of languages) for (const choice of choices) for (const failure of failures) for (const exit of exits) cases.push([language, choice, failure, exit]);
  it.each(cases)('%s: %s / failed %s / %s leaves the default applied and onboarding owed', async (language, choice, failure, exit) => {
    sheetState.language = language;
    const groups = vi.spyOn(workflowModule, 'groupNativeMessageItems');
    const choiceKey = marker.replace('messaging-workflow-onboarded', 'messaging-workflow');
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === (failure === 'marker' ? marker : choiceKey)) throw new Error('keystore refused');
      values.set(key, value);
    });
    const copy = messageWorkflowCopy[language];
    await mount(); await press(copy.workflow[choice].title); await press(copy.useChoice);
    expect(groups.mock.lastCall?.[1]).toBe(choice);
    expect(container.textContent).toContain(copy.saveFailed);
    const writes = vi.mocked(SecureStore.setItemAsync).mock.calls.length;
    if (exit === 'skip') await press(copy.skip);
    // Android Back and a native swipe close request share onRequestClose.
    else await act(async () => { (exit === 'escape' ? sheetState.escape : sheetState.back)?.(); });
    expect(container.querySelector('dialog')).toBeNull();
    expect(groups.mock.lastCall?.[1]).toBe('people-spaces-work');
    expect(vi.mocked(SecureStore.setItemAsync).mock.calls.length).toBe(writes);
    expect(await readMessageWorkflowOnboarded(fixtureID)).toBe(false);
    await act(async () => root.render(h('div'))); await mount();
    expect(container.querySelector('dialog')).not.toBeNull();
  });
});
