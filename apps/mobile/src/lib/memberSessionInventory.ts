// REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009: the pure half of the
// native Account > Sessions surface. It owns the shape the screen is allowed
// to show and the words it says, so both are testable without a renderer or a
// backend.
//
// `public.list_my_sessions()` already reduces every session to an opaque
// SHA-256 handle plus coarse device/browser labels and two timestamps; raw
// session ids, IP addresses, full user agents and refresh credentials never
// cross that boundary. This module keeps the native client on the same side of
// it: the normalizer copies the five fields below by name and nothing else, so
// a future server field — or a hostile response — cannot become a row the
// screen renders, and no value reaches the UI without passing its own check.

import { easternDateTime } from './evidenceTimestamp';
import { nativeCatalogLabel, nativeUiText, type NativeLanguage } from './nativeUiCopy';

/** A session row the Sessions screen may render. */
export type MemberSessionRow = {
  /** The server's opaque 64-hex equality handle. Never a vendor session id. */
  handle: string;
  deviceLabel: MemberSessionDeviceLabel;
  browserLabel: MemberSessionBrowserLabel;
  /** True for the session this app is signed in with, as the server decided. */
  current: boolean;
  createdAt: string | null;
  lastActiveAt: string | null;
};

const DEVICE_LABELS = {
  apple_mobile: 'iPhone or iPad',
  android_mobile: 'Android phone or tablet',
  windows_computer: 'Windows computer',
  apple_computer: 'Mac',
  linux_computer: 'Linux computer',
  signed_in_device: 'Signed-in device',
} satisfies Readonly<Record<string, string>>;

const BROWSER_LABELS = {
  edge: 'Microsoft Edge',
  firefox: 'Firefox',
  chrome: 'Chrome',
  safari: 'Safari',
  browser: 'Browser or app',
} satisfies Readonly<Record<string, string>>;

export type MemberSessionDeviceLabel = keyof typeof DEVICE_LABELS;
export type MemberSessionBrowserLabel = keyof typeof BROWSER_LABELS;

const HANDLE_PATTERN = /^[0-9a-f]{64}$/;

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function deviceLabel(value: string | null): MemberSessionDeviceLabel {
  return value !== null && Object.prototype.hasOwnProperty.call(DEVICE_LABELS, value)
    ? (value as MemberSessionDeviceLabel)
    : 'signed_in_device';
}

function browserLabel(value: string | null): MemberSessionBrowserLabel {
  return value !== null && Object.prototype.hasOwnProperty.call(BROWSER_LABELS, value)
    ? (value as MemberSessionBrowserLabel)
    : 'browser';
}

// A timestamp is kept only when it parses. An unparseable value becomes null
// and the row says the time is unavailable, rather than printing "Invalid
// Date" or a raw server string at a member.
function timestamp(value: string | null): string | null {
  if (value === null) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The server answer, reduced to the rows the screen may show. A payload that
 * is not an array is a refusal to be handled by the caller, signalled with
 * `null`; a row without a well-formed handle is dropped, because without it
 * the row cannot be identified and must not be presented as a session.
 */
export function normalizeMemberSessionRows(payload: unknown): MemberSessionRow[] | null {
  if (!Array.isArray(payload)) return null;
  const entries: unknown[] = payload;
  const rows: MemberSessionRow[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    const handle = readString(source, 'handle')?.toLowerCase() ?? null;
    if (handle === null || !HANDLE_PATTERN.test(handle) || seen.has(handle)) continue;
    seen.add(handle);
    rows.push({
      handle,
      deviceLabel: deviceLabel(readString(source, 'deviceLabel')),
      browserLabel: browserLabel(readString(source, 'browserLabel')),
      current: source.current === true,
      createdAt: timestamp(readString(source, 'createdAt')),
      lastActiveAt: timestamp(readString(source, 'lastActiveAt')),
    });
  }
  // The server already orders the current session first; re-assert it locally
  // so a reordered answer cannot bury the row the member is looking for.
  return rows.sort((left, right) => Number(right.current) - Number(left.current));
}

// Every visible and spoken line takes the member's saved language (#8303);
// English is the default, so the server-facing rules above are unchanged.
function activity(row: MemberSessionRow, language: NativeLanguage): string {
  const t = nativeUiText(language);
  const stamp = easternDateTime(row.lastActiveAt, language === 'es' ? 'es-US' : 'en-US');
  return stamp ? t('Last used {date}', { date: stamp }) : t('Last use unavailable');
}

const device = (row: MemberSessionRow, language: NativeLanguage) => nativeCatalogLabel(language, DEVICE_LABELS[row.deviceLabel]);
const browser = (row: MemberSessionRow, language: NativeLanguage) => nativeCatalogLabel(language, BROWSER_LABELS[row.browserLabel]);

/** The visible title of a row: device first, because that is what a member recognizes. */
export function memberSessionTitle(row: MemberSessionRow, language: NativeLanguage = 'en'): string {
  return row.current ? nativeUiText(language)('{device} — this device', { device: device(row, language) }) : `${device(row, language)}, ${browser(row, language)}`;
}

/** The visible second line. */
export function memberSessionDetail(row: MemberSessionRow, language: NativeLanguage = 'en'): string {
  return row.current
    ? `${browser(row, language)}. ${activity(row, language)}.`
    : `${activity(row, language)}.`;
}

/**
 * One spoken string per row. VoiceOver and TalkBack read a row as a single
 * item, so the device, the browser, whether it is this device and the last use
 * all belong in the label; the handle never does.
 */
export function memberSessionAccessibilityLabel(row: MemberSessionRow, language: NativeLanguage = 'en'): string {
  const here = row.current ? `${nativeUiText(language)('This device.')} ` : '';
  return `${here}${device(row, language)}, ${browser(row, language)}. ${activity(row, language)}.`;
}

export const MEMBER_SESSIONS_COPY = Object.freeze({
  title: 'Where you are signed in',
  body: 'Union Ground lists the sessions on your account that were used in the last eight hours. It shows the kind of device only — never a session key, a password or anyone else’s sessions. Sign out everywhere also ends sessions that are not listed.',
  loading: 'Loading your sessions…',
  emptyBody: 'The server reports no sessions used in the last eight hours. If you expected one, open the app on that device and check again.',
  failureTitle: 'Sessions could not be loaded',
  retry: 'Try loading sessions again',
  refresh: 'Refresh sessions',
  showMore: 'Show all sessions',
  collapse: 'Show fewer sessions',
  signOutEverywhere: 'Sign out everywhere',
  confirmTitle: 'Sign out everywhere?',
  confirmBody: 'This signs this device out and ends every other session on your account. Anyone using your account on another phone or computer has to sign in again. Saved offline copies on this device are cleared.',
  confirmAction: 'Yes, sign out everywhere',
  confirmCancel: 'Keep me signed in',
  working: 'Signing out everywhere…',
});

export type MemberSessionsCopy = { readonly [Key in keyof typeof MEMBER_SESSIONS_COPY]: string };

/** The card's fixed copy in the member's saved language. */
export function memberSessionsCopy(language: NativeLanguage = 'en'): MemberSessionsCopy {
  return Object.fromEntries(Object.entries(MEMBER_SESSIONS_COPY).map(([key, text]) => [key, nativeCatalogLabel(language, text)])) as MemberSessionsCopy;
}

/**
 * The failure line for the list. The two cases a worker can act on are named
 * apart: a request that never reached the service is worth retrying on a
 * better network, and a service that answered and refused is not. Nothing here
 * ever says the list is empty, because an unreadable list is not an empty one.
 */
export function memberSessionsFailureMessage(kind: 'transport' | 'service' | 'denied', language: NativeLanguage = 'en'): string {
  return nativeCatalogLabel(language, memberSessionsFailureEnglish(kind));
}

function memberSessionsFailureEnglish(kind: 'transport' | 'service' | 'denied'): string {
  if (kind === 'denied') {
    return 'Your sessions could not be loaded because this session is no longer accepted. Sign in again to see where you are signed in.';
  }
  if (kind === 'service') {
    return 'Your sessions could not be loaded because the service refused the request, not because of your connection. Try again shortly, and tell your campaign administrator if it keeps happening.';
  }
  return 'Your sessions could not be loaded because the request did not reach Union Ground. Reconnect and try again.';
}
