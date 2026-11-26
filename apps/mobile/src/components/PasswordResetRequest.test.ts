// @vitest-environment jsdom
import { act, createElement as h, StrictMode, useEffect, type EffectCallback, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import SignInScreen from '../../app/sign-in';
import type { requestEmailPasswordReset } from '../services/emailAuth';
import type { loadPendingReset } from '../lib/pendingPasswordReset';
import { PASSWORD_RESUME_PARAM, PASSWORD_RESUME_VALUE } from '../lib/emailAuth';
import { SIGN_IN_DID_NOT_COMPLETE_NOTICE } from '../lib/signInCompletion';
import { PASSWORD_SIGN_IN_FAILED } from '../services/passwordSignIn';

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 32, bottom: 24, left: 0, right: 0 }) }));

type Hoisted = {
  request: Mock<typeof requestEmailPasswordReset>;
  signInWithPassword: Mock<(email: string, password: string) => Promise<void>>;
  memberLanguage: string | null;
  signedOutNotice: string | null;
  demo: boolean;
  announce: Mock<(message: string) => () => void>;
  config: { backendConfigured: boolean; supabaseUrl: string; portalBaseUrl: string };
  pending: Mock<typeof loadPendingReset>;
  focus: EffectCallback | null;
  push: Mock<(destination: unknown) => void>;
};

const mocks = vi.hoisted((): Hoisted => ({
  request: vi.fn<typeof requestEmailPasswordReset>(),
  signInWithPassword: vi.fn(),
  memberLanguage: null,
  signedOutNotice: null,
  demo: false,
  announce: vi.fn(),
  pending: vi.fn<typeof loadPendingReset>(),
  focus: null,
  push: vi.fn<(destination: unknown) => void>(),
  config: {
    backendConfigured: true,
    supabaseUrl: 'https://unionground-live.supabase.co',
    portalBaseUrl: 'https://app.unionground.example',
  },
}));

// The real address check runs; only the network call is replaced.
vi.mock('../services/emailAuth', async (importOriginal: () => Promise<Record<string, unknown>>) => ({
  ...await importOriginal(),
  requestEmailPasswordReset: mocks.request,
  passwordResetRequestAvailable: () => mocks.config.backendConfigured && mocks.config.portalBaseUrl === 'https://app.unionground.example',
}));
vi.mock('react-native', () => ({
  View: ({ children }: PropsWithChildren) => h('div', null, children),
  Text: ({ children }: PropsWithChildren) => h('p', null, children),
  Pressable: ({ children, onPress, disabled }: PropsWithChildren<{ onPress: () => void; disabled?: boolean }>) => h('button', { onClick: onPress, disabled }, children),
  ScrollView: ({ children }: PropsWithChildren) => h('div', null, children),
  KeyboardAvoidingView: ({ children }: PropsWithChildren) => h('div', null, children),
  Keyboard: { addListener: () => ({ remove: () => undefined }), dismiss: () => undefined },
  TextInput: ({ accessibilityLabel, value, onChangeText, secureTextEntry, editable }: {
    accessibilityLabel: string; value: string; onChangeText: (value: string) => void; secureTextEntry?: boolean; editable?: boolean;
  }) => h('input', { 'aria-label': accessibilityLabel, value, disabled: editable === false, type: secureTextEntry ? 'password' : 'text',
    onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  StyleSheet: { create: <T,>(styles: T) => styles },
  useWindowDimensions: () => ({ fontScale: 1, width: 400, height: 800 }),
}));
vi.mock('./ui', () => ({
  Body: ({ children }: PropsWithChildren) => h('p', null, children),
  Button: ({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) =>
    h('button', { disabled, onClick: onPress }, label),
}));
// The provider controls report every sign-in control released, as on Main
// before any hold (#8465), so the single sign-on control is drawn.
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('./BrandMark', () => ({ BrandMark: () => null }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  mode: 'signedOut', error: null, signOutError: null, signedOutNotice: mocks.signedOutNotice, sampleEntryBusy: false, memberLanguage: mocks.memberLanguage,
  signInWithPassword: mocks.signInWithPassword, signInWithPin: vi.fn(), signInWithNativeProvider: vi.fn(),
}) }));
vi.mock('../lib/config', () => ({ mobileConfig: mocks.config }));
vi.mock('../services/sampleSession', () => ({ isLiveSampleBackend: () => mocks.demo }));
vi.mock('../services/supabase', () => ({ pinSignInOffered: async () => false }));
vi.mock('../services/nativeQuickActionRoutes', () => ({ nativeQuickActionDestinationPath: () => null }));
vi.mock('../lib/announce', () => ({ announceForAccessibility: vi.fn(), useAccessibilityAnnouncementQueue: () => mocks.announce }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../lib/pendingPasswordReset', () => ({ loadPendingReset: mocks.pending }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mocks.push }), useLocalSearchParams: () => ({}), Redirect: () => null,
  useFocusEffect: (effect: EffectCallback) => { mocks.focus = effect; useEffect(effect, [effect]); },
}));
vi.mock('./SupportLink', () => ({ SupportLink: () => null }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.request.mockReset().mockResolvedValue({ status: 'sent' });
  mocks.signInWithPassword.mockReset();
  mocks.memberLanguage = null;
  mocks.signedOutNotice = null;
  mocks.announce.mockReset().mockReturnValue(() => undefined);
  mocks.demo = false;
  mocks.config.backendConfigured = true;
  mocks.config.portalBaseUrl = 'https://app.unionground.example';
  mocks.pending.mockReset().mockResolvedValue(null);
  mocks.focus = null;
  mocks.push.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

async function render() {
  await act(async () => root.render(h(StrictMode, null, h(SignInScreen))));
  // The email form and its reset entry sit behind "Sign in with other options"
  // (REQ-UG-SIGN-IN-PROVIDER-FIRST-LAYOUT-20261105). A SAMPLE build
  // opens it already, as "Email and password", and a press would close it.
  if (!field('Email address')) await press('Sign in with other options');
}
function button(label: string) {
  return Array.from(container.querySelectorAll('button')).find((node) => node.textContent === label);
}
function field(label: string) {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}
async function type(label: string, value: string) {
  await act(async () => {
    const input = field(label)!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function press(label: string) {
  const found = button(label);
  expect(found, `Visible button: ${label}`).toBeDefined();
  await act(async () => { found!.click(); });
}

describe('native forgot-password entry (BUG-UG-NATIVE-NO-FORGOT-PASSWORD-20261018)', () => {
  it('refreshes the saved-reset action on focus and opens the resume route', async () => {
    await render();
    expect(button('Continue resetting your password')).toBeUndefined();
    mocks.pending.mockResolvedValue({ ticket: 'ticket', status: 'challenge', state: 'state', secret: '' });
    await act(async () => { mocks.focus?.(); });
    await press('Continue resetting your password');
    expect(mocks.push).toHaveBeenCalledWith({ pathname: '/auth/callback', params: { [PASSWORD_RESUME_PARAM]: PASSWORD_RESUME_VALUE } });
    mocks.pending.mockResolvedValue(null);
    await act(async () => { mocks.focus?.(); });
    expect(button('Continue resetting your password')).toBeUndefined();
  });

  it('opens a reset request from the password form and sends the typed address once', async () => {
    await render();
    await type('Email address', ' member@example.org ');
    await type('Password', 'wrong-temporary-password');
    await press('Forgot your password?');
    // The reset view replaces the password form and drops the typed password.
    expect(field('Password')).toBeNull();
    expect(field('Email address')!.value).toBe('member@example.org');
    await press('Email me a reset link');
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith('member@example.org', 'en');
    expect(container.textContent).toContain('If member@example.org has an account, a reset link is on its way.');
    expect(container.textContent).toContain('only the newest link works');
    expect(button('Email me a reset link')).toBeUndefined();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(mocks.announce).toHaveBeenCalledTimes(1);

    await press('Back to sign in');
    expect(field('Password')!.value).toBe('');
    expect(field('Email address')!.value).toBe('member@example.org');
    expect(button('Sign in')).toBeDefined();
  });

  it('refuses an empty address and a second press while a request is in flight', async () => {
    let settle: (value: { status: 'sent' }) => void = () => undefined;
    mocks.request.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    await render();
    await press('Forgot your password?');
    expect(button('Email me a reset link')!.disabled).toBe(true);
    await type('Email address', 'member@example.org');
    await press('Email me a reset link');
    expect(button('Sending…')!.disabled).toBe(true);
    expect(field('Email address')!.disabled).toBe(true);
    await act(async () => { button('Sending…')!.click(); });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () => { settle({ status: 'sent' }); });
    expect(container.textContent).toContain('a reset link is on its way');
  });

  it('keeps Back to sign in available during a stalled request and drops the late answer', async () => {
    let settle: (value: { status: 'sent' }) => void = () => undefined;
    mocks.request.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    await render();
    await press('Forgot your password?');
    await type('Email address', 'member@example.org');
    await press('Email me a reset link');
    expect(button('Back to sign in')!.disabled).toBe(false);
    await press('Back to sign in');
    expect(field('Email address')!.value).toBe('member@example.org');
    await act(async () => { settle({ status: 'sent' }); });
    expect(container.textContent).not.toContain('a reset link is on its way');
    expect(button('Sign in')).toBeDefined();
  });

  it.each(['member@gmail', 'member@', 'member example@test.org', `${'a'.repeat(250)}@b.co`])(
    'refuses %s, which the route would accept without sending mail', async (address) => {
      await render();
      await press('Forgot your password?');
      await type('Email address', address);
      expect(container.textContent).toContain('Enter a full email address, like you@example.org.');
      expect(button('Email me a reset link')!.disabled).toBe(true);
      await act(async () => { button('Email me a reset link')!.click(); });
      expect(mocks.request).not.toHaveBeenCalled();
      expect(field('Email address')!.value).toBe(address);
    });

  it('announces each settled answer through the shared queue, which speaks on iOS too', async () => {
    mocks.request.mockResolvedValueOnce({ status: 'rate-limited' });
    await render();
    await type('Email address', 'member@example.org');
    await press('Forgot your password?');
    await press('Email me a reset link');
    expect(mocks.announce).toHaveBeenLastCalledWith('Too many attempts. Wait before trying again.');
    await press('Email me a reset link');
    expect(mocks.announce).toHaveBeenLastCalledWith(expect.stringContaining('If member@example.org has an account, a reset link is on its way.'));
    expect(mocks.announce).toHaveBeenCalledTimes(2);
  });

  const failures: ['rate-limited' | 'unavailable', string][] = [
    ['rate-limited', 'Too many attempts. Wait before trying again.'],
    ['unavailable', 'The reset request could not be sent. Try again or ask your administrator for help.'],
  ];
  it.each(failures)('shows fixed copy for a %s request and lets the worker retry', async (status, text) => {
    mocks.request.mockResolvedValueOnce({ status });
    await render();
    await type('Email address', 'member@example.org');
    await press('Forgot your password?');
    await press('Email me a reset link');
    expect(container.textContent).toContain(text);
    await press('Email me a reset link');
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain(text);
    expect(container.textContent).toContain('a reset link is on its way');
  });

  it('writes the request in Spanish for a Spanish device and asks for the email in Spanish', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ locale: 'es-MX' } as Intl.ResolvedDateTimeFormatOptions);
    await render();
    await press('Forgot your password?');
    await type('Correo electrónico', 'miembro@example.org');
    await press('Envíame un enlace');
    expect(mocks.request).toHaveBeenCalledWith('miembro@example.org', 'es');
    expect(container.textContent).toContain('Si miembro@example.org tiene una cuenta');
    expect(container.textContent).toContain('solo funciona el más reciente');
  });

  it("prefers the worker's saved language over the device locale", async () => {
    mocks.memberLanguage = 'en';
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ locale: 'es-MX' } as Intl.ResolvedDateTimeFormatOptions);
    await render();
    await press('Forgot your password?');
    expect(container.textContent).toContain('Reset your password');
  });

  it.each([
    ['SAMPLE', () => { mocks.demo = true; mocks.config.portalBaseUrl = 'https://sample.unionground.example'; }],
    ['an unconfigured build', () => { mocks.config.backendConfigured = false; }],
  ])('offers no reset entry on %s, where no reset email can be sent', async (_name, arrange) => {
    arrange();
    await render();
    expect(button('Forgot your password?')).toBeUndefined();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

// BUG-UG-NATIVE-SIGN-IN-SILENT-DROP-20261104: the refusal used to
// render at the foot of the form, below single sign-on and every provider
// button, which put it below the fold on a phone.
