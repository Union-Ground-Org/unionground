import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEEP_LINK_CPU_BUDGET_MS,
  isJavaScriptBundleFile,
  MALFORMED_DEEP_LINK_URL,
  verifyMalformedDeepLinkBudget,
} from '../../scripts/verify-malformed-deep-link-budget.mjs';

type PackageManifest = { overrides: Record<string, string>; scripts: Record<string, string> };
type PackageLock = { packages: Record<string, { version: string }> };
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as PackageManifest;
const packageLock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as PackageLock;

describe('native malformed-percent deep-link CPU boundary', () => {
  it('recognizes both plain JavaScript and Expo Hermes bundle artifacts', () => {
    expect(isJavaScriptBundleFile('_expo/static/js/ios/entry.js')).toBe(true);
    expect(isJavaScriptBundleFile('_expo/static/js/ios/entry.hbc')).toBe(true);
    expect(isJavaScriptBundleFile('metadata.json')).toBe(false);
  });

  it('locks the Expo Router query decoder to advisory-fixed versions and both audit modes', () => {
    expect(packageJson.overrides['query-string']).toBe('9.5.1');
    expect(packageLock.packages['node_modules/query-string']?.version).toBe('9.5.1');
    // GHSA-qr28-fpjm-wq7f (October 29, 2026): 0.5.0's percent-run decoding is
    // quadratic; 0.5.1 is the first patched release and is pinned by override.
    expect(packageJson.overrides['decode-uri-component']).toBe('0.5.1');
    expect(packageLock.packages['node_modules/decode-uri-component']?.version).toBe('0.5.1');
    // Both audit modes still run, now through the exception-aware wrapper.
    expect(packageJson.scripts['security:audit']).toBe('node scripts/security-audit.mjs');
    const auditScript = readFileSync(new URL('../../scripts/security-audit.mjs', import.meta.url), 'utf8');
    expect(auditScript).toContain("['full', []]");
    expect(auditScript).toContain("['production', ['--omit=dev']]");
    expect(auditScript).toContain('delete env.npm_config_allow_scripts');
    expect(packageJson.scripts['deep-link:budget']).toContain('--platform ios');
    expect(packageJson.scripts['deep-link:budget']).toContain('--platform android');
    expect(MALFORMED_DEEP_LINK_URL).toMatch(/^unionground:\/\/messages\?returnTo=/);
  });

  it.each(['ios', 'android'])('%s parser stays inside the strict CPU budget', (platform) => {
    const result = verifyMalformedDeepLinkBudget({ platform });
    expect(result.platform).toBe(platform);
    expect(result.cpuMs).toBeLessThan(DEEP_LINK_CPU_BUDGET_MS);
  });
});
