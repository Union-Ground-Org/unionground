// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { runInNewContext } from 'node:vm';

import { act, createElement as h, Fragment, useState } from 'react';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as native from '../testing/reactNativeStandIn';
import * as ui from '../testing/uiStandIn';

import { canOpenFeature, FEATURE_KEYS } from '../lib/featureCatalog';
import { parseAppRoute } from '../lib/routes';
import {
  canInitiateMemberHandoff,
  readPreviewHandoffs,
  resetPreviewHandoffs,
  searchPreviewHandoffPeople,
  scopePreviewHandoffActions,
  updatePreviewHandoffs,
  type MemberHandoff,
} from './memberSupportHandoffs';
import {
  failureNotice,
  isFailureNotice,
  successNotice,
  settleMemberSupportCommit,
  MEMBER_SUPPORT_COMMIT_FAILURE,
} from './memberSupportNotice';

const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('worker support native delivery', () => {
  beforeEach(() => resetPreviewHandoffs());

  it('registers one protected Expo destination for preview and authenticated accounts', () => {
    expect(FEATURE_KEYS).toContain('member-support');
    expect(canOpenFeature('preview', 'member-support', 'member')).toBe(true);
    expect(canOpenFeature('authenticated', 'member-support', null)).toBe(true);
    expect(parseAppRoute('unionground://feature/member-support')).toEqual({ kind: 'feature', key: 'member-support' });
    expect(source('./FeatureScreen.tsx')).toContain('<MemberSupportScreen />');
  });

  it('wires every worker and staff operation through the shared RPC adapter', () => {
    const screen = source('./MemberSupportScreen.tsx');
    for (const operation of [
      'saveEmergencyChecklist', 'alertEmergencySteward',
      'resolveEmergencyChecklist',
      'createAccommodation', 'transitionAccommodation',
      'recordHrContact', 'saveHrDirectory',
      'saveOnboardingStep', 'startOnboarding', 'completeOnboardingStep',
      'createMentorshipPair', 'transitionMentorshipPair',
      'addMentorshipNote', 'saveMentorshipGoal',
      'listHandoffs', 'searchHandoffMembers', 'searchHandoffStewards',
      'initiateHandoff', 'acknowledgeHandoff', 'declineHandoff', 'cancelHandoff',
    ]) expect(screen).toContain(`adapter.${operation}`);
    expect(screen).toContain('adapter.load(actor)');
    expect(screen).toContain('{ apiOrigin: mobileConfig.portalBaseUrl, randomUUID: Crypto.randomUUID }');
    expect(screen).toContain('function MentorshipPairCard');
    //  part D: a new pairing sends no start date, so the server starts it
    // on today's Eastern date; the UTC date the screen used to send is
    // tomorrow from 7 PM Eastern.
    expect(screen).toContain('adapter.createMentorshipPair(actor, { mentorUserId, menteeUserId })');
    expect(screen).not.toMatch(/startedOn: new Date\(\)\.toISOString\(\)/u);
    expect(screen).not.toContain('.from(');
    expect(screen).not.toMatch(/service[_-]?role/i);
    expect(screen).not.toMatch(/p_organization_id|organization_id:/);
  });

  // REQ-UG-DEFAULT-NEW-MEMBER-ONBOARDING-PROGRAM-20261006.
  // PHASE-2-WEB-PARITY: the web Worker support view arrives with the web phase.
  const webView = fileURLToPath(new NodeURL('../../../../src/views/MemberSupportView.jsx', import.meta.url));
  it.skipIf(!existsSync(webView))('shows the web starting list, word for word, while the organization has no active step', () => {
    const screen = source('./MemberSupportScreen.tsx');
    const web = source('../../../../src/views/MemberSupportView.jsx');
    expect(screen).not.toContain('No onboarding program');
    expect(screen).toContain("!model.onboardingProgram.some((step) => step.active) ? <><Card><Heading level={3}>Getting started</Heading>");
    // Content only: the start button needs one of the organization's own active steps.
    expect(screen).toContain('!model.onboardingPlan && model.onboardingProgram.some((step) => step.active) ? <Button label="Start my onboarding plan"');
    const block = screen.slice(screen.indexOf('const DEFAULT_ONBOARDING_STEPS'), screen.indexOf('];', screen.indexOf('const DEFAULT_ONBOARDING_STEPS')));
    const steps = [...block.matchAll(/\['([^']+)', '([^']+)'\]/g)].map(([, title, description]) => [title, description]);
    expect(steps.map(([title]) => title)).toEqual(['Welcome', 'Finish your profile', 'Meet your committee contact', 'Read the organizing guide']);
    for (const [title, description] of steps) expect(web).toContain(`["${title}", "${description}`);
  });

  // Gate rounds 1 and 2 on: members only receive active steps, so one
  // note is true whether the chapter added none or turned them all off; staff
  // get the web's note, and Start selected member waits for an active step.
  it.skipIf(!existsSync(webView))('treats turned-off steps like the web does', () => {
    const screen = source('./MemberSupportScreen.tsx');
    const web = source('../../../../src/views/MemberSupportView.jsx');
    expect(screen).not.toContain('TURNED_OFF');
    expect(web).not.toContain('turnedOffNote');
    expect(screen).toContain('<Body muted>{DEFAULT_ONBOARDING_NOTE}</Body>');
    expect(screen).toContain('disabled={disabled || (!memberUserId || !model.onboardingProgram.some((step) => step.active))}');
    expect(screen).not.toContain('model.onboardingProgram.length === 0');
    expect(screen).toContain('<Heading level={2}>Program and oversight</Heading>{model.onboardingProgram.some((step) => step.active) ? null : <Body muted>{DEFAULT_ONBOARDING_STAFF_NOTE}</Body>}');
    for (const name of ['DEFAULT_ONBOARDING_NOTE', 'DEFAULT_ONBOARDING_STAFF_NOTE']) {
      const text = screen.match(new RegExp(`const ${name} = '([^']+)'`))?.[1];
      expect(text, name).toBeTruthy();
      expect(web).toContain(`"${text}"`);
    }
  });

  // Gate round 1 on: the steps named Settings and Learn, which the app
  // does not have. Every surface a step names must exist on both platforms.
  it('names only surfaces the app and the web both have', () => {
    const screen = source('./MemberSupportScreen.tsx');
    const block = screen.slice(screen.indexOf('const DEFAULT_ONBOARDING_STEPS'), screen.indexOf('];', screen.indexOf('const DEFAULT_ONBOARDING_STEPS')));
    expect(block).not.toMatch(/profile in Settings|Open Learn|shows who runs your chapter/);
    expect(block).toContain('Account in the app');
    expect(block).toContain('Find my committee contact on Home');
    expect(block).toContain('Open Organizing rights');
    expect(source('../../app/(tabs)/home.tsx')).toContain("accessibilityLabel={t(\"Account\")}");
    expect(source('../../app/(tabs)/home.tsx')).toContain("key: 'find-steward', label: t(\"Find my committee contact\")");
    expect(source('../lib/hatFunctions.ts')).toContain("label: 'Organizing rights', href: '/feature/rights'");
    // The web English area modules that hold nav.* and today.*.
    const i18n = source('../../../../src/lib/i18n/locales/en/shell.js') + source('../../../../src/lib/i18n/locales/en/home.js');
    expect(block).not.toContain('read the guides');
    // The last step links straight to the /feature/rights lesson index, whose
    // first lesson is one the preview ships; Account shows no campaign.
    expect(block).toContain('Open Organizing rights and start with the first lesson.');
    expect(source('../data/preview.ts')).toContain("title: 'Talking on non-work time'");
    expect(block).toContain('Then check your campaign (in Settings on the web, at the top of Home in the app)');
    expect(block).not.toMatch(/steward|chapter|disciplinary/i);
    expect(screen).toContain("index === DEFAULT_ONBOARDING_STEPS.length - 1 ? <Button label=\"Open Organizing rights\" variant=\"secondary\" onPress={() => router.push('/feature/rights')} /> : null");
  });

  it('keeps all three emergency scenarios, ordered onboarding, and staff oversight visible', () => {
    const screen = source('./MemberSupportScreen.tsx');
    expect(screen).toContain('EMERGENCY_SCENARIOS.map');
    expect(screen).toContain('Alerts needing a committee member response');
    expect(screen).toContain('Complete ${next.title}');
    expect(screen).toContain('Program and oversight');
    expect(screen).toContain('Save HR directory');
    expect(screen).toContain('Create mentorship pair');
    expect(screen).toContain('Complete pairing');
    expect(screen).toContain('Approve');
    expect(screen).toContain('function HandoffsPanel');
    expect(screen).toContain("tab === 'handoffs'");
    expect(screen).toContain("'staffOnly' in item");
    expect(screen).toContain('resolveMemberSupportHat(mode, previewHat, authorizedRoles, organizationRoles)');
    expect(screen).toContain('organizationID, organizationRoles, chapterRoles } = useApp()');
    expect(screen).toContain('Search workers for handoff');
    expect(screen).toContain('Search receiving committee members');
    expect(screen).toContain('Acknowledge handoff');
    expect(screen).toContain('Decline handoff');
    expect(screen).toContain('Cancel handoff');
    expect(screen).toContain('Handoff history is temporarily unavailable');
    expect(screen).toContain('historyRequestRef.current !== requestId');
    expect(screen).toContain("loadError: true");
  });

  it('keeps handoff initiation and preview actions scoped to the active persona', () => {
    expect(canInitiateMemberHandoff(['steward'])).toBe(true);
    expect(canInitiateMemberHandoff(['coordinator'])).toBe(true);
    expect(canInitiateMemberHandoff(['advisor'])).toBe(false);
    expect(canInitiateMemberHandoff(['admin'])).toBe(true);
    expect(canInitiateMemberHandoff(['vp'])).toBe(true);
    expect(canInitiateMemberHandoff(['advisor', 'steward'])).toBe(true);

    const pending = [{
      id: 'handoff',
      status: 'pending',
      initiatedBy: 'initiator-persona',
      fromStewardId: 'coordinator-persona',
      toStewardId: 'steward-persona',
      canAcknowledge: true,
      canDecline: true,
      canCancel: false,
    }];
    expect(scopePreviewHandoffActions(pending, 'steward-persona', 'steward')[0]).toMatchObject({
      direction: 'incoming',
      canAcknowledge: true,
      canDecline: true,
      canCancel: false,
    });
    expect(scopePreviewHandoffActions(pending, 'advisor-persona', 'advisor')[0]).toMatchObject({
      direction: 'overseen',
      canAcknowledge: false,
      canDecline: false,
      canCancel: true,
    });
    expect(scopePreviewHandoffActions(pending, 'coordinator-persona', 'coordinator')[0]).toMatchObject({
      direction: 'outgoing',
      canAcknowledge: false,
      canDecline: false,
      canCancel: true,
    });
    expect(scopePreviewHandoffActions(pending, 'coordinator-persona', 'steward')[0]).toMatchObject({
      direction: 'outgoing',
      canCancel: false,
    });
    expect(scopePreviewHandoffActions(pending, 'initiator-persona', 'steward')[0]).toMatchObject({
      direction: 'outgoing',
      canCancel: true,
    });

    const screen = source('./MemberSupportScreen.tsx');
    expect(screen).toContain('if (!canInitiate) return;');
    expect(screen).toContain('selectedMember.userId === selectedSteward.userId');
    expect(screen).toContain('disabled={disabled || (!selectedMember || !selectedSteward || selfHandoff)}');
    expect(screen).toContain("adapter.listHandoffs(actor, { status: currentStatus })");
    expect(screen).toContain('peopleSearchRequestRef.current[kind] !== requestId');
    expect(screen).toContain('currentQuery.trim() !== query');
    expect(screen).toContain('Latest page · ${loadedPendingCount} pending');
    expect(screen.match(/maxLength=\{100\}/g)).toHaveLength(2);
  });

  it('shares preview handoff changes across hats and limits receivers to committee member grants', () => {
    const directory = [
      { userId: 'sam', label: 'Sam Okafor', chapterId: 'wor', roles: ['steward'], switchablePreviewHat: true },
      { userId: 'maya', label: 'Maya Chen', chapterId: 'wor', roles: [] },
      { userId: 'jordan', label: 'Jordan Lee', chapterId: 'wor', roles: ['steward'] },
    ];
    expect(searchPreviewHandoffPeople('member', 'maya', directory)).toEqual([
      { userId: 'maya', displayName: 'Maya Chen' },
    ]);
    expect(searchPreviewHandoffPeople('steward', 'maya', directory)).toEqual([]);
    expect(searchPreviewHandoffPeople('steward', 'sam', directory)).toEqual([
      { userId: 'sam', displayName: 'Sam Okafor' },
    ]);
    expect(searchPreviewHandoffPeople('steward', 'jordan', directory)).toEqual([]);

    const seed: MemberHandoff[] = [{
      id: 'handoff',
      memberId: 'member',
      memberName: 'Worker',
      initiatedBy: 'coordinator',
      fromStewardId: 'coordinator',
      fromStewardName: 'Campaign lead',
      toStewardId: 'sam',
      toStewardName: 'Sam Okafor',
      direction: 'outgoing',
      status: 'pending',
      note: '',
      canAcknowledge: false,
      canDecline: false,
      canCancel: true,
      createdAt: '2026-08-31T00:00:00.000Z',
    }];
    expect(scopePreviewHandoffActions(readPreviewHandoffs(seed), 'sam', 'steward')[0]).toMatchObject({
      direction: 'incoming',
      canAcknowledge: true,
      canDecline: true,
      canCancel: false,
    });
    const unrelated = [{
      ...seed[0]!,
      id: 'unrelated-handoff',
      initiatedBy: 'coordinator',
      fromStewardId: 'coordinator',
      toStewardId: 'jordan',
    }];
    expect(scopePreviewHandoffActions(unrelated, 'sam', 'steward')).toEqual([]);
    expect(scopePreviewHandoffActions(unrelated, 'advisor', 'advisor')[0]).toMatchObject({
      direction: 'overseen',
    });
    updatePreviewHandoffs(seed, (current) => current.map((item) => ({
      ...item,
      status: 'acknowledged',
    })));
    expect(readPreviewHandoffs(seed)[0]?.status).toBe('acknowledged');

    resetPreviewHandoffs();
    expect(readPreviewHandoffs(seed)[0]?.status).toBe('pending');
    expect(source('../state/AppProvider.tsx')).toContain('resetPreviewHandoffs();');
    // The merged Worker support screen keeps the demo read-only ("Preview
    // changes are not saved."), so its pending count reads the loaded list.
    expect(source('./MemberSupportScreen.tsx')).toContain(
      "model.handoffs.items.filter((item) => item.status === 'pending').length",
    );
  });

  // BUG-UG-NATIVE-HR-CONTACT-RECORDER-DEFAULTS-MEMBER-SELECTOR-STAFF-MEMBER-S-20260921
  it('opens the staff HR contact recorder with no worker preselected', () => {
    const screen = source('./MemberSupportScreen.tsx');
    expect(screen).toContain("useBusinessDraftState(model.staff ? '' : model.viewerUserId ?? '')");
    expect(screen).not.toContain("const [memberUserId, setMemberUserId] = useBusinessDraftState(model.viewerUserId ?? '');");
    expect(screen).toContain('(model.staff && !memberUserId)');
    expect(screen).toContain('memberUserId: model.staff ? memberUserId : null');
  });

  it('separates failed Worker Support outcomes from successful ones', async () => {
    // A settled write keeps the success tone; a rejected one carries the error
    // tone, which is the branch that renders the shared destructive Notice.
    await expect(settleMemberSupportCommit(async () => 'written', 'Accommodation request sent.'))
      .resolves.toEqual({ ok: true, notice: { message: 'Accommodation request sent.', tone: 'success' } });
    await expect(settleMemberSupportCommit(async () => { throw new Error('refused'); }, 'Accommodation request sent.'))
      .resolves.toEqual({ ok: false, notice: { message: MEMBER_SUPPORT_COMMIT_FAILURE, tone: 'error' } });
    // The reload that follows a live write is inside the same operation, so a
    // workspace that fails to come back is a failure too, never a confirmation.
    const rejectedReload = await settleMemberSupportCommit(async () => {
      await Promise.resolve();
      throw new Error('workspace reload failed');
    }, 'Emergency alert resolved.');
    expect(isFailureNotice(rejectedReload.notice)).toBe(true);
    expect(isFailureNotice(successNotice('Emergency alert resolved.'))).toBe(false);
    expect(failureNotice('Handoff history could not be refreshed.')).toEqual({
      message: 'Handoff history could not be refreshed.',
      tone: 'error',
    });
    expect(successNotice('')).toBeNull();
    expect(failureNotice('')).toBeNull();

    const screen = source('./MemberSupportScreen.tsx');
    // Every handoff notice the panel raises is either a clear or an error tone;
    // none may reach the success-styled setter as a bare string again.
    const handoffNotices = [...screen.matchAll(/onNotice\((.{0,14})/g)].map((match) => match[1] ?? '');
    expect(handoffNotices.length).toBeGreaterThanOrEqual(7);
    for (const call of handoffNotices) {
      expect(call.startsWith('null)') || call.startsWith('failureNotice(')).toBe(true);
    }
    for (const message of [
      "failureNotice('Handoff history could not be refreshed.')",
      "failureNotice('Handoff history could not be filtered.')",
      "failureNotice('Older handoffs could not be loaded.')",
      'search could not be completed.`)',
    ]) expect(screen).toContain(message);

    // The two tones render differently: destructive Notice for errors, the
    // primary-colored live line for confirmations.
    expect(screen).toContain("notice.tone === 'error'");
    expect(screen).toContain('<Notice key={notice.attempt}>{notice.message}</Notice>');
    // The Notice announces itself, so the screen's iOS queue skips error tones
    // and each failure is heard once.
    expect(screen).toContain("if (notice.message && notice.tone !== 'error' && Platform.OS === 'ios') {");
    expect(screen).toContain('<Body style={{ color: theme.primary }}><Text accessibilityLiveRegion="polite">{notice.message === BUSINESS_SAVED_STALE ? t(BUSINESS_SAVED_STALE) : notice.message}</Text></Body>');
    expect(screen).toContain("useBusinessDraftState<{ message: string; tone: MemberSupportNoticeTone; attempt: number }>({ message: '', tone: 'success', attempt: 0 })");
    expect(screen).not.toContain("setNotice('That change was not confirmed. Try again.')");
    expect(screen).not.toMatch(/\{notice\.message \? </);

    // The destructive cue and its single announcement live in the shared
    // component, so pin them here too.
    const ui = source('../components/ui.tsx');
    expect(ui).toMatch(/export function Notice\(\{ children\b/);
    expect(ui).toContain('borderColor: theme.destructive');
    expect(ui).toContain('name="alert-circle"');
    expect(ui).toContain('accessibilityLiveRegion="polite"');
  });

  it('uses semantic theme tokens, 48-point controls, and a coherent rolling preview history', () => {
    const screen = source('./MemberSupportScreen.tsx');
    expect(screen).toContain('minimumTouchTarget');
    expect(screen).toContain('theme.quietForeground');
    expect(screen).toContain('accessibilityRole="button"');
    expect(screen).toContain('accessibilityState={{ selected: tab === item.id }}');
    expect(screen).not.toContain('accessibilityRole="tab"');
    expect(screen).toContain("'2024-11-07T15:30:00.000Z'");
    expect(screen).toContain("'2025-03-18T14:00:00.000Z'");
    expect(screen).toContain("'2025-10-09T16:00:00.000Z'");
    expect(screen).toContain("'2026-08-12T17:00:00.000Z'");
    expect(screen).toContain("'2026-08-19T14:30:00.000Z'");
    expect(screen).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

// While an earlier write is unconfirmed the
// mentorship card's write controls are withdrawn, and a draft is cleared only
// after commit says the write was sent. The card is the real
// MentorshipPairCard from the screen, drawn on the shared stand-in.
function mentorshipPairCard() {
  const path = './MemberSupportScreen.tsx';
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'MentorshipPairCard');
  if (!declaration) throw new Error('Missing MentorshipPairCard');
  const js = ts.transpile(`(${declaration.getText(file)})`, {
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment',
  });
  return runInNewContext(js, {
    h, Fragment, useTheme: () => ({}), useBusinessDraftState: useState, styles: {},
    Card: ui.Card, Body: ui.Body, Heading: ui.Heading, Button: ui.Button,
    Pressable: native.Pressable, Text: native.Text, TextInput: native.TextInput, View: native.View,
  }) as (props: Record<string, unknown>) => ReturnType<typeof h>;
}

describe('mentorship card writes (ledger 694)', () => {
  const pair = {
    id: 'pair-a', status: 'active', startedOn: '2026-11-01', outcome: null, mentorLabel: 'Mentor A', menteeLabel: 'Mentee B',
    goals: [{ id: 'goal-a', title: 'Learn the contract', completed: false }], notes: [],
  };
  const adapter = { saveMentorshipGoal: vi.fn(), addMentorshipNote: vi.fn(), transitionMentorshipPair: vi.fn() };
  const platforms: ('ios' | 'android')[] = ['ios', 'android'];
  let view: native.Rendered | null = null;
  afterEach(async () => { await view?.unmount(); view = null; native.setPlatform('ios'); });

  async function card(platform: 'ios' | 'android', disabled: boolean, commit: (operation: () => Promise<unknown>, success: string) => Promise<boolean>) {
    native.setPlatform(platform);
    view = await native.render(h(mentorshipPairCard(), { pair, staff: true, actor: {}, adapter, busy: false, disabled, commit }));
    const field = (name: string) => native.getExposed(view!.container, name) as HTMLInputElement;
    await native.type(field('New goal for Mentee B'), 'Bring the grievance file');
    await native.type(field('New note for Mentee B'), 'Met after the shift');
    return { container: view.container, field };
  }

  it.each(platforms)('withdraws every write control while an earlier write is unconfirmed on %s, and keeps both drafts', async (platform) => {
    const commit = vi.fn(async () => false);
    const { container, field } = await card(platform, true, commit);
    for (const name of ['Add goal', 'Add note', 'Complete pairing', 'Cancel pairing', /Learn the contract/u]) {
      const control = native.getExposed(container, name);
      expect(control.getAttribute('aria-disabled'), String(name)).toBe('true');
      await native.press(control);
    }
    expect(commit).not.toHaveBeenCalled();
    expect(field('New goal for Mentee B').value).toBe('Bring the grievance file');
    expect(field('New note for Mentee B').value).toBe('Met after the shift');
  });

  it.each(platforms)('keeps the typed goal and note when commit refuses on %s', async (platform) => {
    const commit = vi.fn(async () => false);
    const { container, field } = await card(platform, false, commit);
    await native.press(native.getExposed(container, 'Add goal'));
    await native.press(native.getExposed(container, 'Add note'));
    expect(commit).toHaveBeenCalledTimes(2);
    expect(field('New goal for Mentee B').value).toBe('Bring the grievance file');
    expect(field('New note for Mentee B').value).toBe('Met after the shift');
  });

  it.each(platforms)('clears the goal and note only once commit sends them on %s', async (platform) => {
    const commit = vi.fn<(operation: () => Promise<unknown>, success: string) => Promise<boolean>>(async () => true);
    const { container, field } = await card(platform, false, commit);
    await native.press(native.getExposed(container, 'Add goal'));
    await native.press(native.getExposed(container, 'Add note'));
    expect(commit.mock.calls.map(([, success]) => success)).toEqual(['Mentorship goal saved.', 'Mentorship note saved.']);
    expect(field('New goal for Mentee B').value).toBe('');
    expect(field('New note for Mentee B').value).toBe('');
  });

  it.each(platforms)('keeps text typed while the write is pending when commit sends the earlier draft on %s', async (platform) => {
    const sent: Array<(saved: boolean) => void> = [];
    const commit = vi.fn<(operation: () => Promise<unknown>, success: string) => Promise<boolean>>(
      () => new Promise<boolean>((resolve) => { sent.push(resolve); }),
    );
    const { container, field } = await card(platform, false, commit);
    await native.press(native.getExposed(container, 'Add goal'));
    await native.press(native.getExposed(container, 'Add note'));
    await native.type(field('New goal for Mentee B'), 'Ask about overtime');
    await native.type(field('New note for Mentee B'), 'Follow up on Friday');
    await act(async () => { for (const resolve of sent) resolve(true); });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(field('New goal for Mentee B').value).toBe('Ask about overtime');
    expect(field('New note for Mentee B').value).toBe('Follow up on Friday');
  });
});

//  (M2-7): a request that is not sent stays in the box, as the
// mentorship goal and note do. The panel is the real AccommodationPanel.
describe('accommodation request draft (record #9469)', () => {
  const path = './MemberSupportScreen.tsx';
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'AccommodationPanel');
  if (!declaration) throw new Error('Missing AccommodationPanel');
  const js = ts.transpile(`(${declaration.getText(file)})`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' });
  const AccommodationPanel = runInNewContext(js, {
    h, Fragment, useTheme: () => ({}), useBusinessDraftState: useState, styles: {}, ACCOMMODATION_TYPES: ['schedule'],
    useNativeUi: () => ({ t: (key: string) => key }), accommodationTypes: { schedule: 'Schedule' },
    choiceLabel: (labels: Record<string, string>, value: string) => labels[value] ?? value,
    radioChoiceLabel: () => undefined, label: (value: string) => value, formatDate: String, StateMessage: () => null,
    accommodationStatusLabel: (status: string) => `Request ${status}`,
    Card: ui.Card, Body: ui.Body, Heading: ui.Heading, Button: ui.Button,
    Pressable: native.Pressable, Text: native.Text, TextInput: native.TextInput, View: native.View,
  }) as (props: Record<string, unknown>) => ReturnType<typeof h>;
  let view: native.Rendered | null = null;
  afterEach(async () => { await view?.unmount(); view = null; native.setPlatform('ios'); });

  it.each<'ios' | 'android'>(['ios', 'android'])('keeps the typed request when it is not sent, and clears it once sent, on %s', async (platform) => {
    native.setPlatform(platform);
    const commit = vi.fn<(operation: () => Promise<unknown>, success: string) => Promise<boolean>>(async () => false);
    const model = { accommodations: [], staff: false, viewerUserId: 'member-a' };
    view = await native.render(h(AccommodationPanel, { model, actor: {}, adapter: { createAccommodation: vi.fn() }, busy: false, disabled: false, commit }));
    const box = () => native.getExposed(view!.container, 'Requested accommodation') as HTMLInputElement;
    await native.type(box(), 'Move my shift start to 9 AM');
    await native.press(native.getExposed(view.container, 'Submit request'));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('Move my shift start to 9 AM');
    commit.mockResolvedValueOnce(true);
    await native.press(native.getExposed(view.container, 'Submit request'));
    expect(box().value).toBe('');
  });

  // The function-test bot reads a request's status
  // only inside that request's own named container.
  it('names each request and its own status, inside that request only', async () => {
    const request = (id: string, description: string, status: string) => ({ id, memberUserId: 'member-a', memberLabel: 'Avery Lake', requestType: 'schedule', description, status, staffNote: '', submittedAt: '2026-11-20T15:00:00Z' });
    const model = { accommodations: [request('a', 'Mat (ref one)', 'withdrawn'), request('b', 'Chair (ref two)', 'submitted')], staff: false, viewerUserId: 'member-a' };
    view = await native.render(h(AccommodationPanel, { model, actor: {}, adapter: {}, busy: false, disabled: false, commit: vi.fn(async () => true) }));
    const rows = [...view.container.querySelectorAll('[data-testid="accommodation-request"]')];
    // Each card carries exactly one of the two references, each reference is on
    // one card only, and a card with neither fails.
    expect(rows.map((row) => ['(ref one)', '(ref two)'].filter((ref) => row.textContent?.includes(ref)))).toEqual([['(ref one)'], ['(ref two)']]);
    expect(rows.map((row) => [...row.querySelectorAll('[data-testid="accommodation-request-status"]')].map((node) => node.textContent))).toEqual([['Request withdrawn'], ['Request submitted']]);
  });
});
