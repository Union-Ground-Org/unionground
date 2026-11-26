// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// BUG-UG-NATIVE-HOME-EDGE-PILLS-COVER-SECTION-HEADING-20261103: live
// Home reserved no handle row, so the All features and Work handles fell back
// to the screen's vertical centre and covered the member summary and the
// What matters for you now heading. The row is one component both Homes use;
// these tests execute its publish-and-clear contract against the real store
// and pin where live Home places it.

type LayoutEvent = { nativeEvent: { layout: { y: number } } };
type ViewProps = { onLayout?: (event: LayoutEvent) => void; style?: { height?: number }; pointerEvents?: string; accessibilityElementsHidden?: boolean; importantForAccessibility?: string };

const mocks = vi.hoisted(() => ({
  views: [] as ViewProps[],
  offset: 0,
}));

vi.mock('react-native', () => ({
  View: (props: ViewProps) => {
    mocks.views.push(props);
    return createElement('div');
  },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Animated: { Value: class { constructor(initial: number) { mocks.offset = initial; } setValue(next: number) { mocks.offset = next; } } },
  Platform: { OS: 'ios' },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

import { HomeHandleRow } from './HomeHandleRow';
import { resetHomeScrollOffset, syncHomeAwayFromTop, useHomeHandleRowTop } from '../lib/chrome';

// Every row top the handles were drawn with, as HomeCarousel reads it.
const drawnTops: number[] = [];
function HandleProbe() {
  drawnTops.push(useHomeHandleRowTop());
  return null;
}
const lastRow = () => mocks.views.at(-1);
const flushMicrotasks = () => act(async () => { await Promise.resolve(); });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.views.length = 0;
  drawnTops.length = 0;
  resetHomeScrollOffset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { container.remove(); });

describe('HomeHandleRow', () => {
  it('reserves a 48 pt row hidden from touch and assistive technology', async () => {
    await act(async () => { root.render(createElement(HomeHandleRow)); });
    const row = mocks.views.at(-1);
    expect(row?.style?.height).toBe(48);
    expect(row?.pointerEvents).toBe('none');
    expect(row?.accessibilityElementsHidden).toBe(true);
    expect(row?.importantForAccessibility).toBe('no-hide-descendants');
    act(() => root.unmount());
  });

  it('publishes its measured top and clears it when it unmounts', async () => {
    await act(async () => { root.render(createElement(Fragment, null, createElement(HomeHandleRow), createElement(HandleProbe))); });
    await act(async () => { lastRow()?.onLayout?.({ nativeEvent: { layout: { y: 312 } } }); });
    expect(drawnTops.at(-1)).toBe(312);
    // A Home with no row (loading, welcome back, signed out) clears it.
    await act(async () => { root.render(createElement(HandleProbe)); });
    await flushMicrotasks();
    expect(drawnTops.at(-1)).toBe(0);
    act(() => root.unmount());
  });

  // BUG-UG-NATIVE-HOME-HANDLES-STAY-AT-UNSCROLLED-POSITION-AFTER-TEXT-SIZE-CHANGE-IOS-20261103:
  // a cleared row drops the handles' scroll transform, and React Native then
  // rebuilds Home's shared offset from a JS-side 0 while the page stays
  // scrolled, so the handles sat at the unscrolled position over the vote card.
  it('keeps the row through a text-size remount while Home is scrolled', async () => {
    const page = (fontScale: string) => createElement(Fragment, null,
      createElement(Fragment, { key: fontScale }, createElement(HomeHandleRow)),
      createElement(HandleProbe));
    await act(async () => { root.render(page('3.12')); });
    await act(async () => { lastRow()?.onLayout?.({ nativeEvent: { layout: { y: 443 } } }); });
    // The member scrolls; the native driver moves the offset, the listener records it.
    mocks.offset = 202;
    syncHomeAwayFromTop(202);
    // The text size changes: FontScaleRelayout's key remounts the row in place.
    await act(async () => { root.render(page('1.18')); });
    await flushMicrotasks();
    const remounted = lastRow();
    await act(async () => { remounted?.onLayout?.({ nativeEvent: { layout: { y: 380 } } }); });
    const afterFirstLayout = drawnTops.slice(drawnTops.indexOf(443));
    expect(afterFirstLayout).not.toContain(0);
    expect(drawnTops.at(-1)).toBe(380);
    expect(mocks.offset).toBe(202);
    act(() => root.unmount());
    await flushMicrotasks();
  });

  it('sits directly under live Home\'s worker summary, before the section that follows', () => {
    const home = readFileSync(fileURLToPath(new NodeURL('../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');
    const live = home.slice(home.indexOf('function AuthenticatedHome()'));
    const summaryEnd = live.indexOf('<Metric value={metrics.completedThisWeek}');
    const row = live.indexOf('<HomeHandleRow />');
    const nextSection = live.indexOf('<WhatMattersNowSection item={ranking.item}');
    expect(summaryEnd).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(summaryEnd);
    expect(row).toBeLessThan(nextSection);
    // #8175: the optional recruited count is the summary's last item.
    expect(live.slice(summaryEnd, row)).toMatch(/^[^\n]*\n(?:\s*\{recruitedYtd !== null \? \(\n[^\n]*\n\s*\) : null\}\n)?\s*<\/View>\n/);
  });
});
