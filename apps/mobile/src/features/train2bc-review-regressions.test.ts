import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import palette from '../theme/palette.json';

// Run the real component hooks and actions against native host elements and
// controlled backend replies; this proves no physical-device receipt.
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
    app: {} as Record<string, unknown>,
    loadStatus: vi.fn<() => Promise<unknown>>(),
    listReminders: vi.fn<() => Promise<unknown>>(),
    channelHistory: vi.fn<() => Promise<unknown>>(),
    updateReminder: vi.fn(async () => ({ available: true })),
  };
});
vi.mock('react', async (original) => ({ ...await original<typeof React>(), useState: host.useState, useRef: host.useRef, useMemo: host.useMemo, useCallback: host.useCallback, useEffect: host.useEffect, useLayoutEffect: host.useEffect }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', StyleSheet: { create: (value: unknown) => value } }));
vi.mock('expo-router', () => ({ Redirect: 'Redirect', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../components/ui', () => ({ Body: 'Body', Button: 'Button', Card: 'Card', Heading: 'Heading', Screen: 'Screen', StateMessage: 'StateMessage' }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: 'PinnedHeaderScreen' }));
vi.mock('../components/ReminderPicker', () => ({ ReminderPicker: 'ReminderPicker' }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../state/AppProvider', () => ({ useApp: () => host.app }));
// The organization has PIN sign-in on and released (#8586).
vi.mock('../services/memberSwitches', () => ({ useMemberSwitch: () => true }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => ({ check: async () => 'current' }), getSupabaseClient: () => ({}), loadMyMemberPinStatus: host.loadStatus, saveMyMemberPin: vi.fn(), removeMyMemberPin: vi.fn(), endMyMemberPinSessions: vi.fn() }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => ({ listReminders: host.listReminders, updateReminder: host.updateReminder }) }));
vi.mock('../lib/connectedWorkflowRoutes', () => ({ nativeWorkflowRoute: () => null }));
vi.mock('../lib/featureCatalog', () => ({ canOpenFeature: () => true, isFeatureKey: () => true }));
vi.mock('../../../../src/features/messaging/remindHere.js', () => ({ listChannelHereReminders: host.channelHistory }));

import RemindersRoute from '../../app/reminders';

type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
function elements(tree: React.ReactNode): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!React.isValidElement(tree)) return [];
  const node = tree as Node;
  return [node, ...elements(node.props.children)];
}
function drawReminders() {
  const component = elements(RemindersRoute()).find((node) => typeof node.type === 'function' && node.type.name === 'ReminderList');
  if (!component) throw new Error('Reminder list missing');
  host.start('reminders');
  const tree = (component.type as (props: Record<string, unknown>) => React.ReactNode)(component.props);
  host.flush(); return tree;
}
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
const buttonLabels = (tree: React.ReactNode) => elements(tree).filter((node) => node.type === 'Button').map((node) => node.props.label);

beforeEach(() => {
  host.dispose(); host.loadStatus.mockReset(); host.listReminders.mockReset(); host.channelHistory.mockReset(); host.updateReminder.mockClear();
  host.app = { mode: 'authenticated', session: { user: { id: 'member-a' }, access_token: 'pin-token' }, liveSampleBackend: false,
    dashboard: { member: { chapterID: 'chapter-a', language: 'en' } }, organizationID: 'org-a', authorizedRoles: [], chapterRoles: [], organizationRoles: [] };
  host.loadStatus.mockResolvedValue({ available: true, hasPin: true, sessionRestricted: true, otherPinSessions: 2 });
  host.listReminders.mockResolvedValue({ items: [], nextCursor: null }); host.channelHistory.mockResolvedValue([]);
});
afterEach(() => host.dispose());

describe('native restore review regressions', () => {
  it('shows the creator reminder once with its management actions and retains received history', async () => {
    host.listReminders.mockResolvedValue({ items: [{ id: 'owned', kind: 'channel_here', status: 'delivered', remindAt: '2026-10-03T08:00:00Z', title: 'general', note: 'Owned note' }], nextCursor: null });
    host.channelHistory.mockResolvedValue([
      { id: 'owned', mine: true, spaceName: 'general', note: 'Owned note', deliveredAt: null },
      { id: 'received', mine: false, authorName: 'Worker', spaceName: 'general', note: 'Received note', deliveredAt: null },
    ]);
    drawReminders(); await settle(); const tree = drawReminders();
    expect(elements(tree).filter((node) => node.type === 'Card')).toHaveLength(2);
    expect(elements(tree).filter((node) => node.type === 'Body' && React.Children.toArray(node.props.children).join('').includes('Owned note'))).toHaveLength(1);
    expect(buttonLabels(tree)).toEqual(['Complete', 'Cancel']);
    const complete = elements(tree).find((node) => node.props.label === 'Complete');
    (complete?.props.onPress as () => void)(); await settle();
    expect(host.updateReminder).toHaveBeenCalledWith('owned', 'complete', undefined);
  });
});
