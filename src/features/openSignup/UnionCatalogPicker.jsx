import { useEffect, useId, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { BusyButton, BusyFieldset, BusyInput } from "../../components/BusyControls.jsx";
import {
  CATALOG_KEY_PATTERN, cleanCatalogQuery, loadCatalogProfile, numberedLabel, probeCatalogStatus, searchCatalog,
} from "../unionCatalog/catalogSearch.js";
import "./unionCatalogPicker.css";

// REQ-UG-SIGNUP-UNION-CATALOG-PICKER-20261109: the first organization
// screen finds the creator's union and local in the union catalog, then asks
// what the new organization represents: the local-wide organization (reserved
// for the official local, official only after verification) or one of the
// local's chapters. A choice only suggests a name and the local to set up
// under; it grants no role and no verified status. Typing a name stays the
// fallback when the catalog is unavailable or has no match.
const CHAPTER_KINDS = new Set(["chapter", "unit", "bargaining_unit", "retiree_chapter"]);
const QUERY_MIN = 2;
const OTHER_CHAPTER = "other-chapter";
const QUERY_MAX = 80;

// Catalog locals only (the claim and setup paths need a catalog key, and a
// national or intermediate body is not a local), with the local number,
// designation and place that tell same-named locals apart.
async function searchLocals(client, query) {
  const { rows } = await searchCatalog(client, { p_query: query, p_state: null, p_family: null, p_tier: null, p_page: 1 });
  return rows.filter((row) => CATALOG_KEY_PATTERN.test(row.key) && !row.registryOnly && row.level === "local");
}

// Query bounds count characters, not UTF-16 code units.
function characters(value) {
  return [...value].length;
}

function rowDetail(t, row) {
  return [numberedLabel(t, row), [row.city, row.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
}

// pending: the host's create is running; the picker stays focusable and
// refuses changes until it settles (#8435). disabled: the host is done.
export function UnionCatalogPicker({ client, disabled = false, pending = false, onChoose }) {
  const { t } = useLang();
  const ids = useId();
  const catalog = useRef(null);
  const request = useRef(0);
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState("idle");
  const [rows, setRows] = useState([]);
  const [local, setLocal] = useState(null);
  const [chapters, setChapters] = useState({ phase: "idle", list: [] });
  const [choice, setChoice] = useState("");
  const cleanedQuery = [...cleanCatalogQuery(query)].slice(0, QUERY_MAX).join("");
  const queryTooShort = characters(cleanedQuery) < QUERY_MIN;
  const showSearchMinimum = !disabled && !pending && phase !== "searching" && queryTooShort;
  const searchStatusId = `${ids}-search-status`;
  // Where focus goes after the view swaps: the choices after a local is
  // picked, the search box after "Choose a different union".
  const focusNext = useRef(null);
  const legendRef = useRef(null);
  const searchRef = useRef(null);
  useEffect(() => {
    if (focusNext.current === "legend" && local) legendRef.current?.focus();
    if (focusNext.current === "search" && !local) searchRef.current?.focus();
    focusNext.current = null;
  }, [local]);

  async function catalogLive() {
    catalog.current ??= probeCatalogStatus(client).then((probe) => probe.catalog === "live");
    return catalog.current;
  }

  async function search(event) {
    event.preventDefault();
    if (disabled || queryTooShort) return;
    const mine = ++request.current;
    setPhase("searching");
    try {
      if (!(await catalogLive())) { if (mine === request.current) setPhase("unavailable"); return; }
    } catch {
      if (mine === request.current) setPhase("unavailable");
      return;
    }
    // The directory is up; a failed search is its own state, with a retry.
    try {
      const found = await searchLocals(client, cleanedQuery);
      if (mine !== request.current) return;
      setRows(found);
      setPhase(found.length ? "results" : "none");
    } catch {
      if (mine === request.current) setPhase("failed");
    }
  }

  async function loadChapters(row) {
    const mine = ++request.current;
    setChapters({ phase: "loading", list: [] });
    try {
      const profile = await loadCatalogProfile(client, row.key);
      if (mine !== request.current) return;
      if (!profile.found) throw new Error("profile_not_found");
      const list = profile.subunits.filter((unit) => CHAPTER_KINDS.has(unit.kind) && unit.name)
        .sort((left, right) => left.name.localeCompare(right.name));
      setChapters({ phase: "ready", list });
    } catch {
      // A failed read is not an empty list: say so and offer a retry.
      if (mine === request.current) setChapters({ phase: "failed", list: [] });
    }
  }

  function pickLocal(row) {
    focusNext.current = "legend";
    setLocal(row);
    setChoice("");
    onChoose(null);
    loadChapters(row);
  }

  function choose(value) {
    if (!local) return;
    setChoice(value);
    if (value === "local") {
      onChoose({ unionKey: local.key, scope: "local_wide", name: local.name });
      return;
    }
    // A chapter the directory does not list: the local still rides along, and
    // the creator types the chapter's name.
    if (value === OTHER_CHAPTER) {
      onChoose({ unionKey: local.key, scope: "chapter", chapterKey: null, name: null });
      return;
    }
    const chapter = chapters.list.find((unit) => unit.key === value);
    if (chapter) onChoose({ unionKey: local.key, scope: "chapter", chapterKey: chapter.key, name: chapter.name });
  }

  function startOver() {
    focusNext.current = "search";
    request.current += 1;
    setLocal(null);
    setChoice("");
    setChapters({ phase: "idle", list: [] });
    onChoose(null);
  }

  const reservedId = `${ids}-reserved`;
  return (
    <section className="create-org-picker" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>{t("createOrg.pick.title")}</h2>
      <p>{t("createOrg.pick.help")}</p>
      {!local && <>
        <form role="search" onSubmit={search} aria-label={t("createOrg.pick.title")}>
          <label>
            <span>{t("createOrg.pick.search")}</span>
            <div><BusyInput ref={searchRef} name="unionSearch" type="search" autoComplete="off" value={query} pending={pending} disabled={disabled} aria-describedby={showSearchMinimum ? searchStatusId : undefined} onChange={(event) => setQuery(event.target.value)} /></div>
          </label>
          <BusyButton className="auth-switch" type="submit" pending={pending || phase === "searching"} disabled={disabled || queryTooShort}>
            {phase === "searching" ? t("createOrg.pick.searching") : t("createOrg.pick.searchButton")}
          </BusyButton>
        </form>
        <p id={searchStatusId} aria-live="polite" className="create-org-picker__status">
          {showSearchMinimum ? t("unions.searchMinimum", { count: QUERY_MIN })
            : phase === "none" ? t("createOrg.pick.none")
            : phase === "unavailable" ? t("createOrg.pick.unavailable")
              : phase === "failed" ? t("createOrg.pick.searchFailed")
              : phase === "results" ? t(rows.length === 1 ? "createOrg.pick.foundOne" : "createOrg.pick.found", { count: rows.length })
                : ""}
        </p>
        {phase === "results" && <ul className="create-org-picker__results" aria-label={t("createOrg.pick.results")}>
          {rows.map((row) => <li key={row.key}>
            <BusyButton type="button" className="auth-switch" pending={pending} disabled={disabled} onClick={() => pickLocal(row)}>
              <span lang="en">{row.name}</span>{rowDetail(t, row) && <small> · {rowDetail(t, row)}</small>}
            </BusyButton>
          </li>)}
        </ul>}
      </>}
      {local && <BusyFieldset pending={pending} disabled={disabled}>
        <legend tabIndex={-1} ref={legendRef}>{t("createOrg.pick.represent", { local: local.name })}</legend>
        <label className="create-org-picker__option">
          <input type="radio" name="represents" value="local" checked={choice === "local"} aria-describedby={reservedId} onChange={() => choose("local")} />
          <span>{t("createOrg.pick.localWide", { local: local.name })}</span>
        </label>
        <p className="auth-requirements" id={reservedId}>{t("createOrg.pick.reserved")}</p>
        {chapters.phase === "loading" && <p role="status">{t("createOrg.pick.loading")}</p>}
        {chapters.phase === "failed" && <div role="alert">
          <p>{t("createOrg.pick.chaptersFailed")}</p>
          <button type="button" className="auth-switch" onClick={() => loadChapters(local)}>{t("createOrg.pick.retry")}</button>
        </div>}
        {chapters.phase === "ready" && !chapters.list.length && <p role="status">{t("createOrg.pick.noChapters")}</p>}
        {(chapters.phase === "ready" || chapters.phase === "failed") && <div role="group" aria-label={t("createOrg.pick.chapter", { local: local.name })}>
          {chapters.list.map((unit) => <label key={unit.key} className="create-org-picker__option">
            <input type="radio" name="represents" value={unit.key} checked={choice === unit.key} onChange={() => choose(unit.key)} />
            <span lang="en">{unit.name}</span>
          </label>)}
          <label className="create-org-picker__option">
            <input type="radio" name="represents" value={OTHER_CHAPTER} checked={choice === OTHER_CHAPTER} onChange={() => choose(OTHER_CHAPTER)} />
            <span>{t("createOrg.pick.otherChapter", { local: local.name })}</span>
          </label>
        </div>}
        <button type="button" className="auth-switch" onClick={startOver}>{t("createOrg.pick.change")}</button>
      </BusyFieldset>}
    </section>
  );
}
