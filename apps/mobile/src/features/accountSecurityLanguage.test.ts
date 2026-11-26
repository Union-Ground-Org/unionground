// @vitest-environment jsdom
// UX-UG-NATIVE-ACCOUNT-SECURITY-SETTINGS-POLISH-BATCH-20261111 (#8303):
// Account's security panels speak the saved member language on both phones,
// including failure, retry and accessibility names, while every access check,
// session boundary and confirmation step stays exactly as it was.
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberSessionRow } from '../lib/memberSessionInventory';
import type { SignOutFailureKind, SignOutScope } from '../services/signOutFailure';

const state = vi.hoisted(() => ({
  language: 'es' as 'en' | 'es',
  platform: 'ios',
  sessions: vi.fn(),
  signOut: vi.fn(async () => undefined),
  deleteAccount: vi.fn(async () => undefined),
  proof: 'current' as 'current' | 'changed' | 'unavailable',
  updatePassword: vi.fn(async () => undefined),
  stepUpWithPassword: vi.fn(async () => undefined),
  signOutError: null as string | null,
  // The shared Button's own press handler, by label, so a test can call it as a stray press would.
  presses: new Map<string, () => void>(),
}));
type HostProps = { children?: ReactNode; accessibilityLabel?: string; accessibilityHint?: string };
vi.mock('react-native', () => {
  const Host = ({ children, accessibilityLabel }: HostProps) => h('div', { 'aria-label': accessibilityLabel }, children);
  return {
    Platform: { get OS() { return state.platform; } }, StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    View: Host, Text: Host,
    TextInput: ({ accessibilityLabel, placeholder, value, onChangeText }: { accessibilityLabel?: string; placeholder?: string; value?: string; onChangeText?: (text: string) => void }) =>
      h('input', { 'aria-label': accessibilityLabel, placeholder, value, onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value) }),
  };
});
vi.mock('../components/ui', () => {
  const Host = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    Card: Host, Body: Host, Heading: Host, Group: Host, GroupRow: Host,
    Button: ({ label, disabled, disabledReason, onPress }: { label: string; disabled?: boolean; disabledReason?: string; onPress?: () => void }) => {
      if (onPress) state.presses.set(label, onPress);
      return h('button', { disabled, 'data-disabled-reason': disabledReason || undefined, onClick: onPress }, label);
    },
  };
});
vi.mock('../components/SupportLink', () => ({ SupportLink: ({ language }: { language?: string }) => h('a', { 'data-language': language ?? 'en' }, 'support') }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ primary: '#000', foreground: '#000', input: '#fff', border: '#ccc', mutedForeground: '#666', destructive: '#c00', appearance: 'light' }) }));
vi.mock('../services/memberSessions', () => {
  class MemberSessionsUnavailableError extends Error {
    readonly kind: string;
    constructor(kind: string, message: string) { super(message); this.kind = kind; }
  }
  return { MemberSessionsUnavailableError, loadMemberSessions: state.sessions };
});
vi.mock('../services/memberSwitches', () => ({ useMemberSwitch: () => true }));
vi.mock('../services/supabase', () => ({
  captureSessionWriter: () => ({ check: async () => state.proof }),
}));
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    memberLanguage: state.language, dashboard: null, mode: 'authenticated', session: { user: { id: 'member-1', email: 'member@example.test', factors: [] }, access_token: 'a' },
    sessionRestricted: false, sampleHat: null, liveSampleBackend: false, signOut: state.signOut, signOutError: state.signOutError, signOutBusy: false,
    sampleEntryBusy: false, retrySessionAuthentication: vi.fn(async () => true), deleteAccount: state.deleteAccount,
    updatePassword: state.updatePassword, stepUpWithPassword: state.stepUpWithPassword,
  }),
}));
const { MemberSessionsUnavailableError } = await import('../services/memberSessions');
const { NativeSessionsCard } = await import('./NativeSessionsCard');
const { NativeAccountDeletion } = await import('./NativeAccountDeletion');
const { PasswordChangeCard } = await import('./PasswordChangeCard');
const { nativeUiSpanish } = await import('../lib/nativeUiCopy');
const { NEW_PASSWORD_MIN, NEW_PASSWORD_RULE, NEW_PASSWORD_TOO_SHORT } = await import('../../../../src/lib/passwordPolicy.js');
const { signOutFailureMessage } = await import('../services/signOutFailure');
const catalogue: Record<string, string> = nativeUiSpanish;
const es = (english: string): string => {
  const spanish = catalogue[english];
  if (spanish === undefined) throw new Error(`No Spanish for: ${english}`);
  return spanish;
};

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.language = 'es'; state.signOutError = null; state.proof = 'current'; vi.clearAllMocks();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (label: string) => {
  const found = Array.from(container.querySelectorAll('button')).find((element) => element.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const labels = () => Array.from(container.querySelectorAll('[aria-label]')).map((element) => element.getAttribute('aria-label'));
const type = async (label: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing field: ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => { setter?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const ROW: MemberSessionRow = { handle: 'a'.repeat(64), deviceLabel: 'apple_mobile', browserLabel: 'safari', current: true, createdAt: null, lastActiveAt: '2026-11-11T17:00:00Z' };

describe.each(['ios', 'android'])('Account security in the saved worker language on %s', (platform) => {
  beforeEach(() => { state.platform = platform; });

  // The final delete button names the exact phrase while any other
  // text is typed; a stray press deletes nothing; an uncertain result has no reason.
  it('hands Permanently delete my account the phrase it needs in Spanish', async () => {
    await act(async () => root.render(h(NativeAccountDeletion)));
    await act(async () => button(es('Delete my account')).click());
    const reason = () => button(es('Permanently delete my account')).getAttribute('data-disabled-reason');
    await type(es('Type DELETE MY ACCOUNT to confirm'), 'delete my account ');
    expect(button(es('Permanently delete my account')).disabled).toBe(true);
    expect(reason()).toBe(es('Type DELETE MY ACCOUNT to confirm.'));
    await act(async () => state.presses.get(es('Permanently delete my account'))!());
    expect(state.deleteAccount).not.toHaveBeenCalled();
    state.deleteAccount.mockRejectedValueOnce(new Error('account-delete-indeterminate'));
    await type(es('Type DELETE MY ACCOUNT to confirm'), 'DELETE MY ACCOUNT');
    expect(button(es('Permanently delete my account')).disabled).toBe(false);
    expect(reason()).toBeNull();
    await act(async () => button(es('Permanently delete my account')).click());
    expect(state.deleteAccount).toHaveBeenCalledTimes(1);
    expect(button(es('Permanently delete my account')).disabled).toBe(true);
    expect(reason()).toBeNull();
  });

  it('words the sessions panel in Spanish through failure, retry, rows and the sign-out-everywhere confirmation', async () => {
    state.sessions.mockRejectedValueOnce(new MemberSessionsUnavailableError('service', 'refused')).mockResolvedValueOnce([ROW]);
    await act(async () => root.render(h(NativeSessionsCard)));
    const text = () => container.textContent ?? '';
    expect(text()).toContain('Dónde tiene la sesión iniciada');
    expect(text()).toContain('No se pudieron cargar las sesiones');
    expect(text()).toContain('No se pudieron cargar sus sesiones porque el servicio rechazó la solicitud, no por su conexión.');
    await act(async () => button('Volver a cargar las sesiones').click());
    expect(state.sessions).toHaveBeenCalledTimes(2);
    expect(text()).toContain('iPhone o iPad: este dispositivo');
    expect(text()).toContain('Safari. Último uso:');
    expect(labels().some((label) => label?.startsWith('Este dispositivo. iPhone o iPad, Safari. Último uso:'))).toBe(true);
    await act(async () => button('Cerrar sesión en todas partes').click());
    expect(text()).toContain('¿Cerrar sesión en todas partes?');
    await act(async () => button('Mantener mi sesión').click());
    expect(state.signOut).not.toHaveBeenCalled();
    await act(async () => button('Cerrar sesión en todas partes').click());
    await act(async () => button('Sí, cerrar sesión en todas partes').click());
    // The boundary is unchanged: one global sign-out, nothing else.
    expect(state.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'global' });
    expect(text()).not.toMatch(/Where you are signed in|Sign out everywhere|this device/);
  });

  it('keeps DELETE MY ACCOUNT as the phrase to type and reports a refused password in Spanish', async () => {
    state.deleteAccount.mockRejectedValueOnce(new Error('reauth-failed'));
    await act(async () => root.render(h(NativeAccountDeletion)));
    expect(container.textContent).toContain('Eliminar su cuenta');
    await act(async () => button('Eliminar mi cuenta').click());
    expect(labels()).toEqual(expect.arrayContaining(['Su contraseña', 'Escriba DELETE MY ACCOUNT para confirmar']));
    expect(container.textContent).toContain('Escriba DELETE MY ACCOUNT para confirmar.');
    await type('Escriba DELETE MY ACCOUNT para confirmar', 'ELIMINAR MI CUENTA');
    expect(button('Eliminar mi cuenta para siempre').disabled).toBe(true);
    await type('Su contraseña', 'secret-value');
    await type('Escriba DELETE MY ACCOUNT para confirmar', 'DELETE MY ACCOUNT');
    expect(button('Eliminar mi cuenta para siempre').disabled).toBe(false);
    await act(async () => button('Eliminar mi cuenta para siempre').click());
    expect(state.deleteAccount).toHaveBeenCalledExactlyOnceWith('DELETE MY ACCOUNT', 'secret-value');
    expect(container.textContent).toContain('Esa contraseña no coincide. Revísela y vuelva a intentarlo.');
    expect(button('Cancelar')).toBeTruthy();
  });

  // Guidance and failures that
  // arrive as constants or thrown Errors follow the saved language too.
  it('words the password rule, the busy label and a refused current password in Spanish', async () => {
    const refused = 'Check your current password and try again. If you do not know it, use Forgot password on the sign-in screen.';
    let reject: (error: Error) => void = () => {};
    state.updatePassword.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await act(async () => root.render(h(PasswordChangeCard)));
    expect(container.textContent).toContain(NEW_PASSWORD_RULE.es);
    expect(container.textContent).not.toContain(NEW_PASSWORD_RULE.en);
    const password = 'p'.repeat(NEW_PASSWORD_MIN);
    await type(es('Current password'), 'old-secret');
    await type(es('New password'), password);
    await type(es('Confirm new password'), password);
    await act(async () => button(es('Change password')).click());
    expect(button(es('Changing…'))).toBeTruthy();
    await act(async () => reject(new Error(refused)));
    expect(container.textContent).toContain(es(refused));
    expect(container.textContent).not.toContain(refused);
  });

  // #9458 (M2-1): the too-short reason beside the field is in the saved language.
  it('says in Spanish why Change password stays unavailable for a short new password', async () => {
    await act(async () => root.render(h(PasswordChangeCard)));
    await type(es('New password'), 'p'.repeat(NEW_PASSWORD_MIN - 4));
    expect(container.textContent).toContain(NEW_PASSWORD_TOO_SHORT.es.replace('{count}', String(NEW_PASSWORD_MIN - 4)));
    expect(container.textContent).not.toContain('Too short');
  });

  it('shows the thrown length rule in the saved language', async () => {
    state.updatePassword.mockRejectedValueOnce(new Error(NEW_PASSWORD_RULE.en));
    await act(async () => root.render(h(PasswordChangeCard)));
    const password = 'p'.repeat(NEW_PASSWORD_MIN);
    await type(es('Current password'), 'old-secret');
    await type(es('New password'), password);
    await type(es('Confirm new password'), password);
    // The card already shows the rule as guidance; count it before and after
    // so the assertion is about the failure line alone.
    const ruleCount = () => (container.textContent ?? '').split(NEW_PASSWORD_RULE.es).length - 1;
    const before = ruleCount();
    await act(async () => button(es('Change password')).click());
    expect(ruleCount()).toBe(before + 1);
    expect(container.textContent).not.toContain(NEW_PASSWORD_RULE.en);
  });

  it('shows a failed sign-out everywhere in Spanish', async () => {
    state.signOutError = signOutFailureMessage('service', { serverSignOutPrepared: true, scope: 'global' });
    state.sessions.mockResolvedValueOnce([ROW]);
    await act(async () => root.render(h(NativeSessionsCard)));
    expect(container.textContent).toContain(es(state.signOutError));
    expect(container.textContent).not.toContain('Sign out everywhere is incomplete');
  });

  it('keeps English for an English worker', async () => {
    state.language = 'en';
    state.sessions.mockResolvedValueOnce([ROW]);
    await act(async () => root.render(h(NativeSessionsCard)));
    expect(container.textContent).toContain('Where you are signed in');
    expect(container.textContent).toContain('iPhone or iPad — this device');
    expect(button('Sign out everywhere')).toBeTruthy();
  });
});

describe('Account messages that arrive as constants or thrown Errors have Spanish', () => {
  it('covers every sign-out failure variant, sign-in outcome and password-change failure', () => {
    const kinds: SignOutFailureKind[] = ['service', 'local', 'transport'];
    const scopes: SignOutScope[] = ['local', 'global'];
    const variants = kinds.flatMap((kind) => [true, false].flatMap((serverSignOutPrepared) =>
      scopes.map((scope) => signOutFailureMessage(kind, { serverSignOutPrepared, scope }))));
    const thrown = [
      'Sign-in is unavailable. Try again.', 'The sign-in request ended.', 'Sign in again.',
      'The secure mobile backend is not configured.', 'Enter your current password to change it.',
      'Check your current password and try again. If you do not know it, use Forgot password on the sign-in screen.',
      'For your security, sign out, sign in again, then try changing your password.',
      'Your password change could not be confirmed. Check your connection and try again.',
    ];
    for (const english of [...variants, ...thrown]) {
      expect(catalogue[english], english).toEqual(expect.any(String));
      expect(catalogue[english], english).not.toBe(english);
    }
  });
});
