import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { deriveLiveStaffRoles, narrowLiveStaffRoles, type LiveStaffRoles } from './hatFunctions';
import { FEATURE_KEYS, FORM_TEMPLATES, canOpenFeature, featurePath, isFeatureKey, isStaffDeskFeatureKey, isStaffOnlyFeatureKey } from './featureCatalog';
import { functionsForHat, LIVE_STAFF_DESK_LINES, MEMBER_HAT_FUNCTIONS, MEMBER_WORK_WIDGETS, workItemsForHat } from './hatFunctions';
import { PREVIEW_HEALTH_PORTFOLIO, PREVIEW_NOW, previewBallotCardState, previewBallotIsOpen, previewDeskFor, previewWorkDayDiff, previewWorkIsOverdue } from '../data/preview';

const WORK_WIDGET_PREVIEW_FIXTURE_MODULES = new Set([
  '../data/preview',
  '../lib/featureCatalog',
]);

function isPreviewDeskPresentCondition(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isPreviewDeskPresentCondition(node.expression);
  return ts.isIdentifier(node) && node.text === 'desk';
}

function isInsidePreviewDeskBranch(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isConditionalExpression(parent)
      && parent.whenTrue.pos <= node.pos
      && node.end <= parent.whenTrue.end
      && isPreviewDeskPresentCondition(parent.condition)) return true;
    if (ts.isIfStatement(parent)
      && parent.thenStatement.pos <= node.pos
      && node.end <= parent.thenStatement.end
      && isPreviewDeskPresentCondition(parent.expression)) return true;
    current = parent;
  }
  return false;
}

// Copy that is only true of a preview desk. A live, authenticated session has
// desk === null, so a widget row may only say "preview session" inside a
// desk-present branch.
const PREVIEW_SESSION_COPY = /preview session/i;

function unguardedPreviewSessionRowCopy(source: string): string[] {
  const sourceFile = ts.createSourceFile('WorkWidgets.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const unguarded = new Set<string>();

  const collect = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
      && PREVIEW_SESSION_COPY.test(node.getText())
      && !isInsidePreviewDeskBranch(node)) {
      unguarded.add(node.getText().slice(1, -1));
    }
    ts.forEachChild(node, collect);
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'rowsFor') {
      collect(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...unguarded].sort();
}

function unguardedWorkWidgetPreviewFixtures(source: string): string[] {
  const sourceFile = ts.createSourceFile('WorkWidgets.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const previewFixtures = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !WORK_WIDGET_PREVIEW_FIXTURE_MODULES.has(statement.moduleSpecifier.text)
      || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;

    for (const binding of statement.importClause.namedBindings.elements) {
      if (!statement.importClause.isTypeOnly && !binding.isTypeOnly) previewFixtures.add(binding.name.text);
    }
  }

  const unguarded = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)
      && previewFixtures.has(node.text)
      && !ts.isImportSpecifier(node.parent)
      && !isInsidePreviewDeskBranch(node)) {
      unguarded.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...unguarded].sort();
}

describe('standalone feature destinations', () => {
  it('keeps every desktop worker destination inside the app', () => {
    expect(FEATURE_KEYS).toContain('voting');
    expect(FEATURE_KEYS).toContain('forms');
    expect(FEATURE_KEYS).toContain('tasks');
    expect(FEATURE_KEYS).toContain('pay');
    expect(FEATURE_KEYS).toContain('organizer');
    // Dues belong to an existing union and do not ship.
    expect(FEATURE_KEYS as readonly string[]).not.toContain('dues');
    expect(FEATURE_KEYS).toContain('integrations');
    expect(FEATURE_KEYS).toContain('operations');
    expect(FEATURE_KEYS).toContain('chapter-health');
    expect(isFeatureKey('voting')).toBe(true);
    expect(isFeatureKey('browser')).toBe(false);
    expect(FORM_TEMPLATES).toHaveLength(7);
  });

  // Chapter-membership administration must match grant/revoke/set_member_chapter_role:
  // an organization administrator anywhere in the organization, a chapter
  // administrator inside their own chapter, and nobody else.
  it('opens chapter-membership administration exactly where the membership RPCs authorize it', () => {
    expect(canOpenFeature('authenticated', 'chapter-memberships', null, ['admin'], [])).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-memberships', null, [], ['admin'])).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-memberships', null, [], ['vp'])).toBe(false);
    expect(canOpenFeature('authenticated', 'chapter-memberships', null, ['steward'], [])).toBe(false);
    expect(canOpenFeature('authenticated', 'chapter-memberships', null, [], [])).toBe(false);
    expect(canOpenFeature('signedOut', 'chapter-memberships', null, ['admin'], ['admin'])).toBe(false);
    expect(canOpenFeature('preview', 'chapter-memberships', 'admin')).toBe(true);
    expect(canOpenFeature('preview', 'chapter-memberships', 'vp')).toBe(false);
    expect(canOpenFeature('preview', 'chapter-memberships', 'member')).toBe(false);
  });

  // The binding and connection decisions are granted to an organization-wide
  // administrator alone (verify_chapter_union_org_binding and
  // verify_chapter_connection_setup are service-role RPCs behind an
  // organization-scope check). Both destinations that carry them must open
  // for an organization administrator who holds no duplicate chapter
  // assignment, or the only authorized reviewer is locked out of the decision.
  it('opens the destinations that carry a verification decision to an organization-scoped administrator', () => {
    expect(canOpenFeature('authenticated', 'admin', null, [], ['admin'])).toBe(true);
    expect(canOpenFeature('authenticated', 'partners', null, [], ['admin'])).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-memberships', null, [], ['admin'])).toBe(true);
    // Scope widens for the Admin hat (and the coordinator's Case queue, #9098);
    // every other staff tool and desk still needs the hat's own chapter assignment.
    expect(canOpenFeature('authenticated', 'partners', null, [], ['steward'])).toBe(false);
    expect(canOpenFeature('authenticated', 'partners', null, [], ['vp'])).toBe(false);
    expect(canOpenFeature('authenticated', 'steward', null, [], ['steward'])).toBe(false);
    expect(canOpenFeature('authenticated', 'coordinator', null, [], ['coordinator'])).toBe(true);
    expect(canOpenFeature('authenticated', 'tasks', null, [], ['admin'])).toBe(false);
    expect(canOpenFeature('authenticated', 'events-desk', null, [], ['admin'])).toBe(false);
  });

  it('authorizes live worker features and scopes live staff desks to database roles', () => {
    expect(canOpenFeature('authenticated', 'voting', null)).toBe(true);
    expect(canOpenFeature('authenticated', 'organizer', null)).toBe(false);
    expect(canOpenFeature('authenticated', 'organizer', null, ['organizer'])).toBe(true);
    expect(canOpenFeature('authenticated', 'organizer', null, ['organizer', 'steward'])).toBe(false);
    expect(canOpenFeature('authenticated', 'admin', null)).toBe(false);
    expect(canOpenFeature('authenticated', 'admin', null, ['admin'])).toBe(true);
    expect(canOpenFeature('authenticated', 'admin', null, ['admin', 'steward'])).toBe(false);
    expect(canOpenFeature('authenticated', 'admin', null, ['steward'])).toBe(false);
    expect(canOpenFeature('authenticated', 'tasks', null)).toBe(false);
    expect(canOpenFeature('authenticated', 'tasks', null, ['steward'])).toBe(true);
    expect(canOpenFeature('signedOut', 'forms', null)).toBe(false);
    expect(canOpenFeature('preview', 'voting', 'member')).toBe(true);
    // The Organizing desk belongs to the Organizer hat alone.
    expect(canOpenFeature('preview', 'organizer', 'organizer')).toBe(true);
    expect(canOpenFeature('preview', 'organizer', 'member')).toBe(false);
    expect(canOpenFeature('preview', 'organizer', 'steward')).toBe(false);
    expect(canOpenFeature('preview', 'tasks', 'organizer')).toBe(true);
    expect(canOpenFeature('preview', 'admin', 'member')).toBe(false);
    expect(canOpenFeature('preview', 'admin', 'admin')).toBe(true);
    expect(canOpenFeature('preview', 'vp', 'steward')).toBe(false);
    expect(canOpenFeature('preview', 'vp', 'vp')).toBe(true);
    expect(canOpenFeature('preview', 'tasks', 'member')).toBe(false);
    expect(canOpenFeature('preview', 'tasks', null)).toBe(false);
    expect(canOpenFeature('preview', 'tasks', 'steward')).toBe(true);
    expect(canOpenFeature('preview', 'tasks', 'vp')).toBe(true);
    expect(canOpenFeature('preview', 'events-desk', 'member')).toBe(false);
    expect(canOpenFeature('preview', 'events-desk', 'steward')).toBe(true);
    expect(canOpenFeature('preview', 'campaigns', 'member')).toBe(false);
    expect(canOpenFeature('preview', 'campaigns', 'admin')).toBe(true);
    expect(canOpenFeature('preview', 'integrations', 'admin')).toBe(true);
    expect(canOpenFeature('preview', 'integrations', 'steward')).toBe(false);
    expect(canOpenFeature('authenticated', 'integrations', null, [], ['admin'])).toBe(true);
    expect(canOpenFeature('authenticated', 'integrations', null, ['admin'])).toBe(false);
    expect(canOpenFeature('preview', 'operations', 'admin')).toBe(true);
    expect(canOpenFeature('preview', 'operations', 'vp')).toBe(false);
    expect(canOpenFeature('authenticated', 'operations', null, [], ['admin'])).toBe(true);
    expect(canOpenFeature('authenticated', 'operations', null, [], ['vp'])).toBe(false);
    expect(canOpenFeature('preview', 'events', 'member')).toBe(true);
    expect(canOpenFeature('preview', 'chapters', 'member')).toBe(true);
    expect(canOpenFeature('preview', 'chapter-health', 'member')).toBe(false);
    expect(canOpenFeature('preview', 'chapter-health', 'steward')).toBe(false);
    expect(canOpenFeature('preview', 'chapter-health', 'advisor')).toBe(true);
    expect(canOpenFeature('preview', 'chapter-health', 'admin')).toBe(true);
    expect(canOpenFeature('preview', 'chapter-health', 'vp')).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-health', null, ['advisor'])).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-health', null, ['admin'])).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-health', null, ['vp'])).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-health', null, ['steward'])).toBe(false);
    expect(canOpenFeature('authenticated', 'chapter-health', null, ['advisor', 'admin'])).toBe(false);
    expect(canOpenFeature('authenticated', 'chapter-health', null, [], ['advisor'])).toBe(true);
    expect(canOpenFeature('authenticated', 'tasks', null, [], ['admin'])).toBe(false);
    expect(canOpenFeature('authenticated', 'analytics', null, ['admin'])).toBe(false);
    expect(canOpenFeature('authenticated', 'analytics', null, [], ['admin'])).toBe(true);
    expect(canOpenFeature('preview', 'partners', 'member')).toBe(false);
    expect(canOpenFeature('preview', 'partners', 'steward')).toBe(true);
    expect(canOpenFeature('authenticated', 'partners', null)).toBe(false);
    expect(canOpenFeature('authenticated', 'partners', null, ['advisor'])).toBe(true);
    expect(canOpenFeature('authenticated', 'partners', null, ['advisor', 'steward'])).toBe(false);
    expect(isStaffDeskFeatureKey('admin')).toBe(true);
    expect(isStaffDeskFeatureKey('voting')).toBe(false);
    const featureScreen = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
    expect(featureScreen).toContain('canOpenFeature(mode, featureKey, previewHat, chapterRoles, organizationRoles)');
    expect(featureScreen).toContain('queueAnnouncement(copy.confirmAnnouncement(action, item.title))');
    const handshakeScreen = featureScreen.slice(
      featureScreen.indexOf('function LivePartnersFeature()'),
      featureScreen.indexOf('function LiveHealthFeature'),
    );
    expect(handshakeScreen.indexOf('confirming?.item.id === item.id')).toBeGreaterThan(handshakeScreen.indexOf('(items ?? []).map'));
    expect(handshakeScreen).toContain('accessibilityRole="alert" accessibilityLiveRegion="assertive"');
    expect(featureScreen).toContain('accessibilityRole="radiogroup"');
    expect(featureScreen).toContain('accessibilityState={{ selected: attentionLevel === level }}');
    expect(featureScreen).toContain('sparkBar: { width: 18');
    expect(featureScreen).toContain('accessibilityLabel="Campaign health score history"');
    expect(featureScreen).toContain("{ month: 'short', year: '2-digit' }");
    expect(featureScreen).toContain('recordMobileHealthSnapshot(writer, selectedChapterID, snapshotDate, drivers)');
    expect(featureScreen).toContain('Record snapshot');
    expect(featureScreen).toContain('Correct latest snapshot');
    expect(featureScreen).toContain('Measured date, year month day');
    expect(featureScreen).toContain("editable={snapshotMode !== 'correct'}");
    expect(featureScreen).toContain('chapter.databaseDate');
    expect(featureScreen).toContain('Saving a date already shown records an attributed correction.');
    expect(featureScreen).toContain('function openCoaching(nextChapterID: string)');
    // #9240 pull request C: the held coaching entry opens fresh, at support.
    expect(featureScreen).toContain("const COACHING_EMPTY: CoachingDraft = { chapter: null, summary: '', nextAction: '', attentionLevel: 'support' };");
    expect(featureScreen).toContain('coaching.set(() => ({ ...COACHING_EMPTY, chapter: nextChapterID }));');
    expect(featureScreen).toContain('onPress={() => openCoaching(chapter.chapterId)}');
    expect(featureScreen).toContain('onPress={cancelCoaching}');
    expect(featureScreen).toContain('{staff ? <Button label="Campaign handshakes"');
    expect(featureScreen).not.toContain("if (featureKey === 'dues')");
    expect(featureScreen).not.toContain('DuesScreen');
  });

  it('scopes the one-on-one desk to the Committee hat in every mode', () => {
    expect(FEATURE_KEYS).toContain('steward-appointments');
    expect(featurePath('steward-appointments')).toBe('/feature/steward-appointments');
    expect(canOpenFeature('preview', 'steward-appointments', 'steward')).toBe(true);
    expect(canOpenFeature('preview', 'steward-appointments', 'member')).toBe(false);
    expect(canOpenFeature('preview', 'steward-appointments', 'admin')).toBe(false);
    expect(canOpenFeature('authenticated', 'steward-appointments', null)).toBe(false);
    expect(canOpenFeature('authenticated', 'steward-appointments', null, ['steward'])).toBe(true);
    expect(canOpenFeature('authenticated', 'steward-appointments', null, [], ['steward'])).toBe(false);
    expect(canOpenFeature('authenticated', 'steward-appointments', null, ['admin'])).toBe(false);
    expect(canOpenFeature('authenticated', 'steward-appointments', null, ['steward', 'admin'])).toBe(false);
    expect(canOpenFeature('signedOut', 'steward-appointments', null)).toBe(false);
    expect(isStaffOnlyFeatureKey('steward-appointments')).toBe(true);
    expect(isStaffOnlyFeatureKey('appointments')).toBe(false);
    // Routing: the One-on-ones row's href resolves to its own feature key,
    // never to the Committee desk ('steward') whose evidence loader reads
    // member_cases.
    const featureScreen = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
    expect(featureScreen).toContain("if (featureKey === 'steward-appointments') return <StewardAppointmentsFeature />;");
    expect(featureScreen).toContain("'steward-appointments'");
    // Any other preview hat must get the Committee-only gate, not the generic
    // organizing-tool gate that names every organizing hat.
    expect(featureScreen).toContain("if (featureKey === 'steward-appointments') {");
    expect(featureScreen).toContain('title={`${title} opens under Committee`}');
    expect(featureScreen).toContain("qualifyingHats={['steward']}");
  });

  it('scopes the four committee member desk sections to the committee member hat in every mode', () => {
    const keys: readonly ('steward-caseload' | 'steward-requests' | 'steward-forms' | 'steward-broadcasts')[] = ['steward-caseload', 'steward-requests', 'steward-forms', 'steward-broadcasts'];
    for (const key of keys) {
      expect(FEATURE_KEYS).toContain(key);
      expect(featurePath(key)).toBe(`/feature/${key}`);
      expect(canOpenFeature('preview', key, 'steward')).toBe(true);
      expect(canOpenFeature('preview', key, 'member')).toBe(false);
      expect(canOpenFeature('preview', key, 'admin')).toBe(false);
      expect(canOpenFeature('authenticated', key, null)).toBe(false);
      expect(canOpenFeature('authenticated', key, null, ['steward'])).toBe(true);
      expect(canOpenFeature('authenticated', key, null, [], ['steward'])).toBe(false);
      expect(canOpenFeature('authenticated', key, null, ['admin'])).toBe(false);
      expect(canOpenFeature('authenticated', key, null, ['steward', 'admin'])).toBe(false);
      expect(canOpenFeature('signedOut', key, null)).toBe(false);
      expect(isStaffOnlyFeatureKey(key)).toBe(true);
    }
  });

  it('fails ambiguous live staff identities closed across route-adjacent consumers', () => {
    const appProvider = readFileSync(fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)), 'utf8');
    const caseDetail = readFileSync(fileURLToPath(new URL('../../app/issue/[id].tsx', import.meta.url)), 'utf8');
    const shareIntake = readFileSync(fileURLToPath(new URL('../../app/share-intake.tsx', import.meta.url)), 'utf8');
    const memberSupport = readFileSync(fileURLToPath(new URL('../features/MemberSupportScreen.tsx', import.meta.url)), 'utf8');
    const qaScreen = readFileSync(fileURLToPath(new URL('../features/mi1/Mi1QaFeatureScreen.tsx', import.meta.url)), 'utf8');
    const messages = readFileSync(fileURLToPath(new URL('../../app/messages.tsx', import.meta.url)), 'utf8');

    expect(caseDetail).toContain("const liveStaffHat = mode === 'authenticated' ? explicitLiveStaffHat(authorizedRoles) : null;");
    expect(caseDetail).toContain("const coordinatorAccess = liveStaffHat === 'coordinator';");
    expect(caseDetail).not.toContain("authorizedRoles.includes('coordinator')");
    expect(shareIntake).toContain("const liveStaffHat = mode === 'authenticated' ? explicitLiveStaffHat(authorizedRoles) : null;");
    expect(shareIntake).toContain("coordinatorAccess: liveStaffHat === 'coordinator'");
    expect(shareIntake).toContain('staffTaskAccess: liveStaffHat ? isStaffTaskAttachmentRole([liveStaffHat]) : false');
    expect(shareIntake).not.toContain('isStaffTaskAttachmentRole(authorizedRoles)');
    expect(memberSupport).toContain("canInitiateMemberHandoff(selectedHat === 'member' ? [] : [selectedHat])");
    expect(memberSupport).not.toContain('canInitiateMemberHandoff(organizationRoles)');
    expect(messages).toContain("mode === 'authenticated' ? explicitLiveStaffHat(authorizedRoles) : null");
    expect(messages).toContain('{staffBriefingHat ? (');
    expect(messages).not.toContain('{authorizedRoles.length > 0 ? (');
    expect(appProvider).toContain('return staffConfirmed ? scope : null');
    expect(appProvider).toContain('return null;');
    expect(appProvider).toContain('const staffScopeAvailable = organizationStaffScope !== null');
    expect(deriveLiveStaffRoles({ mode: 'authenticated', previewRoles: [], organizationStaffScope: null })).toEqual({
      organizationRoles: [], chapterRoles: [], authorizedRoles: [],
    });
    expect(appProvider).toContain('organizationStaffScope?.organizationID ?? selectedMembership?.organizationID ?? null');
    expect(appProvider).toContain("import { deriveLiveStaffRoles, narrowLiveStaffRoles, selectableLiveStaffRoles, type WidgetLayout } from '../lib/hatFunctions'");
    expect(appProvider).toContain('const liveStaffRoles = deriveLiveStaffRoles({');
    expect(appProvider).not.toContain('organizationStaffScope?.roles ?? selectedMembership?.organizationRoles');
    expect(appProvider).not.toContain('...(selectedMembership?.chapterRoles ?? [])');
    expect(memberSupport).toContain('chapterRoles,');
    expect(memberSupport).not.toContain('chapterRoles: selectedMembership?.chapterRoles');
    expect(qaScreen).toContain('chapterRoles,');
    expect(qaScreen).not.toContain('chapterRoles: selectedMembership?.chapterRoles');
    const switchChapter = appProvider.slice(
      appProvider.indexOf('const switchChapter = useCallback'),
      appProvider.indexOf('const setChapterPinned = useCallback'),
    );
    expect(switchChapter.indexOf('setOrganizationStaffScope(null)')).toBeGreaterThan(-1);
    expect(switchChapter.indexOf('setOrganizationStaffScope(null)')).toBeLessThan(switchChapter.indexOf('setChapterMemberships'));
  });

  it('keeps the preview health widget truthful and the full rolling history reachable', () => {
    const history = PREVIEW_HEALTH_PORTFOLIO.find((chapter) => !chapter.cohortProtected)?.trend ?? [];
    expect(history).toHaveLength(12);
    expect(history[0]?.measuredOn).toBe('2023-09-15');
    expect(history.at(-1)?.measuredOn).toBe('2026-08-15');
    const widgets = readFileSync(fileURLToPath(new URL('../components/WorkWidgets.tsx', import.meta.url)), 'utf8');
    expect(widgets).toContain("if (desk && source === 'health')");
    expect(widgets).toContain('const chapter = desk');
    expect(widgets).toContain('PREVIEW_HEALTH_PORTFOLIO.find');
    expect(widgets).toContain("id: 'health-score'");
    expect(widgets).toContain("id: 'health-trend'");
    expect(widgets).toContain("chapter.coaching.length === 1 ? 'entry' : 'entries'");
  });

  it('never tells a live authenticated session that its roles are a preview', () => {
    const widgets = readFileSync(fileURLToPath(new URL('../components/WorkWidgets.tsx', import.meta.url)), 'utf8');
    expect(unguardedPreviewSessionRowCopy(widgets)).toEqual([]);
    expect(widgets).toContain("const LIVE_ACCESS_EMPTY_LINE = 'Roles and access are managed on the full screen.'");
    expect(widgets).toContain('empty: LIVE_ACCESS_EMPTY_LINE,');
    expect(widgets).not.toContain("desk?.chapterName ?? 'This campaign'");

    const unguardedAccessRow = `
      function rowsFor(item) {
        return {
          href: item.href,
          rows: [{ id: 'campaign', primary: desk?.chapterName ?? 'This campaign', secondary: 'Roles and access stay in this PREVIEW session' }],
        };
      }
    `;
    expect(unguardedPreviewSessionRowCopy(unguardedAccessRow)).toEqual(['Roles and access stay in this PREVIEW session']);

    const guardedAccessRow = `
      function rowsFor(item) {
        return {
          href: item.href,
          rows: desk ? [{ id: 'campaign', primary: desk.chapterName, secondary: 'Roles and access stay in this PREVIEW session' }] : [],
        };
      }
    `;
    expect(unguardedPreviewSessionRowCopy(guardedAccessRow)).toEqual([]);
  });

  it('keeps every Work widget preview fixture behind the preview desk boundary', () => {
    const widgets = readFileSync(fileURLToPath(new URL('../components/WorkWidgets.tsx', import.meta.url)), 'utf8');
    expect(unguardedWorkWidgetPreviewFixtures(widgets)).toEqual([]);

    const unguardedNewFixture = `
      import { NEW_PREVIEW_FIXTURE } from '../data/preview';
      export function rowsFor() {
        return NEW_PREVIEW_FIXTURE.map((entry) => entry);
      }
    `;
    expect(unguardedWorkWidgetPreviewFixtures(unguardedNewFixture)).toEqual(['NEW_PREVIEW_FIXTURE']);

    const invertedPreviewGuard = unguardedNewFixture.replace(
      'return NEW_PREVIEW_FIXTURE.map((entry) => entry);',
      'return !desk ? NEW_PREVIEW_FIXTURE.map((entry) => entry) : [];',
    );
    expect(unguardedWorkWidgetPreviewFixtures(invertedPreviewGuard)).toEqual(['NEW_PREVIEW_FIXTURE']);
  });

  it('keeps the selected live leadership destination title above the shared health portfolio', () => {
    const featureScreen = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
    expect(featureScreen).toContain("if (featureKey === 'chapter-health' || featureKey === 'advisor' || featureKey === 'vp')");
    expect(featureScreen).toContain('<LiveHealthFeature title={title} homeChapterFirst=');
    expect(featureScreen).toContain("if (featureKey === 'chapters') return <ChaptersFeature />;");
    expect(featureScreen).toContain("if (featureKey === 'chapter-health') return <LiveHealthFeature title={title} />;");
    expect(featureScreen).not.toContain("featureKey === 'campaigns' || featureKey === 'advisor'");
    expect(featureScreen).toContain('function LiveHealthFeature({ title, homeChapterFirst');
    expect(featureScreen).toContain('<Heading>{catalogLabel(title)}</Heading>');
  });

  it('titles every Campaign admin connection by its name, once, never by its raw capability key', () => {
    // UX-UG-NATIVE-CHAPTER-ADMIN-SHOWS-RAW-CAPABILITY-KEYS-20261109
    const featureScreen = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
    const services = readFileSync(fileURLToPath(new URL('../services/supabase.ts', import.meta.url)), 'utf8');
    const labelSource = featureScreen.slice(featureScreen.indexOf('function connectionLabel'), featureScreen.indexOf('function connectionReadinessCopy'));
    const titles: Record<string, string> = Object.fromEntries([...labelSource.matchAll(/(\w+): '([^']+)'/g)].map((match) => [match[1], match[2]]));
    expect(titles).toEqual({
      sms: 'SMS delivery',
      calendar_google: 'Google free/busy',
      calendar_microsoft: 'Microsoft free/busy',
      cba: 'Campaign reference library',
      notion: 'Notion sync · planned',
      enterprise: 'Enterprise controls · planned',
    });
    for (const [capability, title] of Object.entries(titles)) {
      expect(title.toLocaleLowerCase()).not.toBe(capability.replaceAll('_', ' '));
      expect(title).not.toContain('_');
    }
    // Admin lists each connection once: the readiness rows are not repeated as
    // SETUP records headed by the key, and its own screen (#8630) lists no
    // records above Optional connections.
    // #8630 retired the generic evidence loader with its last key.
    expect(services).not.toContain('loadMobileFeatureEvidence');
    expect(services).not.toContain("String(row.capability).replaceAll('_', ' ')");
    const adminScreen = featureScreen.slice(featureScreen.indexOf('function ChapterAdminScreen('), featureScreen.indexOf('function connectionLabel'));
    expect(featureScreen).toContain("if (featureKey === 'admin') return <ChapterAdminScreen title={title} authorizedRoles={authorizedRoles} />;");
    expect(adminScreen).toContain('<Heading level={3}>{connectionLabel(capability)}</Heading>');
    // Gate round 1 on #8641: verification names the readiness row's own
    // chapter, only while it is the one this phone shows, never the cached one.
    expect(adminScreen).toContain('const verifyChapter = verifiableConnectionChapter(connection?.chapterID, chapterID);');
    expect(adminScreen).toContain('<ChapterConnectionVerification chapterID={verifyChapter}');
    expect(adminScreen).not.toContain('<ChapterConnectionVerification chapterID={chapterID}');
    expect(adminScreen).toContain("{connections.some((entry) => entry.chapterID !== chapterID) ? (");
    // Stage 116 on #8641 (r3s2): when another session switched the chapter back
    // before the press, the membership refresh sees no change and reloads
    // nothing, so Refresh chapter re-reads the rows itself.
    expect(adminScreen).toMatch(/async function refreshChapter\(\) \{[\s\S]*?await refreshChapterMemberships\(\);[\s\S]*?await loadMobileConnectionReadiness\(\);/);
    expect(adminScreen).toContain("busy={refreshingChapter} onPress={() => { void refreshChapter(); }}");
    expect(featureScreen).toContain("const CHAPTER_ADMIN_CAPABILITIES: MobileConnectionReadiness['capability'][] = ['sms', 'calendar_google', 'calendar_microsoft', 'cba', 'notion', 'enterprise'];");
    // The Home desk card says what the screen offers.
    expect(LIVE_STAFF_DESK_LINES.admin).toBe('See your campaign\'s connected services and their setup.');
  });

  it('names single sign-on on a Campaign admin connection card only through the released read', () => {
    // BUG-UG-NATIVE-CHAPTER-ADMIN-NAMES-HELD-SINGLE-SIGN-ON-20261113
    // (#8607): single sign-on is held for its release day. Every string the
    // card draws (its title, its text, its buttons and any accessibility
    // label) is read from the screen's own source, comments excluded. Once it
    // is released the card names it again, and only through
    // enterpriseControlsCopy keyed on the sign-in options read (#8611).
    const path = fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url));
    const text = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const cardStart = text.indexOf('{CHAPTER_ADMIN_CAPABILITIES.map((capability) => {');
    const cardEnd = text.indexOf('{connectionNotice ?', cardStart);
    expect(cardStart).toBeGreaterThan(-1);
    expect(cardEnd).toBeGreaterThan(cardStart);
    const drawn: string[] = [];
    const accessibility: string[] = [];
    const visit = (node: ts.Node, inside: boolean) => {
      const within = inside
        || (ts.isFunctionDeclaration(node) && ['connectionLabel', 'connectionReadinessCopy'].includes(node.name?.text ?? ''))
        || (node.getStart(source) >= cardStart && node.getEnd() <= cardEnd);
      if (within && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node))) drawn.push(node.text);
      if (within && ts.isJsxAttribute(node) && /^accessibility/.test(node.name.getText(source))) accessibility.push(node.getText(source));
      ts.forEachChild(node, (child) => visit(child, within));
    };
    visit(source, false);
    expect(text).toContain('<Heading level={3}>{connectionLabel(capability)}</Heading>');
    // While either is held, the Enterprise card keeps its own wording over
    // any server message.
    expect(text).toContain("<Body muted>{capability === 'enterprise' && !(ssoReleased && scimReleased) ? enterpriseControlsCopy(ssoReleased, scimReleased) : connection?.publicMessage || connectionReadinessCopy(capability, ssoReleased, scimReleased)}</Body>");
    expect(text.match(/connectionReadinessCopy\(/g)).toHaveLength(2);
    // The argument the card draws its text with is the released read, never a fixed answer.
    expect(text).toContain('const ssoReleased = useSsoReleased();');
    expect(text.match(/ssoReleased/g)).toHaveLength(6);
    // Directory sync (SCIM) is held with single sign-on (#9037): the same, through its own read.
    expect(text).toContain('const scimReleased = useScimReleased();');
    expect(text.match(/scimReleased/g)).toHaveLength(6);
    expect(text).toContain("function connectionReadinessCopy(capability: MobileConnectionReadiness['capability'], ssoReleased: boolean, scimReleased: boolean) {");
    expect(text).toContain("if (capability === 'enterprise') return enterpriseControlsCopy(ssoReleased, scimReleased);");
    expect(text.match(/enterpriseControlsCopy\(/g)).toHaveLength(2);
    expect(drawn).toContain('Enterprise controls · planned');
    for (const value of [...drawn, ...accessibility]) expect(value).not.toMatch(/\bSSO\b|single[\s-]*sign|\bSCIM\b|directory[\s-]*sync/i);
  });

  it('wraps the campaign health score and measure names instead of clipping them at large text', () => {
    // A11Y-UG-NATIVE-CHAPTER-HEALTH-SCORE-CLIPPED-AT-LARGEST-TEXT-20261109
    const featureScreen = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
    const health = featureScreen.slice(featureScreen.indexOf('function LiveHealthFeature'), featureScreen.indexOf('</Screen>', featureScreen.indexOf('function LiveHealthFeature')));
    // The score sits beside the chapter name only while both fit; otherwise it
    // wraps below the name, never past the card edge.
    expect(health).toContain('<View style={styles.healthSummaryRow}><View style={styles.healthSummaryTitle}>');
    expect(health).not.toContain('<View style={styles.workChipRow}><View><Text style={[styles.eyebrow');
    expect(featureScreen).toContain("healthSummaryRow: { flexDirection: 'row', flexWrap: 'wrap',");
    expect(featureScreen).toContain('healthSummaryTitle: { flexShrink: 1 },');
    // A measure name is never squeezed into a fixed column; the meter moves
    // below the name when both do not fit, and the value is never clipped.
    expect(health).toContain('<View style={styles.driverMeter}>');
    expect(featureScreen).toContain("driverRow: { minHeight: 34, flexDirection: 'row', flexWrap: 'wrap',");
    expect(featureScreen).toContain("driverLabel: { minWidth: 126, maxWidth: '100%',");
    expect(featureScreen).not.toMatch(/driverLabel: \{ width:/);
    expect(featureScreen).toContain('driverMeter: { flexGrow: 1, flexBasis: 120,');
    expect(featureScreen).toContain('driverValue: { minWidth: 28,');
  });

  it('opens the coaching form under the campaign actions with visible labels and moves focus to it', () => {
    // UX-UG-NATIVE-CHAPTER-HEALTH-COACHING-FORM-OPENS-OFF-SCREEN-UNLABELLED-20261109
    const featureScreen = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
    const health = featureScreen.slice(featureScreen.indexOf('function LiveHealthFeature'), featureScreen.indexOf('</Screen>', featureScreen.indexOf('function LiveHealthFeature')));
    // The form follows the action buttons directly, before the chapter's
    // coaching history, never after it.
    const actions = health.indexOf('<Button label="Add coaching entry"');
    const form = health.indexOf('{coachingChapter === chapter.chapterId ? <View style={styles.coachingForm}>');
    const history = health.indexOf('{chapter.coaching.map((note)');
    expect(actions).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(actions);
    expect(history).toBeGreaterThan(form);
    expect(health.slice(actions, form)).not.toContain('chapter.coaching.map');
    // Every field has a visible label that stays while typing, and the minimum
    // summary length is visible text tied to the field.
    const formSource = health.slice(form, history);
    expect(formSource).toContain('>Coaching summary</Text>');
    expect(formSource).toContain('<Body muted>Non-sensitive support context, at least {COACHING_SUMMARY_MIN} characters.</Body>');
    expect(formSource).toContain('accessibilityHint={`Non-sensitive support context, at least ${COACHING_SUMMARY_MIN} characters.`}');
    expect(formSource).toContain('>Next authorized action (optional)</Text>');
    expect(formSource).toContain('>Attention level</Text>');
    expect(formSource).not.toContain('placeholder=');
    expect(formSource).toContain("disabled={busy || coaching.pending === 'sending' || summary.trim().length < COACHING_SUMMARY_MIN}");
    expect(featureScreen).toContain('const COACHING_SUMMARY_MIN = 8;');
    // Focus moves to the first field on open and back to the button on Cancel.
    expect(formSource).toContain('<TextInput ref={coachingSummaryRef} accessibilityLabel="Coaching summary"');
    expect(health).toContain('moveAccessibilityFocus(coachingSummaryRef.current);');
    expect(health).toContain('moveAccessibilityFocus(coachingButtonRefs.current.get(returnTo));');
    expect(health).toContain('coachingFocusReturn.current = coachingChapter;\n    closeCoaching();');
    expect(formSource).toContain("<Button label=\"Cancel\" variant=\"secondary\" disabled={busy || coaching.pending === 'sending'} onPress={cancelCoaching} />");
    expect(health).toContain('focusRef={(node) => { if (node) coachingButtonRefs.current.set(chapter.chapterId, node);');
    expect(featureScreen).toContain("AccessibilityInfo.sendAccessibilityEvent(node, 'focus')");
  });

  it('lets anyone check a vote receipt without revealing the vote', () => {
    const featureScreen = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
    expect(featureScreen).toContain('Verify a receipt');
    expect(featureScreen).toContain('Verification never shows how the vote was cast.');
    expect(featureScreen).toContain('Crypto.randomUUID()');
    expect(featureScreen).not.toContain('selected.slice');
    expect(featureScreen).toContain("if (featureKey === 'voting') return <LiveVotingFeature />");
    expect(featureScreen).toContain('submitMobileBallotVote(writer, ballot.id, optionID)');
    expect(featureScreen).toContain('<Body muted>{BALLOT_FINAL_HINT}</Body>');
  });

  it('closes preview votes against the preview clock, not status or the device clock', () => {
    expect(PREVIEW_NOW).toBe('2026-08-13T12:00:00.000Z');
    const member = previewDeskFor('member');
    const budget = member.ballots.find((item) => item.id === 'ballot-2026')!;
    const pulse = member.ballots.find((item) => item.id === 'pulse-new-members')!;
    const contract = member.ballots.find((item) => item.id === 'ballot-2025')!;
    expect(budget.closesAt).toBe('2026-07-21T19:59:00-04:00');
    expect(pulse.closesAt).toBe('2026-07-24T19:59:00-04:00');
    expect(budget.status).toBe('closed');
    expect(pulse.status).toBe('closed');
    expect(contract.status).toBe('closed');
    expect(previewBallotIsOpen(budget)).toBe(false);
    expect(previewBallotIsOpen(pulse)).toBe(false);
    expect(previewBallotIsOpen({ ...budget, status: 'open' })).toBe(false);
    expect(previewBallotIsOpen({ status: 'open', closesAt: '2026-08-20T19:59:00-04:00' })).toBe(true);
    expect(previewBallotIsOpen({ status: 'closed', closesAt: '2026-08-20T19:59:00-04:00' })).toBe(true);
    expect(previewBallotIsOpen(budget, '2026-07-20T12:00:00.000Z')).toBe(true);

    expect(previewBallotCardState(budget)).toEqual({
      open: false,
      label: 'Closed',
      options: [],
      canCast: false,
    });
    expect(previewBallotCardState(pulse)).toEqual({
      open: false,
      label: 'Closed',
      options: [],
      canCast: false,
    });
    expect(previewBallotCardState({ ...budget, status: 'open' }).label).toBe('Closed');
    const future = previewBallotCardState({ status: 'closed', closesAt: '2026-08-20T19:59:00-04:00' });
    expect(future).toEqual({
      open: true,
      label: 'Open vote',
      options: ['Yes', 'No', 'Abstain'],
      canCast: true,
    });
    expect(previewBallotCardState(budget, '2026-07-20T12:00:00.000Z').label).toBe('Open vote');

    const featureScreen = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
    const previewCard = featureScreen.slice(
      featureScreen.indexOf('function BallotCard('),
      featureScreen.indexOf('function FormsFeature('),
    );
    const liveCard = featureScreen.slice(
      featureScreen.indexOf('function LiveBallotCard('),
      featureScreen.indexOf('function previewHealthPortfolio'),
    );
    expect(previewCard).toContain('const { open, label, options, canCast } = previewBallotCardState(ballot);');
    expect(previewCard).toContain('{label}');
    expect(previewCard).toContain('{!receipt && canCast');
    expect(previewCard).not.toContain("ballot.status === 'open'");
    expect(previewCard).not.toContain('vote.closesAt ?');
    expect(liveCard).not.toContain('previewBallotCardState');
    expect(liveCard).not.toContain('previewBallotIsOpen');
    expect(liveCard).toContain('ballot.closed');
  });

  it('pins chapter-work overdue against the preview clock, never the device clock', () => {
    expect(PREVIEW_NOW).toBe('2026-08-13T12:00:00.000Z');
    expect(previewWorkDayDiff('2026-08-10')).toBe(-3);
    expect(previewWorkDayDiff('2026-08-13')).toBe(0);
    expect(previewWorkDayDiff('2026-08-21')).toBe(8);
    expect(previewWorkDayDiff('2026-09-05')).toBe(23);
    const tasks = previewDeskFor('steward').chapterWork?.tasks ?? [];
    const byKey = Object.fromEntries(tasks.map((task) => [task.taskKey, task]));
    expect(byKey['HBV-4']?.dueDate).toBe('2026-08-10');
    expect(byKey['HBV-3']?.dueDate).toBe('2026-08-21');
    expect(byKey['HBV-6']?.dueDate).toBe('2026-09-05');
    expect(byKey['HBV-2']?.dueDate).toBeNull();
    expect(previewWorkIsOverdue(byKey['HBV-4']!)).toBe(true);
    expect(previewWorkIsOverdue(byKey['HBV-3']!)).toBe(false);
    expect(previewWorkIsOverdue(byKey['HBV-6']!)).toBe(false);
    expect(previewWorkIsOverdue(byKey['HBV-2']!)).toBe(false);
    expect(previewWorkIsOverdue({ ...byKey['HBV-4']!, status: 'done' })).toBe(false);
    expect(tasks.filter((task) => previewWorkIsOverdue(task)).map((task) => task.taskKey)).toEqual(['HBV-4']);
    expect(previewWorkDayDiff('2026-08-10', '2026-08-10T12:00:00.000Z')).toBe(0);

    const featureScreen = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
    expect(featureScreen).not.toContain('function workDayDiff');
    expect(featureScreen).not.toContain('function workIsOverdue');
    expect(featureScreen).toContain("{ label: 'Overdue', rows: dated.filter((task) => task.status !== 'done' && previewWorkDayDiff(task.dueDate!) < 0) }");
    expect(featureScreen).toContain("{ label: 'Due today', rows: dated.filter((task) => task.status !== 'done' && previewWorkDayDiff(task.dueDate!) === 0) }");
    expect(featureScreen).toContain("{ label: 'Next 7 days', rows: dated.filter((task) => task.status !== 'done' && previewWorkDayDiff(task.dueDate!) > 0 && previewWorkDayDiff(task.dueDate!) <= 7) }");
    expect(featureScreen).toContain("{ label: 'Later', rows: dated.filter((task) => task.status !== 'done' && previewWorkDayDiff(task.dueDate!) > 7) }");
    expect(featureScreen).toContain('const overdue = previewWorkIsOverdue(task);');
    expect(featureScreen).toContain('const overdueTasks = tasks.filter((task) => previewWorkIsOverdue(task));');
    expect(featureScreen).toContain('color: previewWorkIsOverdue(task) ? theme.destructive : theme.mutedForeground');
    const deadlines = featureScreen.slice(
      featureScreen.indexOf("{ label: 'Overdue', rows: dated.filter"),
      featureScreen.indexOf("{ label: 'Completed', rows: dated.filter"),
    );
    expect(deadlines).toContain('previewWorkDayDiff');
    expect(deadlines).not.toContain('workDayDiff(');
    expect(deadlines).not.toContain('new Date()');
    expect(deadlines).not.toContain('Date.now()');
  });

  it('keeps live activation and campaign partner calls aligned with their RPC boundaries', () => {
    const service = readFileSync(fileURLToPath(new URL('../services/supabase.ts', import.meta.url)), 'utf8');
    expect(service).toContain('p_capability: capability, p_provider_label: providerLabel');
    expect(service).not.toContain('p_capability: capability, p_public_message:');
    expect(service).toContain("if (row.chapter_id === currentChapterID) return []");
    expect(service).toContain('organizationByChapter.get(row.chapter_id)');
  });

  it('keeps later-track mobile designs informational instead of exposing dead actions', () => {
    const featureScreen = ['../features/FeatureScreen.tsx', '../features/LiveAppointmentsFeature.tsx']
      .map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
      .join('\n');
    const accountScreen = readFileSync(fileURLToPath(new URL('../../app/(tabs)/account.tsx', import.meta.url)), 'utf8');
    // The planned set is now one shared list, and it withholds the audited
    // verification control as well as the request button: a planned
    // capability must be unmarkable, not merely unrequestable.
    expect(featureScreen).toContain('const planned = isPlannedChapterCapability(capability)');
    expect(featureScreen).toContain('chapterConnectionIsVerifiable(capability, status)');
    expect(featureScreen).not.toContain("['configuring', 'active', 'error', 'disabled'].includes(status)");
    expect(featureScreen).toContain('chapterConnectionProviderLine(connection.providerLabel');
    expect(featureScreen).toContain('Expanded booking');
    expect(featureScreen).toContain('Multi-attendee scheduling and additional meeting formats are not active.');
    // Batch C copy register 24: the internal "Preview continuity · planned"
    // note is gone from Account.
    expect(accountScreen).not.toContain('Preview continuity');
  });

  it('points left-card and work-widget links at in-app feature routes', () => {
    const hrefs = [...MEMBER_HAT_FUNCTIONS, ...MEMBER_WORK_WIDGETS, ...workItemsForHat('steward'), ...functionsForHat('admin')]
      .map((item) => item.href);
    expect(hrefs.every((href) => !href.includes('sibling-saas.example'))).toBe(true);
    expect(hrefs.some((href) => href === featurePath('voting'))).toBe(true);
    expect(hrefs.some((href) => href === featurePath('forms'))).toBe(true);
    expect(hrefs.some((href) => href === '/messages')).toBe(true);
  });
});

describe('multi-role live staff (BUG-UG-NATIVE-MULTI-ROLE-STAFF-LOCKED-OUT-20261018)', () => {
  const roles: LiveStaffRoles = { organizationRoles: [], chapterRoles: ['admin', 'steward'], authorizedRoles: ['admin', 'steward'] };

  it('opens no staff desk before a role is chosen', () => {
    expect(canOpenFeature('authenticated', 'admin', null, roles.chapterRoles, roles.organizationRoles)).toBe(false);
    expect(canOpenFeature('authenticated', 'steward', null, roles.chapterRoles, roles.organizationRoles)).toBe(false);
  });

  it('opens the chosen role\'s desk and refuses the other role\'s desk', () => {
    const steward = narrowLiveStaffRoles(roles, 'steward');
    expect(canOpenFeature('authenticated', 'steward', null, steward.chapterRoles, steward.organizationRoles)).toBe(true);
    expect(canOpenFeature('authenticated', 'admin', null, steward.chapterRoles, steward.organizationRoles)).toBe(false);
    const admin = narrowLiveStaffRoles(roles, 'admin');
    expect(canOpenFeature('authenticated', 'admin', null, admin.chapterRoles, admin.organizationRoles)).toBe(true);
    expect(canOpenFeature('authenticated', 'steward', null, admin.chapterRoles, admin.organizationRoles)).toBe(false);
  });

  it('binds the chosen staff role to one Auth session and offers the picker on the integrations refusal', () => {
    const provider = readFileSync(fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)), 'utf8');
    const featureScreen = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
    const picker = readFileSync(fileURLToPath(new URL('../components/StaffRolePicker.tsx', import.meta.url)), 'utf8');
    expect(provider).toContain('const staffRoleSessionID = session ? sessionIDFromAccessToken(session.access_token) : null;');
    expect(provider).toContain('staffRolePick.sessionID === staffRoleSessionID');
    expect(provider).toContain('{ userID, sessionID: staffRoleSessionID, role }');
    expect(featureScreen).toContain("rolePicker={mode !== 'preview' && staffRoleChoices.length > 1}");
    expect(picker).toContain('Working as ${LIVE_STAFF_ROLE_LABELS[chosenStaffRole]}');
  });
});
