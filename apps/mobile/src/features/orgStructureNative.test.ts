// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { PREVIEW_STEWARD_ROSTER } from '../data/preview';
import { canOpenFeature, FEATURE_KEYS, FEATURE_TITLES, isStaffOnlyFeatureKey } from '../lib/featureCatalog';
import { parseAppRoute } from '../lib/routes';
import { getExposed, press, render } from '../testing/reactNativeStandIn';
import { minimumTouchTarget, resolveTheme } from '../theme/tokens';
import { OrgStructureScreen } from './OrgStructureScreen';

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('expo-blur', () => ({ BlurView: () => null }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ mode: 'authenticated' }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground') }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-screens/experimental', () => ({
  ScrollViewMarker: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../services/memberOrgPort', () => ({
  memberOrgPort: {
    loadOrganizationStructure: async () => ({
      charts: [{
        chartKind: 'union',
        nodes: [
          { id: 'chair', label: 'Campaign chair', sortOrder: 1, badge: 'North campaign' },
          { id: 'treasurer', label: 'Treasurer', sortOrder: 2 },
        ],
      }],
    }),
  },
}));

const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const manifest = JSON.parse(source('../../lovable-coverage-manifest.json')) as {
  featureKeys: string[];
  featureAccessGroups: { id: string; keys: string[] }[];
  featureReviewGroups: { id: string; keys: string[] }[];
};

describe('worker org structure destination (REQ-UG-MEMBER-ORG-STRUCTURE-VIEW-20260922)', () => {
  it('opens and collapses seat details immediately after the selected row', async () => {
    const screen = await render(createElement(OrgStructureScreen));
    try {
      const { container } = screen;
      const chair = getExposed(container, /^Campaign chair,/);
      const treasurer = getExposed(container, /^Treasurer,/);
      await press(chair);
      const detail = [...container.querySelectorAll('[role="heading"]')]
        .find((heading) => heading.textContent === 'Campaign chair')!;
      expect(container.textContent).toContain('Area: North campaign');
      expect(chair.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(detail.compareDocumentPosition(treasurer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await press(chair);
      expect(container.contains(detail)).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it('ships as a worker feature screen, not a sixth tab', () => {
    expect(FEATURE_KEYS).toContain('org-structure');
    expect(FEATURE_TITLES['org-structure']).toBe('Workplace structure');
    expect(isStaffOnlyFeatureKey('org-structure')).toBe(false);
    expect(canOpenFeature('preview', 'org-structure', 'member')).toBe(true);
    expect(canOpenFeature('authenticated', 'org-structure', null)).toBe(true);
    expect(parseAppRoute('unionground://feature/org-structure')).toEqual({ kind: 'feature', key: 'org-structure' });
    expect(source('./FeatureScreen.tsx')).toContain('<OrgStructureScreen />');
    // Workplace structure stays a pushed feature, outside the five-tab dock.
    const tabs = source('../../app/(tabs)/_layout.tsx');
    expect(tabs).not.toContain('org-structure');
  });

  it('is a listed Campaign-tab destination in both preview and live sessions', () => {
    // One destination list serves preview and live sessions alike.
    const campaign = source('../../app/(tabs)/campaign.tsx');
    expect(campaign.match(/href: '\/feature\/org-structure'/g)).toHaveLength(1);
    expect(campaign).toContain("title: 'Workplace structure'");
  });

  it('is registered in the coverage manifest as a worker destination', () => {
    expect(manifest.featureKeys).toContain('org-structure');
    expect(manifest.featureAccessGroups.find((group) => group.id === 'member-and-authorized-session')?.keys)
      .toContain('org-structure');
    expect(manifest.featureReviewGroups.find((group) => group.id === 'member-read-search-and-detail')?.keys)
      .toContain('org-structure');
    // The manifest above is the pinned census.
  });

  it('renders read-only: search, tree, node detail, and no write control', () => {
    const screen = source('./OrgStructureScreen.tsx');
    expect(screen).toContain('<SearchField');
    expect(screen).toContain('buildMemberOrgTree');
    expect(screen).toContain('searchMemberOrgNodes');
    expect(screen).toContain('resolveMemberOrgEdges');
    expect(screen).toContain('<OrgNodeDetail');
    // Read-only means no save path at all, not a hidden one.
    expect(screen).not.toMatch(/save[A-Z]\w*Organization/);
    expect(screen).not.toContain('TransactionalButton');
    expect(screen).not.toContain('get_organization_intelligence_snapshot');
  });

  it('marks vacant seats wherever a node appears and shows the imported provenance', () => {
    const screen = source('./OrgStructureScreen.tsx');
    // Row, accessibility label and detail all go through the vacant marker.
    expect(screen).toContain("node.vacant ? 'Vacant' : null");
    expect(screen.match(/nodeSummary\(node\)/g)).toHaveLength(2);
    expect(screen).toContain('const sourceLine = memberOrgSourceLine(charts);');
    for (const field of ['node.badge', 'node.roleClass', 'node.chipLabel', 'node.reportsToLabel', 'node.sourceAsOf']) {
      expect(screen).toContain(field);
    }
    // No identity or contact field exists on the native node to render.
    expect(screen).not.toMatch(/node\.(userID|userId|user_id|email|phone|contacts)\b/);
  });

  it('carries loading, error, empty and unmatched-search states', () => {
    const screen = source('./OrgStructureScreen.tsx');
    expect(screen).toContain('Your workplace structure is loading');
    expect(screen).toContain('Your workplace structure could not be loaded');
    expect(screen).toContain('<Button label="Try again"');
    expect(screen).toContain('No workplace structure yet');
    expect(screen).toContain('Nothing matches that search');
  });

  it('reads the backend only through the contract port, naming no RPC of its own', () => {
    const screen = source('./OrgStructureScreen.tsx');
    expect(screen).toContain('memberOrgPort.loadOrganizationStructure()');
    expect(screen).not.toContain('supabase');
    expect(screen).not.toMatch(/get_[a-z_]+\(/);
    // Every RPC name lives once, in the constant that quotes the member contract.
    expect(source('../lib/memberOrgContract.ts')).toContain("organizationStructure: 'get_member_organization_structure'");
    expect(source('../services/memberOrgPort.ts')).toContain('loadMobileMemberOrganizationStructure');
    const service = source('../services/supabase.ts');
    expect(service).toContain('MEMBER_ORG_RPC_NAMES.organizationStructure');
    expect(service).toContain('MEMBER_ORG_RPC_NAMES.stewardRoster');
    expect(service).not.toContain("'get_member_organization_structure'");
  });

  it('names every control and keeps native touch targets', () => {
    const screen = source('./OrgStructureScreen.tsx');
    expect(screen).toContain('accessibilityRole="tab"');
    expect(screen).toContain('accessibilityState={{ selected }}');
    expect(screen).toContain('accessibilityRole="button"');
    expect(screen).toContain('accessibilityLabel={[');
    expect(screen).toContain('minHeight: minimumTouchTarget');
    expect(minimumTouchTarget).toBeGreaterThanOrEqual(44);
  });

  it('hardcodes no union or agency name anywhere in the feature', () => {
    for (const file of ['./OrgStructureScreen.tsx', './StewardFinderSheet.tsx', '../lib/memberOrgContract.ts']) {
      const text = source(file);
      expect(text, file).not.toMatch(/\bSEIU\b/i);
      expect(text, file).not.toMatch(/\bLocal\s*\d/i);
      expect(text, file).not.toMatch(/\bDDS\b/);
      expect(text, file).not.toMatch(/\bMassachusetts\b/i);
      expect(text, file).not.toMatch(/\bhttps?:\/\//);
    }
  });
});

describe('Find my committee contact home entry', () => {
  const home = source('../../app/(tabs)/home.tsx');
  const sheet = source('./StewardFinderSheet.tsx');

  it('opens from the authenticated Quick actions', () => {
    expect(home).toContain("key: 'find-steward', label: t(\"Find my committee contact\")");
    // One sheet per home: the demo home and the signed-in home each mount it.
    expect(home.match(/<StewardFinderSheet open=\{stewardFinderOpen\}/g)).toHaveLength(2);
    // The entry adds no new hero.
    expect(home.match(/<Card hero/g)).toHaveLength(1);
  });

  it('routes Contact through the steward-scoped conversation lookup', () => {
    expect(sheet).toContain('nativeStewardContactRoute(dashboard?.conversations ?? [], steward.id)');
    expect(sheet).toContain("router.push(`/conversation/${route.conversationID}` as never)");
    // A selected steward with no thread gets a bound first message, never the
    // generic Messages composer (which starts an unbound thread).
    expect(sheet).not.toContain("router.push('/messages'");
    expect(sheet).toContain("setComposer({ stewardID: steward.id, draft: '', phase: 'editing', message: null });");
    expect(sheet).toContain('const port = memberOrgPortForSession(session);');
    expect(sheet).toContain('const { writer } = port;');
    expect(sheet).toContain('startSelectedStewardConversation(port, composer.stewardID, composer.draft)');
    expect(sheet).toContain('router.push(`/conversation/${started.conversationID}` as never);');
  });

  it('carries sending, error, cancel and success states for the first message', () => {
    expect(sheet).toContain("busy={composer.phase === 'sending'}");
    expect(sheet).toContain("disabled={composer.draft.trim() === ''}");
    expect(sheet).toContain('<Text accessibilityRole="alert"');
    expect(sheet).toContain('<Button label="Cancel" variant="secondary" onPress={onCancel} />');
    expect(sheet).toContain('accessibilityLabel={`First message to ${steward.name}`}');
    expect(sheet).toContain('maxLength={MEMBER_MESSAGE_MAX_LENGTH}');
    // A reply that lands after Cancel or Close navigates nowhere.
    expect(sheet.match(/if \(sendToken\.current !== token\) return;/g)).toHaveLength(4);
    // The new binding is pulled into the inbox so the next Contact reuses it.
    expect(sheet).toContain('await refresh().catch(() => undefined);');
    // The demo has no server binding to make, and says so instead of faking one.
    expect(sheet).toContain('The demo cannot start a conversation with a specific organizer.');
    expect(sheet).not.toContain('startPreviewConversation');
    expect(sheet).not.toContain('startMemberConversation');
    // It must not reach for a thread by position or by counterpart title.
    expect(sheet).not.toContain('conversations[0]');
    expect(sheet).not.toContain("counterpartRole === 'steward'");
  });

  it('offers See org structure from the same card set', () => {
    expect(sheet).toContain("export const ORG_STRUCTURE_ROUTE = '/feature/org-structure';");
    expect(sheet).toContain('accessibilityLabel="See org structure"');
  });

  it('shows an explicit empty state for a campaign with no organizer', () => {
    expect(sheet).toContain('No committee member is assigned to your campaign yet');
  });

  it('shows only opted-in contact affordances and never leaves the app to use them', () => {
    expect(sheet).toContain('steward.contact.email === null ? null : `Email:');
    expect(sheet).toContain('steward.contact.phone === null ? null : `Phone:');
    expect(sheet).not.toContain('Linking');
    expect(sheet).not.toMatch(/\btel:/);
    expect(sheet).not.toMatch(/\bmailto:/);
    // The preview roster proves both halves of the opt-in rule, in one chapter.
    expect(PREVIEW_STEWARD_ROSTER).toHaveLength(2);
    expect(PREVIEW_STEWARD_ROSTER[0]?.contact.email).not.toBeNull();
    expect(PREVIEW_STEWARD_ROSTER[1]?.contact).toEqual({ conversation: true, email: null, phone: null });
    expect(PREVIEW_STEWARD_ROSTER.every((steward) => steward.contact.conversation)).toBe(true);
    expect(new Set(PREVIEW_STEWARD_ROSTER.map((steward) => steward.chapterID)).size).toBe(1);
  });

  it('names every control and keeps native touch targets', () => {
    expect(sheet).toContain('accessibilityLabel={`Contact ${steward.name}`}');
    expect(sheet).toContain('accessibilityLabel="Close Find my committee contact"');
    expect(sheet).toContain('accessibilityViewIsModal');
    expect(sheet).toContain('minHeight: minimumTouchTarget');
    expect(sheet).toContain('minWidth: minimumTouchTarget');
  });

  it('carries loading, error and empty states and reads through the contract port', () => {
    expect(sheet).toContain('Your organizer list is loading');
    expect(sheet).toContain('Your organizer list could not be loaded');
    expect(sheet).toContain('<Button label="Try again"');
    expect(sheet).toContain('memberOrgPort.loadStewardRoster()');
    expect(sheet).not.toContain('supabase');
    // The roster is read when the sheet opens, not on every Home mount.
    expect(sheet).toContain('useEffect(() => { if (open) void load(); }, [open, load]);');
  });
});
