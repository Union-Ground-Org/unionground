import { afterEach, describe, expect, it, vi } from 'vitest';
import { READ_DEADLINE_MS } from '../lib/readDeadline';
vi.mock('./supabase', () => ({ createCapturedSessionRpcClient: vi.fn() }));
import { arrangePulse, createPulseLayoutSession, layoutWithout, moveLayoutEntry, parsePulseLayout, standardLayoutEntries, type LayoutRpc, type PulseLayoutEntry } from './pulseLayout';

type Call = { name: string; args: Record<string, unknown>; settle: (value: { data: unknown; error: unknown }) => void };
function serverDouble() {
  const calls: Call[] = [];
  const client: LayoutRpc = { rpc: (name, args) => new Promise((settle) => { calls.push({ name, args, settle }); }) };
  return { client, calls };
}
const flush = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
const read = { customized: true, entries: [{ key: 'fixed:membership', pinned: true }, { key: 'fixed:meetings', pinned: false }], options: ['fixed:membership', 'fixed:meetings', 'fixed:turnout'] };
const a: PulseLayoutEntry[] = [{ key: 'fixed:meetings', pinned: false }];
const b: PulseLayoutEntry[] = [{ key: 'fixed:turnout', pinned: false }];
afterEach(() => { vi.useRealTimers(); });

describe('Pulse layout answers', () => {
  it('keeps only well-formed, offered, unique keys and refuses a malformed answer', () => {
    expect(parsePulseLayout({ customized: true, entries: [...read.entries, { key: 'fixed:membership', pinned: false }, { key: 'saved:other', pinned: false }, { key: 'BAD KEY', pinned: false }, { key: 'fixed:turnout', pinned: 'yes' }], options: [...read.options, 'BAD KEY', 7] }))
      .toEqual({ customized: true, entries: read.entries, options: read.options });
    expect(parsePulseLayout({ customized: false, entries: [], options: [] })).toEqual({ customized: false, entries: [], options: [] });
    for (const value of [null, [], { customized: 'true', entries: [], options: [] }, { customized: true, entries: {}, options: [] }, { customized: true, entries: [], options: null }]) {
      expect(() => parsePulseLayout(value)).toThrow('Your Pulse layout could not be checked.');
    }
  });
  it('builds the standard order from what the screen already shows, then carries every other offered key', () => {
    expect(standardLayoutEntries(['membership', 'meetings', 'history-local-meeting_checkins'], ['c1'], ['fixed:meetings', 'saved:c9', 'fixed:poll', 'fixed:membership', 'saved:c1']))
      .toEqual(['fixed:membership', 'fixed:meetings', 'saved:c1', 'saved:c9', 'fixed:poll'].map((key) => ({ key, pinned: false })));
  });
  it('moves one entry past the next entry of its own kind and leaves unknown entries in place', () => {
    const entries = [{ key: 'fixed:a', pinned: false }, { key: 'saved:x', pinned: false }, { key: 'fixed:gone', pinned: false }, { key: 'fixed:b', pinned: false }];
    const visible = new Set(['fixed:a', 'saved:x', 'fixed:b']);
    expect(moveLayoutEntry(entries, 'fixed:b', -1, visible).map((entry) => entry.key)).toEqual(['fixed:b', 'saved:x', 'fixed:gone', 'fixed:a']);
    expect(moveLayoutEntry(entries, 'fixed:a', -1, visible)).toBe(entries);
    expect(moveLayoutEntry(entries, 'saved:x', 1, visible)).toBe(entries);
    expect(layoutWithout(entries, 'saved:x').map((entry) => entry.key)).toEqual(['fixed:a', 'fixed:gone', 'fixed:b']);
  });
  it('skips layout cards the person can no longer see, keeps unkeyed cards, and leaves the standard Pulse alone', () => {
    const cards = [{ id: 'membership', drawable: true }, { id: 'meetings', drawable: false }, { id: 'turnout', drawable: true }, { id: 'history-local-meeting_checkins', drawable: true }];
    const layout = { customized: true, entries: [{ key: 'fixed:turnout', pinned: true }, { key: 'fixed:meetings', pinned: false }, { key: 'fixed:membership', pinned: false }, { key: 'saved:c2', pinned: false }, { key: 'saved:c1', pinned: false }], options: ['fixed:membership', 'fixed:meetings', 'fixed:turnout', 'saved:c1', 'saved:c2'] };
    // Built charts are never skipped: one with no rows draws its own note, as on Main.
    expect(arrangePulse(layout, cards, ['c1', 'c2', 'c3']))
      .toEqual({ pinned: ['turnout'], cards: ['membership', 'history-local-meeting_checkins'], saved: ['c2', 'c1', 'c3'] });
    expect(arrangePulse({ ...layout, customized: false }, cards, [])).toEqual({ pinned: [], cards: cards.map((card) => card.id), saved: null });
    expect(arrangePulse(null, cards, [])).toEqual({ pinned: [], cards: cards.map((card) => card.id), saved: null });
  });
});

describe('Ready-made charts in a layout (#8927 slice 3)', () => {
  it('never puts a ready-made chart in the standard set, so a first change switches none on', () => {
    expect(standardLayoutEntries(['membership', 'ready:open-overdue'], [], ['fixed:membership', 'ready:open-overdue', 'ready:casework', 'fixed:poll']).map((entry) => entry.key))
      .toEqual(['fixed:membership', 'fixed:poll']);
  });
  it('draws an added ready-made chart in layout order and pins it like any card, but never unasked', () => {
    const cards = [{ id: 'membership', drawable: true }, { id: 'ready:open-overdue', drawable: true }, { id: 'ready:casework', drawable: true }];
    const layout = { customized: true, entries: [{ key: 'ready:casework', pinned: true }, { key: 'fixed:membership', pinned: false }, { key: 'ready:open-overdue', pinned: false }], options: ['fixed:membership', 'ready:open-overdue', 'ready:casework'] };
    expect(arrangePulse(layout, cards, [])).toEqual({ pinned: ['ready:casework'], cards: ['membership', 'ready:open-overdue'], saved: [] });
    // Not on the layout: not drawn, even though its key is offered.
    expect(arrangePulse({ ...layout, entries: [{ key: 'fixed:membership', pinned: false }] }, cards, []).cards).toEqual(['membership']);
    // An unsaved (standard) Pulse never draws one.
    expect(arrangePulse({ ...layout, customized: false }, cards.slice(0, 1), []).cards).toEqual(['membership']);
  });
  it('moves ready-made charts among today’s cards, apart from built charts', () => {
    const entries = [{ key: 'fixed:a', pinned: false }, { key: 'saved:x', pinned: false }, { key: 'ready:casework', pinned: false }];
    const visible = new Set(entries.map((entry) => entry.key));
    expect(moveLayoutEntry(entries, 'ready:casework', -1, visible).map((entry) => entry.key)).toEqual(['ready:casework', 'saved:x', 'fixed:a']);
    expect(moveLayoutEntry(entries, 'saved:x', -1, visible)).toBe(entries);
  });
});

describe('Pulse layout session', () => {
  it('reads and writes only the bound campaign and hat, through the captured client', async () => {
    const server = serverDouble(), session = createPulseLayoutSession(server.client, 'chapter-a', 'president');
    const loading = session.load(); await flush();
    expect(server.calls[0]).toMatchObject({ name: 'get_pulse_layout', args: { p_chapter_id: 'chapter-a', p_hat: 'president' } });
    server.calls[0]!.settle({ data: read, error: null }); await expect(loading).resolves.toEqual(read);
    const saving = session.save(a); await flush();
    expect(server.calls[1]).toMatchObject({ name: 'save_pulse_layout', args: { p_chapter_id: 'chapter-a', p_entries: a, p_hat: 'president' } });
    server.calls[1]!.settle({ data: null, error: null }); await expect(saving).resolves.toBeUndefined();
    const standard = session.save(null); await flush();
    expect(server.calls[2]!.args).toEqual({ p_chapter_id: 'chapter-a', p_entries: null, p_hat: 'president' });
    server.calls[2]!.settle({ data: null, error: null }); await standard;
  });
  it('conceals every refusal behind one message', async () => {
    const server = serverDouble(), session = createPulseLayoutSession(server.client, 'chapter-a', 'vp');
    const loading = session.load(); await flush();
    server.calls[0]!.settle({ data: null, error: { code: '42501', message: 'layout unavailable' } });
    await expect(loading).rejects.toThrow('Your Pulse layout could not be checked.');
    const again = session.load(); await flush(); server.calls[1]!.settle({ data: read, error: null }); await again;
    const saving = session.save(a); await flush();
    server.calls[2]!.settle({ data: null, error: { code: '22023', message: 'invalid layout' } });
    await expect(saving).rejects.toThrow('Your Pulse layout could not be saved.');
  });
  it('sends one write at a time, coalesces the queued ones to the latest, and never repeats a saved layout', async () => {
    const server = serverDouble(), session = createPulseLayoutSession(server.client, 'chapter-a', 'vp');
    const loading = session.load(); await flush(); server.calls[0]!.settle({ data: read, error: null }); await loading;
    const first = session.save(a); await flush();
    const second = session.save(b), third = session.save(a), fourth = session.save(b); await flush();
    expect(server.calls.filter((call) => call.name === 'save_pulse_layout')).toHaveLength(1);
    server.calls[1]!.settle({ data: null, error: null }); await first; await flush();
    // The double tap and the undo that raced the first write collapse into one
    // write of the latest layout, sent only after the first one answered.
    expect(server.calls.filter((call) => call.name === 'save_pulse_layout').map((call) => call.args.p_entries)).toEqual([a, b]);
    server.calls[2]!.settle({ data: null, error: null }); await Promise.all([second, third, fourth]);
    await session.save(b); await flush();
    expect(server.calls).toHaveLength(3);
    // Two changes in the same moment, before either is sent, become one write.
    const together = Promise.all([session.save(b), session.save(a)]); await flush();
    expect(server.calls.at(-1)!.args.p_entries).toEqual(a); server.calls.at(-1)!.settle({ data: null, error: null }); await together;
    expect(server.calls).toHaveLength(4);
  });
  it('after a lost answer sends nothing more until a fresh read, and reads only after the write settled', async () => {
    vi.useFakeTimers();
    const server = serverDouble(), session = createPulseLayoutSession(server.client, 'chapter-a', 'vp');
    const loading = session.load(); await flush(); server.calls[0]!.settle({ data: read, error: null }); await loading;
    const lost = session.save(a); const queued = session.save(b);
    const lostResult = expect(lost).rejects.toThrow('Your Pulse layout could not be saved.');
    const queuedResult = expect(queued).rejects.toThrow('Your Pulse layout could not be saved.');
    await flush(); const reread = session.load(); await flush();
    expect(server.calls.map((call) => call.name)).toEqual(['get_pulse_layout', 'save_pulse_layout']);
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); await lostResult; await queuedResult; await flush();
    // The queued write was dropped, not replayed; the read waited for the deadline.
    expect(server.calls.map((call) => call.name)).toEqual(['get_pulse_layout', 'save_pulse_layout', 'get_pulse_layout']);
    await expect(session.save(b)).rejects.toThrow('Your Pulse layout could not be saved.');
    server.calls[2]!.settle({ data: read, error: null }); await reread;
    const after = session.save(b); await flush(); expect(server.calls.at(-1)).toMatchObject({ name: 'save_pulse_layout', args: { p_entries: b } });
    server.calls.at(-1)!.settle({ data: null, error: null }); await after;
  });
  it('a read that never answers rejects at the existing deadline', async () => {
    vi.useFakeTimers();
    const server = serverDouble(), session = createPulseLayoutSession(server.client, 'chapter-a', 'vp');
    const loading = session.load(); const result = expect(loading).rejects.toThrow('Your Pulse layout could not be checked.');
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS - 1); expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); await result;
  });
  it('refuses to write before a verified read, and a paused session drops queued writes', async () => {
    const server = serverDouble(), session = createPulseLayoutSession(server.client, 'chapter-a', 'vp');
    await expect(session.save(a)).rejects.toThrow('Your Pulse layout could not be saved.');
    const loading = session.load(); await flush(); server.calls[0]!.settle({ data: read, error: null }); await loading;
    const inFlight = session.save(a); await flush(); const queued = session.save(b); await flush();
    const queuedResult = expect(queued).rejects.toThrow('Your Pulse layout could not be saved.');
    session.pause();
    server.calls[1]!.settle({ data: null, error: null }); await inFlight; await queuedResult; await flush();
    expect(server.calls.filter((call) => call.name === 'save_pulse_layout')).toHaveLength(1);
    // Paused: nothing is written until the layout is read again.
    await expect(session.save(b)).rejects.toThrow('Your Pulse layout could not be saved.');
    expect(server.calls).toHaveLength(2);
  });
  it('a read that starts drops writes queued before it and refuses every write until it lands (r1s1, r2s1)', async () => {
    const server = serverDouble(), session = createPulseLayoutSession(server.client, 'chapter-a', 'vp');
    const first = session.load(); await flush(); server.calls[0]!.settle({ data: read, error: null }); await first;
    const sent = session.save(a); await flush(); const queued = session.save(b);
    const queuedResult = expect(queued).rejects.toThrow('Your Pulse layout could not be saved.');
    const reread = session.load();
    // Pressed while the read is out: refused at once, never queued behind it.
    await expect(session.save(b)).rejects.toThrow('Your Pulse layout could not be saved.');
    server.calls[1]!.settle({ data: null, error: null }); await sent; await queuedResult; await flush();
    expect(server.calls.map((call) => call.name)).toEqual(['get_pulse_layout', 'save_pulse_layout', 'get_pulse_layout']);
    server.calls[2]!.settle({ data: { customized: true, entries: [{ key: 'fixed:turnout', pinned: false }], options: read.options }, error: null }); await reread;
    const after = session.save(a); await flush();
    expect(server.calls.at(-1)).toMatchObject({ name: 'save_pulse_layout', args: { p_entries: a } });
    server.calls.at(-1)!.settle({ data: null, error: null }); await after;
  });
  it('an older read that lands while a newer one is out does not reopen writes', async () => {
    const server = serverDouble(), session = createPulseLayoutSession(server.client, 'chapter-a', 'vp');
    const older = session.load(), newer = session.load(); await flush();
    server.calls[0]!.settle({ data: read, error: null }); await older; await flush();
    await expect(session.save(a)).rejects.toThrow('Your Pulse layout could not be saved.');
    server.calls[1]!.settle({ data: read, error: null }); await newer;
    const saving = session.save(a); await flush(); expect(server.calls.at(-1)!.name).toBe('save_pulse_layout');
    server.calls.at(-1)!.settle({ data: null, error: null }); await saving;
  });
  it('a failed read leaves writes refused until a read succeeds', async () => {
    const server = serverDouble(), session = createPulseLayoutSession(server.client, 'chapter-a', 'vp');
    const first = session.load(); await flush(); server.calls[0]!.settle({ data: read, error: null }); await first;
    const failing = session.load(); await flush(); server.calls[1]!.settle({ data: null, error: { code: '57014' } });
    await expect(failing).rejects.toThrow('Your Pulse layout could not be checked.');
    await expect(session.save(a)).rejects.toThrow('Your Pulse layout could not be saved.');
    expect(server.calls).toHaveLength(2);
  });
});
