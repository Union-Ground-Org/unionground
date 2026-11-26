// @vitest-environment jsdom
// BUG-UG-NATIVE-LARGEST-TEXT-BREAKS-AND-CLIPS-WORDS-20261103: the cap
// follows the width the text was laid out in.
// BUG-UG-NATIVE-GUIDE-BULLET-CLIPPED-AT-LARGEST-TEXT-IOS-20261103: the
// cap never travels as maxFontSizeMultiplier, which React Native's text
// measure cache leaves out of its key, so a measured height can never belong
// to another cap than the one the text is drawn at.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutChangeEvent } from 'react-native';

const screen = vi.hoisted(() => ({ fontScale: 1 }));
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: screen.fontScale }) }));

import { useWordFit } from './useWordFit';

// React Native's fontScale at the largest iPhone accessibility size.
const LARGEST = 3.571;
const HEADING_3 = { fontSize: 17, lineHeight: 23 };
const BODY = { fontSize: 16, lineHeight: 23 };

let root: Root, host: HTMLDivElement;
let fit: ReturnType<typeof useWordFit> = {};

function Probe({ enabled, text, metrics }: { enabled: boolean; text: string; metrics: { fontSize: number; lineHeight: number } }) {
  fit = useWordFit(enabled, text, metrics);
  return null;
}
const layout = (width: number) => ({ nativeEvent: { layout: { width, height: 40, x: 0, y: 0 } } }) as LayoutChangeEvent;
const render = (enabled: boolean, text: string, metrics = HEADING_3) => act(async () => { root.render(createElement(Probe, { enabled, text, metrics })); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  screen.fontScale = LARGEST;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('useWordFit', () => {
  it('draws a capped text at explicit, already-scaled sizes once its line is measured', async () => {
    await render(true, 'When should general membership meetings start?');
    expect(fit).toEqual({ onLayout: expect.any(Function) });
    await act(async () => { fit.onLayout!(layout(252)); });
    const cap = 252 / (10 * 17 * 0.65);
    expect(fit.allowFontScaling).toBe(false);
    expect(fit.style?.fontSize).toBeCloseTo(17 * cap, 5);
    expect(fit.style?.lineHeight).toBeCloseTo(23 * cap, 5);
    expect(fit).not.toHaveProperty('maxFontSizeMultiplier');
    await act(async () => { fit.onLayout!(layout(300.4)); });
    expect(fit.style?.fontSize).toBeCloseTo(17 * (300 / (10 * 17 * 0.65)), 5);
  });

  it('leaves "• Take worker requests and reply to them." at the system size on a 311 pt line', async () => {
    // Worker N's iPhone 17 frame: the bullet's longest word fits at the full
    // size, so nothing about its size may differ from an unfitted text.
    await render(true, '• Take worker requests and reply to them.', BODY);
    await act(async () => { fit.onLayout!(layout(311.33)); });
    expect(fit).toEqual({ onLayout: expect.any(Function) });
    expect(fit).not.toHaveProperty('maxFontSizeMultiplier');
  });

  it('leaves the default and smaller text sizes alone', async () => {
    screen.fontScale = 1;
    await render(true, 'When should general membership meetings start?');
    await act(async () => { fit.onLayout!(layout(252)); });
    expect(fit).toEqual({ onLayout: expect.any(Function) });
    screen.fontScale = 0.82;
    await render(true, 'Supercalifragilisticexpialidocious');
    await act(async () => { fit.onLayout!(layout(120)); });
    expect(fit).toEqual({ onLayout: expect.any(Function) });
  });

  it('never draws below the default size', async () => {
    await render(true, 'Supercalifragilisticexpialidocious');
    await act(async () => { fit.onLayout!(layout(120)); });
    expect(fit.style).toEqual({ fontSize: 17, lineHeight: 23 });
  });

  it('adds nothing to a text that has not opted in', async () => {
    await render(false, 'membership');
    expect(fit).toEqual({});
  });
});
