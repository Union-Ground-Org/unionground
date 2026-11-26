import { PUBLIC_SITE_ORIGIN } from './publicSite';

// Until Union Ground publishes a website the privacy policy opens only in
// the in-app reader.
export const privacyPolicyUrl: string | null = PUBLIC_SITE_ORIGIN ? `${PUBLIC_SITE_ORIGIN}/privacy` : null;
export const privacyPolicyPath = '/legal/privacy';

// Q19 defect 11: the Account
// control announced itself as "Read privacy policy, button" and pushed the
// in-app reader, leaving the approved public URL a second navigation away. The
// label and hint live here so the screen, the tests and the store-compliance
// row all quote one source for what the shipped control says and where it goes.
export const privacyPolicyLinkLabel = 'Privacy policy';
export const privacyPolicyLinkHint = privacyPolicyUrl
  ? `Opens ${privacyPolicyUrl} in your browser.`
  : 'Opens the privacy policy in the app.';
export const privacyPolicyOpenFailureMessage =
  'Union Ground could not open the privacy policy. Use Read to open the same policy inside the app.';

export type PrivacyPolicyOpenResult =
  | { opened: true }
  | { opened: false; message: string };

export async function openPrivacyPolicy(
  openUrl: (url: string) => Promise<unknown>,
): Promise<void> {
  if (!privacyPolicyUrl) throw new Error('No published privacy policy URL.');
  await openUrl(privacyPolicyUrl);
}

// The screen needs a failure it can render as in-app text: account.tsx
// deliberately avoids Alert.alert, whose OS chrome ignores the forced-light
// theme. This never throws, so a refused or unhandled URL leaves the member on
// a working settings screen with an honest message instead of a silent no-op.
export async function openPrivacyPolicyWithFallback(
  openUrl: (url: string) => Promise<unknown>,
): Promise<PrivacyPolicyOpenResult> {
  try {
    await openPrivacyPolicy(openUrl);
    return { opened: true };
  } catch {
    return { opened: false, message: privacyPolicyOpenFailureMessage };
  }
}
