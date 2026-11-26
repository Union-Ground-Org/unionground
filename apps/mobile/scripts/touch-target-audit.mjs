// Touch-target audit (BUG-UG-NATIVE-TOUCH-TARGETS-UNDER-48PX-20261019).
//
// Window J measured the PREVIEW hat pill and the pushed-screen Back control at
// 36 pt on an iPhone 16e and 36.2 dp on a Pixel 10a: the floating-control band
// ran from the control's top edge to the content start line and stopped. The
// repository minimum is `minimumTouchTarget` (48) in src/theme/tokens.ts.
//
// Three checks, all static, so they run in `npm run check` with the contrast
// and dark-UI audits and need no device:
//
//  1. The floating-control geometry is executed from the constants declared in
//     src/lib/chromeGeometry.ts, for every top inset a shipped phone reports,
//     and the two components that render the band are checked to wire it.
//  2. Every `<Pressable>` whose `style` names a StyleSheet entry (local,
//     aliased or imported from another module) with an explicit numeric height
//     or width under the minimum is a failure unless a `hitSlop` literal makes
//     up the difference inside the parent that clips it (React Native never
//     lets a hit slop reach past the parent's bounds), or it is listed below
//     with a reason. A style the audit cannot inspect is a failure, not a skip.
//  3. Every native Switch needs a 48 dp layout target or sufficient hitSlop.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(scriptDirectory, '..');

/** @type {{ name: string; detail: string }[]} */
const failures = [];
/** @type {{ name: string; detail: string }[]} */
const passes = [];
/**
 * @param {string} name
 * @param {boolean} pass
 * @param {string} detail
 */
function report(name, pass, detail) {
  (pass ? passes : failures).push({ name, detail });
}

// Entries here are measured on a device or justified by a visible control that
// is larger than the Pressable itself. Keep the reason specific.
/** @type {{ file: string; style: string; reason: string }[]} */
const allowed = [
  // { file: 'src/components/Example.tsx', style: 'tinyButton', reason: '...' },
];

/**
 * @param {string} source
 * @param {string} name
 * @returns {number}
 */
function numericConstant(source, name) {
  const match = source.match(new RegExp(`export const ${name} = (\\d+(?:\\.\\d+)?);`));
  if (!match) throw new Error(`Could not read ${name}`);
  return Number(match[1]);
}

// --- 1. floating controls -------------------------------------------------

const [geometry, tokens, hatSwitcher, pinnedHeader] = await Promise.all([
  readFile(path.join(mobileRoot, 'src/lib/chromeGeometry.ts'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/theme/tokens.ts'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/components/HatSwitcher.tsx'), 'utf8'),
  readFile(path.join(mobileRoot, 'src/components/PinnedHeader.tsx'), 'utf8'),
]);

const minimum = numericConstant(tokens, 'minimumTouchTarget');
const size = numericConstant(geometry, 'FLOATING_CONTROL_SIZE');
const lift = numericConstant(geometry, 'FLOATING_CONTROL_LIFT');
const liftFallback = numericConstant(geometry, 'FLOATING_CONTROL_LIFT_FALLBACK');
const contentStart = numericConstant(geometry, 'CONTENT_START_OFFSET');
const hitWidth = numericConstant(geometry, 'FLOATING_CONTROL_HIT_WIDTH');
const hitHeight = numericConstant(geometry, 'FLOATING_CONTROL_HIT_HEIGHT');
const minimumTop = 4; // spacing.xs, the floor floatingControlTop applies

report('minimumTouchTarget is 48', minimum === 48, `${minimum}`);
report('floating control hit width meets the minimum', hitWidth >= minimum, `${hitWidth} >= ${minimum}`);
report('floating control hit height meets the minimum', hitHeight >= minimum, `${hitHeight} >= ${minimum}`);
report(
  'floatingControlHitHeight adds the status-bar overlap and floors the band at FLOATING_CONTROL_HIT_HEIGHT',
  /const systemOverlap = Math\.max\(0, safeAreaTop - controlTop\);\s*return Math\.max\(FLOATING_CONTROL_HIT_HEIGHT \+ systemOverlap, contentStartInset\(safeAreaTop\) - controlTop\);/.test(geometry),
  'the formula in src/lib/chromeGeometry.ts',
);

// Executed the way the components do it: top = max(inset - lift, 4), band =
// max(hit height + overlap above the safe-area line, content start - top). The
// overlap is system-owned (the status bar takes those taps), so the number
// that must meet the minimum is the part of the band below the safe-area line.
// 0 is a device with no inset, 20 a status bar, 47 the iPhone 16e, 54/59/62
// the Dynamic Island phones.
for (const inset of [0, 20, 47, 54, 59, 62]) {
  for (const [label, currentLift] of /** @type {[string, number][]} */ ([['lift', lift], ['fallback lift', liftFallback]])) {
    const top = Math.max(inset - currentLift, minimumTop);
    const overlap = Math.max(0, inset - top);
    const band = Math.max(hitHeight + overlap, inset + contentStart - top);
    const deliverable = top + band - Math.max(top, inset);
    report(
      `floating band at inset ${inset} (${label})`,
      deliverable >= minimum && band >= size,
      `${band}pt tall from y=${top}, ${deliverable}pt below the safe-area line, control ${size}pt, content start ${inset + contentStart}`,
    );
  }
}

report(
  'HatSwitcher sizes its anchor band from floatingControlHitHeight',
  hatSwitcher.includes('const pillBandHeight = floatingControlHitHeight(insets.top, pillTop);')
    && hatSwitcher.includes('{ top: pillTop, height: pillBandHeight }')
    && hatSwitcher.includes('const COMPACT_PILL_WIDTH = FLOATING_CONTROL_HIT_WIDTH;'),
  'the band is the tap target, floating and compact',
);
report(
  'PinnedHeader sizes its back slot from floatingControlHitHeight',
  pinnedHeader.includes('const bandHeight = floatingControlHitHeight(insets.top, controlTop);')
    && pinnedHeader.includes('width: FLOATING_CONTROL_HIT_WIDTH,')
    && pinnedHeader.includes('height: bandHeight }'),
  'the slot is the tap target',
);
// No hitSlop on either: the band the device tree reports is the effective area,
// so a measurement cannot be argued away by an invisible inflation.
report('floating controls carry no hitSlop', !/hitSlop=/.test(hatSwitcher) && !/hitSlop=/.test(pinnedHeader), 'layout bounds are the tap area');
// The actual button carries the label on both platforms, not a container.
const hatPressable = hatSwitcher.slice(hatSwitcher.indexOf('<Pressable\n            accessible'), hatSwitcher.indexOf('onPress={open ? closeMenu : openMenu}'));
report(
  'role pill button carries a non-empty accessibility label',
  hatPressable.includes('accessibilityRole="button"')
    && /accessibilityLabel=\{mode === 'preview' \? `PREVIEW demo, switch role, \$\{current\.label\}` : `Demo, switch role, \$\{current\.label\}`\}/.test(hatPressable),
  'label on the Pressable that owns onPress',
);

// --- 2. every Pressable with an explicit small style ---------------------

/**
 * @param {string} directory
 * @returns {AsyncGenerator<string>}
 */
async function* sources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* sources(full);
    } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
      yield full;
    }
  }
}

/**
 * Every `const NAME = StyleSheet.create({...})` in a module, exported or not,
 * as NAME -> (entry name -> entry source).
 * @param {string} source
 * @returns {Map<string, Map<string, string>>}
 */
function styleSheets(source) {
  /** @type {Map<string, Map<string, string>>} */
  const sheets = new Map();
  const opener = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*StyleSheet\.create\(\{/g;
  /** @type {RegExpExecArray | null} */
  let match;
  while ((match = opener.exec(source)) !== null) {
    /** @type {Map<string, string>} */
    const entries = new Map();
    let index = match.index + match[0].length;
    let depth = 1;
    let keyStart = index;
    /** @type {string | null} */
    let key = null;
    for (; index < source.length && depth > 0; index += 1) {
      const char = source[index];
      if (char === '{' || char === '[' || char === '(') {
        if (depth === 1 && key === null) {
          const head = source.slice(keyStart, index);
          const keyMatch = head.match(/([A-Za-z_$][\w$]*)\s*:\s*$/);
          key = keyMatch ? keyMatch[1] : null;
          keyStart = index;
        }
        depth += 1;
      } else if (char === '}' || char === ']' || char === ')') {
        depth -= 1;
        if (depth === 1 && key !== null) {
          entries.set(key, source.slice(keyStart, index + 1));
          key = null;
          keyStart = index + 1;
        }
      }
    }
    sheets.set(match[1], entries);
    opener.lastIndex = index;
  }
  return sheets;
}

/** @type {Map<string, Map<string, Map<string, string>>>} */
const moduleSheets = new Map();
/**
 * @param {string} file
 * @returns {Promise<Map<string, Map<string, string>>>}
 */
async function sheetsOf(file) {
  const cached = moduleSheets.get(file);
  if (cached) return cached;
  const parsed = styleSheets(await readFile(file, 'utf8'));
  moduleSheets.set(file, parsed);
  return parsed;
}

/**
 * The sheets a file can reference by local name: its own, plus every imported
 * binding (`import { styles } from './ui'`, `import { mi1Styles as styles }
 * from './mi1Styles'`, `import styles from './x'`) whose module declares a
 * StyleSheet of that exported name.
 * @param {string} file
 * @param {string} source
 * @returns {Promise<Map<string, Map<string, string>>>}
 */
async function sheetsVisibleIn(file, source) {
  const visible = new Map(await sheetsOf(file));
  const importPattern = /import\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s+from\s+'(\.[^']+)'/g;
  /** @type {RegExpExecArray | null} */
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const modulePath = match[3];
    const base = path.resolve(path.dirname(file), modulePath);
    const candidates = [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
    /** @type {string | null} */
    let resolved = null;
    for (const candidate of candidates) {
      try { await readFile(candidate, 'utf8'); resolved = candidate; break; } catch { /* next candidate */ }
    }
    if (!resolved) continue;
    const exported = await sheetsOf(resolved);
    if (exported.size === 0) continue;
    if (match[1]) {
      const sheet = exported.get('default') ?? [...exported.values()][0];
      if (sheet) visible.set(match[1], sheet);
      continue;
    }
    for (const binding of match[2].split(',')) {
      const parts = binding.trim().match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!parts) continue;
      const sheet = exported.get(parts[1]);
      if (sheet) visible.set(parts[2] ?? parts[1], sheet);
    }
  }
  return visible;
}

/**
 * Every JSX opening tag of the named elements, with the `<View>` ancestry open
 * at that point (self-closing Views excluded), so a hit slop can be clipped
 * against the parent that will clip it at runtime.
 * @param {string} source
 * @param {string[]} switchNames
 * @returns {Generator<{ name: string; tag: string; line: number; parents: string[] }>}
 */
function* jsxTags(source, switchNames = []) {
  const names = ['Pressable', 'View', 'Animated\\.View', ...switchNames.map((name) => name.replaceAll('.', '\\.'))];
  const opener = new RegExp(`<(${names.join('|')})\\b|<\\/(View|Animated\\.View)>`, 'g');
  /** @type {string[]} */
  const stack = [];
  /** @type {RegExpExecArray | null} */
  let match;
  while ((match = opener.exec(source)) !== null) {
    if (match[2]) { stack.pop(); continue; }
    let index = match.index + match[0].length;
    let depth = 0;
    /** @type {string | null} */
    let quote = null;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote && source[index - 1] !== '\\') quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      // A JS comment between attributes (or inside a brace) may hold quotes
      // and brackets of its own; skip it whole.
      if (char === '/' && source[index + 1] === '/') {
        const newline = source.indexOf('\n', index);
        index = newline < 0 ? source.length : newline;
        continue;
      }
      if (char === '/' && source[index + 1] === '*') {
        const close = source.indexOf('*/', index + 2);
        index = close < 0 ? source.length : close + 1;
        continue;
      }
      if (char === '{' || char === '(') depth += 1;
      else if (char === '}' || char === ')') depth -= 1;
      else if (char === '>' && depth === 0 && source[index - 1] !== '=') break;
    }
    const tag = source.slice(match.index, index + 1);
    const line = source.slice(0, match.index).split('\n').length;
    const selfClosing = tag.endsWith('/>');
    yield { name: match[1], tag, line, parents: [...stack] };
    if (!selfClosing && ['View', 'Animated.View'].includes(match[1])) stack.push(tag);
    opener.lastIndex = index;
  }
}

/**
 * @param {string} styleBody
 * @param {string} name
 * @returns {number | null}
 */
function numberIn(styleBody, name) {
  const match = styleBody.match(new RegExp(`(?<![\\w.])${name}:\\s*(\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
}

/**
 * A `hitSlop` literal as the four insets, or null when the prop is absent or
 * not a literal the audit can read (then it counts for nothing).
 * @param {string} tag
 * @returns {{ top: number; bottom: number; left: number; right: number } | null}
 */
function hitSlopOf(tag) {
  const match = tag.match(/\bhitSlop=\{\s*([\s\S]*?)\s*\}(?=\s|$|\n)/);
  if (!match) return null;
  const literal = match[1].trim();
  if (/^\d+(?:\.\d+)?$/.test(literal)) {
    const all = Number(literal);
    return { top: all, bottom: all, left: all, right: all };
  }
  const object = literal.match(/^\{([\s\S]*)\}$/);
  if (!object) return null;
  /** @param {string} side */
  const side = (side) => numberIn(object[1], side) ?? 0;
  return { top: side('top'), bottom: side('bottom'), left: side('left'), right: side('right') };
}

/**
 * The style entries a tag's `style` prop names, as `sheet.entry` pairs.
 * @param {string} tag
 * @returns {{ sheet: string; entry: string }[]}
 */
function styleReferences(tag) {
  const styleAttribute = tag.match(/\bstyle=\{([\s\S]*)\}/);
  if (!styleAttribute) return [];
  const seen = new Set();
  /** @type {{ sheet: string; entry: string }[]} */
  const references = [];
  for (const reference of styleAttribute[1].matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b/g)) {
    const key = `${reference[1]}.${reference[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ sheet: reference[1], entry: reference[2] });
  }
  return references;
}

let scanned = 0;
let switchesScanned = 0;
for (const root of ['src', 'app']) {
  for await (const file of sources(path.join(mobileRoot, root))) {
    const source = await readFile(file, 'utf8');
    const visible = await sheetsVisibleIn(file, source);
    const relative = path.relative(mobileRoot, file);
    // Resolve the React Native import so renaming Switch cannot bypass the
    // sweep and a local PreferenceSwitch wrapper is not counted twice.
    /** @type {string[]} */
    const switchNames = [];
    for (const imported of source.matchAll(/import\s*(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]react-native['"]/g)) {
      for (const binding of imported[1].split(',')) {
        const match = binding.trim().match(/^Switch(?:\s+as\s+(\w+))?$/);
        if (match) switchNames.push(match[1] ?? 'Switch');
      }
    }
    for (const imported of source.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*['"]react-native['"]/g)) {
      switchNames.push(`${imported[1]}.Switch`);
    }
    for (const { name, tag, line, parents } of jsxTags(source, switchNames)) {
      if (switchNames.includes(name)) {
        switchesScanned += 1;
        const slop = hitSlopOf(tag);
        // Android's unstyled native Switch is 46 x 27 dp. A 48 dp row
        // alone is not interactive; the control itself needs layout bounds
        // or enough hitSlop (the existing privacy-switch pattern).
        let width = 46;
        let height = 27;
        const bodies = [tag.match(/\bstyle=\{([\s\S]*)\}/)?.[1] ?? ''];
        for (const { sheet, entry } of styleReferences(tag)) {
          const body = visible.get(sheet)?.get(entry);
          if (body) bodies.push(body);
        }
        for (const body of bodies) {
          const resolved = body.replace(/\bminimumTouchTarget\b/g, String(minimum));
          width = Math.max(width, numberIn(resolved, 'minWidth') ?? numberIn(resolved, 'width') ?? 0);
          height = Math.max(height, numberIn(resolved, 'minHeight') ?? numberIn(resolved, 'height') ?? 0);
        }
        width += slop ? slop.left + slop.right : 0;
        height += slop ? slop.top + slop.bottom : 0;
        const parent = parents.at(-1);
        if (slop && parent) {
          const parentBodies = [parent.match(/\bstyle=\{([\s\S]*)\}/)?.[1] ?? ''];
          for (const { sheet, entry } of styleReferences(parent)) {
            const body = visible.get(sheet)?.get(entry);
            if (body) parentBodies.push(body);
          }
          for (const body of parentBodies) {
            const resolved = body.replace(/\bminimumTouchTarget\b/g, String(minimum));
            width = Math.min(width, numberIn(resolved, 'width') ?? width);
            height = Math.min(height, numberIn(resolved, 'height') ?? height);
          }
        }
        report(`${relative}:${line} <${name}>`, width >= minimum && height >= minimum,
          `${width} x ${height} dp${width < minimum || height < minimum ? ` under ${minimum}` : ''}`);
        continue;
      }
      if (name !== 'Pressable') continue;
      scanned += 1;
      const slop = hitSlopOf(tag);
      for (const { sheet, entry } of styleReferences(tag)) {
        const entries = visible.get(sheet);
        if (!entries) continue; // not a StyleSheet (theme.x, elevation.x, ...)
        const body = entries.get(entry);
        const label = `${relative}:${line} <Pressable style={${sheet}.${entry}}>`;
        if (!body) {
          report(label, false, `references ${sheet}.${entry}, which the audit cannot find in that StyleSheet`);
          continue;
        }
        const height = numberIn(body, 'minHeight') ?? numberIn(body, 'height');
        const width = numberIn(body, 'minWidth') ?? numberIn(body, 'width');
        /** @type {string[]} */
        const small = [];
        if (height !== null && height < minimum) {
          let effective = height + (slop ? slop.top + slop.bottom : 0);
          // React Native clips a hit slop to the parent's bounds. The parent's
          // height is its own explicit height, or, for a padded row whose
          // tallest child is this control, the control plus the padding.
          const parent = parents[parents.length - 1];
          if (slop && parent) {
            for (const reference of styleReferences(parent)) {
              const parentBody = visible.get(reference.sheet)?.get(reference.entry);
              if (!parentBody) continue;
              const explicit = numberIn(parentBody, 'height') ?? numberIn(parentBody, 'minHeight');
              const padding = numberIn(parentBody, 'paddingVertical') ?? numberIn(parentBody, 'padding');
              const clip = explicit ?? (padding !== null ? height + 2 * padding : null);
              if (clip !== null) effective = Math.min(effective, clip);
            }
          }
          if (effective < minimum) small.push(`height ${height}${slop ? ` (effective ${effective} with hitSlop)` : ''}`);
        }
        if (width !== null && width < minimum) {
          const effective = width + (slop ? slop.left + slop.right : 0);
          if (effective < minimum) small.push(`width ${width}${slop ? ` (effective ${effective} with hitSlop)` : ''}`);
        }
        if (small.length === 0) continue;
        const allowance = allowed.find((item) => item.file === relative && item.style === entry);
        report(label, Boolean(allowance), allowance ? `allowed: ${allowance.reason}` : `${small.join(', ')} under ${minimum}`);
      }
    }
  }
}
report('Pressable sweep', scanned > 0, `${scanned} Pressable elements scanned across ${moduleSheets.size} StyleSheet modules`);
report('Switch sweep', switchesScanned > 0, `${switchesScanned} native Switch elements scanned`);

for (const { name, detail } of passes) console.log(`PASS\t${name}\t${detail}`);
for (const { name, detail } of failures) console.log(`FAIL\t${name}\t${detail}`);
console.log(`\n${passes.length} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
