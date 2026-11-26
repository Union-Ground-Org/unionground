// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExposed, exposedNames, Platform, press, Pressable, render, setPlatform, Text, View, type Rendered } from './reactNativeStandIn';

// The shared stand-in keeps the three platform rules screen tests rely on (#8319).
let screen: Rendered | null = null;
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe('shared React Native stand-in', () => {
  it('hides the children of an accessible container from assistive technology', async () => {
    screen = await render(h(View, null,
      h(View, { accessible: true, accessibilityLabel: 'Sheet' }, h(Pressable, { accessibilityLabel: 'Inner', onPress: () => {} }, h(Text, null, 'Inner'))),
      h(Pressable, { accessibilityLabel: 'Outer', onPress: () => {} }, h(Text, null, 'Outer'))));
    expect(exposedNames(screen.container)).toEqual(['Sheet', 'Outer']);
    expect(() => getExposed(screen!.container, 'Inner')).toThrow(/Nothing exposed as Inner/);
  });

  it('delivers a press to the pressed element only, and never to a disabled one', async () => {
    const outer = vi.fn(); const inner = vi.fn(); const off = vi.fn();
    screen = await render(h(View, null,
      h(Pressable, { accessible: false, accessibilityLabel: 'Row', onPress: outer }, h(Pressable, { accessibilityLabel: 'Open', onPress: inner }, h(Text, null, 'Open'))),
      h(Pressable, { accessibilityLabel: 'Off', disabled: true, onPress: off }, h(Text, null, 'Off'))));
    await press(getExposed(screen.container, 'Open'));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    await press(getExposed(screen.container, 'Off'));
    expect(off).not.toHaveBeenCalled();
  });

  it('switches the platform per test', () => {
    expect(Platform.OS).toBe('ios');
    expect(Platform.select({ ios: 'swipe', android: 'back' })).toBe('swipe');
    setPlatform('android');
    expect(Platform.select({ ios: 'swipe', android: 'back' })).toBe('back');
  });

  it('returns a present platform key even when it is null or undefined, as React Native does', () => {
    expect(Platform.select({ ios: null, default: 'fallback' })).toBeNull();
    expect(Platform.select({ ios: undefined, native: 'native', default: 'fallback' })).toBeUndefined();
    expect(Platform.select({ native: null, default: 'fallback' })).toBeNull();
    expect(Platform.select({ android: 'back', default: 'fallback' })).toBe('fallback');
    setPlatform('android');
    expect(Platform.select({ android: null, ios: 'swipe', default: 'fallback' })).toBeNull();
  });
});
