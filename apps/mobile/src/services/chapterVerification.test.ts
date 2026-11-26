import { afterEach, describe, expect, it, vi } from 'vitest';

// The SAMPLE build's portal by default; one test switches to the fictional
// Production pair.
const config = vi.hoisted(() => ({
  mobileConfig: { portalBaseUrl: 'https://sample.unionground.example/', supabaseUrl: 'https://unionground-sample.supabase.co' as string | null, backendConfigured: true },
}));
vi.mock('../lib/config', () => config);

import { bindingVerificationRequest, connectionVerificationRequest } from '../lib/chapterAdministration';
import { TEST_BACKENDS } from '../test/backends';
import {
  ChapterVerificationError,
  chapterVerificationEndpoint,
  postChapterVerification,
  type ChapterVerificationFetch,
} from './chapterVerification';

// This edition ships no hosted pair; the test setup trusts two fictional ones.
const UNION_GROUND_PORTAL_ORIGIN = TEST_BACKENDS.live.portal;
const UNION_GROUND_SUPABASE_ORIGIN = TEST_BACKENDS.live.supabaseUrl;

function reply(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const binding = bindingVerificationRequest({ chapterID: 'harborview', unionOrgID: 'org-1', verified: true, publicNote: 'Reviewed' });
const connection = connectionVerificationRequest({ chapterID: 'harborview', capability: 'sms', status: 'active' });

describe('native campaign verification boundary', () => {
  afterEach(() => {
    Object.assign(config.mobileConfig, { portalBaseUrl: 'https://sample.unionground.example/', supabaseUrl: 'https://unionground-sample.supabase.co', backendConfigured: true });
  });

  it('posts the binding decision to the one trusted portal origin with the caller’s own token', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl: ChapterVerificationFetch = async (url, init) => { calls.push([url, init]); return reply(200, { accepted: true }); };
    await postChapterVerification(binding!, 'token-abc', fetchImpl);
    expect(calls[0]?.[0]).toBe('https://sample.unionground.example/api/chapter-lifecycle-verification');
    const init = calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');
    expect(JSON.parse(String(init?.body))).toEqual({
      action: 'verify-binding', chapterId: 'harborview', unionOrgId: 'org-1', verified: true, publicNote: 'Reviewed',
    });
  });

  it('carries the connection outcome unchanged', async () => {
    const fetchImpl = vi.fn<ChapterVerificationFetch>(async () => reply(200, { accepted: true }));
    await postChapterVerification(connection!, 'token-abc', fetchImpl);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      action: 'verify-connection', chapterId: 'harborview', capability: 'sms', status: 'active', publicMessage: '',
    });
  });

  it('refuses before any network call when the session has no access token', async () => {
    const fetchImpl = vi.fn<ChapterVerificationFetch>(async () => reply(200, { accepted: true }));
    await expect(postChapterVerification(binding!, null, fetchImpl))
      .rejects.toMatchObject({ reason: 'session-expired' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('separates a refusal from a boundary that never answered', async () => {
    const cases: Array<[Response | Error, string]> = [
      [reply(401, { error: 'unauthenticated' }), 'session-expired'],
      [reply(403, { error: 'not-permitted' }), 'not-permitted'],
      [reply(409, { error: 'request-changed' }), 'request-changed'],
      [reply(503, { error: 'internal' }), 'outcome-unconfirmed'],
      [new Error('offline'), 'outcome-unconfirmed'],
    ];
    for (const [outcome, reason] of cases) {
      const fetchImpl = vi.fn<ChapterVerificationFetch>(async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      await expect(postChapterVerification(binding!, 'token-abc', fetchImpl))
        .rejects.toBeInstanceOf(ChapterVerificationError);
      await expect(postChapterVerification(binding!, 'token-abc', fetchImpl))
        .rejects.toMatchObject({ reason });
    }
  });

  it('will not post a worker token to an origin that is not the trusted portal', () => {
    expect(() => chapterVerificationEndpoint()).not.toThrow();
    expect(chapterVerificationEndpoint('https://sample.unionground.example')).toBe('https://sample.unionground.example/api/chapter-lifecycle-verification');
  });

  // Gate round 1 on #8641: the SAMPLE-only checkout check threw "Portal origin
  // is not trusted." on a Production build, before any request, so every
  // outcome button failed there.
  it('posts a Production decision to app.unionground.example, the portal paired with the Union Ground backend', async () => {
    Object.assign(config.mobileConfig, { portalBaseUrl: UNION_GROUND_PORTAL_ORIGIN, supabaseUrl: UNION_GROUND_SUPABASE_ORIGIN, backendConfigured: true });
    expect(chapterVerificationEndpoint()).toBe('https://app.unionground.example/api/chapter-lifecycle-verification');
    const fetchImpl = vi.fn<ChapterVerificationFetch>(async () => reply(200, { accepted: true }));
    await postChapterVerification(connection!, 'token-abc', fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://app.unionground.example/api/chapter-lifecycle-verification');
    // The Production portal is trusted only beside its own backend.
    Object.assign(config.mobileConfig, { supabaseUrl: 'https://example.supabase.co' });
    expect(() => chapterVerificationEndpoint()).toThrow('Portal origin is not trusted.');
  });

  // A 200 that did not come from the RPC — a proxy fallback page, an HTML
  // redirect, malformed JSON — used to read as a recorded decision and fire
  // the refresh callback, so the operator was told an audited change landed
  // when nothing was written.
  it('treats a 2xx without the boundary acknowledgement as unrecorded', async () => {
    const bodies: unknown[] = [{}, null, { accepted: false }, { result: {} }, '<html>ok</html>'];
    for (const body of bodies) {
      const fetchImpl = vi.fn<ChapterVerificationFetch>(async () => reply(200, body));
      await expect(postChapterVerification(binding!, 'token-abc', fetchImpl))
        .rejects.toMatchObject({ reason: 'outcome-unconfirmed' });
    }
    const malformed = vi.fn<ChapterVerificationFetch>(async () => ({
      ok: true,
      status: 200,
      json: (): Promise<unknown> => Promise.reject(new Error('not json')),
    } as Response));
    await expect(postChapterVerification(binding!, 'token-abc', malformed))
      .rejects.toMatchObject({ reason: 'outcome-unconfirmed' });
  });

  it('accepts exactly the acknowledgement the boundary sends', async () => {
    const fetchImpl = vi.fn<ChapterVerificationFetch>(async () => reply(200, { accepted: true, result: { status: 'verified' } }));
    await expect(postChapterVerification(binding!, 'token-abc', fetchImpl)).resolves.toBeUndefined();
  });

  // Without a bound, a transport that opens and never answers leaves the
  // await pending for the life of the screen: every verification control
  // stays disabled and the unavailable path never runs.
  it('gives up on a transport that never answers and reports it as unavailable', async () => {
    const fetchImpl: ChapterVerificationFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
    });
    await expect(postChapterVerification(binding!, 'token-abc', fetchImpl, 5))
      .rejects.toMatchObject({ reason: 'outcome-unconfirmed' });
  });

  it('carries an abort signal on every request', async () => {
    const fetchImpl = vi.fn<ChapterVerificationFetch>(async () => reply(200, { accepted: true }));
    await postChapterVerification(binding!, 'token-abc', fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  // Headers can arrive and the body then stall: a JSON read outside the bound
  // held the controls busy for the life of the screen (evidence
  // pr2838-body-timeout-0131). The bound now covers the body, and holds even
  // for a stream that ignores the abort signal.
  it('keeps the timeout active through body consumption', async () => {
    const stalled: ChapterVerificationFetch = async () => ({
      ok: true,
      status: 200,
      json: () => new Promise<unknown>(() => { /* never settles */ }),
    } as Response);
    const started = Date.now();
    await expect(postChapterVerification(binding!, 'token-abc', stalled, 5))
      .rejects.toMatchObject({ reason: 'outcome-unconfirmed' });
    expect(Date.now() - started).toBeLessThan(2000);
    const ignoresSignal: ChapterVerificationFetch = async () => new Response(new ReadableStream<Uint8Array>({ start() { /* headers only, body never closes */ } }), { status: 200 });
    await expect(postChapterVerification(binding!, 'token-abc', ignoresSignal, 5))
      .rejects.toMatchObject({ reason: 'outcome-unconfirmed' });
  });

  it('accepts a complete body that arrives inside the bound', async () => {
    const complete: ChapterVerificationFetch = async () => new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(postChapterVerification(binding!, 'token-abc', complete, 500)).resolves.toBeUndefined();
  });

  // A commit-then-lost-response sequence (evidence pr2838-unknown-outcome-0153):
  // the client cannot infer a rollback from a lost acknowledgement, so the
  // reason must say the outcome is unknown, never that nothing was recorded.
  it('reports a lost response as an unconfirmed outcome, not as a refusal or as nothing recorded', async () => {
    let committed = false;
    const lost: ChapterVerificationFetch = async () => { committed = true; throw new TypeError('response lost after server commit'); };
    await expect(postChapterVerification(binding!, 'token-abc', lost)).rejects.toMatchObject({ reason: 'outcome-unconfirmed' });
    expect(committed).toBe(true);
    const { chapterVerificationCopy } = await import('../lib/chapterAdministrationCopy');
    const locales: Array<'en' | 'es'> = ['en', 'es'];
    for (const locale of locales) {
      const text = chapterVerificationCopy[locale].failure['outcome-unconfirmed'];
      expect(text).not.toMatch(/Nothing was recorded|No se registró nada/u);
      expect(text).toMatch(/may or may not|Puede o no/u);
    }
  });

  // A transport that settles a task AFTER the abort, or never settles at all,
  // must neither surface an unhandled `timeout` rejection nor keep the
  // controls busy (evidence pr2838-r2-reproduction-0210, F1).
  it('handles a delayed or ignored abort without an unhandled rejection and without staying busy', async () => {
    const unhandled: string[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason instanceof Error ? reason.message : String(reason)); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const delayed: ChapterVerificationFetch = (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { setTimeout(() => reject(new Error('native abort settled later')), 30); });
      });
      await expect(postChapterVerification(binding!, 'token-abc', delayed, 5)).rejects.toMatchObject({ reason: 'outcome-unconfirmed' });
      await new Promise((resolve) => setTimeout(resolve, 60));
      const ignored: ChapterVerificationFetch = () => new Promise(() => { /* never settles, ignores the signal */ });
      const started = Date.now();
      await expect(postChapterVerification(binding!, 'token-abc', ignored, 5)).rejects.toMatchObject({ reason: 'outcome-unconfirmed' });
      expect(Date.now() - started).toBeLessThan(2000);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('never claims a re-read completed in the unconfirmed copy, in either locale', async () => {
    const { chapterVerificationCopy, chapterMembershipCopy } = await import('../lib/chapterAdministrationCopy');
    const locales: Array<'en' | 'es'> = ['en', 'es'];
    for (const locale of locales) {
      const verification = chapterVerificationCopy[locale].failure['outcome-unconfirmed'];
      expect(verification).not.toMatch(/has been re-read|se volvió a leer|Nothing was recorded|No se registró nada/u);
      expect(verification).toMatch(/Re-read the request|Vuelva a leer la solicitud/u);
      for (const text of [chapterMembershipCopy[locale].membershipUnconfirmed('Ada'), chapterMembershipCopy[locale].roleUnconfirmed('Ada')]) {
        expect(text).toContain('Ada');
        expect(text).not.toMatch(/has been re-read|se volvió a leer/u);
        expect(text).toMatch(/may or may not|Puede o no/u);
      }
      expect(chapterMembershipCopy[locale].refreshFailed).not.toMatch(/recorded|registrado/u);
    }
  });
});
