import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WORD_FIT_GLYPH_EM } from '../lib/wordFit';
import {
  androidSingleFaceFamilies,
  fontFiles,
  resolveTypography,
  typography,
  type EmbeddedWeight,
  type FontFile,
  type TypographyRole,
} from './tokens';

// UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115 (#8928).
const mobileRoot = new URL('../../', import.meta.url);
const repoRoot = new URL('../../../../', import.meta.url);
const fontsDir = new URL('fonts/', mobileRoot);

function mobileFile(path: string): URL {
  return new URL(path.replace(/^\.\//u, ''), mobileRoot);
}

type SfntFacts = {
  version: number;
  tables: string[];
  postScriptName: string;
  familyNames: string[];
  typographicFamily: string;
  weightClass: number;
  fsType: number;
};

// Reads the few sfnt fields the checks need: the table directory, the OS/2
// weight class and embedding bits, and the Windows-platform (UTF-16BE) names.
function readSfnt(bytes: Buffer): SfntFacts {
  const tableCount = bytes.readUInt16BE(4);
  const tables = new Map<string, number>();
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    tables.set(bytes.toString('latin1', record, record + 4), bytes.readUInt32BE(record + 8));
  }
  const nameOffset = tables.get('name');
  const os2Offset = tables.get('OS/2');
  if (nameOffset === undefined || os2Offset === undefined) throw new Error('missing name or OS/2 table');
  const names = new Map<number, string>();
  const recordCount = bytes.readUInt16BE(nameOffset + 2);
  const storage = nameOffset + bytes.readUInt16BE(nameOffset + 4);
  for (let index = 0; index < recordCount; index += 1) {
    const record = nameOffset + 6 + index * 12;
    const platform = bytes.readUInt16BE(record);
    const language = bytes.readUInt16BE(record + 4);
    const nameId = bytes.readUInt16BE(record + 6);
    if (platform !== 3 || language !== 0x409 || names.has(nameId)) continue;
    const start = storage + bytes.readUInt16BE(record + 10);
    const utf16 = Buffer.from(bytes.subarray(start, start + bytes.readUInt16BE(record + 8)));
    names.set(nameId, utf16.swap16().toString('utf16le'));
  }
  return {
    version: bytes.readUInt32BE(0),
    tables: [...tables.keys()],
    postScriptName: names.get(6) ?? '',
    familyNames: [names.get(1) ?? ''],
    typographicFamily: names.get(16) ?? '',
    weightClass: bytes.readUInt16BE(os2Offset + 4),
    fsType: bytes.readUInt16BE(os2Offset + 8),
  };
}

// A word's advance in ems, from the file's own Windows Unicode cmap (format 4)
// and hmtx tables.
function wordEms(bytes: Buffer, word: string): number {
  const tables = new Map<string, number>();
  for (let index = 0; index < bytes.readUInt16BE(4); index += 1) {
    const record = 12 + index * 16;
    tables.set(bytes.toString('latin1', record, record + 4), bytes.readUInt32BE(record + 8));
  }
  const [cmap, hmtx, hhea, head] = ['cmap', 'hmtx', 'hhea', 'head'].map((tag) => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`missing ${tag} table`);
    return offset;
  }) as [number, number, number, number];
  let subtable = -1;
  for (let index = 0; index < bytes.readUInt16BE(cmap + 2); index += 1) {
    const record = cmap + 4 + index * 8;
    if (bytes.readUInt16BE(record) === 3 && bytes.readUInt16BE(record + 2) === 1) subtable = cmap + bytes.readUInt32BE(record + 4);
  }
  if (subtable < 0 || bytes.readUInt16BE(subtable) !== 4) throw new Error('no format 4 Unicode cmap');
  const segments = bytes.readUInt16BE(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  const glyphOf = (code: number): number => {
    for (let segment = 0; segment < segments; segment += 1) {
      if (code > bytes.readUInt16BE(ends + segment * 2)) continue;
      const start = bytes.readUInt16BE(starts + segment * 2);
      if (code < start) return 0;
      const delta = bytes.readInt16BE(deltas + segment * 2);
      const rangeOffset = bytes.readUInt16BE(ranges + segment * 2);
      if (rangeOffset === 0) return (code + delta) & 0xffff;
      const glyph = bytes.readUInt16BE(ranges + segment * 2 + rangeOffset + (code - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
  const metrics = bytes.readUInt16BE(hhea + 34);
  const advance = (glyph: number): number => bytes.readUInt16BE(hmtx + Math.min(glyph, metrics - 1) * 4);
  const unitsPerEm = bytes.readUInt16BE(head + 18);
  return [...word].reduce((sum, character) => sum + advance(glyphOf(character.codePointAt(0) ?? 0)), 0) / unitsPerEm;
}

function cssVariable(css: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(css);
  if (!match?.[1]) throw new Error(`${name} is not in the theme`);
  return match[1].trim();
}

function firstFamily(value: string): string {
  return value.split(',')[0]?.trim().replace(/^'|'$/gu, '') ?? '';
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry) && !/\.test\.tsx?$/u.test(entry) ? [path] : [];
  });
}


describe('the theme typefaces embedded in the phone apps', () => {
  it('lists exactly the token files under the expo-font plugin', async () => {
    const { default: config } = await import('../../app.config');
    const fontPlugins = (config.plugins ?? []).filter((plugin) => (
      plugin === 'expo-font' || (Array.isArray(plugin) && plugin[0] === 'expo-font')
    ));
    const families = [...new Set(fontFiles.map((file) => file.typeface))];
    expect(fontPlugins).toEqual([['expo-font', {
      ios: { fonts: fontFiles.map((file) => file.path) },
      android: {
        fonts: [
          ...families.map((family) => ({
            fontFamily: family,
            fontDefinitions: fontFiles
              .filter((file) => file.typeface === family)
              .map((file) => ({ path: file.path, weight: Number(file.weight) })),
          })),
          // One single-face family per in-between weight, for Android before API 28.
          ...Object.entries(androidSingleFaceFamilies).map(([weight, family]) => ({
            fontFamily: family,
            fontDefinitions: fontFiles
              .filter((file) => file.typeface === 'Public Sans' && file.weight === weight)
              .map((file) => ({ path: file.path, weight: Number(file.weight) })),
          })),
        ],
      },
    }]]);
  });

  it('names a single-face family for Medium and SemiBold on Android before API 28 only', () => {
    // React Native's ReactFontManager keeps only NORMAL and BOLD below API 28,
    // so a family-plus-weight 500 or 600 would draw Regular there (#8953 r2s1).
    expect(resolveTypography('ios', '27.0')).toBe(typography);
    expect(resolveTypography('android', 28)).toBe(typography);
    expect(resolveTypography('android', 36)).toBe(typography);
    for (const version of [24, 27, '27']) {
      const old = resolveTypography('android', version);
      expect(old.bodyMedium).toEqual({ fontFamily: 'Public Sans Medium', fontWeight: '500' });
      expect(old.control).toEqual({ fontFamily: 'Public Sans SemiBold', fontWeight: '600' });
      // Regular and Bold resolve through NORMAL and BOLD; Archivo has one face.
      const unchanged: readonly TypographyRole[] = ['heading', 'name', 'body', 'controlStrong'];
      for (const role of unchanged) expect(old[role]).toBe(typography[role]);
    }
    for (const [weight, family] of Object.entries(androidSingleFaceFamilies)) {
      expect(fontFiles.some((file) => file.typeface === 'Public Sans' && file.weight === (weight as EmbeddedWeight)), family).toBe(true);
    }
  });

  it.each(fontFiles.map((file): [string, FontFile] => [file.postScriptName, file]))(
    '%s is a static TrueType file whose names and weight match its token',
    (postScriptName, file) => {
      expect(basename(file.path)).toBe(`${postScriptName}.ttf`);
      const facts = readSfnt(readFileSync(mobileFile(file.path)));
      expect(facts.version).toBe(0x00010000);
      expect(facts.tables).toContain('glyf');
      expect(facts.tables).not.toContain('fvar');
      expect(facts.postScriptName).toBe(postScriptName);
      // iOS files a face under its typographic family name (name 16), or its
      // family name (name 1) when it has none; Android's XML family uses the
      // same string, so one style name draws on both.
      expect(facts.typographicFamily || facts.familyNames[0]).toBe(file.typeface);
      expect(facts.weightClass).toBe(Number(file.weight));
      expect(facts.fsType).toBe(0);
    },
  );

  it('keeps the upstream licence and the provenance note beside the files', () => {
    const present = readdirSync(fontsDir);
    expect(present.filter((entry) => entry.endsWith('.ttf')).sort())
      .toEqual(fontFiles.map((file) => basename(file.path)).sort());
    const licences: readonly (readonly [string, string])[] = [
      ['OFL-Archivo.txt', 'Copyright 2020 The Archivo Project Authors'],
      ['OFL-PublicSans.txt', 'Copyright 2015 The Public Sans Project Authors'],
    ];
    for (const [licence, holder] of licences) {
      const text = readFileSync(new URL(licence, fontsDir), 'utf8');
      expect(text).toContain(holder);
      expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    }
    const note = readFileSync(new URL('README.md', fontsDir), 'utf8');
    for (const file of fontFiles) {
      const bytes = statSync(mobileFile(file.path)).size;
      expect(note).toContain(`\`${basename(file.path)}\` (weight ${file.weight}), ${bytes.toLocaleString('en-US')} bytes.`);
    }
  });

  it('follows the theme: Archivo 800 for headings and the name, Public Sans for text and controls', () => {
    const css = readFileSync(new URL('src/sg-tokens.css', repoRoot), 'utf8');
    const display = firstFamily(cssVariable(css, '--sg-font-family-display'));
    const body = firstFamily(cssVariable(css, '--sg-font-family-body'));
    const weight = (name: string) => cssVariable(css, `--sg-font-weight-${name}`).split(/\s/u)[0] ?? '';
    const expected: Record<TypographyRole, { fontFamily: string; fontWeight: string }> = {
      heading: { fontFamily: display, fontWeight: weight('extrabold') },
      name: { fontFamily: display, fontWeight: weight('extrabold') },
      body: { fontFamily: body, fontWeight: weight('regular') },
      bodyMedium: { fontFamily: body, fontWeight: weight('medium') },
      control: { fontFamily: body, fontWeight: weight('semibold') },
      controlStrong: { fontFamily: body, fontWeight: weight('bold') },
    };
    expect(display).toBe('Archivo');
    expect(body).toBe('Public Sans');
    for (const [role, style] of Object.entries(typography)) {
      expect(style).toEqual(expected[role as TypographyRole]);
      // Every role asks for a face that is embedded, never one a platform
      // would have to choose a neighbour for or synthesise.
      expect(fontFiles.some((file) => file.typeface === style.fontFamily && file.weight === style.fontWeight)).toBe(true);
    }
    expect(new Set(Object.values(typography).map((style) => `${style.fontFamily} ${style.fontWeight}`)))
      .toEqual(new Set(fontFiles.map((file) => `${file.typeface} ${file.weight}`)));
  });

  it('keeps each word-fit allowance above the faces it covers, with room to spare', () => {
    // The largest-text word fit (src/lib/wordFit.ts) assumes no word averages
    // more than its face's allowance a letter: Body fits Public Sans and
    // Heading fits Archivo. These words are from the app and the fit's own
    // cases; "messages" is the widest a letter in Archivo ExtraBold.
    const words = ['membership', 'messages', 'Transportation', 'representation', 'investigation', 'Recruited', 'meetings'];
    for (const file of fontFiles) {
      const bytes = readFileSync(mobileFile(file.path));
      const allowance = WORD_FIT_GLYPH_EM[file.typeface === 'Archivo' ? 'heading' : 'body'];
      for (const word of words) {
        expect(wordEms(bytes, word) / word.length, `${file.postScriptName} ${word}`)
          .toBeLessThanOrEqual(allowance * 0.95);
      }
    }
    // All-capitals labels are Public Sans Bold; their allowance covers the caps.
    const capsWords = ['ANNOUNCEMENT', 'MEMBERSHIP', 'GRIEVANCE', 'ANNOUNCEMENTS'];
    const bold = readFileSync(mobileFile('./fonts/PublicSans-Bold.ttf'));
    for (const word of capsWords) {
      expect(wordEms(bold, word) / word.length, `caps ${word}`).toBeLessThanOrEqual(WORD_FIT_GLYPH_EM.caps * 0.9);
    }
    // The parser reads real advances: "membership" is 6.28 em in Archivo ExtraBold.
    expect(wordEms(readFileSync(mobileFile('./fonts/Archivo-ExtraBold.ttf')), 'membership')).toBeCloseTo(6.28, 2);
  });

  it('draws the shared text primitives from the roles, not from their own font names', () => {
    const styleLine = (path: string, name: string): string => {
      const source = readFileSync(new URL(path, mobileRoot), 'utf8');
      const line = source.split('\n').find((text) => text.startsWith(`  ${name}: {`));
      if (!line) throw new Error(`${path} has no ${name} style`);
      return line;
    };
    const primitives: readonly (readonly [string, string, TypographyRole])[] = [
      ['src/components/ui.tsx', 'heading1', 'heading'],
      ['src/components/ui.tsx', 'heading2', 'heading'],
      ['src/components/ui.tsx', 'heading3', 'heading'],
      ['src/components/ui.tsx', 'body', 'body'],
      ['src/components/ui.tsx', 'buttonText', 'control'],
      ['src/components/PinnedHeader.tsx', 'title', 'heading'],
    ];
    for (const [path, name, role] of primitives) {
      const line = styleLine(path, name);
      // Through resolveTypography, so old Android gets its single-face families.
      expect(line, `${path} ${name}`).toMatch(new RegExp(`\\{ \\.\\.\\.typeface\\.${role},`, 'u'));
      expect(line, `${path} ${name}`).not.toMatch(/fontFamily|fontWeight/u);
    }
  });

  it('keeps Georgia where a design already set it and adds it nowhere else', () => {
    const root = new URL('.', mobileRoot).pathname;
    const users = [...sourceFiles(join(root, 'app')), ...sourceFiles(join(root, 'src'))]
      .filter((path) => /fontFamily[^\n]*Georgia|'Georgia'/u.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(root.length))
      .sort();
    // This edition's Home greeting has used a serif face since its own design.
    expect(users).toEqual([
      'app/(tabs)/home.tsx',
      'app/notifications.tsx',
      'app/sign-in.tsx',
      'src/features/learning/LearningItemView.tsx',
    ]);
  });
});
