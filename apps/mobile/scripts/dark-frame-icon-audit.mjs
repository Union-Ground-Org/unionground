import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(scriptDirectory, '..');
const palette = JSON.parse(await readFile(path.join(mobileRoot, 'src/theme/palette.json'), 'utf8'));
const night = palette['union-ground-dark'];
const [tokensSource, notificationsSource, tabsSource, entrySource, uiSource, compassRouteSource, compassPanelSource, previewRightsSource, liveRightsSource] = await Promise.all([
  readFile(path.join(mobileRoot, 'src/theme/tokens.ts'), 'utf8'),
  readFile(path.join(mobileRoot, 'app/notifications.tsx'), 'utf8'),
  readFile(path.join(mobileRoot, 'app/(tabs)/_layout.tsx'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/components/AskCompassButton.tsx'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/components/ui.tsx'), 'utf8'),
  readFile(path.join(mobileRoot, 'app/(tabs)/compass.tsx'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/components/CompassPanel.tsx'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/features/FeatureScreen.tsx'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/features/LiveLivedInScreens.tsx'), 'utf8'),
]);

const failures = [];
const passes = [];

function report(name, pass, detail) {
  (pass ? passes : failures).push({ name, detail });
}

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const pairs = [
  ['mutedForeground', 'background', 3, 'Unselected native-tab icon on the tab surface'],
  ['primary', 'background', 3, 'Selected native-tab icon on the tab surface'],
  ['compass', 'background', 3, 'Compass signal on the page surface'],
  ['compassForeground', 'compass', 4.5, 'Ask Compass button and Compass action text'],
  ['accentForeground', 'accent', 3, 'Vote notification glyph on its chip'],
  ['compass', 'secondary', 3, 'Rights notification glyph on its chip'],
  ['primary', 'secondary', 3, 'Case and message notification glyphs on their chips'],
  ['secondaryForeground', 'secondary', 3, 'Default notification glyph on its chip'],
  ['mutedForeground', 'muted', 3, 'Read and empty notification glyphs on their chips'],
  ['primary', 'card', 3, 'Unread dot and unread-card boundary on the card surface'],
  ['primaryForeground', 'primary', 4.5, 'Activity header and selected-filter text'],
  ['foreground', 'card', 4.5, 'Activity row and unselected-filter text'],
  ['border', 'card', 3, 'Unselected-filter outline on the card surface'],
  ['statusActive', 'muted', 3, 'Pulse/status active mark on the status surface'],
  ['statusAttention', 'muted', 3, 'Pulse/status attention mark on the status surface'],
  ['statusQueued', 'muted', 3, 'Pulse/status queued mark on the status surface'],
  ['statusDone', 'muted', 3, 'Pulse/status done mark on the status surface'],
  ['ring', 'background', 3, 'Focus indicator on the page surface'],
];

for (const [foregroundName, backgroundName, minimum, usage] of pairs) {
  const value = contrast(night[foregroundName], night[backgroundName]);
  report(
    `${foregroundName}/${backgroundName}`,
    value >= minimum,
    `${value.toFixed(2)}:1 (minimum ${minimum.toFixed(1)}:1) — ${usage}`,
  );
}

const sourceContracts = [
  ["Union Ground's dark form declares dark appearance", tokensSource, /return key === darkPaletteKey \? 'dark' : 'light';/],
  ["Union Ground's dark form resolves only when an audit asks for it", tokensSource, /const renderedKey: PaletteKey = prefersDark \? darkPaletteKey : key;/],
  ['Vote notification uses accent fill/foreground', notificationsSource, /case 'vote': return \{ fill: theme\.accent, glyph: theme\.accentForeground \};/],
  ['Rights notification uses Compass on secondary', notificationsSource, /case 'rights': return \{ fill: theme\.secondary, glyph: theme\.compass \};/],
  ['Case notification uses primary on secondary', notificationsSource, /case 'case': return \{ fill: theme\.secondary, glyph: theme\.primary \};/],
  ['Message notification uses primary on secondary', notificationsSource, /case 'message': return \{ fill: theme\.secondary, glyph: theme\.primary \};/],
  ['Default notification uses secondary foreground', notificationsSource, /default: return \{ fill: theme\.secondary, glyph: theme\.secondaryForeground \};/],
  ['Read notification uses muted semantic pair', notificationsSource, /backgroundColor: theme\.muted[\s\S]{0,180}color=\{theme\.mutedForeground\}/],
  ['Native tabs use semantic default/selected icon roles', tabsSource, /iconColor=\{\{ default: theme\.mutedForeground, selected: theme\.primary \}\}/],
  ['Ask the Guide entry uses the semantic Compass button variant', entrySource, /<Button\s+label=(?:"Ask the Guide"|\{t\("Ask the Guide"\)\}|\{t\("Ask Compass"\)\})\s+variant="compass"/],
  ['Ask Compass entry pushes the Compass destination', entrySource, /router\.push\('\/compass'\)/],
  ['Preview rights screen exposes Ask the Guide', previewRightsSource, /<Heading>(?:Organizing rights|\{t\("Organizing rights"\)\})<\/Heading>\s*<AskCompassButton\s*\/>/],
  ['Live rights screen exposes Ask the Guide', liveRightsSource, /<Heading>(?:Organizing rights|\{t\("Organizing rights"\)\})<\/Heading>\s*<AskCompassButton\s*\/>/],
  ['Compass button variant uses its semantic foreground pair', uiSource, /variant === 'compass'\s*\? \{ background: theme\.compass, foreground: theme\.compassForeground \}/],
  ['Guide tab renders CompassPanel', compassRouteSource, /<CompassPanel\s/],
  ['Compass panel signal uses its semantic foreground pair', compassPanelSource, /backgroundColor: compassReady \? theme\.compass : theme\.secondary[\s\S]{0,180}color=\{compassReady \? theme\.compassForeground : theme\.secondaryForeground\}/],
  ['Compass response indicator uses the semantic Compass role', compassPanelSource, /<ActivityIndicator color=\{theme\.compass\}/],
];

for (const [name, source, pattern] of sourceContracts) report(name, pattern.test(source), pattern.toString());

// Union Ground's five-tab dock: Guide (route compass) and Campaign are tabs;
// Messages and Campaign pulse are pushed. All tab icons use the shared
// semantic roles checked above instead of a per-destination override.
const tabNames = [...tabsSource.matchAll(/<NativeTabs\.Trigger\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);
report('Native tab roster follows the Union Ground dock',
  JSON.stringify(tabNames) === JSON.stringify(['home', 'work', 'compass', 'campaign', 'account']), tabNames.join(', '));
report('Native tabs retain shared semantic icon roles',
  !/\bselectedColor=|\bselectedStyle=/.test(tabsSource), 'No per-tab color overrides');

function rgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function relativeLuminance(red, green, blue) {
  const channels = [red, green, blue].map((value) => value / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function nearColor(pixel, anchors, maximumDistance) {
  return anchors.some((anchor) => Math.hypot(pixel[0] - anchor[0], pixel[1] - anchor[1], pixel[2] - anchor[2]) <= maximumDistance);
}

async function auditFrame(framePath) {
  // Keep source/icon CI independent of image tooling. `sharp` is a mobile
  // development dependency and is loaded only for the optional frame lane.
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(framePath)
    .rotate()
    .removeAlpha()
    .resize({ width: 240, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const surfaceAnchors = ['background', 'card', 'popover', 'secondary', 'muted', 'input'].map((key) => rgb(night[key]));
  const signalAnchors = ['primary', 'compass', 'accentForeground', 'statusAttention', 'statusQueued', 'statusDone'].map((key) => rgb(night[key]));
  let darkPixels = 0;
  let brightPixels = 0;
  let surfacePixels = 0;
  let signalPixels = 0;
  let minimumLuminance = 1;
  let maximumLuminance = 0;
  const total = info.width * info.height;

  for (let offset = 0; offset < data.length; offset += info.channels) {
    const pixel = [data[offset], data[offset + 1], data[offset + 2]];
    const value = relativeLuminance(...pixel);
    minimumLuminance = Math.min(minimumLuminance, value);
    maximumLuminance = Math.max(maximumLuminance, value);
    if (value <= 0.10) darkPixels += 1;
    if (value >= 0.50) brightPixels += 1;
    if (nearColor(pixel, surfaceAnchors, 32)) surfacePixels += 1;
    if (nearColor(pixel, signalAnchors, 38)) signalPixels += 1;
  }

  const values = {
    darkShare: darkPixels / total,
    brightShare: brightPixels / total,
    surfaceShare: surfacePixels / total,
    signalShare: signalPixels / total,
    range: maximumLuminance - minimumLuminance,
  };
  const framePass = info.height > info.width
    && info.width >= 240
    && info.height >= 420
    && values.darkShare >= 0.25
    && values.brightShare >= 0.005
    && values.surfaceShare >= 0.08
    && values.signalShare >= 0.0001
    && values.range >= 0.35;
  report(
    `Union Ground dark frame ${framePath}`,
    framePass,
    `${info.width}x${info.height}; dark ${(values.darkShare * 100).toFixed(1)}%; bright ${(values.brightShare * 100).toFixed(1)}%; palette surfaces ${(values.surfaceShare * 100).toFixed(1)}%; semantic signals ${(values.signalShare * 100).toFixed(2)}%; luminance range ${values.range.toFixed(2)}`,
  );
}

const argumentsList = process.argv.slice(2);
const framesFlag = argumentsList.indexOf('--frames');
if (framesFlag >= 0) {
  const frames = argumentsList.slice(framesFlag + 1);
  if (frames.length === 0) report('physical-device dark frames supplied', false, '--frames requires at least one image path');
  for (const frame of frames) await auditFrame(path.resolve(process.cwd(), frame));
} else {
  console.log('FRAME AUDIT\tNOT RUN\tNo --frames paths supplied; source/icon checks are not photographic closure evidence.');
}

console.log('Union Ground dark-frame/icon audit');
for (const item of passes) console.log(`PASS\t${item.name}\t${item.detail}`);
for (const item of failures) console.error(`FAIL\t${item.name}\t${item.detail}`);
console.log(`SUMMARY\t${passes.length} passed\t${failures.length} failed`);

if (failures.length > 0) process.exitCode = 1;
