import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Dependabot must never bump a dependency the Expo SDK pins (
//): the weekly minor-and-patch group would otherwise move react,
// react-dom or a community native module away from the SDK's tested version.
// The ignore must name version-update types only, because a bare
// dependency-name ignore also suppresses security updates (Codex on).
// scripts/classify-ci-worklist-change.mjs runs this suite on a change to
// .github/dependabot.yml alone.
const require = createRequire(import.meta.url);
const bundled = require('expo/bundledNativeModules.json') as Record<string, string>;
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
};
const config = readFileSync(new URL('../../../../.github/dependabot.yml', import.meta.url), 'utf8');
const VERSION_UPDATES = ['version-update:semver-major', 'version-update:semver-minor', 'version-update:semver-patch'];

type Ignore = { name: string; updateTypes: string[] | null };

// The ignore entries of the /apps/mobile npm block. The section ends at the
// next key indented four spaces (allow, groups, ...) or at the block's end.
function mobileIgnores(text: string): Ignore[] {
  const block = text.split(/\n {2}- package-ecosystem: /u).find((part) => /\n {4}directory: \/apps\/mobile\n/u.test(part));
  if (!block) throw new Error('dependabot.yml has no /apps/mobile npm block');
  const lines = block.split('\n');
  const start = lines.indexOf('    ignore:');
  if (start < 0) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,4}\S/u.test(line)) break;
    section.push(line);
  }
  // The leading newline lets an entry that directly follows `ignore:` split
  // like the others; the first piece (comments or nothing) is dropped .
  return `\n${section.join('\n')}`.split(/\n {6}- /u).slice(1).flatMap((entry) => {
    const name = /^dependency-name: "([^"]+)"/u.exec(entry)?.[1];
    if (typeof name !== 'string') return [];
    const types = /\n {8}update-types: \[([^\]]*)\]/u.exec(entry)?.[1];
    return [{ name, updateTypes: types === undefined ? null : types.split(',').map((value) => value.trim().replace(/^"|"$/gu, '')) }];
  });
}

// Fixtures must edit the /apps/mobile block only: the root block carries some
// of the same lines, and String.replace would otherwise edit the root copy.
const MOBILE_BLOCK = '\n  - package-ecosystem: npm\n    directory: /apps/mobile\n';
function editMobileBlock(text: string, edit: (block: string) => string): string {
  const start = text.indexOf(MOBILE_BLOCK);
  if (start < 0) throw new Error('dependabot.yml has no /apps/mobile npm block');
  const next = text.indexOf('\n  - package-ecosystem: ', start + 1);
  const end = next < 0 ? text.length : next;
  return text.slice(0, start) + edit(text.slice(start, end)) + text.slice(end);
}
function mobileBlockOf(text: string): string {
  let found = '';
  editMobileBlock(text, (block) => {
    found = block;
    return block;
  });
  return found;
}

// Dependabot dependency-name patterns: `*` matches any run of characters.
const covers = (pattern: string, name: string) =>
  new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')).join('.*')}$`, 'u').test(name);
const versionOnly = (entry: Ignore) => entry.updateTypes !== null && VERSION_UPDATES.every((type) => entry.updateTypes?.includes(type))
  && entry.updateTypes.every((type) => VERSION_UPDATES.includes(type));

describe('Dependabot ignores every Expo SDK-pinned mobile dependency', () => {
  const ignores = mobileIgnores(config);
  const direct = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const pinned = direct.filter((name) => Object.hasOwn(bundled, name));

  it('reads the mobile ignore list and the SDK pins', () => {
    expect(ignores.map((entry) => entry.name)).toEqual(expect.arrayContaining(['expo*', 'react-native*', '@expo/*', 'react', 'react-dom']));
    expect(pinned).toEqual(expect.arrayContaining(['expo-router', 'react', 'react-dom', 'react-native',
      '@react-native-community/datetimepicker', '@react-native-masked-view/masked-view']));
  });

  it('ignores every version-update type for each SDK-pinned direct dependency', () => {
    expect(pinned.filter((name) => !ignores.some((entry) => covers(entry.name, name) && versionOnly(entry)))).toEqual([]);
  });

  it('never ignores a dependency outright, which would also suppress its security updates', () => {
    expect(ignores.filter((entry) => entry.updateTypes === null)).toEqual([]);
  });

  it('would catch a pinned dependency that loses its entry or its version-only scoping', () => {
    const entry = '      - dependency-name: "react-dom"\n        update-types: ["version-update:semver-major", "version-update:semver-minor", "version-update:semver-patch"]\n';
    expect(config).toContain(entry);
    expect(mobileIgnores(config.replace(entry, '')).some((ignore) => covers(ignore.name, 'react-dom') && versionOnly(ignore))).toBe(false);
    const bare = mobileIgnores(config.replace(entry, '      - dependency-name: "react-dom"\n'));
    expect(bare.find((ignore) => ignore.name === 'react-dom')).toEqual({ name: 'react-dom', updateTypes: null });
    expect(covers('@react-native-community/*', '@react-native-community/datetimepicker')).toBe(true);
    expect(covers('react', 'react-dom')).toBe(false);
  });

  it('stops at the end of the ignore section, so a following allow list is never read as ignores', () => {
    // The allow list goes right after the mobile ignore section, so a reader
    // that stops terminating the section would return left-pad .
    const last = '      - dependency-name: "*"\n        update-types: ["version-update:semver-major"]\n';
    const withAllow = editMobileBlock(config, (block) => {
      if (!block.endsWith(last)) throw new Error('the /apps/mobile ignore section no longer ends the block');
      return `${block}    allow:\n      - dependency-name: "left-pad"\n        update-types: ["version-update:semver-major", "version-update:semver-minor", "version-update:semver-patch"]\n`;
    });
    expect(mobileBlockOf(withAllow)).toContain('dependency-name: "left-pad"');
    expect(mobileBlockOf(config)).not.toContain('left-pad');
    expect(mobileIgnores(withAllow).map((entry) => entry.name)).not.toContain('left-pad');
    expect(mobileIgnores(withAllow)).toEqual(ignores);
  });

  it('reads an ignore entry that directly follows ignore: with no comment between them', () => {
    const bare = editMobileBlock(config, (block) => block.replace(/\n {4}ignore:\n(?: {6}#.*\n)+/u, '\n    ignore:\n'));
    expect(mobileBlockOf(bare)).toMatch(/\n {4}ignore:\n {6}- dependency-name: "expo\*"\n/u);
    expect(mobileIgnores(bare)).toEqual(ignores);
  });

  it('keeps the major-version ignore for every other dependency', () => {
    expect(ignores).toContainEqual({ name: '*', updateTypes: ['version-update:semver-major'] });
  });
});
