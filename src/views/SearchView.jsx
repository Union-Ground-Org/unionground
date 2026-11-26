import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../components/Primitives.jsx";
import { useAccessibleKnowledgeArticles } from "../features/knowledge/useAccessibleKnowledgeArticles.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { withLoadDeadline } from "../lib/loadDeadline.js";
import { buildSearchIndex, memberOpenableCaseEntries, mergeServerCaseEntries, searchEntries } from "../lib/searchIndex.js";
import { useMemberCaseSearch } from "../features/cases/useMemberCaseSearch.js";
import { CASE_SEARCH_MAX_LIMIT } from "../features/cases/caseSearchApi.js";
import { deadlineLabel, getChapterLeadership, getMemberOrganizationStructure } from "../lib/memberApi.js";
import { useDeviceParityState } from "../lib/deviceParity.js";

// Member search (PR8, gap J). The index starts with the data snapshot already
// in memory, then a live session replaces the boot-time 100-article window
// with a complete one-statement knowledge snapshot. Non-knowledge results and
// the initial knowledge window remain instant and available offline.
// Every result is a jump: the parent lands the member on the item itself
// (conversation open, case dialog up, lesson selected) via onOpenResult.
// Knowledge-base articles are the exception — their whole body is right here,
// so they expand in place instead of navigating anywhere.
// Search is an app-only surface — the prototype has no page for it — so the
// header is deliberately the quietest in-page form the app already uses
// (eyebrow + h1). The avatar/bell that used to ride along in ScreenHeader now
// live once, in the shell's global mobile top bar.
// A server snippet arrives as marked segments (public.search_member_cases wraps
// each match in sentinels, never in HTML), so the highlight is React nodes and
// the string never reaches dangerouslySetInnerHTML. Local excerpts use the same
// segments, and title-only matches mark the title.
function renderSnippet(item, title = false) {
  const segments = title ? item.titleSegments : item.snippetSegments;
  if (!segments?.length) return title ? item.title : item.snippet;
  return segments.map((segment, index) => (
    segment.highlight
      ? <mark key={`${item.id}-${index}`}>{segment.text}</mark>
      : segment.text
  ));
}

export function SearchView({ data, onOpenResult, onAskCompass, knowledgeClient = null, caseSearchClient = null, organizationStructureClient = knowledgeClient, chapterLeadershipClient = null, memberRequestsAvailable = false, dues = true }) {
  const { t, lang } = useLang();
  const [query, setQuery] = useDeviceParityState("search.query", "");
  const [openArticle, setOpenArticle] = useDeviceParityState("search.openArticle", null);
  const knowledgeScope = `${data.member?.id || ""}:${data.member?.organizationId || ""}:${data.member?.chapterId || ""}`;
  const [people, setPeople] = useState(null);
  // A failed people request retries on the member's next query edit, so one
  // transient error does not hide officers for the rest of the visit.
  const [peopleAttempt, setPeopleAttempt] = useState(0);
  const loadPeople = Boolean(organizationStructureClient && data.member?.id && data.member?.organizationId);
  useEffect(() => {
    if (!loadPeople) return undefined;
    let current = true;
    withLoadDeadline(getMemberOrganizationStructure(organizationStructureClient)).then(
      (structure) => { if (current) setPeople({ client: organizationStructureClient, scope: knowledgeScope, structure, phase: "ready" }); },
      () => { if (current) setPeople({ client: organizationStructureClient, scope: knowledgeScope, structure: null, phase: "error" }); },
    );
    return () => { current = false; };
  }, [organizationStructureClient, knowledgeScope, loadPeople, peopleAttempt]);
  // REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006:
  // the chapter's officers and administrators are people results too. The
  // roster loads on its own: until it arrives, or if it fails, the other people
  // results stand unchanged.
  const [leadership, setLeadership] = useState(null);
  const loadLeadership = Boolean(chapterLeadershipClient && data.member?.id && data.member?.chapterId);
  useEffect(() => {
    if (!loadLeadership) return undefined;
    let current = true;
    withLoadDeadline(getChapterLeadership(chapterLeadershipClient)).then(
      (roster) => { if (current) setLeadership({ client: chapterLeadershipClient, scope: knowledgeScope, roster }); },
      () => { if (current) setLeadership({ client: chapterLeadershipClient, scope: knowledgeScope, roster: null }); },
    );
    return () => { current = false; };
  }, [chapterLeadershipClient, knowledgeScope, loadLeadership]);
  const currentPeople = loadPeople && people?.client === organizationStructureClient && people.scope === knowledgeScope ? people : null;
  const peoplePhase = loadPeople ? currentPeople?.phase || "loading" : "idle";
  const memberOrgStructure = loadPeople ? currentPeople?.structure ?? data.memberOrgStructure ?? null : data.memberOrgStructure;
  const chapterLeadership = loadLeadership && leadership?.client === chapterLeadershipClient && leadership.scope === knowledgeScope
    ? leadership.roster
    : data.chapterLeadership ?? null;
  const { articles: knowledgeArticles, phase: knowledgePhase, retry: retryKnowledge } = useAccessibleKnowledgeArticles({
    client: knowledgeClient,
    fallbackArticles: data.kbArticles,
    publishedOnly: true,
    scopeKey: knowledgeScope,
  });
  const searchableData = useMemo(
    () => ({ ...data, kbArticles: knowledgeArticles, memberOrgStructure, chapterLeadership }),
    [data, knowledgeArticles, memberOrgStructure, chapterLeadership],
  );
  // t resolves the static form-template titles, so the index follows the
  // member's language (DB templates arrive pre-resolved by loadMemberApp).
  const index = useMemo(() => buildSearchIndex(searchableData, t, { memberRequests: memberRequestsAvailable, dues }), [searchableData, t, memberRequestsAvailable, dues]);
  const trimmed = query.trim();
  // Postgres matches stems the local substring scan cannot, so server rows
  // replace their local twin. The RPC also returns a steward's caseload and a
  // coordinator's queue, which this member page cannot open, so only the
  // member's own cases are kept. The local index still answers first and
  // still answers offline.
  const { entries: serverCases, phase: casePhase } = useMemberCaseSearch({
    client: caseSearchClient,
    query: trimmed,
    limit: CASE_SEARCH_MAX_LIMIT,
    formatDeadline: (value) => deadlineLabel(value, lang),
    t,
  });
  const openableCases = useMemo(() => memberOpenableCaseEntries(serverCases, data.cases), [serverCases, data.cases]);
  const searchIndex = useMemo(() => mergeServerCaseEntries(index, openableCases), [index, openableCases]);
  const groups = useMemo(() => searchEntries(searchIndex, query, { highlightLocal: true }), [searchIndex, query]);

  const kbBySlug = useMemo(
    () => new Map(knowledgeArticles.map((article) => [article.slug, article])),
    [knowledgeArticles],
  );

  function open(item) {
    if (item.focus.kb) {
      setOpenArticle((current) => (current === item.focus.kb ? null : item.focus.kb));
      return;
    }
    onOpenResult(item.focus);
  }

  return (
    <div className="screen">
      <header className="protohead">
        <span className="eyebrow">{t("search.eyebrow")}</span>
        <h1 className="protohead__title">{t("nav.search")}</h1>
      </header>
      <label className="search-box">
        <Search size={18} />
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (peoplePhase === "error") setPeopleAttempt((attempt) => attempt + 1);
          }}
          placeholder={t("search.placeholder")}
          aria-label={t("nav.search")}
          autoFocus
        />
      </label>
      {casePhase === "loading" && <p className="search-hint" role="status">{t("search.casesLoading")}</p>}
      {casePhase === "error" && <p className="form-error" role="alert">{t("search.casesLoadError")}</p>}
      {knowledgePhase === "loading" && <p className="search-hint" role="status">{t("search.knowledgeLoading")}</p>}
      {knowledgePhase === "error" && <div className="search-hint">
        <p className="form-error" role="alert">{t("search.knowledgeLoadError")}</p>
        <button type="button" className="dialog-secondary" onClick={retryKnowledge}>{t("app.tryAgain")}</button>
      </div>}
      {peoplePhase === "loading" && <p className="search-hint" role="status">{t("search.peopleLoading")}</p>}
      {peoplePhase === "error" && <div className="search-hint">
        <p className="form-error" role="alert">{t("search.peopleLoadError")}</p>
        <button type="button" className="dialog-secondary" onClick={() => { setPeople(null); setPeopleAttempt((value) => value + 1); }}>{t("app.tryAgain")}</button>
      </div>}
      {!trimmed && <p className="search-hint">{t("search.hint")}</p>}
      {trimmed && groups.length === 0 && [knowledgePhase, casePhase, peoplePhase].every((phase) => phase !== "loading" && phase !== "error") && <EmptyState>{t("search.empty", { query: trimmed })}</EmptyState>}
      {groups.map((group) => (
        <section className="search-group" key={group.type}>
          <h2 className="eyebrow">{t(`search.type.${group.type}`)}</h2>
          {group.items.map((item) => (
            <div key={item.id}>
              <button type="button" className="search-result" style={{ minHeight: 48, overflowWrap: "anywhere" }} onClick={() => open(item)} aria-expanded={item.focus.kb ? openArticle === item.focus.kb : undefined}>
                <span><strong>{renderSnippet(item, true)}</strong>{item.snippet && <small style={item.snippetSegments?.length ? { whiteSpace: "normal" } : undefined}>{renderSnippet(item)}</small>}</span>
                {item.meta && <span className="search-result__meta">{item.meta}</span>}
              </button>
              {item.focus.kb && openArticle === item.focus.kb && kbBySlug.has(item.focus.kb) && (
                <article className="search-article">
                  <span className="eyebrow">{kbBySlug.get(item.focus.kb).ref}</span>
                  <p>{kbBySlug.get(item.focus.kb).body}</p>
                </article>
              )}
            </div>
          ))}
        </section>
      ))}
      {trimmed && onAskCompass && (
        <button type="button" className="search-ask" onClick={() => onAskCompass(trimmed)}>
          {t("search.askCompass", { query: trimmed })}
        </button>
      )}
    </div>
  );
}
