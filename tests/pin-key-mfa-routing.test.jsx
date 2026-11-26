import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { owesASecondFactor } from '../src/App.jsx';
import { sessionRequiresTotp } from '../apps/mobile/src/lib/authPolicy.ts';

// The Auth response is an isolated transport fixture. These tests prove the
// installed SDK/client routing; the proxy/SQL suites prove server authority.
const user = { id: '10000000-0000-4000-8000-000000000001', factors: [{ id: 'fixture-totp', factor_type: 'totp', status: 'verified' }] };
function token(aal, method, marker) {
  return [btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), btoa(JSON.stringify({ sub: user.id, aal, amr: [{ method }], ug_key_uv: marker, exp: Math.floor(Date.now() / 1000) + 600 })), btoa('fixture-signature')].map(part => part.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')).join('.');
}
describe('installed SDK and both clients honor only server assurance', () => {
  it.each([
    ['verified key', 'aal2', 'passkey', true, false],
    ['key without UV', 'aal1', 'passkey', false, true],
    ['claimed UV at AAL1', 'aal1', 'passkey', true, true],
    ['password', 'aal1', 'password', false, true],
    ['Google', 'aal1', 'oauth', false, true],
    ['existing TOTP', 'aal2', 'totp', false, false],
  ])('%s routes website and app consistently', async (_label, aal, method, marker, codeRequired) => {
    const fetcher = vi.fn(async url => {
      expect(String(url)).toBe('https://key-fixture.invalid/auth/v1/user');
      return new Response(JSON.stringify(user), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = createClient('https://key-fixture.invalid', 'fixture-publishable', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
    });
    const result = await client.auth.mfa.getAuthenticatorAssuranceLevel(token(aal, method, marker));
    expect(result.error).toBeNull();
    expect(result.data.currentLevel).toBe(aal);
    expect(owesASecondFactor(result.data, user)).toBe(codeRequired);
    expect(sessionRequiresTotp(result.data)).toBe(codeRequired);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
