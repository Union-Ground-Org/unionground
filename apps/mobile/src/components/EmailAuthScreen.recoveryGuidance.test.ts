// @vitest-environment jsdom
import { act, createElement as h, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmailAuthScreen } from './EmailAuthScreen';
import type { beginEmailPasswordReset, finishEmailPasswordReset } from '../services/emailAuth';

const api = vi.hoisted(() => ({
  beginEmailPasswordReset: vi.fn<typeof beginEmailPasswordReset>(),
  finishEmailPasswordReset: vi.fn<typeof finishEmailPasswordReset>(),
  acceptEmailInvitation: vi.fn(), passwordResetRequestAvailable: vi.fn(),
}));
const locale = vi.hoisted((): { language: string | null } => ({ language: 'en' }));
vi.mock('../services/emailAuth', () => api);
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: locale.language }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ foreground: '#111', border: '#333', card: '#fff', primary: '#111' }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../modules/store-age-signal/src/StoreAgeSignalModule', () => ({ default: null }));
vi.mock('./ResidenceAgeFields', () => ({ ResidenceAgeFields: () => null }));
vi.mock('./PasswordResetRequest', () => ({ PasswordResetRequest: () => null }));
vi.mock('./SupportLink', () => ({ SupportLink: () => null }));
vi.mock('../lib/pendingPasswordReset', () => ({
  loadPendingReset: async () => null, clearPendingReset: async () => true, savePendingReset: async () => true,
  sameResetAccount: () => true, shareBegin: (_ticket: string, begin: () => Promise<unknown>) => begin(),
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Linking: { openURL: vi.fn() },
  View: ({ children }: PropsWithChildren) => h('div', null, children),
  Text: ({ children }: PropsWithChildren) => h('p', null, children),
  ActivityIndicator: () => null,
  Pressable: () => null,
  TextInput: ({ accessibilityLabel, value, onChangeText }: {
    accessibilityLabel: string; value: string; onChangeText: (value: string) => void;
  }) => h('input', { 'aria-label': accessibilityLabel, value,
    onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
}));
vi.mock('./ui', () => ({
  Screen: ({ children }: PropsWithChildren) => h('main', null, children),
  Body: ({ children }: PropsWithChildren) => h('p', null, children),
  Heading: ({ children }: PropsWithChildren) => h('h1', null, children),
  Button: ({ label, onPress, disabled, busy }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }) =>
    h('button', { disabled: disabled || busy, onClick: onPress }, label),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  api.beginEmailPasswordReset.mockResolvedValue({ status: 'challenge', state: 'sealed-state', secret: '' });
  api.finishEmailPasswordReset.mockResolvedValue({ status: 'completed', sessionsEnded: true, recoveryCodeUsed: true });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it.each(['en', 'es', null])('shows the manual web enrollment route throughout native recovery (%s)', async (language) => {
  locale.language = language;
  const onSignIn = vi.fn();
  await act(async () => root.render(h(EmailAuthScreen, {
    link: { kind: 'passwordReset', token: `t1.${'A'.repeat(16)}.${'B'.repeat(64)}` }, onSignIn,
  })));
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find(node => node.textContent === label);
    if (!button) throw new Error(`Missing button ${label}`);
    await act(async () => button.click());
  };
  await click('Lost your authenticator? Use a saved recovery code instead');
  const expectManualGuidance = () => {
    expect(container.textContent).toContain('on the website');
    expect(container.textContent).toContain('Settings > Security');
    expect(container.textContent).toContain('Turn on two-step sign-in');
    expect(container.textContent).toContain('Configuración > Seguridad');
    expect(container.textContent).toContain('Activar el inicio de sesión en dos pasos');
    expect(container.textContent).toContain('in a browser');
    expect(container.textContent).not.toMatch(/when asked|the next time you sign in/);
  };
  expectManualGuidance();
  for (const [label, value] of [
    [language === 'es' ? 'Contraseña nueva' : 'New password', 'new-password-long-enough-123'],
    [language === 'es' ? 'Confirma la contraseña nueva' : 'Confirm new password', 'new-password-long-enough-123'],
    ['One-time recovery code', 'UG-ABCD-1234-ABCD-1234'],
  ] as const) {
    const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!field) throw new Error(`Missing field ${label}`);
    await act(async () => { field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  await click(language === 'es' ? 'Cambiar contraseña' : 'Change password');
  expect(api.finishEmailPasswordReset).toHaveBeenCalledWith('sealed-state', 'UG-ABCD-1234-ABCD-1234', 'new-password-long-enough-123');
  expectManualGuidance();
  expect(container.textContent).toContain('the authenticator you lost is removed');
  expect(container.textContent).toContain('Recovery codes');
  expect(container.querySelector('input')).toBeNull();
  await click(language === 'es' ? 'Continuar para entrar' : 'Continue to sign in');
  expect(onSignIn).toHaveBeenCalledOnce();
});
