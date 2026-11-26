import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

// OPS-UG-PHONE-APP-BACK-SWIPE-AND-EDGE-BAND-GUARDS-20261118 (#9128).
// The Native owner correction contract (apps/mobile/AGENTS.md) keeps a phone
// screen's top and bottom edges free of lines and bands: no border, hairline,
// header shadow line, gradient or scrim along the header, the tab bar or a
// screen container. This is a class check over every piece of shared chrome
// in app/ and src/, found by role, not a check of one file:
//   - every navigator layout (app/**/_layout.tsx): the stack header and the
//     tab bar are configured there;
//   - every chrome component, by name: `Screen` and any component whose name
//     ends in Header, HeaderScreen, TabBar, Tabs, Dock, Ramp or Chrome, with
//     the StyleSheet entries it uses;
//   - every navigator option object anywhere (screenOptions, options,
//     navigation.setOptions).
// An edge allowed to stay goes in EDGE_BAND_ALLOWLIST with its reason. The design
// publish checklist (REQ-UG-DESIGN-PUBLISH-CHECKLIST-20261118) points
// at this test for its edge-band item.

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCANNED_ROOTS = ['app', 'src'];
const CHROME_COMPONENT = /^(Screen|[A-Z]\w*(Header|HeaderScreen|TabBar|Tabs|Dock|Ramp|Chrome))$/;
const EDGE_STYLE_KEYS = new Set(['borderTopWidth', 'borderBottomWidth']);
// A border on every side, or a style shadow, also paints the top or bottom
// edge of the view it styles; on an inner control (the circular Back button)
// it is that control's own decoration, not an edge band.
const WHOLE_BORDER_KEY = 'borderWidth';
const STYLE_SHADOW_KEYS = new Set(['shadowColor', 'shadowOpacity', 'shadowRadius', 'shadowOffset']);
const CONTROL_ELEMENT = /(^|\.)(Pressable|Touchable\w*|\w*Button)$/;
// Elements that render nothing of their own: a component's root is the first
// real element inside them.
const WRAPPER_ELEMENT = /(^|\.)(Provider|Fragment)$/;
// StyleSheet entries that style a chrome component's own frame: never an
// inner control's decoration, whatever element carries them.
const EDGE_ENTRY = /^(root|host|frame|backing|edge|container|screen|page|header|bar|band)$|(Root|Host|Frame|Backing|Edge|Container|Bar|Band)$/;
const BAND_ELEMENT = /(Gradient|Scrim|Feather|EdgeFade|ChromeFade)$/;
const OPTION_ATTRIBUTES = new Set(['options', 'screenOptions']);

// Key: `<file> <scope> <rule>`; value: the reason it may stay. A reason cites
// the contract line that allows the edge, never a design preference alone, so
// the allowlist cannot hide a breach of the native correction.
// Empty since the owner removed the top ramp on every screen (Nov 22-23,
// 2026, #9607): no edge band is allowed.
const EDGE_BAND_ALLOWLIST: Readonly<Record<string, string>> = {};

// A shadow colour that draws nothing ("transparent", which also stops iOS
// drawing its default tab bar hairline) is no edge.
function drawsNothing(node: ts.Expression | ts.JsxAttributeValue | undefined): boolean {
  const value = node && ts.isJsxExpression(node) ? node.expression : node;
  return value !== undefined && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) && value.text === 'transparent';
}

type EdgeBand = { file: string; scope: string; rule: string; line: number };

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'testing') walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        found.push(path);
      }
    }
  };
  walk(root);
  return found;
}

function isZero(node: ts.Expression): boolean {
  return ts.isNumericLiteral(node) && Number(node.text) === 0;
}

// A property's name as the runtime sees it: `gap`, 'gap', "gap", [`gap`] and
// ['gap'] are one key. A computed name that is not a literal is unknowable.
function staticName(name: ts.PropertyName | ts.Expression): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return staticName(name.expression);
  return undefined;
}

// A style shadow that paints nothing: a transparent colour, no opacity or
// radius, or a zero offset.
function shadowDrawsNothing(key: string, value: ts.Expression): boolean {
  if (key === 'shadowColor') return drawsNothing(value);
  if (key === 'shadowOffset') return ts.isObjectLiteralExpression(value) && value.properties.every((part) => ts.isPropertyAssignment(part) && isZero(part.initializer));
  return isZero(value);
}

// The root elements a chrome component (or a layout) returns, looking through
// context providers and fragments; render callbacks nested inside are not the
// component's root.
function rootElements(scope: ts.Node): Set<ts.Node> {
  const roots = new Set<ts.Node>();
  const addRoot = (node: ts.Node | undefined): void => {
    let value = node;
    while (value && ts.isParenthesizedExpression(value)) value = value.expression;
    if (!value) return;
    if (ts.isJsxFragment(value)) { value.children.forEach(addRoot); return; }
    const opening = ts.isJsxElement(value) ? value.openingElement : ts.isJsxSelfClosingElement(value) ? value : undefined;
    if (!opening) return;
    if (WRAPPER_ELEMENT.test(opening.tagName.getText())) {
      if (ts.isJsxElement(value)) value.children.forEach(addRoot);
      return;
    }
    roots.add(opening);
  };
  const functions: ts.Node[] = [];
  const own = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) { functions.push(node); return; }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      let value: ts.Expression = node.initializer;
      while (ts.isCallExpression(value) && value.arguments[0]) value = value.arguments[0];
      own(value);
    }
    if (ts.isSourceFile(node)) node.statements.forEach((statement) => { if (ts.isVariableStatement(statement)) statement.declarationList.declarations.forEach(own); else own(statement); });
  };
  own(scope);
  for (const fn of functions) {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) { addRoot(fn.body); continue; }
    const visit = (node: ts.Node): void => {
      if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
      if (ts.isReturnStatement(node)) addRoot(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(fn);
  }
  return roots;
}

// The node sits on an inner control: a Pressable, Touchable or *Button
// element, or one marked as a button, or inside one. The component's own root
// never counts as a control, so a pressable root's edge is still an edge.
function insideControl(node: ts.Node, roots: ReadonlySet<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    // From a child the walk meets the whole element; from a prop, its tag.
    const element = ts.isJsxElement(current) ? current.openingElement : current;
    if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) continue;
    if (roots.has(element)) continue;
    if (CONTROL_ELEMENT.test(element.tagName.getText())) return true;
    const role = element.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'accessibilityRole');
    if (role && ts.isJsxAttribute(role) && role.initializer && ts.isStringLiteral(role.initializer) && role.initializer.text === 'button') return true;
  }
  return false;
}

function isFalse(node: ts.Expression | undefined): boolean {
  return node !== undefined && node.kind === ts.SyntaxKind.FalseKeyword;
}

function componentName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    let value: ts.Expression = node.initializer;
    // memo(...) and forwardRef(...) wrap the component.
    while (ts.isCallExpression(value) && value.arguments[0]) value = value.arguments[0];
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return node.name.text;
  }
  return null;
}

/** Every edge line or band the shared chrome in one source file draws. */
function findEdgeBands(file: string, source: string): EdgeBand[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: EdgeBand[] = [];
  const seen = new Set<string>();
  const report = (scope: string, rule: string, node: ts.Node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const key = `${scope} ${rule} ${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ file, scope, rule, line: line + 1 });
  };

  // StyleSheet.create entries, so `styles.header` resolves to its object.
  const sheets = new Map<string, Map<string, ts.ObjectLiteralExpression>>();
  const collectSheets = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(sourceFile) === 'StyleSheet.create' && node.initializer.arguments[0]
      && ts.isObjectLiteralExpression(node.initializer.arguments[0])) {
      const entries = new Map<string, ts.ObjectLiteralExpression>();
      for (const property of node.initializer.arguments[0].properties) {
        const entryName = ts.isPropertyAssignment(property) ? staticName(property.name) : undefined;
        if (entryName !== undefined && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) entries.set(entryName, property.initializer);
      }
      sheets.set(node.name.text, entries);
    }
    ts.forEachChild(node, collectSheets);
  };
  collectSheets(sourceFile);

  // `at` is where the style is applied: the node itself for an inline style,
  // the `styles.x` reference for a StyleSheet entry.
  let roots: ReadonlySet<ts.Node> = new Set();
  const scanStyles = (scope: string, node: ts.Node, at: ts.Node = node, edgeEntry = false) => {
    if (!ts.isPropertyAssignment(node)) return;
    const key = staticName(node.name);
    if (key === undefined) return;
    if (EDGE_STYLE_KEYS.has(key) && !isZero(node.initializer)) report(scope, key, node);
    if (key === 'headerShadowVisible' && !isFalse(node.initializer)) report(scope, 'headerShadowVisible', node);
    const paintsEdge = (key === WHOLE_BORDER_KEY && !isZero(node.initializer)) || (STYLE_SHADOW_KEYS.has(key) && !shadowDrawsNothing(key, node.initializer));
    if (paintsEdge && (edgeEntry || !insideControl(at, roots))) report(scope, key, node);
  };

  const scanChrome = (scope: string, body: ts.Node) => {
    roots = rootElements(body);
    const visit = (node: ts.Node) => {
      scanStyles(scope, node);
      // `styles.header` and `styles['header']` resolve to the StyleSheet entry.
      const sheetName = (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      const entryName = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? staticName(node.argumentExpression) : undefined;
      const entry = sheetName !== undefined && entryName !== undefined ? sheets.get(sheetName)?.get(entryName) : undefined;
      const edgeEntry = entryName !== undefined && EDGE_ENTRY.test(entryName);
      if (entry) ts.forEachChild(entry, function inner(child) { scanStyles(scope, child, node, edgeEntry); ts.forEachChild(child, inner); });
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sourceFile);
        if (BAND_ELEMENT.test(tag)) report(scope, `<${tag}>`, node);
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const name = attribute.name.getText(sourceFile);
          // A tab bar's or header's own shadow line.
          if (name === 'shadowColor' && !drawsNothing(attribute.initializer)) report(scope, 'shadowColor', attribute);
          if (name === 'headerShadowVisible') {
            const value = attribute.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
            if (!isFalse(value)) report(scope, 'headerShadowVisible', attribute);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  };

  const isLayout = /(^|\/)_layout\.tsx$/.test(file);
  if (isLayout) scanChrome('layout', sourceFile);

  const visit = (node: ts.Node) => {
    const name = componentName(node);
    if (!isLayout && name && CHROME_COMPONENT.test(name)) scanChrome(name, node);
    // Navigator options anywhere: the header and tab bar they configure (a
    // layout's own options were scanned with the layout).
    if (!isLayout && ts.isJsxAttribute(node) && OPTION_ATTRIBUTES.has(node.name.getText(sourceFile)) && node.initializer) {
      ts.forEachChild(node.initializer, function inner(child) { scanStyles('options', child); ts.forEachChild(child, inner); });
    }
    if (!isLayout && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setOptions') {
      for (const argument of node.arguments) ts.forEachChild(argument, function inner(child) { scanStyles('options', child); ts.forEachChild(child, inner); });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function keyOf(band: EdgeBand): string {
  return `${band.file} ${band.scope} ${band.rule}`;
}

function scanApp(): EdgeBand[] {
  return SCANNED_ROOTS.flatMap((root) => sourceFiles(join(MOBILE_ROOT, root)))
    .flatMap((path) => findEdgeBands(relative(MOBILE_ROOT, path).replace(/\\/g, '/'), readFileSync(path, 'utf8')));
}

describe('phone chrome draws no line or band at a screen edge (#9128)', () => {
  const found = scanApp();

  it('finds the shared header, tab bar and screen container it guards', () => {
    const files = new Set(SCANNED_ROOTS.flatMap((root) => sourceFiles(join(MOBILE_ROOT, root))).map((path) => relative(MOBILE_ROOT, path).replace(/\\/g, '/')));
    for (const file of ['app/_layout.tsx', 'app/(tabs)/_layout.tsx', 'src/components/PinnedHeader.tsx', 'src/components/TopChrome.tsx', 'src/components/ui.tsx']) {
      expect(files.has(file), file).toBe(true);
    }
  });

  it('allows only the reasoned edges', () => {
    const outside = found.filter((band) => !(keyOf(band) in EDGE_BAND_ALLOWLIST)).map((band) => `${band.file}:${band.line} ${band.scope} ${band.rule}`);
    expect(outside, 'an edge line or band on shared phone chrome: remove it, or add it to EDGE_BAND_ALLOWLIST with its reason').toEqual([]);
  });

  it('gives every allowlisted edge a reason, and drops an entry once its edge is gone', () => {
    for (const [key, reason] of Object.entries(EDGE_BAND_ALLOWLIST)) {
      expect(reason.length, `${key} needs a reason`).toBeGreaterThan(40);
      expect(found.some((band) => keyOf(band) === key), `${key} is no longer drawn; drop its allowlist entry`).toBe(true);
    }
  });

  it('catches each kind of edge on chrome, and leaves content alone', () => {
    const broken: Array<[string, string]> = [
      ['app/(tabs)/_layout.tsx', 'export default function L() { return <Tabs screenOptions={{ tabBarStyle: { borderTopWidth: 1 } }} />; }'],
      ['app/_layout.tsx', 'export default function L() { return <Stack screenOptions={{ headerShadowVisible: true }} />; }'],
      ['app/issue/[id].tsx', 'export default function C() { return <Stack.Screen options={{ headerStyle: { borderBottomWidth: StyleSheet.hairlineWidth } }} />; }'],
      ['app/issue/[id].tsx', 'export default function C({ navigation }) { navigation.setOptions({ headerShadowVisible: shown }); return null; }'],
      ['src/components/ui.tsx', 'export function Screen() { return <View style={styles.page} />; }\nconst styles = StyleSheet.create({ page: { borderBottomWidth: 1 } });'],
      ['src/components/WorkDock.tsx', 'export const WorkDock = () => <LinearGradient colors={fade} />;'],
      ['src/components/MessagesHeader.tsx', 'export const MessagesHeader = memo(() => <DockScrim />);'],
      // A quoted or computed key, or a quoted StyleSheet entry, is the same style at runtime.
      ['src/components/ui.tsx', "export function Screen() { return <View style={styles.page} />; }\nconst styles = StyleSheet.create({ page: { 'borderBottomWidth': 1 } });"],
      ['src/components/ui.tsx', "export function Screen() { return <View style={styles['page']} />; }\nconst styles = StyleSheet.create({ 'page': { [`borderTopWidth`]: 1 } });"],
      ['app/_layout.tsx', "export default function L() { return <Stack screenOptions={{ ['headerShadowVisible']: true }} />; }"],
      // A border on every side, or a style shadow, paints the edge too.
      ['src/components/ui.tsx', 'export function Screen() { return <View style={{ borderWidth: StyleSheet.hairlineWidth }} />; }'],
      ['src/components/NoticeHeader.tsx', 'export const NoticeHeader = () => <View style={styles.bar} />;\nconst styles = StyleSheet.create({ bar: { shadowOpacity: 0.2 } });'],
      ['app/_layout.tsx', 'export default function L() { return <Stack screenOptions={{ headerStyle: { shadowColor: theme.border } }} />; }'],
      // A chrome component's own root, or a frame entry, is an edge even on a pressable.
      ['src/components/PillHeader.tsx', 'export const PillHeader = () => <Pressable style={{ borderWidth: 1 }} />;'],
      ['src/components/DockHeader.tsx', 'export const DockHeader = () => <View><Pressable style={styles.backing} /></View>;\nconst styles = StyleSheet.create({ backing: { borderWidth: 1 } });'],
    ];
    for (const [file, source] of broken) expect(findEdgeBands(file, source), source).toHaveLength(1);
    // An inner control's own border or shadow (the circular Back button) is
    // its decoration, and a shadow that paints nothing is no edge.
    expect(findEdgeBands('src/components/BackHeader.tsx', 'export const BackHeader = () => <View><Pressable accessibilityRole="button" onPress={back}>{() => <View style={{ borderWidth: 1, shadowOpacity: 0.3 }} />}</Pressable><IconButton style={{ borderWidth: 1 }} /></View>;')).toEqual([]);
    expect(findEdgeBands('src/components/QuietHeader.tsx', "export const QuietHeader = () => <View style={{ shadowColor: 'transparent', shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, borderWidth: 0 }} />;")).toEqual([]);
    // A list row's separator inside a screen body is content, not an edge.
    expect(findEdgeBands('app/(tabs)/account.tsx', 'export default function Account() { return <View style={styles.row} />; }\nconst styles = StyleSheet.create({ row: { borderBottomWidth: 1 } });')).toEqual([]);
    expect(findEdgeBands('app/_layout.tsx', 'export default function L() { return <Stack screenOptions={{ headerShadowVisible: false }} />; }')).toEqual([]);
    expect(findEdgeBands('app/(tabs)/_layout.tsx', "export default function L() { return <NativeTabs shadowColor={'transparent'} />; }")).toEqual([]);
    expect(findEdgeBands('app/(tabs)/_layout.tsx', 'export default function L() { return <NativeTabs shadowColor="#000" />; }')).toHaveLength(1);
  });

  it('fails on a broken copy of the real stack layout, pinned header and screen container', () => {
    const layout = readFileSync(join(MOBILE_ROOT, 'app/_layout.tsx'), 'utf8');
    expect(layout).toContain('headerShadowVisible: false');
    expect(findEdgeBands('app/_layout.tsx', layout.replace('headerShadowVisible: false', 'headerShadowVisible: true')).map(keyOf))
      .toContain('app/_layout.tsx layout headerShadowVisible');
    const header = readFileSync(join(MOBILE_ROOT, 'src/components/PinnedHeader.tsx'), 'utf8');
    const backing = 'backgroundColor: theme.background }]';
    expect(header).toContain(backing);
    expect(findEdgeBands('src/components/PinnedHeader.tsx', header)).toEqual([]);
    const brokenBackings: Array<[string, string[]]> = [
      ['borderBottomWidth: StyleSheet.hairlineWidth', ['borderBottomWidth']],
      ["'borderBottomWidth': StyleSheet.hairlineWidth", ['borderBottomWidth']],
      ['borderWidth: StyleSheet.hairlineWidth', ['borderWidth']],
      ['shadowColor: theme.border, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 0, height: 1 }', ['shadowColor', 'shadowOpacity', 'shadowOffset']],
      // A hard shadow line with no blur; a zero radius alone draws nothing.
      ['shadowColor: theme.border, shadowOpacity: 1, shadowRadius: 2', ['shadowColor', 'shadowOpacity', 'shadowRadius']],
    ];
    // The screen root (PinnedHeaderScreen's host view, inside its two context
    // providers) is an edge even when it is pressable or marked as a button,
    // while the Back circle's keyline inside the Back control stays allowed.
    expect(header).toContain('backCircle: { width: FLOATING_CONTROL_SIZE, height: FLOATING_CONTROL_SIZE, borderWidth: StyleSheet.hairlineWidth }');
    const root = '<View style={styles.host}>';
    const rootClose = '</View>\n      </PinnedHeaderNameContext.Provider>';
    const pressableRoot = (source: string, open: string) => source.replace(root, open).replace(rootClose, '</Pressable>\n      </PinnedHeaderNameContext.Provider>');
    const rootBreaks: Array<[string, string]> = [
      ['a Pressable root with a hairline', pressableRoot(header, '<Pressable style={[styles.host, { borderWidth: StyleSheet.hairlineWidth }]}>')],
      ['a button-role root with a hairline', header.replace(root, '<View accessibilityRole="button" style={[styles.host, { borderWidth: StyleSheet.hairlineWidth }]}>')],
      ['a Pressable root with a hairline on its host entry', pressableRoot(header.replace('host: { flex: 1 }', 'host: { flex: 1, borderWidth: StyleSheet.hairlineWidth }'), '<Pressable style={styles.host}>')],
    ];
    for (const [label, broken] of rootBreaks) {
      expect(broken, label).not.toBe(header);
      expect(findEdgeBands('src/components/PinnedHeader.tsx', broken).map(keyOf), label).toEqual(['src/components/PinnedHeader.tsx PinnedHeaderScreen borderWidth']);
    }
    for (const [edge, rules] of brokenBackings) {
      expect(findEdgeBands('src/components/PinnedHeader.tsx', header.replace(backing, `backgroundColor: theme.background, ${edge} }]`)).map(keyOf), edge)
        .toEqual(rules.map((rule) => `src/components/PinnedHeader.tsx PinnedHeader ${rule}`));
    }
    // The tab bar: a transparent shadow colour draws no line; a coloured one does.
    const tabs = readFileSync(join(MOBILE_ROOT, 'app/(tabs)/_layout.tsx'), 'utf8');
    expect(tabs).toContain('shadowColor="transparent"');
    expect(findEdgeBands('app/(tabs)/_layout.tsx', tabs)).toEqual([]);
    expect(findEdgeBands('app/(tabs)/_layout.tsx', tabs.replace('shadowColor="transparent"', 'shadowColor={theme.border}')).map(keyOf))
      .toEqual(['app/(tabs)/_layout.tsx layout shadowColor']);
    // The shared screen container, through the StyleSheet entry it uses.
    const ui = readFileSync(join(MOBILE_ROOT, 'src/components/ui.tsx'), 'utf8');
    const screenStyle = '  screen: { paddingHorizontal: spacing.lg,';
    expect(ui).toContain(screenStyle);
    expect(findEdgeBands('src/components/ui.tsx', ui)).toEqual([]);
    expect(findEdgeBands('src/components/ui.tsx', ui.replace(screenStyle, '  screen: { borderBottomWidth: 1, paddingHorizontal: spacing.lg,')).map(keyOf))
      .toEqual(['src/components/ui.tsx Screen borderBottomWidth']);
  });
});
