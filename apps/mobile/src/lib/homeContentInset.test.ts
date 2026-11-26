import { describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ os: 'android', bottom: 24 }));
vi.mock('react-native', () => ({
  Animated: { Value: class { constructor(_value: number) {} } },
  Platform: { get OS() { return runtime.os; } },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: runtime.bottom }),
}));

const { useNativeTabContentInset } = await import('./chrome');

describe('full-height Home inset opt-in', () => {
  it.each([
    { os: 'android', bottom: 24, home: 108, other: 56 },
    { os: 'android', bottom: 48, home: 132, other: 80 },
    { os: 'ios', bottom: 34, home: 66, other: 66 },
  ])('reserves only the Home-owned Android controls on $os with inset $bottom', ({ os, bottom, home, other }) => {
    runtime.os = os; runtime.bottom = bottom;
    expect(useNativeTabContentInset(true)).toBe(home);
    expect(useNativeTabContentInset()).toBe(other);
  });
});
