// @vitest-environment jsdom
import { act, createElement as h, type FormEvent, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasswordChangeCard } from './PasswordChangeCard';
import { NEW_PASSWORD_MAX, NEW_PASSWORD_MIN, NEW_PASSWORD_RULE, NEW_PASSWORD_TOO_LONG, NEW_PASSWORD_TOO_SHORT } from '../../../../src/lib/passwordPolicy.js';

const api = vi.hoisted(() => ({
  updatePassword: vi.fn<(password: string, current: string) => Promise<void>>(),
  mode: 'authenticated' as 'authenticated' | 'booting' | 'preview' | 'signedOut',
  sessionRestricted: false,
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => api }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ foreground: '#111', border: '#333', input: '#fff', primary: '#111', destructive: '#900', appearance: 'light' }) }));
vi.mock('../components/ui', () => ({
  Card: ({ children }: PropsWithChildren) => h('section', null, children),
  Heading: ({ children }: PropsWithChildren) => h('h3', null, children),
  Body: ({ children }: PropsWithChildren) => h('p', null, children),
  Button: ({ label, disabled, disabledReason, onPress }: { label: string; disabled?: boolean; disabledReason?: string; onPress: () => void }) =>
    h('button', { disabled, 'data-disabled-reason': disabledReason || undefined, onClick: onPress }, label),
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children, accessibilityLiveRegion }: PropsWithChildren<{ accessibilityLiveRegion?: string }>) => h('div', { role: accessibilityLiveRegion ? 'status' : undefined }, children),
  Text: ({ children }: PropsWithChildren) => h('span', null, children),
  TextInput: ({ accessibilityLabel, accessibilityHint, editable, autoComplete, maxLength, value, onChangeText }: {
    accessibilityLabel: string; accessibilityHint?: string; editable: boolean; autoComplete: string; maxLength?: number; value: string; onChangeText: (value: string) => void;
  }) => h('input', { 'aria-label': accessibilityLabel, 'aria-description': accessibilityHint, disabled: !editable, autoComplete, maxLength, value,
    onInput: (event: FormEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value) }),
}));

let root: Root;
let host: HTMLDivElement;
const field = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
const password = 'new local private passphrase 123';
async function fill(confirm = password) {
  const entries: Array<[string, string]> = [['Current password', 'old123'], ['New password', password], ['Confirm new password', confirm]];
  for (const [label, value] of entries) {
    await act(async () => { const input = field(label); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); });
  }
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.updatePassword.mockReset().mockResolvedValue(undefined);
  api.mode = 'authenticated'; api.sessionRestricted = false;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(PasswordChangeCard)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('native password-change outcomes', () => {
  const unavailableModes: Array<'booting' | 'preview' | 'signedOut'> = ['booting', 'preview', 'signedOut'];
  it.each(unavailableModes)('keeps controls unavailable in %s mode', async mode => {
    api.mode = mode;
    await act(async () => root.render(h(PasswordChangeCard)));
    expect(host.textContent).toBe('');
    expect(api.updatePassword).not.toHaveBeenCalled();
  });

  it('keeps controls unavailable for a restricted session', async () => {
    api.sessionRestricted = true;
    await act(async () => root.render(h(PasswordChangeCard)));
    expect(host.textContent).toBe('');
  });

  it.each([true, false])('retains the request and success across USER_UPDATED revalidation (finish while booting=%s)', async finishWhileBooting => {
    let finish!: () => void;
    api.updatePassword.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await fill();
    await act(async () => button('Change password').click());
    // AppProvider clears protected rows and sets mode=booting on USER_UPDATED.
    // Account keeps this state owner mounted for the same session user.
    api.mode = 'booting';
    await act(async () => root.render(h(PasswordChangeCard)));
    expect(host.textContent).toBe('');
    if (finishWhileBooting) await act(async () => finish());
    api.mode = 'authenticated';
    await act(async () => root.render(h(PasswordChangeCard)));
    if (!finishWhileBooting) {
      expect(button('Changing…').disabled).toBe(true);
      await act(async () => finish());
    }
    expect(api.updatePassword).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Your password was changed.');
    expect(button('Change password').disabled).toBe(true);
    // Account keys the state owner by user ID, so another account gets no old
    // proof or result even when this screen remains in the navigation stack.
    await act(async () => root.render(h(PasswordChangeCard, { key: 'different-account' })));
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(field('Current password').value).toBe('');
  });

  it('states the shared minimum beside each new-password field before typing', () => {
    expect(host.textContent).toContain(NEW_PASSWORD_RULE.en);
    for (const label of ['New password', 'Confirm new password']) {
      expect(field(label).getAttribute('aria-description')).toBe(NEW_PASSWORD_RULE.en);
      expect(field(label).parentElement?.textContent).toContain(NEW_PASSWORD_RULE.en);
      expect(field(label).maxLength).toBe(256);
    }
    expect(field('Current password').getAttribute('autocomplete')).toBe('current-password');
    expect(field('Current password').hasAttribute('maxlength')).toBe(false);
    expect(button('Change password').disabled).toBe(true);
  });

  // #9458 (M2-1), the phone twin of the web fix for #9448: the button stays
  // unavailable while the new password misses the length rule, and the field
  // says why, to sight and to a screen reader, with the policy's numbers.
  it('says beside the new-password field why Change password stays unavailable', async () => {
    const reasonFor = (value: string) => {
      const reason = value.length < NEW_PASSWORD_MIN ? NEW_PASSWORD_TOO_SHORT.en : NEW_PASSWORD_TOO_LONG.en;
      return reason.replace('{count}', String(value.length));
    };
    const type = async (label: string, value: string) => {
      await act(async () => { const input = field(label); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    await type('Current password', 'old123');
    const short = 'p'.repeat(NEW_PASSWORD_MIN - 4);
    await type('New password', short);
    await type('Confirm new password', short);
    expect(button('Change password').disabled).toBe(true);
    expect(button('Change password').getAttribute('data-disabled-reason')).toBe(reasonFor(short));
    expect(field('New password').parentElement?.textContent).toContain(reasonFor(short));
    expect(field('New password').getAttribute('aria-description')).toBe(`${reasonFor(short)} ${NEW_PASSWORD_RULE.en}`);
    // One reason, beside the field it is about; the confirmation keeps its rule.
    expect(host.textContent?.split(reasonFor(short)).length).toBe(2);
    expect(field('Confirm new password').getAttribute('aria-description')).toBe(NEW_PASSWORD_RULE.en);
    const long = 'p'.repeat(NEW_PASSWORD_MAX + 1);
    await type('New password', long);
    expect(field('New password').parentElement?.textContent).toContain(reasonFor(long));
    for (const value of ['', 'p'.repeat(NEW_PASSWORD_MIN)]) {
      await type('New password', value);
      expect(host.textContent).not.toContain('Too short');
      expect(host.textContent).not.toContain('Too long');
      expect(field('New password').getAttribute('aria-description')).toBe(NEW_PASSWORD_RULE.en);
    }
  });

  it('hands Change password the first unmet rule as its reason', async () => {
    const reason = () => button('Change password').getAttribute('data-disabled-reason');
    const type = async (label: string, value: string) => {
      await act(async () => { const input = field(label); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    expect(reason()).toBe('Enter your current password to change it.');
    await type('Current password', 'old123');
    expect(reason()).toBe(NEW_PASSWORD_RULE.en);
    await type('New password', password);
    await type('Confirm new password', 'short');
    expect(reason()).toBe('The passwords do not match.');
    await type('Confirm new password', password);
    expect(button('Change password').disabled).toBe(false);
    expect(reason()).toBeNull();
  });

  it('rejects a mismatch without calling Auth', async () => {
    await fill('another local private passphrase');
    await act(async () => button('Change password').click());
    expect(api.updatePassword).not.toHaveBeenCalled();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('The passwords do not match.');
  });

  it('serializes same-render presses and keeps a success until dismissal', async () => {
    let finish!: () => void;
    api.updatePassword.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await fill();
    await act(async () => { const submit = button('Change password'); submit.click(); submit.click(); });
    expect(api.updatePassword).toHaveBeenCalledTimes(1);
    expect(api.updatePassword).toHaveBeenCalledWith(password, 'old123');
    expect(field('Current password').disabled).toBe(true);
    await act(async () => finish());
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Your password was changed.');
    expect(field('Current password').value).toBe('');
    await act(async () => root.render(h(PasswordChangeCard)));
    expect(host.textContent).toContain('Your password was changed.');
    expect(button('Change password').disabled).toBe(true);
    await act(async () => button('Dismiss').click());
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(field('New password').disabled).toBe(false);
  });

  it.each([new Error('Your password change could not be confirmed.'), 'unavailable'])('replaces a refused outcome with one success on retry (%s)', async error => {
    api.updatePassword.mockRejectedValueOnce(error);
    await fill();
    await act(async () => button('Change password').click());
    expect(host.textContent).toContain('could not be confirmed');
    expect(field('Current password').value).toBe('');
    await fill();
    await act(async () => button('Change password').click());
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.textContent).toContain('Your password was changed.');
    expect(host.textContent).not.toContain('could not be confirmed');
  });
});
