// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// UX-UG-NATIVE-ADMIN-FEATURE-ROWS-OPEN-CHAPTER-ADMIN-WITHOUT-THEIR-CONTENT-20261109:
// five Admin rows opened /feature/admin, which shows only the chapter's
// optional connections. This mounts the shipped All features list with the
// Admin hat's live groups (native hosts replaced, as in the other mobile render
// tests), taps every Admin row and checks where each one goes.

const runtime = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: 'en' }) }));

vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const box = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    View: box,
    Text: box,
    ScrollView: box,
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string }) => (
      h('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, typeof children === 'function' ? null : children)
    ),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Platform: { OS: 'android', select: <T,>(options: { android?: T; default?: T }) => options.android ?? options.default },
    useWindowDimensions: () => ({ width: 360, height: 800, scale: 2.625, fontScale: 1 }),
  };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: runtime.push }) }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => undefined }));
vi.mock('../services/haptics', () => ({ haptics: { select: async () => undefined, impact: async () => undefined } }));
vi.mock('../lib/quickActions', () => ({ PINNED_DESTINATIONS_STORE_PREFIX: 'test-shortcuts' }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#000000' }) }));
vi.mock('./FontScaleRelayout', async () => {
  const { createElement: h } = await import('react');
  return { FontScaleRelayout: ({ children }: { children?: ReactNode }) => h('div', null, children) };
});
vi.mock('./RowHighlight', async () => {
  const { createElement: h } = await import('react');
  const box = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return { HighlightList: box, HighlightRow: box };
});
vi.mock('./ui', async () => {
  const { createElement: h } = await import('react');
  return {
    Body: ({ children }: { children?: ReactNode }) => h('div', null, children),
    SearchField: ({ accessibilityLabel }: { accessibilityLabel?: string }) => h('input', { 'aria-label': accessibilityLabel }),
  };
});

import { FunctionDeck } from './FunctionDeck';
import { featureGroupsForRoles, STAFF_HAT_FUNCTIONS, workItemsForRoles, type HatFunctionGroup } from '../lib/hatFunctions';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.push.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(groups: HatFunctionGroup[]) {
  await act(async () => {
    root.render(createElement(FunctionDeck, { width: 320, height: 640, topPad: 0, bottomPad: 0, groups, onHome: () => undefined, shortcutScope: 'admin' }));
  });
}

// The directory row is the last button with the row's name; a shortcut for the
// same destination may sit above it in the rail.
function rowButton(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).filter((button) => button.getAttribute('aria-label') === label).at(-1);
}

const REMOVED_LABELS = ['Form templates', 'Contributions administration', 'Recent admin activity'];
const ADMIN_ROW_KEYS = new Set(['admin', 'admin-access', 'admin-events']);

describe('Admin rows in the native All features list', () => {
  for (const [scope, groups] of [
    ['campaign administrator', featureGroupsForRoles(['admin'])],
    ['organization administrator', featureGroupsForRoles([], ['admin'])],
  ] as const) {
    it(`opens each Admin row where its content is, for the ${scope}`, async () => {
      await mount([...groups]);
      const adminRows = groups.flatMap((group) => group.items).filter((item) => ADMIN_ROW_KEYS.has(item.key));
      expect(adminRows.map((item) => item.label).sort()).toEqual(
        scope === 'campaign administrator'
          ? ['Campaign admin', 'Meetings & check-in codes', 'Roles & access']
          : ['Campaign admin', 'Roles & access'],
      );
      for (const item of adminRows) {
        const button = rowButton(item.label);
        expect(button, item.label).toBeTruthy();
        runtime.push.mockReset();
        await act(async () => { button?.click(); });
        expect(runtime.push, item.label).toHaveBeenCalledWith(item.href);
      }
      expect(groups.flatMap((group) => group.items).find((item) => item.key === 'admin')?.href).toBe('/feature/admin');
      expect(groups.flatMap((group) => group.items).find((item) => item.key === 'admin-access')?.href).toBe('/feature/chapter-memberships');
      for (const label of REMOVED_LABELS) expect(rowButton(label), label).toBeUndefined();
      // The extra-verification status row is gone too, under whatever label.
      expect(groups.flatMap((group) => group.items).some((item) => item.key === 'admin-mfa')).toBe(false);
    });
  }

  it('links no Admin row other than Campaign admin to /feature/admin, in the list, in Work or on the desk', () => {
    const lists = [
      STAFF_HAT_FUNCTIONS.admin,
      featureGroupsForRoles(['admin']).flatMap((group) => group.items),
      featureGroupsForRoles([], ['admin']).flatMap((group) => group.items),
      workItemsForRoles(['admin']),
      workItemsForRoles([], ['admin']),
    ];
    for (const items of lists) {
      expect(items.filter((item) => item.href === '/feature/admin').map((item) => item.key)).toEqual(['admin']);
      for (const key of ['admin-mfa', 'admin-form-templates', 'admin-rewards', 'admin-audit']) {
        expect(items.some((item) => item.key === key), key).toBe(false);
      }
    }
  });

  it('sends Roles & access to a route that renders campaign role grants, and says only what that screen does', () => {
    const access = STAFF_HAT_FUNCTIONS.admin.find((item) => item.key === 'admin-access');
    expect(access).toMatchObject({ label: 'Roles & access', href: '/feature/chapter-memberships', blurb: 'Grant or revoke a person\'s campaign roles.' });
    expect(access?.blurb).not.toMatch(/invit/i);
    const feature = readFileSync(resolve('src/features/FeatureScreen.tsx'), 'utf8');
    const memberships = readFileSync(resolve('src/features/ChapterMembershipsScreen.tsx'), 'utf8');
    expect(feature).toContain("if (featureKey === 'chapter-memberships') {\n    return <ChapterMembershipsScreen />;");
    expect(memberships).toContain('<Heading level={3}>{copy.roleLabel}</Heading>');
    expect(memberships).toContain('copy.grantRole : copy.revokeRole');
    // Chapter admin's own row describes what Chapter admin shows (#7811).
    expect(STAFF_HAT_FUNCTIONS.admin.find((item) => item.key === 'admin')?.blurb).toBe('See your campaign\'s connected services and their setup.');
  });
});
