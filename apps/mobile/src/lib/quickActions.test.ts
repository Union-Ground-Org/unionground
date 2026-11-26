import { describe, expect, it } from 'vitest';

import { nativeTabPath, quickActionsPathEligible, quickActionsScope, quickCaptureScope } from './quickActions';

describe('quick-actions drawer gating', () => {
  it('keeps Home on its own carousel right page for every hat', () => {
    expect(quickActionsPathEligible('/home')).toBe(false);
    expect(quickActionsPathEligible('/(tabs)/home')).toBe(false);
  });

  it('stays off pre-session and auth screens', () => {
    for (const path of ['/', '/sign-in', '/mfa-challenge', '/auth/callback']) {
      expect(quickActionsPathEligible(path)).toBe(false);
    }
  });

  it('covers eligible pages independently of hat', () => {
    for (const path of ['/messages', '/pulse', '/work', '/campaign', '/account', '/notifications', '/channel/abc', '/conversation/abc', '/issue/abc', '/feature/tasks', '/legal/terms', '/swipe']) {
      expect(quickActionsPathEligible(path)).toBe(true);
    }
  });

  it('excludes the Guide screen for every hat to avoid a duplicate panel', () => {
    expect(quickActionsPathEligible('/messages')).toBe(true);
    expect(quickActionsPathEligible('/pulse')).toBe(true);
    expect(quickActionsPathEligible('/compass')).toBe(false);
    expect(quickActionsPathEligible('/(tabs)/compass')).toBe(false);
  });

  it('distinguishes native-tab scenes from pushed detail routes', () => {
    for (const path of ['/home', '/work', '/compass', '/campaign', '/account', '/(tabs)/compass', '/(tabs)/campaign', '/(tabs)/work']) {
      expect(nativeTabPath(path), path).toBe(true);
    }
    for (const path of ['/messages', '/pulse', '/feature/chapter', '/notifications', '/conversation/abc', '/channel/abc']) {
      expect(nativeTabPath(path), path).toBe(false);
    }
  });

  it('scopes deck shortcuts per hat and per authenticated role set', () => {
    expect(quickActionsScope('preview', 'steward', ['steward'])).toBe('preview.steward');
    expect(quickActionsScope('preview', null, [])).toBe('preview.member');
    expect(quickActionsScope('authenticated', null, ['steward', 'admin'])).toBe('authenticated.steward.admin');
    expect(quickActionsScope('authenticated', null, [])).toBe('authenticated.member');
  });

  it('pins captured content to the stable account and campaign, never just the role shape', () => {
    expect(quickCaptureScope('preview', 'steward', null, null)).toBe('preview.steward');
    expect(quickCaptureScope('authenticated', null, 'user-a', 'wor')).toBe('authenticated.user-a.wor');
    expect(quickCaptureScope('authenticated', null, 'user-b', 'wor')).not.toBe(quickCaptureScope('authenticated', null, 'user-a', 'wor'));
    expect(quickCaptureScope('authenticated', null, 'user-a', 'spr')).not.toBe(quickCaptureScope('authenticated', null, 'user-a', 'wor'));
    expect(quickCaptureScope('authenticated', null, null, null)).toBe('authenticated.unknown.none');
  });
});
