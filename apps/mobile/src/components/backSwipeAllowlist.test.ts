import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

// OPS-UG-PHONE-APP-BACK-SWIPE-AND-EDGE-BAND-GUARDS-20261118 (#9128).
// A pushed phone screen returns to the previous screen with the iOS edge swipe.
// `gestureEnabled: false` turns that swipe off, so it may appear only in the
// screens named below, each with the reason it stands down. Any other place
// (navigation.setOptions, a navigator's screenOptions, a Stack.Screen's
// options, or a JSX prop) fails here. The design publish checklist
// (REQ-UG-DESIGN-PUBLISH-CHECKLIST-20261118) points at this test for
// its back-swipe item.

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCANNED_ROOTS = ['app', 'src'];

const BACK_SWIPE_OFF_ALLOWLIST: Readonly<Record<string, string>> = {
  // This edition's Organizing rights lesson reader keeps the swipe guard it shipped with.
  'src/features/FeatureScreen.tsx':
    'Organizing rights lesson reader: while a lesson opened from the index is showing, header Back and Android back return to the index; '
    + 'the iOS edge swipe would pop the whole feature past the reader, so it stands down only while that lesson shows.',
  'src/features/LiveLivedInScreens.tsx':
    'Campaign document reader: while a document opened from the list is showing, header Back and Android back close it and return to the list; '
    + 'the iOS edge swipe would pop My campaign past the reader, so it stands down only while that document shows.',
  'src/features/learning/LearningContentManager.tsx':
    'Learning content manager: Organizing rights and Account are pushed screens whose edge swipe would pop the whole screen past the '
    + "manager's draft-discard confirmation, so it stands down while the manager is open.",
};

type SwipeOff = { file: string; line: number; text: string };

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'testing') walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        found.push(path);
      }
    }
  };
  walk(root);
  return found;
}

function isTrueLiteral(node: ts.Node | undefined): boolean {
  return node !== undefined && node.kind === ts.SyntaxKind.TrueKeyword;
}

// A property's name as the runtime sees it: gestureEnabled, 'gestureEnabled',
// ["gestureEnabled"] and [`gestureEnabled`] are one key.
function staticName(name: ts.PropertyName | ts.Expression): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return staticName(name.expression);
  return undefined;
}

/** Every place in one source file that sets gestureEnabled to anything but `true`. */
function findBackSwipeOff(file: string, source: string): SwipeOff[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: SwipeOff[] = [];
  const report = (node: ts.Node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    found.push({ file, line: line + 1, text: node.getText(sourceFile) });
  };
  const visit = (node: ts.Node) => {
    // Object literals (setOptions, screenOptions, Stack.Screen options) and a
    // shorthand `{ gestureEnabled }`, whose value is not knowable here.
    if (ts.isPropertyAssignment(node) && staticName(node.name) === 'gestureEnabled' && !isTrueLiteral(node.initializer)) report(node);
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'gestureEnabled') report(node);
    // A JSX prop: gestureEnabled={false}; a bare `gestureEnabled` prop is true.
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === 'gestureEnabled' && node.initializer) {
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (!isTrueLiteral(value)) report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function scanApp(): SwipeOff[] {
  return SCANNED_ROOTS.flatMap((root) => sourceFiles(join(MOBILE_ROOT, root)))
    .flatMap((path) => findBackSwipeOff(relative(MOBILE_ROOT, path).replace(/\\/g, '/'), readFileSync(path, 'utf8')));
}

describe('back swipe stays on outside the named screens (#9128)', () => {
  const found = scanApp();

  it('turns the swipe off only in an allowlisted screen', () => {
    const outside = found.filter((hit) => !(hit.file in BACK_SWIPE_OFF_ALLOWLIST)).map((hit) => `${hit.file}:${hit.line} ${hit.text}`);
    expect(outside, 'gestureEnabled false outside the allowlist: restore the back swipe, or add the screen with its reason').toEqual([]);
  });

  it('holds exactly the three screens named here, each with a reason, and each still needs its entry', () => {
    expect(Object.keys(BACK_SWIPE_OFF_ALLOWLIST).sort()).toEqual(['src/features/FeatureScreen.tsx', 'src/features/LiveLivedInScreens.tsx', 'src/features/learning/LearningContentManager.tsx']);
    for (const [file, reason] of Object.entries(BACK_SWIPE_OFF_ALLOWLIST)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(40);
      expect(found.some((hit) => hit.file === file), `${file} no longer turns the swipe off; drop its allowlist entry`).toBe(true);
    }
  });

  it('catches each way a screen can turn the swipe off', () => {
    const broken = [
      "navigation.setOptions({ gestureEnabled: false });",
      "<Stack screenOptions={{ headerShown: false, gestureEnabled: false }} />",
      "<Stack.Screen name=\"issue\" options={() => ({ gestureEnabled: !canLeave })} />",
      "<Screen gestureEnabled={false} />",
      "const gestureEnabled = false; navigation.setOptions({ gestureEnabled });",
      // A quoted or computed key is the same option at runtime.
      "navigation.setOptions({ 'gestureEnabled': false });",
      "<Stack screenOptions={{ [\"gestureEnabled\"]: false }} />",
      "<Stack.Screen name=\"issue\" options={{ [`gestureEnabled`]: false }} />",
    ];
    for (const line of broken) expect(findBackSwipeOff('app/broken.tsx', line), line).toHaveLength(1);
    expect(findBackSwipeOff('app/fine.tsx', "navigation.setOptions({ gestureEnabled: true }); type O = { gestureEnabled: boolean };")).toEqual([]);
    expect(findBackSwipeOff('app/fine.tsx', "navigation.setOptions({ 'gestureEnabled': true });")).toEqual([]);
  });

  it('fails on a broken copy of a real screen', () => {
    const account = readFileSync(join(MOBILE_ROOT, 'app/(tabs)/account.tsx'), 'utf8');
    expect(findBackSwipeOff('app/(tabs)/account.tsx', account)).toEqual([]);
    const brokenCopy = `${account}\nexport function Broken({ navigation }: { navigation: { setOptions: (o: object) => void } }) { navigation.setOptions({ gestureEnabled: false }); return null; }\n`;
    const hits = findBackSwipeOff('app/(tabs)/account.tsx', brokenCopy);
    expect(hits).toHaveLength(1);
    expect(hits.every((hit) => !(hit.file in BACK_SWIPE_OFF_ALLOWLIST))).toBe(true);
    expect(findBackSwipeOff('app/(tabs)/account.tsx', brokenCopy.replace('{ gestureEnabled: false }', "{ 'gestureEnabled': false }"))).toHaveLength(1);
  });
});
