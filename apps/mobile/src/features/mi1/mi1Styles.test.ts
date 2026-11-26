import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');

// mi1Styles is a shared sheet: a key survives only while an importing MI1
// screen reads it, so a dead style cannot sit beside the live ones.
describe('mi1Styles shared keys', () => {
  it('exposes only keys that an importing MI1 screen references', () => {
    const body = read('mi1Styles.ts').match(/StyleSheet\.create\(\{([\s\S]*)\}\);/)?.[1] ?? '';
    const keys = [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(0);

    const importers = readdirSync(dir)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => {
        const source = read(name);
        const binding = source.match(/import\s*\{\s*mi1Styles(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*\}\s*from\s*'\.\/mi1Styles'/);
        return binding ? { source, alias: binding[1] ?? 'mi1Styles' } : null;
      })
      .filter((entry): entry is { source: string; alias: string } => entry !== null);
    expect(importers.length).toBeGreaterThan(0);

    const unused = keys.filter((key) => !importers.some(({ source, alias }) => new RegExp(`\\b${alias}\\.${key}\\b`).test(source)));
    expect(unused).toEqual([]);
  });
});
