// @vitest-environment jsdom
import { act, createElement as h, Fragment, StrictMode, type PropsWithChildren, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY, EmailAuthScreen, RECOVERY_CODE_MAX_LENGTH, RECOVERY_CODE_MIN_LENGTH } from './EmailAuthScreen';
import type { acceptEmailInvitation, beginEmailPasswordReset, finishEmailPasswordReset, passwordResetRequestAvailable } from '../services/emailAuth';
import { legalAcceptanceLinks, legalAcceptanceVersions } from '../lib/legalAcceptance';
import { LEGAL_SITE_ORIGIN } from '../lib/legalDocuments';
import type { EmailAuthLink } from '../lib/emailAuth';
import { NEW_PASSWORD_MAX, NEW_PASSWORD_MIN, NEW_PASSWORD_TOO_LONG, NEW_PASSWORD_TOO_SHORT } from '../../../../src/lib/passwordPolicy.js';
import { resetEnrollmentFixture } from '../../../../tests/helpers/resetEnrollmentFixture.js';

// Mobile CI has no server telemetry packages; keep only these external sink fakes.
vi.mock('../../../../api/_lib/observability.js', () => ({ captureServerFailure: () => false }));
vi.mock('../../../../api/_lib/accountMailAlerts.js', () => ({ recordAccountMailFailure: () => null }));
// The real reset handler accepts only an approved backend: the app's fictional
// pairs (src/test/setup.ts) plus the reset fixture's project and portal.
vi.mock('../../../../src/lib/trustedBackends.js', async () => {
  const { TEST_BACKENDS } = await import('../test/backends');
  const { PORTAL_ORIGIN, SUPABASE_ORIGIN } = await import('../../../../tests/helpers/fictional-provider.js');
  const table: Readonly<Record<string, string>> = Object.freeze({
    [TEST_BACKENDS.sample.supabaseUrl]: TEST_BACKENDS.sample.portal,
    [TEST_BACKENDS.live.supabaseUrl]: TEST_BACKENDS.live.portal,
    [SUPABASE_ORIGIN]: PORTAL_ORIGIN,
  });
  return { TRUSTED_BACKEND_PORTALS: table, isTrustedPortalOrigin: (origin: unknown) => Object.values(table).includes(origin as string) };
});

vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://unionground-live.supabase.co', portalBaseUrl: 'https://app.unionground.example' } }));

const api = vi.hoisted(() => ({
  acceptEmailInvitation: vi.fn<typeof acceptEmailInvitation>(),
  beginEmailPasswordReset: vi.fn<typeof beginEmailPasswordReset>(),
  finishEmailPasswordReset: vi.fn<typeof finishEmailPasswordReset>(),
  passwordResetRequestAvailable: vi.fn<typeof passwordResetRequestAvailable>(),
}));
const openURL = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>());
const push = vi.hoisted(() => vi.fn<(path: string) => void>());
const locale = vi.hoisted(() => ({ language: 'en' }));
// The shared Button's own press handler, by label, so a test can call it as a
// stray press would; and the app's announcement queue .
const presses = vi.hoisted(() => new Map<string, () => void>());
const announced = vi.hoisted(() => vi.fn<(message: string) => () => void>());
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => announced }));
vi.mock('../services/emailAuth', () => api);
// The keystore-backed pending reset, as an in-memory slot.
type PendingRecord = { ticket: string; status: 'challenge' | 'enroll'; state: string; secret: string; account?: string };
// Opaque account tags as api/_lib/passwordReset.js resetAccountTag writes them.
const ACCOUNT_A = `a1.${'A'.repeat(22)}`;
const pending = vi.hoisted((): { record: PendingRecord | null } => ({ record: null }));
// Exercise the real pending-slot and begin queues; only native storage is fake.
vi.mock('../lib/secureSessionStorage', () => ({ secureSessionStorage: {
  getItem: async (): Promise<string | null> => pending.record
    ? JSON.stringify({ ...pending.record, expiresAt: Date.now() + 900_000 }) : null,
  setItem: async (_key: string, value: string): Promise<void> => {
    const { ticket, status, state, secret, account } = JSON.parse(value) as PendingRecord;
    pending.record = { ticket, status, state, secret, ...(account ? { account } : {}) };
  },
  removeItem: async (): Promise<void> => { pending.record = null; },
} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));
// The in-app reset request has its own suite; here only its presence matters.
vi.mock('./PasswordResetRequest', () => ({ PasswordResetRequest: ({ onBack }: { onBack: (email: string) => void }) =>
  h('form', { 'data-testid': 'password-reset-request' }, h('button', { 'data-testid': 'password-reset-back', onClick: () => onBack('') }, 'Back to sign in')) }));
// REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016: the store's age signal,
// per case. `null` is a build without the native module (web, Expo Go).
const store = vi.hoisted(() => ({
  module: null as { requestAgeSignalAsync: () => Promise<unknown> } | null,
  request: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('../../modules/store-age-signal/src/StoreAgeSignalModule', () => ({ get default() { return store.module; } }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: locale.language }) }));
// The shared Help and support control has its own suite; here its presence, language and words matter.
vi.mock('./SupportLink', () => ({ SupportLink: ({ language, description }: { language: string; description: string }) =>
  h('a', { role: 'link', 'data-testid': 'support-link', 'data-language': language, href: 'mailto:support@unionground.example' }, description) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ foreground: '#111', border: '#333', card: '#fff', primary: '#111' }) }));
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Linking: { openURL },
  Pressable: ({ children, accessibilityRole, accessibilityLabel, accessibilityState, disabled, onPress }: PropsWithChildren<{
    accessibilityRole: string; accessibilityLabel: string; accessibilityState?: { checked?: boolean }; disabled?: boolean; onPress: () => void;
  }>) => h('button', { role: accessibilityRole, 'aria-label': accessibilityLabel,
    'aria-checked': accessibilityState?.checked, disabled, onClick: onPress }, children),
  View: ({ children }: PropsWithChildren) => h('div', null, children),
  Modal: ({ children, visible }: PropsWithChildren<{ visible: boolean }>) => (visible ? h('div', { role: 'dialog' }, children) : null),
  FlatList: ({ data, renderItem, keyExtractor }: {
    data: readonly { code: string }[]; renderItem: (info: { item: { code: string } }) => ReactNode; keyExtractor: (item: { code: string }) => string;
  }) => h('div', null, data.map((item) => h(Fragment, { key: keyExtractor(item) }, renderItem({ item })))),
  Text: ({ children }: PropsWithChildren) => h('p', null, children),
  ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel: string }) => h('span', { role: 'status' }, accessibilityLabel),
  TextInput: ({ accessibilityLabel, accessibilityHint, value, onChangeText, secureTextEntry, editable }: {
    accessibilityLabel: string; accessibilityHint?: string; value: string; onChangeText: (value: string) => void; secureTextEntry?: boolean; editable?: boolean;
  }) => h('input', { 'aria-label': accessibilityLabel, 'aria-description': accessibilityHint, value, disabled: editable === false, type: secureTextEntry ? 'password' : 'text',
    onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
}));
vi.mock('./ui', () => ({
  Screen: ({ children, nativeHeaderHeight }: PropsWithChildren<{ nativeHeaderHeight?: number }>) =>
    h('main', { 'data-native-header-height': nativeHeaderHeight }, children),
  Body: ({ children }: PropsWithChildren) => h('p', null, children),
  Heading: ({ children }: PropsWithChildren) => h('h1', null, children),
  Button: ({ label, onPress, disabled, disabledReason, busy }: { label: string; onPress: () => void; disabled?: boolean; disabledReason?: string; busy?: boolean }) => {
    presses.set(label, onPress);
    return h('button', { disabled: disabled || busy, 'data-disabled-reason': disabledReason || undefined, onClick: onPress }, label);
  },
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.resetAllMocks();
  pending.record = null;
  locale.language = 'en';
  openURL.mockResolvedValue(undefined);
  store.request.mockReset();
  store.module = { requestAgeSignalAsync: store.request };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const resume: EmailAuthLink = { kind: 'passwordResume', token: '' };
const invite = { kind: 'invitation' as const, token: 'A'.repeat(43) };
const reset = { kind: 'passwordReset' as const, token: `t1.${'A'.repeat(16)}.${'B'.repeat(64)}` };
async function render(link: EmailAuthLink | null, onRequestNewLink?: () => void) {
  await act(async () => root.render(h(StrictMode, null, h(EmailAuthScreen, { link, onSignIn: () => undefined, onRequestNewLink }))));
}
const buttonNamed = (label: string) => [...container.querySelectorAll('button')].find((button) => button.textContent === label);
async function input(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!field) throw new Error(`Missing field ${label}`);
  await act(async () => { field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); });
}
// A state first, then both boxes, the
// terms and the age attestation that state selects.
async function chooseState(name: string) {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="State where you live"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${name}"]`)!.click());
}
async function accept(state = 'Texas') {
  await chooseState(state);
  for (const box of container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')) {
    await act(async () => box.click());
  }
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept and continue')!.click());
}

describe('native secure email screen', () => {
  it.each([invite, reset])('hands the retained native header height to the $kind screen', async (link) => {
    // BUG-UG-NATIVE-INVITE-HEADING-UNDER-BACK-ARROW-20261102: the
    // heading-first screen clears the header auth/callback keeps over it.
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'link-invalid' });
    await act(async () => root.render(h(EmailAuthScreen, { link, onSignIn: () => undefined, nativeHeaderHeight: 108 })));
    expect(container.querySelector('main')?.getAttribute('data-native-header-height')).toBe('108');
  });

  //  (M1-2): Accept and continue names the first unmet part in screen
  // order, a stray press submits nothing, and a state change that clears the
  // checked age box says so, through the announcement queue, until it is
  // checked again.
  it('hands Accept and continue the first missing part and says when a new state clears the age box', async () => {
    announced.mockReturnValue(() => {});
    await render(invite);
    const reason = () => buttonNamed('Accept and continue')?.getAttribute('data-disabled-reason');
    const recheck = 'Check the age statement again for the state you chose.';
    const ageBox = () => [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].at(-1)!;
    expect(reason()).toBe('Check the box saying you have read and agree to the current version.');
    await act(async () => presses.get('Accept and continue')!());
    expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    expect(reason()).toBe('Choose the state where you live.');
    await chooseState('Texas');
    expect(reason()).toBe('Check the age statement for your state.');
    expect(container.textContent).not.toContain(recheck);
    await act(async () => ageBox().click());
    expect(buttonNamed('Accept and continue')?.disabled).toBe(false);
    expect(reason()).toBeNull();
    await chooseState('Ohio');
    expect(container.textContent).toContain(recheck);
    expect(announced).toHaveBeenCalledTimes(1);
    expect(announced).toHaveBeenCalledWith(recheck);
    expect(reason()).toBe('Check the age statement for your state.');
    // A second change before the box is checked keeps the sentence and speaks nothing new.
    await chooseState('Utah');
    expect(container.textContent).toContain(recheck);
    expect(announced).toHaveBeenCalledTimes(1);
    await act(async () => ageBox().click());
    expect(container.textContent).not.toContain(recheck);
    // Unchecking by hand is not a state change: no sentence comes back.
    await act(async () => ageBox().click());
    expect(container.textContent).not.toContain(recheck);
    expect(reason()).toBe('Check the age statement for your state.');
    await act(async () => presses.get('Accept and continue')!());
    expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
  });

  it.skipIf(!LEGAL_SITE_ORIGIN)('gives Accept and continue no reason while a document failed to open, which has its own alert', async () => {
    openURL.mockRejectedValue(new Error('no browser'));
    push.mockImplementation(() => { throw new Error('static reader refused'); });
    await render(invite);
    await act(async () => container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Privacy"]')!.click());
    expect(container.textContent).toContain('could not be opened');
    expect(buttonNamed('Accept and continue')?.getAttribute('data-disabled-reason')).toBeNull();
  });

  it.skipIf(!LEGAL_SITE_ORIGIN)('shows every version before consent and redeems only once after explicit agreement in Strict Mode', async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'accepted', reactivated: false });
    await render(invite);
    expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    expect(container.textContent).toContain('For a new account');
    expect(container.textContent).toContain('keep using your existing password; no new password is sent');
    expect(container.textContent).toContain(`Use at least ${NEW_PASSWORD_MIN} characters.`);
    expect(container.textContent).toContain(`Terms of use, version ${legalAcceptanceVersions()['terms-of-use']}`);
    // Owner direction of October 16, 2026: every instrument is operative, so
    // the screen no longer says they are not.
    expect(container.textContent).not.toContain('not operative');
    expect(container.querySelectorAll('[role="link"]')).toHaveLength(6);
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === 'Accept and continue')!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    // No age attestation is offered before a state is chosen, and the terms box
    // alone leaves the button disabled.
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
    const terms = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
    await act(async () => terms.click());
    expect(button.disabled).toBe(true);
    // An app-store age-law state selects the 18-or-older attestation.
    await chooseState('Texas');
    const age = () => container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1]!;
    expect(age().getAttribute('aria-label')).toBe("I'm 18 or older.");
    await act(async () => age().click());
    expect(button.disabled).toBe(false);
    // Any other state selects the D-03 B band and clears the earlier answer.
    await chooseState('Ohio');
    expect(age().getAttribute('aria-label')).toBe("I'm 13 or older, and if I'm under 18, my organization authorized this account.");
    expect(age().getAttribute('aria-checked')).toBe('false');
    expect(button.disabled).toBe(true);
    await act(async () => age().click());
    await act(async () => button.click());
    expect(api.acceptEmailInvitation).toHaveBeenCalledTimes(1);
    expect(api.acceptEmailInvitation).toHaveBeenCalledWith(invite.token, legalAcceptanceVersions(), 'OH', true, '');
    expect(container.textContent).toContain('Your invitation is accepted');
    expect(api.beginEmailPasswordReset).not.toHaveBeenCalled();
  });

  // REQ-UG-NATIVE-MEMBER-REFERRAL-CODE-20261111: the optional
  // referral field, as on the web invitation page.
  it('sends the referral code typed into the optional field with the acceptance', async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'accepted', reactivated: false });
    await render(invite);
    expect(container.textContent).toContain('Referral code (optional)');
    expect(container.textContent).toContain('If a worker of this organization brought you in, enter their code so they get credit.');
    await input('Referral code (optional)', '0A1B-2C3D-4E5F');
    await accept('Ohio');
    expect(api.acceptEmailInvitation).toHaveBeenCalledTimes(1);
    expect(api.acceptEmailInvitation).toHaveBeenCalledWith(invite.token, legalAcceptanceVersions(), 'OH', true, '0A1B-2C3D-4E5F');
  });

  it('offers no referral field on a password reset link', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'link-invalid' });
    await render(reset);
    expect(container.querySelector('input[aria-label="Referral code (optional)"]')).toBeNull();
  });

  // REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016 (Cursor HIGH on):
  // this clickwrap is native account creation, so the store's age signal is
  // read here, at Accept, before the one-time token crosses the network.
  const shared = (lower: number | null, upper: number | null) => ({ platform: 'ios', status: 'shared', lower, upper, source: 'test' });
  const blockedCopy = () => container.querySelector('[data-testid="email-auth-store-blocked"]') ?? [...container.querySelectorAll('p')].find((node) => node.textContent?.includes('reports an age under 18'));

  it('stops a store-reported minor in an age-law state before the invitation token is sent', async () => {
    store.request.mockResolvedValue(shared(13, 15));
    await render(invite);
    await accept('Texas');
    expect(store.request).toHaveBeenCalledTimes(1);
    expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Your app store account reports an age under 18');
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept and continue')).toBeUndefined();
    expect(blockedCopy()).toBeTruthy();
    // Choosing another state releases the refusal and the attestation path.
    await chooseState('Ohio');
    expect(container.textContent).not.toContain('reports an age under 18');
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept and continue')).toBeTruthy();
  });

  it('says the refusal in English for a Spanish-language worker', async () => {
    locale.language = 'es';
    store.request.mockResolvedValue(shared(null, 16));
    await render(invite);
    await accept('California');
    expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Your app store account reports an age under 18');
    expect(container.textContent).not.toContain('indica una edad menor de 18 años');
  });

  it('lets a store-reported adult, an unavailable signal and a missing module through to the self-attested acceptance', async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'accepted', reactivated: false });
    store.request.mockResolvedValue(shared(18, null));
    await render(invite);
    await accept('Texas');
    expect(store.request).toHaveBeenCalledTimes(1);
    expect(api.acceptEmailInvitation).toHaveBeenCalledWith(invite.token, legalAcceptanceVersions(), 'TX', true, '');
    await act(async () => root.unmount());
    root = createRoot(container);
    store.request.mockReset();
    store.request.mockResolvedValue({ platform: 'android', status: 'unavailable', error: 'play-services-missing' });
    await render(invite);
    await accept('Utah');
    expect(api.acceptEmailInvitation).toHaveBeenLastCalledWith(invite.token, legalAcceptanceVersions(), 'UT', true, '');
    await act(async () => root.unmount());
    root = createRoot(container);
    store.module = null;
    store.request.mockReset();
    await render(invite);
    await accept('Louisiana');
    expect(store.request).not.toHaveBeenCalled();
    expect(api.acceptEmailInvitation).toHaveBeenLastCalledWith(invite.token, legalAcceptanceVersions(), 'LA', true, '');
    expect(api.acceptEmailInvitation).toHaveBeenCalledTimes(3);
  });

  it('never asks the store outside the app-store age-law states', async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'accepted', reactivated: false });
    store.request.mockResolvedValue(shared(13, 15));
    await render(invite);
    await accept('Ohio');
    expect(store.request).not.toHaveBeenCalled();
    expect(api.acceptEmailInvitation).toHaveBeenCalledWith(invite.token, legalAcceptanceVersions(), 'OH', true, '');
  });

  it('renders a closed failure for an invalid callback without calling an API', async () => {
    await render(null);
    expect(container.textContent).toContain('invalid, expired, or already used');
    expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    expect(api.beginEmailPasswordReset).not.toHaveBeenCalled();
  });

  it('renders an expired invitation without a retry that could create a session', async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'link-invalid' });
    await render(invite);
    await accept();
    expect(container.textContent).toContain('invalid, expired, or already used');
    expect(container.textContent).not.toContain('Try again');
  });

  // UX-UG-NATIVE-LINK-FAILURE-ASK-ADMINISTRATOR-20261018: a failed
  // link names a way forward that exists for every link of its kind.
  it('offers a new reset link after a failed reset link, and nothing abstract to ask', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'link-invalid' });
    const onRequestNewLink = vi.fn();
    await render(reset, onRequestNewLink);
    expect(api.beginEmailPasswordReset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('This reset link is invalid, expired, or already used');
    expect(container.textContent).not.toMatch(/administrator|Request a new link/);
    const button = buttonNamed('Send me a new reset link');
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    expect(onRequestNewLink).toHaveBeenCalledTimes(1);
    expect(api.beginEmailPasswordReset).toHaveBeenCalledTimes(1);
    expect(buttonNamed('Continue to sign in')).toBeTruthy();
  });

  it('keeps the failed reset link closed where no reset email can be sent', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'link-invalid' });
    await render(reset);
    expect(buttonNamed('Send me a new reset link')).toBeUndefined();
    expect(container.textContent).toContain('This reset link is invalid, expired, or already used');
  });

  it("names the organization's administrator and the support address after a failed invitation link", async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'link-invalid' });
    await render(invite, vi.fn());
    await accept();
    expect(container.textContent).toContain("Ask your organization's administrator to send a new invitation");
    // The support address is an actionable control, not inert text.
    const support = container.querySelector('[data-testid="support-link"]')!;
    expect(support).toBeTruthy();
    expect(support.textContent).toBe('No administrator to ask? Ask the person who invited you.');
    expect(support.getAttribute('data-language')).toBe('en');
    expect(container.textContent).not.toContain('Request a new link');
    expect(buttonNamed('Send me a new reset link')).toBeUndefined();
    expect(buttonNamed('Try again')).toBeUndefined();
  });

  it('offers no support control after a failed reset link, which has its own action', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'link-invalid' });
    await render(reset, vi.fn());
    expect(container.querySelector('[data-testid="support-link"]')).toBeNull();
  });

  it('does not point at a reset action that is absent for an unknown link (gate round 1, Sol r1s1)', async () => {
    await render(null);
    expect(buttonNamed('Send me a new reset link')).toBeUndefined();
    expect(container.textContent).not.toContain('below');
    expect(container.textContent).toContain('Forgot your password?');
    expect(container.querySelector('[data-testid="support-link"]')).toBeTruthy();
  });

  it("shows the host's sign-out diagnosis while a signed-in worker stays on the screen", async () => {
    await act(async () => root.render(h(StrictMode, null, h(EmailAuthScreen, { link: null, onSignIn: () => undefined, notice: 'You remain signed in.' }))));
    expect(container.textContent).toContain('You remain signed in.');
  });

  // Owner ruling: native member copy is English only. A Spanish-language
  // member reads the same failed-link guidance in English; only the shared
  // support control keeps its own language.
  it('names both ways forward, in English for a Spanish-language worker too, when the kind of link is unknown', async () => {
    const onRequestNewLink = vi.fn();
    await render(null, onRequestNewLink);
    expect(container.textContent).toContain("ask your organization's administrator");
    expect(container.textContent).toContain('send yourself a new link below');
    expect(container.querySelector('[data-testid="support-link"]')?.textContent).toContain('No administrator to ask?');
    expect(buttonNamed('Send me a new reset link')).toBeTruthy();
    await act(async () => root.unmount());
    locale.language = 'es';
    root = createRoot(container);
    api.acceptEmailInvitation.mockResolvedValue({ status: 'link-invalid' });
    await render(invite, onRequestNewLink);
    await accept();
    expect(container.textContent).toContain("Ask your organization's administrator to send a new invitation");
    expect(container.textContent).not.toContain('Pide a la administración');
    const support = container.querySelector('[data-testid="support-link"]')!;
    expect(support.textContent).toBe('No administrator to ask? Ask the person who invited you.');
    expect(support.getAttribute('data-language')).toBe('es');
    expect(buttonNamed('Send me a new reset link')).toBeUndefined();
    expect(buttonNamed('Envíame un enlace de restablecimiento nuevo')).toBeUndefined();
  });

  it.skipIf(!LEGAL_SITE_ORIGIN)('opens public instrument links without redeeming or sending the private token', async () => {
    await render(invite);
    for (const link of container.querySelectorAll<HTMLButtonElement>('[role="link"]')) {
      await act(async () => link.click());
    }
    expect(openURL.mock.calls.map(([url]) => url)).toEqual(legalAcceptanceLinks().map((link) => link.url));
    expect(JSON.stringify(openURL.mock.calls)).not.toContain(invite.token);
    expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
  });

  // BUG-UG-NATIVE-FAILED-DOCUMENT-OPEN-LOCKS-ACCEPT-20261018
  // These cases need a site that publishes the instruments; this edition has none yet.
  describe.skipIf(!LEGAL_SITE_ORIGIN)('when the browser refuses to open a terms document', () => {
    const termsLink = () => container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Terms of use"]')!;
    const acceptButton = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Accept and continue')!;
    const consent = async () => {
      await chooseState('Texas');
      for (const box of container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')) await act(async () => box.click());
    };
    const pendingOpen = () => {
      let resolve!: () => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
      return { promise, resolve, reject };
    };

    it('reads the same instrument in the app instead of locking Accept', async () => {
      openURL.mockRejectedValue(new Error('no browser'));
      await render(invite);
      await act(async () => termsLink().click());
      expect(push).toHaveBeenCalledWith('/legal/terms');
      expect(container.textContent).not.toContain('could not be opened');
      await consent();
      expect(acceptButton().disabled).toBe(false);
    });

    it('does not let a refused change history undo instruments already read in the app', async () => {
      openURL.mockRejectedValue(new Error('no browser'));
      await render(invite);
      for (const link of container.querySelectorAll<HTMLButtonElement>('[role="link"]')) await act(async () => link.click());
      expect(push).toHaveBeenCalledTimes(legalAcceptanceLinks().length - 1);
      expect(container.textContent).not.toContain('could not be opened');
      await consent();
      expect(acceptButton().disabled).toBe(false);
    });

    it.each([false, true])('keeps a failed Privacy push locked after Change history refuses (earlier Privacy success: %s)', async (readPrivacyFirst) => {
      openURL.mockRejectedValue(new Error('no browser'));
      await render(invite);
      await consent();
      const privacy = container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Privacy"]')!;
      if (readPrivacyFirst) await act(async () => privacy.click());
      else await act(async () => termsLink().click());
      expect(acceptButton().disabled).toBe(false);
      push.mockImplementation(() => { throw new Error('static reader refused'); });
      await act(async () => privacy.click());
      expect(acceptButton().disabled).toBe(true);
      await act(async () => container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Change history"]')!.click());
      expect(container.textContent).toContain('could not be opened');
      expect(acceptButton().disabled).toBe(true);
      await act(async () => acceptButton().click());
      expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    });

    it('records a successful browser retry after revoking a failed reader credit', async () => {
      openURL.mockRejectedValue(new Error('no browser'));
      await render(invite);
      await consent();
      const privacy = container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Privacy"]')!;
      await act(async () => privacy.click());
      push.mockImplementation(() => { throw new Error('static reader refused'); });
      await act(async () => privacy.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Change history"]')!.click());
      expect(acceptButton().disabled).toBe(true);
      openURL.mockResolvedValueOnce(undefined);
      await act(async () => privacy.click());
      expect(acceptButton().disabled).toBe(false);
      await act(async () => container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Change history"]')!.click());
      expect(container.textContent).not.toContain('could not be opened');
      expect(acceptButton().disabled).toBe(false);
    });

    it('does not let a different successful reader clear a failed instrument', async () => {
      openURL.mockRejectedValue(new Error('no browser'));
      await render(invite);
      await consent();
      const privacy = container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Privacy"]')!;
      push.mockImplementation(() => { throw new Error('static reader refused'); });
      await act(async () => privacy.click());
      push.mockImplementation(() => undefined);
      await act(async () => termsLink().click());
      expect(container.textContent).toContain('could not be opened');
      expect(acceptButton().disabled).toBe(true);
      await act(async () => privacy.click());
      expect(container.textContent).not.toContain('could not be opened');
      expect(acceptButton().disabled).toBe(false);
    });

    it.each(['history-first', 'instrument-first'])('settles concurrent Change history refusal and successful fallback (%s)', async (order) => {
      let refuseHistory!: (reason: Error) => void;
      let refuseInstrument!: (reason: Error) => void;
      openURL.mockImplementation((url) => new Promise<void>((_resolve, reject) => {
        if (url.endsWith('/changelog')) refuseHistory = reject;
        else refuseInstrument = reject;
      }));
      await render(invite);
      await consent();
      await act(async () => container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Change history"]')!.click());
      await act(async () => termsLink().click());
      const first = order === 'history-first' ? refuseHistory : refuseInstrument;
      const second = order === 'history-first' ? refuseInstrument : refuseHistory;
      await act(async () => first(new Error('no browser')));
      await act(async () => second(new Error('no browser')));
      expect(push).toHaveBeenCalledWith('/legal/terms');
      expect(container.textContent).not.toContain('could not be opened');
      expect(acceptButton().disabled).toBe(false);
      expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    });

    it.each(['history-first', 'instrument-first'])('settles concurrent Change history refusal and successful browser open (%s)', async (order) => {
      let refuseHistory!: (reason: Error) => void;
      let openInstrument!: () => void;
      openURL.mockImplementation((url) => new Promise<void>((resolve, reject) => {
        if (url.endsWith('/changelog')) refuseHistory = reject;
        else openInstrument = resolve;
      }));
      await render(invite);
      await consent();
      await act(async () => container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Change history"]')!.click());
      await act(async () => termsLink().click());
      const history = () => refuseHistory(new Error('no browser'));
      await act(async () => (order === 'history-first' ? history : openInstrument)());
      await act(async () => (order === 'history-first' ? openInstrument : history)());
      expect(push).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain('could not be opened');
      expect(acceptButton().disabled).toBe(false);
      expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    });

    it.each<['latest-success-first' | 'obsolete-refusal-first', boolean]>([
      ['latest-success-first', false], ['latest-success-first', true],
      ['obsolete-refusal-first', false], ['obsolete-refusal-first', true],
    ])('ignores an obsolete Terms refusal (%s, fallback would throw: %s)', async (order, readerThrows) => {
      const older = pendingOpen();
      const latest = pendingOpen();
      openURL.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => latest.promise);
      if (readerThrows) push.mockImplementation(() => { throw new Error('reader refused'); });
      await render(invite);
      await consent();
      await act(async () => termsLink().click());
      await act(async () => termsLink().click());
      const refuseOlder = () => older.reject(new Error('old browser refused'));
      await act(async () => (order === 'latest-success-first' ? latest.resolve : refuseOlder)());
      expect(push).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain('could not be opened');
      await act(async () => (order === 'latest-success-first' ? refuseOlder : latest.resolve)());
      expect(push).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain('could not be opened');
      expect(acceptButton().disabled).toBe(false);
      expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    });

    it('ignores an obsolete history refusal after a newer history open succeeds', async () => {
      const older = pendingOpen();
      const latest = pendingOpen();
      openURL.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => latest.promise);
      await render(invite);
      await consent();
      const history = container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Change history"]')!;
      await act(async () => history.click());
      await act(async () => history.click());
      await act(async () => latest.resolve());
      await act(async () => older.reject(new Error('old history refused')));
      expect(push).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain('could not be opened');
      expect(acceptButton().disabled).toBe(false);
    });

    it('keeps a latest Terms failure locked when an obsolete browser open later succeeds', async () => {
      const older = pendingOpen();
      openURL.mockImplementationOnce(() => older.promise).mockRejectedValueOnce(new Error('latest browser refused'));
      push.mockImplementation(() => { throw new Error('reader refused'); });
      await render(invite);
      await consent();
      await act(async () => termsLink().click());
      await act(async () => termsLink().click());
      expect(acceptButton().disabled).toBe(true);
      await act(async () => older.resolve());
      expect(container.textContent).toContain('could not be opened');
      expect(acceptButton().disabled).toBe(true);
      await act(async () => acceptButton().click());
      expect(api.acceptEmailInvitation).not.toHaveBeenCalled();
    });

    it('does not supersede a pending Privacy attempt when Terms opens later', async () => {
      const privacyOpen = pendingOpen();
      openURL.mockImplementationOnce(() => privacyOpen.promise).mockResolvedValue(undefined);
      push.mockImplementation(() => { throw new Error('reader refused'); });
      await render(invite);
      await consent();
      const privacy = container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Privacy"]')!;
      await act(async () => privacy.click());
      await act(async () => termsLink().click());
      await act(async () => privacyOpen.reject(new Error('privacy refused')));
      expect(container.textContent).toContain('could not be opened');
      expect(acceptButton().disabled).toBe(true);
      await act(async () => privacy.click());
      expect(container.textContent).not.toContain('could not be opened');
      expect(acceptButton().disabled).toBe(false);
    });

    it('keeps Accept locked when no in-app rendering exists or it cannot open', async () => {
      openURL.mockRejectedValue(new Error('no browser'));
      await render(invite);
      await act(async () => container.querySelector<HTMLButtonElement>('[role="link"][aria-label^="Change history"]')!.click());
      expect(push).not.toHaveBeenCalled();
      expect(container.textContent).toContain('could not be opened');
      await consent();
      expect(acceptButton().disabled).toBe(true);
      push.mockImplementation(() => { throw new Error('no route'); });
      await act(async () => termsLink().click());
      expect(container.textContent).toContain('could not be opened');
      expect(acceptButton().disabled).toBe(true);
    });
  });

  it('announces a stale pack and requires the updated app or web clickwrap instead of retrying it', async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'terms-version-stale' });
    await render(invite);
    await accept();
    expect(container.textContent).toContain('Nothing was accepted');
    expect(container.textContent).toContain('Update the app');
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain('Try again');
    expect(api.acceptEmailInvitation).toHaveBeenCalledTimes(1);
  });

  // REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102.
  it('asks for a personal address when the invitation went to a government or employer one, without a retry', async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'email-domain-blocked' });
    await render(invite);
    await accept();
    expect(container.textContent).toContain("Use a personal email address. Government and employer email addresses can't be used for a Union Ground account.");
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain('Try again');
    expect(api.acceptEmailInvitation).toHaveBeenCalledTimes(1);
  });

  it('requires matching passwords and a complete authenticator code before submitting recovery', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
    api.finishEmailPasswordReset.mockResolvedValue({ status: 'completed', sessionsEnded: true, recoveryCodeUsed: false });
    await render(reset);
    const finish = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change password')!;
    expect(finish().disabled).toBe(true);
    await input('New password', 'new-password-long-enough-123');
    await input('Confirm new password', 'mismatched-password');
    await input('Authenticator code', '123456');
    expect(finish().disabled).toBe(true);
    await input('New password', 'a'.repeat(NEW_PASSWORD_MIN - 1));
    await input('Confirm new password', 'a'.repeat(NEW_PASSWORD_MIN - 1));
    expect(finish().disabled).toBe(true);
    expect(container.textContent).toContain(`Use at least ${NEW_PASSWORD_MIN} characters. Use no more than 256 characters.`);
    await input('New password', 'new-password-long-enough-123');
    await input('Confirm new password', 'new-password-long-enough-123');
    expect(finish().disabled).toBe(false);
    await act(async () => finish().click());
    expect(api.finishEmailPasswordReset).toHaveBeenCalledWith('sealed-state', '123456', 'new-password-long-enough-123');
    expect(container.textContent).toContain('Sign in with your new password');
    expect(container.querySelector('input')).toBeNull();
  });

  //  (M1-1), the phone twin of the web fix for: Change password
  // stays unavailable while the new password misses the length rule, and the
  // field says why, to sight and to a screen reader, with the policy's numbers.
  it.each<'en' | 'es'>(['en', 'es'])('says beside the new-password field why Change password stays unavailable (%s)', async (language) => {
    locale.language = language;
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
    await render(reset);
    const [newLabel, confirmLabel, codeLabel, finishLabel] = language === 'en'
      ? ['New password', 'Confirm new password', 'Authenticator code', 'Change password']
      : ['Contraseña nueva', 'Confirma la contraseña nueva', 'Código del autenticador', 'Cambiar contraseña'];
    const field = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    const hint = field(confirmLabel).getAttribute('aria-description');
    const reasonFor = (value: string) => (value.length < NEW_PASSWORD_MIN ? NEW_PASSWORD_TOO_SHORT : NEW_PASSWORD_TOO_LONG)[language]
      .replace('{count}', String(value.length));
    const short = 'a'.repeat(NEW_PASSWORD_MIN - 4);
    await input(newLabel, short);
    await input(confirmLabel, short);
    await input(codeLabel, '123456');
    expect(buttonNamed(finishLabel)?.disabled).toBe(true);
    expect(buttonNamed(finishLabel)?.getAttribute('data-disabled-reason')).toBe(reasonFor(short));
    expect(container.textContent).toContain(reasonFor(short));
    expect(field(newLabel).getAttribute('aria-description')).toBe(`${reasonFor(short)} ${hint}`);
    expect(field(confirmLabel).getAttribute('aria-description')).toBe(hint);
    const long = 'a'.repeat(NEW_PASSWORD_MAX + 1);
    await input(newLabel, long);
    expect(container.textContent).toContain(reasonFor(long));
    for (const value of ['', 'a'.repeat(NEW_PASSWORD_MIN)]) {
      await input(newLabel, value);
      expect(container.textContent).not.toContain(language === 'en' ? 'Too ' : 'Demasiado ');
      expect(field(newLabel).getAttribute('aria-description')).toBe(hint);
    }
  });

  //  (M1-1): a press on the unavailable button names the first unmet
  // rule in field order: the code, then the password length, then the match.
  it('hands Change password the first unmet rule as its reason', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
    await render(reset);
    const reason = () => buttonNamed('Change password')?.getAttribute('data-disabled-reason');
    const good = 'a'.repeat(NEW_PASSWORD_MIN);
    expect(reason()).toBe('Enter the six-digit code from your authenticator app.');
    await act(async () => buttonNamed('Lost your authenticator? Use a saved recovery code instead')!.click());
    expect(reason()).toBe('A recovery code is 18 to 32 letters, numbers and dashes.');
    await act(async () => buttonNamed('Use the code from my authenticator app instead')!.click());
    await input('Authenticator code', '123456');
    expect(reason()).toBe(`Use at least ${NEW_PASSWORD_MIN} characters. Use no more than ${NEW_PASSWORD_MAX} characters. The two passwords must match.`);
    await input('New password', good);
    await input('Confirm new password', `${good}x`);
    expect(reason()).toBe('The two passwords do not match.');
    await input('Confirm new password', good);
    expect(buttonNamed('Change password')?.disabled).toBe(false);
    expect(reason()).toBeNull();
  });

  // The recovery-code sentence reads the same two
  // constants as the rule, and the rule accepts and refuses what it did on Main.
  it('names the recovery code length from the constants the rule reads', async () => {
    expect([RECOVERY_CODE_MIN_LENGTH, RECOVERY_CODE_MAX_LENGTH]).toEqual([18, 32]);
    expect(COPY.en.recoveryCodeShape).toBe(`A recovery code is ${RECOVERY_CODE_MIN_LENGTH} to ${RECOVERY_CODE_MAX_LENGTH} letters, numbers and dashes.`);
    expect(COPY.es.recoveryCodeShape).toContain(`de ${RECOVERY_CODE_MIN_LENGTH} a ${RECOVERY_CODE_MAX_LENGTH} letras`);
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
    await render(reset);
    await act(async () => buttonNamed('Lost your authenticator? Use a saved recovery code instead')!.click());
    const reason = () => buttonNamed('Change password')?.getAttribute('data-disabled-reason');
    for (const [length, accepted] of [[17, false], [18, true], [32, true], [33, false]] as Array<[number, boolean]>) {
      await input('One-time recovery code', 'A1-'.repeat(11).slice(0, length));
      expect(reason() === COPY.en.recoveryCodeShape).toBe(!accepted);
    }
  });

  it.each<['en' | 'es', boolean]>([
    ['en', true], ['en', false], ['es', true], ['es', false],
  ])('explains enrollment and offers recovery codes in %s (sessions ended: %s)', async (language, sessionsEnded) => {
    locale.language = language;
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'enroll', state: 'sealed-state', secret: 'A'.repeat(32) });
    api.finishEmailPasswordReset.mockResolvedValue({ status: 'completed', sessionsEnded, recoveryCodeUsed: false });
    await render(reset);
    const copy = container.textContent;
    expect(copy).toContain('Google Authenticator');
    expect(copy).toContain('Microsoft Authenticator');
    for (const text of language === 'en'
      ? ['free options', 'protect your account', 'about a minute', 'six-digit code', 'only after the code is accepted',
        'No phone', 'unable to use an authenticator app', 'campaign administrator', 'Add this key in your authenticator app']
      : ['opciones gratuitas', 'proteger tu cuenta', 'aproximadamente un minuto', 'seis dígitos', 'solo después de que se acepte el código',
        'No tienes teléfono', 'no puedes usar una app de autenticación', 'administración de tu campaña', 'Añade esta clave en tu app de autenticación']) {
      expect(copy).toContain(text);
    }
    expect(container.textContent).toContain('A'.repeat(32));
    const finish = [...container.querySelectorAll('button')].find((button) =>
      button.textContent === (language === 'en' ? 'Change password' : 'Cambiar contraseña'))!;
    expect(finish.disabled).toBe(true);
    await input(language === 'en' ? 'New password' : 'Contraseña nueva', 'a'.repeat(NEW_PASSWORD_MIN));
    await input(language === 'en' ? 'Confirm new password' : 'Confirma la contraseña nueva', 'a'.repeat(NEW_PASSWORD_MIN));
    await input(language === 'en' ? 'Authenticator code' : 'Código del autenticador', '123456');
    await act(async () => finish.click());
    expect(api.finishEmailPasswordReset).toHaveBeenCalledWith('sealed-state', '123456', 'a'.repeat(NEW_PASSWORD_MIN));
    expect(container.textContent).toContain(language === 'en' ? 'Union Ground on the web' : 'Union Ground desde la web');
    expect(container.textContent).toContain(language === 'en'
      ? 'Settings > Security > Recovery codes' : 'Configuración > Seguridad > Códigos de recuperación');
    expect(container.textContent).toContain(language === 'en' ? 'if your organization allows it' : 'si tu organización lo permite');
    expect(container.textContent).not.toContain('A'.repeat(32));
    expect(container.querySelector('input')).toBeNull();
  });
  it.each<'recovery-unfinished' | 'recovery-held'>(['recovery-unfinished', 'recovery-held'])('clears the saved reset after %s so a reload cannot resume it', async (status) => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
    api.finishEmailPasswordReset.mockResolvedValue({ status });
    await render(reset);
    expect(pending.record).toMatchObject({ state: 'sealed-state' });
    await act(async () => buttonNamed('Lost your authenticator? Use a saved recovery code instead')!.click());
    await input('New password', 'new-password-long-enough-123');
    await input('Confirm new password', 'new-password-long-enough-123');
    await input('One-time recovery code', 'UG-ABCD-1234-ABCD-1234');
    await act(async () => buttonNamed('Change password')!.click());
    expect(container.textContent).toContain(status === 'recovery-held'
      ? 'Your recovery could not be completed and is now on hold'
      : 'Your password was changed, but we could not finish');
    expect(pending.record).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    api.beginEmailPasswordReset.mockClear();
    await render(resume);
    expect(api.beginEmailPasswordReset).not.toHaveBeenCalled();
    expect(container.textContent).toContain('invalid, expired, or already used');
    expect(container.querySelector('input')).toBeNull();
  });

  // BUG-UG-RESET-REFUSES-RECOVERY-CODE-20261018
  // The native app's copy is English-only by owner ruling: the recovery-code
  // strings exist in English alone.
  it('sends a saved recovery code instead of the authenticator code and says what happened', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
    api.finishEmailPasswordReset.mockResolvedValue({ status: 'completed', sessionsEnded: true, recoveryCodeUsed: true });
    await render(reset);
    await act(async () => [...container.querySelectorAll('button')].find((button) =>
      button.textContent === 'Lost your authenticator? Use a saved recovery code instead')!.click());
    const finish = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change password')!;
    await input('New password', 'new-password-long-enough-123');
    await input('Confirm new password', 'new-password-long-enough-123');
    await input('One-time recovery code', '123456');
    expect(finish().disabled).toBe(true);
    await input('One-time recovery code', 'UG-ABCD-1234-ABCD-1234');
    expect(finish().disabled).toBe(false);
    await act(async () => finish().click());
    expect(api.finishEmailPasswordReset).toHaveBeenCalledWith('sealed-state', 'UG-ABCD-1234-ABCD-1234', 'new-password-long-enough-123');
    expect(container.textContent).toContain('the authenticator you lost is removed');
    expect(container.querySelector('input')).toBeNull();
  });

  it('says the password changed but the recovery is unfinished, and closes the form', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
    api.finishEmailPasswordReset.mockResolvedValue({ status: 'recovery-unfinished' });
    await render(reset);
    await act(async () => [...container.querySelectorAll('button')].find((button) =>
      button.textContent === 'Lost your authenticator? Use a saved recovery code instead')!.click());
    await input('New password', 'new-password-long-enough-123');
    await input('Confirm new password', 'new-password-long-enough-123');
    await input('One-time recovery code', 'UG-ABCD-1234-ABCD-1234');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change password')!.click());
    expect(container.textContent).toContain('Your password was changed, but we could not finish removing your old authenticator');
    expect(container.querySelector('input')).toBeNull();
    // The recovery lock may still refuse a sign-in: no sign-in action is offered.
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Continue to sign in')).toBeUndefined();
  });

  it.each(['en', 'es'])('keeps held recovery closed and offers the English support route (%s)', async (language) => {
    locale.language = language;
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
    api.finishEmailPasswordReset.mockResolvedValue({ status: 'recovery-held' });
    await render(reset);
    await act(async () => [...container.querySelectorAll('button')].find((button) =>
      button.textContent === 'Lost your authenticator? Use a saved recovery code instead')!.click());
    await input(language === 'en' ? 'New password' : 'Contraseña nueva', 'new-password-long-enough-123');
    await input(language === 'en' ? 'Confirm new password' : 'Confirma la contraseña nueva', 'new-password-long-enough-123');
    await input('One-time recovery code', 'UG-ABCD-1234-ABCD-1234');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === (language === 'en' ? 'Change password' : 'Cambiar contraseña'))!.click());
    expect(container.textContent).toContain('Your recovery could not be completed and is now on hold, so we cannot tell you whether your password changed');
    expect(container.textContent).toContain('Ask your campaign administrator to reset your two-step sign-in');
    const support = container.querySelector<HTMLAnchorElement>('[data-testid="support-link"]');
    expect(support).not.toBeNull();
    expect(support?.getAttribute('href')).toBe('mailto:support@unionground.example');
    expect(support?.getAttribute('data-language')).toBe('en');
    expect(support?.textContent).toContain('No administrator to ask? Ask the person who invited you.');
    expect(container.querySelector('input')).toBeNull();
    for (const label of ['Change password', 'Cambiar contraseña', 'Try again', 'Volver a intentar']) {
      expect([...container.querySelectorAll('button')].some((button) => button.textContent === label)).toBe(false);
    }
    expect(api.finishEmailPasswordReset).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Continue to sign in')).toBeUndefined();
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Continuar para entrar')).toBeUndefined();
  });

  it('explains a refused recovery code, never offers one while enrolling, and switches back to the authenticator code', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
    api.finishEmailPasswordReset.mockResolvedValue({ status: 'code-not-accepted' });
    await render(reset);
    const toggle = (label: string) => [...container.querySelectorAll('button')].find((button) => button.textContent === label)!;
    await act(async () => toggle('Lost your authenticator? Use a saved recovery code instead').click());
    await input('New password', 'new-password-long-enough-123');
    await input('Confirm new password', 'new-password-long-enough-123');
    await input('One-time recovery code', 'UG-ABCD-1234-ABCD-1234');
    await act(async () => toggle('Change password').click());
    expect(container.textContent).toContain('That recovery code was not accepted');
    await act(async () => toggle('Use the code from my authenticator app instead').click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Authenticator code"]')!.value).toBe('');
    expect(container.textContent).not.toContain('That recovery code was not accepted');
    await act(async () => root.unmount());

    pending.record = null;
    root = createRoot(container);
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'enroll', state: 'sealed-state', secret: 'A'.repeat(32) });
    await render(reset);
    expect(container.textContent).not.toContain('recovery code instead');
  });

  // BUG-UG-RESET-LINK-SPENT-ON-PAGE-OPEN-20261018: opening the link
  // spends it, so a relaunch inside the sealed state's life resumes the step.
  it('keeps the begun reset and resumes the enrolment step on a fresh mount without calling begin again', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'enroll', state: 'sealed-state', secret: 'A'.repeat(32) });
    await render(reset);
    expect(api.beginEmailPasswordReset).toHaveBeenCalledTimes(1);
    expect(pending.record).toEqual({ ticket: reset.token, status: 'enroll', state: 'sealed-state', secret: 'A'.repeat(32) });
    await act(async () => root.unmount());

    // The OS killed the app; the same link, or the sign-in resume button, opens it again.
    for (const link of [reset, resume]) {
      api.beginEmailPasswordReset.mockClear();
      root = createRoot(container);
      await render(link);
      expect(api.beginEmailPasswordReset).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Add this key in your authenticator app');
      expect(container.textContent).toContain('A'.repeat(32));
      await act(async () => root.unmount());
    }
    root = createRoot(container);
  });

  it('forgets the saved reset after it completes and when the server refuses it', async () => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
    api.finishEmailPasswordReset.mockResolvedValue({ status: 'completed', sessionsEnded: true, recoveryCodeUsed: false });
    await render(reset);
    expect(pending.record).not.toBeNull();
    await input('New password', 'new-password-long-enough-123');
    await input('Confirm new password', 'new-password-long-enough-123');
    await input('Authenticator code', '123456');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change password')!.click());
    expect(pending.record).toBeNull();
    await act(async () => root.unmount());

    root = createRoot(container);
    pending.record = { ticket: reset.token, status: 'challenge', state: 'old', secret: '' };
    api.finishEmailPasswordReset.mockResolvedValue({ status: 'link-invalid' });
    await render(reset);
    await input('New password', 'new-password-long-enough-123');
    await input('Confirm new password', 'new-password-long-enough-123');
    await input('Authenticator code', '123456');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change password')!.click());
    expect(pending.record).toBeNull();
    expect(container.textContent).toContain('invalid, expired, or already used');
  });

  it('clears a retained pre-tag enrollment when finish finds its factor gone', async () => {
    // A saved enrollment with no account tag outlives a newer begin; the server
    // answers its finish link-invalid once the factor is deleted, which clears it.
    pending.record = { ticket: reset.token, status: 'enroll', state: 'old-enroll', secret: 'A'.repeat(32) };
    api.finishEmailPasswordReset.mockResolvedValue({ status: 'link-invalid' });
    await render(reset);
    expect(api.beginEmailPasswordReset).not.toHaveBeenCalled();
    await input('New password', 'new-password-long-enough-123');
    await input('Confirm new password', 'new-password-long-enough-123');
    await input('Authenticator code', '123456');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change password')!.click());
    expect(api.finishEmailPasswordReset).toHaveBeenCalled();
    expect(pending.record).toBeNull();
    expect(container.textContent).toContain('invalid, expired, or already used');
  });

  it('begins again for a newer link and refuses a resume with nothing saved', async () => {
    pending.record = { ticket: `t1.${'C'.repeat(16)}.${'D'.repeat(64)}`, status: 'challenge', state: 'old', secret: '' };
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'new-state', secret: '' });
    await render(reset);
    expect(api.beginEmailPasswordReset).toHaveBeenCalledTimes(1);
    expect(pending.record).toMatchObject({ ticket: reset.token, state: 'new-state' });
    await act(async () => root.unmount());

    root = createRoot(container);
    pending.record = null;
    api.beginEmailPasswordReset.mockClear();
    await render(resume);
    expect(api.beginEmailPasswordReset).not.toHaveBeenCalled();
    expect(container.textContent).toContain('invalid, expired, or already used');
    expect(container.querySelector('input')).toBeNull();
  });
  it('keeps the usable saved reset when a different link turns out to be expired or used', async () => {
    const saved: NonNullable<typeof pending.record> = { ticket: `t1.${'C'.repeat(16)}.${'D'.repeat(64)}`, status: 'challenge', state: 'kept', secret: '' };
    pending.record = saved;
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'link-invalid' });
    await render(reset);
    expect(api.beginEmailPasswordReset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('invalid, expired, or already used');
    expect(pending.record).toEqual(saved);
  });

  it('captures the enrollment saved by an earlier queued begin before invalidating it', async () => {
    let finishFirst: (value: Awaited<ReturnType<typeof beginEmailPasswordReset>>) => void = () => undefined;
    api.beginEmailPasswordReset.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ status: 'reset-invalidated', reason: 'rate-limited', account: ACCOUNT_A });
    await render(reset);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ kind: 'passwordReset', token: 'ticket-b' }, vi.fn());
    expect(api.beginEmailPasswordReset).toHaveBeenCalledTimes(1);
    await act(async () => { finishFirst({ status: 'enroll', state: 'state-a', secret: 'A'.repeat(32), account: ACCOUNT_A }); });
    expect(api.beginEmailPasswordReset).toHaveBeenCalledTimes(2);
    expect(pending.record).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(buttonNamed('Send me a new reset link')).toBeTruthy();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(resume);
    expect(container.textContent).not.toContain('A'.repeat(32));
    expect(container.querySelector('input')).toBeNull();
  });

  it('runs Auth deletion and failed enrollment through the real native transport and pending store', async () => {
    const backend = resetEnrollmentFixture(vi);
    const transport = await vi.importActual<typeof import('../services/emailAuth')>('../services/emailAuth');
    api.beginEmailPasswordReset.mockImplementation(transport.beginEmailPasswordReset);
    await render({ kind: 'passwordReset', token: backend.ticketA });
    expect(backend.factorCount()).toBe(1);
    expect(pending.record?.status).toBe('enroll');
    await act(async () => root.unmount());
    root = createRoot(container);
    backend.failEnrollment(429);
    await render({ kind: 'passwordReset', token: backend.ticketB }, vi.fn());
    expect(backend.factorCount()).toBe(0);
    expect(pending.record === null).toBe(true);
    expect(buttonNamed('Send me a new reset link')).toBeTruthy();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(resume);
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it.each(['delete-throttled', 'other-account-enroll-failed'])('keeps the real prior enrollment after %s without factor deletion', async (failure) => {
    const backend = resetEnrollmentFixture(vi);
    const transport = await vi.importActual<typeof import('../services/emailAuth')>('../services/emailAuth');
    api.beginEmailPasswordReset.mockImplementation(transport.beginEmailPasswordReset);
    await render({ kind: 'passwordReset', token: backend.ticketA });
    const savedState = pending.record?.state;
    await act(async () => root.unmount());
    root = createRoot(container);
    if (failure === 'delete-throttled') backend.failDeletion(429);
    else { backend.useOtherAccount(); backend.failEnrollment(500); }
    await render({ kind: 'passwordReset', token: backend.ticketB });
    expect(backend.factorCount()).toBe(1);
    expect(pending.record?.state === savedState).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(resume);
    expect(container.textContent).toContain('JBSWY3DPEHPK3PXP');
  });

  // BUG-UG-RESET-PENDING-RECORD-ACCOUNT-BINDING-20261021 (Grok R6 on
  //): B's begin deletes B's own unverified factor, then B's enrolment
  // fails; A's saved enrollment is live and must stay.
  it.each<429 | 404 | 500 | 'transport'>([429, 404, 500, 'transport'])("keeps another account's live enrollment when this account's factor is deleted and enrollment fails (%s)", async (failure) => {
    const backend = resetEnrollmentFixture(vi);
    const transport = await vi.importActual<typeof import('../services/emailAuth')>('../services/emailAuth');
    api.beginEmailPasswordReset.mockImplementation(transport.beginEmailPasswordReset);
    await render({ kind: 'passwordReset', token: backend.ticketA });
    const saved = pending.record;
    expect(saved?.account).toMatch(/^a1\./u);
    await act(async () => root.unmount());
    root = createRoot(container);
    backend.useOtherAccount();
    backend.seedFactor();
    backend.failEnrollment(failure);
    await render({ kind: 'passwordReset', token: backend.ticketB }, vi.fn());
    expect(backend.factorCount()).toBe(1);
    expect(pending.record).toEqual(saved);
    expect(buttonNamed('Send me a new reset link')).toBeTruthy();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(resume);
    expect(container.textContent).toContain('JBSWY3DPEHPK3PXP');
  });

  it.each<[string, string | undefined]>([['another account', `a1.${'B'.repeat(22)}`], ['an untagged answer', undefined]])('keeps a saved enrollment when the invalidation names %s', async (_label, account) => {
    const saved: PendingRecord = { ticket: 'ticket-a', status: 'enroll', state: 'state-a', secret: 'A'.repeat(32), account: ACCOUNT_A };
    pending.record = saved;
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'reset-invalidated', reason: 'rate-limited', ...(account ? { account } : {}) });
    await render(reset);
    expect(pending.record).toEqual(saved);
  });

  it.each<Array<'enroll' | 'challenge'>[number]>(['enroll', 'challenge'])('conditionally clears only the captured enrollment, preserving a newer %s', async (status) => {
    pending.record = { ticket: 'ticket-a', status: 'enroll', state: 'state-a', secret: 'A'.repeat(32) };
    let finish: (value: Awaited<ReturnType<typeof beginEmailPasswordReset>>) => void = () => undefined;
    api.beginEmailPasswordReset.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(reset);
    pending.record = { ticket: 'ticket-c', status, state: 'state-c', secret: '' };
    await act(async () => { finish({ status: 'reset-invalidated', reason: 'unavailable' }); });
    expect(pending.record).toMatchObject({ ticket: 'ticket-c', state: 'state-c' });
  });

  it.each<Array<'link-invalid' | 'rate-limited' | 'unavailable'>[number]>(['link-invalid', 'rate-limited', 'unavailable'])('preserves a usable enrollment on pre-mutation %s', async (status) => {
    const saved: PendingRecord = { ticket: 'ticket-a', status: 'enroll', state: 'state-a', secret: 'A'.repeat(32) };
    pending.record = saved;
    api.beginEmailPasswordReset.mockResolvedValue({ status });
    await render(reset);
    expect(pending.record).toEqual(saved);
  });

  it('preserves an unrelated verified challenge on enrollment invalidation', async () => {
    pending.record = { ticket: 'ticket-a', status: 'challenge', state: 'verified-factor', secret: '' };
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'reset-invalidated', reason: 'unavailable' });
    await render(reset);
    expect(pending.record).toMatchObject({ status: 'challenge', state: 'verified-factor' });
  });

  it.each([false, true])('clears only the finished state after navigation (newer reset saved: %s)', async (newerSaved) => {
    api.beginEmailPasswordReset.mockResolvedValue({ status: 'enroll', state: 'sealed-state', secret: 'A'.repeat(32) });
    let answer: (value: Awaited<ReturnType<typeof finishEmailPasswordReset>>) => void = () => undefined;
    api.finishEmailPasswordReset.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await render(reset);
    await input('New password', 'new-password-long-enough-123');
    await input('Confirm new password', 'new-password-long-enough-123');
    await input('Authenticator code', '123456');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change password')!.click());
    await act(async () => root.unmount());
    expect(pending.record).not.toBeNull();
    const newer: PendingRecord = { ticket: 'newer-ticket', status: 'enroll', state: 'newer-state', secret: 'newer-key' };
    if (newerSaved) pending.record = newer;
    await act(async () => { answer({ status: 'completed', sessionsEnded: true, recoveryCodeUsed: false }); });
    expect(pending.record).toEqual(newerSaved ? newer : null);
    root = createRoot(container);
  });

  // UX-UG-NATIVE-INVITE-ACCEPTED-SECOND-EMAIL-DEAD-END-20261018: the
  // accepted state names the email that carries the password and lets the
  // member reset it in the app when that email never arrives.
  it("names the password email's sender and subject after acceptance and offers an in-app reset", async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'accepted', reactivated: false });
    api.passwordResetRequestAvailable.mockReturnValue(true);
    await render(invite);
    await accept();
    expect(container.textContent).toContain('a separate email from Union Ground with the subject "Your Union Ground sign-in password"');
    // The server picks the email language from the invitation, which this
    // screen cannot know, so both subjects are named.
    expect(container.textContent).toContain('"Tu contraseña de Union Ground"');
    expect(container.textContent).toContain("Didn't get it?");
    const resetButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reset your password');
    expect(resetButton).toBeTruthy();
    expect(container.querySelector('[data-testid="password-reset-request"]')).toBeNull();
    await act(async () => resetButton!.click());
    expect(container.querySelector('[data-testid="password-reset-request"]')).toBeTruthy();
    expect(api.acceptEmailInvitation).toHaveBeenCalledTimes(1);
  });

  it("routes the reset form's Back to sign in control to sign-in, as its label says", async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'accepted', reactivated: false });
    api.passwordResetRequestAvailable.mockReturnValue(true);
    const onSignIn = vi.fn();
    await act(async () => root.render(h(StrictMode, null, h(EmailAuthScreen, { link: invite, onSignIn }))));
    await accept();
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reset your password')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="password-reset-back"]')!.click());
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('offers no reset after acceptance where no reset email can be sent, nor after a reactivation', async () => {
    api.acceptEmailInvitation.mockResolvedValue({ status: 'accepted', reactivated: false });
    api.passwordResetRequestAvailable.mockReturnValue(false);
    await render(invite);
    await accept();
    expect(container.textContent).toContain('"Your Union Ground sign-in password"');
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Reset your password')).toBeUndefined();
    await act(async () => root.unmount());
    root = createRoot(container);
    api.acceptEmailInvitation.mockResolvedValue({ status: 'accepted', reactivated: true });
    api.passwordResetRequestAvailable.mockReturnValue(true);
    await render(invite);
    await accept();
    expect(container.textContent).toContain('Sign in with your existing password');
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Reset your password')).toBeUndefined();
  });

  // Owner ruling: native member copy is English only. The accepted-invitation
  // guidance and its reset control read in English for a Spanish-language
  // member; the older Spanish heading of the screen is unchanged.
  it('says the accepted-invitation guidance in English for a Spanish-language worker', async () => {
    locale.language = 'es';
    api.acceptEmailInvitation.mockResolvedValue({ status: 'accepted', reactivated: false });
    api.passwordResetRequestAvailable.mockReturnValue(true);
    await render(invite);
    await accept();
    expect(container.textContent).toContain('Acepta tu invitación');
    expect(container.textContent).toContain('Your invitation is accepted. Your sign-in password is in a separate email from Union Ground');
    expect(container.textContent).toContain('"Your Union Ground sign-in password"');
    expect(container.textContent).not.toContain('con el asunto');
    expect(container.textContent).not.toContain('¿No llegó?');
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Reset your password')).toBeTruthy();
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Restablecer mi contraseña')).toBeUndefined();
  });
});
