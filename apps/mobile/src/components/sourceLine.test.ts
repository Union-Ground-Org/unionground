import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { sourceLineT } from '../../../../src/lib/i18n/sourceLine.js';
import { sourceLineModel } from '../../../../src/lib/sourceLine.js';

// REQ-UG-PROVENANCE-CONTRACT-20261012: the native source line reads
// the same model and register as the web one, without the web catalogue.
const ID = `prov-${'a'.repeat(64)}`;
const record = {
  provenance_id: ID,
  source: { url: 'https://www.mass.gov/dlr/decisions/example', publisher: 'Massachusetts Department of Labor Relations' },
  retrieved_at: '2026-10-12T03:30:00Z',
  content_sha256: 'b'.repeat(64),
  capture: { method: 'http-get' },
  as_of: '2026-03-14',
  review: { status: 'unreviewed' },
};

describe('native SourceLine', () => {
  it('shows the publisher and the Eastern-time retrieval date in both languages', () => {
    const model = sourceLineModel(record, { lang: 'en' });
    expect(model).toMatchObject({ publisher: 'Massachusetts Department of Labor Relations', href: 'https://www.mass.gov/dlr/decisions/example', retrieved: 'Oct 11, 2026', inputs: [] });
    expect(sourceLineT('es', 'sourceLine.retrieved', { date: sourceLineModel(record, { lang: 'es' })?.retrieved })).toBe('consultada el 11 oct 2026');
    expect(sourceLineT('en', 'sourceLine.opensBrowser', { publisher: 'DLR' })).toBe('DLR, opens in your browser');
  });

  it('lists a computed value\'s inputs and refuses an unshowable record', () => {
    const computed = { ...record, provenance_id: `prov-${'c'.repeat(64)}`, capture: { method: 'computed' }, derived_from: [ID, 'example-org/example-data@0123abc:pay.csv'] };
    expect(sourceLineModel(computed, { inputs: [record] })?.inputs.map((input) => input.key)).toEqual([ID, 'example-org/example-data@0123abc:pay.csv']);
    expect(sourceLineModel({ ...record, source: { ...record.source, url: 'javascript:alert(1)' } })).toBeNull();
  });

  it('reaches the sourceLine chunk, never the web catalogue barrel', () => {
    const source = readFileSync(fileURLToPath(new URL('./SourceLine.tsx', import.meta.url)), 'utf8');
    expect(source).toContain("from '../../../../src/lib/i18n/sourceLine.js'");
    expect(source).not.toMatch(/src\/lib\/i18n(?:\.js)?'/);
    expect(source).toContain("accessibilityRole=\"alert\"");
  });
});
