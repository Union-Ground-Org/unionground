import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({}),
  processLock: vi.fn(),
}));
vi.mock('../lib/config', () => ({
  mobileConfig: {
    backendConfigured: true,
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'publishable-test-key',
  },
}));
vi.mock('../lib/secureSessionStorage', () => ({
  createBackendScopedSessionStorage: () => ({}),
}));

import { isMfaRequiredRpcError, isNotAuthorizedRpcError } from './supabase';

const rpc = (message: string, code = '42501') => ({ code, message });

describe('list_organization_integrations 42501 classification', () => {
  it('keeps MFA on its own surface', () => {
    expect(isMfaRequiredRpcError(rpc('mfa required'))).toBe(true);
    expect(isNotAuthorizedRpcError(rpc('mfa required'))).toBe(false);
  });

  it('classifies every authorization envelope this RPC emits onto the non-retry surface', () => {
    for (const message of [
      'not authorized',
      'authentication required',
      'active organization membership required',
    ]) {
      expect(isNotAuthorizedRpcError(rpc(message)), message).toBe(true);
      expect(isMfaRequiredRpcError(rpc(message)), message).toBe(false);
    }
  });

  it('leaves transient failures retryable', () => {
    expect(isNotAuthorizedRpcError(new Error('network'))).toBe(false);
    expect(isNotAuthorizedRpcError(rpc('backend unavailable', 'PGRST301'))).toBe(false);
    expect(isNotAuthorizedRpcError(rpc('SCIM stays disabled until the enterprise-later gate'))).toBe(false);
  });
});
