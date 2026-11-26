// REQ-UG-RIGHTS-RESUME-READING-20261029: one personal "Save my place"
// bookmark for the rights reader. The stored value is only a lesson id, a
// section anchor derived from that section's own text, and a revision of the
// whole lesson: never lesson text, a title or a scroll offset. The key carries
// the backend, account, organization and chapter, so another scope never
// reads it. Saving, clearing and resuming never touch lesson progress.

export type RightsReadingScope = { backend: string; userID: string; organizationID: string; chapterID: string };
export type RightsReadingLesson = { id: string; title: string; description: string; steps: string[]; script: string };
export type RightsBookmark = { lessonID: string; anchor: string; revision: string };
export type RightsReadingSection = { anchor: string; kind: 'steps' | 'paragraph'; text: string[] };
export type RightsResume =
  | { kind: 'unavailable' }
  | { kind: 'resumed'; lessonID: string; anchor: string }
  | { kind: 'changed'; lessonID: string; anchor: string | null };

const LESSON_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ANCHOR = /^(?:steps|p)\.[0-9a-f]{8}(?:\.[1-9][0-9]?)?$/;
const REVISION = /^[0-9a-f]{16}$/;
const MAX_STORED_LENGTH = 200;

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function digest(parts: string[]): string {
  // Length-prefixed so ["ab", "c"] and ["a", "bc"] never collide by construction.
  const text = parts.map((part) => `${part.length}:${part}`).join('|');
  return `${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x01234567)}`;
}

export function rightsResumeStoreKey(scope: RightsReadingScope | null): string | null {
  if (!scope || [scope.backend, scope.userID, scope.organizationID, scope.chapterID].some((part) => part.trim() === '')) return null;
  return `org.unionground.app.rights-resume-v1.${digest([scope.backend, scope.userID, scope.organizationID, scope.chapterID])}`;
}

export function rightsLessonRevision(lesson: RightsReadingLesson): string {
  return digest([lesson.id, lesson.title, lesson.description, ...lesson.steps, '\u0000', lesson.script]);
}

/** Stable anchors: each comes from its own section's text, so it survives edits elsewhere. */
export function rightsReadingSections(lesson: RightsReadingLesson): RightsReadingSection[] {
  const seen = new Map<string, number>();
  const anchor = (prefix: string, text: string[]) => {
    const base = `${prefix}.${digest(text).slice(0, 8)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}.${count}`;
  };
  const sections: RightsReadingSection[] = [];
  if (lesson.steps.length > 0) sections.push({ anchor: anchor('steps', lesson.steps), kind: 'steps', text: lesson.steps });
  for (const paragraph of lesson.script.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean)) {
    sections.push({ anchor: anchor('p', [paragraph]), kind: 'paragraph', text: [paragraph] });
  }
  return sections;
}

export function rightsBookmarkFor(lesson: RightsReadingLesson, anchor: string): RightsBookmark {
  if (!rightsReadingSections(lesson).some((section) => section.anchor === anchor)) throw new Error('That place is not in this lesson.');
  return { lessonID: lesson.id, anchor, revision: rightsLessonRevision(lesson) };
}

export function serializeRightsBookmark(bookmark: RightsBookmark): string {
  const value = JSON.stringify({ v: 1, l: bookmark.lessonID, a: bookmark.anchor, r: bookmark.revision });
  if (parseRightsBookmark(value) === null) throw new Error('That place could not be saved.');
  return value;
}

export function parseRightsBookmark(raw: string | null): RightsBookmark | null {
  if (raw === null || raw.length > MAX_STORED_LENGTH) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const { v, l, a, r, ...rest } = value as Record<string, unknown>;
    if (v !== 1 || Object.keys(rest).length > 0) return null;
    if (typeof l !== 'string' || !LESSON_ID.test(l) || typeof a !== 'string' || !ANCHOR.test(a) || typeof r !== 'string' || !REVISION.test(r)) return null;
    return { lessonID: l, anchor: a, revision: r };
  } catch {
    return null;
  }
}

/**
 * Resolves a bookmark against lessons just reloaded under current
 * authorization. A missing lesson is unavailable (the caller clears it and
 * never names it); changed text keeps an anchor only when that exact section
 * is still present, otherwise the reader starts at the lesson top.
 */
export function resolveRightsResume(bookmark: RightsBookmark, lessons: RightsReadingLesson[]): RightsResume {
  const lesson = lessons.find((item) => item.id === bookmark.lessonID);
  if (!lesson) return { kind: 'unavailable' };
  const present = rightsReadingSections(lesson).some((section) => section.anchor === bookmark.anchor);
  if (rightsLessonRevision(lesson) === bookmark.revision && present) return { kind: 'resumed', lessonID: lesson.id, anchor: bookmark.anchor };
  return { kind: 'changed', lessonID: lesson.id, anchor: present ? bookmark.anchor : null };
}

/** A Compass source link always wins; a bookmark only opens when the member asks. */
export function rightsReaderLesson(input: { sourceLessonID: string | null; openedLessonID: string | null }): string | null {
  return input.sourceLessonID ?? input.openedLessonID;
}

export type RightsBookmarkStorage = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

export function createRightsBookmarkStore(storage: RightsBookmarkStorage) {
  const requireKey = (scope: RightsReadingScope | null) => {
    const key = rightsResumeStoreKey(scope);
    if (!key) throw new Error('Open your signed-in campaign first.');
    return key;
  };
  return {
    async read(scope: RightsReadingScope | null): Promise<RightsBookmark | null> {
      const key = rightsResumeStoreKey(scope);
      return key ? parseRightsBookmark(await storage.getItemAsync(key)) : null;
    },
    /** Resolves only once the bookmark reads back exactly; anything else throws. */
    async save(scope: RightsReadingScope | null, bookmark: RightsBookmark): Promise<void> {
      const key = requireKey(scope);
      const value = serializeRightsBookmark(bookmark);
      await storage.setItemAsync(key, value);
      if ((await storage.getItemAsync(key)) !== value) throw new Error('That place could not be saved.');
    },
    async clear(scope: RightsReadingScope | null): Promise<void> {
      await storage.deleteItemAsync(requireKey(scope));
    },
  };
}

export type RightsBookmarkStore = ReturnType<typeof createRightsBookmarkStore>;
export type RightsResumeOutcome =
  | { kind: 'none' }
  | { kind: 'unavailable'; cleared: boolean; message: string }
  | { kind: 'open'; lessonID: string; anchor: string | null; changed: boolean; message: string };

export const RIGHTS_RESUME_COPY = {
  resumed: 'Resumed at your saved place.',
  changedSection: 'This lesson changed since you saved your place. You are at the same section, which has not changed.',
  changedTop: 'This lesson changed since you saved your place, so it opens at the top.',
  unavailable: 'Your saved place is no longer available. The lesson was removed or is no longer shared with you, so the saved place was cleared.',
  unavailableKept: 'Your saved place is no longer available, and it could not be cleared from this device. Try Clear saved place.',
} as const;

/**
 * The explicit Continue reading action. `reload` is the normal authorized
 * lessons read; nothing here can mark progress, send a receipt or award.
 * A reload failure propagates and leaves the bookmark as it was.
 */
export async function resumeRightsReading(
  store: RightsBookmarkStore,
  scope: RightsReadingScope | null,
  reload: () => Promise<RightsReadingLesson[]>,
): Promise<RightsResumeOutcome> {
  const bookmark = await store.read(scope);
  if (!bookmark) return { kind: 'none' };
  const resume = resolveRightsResume(bookmark, await reload());
  if (resume.kind === 'unavailable') {
    try {
      await store.clear(scope);
      return { kind: 'unavailable', cleared: true, message: RIGHTS_RESUME_COPY.unavailable };
    } catch {
      return { kind: 'unavailable', cleared: false, message: RIGHTS_RESUME_COPY.unavailableKept };
    }
  }
  if (resume.kind === 'resumed') return { kind: 'open', lessonID: resume.lessonID, anchor: resume.anchor, changed: false, message: RIGHTS_RESUME_COPY.resumed };
  return { kind: 'open', lessonID: resume.lessonID, anchor: resume.anchor, changed: true, message: resume.anchor ? RIGHTS_RESUME_COPY.changedSection : RIGHTS_RESUME_COPY.changedTop };
}
