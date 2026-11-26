function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function honestCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function meaningfulWords(name) {
  return clean(name)
    .split(/\s+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .filter((word) => !["and", "chapter", "of", "the", "y", "capitulo", "capítulo", "de", "del", "la", "el"].includes(word.toLocaleLowerCase()));
}

const ACRONYM = /^\p{Lu}{2,4}$/u;

export function chapterAbbreviation(name) {
  const meaningful = meaningfulWords(name);
  if (!meaningful.length) return "";
  if (meaningful.length === 1 && meaningful[0] === meaningful[0].toLocaleUpperCase() && meaningful[0].length <= 4) {
    return meaningful[0];
  }
  return meaningful.slice(0, 3).map((word) => word[0]).join("").toLocaleUpperCase();
}

// The longer form for a name whose short glyph another chapter already shows:
// "DCF Springfield" and "DTA Springfield" are both DS by first letters, so a
// name with an agency acronym keeps it whole and adds the next word's initial
// (DCFS, DTAS). Null when the name has no acronym to keep.
function acronymAbbreviation(name) {
  const meaningful = meaningfulWords(name);
  const lead = meaningful.findIndex((word) => ACRONYM.test(word));
  if (lead < 0) return null;
  const next = meaningful.find((_, index) => index !== lead);
  return `${meaningful[lead]}${next ? next[0].toLocaleUpperCase() : ""}`.slice(0, 4);
}

// One rail, one glyph per chapter (BUG-UG-CHAPTER-RAIL-DUPLICATE-ABBREVIATIONS-20261106):
// chapters whose short glyphs collide take the acronym form, and any glyph
// still shared gets a running number after the first.
export function withDistinctAbbreviations(chapters) {
  const count = (list) => list.reduce((map, chapter) => map.set(chapter.abbreviation, (map.get(chapter.abbreviation) ?? 0) + 1), new Map());
  const shortCounts = count(chapters);
  const extended = chapters.map((chapter) => (shortCounts.get(chapter.abbreviation) > 1
    ? { ...chapter, abbreviation: acronymAbbreviation(chapter.name) ?? chapter.abbreviation }
    : chapter));
  const seen = new Map();
  return extended.map((chapter) => {
    if (!chapter.abbreviation) return chapter;
    const index = (seen.get(chapter.abbreviation) ?? 0) + 1;
    seen.set(chapter.abbreviation, index);
    return index === 1 ? chapter : { ...chapter, abbreviation: `${chapter.abbreviation.slice(0, 3)}${index}` };
  });
}

function liveChapter(id, name) {
  return {
    id,
    name,
    abbreviation: chapterAbbreviation(name),
    category: null,
    memberCount: null,
    staffCount: null,
    landing: null,
  };
}

// BUG-UG-CHAPTER-ROLES-HIDDEN-UNTIL-CHAPTER-SWITCH-20261003: the live
// rail lists every chapter the member belongs to (the server's own
// get_my_chapter_memberships rows, never a catalog), the selected one first,
// so a second membership is visible and selectable instead of "No chapters
// match". Without membership rows it falls back to the selected chapter alone.
export function normalizeLiveChapters(member) {
  const chapterId = clean(member?.chapterId);
  const chapterName = clean(member?.chapterName);
  const rows = Array.isArray(member?.chapterMemberships) ? member.chapterMemberships : [];
  const seen = new Set();
  const chapters = [];
  if (chapterId) {
    seen.add(chapterId);
    chapters.push(liveChapter(chapterId, chapterName || chapterId));
  }
  for (const row of rows) {
    const id = clean(row?.chapterId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    chapters.push(liveChapter(id, clean(row?.name) || id));
  }
  return withDistinctAbbreviations(chapters);
}

// A live choice of another of the member's chapters runs the unsaved-work
// guard first (a veto changes nothing), then selects the chapter through the
// authorized switch and re-reads the member's data, so that chapter's roles and
// hats apply at once with no sign-out. A refused switch changes nothing; a
// refresh that fails after a successful switch is reported as such, because
// the server's selection did change. Choosing the current chapter just opens it.
export async function selectLiveChapter(chapter, {
  currentChapterId, guard = null, switchChapter, reload = null, open, onRefused, onReloadFailed,
}) {
  const id = clean(chapter?.id);
  if (!id) return false;
  if (typeof guard === "function" && !guard()) return false;
  if (id === clean(currentChapterId) || typeof switchChapter !== "function") {
    open();
    return true;
  }
  try {
    await switchChapter(id);
  } catch (error) {
    onRefused?.(error, chapter);
    return false;
  }
  if (typeof reload === "function") {
    try {
      await reload();
    } catch (error) {
      onReloadFailed?.(error, chapter);
    }
  }
  open();
  return true;
}

// One chapter choice at a time: a choice made while a switch is settling is
// ignored, so the last committed selection is always the one the member saw
// start. `options` is read at call time so the caller can keep it current.
export function createLiveChapterSelector(readOptions) {
  let pending = false;
  return async (chapter) => {
    if (pending) return false;
    const options = readOptions();
    pending = true;
    options.onBusy?.(true);
    try {
      return await selectLiveChapter(chapter, options);
    } finally {
      pending = false;
      options.onBusy?.(false);
    }
  };
}

export function normalizeDemoChapters(organizations) {
  if (!Array.isArray(organizations)) return [];
  const seen = new Set();
  const chapters = [];
  for (const organization of organizations) {
    const id = clean(organization?.id);
    const name = clean(organization?.name);
    const identity = id.toLocaleLowerCase();
    if (!id || !name || seen.has(identity)) continue;
    seen.add(identity);
    chapters.push({
      id,
      name,
      abbreviation: chapterAbbreviation(name),
      category: clean(organization?.region) || null,
      memberCount: honestCount(organization?.memberCount),
      staffCount: honestCount(organization?.staffCount),
      // The SAMPLE origin is the boundary. Realistic fictional chapter names
      // and rows stay unlabeled in product chrome.
      landing: organization?.landing && typeof organization.landing === "object"
        ? organization.landing
        : null,
    });
  }
  return withDistinctAbbreviations(chapters);
}

export function normalizeSampleChapters(organizations, member) {
  const catalog = normalizeDemoChapters(organizations);
  return catalog.length > 0 ? catalog : normalizeLiveChapters(member);
}
