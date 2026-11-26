import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FEATURE_TITLES } from '../lib/featureCatalog';
import { STAFF_HAT_FUNCTIONS } from '../lib/hatFunctions';

const SECTION_KEYS = ['steward-caseload', 'steward-requests', 'steward-forms', 'steward-broadcasts'] as const;

describe('committee member desk destinations', () => {
  it('opens each Work row on a screen whose heading is the row, and opens issue cards', () => {
    const feature = readFileSync(fileURLToPath(new URL('./FeatureScreen.tsx', import.meta.url)), 'utf8');
    const screen = readFileSync(fileURLToPath(new URL('./StewardDeskSectionsScreen.tsx', import.meta.url)), 'utf8');
    for (const key of SECTION_KEYS) {
      const row = STAFF_HAT_FUNCTIONS.steward.find((item) => item.key === key);
      expect(row?.href).toBe(`/feature/${key}`);
      expect(FEATURE_TITLES[key]).toBe(row?.label);
      expect(row?.href).not.toBe('/feature/steward');
    }
    expect(feature).toContain('if (isStewardDeskSectionKey(featureKey)) return <StewardDeskSectionsScreen featureKey={featureKey} />;');
    // Case cards open by their visible text (#7816; CaseRowPressable).
    // #8630: Casework's chapter case cards live on its own screen.
    expect(readFileSync(fileURLToPath(new URL('./LiveFeatureScreens.tsx', import.meta.url)), 'utf8')).toContain('<CaseRowPressable reference={item.reference} visible={[item.status, item.title, item.meta]}');
    expect(feature).toContain('<CaseRowPressable key={item.id} reference={item.reference}');
    expect(screen).toContain('<Heading>{catalogLabel(title)}</Heading>');
    expect(screen).toContain('<CaseRowPressable\n          key={item.id}\n          reference={item.reference}');
    expect(screen).toContain('label="Acknowledge"');
    expect(screen).toContain('label="Close request"');
    expect(screen).toContain('label="Start review"');
    expect(screen).toContain('label="Approve"');
    expect(screen).toContain('label="Return with note"');
    // The Broadcasts composer is shared with Chapter notices (#9099 part 2).
    expect(screen).toContain('<NoticeComposer scope={scope}');
    expect(readFileSync(fileURLToPath(new URL('./NoticeComposer.tsx', import.meta.url)), 'utf8')).toContain("'Send unit notice'");
    expect(screen).toContain('Another committee member reviews it.');
    expect(screen).toContain('label="Load more"');
    expect(screen).toContain('End of the list.');
    expect(screen).toContain('Showing ${shown} of ${total}');
  });
});
