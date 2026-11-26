import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  isNativeDeepLinkProofEnabled,
  measureNativeDeepLinkProbe,
  nativeDeepLinkProofLabel,
  NATIVE_DEEP_LINK_PROOF_BUDGET_MS,
  NATIVE_DEEP_LINK_PROOF_URL,
} from './nativeDeepLinkProof';

describe('physical native malformed-deep-link proof', () => {
  it('wires the exact device URL through Expo Linking and waits for a responsive frame', () => {
    const gate = readFileSync(new URL('../components/NativeDeepLinkProofGate.tsx', import.meta.url), 'utf8');
    const layout = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8');

    expect(gate).toContain('parse: Linking.parse');
    expect(gate).toContain("Linking.addEventListener('url'");
    expect(gate).toContain('Linking.getInitialURL()');
    expect(gate).toContain('requestAnimationFrame');
    expect(gate).toContain('testID="native-deep-link-proof-result"');
    expect(layout).toContain('<NativeDeepLinkProofGate />');
  });

  it('is enabled only by the explicit development-proof build flag', () => {
    expect(isNativeDeepLinkProofEnabled('1')).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes']) {
      expect(isNativeDeepLinkProofEnabled(value)).toBe(false);
    }
  });

  it('keeps ready, pending, responsive, and failure states explicit', () => {
    const measurement = { budgetMs: 25, elapsedMs: 3.25, route: 'messages' as const };
    expect(nativeDeepLinkProofLabel({ status: 'ready' })).toMatch(/ready$/);
    expect(nativeDeepLinkProofLabel({ status: 'failed' })).toMatch(/failed$/);
    expect(nativeDeepLinkProofLabel({ status: 'passed', measurement, responsive: false }))
      .toBe('Native malformed deep-link proof passed in 3.250 ms of 25 ms; responsiveness pending');
    expect(nativeDeepLinkProofLabel({ status: 'passed', measurement, responsive: true }))
      .toBe('Native malformed deep-link proof passed in 3.250 ms of 25 ms; app responsive');
  });

  it('measures the exact supported app scheme through the injected native parser', () => {
    const parse = vi.fn(() => ({
      scheme: 'unionground',
      hostname: 'messages',
      path: null,
      queryParams: { returnTo: '\uFFFD'.repeat(128) },
    }));
    const times = [100, 103.25];
    const result = measureNativeDeepLinkProbe({
      url: NATIVE_DEEP_LINK_PROOF_URL,
      parse,
      now: () => times.shift()!,
    });

    expect(parse).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledWith(NATIVE_DEEP_LINK_PROOF_URL);
    expect(result).toEqual({ budgetMs: 25, elapsedMs: 3.25, route: 'messages' });
    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('query');
  });

  it('ignores every non-proof URL without invoking the parser', () => {
    const parse = vi.fn();
    expect(measureNativeDeepLinkProbe({
      url: 'unionground://messages',
      parse,
      now: () => 0,
    })).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });

  it('fails closed on an unbounded route or a decode at the strict runtime ceiling', () => {
    expect(() => measureNativeDeepLinkProbe({
      url: NATIVE_DEEP_LINK_PROOF_URL,
      parse: () => ({ scheme: 'unionground', hostname: 'messages', queryParams: { returnTo: 'x'.repeat(513) } }),
      now: () => 0,
    })).toThrow(/bounded route/);

    const times = [0, NATIVE_DEEP_LINK_PROOF_BUDGET_MS];
    expect(() => measureNativeDeepLinkProbe({
      url: NATIVE_DEEP_LINK_PROOF_URL,
      parse: () => ({ scheme: 'unionground', hostname: 'messages', queryParams: { returnTo: 'bounded' } }),
      now: () => times.shift()!,
    })).toThrow(/runtime budget/);
  });
});
