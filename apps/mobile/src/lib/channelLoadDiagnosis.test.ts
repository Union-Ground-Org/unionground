import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_LOAD_LOG_TAG,
  CHANNEL_LOAD_OPS,
  classifyChannelLoadError,
  classifyChannelActionError,
  classifyMarkReadError,
  isMarkReadSpaceUnavailable,
  readLastChannelLoadDiagnosis,
  recordChannelLoadDiagnosis,
  resetChannelLoadDiagnosis,
} from './channelLoadDiagnosis';

afterEach(() => {
  resetChannelLoadDiagnosis();
});

describe('classifyChannelLoadError', () => {
  it('classifies row-level-security denials as authorized-empty', () => {
    expect(classifyChannelLoadError({ code: '42501' })).toBe('authorized-empty');
    // PR #2058 contract (amended): a bare 403 was pinned as authorized-empty
    // because the HTTP status was treated as an RLS denial. The predicates
    // private.can_read_chapter_space() and private.mfa_satisfied() cannot
    // raise, so a real privilege denial carries SQLSTATE 42501. A codeless
    // 403 is a gateway refusal and classifies as `request` instead
    // (BUG-UG-MOBILE-CHANNEL-CODELESS-403-READS-AS-AUTHORIZED-EMPTY-20260918).
    expect(classifyChannelLoadError({ status: 403 })).toBe('request');
    expect(classifyChannelLoadError({ code: '42501', status: 403 })).toBe('authorized-empty');
  });

  it('lets a 403 that carries a non-authorization code reach the code-based classes', () => {
    expect(classifyChannelLoadError({ code: 'PGRST204', status: 403 })).toBe('schema');
    expect(classifyChannelLoadError({ code: '42P01', status: 403 })).toBe('schema');
    expect(classifyChannelLoadError({ error: { message: 'Forbidden' }, status: 403, data: null })).toBe('request');
  });

  it('does not change non-403 classifications when a 403 is also present in the suite', () => {
    expect(classifyChannelLoadError({ status: 401 })).toBe('authentication');
    expect(classifyChannelLoadError({ status: 400 })).toBe('request');
    expect(classifyChannelLoadError({ status: 404 })).toBe('request');
    expect(classifyChannelLoadError({ status: 503 })).toBe('transport');
    expect(classifyChannelLoadError({ code: 'PGRST204', status: 400 })).toBe('schema');
    expect(classifyChannelLoadError({ code: '42501' })).toBe('authorized-empty');
  });

  it('classifies expired, rejected, or absent JWTs as authentication faults', () => {
    expect(classifyChannelLoadError({ code: 'PGRST301' })).toBe('authentication');
    expect(classifyChannelLoadError({ code: 'pgrst302' })).toBe('authentication');
    expect(classifyChannelLoadError({ status: 401 })).toBe('authentication');
    expect(classifyChannelLoadError({ code: 'PGRST301', status: 401 })).toBe('authentication');
  });

  it('reads PostgREST response-level status when the error body has none', () => {
    expect(classifyChannelLoadError({ error: { code: '' }, status: 0, data: null })).toBe('transport');
    expect(classifyChannelLoadError({ error: { message: 'Failed to fetch' }, status: 0 })).toBe('transport');
    expect(classifyChannelLoadError({ error: { code: '' }, data: null })).toBe('unknown');
    expect(classifyChannelLoadError({ error: { name: 'TypeError' }, status: 0, data: null })).toBe('transport');
    expect(classifyChannelLoadError({ error: { code: 'PGRST204' }, status: 400, data: null })).toBe('schema');
  });

  it('classifies PostgREST and undefined-relation SQLSTATEs as schema faults', () => {
    expect(classifyChannelLoadError({ code: 'PGRST204' })).toBe('schema');
    expect(classifyChannelLoadError({ code: 'PGRST200' })).toBe('schema');
    expect(classifyChannelLoadError({ code: 'PGRST202' })).toBe('schema');
    expect(classifyChannelLoadError({ code: '42P01' })).toBe('schema');
    expect(classifyChannelLoadError({ code: '42703' })).toBe('schema');
    expect(classifyChannelLoadError({ code: '42883' })).toBe('schema');
  });

  it('classifies network, abort, timeout, and 5xx as transport faults', () => {
    expect(classifyChannelLoadError({ name: 'AbortError' })).toBe('transport');
    expect(classifyChannelLoadError({ name: 'TimeoutError' })).toBe('transport');
    expect(classifyChannelLoadError({ name: 'TypeError' })).toBe('transport');
    expect(classifyChannelLoadError({ code: 'ETIMEDOUT' })).toBe('transport');
    expect(classifyChannelLoadError({ status: 0 })).toBe('transport');
    expect(classifyChannelLoadError({ status: 503 })).toBe('transport');
    expect(classifyChannelLoadError({ statusCode: 502 })).toBe('transport');
    expect(classifyChannelLoadError({ code: 'PGRST003' })).toBe('transport');
  });

  // BUG-UG-MOBILE-CHAPTER-CHANNELS-CLASS-UNKNOWN-ON-DEVICE-20260918: the
  // gateway refused the load's own request line ahead of PostgREST, so the
  // answer carried a status and a plain-text body but no PostgREST code.
  it('names a codeless backend answer as a request fault', () => {
    expect(classifyChannelLoadError({ error: { message: 'Bad Request' }, status: 400, data: null })).toBe('request');
    expect(classifyChannelLoadError({ status: 400 })).toBe('request');
    expect(classifyChannelLoadError({ status: 403 })).toBe('request');
    expect(classifyChannelLoadError({ status: 404 })).toBe('request');
    expect(classifyChannelLoadError({ status: 414 })).toBe('request');
    expect(classifyChannelLoadError({ status: 429 })).toBe('request');
    expect(classifyChannelLoadError({ code: 'P0001', status: 400 })).toBe('request');
  });

  it('never reports the catch-all class for an answer a reachable backend produced', () => {
    for (let status = 400; status <= 599; status += 1) {
      expect(
        classifyChannelLoadError({ error: { message: 'refused' }, status, data: null }),
        `status ${status}`,
      ).not.toBe('unknown');
      expect(classifyChannelLoadError({ status }), `bare status ${status}`).not.toBe('unknown');
    }
  });

  it('classifies an uncoded value as unknown and never consults the message', () => {
    expect(classifyChannelLoadError({ message: 'relation does not exist' })).toBe('unknown');
    expect(classifyChannelLoadError('boom')).toBe('unknown');
    expect(classifyChannelLoadError(null)).toBe('unknown');
  });

  it('prefers authentication over a PostgREST schema code on the same value', () => {
    expect(classifyChannelLoadError({ code: 'PGRST301', status: 401 })).toBe('authentication');
  });
});

describe('classifyChannelActionError', () => {
  it('maps the reaction and vote RPC 42501 denial to authentication, not authorized-empty', () => {
    // toggle_member_message_reaction and cast_channel_poll_vote both open with
    // `caller is null or not private.mfa_satisfied()` raising 42501.
    expect(classifyChannelActionError({ code: '42501' })).toBe('authentication');
    expect(classifyChannelActionError({ error: { code: '42501' }, data: null })).toBe('authentication');
    expect(classifyChannelLoadError({ error: { code: '42501' }, data: null })).toBe('authorized-empty');
  });

  it('maps the message/poll-unavailable 22023 raise to request', () => {
    expect(classifyChannelActionError({ code: '22023' })).toBe('request');
    expect(classifyChannelActionError({ error: { code: '22023' }, data: null })).toBe('request');
  });

  it('is the classifier mark-read already used', () => {
    expect(classifyMarkReadError).toBe(classifyChannelActionError);
  });
});

describe('classifyMarkReadError', () => {
  it('maps the RPC 42501 authentication denial instead of authorized-empty', () => {
    expect(classifyMarkReadError({ code: '42501' })).toBe('authentication');
    expect(classifyMarkReadError({ error: { code: '42501' }, data: null })).toBe('authentication');
    expect(classifyMarkReadError({ code: '42501', status: 403 })).toBe('authentication');
    expect(classifyChannelLoadError({ code: '42501' })).toBe('authorized-empty');
  });

  it('reuses the load classifier for every other mark-read answer', () => {
    expect(classifyMarkReadError({ name: 'AbortError' })).toBe('transport');
    expect(classifyMarkReadError({ code: 'PGRST202' })).toBe('schema');
    expect(classifyMarkReadError({ status: 401 })).toBe('authentication');
    expect(classifyMarkReadError({ status: 400 })).toBe('request');
    expect(classifyMarkReadError(null)).toBe('unknown');
  });

  it('maps the RPC 22023 space-unavailable raise to request', () => {
    expect(classifyMarkReadError({ code: '22023' })).toBe('request');
    expect(classifyMarkReadError({ error: { code: '22023' }, data: null })).toBe('request');
    expect(isMarkReadSpaceUnavailable({ code: '22023' })).toBe(true);
    expect(isMarkReadSpaceUnavailable({ error: { code: '22023' }, data: null })).toBe(true);
    expect(isMarkReadSpaceUnavailable({ code: '42501' })).toBe(false);
    expect(isMarkReadSpaceUnavailable({ name: 'AbortError' })).toBe(false);
  });
});

describe('recordChannelLoadDiagnosis', () => {
  it('retains the last classification and warns only the closed codes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    recordChannelLoadDiagnosis({ class: 'schema', op: 'load' });
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'schema', op: 'load' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=schema op=load`);
    recordChannelLoadDiagnosis({ class: 'transport', op: 'poll-tally' });
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'transport', op: 'poll-tally' });
    recordChannelLoadDiagnosis({ class: 'request', op: 'mark_read' });
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'request', op: 'mark_read' });
    expect(warn.mock.calls.flat().join('\n')).not.toContain('message');
    warn.mockRestore();
  });
});

describe('channel action diagnosis ops', () => {
  it('admits send, reaction, and vote as closed operation names', () => {
    expect(CHANNEL_LOAD_OPS).toEqual(['load', 'poll-tally', 'mark_read', 'send', 'reaction', 'vote']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    recordChannelLoadDiagnosis({ class: 'schema', op: 'send' });
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'schema', op: 'send' });
    recordChannelLoadDiagnosis({ class: 'transport', op: 'reaction' });
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'transport', op: 'reaction' });
    recordChannelLoadDiagnosis({ class: 'unknown', op: 'vote' });
    expect(readLastChannelLoadDiagnosis()).toEqual({ class: 'unknown', op: 'vote' });
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=schema op=send`);
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=transport op=reaction`);
    expect(warn).toHaveBeenCalledWith(`${CHANNEL_LOAD_LOG_TAG} class=unknown op=vote`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('message');
    warn.mockRestore();
  });
});
