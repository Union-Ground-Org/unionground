import { createClient, processLock } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFailClosedAuthFetch } from './authFetch';

const backend = 'https://auth-boundary.example.test';
afterEach(() => vi.useRealTimers());
function clientWith(status: number, guarded: boolean) {
  const transport = vi.fn(async () => new Response(JSON.stringify({ error_code: 'session_not_found', message: 'Session not found' }), { status }));
  return createClient(backend, 'public-test-key', {
    global: { fetch: guarded ? createFailClosedAuthFetch(backend, transport) : transport },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

describe('real pinned Auth SDK HTTP boundary', () => {
  it('releases a hung Auth transport within ten seconds even when it ignores abort', async () => {
    vi.useFakeTimers();
    let outcome = 'pending';
    let signal: AbortSignal | null | undefined;
    const transport = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    void createFailClosedAuthFetch(backend, transport)(`${backend}/auth/v1/token`).then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcome).toBe('rejected');
    expect(signal?.aborted).toBe(true);
  });

  it('preserves caller cancellation and discards a response arriving after cancellation', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let respond!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    const transport = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(resolve => { respond = resolve; });
    });
    const pending = createFailClosedAuthFetch(backend, transport)(new Request(`${backend}/auth/v1/user`, { signal: caller.signal }));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
    respond(new Response('{}'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start already-cancelled Auth work or time out non-Auth requests', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    caller.abort();
    const transport = vi.fn(async () => new Response('{}'));
    const guarded = createFailClosedAuthFetch(backend, transport);
    await expect(guarded(`${backend}/auth/v1/user`, { signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
    const init = { signal: new AbortController().signal };
    await guarded(`${backend}/rest/v1/members`, init);
    expect(transport).toHaveBeenCalledWith(`${backend}/rest/v1/members`, init);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the pinned SDK process lock so the next session check can recover', async () => {
    vi.useFakeTimers();
    const user = { id: 'test-member', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01' };
    const token = [JSON.stringify({ alg: 'HS256' }), JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, session_id: '11111111-1111-4111-8111-111111111111' }), 'test-signature']
      .map(segment => Buffer.from(segment).toString('base64url')).join('.');
    let available = true;
    const transport = vi.fn(async () => {
      if (!available) return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify({ access_token: token, refresh_token: 'local-test-refresh', expires_in: 3600, token_type: 'bearer', user }));
    });
    const client = createClient(backend, 'public-test-key', {
      global: { fetch: createFailClosedAuthFetch(backend, transport) },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock },
    });
    expect((await client.auth.setSession({ access_token: token, refresh_token: 'local-test-refresh' })).error).toBeNull();
    available = false;
    const failed = client.auth.refreshSession();
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await failed).error).not.toBeNull();
    available = true;
    // The pinned SDK retains a transient failure for a 60-second cooldown.
    await vi.advanceTimersByTimeAsync(60_000);
    const recovered = await client.auth.refreshSession();
    expect(recovered.error).toBeNull();
    expect(recovered.data.session?.user.id).toBe(user.id);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reproduces the SDK rewriting an unguarded 507 to missing-session status 400', async () => {
    const { error } = await clientWith(507, false).auth.getUser('captured-access-token');
    expect(error?.name).toBe('AuthSessionMissingError');
    expect(error?.status).toBe(400);
  });
  it.each([500, 505, 507, 511, 599])('refuses outage %s before probe or revocation normalizes its body', async (status) => {
    const probe = clientWith(status, true);
    const { error } = await probe.auth.getUser('captured-access-token');
    expect(error).not.toBeNull();
    expect(error?.name).not.toBe('AuthSessionMissingError');
    const revoked = await probe.auth.admin.signOut('captured-access-token', 'local');
    expect(revoked.error).not.toBeNull();
    expect(revoked.error?.name).not.toBe('AuthSessionMissingError');
  });
  it('keeps a genuine non-5xx missing-session answer definitive', async () => {
    expect((await clientWith(403, true).auth.getUser('captured-access-token')).error?.name).toBe('AuthSessionMissingError');
  });
  it('preserves the original outage status without consuming its body', async () => {
    const response = new Response('private provider diagnostic', { status: 507 });
    const transport = vi.fn(async () => response);
    await expect(createFailClosedAuthFetch(backend, transport)(`${backend}/auth/v1/user`)).rejects.toMatchObject({ status: 507 });
    expect(response.bodyUsed).toBe(false);
  });
});
