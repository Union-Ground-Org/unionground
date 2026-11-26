// Identifiers the function-test bot reads. The
// shared Card and Heading pass a testID to the native view and text, and the
// demo switcher names the signed-in persona from the session. They are testIDs
// only: nothing a person sees or hears changes. The request rows themselves
// are checked in memberSupportNative.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('automation identifiers', () => {
  it('passes a testID through Card and Heading to the native view and text', () => {
    const ui = read('../components/ui.tsx');
    const card = ui.slice(ui.indexOf('export function Card('), ui.indexOf('export function Heading('));
    const heading = ui.slice(ui.indexOf('export function Heading('), ui.indexOf('export function Heading(') + 2000);
    expect(card).toMatch(/<Animated\.View\s+testID=\{testID\}/);
    expect(heading).toMatch(/<Text\s+testID=\{testID\}/);
  });

  it('names the signed-in persona on the switcher from the session, never from on-screen text', () => {
    const switcher = read('../components/HatSwitcher.tsx');
    expect(switcher).toContain("const activeHat = mode === 'preview' ? previewHat : sampleHat;");
    expect(switcher).toContain('testID={`demo-signed-in-${activeHat}`}');
    expect(switcher).not.toMatch(/testID=\{`demo-signed-in-\$\{current/);
  });
});
