#!/usr/bin/env node
// TEST-UG-PHONE-TESTS-EXECUTE-SCREENS-ON-ONE-SHARED-STAND-IN-20261111 (#8319):
// counts phone screen files (.tsx under app/, src/features/, src/components/)
// that no test executes. A screen counts as executed when a test that renders
// (react-dom's createRoot or render, react-test-renderer, or the shared
// stand-in's render) imports it and does not replace it with vi.mock. Reading
// a screen's source as text does not count. Phone tests and the root tests
// that import phone files are both read.
//   node scripts/unexecuted-screens.mjs          prints the count
//   node scripts/unexecuted-screens.mjs --list   prints each file
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(mobileRoot, '../..');

function walk(dir, keep) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path, keep);
    return keep(path) ? [path] : [];
  });
}

const isTest = (path) => /\.test\.[cm]?[jt]sx?$/.test(path);

export function screenFiles(root = mobileRoot) {
  return ['app', 'src/features', 'src/components']
    .flatMap((dir) => walk(join(root, dir), (path) => path.endsWith('.tsx') && !isTest(path)))
    .sort();
}

export function testFiles(root = mobileRoot, repo = repoRoot) {
  return [...walk(join(root, 'src'), isTest), ...walk(join(repo, 'tests'), isTest)].sort();
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try { if (readdirSync(candidate)) continue; } catch { return candidate; }
    }
  }
  return null;
}

const RENDERS = /\bcreateRoot\(|\brender\(|renderToStaticMarkup\(|renderToString\(|react-test-renderer|testing\/reactNativeStandIn/;
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"`]([^'"`]+)['"`]/g;
const MOCK = /\bvi\.mock\(\s*['"`]([^'"`]+)['"`]/g;

// The screen files each rendering test executes directly.
export function executedScreens(tests = testFiles()) {
  const executed = new Set();
  for (const test of tests) {
    const source = readFileSync(test, 'utf8');
    if (!RENDERS.test(source)) continue;
    const mocked = new Set([...source.matchAll(MOCK)].map((match) => resolveImport(test, match[1])).filter(Boolean));
    for (const match of source.matchAll(IMPORT)) {
      const file = resolveImport(test, match[1]);
      if (file && file.endsWith('.tsx') && !mocked.has(file)) executed.add(file);
    }
  }
  return executed;
}

export function unexecutedScreens({ screens = screenFiles(), tests = testFiles() } = {}) {
  const executed = executedScreens(tests);
  return screens.filter((file) => !executed.has(file)).map((file) => relative(mobileRoot, file));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = unexecutedScreens();
  if (process.argv.includes('--list')) for (const file of files) console.log(file);
  console.log(`${files.length} of ${screenFiles().length} phone screen files are executed by no test`);
}
