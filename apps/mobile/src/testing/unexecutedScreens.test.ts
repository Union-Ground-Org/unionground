import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { screenFiles, testFiles, unexecutedScreens } from '../../scripts/unexecuted-screens.mjs';

// TEST-UG-PHONE-TESTS-EXECUTE-SCREENS-ON-ONE-SHARED-STAND-IN-20261111 (#8319):
// how many phone screen files no test executes (reading source text does not
// count). A ceiling that can only go down: lower it when a screen test lands.
const CEILING = 107;

const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'unexecuted-screens-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('phone screens no test executes', () => {
  it(`stays at or under ${CEILING}`, () => {
    expect(screenFiles().length).toBeGreaterThan(150);
    expect(unexecutedScreens().length).toBeLessThanOrEqual(CEILING);
  });

  it('counts a screen that a test only reads as text, or replaces with vi.mock, as not executed', () => {
    const screen = join(scratch, 'Seeded.tsx');
    writeFileSync(screen, 'export function Seeded() { return null; }\n');
    const textOnly = join(scratch, 'textOnly.test.ts');
    writeFileSync(textOnly, "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('./Seeded.tsx', import.meta.url), 'utf8');\n");
    const mocked = join(scratch, 'mocked.test.tsx');
    writeFileSync(mocked, "vi.mock('./Seeded', () => ({}));\nimport { Seeded } from './Seeded';\nrender(Seeded);\n");
    expect(unexecutedScreens({ screens: [screen], tests: [textOnly, mocked] })).toHaveLength(1);
    const rendered = join(scratch, 'rendered.test.tsx');
    writeFileSync(rendered, "import { Seeded } from './Seeded';\nawait render(Seeded);\n");
    expect(unexecutedScreens({ screens: [screen], tests: [textOnly, mocked, rendered] })).toEqual([]);
  });

  it('reads the phone tests and the root tests that render phone screens', () => {
    expect(testFiles().some((file) => file.endsWith('src/components/ReminderPicker.test.tsx'))).toBe(true);
    expect(unexecutedScreens()).not.toContain('src/components/ReminderPicker.tsx');
  });
});
