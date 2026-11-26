import { describe, expect, it } from 'vitest';

import {
  bindingPillState,
  canShareHandshakeDocument,
  normalizeChapterBinding,
  normalizeHandshakeDocuments,
  normalizeUnionOrganizations,
  retainedDocumentSelection,
  unionOrganizationSearchPattern,
  unionOrganizationSearchable,
} from './chapterLifecycle';

describe('campaign lifecycle shaping', () => {
  it('normalizes an honest binding and never guesses an incomplete row', () => {
    expect(normalizeChapterBinding({
      chapter_id: 'wor',
      union_org_id: 'rcw-12',
      status: 'requested',
      public_note: 'Reviewing charter',
      union_orgs: { name: 'Riverbend Care Workers Local 12' },
    })).toEqual({
      chapterID: 'wor',
      unionOrgID: 'rcw-12',
      organizationName: 'Riverbend Care Workers Local 12',
      status: 'requested',
      publicNote: 'Reviewing charter',
    });
    expect(normalizeChapterBinding({ chapter_id: 'wor', status: 'requested' })).toBeNull();
    expect(normalizeChapterBinding({ chapter_id: 'wor', union_org_id: 'rcw-12', status: 'fabricated' })).toBeNull();
    expect(normalizeChapterBinding(null)).toBeNull();
  });

  it('falls back to the organization id when the embedded name is missing', () => {
    expect(normalizeChapterBinding({
      chapter_id: 'wor', union_org_id: 'rcw-12', status: 'verified', union_orgs: [],
    })?.organizationName).toBe('rcw-12');
  });

  it('normalizes search results with a joined location and drops rows without identity', () => {
    expect(normalizeUnionOrganizations([
      { id: 'a', name: 'Riverbend Care Workers Local 12', city: 'Springfield', state: 'XX', affiliation: 'RCW' },
      { id: '', name: 'Anonymous' },
      { name: 'Missing id' },
    ])).toEqual([{ id: 'a', name: 'Riverbend Care Workers Local 12', location: 'Springfield, XX', affiliation: 'RCW' }]);
  });

  it('keeps only published documents that carry every rendering field', () => {
    expect(normalizeHandshakeDocuments([
      { id: 'd1', title: 'Committee handbook', document_type: 'training', updated_at: '2026-09-01T00:00:00Z' },
      { id: 'd2', title: 'Missing updated at' },
    ])).toEqual([{ id: 'd1', title: 'Committee handbook', documentType: 'training', updatedAt: '2026-09-01T00:00:00Z' }]);
  });

  it('keeps local-number searches aligned with the nationwide catalog and disambiguates local names', () => {
    expect(unionOrganizationSearchable('1')).toBe(true);
    expect(unionOrganizationSearchable('Local 1')).toBe(true);
    expect(unionOrganizationSearchable('Boston')).toBe(true);
    expect(unionOrganizationSearchable('x')).toBe(false);
    expect(normalizeUnionOrganizations([{ id: 'local-a', name: 'Example Workers', local_number: '1', designation: 'Local', city: 'Boston', state: 'MA' }]))
      .toEqual([{ id: 'local-a', name: 'Example Workers · Local 1', location: 'Boston, MA', affiliation: '' }]);
  });

  it('escapes ILIKE wildcards and refuses needles too short to search', () => {
    expect(unionOrganizationSearchPattern('100%_local')).toBe('%100\\%\\_local%');
    // PostgREST turns `*` into `%` and Postgres reads `\` as the LIKE escape.
    expect(unionOrganizationSearchPattern('RCW * Local\\')).toBe('%RCW  Local\\\\%');
    expect(unionOrganizationSearchPattern(' s ')).toBeNull();
    expect(unionOrganizationSearchPattern('')).toBeNull();
  });

  it('maps binding states onto honest pill tones', () => {
    expect(bindingPillState('verified')).toBe('done');
    expect(bindingPillState('rejected')).toBe('attention');
    expect(bindingPillState('requested')).toBe('queued');
  });

  it('offers document sharing only for an active docs-only handshake with a chosen document', () => {
    expect(canShareHandshakeDocument({ status: 'active', dataScope: 'docs_only' }, 'doc-1')).toBe(true);
    expect(canShareHandshakeDocument({ status: 'active', dataScope: 'docs_only' }, '')).toBe(false);
    expect(canShareHandshakeDocument({ status: 'requested', dataScope: 'docs_only' }, 'doc-1')).toBe(false);
    expect(canShareHandshakeDocument({ status: 'active', dataScope: 'aggregate_only' }, 'doc-1')).toBe(false);
  });

  it('retains the chosen document across refresh only while it still exists', () => {
    const documents = normalizeHandshakeDocuments([
      { id: 'd1', title: 'First', document_type: 'policy', updated_at: '2026-09-01T00:00:00Z' },
      { id: 'd2', title: 'Second', document_type: 'policy', updated_at: '2026-09-02T00:00:00Z' },
    ]);
    expect(retainedDocumentSelection(documents, 'd2')).toBe('d2');
    expect(retainedDocumentSelection(documents, 'gone')).toBe('d1');
    expect(retainedDocumentSelection([], 'gone')).toBe('');
  });
});
