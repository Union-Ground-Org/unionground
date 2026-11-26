// @vitest-environment jsdom
import { act, createElement as h, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskDiscussion } from '../lib/taskDiscussions';

// BUG-UG-NATIVE-CASE-ROWS-AND-TASK-TITLES-DO-NOT-OPEN-20261111, gate
// finding G6-8264-1: the Messages task discussions were read once and then only
// on a manual pull-to-refresh, so a first incoming discussion stayed absent.
// The real hook and section are mounted here, with native drawing, the router
// and the service boundary replaced.
const fake = vi.hoisted(() => ({
  load: vi.fn<() => Promise<TaskDiscussion[]>>(),
  push: vi.fn(),
  appState: 'active' as string,
  listeners: [] as Array<(next: string) => void>,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: fake.push }) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: 'en' }) }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  return {
    View: ({ children }: PropsWithChildren) => createElement('div', null, children),
    Pressable: ({ children, onPress, accessibilityLabel }: PropsWithChildren<{ onPress: () => void; accessibilityLabel: string }>) =>
      createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
    StyleSheet: { create: <T,>(value: T) => value },
    AppState: {
      get currentState() { return fake.appState; },
      addEventListener: (_event: string, listener: (next: string) => void) => {
        fake.listeners.push(listener);
        return { remove: () => { fake.listeners.splice(fake.listeners.indexOf(listener), 1); } };
      },
    },
  };
});
vi.mock('../components/ui', async () => {
  const { createElement } = await import('react');
  const text = ({ children }: PropsWithChildren) => createElement('div', null, children);
  return { Body: text, Card: text, Heading: text };
});
vi.mock('../services/livedIn', () => ({ loadMyTaskDiscussions: () => fake.load() }));

import { TaskDiscussionsSection } from '../components/TaskDiscussionsSection';
import { filterTaskDiscussions, taskDiscussionScope } from '../lib/taskDiscussions';
import { useTaskDiscussions } from './useTaskDiscussions';

const POLL_MS = 30_000;
const discussion: TaskDiscussion = {
  taskID: '00000000-0000-4000-8000-000000000010',
  title: 'New first discussion',
  reference: 'FLEET-MAINTENANCE-6',
  latestAt: '2026-11-11T17:00:00.000Z',
  latestPreview: 'A new task message',
  latestFromYou: false,
};

// The Messages wiring in miniature: the screen owns the list and its search,
// scoped to the person, organization and selected chapter.
function Harness({ reloadKey, query, chapterID = 'tamarack-eastgate', connected = true }: { reloadKey: number; query: string; chapterID?: string | null; connected?: boolean }) {
  const state = useTaskDiscussions(taskDiscussionScope('user-one', 'org-one', chapterID), reloadKey, POLL_MS, connected);
  return h(TaskDiscussionsSection, { items: filterTaskDiscussions(state.items, query), failed: state.failed });
}

let container: HTMLDivElement;
let root: Root;
const render = (reloadKey = 0, query = '', chapterID: string | null = 'tamarack-eastgate', connected = true) => act(async () => { root.render(h(Harness, { reloadKey, query, chapterID, connected })); });
const tick = (ms = POLL_MS) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  fake.load.mockReset();
  fake.push.mockReset();
  fake.appState = 'active';
  fake.listeners.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('Messages task discussions stay fresh while mounted', () => {
  it('shows a first incoming discussion on the next poll, with no manual refresh', async () => {
    fake.load.mockResolvedValue([]);
    await render();
    expect(fake.load).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');

    fake.load.mockResolvedValue([discussion]);
    // Search and parent rerenders alone do not read again...
    for (const query of ['', 'Fleet']) await render(0, query);
    expect(fake.load).toHaveBeenCalledTimes(1);
    // ...but the poll does, on the conversation cadence.
    await tick();
    expect(fake.load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('New first discussion');

    act(() => container.querySelector('button')!.click());
    expect(fake.push).toHaveBeenCalledWith(`/task-conversation/${discussion.taskID}`);
  });

  it('stops polling in the background and reads again as soon as the app is active', async () => {
    fake.load.mockResolvedValue([]);
    await render();
    await act(async () => { fake.listeners.forEach((listener) => listener('background')); });
    await tick(POLL_MS * 3);
    expect(fake.load).toHaveBeenCalledTimes(1);

    fake.load.mockResolvedValue([discussion]);
    await act(async () => { fake.listeners.forEach((listener) => listener('active')); });
    expect(fake.load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('New first discussion');
  });

  it('keeps the last good list when a poll fails, and says so only when there is nothing to show', async () => {
    fake.load.mockResolvedValue([discussion]);
    await render();
    fake.load.mockRejectedValue(new Error('network'));
    await tick();
    expect(container.textContent).toContain('New first discussion');
    expect(container.textContent).not.toContain('could not load');

    root.unmount();
    root = createRoot(container);
    fake.load.mockRejectedValue(new Error('network'));
    await render();
    expect(container.textContent).toContain('Task discussions could not load.');
  });

  it('a manual refresh reads at once even while a poll is still in flight', async () => {
    let settle: (value: TaskDiscussion[]) => void = () => undefined;
    fake.load.mockResolvedValue([]);
    await render();
    fake.load.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    await tick();
    expect(fake.load).toHaveBeenCalledTimes(2);
    fake.load.mockResolvedValue([discussion]);
    await render(1);
    expect(fake.load).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('New first discussion');
    // The superseded read settles late and does not overwrite the fresh list.
    await act(async () => { settle([]); });
    expect(container.textContent).toContain('New first discussion');
  });

  it('stops its timer and app-state listener when Messages unmounts', async () => {
    fake.load.mockResolvedValue([]);
    await render();
    expect(fake.listeners).toHaveLength(1);
    act(() => root.unmount());
    expect(fake.listeners).toHaveLength(0);
    await tick(POLL_MS * 2);
    expect(fake.load).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  // Gate G6-8264 FINAL P1 (r3s1/r4s1): after a chapter switch the old chapter's
  // titles and previews must not render, and a late old-chapter read must not
  // publish under the new chapter.
  it('shows nothing from the old campaign after a switch, before and while the new campaign loads', async () => {
    fake.load.mockResolvedValue([discussion]);
    await render(0, '', 'tamarack-eastgate');
    expect(container.textContent).toContain('New first discussion');

    // The workspace reload clears the dashboard first: no chapter, no list.
    fake.load.mockImplementation(() => new Promise(() => undefined));
    await render(0, '', null);
    expect(container.textContent).toBe('');
    // The new chapter's read is still pending: still nothing from the old one.
    await render(0, '', 'tamarack-harrow-bay');
    expect(container.textContent).toBe('');
  });

  it('shows nothing from the old campaign even when the campaign changes in one step', async () => {
    fake.load.mockResolvedValue([discussion]);
    await render(0, '', 'tamarack-eastgate');
    expect(container.textContent).toContain('New first discussion');
    fake.load.mockImplementation(() => new Promise(() => undefined));
    await render(0, '', 'tamarack-harrow-bay');
    expect(container.textContent).toBe('');
  });

  it('drops an old-chapter read that resolves after the switch', async () => {
    let settleOld: (value: TaskDiscussion[]) => void = () => undefined;
    fake.load.mockImplementationOnce(() => new Promise((resolve) => { settleOld = resolve; }));
    await render(0, '', 'tamarack-eastgate');
    const newChapter: TaskDiscussion = { ...discussion, taskID: '00000000-0000-4000-8000-000000000020', title: 'Harrow Bay rota' };
    fake.load.mockResolvedValue([newChapter]);
    await render(0, '', 'tamarack-harrow-bay');
    expect(container.textContent).toContain('Harrow Bay rota');
    await act(async () => { settleOld([discussion]); });
    expect(container.textContent).toContain('Harrow Bay rota');
    expect(container.textContent).not.toContain('New first discussion');
  });

  // A11Y-UG-FOCUS-AND-ACCESSIBLE-NAME-GAPS-FROM-REVIEWS-20261117
  // : the poll re-read the whole list every tick even with
  // the device offline. It now skips ticks and foreground reads offline, as
  // the conversation poller does, and catches up once on reconnect.
  it('does not poll while offline and reads once when the device reconnects', async () => {
    fake.load.mockResolvedValue([]);
    await render(0, '', 'tamarack-eastgate', false);
    // Opening the tab is the member's own request and still reads.
    expect(fake.load).toHaveBeenCalledTimes(1);
    await tick(POLL_MS * 3);
    expect(fake.load).toHaveBeenCalledTimes(1);
    await act(async () => { fake.listeners.forEach((listener) => listener('background')); });
    await act(async () => { fake.listeners.forEach((listener) => listener('active')); });
    expect(fake.load).toHaveBeenCalledTimes(1);
    // A manual refresh still reads while offline.
    await render(1, '', 'tamarack-eastgate', false);
    expect(fake.load).toHaveBeenCalledTimes(2);

    fake.load.mockResolvedValue([discussion]);
    await render(1, '', 'tamarack-eastgate', true);
    expect(fake.load).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('New first discussion');
    await tick();
    expect(fake.load).toHaveBeenCalledTimes(4);
  });

  it('does not catch up on reconnect while the app is in the background', async () => {
    fake.load.mockResolvedValue([]);
    await render(0, '', 'tamarack-eastgate', false);
    fake.appState = 'background';
    await act(async () => { fake.listeners.forEach((listener) => listener('background')); });
    await render(0, '', 'tamarack-eastgate', true);
    await tick(POLL_MS * 2);
    expect(fake.load).toHaveBeenCalledTimes(1);
  });
});
