// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-NATIVE-CHARTS-ARRIVE-ONCE-THEME-DECISION-4-20261113 (#8646):
// the hook executed on the shared stand-in, with a View the test can place on
// or off the screen and a device that answers the Reduce Motion question.
const device = vi.hoisted(() => ({
  rect: { x: 16, y: 2000, width: 358, height: 150 } as { x: number; y: number; width: number; height: number },
  reduceMotion: false,
  measurable: true,
  changed: null as ((enabled: boolean) => void) | null,
}));

vi.mock('react-native', async () => {
  const stand = await import('../testing/reactNativeStandIn');
  const { forwardRef, useImperativeHandle } = await import('react');
  const View = forwardRef<unknown, Record<string, unknown>>(function MeasuredView(props, ref) {
    useImperativeHandle(ref, () => (device.measurable
      ? { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(device.rect.x, device.rect.y, device.rect.width, device.rect.height) }
      : {}));
    return h(stand.View, props);
  });
  return {
    ...stand,
    View,
    AccessibilityInfo: {
      ...stand.AccessibilityInfo,
      isReduceMotionEnabled: async () => device.reduceMotion,
      addEventListener: (_event: string, listener: (enabled: boolean) => void) => { device.changed = listener; return { remove: () => {} }; },
    },
  };
});

import { render, type Rendered } from '../testing/reactNativeStandIn';
import { View, Text } from 'react-native';
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext';
import { forgetChartArrivals } from './chartArrival';
import { useReduceMotion } from './reduceMotion';
import { useChartArrival } from './useChartArrival';

function Probe({ name }: { name: string | null }) {
  const { ref, elapsed } = useChartArrival(name, 1000);
  return h(View, { ref }, h(Text, null, elapsed === null ? 'finished' : `at ${elapsed}`));
}

// A tab screen: focused or not, with its focus and blur events.
const tab = { focused: false, listeners: new Map<string, () => void>() };
const tabNavigation = {
  isFocused: () => tab.focused,
  addListener: (event: string, listener: () => void) => { tab.listeners.set(event, listener); return () => { tab.listeners.delete(event); }; },
};

async function showInTab(name: string) {
  await screen?.unmount();
  screen = await render(h(NavigationContext.Provider, { value: tabNavigation as never }, h(Probe, { name })));
}

function Warm() {
  useReduceMotion();
  return null;
}

let screen: Rendered | null = null;
const shown = () => screen?.container.textContent ?? '';

async function show(name: string | null) {
  await screen?.unmount();
  screen = await render(h(Probe, { name }));
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  device.rect = { x: 16, y: 2000, width: 358, height: 150 };
  device.measurable = true;
});

afterEach(async () => {
  await screen?.unmount();
  screen = null;
  forgetChartArrivals();
  vi.useRealTimers();
});

// The Reduce Motion probe is shared by the whole app, so these run in order:
// first before the device answers, then after.
describe('a chart before the device has answered the Reduce Motion question', () => {
  it('is drawn finished and never arrives later', async () => {
    screen = await render(h(Probe, { name: 'pulse:early' }));
    expect(shown()).toBe('finished');
    await advance(500);
    device.rect = { x: 16, y: 100, width: 358, height: 150 };
    await show('pulse:early');
    expect(shown()).toBe('finished');
  });
});

describe('once the device has answered', () => {
  beforeEach(async () => {
    device.reduceMotion = false;
    screen = await render(h(Warm));
    await advance(0);
    await screen.unmount();
    screen = null;
  });

  it('a chart below the fold waits empty, arrives when seen, then stays finished', async () => {
    await show('pulse:participation');
    expect(shown()).toBe('at 0');
    await advance(600);
    expect(shown()).toBe('at 0');
    device.rect = { x: 16, y: 600, width: 358, height: 150 };
    await advance(150);
    await advance(400);
    expect(shown()).toMatch(/^at [1-9]\d*$/);
    await advance(700);
    expect(shown()).toBe('finished');
    // Opened again, refreshed or filtered: the same chart is drawn whole.
    await show('pulse:participation');
    expect(shown()).toBe('finished');
    // Another chart still has its own first arrival.
    device.rect = { x: 16, y: 2000, width: 358, height: 150 };
    await show('pulse:case-status');
    expect(shown()).toBe('at 0');
  });

  it('a chart on screen when its screen opens waits for the screen to settle before it arrives', async () => {
    device.rect = { x: 16, y: 300, width: 358, height: 150 };
    await show('pulse:opened-on-screen');
    await advance(450);
    expect(shown()).toBe('at 0');
    await advance(300);
    await advance(200);
    expect(shown()).toMatch(/^at [1-9]\d*$/);
  });

  it('a chart on a tab that is not showing waits, however much of it would be on screen', async () => {
    tab.focused = false;
    device.rect = { x: 16, y: 300, width: 358, height: 150 };
    await showInTab('pulse:hidden-tab');
    await advance(3000);
    expect(shown()).toBe('at 0');
    // The tab opens: the chart waits for it to settle, then arrives.
    tab.focused = true;
    await act(async () => { tab.listeners.get('focus')?.(); });
    await advance(450);
    expect(shown()).toBe('at 0');
    await advance(300);
    await advance(200);
    expect(shown()).toMatch(/^at [1-9]\d*$/);
  });

  it('a chart whose tab is left before it arrives waits for the tab to come back', async () => {
    tab.focused = true;
    device.rect = { x: 16, y: 300, width: 358, height: 150 };
    await showInTab('pulse:left-tab');
    await advance(300);
    tab.focused = false;
    await act(async () => { tab.listeners.get('blur')?.(); });
    await advance(2000);
    expect(shown()).toBe('at 0');
  });

  it('a chart leaving before it is seen still arrives the first time it is', async () => {
    await show('pulse:turnout');
    expect(shown()).toBe('at 0');
    await show('pulse:turnout');
    expect(shown()).toBe('at 0');
  });

  it('a chart with no name, or one that cannot be measured, is drawn finished', async () => {
    await show(null);
    expect(shown()).toBe('finished');
    device.measurable = false;
    await show('pulse:unmeasured');
    await advance(0);
    expect(shown()).toBe('finished');
  });
});

describe('under Reduce Motion', () => {
  it('a waiting chart is drawn finished the moment the setting turns on, and every chart after it', async () => {
    await show('pulse:waiting');
    expect(shown()).toBe('at 0');
    await act(async () => { device.changed?.(true); });
    expect(shown()).toBe('finished');
    device.rect = { x: 16, y: 100, width: 358, height: 150 };
    await show('pulse:reduced');
    expect(shown()).toBe('finished');
    await advance(2000);
    expect(shown()).toBe('finished');
    await act(async () => { device.changed?.(false); });
  });
});
