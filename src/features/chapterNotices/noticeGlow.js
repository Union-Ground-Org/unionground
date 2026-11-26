// REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113 (#8627): a chapter's
// notices carry the tile's soft glow in the colour the chapter picks (owner,
// Nov 13, 2026, decision 3 of the Union Ground theme guide). The four choices
// and the drawing come from the promo package (kit/brand/theme/tokens.json
// "glow" and ug-theme.css); the values live in src/sg-tokens.css as
// --sg-light-glow-*. Amber means due soon and red,
// breathing, means urgent: they follow the notice, never the chapter.
export const CHAPTER_NOTICE_GLOWS = Object.freeze(["green", "blue", "gold", "violet"]);

// A chapter that has not chosen, or a value this build does not know, is green.
export function chapterNoticeGlow(value) {
  return CHAPTER_NOTICE_GLOWS.includes(value) ? value : "green";
}

// The glow one notice tile wears, with the word that says the same thing.
// Urgency comes first. No announcement is marked urgent or due today yet
// (this record adds no urgency field), so today every chapter notice takes
// its chapter's colour; an organization-wide notice has no chapter and no glow.
export function noticeTileGlow(notice, chapter) {
  if (notice?.urgent === true) return { glow: "red", breathe: true, wordKey: "noticeGlow.urgent" };
  if (notice?.dueToday === true) return { glow: "amber", breathe: false, wordKey: "noticeGlow.dueToday" };
  if (!chapter) return null;
  return { glow: chapterNoticeGlow(chapter.glow), breathe: false, wordKey: null };
}

// The chapter and colour of each of the member's chapter notices, by
// broadcast id. Same rows and bounds as the cold-Home broadcast read (the
// newest 50 unretracted, under the same RLS); it runs when Messages opens, so
// the one-call Home bootstrap is unchanged. a review note: only the
// chapters those notices name are read (at most 50), so the API's 1,000-row
// cap can never cut the lookup short. A database without the column yet
// answers with an error, which the caller treats as "no glow".
export async function loadNoticeChapters(client) {
  const broadcasts = await client.from("member_broadcasts").select("id,chapter_id,audience_scope").is("retracted_at", null).order("published_at", { ascending: false }).limit(50);
  if (broadcasts.error) throw broadcasts.error;
  const notices = (broadcasts.data || []).filter((row) => row.audience_scope !== "organization" && row.chapter_id);
  const chapterIds = [...new Set(notices.map((row) => row.chapter_id))];
  if (!chapterIds.length) return {};
  const chapters = await client.from("chapters").select("id,name,notice_glow").in("id", chapterIds);
  if (chapters.error) throw chapters.error;
  const byId = new Map((chapters.data || []).map((row) => [row.id, { name: row.name, glow: chapterNoticeGlow(row.notice_glow) }]));
  const out = {};
  for (const row of notices) {
    const chapter = byId.get(row.chapter_id);
    if (chapter) out[row.id] = chapter;
  }
  return out;
}

// One read per client and member for the session, so opening Messages again
// issues no new reads; it reads again only when an announcement arrives that
// the last read did not cover, or after the colour was changed or the member
// signed out (forgetNoticeChapters). a review note: the entry belongs to
// the member it was read for, so another member on the same client (an
// account switch) never gets it, and nothing is cached without a member.
let noticeChapterReads = new WeakMap();
export function noticeChaptersFor(client, broadcastIds = [], memberId = null) {
  if (!memberId) return loadNoticeChapters(client);
  const cached = noticeChapterReads.get(client);
  if (cached && cached.memberId === memberId && broadcastIds.every((id) => cached.seen.has(id))) return cached.read;
  const read = loadNoticeChapters(client);
  noticeChapterReads.set(client, { memberId, read, seen: new Set(broadcastIds) });
  read.catch(() => { if (noticeChapterReads.get(client)?.read === read) noticeChapterReads.delete(client); });
  return read;
}
export function forgetNoticeChapters() {
  noticeChapterReads = new WeakMap();
}

// The settings control's two calls. The server decides who may change the
// colour (the roles that can publish that chapter's announcements).
export function createNoticeGlowApi(client) {
  if (!client) return null;
  const data = (result) => {
    if (result.error) {
      // #9995: a refusal that arrives as an HTTP status alone (403 or 404, no
      // code) keeps that status, so the control can tell it from a failed read.
      if (Number.isInteger(result.status) && typeof result.error === "object" && result.error.status === undefined) result.error.status = result.status;
      throw result.error;
    }
    return result.data;
  };
  return {
    load: async (chapterId) => data(await client.rpc("get_chapter_notice_glow", { p_chapter_id: chapterId })),
    save: async (chapterId, colour) => data(await client.rpc("set_chapter_notice_glow", { p_chapter_id: chapterId, p_colour: colour })),
  };
}
