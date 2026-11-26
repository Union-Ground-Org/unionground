// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from '../testing/reactNativeStandIn';
import { boot, restore, signIn } from '../testing/retainedDraftHarness';
import type { Held } from './retainedDraft';

// #9240 PR A: the hook's own rules, through a probe editor, for the paths the
// first two adopters do not reach (a keyed write, a basis, an editor's read).

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../state/AppProvider', async () => (await import('../testing/retainedDraftHarness')).appProviderStandIn);
let uuid = 0;
vi.mock('expo-crypto', () => ({ randomUUID: () => `key-${++uuid}` }));

const { defineRetainedSurface, useRetainedDraft } = await import('./retainedDraft');
type Fields = { body: string };
type Probe = ReturnType<typeof useRetainedDraft<Fields>>;
const surface = defineRetainedSurface<Held<Fields>>('hook-probe');
let probe: Probe;
let fresh = true;
let basis: string | null | undefined;
function Editor() {
  probe = useRetainedDraft<Fields>({ surface, item: 'case-1', empty: { body: '' }, fresh, scope: 'organization', basis });
  return null;
}
let view: Rendered;
const again = () => view.rerender(h(Editor));
beforeEach(async () => { signIn('chapterless'); fresh = true; basis = undefined; uuid = 0; view = await render(h(Editor)); });
afterEach(async () => { await view.unmount(); });

describe('useRetainedDraft', () => {
  it('conceals and ignores typing until the editor read is fresh', async () => {
    fresh = false; await again();
    expect(probe.shown).toBe(false);
    act(() => probe.set({ body: 'Too early' }));
    fresh = true; await again();
    expect(probe.value.body).toBe('');
  });
  it('holds nothing for a value typed back to empty, and offers no attempt then', async () => {
    act(() => probe.set({ body: 'x' }));
    act(() => probe.set((value) => ({ ...value, body: '' })));
    boot(); await again(); restore(); await again();
    expect(probe.value.body).toBe('');
    expect(probe.begin()).toBeNull();
  });
  it('locks one attempt at a time and refuses Discard while it is sending', async () => {
    act(() => probe.set({ body: 'Unsent' }));
    let first: ReturnType<Probe['begin']> = null;
    act(() => { first = probe.begin(); });
    expect(first).not.toBeNull();
    expect(probe.pending).toBe('sending');
    expect(probe.begin()).toBeNull();
    act(() => probe.set({ body: 'Changed' }));
    act(() => probe.discard());
    expect(probe.value.body).toBe('Unsent');
    act(() => { first!.settle({ failed: 'Try again.' }); });
    expect(probe.pending).toBe(false);
    expect(probe.failed).toBe('Try again.');
    act(() => probe.set({ body: 'Edited' }));
    expect(probe.failed).toBeNull();
  });
  it('reuses the attempt key only for a deliberate retry after an unknown outcome', async () => {
    act(() => probe.set({ body: 'Unsent' }));
    let first!: NonNullable<ReturnType<Probe['begin']>>;
    act(() => { first = probe.begin()!; });
    act(() => { first.settle('uncertain'); });
    boot(); await again(); restore(); await again();
    expect(probe.pending).toBe('uncertain');
    act(() => probe.set({ body: 'Locked' }));
    expect(probe.value.body).toBe('Unsent');
    let retry!: NonNullable<ReturnType<Probe['begin']>>;
    // A later definite failure (429, 5xx, a timeout) does not prove the first
    // attempt did not land: the outcome stays unknown with the same key.
    for (const copy of ['Rate limited.', 'Service unavailable.']) {
      act(() => { retry = probe.begin()!; });
      expect(retry.key).toBe(first.key);
      act(() => { retry.settle({ failed: copy }); });
      expect(probe.pending).toBe('uncertain');
      expect(probe.failed).toBe(copy);
      act(() => probe.set({ body: 'Edited' }));
      expect(probe.value.body).toBe('Unsent');
      boot(); await again(); restore(); await again();
      expect(probe.pending).toBe('uncertain');
    }
    act(() => { retry = probe.begin()!; });
    expect(retry.key).toBe(first.key);
    act(() => { retry.settle('done'); });
    expect(probe.value.body).toBe('');
    expect(probe.pending).toBe(false);
  });
  it('clears an unknown outcome only on Discard, after which a new attempt has a new key', async () => {
    act(() => probe.set({ body: 'Unsent' }));
    let first!: NonNullable<ReturnType<Probe['begin']>>;
    act(() => { first = probe.begin()!; });
    act(() => { first.settle('uncertain'); });
    let retry!: NonNullable<ReturnType<Probe['begin']>>;
    act(() => { retry = probe.begin()!; });
    act(() => { retry.settle({ failed: 'Rate limited.' }); });
    act(() => probe.discard());
    expect(probe.value.body).toBe('');
    expect(probe.pending).toBe(false);
    act(() => probe.set({ body: 'New invitation' }));
    let next!: NonNullable<ReturnType<Probe['begin']>>;
    act(() => { next = probe.begin()!; });
    expect(next.key).not.toBe(first.key);
    act(() => { next.settle({ failed: 'Rate limited.' }); });
    expect(probe.pending).toBe(false);
    expect(probe.value.body).toBe('New invitation');
  });
  it('settles a confirmed attempt after an unmount, and not after the scope retired', async () => {
    act(() => probe.set({ body: 'Unsent' }));
    let attempt!: NonNullable<ReturnType<Probe['begin']>>;
    act(() => { attempt = probe.begin()!; });
    await view.unmount();
    expect(attempt.settle('done')).toBe(true);
    view = await render(h(Editor));
    expect(probe.value.body).toBe('');
    act(() => probe.set({ body: 'Second' }));
    act(() => { attempt = probe.begin()!; });
    signIn('chapterless'); await again();
    expect(attempt.settle({ failed: 'Try again.' })).toBe(false);
    expect(probe.value.body).toBe('');
  });
  it('marks the text stale when the basis moved, without changing it', async () => {
    basis = 'rev-1'; await again();
    act(() => probe.set({ body: 'Typed on rev 1' }));
    expect(probe.stale).toBe(false);
    basis = 'rev-2'; await again();
    expect(probe.stale).toBe(true);
    expect(probe.value.body).toBe('Typed on rev 1');
  });
  it('retires the work on an authoritative refusal of the editor read only', async () => {
    act(() => probe.set({ body: 'Unsent' }));
    act(() => probe.refused(new TypeError('Network request failed')));
    expect(probe.value.body).toBe('Unsent');
    act(() => probe.refused({ code: 'PGRST301' }));
    expect(probe.value.body).toBe('Unsent');
    act(() => probe.refused({ code: '42501' }));
    expect(probe.value.body).toBe('');
  });
});
