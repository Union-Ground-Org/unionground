import { CATALOG_KEY_PATTERN } from "../../../../src/features/unionCatalog/catalogSearch.js";
import { parseEmailedAuthLink } from '../../../../src/lib/emailedAuthLink.js';
import { isFeatureKey, isStaffOnlyFeatureKey, type FeatureKey } from './featureCatalog';
import { APP_LINK_HOSTS } from './appLinkHosts';
import { isLegalPageKey, type LegalPageKey } from './legalDocuments';

export type AppRoute =
  | { kind: 'tab'; tab: 'home' | 'work' | 'compass' | 'campaign' | 'account' }
  | { kind: 'pulse' }
  | { kind: 'recognition' }
  | { kind: 'issue'; id: string }
  | { kind: 'offline' }
  | { kind: 'notifications' }
  | { kind: 'messages' }
  | { kind: 'conversation'; id: string }
  | { kind: 'channel'; id: string }
  | { kind: 'taskConversation'; id: string }
  | { kind: 'feature'; key: FeatureKey }
  | { kind: 'legal'; page: LegalPageKey }
  | { kind: 'publicUnions' }
  | { kind: 'publicUnion'; key: string }
  | { kind: 'swipe' }
  | { kind: 'shareIntake' }
  | { kind: 'emailAuth'; action: 'invitation' | 'passwordReset'; token: string }
  | { kind: 'authCallback'; code: string };

// Universal and App Links follow the policy app.config.ts registers
// (appLinkHosts.ts). While it is disabled no https link is accepted.
const universalLinkHosts: ReadonlySet<string> = new Set<string>(APP_LINK_HOSTS);
// The five dock roots. `compass` is the Guide tab's route name.
const allowedTabs = new Set(['home', 'work', 'compass', 'campaign', 'account']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxInboundRouteLength = 4096;
const maxAuthCodeLength = 2048;

// The app-relative path segments of a unionground:// link or a universal
// https://(sample.unionground.example|app.unionground.example)/app/ link; null for any other origin.
function appPathSegments(url: URL): string[] | null {
  const isCustom = url.protocol === 'unionground:';
  const isUniversal = url.protocol === 'https:' && universalLinkHosts.has(url.hostname);
  if (!isCustom && !isUniversal) return null;
  const parts = isCustom
    ? [url.hostname, ...url.pathname.split('/')]
    : url.pathname.split('/').slice(1);
  const path = parts.filter(Boolean);
  if (isUniversal && path.shift() !== 'app') return null;
  return path;
}

export function parseAppRoute(value: string): AppRoute | null {
  if (!value || value.length > maxInboundRouteLength || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const emailLink = parseEmailedAuthLink(value);
  if (emailLink?.token && (emailLink.kind === 'invitation' || emailLink.kind === 'passwordReset')) {
    return { kind: 'emailAuth', action: emailLink.kind, token: emailLink.token };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const path = appPathSegments(url);
  if (!path) return null;
  if (url.username || url.password || url.hash || /%2f/i.test(url.pathname)) return null;

  if (path[0] === 'auth' && path[1] === 'callback') {
    if (path.length !== 2 || [...url.searchParams.keys()].some((key) => key !== 'code')) return null;
    const codes = url.searchParams.getAll('code');
    const code = codes.length === 1 ? codes[0] : null;
    return code && code.length <= maxAuthCodeLength ? { kind: 'authCallback', code } : null;
  }

  if (url.search) return null;

  if (path.length === 1 && allowedTabs.has(path[0]!)) {
    return { kind: 'tab', tab: path[0] as Extract<AppRoute, { kind: 'tab' }>['tab'] };
  }

  if (path.length === 2 && path[0] === 'issue' && uuidPattern.test(path[1]!)) {
    return { kind: 'issue', id: path[1]! };
  }
  if (path.length === 1 && path[0] === 'offline') return { kind: 'offline' };
  if (path.length === 1 && path[0] === 'notifications') return { kind: 'notifications' };
  if (path.length === 1 && path[0] === 'messages') return { kind: 'messages' };
  if (path.length === 1 && path[0] === 'pulse') return { kind: 'pulse' };
  if (path.length === 1 && path[0] === 'recognition') return { kind: 'recognition' };
  // Links from Union Ground's earlier app named these as their own roots;
  // they now open the feature screens that replaced them.
  if (path.length === 1 && path[0] === 'rights') return { kind: 'feature', key: 'rights' };
  if (path.length === 1 && path[0] === 'meetings') return { kind: 'feature', key: 'events' };
  if (path.length === 2 && path[0] === 'conversation' && uuidPattern.test(path[1]!)) {
    return { kind: 'conversation', id: path[1]! };
  }
  if (path.length === 2 && path[0] === 'channel' && uuidPattern.test(path[1]!)) {
    return { kind: 'channel', id: path[1]! };
  }
  // The screen checks task access itself and refuses a missing task and an
  // unreadable one alike (REQ-UNION-GROUND-MOBILE-MEMBER-TASK-CONVERSATION-ENTRY-20261111).
  if (path.length === 2 && path[0] === 'task-conversation' && uuidPattern.test(path[1]!)) {
    return { kind: 'taskConversation', id: path[1]! };
  }
  if (path.length === 1 && path[0] === 'swipe') return { kind: 'swipe' };
  if (path.length === 2 && path[0] === 'feature' && isFeatureKey(path[1]!)) {
    return { kind: 'feature', key: path[1] };
  }
  if (path.length === 2 && path[0] === 'legal' && isLegalPageKey(path[1]!)) {
    return { kind: 'legal', page: path[1] };
  }
  if (path.length === 2 && path[0] === 'public' && path[1] === 'unions') return { kind: 'publicUnions' };
  if (path.length === 3 && path[0] === 'public' && path[1] === 'unions' && CATALOG_KEY_PATTERN.test(path[2]!)) return { kind: 'publicUnion', key: path[2]! };

  return null;
}

export function routeFromNotification(data: Record<string, unknown>): AppRoute | null {
  // The shared notification contract still names the record type 'case';
  // Union Ground opens it as an issue.
  if (data.screen === 'case' && typeof data.record_id === 'string' && uuidPattern.test(data.record_id)) {
    return { kind: 'issue', id: data.record_id };
  }
  if (data.screen === 'work') return { kind: 'tab', tab: 'work' };
  if (data.screen === 'campaign') return { kind: 'tab', tab: 'campaign' };
  if (data.screen === 'home') return { kind: 'tab', tab: 'home' };
  if (data.screen === 'notifications') return { kind: 'notifications' };
  if (data.screen === 'messages') return { kind: 'messages' };
  if (data.screen === 'conversation' && typeof data.record_id === 'string' && uuidPattern.test(data.record_id)) {
    return { kind: 'conversation', id: data.record_id };
  }
  if (data.screen === 'channel' && typeof data.record_id === 'string' && uuidPattern.test(data.record_id)) {
    return { kind: 'channel', id: data.record_id };
  }
  if (typeof data.screen === 'string' && isLegalPageKey(data.screen)) return { kind: 'legal', page: data.screen };
  if (typeof data.screen === 'string' && isFeatureKey(data.screen)) {
    if (isStaffOnlyFeatureKey(data.screen)) return null;
    return { kind: 'feature', key: data.screen };
  }
  return null;
}

/**
 * The app modes the index screen can observe while it decides where an
 * inbound intent goes. Mirrored from AppProvider's AppMode so this module
 * stays importable from tests that cannot load React Native.
 */
export type AppBootMode = 'booting' | 'signedOut' | 'mfaRequired' | 'authenticated' | 'preview';

/** File-route path for the Home tab. `/` is the index Redirect shell, not this screen. */
export const HOME_TAB_PATH = '/(tabs)/home';


/**
 * Where the index screen sends the member after a launch that resolved to `/`
 * (no inbound intent, or a URL that is not an unresolved custom-scheme host).
 * `null` means booting, where the index screen renders its own spinner.
 * Signed out on a device that has never left Welcome, that is Welcome
 * (REQ-UG-NATIVE-WELCOME-SCREEN-ON-FIRST-OPEN-20261115). Deep links,
 * callbacks and sign-out never come through here, so they never meet it.
 */
export function indexRedirectPath(mode: AppBootMode): string | null {
  if (mode === 'booting') return null;
  if (mode === 'mfaRequired') return '/mfa-challenge';
  if (mode === 'signedOut') return '/sign-in';
  return HOME_TAB_PATH;
}

// A sign-in link addressed to auth/callback that parseAppRoute turned away:
// a session in the fragment (GoTrue's implicit flow), extra parameters, an
// unusable code, or the auth server's error answer. Only the address is
// inspected here. The intent layer opens the callback screen for it through
// refusedAuthCallbackPath: the bare path ("Sign-in link unavailable") for most
// links, and one fixed query for an error answer, never the link's own values
// (UX-UG-NATIVE-REJECTED-SIGN-IN-LINK-SAYS-NOTHING-20261111).
const maxRefusedCallbackLength = 16_384;

export function isRefusedAuthCallbackLink(value: string): boolean {
  if (!value || value.length > maxRefusedCallbackLength || parseAppRoute(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const path = appPathSegments(url);
  return path?.length === 2 && path[0] === 'auth' && path[1] === 'callback';
}

// UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117 (tooling
// ledger 18): an expired or already-used link comes back from the auth server
// as auth/callback with only its error parameters (error, error_code and
// error_description) and no code. Supabase's PKCE error redirect writes them
// to the query AND the fragment (the fragment may end with its bare `sb`
// marker), and the implicit flow writes them to the fragment alone. The
// callback screen then says the link expired or was already used rather than
// that it is incomplete. It gets this fixed query, never the link's own
// values. Any other refused link (a session or any other key in the fragment,
// a code or any other key in the query, credentials) opens the bare callback
// screen as before.
export const REJECTED_AUTH_CALLBACK_PATH = '/auth/callback?error=access_denied&error_code=otp_expired';
const authErrorKeys: ReadonlySet<string> = new Set(['error', 'error_code', 'error_description']);

function authErrorParts(params: URLSearchParams, allowMarker: boolean): { valid: boolean; names: boolean } {
  let names = false;
  for (const [key, value] of params) {
    if (key === 'error' || key === 'error_code') names = true;
    else if (!authErrorKeys.has(key) && !(allowMarker && key === 'sb' && value === '')) return { valid: false, names: false };
  }
  return { valid: true, names };
}

export function refusedAuthCallbackPath(value: string): '/auth/callback' | typeof REJECTED_AUTH_CALLBACK_PATH {
  if (!isRefusedAuthCallbackLink(value)) return '/auth/callback';
  const url = new URL(value);
  if (url.username || url.password) return '/auth/callback';
  const query = authErrorParts(url.searchParams, false);
  const fragment = authErrorParts(new URLSearchParams(url.hash.slice(1)), true);
  return query.valid && fragment.valid && (query.names || fragment.names) ? REJECTED_AUTH_CALLBACK_PATH : '/auth/callback';
}

/**
 * Unresolved `unionground://…` hosts must land on the Home tab, not `/`.
 * `/` has no content route (`appRouteFromRouterPath('/')` is null) and dumps as
 * chrome with zero text — the G6 blank hierarchy. Empty `unionground://` launches
 * stay on `/` so the index spinner still owns ordinary boot.
 * BUG-UG-MOBILE-UNKNOWN-SCHEME-ROUTE-DEAD-END-20260905.
 */
export function unresolvedCustomSchemeHomePath(value: string): string | null {
  if (!value || value.length > maxInboundRouteLength || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'unionground:') return null;
  const parts = [url.hostname, ...url.pathname.split('/')].filter(Boolean);
  return parts.length > 0 ? HOME_TAB_PATH : null;
}

export function isPublicAppRoute(route: AppRoute | null): boolean {
  return route?.kind === 'offline'
    || route?.kind === 'publicUnions'
    || route?.kind === 'publicUnion'
    || route?.kind === 'legal';
}

export function routerPath(route: AppRoute): string | null {
  if (route.kind === 'tab') return route.tab === 'home' ? '/(tabs)/home' : `/${route.tab}`;
  if (route.kind === 'issue') return `/issue/${route.id}`;
  if (route.kind === 'offline') return '/offline';
  if (route.kind === 'notifications') return '/notifications';
  if (route.kind === 'messages') return '/messages';
  if (route.kind === 'pulse') return '/pulse';
  if (route.kind === 'recognition') return '/recognition';
  if (route.kind === 'conversation') return `/conversation/${route.id}`;
  if (route.kind === 'channel') return `/channel/${route.id}`;
  if (route.kind === 'taskConversation') return `/task-conversation/${route.id}`;
  if (route.kind === 'feature') return `/feature/${route.key}`;
  if (route.kind === 'legal') return `/legal/${route.page}`;
  if (route.kind === 'publicUnions') return '/public/unions';
  if (route.kind === 'publicUnion') return `/public/unions/${route.key}`;
  if (route.kind === 'swipe') return '/swipe';
  if (route.kind === 'shareIntake') return '/share-intake';
  return null;
}

export function appRouteFromRouterPath(pathname: string): AppRoute | null {
  const path = pathname.split('?')[0]?.split('/').filter(Boolean) ?? [];
  const normalized = path[0] === '(tabs)' ? path.slice(1) : path;
  if (normalized.length === 1 && allowedTabs.has(normalized[0]!)) {
    return { kind: 'tab', tab: normalized[0] as Extract<AppRoute, { kind: 'tab' }>['tab'] };
  }
  if (normalized.length === 2 && normalized[0] === 'issue' && uuidPattern.test(normalized[1]!)) {
    return { kind: 'issue', id: normalized[1]! };
  }
  if (normalized.length === 1 && normalized[0] === 'offline') return { kind: 'offline' };
  if (normalized.length === 1 && normalized[0] === 'notifications') return { kind: 'notifications' };
  if (normalized.length === 1 && normalized[0] === 'messages') return { kind: 'messages' };
  if (normalized.length === 1 && normalized[0] === 'pulse') return { kind: 'pulse' };
  if (normalized.length === 1 && normalized[0] === 'recognition') return { kind: 'recognition' };
  if (normalized.length === 2 && normalized[0] === 'conversation' && uuidPattern.test(normalized[1]!)) {
    return { kind: 'conversation', id: normalized[1]! };
  }
  if (normalized.length === 2 && normalized[0] === 'channel' && uuidPattern.test(normalized[1]!)) {
    return { kind: 'channel', id: normalized[1]! };
  }
  if (normalized.length === 2 && normalized[0] === 'task-conversation' && uuidPattern.test(normalized[1]!)) {
    return { kind: 'taskConversation', id: normalized[1]! };
  }
  if (normalized.length === 1 && normalized[0] === 'swipe') return { kind: 'swipe' };
  if (normalized.length === 1 && normalized[0] === 'share-intake') return { kind: 'shareIntake' };
  if (normalized.length === 2 && normalized[0] === 'feature' && isFeatureKey(normalized[1]!)) {
    return { kind: 'feature', key: normalized[1] };
  }
  if (normalized.length === 2 && normalized[0] === 'legal' && isLegalPageKey(normalized[1]!)) {
    return { kind: 'legal', page: normalized[1] };
  }
  if (normalized.length === 2 && normalized[0] === 'public' && normalized[1] === 'unions') return { kind: 'publicUnions' };
  if (normalized.length === 3 && normalized[0] === 'public' && normalized[1] === 'unions' && CATALOG_KEY_PATTERN.test(normalized[2]!)) return { kind: 'publicUnion', key: normalized[2]! };
  return null;
}
