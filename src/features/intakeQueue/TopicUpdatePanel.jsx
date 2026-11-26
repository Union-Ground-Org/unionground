import { useCallback, useEffect, useId, useRef, useState } from "react";
import "../../lib/i18n/features/topicUpdateStrings.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { DATE_TIME_WITH_ZONE_OPTIONS, formatDateTimeWithZone } from "../../lib/i18n/zonedDates.js";
import {
  BODY_MAX, EASTERN, SUBJECT_MAX, TOPIC_SEND_TOPICS, cleanUpdate, newKey, refusalKey, updateReady, updateSignature,
} from "./topicSendApi.js";
import { focusedElement, useSuccessFocus } from "./useSuccessFocus.js";

// Email an update (REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118):
// the People waiting panel where an intake reviewer writes one update for a
// landing topic, previews it with the recipient count, sends a test to their
// own address and then sends it. Everything goes through
// `requestSend(action, payload)`, which resolves to the route's result or
// rejects with `{ status, error, reason, missing }`. Send stays unavailable
// until a test of exactly the text on screen reached the provider, and it asks
// once more before queueing. The rendered preview is the server's own email in
// a sandboxed frame that runs nothing. Dates are Eastern.

const P = "topicUpdate";
const EASTERN_STAMP = Object.freeze({ ...DATE_TIME_WITH_ZONE_OPTIONS, timeZone: EASTERN });
const FRAME_STYLE = Object.freeze({ inlineSize: "100%", blockSize: "480px", border: "1px solid var(--border)", borderRadius: "12px", background: "var(--card)" });

function known(list, value) {
  return typeof value === "string" && list.includes(value) ? value : null;
}

function count(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function SendItem({ send, t, lang }) {
  const kind = known(["test", "list"], send.kind) || "list";
  const topic = known(TOPIC_SEND_TOPICS, send.topic);
  const status = known(["sending", "done"], send.status) || "sending";
  return <li className="xus-verifier-item">
    <h4 className="xus-etitle">{send.subject}</h4>
    <p className="xus-note">{t(`${P}.sendLine`, {
      kind: t(`${P}.kind.${kind}`),
      topic: topic ? t(`${P}.topic.${topic}`) : "",
      status: t(`${P}.status.${status}`),
      when: formatDateTimeWithZone(send.createdAt, lang, EASTERN_STAMP),
    })}{send.mine === true ? ` · ${t(`${P}.mine`)}` : ""}</p>
    <p className="xus-note">{t(`${P}.counts`, { queued: count(send.queued), sent: count(send.sent), failed: count(send.failed), skipped: count(send.skipped) })}</p>
  </li>;
}

export function TopicUpdatePanel({ requestSend }) {
  const { t, lang } = useLang();
  const headingId = useId();
  const topicId = useId();
  const subjectId = useId();
  const bodyId = useId();
  const hintId = useId();
  const frameLangId = useId();
  const sendRef = useRef(requestSend);
  useEffect(() => { sendRef.current = requestSend; });
  const busyRef = useRef(new Set());
  // Counts edits, so a preview reply that arrives after the topic or text
  // changed is dropped instead of showing another draft's email and count.
  const editsRef = useRef(0);
  const [overview, setOverview] = useState(null);
  const [draft, setDraft] = useState({ topic: TOPIC_SEND_TOPICS[0], subject: "", body: "" });
  const [preview, setPreview] = useState(null);
  const [frameLang, setFrameLang] = useState("en");
  // The delivered test: its id and the exact text it carried.
  const [tested, setTested] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const { targetRef: noticeRef, handOff } = useSuccessFocus();

  const failureText = useCallback((error) => {
    const key = refusalKey(error);
    if (key === "mail-unavailable") return t(`${P}.mailMissing`, { names: (error.missing || []).join(", ") });
    if (key === "unavailable" || key === "generic") return t(`${P}.error.${key}`);
    return t(`${P}.refusal.${key}`);
  }, [t]);

  const load = useCallback(async () => {
    try {
      setOverview(await sendRef.current("overview", {}));
    } catch (error) {
      setOverview({ failed: true, message: failureText(error) });
    }
  }, [failureText]);

  useEffect(() => { load(); }, [load]);

  const topics = Array.isArray(overview?.topics) ? overview.topics.filter((row) => known(TOPIC_SEND_TOPICS, row?.topic)) : [];
  const current = topics.find((row) => row.topic === draft.topic) || null;
  const recipients = count(current?.recipients);
  const mail = overview?.mail || { ready: false, missing: [] };
  const signature = updateSignature(draft);
  const testedNow = tested?.signature === signature;
  const ready = updateReady(draft);
  const canSend = ready && testedNow && mail.ready === true && current?.sentToday !== true && recipients > 0;

  function edit(field, value) {
    editsRef.current += 1;
    setDraft((before) => ({ ...before, [field]: value }));
    setPreview(null);
    setConfirming(false);
    setNotice("");
  }

  async function act(action, run, event) {
    return runBusyWrite(busyRef, action, async () => {
      setBusy(action);
      setNotice("");
      setFailure("");
      try {
        await run();
      } catch (error) {
        setFailure(failureText(error));
      } finally {
        setBusy("");
      }
    }, event);
  }

  const showPreview = (event) => act("preview", async () => {
    const edits = editsRef.current;
    const result = await sendRef.current("preview", cleanUpdate(draft));
    if (edits === editsRef.current) setPreview(result);
  }, event);

  const sendTest = (event) => act("test", async () => {
    const update = cleanUpdate(draft);
    const result = await sendRef.current("test", { ...update, key: newKey() });
    if (result?.delivered === true && result.send?.id) {
      setTested({ id: result.send.id, signature: updateSignature(update) });
      setNotice(t(`${P}.testSent`));
    } else {
      setFailure(t(`${P}.testFailed`));
    }
    await load();
  }, event);

  const sendList = (event) => {
    const started = focusedElement();
    return act("send", async () => {
      const update = cleanUpdate(draft);
      const result = await sendRef.current("send", { ...update, key: newKey(), testSendId: tested.id });
      setConfirming(false);
      setNotice(t(`${P}.queued`, { count: count(result?.send?.queued) }));
      setTested(null);
      // Yes, send it is gone now, before the sends are read again (ledger 621).
      handOff(started);
      await load();
    }, event);
  };

  const html = preview?.email?.[frameLang]?.html;
  const sends = Array.isArray(overview?.sends) ? overview.sends : [];
  const hint = !ready ? null
    : current?.sentToday === true ? t(`${P}.sentToday`)
      : overview && !overview.failed && recipients === 0 ? t(`${P}.noRecipients`)
        : tested && !testedNow ? t(`${P}.testStale`)
          : !testedNow ? t(`${P}.testNeeded`) : null;

  return <section className="xus-verifier-list" aria-labelledby={headingId}>
    <h3 className="xus-etitle" id={headingId}>{t("topicUpdate.heading")}</h3>
    <p className="xus-note">{t(`${P}.intro`)}</p>
    {overview === null && <p className="xus-note" role="status">{t(`${P}.loading`)}</p>}
    {overview?.failed && <p className="xus-note xus-note--error">{overview.message}</p>}
    {overview && !overview.failed && mail.ready !== true && <p className="xus-note xus-note--error">{t(`${P}.mailMissing`, { names: (mail.missing || []).join(", ") })}</p>}

    <label className="xus-field" htmlFor={topicId}>{t(`${P}.topic`)}
      <select id={topicId} className="xus-input" value={draft.topic} onChange={(event) => edit("topic", event.target.value)}>
        {TOPIC_SEND_TOPICS.map((topic) => {
          const row = topics.find((entry) => entry.topic === topic);
          const name = t(`${P}.topic.${topic}`);
          return <option key={topic} value={topic}>{row ? t(`${P}.topicOption`, { topic: name, count: count(row.recipients) }) : name}</option>;
        })}
      </select>
    </label>
    <label className="xus-field" htmlFor={subjectId}>{t(`${P}.subject`)}
      <input id={subjectId} className="xus-input" type="text" maxLength={SUBJECT_MAX} value={draft.subject} readOnly={Boolean(busy)} onChange={(event) => edit("subject", event.target.value.replace(/[\r\n]+/g, " "))} />
    </label>
    <label className="xus-field" htmlFor={bodyId}>{t(`${P}.body`)}
      <textarea id={bodyId} className="xus-input xus-input--area" rows={10} maxLength={BODY_MAX} aria-describedby={hintId} value={draft.body} readOnly={Boolean(busy)} onChange={(event) => edit("body", event.target.value)} />
    </label>
    <p className="xus-note" id={hintId}>{t(`${P}.bodyHint`)}</p>

    <div className="xus-btnrow">
      <BusyButton className="xus-btn" type="button" pending={busy === "preview"} disabled={!ready || Boolean(busy)} onClick={showPreview}>{t(`${P}.preview`)}</BusyButton>
      <BusyButton className="xus-btn" type="button" pending={busy === "test"} disabled={!ready || mail.ready !== true || Boolean(busy)} onClick={sendTest}>{t(`${P}.test`)}</BusyButton>
      <button className="xus-btn xus-btn--go" type="button" disabled={!canSend || Boolean(busy)} onClick={() => setConfirming(true)}>{t(`${P}.send`, { count: recipients })}</button>
    </div>
    {hint && <p className="xus-note">{hint}</p>}

    {confirming && canSend && <div className="xus-verifier-item" role="group" aria-label={t(`${P}.confirmHeading`, { count: recipients })}>
      <p className="xus-etitle">{t(`${P}.confirmHeading`, { count: recipients })}</p>
      <p className="xus-note">{t(`${P}.confirmBody`)}</p>
      <div className="xus-btnrow">
        <BusyButton className="xus-btn xus-btn--go" type="button" pending={busy === "send"} disabled={Boolean(busy)} onClick={sendList}>{t(`${P}.confirm`)}</BusyButton>
        <button className="xus-btn" type="button" disabled={Boolean(busy)} onClick={() => setConfirming(false)}>{t(`${P}.cancel`)}</button>
      </div>
    </div>}

    <p ref={noticeRef} tabIndex={-1} className="xus-note xus-note--success" role="status" aria-live="polite">{notice}</p>
    {failure && <p className="xus-note xus-note--error" role="alert">{failure}</p>}

    {preview && <div className="xus-verifier-item">
      <p className="xus-note">{t(`${P}.previewCount`, { count: count(preview.recipients) })}</p>
      <label className="xus-field" htmlFor={frameLangId}>{t(`${P}.previewLanguage`)}
        <select id={frameLangId} className="xus-input" value={frameLang} onChange={(event) => setFrameLang(event.target.value === "es" ? "es" : "en")}>
          <option value="en">{t(`${P}.previewLanguage.en`)}</option>
          <option value="es">{t(`${P}.previewLanguage.es`)}</option>
        </select>
      </label>
      {typeof html === "string" && <iframe title={t(`${P}.previewFrame`)} sandbox="" srcDoc={html} style={FRAME_STYLE} />}
    </div>}

    <h4 className="xus-etitle">{t(`${P}.sendsHeading`)}</h4>
    <div className="xus-btnrow"><BusyButton className="xus-btn" type="button" pending={busy === "refresh"} disabled={Boolean(busy)} onClick={(event) => act("refresh", load, event)}>{t(`${P}.refresh`)}</BusyButton></div>
    {overview && !overview.failed && sends.length === 0 && <p className="xus-note">{t(`${P}.sendsEmpty`)}</p>}
    {sends.length > 0 && <ul className="xus-verifier-items">{sends.map((send) => <SendItem key={send.id} send={send} t={t} lang={lang} />)}</ul>}
  </section>;
}
