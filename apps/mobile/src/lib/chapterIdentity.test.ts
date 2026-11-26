import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { chapterIdentityPresentation } from './chapterIdentity';

// REQ-UNION-BASE-MULTI-CHAPTER-MEMBERSHIP-20260818, finding F3 (2026-09-26):
// the authenticated Home mounted no chapter rail, so the live switcher was
// unreachable. The mobile lane ships no React renderer: the identity copy is
// exercised here and the Home, the rail and the provider are pinned by source.

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const home = read('../../app/(tabs)/home.tsx');
const rail = read('../components/ChapterRail.tsx');
const provider = read('../state/AppProvider.tsx');

const harborview = { name: 'Harborview Care United', region: 'Central', selected: true };
const fixture = { name: 'Fixture: device campaign (synthetic, 09-26)', region: 'Fixture region (synthetic)', selected: false };

describe('campaign identity control copy', () => {
  it('states an honest empty state when no membership is active', () => {
    const identity = chapterIdentityPresentation([]);
    expect(identity.title).toBe('No active campaign membership');
    expect(identity.accessibilityLabel).toBe('Campaign, no active membership');
    expect(identity.accessibilityHint).toBe('Opens the campaign rail');
    expect(identity.subtitle).toBe('You\u2019re not in a campaign yet. Your campaign administrator can add you to one.');
    expect(identity.subtitle).not.toMatch(/restore/i);
  });

  it('gives a single-chapter worker a calm identity, not a picker promise', () => {
    const identity = chapterIdentityPresentation([harborview]);
    expect(identity.title).toBe('Harborview Care United');
    expect(identity.subtitle).toBe('Your campaign\u00a0· Central');
    expect(identity.accessibilityLabel).toBe('Campaign, Harborview Care United, current campaign');
    expect(chapterIdentityPresentation([{ ...harborview, region: null }]).subtitle).toBe('Your campaign');
    // The only membership is the identity even if the server has not marked it selected.
    expect(chapterIdentityPresentation([{ ...harborview, selected: false }]).title).toBe('Harborview Care United');
  });

  it('names the current campaign and the authorized count for a multi-chapter worker', () => {
    const identity = chapterIdentityPresentation([harborview, fixture]);
    expect(identity.title).toBe('Harborview Care United');
    expect(identity.subtitle).toBe('Current campaign\u00a0· Central\u00a0· 2 authorized campaigns');
    expect(identity.accessibilityLabel).toBe('Campaign, Harborview Care United, current campaign, 2 authorized campaigns');
    const none = chapterIdentityPresentation([{ ...harborview, selected: false }, fixture]);
    expect(none.title).toBe('Choose a campaign');
    expect(none.accessibilityLabel).toBe('Campaign, none selected, 2 authorized campaigns');
  });
});

describe('authenticated Home reaches the live campaign rail', () => {
  it('mounts the identity control and the rail inside AuthenticatedHome', () => {
    const authenticated = home.split('function AuthenticatedHome()')[1] ?? '';
    expect(authenticated).toContain('const { chapterMemberships, dashboard, error, refreshing, refresh, session, locked, privacyCovered } = useApp();');
    expect(authenticated).toContain('const [railOpen, setRailOpen] = useState(false);');
    expect(authenticated).toContain('const chapterIdentity = chapterIdentityPresentation(chapterMemberships, language);');
    expect(authenticated).toContain('accessibilityLabel={chapterIdentity.accessibilityLabel}');
    expect(authenticated).toContain('accessibilityHint={chapterIdentity.accessibilityHint}');
    expect(authenticated).toContain('onPress={() => { void haptics.select(); setRailOpen(true); }}');
    expect(authenticated).toContain('<ChapterRail open={railOpen} onClose={() => setRailOpen(false)} />');
    // The control is a real button with a touch-target floor.
    expect(home).toContain('chapterIdentity: { flexDirection: \'row\', alignItems: \'center\', gap: spacing.sm, minHeight: minimumTouchTarget,');
    // PrototypeHome keeps its own rail mount (preview behaviour unchanged).
    const prototype = home.split('function PrototypeHome()')[1]?.split('function AuthenticatedHome()')[0] ?? '';
    expect(prototype).toContain('<ChapterRail open={railOpen} onClose={() => setRailOpen(false)} />');
  });

  it('keeps the live rail branch: search, current/switch labels, pins, empty and single-chapter notes', () => {
    expect(rail).toContain("const live = mode === 'authenticated';");
    expect(rail).toContain('accessibilityLabel="Search your campaigns"');
    expect(rail).toContain("accessibilityLabel={`${chapter.name}${chapter.selected ? ', current campaign' : ', switch campaign'}`}");
    expect(rail).toContain("accessibilityLabel={`${chapter.pinned ? 'Unpin' : 'Pin'} ${chapter.name}`}");
    expect(rail).toContain('No active campaign membership');
    expect(rail).toContain('{NO_CHAPTER_SUBTITLE}');
    expect(rail).not.toMatch(/restore access/i);
    expect(rail).toContain('This account currently belongs to one campaign. Additional active campaign memberships will appear here automatically.');
    expect(rail).toContain('await switchChapter(chapterID);');
    expect(rail).toContain('await setChapterPinned(chapterID, !pinned);');
  });

  it('switches through the provider, which resets the channel store and refetches under the new campaign', () => {
    const switcher = provider.split('const switchChapter = useCallback(async (chapterID: string) => {')[1]?.split('}, [')[0] ?? '';
    expect(switcher).toContain('await switchMobileChapter(writer, chapterID);');
    expect(switcher).toContain('liveChannelStore.resetForSession();');
    expect(switcher).toContain('setDashboard(null);');
    expect(switcher).toContain('await fetchDashboard(session);');
    expect(switcher).toContain("throw new Error('Campaign changed, but the workspace could not refresh. Pull to refresh and try again.');");
  });
});
