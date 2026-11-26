// REQ-UG-LOVABLE-NATIVE-SCREENS-BATCH-C-PORT-20261103 (part 3): the
// Batch C legal layout is layout only. The summary leads in an In short card,
// the meta line sits under the title, and Privacy's Key actions card jumps to
// the document's own "Your control" section; no sentence is added.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { LEGAL_DOCUMENTS } from './legalDocuments';

const screen = readFileSync(new URL('../features/LegalDocumentScreen.tsx', import.meta.url), 'utf8');

describe('Batch C legal layout', () => {
  it('puts the meta line under the title, then In short, then Key actions', () => {
    const title = screen.indexOf('<Heading>{document.title}</Heading>');
    const meta = screen.indexOf('<Body muted>{document.notice}</Body>');
    const inShort = screen.indexOf('<Heading level={3}>In short</Heading>');
    const intro = screen.indexOf('<Body>{document.intro}</Body>');
    const actions = screen.indexOf('<Heading level={3}>Key actions</Heading>');
    const jump = screen.indexOf('<JumpCard sections={jumpEntries} onJump={jumpTo} />');
    expect(title).toBeGreaterThan(0);
    expect(meta).toBeGreaterThan(title);
    expect(inShort).toBeGreaterThan(meta);
    expect(intro).toBeGreaterThan(inShort);
    expect(actions).toBeGreaterThan(intro);
    expect(jump).toBeGreaterThan(actions);
  });

  it('adds no outbound link and no new legal sentence', () => {
    expect(screen.match(/Linking\.openURL\(/g)).toHaveLength(2);
    expect(screen).not.toMatch(/business days|within 30 days|under 13|Decision needed/i);
  });
});
