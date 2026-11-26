import { useCallback, useEffect, useRef, useState } from "react";
import { AnnouncementDrafts } from "../../components/AnnouncementDrafts.jsx";
import { dateTimeFormat } from "../../lib/i18n.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { NOTICE_AUDIENCE_UNAVAILABLE } from "../../lib/noticeAudience.js";
import { createNoticeDraft, noticeKeyReused } from "../../lib/noticePublishKey.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: officers could
// not post a notice that members mark as read. Under the Announcements tab, a
// steward, admin or president posts a notice to their chapter or (with an
// organization role) the whole organization; members read it in the same tab,
// and the poster sees how many read it and who. Event drafts land here too.
// The server decides every permission; this card only offers what it allows.

export const NOTICE_HATS = Object.freeze(["steward", "admin", "vp"]);
// Where the desk lives: the Announcements filter of the inbox.
export const NOTICE_COMPOSER_PATH = "/m/messages?filter=announcement";

function readerTime(value, lang) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function NoticeReceipts({ api, notice, onCounts }) {
  const { t, lang } = useLang();
  const [state, setState] = useState({ status: "closed", readers: [] });
  // Each opening is one request; closing or reopening makes an answer still
  // in flight stale, so it cannot reopen or overwrite the panel.
  const requestRef = useRef(0);
  async function toggle() {
    const request = requestRef.current + 1;
    requestRef.current = request;
    if (state.status !== "closed") {
      setState({ status: "closed", readers: [] });
      return;
    }
    setState({ status: "loading", readers: [] });
    try {
      const receipts = await api.receipts(notice.id);
      if (requestRef.current !== request) return;
      setState({ status: "ready", readers: receipts.readers });
      // The reader list is the freshest count; keep the line above it in step.
      onCounts(notice.id, receipts);
    } catch {
      if (requestRef.current === request) setState({ status: "failed", readers: [] });
    }
  }
  const listId = `notice-readers-${notice.id}`;
  return <div className="officer-notices__receipts">
    <button type="button" className="cwk-btn cwk-btn--ghost" aria-expanded={state.status !== "closed"} aria-controls={listId} onClick={() => void toggle()}>
      {t(state.status === "closed" ? "notices.showReaders" : "notices.hideReaders")}
    </button>
    {state.status !== "closed" && <div id={listId} role="status">
      {state.status === "loading" && <p className="cwk-empty">{t("notices.readersLoading")}</p>}
      {state.status === "failed" && <p className="cwk-empty">{t("notices.readersUnavailable")}</p>}
      {state.status === "ready" && state.readers.length === 0 && <p className="cwk-empty">{t("notices.readersEmpty")}</p>}
      {state.status === "ready" && state.readers.length > 0 && <ul className="officer-notices__readers">
        {state.readers.map((reader, index) => <li key={`${reader.readAt}:${index}`}>
          <strong>{reader.name || t("notices.readerUnnamed")}</strong> <span className="cwk-time">{readerTime(reader.readAt, lang)}</span>
        </li>)}
      </ul>}
    </div>}
  </div>;
}

export function OfficerNoticeDesk({ api, canPostOrganization = false, chapterAudienceLabel = null, onNotice = () => {} }) {
  const { t, lang } = useLang();
  const composerRef = useRef(null);
  const [busy, setBusy] = useState(false);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [activeDraftId, setActiveDraftId] = useState(null);
  const [draftsRevision, setDraftsRevision] = useState(0);
  // The notice being written has one operation key from its first Post until
  // it is confirmed posted (#9220): a Post pressed again after a lost reply is
  // the same operation. Leaving the desk, another account, hat or chapter (a
  // new api) and loading an event draft each start a new notice.
  const noticeDraft = useRef(null);
  noticeDraft.current ??= createNoticeDraft();
  useEffect(() => { noticeDraft.current.cancel(); }, [api]);
  const [audiences, setAudiences] = useState({ status: "loading", options: [] });
  const audienceGeneration = useRef(0);
  const loadAudiences = useCallback(async () => {
    const generation = ++audienceGeneration.current;
    setAudiences({ status: "loading", options: [] });
    try {
      const options = await api.loadAudiences();
      if (generation === audienceGeneration.current) setAudiences({ status: "ready", options: options.filter((option) => option.kind !== "organization" || canPostOrganization) });
    } catch {
      if (generation === audienceGeneration.current) setAudiences({ status: "failed", options: [] });
    }
  }, [api, canPostOrganization]);
  useEffect(() => {
    void loadAudiences();
    return () => { audienceGeneration.current += 1; };
  }, [loadAudiences]);
  const [mine, setMine] = useState({ status: "loading", notices: [], hasMore: false, olderBusy: false, olderFailed: false });

  // A reload starts a new list; an older page asked for under the previous
  // list must not be appended to the new one.
  const listGenerationRef = useRef(0);
  const reload = useCallback(async () => {
    const generation = listGenerationRef.current + 1;
    listGenerationRef.current = generation;
    try {
      const page = await api.listMine(null);
      if (listGenerationRef.current !== generation) return;
      setMine({ status: "ready", notices: page.notices, hasMore: page.hasMore, olderBusy: false, olderFailed: false });
    } catch {
      if (listGenerationRef.current === generation) setMine({ status: "failed", notices: [], hasMore: false, olderBusy: false, olderFailed: false });
    }
  }, [api]);

  async function loadOlder() {
    const last = mine.notices.at(-1);
    if (!last || mine.olderBusy) return;
    const generation = listGenerationRef.current;
    setMine((current) => ({ ...current, olderBusy: true, olderFailed: false }));
    try {
      const page = await api.listMine({ publishedAt: last.publishedAt, id: last.id });
      if (listGenerationRef.current !== generation) return;
      setMine((current) => {
        const known = new Set(current.notices.map((notice) => notice.id));
        return { ...current, notices: [...current.notices, ...page.notices.filter((notice) => !known.has(notice.id))], hasMore: page.hasMore, olderBusy: false };
      });
    } catch {
      if (listGenerationRef.current === generation) setMine((current) => ({ ...current, olderBusy: false, olderFailed: true }));
    }
  }
  useEffect(() => { void reload(); }, [reload]);
  const updateCounts = useCallback((id, receipts) => {
    setMine((current) => ({
      ...current,
      notices: current.notices.map((notice) => (notice.id === id ? {
        ...notice,
        readCount: receipts.readCount ?? notice.readCount,
        audienceCount: receipts.audienceCount ?? notice.audienceCount,
      } : notice)),
    }));
  }, []);

  function publish(event) {
    return runBusyWrite(busyWriteRef, "publish", () => publishNow(event), event);
  }

  async function publishNow(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const title = String(formData.get("title") || "").trim();
    const body = String(formData.get("body") || "").trim();
    const locale = formData.get("locale") === "es" ? "es" : "en";
    const audience = String(formData.get("audience") || "");
    if (!title || !body || busy || audiences.status !== "ready" || !audiences.options.some((option) => option.value === audience)) return;
    setBusy(true);
    try {
      await api.publish(title, body, locale, audience, noticeDraft.current.start());
      noticeDraft.current.confirm();
      if (activeDraftId && api.resolveDraft) {
        await Promise.resolve(api.resolveDraft(activeDraftId, "published")).catch(() => null);
        setActiveDraftId(null);
        setDraftsRevision((value) => value + 1);
      }
      form.reset();
      onNotice(t("notices.published"));
      await reload();
    } catch (error) {
      if (noticeKeyReused(error)) {
        // The server holds this draft's first version, already posted, and
        // refused the edited one: say so, and let Post send the edit as a
        // new notice.
        noticeDraft.current.cancel();
        onNotice(t("notices.firstVersionPosted"));
        void reload();
      } else if (error?.code === NOTICE_AUDIENCE_UNAVAILABLE) {
        setAudiences({ status: "ready", options: [] });
        onNotice(t("notices.audienceUnavailable"));
      } else onNotice(t("notices.publishFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <section className="cwk-card officer-notices" aria-labelledby="officer-notices-title">
    <h2 id="officer-notices-title" className="cwk-card__title">{t("notices.title")}</h2>
    <p className="cwk-card__note">{t("notices.sub")}</p>
    <AnnouncementDrafts api={api} busy={busy} refreshKey={draftsRevision} onUse={(draft) => {
      const form = composerRef.current;
      if (!form) return;
      form.elements.title.value = draft.title;
      form.elements.body.value = draft.body;
      noticeDraft.current.cancel();
      setActiveDraftId(draft.id);
      form.elements.title.focus();
    }} />
    <form className="cwk-form" onSubmit={publish} ref={composerRef} aria-label={t("notices.title")}>
      <label className="cwk-form__label">{t("notices.titleLabel")}<input name="title" maxLength="120" required /></label>
      <label className="cwk-form__label">{t("notices.bodyLabel")}<textarea name="body" maxLength="4000" required /></label>
      <label className="cwk-form__label">{t("notices.localeLabel")}
        <select name="locale" defaultValue={lang === "es" ? "es" : "en"}>
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </label>
      <fieldset className="cwk-form__label">
        <legend>{t("notices.audienceLabel")}</legend>
        {audiences.status === "loading" && <p role="status">{t("notices.audienceLoading")}</p>}
        {audiences.status === "failed" && <p role="alert">{t("notices.audienceLoadFailed")}</p>}
        {audiences.status === "ready" && audiences.options.length === 0 && <p role="status">{t("notices.audienceUnavailable")}</p>}
        {audiences.options.map((option, index) => <label key={option.value}><input type="radio" name="audience" value={option.value} defaultChecked={index === 0} /> {option.kind === "chapter" ? chapterAudienceLabel || t("notices.audienceChapter") : option.kind === "organization" ? t("notices.audienceOrganization") : t(option.kind === "unit" ? "notices.audienceUnit" : "notices.audienceCommittee", { name: option.name })}</label>)}
        {(audiences.status === "failed" || (audiences.status === "ready" && audiences.options.length === 0)) && <BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={busy} onClick={() => void loadAudiences()}>{t("notices.reloadAudiences")}</BusyButton>}
      </fieldset>
      <p className="cwk-card__note">{t("notices.limit")}</p>
      <BusyButton className="cwk-btn cwk-btn--green cwk-btn--wide" pending={busy} disabled={audiences.status !== "ready" || audiences.options.length === 0}>{busy ? t("notices.publishing") : t("notices.publish")}</BusyButton>
    </form>
    <div className="officer-notices__mine-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <h3 className="cwk-card__title">{t("notices.mineTitle")}</h3>
      <button type="button" className="cwk-btn cwk-btn--ghost" onClick={() => void reload()}>{t("notices.refresh")}</button>
    </div>
    {mine.status === "failed" && <p className="cwk-empty" role="status">{t("notices.mineUnavailable")}</p>}
    {mine.status === "ready" && mine.notices.length === 0 && <p className="cwk-empty">{t("notices.mineEmpty")}</p>}
    {mine.status === "ready" && mine.notices.length > 0 && <ul className="officer-notices__mine">
      {mine.notices.map((notice) => <li key={notice.id} className="cwk-row">
        <div className="cwk-row__main">
          <div className="cwk-row__top">
            <span className="cwk-name">{notice.title}</span>
            <span className="cwk-chip">{t(`notices.audienceChip.${notice.audience}`)}</span>
            {notice.retracted && <span className="cwk-chip cwk-chip--rest">{t("notices.retracted")}</span>}
          </div>
          {notice.readCount != null && <p className="cwk-note">{notice.audienceCount != null
            ? t("notices.readOf", { read: notice.readCount, total: notice.audienceCount })
            : t("notices.readCount", { read: notice.readCount })}</p>}
          <NoticeReceipts api={api} notice={notice} onCounts={updateCounts} />
        </div>
      </li>)}
    </ul>}
    {mine.status === "ready" && mine.olderFailed && <p className="cwk-empty" role="status">{t("notices.olderUnavailable")}</p>}
    {mine.status === "ready" && mine.hasMore && <BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={mine.olderBusy} onClick={() => void loadOlder()}>
      {t(mine.olderBusy ? "notices.olderLoading" : "notices.older")}
    </BusyButton>}
  </section>;
}

// A member acting as Member who holds a role that may post notices: say so
// and offer to act in that role here, as the other authoring pages do.
export function OfficerNoticeHint({ hats, onWear }) {
  const { t } = useLang();
  const labels = { steward: "demo.hatSteward", admin: "demo.hatAdmin", vp: "demo.hatVp" };
  const offered = hats.filter((hat) => labels[hat]);
  if (!offered.length || typeof onWear !== "function") return null;
  return <div className="staff-authoring-hint" role="note">
    <p>{t("notices.wearToPost")}</p>
    <div className="staff-authoring-hint__actions" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
      {offered.map((hat) => <button key={hat} type="button" onClick={() => onWear(hat)}>
        {t("staffAuthoring.wearHat", { hat: t(labels[hat]) })}
      </button>)}
    </div>
  </div>;
}
