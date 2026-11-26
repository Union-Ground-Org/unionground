// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A11Y-UG-FOCUS-AND-ACCESSIBLE-NAME-GAPS-FROM-REVIEWS-20261117
//: Messages announced its result count whenever the count
// changed, so a background task-discussion or conversation refresh made
// VoiceOver speak, and Android's polite live region read it too. The count is
// spoken only after the member's own filter or search change.
const fake = vi.hoisted(() => ({ os: 'ios' as string, announce: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: { get OS() { return fake.os; } },
  AccessibilityInfo: { announceForAccessibility: (message: string) => fake.announce(message) },
}));

import { useResultCountAnnouncement } from './useResultCountAnnouncement';

function Harness({ searchKey, count }: { searchKey: string; count: number }) {
  const liveRegion = useResultCountAnnouncement(searchKey, `${count} results`);
  return h('span', { 'data-live': liveRegion }, `${count} results`);
}

let container: HTMLDivElement;
let root: Root;
const render = (searchKey: string, count: number) => act(async () => { root.render(h(Harness, { searchKey, count })); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const liveRegion = () => container.querySelector('span')!.getAttribute('data-live');

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  fake.os = 'ios';
  fake.announce.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('Messages result count announcement', () => {
  it('says nothing on open or when a background refresh changes the count', async () => {
    await render('all|', 4);
    await wait(1_000);
    await render('all|', 5);
    await wait(1_000);
    await render('all|', 3);
    await wait(1_000);
    expect(fake.announce).not.toHaveBeenCalled();
    expect(liveRegion()).toBe('none');
  });

  it('announces the count once after the worker pauses a search, with the count at that moment', async () => {
    await render('all|', 4);
    await render('all|f', 3);
    await wait(200);
    await render('all|fl', 2);
    // A refresh lands while the search is settling: the announcement waits
    // and speaks the newest count.
    await wait(200);
    await render('all|fl', 1);
    await wait(449);
    expect(fake.announce).not.toHaveBeenCalled();
    await wait(1);
    expect(fake.announce).toHaveBeenCalledTimes(1);
    expect(fake.announce).toHaveBeenCalledWith('1 results');
    // A later refresh after the search settled is silent again.
    await render('all|fl', 2);
    await wait(1_000);
    expect(fake.announce).toHaveBeenCalledTimes(1);
  });

  // Gate G7-9049: clearing back to the settled query within 450 ms is
  // still the member's own change and must announce the count it lands on.
  it('announces after typing and clearing back to the settled search within 450 ms', async () => {
    await render('all|', 4);
    await render('all|x', 2);
    await wait(100);
    await render('all|', 5);
    expect(liveRegion()).toBe('polite');
    await wait(449);
    expect(fake.announce).not.toHaveBeenCalled();
    await wait(1);
    expect(fake.announce).toHaveBeenCalledExactlyOnceWith('5 results');
    expect(liveRegion()).toBe('none');
    await render('all|', 6);
    await wait(1_000);
    expect(fake.announce).toHaveBeenCalledTimes(1);
  });

  it('keeps the Android live region polite only while the worker change settles', async () => {
    fake.os = 'android';
    await render('all|', 4);
    expect(liveRegion()).toBe('none');
    await render('unread|', 2);
    expect(liveRegion()).toBe('polite');
    await wait(450);
    expect(liveRegion()).toBe('none');
    await render('unread|', 3);
    expect(liveRegion()).toBe('none');
    // Android speaks through the live region, not a second announcement.
    expect(fake.announce).not.toHaveBeenCalled();
  });
});
