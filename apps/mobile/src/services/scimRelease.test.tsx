// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from '../testing/reactNativeStandIn';

// REQ-UG-HOLD-DIRECTORY-SYNC-WITH-SINGLE-SIGN-ON-20261117 (#9037):
// copy names directory sync (SCIM) only once its control read says it is
// released. Every other state is false.
const port = vi.hoisted(() => ({
  app: { mode: 'authenticated', session: { access_token: 'token-a' } as { access_token: string } | null },
  scimReleased: vi.fn(),
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('./supabase', () => ({ loadMobileScimReleased: port.scimReleased }));

import { useScimReleased } from './scimRelease';

function Probe() {
  return h('span', null, String(useScimReleased()));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

let rendered: Rendered | null = null;
async function open() {
  rendered = await render(h(Probe));
  await act(async () => { await Promise.resolve(); });
  return rendered;
}

afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  port.app = { mode: 'authenticated', session: { access_token: 'token-a' } };
  port.scimReleased.mockReset();
});

describe('useScimReleased', () => {
  it('answers false while the read is out and true only once it says directory sync is released', async () => {
    const read = deferred<boolean>();
    port.scimReleased.mockReturnValue(read.promise);
    const { container } = await open();
    expect(container.textContent).toBe('false');
    await act(async () => { read.resolve(true); });
    expect(container.textContent).toBe('true');
  });

  it('answers false while directory sync is held', async () => {
    port.scimReleased.mockResolvedValue(false);
    const { container } = await open();
    expect(container.textContent).toBe('false');
    expect(port.scimReleased).toHaveBeenCalledTimes(1);
  });

  it('answers false after a failed or refused read', async () => {
    port.scimReleased.mockRejectedValue({ code: '42501', message: 'not authorized' });
    expect((await open()).container.textContent).toBe('false');
    await rendered?.unmount();
    port.scimReleased.mockImplementation(() => { throw new Error('backend not configured'); });
    expect((await open()).container.textContent).toBe('false');
  });

  it('reads nothing and answers false signed out or in a preview', async () => {
    port.scimReleased.mockResolvedValue(true);
    port.app = { mode: 'preview', session: { access_token: 'token-a' } };
    expect((await open()).container.textContent).toBe('false');
    await rendered?.unmount();
    port.app = { mode: 'signedOut', session: null };
    expect((await open()).container.textContent).toBe('false');
    expect(port.scimReleased).not.toHaveBeenCalled();
  });

  it('answers false for a released answer read under another session', async () => {
    port.scimReleased.mockResolvedValueOnce(true);
    const { container } = await open();
    expect(container.textContent).toBe('true');
    port.scimReleased.mockReturnValueOnce(new Promise(() => {}));
    port.app = { mode: 'authenticated', session: { access_token: 'token-b' } };
    await rendered!.rerender(h(Probe));
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe('false');
  });
});
