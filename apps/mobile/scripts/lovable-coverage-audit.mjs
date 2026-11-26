import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbiddenAppHostsIn } from '../../../scripts/lib/sibling-deny-list.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(mobileRoot, '../..');
const manifestPath = path.join(mobileRoot, 'lovable-coverage-manifest.json');

// The census keeps every route module and feature key inside a named review
// and access group, so a destination cannot ship without a design review home.
// The source census and the Union Ground contracts below are enforced.
const [manifest, featureSource, tokenSource, appSource, previewSource, legalSource, campaignSource, legalScreenSource] = await Promise.all([
  readFile(manifestPath, 'utf8').then(JSON.parse),
  readFile(path.join(mobileRoot, 'src/lib/featureCatalog.ts'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/theme/tokens.ts'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/state/AppProvider.tsx'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/data/preview.ts'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/lib/legalDocuments.ts'), 'utf8'),
  readFile(path.join(mobileRoot, 'app/(tabs)/campaign.tsx'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/features/LegalDocumentScreen.tsx'), 'utf8'),
]);

const failures = [];
const passes = [];

function report(name, pass, detail) {
  (pass ? passes : failures).push({ name, detail });
}

function stringLiterals(value) {
  return [...value.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

// Feature-key lists are declared either as `as const` tuples or as
// `readonly FeatureKey[]` arrays; both are source-of-truth censuses here.
function exportedArray(source, name) {
  const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}(?::\\s*readonly FeatureKey\\[\\])?\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as const)?;`));
  if (!match) throw new Error(`Could not parse ${name}`);
  return stringLiterals(match[1]);
}

function typeUnion(source, name) {
  const match = source.match(new RegExp(`type\\s+${name}\\s*=([\\s\\S]*?);`));
  if (!match) throw new Error(`Could not parse ${name}`);
  return stringLiterals(match[1]);
}

function exactArray(actual, expected, label) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  report(label, pass, pass ? `${actual.length} entries` : `expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
}

function exactSet(actual, expected, label) {
  const normalizedActual = [...new Set(actual)].sort();
  const normalizedExpected = [...new Set(expected)].sort();
  const duplicates = actual.length !== new Set(actual).size;
  const pass = !duplicates && JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected);
  report(label, pass, pass ? `${actual.length} unique entries` : `expected ${JSON.stringify(normalizedExpected)}, found ${JSON.stringify(normalizedActual)}${duplicates ? ' (duplicates present)' : ''}`);
}

async function routeModules(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await routeModules(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(relative);
  }
  return files.sort();
}

const actualRoutes = await routeModules(path.join(mobileRoot, 'app'));
const actualFeatures = exportedArray(featureSource, 'FEATURE_KEYS');
const staffDesks = exportedArray(featureSource, 'STAFF_DESK_FEATURE_KEYS');
const staffTools = exportedArray(featureSource, 'STAFF_TOOL_FEATURE_KEYS');
const leadershipFeatures = exportedArray(featureSource, 'LEADERSHIP_FEATURE_KEYS');
const chapterAdminFeatures = exportedArray(featureSource, 'CHAPTER_ADMIN_FEATURE_KEYS');
const integrationFeatures = exportedArray(featureSource, 'INTEGRATION_FEATURE_KEYS');
const operationsFeatures = exportedArray(featureSource, 'OPERATIONS_FEATURE_KEYS');
const stewardDeskTools = exportedArray(featureSource, 'STEWARD_DESK_TOOL_FEATURE_KEYS');
const chapterNoticeFeatures = exportedArray(featureSource, 'CHAPTER_ADMIN_OR_PRESIDENT_FEATURE_KEYS');
const memberFeatures = actualFeatures.filter((key) => ![...staffDesks, ...staffTools, ...leadershipFeatures, ...chapterAdminFeatures, ...integrationFeatures, ...operationsFeatures, ...stewardDeskTools, ...chapterNoticeFeatures].includes(key));
const actualModes = typeUnion(appSource, 'AppMode');
const actualLegalPages = typeUnion(legalSource, 'LegalPageKey');
const previewBlock = previewSource.match(/export const PREVIEW_HATS:[\s\S]*?=\s*\[([\s\S]*?)\n\];/);
if (!previewBlock) throw new Error('Could not parse PREVIEW_HATS');
const actualHats = [...previewBlock[1].matchAll(/\bkey:\s*'([^']+)'/g)].map((match) => match[1]);
const palette = JSON.parse(await readFile(path.join(mobileRoot, 'src/theme/palette.json'), 'utf8'));
const actualThemes = Object.keys(palette);

const defaultTheme = tokenSource.match(/defaultThemeKey\s*=\s*'([^']+)'/)?.[1];
if (!defaultTheme) throw new Error('Could not parse theme defaults');
// One palette for every hat: effectiveThemeKey ignores the worn hat.
const oneThemeForEveryHat = tokenSource.includes('return normalizeThemeKey(selectedTheme);');
const actualHatThemes = Object.fromEntries(actualHats.map((hat) => [hat, oneThemeForEveryHat ? defaultTheme : 'unknown']));

exactArray(actualRoutes, manifest.routeModules, 'route module census');
exactArray(actualFeatures, manifest.featureKeys, 'feature-key registry');
exactArray(actualModes, manifest.appModes, 'application modes');
exactArray(actualHats, manifest.previewHats, 'preview hat roster');
exactArray(actualLegalPages, manifest.legalPageKeys, 'legal-page registry');
exactArray(actualThemes, Object.keys(manifest.themeAppearances), 'theme palette registry');
report('dark theme declaration', tokenSource.includes("return key === darkPaletteKey ? 'dark' : 'light';") && tokenSource.includes("export const darkPaletteKey = 'union-ground-dark' satisfies PaletteKey;") && manifest.themeAppearances['union-ground-dark'] === 'dark', "Union Ground's dark form is the sole declared dark palette");
report('per-hat theme defaults', JSON.stringify(actualHatThemes) === JSON.stringify(manifest.hatDefaultThemes), JSON.stringify(actualHatThemes));

exactSet(manifest.surfaceGroups.flatMap((group) => group.modules), manifest.routeModules, 'route-to-review-group coverage');
exactSet(manifest.featureAccessGroups.flatMap((group) => group.keys), manifest.featureKeys, 'feature access-group coverage');
exactSet(manifest.featureReviewGroups.flatMap((group) => group.keys), manifest.featureKeys, 'feature review-group coverage');

const accessByID = Object.fromEntries(manifest.featureAccessGroups.map((group) => [group.id, group.keys]));
exactArray(memberFeatures, accessByID['member-and-authorized-session'], 'member/authorized feature access group');
exactArray(staffDesks, accessByID['exact-staff-desk'], 'exact staff-desk access group');
exactArray(staffTools, accessByID['any-staff-role'], 'any-staff access group');
exactArray(leadershipFeatures, accessByID['leadership'], 'leadership access group');
exactArray(chapterAdminFeatures, accessByID['chapter-admin'], 'chapter-admin access group');
exactArray(integrationFeatures, accessByID['admin-or-president'], 'admin-or-president access group');
exactArray(operationsFeatures, accessByID['admin-only'], 'admin-only access group');
exactArray(stewardDeskTools, accessByID['exact-committee-hat'], 'exact Committee-hat access group');
exactArray(chapterNoticeFeatures, accessByID['chapter-admin-or-president'], 'chapter admin-or-president access group');

const requiredStates = ['empty', 'populated', 'loading', 'success', 'error', 'disabled', 'selected', 'detail', 'modal-or-system-sheet', 'destructive-or-cancel', 'long-content', 'revoked-access'];
report(
  'required review-state dimensions',
  requiredStates.every((state) => manifest.crossCuttingReviewStates.includes(state)),
  requiredStates.join(', '),
);

// Union Ground contracts: the Campaign tab keeps campaign work in the app,
// and the legal reader opens a website only once Union Ground has one.
report(
  'Campaign tab keeps campaign work in the app',
  !campaignSource.includes('Linking.openURL') && !campaignSource.includes('https://'),
  'no implicit browser hand-off from the Campaign tab',
);
report(
  'legal reader opens no site until one is published',
  legalSource.includes('export const LEGAL_SITE_ORIGIN: string | null = PUBLIC_SITE_ORIGIN;')
    && legalScreenSource.includes('{legalSiteUrl(document) ? (')
    && forbiddenAppHostsIn(legalScreenSource).length === 0,
  'legal site origin follows PUBLIC_SITE_ORIGIN',
);

let head = 'unknown';
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
} catch {
  // The source census remains useful from an exported tree without Git metadata.
}

console.log(`Union Ground design coverage census (working tree at ${head})`);
for (const item of passes) console.log(`PASS\t${item.name}\t${item.detail}`);
for (const item of failures) console.error(`FAIL\t${item.name}\t${item.detail}`);
console.log(`SUMMARY\t${passes.length} passed\t${failures.length} failed`);

if (failures.length > 0) process.exitCode = 1;
