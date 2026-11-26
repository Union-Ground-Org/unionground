import { describe, expect, it, vi } from 'vitest';

// TEST-UG-CONTRACT-CHECKS-A-FALLBACK-CANNOT-SATISFY-20261111 (#8324):
// the phone had no language coverage check. The screens below merge Spanish
// over English (`{ ...COPY.en, ...COPY.es }`), so a missing Spanish string
// silently shows English. This reads each table's own Spanish entries: an
// entry that is missing, empty, the English text again, or the raw key is a
// gap. Gaps are listed by key and the list can only shrink. The native app is
// not required to be Spanish (owner ruling, Sep 20, 2026); the list records
// what it shows in English to a Spanish-language member.
const stub = vi.hoisted(() => (extra: Record<string, unknown> = {}) => new Proxy(extra, {
  get: (target, key) => (key in target ? target[key as string] : key === '__esModule' ? true : key === 'then' ? undefined : String(key)),
  has: () => true,
}));
vi.mock('react-native', () => stub({ StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }, Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default } }));
vi.mock('expo-router', () => stub());
vi.mock('expo-secure-store', () => stub());
vi.mock('expo-linking', () => stub());
vi.mock('expo-constants', () => stub({ default: { expoConfig: { extra: {} } } }));
vi.mock('@expo/vector-icons', () => stub());
vi.mock('react-native-safe-area-context', () => stub());
vi.mock('@supabase/supabase-js', () => stub());
vi.mock('../../../../api/_lib/observability.js', () => ({ captureServerFailure: () => false }));
vi.mock('./config', () => ({ mobileConfig: { backendConfigured: false, supabaseUrl: 'https://example.invalid', portalBaseUrl: 'https://app.unionground.example' } }));
vi.mock('./secureSessionStorage', () => stub());
vi.mock('../services/emailAuth', () => stub());
vi.mock('../services/supabase', () => stub());
vi.mock('../state/AppProvider', () => stub());
vi.mock('../theme/ThemeProvider', () => stub());
vi.mock('../components/ui', () => stub());
vi.mock('../components/SupportLink', () => stub());
vi.mock('../../modules/store-age-signal/src/StoreAgeSignalModule', () => stub());

import { COPY as SIGN_IN_COPY, LINK_COPY as SIGN_IN_LINK_COPY } from '../components/EmailAuthScreen';
import { COPY as PASSWORD_RESET_COPY } from '../components/PasswordResetRequest';
import { MESSAGE_FILTERS } from './messageInbox';
import { messageInboxCopy } from './messageInboxCopy';
import { notificationCopy } from './notificationCopy';
import { supportLinkCopy } from './supportContact';

type Table = { en: unknown; es?: unknown };

// The first screens a new member meets: sign-in and its private-link states,
// the password reset request, the help link on both, notification set-up and
// the Messages tab.
const FIRST_SCREENS: Record<string, Table> = {
  'sign-in': SIGN_IN_COPY,
  'sign-in-link': { en: SIGN_IN_LINK_COPY },
  'password-reset': PASSWORD_RESET_COPY,
  'support-link': supportLinkCopy,
  notifications: notificationCopy,
  messages: messageInboxCopy,
};

// A function entry is compared by what it returns for every sample call:
// singular and plural counts, and each message filter with both counts, so a
// Spanish singular or per-filter arm that falls back to English is a gap.
const SAMPLE_CALLS: unknown[][] = [
  [0], [1], [2], ['Tamarack'],
  ...MESSAGE_FILTERS.flatMap((filter) => [[filter, 'Tamarack', 1, false], [filter, 'Tamarack', 2, true]]),
];
function samples(value: unknown): unknown[] {
  if (typeof value !== 'function') return [value];
  return SAMPLE_CALLS.map((args) => {
    try { return (value as (...args: unknown[]) => unknown)(...args); } catch { return undefined; }
  });
}

function gaps(tables: Record<string, Table>): string[] {
  const out: string[] = [];
  const walk = (screen: string, path: string[], en: unknown, es: unknown) => {
    if (en && typeof en === 'object') {
      for (const key of Object.keys(en)) {
        const spanish = es && typeof es === 'object' && Object.hasOwn(es, key) ? (es as Record<string, unknown>)[key] : undefined;
        walk(screen, [...path, key], (en as Record<string, unknown>)[key], spanish);
      }
      return;
    }
    const key = path.join('.');
    const english = samples(en);
    const spanish = typeof es === typeof en ? samples(es) : english.map(() => undefined);
    const gap = english.some((text, index) => {
      if (typeof text !== 'string' || !text.trim()) return false;
      const other = spanish[index];
      return typeof other !== 'string' || !other.trim() || other === text || other === key || other === path.at(-1);
    });
    if (gap) out.push(`${screen}:${key}`);
  };
  for (const [screen, table] of Object.entries(tables)) walk(screen, [], table.en, table.es);
  return out.sort();
}

// What these screens show in English to a Spanish-language member today
// (Nov 11, 2026). A key that gains Spanish must leave the list; nothing may join.
const ENGLISH_ONLY = [
  // The private-link outcomes render in English for every member language
  // (EmailAuthScreen, LINK_COPY).
  'sign-in-link:accepted', 'sign-in-link:invitationPassword', 'sign-in-link:linkInvalidInvitation',
  'sign-in-link:linkInvalidReset', 'sign-in-link:linkInvalidUnknown', 'sign-in-link:linkInvalidUnknownNoReset',
  'sign-in-link:newResetLink', 'sign-in-link:noAdministrator', 'sign-in-link:passwordMissing', 'sign-in-link:resetPassword',
  // The recovery-code steps of the reset screen.
  'sign-in:completedRecovery', 'sign-in:recovery-held', 'sign-in:recovery-incomplete', 'sign-in:recovery-rejected',
  'sign-in:recovery-unfinished', 'sign-in:recoveryCode', 'sign-in:recoveryIntro', 'sign-in:useAuthenticator', 'sign-in:useRecovery',
];

describe('first-screen Spanish coverage (phone)', () => {
  it('reads every listed screen', () => {
    for (const [screen, table] of Object.entries(FIRST_SCREENS)) expect(Object.keys(table.en as object).length, screen).toBeGreaterThan(2);
  });

  it('shows Spanish for every string on the listed first screens, apart from the listed gaps', () => {
    expect(gaps(FIRST_SCREENS).filter((key) => !ENGLISH_ONLY.includes(key))).toEqual([]);
  });

  it('lists only strings that are still English-only, so the list can only shrink', () => {
    expect(ENGLISH_ONLY.filter((key) => !gaps(FIRST_SCREENS).includes(key))).toEqual([]);
    expect(new Set(ENGLISH_ONLY).size).toBe(ENGLISH_ONLY.length);
    expect(ENGLISH_ONLY.length).toBeLessThanOrEqual(19);
  });

  it('fails on seeded violations that the merged lookup would hide', () => {
    const en = { title: 'Messages', unread: (count: number) => `${count} unread`, nested: { empty: 'No messages yet' } };
    // Each of these still shows text through `{ ...en, ...es }`.
    const seeded = {
      missing: { en, es: { unread: (count: number) => `${count} sin leer`, nested: { empty: 'Aún no hay mensajes' } } },
      english: { en, es: { title: 'Messages', unread: (count: number) => `${count} sin leer`, nested: { empty: 'Aún no hay mensajes' } } },
      rawKey: { en, es: { title: 'Mensajes', unread: (count: number) => `${count} sin leer`, nested: { empty: 'empty' } } },
      sameFunction: { en, es: { title: 'Mensajes', unread: en.unread, nested: { empty: 'Aún no hay mensajes' } } },
      // Plural translated, singular left in English.
      singular: { en, es: { title: 'Mensajes', unread: (count: number) => (count === 1 ? '1 unread' : `${count} sin leer`), nested: { empty: 'Aún no hay mensajes' } } },
      translated: { en, es: { title: 'Mensajes', unread: (count: number) => `${count} sin leer`, nested: { empty: 'Aún no hay mensajes' } } },
    };
    expect(gaps(seeded)).toEqual(['english:title', 'missing:title', 'rawKey:nested.empty', 'sameFunction:unread', 'singular:unread']);
    expect({ ...seeded.missing.en, ...seeded.missing.es }.title).toBe('Messages');
  });
});
