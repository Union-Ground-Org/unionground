// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_RESET_KEY, RESET_STATE_LIFETIME_MS } from '../lib/pendingPasswordReset';
import { PendingPasswordResetCard } from './PendingPasswordResetCard';

// BUG-UG-AUTHENTICATED-NATIVE-RESET-RESUME-20261021: after an
// authenticated cold start the sign-in screen redirects to Home, so Account
// offers the saved reset. Only the keystore and native hosts are replaced; the
// real loadPendingReset decides expiry and damaged-record cleanup.
const fixture = vi.hoisted(() => ({
  keystore: new Map<string, string>(),
  signOut: vi.fn(async () => undefined),
  signOutBusy: false,
  focus: null as null | (() => (() => void) | void),
  signedIn: 'a1.AAAAAAAAAAAAAAAAAAAAAA' as string | null,
  tokens: [] as string[],
}));
const OWN = 'a1.AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'a1.BBBBBBBBBBBBBBBBBBBBBB';
vi.mock('./../lib/secureSessionStorage', () => ({ secureSessionStorage: {
  getItem: async (key: string) => fixture.keystore.get(key) ?? null,
  setItem: async (key: string, value: string) => { fixture.keystore.set(key, value); },
  removeItem: async (key: string) => { fixture.keystore.delete(key); },
} }));
vi.mock('expo-router', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => (() => void) | void) => { useEffect(() => { fixture.focus = effect; return effect(); }, [effect]); },
  };
});
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ session: { access_token: 'member-token' }, signOut: fixture.signOut, signOutBusy: fixture.signOutBusy }) }));
// The route's answer for the signed-in account (api/password-reset.js "account").
vi.mock('../services/emailAuth', () => ({ signedInResetAccount: async (token: string) => { fixture.tokens.push(token); return fixture.signedIn; } }));
vi.mock('../components/ui', () => {
  const Host = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const Button = ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => createElement('button', { onClick: onPress, disabled }, label);
  return { Body: Host, Card: Host, Heading: Host, Button };
});

let container: HTMLDivElement;
let root: Root;
const save = (expiresAt: number, account: string | null = OWN) => fixture.keystore.set(PENDING_RESET_KEY,
  JSON.stringify({ ticket: 't', status: 'enroll', state: 's', secret: 'k', expiresAt, ...(account ? { account } : {}) }));
const settle = async () => { await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }); };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.keystore.clear(); fixture.signOut.mockClear(); fixture.signOutBusy = false; fixture.focus = null;
  fixture.signedIn = OWN; fixture.tokens = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Account pending password reset', () => {
  // Finishing a reset ends this account's sessions,
  // and the record is not bound to an account, so the card never opens
  // the reset over a signed-in session; it signs out, and sign-in resumes it.
  it('offers a saved reset by signing out first, never by opening it over this session', async () => {
    save(Date.now() + RESET_STATE_LIFETIME_MS);
    act(() => root.render(createElement(PendingPasswordResetCard)));
    await settle();
    const button = container.querySelector('button');
    expect(button?.textContent).toBe('Sign out to finish the reset');
    expect(container.textContent).toContain('Continue resetting your password on the sign-in screen');
    await act(async () => { button?.click(); });
    await settle();
    expect(fixture.signOut).toHaveBeenCalledTimes(1);
    expect(fixture.signOut).toHaveBeenCalledWith();
    // The saved reset is left for the sign-in screen to offer.
    expect(fixture.keystore.has(PENDING_RESET_KEY)).toBe(true);
    expect(fixture.tokens).toEqual(['member-token', 'member-token']);
  });

  // Grok final on  (r2g1): another account's reset, or a record saved
  // before the account tag existed, must never sign this member out.
  it('shows nothing for a reset saved for another account', async () => {
    save(Date.now() + RESET_STATE_LIFETIME_MS, OTHER);
    act(() => root.render(createElement(PendingPasswordResetCard)));
    await settle();
    expect(container.textContent).toBe('');
    expect(fixture.keystore.has(PENDING_RESET_KEY)).toBe(true);
  });

  it('shows nothing for a saved reset that carries no account tag', async () => {
    save(Date.now() + RESET_STATE_LIFETIME_MS, null);
    act(() => root.render(createElement(PendingPasswordResetCard)));
    await settle();
    expect(container.textContent).toBe('');
    expect(fixture.tokens).toEqual([]);
  });

  it('shows nothing when the signed-in account tag cannot be read', async () => {
    save(Date.now() + RESET_STATE_LIFETIME_MS);
    fixture.signedIn = null;
    act(() => root.render(createElement(PendingPasswordResetCard)));
    await settle();
    expect(container.textContent).toBe('');
  });

  // Sol final on  (r2s P2): the press reads the record again, so a reset
  // that lapsed after focus hides the card and keeps the session.
  it('keeps the session when the reset lapsed between focus and the press', async () => {
    save(Date.now() + RESET_STATE_LIFETIME_MS);
    act(() => root.render(createElement(PendingPasswordResetCard)));
    await settle();
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    save(Date.now() - 1);
    await act(async () => { button?.click(); });
    await settle();
    expect(fixture.signOut).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('disables the sign-out while one is already running', async () => {
    save(Date.now() + RESET_STATE_LIFETIME_MS);
    fixture.signOutBusy = true;
    act(() => root.render(createElement(PendingPasswordResetCard)));
    await settle();
    expect(container.querySelector('button')?.disabled).toBe(true);
  });

  it('shows nothing when no reset was begun', async () => {
    act(() => root.render(createElement(PendingPasswordResetCard)));
    await settle();
    expect(container.textContent).toBe('');
  });

  it('shows nothing for an expired reset and removes the lapsed record', async () => {
    save(Date.now() - 1);
    act(() => root.render(createElement(PendingPasswordResetCard)));
    await settle();
    expect(container.textContent).toBe('');
    expect(fixture.keystore.has(PENDING_RESET_KEY)).toBe(false);
  });

  it('hides the card on the next focus once the reset screen has finished and cleared it', async () => {
    save(Date.now() + RESET_STATE_LIFETIME_MS);
    act(() => root.render(createElement(PendingPasswordResetCard)));
    await settle();
    expect(container.querySelector('button')).not.toBeNull();
    fixture.keystore.delete(PENDING_RESET_KEY);
    await act(async () => { fixture.focus?.(); });
    await settle();
    expect(container.querySelector('button')).toBeNull();
  });
});
