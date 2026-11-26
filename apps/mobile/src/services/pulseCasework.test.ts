import { describe, expect, it, vi } from 'vitest';
vi.mock('./supabase', () => ({ createCapturedSessionRpcClient: vi.fn() }));
import { loadPulseCasework, type CaseworkRpc } from './pulseCasework';

function client(answers: Record<string, { data: unknown; error: unknown }>) {
  const calls: [string, Record<string, unknown>][] = [];
  const rpc: CaseworkRpc = { rpc: (name, args) => { calls.push([name, args]); return Promise.resolve(answers[name] ?? { data: null, error: { code: '42883' } }); } };
  return { rpc, calls };
}

describe('Issue work chart loader', () => {
  it('reads only the Issue work charts on the Pulse, each bound to the screen’s campaign', async () => {
    const server = client({ get_pulse_open_overdue: { data: { state: 'withheld' }, error: null } });
    const cards = await loadPulseCasework(server.rpc, ['ready:open-overdue', 'fixed:membership', 'ready:notice-reach'], 'chapter-a', new AbortController().signal);
    expect(server.calls).toEqual([['get_pulse_open_overdue', { p_chapter_id: 'chapter-a' }]]);
    expect(cards.map((card) => [card.id, card.message])).toEqual([['ready:open-overdue', 'Withheld: a group of people behind these figures is too small to share safely.']]);
    expect(await loadPulseCasework(server.rpc, ['fixed:membership'], 'chapter-a', new AbortController().signal)).toEqual([]);
  });

  it('shows a refusal for a campaign that is no longer selected as unavailable, never as figures or zero', async () => {
    const server = client({ get_pulse_open_overdue: { data: { state: 'unavailable' }, error: null } });
    const [card] = await loadPulseCasework(server.rpc, ['ready:open-overdue'], 'chapter-a', new AbortController().signal);
    expect(card).toMatchObject({ unavailable: true, rows: [], message: 'These figures are not available for your current role.' });
  });

  it('turns a refused, failed or abandoned read into that card’s not-loaded state, never zero', async () => {
    const server = client({ get_pulse_casework: { data: null, error: { code: '42501' } } });
    const cards = await loadPulseCasework(server.rpc, ['ready:casework', 'ready:days-to-resolve'], 'chapter-a', new AbortController().signal);
    expect(cards.map((card) => [card.id, card.unavailable, card.rows.length])).toEqual([['ready:days-to-resolve', true, 0], ['ready:casework', true, 0]]);
    const aborted = new AbortController(); aborted.abort();
    const late = client({ get_pulse_open_overdue: { data: { state: 'ready', open: 30, overdue: 0, resolvedThisMonth: 0 }, error: null } });
    expect((await loadPulseCasework(late.rpc, ['ready:open-overdue'], 'chapter-a', aborted.signal))[0]).toMatchObject({ unavailable: true, rows: [] });
  });
});
