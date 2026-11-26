import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { STAFF_HAT_FUNCTIONS } from '../lib/hatFunctions';
import {
  STAFF_DESK_HATS,
  deskPathForHat,
  isSameDeskSection,
  sameDeskSections,
} from './deskJump';

function compactDeskFeature(): string {
  const source = readFileSync(fileURLToPath(new URL('./FeatureScreen.tsx', import.meta.url)), 'utf8');
  const desk = source.slice(source.indexOf('function DeskFeature('), source.indexOf('\nconst styles = StyleSheet.create'));
  return desk.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ');
}

describe('same-desk section rows', () => {
  it('classifies at least one same-desk section on every staff hat', () => {
    for (const hat of STAFF_DESK_HATS) {
      const sections = sameDeskSections(hat, STAFF_HAT_FUNCTIONS[hat]);
      // The steward Work rows that used to stay on the casework desk now open
      // their own screens, so that hat has no leftover same-desk section. The
      // Admin rows that stayed on Chapter admin promised content it lacks; the
      // remaining ones open their own screens too (#7874).
      if (hat === 'steward' || hat === 'admin') {
        expect(sections, `${hat} desk rows open their own screens`).toHaveLength(0);
      } else {
        expect(sections.length, `${hat} must have a same-desk section`).toBeGreaterThan(0);
      }
      for (const section of sections) {
        expect(isSameDeskSection(section, hat)).toBe(true);
        expect(section.href).toBe(deskPathForHat(hat));
      }
      const elsewhere = STAFF_HAT_FUNCTIONS[hat].filter((item) => !isSameDeskSection(item, hat));
      expect(elsewhere.length).toBeGreaterThan(0);
      expect(elsewhere.some((item) => item.key === hat)).toBe(true);
    }
  });

  it('DeskFeature hosts same-desk rows as inert Views and elsewhere rows as PressableScale', () => {
    const desk = compactDeskFeature();
    expect(desk).toContain('const sameDesk = isSameDeskSection(section, expectedHat);');
    expect(desk).toContain('if (sameDesk) { return ( <View key={section.key} accessible accessibilityLabel={count != null ? `${section.label}, ${count}` : section.label} style={[styles.deskSectionRow, divider]} >');
    expect(desk).toContain('{sameDesk ? null : <Ionicons name="chevron-forward"');
    expect(desk).toContain('<PressableScale key={section.key} accessibilityRole="button"');
    expect(desk).toContain('onPress={() => { void haptics.select(); router.push(section.href as never); }}');
    expect(desk).not.toContain('planDeskJump');
    expect(desk).not.toContain('performDeskJump');
    expect(desk).not.toContain('jumpToSection');
    expect(desk).not.toContain('setAccessibilityFocus');
    expect(desk).not.toContain('findNodeHandle');
    expect(desk).not.toContain('sendAccessibilityEvent');
    expect(desk).not.toContain('arrow-down');
    expect(desk).not.toContain('sectionTops');
    expect(desk).not.toContain('sectionNodes');
    expect(desk).not.toMatch(/if \(sameDesk\) \{ return \( <PressableScale/);
    expect(desk).not.toContain('onPress={() => { return;');
  });
});
