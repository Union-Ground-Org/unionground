import { describe, expect, it, vi } from 'vitest';

// Pins the shipped, empty trust table rather than the suite's fictional pairs.
vi.unmock('../../../../src/lib/trustedBackends.js');

vi.mock('./config', () => ({ mobileConfig: { portalBaseUrl: 'https://unionground.invalid', supabaseUrl: null, backendConfigured: false } }));

import { resolveMfaRecoveryApiOrigin, resolvePortalApiOrigin } from './portalApiOrigin';

describe('resolvePortalApiOrigin', () => {
  it('refuses every portal while no Union Ground backend is provisioned', () => {
    expect(() => resolvePortalApiOrigin()).toThrow('Portal origin is not trusted.');
    expect(() => resolveMfaRecoveryApiOrigin()).toThrow('Portal origin is not trusted.');
  });

  it('never sends a token to a sibling product or a manifest-chosen host', () => {
    for (const [supabaseUrl, portalBaseUrl] of <Array<[string, string]>>[
      ['https://unionground-sample.supabase.co', 'https://sibling-product.example'],
      ['https://productionprojectref.supabase.co', 'https://sibling-saas.example'],
      ['https://example.supabase.co', 'https://evil.example'],
    ]) {
      expect(() => resolvePortalApiOrigin({ backendConfigured: true, supabaseUrl, portalBaseUrl }))
        .toThrow('Portal origin is not trusted.');
    }
  });

  it('rejects malformed portal origins before any trust decision', () => {
    expect(() => resolvePortalApiOrigin({ backendConfigured: true, supabaseUrl: null, portalBaseUrl: 'not a url' }))
      .toThrow('Portal origin is invalid.');
  });
});
