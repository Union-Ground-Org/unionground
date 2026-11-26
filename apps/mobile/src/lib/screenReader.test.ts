import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ resolve: (_value: boolean) => {}, reject: (_error: unknown) => {}, change: (_value: boolean) => {} }));
vi.mock('react', () => ({
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => boolean) => { subscribe(() => undefined); return snapshot(); },
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isScreenReaderEnabled: () => new Promise<boolean>((resolve, reject) => { probe.resolve = resolve; probe.reject = reject; }),
    addEventListener: (_event: string, listener: (value: boolean) => void) => { probe.change = listener; },
  },
}));

beforeEach(() => { vi.resetModules(); });

// A layout that would merge accessibility frames waits until the probe has
// answered that no screen reader runs.
describe('screen reader known off', () => {
  it('is false until the probe answers off, and false again when a reader starts', async () => {
    const { useScreenReader, useScreenReaderKnownOff } = await import('./screenReader');
    expect(useScreenReader()).toBe(false);
    expect(useScreenReaderKnownOff()).toBe(false);
    probe.resolve(false);
    await Promise.resolve();
    expect(useScreenReaderKnownOff()).toBe(true);
    probe.change(true);
    expect(useScreenReader()).toBe(true);
    expect(useScreenReaderKnownOff()).toBe(false);
  });

  it('keeps a newer change meeting over a first probe that answers late', async () => {
    const { useScreenReader, useScreenReaderKnownOff } = await import('./screenReader');
    expect(useScreenReaderKnownOff()).toBe(false);
    probe.change(true);
    probe.resolve(false);
    await Promise.resolve();
    expect(useScreenReader()).toBe(true);
    expect(useScreenReaderKnownOff()).toBe(false);
  });

  it('stays false when the probe fails', async () => {
    const { useScreenReaderKnownOff } = await import('./screenReader');
    expect(useScreenReaderKnownOff()).toBe(false);
    probe.reject(new Error('unavailable'));
    await Promise.resolve(); await Promise.resolve();
    expect(useScreenReaderKnownOff()).toBe(false);
  });
});
