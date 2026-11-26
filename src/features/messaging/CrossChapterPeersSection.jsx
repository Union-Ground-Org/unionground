// REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109 (#7666): a chapter
// lead (or a steward, where the organization enabled it) writes to the people
// with the same access level in the organization's other chapters: one, several
// or all of them. Each person gets their own two-person conversation; nobody
// sees who else was written to. The list comes in pages with a name or chapter
// search, so everyone is reachable; choices survive paging and searching. The
// person's own mute lives here too.
import { useEffect, useId, useRef, useState } from "react";
import { BusyButton, BusyInput } from "../../components/BusyControls.jsx";
import { prepareBusyWrite, runBusyWrite } from "../../lib/busyWrite.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { rpcErrorText } from "../../lib/rpcErrorText.js";
import { useRequestGeneration } from "../../lib/useRequestGeneration.js";
import { CROSS_CHAPTER_SEND_LIMIT, crossChapterPeerRole } from "./crossChapterPeers.js";
import "./crossChapterPeers.css";

export function CrossChapterPeersSection({ api, onSent, onOpen }) {
  const { t } = useLang();
  const ids = { body: useId(), limit: useId(), search: useId() };
  const [state, setState] = useState({ phase: "loading", data: null, query: "" });
  const [draftQuery, setDraftQuery] = useState("");
  const [more, setMore] = useState({ loading: false, failed: false });
  const [selected, setSelected] = useState(() => new Map());
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [outcome, setOutcome] = useState(null);
  // Every list read (first load, search, retry) starts a new generation; a
  // page or list that answers for an older one is dropped (Sol final
  // G6-8095-2), so a slow Show more never lands under a newer search.
  const requests = useRequestGeneration(api);

  function load(query = state.query) {
    const request = requests.begin();
    setState({ phase: "loading", data: null, query });
    setMore({ loading: false, failed: false });
    return Promise.resolve().then(() => api.load({ query }))
      .then((data) => { if (request.isCurrent()) setState({ phase: "ready", data, query }); })
      .catch(() => { if (request.isCurrent()) setState({ phase: "error", data: null, query }); });
  }
  useEffect(() => {
    const request = requests.begin();
    // A new api starts over, as a new search does: the old rows, search and
    // next page go, and a Show more still in flight for the old one is
    // dropped, so its button must not stay busy (Grok deltas on #8095).
    setState({ phase: "loading", data: null, query: "" });
    setDraftQuery("");
    setMore({ loading: false, failed: false });
    Promise.resolve().then(() => api.load({ query: "" }))
      .then((data) => { if (request.isCurrent()) setState({ phase: "ready", data, query: "" }); })
      .catch(() => { if (request.isCurrent()) setState({ phase: "error", data: null, query: "" }); });
  }, [api, requests]);

  if (state.phase === "loading") return <p role="status">{t("crossChapter.loading")}</p>;
  if (state.phase === "error") {
    return <div className="officer-contact">
      <p role="alert">{t("crossChapter.error")}</p>
      <button type="button" className="dialog-secondary" onClick={() => void load()}>{t("crossChapter.retry")}</button>
    </div>;
  }

  const { peers, muted, nextOffset } = state.data;
  const chosen = [...selected.values()];
  const room = CROSS_CHAPTER_SEND_LIMIT - selected.size;
  const unchosen = peers.filter((peer) => !selected.has(peer.id));
  const allShown = peers.length > 0 && unchosen.length === 0;
  const full = room <= 0;

  function toggle(peer, on) {
    setOutcome(null);
    setSelected((current) => {
      const next = new Map(current);
      if (on && next.size < CROSS_CHAPTER_SEND_LIMIT) next.set(peer.id, peer);
      if (!on) next.delete(peer.id);
      return next;
    });
  }
  function toggleAll(on) {
    setOutcome(null);
    setSelected((current) => {
      const next = new Map(current);
      if (on) for (const peer of peers) { if (next.size >= CROSS_CHAPTER_SEND_LIMIT) break; next.set(peer.id, peer); }
      else for (const peer of peers) next.delete(peer.id);
      return next;
    });
  }
  async function loadMore() {
    if (more.loading || nextOffset == null) return;
    const request = requests.capture();
    setMore({ loading: true, failed: false });
    try {
      const page = await api.load({ query: state.query, offset: nextOffset });
      if (!request.isCurrent()) return;
      setState((current) => {
        if (!request.isCurrent() || !current.data) return current;
        const seen = new Set(current.data.peers.map((peer) => peer.id));
        return { ...current, data: { ...current.data, peers: [...current.data.peers, ...page.peers.filter((peer) => !seen.has(peer.id))], nextOffset: page.nextOffset } };
      });
      setMore({ loading: false, failed: false });
    } catch {
      if (request.isCurrent()) setMore({ loading: false, failed: true });
    }
  }
  function send(event) {
    return prepareBusyWrite(busyWriteRef, "send", () => {
      event.preventDefault();
      const text = body.trim();
      if (!text || chosen.length === 0 || sending) return undefined;
      return () => sendNow(text);
    }, event);
  }
  async function sendNow(text) {
    setSending(true);
    setOutcome(null);
    try {
      const result = await api.send(chosen.map((peer) => peer.id), text);
      // A send superseded by an account change resolves to nothing.
      if (!result) return;
      onSent?.(result);
      const conversations = Array.isArray(result?.conversations) ? result.conversations : [];
      setOutcome({ kind: "sent", count: conversations.length, conversationId: conversations.length === 1 ? conversations[0].id : null });
      setSelected(new Map());
      setBody("");
    } catch (error) {
      setOutcome({ kind: "error", text: rpcErrorText(t, error, "crossChapter.sendFailed") });
    } finally {
      setSending(false);
    }
  }
  function setMute(next) {
    return runBusyWrite(busyWriteRef, "mute", () => setMuteNow(next));
  }

  async function setMuteNow(next) {
    if (muteBusy) return;
    setMuteBusy(true);
    try {
      const result = await api.setMute(next);
      setState((current) => ({ ...current, data: { ...current.data, muted: result?.muted === true } }));
    } catch (error) {
      setOutcome({ kind: "error", text: rpcErrorText(t, error, "crossChapter.muteFailed") });
    } finally {
      setMuteBusy(false);
    }
  }

  return (
    <section className="officer-contact cross-chapter" aria-label={t("crossChapter.title")}>
      <p className="peer-contact__privacy">{t("crossChapter.body")}</p>
      <form className="cross-chapter__search" role="search" onSubmit={(event) => { event.preventDefault(); void load(draftQuery.trim()); }}>
        <label htmlFor={ids.search}>{t("crossChapter.search")}</label>
        <input id={ids.search} className="xus-input" type="search" maxLength={80} value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} />
        <button type="submit" className="dialog-secondary">{t("crossChapter.searchButton")}</button>
      </form>
      {peers.length === 0 && <p className="peer-contact__quiet">{state.query ? t("crossChapter.noMatch", { query: state.query }) : t("crossChapter.empty")}</p>}
      {(peers.length > 0 || chosen.length > 0) && <form onSubmit={send}>
        {peers.length > 0 && <fieldset className="cross-chapter__people" aria-describedby={ids.limit}>
          <legend>{t("crossChapter.pick")}</legend>
          <p id={ids.limit} className="peer-contact__quiet">{t("crossChapter.limit", { count: CROSS_CHAPTER_SEND_LIMIT })}</p>
          <label className="cross-chapter__person cross-chapter__person--all">
            <input type="checkbox" checked={allShown} disabled={!allShown && full} onChange={(event) => toggleAll(event.target.checked)} />
            <span><strong>{unchosen.length > room && !allShown ? t("crossChapter.selectFirst", { count: Math.max(room, 0) }) : t("crossChapter.selectAll", { count: peers.length })}</strong></span>
          </label>
          <ul className="officer-contact__list">
            {peers.map((peer) => {
              const checked = selected.has(peer.id);
              return <li key={peer.id}>
                <label className="cross-chapter__person">
                  <input type="checkbox" checked={checked} disabled={!checked && full} onChange={(event) => toggle(peer, event.target.checked)} />
                  <span>
                    <strong>{peer.name}</strong>
                    <small>{[crossChapterPeerRole(peer, t), peer.chapters.join(", ")].filter(Boolean).join(" · ")}</small>
                  </span>
                </label>
              </li>;
            })}
          </ul>
          {nextOffset != null && <button type="button" className="dialog-secondary" disabled={more.loading} onClick={() => void loadMore()}>{more.loading ? t("crossChapter.loadingMore") : t("crossChapter.more")}</button>}
          {more.failed && <p role="alert">{t("crossChapter.moreFailed")}</p>}
        </fieldset>}
        {chosen.length > 0 && <p className="peer-contact__quiet">{t("crossChapter.chosen", { names: chosen.map((peer) => peer.name).join(", ") })}</p>}
        <label className="xus-field xus-field--wide" htmlFor={ids.body}>
          <span>{t("crossChapter.message")}</span>
          <textarea id={ids.body} className="xus-input" rows={4} maxLength={4000} value={body} onChange={(event) => { setOutcome(null); setBody(event.target.value); }} />
        </label>
        <BusyButton type="submit" className="dialog-primary" pending={sending} disabled={chosen.length === 0 || !body.trim()}>
          {sending ? t("crossChapter.sending") : chosen.length === 1 ? t("crossChapter.sendOne", { name: chosen[0].name }) : t("crossChapter.sendMany", { count: chosen.length })}
        </BusyButton>
      </form>}
      {outcome?.kind === "sent" && <div role="status">
        <p>{outcome.count === 1 ? t("crossChapter.sentOne") : t("crossChapter.sentMany", { count: outcome.count })}</p>
        {outcome.conversationId && onOpen && <button type="button" className="dialog-secondary" onClick={() => onOpen(outcome.conversationId)}>{t("crossChapter.open")}</button>}
      </div>}
      {outcome?.kind === "error" && <p role="alert">{outcome.text}</p>}
      <label className="xus-field xus-field--check cross-chapter__mute">
        <BusyInput type="checkbox" checked={muted} pending={muteBusy} onChange={(event) => void setMute(event.target.checked)} />
        <span>{t("crossChapter.mute")}</span>
      </label>
      <p className="peer-contact__quiet">{t("crossChapter.muteHelp")}</p>
    </section>
  );
}
