import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import * as privacyPolicyModule from './privacyPolicy';

type OpenPrivacyPolicy = (openUrl: (url: string) => Promise<unknown>) => Promise<void>;

const openPrivacyPolicy = (privacyPolicyModule as { openPrivacyPolicy?: OpenPrivacyPolicy })
  .openPrivacyPolicy;

const accountScreen = readFileSync(
  fileURLToPath(new URL('../../app/(tabs)/account.tsx', import.meta.url)),
  'utf8',
);

describe('unpublished Union Ground site', () => {
  it('has no public policy URL and never opens a browser', async () => {
    expect(privacyPolicyModule.privacyPolicyUrl).toBeNull();
    expect(privacyPolicyModule.privacyPolicyPath).toBe('/legal/privacy');
    const openUrl = vi.fn().mockResolvedValue(undefined);
    await expect(openPrivacyPolicy?.(openUrl)).rejects.toThrow();
    expect(openUrl).not.toHaveBeenCalled();
    await expect(privacyPolicyModule.openPrivacyPolicyWithFallback(openUrl)).resolves.toEqual({
      opened: false,
      message: privacyPolicyModule.privacyPolicyOpenFailureMessage,
    });
    // The recovery it names must be the control the screen actually still ships.
    expect(privacyPolicyModule.privacyPolicyOpenFailureMessage).toContain('Read');
    expect(privacyPolicyModule.privacyPolicyLinkHint).toBe('Opens the privacy policy in the app.');
  });
});

describe('published Union Ground site', () => {
  it('opens exactly the published policy, and reports a refusal in the app', async () => {
    vi.resetModules();
    vi.doMock('./publicSite', () => ({ PUBLIC_SITE_ORIGIN: 'https://app.unionground.example' }));
    const published = await import('./privacyPolicy');
    const openUrl = vi.fn().mockResolvedValue(true);
    await expect(published.openPrivacyPolicyWithFallback(openUrl)).resolves.toEqual({ opened: true });
    expect(openUrl).toHaveBeenCalledWith('https://app.unionground.example/privacy');
    expect(published.privacyPolicyLinkHint).toContain('https://app.unionground.example/privacy');
    const refused = vi.fn().mockRejectedValue(new Error('no activity found to handle intent'));
    await expect(published.openPrivacyPolicyWithFallback(refused)).resolves.toEqual({
      opened: false,
      message: published.privacyPolicyOpenFailureMessage,
    });
    vi.doUnmock('./publicSite');
  });
});

// A11Y-UG-MOBILE-VOICEOVER-ACCOUNT-PRIVACY-POLICY-LINK-20260913, Q19
// defect 11. The device pass found "Read privacy policy, button" leading to the
// in-app reader, with the approved URL a second navigation away.
describe('Account privacy-policy control (Q19 defect 11)', () => {
  it('announces a link, not a button', () => {
    expect(accountScreen).toContain('accessibilityRole="link"');
    expect(accountScreen).toContain('accessibilityLabel={privacyPolicyLinkLabel}');
    expect(privacyPolicyModule.privacyPolicyLinkLabel).toBe('Privacy policy');
    // The old two-step button label must not come back on this screen.
    expect(accountScreen).not.toContain('accessibilityLabel="Read privacy policy"');
  });

  it('reaches the published URL in one step once a site exists', () => {
    expect(accountScreen).toContain('openPrivacyPolicyWithFallback');
    expect(accountScreen).toContain('Linking.openURL(url)');
    expect(accountScreen).toContain('{privacyPolicyUrl ? (');
    // The link's own press handler must not route through the in-app reader.
    const linkStart = accountScreen.indexOf('accessibilityRole="link"');
    expect(linkStart).toBeGreaterThan(-1);
    const link = accountScreen.slice(linkStart, accountScreen.indexOf('</Pressable>', linkStart));
    expect(link).toContain('openApprovedPrivacyPolicy');
    expect(link).not.toContain("router.push('/legal/privacy'");
  });

  it('keeps the disabled and busy states honest while the browser is opening', () => {
    expect(accountScreen).toContain('accessibilityState={{ busy: privacyLinkBusy, disabled: privacyLinkBusy }}');
    expect(accountScreen).toContain('disabled={privacyLinkBusy}');
    expect(accountScreen).toContain('{privacyLinkError ? <Notice>{privacyLinkError}</Notice> : null}');
  });

  it('keeps the in-app reader as a distinctly labelled secondary control', () => {
    expect(accountScreen).toContain("accessibilityLabel={t(\"Read the privacy policy inside the app\")}");
    expect(accountScreen).toContain("router.push('/legal/privacy' as never)");
    // One "Privacy policy" accessible name per row: the secondary button must
    // not repeat the link's label.
    expect(accountScreen).not.toContain('accessibilityLabel="Privacy policy"');
  });
});
