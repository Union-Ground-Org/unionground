import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-NATIVE-MEMBER-PROFILE-RPC-AND-GRANT-REVOKE-20261104 (#7032,
// part 1): native member profile writes go through update_my_member_profile,
// the journalled RPC web uses since #7026, so the direct column UPDATE grant
// can be revoked once a native release carrying this is live.
const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'http://localhost', supabasePublishableKey: 'test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));

import { updateMemberProfile } from './supabase';

type Query = Record<string, ReturnType<typeof vi.fn>> & { then?: unknown };
let queries: Query[] = [];
let row: Record<string, unknown> = {};

beforeEach(() => {
  queries = [];
  row = { id: 'member-1', first_name: 'Ana', full_name: 'Ana Fictional', initials: 'AF', role_line: 'Worker', member_since: 2020, chapter_id: 'chapter-1', language: 'en' };
  backend.rpc.mockReset().mockImplementation(async (_name: string, args: { p_fields: Record<string, unknown> }) => {
    row = { ...row, ...args.p_fields };
    return { data: { updated: true }, error: null };
  });
  backend.from.mockReset().mockImplementation(() => {
    const q: Query = {};
    for (const key of ['select', 'update', 'upsert', 'eq', 'maybeSingle']) q[key] = vi.fn(() => q);
    q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: row, error: null }).then(resolve);
    queries.push(q);
    return q;
  });
});

describe('native worker profile writes', () => {
  it('saves names and language through update_my_member_profile for the account the screen was opened for, then reads the row back', async () => {
    const profile = await updateMemberProfile('member-1', { firstName: ' Bea ', fullName: ' Bea Example ', language: 'es' });

    expect(backend.rpc).toHaveBeenCalledTimes(1);
    expect(backend.rpc).toHaveBeenCalledWith('update_my_member_profile', {
      p_expected_user_id: 'member-1',
      p_fields: { first_name: 'Bea', full_name: 'Bea Example', initials: 'BE', language: 'es' },
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.update).not.toHaveBeenCalled();
    expect(queries[0]!.upsert).not.toHaveBeenCalled();
    expect(queries[0]!.eq).toHaveBeenCalledWith('id', 'member-1');
    expect(profile).toMatchObject({ id: 'member-1', firstName: 'Bea', fullName: 'Bea Example', initials: 'BE', roleLine: 'Worker', language: 'es' });
  });

  it('surfaces a refused save and does not report stale values as saved', async () => {
    const refusal = { code: '42501', message: 'this form belongs to another account' };
    backend.rpc.mockResolvedValueOnce({ data: null, error: refusal });

    await expect(updateMemberProfile('member-1', { firstName: 'Bea', fullName: 'Bea Example', language: 'en' })).rejects.toBe(refusal);
    expect(queries).toHaveLength(0);
  });

  it('checks the names before calling the server', async () => {
    await expect(updateMemberProfile('member-1', { firstName: ' ', fullName: 'Bea Example', language: 'en' })).rejects.toThrow('Enter a valid preferred and full name.');
    expect(backend.rpc).not.toHaveBeenCalled();
  });

  it('leaves no direct member_profiles write anywhere in the native app', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(root, 'app'));
    walk(join(root, 'src'));
    expect(files.length).toBeGreaterThan(50);
    const direct = /from\(\s*['"]member_profiles['"]\s*\)[^;]*?\.(update|upsert|insert|delete)\(/;
    const offenders = files.filter((path) => direct.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
    const callers = files.filter((path) => readFileSync(path, 'utf8').includes("rpc('update_my_member_profile'"));
    expect(callers.map((path) => path.slice(root.length)).sort()).toEqual(['src/services/stewardPulse.ts', 'src/services/supabase.ts']);
  });
});
