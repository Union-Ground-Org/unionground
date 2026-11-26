import { beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699,
// part 2): alliance grievance co-signers on the phone through the website's
// calls.
type Call = [string, ...unknown[]];
const calls: Call[] = [];
const tables: Record<string, { data: unknown; error: unknown }> = {};
const rpcAnswers: Record<string, { data: unknown; error: unknown }> = {};
const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), auth: { getSession: vi.fn() }, pinned: vi.fn() }));
vi.mock('./supabase', () => ({
  getSupabaseClient: () => backend,
  createCapturedSessionRpcClient: (session: { user: { id: string } }) => { backend.pinned(session.user.id); return backend; },
}));
vi.mock('../../../../src/lib/sensitiveContentApi.js', () => ({ sensitiveContentRpc: vi.fn() }));

import { FormActionError } from './memberForms';
import { CosignChangedSincePreview, CosignRefusal, inviteCosigner, loadCosigning, normalCosignerEmail, respondToCosign, withdrawCosign } from './formCosigners';

const session = (userID: string, email = 'pat@example.org') => ({ data: { session: { access_token: `token-${userID}`, user: { id: userID, email } } } });
const STROKES = [[{ x: 10, y: 20 }, { x: 30, y: 40 }]];

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(tables)) delete tables[key];
  for (const key of Object.keys(rpcAnswers)) delete rpcAnswers[key];
  backend.pinned.mockReset();
  backend.auth.getSession.mockResolvedValue(session('user-1'));
  backend.from.mockImplementation((table: string) => {
    calls.push(['from', table]);
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order']) query[method] = (...args: unknown[]) => { calls.push([method, ...args]); return query; };
    query.limit = async () => tables[table] ?? { data: [], error: null };
    return query;
  });
  backend.rpc.mockImplementation(async (name: string, args: unknown) => { calls.push(['rpc', name, args]); return rpcAnswers[name] ?? { data: { status: 'ok' }, error: null }; });
});

describe('reading co-signing', () => {
  it('splits the rows into co-signers on the worker’s forms and invitations to the worker, as the website does', async () => {
    tables.member_form_cosigners = { data: [
      { id: 'c1', form_id: 'own-1', invited_email: 'sam@example.org', cosigner_user_id: null, status: 'invited', invited_at: '2026-11-13T10:00:00Z' },
      { id: 'c2', form_id: 'own-1', invited_email: 'lee@example.org', cosigner_user_id: 'user-3', status: 'accepted', invited_at: '2026-11-12T10:00:00Z' },
      { id: 'c3', form_id: 'other-1', invited_email: 'PAT@example.org', cosigner_user_id: null, status: 'invited', invited_at: '2026-11-13T09:00:00Z' },
      { id: 'c4', form_id: 'other-2', invited_email: 'old@example.org', cosigner_user_id: 'user-1', status: 'accepted', invited_at: '2026-11-11T09:00:00Z' },
      { id: 'c5', form_id: 'other-3', invited_email: 'pat@example.org', cosigner_user_id: 'user-1', status: 'declined', invited_at: '2026-11-10T09:00:00Z' },
      { id: 'c6', form_id: 'other-4', invited_email: 'someone@example.org', cosigner_user_id: 'user-9', status: 'invited', invited_at: '2026-11-10T09:00:00Z' },
    ], error: null };
    tables.member_forms = { data: [{ id: 'other-2', template_key: 'alliance_grievance', template_version: 2, answers: { summary: 'Unsafe staffing', hours: 6 }, status: 'approved' }], error: null };
    backend.rpc.mockImplementation(async (name: string, args: { p_form_id: string }) => {
      calls.push(['rpc', name, args]);
      // Only the first preview issues a digest (#8730); the second stands for
      // a server before 20261113122700.
      return { data: { summary: `Summary of ${args.p_form_id}`, filerName: 'Jordan R.', ...(args.p_form_id === 'other-1' ? { reviewDigest: 'a'.repeat(64) } : {}) }, error: null };
    });
    const cosigning = await loadCosigning('user-1', new Set(['own-1']));
    expect(cosigning.cosigners).toEqual({ 'own-1': [
      { id: 'c1', email: 'sam@example.org', status: 'invited', invitedAt: '2026-11-13T10:00:00Z' },
      { id: 'c2', email: 'lee@example.org', status: 'accepted', invitedAt: '2026-11-12T10:00:00Z' },
    ] });
    expect(cosigning.requests).toEqual([
      { formID: 'other-1', status: 'invited', summary: 'Summary of other-1', filerName: 'Jordan R.', reviewDigest: 'a'.repeat(64), previewUnavailable: false, grievance: null },
      { formID: 'other-2', status: 'accepted', summary: 'Summary of other-2', filerName: 'Jordan R.', reviewDigest: null, previewUnavailable: false, grievance: { templateKey: 'alliance_grievance', templateVersion: 2, answers: { summary: 'Unsafe staffing', hours: '6' }, status: 'approved' } },
    ]);
    // Only the accepted grievance is read in full; the previews are the
    // summary-only definer reads.
    expect(calls).toContainEqual(['in', 'id', ['other-2']]);
    // The accepted grievance's own status comes with it (gate stage 169, r3s1).
    expect(calls).toContainEqual(['select', 'id,template_key,template_version,answers,status']);
    expect(calls.filter((call) => call[1] === 'cosign_invite_preview').map((call) => call[2])).toEqual([{ p_form_id: 'other-1' }, { p_form_id: 'other-2' }]);
    expect(backend.pinned).toHaveBeenCalledWith('user-1');
  });

  it('fails the read rather than show part of it, and stops for another worker', async () => {
    tables.member_form_cosigners = { data: null, error: { message: 'offline' } };
    await expect(loadCosigning('user-1', new Set())).rejects.toMatchObject({ reason: 'unavailable' });
    backend.auth.getSession.mockResolvedValue(session('user-2'));
    await expect(loadCosigning('user-1', new Set())).rejects.toMatchObject({ reason: 'session-changed' });
  });
});

describe('co-signer writes', () => {
  it('invites with the website’s email check, trimmed and lower-cased', async () => {
    await inviteCosigner('own-1', '  Sam@Example.org ', 'user-1');
    expect(calls).toEqual([['rpc', 'invite_cosigner', { p_form_id: 'own-1', p_email: 'sam@example.org' }]]);
    expect(normalCosignerEmail('not-an-email')).toBeNull();
    expect(normalCosignerEmail(`${'a'.repeat(320)}@example.org`)).toBeNull();
    calls.length = 0;
    await expect(inviteCosigner('own-1', 'not-an-email', 'user-1')).rejects.toMatchObject({ reason: 'failed' });
    expect(calls).toEqual([]);
  });

  it('accepts only with a drawn signature and consent, declines with neither, and withdraws', async () => {
    await respondToCosign('other-1', true, STROKES, 'user-1');
    await respondToCosign('other-1', false, null, 'user-1');
    await withdrawCosign('other-2', 'user-1');
    expect(calls).toEqual([
      ['rpc', 'respond_to_cosign', { p_form_id: 'other-1', p_accept: true, p_strokes: STROKES, p_consent: true }],
      ['rpc', 'respond_to_cosign', { p_form_id: 'other-1', p_accept: false, p_strokes: null, p_consent: false }],
      ['rpc', 'withdraw_cosign', { p_form_id: 'other-2' }],
    ]);
    calls.length = 0;
    await expect(respondToCosign('other-1', true, [[{ x: 1, y: 1 }]], 'user-1')).rejects.toMatchObject({ reason: 'signature-required' });
    expect(calls).toEqual([]);
    rpcAnswers.withdraw_cosign = { data: null, error: { message: 'not withdrawable' } };
    await expect(withdrawCosign('other-2', 'user-1')).rejects.toMatchObject({ reason: 'failed' });
  });
});

// Gate stage 169 (r3s1): a server refusal is the server's answer, never a
// connection problem.
describe('co-signer refusals', () => {
  it('names the server’s refusals and keeps a request with no answer a failure', async () => {
    const refuse = (message: string) => ({ data: null, error: { code: '22023', message } });
    rpcAnswers.withdraw_cosign = refuse('you have no withdrawable co-signature on this form');
    await expect(withdrawCosign('other-2', 'user-1')).rejects.toMatchObject({ reason: 'not-withdrawable' });
    rpcAnswers.respond_to_cosign = refuse('no pending co-sign invitation for you on this form');
    await expect(respondToCosign('other-1', false, null, 'user-1')).rejects.toBeInstanceOf(CosignRefusal);
    const refusals: [string, string][] = [
      ['you cannot invite yourself', 'self'],
      ['this worker answered already — you can ask again after 2026-11-15', 'answered'],
      ['co-signer limit reached (max 10)', 'limit'],
      ['form not found or not eligible for co-signers', 'not-eligible'],
    ];
    for (const [message, reason] of refusals) {
      rpcAnswers.invite_cosigner = refuse(message);
      await expect(inviteCosigner('own-1', 'sam@example.org', 'user-1')).rejects.toMatchObject({ reason });
    }
    rpcAnswers.invite_cosigner = { data: null, error: { message: 'TypeError: fetch failed' } };
    await expect(inviteCosigner('own-1', 'sam@example.org', 'user-1')).rejects.toMatchObject({ reason: 'failed' });
  });
});

// Gate stage 185 on #8738 (r1s1): only a preview the server answered makes a
// request answerable. A failed or malformed one never becomes a request with
// no digest, which would accept without the comparison.
describe('a preview that did not load', () => {
  it('marks the request unavailable, with no digest, and keeps the no-digest path for a loaded preview only', async () => {
    tables.member_form_cosigners = { data: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((formID, index) => (
      { id: `c${index}`, form_id: formID, invited_email: 'pat@example.org', cosigner_user_id: 'user-1', status: 'invited', invited_at: `2026-11-13T1${index}:00:00Z` }
    )), error: null };
    const replies: Record<string, { data: unknown; error: unknown }> = {
      p1: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
      p2: { data: null, error: { message: 'Service Unavailable', status: 503 } },
      p3: { data: null, error: null },
      p4: { data: { summary: 'Heat', filerName: 'Jordan R.', reviewDigest: 'not-a-digest' }, error: null },
      p5: { data: { summary: 'Heat', filerName: 'Jordan R.' }, error: null },
      p6: { data: { summary: 'Heat', filerName: 'Jordan R.', reviewDigest: 'c'.repeat(64) }, error: null },
    };
    backend.rpc.mockImplementation(async (name: string, args: { p_form_id: string }) => {
      calls.push(['rpc', name, args]);
      return replies[args.p_form_id] ?? { data: null, error: { message: 'unexpected' } };
    });
    const { requests } = await loadCosigning('user-1', new Set());
    const byForm = Object.fromEntries(requests.map((request) => [request.formID, { unavailable: request.previewUnavailable, digest: request.reviewDigest, summary: request.summary }]));
    expect(byForm).toEqual({
      p1: { unavailable: true, digest: null, summary: '' },
      p2: { unavailable: true, digest: null, summary: '' },
      p3: { unavailable: true, digest: null, summary: '' },
      p4: { unavailable: true, digest: null, summary: '' },
      p5: { unavailable: false, digest: null, summary: 'Heat' },
      p6: { unavailable: false, digest: 'c'.repeat(64), summary: 'Heat' },
    });
  });
});

// #8730: an accept names the preview the co-signer was shown, the way the
// website does since #8729.
describe('co-signing only the previewed version', () => {
  const DIGEST = 'b'.repeat(64);

  it('sends the issued digest on an accept only, by name, and goes as before when none was issued', async () => {
    await respondToCosign('other-1', true, STROKES, 'user-1', DIGEST);
    await respondToCosign('other-1', false, null, 'user-1', DIGEST);
    await respondToCosign('other-1', true, STROKES, 'user-1', null);
    expect(calls).toEqual([
      ['rpc', 'respond_to_cosign', { p_form_id: 'other-1', p_accept: true, p_strokes: STROKES, p_consent: true, p_expected_digest: DIGEST }],
      ['rpc', 'respond_to_cosign', { p_form_id: 'other-1', p_accept: false, p_strokes: null, p_consent: false }],
      ['rpc', 'respond_to_cosign', { p_form_id: 'other-1', p_accept: true, p_strokes: STROKES, p_consent: true }],
    ]);
  });

  it('stores and retries nothing when the grievance changed after the preview', async () => {
    rpcAnswers.respond_to_cosign = { data: null, error: { code: 'PT409', details: 'cosign_changed_since_preview', message: 'form changed since the co-sign preview' } };
    await expect(respondToCosign('other-1', true, STROKES, 'user-1', DIGEST)).rejects.toBeInstanceOf(CosignChangedSincePreview);
    expect(calls.filter(([kind]) => kind === 'rpc')).toHaveLength(1);
  });

  it('never drops an issued digest to try again: a missing-function answer can be a stale schema cache', async () => {
    rpcAnswers.respond_to_cosign = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.respond_to_cosign' } };
    await expect(respondToCosign('other-1', true, STROKES, 'user-1', DIGEST)).rejects.toBeInstanceOf(FormActionError);
    expect(calls).toEqual([
      ['rpc', 'respond_to_cosign', { p_form_id: 'other-1', p_accept: true, p_strokes: STROKES, p_consent: true, p_expected_digest: DIGEST }],
    ]);
  });
});
