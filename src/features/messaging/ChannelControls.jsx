// Responsive-web surfaces for the chapter channel controls
// (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001): the per-channel settings
// dialog, highlighted post bodies, the mention picker and mention search.
// Every control is shown only when the organization switch is on, and every
// change is confirmed by the server before it is shown as saved.
import { useEffect, useId, useRef, useState } from "react";
import { BusyButton, BusyInput, BusySelect } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { AtSign, BellOff, Pin, Search } from "lucide-react";
import { Dialog } from "../../components/Dialog.jsx";
import { ReminderTimePicker } from "../../components/ReminderTimePicker.jsx";
import { RadioGroup } from "../../components/RadioGroup.jsx";
import {
  CHANNEL_MUTE_DURATIONS,
  CHANNEL_NOTIFICATION_LEVELS,
  channelSettingFor,
  isChannelControlDisabled,
  isKeywordLimitError,
  isMuteActive,
  keywordListProblem,
  muteUntilFor,
  normalizeKeywords,
  segmentChannelText,
} from "./channelControls.js";
import { formatDateTimeWithZone } from "../../lib/i18n.js";
import { inReaderLanguage } from "../../lib/bilingualContent.js";

function errorCopy(t, error, fallbackKey) {
  if (isChannelControlDisabled(error)) return t("channelControls.turnedOff");
  if (isKeywordLimitError(error)) return t("channelControls.keywordLimitReached");
  return t(fallbackKey);
}

export function channelHasAnyControl(controls) {
  const s = controls?.switches || {};
  return Boolean(controls?.available && (s.notificationLevels || s.channelMute || s.keywordAlerts));
}

// The member's own notification choices for one channel.
export function ChannelSettingsDialog({ t, lang, space, controls, api, onSaved, onClose }) {
  const setting = channelSettingFor(controls, space.id);
  const switches = controls.switches;
  const [busy, setBusy] = useState("");
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [duration, setDuration] = useState("8h");
  const [keywordDraft, setKeywordDraft] = useState("");
  const levelLabelId = useId();
  const keywordInputId = useId();
  const elsewhere = Math.max(0, controls.keywordCount - setting.keywords.length);

  function save(kind, action) {
    return runBusyWrite(busyWriteRef, "channel", (unlock) => saveNow(kind, action, unlock));
  }

  // Resolves true only when the server took the change, so a caller keeps
  // what the person typed after a failure (#9469).
  async function saveNow(kind, action, unlock) {
    if (busy) return false;
    setBusy(kind);
    setError("");
    setStatus("");
    try {
      const saved = await action();
      onSaved(space.id, saved);
      setStatus(t("channelControls.saved"));
      return true;
    } catch (cause) {
      setError(errorCopy(t, cause, "channelControls.saveFailed"));
      return false;
    } finally {
      setBusy("");
      unlock();
    }
  }

  function addKeyword(event) {
    event.preventDefault();
    const next = normalizeKeywords([...setting.keywords, keywordDraft]);
    const problem = keywordListProblem(next, { elsewhere, limit: controls.keywordLimit });
    if (problem) {
      setError(t(problem === "length" ? "channelControls.keywordLength" : problem === "per-channel" ? "channelControls.keywordPerChannel" : "channelControls.keywordLimitReached"));
      return;
    }
    const typed = keywordDraft;
    save("keywords", () => api.setKeywords(space.id, next)).then((saved) => { if (saved) setKeywordDraft((current) => current === typed ? "" : current); });
  }

  const muteActive = isMuteActive(setting);
  return (
    <Dialog eyebrow={t("channelControls.eyebrow")} title={t("channelControls.title", { name: space.name })} onClose={onClose}>
      <div className="channel-controls">
        {switches.notificationLevels && (
          <section className="channel-controls__section" aria-labelledby={levelLabelId}>
            <h3 id={levelLabelId} className="channel-controls__heading">{t("channelControls.levelTitle")}</h3>
            <RadioGroup className="channel-controls__levels" aria-labelledby={levelLabelId}>
              {CHANNEL_NOTIFICATION_LEVELS.map((level) => (
                <BusyButton
                  type="button"
                  role="radio"
                  key={level}
                  aria-checked={setting.level === level}
                  pending={Boolean(busy)}
                  className="channel-controls__level"
                  onClick={() => setting.level !== level && save("level", () => api.setLevel(space.id, level))}
                >
                  <strong>{t(`channelControls.level.${level}`)}</strong>
                  <span>{t(`channelControls.level.${level}Sub`)}</span>
                </BusyButton>
              ))}
            </RadioGroup>
          </section>
        )}
        {switches.channelMute && (
          <section className="channel-controls__section" aria-label={t("channelControls.muteTitle")}>
            <h3 className="channel-controls__heading">{t("channelControls.muteTitle")}</h3>
            {muteActive ? (
              <div className="channel-controls__row">
                <p className="channel-controls__state"><BellOff size={15} aria-hidden="true" />
                  {setting.mutedUntil
                    ? t("channelControls.mutedUntil", { time: formatDateTimeWithZone(setting.mutedUntil, lang) })
                    : t("channelControls.mutedForever")}
                </p>
                <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={Boolean(busy)} onClick={() => save("mute", () => api.setMute(space.id, false))}>
                  {t("channelControls.unmute")}
                </BusyButton>
              </div>
            ) : (
              <div className="channel-controls__row">
                <label>
                  {t("channelControls.muteFor")}
                  <BusySelect value={duration} onChange={(event) => setDuration(event.target.value)} pending={Boolean(busy)}>
                    {CHANNEL_MUTE_DURATIONS.map((choice) => <option key={choice.id} value={choice.id}>{t(`channelControls.mute.${choice.id}`)}</option>)}
                  </BusySelect>
                </label>
                <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={Boolean(busy)} onClick={() => save("mute", () => api.setMute(space.id, true, muteUntilFor(duration)))}>
                  {t("channelControls.mute")}
                </BusyButton>
              </div>
            )}
            <p className="channel-controls__note">{t("channelControls.muteScope")}</p>
          </section>
        )}
        {switches.keywordAlerts && (
          <section className="channel-controls__section" aria-label={t("channelControls.keywordsTitle")}>
            <h3 className="channel-controls__heading">{t("channelControls.keywordsTitle")}</h3>
            <p className="channel-controls__note">{t("channelControls.keywordsBody", { used: controls.keywordCount, limit: controls.keywordLimit })}</p>
            {setting.keywords.length > 0 && (
              <ul className="channel-controls__keywords" aria-label={t("channelControls.keywordsList")}>
                {setting.keywords.map((keyword) => (
                  <li key={keyword}>
                    <span>{keyword}</span>
                    <BusyButton
                      type="button"
                      className="hub2-btn hub2-btn--ghost"
                      aria-label={t("channelControls.removeKeyword", { keyword })}
                      pending={Boolean(busy)}
                      onClick={() => save("keywords", () => api.setKeywords(space.id, setting.keywords.filter((item) => item !== keyword)))}
                    >×</BusyButton>
                  </li>
                ))}
              </ul>
            )}
            <form className="channel-controls__row" onSubmit={addKeyword}>
              <label htmlFor={keywordInputId}>{t("channelControls.addKeywordLabel")}</label>
              <BusyInput id={keywordInputId} value={keywordDraft} maxLength={48} onChange={(event) => setKeywordDraft(event.target.value)} pending={Boolean(busy)} />
              <BusyButton type="submit" className="hub2-btn hub2-btn--ghost" pending={Boolean(busy)} disabled={!keywordDraft.trim()}>{t("channelControls.addKeyword")}</BusyButton>
            </form>
          </section>
        )}
        <p className="channel-controls__note">{t("channelControls.boundaries")}</p>
        {status && <p role="status" className="channel-controls__status">{status}</p>}
        {error && <p role="alert" className="channel-controls__error">{error}</p>}
      </div>
    </Dialog>
  );
}

// A post body with keyword and @here highlights. The text is never changed;
// <mark> carries the emphasis and a screen reader hears it as highlighted.
export function ChannelPostBody({ body, keywords = [], here = false, mentionsMe = false, t }) {
  const segments = segmentChannelText(body || "", { keywords, here });
  return (
    <>
      {mentionsMe && <span className="channel-mention-chip"><AtSign size={12} aria-hidden="true" />{t("channelControls.mentionsYou")}</span>}
      <p>{segments.map((segment, index) => segment.highlight
        ? <mark key={index} className={`channel-highlight channel-highlight--${segment.highlight}`}>{segment.text}</mark>
        : <span key={index}>{segment.text}</span>)}</p>
    </>
  );
}

// Pick people to mention. Candidates come from the server, which only offers
// people who can read this channel and never a member directory. An empty list
// says so (owner ruling, October 7, 2026: the candidate rule stays as it is), and
// `onAddPeople`, passed only to someone who already manages this space's
// members, opens that existing control.
// Record 8435: pending is the thread's post in progress (the opener keeps
// focus and refuses), not a settled state.
export function MentionPicker({ t, api, spaceId, onPick, pending = false, onAddPeople = null, staffScope = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [state, setState] = useState("idle");
  const inputId = useId();
  const listId = useId();
  const run = useRef(0);
  useEffect(() => {
    if (!open) return undefined;
    const current = ++run.current;
    setState("loading");
    const timer = globalThis.setTimeout(() => {
      api.mentionCandidates(spaceId, query.trim()).then((found) => {
        if (current !== run.current) return;
        setRows(found);
        setState("ready");
      }).catch(() => {
        if (current !== run.current) return;
        setRows([]);
        setState("error");
      });
    }, 200);
    return () => globalThis.clearTimeout(timer);
  }, [api, open, query, spaceId]);
  if (!open) {
    return <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={pending} onClick={() => setOpen(true)}><AtSign size={14} aria-hidden="true" />{t("channelControls.mention")}</BusyButton>;
  }
  return (
    <div className="channel-mention-picker">
      <label htmlFor={inputId}>{t("channelControls.mentionSearchLabel")}</label>
      <input id={inputId} value={query} autoFocus aria-controls={listId} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} />
      <ul id={listId} aria-label={t("channelControls.mentionCandidates")} aria-busy={state === "loading"}>
        {rows.map((person) => (
          <li key={person.id}>
            <button type="button" className="hub2-btn hub2-btn--ghost" onClick={() => { onPick(person); setOpen(false); setQuery(""); }}>
              {t("channelControls.mentionPerson", { name: rows.some((other) => other.id !== person.id && other.name === person.name) ? `${person.name} (${person.id})` : person.name })}
            </button>
          </li>
        ))}
      </ul>
      {state === "ready" && rows.length === 0 && <div className="channel-mention-picker__empty">
        {/* list_channel_mention_candidates offers a staff caller every reader;
            anyone else, readers who have posted here or are roster stewards. */}
        <p role="status">{query.trim() ? `${t("channelControls.mentionNone")} ` : ""}{t(staffScope ? "channelControls.mentionWhoAppears" : "channelControls.mentionWhoAppearsMember")}</p>
        {/* A search miss is not a membership problem: offer the members
            dialog only when nobody can be mentioned at all. */}
        {onAddPeople && !query.trim() && <button type="button" className="hub2-btn hub2-btn--ghost" onClick={() => { setOpen(false); onAddPeople(); }}>{t("channelControls.mentionAddPeople")}</button>}
      </div>}
      {state === "error" && <p role="alert">{t("channelControls.mentionFailed")}</p>}
      <button type="button" className="hub2-btn hub2-btn--ghost" onClick={() => setOpen(false)}>{t("channelControls.close")}</button>
    </div>
  );
}

// Posts that mention the member or ping @here, newest first.
// REQ-UG-MENTION-REMINDERS-20261030: onRemind(hit, remindAt) turns a
// mention into the reader's own reminder on that post, through the existing
// channel message reminder (create_member_message_reminder, owner-only, at most
// 20 pending per message and 500 in all). Without it no control is offered.
export function MentionSearchPanel({ t, lang, api, onOpenPost, onRemind = null }) {
  const [query, setQuery] = useState("");
  const [reminding, setReminding] = useState(null);
  const [remindBusy, setRemindBusy] = useState(false);
  const [remindNote, setRemindNote] = useState({ postId: null, text: "", failed: false });
  const [rows, setRows] = useState([]);
  const [state, setState] = useState("idle");
  const inputId = useId();
  const run = useRef(0);
  async function search(event) {
    event?.preventDefault();
    const current = ++run.current;
    setState("loading");
    try {
      const found = await api.searchMentions(query.trim());
      if (current !== run.current) return;
      setRows(found);
      setState("ready");
    } catch (cause) {
      if (current !== run.current) return;
      setRows([]);
      setState(isChannelControlDisabled(cause) ? "off" : "error");
    }
  }
  useEffect(() => { search(); /* first page of mentions on open */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function remind(hit, remindAt) {
    if (remindBusy) return;
    setRemindBusy(true);
    try {
      await onRemind(hit, remindAt);
      setReminding(null);
      setRemindNote({ postId: hit.postId, text: t("inbox.reminderSet"), failed: false });
    } catch {
      setRemindNote({ postId: hit.postId, text: t("inbox.actionFailed"), failed: true });
    } finally {
      setRemindBusy(false);
    }
  }
  return (
    <section className="hub2-card channel-mention-search" aria-label={t("channelControls.mentionSearchTitle")}>
      <div className="hub2-card__head"><span className="hub2-card__headtitle"><AtSign size={15} aria-hidden="true" /> {t("channelControls.mentionSearchTitle")}</span></div>
      <form className="channel-controls__row" role="search" onSubmit={search}>
        <label htmlFor={inputId}>{t("channelControls.mentionSearchQuery")}</label>
        <input id={inputId} type="search" maxLength={80} value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="hub2-btn hub2-btn--ghost"><Search size={14} aria-hidden="true" />{t("channelControls.search")}</button>
      </form>
      <div aria-live="polite">
        {state === "loading" && <p role="status">{t("channelControls.searching")}</p>}
        {state === "ready" && rows.length === 0 && <p>{t("channelControls.noMentions")}</p>}
        {state === "error" && <p role="alert">{t("channelControls.searchFailed")}</p>}
        {state === "off" && <p>{t("channelControls.turnedOff")}</p>}
      </div>
      {rows.map((hit) => (
        <div className="channel-mention-hit" key={hit.postId}>
          <button type="button" className="hub2-rowbtn" onClick={() => onOpenPost(hit)}>
            <span className="hub2-rowbtn__main">
              <span className="hub2-rowbtn__title">{hit.threadTitle}</span>
              <span className="hub2-rowbtn__meta">
                {t(hit.reason === "here" ? "channelControls.reasonHere" : "channelControls.reasonMention", { name: hit.authorName || "" })}
                {" · "}{inReaderLanguage(lang, hit.spaceName, hit.spaceNameEs)}{" · "}{formatDateTimeWithZone(hit.createdAt, lang)}
              </span>
              <span className="hub2-rowbtn__meta">{inReaderLanguage(lang, hit.body, hit.bodyEs)}</span>
            </span>
          </button>
          {onRemind && reminding !== hit.postId && (
            <button type="button" className="hub2-btn hub2-btn--ghost" aria-label={t("channelControls.remindFromMention", { title: hit.threadTitle || "" })} onClick={() => { setReminding(hit.postId); setRemindNote({ postId: null, text: "", failed: false }); }}>
              {t("inbox.remindMe")}
            </button>
          )}
          {onRemind && reminding === hit.postId && (
            <ReminderTimePicker busy={remindBusy} title={t("channelControls.remindFromMention", { title: hit.threadTitle || "" })} onCancel={() => setReminding(null)} onConfirm={(remindAt) => remind(hit, remindAt)} />
          )}
          {remindNote.postId === hit.postId && remindNote.text && <p role={remindNote.failed ? "alert" : "status"}>{remindNote.text}</p>}
        </div>
      ))}
    </section>
  );
}

export function PinToggle({ t, thread, onToggle, busy = false }) {
  const pinned = Boolean(thread.pinned_at);
  return (
    <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={busy} onClick={() => onToggle(thread, !pinned)}>
      <Pin size={14} aria-hidden="true" />{t(pinned ? "channelControls.unpin" : "channelControls.pin")}
    </BusyButton>
  );
}
