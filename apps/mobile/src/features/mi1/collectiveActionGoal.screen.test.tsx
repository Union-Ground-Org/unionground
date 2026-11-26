import { stubSessionWriter } from '../../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../../testing/reactNativeStandIn';

// BUG-UG-COLLECTIVE-ACTION-GOAL-FIXED-AT-100-20261111 (#8220),
// executed on the shared stand-in (#8319): the phone's Create action form
// asked for no goal and saved every new collective action with 100.
const api = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
// #9166: the signed-in person's roles, per test (an organization admin by default).
const app = vi.hoisted(() => ({ authorizedRoles: ['admin'], organizationRoles: ['admin'], chapterID: 'chapter-1', language: 'en' as 'en' | 'es' }));
vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/ui', async () => ({ ...await import('../../testing/uiStandIn'), OptionPicker: () => null }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => () => undefined }));
vi.mock('./ConnectionSuggestionsPanel', () => ({ ConnectionSuggestionsPanel: () => null }));
vi.mock('../../state/AppProvider', () => ({ useApp: () => ({
  mode: 'authenticated', memberLanguage: app.language, dashboard: { member: { id: 'admin-1', chapterID: 'chapter-1' } }, previewHat: null, authorizedRoles: app.authorizedRoles,
  chapterMemberships: [{ chapterID: app.chapterID, organizationID: 'org-1', selected: true }], organizationID: 'org-1', organizationRoles: app.organizationRoles,
}) }));
vi.mock('../../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => null, session?.user?.id ?? 'member-a'),
  loadMobileCollectiveActions: api.load, saveMobileCollectiveAction: api.save,
  loadMobileOrganizationIntelligenceSnapshot: vi.fn(), requestMobileCollectiveActionExport: vi.fn(), saveMobileOrganizationChartNode: vi.fn(),
  saveMobileOrganizationRelationship: vi.fn(), saveMobileOrganizationTimelineEvent: vi.fn(), saveMobileOrganizationTopicProgress: vi.fn(),
  toggleMobileCollectiveActionParticipation: vi.fn(),
}));

import { CollectiveActionsScreen } from './OrganizationIntelligenceScreens';
import { nativeUiText } from '../../lib/nativeUiCopy';

let screen: Rendered | null = null;
afterEach(async () => {
  await screen?.unmount(); screen = null; setPlatform('ios'); api.load.mockReset(); api.save.mockReset();
  app.authorizedRoles = ['admin']; app.organizationRoles = ['admin']; app.chapterID = 'chapter-1'; app.language = 'en';
});

describe.each(['ios', 'android'] as const)('Create action on %s', (os) => {
  it('saves the participation goal the person typed', async () => {
    setPlatform(os);
    api.load.mockResolvedValue({ organizationId: 'org-1', actions: [], hasMore: false });
    api.save.mockResolvedValue(undefined);
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    await type(getExposed(screen.container, 'Title'), 'Staffing pledge');
    await type(getExposed(screen.container, 'Summary'), 'Sign the staffing pledge');
    // No goal, or one the server would refuse, publishes nothing.
    for (const goal of ['', '0', '1000001', 'sixty']) {
      await type(getExposed(screen.container, /^Participation goal/), goal);
      await press(getExposed(screen.container, 'Publish action'));
    }
    expect(api.save).not.toHaveBeenCalled();
    await type(getExposed(screen.container, /^Participation goal/), '61');
    await press(getExposed(screen.container, 'Publish action'));
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0]?.[2]).toMatchObject({ p_title: 'Staffing pledge', p_target_count: 61 });
  });

  it("lets the action's editor change its goal, resending the action as it is", async () => {
    setPlatform(os);
    api.load.mockResolvedValue({ organizationId: 'org-1', hasMore: false, actions: [{
      id: 'a-1', kind: 'petition', status: 'published', title: 'Safe staffing', summary: 'Sign by Friday.', chapterId: 'chapter-1',
      targetCount: 100, participantCount: 12, viewerCanEdit: true, startsAt: '2026-11-12T14:00:00Z', endsAt: null,
    }] });
    api.save.mockResolvedValue(undefined);
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    await press(getExposed(screen.container, 'Change goal'));
    for (const goal of ['', '-5', '6.5']) {
      await type(getExposed(screen.container, 'Participation goal'), goal);
      await press(getExposed(screen.container, 'Save goal'));
    }
    expect(api.save).not.toHaveBeenCalled();
    await type(getExposed(screen.container, 'Participation goal'), '75');
    await press(getExposed(screen.container, 'Save goal'));
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0]?.[2]).toEqual({
      p_id: 'a-1', p_chapter_id: 'chapter-1', p_action_kind: 'petition', p_title: 'Safe staffing', p_summary: 'Sign by Friday.',
      p_status: 'published', p_target_count: 75, p_starts_at: '2026-11-12T14:00:00Z', p_ends_at: null,
    });
  });
});

// BUG-UG-CHAPTER-PRESIDENT-CANNOT-START-A-PETITION-20261118 (#9166):
// the card offered Join on every published action, so once the server refuses
// a join from outside the action's chapter the button would only fail.
const JOIN_PLATFORMS: Array<'ios' | 'android'> = ['ios', 'android'];
describe.each(JOIN_PLATFORMS)('Join on %s', (os) => {
  it("offers Join only where the server allows it, and keeps Withdraw for a participant", async () => {
    setPlatform(os);
    api.load.mockResolvedValue({ organizationId: 'org-1', hasMore: false, actions: [
      { id: 'a-other', kind: 'petition', status: 'published', title: 'Other campaign petition', summary: 'Campaign A only.', chapterId: 'chapter-a', targetCount: 50, participantCount: 3, viewerCanEdit: true, viewerCanJoin: false },
      { id: 'a-joined', kind: 'petition', status: 'published', title: 'Joined before', summary: 'Signed earlier.', chapterId: 'chapter-a', targetCount: 50, participantCount: 4, viewerParticipation: 'signature', viewerCanEdit: true, viewerCanJoin: false },
      { id: 'org-wide', kind: 'petition', status: 'published', title: 'Whole organization petition', summary: 'Everyone.', chapterId: null, targetCount: 50, participantCount: 9, viewerCanEdit: true, viewerCanJoin: true },
      { id: 'unstated', kind: 'petition', status: 'published', title: 'Older server petition', summary: 'No join rule sent.', chapterId: null, targetCount: 50, participantCount: 2, viewerCanEdit: true },
    ] });
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    const text = screen.container.textContent ?? '';
    expect(text.split("Only workers of this action's campaign can join it.")).toHaveLength(2);
    expect((text.match(/Join action/g) ?? []).length).toBe(2);
    expect((text.match(/Withdraw/g) ?? []).length).toBe(1);
  });
});

// BUG-UG-CHAPTER-PRESIDENT-CANNOT-START-A-PETITION-20261118 (#9166):
// a President granted for the chapter only wore Member on this screen, so the
// server answered no manage scope, and every new action was saved for the
// whole organization, which save_digital_action refuses a chapter grant.
const CHAPTER_PLATFORMS: Array<'ios' | 'android'> = ['ios', 'android'];
const CHAPTER_NOTE = 'Actions you create here are for your campaign.';
describe.each(CHAPTER_PLATFORMS)('Collective actions for a Campaign chair on %s', (os) => {
  it('wears the campaign hat, says the action is for the campaign, and saves it for the campaign', async () => {
    setPlatform(os);
    app.authorizedRoles = ['vp']; app.organizationRoles = [];
    api.load.mockResolvedValue({ organizationId: 'org-1', manageScope: 'chapter', manageChapterId: 'chapter-1', authoringHats: ['vp'], actions: [], hasMore: false });
    api.save.mockResolvedValue(undefined);
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    expect(api.load).toHaveBeenCalledWith('vp');
    expect(screen.container.textContent).toContain(CHAPTER_NOTE);
    await type(getExposed(screen.container, 'Title'), 'Safer break room');
    await type(getExposed(screen.container, 'Summary'), 'Sign for a safer break room');
    await type(getExposed(screen.container, /^Participation goal/), '40');
    await press(getExposed(screen.container, 'Publish action'));
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0]?.[1]).toBe('vp');
    expect(api.save.mock.calls[0]?.[2]).toMatchObject({ p_id: null, p_chapter_id: 'chapter-1', p_action_kind: 'petition', p_title: 'Safer break room', p_status: 'published', p_target_count: 40 });
  });

  it("edits its campaign's action under the campaign hat and keeps the action in the campaign", async () => {
    setPlatform(os);
    app.authorizedRoles = ['vp']; app.organizationRoles = [];
    api.load.mockResolvedValue({ organizationId: 'org-1', manageScope: 'chapter', manageChapterId: 'chapter-1', hasMore: false, actions: [{
      id: 'a-1', kind: 'petition', status: 'published', title: 'Safer break room', summary: 'Sign by Friday.', chapterId: 'chapter-1',
      targetCount: 40, participantCount: 6, viewerCanEdit: true, viewerCanJoin: true, startsAt: null, endsAt: null,
    }] });
    api.save.mockResolvedValue(undefined);
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    await press(getExposed(screen.container, 'Change goal'));
    await type(getExposed(screen.container, 'Participation goal'), '60');
    await press(getExposed(screen.container, 'Save goal'));
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0]?.[1]).toBe('vp');
    expect(api.save.mock.calls[0]?.[2]).toMatchObject({ p_id: 'a-1', p_chapter_id: 'chapter-1', p_target_count: 60 });
  });

  it('keeps an organization-wide officer on the organization hat, saving for the whole organization', async () => {
    setPlatform(os);
    app.authorizedRoles = ['vp', 'steward']; app.organizationRoles = ['vp'];
    api.load.mockResolvedValue({ organizationId: 'org-1', manageScope: 'organization', manageChapterId: null, actions: [], hasMore: false });
    api.save.mockResolvedValue(undefined);
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    expect(api.load).toHaveBeenCalledWith('vp');
    expect(screen.container.textContent).not.toContain(CHAPTER_NOTE);
    await type(getExposed(screen.container, 'Title'), 'Staffing pledge');
    await type(getExposed(screen.container, 'Summary'), 'Sign the staffing pledge');
    await type(getExposed(screen.container, /^Participation goal/), '61');
    await press(getExposed(screen.container, 'Publish action'));
    expect(api.save.mock.calls[0]?.[2]).toMatchObject({ p_chapter_id: null, p_target_count: 61 });
  });

  it('offers no form when the server gives the campaign hat no scope', async () => {
    setPlatform(os);
    app.authorizedRoles = ['steward']; app.organizationRoles = [];
    api.load.mockResolvedValue({ organizationId: 'org-1', manageScope: null, manageChapterId: null, authoringHats: [], actions: [], hasMore: false });
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    expect(api.load).toHaveBeenCalledWith('steward');
    expect(screen.container.textContent).not.toContain('Create action');
  });

  it('reads the list again after a campaign switch under the same hat, and offers the form for the new campaign', async () => {
    setPlatform(os);
    app.authorizedRoles = ['vp']; app.organizationRoles = [];
    api.load.mockResolvedValueOnce({ organizationId: 'org-1', manageScope: 'chapter', manageChapterId: 'chapter-1', actions: [], hasMore: false });
    api.save.mockResolvedValue(undefined);
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    expect(screen.container.textContent).toContain(CHAPTER_NOTE);
    // The person switches to a second chapter where they are also President.
    app.chapterID = 'chapter-2';
    api.load.mockResolvedValue({ organizationId: 'org-1', manageScope: 'chapter', manageChapterId: 'chapter-2', actions: [], hasMore: false });
    await screen.rerender(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    expect(api.load).toHaveBeenCalledTimes(2);
    expect(api.load.mock.calls[1]?.[0]).toBe('vp');
    expect(screen.container.textContent).toContain(CHAPTER_NOTE);
    await type(getExposed(screen.container, 'Title'), 'Second campaign pledge');
    await type(getExposed(screen.container, 'Summary'), 'Sign for the second campaign');
    await type(getExposed(screen.container, /^Participation goal/), '25');
    await press(getExposed(screen.container, 'Publish action'));
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0]?.[2]).toMatchObject({ p_chapter_id: 'chapter-2', p_target_count: 25 });
  });

  it('offers no form when the campaign the server names is not the selected campaign', async () => {
    setPlatform(os);
    app.authorizedRoles = ['vp']; app.organizationRoles = [];
    api.load.mockResolvedValue({ organizationId: 'org-1', manageScope: 'chapter', manageChapterId: 'chapter-2', actions: [], hasMore: false });
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    expect(screen.container.textContent).not.toContain('Create action');
    expect(api.save).not.toHaveBeenCalled();
  });
});

// UX-UG-PHONE-ACTION-AND-PAY-PUBLISH-HIDE-THEIR-RULE-20261125 (#9918,
// carved from #9468, M2-19): Publish action and Save goal went grey on a short
// title or summary, or a goal written "1,000" or "50 people", with no reason.
const REASON_LANGUAGES: Array<'en' | 'es'> = ['en', 'es'];
describe.each(REASON_LANGUAGES)('collective action rules said beside the button, in %s', (language) => {
  const t = nativeUiText(language);
  const goalRule = t('Enter the goal in digits only: a whole number from 1 to {max}, with no commas or words.', { max: 1_000_000 });
  const shown = () => screen?.container.textContent ?? '';

  it('names the short title, then the short summary, then the goal, and publishes nothing', async () => {
    app.language = language;
    api.load.mockResolvedValue({ organizationId: 'org-1', actions: [], hasMore: false });
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    const publish = () => getExposed(screen!.container, t('Publish action'));
    await type(getExposed(screen.container, t('Title')), 'No');
    await press(publish());
    expect(shown()).toContain(t('Use at least {count} characters for the title.', { count: 3 }));
    await type(getExposed(screen.container, t('Title')), 'Staffing pledge');
    expect(publish().getAttribute('aria-description')).toBe(t('Use at least {count} characters for the summary.', { count: 3 }));
    await type(getExposed(screen.container, t('Summary')), 'Sign the pledge');
    for (const goal of ['1,000', '50 people']) {
      await type(getExposed(screen.container, t('Participation goal (people)')), goal);
      await press(publish());
      expect(shown()).toContain(goalRule);
    }
    // The limit is written as the digits the field accepts.
    expect(goalRule).toContain('1000000');
    expect(api.save).not.toHaveBeenCalled();
    await type(getExposed(screen.container, t('Participation goal (people)')), '1000');
    expect(publish().getAttribute('aria-disabled')).toBeNull();
    // The complete form publishes once, with the goal as typed.
    api.save.mockResolvedValue(undefined);
    await press(publish());
    await act(async () => { await Promise.resolve(); });
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0]?.[2]).toMatchObject({ p_title: 'Staffing pledge', p_summary: 'Sign the pledge', p_target_count: 1000 });
  });

  it('names the goal rule beside Save goal', async () => {
    app.language = language;
    api.load.mockResolvedValue({ organizationId: 'org-1', hasMore: false, actions: [{
      id: 'a-1', kind: 'petition', status: 'published', title: 'Safe staffing', summary: 'Sign by Friday.', chapterId: 'chapter-1',
      targetCount: 100, participantCount: 12, viewerCanEdit: true, startsAt: null, endsAt: null,
    }] });
    screen = await render(h(CollectiveActionsScreen));
    await act(async () => { await Promise.resolve(); });
    await press(getExposed(screen.container, t('Change goal')));
    await type(getExposed(screen.container, t('Participation goal')), '50 people');
    await press(getExposed(screen.container, t('Save goal')));
    expect(shown()).toContain(goalRule);
    expect(api.save).not.toHaveBeenCalled();
  });
});
