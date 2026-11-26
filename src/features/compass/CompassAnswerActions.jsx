// REQ-UG-COMPASS-ACTION-OFFERS-20261001 (CR-099)
//
// Offers under a saved Compass answer: pin it to Home, forward it to a
// message, task or event (copy, then open that surface, as the old forward
// picker did), and for staff hats turn it into a task or a chapter
// announcement. Every write waits for an explicit confirmation and calls the
// caller-supplied existing authorized path; nothing is sent automatically.
// Task and announcement fields remain blank for the person
// to write; assistant output never fills a form.
import { useId, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { inferForwardTarget } from "./actionOffers.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { createNoticeDraft, noticeKeyReused } from "../../lib/noticePublishKey.js";

export function CompassAnswerActions({ message, actions }) {
  const { t } = useLang();
  const formId = useId();
  const [panel, setPanel] = useState(null);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435), keyed by the record the write changes.
  const busyWriteRef = useRef(new Set());
  const [notice, setNotice] = useState(null);
  const targets = actions.forwardTargets || ["message", "event"];
  const [target, setTarget] = useState(() => inferForwardTarget(message.body, targets));
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const pinned = Boolean(actions.pinnedIds?.has(message.id));
  // The announcement being written keeps one operation key from its first
  // Publish until it is confirmed posted; opening a panel starts a new one.
  const announcementDraft = useRef(null);
  announcementDraft.current ??= createNoticeDraft();

  function open(next) {
    announcementDraft.current.cancel();
    setNotice(null);
    setTitle("");
    setBody("");
    setPanel((current) => (current === next ? null : next));
  }

  function run(work, successKey, failureKeys = {}) {
    return runBusyWrite(busyWriteRef, `answer:${message.id}`, () => runNow(work, successKey, failureKeys));
  }

  // The lock above holds for the whole write, so busy is never already set
  // here; Main's render-time busy check is no longer needed.
  async function runNow(work, successKey, failureKeys = {}) {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      setPanel(null);
      setNotice({ kind: "status", text: t(successKey) });
    } catch (error) {
      setNotice({ kind: "alert", text: t(failureKeys[error?.code] || "compass.actions.failed") });
    } finally {
      setBusy(false);
    }
  }

  const pin = () => run(() => actions.pin(message.id, !pinned), pinned ? "compass.actions.unpinned" : "compass.actions.pinned", {
    pin_limit: "compass.actions.pinLimit", feature_disabled: "compass.actions.off",
  });
  const forward = () => run(() => actions.forward(target, message.body), "compass.actions.forwarded");
  const createTask = (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    run(() => actions.createTask({ title: title.trim(), description: body.trim() }), "compass.actions.taskCreated");
  };
  const publish = (event) => {
    event.preventDefault();
    if (!title.trim() || !body.trim()) return;
    run(async () => {
      try {
        await actions.publishBroadcast({ title: title.trim(), body: body.trim(), operationKey: announcementDraft.current.start() });
        announcementDraft.current.confirm();
      } catch (error) {
        if (!noticeKeyReused(error)) throw error;
        // This draft's first version is already posted; the edit goes as a new one next time.
        announcementDraft.current.cancel();
        throw Object.assign(new Error("first version posted"), { code: "notice_first_version_posted" });
      }
    }, "compass.actions.published", {
      notice_audience_unavailable: "notices.audienceUnavailable",
      notice_first_version_posted: "notices.firstVersionPosted",
    });
  };

  return (
    <div className="compass-answer-actions">
      <div className="compass-chips" role="group" aria-label={t("compass.actions.groupLabel")}>
        {actions.pin && <BusyButton type="button" aria-pressed={pinned} pending={busy} onClick={pin}>{t(pinned ? "compass.actions.unpin" : "compass.actions.pin")}</BusyButton>}
        <BusyButton type="button" aria-expanded={panel === "forward"} pending={busy} onClick={() => open("forward")}>{t("compass.actions.forward")}</BusyButton>
        {actions.createTask && <BusyButton type="button" aria-expanded={panel === "task"} pending={busy} onClick={() => open("task")}>{t("compass.actions.makeTask")}</BusyButton>}
        {actions.publishBroadcast && <BusyButton type="button" aria-expanded={panel === "broadcast"} pending={busy} onClick={() => open("broadcast")}>{t("compass.actions.draftAnnouncement")}</BusyButton>}
      </div>
      {panel === "forward" && (
        <fieldset className="compass-answer-actions__panel">
          <legend>{t("compass.actions.forwardLegend")}</legend>
          {targets.map((option) => (
            <label key={option}>
              <input type="radio" name={`${formId}-forward`} value={option} checked={target === option} onChange={() => setTarget(option)} />
              {t(`compass.actions.forwardTo.${option}`)}
            </label>
          ))}
          <p>{t("compass.actions.forwardHelp")}</p>
          <div className="compass-answer-actions__buttons">
            <BusyButton type="button" className="dialog-primary" pending={busy} onClick={forward}>{t("compass.actions.forwardConfirm")}</BusyButton>
            <BusyButton type="button" className="dialog-secondary" pending={busy} onClick={() => setPanel(null)}>{t("compass.actions.cancel")}</BusyButton>
          </div>
        </fieldset>
      )}
      {(panel === "task" || panel === "broadcast") && (
        <form className="compass-answer-actions__panel" onSubmit={panel === "task" ? createTask : publish} aria-label={t(panel === "task" ? "compass.actions.taskLegend" : "compass.actions.broadcastLegend")}>
          <p>{t(panel === "task" ? "compass.actions.taskHelp" : "compass.actions.broadcastHelp")}</p>
          <label htmlFor={`${formId}-title`}>{t("compass.actions.titleField")}</label>
          <input id={`${formId}-title`} value={title} maxLength={panel === "task" ? 120 : 160} required onChange={(event) => setTitle(event.target.value)} />
          <label htmlFor={`${formId}-body`}>{t(panel === "task" ? "compass.actions.descriptionField" : "compass.actions.messageField")}</label>
          <textarea id={`${formId}-body`} value={body} maxLength={4000} required={panel === "broadcast"} onChange={(event) => setBody(event.target.value)} />
          <div className="compass-answer-actions__buttons">
            <BusyButton type="submit" className="dialog-primary" pending={busy} disabled={!title.trim()}>{t(panel === "task" ? "compass.actions.taskConfirm" : "compass.actions.broadcastConfirm")}</BusyButton>
            <BusyButton type="button" className="dialog-secondary" pending={busy} onClick={() => setPanel(null)}>{t("compass.actions.cancel")}</BusyButton>
          </div>
        </form>
      )}
      {notice && <p className={`compass-answer-actions__notice compass-answer-actions__notice--${notice.kind}`} role={notice.kind}>{notice.text}</p>}
    </div>
  );
}
