import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  RIGHTS_RESUME_COPY,
  createRightsBookmarkStore,
  parseRightsBookmark,
  resolveRightsResume,
  resumeRightsReading,
  rightsBookmarkFor,
  rightsLessonRevision,
  rightsReaderLesson,
  rightsReadingSections,
  rightsResumeStoreKey,
  serializeRightsBookmark,
  type RightsBookmarkStorage,
  type RightsReadingLesson,
  type RightsReadingScope,
} from './rightsResumeReading';

const scope: RightsReadingScope = { backend: 'https://backend-a.example', userID: 'user-a', organizationID: 'org-a', chapterID: 'chapter-a' };
const weingarten: RightsReadingLesson = {
  id: 'weingarten',
  title: 'Surprise disciplinary meeting',
  description: 'Use this if management pulls you into a meeting that could lead to discipline.',
  steps: ['Ask whether the meeting could lead to discipline.', 'State that you want union representation before answering.'],
  script: 'If this meeting could lead to discipline, I request representation.\n\nI will wait for a committee member before answering.',
};

function memoryStorage(): RightsBookmarkStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async (key) => { values.delete(key); },
  };
}

function anchorOf(lesson: RightsReadingLesson, index: number): string {
  const section = rightsReadingSections(lesson)[index];
  if (!section) throw new Error('missing section');
  return section.anchor;
}

describe('rights resume bookmark', () => {
  it('saves, survives a relaunch, resumes at the anchor and clears', async () => {
    const storage = memoryStorage();
    const paragraph = anchorOf(weingarten, 2);
    await createRightsBookmarkStore(storage).save(scope, rightsBookmarkFor(weingarten, paragraph));

    // A relaunch is a new store over the same secure storage.
    const relaunched = createRightsBookmarkStore(storage);
    expect(await relaunched.read(scope)).toEqual({ lessonID: 'weingarten', anchor: paragraph, revision: rightsLessonRevision(weingarten) });
    await expect(resumeRightsReading(relaunched, scope, async () => [weingarten]))
      .resolves.toEqual({ kind: 'open', lessonID: 'weingarten', anchor: paragraph, changed: false, message: RIGHTS_RESUME_COPY.resumed });

    await relaunched.clear(scope);
    expect(storage.values.size).toBe(0);
    await expect(resumeRightsReading(relaunched, scope, async () => [weingarten])).resolves.toEqual({ kind: 'none' });
  });

  it('stores only the lesson id, anchor and revision, never lesson text or a pixel offset', async () => {
    const storage = memoryStorage();
    await createRightsBookmarkStore(storage).save(scope, rightsBookmarkFor(weingarten, anchorOf(weingarten, 0)));
    const [key, value] = [...storage.values][0] ?? ['', ''];
    expect(key).toMatch(/^org\.unionground\.app\.rights-resume-v1\.[0-9a-f]{16}$/);
    expect(Object.keys(JSON.parse(value ?? '{}'))).toEqual(['v', 'l', 'a', 'r']);
    for (const text of [weingarten.title, weingarten.description, ...weingarten.steps, 'discipline', 'user-a', 'chapter-a']) {
      expect(`${key}${value}`).not.toContain(text);
    }
    expect(value?.length).toBeLessThanOrEqual(200);
  });

  it('keeps the same section after a content change, or opens at the top when it is gone', () => {
    const scriptAnchor = anchorOf(weingarten, 2);
    const stepsAnchor = anchorOf(weingarten, 0);
    const edited = { ...weingarten, script: 'A rewritten opening paragraph.\n\nI will wait for a committee member before answering.' };
    // The unchanged paragraph keeps its anchor even though the lesson revision moved.
    expect(rightsLessonRevision(edited)).not.toBe(rightsLessonRevision(weingarten));
    expect(resolveRightsResume(rightsBookmarkFor(weingarten, scriptAnchor), [edited])).toEqual({ kind: 'changed', lessonID: 'weingarten', anchor: scriptAnchor });
    const reordered = { ...weingarten, steps: [...weingarten.steps].reverse() };
    expect(resolveRightsResume(rightsBookmarkFor(weingarten, stepsAnchor), [reordered])).toEqual({ kind: 'changed', lessonID: 'weingarten', anchor: null });
  });

  it('explains a changed lesson through the resume outcome', async () => {
    const storage = memoryStorage();
    const store = createRightsBookmarkStore(storage);
    await store.save(scope, rightsBookmarkFor(weingarten, anchorOf(weingarten, 1)));
    const outcome = await resumeRightsReading(store, scope, async () => [{ ...weingarten, script: 'Entirely new text.' }]);
    expect(outcome).toEqual({ kind: 'open', lessonID: 'weingarten', anchor: null, changed: true, message: RIGHTS_RESUME_COPY.changedTop });
  });

  it('clears an unavailable lesson without naming it', async () => {
    const storage = memoryStorage();
    const store = createRightsBookmarkStore(storage);
    await store.save(scope, rightsBookmarkFor(weingarten, anchorOf(weingarten, 0)));
    const outcome = await resumeRightsReading(store, scope, async () => [{ ...weingarten, id: 'safety', title: 'Raise an immediate safety concern' }]);
    expect(outcome).toEqual({ kind: 'unavailable', cleared: true, message: RIGHTS_RESUME_COPY.unavailable });
    expect(JSON.stringify(outcome)).not.toContain(weingarten.title);
    expect(storage.values.size).toBe(0);

    await store.save(scope, rightsBookmarkFor(weingarten, anchorOf(weingarten, 0)));
    const stuck = createRightsBookmarkStore({ ...storage, deleteItemAsync: async () => { throw new Error('keychain'); } });
    await expect(resumeRightsReading(stuck, scope, async () => [])).resolves.toEqual({ kind: 'unavailable', cleared: false, message: RIGHTS_RESUME_COPY.unavailableKept });
  });

  it('isolates the bookmark by backend, account, organization and campaign', async () => {
    const storage = memoryStorage();
    await createRightsBookmarkStore(storage).save(scope, rightsBookmarkFor(weingarten, anchorOf(weingarten, 0)));
    const store = createRightsBookmarkStore(storage);
    for (const other of [{ backend: 'https://backend-b.example' }, { userID: 'user-b' }, { organizationID: 'org-b' }, { chapterID: 'chapter-b' }]) {
      const otherScope = { ...scope, ...other };
      expect(rightsResumeStoreKey(otherScope)).not.toBe(rightsResumeStoreKey(scope));
      expect(await store.read(otherScope)).toBeNull();
      await expect(resumeRightsReading(store, otherScope, async () => [weingarten])).resolves.toEqual({ kind: 'none' });
    }
    expect(rightsResumeStoreKey(null)).toBeNull();
    expect(rightsResumeStoreKey({ ...scope, chapterID: ' ' })).toBeNull();
    await expect(store.save(null, rightsBookmarkFor(weingarten, anchorOf(weingarten, 0)))).rejects.toThrow('Open your signed-in campaign first.');
  });

  it('never reports a save that storage did not keep', async () => {
    const bookmark = rightsBookmarkFor(weingarten, anchorOf(weingarten, 0));
    const failing = createRightsBookmarkStore({ ...memoryStorage(), setItemAsync: async () => { throw new Error('keychain'); } });
    await expect(failing.save(scope, bookmark)).rejects.toThrow('keychain');
    const dropping = createRightsBookmarkStore({ ...memoryStorage(), setItemAsync: async () => undefined });
    await expect(dropping.save(scope, bookmark)).rejects.toThrow('That place could not be saved.');
  });

  it('keeps the bookmark when the authorized reload fails', async () => {
    const storage = memoryStorage();
    const store = createRightsBookmarkStore(storage);
    await store.save(scope, rightsBookmarkFor(weingarten, anchorOf(weingarten, 0)));
    await expect(resumeRightsReading(store, scope, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(await store.read(scope)).not.toBeNull();
  });

  it('lets a Guide source link take precedence over a saved place', () => {
    expect(rightsReaderLesson({ sourceLessonID: 'loudermill', openedLessonID: 'weingarten' })).toBe('loudermill');
    expect(rightsReaderLesson({ sourceLessonID: null, openedLessonID: 'weingarten' })).toBe('weingarten');
    expect(rightsReaderLesson({ sourceLessonID: null, openedLessonID: null })).toBeNull();
  });

  it('bounds what it reads back', () => {
    const valid = serializeRightsBookmark(rightsBookmarkFor(weingarten, anchorOf(weingarten, 0)));
    expect(parseRightsBookmark(valid)).not.toBeNull();
    const parsed = JSON.parse(valid) as Record<string, unknown>;
    for (const raw of [
      null, '', 'not json', '[]', JSON.stringify({ ...parsed, v: 2 }), JSON.stringify({ ...parsed, t: weingarten.title }),
      JSON.stringify({ ...parsed, l: 'x'.repeat(65) }), JSON.stringify({ ...parsed, l: '../other' }), JSON.stringify({ ...parsed, a: 'y:1200' }),
      JSON.stringify({ ...parsed, r: 'abc' }), `${valid}${' '.repeat(200)}`,
    ]) expect(parseRightsBookmark(raw)).toBeNull();
    expect(() => rightsBookmarkFor(weingarten, 'p.00000000')).toThrow('That place is not in this lesson.');
    expect(() => serializeRightsBookmark({ ...rightsBookmarkFor(weingarten, anchorOf(weingarten, 0)), lessonID: 'x'.repeat(65) })).toThrow();
  });

  it('anchors sections by their own text, with duplicates kept distinct', () => {
    const sections = rightsReadingSections({ ...weingarten, script: 'Same.\n\nSame.\n\n  \n\nLast.' });
    expect(sections.map((section) => section.kind)).toEqual(['steps', 'paragraph', 'paragraph', 'paragraph']);
    expect(new Set(sections.map((section) => section.anchor)).size).toBe(4);
    expect(sections[2]?.anchor).toBe(`${sections[1]?.anchor}.2`);
    expect(rightsReadingSections({ ...weingarten, title: 'Renamed' }).map((section) => section.anchor))
      .toEqual(rightsReadingSections(weingarten).map((section) => section.anchor));
  });

  it('keeps saving, clearing and resuming apart from progress, receipts, rewards and analytics', () => {
    for (const path of ['src/lib/rightsResumeReading.ts', 'src/features/RightsResumeReading.tsx']) {
      const source = readFileSync(path, 'utf8');
      // No service layer at all: only secure storage, config, theme and UI.
      expect(source).not.toMatch(/from '\.\.\/services\//u);
      for (const forbidden of ['saveMobileRightsProgress', 'markMobileBroadcastRead', 'requestMobileSteward', 'reward', 'milestone', 'posthog', 'analytics', 'sentry', 'haptics']) {
        expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });
});
