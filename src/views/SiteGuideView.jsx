import { runBusyWrite } from "../lib/busyWrite.js";
import { BusyButton } from "../components/BusyControls.jsx";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import {
  RESTORE_DEFAULTS_DRAFT,
  SITE_GUIDE_LIMITS,
  SITE_GUIDE_MAX_STEPS,
  buildSiteGuide,
  filterSiteGuideSections,
  loadSiteGuide,
  normalizeSiteGuide,
  saveSiteGuide,
  siteGuideEnabled,
  siteGuideSearchWords,
  siteGuideStaffOnlyDesks,
} from "../lib/siteGuide.js";
import "./siteGuide.css";

// REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: "How to use this site" for
// every signed-in role (old /dashboard/guide). Sections follow the person's own
// navigation; an organization admin can replace the words for everyone.
// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 31): a search
// box narrows the sections and their page links, and a role paused by the staff
// two-step policy (`pausedRoles`) shows its desk section with a note, not links.
export function SiteGuideView({ client = null, configuration = null, roles = [], pausedRoles = [], demoNavigation = false, onNavigate }) {
  const { t, lang } = useLang();
  const [server, setServer] = useState(() => ({ status: client ? "loading" : "ready", ...normalizeSiteGuide(null) }));
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const next = await loadSiteGuide(client);
      setServer({ status: "ready", ...next });
    } catch {
      // The defaults are still a truthful guide; only the organization's own
      // wording and the editor are unavailable.
      setServer({ status: "ready", ...normalizeSiteGuide(null) });
    }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  const guide = useMemo(() => buildSiteGuide({ t, copy: server.copy, roles, pausedRoles, demoNavigation }), [t, server.copy, roles, pausedRoles, demoNavigation]);
  const shownSections = useMemo(() => filterSiteGuideSections(guide.sections, query, (item) => t(item.labelKey)), [guide.sections, query, t]);
  const searching = query.trim().length > 0;
  const hintWords = useMemo(() => siteGuideSearchWords(guide.sections, t, (item) => t(item.labelKey)), [guide.sections, t]);
  const hint = hintWords.length ? t("siteGuide.searchHint", { words: new Intl.ListFormat(lang, { type: "disjunction" }).format(hintWords) }) : "";
  const staffDesks = useMemo(
    () => (searching && shownSections.length === 0
      ? siteGuideStaffOnlyDesks({ t, copy: server.copy, roles, pausedRoles, demoNavigation, query: query.trim(), labelOf: (item) => t(item.labelKey) })
      : []),
    [searching, shownSections.length, t, server.copy, roles, pausedRoles, demoNavigation, query],
  );
  const loading = server.status === "loading";
  const enabled = siteGuideEnabled(configuration) && server.enabled !== false;
  const showGuide = !loading && enabled;
  const title = t("nav.siteGuide");

  const jump = (key) => {
    const target = document.getElementById(`site-guide-${key}`);
    target?.scrollIntoView?.({ block: "start" });
    target?.querySelector("h2")?.focus?.();
  };

  return (
    <section className="site-guide" aria-labelledby="site-guide-title">
      <header className="site-guide__header">
        <h1 id="site-guide-title">{title}</h1>
        {showGuide && guide.title !== title && <p className="site-guide__intro"><strong>{guide.title}</strong></p>}
        {showGuide && <p className="site-guide__intro">{guide.intro}</p>}
        {showGuide && server.canEdit && !editing && (
          <button type="button" className="site-guide__button site-guide__button--secondary" onClick={() => { setNotice(""); setEditing(true); }}>
            {t("siteGuide.edit")}
          </button>
        )}
      </header>
      <div className="site-guide__content" aria-busy={loading || undefined}>
        {loading && <p role="status">{t("siteGuide.loading")}</p>}
        {!loading && !enabled && <p>{t("siteGuide.off")}</p>}
        {!loading && !enabled && server.canEdit && <p className="site-guide__muted">{t("siteGuide.offAdmin")}</p>}
        {showGuide && <p className="site-guide__notice" role="status" aria-live="polite">{notice}</p>}
        {showGuide && (editing ? (
          <SiteGuideEditor
            guide={guide}
            copy={server.copy}
            onCancel={() => setEditing(false)}
            onSave={async (draft, success) => {
              try {
                await saveSiteGuide(client, draft);
                await load();
                setEditing(false);
                setNotice(success);
              } catch (error) {
                setNotice(error?.code === "42501" ? t("siteGuide.saveForbidden") : t("siteGuide.saveFailed"));
              }
            }}
          />
        ) : (
          <div className="site-guide__layout">
            <div className="site-guide__search" role="search">
              <label className="site-guide__field" htmlFor="site-guide-search"><span>{t("siteGuide.searchLabel")}</span></label>
              <div className="site-guide__search-row">
                <input
                  id="site-guide-search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={hint}
                  autoComplete="off"
                  maxLength={80}
                />
                {searching && (
                  <button type="button" className="site-guide__button site-guide__button--secondary" onClick={() => setQuery("")}>{t("siteGuide.searchClear")}</button>
                )}
              </div>
              <p className="site-guide__muted" aria-live="polite">
                {searching ? (shownSections.length === 0
                  ? (staffDesks.length
                    ? t("siteGuide.searchStaffOnly", { query: query.trim(), roles: new Intl.ListFormat(lang, { type: "disjunction" }).format(staffDesks) })
                    : t("siteGuide.searchEmpty", { query: query.trim() }))
                  : shownSections.length === 1 ? t("siteGuide.searchCountOne") : t("siteGuide.searchCount", { count: shownSections.length })) : ""}
              </p>
            </div>
            <nav className="site-guide__toc" aria-label={t("siteGuide.onThisPage")}>
              <p className="site-guide__toc-title">{t("siteGuide.onThisPage")}</p>
              {shownSections.map((section) => (
                <button type="button" key={section.key} className="site-guide__toc-link" onClick={() => jump(section.key)}>{section.label}</button>
              ))}
            </nav>
            <div className="site-guide__sections">
              {shownSections.map((section) => (
                <article key={section.key} id={`site-guide-${section.key}`} className="site-guide__section" aria-labelledby={`site-guide-${section.key}-title`}>
                  <h2 id={`site-guide-${section.key}-title`} tabIndex={-1}>{section.label}</h2>
                  <p className="site-guide__body">{section.body}</p>
                  {section.paused && <p className="site-guide__paused">{t("siteGuide.pausedNote")}</p>}
                  {section.steps.length > 0 && (
                    <ul className="site-guide__steps">
                      {section.steps.map((step) => <li key={step}>{step}</li>)}
                    </ul>
                  )}
                  {section.destinations.length > 0 && (
                    <ul className="site-guide__destinations" aria-label={t("siteGuide.destinations", { section: section.label })}>
                      {section.destinations.map((item) => (
                        <li key={`${item.key}:${item.sectionId}`}>
                          <button type="button" className="site-guide__link" onClick={() => onNavigate?.(item.viewKey, item.path, item.sectionId)}>
                            {t(item.labelKey)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
              <aside className="site-guide__help" aria-labelledby="site-guide-help-title">
                <h2 id="site-guide-help-title">{guide.helpTitle}</h2>
                <p className="site-guide__body">{guide.helpBody}</p>
              </aside>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SiteGuideEditor({ guide, copy, onCancel, onSave }) {
  const busyWriteRef = useRef(new Set());
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => ({
    title: copy?.title ?? "",
    intro: copy?.intro ?? "",
    helpTitle: copy?.helpTitle ?? "",
    helpBody: copy?.helpBody ?? "",
    sections: Object.fromEntries(guide.sections.map((section) => [section.key, {
      body: copy?.sections?.[section.key]?.body ?? "",
      steps: (copy?.sections?.[section.key]?.steps ?? []).join("\n"),
    }])),
  }));
  const set = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  const setSection = (key, field) => (event) => setDraft((current) => ({
    ...current,
    sections: { ...current.sections, [key]: { ...current.sections[key], [field]: event.target.value } },
  }));
  const submit = async (next, success) => {
    return runBusyWrite(busyWriteRef, "busy", async (releaseBusyWrite) => {
      setBusy(true);
      try { await onSave(next, success); } finally { setBusy(false);
        releaseBusyWrite();
      }
    });
  };
  return (
    <form className="site-guide__editor" aria-label={t("siteGuide.editorLabel")} onSubmit={(event) => { event.preventDefault(); void submit(draft, t("siteGuide.saved")); }}>
      <p className="site-guide__muted">{t("siteGuide.editorNote")}</p>
      <label className="site-guide__field"><span>{t("siteGuide.fieldTitle")}</span>
        <input value={draft.title} onChange={set("title")} maxLength={SITE_GUIDE_LIMITS.title} placeholder={guide.title} />
      </label>
      <label className="site-guide__field"><span>{t("siteGuide.fieldIntro")}</span>
        <textarea value={draft.intro} onChange={set("intro")} maxLength={SITE_GUIDE_LIMITS.intro} placeholder={guide.intro} rows={3} />
      </label>
      {guide.sections.map((section) => (
        <fieldset key={section.key} className="site-guide__fieldset">
          <legend>{section.label}</legend>
          <label className="site-guide__field"><span>{t("siteGuide.fieldBody")}</span>
            <textarea value={draft.sections[section.key]?.body ?? ""} onChange={setSection(section.key, "body")} maxLength={SITE_GUIDE_LIMITS.body} rows={3} placeholder={t(`siteGuide.section.${section.key}.body`)} />
          </label>
          <label className="site-guide__field"><span>{t("siteGuide.fieldSteps", { max: SITE_GUIDE_MAX_STEPS })}</span>
            <textarea value={draft.sections[section.key]?.steps ?? ""} onChange={setSection(section.key, "steps")} rows={3} placeholder={[1, 2].map((n) => t(`siteGuide.section.${section.key}.step${n}`)).join("\n")} />
          </label>
        </fieldset>
      ))}
      <label className="site-guide__field"><span>{t("siteGuide.fieldHelpTitle")}</span>
        <input value={draft.helpTitle} onChange={set("helpTitle")} maxLength={SITE_GUIDE_LIMITS.helpTitle} placeholder={guide.helpTitle} />
      </label>
      <label className="site-guide__field"><span>{t("siteGuide.fieldHelpBody")}</span>
        <textarea value={draft.helpBody} onChange={set("helpBody")} maxLength={SITE_GUIDE_LIMITS.helpBody} rows={3} placeholder={guide.helpBody} />
      </label>
      <div className="site-guide__actions">
        <BusyButton type="submit" className="site-guide__button" pending={busy}>{t("siteGuide.save")}</BusyButton>
        <BusyButton
          type="button"
          className="site-guide__button site-guide__button--secondary"
          pending={busy}
          onClick={() => { if (window.confirm(t("siteGuide.restoreConfirm"))) void submit(RESTORE_DEFAULTS_DRAFT, t("siteGuide.restored")); }}
        >
          {t("siteGuide.restore")}
        </BusyButton>
        <BusyButton type="button" className="site-guide__button site-guide__button--secondary" pending={busy} onClick={onCancel}>{t("siteGuide.cancel")}</BusyButton>
      </div>
    </form>
  );
}
