import { stubSessionWriter } from '../testing/stubSessionWriter';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import palette from '../theme/palette.json';

// Execute the screen's real hooks and callbacks, replacing only the native
// host and network. This does not simulate TalkBack speech or device focus.
const host = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  const instances = new Map<string, Slot[]>();
  let slots: Slot[] = []; let cursor = 0;
  const pending: Array<() => void> = [];
  const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  const slot = () => { const index = cursor++; return slots[index] ?? (slots[index] = {}); };
  const useMemo = (factory: () => unknown, deps: readonly unknown[]) => {
    const entry = slot(); if (changed(entry.deps, deps)) { entry.value = factory(); entry.deps = deps; } return entry.value;
  };
  return {
    start: (id: string) => { slots = instances.get(id) ?? []; instances.set(id, slots); cursor = 0; },
    flush: () => pending.splice(0).forEach((effect) => effect()),
    dispose: () => { instances.forEach((entries) => entries.forEach((entry) => entry.cleanup?.())); instances.clear(); pending.length = 0; },
    useState: (initial: unknown) => {
      const entry = slot(); if (!('value' in entry)) entry.value = typeof initial === 'function' ? initial() : initial;
      return [entry.value, (next: unknown) => { entry.value = typeof next === 'function' ? next(entry.value) : next; }];
    },
    useRef: (initial: unknown) => { const entry = slot(); if (!('value' in entry)) entry.value = { current: initial }; return entry.value; },
    useMemo,
    useCallback: (callback: unknown, deps: readonly unknown[]) => useMemo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const entry = slot(); if (changed(entry.deps, deps)) { entry.deps = deps; pending.push(() => { entry.cleanup?.(); entry.cleanup = effect() || undefined; }); }
    },
    app: {} as Record<string, unknown>, platform: { OS: 'android' },
    load: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    listHandoffs: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
});
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('react', async (original) => ({ ...await original<typeof React>(), useState: host.useState, useRef: host.useRef, useMemo: host.useMemo, useCallback: host.useCallback, useEffect: host.useEffect, useLayoutEffect: host.useEffect }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', Alert: { alert: vi.fn() }, Platform: host.platform, StyleSheet: { create: (value: unknown) => value } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-id' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../components/ui', () => ({ Body: 'Body', Button: 'Button', Card: 'Card', Heading: 'Heading', Notice: 'Notice', Screen: 'Screen', StateMessage: 'StateMessage' }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../state/AppProvider', () => ({ useApp: () => host.app }));
vi.mock('../lib/config', () => ({ mobileConfig: { portalBaseUrl: 'https://example.test' } }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => null, session?.user?.id ?? 'member-a'),  getSupabaseClient: () => null }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('../lib/announce', () => ({ queueAccessibilityAnnouncement: vi.fn() }));
vi.mock('../../../../src/features/memberSupport/index.js', async (original) => ({
  ...await original<Record<string, unknown>>(),
  createMemberSupportAdapter: () => ({ load: host.load, listHandoffs: host.listHandoffs }),
}));

import { MemberSupportScreen } from './MemberSupportScreen';

type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
function elements(tree: React.ReactNode): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!React.isValidElement(tree)) return [];
  const node = tree as Node;
  return [node, ...elements(node.props.children)];
}
function draw() { host.start('screen'); const tree = MemberSupportScreen(); host.flush(); return tree; }
function emergency(tree: React.ReactNode) {
  const node = elements(tree).find((entry) => typeof entry.type === 'function' && entry.type.name === 'EmergencyPanel');
  if (!node) throw new Error('Emergency panel is not mounted');
  host.start('emergency');
  const rendered = (node.type as (props: Record<string, unknown>) => React.ReactNode)(node.props);
  host.flush(); return rendered;
}
async function settle() { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }
function radios(tree: React.ReactNode) { return elements(tree).filter((node) => node.props.accessibilityRole === 'radio'); }
async function ready() { draw(); await settle(); return draw(); }

beforeEach(() => {
  host.dispose(); host.platform.OS = 'android'; host.load.mockReset(); host.listHandoffs.mockClear();
  host.app = { mode: 'authenticated', dashboard: { member: { id: 'member-a', chapterID: 'chapter-a' } }, previewHat: null,
    authorizedRoles: [], chapterMemberships: [{ selected: true, chapterID: 'chapter-a' }], organizationID: 'org-a', organizationRoles: [], chapterRoles: [] };
  host.load.mockResolvedValue({ state: 'ready', staff: false, viewerUserId: 'member-a', emergencyChecklists: [] });
});
afterEach(() => host.dispose());

describe('Worker Support spoken choices and focus stability', () => {
  it('exposes the group, option and position while keeping every radio independently selectable', async () => {
    let tree = emergency(await ready());
    expect(radios(tree).map((node) => node.props.accessibilityLabel)).toEqual([
      'Emergency scenario, Disciplinary meeting, 1 of 3',
      'Emergency scenario, Pre-discipline response, 2 of 3',
      'Emergency scenario, Unsafe work, 3 of 3',
    ]);
    const group = elements(tree).find((node) => node.props.accessibilityRole === 'radiogroup');
    expect(group?.props.accessible).not.toBe(true);
    expect(radios(tree).map((node) => node.props.accessibilityState)).toEqual([{ selected: true }, { selected: false }, { selected: false }]);
    (radios(tree)[1]!.props.onPress as () => void)();
    tree = emergency(draw());
    expect(radios(tree).map((node) => node.props.accessibilityState)).toEqual([{ selected: false }, { selected: true }, { selected: false }]);
    expect(host.load).toHaveBeenCalledTimes(1);
  });

  it('does not replace the loaded choices when equivalent provider arrays and membership objects are recreated', async () => {
    await ready();
    host.app = { ...host.app, authorizedRoles: [], organizationRoles: [], chapterRoles: [], chapterMemberships: [{ selected: true, chapterID: 'chapter-a' }] };
    draw(); await settle(); const tree = draw();
    expect(host.load).toHaveBeenCalledTimes(1);
    expect(radios(emergency(tree))).toHaveLength(3);
  });

  it.each([
    ['member', { dashboard: { member: { id: 'member-b', chapterID: 'chapter-a' } } }],
    ['organization', { organizationID: 'org-b' }],
    ['chapter', { chapterMemberships: [{ selected: true, chapterID: 'chapter-b' }] }],
    ['organization permission', { authorizedRoles: ['steward'], organizationRoles: ['steward'] }],
    ['campaign permission', { authorizedRoles: ['steward'], chapterRoles: ['steward'] }],
    ['authentication', { mode: 'signedOut' }],
  ])('reloads when the %s actually changes', async (_label, change) => {
    await ready(); const previous = host.load.mock.calls[0]?.[0];
    host.app = { ...host.app, ...change }; draw(); await settle();
    expect(host.load).toHaveBeenCalledTimes(2);
    expect(host.load.mock.calls[1]?.[0]).not.toEqual(previous);
  });

  it('keeps iOS radio names and selection behavior unchanged', async () => {
    host.platform.OS = 'ios'; let tree = emergency(await ready());
    expect(radios(tree).map((node) => node.props.accessibilityLabel)).toEqual([undefined, undefined, undefined]);
    (radios(tree)[2]!.props.onPress as () => void)(); tree = emergency(draw());
    expect(radios(tree)[2]!.props.accessibilityState).toEqual({ selected: true });
  });
});
