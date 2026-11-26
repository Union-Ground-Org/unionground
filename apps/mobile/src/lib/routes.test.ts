import { describe, expect, it, vi } from 'vitest';

// Universal links are off in the shipped policy. These suites enable one
// fictional verified domain and prove the sibling product's hosts stay refused.
vi.mock('./appLinkHosts', () => ({ APP_LINK_HOSTS: Object.freeze(['app.unionground.example']) }));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type AppRoute,
  appRouteFromRouterPath,
  HOME_TAB_PATH,
  isPublicAppRoute,
  parseAppRoute,
  routeFromNotification,
  routerPath,
  unresolvedCustomSchemeHomePath,
} from './routes';

const issueID = '33333333-3333-4333-8333-333333333333';
const channelID = '44444444-4444-4444-8444-444444444444';

describe('strict mobile routing', () => {
  it('allows known custom and universal routes', () => {
    expect(parseAppRoute('unionground://work')).toEqual({ kind: 'tab', tab: 'work' });
    for (const sibling of ['sibling-product.example', 'sibling-saas.example']) {
      expect(parseAppRoute(`https://${sibling}/app/notifications`)).toBeNull();
    }
    expect(parseAppRoute(`https://app.unionground.example/app/issue/${issueID}`)).toEqual({ kind: 'issue', id: issueID });
    expect(parseAppRoute(`unionground://issue/${issueID}`)).toEqual({ kind: 'issue', id: issueID });
    // A grievance case path is not a Union Ground destination.
    expect(parseAppRoute(`unionground://case/${issueID}`)).toBeNull();
    expect(parseAppRoute('https://app.unionground.example/app/notifications')).toEqual({ kind: 'notifications' });
    expect(parseAppRoute(`unionground://conversation/${issueID}`)).toEqual({ kind: 'conversation', id: issueID });
    expect(parseAppRoute(`unionground://channel/${channelID}`)).toEqual({ kind: 'channel', id: channelID });
    expect(parseAppRoute('unionground://swipe')).toEqual({ kind: 'swipe' });
    expect(parseAppRoute('unionground://feature/voting')).toEqual({ kind: 'feature', key: 'voting' });
    expect(parseAppRoute('unionground://legal/terms')).toEqual({ kind: 'legal', page: 'terms' });
    // The public chapter directory and public event pages do not ship.
    expect(parseAppRoute('unionground://public/chapters')).toBeNull();
    expect(parseAppRoute('unionground://public/chapters/harborview')).toBeNull();
    expect(parseAppRoute('unionground://public/events/august-meeting')).toBeNull();
  });

  it('opens only the public offline library without granting access to private records', () => {
    const offline: AppRoute = { kind: 'offline' };
    expect(parseAppRoute('unionground://offline')).toEqual(offline);
    expect(appRouteFromRouterPath('/offline')).toEqual(offline);
    expect(routerPath(offline)).toBe('/offline');
    expect(isPublicAppRoute(offline)).toBe(true);
    expect(isPublicAppRoute({ kind: 'issue', id: issueID })).toBe(false);
    expect(parseAppRoute('unionground://offline?account=another')).toBeNull();
  });

  it('rejects lookalike hosts and unknown paths', () => {
    expect(parseAppRoute('https://app.unionground.example.example.com/app/home')).toBeNull();
    expect(parseAppRoute('unionground://admin')).toBeNull();
  });

  it('rejects ambiguous, credential-bearing, oversized, and decorated routes', () => {
    expect(parseAppRoute('https://attacker@app.unionground.example/app/home')).toBeNull();
    expect(parseAppRoute('https://app.unionground.example/app/home#case-secret')).toBeNull();
    expect(parseAppRoute('https://app.unionground.example/app/home?next=case')).toBeNull();
    expect(parseAppRoute(`https://app.unionground.example/app/issue%2F${issueID}`)).toBeNull();
    expect(parseAppRoute(`https://app.unionground.example/app/home${'a'.repeat(4097)}`)).toBeNull();
    expect(parseAppRoute('unionground://home\nhttps://attacker.example')).toBeNull();
  });

  it('accepts one bounded auth code and rejects callback parameter confusion', () => {
    expect(parseAppRoute('https://app.unionground.example/app/auth/callback?code=one-time-code')).toEqual({
      kind: 'authCallback',
      code: 'one-time-code',
    });
    expect(parseAppRoute('https://app.unionground.example/app/auth/callback?code=first&code=second')).toBeNull();
    expect(parseAppRoute('https://app.unionground.example/app/auth/callback?code=ok&next=/issue')).toBeNull();
    expect(parseAppRoute(`unionground://auth/callback?code=${'a'.repeat(2049)}`)).toBeNull();
  });

  it('requires a UUID for protected records', () => {
    expect(parseAppRoute('unionground://issue/worker-name')).toBeNull();
  });

  it('does not accept arbitrary notification destinations', () => {
    expect(routeFromNotification({ screen: 'https://evil.example' })).toBeNull();
    // The shared notification contract still names the record type 'case'.
    expect(routeFromNotification({ screen: 'case', record_id: issueID })).toEqual({ kind: 'issue', id: issueID });
    expect(routeFromNotification({ screen: 'conversation', record_id: 'member-name' })).toBeNull();
    expect(routeFromNotification({ screen: 'channel', record_id: channelID })).toEqual({ kind: 'channel', id: channelID });
    expect(routeFromNotification({ screen: 'channel', record_id: 'harborview-campaign' })).toBeNull();
    expect(routeFromNotification({ screen: 'notifications' })).toEqual({ kind: 'notifications' });
    expect(routeFromNotification({ screen: 'admin' })).toBeNull();
    expect(routeFromNotification({ screen: 'steward' })).toBeNull();
    expect(routeFromNotification({ screen: 'tasks' })).toBeNull();
    expect(routeFromNotification({ screen: 'coordinator' })).toBeNull();
    expect(routeFromNotification({ screen: 'advisor' })).toBeNull();
    expect(routeFromNotification({ screen: 'vp' })).toBeNull();
    expect(routeFromNotification({ screen: 'events-desk' })).toBeNull();
    expect(routeFromNotification({ screen: 'campaigns' })).toBeNull();
    expect(routeFromNotification({ screen: 'integrations' })).toBeNull();
    expect(routeFromNotification({ screen: 'steward-appointments' })).toBeNull();
    expect(routeFromNotification({ screen: 'events' })).toEqual({ kind: 'feature', key: 'events' });
  });

  it('treats in-app legal pages as public and signed-out readable', () => {
    const privacy = { kind: 'legal' as const, page: 'privacy' as const };
    const terms = { kind: 'legal' as const, page: 'terms' as const };
    expect(parseAppRoute('unionground://legal/privacy')).toEqual(privacy);
    expect(appRouteFromRouterPath('/legal/privacy')).toEqual(privacy);
    expect(isPublicAppRoute(privacy)).toBe(true);
    expect(isPublicAppRoute(terms)).toBe(true);
    expect(isPublicAppRoute({ kind: 'publicUnions' })).toBe(true);
    expect(isPublicAppRoute({ kind: 'feature', key: 'voting' })).toBe(false);
    expect(isPublicAppRoute({ kind: 'tab', tab: 'home' })).toBe(false);
    expect(isPublicAppRoute({ kind: 'issue', id: issueID })).toBe(false);
    const layout = readFileSync(fileURLToPath(new URL('../../app/_layout.tsx', import.meta.url)), 'utf8');
    const sessionNavigation = readFileSync(fileURLToPath(new URL('./rootLayoutNavigation.ts', import.meta.url)), 'utf8');
    expect(sessionNavigation).toContain('isPublicAppRoute(currentRoute)');
    expect(layout).toContain('isPublicAppRoute(route)');
  });

  it('round-trips only protected router destinations used for post-authentication resume', () => {
    const route = { kind: 'issue' as const, id: issueID };
    expect(appRouteFromRouterPath(routerPath(route)!)).toEqual(route);
    expect(routerPath({ kind: 'tab', tab: 'work' })).toBe('/work');
    expect(appRouteFromRouterPath('/work')).toEqual({ kind: 'tab', tab: 'work' });
    expect(appRouteFromRouterPath('/(tabs)/work')).toEqual({ kind: 'tab', tab: 'work' });
    expect(appRouteFromRouterPath('/messages')).toEqual({ kind: 'messages' });
    expect(appRouteFromRouterPath(`/conversation/${issueID}`)).toEqual({ kind: 'conversation', id: issueID });
    expect(appRouteFromRouterPath(`/channel/${channelID}`)).toEqual({ kind: 'channel', id: channelID });
    expect(routerPath({ kind: 'channel', id: channelID })).toBe(`/channel/${channelID}`);
    expect(appRouteFromRouterPath('/swipe')).toEqual({ kind: 'swipe' });
    expect(routerPath({ kind: 'swipe' })).toBe('/swipe');
    expect(appRouteFromRouterPath('/share-intake')).toEqual({ kind: 'shareIntake' });
    expect(routerPath({ kind: 'shareIntake' })).toBe('/share-intake');
    expect(parseAppRoute('unionground://share-intake')).toBeNull();
    expect(appRouteFromRouterPath('/feature/forms')).toEqual({ kind: 'feature', key: 'forms' });
    expect(appRouteFromRouterPath('/public/chapters')).toBeNull();
    expect(appRouteFromRouterPath('/pulse')).toEqual({ kind: 'pulse' });
    expect(routerPath({ kind: 'pulse' })).toBe('/pulse');
    expect(routerPath({ kind: 'legal', page: 'privacy' })).toBe('/legal/privacy');
    expect(appRouteFromRouterPath('/sign-in')).toBeNull();
  });

  it('sends unresolved custom-scheme hosts to the Home tab, not the index shell', () => {
    expect(appRouteFromRouterPath('/')).toBeNull();
    expect(unresolvedCustomSchemeHomePath('unionground://auth')).toBe(HOME_TAB_PATH);
    expect(unresolvedCustomSchemeHomePath('unionground://login')).toBe(HOME_TAB_PATH);
    expect(unresolvedCustomSchemeHomePath('unionground://preview_exit')).toBe(HOME_TAB_PATH);
    expect(unresolvedCustomSchemeHomePath('unionground://')).toBeNull();
    expect(unresolvedCustomSchemeHomePath('https://app.unionground.example/app/bogus')).toBeNull();
    expect(appRouteFromRouterPath(HOME_TAB_PATH)).toEqual({ kind: 'tab', tab: 'home' });
    expect(routerPath({ kind: 'tab', tab: 'home' })).toBe(HOME_TAB_PATH);
  });
});

describe('October native destination routing', () => {
  it('opens each dock root by name and keeps retired roots unroutable', () => {
    const destinations: Array<Extract<AppRoute, { kind: 'tab' }>['tab']> = ['work', 'compass', 'campaign', 'account'];
    for (const name of destinations) {
      const route = parseAppRoute(`unionground://${name}`);
      expect(route).toEqual({ kind: 'tab', tab: name });
      expect(route && routerPath(route)).toBe(`/${name}`);
      expect(appRouteFromRouterPath(`/${name}`)).toEqual(route);
    }
    expect(parseAppRoute('unionground://union')).toBeNull();
    expect(parseAppRoute('unionground://pulse')).toEqual({ kind: 'pulse' });
    expect(parseAppRoute('unionground://messages')).toEqual({ kind: 'messages' });
  });
});
