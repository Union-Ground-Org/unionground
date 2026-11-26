// @vitest-environment jsdom
// BUG-UG-MINI-LESSONS-OFF-SECTION-IS-A-DEAD-END-THAT-BLAMES-THE-UNION-20261124
// (#9839): get_learning_policy is platform AND organization AND chapter, so
// "off" can come from a switch nobody in the chapter holds. The iPhone demo
// walk of Nov 24, 2026 found Know your rights > Mini-lessons saying "Your union
// has turned mini-lessons off for this chapter." while the chapter and the
// organization had lessons on. A section a person can never use is not offered;
// a manager keeps the way into the editor, and the sentence blames no one.
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, press, render, type Rendered } from '../../testing/reactNativeStandIn';
import { learningCopy } from '../../lib/learningContentCopy';
import type { LearningLocale, LearningPolicy } from '../../lib/learningContentModel';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'es',
  status: 'disabled' as string,
  policy: null as Record<string, unknown> | null,
}));

vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/ui', () => import('../../testing/uiStandIn'));
vi.mock('../../components/Text', async () => ({ Text: (await import('../../testing/reactNativeStandIn')).Text }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ cardForeground: '#000', destructive: '#a00', secondaryForeground: '#000' }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('./LearningControls', () => ({ LearningLinkButton: () => null }));
vi.mock('./LearningItemView', () => ({ LearningItemView: () => null }));
vi.mock('./useLearningContent', async () => {
  const { learningCopy: copyFor } = await import('../../lib/learningContentCopy');
  return {
    useLearningCopy: () => copyFor(state.locale as LearningLocale),
    useLearningLibrary: () => ({
      scope: { chapterId: 'chapter-a', organizationId: 'org-a', locale: state.locale },
      controller: { lessons: () => [], loadMore: async () => {}, refreshPolicy: async () => {}, restoreHome: async () => {} },
      snapshot: {
        status: state.status, policy: state.policy, hasMore: false, loadingMore: false, loadMoreError: false,
        restoreError: false, restoring: false, restoredJustNow: false,
      },
    }),
  };
});

const { LearningLibrarySection } = await import('./LearningLibrarySection');

const off = (patch: Partial<LearningPolicy> = {}) => ({
  organizationId: 'org-a', chapterId: 'chapter-a', quotesEnabled: true, lessonsEnabled: false, homeHidden: false,
  canManage: false, isPlatformOwner: false, version: '1', ...patch,
});

let view: Rendered | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

describe('Organizing rights > Mini-lessons while lessons are off (#9839)', () => {
  for (const locale of ['en', 'es'] as const) {
    const copy = learningCopy(locale);

    it(`offers a worker no mini-lessons section at all (${locale})`, async () => {
      Object.assign(state, { locale, status: 'disabled', policy: off() });
      view = await render(h(LearningLibrarySection, { onManage: vi.fn() }));
      expect(view.container.textContent).toBe('');
      expect(exposedNames(view.container)).toEqual([]);
    });

    it(`keeps a manager's way into the editor, with a sentence that blames no one (${locale})`, async () => {
      for (const policy of [off({ canManage: true }), off({ isPlatformOwner: true })]) {
        const onManage = vi.fn();
        Object.assign(state, { locale, status: 'disabled', policy });
        view = await render(h(LearningLibrarySection, { onManage }));
        const text = view.container.textContent ?? '';
        expect(text).toContain(copy.learnHeading);
        expect(text).toContain(copy.learnDisabledTitle);
        expect(text).toContain(copy.learnDisabledBody);
        await press(getExposed(view.container, copy.manage));
        expect(onManage).toHaveBeenCalledTimes(1);
        await view.unmount();
        view = null;
      }
    });

    it(`still shows the section while the policy is loading (${locale})`, async () => {
      Object.assign(state, { locale, status: 'loading', policy: null });
      view = await render(h(LearningLibrarySection, { onManage: vi.fn() }));
      expect(view.container.textContent).toContain(copy.learnLoadingTitle);
    });
  }

  it('says plainly that mini-lessons are not available, blaming neither the union nor the campaign', () => {
    expect(learningCopy('en').learnDisabledTitle).toBe('Mini-lessons are not available');
    expect(learningCopy('en').learnDisabledBody).toBe('Mini-lessons are not offered here right now.');
    expect(learningCopy('es').learnDisabledTitle).toBe('Las minilecciones no están disponibles');
    expect(learningCopy('es').learnDisabledBody).toBe('Por ahora no se ofrecen minilecciones aquí.');
    for (const locale of ['en', 'es'] as const) {
      const { learnDisabledTitle, learnDisabledBody } = learningCopy(locale);
      expect(`${learnDisabledTitle} ${learnDisabledBody}`).not.toMatch(/union|chapter|officer|turned|sindicato|cap[ií]tulo|desactiv/i);
    }
  });
});
