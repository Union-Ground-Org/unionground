import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import * as shared from '../../../../src/features/learningContent/model.js';
import {
  LEARNING_EDITABLE_FIELDS,
  LEARNING_LIMITS,
  emptyLearningDraftForm,
  learningDraftFormChanged,
  learningDraftFormFromItem,
  learningDraftFormIssues,
  learningDraftFormPayload,
  learningNextStoreKey,
  learningPublicationIssues,
  msUntilNextLocalDay,
  normalizeLearningItem,
  parseLearningLocalDateTime,
  planLearningHomeLoad,
  validateLearningItem,
  type LearningDraftForm,
  type LearningItem,
  type LearningPolicy,
} from './learningContentModel';

const policy = (patch: Partial<LearningPolicy> = {}): LearningPolicy => ({
  organizationId: 'org-a',
  chapterId: 'chapter-a',
  quotesEnabled: true,
  lessonsEnabled: true,
  homeHidden: false,
  canManage: false,
  isPlatformOwner: false,
  version: '1:0:0:false',
  ...patch,
});

function form(patch: Partial<LearningDraftForm> = {}): LearningDraftForm {
  return { ...emptyLearningDraftForm('quote', 'en', 'chapter'), title: 'Showing up', body: 'Solidarity is a practice.', ...patch };
}

function item(patch: Record<string, unknown> = {}): LearningItem {
  const normalized = normalizeLearningItem({
    id: 'a1b2c3d4-0000-4000-8000-000000000001', scope: 'chapter', organization_id: 'org-a', chapter_id: 'chapter-a',
    kind: 'mini_lesson', locale: 'es', locale_state: 'reviewed', title: 'Un registro', body: 'Escríbelo el mismo día.',
    attribution: '', source: 'Guía de la campaña', rights_note: 'Propio', review_note: 'Revisado', bullets: ['Fecha'], direction: '',
    topics: [], audience: 'all', tone: '', learning_outcome: '', factual_claims: true, priority: 3, is_default: false,
    status: 'published', starts_at: '2026-09-28T23:30:00.123456+00:00', ends_at: null, revision: 4, provenance: {}, ...patch,
  });
  if (!normalized) throw new Error('fixture did not normalize');
  return normalized;
}

describe('native learning model is the shared contract', () => {
  it('re-exports the shared validators and limits rather than a native copy', () => {
    expect(validateLearningItem).toBe(shared.validateLearningItem);
    expect(learningPublicationIssues).toBe(shared.learningPublicationIssues);
    expect(normalizeLearningItem).toBe(shared.normalizeLearningItem);
    expect(LEARNING_LIMITS).toBe(shared.LEARNING_LIMITS);
    expect(LEARNING_LIMITS).toMatchObject({
      title: 100, body: { quote: 500, mini_lesson: 2000 }, bulletCount: 5, bullet: 200, topicCount: 5, topic: 80,
      attribution: 200, source: 1000, rights_note: 1000, review_note: 1000, direction: 1000, tone: 100, learning_outcome: 500,
      priorityMin: 0, priorityMax: 100, payloadBytes: 64000, selectedIds: 500,
    });
  });

  it('parses server microsecond timestamps without the JavaScript engine date parser', () => {
    // Hermes may refuse "+00:00" with six fractional digits; the shared parser
    // does not, so a published row is never dropped on a phone.
    expect(item().starts_at).toBe('2026-09-28T23:30:00.123456+00:00');
    expect(shared.isLearningItemLive(item(), Date.UTC(2026, 8, 29))).toBe(true);
  });
});

describe('editor form limits (Unicode code points, trimmed)', () => {
  it.each([
    ['title', LEARNING_LIMITS.title],
    ['attribution', LEARNING_LIMITS.attribution],
    ['source', LEARNING_LIMITS.source],
    ['rights_note', LEARNING_LIMITS.rights_note],
    ['review_note', LEARNING_LIMITS.review_note],
    ['direction', LEARNING_LIMITS.direction],
    ['tone', LEARNING_LIMITS.tone],
    ['learning_outcome', LEARNING_LIMITS.learning_outcome],
  ] as [keyof LearningDraftForm, number][])('%s accepts %i code points and refuses one more', (field, limit) => {
    const atLimit = '😀'.repeat(limit);
    expect(learningDraftFormIssues(form({ [field]: atLimit }))).toEqual([]);
    expect(learningDraftFormIssues(form({ [field]: `${atLimit}ñ` }))).toContainEqual(expect.objectContaining({ field, code: 'too_long', limit }));
  });

  it('bounds the body by kind: 500 for a quote, 2000 for a mini-lesson', () => {
    expect(learningDraftFormIssues(form({ body: 'á'.repeat(500) }))).toEqual([]);
    expect(learningDraftFormIssues(form({ body: 'á'.repeat(501) }))).toContainEqual(expect.objectContaining({ field: 'body', code: 'too_long', limit: 500 }));
    const lesson = emptyLearningDraftForm('mini_lesson', 'es', 'chapter');
    expect(learningDraftFormIssues({ ...lesson, title: 'Lección', body: 'é'.repeat(2000) })).toEqual([]);
    expect(learningDraftFormIssues({ ...lesson, title: 'Lección', body: 'é'.repeat(2001) })).toContainEqual(expect.objectContaining({ field: 'body', code: 'too_long', limit: 2000 }));
  });

  it('requires a non-blank title and body', () => {
    expect(learningDraftFormIssues(form({ title: '   ', body: '\n' }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'title', code: 'required' }),
      expect.objectContaining({ field: 'body', code: 'required' }),
    ]));
  });

  it('allows up to five non-empty bullets and topics within their entry limits', () => {
    const five = ['a', 'b', 'c', 'd', 'e'];
    expect(learningDraftFormIssues(form({ bullets: five, topics: five }))).toEqual([]);
    expect(learningDraftFormIssues(form({ bullets: [...five, 'f'] }))).toContainEqual(expect.objectContaining({ field: 'bullets', code: 'too_many', limit: 5 }));
    expect(learningDraftFormIssues(form({ topics: ['ok', '  '] }))).toContainEqual(expect.objectContaining({ field: 'topics', code: 'empty_entry', index: 1 }));
    expect(learningDraftFormIssues(form({ bullets: ['x'.repeat(200)] }))).toEqual([]);
    expect(learningDraftFormIssues(form({ bullets: ['x'.repeat(201)] }))).toContainEqual(expect.objectContaining({ field: 'bullets', code: 'entry_too_long', index: 0, limit: 200 }));
    expect(learningDraftFormIssues(form({ topics: ['t'.repeat(81)] }))).toContainEqual(expect.objectContaining({ field: 'topics', code: 'entry_too_long', index: 0, limit: 80 }));
  });

  it('treats the typed priority as a whole number from 0 to 100', () => {
    for (const valid of ['0', '42', '100']) expect(learningDraftFormIssues(form({ priority: valid }))).toEqual([]);
    for (const invalid of ['', '101', '-1', '4.5', 'ten']) {
      expect(learningDraftFormIssues(form({ priority: invalid }))).toContainEqual(expect.objectContaining({ field: 'priority', code: 'out_of_range' }));
    }
  });

  it('refuses a default flag outside the platform scope', () => {
    expect(learningDraftFormIssues(form({ is_default: true }))).toContainEqual({ field: 'is_default', code: 'platform_only' });
    expect(learningDraftFormIssues(form({ is_default: true, scope: 'platform' }))).toEqual([]);
  });

  it('accepts every field at its maximum with four-byte characters (the 64,000-byte ceiling)', () => {
    const wide = '𝄞'; // four UTF-8 bytes, one code point
    const full: LearningDraftForm = {
      ...emptyLearningDraftForm('mini_lesson', 'es', 'platform'),
      title: wide.repeat(100), body: wide.repeat(2000), attribution: wide.repeat(200), source: wide.repeat(1000),
      rights_note: wide.repeat(1000), review_note: wide.repeat(1000), direction: wide.repeat(1000), tone: wide.repeat(100),
      learning_outcome: wide.repeat(500), bullets: Array.from({ length: 5 }, () => wide.repeat(200)),
      topics: Array.from({ length: 5 }, () => wide.repeat(80)), priority: '100', is_default: true, locale_state: 'reviewed',
    };
    expect(learningDraftFormIssues(full)).toEqual([]);
    expect(shared.learningPayloadBytes(learningDraftFormPayload(full))).toBeLessThanOrEqual(LEARNING_LIMITS.payloadBytes);
  });
});

describe('editor form payload', () => {
  it('sends exactly the eighteen editable keys, trimmed, and the id only when updating', () => {
    const created = learningDraftFormPayload(form({ title: '  Showing up  ', bullets: [' one '], priority: ' 7 ' }));
    expect(Object.keys(created).sort()).toEqual([...LEARNING_EDITABLE_FIELDS].sort());
    expect(created).toMatchObject({ title: 'Showing up', bullets: ['one'], priority: 7 });
    const updated = learningDraftFormPayload(learningDraftFormFromItem(item()));
    expect(Object.keys(updated).sort()).toEqual(['id', ...LEARNING_EDITABLE_FIELDS].sort());
    expect(updated).not.toHaveProperty('revision');
    expect(updated).not.toHaveProperty('scope');
    expect(updated).not.toHaveProperty('status');
  });

  it('keeps the revision and scope a save must present and detects edits on the built payload', () => {
    const baseline = learningDraftFormFromItem(item());
    expect(baseline).toMatchObject({ id: item().id, revision: 4, scope: 'chapter', priority: '3', locale: 'es' });
    expect(learningDraftFormChanged(baseline, baseline)).toBe(false);
    expect(learningDraftFormChanged({ ...baseline, title: 'Un registro ' }, baseline)).toBe(false);
    expect(learningDraftFormChanged({ ...baseline, title: 'Otro' }, baseline)).toBe(true);
  });

  it('starts a mini-lesson with factual claims on and a quote with them off', () => {
    expect(emptyLearningDraftForm('mini_lesson', 'en', 'chapter').factual_claims).toBe(true);
    expect(emptyLearningDraftForm('quote', 'en', 'chapter').factual_claims).toBe(false);
  });
});

describe('publication rules', () => {
  it('needs a reviewed locale, rights and review notes, and a source for attributed or factual items', () => {
    const draft = item({ locale_state: 'draft', rights_note: '', review_note: '', source: '' });
    expect(learningPublicationIssues(draft)).toEqual(expect.arrayContaining([
      { field: 'locale_state', code: 'not_reviewed' },
      { field: 'rights_note', code: 'required' },
      { field: 'review_note', code: 'required' },
      { field: 'source', code: 'required' },
    ]));
    expect(learningPublicationIssues(item({ factual_claims: false, attribution: '', source: '' }))).toEqual([]);
    expect(learningPublicationIssues(item({ kind: 'quote', factual_claims: false, attribution: 'Dana', source: '' }))).toContainEqual({ field: 'source', code: 'required' });
  });
});

describe('Next storage key', () => {
  const scope = { userId: 'user-a', organizationId: 'org-a', chapterId: 'chapter-a', locale: 'en' };

  it('is a Keychain/Keystore-safe key scoped by user, organization, campaign and locale', () => {
    const key = learningNextStoreKey(scope);
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(learningNextStoreKey({ ...scope })).toBe(key);
    for (const change of [{ userId: 'user-b' }, { organizationId: 'org-b' }, { chapterId: 'chapter-b' }, { locale: 'es' }]) {
      expect(learningNextStoreKey({ ...scope, ...change })).not.toBe(key);
    }
  });
});

describe('typed schedule input', () => {
  it('parses a device-local date and 24-hour time strictly', () => {
    expect(parseLearningLocalDateTime('2026-10-01', '09:30')?.getTime()).toBe(new Date(2026, 9, 1, 9, 30).getTime());
    expect(parseLearningLocalDateTime(' 2026-10-01 ', '9:05')?.getMinutes()).toBe(5);
    for (const [date, time] of [['2026-02-31', '09:00'], ['2026-13-01', '09:00'], ['2026-10-01', '24:00'], ['10/01/2026', '09:00'], ['2026-10-01', '9am'], ['', '']]) {
      expect(parseLearningLocalDateTime(date ?? '', time ?? '')).toBeNull();
    }
  });

  it('counts down to the next local midnight', () => {
    expect(msUntilNextLocalDay(new Date(2026, 8, 28, 23, 59, 0))).toBe(60_000);
    expect(msUntilNextLocalDay(new Date(2026, 8, 28, 23, 59, 59, 900))).toBe(1_000);
  });
});

describe('Home load plan', () => {
  const fresh = { version: null, signature: null, loaded: false };

  it('reads nothing for a hidden Home or when both modules are off', () => {
    expect(planLearningHomeLoad(fresh, policy({ homeHidden: true }))).toMatchObject({ clear: true, load: false });
    expect(planLearningHomeLoad(fresh, policy({ quotesEnabled: false, lessonsEnabled: false }))).toMatchObject({ clear: true, load: false });
  });

  it('reads only the enabled kinds: both at once, or one kind', () => {
    expect(planLearningHomeLoad(fresh, policy())).toMatchObject({ load: true, kind: null });
    expect(planLearningHomeLoad(fresh, policy({ lessonsEnabled: false }))).toMatchObject({ load: true, kind: 'quote' });
    expect(planLearningHomeLoad(fresh, policy({ quotesEnabled: false }))).toMatchObject({ load: true, kind: 'mini_lesson' });
  });

  it('keeps the cache for an unchanged policy and invalidates it on a new version or switch', () => {
    const loaded = planLearningHomeLoad(fresh, policy());
    const cached = { version: '1:0:0:false', signature: loaded.signature, loaded: true };
    expect(planLearningHomeLoad(cached, policy())).toEqual({ clear: false, load: false, kind: null, signature: loaded.signature });
    expect(planLearningHomeLoad(cached, policy({ version: '2:0:0:false' }))).toMatchObject({ clear: true, load: true });
    expect(planLearningHomeLoad(cached, policy({ quotesEnabled: false }))).toMatchObject({ clear: true, load: true, kind: 'mini_lesson' });
  });
});

it('refuses a spring-forward schedule in the actual Eastern time zone', () => {
  const moduleUrl = new URL('./learningContentModel.ts', import.meta.url).href;
  const code = 'import {parseLearningLocalDateTime as parse} from '+JSON.stringify(moduleUrl)+'; console.log(JSON.stringify([parse("2027-03-14","02:30"),parse("2027-03-14","03:30")?.getHours()]));';
  const observed = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: {...process.env,TZ:'America/New_York'}, encoding:'utf8' });
  expect(JSON.parse(observed)).toEqual([null,3]);
});
