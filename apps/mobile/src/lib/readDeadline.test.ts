import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import palette from '../theme/palette.json';
import { READ_DEADLINE_MS, ReadDeadlineError, withReadDeadline } from './readDeadline';

// BUG-UG-NATIVE-REMINDERS-UNBOUNDED-LOAD-WITHOUT-RETRY-20261111
// (#8287): a Reminders read that never settled left "Loading reminders" up
// forever with no Retry. These runs execute the actual RemindersRoute and
// ReminderList hooks (shared by Android and iPhone) against a persistently
// pending local backend; only native hosts and data ports are fixtures.
const host = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  const instances = new Map<string, Slot[]>();
  let slots: Slot[] = []; let cursor = 0;
  const pending: Array<() => void> = [];
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  const slot = () => { const index = cursor++; return slots[index] ?? (slots[index] = {}); };
  return {
    start: (id: string) => { slots = instances.get(id) ?? []; instances.set(id, slots); cursor = 0; },
    flush: () => pending.splice(0).forEach((effect) => effect()),
    dispose: () => { instances.forEach((entries) => entries.forEach((entry) => entry.cleanup?.())); instances.clear(); pending.length = 0; },
    useState: (initial: unknown) => {
      const entry = slot(); if (!('value' in entry)) entry.value = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [entry.value, (next: unknown) => { entry.value = typeof next === 'function' ? (next as (value: unknown) => unknown)(entry.value) : next; }];
    },
    useRef: (initial: unknown) => { const entry = slot(); if (!('value' in entry)) entry.value = { current: initial }; return entry.value; },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const entry = slot(); if (changed(entry.deps, deps)) { entry.deps = deps; pending.push(() => { entry.cleanup?.(); entry.cleanup = effect() || undefined; }); }
    },
    app: {} as Record<string, unknown>,
    listReminders: vi.fn<() => Promise<unknown>>(),
    channelHistory: vi.fn<() => Promise<unknown>>(),
  };
});
vi.mock('react', async (original) => ({ ...await original<typeof React>(), useState: host.useState, useRef: host.useRef, useEffect: host.useEffect, useLayoutEffect: host.useEffect }));
vi.mock('expo-router', () => ({ Redirect: 'Redirect', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../components/ui', () => ({ Body: 'Body', Button: 'Button', Card: 'Card', Heading: 'Heading', Screen: 'Screen', StateMessage: 'StateMessage' }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: 'PinnedHeaderScreen' }));
vi.mock('../components/ReminderPicker', () => ({ ReminderPicker: 'ReminderPicker' }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../state/AppProvider', () => ({ useApp: () => host.app }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => ({}) }));
vi.mock('./connectedWorkflows', () => ({ connectedWorkflowApi: () => ({ listReminders: host.listReminders, updateReminder: vi.fn() }) }));
vi.mock('./connectedWorkflowRoutes', () => ({ nativeWorkflowRoute: () => null }));
vi.mock('./featureCatalog', () => ({ canOpenFeature: () => true, isFeatureKey: () => true }));
vi.mock('../../../../src/features/messaging/remindHere.js', () => ({ listChannelHereReminders: host.channelHistory }));

import RemindersRoute from '../../app/reminders';

type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
function elements(tree: React.ReactNode): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!React.isValidElement(tree)) return [];
  const node = tree as Node;
  return [node, ...elements(node.props.children)];
}
function textOf(tree: React.ReactNode): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(' ');
  return React.isValidElement(tree) ? textOf((tree as Node).props.children) : '';
}
function draw() {
  const list = elements(RemindersRoute()).find((node) => typeof node.type === 'function' && node.type.name === 'ReminderList');
  if (!list) throw new Error('Reminder list missing');
  host.start('reminders');
  const tree = (list.type as (props: Record<string, unknown>) => React.ReactNode)(list.props);
  host.flush(); return tree;
}
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
const titles = (tree: React.ReactNode) => elements(tree).filter((node) => node.type === 'StateMessage').map((node) => node.props.title);
const retry = (tree: React.ReactNode) => elements(tree).find((node) => node.type === 'Button' && node.props.label === 'Try again')?.props as { disabled?: boolean; onPress?: () => void } | undefined;
const page = (note: string) => ({ items: [{ id: note, kind: 'channel_here', status: 'scheduled', remindAt: '2026-11-20T15:00:00Z', title: note, note }], nextCursor: null });
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  host.dispose(); host.listReminders.mockReset(); host.channelHistory.mockReset();
  host.channelHistory.mockResolvedValue([]);
  host.app = { mode: 'authenticated', session: { user: { id: 'member-a' } }, dashboard: { member: { chapterID: 'chapter-a', language: 'en' } },
    organizationID: 'org-a', authorizedRoles: [], chapterRoles: [], organizationRoles: [], previewHat: null };
});
afterEach(() => { host.dispose(); vi.useRealTimers(); });

describe('withReadDeadline', () => {
  it('rejects a read that never settles once the deadline passes, and passes a prompt one through', async () => {
    const stalled = withReadDeadline(never());
    const outcome = expect(stalled).rejects.toBeInstanceOf(ReadDeadlineError);
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    await outcome;
    await expect(withReadDeadline(Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('native Reminders reads (Android and iPhone)', () => {
  it('turns a stalled read into a visible Try again, and a retry renders a later success', async () => {
    host.listReminders.mockImplementationOnce(never);
    expect(titles(draw())).toContain('Loading reminders');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await settle();
    const failed = draw();
    expect(titles(failed)).toEqual(['Reminders could not be loaded']);
    expect(retry(failed)?.disabled).toBe(false);

    host.listReminders.mockResolvedValueOnce(page('Bring the overtime log'));
    retry(failed)!.onPress!();
    draw(); await settle();
    const recovered = draw();
    expect(titles(recovered)).toEqual([]);
    expect(textOf(recovered)).toContain('Bring the overtime log');
  });

  it('never publishes a reply that arrives after its deadline', async () => {
    let answerLate: (value: unknown) => void = () => {};
    host.listReminders.mockImplementationOnce(() => new Promise((resolve) => { answerLate = resolve; }));
    draw();
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    await settle();
    expect(titles(draw())).toEqual(['Reminders could not be loaded']);
    answerLate(page('Stale reminder'));
    await settle();
    const tree = draw();
    expect(textOf(tree)).not.toContain('Stale reminder');
    expect(titles(tree)).toEqual(['Reminders could not be loaded']);
  });

  it('keeps the ordinary recovery for a rejected read', async () => {
    host.listReminders.mockRejectedValueOnce(new Error('network down'));
    draw(); await settle();
    const failed = draw();
    expect(titles(failed)).toEqual(['Reminders could not be loaded']);
    host.listReminders.mockResolvedValueOnce(page('Committee check-in'));
    retry(failed)!.onPress!();
    draw(); await settle();
    expect(textOf(draw())).toContain('Committee check-in');
  });
});
