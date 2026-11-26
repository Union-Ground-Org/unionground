import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { presentSearchRow, pressSearchRow, type SearchRowItem } from './searchRowPresentation';

function featureSearchMap(): string {
  const source = readFileSync(fileURLToPath(new URL('./FeatureScreen.tsx', import.meta.url)), 'utf8');
  const search = source.slice(source.indexOf('function SearchFeature()'), source.indexOf('function CasesFeature()'));
  const live = search.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  return live.slice(live.indexOf('results.map((item) => {')).replace(/\s+/g, ' ');
}

const casesRow: SearchRowItem = {
  id: 'c1',
  title: 'GR-2026-014 · Weingarten request',
  body: 'Grievance · Step 2',
  href: '/issue/c1',
};

const hreflessRows: SearchRowItem[] = [
  { id: 'e1', title: 'Campaign meeting', body: 'Tue 7pm · Union Hall' },
  { id: 'f1', title: 'Committee intake', body: 'Submitted' },
  { id: 'r1', title: 'Weingarten rights', body: 'Ask for a committee member before an investigatory interview.' },
  { id: 'b1', title: 'Contract ratification', body: 'Closes Jul 21 · 64% turnout' },
];

describe('presentSearchRow', () => {
  it('makes a issues row pressable with a button role and its destination', () => {
    const row = presentSearchRow(casesRow);
    expect(row.kind).toBe('pressable');
    expect(row.accessibilityRole).toBe('button');
    expect(row.accessibilityLabel).toBe(casesRow.title);
    if (row.kind !== 'pressable') throw new Error('expected pressable');
    expect(row.href).toBe('/issue/c1');
  });

  it.each(hreflessRows)('keeps $title static so VoiceOver can still read the detail', (item) => {
    const row = presentSearchRow(item);
    expect(row.kind).toBe('static');
    expect(row.accessibilityRole).toBeUndefined();
    expect(row.accessibilityLabel).toContain(item.title);
    expect(row.accessibilityLabel).toContain(item.body);
    expect(row.accessibilityLabel).not.toBe(item.title);
  });
});

describe('pressSearchRow', () => {
  it('pushes the issues href and ignores a hrefless row in the same fixture pair', () => {
    const push = vi.fn();
    const cases = presentSearchRow(casesRow);
    const events = presentSearchRow(hreflessRows[0]!);

    pressSearchRow(cases, push);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/issue/c1');

    pressSearchRow(events, push);
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe('SearchFeature hosts the helper directly', () => {
  it('renders the issues row as Pressable and a hrefless row as View, with no extra handler wrapper', () => {
    const map = featureSearchMap();
    expect(map).toContain('const row = presentSearchRow(item);');
    expect(map).toContain("if (row.kind === 'pressable') { return ( <Pressable key={item.id} accessibilityRole={row.accessibilityRole} accessibilityLabel={row.accessibilityLabel} onPress={() => { void haptics.select(); pressSearchRow(row, (href) => { router.push(href as never); }); }} >");
    expect(map).toContain('return ( <View key={item.id} accessible accessibilityRole={row.accessibilityRole} accessibilityLabel={row.accessibilityLabel}>');
    expect(map.match(/<Pressable/g)?.length).toBe(1);
    expect(map).not.toContain('accessibilityRole="button"');
    expect(map).not.toContain('onPress={() => { return;');
  });
});
