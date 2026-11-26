import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { channelLoadNeedsSupport, messageInboxCopy } from './messageInboxCopy';
import {
  openSupportEmail,
  openSupportEmailWithFallback,
  supportAccountBody,
  supportEmail,
  supportEmailUrl,
  supportLinkCopy,
  supportMfaBody,
  supportSignInBody,
} from './supportContact';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const accountScreen = read('../../app/(tabs)/account.tsx');
const signInScreen = read('../../app/sign-in.tsx');
const mfaScreen = read('../../app/mfa-challenge.tsx');
const messagesScreen = read('../../app/messages.tsx');
const deletionFeature = read('../features/NativeAccountDeletion.tsx');
const supportLink = read('../components/SupportLink.tsx');

// The signed-in app's Help and support entry. The support address is Union
// Ground's own mailbox, never a union; this edition publishes none yet, so the
// mailbox cases run once one is added and the no-mailbox cases run until then.
describe.skipIf(supportEmail === null)('support contact', () => {
  it('opens a new email to the Union Ground support mailbox', async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);

    await openSupportEmail(openUrl);

    expect(supportEmail).toBe('support@unionground.example');
    expect(supportEmailUrl).toBe('mailto:support@unionground.example');
    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith('mailto:support@unionground.example');
  });

  it('reports success without changing the destination', async () => {
    const openUrl = vi.fn().mockResolvedValue(true);

    await expect(openSupportEmailWithFallback(openUrl)).resolves.toEqual({ opened: true });
    expect(openUrl).toHaveBeenCalledWith(supportEmailUrl);
  });

  it('returns an in-app message that keeps the address readable when no mail app opens', async () => {
    const openUrl = vi.fn().mockRejectedValue(new Error('No Activity found to handle Intent'));

    await expect(openSupportEmailWithFallback(openUrl)).resolves.toEqual({
      opened: false,
      message: supportLinkCopy.en.openFailure,
    });
    await expect(openSupportEmailWithFallback(openUrl, 'es')).resolves.toEqual({
      opened: false,
      message: supportLinkCopy.es.openFailure,
    });
    for (const copy of Object.values(supportLinkCopy)) {
      expect(copy.openFailure).toContain(supportEmail);
      expect(copy.hint).toContain(supportEmail);
      expect(copy.label.length).toBeGreaterThan(0);
    }
  });

  it('names the address in every screen body so a phone with no mail app still shows it', () => {
    for (const body of [supportAccountBody, supportSignInBody, supportMfaBody]) {
      expect(body).toContain(supportEmail);
    }
  });
});

describe.skipIf(supportEmail !== null)('support contact with no published mailbox', () => {
  it('names no address and sends no one to an invented mailbox', async () => {
    expect(supportEmailUrl).toBeNull();
    await expect(openSupportEmail(vi.fn())).rejects.toThrow('No support mailbox is published.');
    expect(supportAccountBody).toBe('No support mailbox is published yet. Campaign questions go to the committee in Messages.');
    expect(supportSignInBody).toBe('Trouble signing in or with an invitation? Ask the person who invited you.');
    expect(supportMfaBody).toBe('Cannot reach them? Ask the person who invited you.');
    for (const body of [supportAccountBody, supportSignInBody, supportMfaBody]) expect(body).not.toContain('@');
  });
});

describe('SupportLink control', () => {
  it('is a link with the copy label as its spoken name and a 48 pt target', () => {
    expect(supportLink).toContain('accessibilityRole="link"');
    expect(supportLink).toContain('accessibilityLabel={copy.label}');
    expect(supportLink).toContain('accessibilityHint={copy.hint}');
    expect(supportLink).toContain('minHeight: minimumTouchTarget');
    expect(supportLink).toContain('accessibilityState={{ busy, disabled: busy }}');
  });

  it('opens the mailbox through the fallback helper and renders the failure in-app', () => {
    expect(supportLink).toContain('openSupportEmailWithFallback((url) => Linking.openURL(url), language)');
    expect(supportLink).toContain('{failure ? <Notice>{failure}</Notice> : null}');
    expect(supportLink).not.toContain('Alert.alert');
  });
});

describe('Help and support placement', () => {
  it('sits at the top of the Account privacy block, above the privacy-policy link', () => {
    const helpRow = accountScreen.indexOf('<SupportLink language={language} description={catalogLabel(supportAccountBody)} />');
    const privacyLink = accountScreen.indexOf('accessibilityLabel={privacyPolicyLinkLabel}');
    const deletion = accountScreen.indexOf('<NativeAccountDeletion />');
    expect(helpRow).toBeGreaterThan(-1);
    expect(privacyLink).toBeGreaterThan(helpRow);
    expect(deletion).toBeGreaterThan(privacyLink);
    expect(accountScreen).toContain("import { SupportLink } from '../../src/components/SupportLink';");
  });

  // Sign-in and the MFA screen carry the link once a mailbox is published.
  it.skipIf(supportEmail === null)('is offered on sign-in and on the MFA screen', () => {
    // On sign-in the link sits in the footer's second row of links, beside
    // public downloads, and its sentence opens the footer's fine print (build
    // c proof, Nov 6, 2026; two centred rows,, Nov 7, 2026).
    expect(signInScreen).toContain('<SupportLink variant="footer" maxFontSizeMultiplier={FORM_TEXT_CAP} />');
    expect(signInScreen).toContain('<Text allowFontScaling={false} lineBreakStrategyIOS="standard" style={finePrintStyle}>{supportSignInBody}</Text>');
    expect(mfaScreen).toContain('<SupportLink description={supportMfaBody} />');
  });

  it('tells a worker with no authenticator or saved code who resets two-step, in plain words', () => {
    expect(mfaScreen).toContain('Your campaign administrator can reset your two-step sign-in. Ask them directly.');
    expect(mfaScreen).not.toMatch(/local office|reset the factor/i);
    expect(supportMfaBody).not.toMatch(/local office|factor/i);
    expect(supportMfaBody).toContain(supportEmail === null ? 'Ask the person who invited you.' : 'put you in touch');
  });

  it('follows the account-deletion indeterminate notice that used to say "contact support"', () => {
    expect(deletionFeature).toContain("<SupportLink language={language} />");
    expect(deletionFeature).not.toContain('or contact support.');
    expect(deletionFeature).toContain('use Help and support below.');
  });
});

describe('campaign channel load copy', () => {
  it('names the link instead of a bare "contact support" in both locales', () => {
    for (const copy of Object.values(messageInboxCopy)) {
      for (const text of Object.values(copy.channelError)) {
        expect(text).not.toMatch(/contact support|contacta a soporte/i);
      }
    }
    expect(messageInboxCopy.en.channelError.request).toContain(supportLinkCopy.en.label);
    expect(messageInboxCopy.en.channelError.schema).toContain(supportLinkCopy.en.label);
    expect(messageInboxCopy.es.channelError.request).toContain(supportLinkCopy.es.label);
    expect(messageInboxCopy.es.channelError.schema).toContain(supportLinkCopy.es.label);
  });

  it.skipIf(supportEmail === null)('shows the link under exactly the faults whose copy names it', () => {
    expect(channelLoadNeedsSupport('request')).toBe(true);
    expect(channelLoadNeedsSupport('schema')).toBe(true);
    expect(channelLoadNeedsSupport('authentication')).toBe(false);
    expect(channelLoadNeedsSupport('transport')).toBe(false);
    expect(channelLoadNeedsSupport('unknown')).toBe(false);
    expect(channelLoadNeedsSupport(null)).toBe(false);
    expect(messagesScreen).toContain('channelLoadNeedsSupport(store.loadFault())');
    expect(messagesScreen).toContain('{channelsNeedSupport ? <SupportLink language={language} /> : null}');
  });
});
