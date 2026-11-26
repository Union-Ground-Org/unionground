import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Two pull requests each added
// "Cases": "Casos" to the native Spanish catalogue at different places, git
// merged both cleanly, and JSON.parse keeps the last copy silently, so the
// file declared the key twice with nothing failing. This reads the raw text
// and refuses any key declared more than once, as tests/i18n.test.js does for
// the web catalogue.

/** The keys of a JSON object's top level, in order, duplicates kept. */
function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const literal = text.slice(index, end + 1);
      let next = end + 1;
      while (next < text.length && /\s/.test(text[next] ?? '')) next += 1;
      if (depth === 1 && text[next] === ':') keys.push(JSON.parse(literal) as string);
      index = end + 1;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    index += 1;
  }
  return keys;
}

const duplicates = (keys: string[]) => [...new Set(keys.filter((key, position) => keys.indexOf(key) !== position))];

describe('the native Spanish catalogue file', () => {
  it('declares every key once', () => {
    const raw = readFileSync(new URL('./nativeUiSpanish.json', import.meta.url), 'utf8');
    const keys = topLevelKeys(raw);
    // The scan sees every key the parser keeps, so it is reading the real top level.
    expect(new Set(keys).size).toBe(Object.keys(JSON.parse(raw) as Record<string, string>).length);
    expect(duplicates(keys), 'keys declared more than once in nativeUiSpanish.json').toEqual([]);
  });

  it('finds a key declared twice, and ignores colons and quotes inside values', () => {
    const seeded = '{\n  "Issues": "Casos",\n  "A \\"quoted\\" key": "x: y",\n  "Votes": "Votaciones",\n  "Issues": "Casos"\n}';
    expect(topLevelKeys(seeded)).toEqual(['Issues', 'A "quoted" key', 'Votes', 'Issues']);
    expect(duplicates(topLevelKeys(seeded))).toEqual(['Issues']);
    expect(duplicates(topLevelKeys('{ "a": { "b": 1, "b": 2 }, "c": [ { "a": 1 } ] }'))).toEqual([]);
  });
});
