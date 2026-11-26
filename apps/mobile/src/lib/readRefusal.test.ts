import { describe, expect, it } from 'vitest';
import { isAuthoritativeReadRefusal, isReadRefusal } from './readRefusal';

// BUG-UG-NATIVE-CONVERSATION-REFRESH-FAILURE-HIDES-LOADED-MESSAGES-20261115
//: every field a wrapper can move a
// refusal code into.
const wrapped = (code: string, options: { sqlState?: string | null; cause?: unknown } = {}) =>
  Object.assign(new Error(code), { name: 'ConnectedWorkflowError', code, sqlState: options.sqlState ?? null, ...(options.cause === undefined ? {} : { cause: options.cause }) });

describe('isReadRefusal', () => {
  it('reads permission errors, refused tokens and refused sessions as refusals', () => {
    for (const error of [
      { code: '42501', message: 'permission denied for table member_messages' },
      { code: 'PGRST301', message: 'JWT expired' }, { code: 'PGRST302' }, { code: 'PGRST303' },
      { sqlState: '42501' }, { status: 401 }, { status: 403 },
    ]) expect(isReadRefusal(error), JSON.stringify(error)).toBe(true);
  });
  it('reads the connected-workflow facade shapes as refusals', () => {
    for (const error of [
      wrapped('not_authorized', { sqlState: '42501' }),
      // An expired or invalid token: the facade has no name for it, so the
      // code is "unavailable" and the raw code stays in sqlState.
      wrapped('unavailable', { sqlState: 'PGRST301' }),
      wrapped('unavailable', { sqlState: 'PGRST303' }),
      wrapped('unavailable', { cause: { code: 'PGRST301', message: 'JWT expired' } }),
      wrapped('network', { cause: { status: 401 } }),
      wrapped('scope_changed'), wrapped('source_unavailable'), wrapped('source_removed'),
      { code: 'P0001', details: 'cw:not_authorized', message: 'authentication required' },
      { code: 'P0001', message: 'cw:scope_changed' },
    ]) expect(isReadRefusal(error), JSON.stringify(error)).toBe(true);
  });
  it('keeps transport failures, deadlines and other errors as ordinary failures', () => {
    for (const error of [null, undefined, 'offline', new Error('fetch failed'), Object.assign(new Error('Read timed out'), { name: 'TimeoutError' }),
      { code: 'network' }, { code: 'PGRST000' }, { code: '57014' }, { status: 500 }, { status: 503 },
      wrapped('network', { cause: new TypeError('Network request failed') }), wrapped('unavailable', { sqlState: '57014' }),
      wrapped('rate_limited', { sqlState: '54000' }), { code: 'P0001', details: 'cw:rate_limited' }]) {
      expect(isReadRefusal(error), JSON.stringify(error)).toBe(false);
    }
  });
  it('stops at a bounded depth of wrapped causes', () => {
    let error: unknown = { code: '42501' };
    for (let index = 0; index < 6; index += 1) error = { cause: error };
    expect(isReadRefusal(error)).toBe(false);
  });
  it('conceals refreshable token failures without authoritatively retiring unsent work', () => {
    for (const error of [{ code: 'PGRST301' }, { code: 'PGRST302' }, { code: 'PGRST303' }, { status: 401 },
      wrapped('unavailable', { sqlState: 'PGRST301' }), wrapped('unavailable', { cause: { code: 'PGRST303' } }),
      wrapped('network', { cause: { status: 401 } })]) {
      expect(isReadRefusal(error), JSON.stringify(error)).toBe(true);
      expect(isAuthoritativeReadRefusal(error), JSON.stringify(error)).toBe(false);
    }
  });
  it('retires only authoritative permission/item refusals, including wrapped and mixed responses', () => {
    for (const error of [{ code: '42501' }, { status: 403 }, { code: 'PGRST301', cause: { status: 403 } },
      wrapped('not_authorized', { sqlState: '42501' }), wrapped('scope_changed'), wrapped('source_unavailable'), wrapped('source_removed'),
      { code: 'P0001', details: 'cw:not_authorized' }, { message: 'cw:source_removed' }]) {
      expect(isAuthoritativeReadRefusal(error), JSON.stringify(error)).toBe(true);
    }
    expect(isAuthoritativeReadRefusal(new TypeError('Network request failed'))).toBe(false);
    expect(isAuthoritativeReadRefusal({ cause: { cause: { cause: { cause: { code: '42501' } } } } })).toBe(false);
  });
});
