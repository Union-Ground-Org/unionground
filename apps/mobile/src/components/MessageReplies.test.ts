import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EffectCleanup = void | (() => void);
type Effect = () => EffectCleanup;
type StateSetter = (next: unknown | ((current: unknown) => unknown)) => void;

const harness = vi.hoisted(() => {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effects: Effect[] = [];
  const pendingCleanups = new Set<() => void>();
  const appStateListeners = new Set<(state: string) => void>();
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;

  function disposeEffects() {
    for (const cleanup of [...pendingCleanups]) cleanup();
    pendingCleanups.clear();
  }

  return {
    fontScale: undefined as number | undefined,
    reset() {
      disposeEffects();
      states.length = 0;
      refs.length = 0;
      effects.length = 0;
      appStateListeners.clear();
      stateCursor = 0;
      refCursor = 0;
      effectCursor = 0;
    },
    disposeEffects,
    beginRender() {
      stateCursor = 0;
      refCursor = 0;
    },
    useState(initial: unknown): [unknown, StateSetter] {
      const index = stateCursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (next) => {
        states[index] = typeof next === 'function'
          ? (next as (current: unknown) => unknown)(states[index])
          : next;
      }];
    },
    useRef(initial: unknown): { current: unknown } {
      const index = refCursor++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index]!;
    },
    useEffect(effect: Effect) {
      effects.push(effect);
    },
    runNextEffect(): EffectCleanup {
      const effect = effects[effectCursor++];
      if (!effect) throw new Error('Expected a queued effect');
      const cleanup = effect();
      if (typeof cleanup !== 'function') return cleanup;
      const dispose = () => {
        if (!pendingCleanups.has(dispose)) return;
        pendingCleanups.delete(dispose);
        cleanup();
      };
      pendingCleanups.add(dispose);
      return dispose;
    },
    addAppStateListener(listener: (state: string) => void) {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
    emitAppState(state: string) {
      for (const listener of appStateListeners) listener(state);
    },
  };
});

const replyApi = vi.hoisted(() => ({
  page: (..._args: unknown[]): Promise<unknown> => Promise.reject(new Error('page mock not set')),
  counts: (..._args: unknown[]): Promise<Record<string, number>> => Promise.reject(new Error('counts mock not set')),
}));

vi.mock('react', () => ({
  // The app's Text reads the family its parent Text resolved (#8928).
  createContext: (value: unknown) => ({ Provider: 'TextFamilyProvider', value }),
  useContext: () => null,
  useEffect: harness.useEffect,
  useRef: harness.useRef,
  useState: harness.useState,
}));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => harness.addAppStateListener(listener),
  },
  Pressable: 'Pressable',
  useWindowDimensions: () => ({ fontScale: harness.fontScale ?? 1 }),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 0.5 },
  Text: 'Text',
  View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('../../../../src/features/messaging/replies.js', () => ({
  messageReplyCounts: (...args: unknown[]) => replyApi.counts(...args),
  messageReplyPage: (...args: unknown[]) => replyApi.page(...args),
}));

vi.mock('./NativeMessageActions', () => ({ NativeMessageActions: 'NativeMessageActions' }));
vi.mock('../features/SavedPulseCharts', () => ({ LiveChartMessage: 'LiveChartMessage' }));
vi.mock('./ui', () => ({ Body: 'Body', Button: 'Button' }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => ({}) }));
const ui = vi.hoisted(() => ({ language: 'en' as 'en' | 'es' }));
vi.mock('../lib/useNativeUi', async () => {
  const { nativeUiText } = await import('../lib/nativeUiCopy');
  return { useNativeUi: () => ({ language: ui.language, t: nativeUiText(ui.language) }) };
});
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => motion.reduced }));
vi.mock('../theme/ThemeProvider', () => ({
  useTheme: () => ({ foreground: '#000', mutedForeground: '#666', destructive: '#900', secondary: '#eee', secondaryForeground: '#123', border: '#999', muted: '#ddd', primary: '#040' }),
}));

import { MessageReplies, ParentMessageControl, parentMessageLabel, ReplyCountControl, replyCountLabel, useMessageReplyCounts } from './MessageReplies';

const REPLY_LOAD_TIMEOUT_MS = 15000;

type RenderNode = {
  type?: unknown;
  props?: {
    children?: unknown;
    label?: unknown;
    enabled?: unknown;
    body?: unknown;
  };
};

const firstPage = {
  parent: {
    id: 'parent-1',
    body: 'Original post',
    author_name: 'Avery',
    created_at: '2026-09-20T12:00:00.000Z',
    parent_id: null,
  },
  replies: [{
    id: 'reply-1',
    body: 'First reply',
    author_name: 'Blair',
    created_at: '2026-09-20T12:01:00.000Z',
    parent_id: 'parent-1',
  }],
  count: 1,
  hasMore: false,
};

const firstPageMore = {
  ...firstPage,
  count: 2,
  hasMore: true,
};

function findButton(node: unknown, label: string): (() => void) | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const propsValue = (node as RenderNode).props;
  if (!propsValue) return undefined;
  if (propsValue.label === label && typeof (propsValue as { onPress?: unknown }).onPress === 'function') {
    return (propsValue as { onPress: () => void }).onPress;
  }
  const children = propsValue.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findButton(child, label);
      if (found) return found;
    }
  }
  return undefined;
}

const props: Parameters<typeof MessageReplies>[0] = {
  sourceKind: 'private',
  targetID: 'conversation-1',
  parentID: 'parent-1',
  onClose: () => undefined,
  onCompose: () => undefined,
};

function renderReplies(overrides: Partial<typeof props> = {}) {
  harness.beginRender();
  return MessageReplies({ ...props, ...overrides });
}

function visibleText(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(visibleText);
  if (!node || typeof node !== 'object') return [];
  const propsValue = (node as RenderNode).props;
  if (!propsValue) return [];
  const label = typeof propsValue.label === 'string' ? [propsValue.label] : [];
  return [...label, ...visibleText(propsValue.children)];
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  harness.reset();
  vi.useRealTimers();
});

afterEach(() => {
  harness.disposeEffects();
  vi.useRealTimers();
});

describe('MessageReplies refresh recovery', () => {
  it.each(['private', 'channel'] satisfies Array<'private' | 'channel'>)('resolves chart parents and replies inside their message actions in %s, while keeping removed content hidden', async sourceKind => {
    const reference = '[pulse-chart:123e4567-e89b-42d3-a456-426614174000]';
    replyApi.page = async () => ({ ...firstPage, parent: { ...firstPage.parent, body: reference }, replies: [
      { ...firstPage.replies[0]!, body: reference },
      { ...firstPage.replies[0]!, id: 'removed', body: reference, redacted_at: '2026-11-01' },
    ] });
    renderReplies({ sourceKind }); harness.runNextEffect(); await flushAsyncWork();
    const actions: RenderNode[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object') return;
      const element = node as RenderNode;
      if (element.type === 'NativeMessageActions') actions.push(element);
      visit(element.props?.children);
    };
    visit(renderReplies({ sourceKind }));
    expect(actions).toHaveLength(3);
    for (const action of actions.slice(0, 2)) {
      expect(action.props?.enabled).toBe(true);
      expect(action.props?.children).toMatchObject({ type: 'LiveChartMessage', props: { body: reference } });
    }
    expect(actions[2]?.props?.enabled).toBe(false);
    expect(visibleText(actions[2]).join('')).toBe('Message removed.');
  });
  it('lets the next background refresh recover after a request never settles', async () => {
    vi.useFakeTimers();
    let calls = 0;
    replyApi.page = () => {
      calls += 1;
      return calls === 1 ? new Promise(() => undefined) : Promise.resolve(firstPage);
    };

    renderReplies();
    harness.runNextEffect();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(30000);
    await flushAsyncWork();

    expect(calls).toBe(2);
    expect(visibleText(renderReplies()).join('')).toContain('1 reply');
  });

  it('starts the new scope load even when the old scope request has not settled', async () => {
    let calls = 0;
    replyApi.page = () => {
      calls += 1;
      return calls === 1 ? new Promise(() => undefined) : Promise.resolve(firstPage);
    };

    renderReplies();
    const disposeFirstScope = harness.runNextEffect();
    expect(calls).toBe(1);

    renderReplies({ parentID: 'parent-2' });
    if (disposeFirstScope) disposeFirstScope();
    harness.runNextEffect();
    await flushAsyncWork();

    expect(calls).toBe(2);
    expect(visibleText(renderReplies({ parentID: 'parent-2' })).join('')).toContain('1 reply');
  });

  it('keeps a successful page visible and exposes an error after an active-state refresh fails', async () => {
    let calls = 0;
    replyApi.page = async () => {
      calls += 1;
      if (calls === 1) return firstPage;
      throw new Error('transient refresh failure');
    };

    renderReplies();
    harness.runNextEffect();
    await flushAsyncWork();
    harness.emitAppState('active');
    await flushAsyncWork();

    const text = visibleText(renderReplies());
    const rendered = text.join('');
    expect(calls).toBe(2);
    expect(rendered).toContain('1 reply');
    expect(text).toContain('First reply');
    expect(text).toContain('Replies unavailable.');
    expect(text).toContain('Try replies again');
  });

  it('keeps rows and the Load more affordance when a pagination request fails', async () => {
    let calls = 0;
    replyApi.page = async () => {
      calls += 1;
      if (calls === 1) return firstPageMore;
      throw new Error('transient pagination failure');
    };

    renderReplies();
    harness.runNextEffect();
    await flushAsyncWork();
    findButton(renderReplies(), 'Load more replies')!();
    await flushAsyncWork();

    const text = visibleText(renderReplies());
    const rendered = text.join('');
    expect(calls).toBe(2);
    expect(rendered).toContain('2 replies');
    expect(text).toContain('First reply');
    expect(text).toContain('Replies unavailable.');
    expect(text).toContain('Try replies again');
    expect(text).toContain('Load more replies');
  });

  it('shows the full unavailable state with a retry when the first request and no last good page fails', async () => {
    let calls = 0;
    replyApi.page = async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return firstPage;
    };

    renderReplies();
    harness.runNextEffect();
    await flushAsyncWork();

    const text = visibleText(renderReplies());
    const rendered = text.join('');
    expect(text).toContain('Replies unavailable.');
    expect(text).toContain('Try replies again');
    expect(rendered).not.toContain('Original post');
    expect(rendered).not.toMatch(/\d+ replies/);

    findButton(renderReplies(), 'Try replies again')!();
    await flushAsyncWork();
    expect(visibleText(renderReplies()).join('')).toContain('1 reply');
  });

  it('issues a single request when pagination and a passive refresh overlap, keeping the pagination result', async () => {
    let calls = 0;
    let resolvePagination: ((page: unknown) => void) | undefined;
    replyApi.page = (..._args: unknown[]) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(firstPageMore);
      return new Promise((resolve) => { resolvePagination = resolve; });
    };

    renderReplies();
    harness.runNextEffect();
    await flushAsyncWork();
    findButton(renderReplies(), 'Load more replies')!();
    await flushAsyncWork();
    expect(calls).toBe(2);

    harness.emitAppState('active');
    await flushAsyncWork();
    expect(calls).toBe(2);

    resolvePagination!({
      ...firstPageMore,
      replies: [...firstPageMore.replies, {
        id: 'reply-2',
        body: 'Second reply',
        author_name: 'Casey',
        created_at: '2026-09-20T12:02:00.000Z',
        parent_id: 'parent-1',
      }],
      count: 2,
      hasMore: false,
    });
    await flushAsyncWork();

    const text = visibleText(renderReplies());
    expect(text).toContain('Second reply');
    expect(text).toContain('First reply');
    expect(calls).toBe(2);
  });

  it('clears the rendered page on a 42501 authorization denial after a successful load', async () => {
    let calls = 0;
    replyApi.page = async () => {
      calls += 1;
      if (calls === 1) return firstPage;
      throw Object.assign(new Error('message unavailable'), { code: '42501' });
    };

    renderReplies();
    harness.runNextEffect();
    await flushAsyncWork();
    harness.emitAppState('active');
    await flushAsyncWork();

    const rendered = visibleText(renderReplies()).join('');
    expect(calls).toBe(2);
    expect(rendered).not.toContain('Original post');
    expect(rendered).not.toContain('First reply');
    expect(rendered).not.toMatch(/\d+ replies/);
    expect(rendered).toContain('Replies unavailable.');
    expect(rendered).toContain('Try replies again');
  });

  it('aborts the in-flight request when the load times out', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    replyApi.page = (...args: unknown[]) => {
      const signal = args[5];
      if (signal instanceof AbortSignal) signals.push(signal);
      return new Promise(() => undefined);
    };

    renderReplies();
    harness.runNextEffect();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(REPLY_LOAD_TIMEOUT_MS);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('never wipes the page or counts inside a catch except after an authorization check', () => {
    const source = readFileSync(new URL('./MessageReplies.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/if \(isReplyAuthorizationError\(error\)\) setPage\(null\)/);
    expect(source).toMatch(/isReplyAuthorizationError\(error\)\) setCounts\(\{\}\)/);
    expect(source).not.toMatch(/catch \{[^}]*setPage\(null\)/);
    for (const match of source.matchAll(/catch(?:\s*\([^)]*\))?\s*\{[\s\S]*?\}/g)) {
      if (match[0].includes('setPage(null)') || match[0].includes('setCounts({})')) {
        expect(match[0]).toContain('isReplyAuthorizationError');
      }
    }
  });

  it('keeps the last successful count map when a later active-state refresh fails', async () => {
    let calls = 0;
    replyApi.counts = async () => {
      calls += 1;
      if (calls === 1) return { 'message-1': 3 };
      throw new Error('transient count failure');
    };

    harness.beginRender();
    useMessageReplyCounts('private', 'conversation-1', ['message-1'], true);
    harness.runNextEffect();
    await flushAsyncWork();
    harness.emitAppState('active');
    await flushAsyncWork();

    harness.beginRender();
    const counts = useMessageReplyCounts('private', 'conversation-1', ['message-1'], true);
    expect(calls).toBe(2);
    expect(counts).toEqual({ 'message-1': 3 });
  });

  it('clears the last successful count map on a 42501 authorization denial', async () => {
    let calls = 0;
    replyApi.counts = async () => {
      calls += 1;
      if (calls === 1) return { 'message-1': 3 };
      throw Object.assign(new Error('not authorized'), { code: '42501' });
    };

    harness.beginRender();
    useMessageReplyCounts('private', 'conversation-1', ['message-1'], true);
    harness.runNextEffect();
    await flushAsyncWork();
    harness.emitAppState('active');
    await flushAsyncWork();

    harness.beginRender();
    const counts = useMessageReplyCounts('private', 'conversation-1', ['message-1'], true);
    expect(calls).toBe(2);
    expect(counts).toEqual({});
  });

  it('does not let a disposed effect interval call the next page mock', async () => {
    vi.useFakeTimers();
    let calls = 0;
    replyApi.page = () => {
      calls += 1;
      return Promise.resolve(firstPage);
    };

    renderReplies();
    harness.runNextEffect();
    await flushAsyncWork();
    expect(calls).toBe(1);

    harness.disposeEffects();
    replyApi.page = () => {
      calls += 1;
      return Promise.resolve(firstPage);
    };
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls).toBe(1);
  });
});

// App Store capture, Nov 7, 2026: the channel reply pill read "1 replies".
describe('reply count label', () => {
  it('says one reply in the singular and every other count in the plural', () => {
    expect(replyCountLabel(1)).toBe('1 reply');
    expect(replyCountLabel(2)).toBe('2 replies');
    expect(replyCountLabel(12)).toBe('12 replies');
  });

  it('labels the channel and conversation reply pills and the replies header with it', () => {
    const own = { '../../app/channel/[id].tsx': '<ReplyCountControl count={replyCounts[message.id] ?? 0} onPress={() => setReplyParent(message.id)} />', '../../app/conversation/[id].tsx': "<ReplyCountControl count={replyCounts[message.id] ?? 0} align={mine ? 'end' : 'start'} onPress={() => setReplyParent(message.id)} />" };
    for (const [path, call] of Object.entries(own)) {
      const screen = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(screen, path).toContain(call);
      expect(screen, path).not.toMatch(/<Button label=\{replyCountLabel/);
      expect(screen, path).not.toMatch(/\} replies`/);
    }
    // On a channel the count closes the message's reactions in its one footer
    // row, after the add-reaction chip, instead of floating in a band of its own.
    const channel = readFileSync(new URL('../../app/channel/[id].tsx', import.meta.url), 'utf8');
    const row = channel.slice(channel.indexOf('const reactionRow = <>'), channel.indexOf('const footerInActions'));
    expect(row.indexOf('<AddReactionChip')).toBeGreaterThan(-1);
    expect(row.indexOf('<ReplyCountControl')).toBeGreaterThan(row.indexOf('<AddReactionChip'));
    expect(channel.match(/<ReplyCountControl/g)).toHaveLength(1);
    expect(channel).toContain("reactions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 0, columnGap: spacing.sm },");
    const replies = readFileSync(new URL('./MessageReplies.tsx', import.meta.url), 'utf8');
    expect(replies).toContain('{replyCountLabel(page.count, t)}');
  });
});

// The reply count was a full-width filled primary button that outweighed the
// message it belongs to (App Store capture, Nov 7, 2026). It is now a quiet
// secondary chip sized to its words, inside a full-height target.
describe('reply count control', () => {
  type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
  const node = (value: unknown): Node => value as Node;
  // Both controls hand their words to one chip; render that chip once.
  const chipOf = (value: unknown): Node => { const element = node(value); return node((element.type as (props: unknown) => unknown)(element.props)); };
  type Style = Record<string, unknown> | null;
  const placeOf = (control: Node) => control.props.style as Style[];
  const flat = (styles: unknown[]) => Object.assign({}, ...(styles.flat(Infinity) as Style[]).filter(Boolean)) as Record<string, unknown>;
  // The chip is drawn by the target for its pressed state.
  const pillOf = (control: Node, pressed = false) => (control.props.children as (state: { pressed: boolean }) => Node)({ pressed });
  it('is a named button with a full-height target and a compact secondary chip', () => {
    const onPress = vi.fn();
    const control = chipOf(ReplyCountControl({ count: 1, onPress }));
    expect(control.type).toBe('Pressable');
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityLabel).toBe('1 reply');
    expect(control.props.accessibilityHint).toBe('Opens the replies');
    expect(control.props.onPress).toBe(onPress);
    const [frame, target, place] = placeOf(control);
    expect(target).toEqual({ minHeight: 48 });
    // A wrapped label keeps 4 pt clear above and below the chip.
    expect(frame?.paddingVertical).toBe(4);
    // A row item: no side of its own, so the channel row centres it.
    expect(frame?.alignSelf).toBeUndefined();
    expect(place).toEqual({ marginLeft: 0 });
    const chip = pillOf(control);
    const [chipStyle, size, chipColors] = chip.props.style as Array<Record<string, unknown>>;
    // The reaction chips' height, gap and 8 pt sides at the default size; the
    // chevron's own side bearing stands in for 2 pt of the trailing side.
    expect(size).toEqual({ minHeight: 36, gap: 4, paddingHorizontal: 8, paddingRight: 6 });
    expect(chipColors).toEqual({ backgroundColor: '#eee', borderColor: '#999' });
    expect(chipStyle?.borderRadius).toBeGreaterThan(0);
    expect(chipStyle?.width).toBeUndefined();
    expect(JSON.stringify(chip)).toContain('1 reply');
  });

  it('sits under your own bubble on the trailing side and caps its words and icons at 2x', () => {
    harness.fontScale = 3.1;
    try {
      const control = chipOf(ReplyCountControl({ count: 1, onPress: vi.fn(), align: 'end' }));
      const [, target, end] = placeOf(control);
      expect(end).toEqual({ alignSelf: 'flex-end' });
      // Height, sides and gap grow with the words, as on the reaction chips,
      // and the target keeps 4 pt either side of the grown chip.
      expect(target).toEqual({ minHeight: 80 });
      const chip = pillOf(control);
      expect((chip.props.style as Array<Record<string, unknown>>)[1]).toEqual({ minHeight: 72, gap: 8, paddingHorizontal: 16, paddingRight: 12 });
      const parts = chip.props.children as Node[];
      expect(parts.map((part) => part.props.size ?? part.props.maxFontSizeMultiplier)).toEqual([32, 2, 26]);
    } finally {
      harness.fontScale = undefined;
    }
  });

  // A press laid 82% opacity over the whole chip; it now lays the muted fill
  // the add-reaction chip uses under the same words and, because that fill
  // barely differs from the secondary one, edges it in the primary colour and
  // settles the chip a little unless Reduce Motion is on.
  it('shows a press with a muted fill, a primary edge and a small settle, its words and target unchanged', () => {
    const control = chipOf(ReplyCountControl({ count: 2, onPress: vi.fn() }));
    expect(typeof control.props.style).not.toBe('function');
    expect(JSON.stringify(placeOf(control))).not.toContain('opacity');
    const rest = pillOf(control, false);
    const pressed = pillOf(control, true);
    expect((rest.props.style as Array<Record<string, unknown>>)[2]).toEqual({ backgroundColor: '#eee', borderColor: '#999' });
    expect((rest.props.style as Array<Record<string, unknown>>)[3]).toBeNull();
    expect((pressed.props.style as Array<Record<string, unknown>>)[2]).toEqual({ backgroundColor: '#ddd', borderColor: '#040' });
    expect((pressed.props.style as Array<Record<string, unknown>>)[3]).toEqual({ transform: [{ scale: 0.96 }] });
    expect(JSON.stringify(pressed.props.children)).toBe(JSON.stringify(rest.props.children));
    motion.reduced = true;
    try {
      const still = pillOf(chipOf(ReplyCountControl({ count: 2, onPress: vi.fn() })), true);
      expect((still.props.style as Array<Record<string, unknown>>)[2]).toEqual({ backgroundColor: '#ddd', borderColor: '#040' });
      expect((still.props.style as Array<Record<string, unknown>>)[3]).toBeNull();
    } finally {
      motion.reduced = false;
    }
  });

  it('counts in the plural past one', () => {
    const control = chipOf(ReplyCountControl({ count: 4, onPress: vi.fn() }));
    expect(control.props.accessibilityLabel).toBe('4 replies');
  });

  // "View parent message" was a full-width filled primary button under a reply.
  it('offers View parent message as the same quiet chip on the message side', () => {
    const onPress = vi.fn();
    const control = chipOf(ParentMessageControl({ onPress, align: 'end' }));
    expect(control.type).toBe('Pressable');
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityLabel).toBe('View parent message');
    expect(control.props.accessibilityHint).toBe('Opens the message this replies to');
    expect(control.props.onPress).toBe(onPress);
    const [frame, , end] = placeOf(control);
    expect(flat(placeOf(control)).minHeight).toBeGreaterThanOrEqual(48);
    expect(end).toEqual({ alignSelf: 'flex-end' });
    const chip = pillOf(control);
    expect((chip.props.style as Array<Record<string, unknown>>)[2]).toEqual({ backgroundColor: '#eee', borderColor: '#999' });
    expect(JSON.stringify(chip)).toContain('return-up-back-outline');
    // The leading arrow already points; no second, opposite chevron.
    expect(JSON.stringify(chip)).not.toContain('chevron-forward');
    // With no chevron, both sides are the chips' even 8 pt.
    expect((chip.props.style as Array<Record<string, unknown>>)[1]).toEqual({ minHeight: 36, gap: 4, paddingHorizontal: 8 });
    // A long label wraps inside the chip at large text, never past its message.
    expect(frame?.maxWidth).toBe('100%');
    expect((chip.props.style as Array<Record<string, unknown>>)[0]?.flexShrink).toBe(1);
    const label = (chip.props.children as Node[]).find((part) => part?.props?.maxFontSizeMultiplier);
    expect((label?.props.style as Array<Record<string, unknown>>)[0]?.flexShrink).toBe(1);
  });

  it('draws a channel reply\'s text closer by the column gap, keeping its whole target', () => {
    const control = chipOf(ParentMessageControl({ onPress: vi.fn(), align: 'start', beforeBody: true }));
    const [, , , pull] = placeOf(control);
    // The target's spare height sits above the chip and the target lifts by the
    // column's gap, meeting the line above without covering it, so the reply's
    // text moves closer.
    expect(pull).toEqual({ justifyContent: 'flex-end', paddingBottom: 0, marginTop: -4, marginBottom: -4 });
    expect(flat(placeOf(control))).toMatchObject({ minHeight: 48, paddingVertical: 4, paddingBottom: 0 });
    harness.fontScale = 3.1;
    try {
      const large = chipOf(ParentMessageControl({ onPress: vi.fn(), align: 'start', beforeBody: true }));
      expect(flat(placeOf(large))).toMatchObject({ minHeight: 80, marginTop: -4, marginBottom: -4 });
    } finally {
      harness.fontScale = undefined;
    }
    // The channel column's gap is what the pull takes back, so targets never overlap.
    expect(readFileSync(new URL('../../app/channel/[id].tsx', import.meta.url), 'utf8')).toContain('msgBody: { flex: 1, gap: spacing.xs },');
  });

  // A one-line channel body was centred in its 48 pt target, a band of space
  // above and below its words. It reaches up over the plain author line
  // instead; under this chip, whose own target is above it, it keeps the band.
  it('lets a channel body reach over its author line, never over this chip', () => {
    const channel = readFileSync(new URL('../../app/channel/[id].tsx', import.meta.url), 'utf8');
    expect(channel).toContain('reachAbove={message.parentMessageID ? undefined : bodyReachOverAuthor(fontScale)}');
    expect(readFileSync(new URL('./ChannelControls.tsx', import.meta.url), 'utf8')).toContain('body: { fontSize: 15, lineHeight: CHANNEL_BODY_LINE_HEIGHT },');
  });

  it('names the author of a loaded parent and falls back when it is not loaded', () => {
    expect(parentMessageLabel('Delia Torres')).toBe('Replying to Delia Torres');
    expect(parentMessageLabel('  ')).toBe('View parent message');
    expect(parentMessageLabel(undefined)).toBe('View parent message');
    const control = chipOf(ParentMessageControl({ onPress: vi.fn(), align: 'start', author: 'Delia Torres' }));
    expect(control.props.accessibilityLabel).toBe('Replying to Delia Torres');
    expect(control.props.accessibilityHint).toBe('Opens the message this replies to');
  });

  // #8304: the saved member language reaches the reply chips and their hints;
  // a member name stays as written.
  it('speaks the saved Spanish on both reply chips and keeps the worker name', () => {
    ui.language = 'es';
    try {
      const parent = chipOf(ParentMessageControl({ onPress: vi.fn(), align: 'start', author: 'Delia Torres' }));
      expect(parent.props.accessibilityLabel).toBe('Respondiendo a Delia Torres');
      expect(parent.props.accessibilityHint).toBe('Abre el mensaje al que responde');
      expect(chipOf(ParentMessageControl({ onPress: vi.fn(), align: 'start' })).props.accessibilityLabel).toBe('Ver el mensaje original');
      const count = chipOf(ReplyCountControl({ count: 2, onPress: vi.fn() }));
      expect(count.props.accessibilityLabel).toBe('2 respuestas');
      expect(count.props.accessibilityHint).toBe('Abre las respuestas');
      expect(chipOf(ReplyCountControl({ count: 1, onPress: vi.fn() })).props.accessibilityLabel).toBe('1 respuesta');
    } finally { ui.language = 'en'; }
  });

  it('sits above a channel reply, ahead of its body and actions', () => {
    const channel = readFileSync(new URL('../../app/channel/[id].tsx', import.meta.url), 'utf8');
    expect(channel.indexOf('<ParentMessageControl')).toBeLessThan(channel.indexOf('<WorkflowMessageActions key='));
  });

  it('uses it under replies in a channel and a conversation and in the replies header', () => {
    const sites = {
      '../../app/channel/[id].tsx': '<ParentMessageControl align="start" beforeBody author={messages.find((row) => row.id === message.parentMessageID)?.author} onPress={() => setReplyParent(message.parentMessageID ?? null)} />',
      '../../app/conversation/[id].tsx': "<ParentMessageControl align={mine ? 'end' : 'start'} author={threadMessages.find((row) => row.id === message.parentMessageID)?.senderName} onPress={() => setReplyParent(message.parentMessageID ?? null)} />",
      './MessageReplies.tsx': '<ParentMessageControl align="start" onPress={() => onOpenParent(page.parent.parent_id!)} />',
    };
    for (const [path, call] of Object.entries(sites)) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source, path).toContain(call);
      expect(source, path).not.toContain('<Button label="View parent message"');
    }
  });
});
