import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ createCapturedSessionRpcClient: vi.fn() }));

import { emptyLearningDraftForm, isLearningItemLive, learningDraftFormFromItem } from '../lib/learningContentModel';
import { createLearningContentApi, learningFailureKind } from '../services/learningContent';
import { createPreviewLearningRpcClient, createPreviewLearningStore } from './learningContentPreview';
import { readLearningAdministration } from '../features/learning/learningControllers';

const NOW = new Date(Date.UTC(2026, 8, 29, 14, 0, 0));
const ORG = 'preview-harborview-care-united';

function previewApi(hat: string, store = createPreviewLearningStore(ORG, NOW)) {
  const client = createPreviewLearningRpcClient(store, { userId: `preview-${hat}`, hat, organizationId: ORG, chapterId: 'hbv' }, () => NOW);
  return { store, api: createLearningContentApi(client, () => NOW.getTime()) };
}

describe('PREVIEW learning source', () => {
  it('is fictional and in memory only: every fixture is marked as a preview fixture of the demo organization', () => {
    const store = createPreviewLearningStore(ORG, NOW);
    expect(store.items.length).toBeGreaterThan(6);
    expect(store.items.every((item) => item.id.startsWith('ecececec-ecec-4ece-8ece-') && item.organization_id === ORG && item.scope !== 'platform')).toBe(true);
  });

  it('keeps the published, draft and scheduled mix and pairs every Spanish lesson with an English one', () => {
    const store = createPreviewLearningStore(ORG, NOW);
    const count = (status: string) => store.items.filter((item) => item.status === status).length;
    expect([count('published'), count('draft'), count('scheduled')]).toEqual([10, 1, 1]);
    const titles = (locale: string, kind: string) => store.items.filter((item) => item.locale === locale && item.kind === kind && item.status === 'published').map((item) => item.title);
    expect(titles('en', 'mini_lesson')).toEqual(['Having a first conversation', 'Writing down what you saw', 'Your rights while organizing']);
    expect(titles('es', 'mini_lesson')).toEqual(['Tener una primera conversación', 'Tus derechos al organizarte']);
    expect(titles('es', 'quote')).toEqual(['Presentarse', 'Cuida la lista']);
  });

  it('teaches organizing, not an existing union, and never reaches a legal conclusion', () => {
    const store = createPreviewLearningStore(ORG, NOW);
    const banned = /steward|grievance|chapter|dues|weingarten|worcester|okafor|509|delegad|queja formal|contrato del cap/i;
    for (const item of store.items) {
      const text = [item.title, item.body, item.attribution, item.source, item.rights_note, item.review_note, item.learning_outcome, ...item.bullets].join(' ');
      expect(text, item.title).not.toMatch(banned);
      expect(text, item.title).not.toMatch(/\bULP\b|unfair labor practice|win rate/i);
      if (item.source) expect(item.source, item.title).toMatch(/Harborview Care United|Union Ground/);
    }
  });

  it('delivers reviewed, live content in the requested locale only', async () => {
    const { api } = previewApi('member');
    const english = await api.listContent({ chapterId: 'hbv', locale: 'en', kind: null, offset: 0, limit: 100 });
    const spanish = await api.listContent({ chapterId: 'hbv', locale: 'es', kind: null, offset: 0, limit: 100 });
    expect(english.items.length).toBeGreaterThan(0);
    expect(english.items.every((item) => item.locale === 'en' && isLearningItemLive(item, NOW.getTime()))).toBe(true);
    expect(spanish.items.every((item) => item.locale === 'es')).toBe(true);
    // Delivery rows never carry editorial notes or provenance.
    expect(english.items.every((item) => item.rights_note === '' && item.review_note === '' && item.provenance === null)).toBe(true);
    expect(english.items.some((item) => item.title === 'What happens after cards' || item.title === 'Bargaining a first contract')).toBe(false);
  });

  it('refuses another campaign and the manager to a worker', async () => {
    const { api } = previewApi('member');
    await expect(api.getPolicy('other')).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(api.getWorkspace({ chapterId: 'hbv', scope: 'chapter', offset: 0 })).rejects.toMatchObject({ kind: 'forbidden' });
    expect((await api.getPolicy('hbv')).canManage).toBe(false);
  });

  it('lets an administrator save a draft, publish it, schedule, withdraw, and read the audit history', async () => {
    const { api, store } = previewApi('admin');
    expect((await api.getPolicy('hbv')).canManage).toBe(true);
    const created = await api.saveContent({ chapterId: 'hbv', form: { ...emptyLearningDraftForm('quote', 'es', 'organization'), title: 'Juntos', body: 'Preguntar juntos pesa más.' } });
    expect(created).toMatchObject({ status: 'draft', revision: 1, scope: 'organization' });
    const blocked = await api.transition({ chapterId: 'hbv', id: created.id, action: 'publish', expectedRevision: 1, startsAt: null, endsAt: null }).catch((error: unknown) => error);
    expect(learningFailureKind(blocked)).toBe('invalid');
    const reviewed = await api.saveContent({ chapterId: 'hbv', form: { ...learningDraftFormFromItem(created), locale_state: 'reviewed', rights_note: 'Texto propio', review_note: 'Revisado por el comité' } });
    const published = await api.transition({ chapterId: 'hbv', id: reviewed.id, action: 'publish', expectedRevision: reviewed.revision, startsAt: null, endsAt: null });
    expect(published).toMatchObject({ status: 'published', revision: 3 });
    const scheduled = await api.transition({ chapterId: 'hbv', id: published.id, action: 'schedule', expectedRevision: 3, startsAt: new Date(NOW.getTime() + 3_600_000), endsAt: null });
    const withdrawn = await api.transition({ chapterId: 'hbv', id: scheduled.id, action: 'withdraw', expectedRevision: scheduled.revision, startsAt: null, endsAt: null });
    expect(withdrawn).toMatchObject({ status: 'withdrawn', starts_at: null, ends_at: null });
    const history = await api.getHistory({ chapterId: 'hbv', id: created.id, offset: 0 });
    expect(history.items.map((entry) => entry.action)).toEqual(['withdraw', 'schedule', 'publish', 'save_draft', 'save_draft']);
    const conflict = await api.saveContent({ chapterId: 'hbv', form: { ...learningDraftFormFromItem(reviewed) } }).catch((error: unknown) => error);
    expect(learningFailureKind(conflict)).toBe('conflict');
    expect(store.items.some((item) => item.id === created.id)).toBe(true);
  });

  it('offers reviewed published choices and refuses a selection outside the scope', async () => {
    const { api } = previewApi('vp');
    const choices = await api.listChoices({ chapterId: 'hbv', scope: 'chapter', offset: 0 });
    expect(choices.items.length).toBeGreaterThan(0);
    expect(choices.items.every((item) => item.status === 'published' || item.status === 'scheduled')).toBe(true);
    const first = choices.items[0];
    if (!first) throw new Error('no choice');
    await expect(api.savePolicy({ expectedRevision: (await api.getWorkspace({ chapterId: 'hbv', scope: 'chapter', offset: 0 })).policy.revision ?? 0, chapterId: 'hbv', scope: 'chapter', quotesEnabled: true, lessonsEnabled: false, selectedIds: [first.id] }))
      .resolves.toMatchObject({ lessonsEnabled: false, selectedIds: [first.id] });
    const outside = await api.savePolicy({ expectedRevision: (await api.getWorkspace({ chapterId: 'hbv', scope: 'chapter', offset: 0 })).policy.revision ?? 0, chapterId: 'hbv', scope: 'chapter', quotesEnabled: true, lessonsEnabled: true, selectedIds: ['ecececec-ecec-4ece-8ece-0000000000ff'] }).catch((error: unknown) => error);
    expect(learningFailureKind(outside)).toBe('forbidden');
  });

  it('remembers a hidden Home per worker and changes the policy version with it', async () => {
    const { api, store } = previewApi('member');
    const before = await api.getPolicy('hbv');
    await api.setHomeHidden({ chapterId: 'hbv', hidden: true });
    const hidden = await api.getPolicy('hbv');
    expect(hidden.homeHidden).toBe(true);
    expect(hidden.version).not.toBe(before.version);
    expect((await previewApi('organizer', store).api.getPolicy('hbv')).homeHidden).toBe(false);
  });
});

describe('PREVIEW administration entrance', () => {
  it.each([['member', false], ['organizer', false], ['committee', false], ['advisor', false], ['admin', true], ['vp', true]])(
    'the %s hat sees it: %s',
    async (hat, allowed) => {
      const { api } = previewApi(String(hat));
      expect((await readLearningAdministration({ api, chapterId: 'hbv' })) !== null).toBe(allowed);
    },
  );
});
