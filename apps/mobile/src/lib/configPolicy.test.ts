import { describe, expect, it, vi } from 'vitest';

// Pins the shipped, empty trust table rather than the suite's fictional pairs.
vi.unmock('../../../../src/lib/trustedBackends.js');

import { isApprovedBackend, parseMobileConfig, UNIONGROUND_UNPROVISIONED_PORTAL_ORIGIN, trustedPortalForBackend } from './configPolicy';

describe('mobile configuration', () => {
  it('fails closed for placeholders', () => {
    expect(parseMobileConfig({
      supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
      supabasePublishableKey: 'sb_publishable_REPLACE_ME',
    }).backendConfigured).toBe(false);
  });

  it('rejects insecure backend URLs', () => {
    expect(parseMobileConfig({
      supabaseUrl: 'http://example.supabase.co',
      supabasePublishableKey: 'sb_publishable_example',
    }).backendConfigured).toBe(false);
  });

  it('rejects non-origin backend URLs and case-normalized placeholders', () => {
    expect(parseMobileConfig({
      supabaseUrl: 'https://example.supabase.co/rest/v1',
      supabasePublishableKey: 'sb_publishable_example',
    }).backendConfigured).toBe(false);
    expect(parseMobileConfig({
      supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
      supabasePublishableKey: 'sb_publishable_example',
    }).backendConfigured).toBe(false);
  });

  it('admits no backend while Union Ground has no provisioned project', () => {
    // Sibling-product projects, including the shared SAMPLE one, are refused.
    for (const supabaseUrl of [
      'https://unionground-sample.supabase.co',
      'https://productionprojectref.supabase.co',
      'https://example.supabase.co',
    ]) {
      const config = parseMobileConfig({ supabaseUrl, supabasePublishableKey: 'sb_publishable_example', compassNetworkEnabled: true });
      expect(config.supabaseUrl).toBeNull();
      expect(config.backendConfigured).toBe(false);
      expect(config.compassNetworkEnabled).toBe(false);
      expect(isApprovedBackend(config)).toBe(false);
      expect(trustedPortalForBackend(supabaseUrl)).toBeNull();
    }
  });

  it('keeps networked Guide disabled unless source config explicitly enables it for a valid backend', () => {
    expect(parseMobileConfig({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'sb_publishable_example',
    }).compassNetworkEnabled).toBe(false);
    expect(parseMobileConfig({ compassNetworkEnabled: true }).compassNetworkEnabled).toBe(false);
  });

  it('never accepts an untrusted portal origin for bearer-token requests', () => {
    expect(parseMobileConfig({ portalBaseUrl: 'https://attacker.example' }).portalBaseUrl).toBe(UNIONGROUND_UNPROVISIONED_PORTAL_ORIGIN);
    expect(parseMobileConfig({ portalBaseUrl: 'https://sibling-saas.example' }).portalBaseUrl).toBe(UNIONGROUND_UNPROVISIONED_PORTAL_ORIGIN);
    // The placeholder can never resolve: .invalid is reserved (RFC 2606).
    expect(new URL(UNIONGROUND_UNPROVISIONED_PORTAL_ORIGIN).hostname.endsWith('.invalid')).toBe(true);
  });

  it('fails closed when a privileged Supabase credential is placed in mobile config', () => {
    expect(parseMobileConfig({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'sb_secret_service-role-value',
    }).backendConfigured).toBe(false);
    expect(parseMobileConfig({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'service_role.jwt.value',
    }).backendConfigured).toBe(false);
    expect(parseMobileConfig({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'eyJhbGciOiJIUzI1NiJ9.legacy-service-role.jwt',
    }).backendConfigured).toBe(false);
  });

  it('keeps the trusted backend table free of prototype keys', () => {
    expect(trustedPortalForBackend('__proto__')).toBeNull();
    expect(trustedPortalForBackend('constructor')).toBeNull();
    expect(trustedPortalForBackend(null)).toBeNull();
  });
});
