import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import palette from '../../theme/palette.json';
import { learningCopy } from '../../lib/learningContentCopy';
import { normalizeLearningItem, type LearningItem } from '../../lib/learningContentModel';

// Execute the real manager/editor callbacks using the mobile suite's hook-host
// pattern. Native controls and the authenticated API are the mocked boundaries.
const host = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  const frames = new Map<unknown, Slot[]>();
  let slots: Slot[] = []; let cursor = 0;
  const pending: Array<() => void> = [];
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) => !a || !b || a.length !== b.length || a.some((x, i) => x !== b[i]);
  const slot = () => { const i = cursor++; return slots[i] ?? (slots[i] = {}); };
  return {
    start(key: unknown) { slots = frames.get(key) ?? []; frames.set(key, slots); cursor = 0; },
    drop(key: unknown) { frames.get(key)?.forEach((s) => s.cleanup?.()); frames.delete(key); },
    reset() { frames.forEach((frame) => frame.forEach((s) => s.cleanup?.())); frames.clear(); pending.length = 0; },
    flush() { pending.splice(0).forEach((fn) => fn()); },
    useState(initial: unknown) { const s = slot(); if (!('value' in s)) s.value = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [s.value, (next: unknown) => { s.value = typeof next === 'function' ? (next as (previous: unknown) => unknown)(s.value) : next; }]; },
    useRef(initial: unknown) { const s = slot(); if (!('value' in s)) s.value = { current: initial }; return s.value; },
    useCallback(fn: unknown, deps: readonly unknown[]) { const s = slot(); if (changed(s.deps, deps)) { s.value = fn; s.deps = deps; } return s.value; },
    useEffect(fn: () => void | (() => void), deps?: readonly unknown[]) { const s = slot(); if (changed(s.deps, deps)) { s.deps = deps; pending.push(() => { s.cleanup?.(); s.cleanup = fn() || undefined; }); } },
    useMemo(fn: () => unknown, deps: readonly unknown[]) { const s = slot(); if (changed(s.deps, deps)) { s.value = fn(); s.deps = deps; } return s.value; },
    // The memory-only draft holder (record 9240): each draw reads it again.
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, snapshot: () => unknown) { const s = slot(); if (!s.cleanup) s.cleanup = subscribe(() => undefined); return snapshot(); },
    scope: {} as Record<string, unknown>,
    alertActions: [] as Array<{ text: string; onPress?: () => void }>,
    getPolicy: vi.fn(), getWorkspace: vi.fn(), saveContent: vi.fn(), transition: vi.fn(),
  };
});

vi.mock('react', async (original) => ({ ...await original<typeof React>(), useState: host.useState, useRef: host.useRef, useCallback: host.useCallback, useEffect: host.useEffect, useMemo: host.useMemo, useSyncExternalStore: host.useSyncExternalStore }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 }, Alert: { alert: (_title: string, _message: string, actions: typeof host.alertActions) => { host.alertActions = actions; } } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({ setOptions: vi.fn() }) }));
vi.mock('../../components/ui', () => Object.fromEntries(['Body', 'Button', 'Card', 'Heading', 'Screen', 'StateMessage', 'StatusPill'].map((name) => [name, name])));
vi.mock('./LearningControls', () => Object.fromEntries(['LearningCheckRow', 'LearningChoiceGroup', 'LearningFact', 'LearningListField', 'LearningMessages', 'LearningRowAction', 'LearningTextField', 'LearningToggleRow'].map((name) => [name, name])));
vi.mock('./LearningItemView', () => ({ LearningItemView: 'LearningItemView' }));
vi.mock('../../lib/screenBack', () => ({ useScreenBackInterceptor: vi.fn() }));
vi.mock('../../services/haptics', () => ({ haptics: { success: vi.fn(), warning: vi.fn() } }));
vi.mock('../../services/supabase', () => ({ createCapturedSessionRpcClient: vi.fn() }));
// The signed-in chapter officer the provider syncs into the draft holder.
vi.mock('../../state/AppProvider', async () => (await import('../../testing/retainedDraftHarness')).appProviderStandIn);
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-1' }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('./useLearningContent', async () => {
  const { learningCopy } = await import('../../lib/learningContentCopy');
  return { useLearningScope: () => host.scope, useLearningCopy: () => learningCopy('en'), manageableLearningScopes: () => ['chapter'] };
});

import { LearningContentManager } from './LearningContentManager';
import { signIn } from '../../testing/retainedDraftHarness';
import { LearningRequestError } from '../../services/learningContent';

type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
function nodes(tree: React.ReactNode): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement(tree)) return [];
  const node = tree as Node;
  return [node, ...nodes(node.props.children)];
}
function named(tree: React.ReactNode, label: string): Node {
  const node = nodes(tree).find((n) => n.props.label === label || n.props.accessibilityLabel === label);
  if (!node) throw new Error(`Missing control: ${label}`);
  return node;
}
function component(tree: React.ReactNode, name: string): Node {
  const node = nodes(tree).find((n) => typeof n.type === 'function' && n.type.name === name);
  if (!node) throw new Error(`Missing component: ${name}`);
  return node;
}
function draw(node: Node): React.ReactNode {
  if (typeof node.type !== 'function') throw new Error('Expected a function component');
  host.start(node.type);
  const tree = (node.type as (props: Node['props']) => React.ReactNode)(node.props);
  host.flush();
  return tree;
}
const press = (node: Node) => (node.props.onPress as () => void)();
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
const copy = learningCopy('en');
let current: LearningItem;
beforeEach(() => {
  host.reset(); vi.clearAllMocks(); vi.stubGlobal('React', React); signIn('chapter');
  current = normalizeLearningItem({ id: 'a1b2c3d4-0000-4000-8000-00000000000a', scope: 'chapter', organization_id: 'org-a', chapter_id: 'chapter-a', kind: 'quote', locale: 'en', locale_state: 'reviewed', title: 'Reviewed writing', body: 'Original writing.', source: 'Original authored writing', rights_note: 'Author permits reuse.', review_note: 'Reviewed.', audience: 'all', status: 'draft', priority: 0, revision: 3 })!;
  expect(current).not.toBeNull();
  host.getPolicy.mockResolvedValue({ canManage: true, isPlatformOwner: false });
  host.getWorkspace.mockImplementation(async () => ({ items: [current], hasMore: false, policy: { quotesEnabled: true, lessonsEnabled: true, selectedIds: null, revision: 1 } }));
  host.scope = { scopeKey: 'session-a/chapter-a/en', source: 'live', userId: 'editor-a', organizationId: 'org-a', chapterId: 'chapter-a', locale: 'en', captureGuard: () => () => true, api: { getPolicy: host.getPolicy, getWorkspace: host.getWorkspace, saveContent: host.saveContent, transition: host.transition } };
});
afterEach(() => { host.reset(); vi.unstubAllGlobals(); });

describe('native learning editor conflict recovery', () => {
  it.each(['save', 'publication'] as const)('reloads the current revision after a %s conflict without silently replacing the open draft', async (action) => {
    host.start(LearningContentManager);
    const manager = LearningContentManager({ onClose: vi.fn(), origin: 'account' }) as Node;
    host.flush(); draw(manager); await settle(); draw(manager); await settle();
    press(named(draw(manager), copy.editLabel(current.title)));
    let managerTree = draw(manager);
    const editor = component(managerTree, 'LearningItemEditor');
    let editorTree = draw(editor);
    current = { ...current, revision: 4, title: 'Newer reviewed writing' };
    if (action === 'save') {
      (named(editorTree, copy.fields.title).props.onChangeText as (value: string) => void)('My unsaved draft');
      editorTree = draw(editor);
      host.saveContent.mockRejectedValueOnce(new LearningRequestError('conflict', 'stale revision'));
      press(named(editorTree, copy.saveDraft)); await settle(); editorTree = draw(editor);
      expect(named(editorTree, copy.fields.title).props.value).toBe('My unsaved draft');
    } else {
      const publication = component(editorTree, 'PublicationPanel');
      press(named(draw(publication), copy.publishNow));
      host.transition.mockRejectedValueOnce(new LearningRequestError('conflict', 'stale revision'));
      press(named(draw(publication), copy.confirm)); await settle();
      expect(nodes(draw(publication)).some((n) => (n.props.messages as string[] | undefined)?.includes(copy.conflict))).toBe(true);
      host.drop(publication.type);
    }
    expect(host.getWorkspace).toHaveBeenCalledTimes(1);
    managerTree = draw(manager); press(named(managerTree, copy.backToList));
    if (action === 'save') {
      expect(host.alertActions.some((a) => a.text === copy.discard)).toBe(true);
      expect(host.getWorkspace).toHaveBeenCalledTimes(1);
      host.alertActions.find((a) => a.text === copy.discard)?.onPress?.();
    }
    host.drop(editor.type);
    await settle(); managerTree = draw(manager);
    expect(host.getWorkspace).toHaveBeenCalledTimes(2);
    press(named(managerTree, copy.editLabel('Newer reviewed writing')));
    const reopened = component(draw(manager), 'LearningItemEditor');
    editorTree = draw(reopened);
    expect(named(editorTree, copy.fields.title).props.value).toBe('Newer reviewed writing');
    (named(editorTree, copy.fields.title).props.onChangeText as (value: string) => void)('Reviewed final writing');
    host.saveContent.mockResolvedValueOnce({ ...current, revision: 5, title: 'Reviewed final writing' });
    press(named(draw(reopened), copy.saveDraft)); await settle();
    expect(host.saveContent).toHaveBeenLastCalledWith(expect.objectContaining({ form: expect.objectContaining({ revision: 4, title: 'Reviewed final writing' }) }));
    expect(nodes(draw(reopened)).some((n) => (n.props.messages as string[] | undefined)?.includes(copy.saved))).toBe(true);
  });
});
