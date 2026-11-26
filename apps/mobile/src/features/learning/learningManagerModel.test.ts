import { describe, expect, it } from 'vitest';

import {
  defaultLearningWindowInput,
  formatLearningMoment,
  learningPolicyDraft,
  learningPolicyDraftChanged,
  learningProvenanceEntries,
  learningSelectionForSave,
  learningSelectionOutside,
  learningSelectionOverLimit,
  learningSnapshotTitle,
  learningStatusState,
  parseLearningWindowInput,
  toggleLearningSelection,
  type LearningPolicyDraft,
} from './learningManagerModel';
import { normalizeLearningItem, type LearningItem, type LearningScopePolicy } from '../../lib/learningContentModel';

const A = 'a1b2c3d4-0000-4000-8000-00000000000a';
const B = 'a1b2c3d4-0000-4000-8000-00000000000b';
const scopePolicy = (selectedIds: string[] | null, patch: Partial<LearningScopePolicy> = {}): LearningScopePolicy => ({ quotesEnabled: true, lessonsEnabled: true, selectedIds, revision: 1, ...patch });

function item(id: string): LearningItem {
  const normalized = normalizeLearningItem({ id, scope: 'organization', organization_id: 'org-a', chapter_id: null, kind: 'quote', locale: 'en', locale_state: 'reviewed', title: 'T', body: 'B', audience: 'all', status: 'published', starts_at: '2026-09-01T00:00:00Z', priority: 0, revision: 1 });
  if (!normalized) throw new Error('fixture did not normalize');
  return normalized;
}

describe('switch and selection drafts', () => {
  it('reads null as inherit-all, [] as none and a list as only-selected', () => {
    expect(learningPolicyDraft(scopePolicy(null))).toMatchObject({ mode: 'all', selected: [] });
    expect(learningPolicyDraft(scopePolicy([]))).toMatchObject({ mode: 'none', selected: [] });
    expect(learningPolicyDraft(scopePolicy([A]))).toMatchObject({ mode: 'some', selected: [A] });
  });

  it('sends null, [] or the de-duplicated ids, and never a platform selection', () => {
    const draft: LearningPolicyDraft = { quotes: true, lessons: false, mode: 'some', selected: [A, A, B] };
    expect(learningSelectionForSave('chapter', draft)).toEqual([A, B]);
    expect(learningSelectionForSave('organization', { ...draft, mode: 'none' })).toEqual([]);
    expect(learningSelectionForSave('organization', { ...draft, mode: 'all' })).toBeNull();
    expect(learningSelectionForSave('platform', draft)).toBeNull();
  });

  it('knows when the draft differs from what the server saved', () => {
    const saved = scopePolicy([A, B]);
    expect(learningPolicyDraftChanged('chapter', learningPolicyDraft(saved), saved)).toBe(false);
    expect(learningPolicyDraftChanged('chapter', { ...learningPolicyDraft(saved), selected: [B, A] }, saved)).toBe(false);
    expect(learningPolicyDraftChanged('chapter', { ...learningPolicyDraft(saved), quotes: false }, saved)).toBe(true);
    expect(learningPolicyDraftChanged('chapter', { ...learningPolicyDraft(saved), mode: 'all' }, saved)).toBe(true);
    expect(learningPolicyDraftChanged('platform', { quotes: true, lessons: true, mode: 'some', selected: [A] }, scopePolicy(null))).toBe(false);
  });

  it('bounds the selection at 500 and counts selected items not listed', () => {
    const many = Array.from({ length: 501 }, (_, index) => `id-${index}`);
    expect(learningSelectionOverLimit({ quotes: true, lessons: true, mode: 'some', selected: many })).toBe(true);
    expect(learningSelectionOverLimit({ quotes: true, lessons: true, mode: 'some', selected: many.slice(1) })).toBe(false);
    expect(toggleLearningSelection([A], B)).toEqual([A, B]);
    expect(toggleLearningSelection([A, B], A)).toEqual([B]);
    expect(learningSelectionOutside([A, B, B], [item(A)])).toBe(1);
  });
});

describe('publication input', () => {
  it('opens a schedule on tomorrow at 9:00 local time', () => {
    expect(defaultLearningWindowInput(new Date(2026, 11, 31, 22, 0))).toEqual({ startDate: '2027-01-01', startTime: '09:00', endDate: '', endTime: '' });
  });

  it('needs a start only for a schedule and both halves of any end', () => {
    const input = { startDate: '2026-10-01', startTime: '09:00', endDate: '', endTime: '' };
    expect(parseLearningWindowInput('schedule', input)).toMatchObject({ ok: true, endsAt: null });
    expect(parseLearningWindowInput('schedule', { ...input, startTime: '' })).toEqual({ ok: false, field: 'starts_at' });
    expect(parseLearningWindowInput('publish', { ...input, startDate: 'never' })).toEqual({ ok: true, startsAt: null, endsAt: null });
    expect(parseLearningWindowInput('publish', { ...input, endDate: '2026-10-02' })).toEqual({ ok: false, field: 'ends_at' });
    expect(parseLearningWindowInput('withdraw', { ...input, endDate: 'x', endTime: 'y' })).toEqual({ ok: true, startsAt: null, endsAt: null });
  });
});

describe('presentation', () => {
  it('maps every status onto the shared status ramp', () => {
    expect(['draft', 'published', 'scheduled', 'withdrawn'].map((status) => learningStatusState(status as LearningItem['status']))).toEqual(['attention', 'active', 'queued', 'done']);
  });

  it('formats server microsecond timestamps in the worker language', () => {
    expect(formatLearningMoment('2026-09-28T23:30:00.123456+00:00', 'en')).toMatch(/2026/);
    expect(formatLearningMoment('2026-09-28T23:30:00.123456+00:00', 'en')).not.toContain('123456');
    expect(formatLearningMoment('not a time', 'es')).toBe('not a time');
  });

  it('reads a history snapshot title only when it is text', () => {
    expect(learningSnapshotTitle({ title: 'Showing up' })).toBe('Showing up');
    expect(learningSnapshotTitle({ title: 7 })).toBe('');
    expect(learningSnapshotTitle(null)).toBe('');
  });
});

describe('provenance for reviewers', () => {
  it('lists plain values only, bounded in count and length', () => {
    const long = 'é'.repeat(400);
    const entries = learningProvenanceEntries({ donor_path: 'lib/knowledge/seed.ts', recovery_note: long, donor_sha: null, nested: { a: 1 }, revision: 1, verified: false });
    expect(entries.map(([key]) => key)).toEqual(['donor_path', 'recovery_note', 'revision', 'verified']);
    expect(Array.from(entries[1]?.[1] ?? '').length).toBe(300);
    expect(learningProvenanceEntries(Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, 'v'])))).toHaveLength(12);
    expect(learningProvenanceEntries(null)).toEqual([]);
  });
});
