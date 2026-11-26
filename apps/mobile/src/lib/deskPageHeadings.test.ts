import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { nativeCatalogLabel, nativeUiSpanish } from './nativeUiCopy';
import { FEATURE_TITLES } from './featureCatalog';

// App-owned page names only. Member-authored record headings keep their text.
// The English names are the headings shown on Main before ledger 543.
const screens: Record<string, Record<string, readonly string[]>> = {
  'src/features/StewardDeskSectionsScreen.tsx': { StewardDeskSectionsScreen: ['Your caseload', 'Worker requests', 'Forms review', 'Broadcasts'] },
  'src/features/FeatureScreen.tsx': { UnbuiltFeatureScreen: Object.values(FEATURE_TITLES), LiveVotingFeature: ['Votes'], ChapterAdminScreen: ['Campaign admin'], LiveHealthFeature: ['Campaign health', 'Leadership overview', 'Health portfolio'], CasesFeature: ['My issues'], ChaptersFeature: ['Campaigns', 'Campaigns'] },
  'src/features/LiveFeatureScreens.tsx': { LiveCampaignsScreen: ['Campaigns'], LiveBeHeardScreen: ['Be heard'], LiveSearchScreen: ['Search'], LiveCaseworkDeskScreen: ['Issue work'], LiveCaseQueueScreen: ['Issue queue'] },
  'src/features/LiveLivedInScreens.tsx': { LiveEventsScreen: ['Meetings desk', 'Meetings'], LiveRewardsScreen: ['Contributions'], LiveWorkloadScreen: ['Workplace log'], LiveChapterScreen: ['My campaign'], LiveTasksScreen: ['Campaign work'], LiveReportsScreen: ['My reports'], LiveStewardAppointmentsScreen: ['One-on-one desk'] },
  'src/features/mi1/OrganizationIntelligenceScreens.tsx': { OrganizationIntelligenceScreen: ['Power map'], CollectiveActionsScreen: ['Digital Picket Line'] },
  'src/features/mi1/IntegrationControlsScreen.tsx': { IntegrationControlsScreen: ['Connected services'] },
  'src/features/mi1/OperationsHealthScreen.tsx': { OperationsHealthScreen: ['Operations health'] },
  'src/features/mi1/AnalyticsCoreScreen.tsx': { AnalyticsCoreScreen: ['Organization analytics'] },
  'src/features/mi1/PayToolsScreen.tsx': { PayToolsScreen: ['Pay tools'] },
  'src/features/LiveAppointmentsFeature.tsx': { LiveAppointmentsFeature: ['One-on-ones'] },
  'src/features/LeadershipPulseScreen.tsx': { LeadershipPulseContent: ['Pulse'] },
  'src/features/StewardPulseScreen.tsx': { StewardPulseContent: ['Pulse'] },
  'src/features/MemberSupportScreen.tsx': { MemberSupportScreen: ['Worker support'] },
  'src/features/ChapterNoticesScreen.tsx': { ChapterNoticesScreen: ['Campaign notices'] },
  // The Campaign tab's page heading is the campaign's own name (authored), so it is not walked here.
  'app/mentions.tsx': { MentionList: ['Your mentions'] },
  'app/mfa-challenge.tsx': { MfaChallengeForm: ["You're offline", 'Confirming account security', 'Enter your authenticator code'] },
  'app/task-conversation/[id].tsx': { TaskConversation: ['Task conversation'] },
  'app/_layout.tsx': { NavigationRoot: ['Union Ground is locked'] },
  'app/share-intake.tsx': { OwnedShareIntakeScreen: ['Save shared attachment'] },
};

function titleValues(expression: ts.Expression, dynamic: readonly string[]): readonly string[] | null {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isIdentifier(expression) && expression.text === 'title') return dynamic;
  if (ts.isConditionalExpression(expression)) {
    const yes = titleValues(expression.whenTrue, dynamic), no = titleValues(expression.whenFalse, dynamic);
    return yes && no ? [...yes, ...no] : null;
  }
  return null;
}

function isSectionHeading(node: ts.JsxElement): boolean {
  return node.openingElement.attributes.properties.some((prop) => {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== 'level') return false;
    const value = prop.initializer;
    return Boolean(value && ts.isJsxExpression(value) && value.expression
      && ts.isNumericLiteral(value.expression) && ['2', '3'].includes(value.expression.text));
  });
}

it('walks desk page headings: complete Spanish titles, original English, and no new raw heading', () => {
  const gaps: string[] = [];
  // 19 screens here: this edition has no Dues screen, and its Campaign tab heading is authored.
  expect(Object.keys(screens)).toHaveLength(19);
  expect(Object.values(screens).reduce((count, functions) => count + Object.keys(functions).length, 0)).toBe(35);
  const census = { headings: 0, labels: 0, authored: 0 };
  const distinct = new Set<string>();
  for (const [path, functions] of Object.entries(screens)) {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const [name, original] of Object.entries(functions)) {
      const fn = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
      if (!fn?.body) { gaps.push(`${path}:${name}: missing screen`); continue; }
      const english: string[] = [];
      function visit(node: ts.Node) {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Heading' && !isSectionHeading(node)) {
          const children = node.children.filter((child) => !ts.isJsxText(child) || child.text.trim());
          const child = children.length === 1 ? children[0] : null;
          let translated = false;
          let labels: readonly string[] | null = null;
          if (child && ts.isJsxText(child)) labels = [child.text.trim()];
          if (child && ts.isJsxExpression(child) && child.expression) {
            const expression = child.expression;
            if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'catalogLabel') {
              translated = true;
              labels = expression.arguments[0] ? titleValues(expression.arguments[0], original) : null;
            } else labels = titleValues(expression, original);
          }
          const expression = child && ts.isJsxExpression(child) ? child.expression : undefined;
          if (path === 'src/features/LiveLivedInScreens.tsx' && name === 'LiveChapterScreen'
            && expression?.getText(ast) === 'selectedDocument.title') {
            census.authored += 1;
          } else {
            census.headings += 1;
            if (!labels && translated && expression && ts.isCallExpression(expression)
              && path === 'app/mfa-challenge.tsx' && expression.arguments[0]?.getText(ast) === 'copy.title') {
              labels = ["You're offline", 'Confirming account security'];
            }
            if (!labels) gaps.push(path + ':' + name + ': unrecognized page-heading expression');
          }
          if (labels) {
            const location = `${path}:${name}:${ast.getLineAndCharacterOfPosition(node.pos).line + 1}`;
            if (!translated) gaps.push(`${location}: raw page heading`);
            for (const title of labels) {
              census.labels += 1; distinct.add(title);
              english.push(nativeCatalogLabel('en', title));
              if (!Object.hasOwn(nativeUiSpanish, title) || nativeCatalogLabel('es', title) === title || !nativeCatalogLabel('es', title).trim()) {
                gaps.push(`${location}: missing Spanish title ${title}`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(fn.body);
      if (JSON.stringify(english) !== JSON.stringify(original)) {
        gaps.push(`${path}:${name}: English titles changed: ${JSON.stringify(english)}`);
      }
    }
  }
  expect(census).toEqual({ headings: 37, labels: 84, authored: 1 });
  expect(distinct.size).toBe(54);
  expect(gaps, gaps.join('\n')).toEqual([]);
});
