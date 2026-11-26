// @vitest-environment jsdom
// TEST-UG-PHONE-CASE-ROWS-OPEN-EXECUTED-ON-THE-STAND-IN-20261113 (#8652;
// The
// recruited-count hook executed, not read as source. A count read for one
// account never shows on another, and a failed read shows no count.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Session = { user: { id: string } };
const runtime = vi.hoisted(() => ({
  app: { mode: 'authenticated', session: null as Session | null, refreshing: false },
  replies: new Map<string, () => Promise<{ data: unknown; error: unknown }>>(),
}));
vi.mock('../../state/AppProvider', () => ({ useApp: () => runtime.app }));
vi.mock('../../services/supabase', () => ({
  createCapturedSessionRpcClient: (session: Session) => ({
    rpc: (name: string) => {
      expect(name).toBe('get_member_rewards_summary');
      return runtime.replies.get(session.user.id)!();
    },
  }),
}));
import { useMemberRecruitedCount } from './useMemberRecruitedCount';

let root: Root, host: HTMLDivElement, shown: number | null | 'unset';

function Probe() {
  shown = useMemberRecruitedCount(true);
  return null;
}
async function render() { await act(async () => { root.render(createElement(Probe)); }); }
function deferred() {
  let resolve!: (value: { data: unknown; error: unknown }) => void;
  const promise = new Promise<{ data: unknown; error: unknown }>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  runtime.app = { mode: 'authenticated', session: null, refreshing: false };
  runtime.replies.clear();
  shown = 'unset';
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('useMemberRecruitedCount', () => {
  it('shows the count the summary returned for the signed-in worker', async () => {
    runtime.app.session = { user: { id: 'member-a' } };
    runtime.replies.set('member-a', async () => ({ data: { recruitedYtd: 4 }, error: null }));
    await render();
    expect(shown).toBe(4);
  });

  it('never shows one account\'s count after switching to another account', async () => {
    const second = deferred();
    runtime.app.session = { user: { id: 'member-a' } };
    runtime.replies.set('member-a', async () => ({ data: { recruitedYtd: 4 }, error: null }));
    runtime.replies.set('member-b', () => second.promise);
    await render();
    expect(shown).toBe(4);
    runtime.app = { ...runtime.app, session: { user: { id: 'member-b' } } };
    await render();
    // member-b's read is still out: member-a's 4 must not stand in for it.
    expect(shown).toBeNull();
    await act(async () => { second.resolve({ data: { recruitedYtd: 1 }, error: null }); });
    expect(shown).toBe(1);
  });

  it('shows no count when the read returns an error', async () => {
    runtime.app.session = { user: { id: 'member-a' } };
    runtime.replies.set('member-a', async () => ({ data: { recruitedYtd: 4 }, error: { message: 'denied' } }));
    await render();
    expect(shown).toBeNull();
  });

  it('shows no count when the read throws', async () => {
    runtime.app.session = { user: { id: 'member-a' } };
    runtime.replies.set('member-a', async () => { throw new Error('offline'); });
    await render();
    expect(shown).toBeNull();
  });

  it('shows no count outside a live worker session', async () => {
    runtime.app = { mode: 'preview', session: { user: { id: 'member-a' } }, refreshing: false };
    runtime.replies.set('member-a', async () => ({ data: { recruitedYtd: 4 }, error: null }));
    await render();
    expect(shown).toBeNull();
  });
});
