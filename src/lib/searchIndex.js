// Client-side member search (PR8, gap J). Pure functions over the member-app
// data snapshot — every indexed surface is already in memory (loadMemberApp
// fetches eagerly), so search works with zero network calls and therefore
// offline. Text is single-language per item (DB content is author-language;
// form templates arrive already resolved to the member's language), so the
// index holds what the member actually sees, not a parallel translation.
//
// Matching is diacritic-insensitive ("lección" matches "leccion" and vice
// versa) and token-based: every whitespace token of the query must appear
// somewhere in the entry's haystack. Title hits rank above body hits, then
// ties keep the index's own recency-ish ordering.

import { caseRowLine } from "./caseRowLine.js";
import { FORM_TEMPLATES } from "./formTemplates.js";
import { FEATURE_GROUPS } from "./mobileNav.js";
import { siteGuideEnabled } from "./siteGuide.js";
import { leadershipRoleLine } from "./chapterLeadership.js";

const TYPE_ORDER = [
  "page", "person",
  "case", "conversation", "broadcast", "event", "appointment", "ballot", "pulse",
  "lesson", "form", "template", "kb", "notification", "guide", "reward", "tool",
];

const FORM_STATUS_KEYS = {
  draft: "forms.statusDraft",
  submitted: "forms.statusSubmitted",
  in_review: "forms.statusInReview",
  approved: "forms.statusApproved",
  returned: "forms.statusReturned",
};

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function entry(type, id, title, snippet, meta, focus, extraHaystack = "") {
  const snippetSource = String(snippet || "");
  return {
    id: `${type}:${id}`,
    type,
    title: String(title || ""),
    snippet: snippetSource.slice(0, 160),
    snippetSource,
    meta: String(meta || ""),
    focus,
    haystack: normalizeText(`${title} ${snippet} ${extraHaystack}`),
  };
}

// The one deep-link payload every case result carries, wherever the row came
// from. CasesView keys off focus.caseId and prints its own "unavailable or no
// longer accessible" line when the id is not in the snapshot, so a server
// result for a case the member app never fetched still lands somewhere honest.
export function caseFocus(caseId) {
  return { view: "cases", path: `/m/cases?case=${caseId}`, caseId, filter: "all" };
}

// Union Ground issues carry no contract articles and no grievance step
// (owner decision, 2026-10-13), so neither is shown or indexed. A result shows
// its reference and type, never its topic; `line` is the server's neutral line
// for a server row, and a local row composes it from the type.
function caseEntry(item, t, line = caseRowLine({ caseType: item.type }, t)) {
  return entry(
    "case", item.id, `${item.reference} · ${line}`,
    item.snippet || "",
    item.deadline || "",
    caseFocus(item.id),
    `${item.title || ""} ${item.type} ${(item.updates || []).map((update) => update.body).join(" ")}`,
  );
}

// Build the flat entry list from the data snapshot. Focus payloads carry
// exactly what App needs to land the member ON the item, not merely on its
// view: the conversation/broadcast id + tab for Messages, the case id (and
// the "all" filter, so a resolved case is not hidden by the default filter),
// the lesson label Rights keys by, the template key / form row for Forms, the
// plan id for the App-level ballot/pulse dialog.
//
// `t` resolves i18n keys for the STATIC form templates (their titleKey/
// blurbKey are catalogue keys; DB-sourced templates carry already-resolved
// text there — the `source: "db"` marker tells them apart). Members must be
// able to find a form by its displayed name, not its registry key.
export function buildSearchIndex(data, t = (key) => key, { memberRequests = false, dues = true } = {}) {
  if (!data) return [];
  const entries = [];

  // Only the member catalog is eligible here. Staff navigation, arbitrary
  // configured links and profile/task directories are not member search data.
  for (const page of FEATURE_GROUPS.flatMap((group) => group.items)) {
    if (!page.path || page.key === "search") continue;
    const view = page.viewKey ?? page.key;
    if (view === "siteGuide" && !siteGuideEnabled(data.organizationConfiguration)) continue;
    if (view === "dues" && !dues) continue;
    entries.push(entry("page", page.key, t(page.labelKey), "", "", { view, path: page.path }));
  }

  // Find-my-steward roster (get_member_chapter_stewards, the Home card). Name
  // and role only, never the contact fields; the result opens Home, where the
  // card offers the member's contact route.
  const indexedPeople = new Set();
  for (const steward of data.chapterStewards || []) {
    if (!steward?.id || !steward.name?.trim()) continue;
    indexedPeople.add(normalizeText(steward.name));
    const role = t(`today.stewardRole_${steward.roleLabel === "steward" ? "steward" : "other"}`);
    entries.push(entry("person", `steward:${steward.id}`, steward.name, [role, steward.chapterLabel].filter(Boolean).join(" · "),
      t("today.findSteward"), { view: "today", path: "/m" }));
  }

  // This projection is already authorized by get_member_organization_structure.
  // Recheck its scope so a stale snapshot cannot label a previous tenant's
  // officer as belonging to the current member. Never index private contact
  // fields, participant ids, vacant seats, or the staff member directory. The
  // demo snapshot carries no member organization id; its chapter still has to
  // match, and a live member keeps the organization equality check.
  const structure = data.memberOrgStructure;
  const structureInScope = Boolean(structure && data.member?.chapterId && structure.chapterId === data.member.chapterId
    && (!data.member.organizationId || structure.organizationId === data.member.organizationId));
  if (structureInScope) {
    for (const chart of structure.charts || []) {
      if (chart.chartKind !== "union") continue;
      for (const person of chart.nodes || []) {
        // Occupied officer seats only: a person node, or a role seat the chart
        // shows as filled. Setup-imported seats arrive vacant.
        if (!["person", "role"].includes(person.nodeKind) || person.vacant || !person.label?.trim()) continue;
        if (person.chapterId && person.chapterId !== data.member.chapterId) continue;
        if (indexedPeople.has(normalizeText(person.label))) continue;
        entries.push(entry("person", person.id, person.label, person.subtitle || "", t("nav.orgStructure"),
          { view: "orgStructure", path: "/m/org-structure", nodeId: person.id }));
      }
    }
  }

  // REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006: the
  // chapter's officers and administrators (get_chapter_leadership), by name,
  // title and role only. The result opens the Who runs this chapter card on
  // the profile page. A person the roster or the chart already lists keeps
  // that entry, and a roster for another chapter is never indexed.
  const leadership = data.chapterLeadership;
  if (leadership && data.member?.chapterId && leadership.chapterId === data.member.chapterId) {
    const chartPeople = new Set();
    if (structureInScope) {
      for (const chart of structure.charts || []) {
        for (const node of chart.nodes || []) {
          if (node?.label) chartPeople.add(normalizeText(node.label));
          // A filled role seat names its holder in the subtitle.
          if (node?.nodeKind === "role" && node.subtitle) chartPeople.add(normalizeText(node.subtitle));
        }
      }
    }
    for (const person of leadership.people || []) {
      if (!person?.id || !person.name?.trim()) continue;
      const key = normalizeText(person.name);
      if (indexedPeople.has(key) || chartPeople.has(key)) continue;
      indexedPeople.add(key);
      entries.push(entry("person", `leader:${person.id}`, person.name, leadershipRoleLine(person, t),
        t("settings.leadershipTitle"), { view: "settings", path: "/m/settings/profile" }));
    }
  }

  // Same precedence as FormsView: DB registry templates when loaded, the
  // static array as the demo/offline fallback — so demo Search shows the
  // "Start a form" group the demo Forms hub shows.
  const templates = Array.isArray(data.formTemplates) ? data.formTemplates : FORM_TEMPLATES;
  const templateText = (template, field) =>
    (template?.source === "db" ? template?.[field] : t(template?.[field])) || "";
  const templateByKey = new Map(templates.map((template) => [template.key, template]));
  const versionedTitle = (row) => {
    const pinned = (data.formTemplateVersions || []).find(
      (template) => template.key === row.templateKey && template.version === row.templateVersion,
    );
    return templateText(pinned || templateByKey.get(row.templateKey), "titleKey")
      || row.templateKey.replace(/_/g, " ");
  };

  for (const item of data.cases || []) entries.push(caseEntry(item, t));

  for (const item of data.conversations || []) {
    const result = entry(
      "conversation", item.id, item.sender, item.preview, item.dateLabel,
      { view: "messages", path: "/m/messages", tab: "inbox", conversationId: item.id },
      (item.messages || []).map((message) => message.body).join(" "),
    );
    result.searchMessages = (item.messages || []).filter((message) => typeof message.body === "string" && message.body);
    if (item.preview) result.searchMessages.push({ body: item.preview });
    entries.push(result);
  }

  for (const item of data.broadcasts || []) {
    entries.push(entry(
      "broadcast", item.id, item.title, item.body, item.sender,
      { view: "messages", path: "/m/messages", tab: "broadcasts", broadcastId: item.id },
    ));
  }

  for (const item of data.events || []) {
    entries.push(entry(
      "event", item.id, item.title, item.summary, `${item.dateLabel} · ${item.location || ""}`,
      // The meeting itself, not the Events list (#8218): the same
      // ?event= address the record index and connected workflows open.
      { view: "events", path: `/m/events?event=${encodeURIComponent(item.id)}` },
      // The location is printed on the result card, so it must also match a
      // query ("Worcester" should find the meeting held there).
      `${item.location || ""} ${item.dateLabel || ""}`,
    ));
  }

  for (const item of data.appointments || []) {
    entries.push(entry(
      "appointment", item.id, t(`appt.type.${item.type}`),
      `${item.dateLabel || ""} · ${item.timeLabel || ""}`.trim(),
      item.stewardName || "",
      { view: "appointments", path: "/m/appointments" },
      `${item.stewardName || ""} ${item.status || ""}`,
    ));
  }

  for (const item of data.planItems || []) {
    if (item.kind === "lesson") continue; // the lesson nudge duplicates the rights entry below
    entries.push(entry(
      item.kind === "ballot" ? "ballot" : "pulse", item.id, item.title, item.meta, "",
      { planId: item.id },
      (item.options || []).map((option) => option.label).join(" "),
    ));
  }

  for (const item of data.rights?.lessonRecords || []) {
    entries.push(entry(
      "lesson", item.id, item.title, item.description, item.label,
      { view: "rights", path: "/m/rights", lessonLabel: item.label },
      `${item.label} ${(item.steps || []).join(" ")} ${item.script || ""}`,
    ));
  }

  for (const item of data.forms || []) {
    const status = Object.hasOwn(FORM_STATUS_KEYS, item.status) ? t(FORM_STATUS_KEYS[item.status]) : item.status;
    const note = String(item.reviewNote || "").trim();
    const normalizedNote = normalizeText(note);
    const repeatsStatus = [item.status, status].some((label) => normalizeText(label) === normalizedNote);
    entries.push(entry(
      "form", item.id, versionedTitle(item), repeatsStatus ? "" : note, status,
      { view: "forms", path: "/m/forms", templateKey: item.templateKey, formId: item.id },
      // Sealed FMLA answers (#5747) stay out of the search index.
      `${item.status || ""} ${status || ""} ${item.templateKey.replace(/_/g, " ")} ${item.sealed ? "" : Object.values(item.answers || {}).map((value) => String(value ?? "")).join(" ")}`,
    ));
  }

  for (const item of templates) {
    entries.push(entry(
      "template", item.key, templateText(item, "titleKey") || item.key, templateText(item, "blurbKey"), "",
      { view: "forms", path: "/m/forms", templateKey: item.key },
      item.key.replace(/_/g, " "),
    ));
  }

  for (const item of data.kbArticles || []) {
    entries.push(entry(
      "kb", item.slug, item.title, item.body, item.ref,
      { kb: item.slug },
      (item.keywords || []).join(" "),
    ));
  }

  for (const item of data.notifications || []) {
    entries.push(entry(
      "notification", item.id, item.title, item.body, "",
      { notifications: true },
    ));
  }

  for (const item of data.guideThreads || []) {
    const result = entry(
      "guide", item.id, item.title, "", "",
      { assistant: true, guideThreadId: item.id },
      (item.messages || []).map((message) => message.body).join(" "),
    );
    result.searchMessages = (item.messages || []).filter((message) => typeof message.body === "string" && message.body);
    entries.push(result);
  }

  // BUG-UG-PASSWORD-REISSUE-HAT-AND-DISCOVERY-20261003: an admin
  // looking for how to get a locked-out worker back in must find the password
  // reissue by the words the sign-in error and workers use. The entry is
  // offered to anyone who holds the Admin role; opening it wears the Admin hat.
  if ((data.roles || []).includes("admin")) {
    entries.push(entry(
      "tool", "password-reissue", t("search.tool.passwordReissue"), t("search.tool.passwordReissueSub"), "",
      { staffView: "admin", path: "/m/admin/signin-recovery", sectionId: "admin-signin-recovery" },
      `${t("admin.recoveryTitle")} reissue reset forgot password locked out sign in reemitir restablecer olvide contrasena`,
    ));
  }

  // REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: any
  // signed-in member can suggest an invitation or ask for a staff role, where
  // the page is drawn (not the fixture demo, SAMPLE or a restricted session).
  if (data.member && memberRequests === true) {
    entries.push(entry(
      "tool", "member-requests", t("search.tool.requests"), t("search.tool.requestsSub"), "",
      { view: "settings", path: "/m/settings/requests" },
      `${t("requests.title")} invite invitation suggest request role access steward coordinator invitar invitacion sugerir solicitud rol acceso`,
    ));
  }

  // REQ-UG-INVITE-RIGHTS-AND-ACCESS-REQUESTS-20261030: a President
  // searching "invite" found nothing (Oct 29-30 swarm finding 26). Each role
  // that may invite finds its own invitation page; opening it wears that role.
  // The database still decides who may invite into which chapter.
  const inviteKeywords = "invite invitation invitations add member new member bring colleague invitar invitacion invitaciones agregar miembro";
  if ((data.roles || []).includes("admin")) {
    entries.push(entry(
      "tool", "invite-members-admin", t("search.tool.invite"), t("search.tool.inviteSub"), "",
      { staffView: "admin", path: "/m/admin/invitations", sectionId: "admin-invitations" },
      `${t("admin.inviteTitle")} ${inviteKeywords}`,
    ));
  }
  if ((data.roles || []).includes("vp")) {
    entries.push(entry(
      "tool", "invite-members-president", t("search.tool.invite"), t("search.tool.inviteSubPresident"), "",
      { staffView: "vp", path: "/m/vp/invitations", sectionId: "vp-invitations" },
      `${t("admin.inviteTitle")} ${inviteKeywords}`,
    ));
  }

  for (const item of data.recognitionCatalog?.rules || []) {
  // The recognition catalogue, not a points catalogue: Union Ground retired
  // point minting, so an entry carries the rule's description and no score.
    entries.push(entry(
      "reward", item.recognitionKind, item.label, item.description, "",
      { view: "rewards", path: "/m/rewards" },
    ));
  }

  return entries;
}

// public.search_member_cases wraps every match in these sentinels rather than
// HTML, so a snippet is rendered as React nodes and never as markup. Text that
// genuinely contains "[[" would draw one spurious highlight; that is cosmetic,
// and it is the price of never handing a server string to dangerouslySetInnerHTML.
export const SNIPPET_MARK_OPEN = "[[";
export const SNIPPET_MARK_CLOSE = "]]";

// [{ text, highlight }] — every segment in order, so the caller can render the
// marked runs with <mark> and the rest as plain text.
export function snippetSegments(snippet) {
  const source = String(snippet ?? "");
  const segments = [];
  let at = 0;
  while (at < source.length) {
    const open = source.indexOf(SNIPPET_MARK_OPEN, at);
    if (open === -1) break;
    const close = source.indexOf(SNIPPET_MARK_CLOSE, open + SNIPPET_MARK_OPEN.length);
    if (close === -1) break;
    if (open > at) segments.push({ text: source.slice(at, open), highlight: false });
    const marked = source.slice(open + SNIPPET_MARK_OPEN.length, close);
    if (marked) segments.push({ text: marked, highlight: true });
    at = close + SNIPPET_MARK_CLOSE.length;
  }
  if (at < source.length) segments.push({ text: source.slice(at), highlight: false });
  return segments;
}

export function plainSnippet(snippet) {
  return snippetSegments(snippet).map((segment) => segment.text).join("");
}

// Rows from public.search_member_cases, in the same entry shape the local
// index uses. `pinned` marks them for searchEntries: Postgres already decided
// they match, and its stemmer reaches words ("filing" for "filed") the local
// substring scan never will, so they must not be re-filtered by it.
export function serverCaseEntries(rows, { formatDeadline = (value) => value || "", t = null } = {}) {
  return (Array.isArray(rows) ? rows : []).map((row, order) => {
    const headline = String(row.headline ?? "");
    const item = {
      id: row.case_id,
      reference: row.reference,
      snippet: plainSnippet(headline),
      type: row.case_type,
      deadline: formatDeadline(row.deadline),
    };
    // Without a translator the server's own line (row.title) is used. With
    // one, a row the server marks topic_shown keeps its title, the topic a
    // chapter or steward switch shows to this reader (#7043).
    const line = t ? caseRowLine({ caseType: row.case_type, title: row.title, topicShown: row.topic_shown }, t) : row.title;
    const base = caseEntry(item, t, line);
    return {
      ...base,
      snippetSegments: snippetSegments(headline),
      headlineSource: row.headline_source || "",
      serverRank: Number(row.rank) || 0,
      serverOrder: order,
      pinned: true,
    };
  });
}

// search_member_cases returns every case the caller may read as staff too (a
// steward's caseload, a coordinator's queue), but every result here opens on
// /m/cases, which shows only the member's own cases and calls anything else
// unavailable. The member surfaces therefore keep only rows for cases in the
// member's own list, so every listed case opens.
export function memberOpenableCaseEntries(serverEntries, cases) {
  const own = new Set((Array.isArray(cases) ? cases : []).map((item) => item?.id).filter(Boolean));
  return (Array.isArray(serverEntries) ? serverEntries : []).filter((item) => own.has(item?.focus?.caseId));
}

// Server rows replace their local twin in place and append the cases the
// snapshot never carried. The local haystack rides along so a token the
// headline omits (a case note body, the step) still matches locally.
export function mergeServerCaseEntries(entries, serverEntries) {
  const incoming = Array.isArray(serverEntries) ? serverEntries : [];
  if (!incoming.length) return entries;
  const byId = new Map(incoming.map((item) => [item.id, item]));
  const merged = (entries || []).map((item) => {
    const server = byId.get(item.id);
    if (!server) return item;
    byId.delete(item.id);
    return { ...item, ...server, haystack: `${item.haystack} ${server.haystack}`.trim() };
  });
  return [...merged, ...byId.values()];
}

// Above every locally scored hit of the same type, in the server's own rank
// order. 1000 is simply out of reach of the 2-per-token local score.
const PINNED_SCORE = 1000;

const EXCERPT_CONTEXT = 50;
const EXCERPT_TARGET = 160;
const EXCERPT_TEXT_LIMIT = 238; // Reserve room for two ellipses.

function clippedWordSegments(word, tokens, hasBefore, hasAfter) {
  const normalized = normalizeText(word);
  const token = tokens.find((value) => normalized.includes(value));
  const offset = token ? normalized.indexOf(token) : 0;
  const characters = Array.from(word);
  // Convert the normalized match offset back to original code points.
  let anchor = 0;
  let scanned = 0;
  while (anchor < characters.length && scanned < offset) scanned += normalizeText(characters[anchor++]).length;
  const start = Math.max(0, Math.min(anchor - EXCERPT_CONTEXT, characters.length - EXCERPT_TEXT_LIMIT));
  const end = Math.min(characters.length, start + EXCERPT_TEXT_LIMIT);
  const segments = [];
  if (hasBefore || start > 0) segments.push({ text: "…", highlight: false });
  segments.push({ text: characters.slice(start, end).join(""), highlight: Boolean(token) });
  if (hasAfter || end < characters.length) segments.push({ text: "…", highlight: false });
  return segments;
}

// All query tokens must match the haystack. Score: 2 per token found in the
// title, 1 elsewhere — so title matches float without hiding body matches.
// Keep whole words, accents and literal markup whenever they fit the window.
// As with server case results, React renders marked segments as text nodes.
function matchingSegments(source, tokens, excerpt = true) {
  const text = String(source || "");
  const parts = (excerpt ? text.trim() : text).split(/(\s+)/);
  const matches = (part) => tokens.some((token) => normalizeText(part).includes(token));
  const first = parts.findIndex(matches);
  let from = 0, to = parts.length;
  if (excerpt) {
    from = Math.max(0, first);
    to = from + 1;
    let length = parts[from].length;
    if (length > EXCERPT_TEXT_LIMIT) return clippedWordSegments(parts[from], tokens, from > 0, to < parts.length);

    let before = 0;
    while (from > 0 && before < EXCERPT_CONTEXT && length + parts[from - 1].length <= EXCERPT_TEXT_LIMIT) {
      const width = parts[--from].length;
      before += width;
      length += width;
    }
    if (from > 0 && !parts[from].trim()) length -= parts[from++].length;
    while (to < parts.length && length < EXCERPT_TARGET && length + parts[to].length <= EXCERPT_TEXT_LIMIT) {
      length += parts[to++].length;
    }
    if (to < parts.length && !parts[to - 1].trim()) to -= 1;
  }
  const segments = [];
  const append = (text, highlight) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last?.highlight === highlight) last.text += text;
    else segments.push({ text, highlight });
  };
  if (from > 0) append("…", false);
  for (const part of parts.slice(from, to)) append(part, matches(part));
  if (to < parts.length) append("…", false);
  return segments;
}

function matchingExcerpt(item, source, tokens) {
  const segments = matchingSegments(source, tokens);
  return {
    ...item,
    snippet: segments.map((segment) => segment.text).join(""),
    snippetSegments: segments,
    titleSegments: matchingSegments(item.title, tokens, false),
  };
}

function matchingMessageResult(item, tokens) {
  const messages = item.searchMessages || [];
  const message = messages.find(({ body }) => tokens.every((token) => normalizeText(body).includes(token)))
    || messages.find(({ body }) => tokens.some((token) => normalizeText(body).includes(token)));
  // Title-only matches keep the existing snippet (empty for guide threads),
  // and mark the title so the result identifies the field that matched.
  return {
    ...matchingExcerpt(item, message ? message.body : item.snippet, tokens),
    focus: message?.id ? { ...item.focus, messageId: message.id } : item.focus,
  };
}

export function searchEntries(entries, query, { limitPerType = 5, highlightLocal = false } = {}) {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const scored = [];
  for (const item of entries) {
    if (item.pinned) {
      scored.push({ item, score: PINNED_SCORE - (item.serverOrder ?? 0) });
      continue;
    }
    const title = normalizeText(item.title);
    let score = 0;
    let matched = true;
    for (const token of tokens) {
      if (title.includes(token)) score += 2;
      else if (item.haystack.includes(token)) score += 1;
      else { matched = false; break; }
    }
    if (matched) scored.push({ item: ["conversation", "guide"].includes(item.type) ? matchingMessageResult(item, tokens) : item, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const byType = new Map();
  for (const { item } of scored) {
    if (!byType.has(item.type)) byType.set(item.type, []);
    const bucket = byType.get(item.type);
    if (bucket.length >= limitPerType) continue;
    bucket.push(highlightLocal && !item.pinned && !item.snippetSegments
      ? matchingExcerpt(item, item.snippetSource ?? item.snippet, tokens)
      : item);
  }
  const groups = [];
  for (const type of TYPE_ORDER) {
    if (byType.has(type)) groups.push({ type, items: byType.get(type) });
  }
  return groups;
}
