import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STEWARD_HINTS_SWITCH, StewardAmbientHint } from '../src/features/memberHome/StewardAmbientHint.jsx';

const initialNow = Date.parse('2026-10-20T16:00:00-04:00');
const enabled = { organizationConfiguration: { switches: { [STEWARD_HINTS_SWITCH]: true } } };
function hint(id, extra = {}) {
  return {
    id, scope: 'chapter', organization_id: 'org', chapter_id: 'chapter',
    kind: 'mini_lesson', locale: 'en', locale_state: 'reviewed', audience: 'staff',
    status: 'published', title: id, body: 'Current guidance.',
    starts_at: new Date(initialNow - 60_000).toISOString(), ends_at: null,
    revision: 1, priority: 0, ...extra,
  };
}
function wiring(items, overrides = {}) {
  const client = { rpc: vi.fn(async () => ({ data: { items, hasMore: false }, error: null })) };
  return {
    client,
    transport: { client, session: { user: { id: 'steward' } }, organizationId: 'org', chapterId: 'chapter', locale: 'en', ...overrides },
  };
}
const view = transport => <StewardAmbientHint data={enabled} learningContent={transport} />;

afterEach(() => { cleanup(); vi.useRealTimers(); });
it.each([true, false])('retires an expired steward hint while keeping a non-expiring one (expires=%s)', async (expires) => {
  vi.useFakeTimers();
  const now = Date.parse('2026-10-20T20:00:00.000Z');
  vi.setSystemTime(now);
  const item = {
    id: 'hint', scope: 'chapter', organization_id: 'org', chapter_id: 'chapter',
    kind: 'mini_lesson', locale: 'en', locale_state: 'reviewed', audience: 'staff',
    status: 'published', title: 'A time-limited hint', body: 'Current guidance.',
    starts_at: new Date(now - 60_000).toISOString(),
    ends_at: expires ? new Date(now + 60_000).toISOString() : null,
    revision: 1, priority: 0,
  };
  const client = {rpc: vi.fn(async (name) => {
    if (name !== 'list_learning_content') throw new Error(`Unexpected RPC ${name}`);
    return {data: {items: [item], hasMore: false}, error: null};
  })};
  await act(async () => render(<StewardAmbientHint
    data={{organizationConfiguration: {switches: {[STEWARD_HINTS_SWITCH]: true}}}}
    learningContent={{client, session: {user: {id: 'steward'}}, organizationId: 'org', chapterId: 'chapter', locale: 'en'}}
  />));
  expect(screen.queryByRole('heading', {name: item.title})).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60_025));
  const heading = screen.queryByRole('heading', {name: item.title});
  if (expires) expect(heading).toBeNull();
  else expect(heading).not.toBeNull();
});

it('advances from an expired staff hint to the next live staff hint without a read', async () => {
  vi.useFakeTimers(); vi.setSystemTime(initialNow);
  const { client, transport } = wiring([
    hint('All audience', { audience: 'all' }),
    hint('First staff', { ends_at: new Date(initialNow + 60_000).toISOString() }),
    hint('Second staff'),
  ]);
  await act(async () => render(view(transport)));
  expect(screen.getByRole('heading', { name: 'First staff' })).toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(60_025));
  expect(screen.getByRole('heading', { name: 'Second staff' })).toBeInTheDocument();
  expect(client.rpc).toHaveBeenCalledTimes(1);
});

it('falls back to a live all-audience hint and excludes members-only content', async () => {
  vi.useFakeTimers(); vi.setSystemTime(initialNow);
  const { client, transport } = wiring([
    hint('Current staff', { ends_at: new Date(initialNow + 60_000).toISOString() }),
    hint('Members only', { audience: 'members' }),
    hint('Everyone', { audience: 'all', ends_at: new Date(initialNow + 120_000).toISOString() }),
  ]);
  await act(async () => render(view(transport)));
  await act(async () => vi.advanceTimersByTimeAsync(60_025));
  expect(screen.getByRole('heading', { name: 'Everyone' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Members only' })).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.queryByRole('heading')).toBeNull();
  expect(client.rpc).toHaveBeenCalledTimes(1);
});

it('retires a hint on focus after the clock passes its deadline without polling', async () => {
  vi.useFakeTimers(); vi.setSystemTime(initialNow);
  const { client, transport } = wiring([hint('Expires while away', { ends_at: new Date(initialNow + 60_000).toISOString() })]);
  await act(async () => render(view(transport)));
  vi.setSystemTime(initialNow + 120_000);
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(screen.queryByRole('heading')).toBeNull();
  expect(client.rpc).toHaveBeenCalledTimes(1);
});

it('drops an old chapter response after the hint session changes', async () => {
  vi.useFakeTimers(); vi.setSystemTime(initialNow);
  let finishOld;
  const old = wiring([]);
  old.client.rpc.mockReturnValue(new Promise(resolve => { finishOld = resolve; }));
  const next = wiring([hint('New chapter hint', { chapter_id: 'new-chapter' })], { chapterId: 'new-chapter' });
  let mounted;
  await act(async () => { mounted = render(view(old.transport)); });
  await act(async () => mounted.rerender(view(next.transport)));
  expect(screen.getByRole('heading', { name: 'New chapter hint' })).toBeInTheDocument();
  await act(async () => finishOld({ data: { items: [hint('Old chapter hint')], hasMore: false }, error: null }));
  expect(screen.queryByRole('heading', { name: 'Old chapter hint' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'New chapter hint' })).toBeInTheDocument();
  expect(old.client.rpc).toHaveBeenCalledTimes(1);
  expect(next.client.rpc).toHaveBeenCalledTimes(1);
});

it('clears the publication timer on unmount and retires a pending read', async () => {
  vi.useFakeTimers(); vi.setSystemTime(initialNow);
  const loaded = wiring([hint('A live hint')]);
  let mounted;
  await act(async () => { mounted = render(view(loaded.transport)); });
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  mounted.unmount();
  expect(vi.getTimerCount()).toBe(0);
  let finish;
  const pending = wiring([]);
  pending.client.rpc.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await act(async () => { mounted = render(view(pending.transport)); });
  mounted.unmount();
  await act(async () => finish({ data: { items: [hint('Retired hint')], hasMore: false }, error: null }));
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.queryByRole('heading')).toBeNull();
});

it('keeps the hint empty on a refused read', async () => {
  vi.useFakeTimers(); vi.setSystemTime(initialNow);
  const { client, transport } = wiring([]);
  client.rpc.mockRejectedValue(new Error('local refusal'));
  await act(async () => render(view(transport)));
  expect(screen.queryByRole('heading')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60_025));
  expect(client.rpc).toHaveBeenCalledTimes(1);
});
