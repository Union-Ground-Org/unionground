// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, type, type Rendered } from '../../testing/reactNativeStandIn';

// UX-UG-BLOCKED-BUTTON-GIVES-NO-REASON-STAFF-DESKS-20261122 (#9468,
// M2-20 and the Propose tags miss): Save review needs the source's full record
// ID and the confirmation, and Propose tags needs text; both stayed grey with
// no word why.
vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/ui', () => import('../../testing/uiStandIn'));
vi.mock('../../components/Text', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/PressableScale', async () => ({ PressableScale: (await import('../../testing/reactNativeStandIn')).Pressable }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => () => undefined }));
vi.mock('../../services/haptics', () => ({ haptics: { select: vi.fn() } }));

import { ConnectionSourceReview } from './ConnectionSourceReview';
import { nativeConnectionCopy, type ConnectionWorkspace } from '../../lib/connectionSuggestionsShared';

const workspace = {
  organizationId: 'org-1', chapterId: 'chapter-1', chapterName: 'Tamarack', profile: null, draft: null, canPublish: true,
  canRequestHandshake: false, hiddenChapterIds: [], analysis: { nextPeriodKey: null, nextPeriodFrozen: true, latest: null },
} satisfies ConnectionWorkspace;
const RECORD = '3f2b8c1e-5d4a-4e6b-9c7d-0a1b2c3d4e5f';

let view: Rendered | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const REASON_LANGUAGES: Array<'en' | 'es'> = ['en', 'es'];
describe.each(REASON_LANGUAGES)('connection source review, in %s', (language) => {
  const tr = nativeConnectionCopy(language);
  const shown = () => view?.container.textContent ?? '';

  it('says what Propose tags and Save review wait for, and saves only when both are met', async () => {
    const onReview = vi.fn();
    view = await render(h(ConnectionSourceReview, { workspace, busy: false, onReview, onFreeze: vi.fn(), tr }));
    await press(getExposed(view.container, tr('propose')));
    expect(shown()).toContain(tr('proposeNeedsText'));
    const save = () => getExposed(view!.container, tr('saveReview'));
    await type(getExposed(view.container, tr('sourceId')), '3f2b8c1e');
    await press(save());
    expect(shown()).toContain(tr('reviewSourceInvalid'));
    expect(tr('reviewSourceInvalid')).toContain('36');
    await type(getExposed(view.container, tr('sourceId')), RECORD);
    expect(save().getAttribute('aria-description')).toBe(tr('reviewConsentRequired'));
    await press(save());
    expect(shown()).toContain(tr('reviewConsentRequired'));
    expect(onReview).not.toHaveBeenCalled();
    await press(getExposed(view.container, tr('reviewConsent')));
    expect(shown()).not.toContain(tr('reviewConsentRequired'));
    await press(save());
    expect(onReview).toHaveBeenCalledWith({ sourceKind: 'grievance', sourceId: RECORD, topicKeys: [] }, expect.any(Function));
  });

  it('gives no reason while a save is in flight', async () => {
    view = await render(h(ConnectionSourceReview, { workspace, busy: true, onReview: vi.fn(), onFreeze: vi.fn(), tr }));
    expect(getExposed(view.container, tr('propose')).getAttribute('aria-description')).toBeNull();
    expect(getExposed(view.container, tr('saveReview')).getAttribute('aria-description')).toBeNull();
  });
});
