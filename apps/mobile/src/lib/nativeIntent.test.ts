import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Universal links are off in the shipped policy. These suites enable one
// fictional verified domain and prove the sibling product's hosts stay refused.
vi.mock('./appLinkHosts', () => ({ APP_LINK_HOSTS: Object.freeze(['app.unionground.example']) }));

import {
  appRouteFromRouterPath,
  HOME_TAB_PATH,
  indexRedirectPath,
  isRefusedAuthCallbackLink,
  REJECTED_AUTH_CALLBACK_PATH,
  type AppBootMode,
} from '../lib/routes';
import { AUTH_CALLBACK_INITIAL_STATE, authCallbackScreenModel, type AuthCallbackMode } from '../lib/authCallbackRecovery';
import { redirectSystemPath } from '../../app/+native-intent';

// The five unknown top-level custom-scheme routes the G6 drill probed
// (external-artifact-dir/android-drill/candidate/dumps/route-unionbase__*.xml).
// Each dumped a chrome-only blank hierarchy because the resolver returned `/`,
// which is the index Redirect shell (`appRouteFromRouterPath('/')` is null),
// not a screen with content. The intent layer now returns the Home tab path.
const probedUnknownRoutes = [
  'unionground://auth',
  'unionground://login',
  'unionground://preview_exit',
  'unionground://sign-in',
  'unionground://sign-out',
];

describe('native inbound intent redirect', () => {
  it.each([true, false])('sends store-account provider callbacks Home without any code exchanger (initial=%s)', (initial) => {
    // Union Ground offers no provider sign-in, so no route consumes the code.
    for (const query of ['code=private-code', 'error=access_denied&error_description=private-detail', 'code=one&code=two']) {
      const target = redirectSystemPath({ path: `unionground://auth/provider-callback?${query}`, initial });
      expect(target).toBe('/(tabs)/home');
      expect(target).not.toContain('private');
    }
    expect(redirectSystemPath({ path: 'https://attacker.example/auth/provider-callback?code=private-code', initial }))
      .toBe('/');
  });
  it('maps only validated app routes', () => {
    expect(redirectSystemPath({ path: 'https://app.unionground.example/app/messages', initial: true })).toBe('/messages');
    expect(redirectSystemPath({ path: 'https://app.unionground.example/app/auth/callback?code=one%2Btime', initial: true }))
      .toBe('/auth/callback?code=one%2Btime');
    expect(redirectSystemPath({ path: 'unionground://os-quick-action/work', initial: false }))
      .toBe('/os-quick-action/work');
  });

  it('falls back without echoing malformed or unsupported input', () => {
    expect(redirectSystemPath({ path: 'https://attacker.example/app/messages', initial: true })).toBe('/');
    expect(redirectSystemPath({ path: 'https://app.unionground.example/app/home?next=attacker', initial: false })).toBe('/');
    expect(redirectSystemPath({ path: 'not a URL', initial: false })).toBe('/');
    expect(redirectSystemPath({ path: 'unionground://os-quick-action/work?case=one', initial: false }))
      .toBe(HOME_TAB_PATH);
  });
});

describe('unknown top-level custom-scheme routes land on Home content', () => {
  it('does not treat `/` as a content route — that is the blank index shell', () => {
    expect(appRouteFromRouterPath('/')).toBeNull();
    expect(appRouteFromRouterPath(HOME_TAB_PATH)).toEqual({ kind: 'tab', tab: 'home' });
  });

  it.each(probedUnknownRoutes)('%s resolves to the Home tab screen, not the index shell', (path) => {
    const resolved = redirectSystemPath({ path, initial: true });
    expect(resolved).toBe(HOME_TAB_PATH);
    expect(resolved).not.toBe('/');
    expect(resolved).not.toContain(path.replace('unionground://', ''));
    expect(appRouteFromRouterPath(resolved)).toEqual({ kind: 'tab', tab: 'home' });
  });

  it('covers arbitrary unrecognized top-level segments, not just the probed five', () => {
    for (const segment of ['messages-old', 'case-folders', 'settings', 'x'.repeat(64)]) {
      expect(redirectSystemPath({ path: `unionground://${segment}`, initial: false })).toBe(HOME_TAB_PATH);
      expect(redirectSystemPath({ path: `unionground://${segment}/nested`, initial: true })).toBe(HOME_TAB_PATH);
    }
  });

  it('keeps an empty custom-scheme launch on `/` so ordinary boot still uses the index spinner', () => {
    expect(redirectSystemPath({ path: 'unionground://', initial: true })).toBe('/');
    expect(redirectSystemPath({ path: 'unionground:///', initial: true })).toBe('/');
  });

  it('never selects an empty destination for any boot mode', () => {
    // Booting renders the index spinner — a visible node, not an empty hierarchy.
    expect(indexRedirectPath('booting')).toBeNull();
    const decidedModes: AppBootMode[] = ['signedOut', 'mfaRequired', 'authenticated', 'preview'];
    for (const mode of decidedModes) {
      const destination = indexRedirectPath(mode);
      expect(destination).not.toBeNull();
      expect(destination).not.toBe('/');
      expect(destination).toMatch(/^\/(sign-in|mfa-challenge|\(tabs\)\/home)$/);
    }
  });

  it('index screen holds the spinner until the navigator is mounted, then redirects', () => {
    const indexSource = readFileSync(fileURLToPath(new URL('../../app/index.tsx', import.meta.url)), 'utf8');
    expect(indexSource).toContain('indexRedirectPath(mode)');
    expect(indexSource).toContain('if (destination === null || !navigatorReady || !rootNavigatorIsReady(navigationRef))');
    expect(indexSource).toContain('<ActivityIndicator');
    expect(indexSource).toMatch(/<Redirect href=\{destination\} \/>/);
  });
});

// UX-UG-NATIVE-REJECTED-SIGN-IN-LINK-SAYS-NOTHING-20261111: an
// emailed sign-in link that carried the session in its fragment (GoTrue's
// implicit flow) was refused and sent Home, so a signed-out member saw the
// sign-in screen with no word about the link.
const fragmentSession = 'access_token=header.payload.signature&expires_in=3600&refresh_token=private-refresh&token_type=bearer&type=magiclink';
const refusedCallbackLinks = [
  `unionground://auth/callback#${fragmentSession}`,
  `https://app.unionground.example/app/auth/callback#${fragmentSession}`,
  `unionground://auth/callback?code=one-time#${fragmentSession}`,
  'unionground://auth/callback?code=one&code=two',
  // An error beside anything else (a code, a fragment, another key) stays bare.
  'unionground://auth/callback?error=access_denied&code=one-time',
  `unionground://auth/callback?error=access_denied&error_code=otp_expired#${fragmentSession}`,
  'unionground://auth/callback?error=access_denied&redirect_to=https%3A%2F%2Fattacker.example',
  'unionground://auth/callback?error_description=private-detail',
  // An error fragment that also carries a session or any other key, a marker
  // with a value, or a marker alone, stays bare (r1s1 and r2s1 of #9062 round 1).
  'unionground://auth/callback?error=access_denied#error=access_denied&refresh_token=private-refresh',
  'unionground://auth/callback#error=access_denied&access_token=header.payload.signature',
  'unionground://auth/callback?error=access_denied&error_code=otp_expired#state=private-state',
  'unionground://auth/callback#error=access_denied&sb=private',
  'unionground://auth/callback#sb',
];

describe('a sign-in link the app turns away shows "Sign-in link unavailable"', () => {
  it.each(refusedCallbackLinks)('%s opens the bare callback screen and carries nothing from the link', (link) => {
    expect(isRefusedAuthCallbackLink(link)).toBe(true);
    for (const initial of [true, false]) {
      const resolved = redirectSystemPath({ path: link, initial });
      expect(resolved).toBe('/auth/callback');
      expect(resolved).not.toMatch(/[?#]/);
    }
  });

  it.each<AuthCallbackMode>(['booting', 'signedOut', 'mfaRequired', 'authenticated', 'preview'])(
    'the callback screen without a code shows the notice with a way out and starts no exchange (mode %s)',
    (mode) => {
      // What app/auth/callback.tsx renders for `/auth/callback`: no code
      // parameter, so hasCode is false and the exchange effect returns early.
      const model = authCallbackScreenModel({ hasCode: false, state: AUTH_CALLBACK_INITIAL_STATE, mode, language: 'en' });
      expect(model.kind).toBe('recovery');
      if (model.kind !== 'recovery') return;
      expect(model.title).toBe('Sign-in link unavailable');
      expect(model.body).toContain('Request a new one.');
      expect(model.buttons.length).toBeGreaterThan(0);
      if (mode === 'signedOut' || mode === 'booting') {
        expect(model.buttons.map((button) => button.effect)).toEqual([{ kind: 'navigate', href: '/sign-in' }]);
      }
    },
  );

  // UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117 (tooling
  // The auth server sends an
  // expired or used link back with only its error parameters. The intent layer
  // used to strip them, so the screen still said "incomplete".
  // Supabase's PKCE error redirect writes the error to the query and the
  // fragment, the fragment ending with its bare `sb` marker; the implicit flow
  // writes it to the fragment alone (r1s1 and r2s1 of #9062 round 1).
  const expiredError = 'error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
  it.each([
    'unionground://auth/callback?error=access_denied&error_code=otp_expired',
    `unionground://auth/callback?${expiredError}`,
    `unionground://auth/callback?${expiredError}#${expiredError}&sb`,
    `unionground://auth/callback?${expiredError}#${expiredError}`,
    `unionground://auth/callback#${expiredError}&sb`,
    `unionground://auth/callback#${expiredError}`,
    `https://app.unionground.example/app/auth/callback?${expiredError}#${expiredError}&sb`,
    'https://app.unionground.example/app/auth/callback?error_code=otp_expired',
  ])('%s opens the callback screen with one fixed query and reaches the expired-link message', (link) => {
    for (const initial of [true, false]) {
      const resolved = redirectSystemPath({ path: link, initial });
      // Fixed: none of the link's own values travel on.
      expect(resolved).toBe(REJECTED_AUTH_CALLBACK_PATH);
      expect(resolved).not.toMatch(/private|Email|#|[?&]code=/);
      // What app/auth/callback.tsx reads from that route.
      const params = new URL(resolved, 'https://route.invalid').searchParams;
      const modes: AuthCallbackMode[] = ['booting', 'signedOut', 'mfaRequired', 'authenticated'];
      for (const mode of modes) {
        const model = authCallbackScreenModel({
          hasCode: Boolean(params.get('code')),
          linkRejected: Boolean(params.get('error') || params.get('error_code')),
          state: AUTH_CALLBACK_INITIAL_STATE,
          mode,
          language: 'en',
        });
        expect(model).toMatchObject({ kind: 'recovery', reason: 'linkRejected', title: 'Sign-in link expired', body: 'This sign-in link has expired or was already used. Request a new one.' });
      }
    }
  });

  it('the callback screen exchanges only a code parameter, never a fragment', () => {
    const screen = readFileSync(fileURLToPath(new URL('../../app/auth/callback.tsx', import.meta.url)), 'utf8');
    // The error parameters an expired or used link carries only choose the
    // recovery wording; they are never exchanged.
    expect(screen).toContain("const params = useLocalSearchParams<{ code?: string; error?: string; error_code?: string }>();");
    expect(screen).toContain('const code = params.code;');
    expect(screen).toContain('linkRejected: Boolean(params.error || params.error_code),');
    expect(screen).toContain('if (!code) return;');
    expect(screen).toContain('hasCode: Boolean(code),');
    expect(screen).not.toMatch(/access_token|refresh_token|setSession|location\.hash/);
  });

  it('other refused deep links keep their Home fallback', () => {
    for (const link of [
      'unionground://auth/callbacks#x=1',
      'unionground://auth/callback/extra#x=1',
      'unionground://messages#x=1',
      'https://attacker.example/app/auth/callback#x=1',
      'https://app.unionground.example/auth/callback#x=1',
    ]) {
      expect(isRefusedAuthCallbackLink(link)).toBe(false);
      expect(redirectSystemPath({ path: link, initial: true })).not.toBe('/auth/callback');
    }
    expect(redirectSystemPath({ path: 'unionground://messages#x=1', initial: true })).toBe(HOME_TAB_PATH);
    expect(redirectSystemPath({ path: 'https://attacker.example/app/auth/callback#x=1', initial: true })).toBe('/');
  });

  it('a usable callback link still goes through the code exchange', () => {
    expect(isRefusedAuthCallbackLink('unionground://auth/callback?code=one-time')).toBe(false);
    expect(redirectSystemPath({ path: 'unionground://auth/callback?code=one-time', initial: true }))
      .toBe('/auth/callback?code=one-time');
  });
});
