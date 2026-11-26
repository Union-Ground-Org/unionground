// @vitest-environment jsdom
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

const profile = vi.hoisted(() => ({ fullName: '' as string | null, language: 'es' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: profile.language }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/supabase', async () => {
  const fixture = await (() => ({
  getSupabaseClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { id: 'case-a', user_id: 'member-a', organization_id: 'org-a', steward_user_id: 'steward-a' }, error: null }),
      };
      return query;
    },
    rpc: async (name: string) => {
      if (name !== 'list_member_case_assignment_candidates') throw new Error(`Unexpected write: ${name}`);
      return { data: [{ userId: 'steward-a', fullName: profile.fullName, roles: ['steward'] }], error: null };
    },
  }),
}))();
  return { ...fixture, captureSessionWriter: () => stubSessionWriter(() => fixture.getSupabaseClient()) };
});

import { CaseStewardAssignment } from './CaseStewardAssignment';

let screen: Rendered | null = null;
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('unnamed committee member on %s', (platform) => {
  beforeEach(() => setPlatform(platform));
  describe.each<[string, string, string, string]>([
    ['es', 'Comité sin nombre', 'Comité asignado: ', 'Asignación del asunto'],
    ['en', 'Unnamed committee member', 'Assigned committee member: ', 'Issue assignment'],
  ])('in %s', (language, fallback, assignedPrefix, heading) => {
    it.each<[string, string | null]>([
      ['empty', ''], ['null', null], ['whitespace-only', ' \t\n '],
    ])('localizes a %s profile name in both places', async (_kind, name) => {
      profile.fullName = name; profile.language = language;
      screen = await render(h(CaseStewardAssignment, { caseID: 'case-a' }));
      expect(screen.container.textContent).toContain(heading);
      expect(screen.container.textContent).toContain(assignedPrefix + fallback);
      expect(getExposed(screen.container, fallback).textContent).toBe(fallback);
      if (language === 'es') expect(screen.container.textContent).not.toContain('Unnamed committee member');
    });

    it('preserves a non-blank authored name exactly, including surrounding whitespace', async () => {
      const name = ' \t Avery Lind \n ';
      profile.fullName = name; profile.language = language;
      screen = await render(h(CaseStewardAssignment, { caseID: 'case-a' }));
      const button = [...screen.container.querySelectorAll('[aria-label]')].find((node) => node.getAttribute('aria-label') === name);
      expect(button?.textContent).toBe(name);
      expect(screen.container.textContent).toContain(assignedPrefix + name);
    });
  });
});
