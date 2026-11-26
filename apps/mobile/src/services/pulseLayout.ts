import type { Session } from '@supabase/supabase-js';
import { withReadDeadline } from '../lib/readDeadline';
import { createCapturedSessionRpcClient } from './supabase';

// #8927 slice 3: the person's own Pulse layout, read with get_pulse_layout and
// written with save_pulse_layout (20261113148000). The server binds both to the
// caller, their organization and their currently selected chapter, rechecks the
// hat, and returns only entries whose key it still offers (a lost role, a
// removed built chart or another chapter's key is never returned). A write is
// a whole replacement; NULL goes back to the standard set.
export type PulseLayoutEntry = { key: string; pinned: boolean };
export type PulseLayout = { customized: boolean; entries: PulseLayoutEntry[]; options: string[] };
export type LayoutRpc = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

const READ_FAILED = 'Your Pulse layout could not be checked.';
const SAVE_FAILED = 'Your Pulse layout could not be saved.';
const KEY = /^[a-z0-9:_-]{1,80}$/;
const MAX_ENTRIES = 64;

export function pulseLayoutClient(session: Session): LayoutRpc { return createCapturedSessionRpcClient(session); }
export const fixedLayoutKey = (id: string) => `fixed:${id}`;
export const savedLayoutKey = (id: string) => `saved:${id}`;
// #8927 slice 3: a ready-made chart's card id is its own layout key
// (ready:<chart>); today's cards are fixed:<id>. Both are cards on the Pulse
// and move among each other; built charts (saved:) are listed apart.
export const cardLayoutKey = (id: string) => (id.startsWith('ready:') ? id : fixedLayoutKey(id));
const cardOfKey = (key: string) => (key.startsWith('fixed:') ? key.slice(6) : key.startsWith('ready:') ? key : null);
export const layoutKind = (key: string) => (key.startsWith('saved:') ? 'saved' : 'card');

export function parsePulseLayout(value: unknown): PulseLayout {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!row || typeof row.customized !== 'boolean' || !Array.isArray(row.entries) || !Array.isArray(row.options)) throw new Error(READ_FAILED);
  const offered: unknown[] = row.options, listed: unknown[] = row.entries;
  const options = [...new Set(offered.flatMap((key) => typeof key === 'string' && KEY.test(key) ? [key] : []))];
  const seen = new Set<string>(), entries: PulseLayoutEntry[] = [];
  for (const item of listed) {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (typeof entry.key !== 'string' || typeof entry.pinned !== 'boolean' || !options.includes(entry.key) || seen.has(entry.key)) continue;
    seen.add(entry.key); entries.push({ key: entry.key, pinned: entry.pinned });
  }
  return { customized: row.customized, entries: entries.slice(0, MAX_ENTRIES), options };
}

// The standard Pulse as layout entries, in the order the screen shows it,
// then every other key the server offers, so the first change a person makes
// starts from what they were looking at and depends on nothing still loading:
// a card whose figures arrive later (weekly history) or a built chart the
// phone has not listed yet stays on, and keys this screen never draws are
// kept untouched. Ready-made charts are not in the standard set: a person adds
// them from Customize, so a first change never switches one on unasked.
export function standardLayoutEntries(cardIDs: readonly string[], chartIDs: readonly string[], options: readonly string[]): PulseLayoutEntry[] {
  const keys = [...cardIDs.filter((id) => !id.startsWith('ready:')).map(fixedLayoutKey), ...chartIDs.map(savedLayoutKey)].filter((key) => options.includes(key));
  return [...new Set([...keys, ...options.filter((key) => !key.startsWith('ready:'))])].slice(0, MAX_ENTRIES).map((key) => ({ key, pinned: false }));
}

// Moves an entry past the nearest visible entry of the same kind (today's
// cards and built charts are listed apart). Entries the phone cannot show stay
// where they are, so a change never drops what the server still holds.
export function moveLayoutEntry(entries: PulseLayoutEntry[], key: string, direction: -1 | 1, visible: ReadonlySet<string>): PulseLayoutEntry[] {
  const from = entries.findIndex((entry) => entry.key === key);
  if (from < 0) return entries;
  const kind = layoutKind(key);
  let to = from + direction;
  while (to >= 0 && to < entries.length && !(visible.has(entries[to]!.key) && layoutKind(entries[to]!.key) === kind)) to += direction;
  if (to < 0 || to >= entries.length) return entries;
  const next = [...entries];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}
export function layoutWithout(entries: PulseLayoutEntry[], key: string): PulseLayoutEntry[] { return entries.filter((entry) => entry.key !== key); }

type Showable = { id: string; drawable: boolean };
// What the Pulse draws. Without a saved layout nothing changes. With one, a
// card the layout names but the person cannot see now (not offered any more,
// not loaded, or with no figures that may be shown) is skipped: never drawn
// empty, never counted. A card the server offers no key for keeps its place.
// Built charts are never taken off or skipped by a layout (the stored layout
// has no "off" mark, so a chart built later would vanish, and one with no rows
// draws its own withheld note and controls, as on Main): the layout orders
// them, the rest follow in their own order, and each keeps its own pin, which
// also decides Home. saved: null means the built-chart slots show as today.
export function arrangePulse(layout: PulseLayout | null, cards: readonly Showable[], charts: readonly string[]): { pinned: string[]; cards: string[]; saved: string[] | null } {
  if (!layout?.customized) return { pinned: [], cards: cards.map((card) => card.id), saved: null };
  const fixed = layout.entries.flatMap((entry) => { const id = cardOfKey(entry.key); return id === null ? [] : [{ id, pinned: entry.pinned }]; }).filter((entry) => cards.some((card) => card.id === entry.id && card.drawable));
  const placed = layout.entries.filter((entry) => entry.key.startsWith('saved:')).map((entry) => entry.key.slice(6));
  return {
    pinned: fixed.filter((entry) => entry.pinned).map((entry) => entry.id),
    cards: [...fixed.filter((entry) => !entry.pinned).map((entry) => entry.id), ...cards.filter((card) => !layout.options.includes(cardLayoutKey(card.id)) && !card.id.startsWith('ready:')).map((card) => card.id)],
    saved: [...placed, ...charts.filter((id) => !placed.includes(id))].filter((id) => charts.includes(id)),
  };
}

// One session per signed-in person, organization, chapter and hat (the screen
// remounts when any of them changes, and pauses this one). Calls run one at a
// time, every one under the existing read deadline. A write waits for the one
// before it; writes queued behind it collapse to the latest layout, and a
// layout equal to the last confirmed one is not sent again. After a write
// whose answer was lost, a pause, or the start of any read, nothing more is
// written until a fresh read has said what the server holds.
export function createPulseLayoutSession(client: LayoutRpc, chapterID: string, hat: string) {
  let tail: Promise<unknown> = Promise.resolve();
  let verified = false, epoch = 0, generation = 0;
  let confirmed: string | null = null;
  let pending: { entries: PulseLayoutEntry[] | null; promise: Promise<void>; epoch: number } | null = null;
  const call = async (name: string, args: Record<string, unknown>, message: string) => {
    let result: { data: unknown; error: unknown };
    try { result = await withReadDeadline(Promise.resolve(client.rpc(name, { p_chapter_id: chapterID, ...args, p_hat: hat }))); }
    catch { throw new Error(message); }
    if (result.error) throw new Error(message);
    return result.data;
  };
  function run<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined); // swallow-ok: the caller receives this rejection; the queue only moves on
    return result;
  }
  return {
    // Each read starts a new generation: writes queued before it are dropped,
    // and every write is refused until this read lands, so nothing is written
    // that was not built on the last verified read. A failed read, or an older
    // read landing while a newer one is out, leaves writes refused.
    load(): Promise<PulseLayout> {
      const mine = ++generation;
      verified = false; epoch += 1;
      return run(async () => {
        const layout = parsePulseLayout(await call('get_pulse_layout', {}, READ_FAILED));
        if (mine === generation) { confirmed = JSON.stringify(layout.customized ? layout.entries : null); verified = true; }
        return layout;
      });
    },
    save(entries: PulseLayoutEntry[] | null): Promise<void> {
      if (!verified) return Promise.reject(new Error(SAVE_FAILED));
      if (pending && pending.epoch === epoch) { pending.entries = entries; return pending.promise; }
      const slot = { entries, epoch, promise: Promise.resolve() };
      slot.promise = run(async () => {
        if (pending === slot) pending = null;
        if (!verified || slot.epoch !== epoch) throw new Error(SAVE_FAILED);
        const body = JSON.stringify(slot.entries);
        if (body === confirmed) return;
        try { await call('save_pulse_layout', { p_entries: slot.entries }, SAVE_FAILED); }
        catch (error) { verified = false; epoch += 1; throw error; }
        confirmed = body;
      });
      pending = slot;
      return slot.promise;
    },
    // Background or unmount: drop queued writes and require a fresh read
    // before writing again. A write already sent still finishes first.
    pause() { verified = false; epoch += 1; },
  };
}
export type PulseLayoutSession = ReturnType<typeof createPulseLayoutSession>;
