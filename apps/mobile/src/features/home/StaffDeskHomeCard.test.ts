// @vitest-environment jsdom
// REQ-UG-LOVABLE-NATIVE-SCREENS-BATCH-C-PORT-20261103: the Batch C
// role desk card renders on live Home in both Union Ground appearances, names
// the role and the desk, and opens the desk.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveTheme } from '../../theme/tokens';

const runtime = vi.hoisted(() => ({
  app: {
    mode: 'authenticated',
    sessionRestricted: false,
    chosenStaffRole: null as string | null,
    authorizedRoles: [] as string[],
    chapterRoles: [] as string[],
    organizationRoles: [] as string[],
  },
  dark: false,
  push: vi.fn(),
}));
vi.mock('../../state/AppProvider', () => ({ useApp: () => runtime.app }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground', runtime.dark) }));
vi.mock('../../services/haptics', () => ({ haptics: { select: async () => {} } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: runtime.push }) }));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    View: text, Text: text,
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string }) => h('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Platform: { OS: 'android', select: <T,>(value: { android?: T; default?: T }) => value.android ?? value.default },
  };
});
import { StaffDeskHomeCard } from './StaffDeskHomeCard';

let root: Root, host: HTMLDivElement;

async function render() { await act(async () => { root.render(createElement(StaffDeskHomeCard)); }); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  runtime.app = { mode: 'authenticated', sessionRestricted: false, chosenStaffRole: null, authorizedRoles: [], chapterRoles: [], organizationRoles: [] };
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); });

describe.each([false, true])('Batch C role desk card (dark %s)', (dark) => {
  beforeEach(() => { runtime.dark = dark; });

  it('shows the committee member desk and opens it', async () => {
    runtime.app.authorizedRoles = ['steward'];
    runtime.app.chapterRoles = ['steward'];
    await render();
    expect(host.textContent).toContain('COMMITTEE DESK');
    expect(host.textContent).toContain('Committee desk');
    expect(host.textContent).toContain('Your caseload, worker requests, one-on-ones and forms to review.');
    act(() => { host.querySelector('button')!.click(); });
    expect(runtime.push).toHaveBeenCalledWith('/feature/steward');
  });

  it('follows the chosen role for an account holding several', async () => {
    // AppProvider narrows the exposed roles to the chosen one.
    runtime.app.authorizedRoles = ['coordinator'];
    runtime.app.chapterRoles = ['coordinator'];
    runtime.app.chosenStaffRole = 'coordinator';
    await render();
    expect(host.querySelector('button')!.getAttribute('aria-label'))
      .toBe('CAMPAIGN LEAD DESK. Issue queue. The campaign issue load and its deadlines.');
  });

  // Gate round 1 on #6997 (r1s1): the Steward desk needs chapter scope, so an
  // organization-only grant gets no card whose destination would refuse it.
  it('renders nothing for an organization-only committee member grant', async () => {
    runtime.app.authorizedRoles = ['steward'];
    runtime.app.organizationRoles = ['steward'];
    await render();
    expect(host.textContent).toBe('');
  });

  // #9098: the Case queue opens for an organization-wide coordinator, and
  // get_coordinator_kpis counts that grant (member_has_role reads
  // organization_role_grants), so the card shows like the Advisor desk's.
  it.each([['advisor', 'ADVISOR DESK'], ['coordinator', 'CAMPAIGN LEAD DESK']])('shows an organization-scoped %s desk that opens at organization scope', async (role, title) => {
    runtime.app.authorizedRoles = [role];
    runtime.app.organizationRoles = [role];
    await render();
    expect(host.textContent).toContain(title);
  });

  it('renders nothing for a worker account', async () => {
    await render();
    expect(host.textContent).toBe('');
  });
});
