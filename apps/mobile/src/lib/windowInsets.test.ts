import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The window's bottom inset that the Messages organize
// sheet and the steward finder pad from.
// Named here because the pinned Semgrep parser rejects an inline import type
// as a generic argument in original<typeof import(...)>().
type ReactModule = typeof import('react');
const port = vi.hoisted(() => ({ startupBottom: null as number | null, providerBottom: 0 }));
vi.mock('react', async (original) => ({
  ...await original<ReactModule>(),
  useEffect: (effect: () => void) => { effect(); },
}));
vi.mock('react-native-safe-area-context', () => ({
  get initialWindowMetrics() {
    return port.startupBottom === null ? null : { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: port.startupBottom } };
  },
  useSafeAreaInsets: () => ({ top: 47, left: 0, right: 0, bottom: port.providerBottom }),
}));

const { WindowBottomInsetPublisher, publishWindowBottomInset, readWindowBottomInset, resetWindowBottomInsetForTests } = await import('./windowInsets');

afterEach(() => { resetWindowBottomInsetForTests(); port.startupBottom = null; port.providerBottom = 0; });

const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
function appFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? appFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the window bottom inset', () => {
  it('does not trust a published 0 while the startup snapshot is positive', () => {
    port.startupBottom = 34;
    publishWindowBottomInset(0);
    // On Main the published 0 won, and the last button sat in the home indicator.
    expect(readWindowBottomInset()).toBe(34);
    publishWindowBottomInset(48);
    expect(readWindowBottomInset()).toBe(48);
    // With no inset at startup either, a 0 is the window's real inset.
    port.startupBottom = 0;
    publishWindowBottomInset(0);
    expect(readWindowBottomInset()).toBe(0);
  });

  it('uses the startup snapshot, else 0, until a value is published', () => {
    expect(readWindowBottomInset()).toBe(0);
    port.startupBottom = 24;
    expect(readWindowBottomInset()).toBe(24);
  });

  it('publishes the bottom inset of the provider it is rendered under, and follows it', () => {
    port.startupBottom = 24;
    for (const bottom of [24, 48, 24]) {
      port.providerBottom = bottom;
      WindowBottomInsetPublisher();
      expect(readWindowBottomInset()).toBe(bottom);
    }
  });

  it('is published from the app\'s one root SafeAreaProvider, whose view is the whole window, and from nowhere else', () => {
    // The root layout renders the publisher as the provider's first child, so
    // no tab bar or nested provider can sit between them.
    expect(source('../../app/_layout.tsx')).toMatch(/<SafeAreaProvider>\n\s+<WindowBottomInsetPublisher \/>/);
    const files = appFiles(fileURLToPath(new URL('../../app', import.meta.url)));
    const providers = files.filter((file) => /<SafeAreaProvider[\s>]/.test(readFileSync(file, 'utf8')));
    expect(providers.map((file) => file.replace(/.*\/app\//, 'app/'))).toEqual(['app/_layout.tsx']);
    const publishers = files.filter((file) => /WindowBottomInsetPublisher|publishWindowBottomInset/.test(readFileSync(file, 'utf8')));
    expect(publishers.map((file) => file.replace(/.*\/app\//, 'app/'))).toEqual(['app/_layout.tsx']);
    // The provider takes no initial metrics, so it renders its children only
    // after the native window measurement: the first value published is real.
    expect(source('../../app/_layout.tsx')).not.toMatch(/<SafeAreaProvider[^>]*initialMetrics/);
  });
});
