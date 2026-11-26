import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// BUG-UG-CASE-PRIVACY-COPY-MISSTATES-READERS-20261106 (#7194). The
// member's case screen used to say "Private by design" while, by default, every
// steward in the chapter's grievance scope can read the case, its notes and its
// documents. The mobile lane has no React renderer, so the card is pinned by
// source.

const caseScreen = readFileSync(fileURLToPath(new URL('../../app/issue/[id].tsx', import.meta.url)), 'utf8');

describe('native issue privacy card', () => {
  it('no longer calls the issue private by design', () => {
    expect(caseScreen).not.toContain('Private by design');
  });
});
