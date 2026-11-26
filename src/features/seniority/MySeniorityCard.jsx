// REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: a member's
// own seniority entry and bids (public.get_my_seniority returns nothing
// else), with a way to question the entry. Shown only when there is something
// to show, so members of a chapter without a list see no empty card.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BusyButton, BusyTextarea } from "../../components/BusyControls.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatCalendarDay } from "../../lib/i18n/zonedDates.js";
import "../../lib/i18n/features/seniorityStrings.js";

// get_my_seniority's refusal (no organization) hides the card, as before.
const SENIORITY_REFUSAL_CODES = new Set(["42501"]);

function QuestionForm({ entry, api, onSent }) {
  const { t } = useLang();
  const id = useId();
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState(null);
  // Record #9891 (audit W5-11): the send shows it is busy and cannot go twice
  // (the ref refuses a second submit before React paints the busy state), and
  // an empty press says what is missing instead of doing nothing.
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  return <form onSubmit={async (event) => {
    event.preventDefault();
    if (sendingRef.current) return;
    if (!note.trim()) {
      setNotice({ role: "alert", text: t("seniority.myQuestionEmpty") });
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setNotice(null);
    try {
      await api.question(entry.id, note.trim());
      setNote("");
      setNotice({ role: "status", text: t("seniority.myQuestionSent") });
      onSent();
    } catch {
      setNotice({ role: "alert", text: t("seniority.myQuestionError") });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }}>
    <label htmlFor={id}>{t("seniority.myQuestionLabel")}</label>
    <BusyTextarea id={id} rows={2} maxLength={1000} value={note} pending={sending} onChange={(event) => setNote(event.target.value)} />
    <BusyButton type="submit" className="dialog-secondary" pending={sending}>{t("seniority.myQuestionSend")}</BusyButton>
    {notice && <p role={notice.role}>{notice.text}</p>}
  </form>;
}

export function MySeniorityCard({ api }) {
  const { t, lang } = useLang();
  const id = useId();
  const [state, setState] = useState(null);
  const [pending, setPending] = useState(false);
  // Only the newest read (load, Try again, refresh after a question) writes.
  const ticket = useRef(0);
  const load = useCallback(() => {
    const current = ++ticket.current;
    setPending(true);
    Promise.resolve().then(() => api.mine())
      .then((value) => { if (current === ticket.current) setState({ entries: value?.entries ?? [], bids: value?.bids ?? [], failed: false }); })
      // Record #9465 (W5-12): a failed read keeps what was shown and says so,
      // instead of hiding the card as if the member had no entry.
      .catch((error) => {
        if (current !== ticket.current) return;
        if (SENIORITY_REFUSAL_CODES.has(String(error?.code ?? ""))) setState({ entries: [], bids: [], failed: false });
        else setState((prev) => ({ entries: prev?.entries ?? [], bids: prev?.bids ?? [], failed: true }));
      })
      .finally(() => { if (current === ticket.current) setPending(false); });
  }, [api]);
  useEffect(() => { load(); return () => { ticket.current += 1; }; }, [load]);
  if (!state || (!state.failed && state.entries.length === 0 && state.bids.length === 0)) return null;
  return <section className="setin-card my-seniority" aria-labelledby={`${id}-title`}>
    <div className="setin-card__head">
      <h3 id={`${id}-title`}>{t("seniority.myTitle")}</h3>
      <p>{t("seniority.myRule")}</p>
    </div>
    {state.failed && <div role="alert" className="my-seniority__failed">
      <p>{t("seniority.myLoadFailed")}</p>
      <BusyButton type="button" className="dialog-secondary" pending={pending} onClick={load}>{t("seniority.retry")}</BusyButton>
    </div>}
    {state.entries.map((entry) => <div key={entry.id} className="my-seniority__entry">
      <p><strong>{t("seniority.myEntry", { chapter: entry.chapterName, date: formatCalendarDay(entry.seniorityDate, lang) || entry.seniorityDate })}</strong>{entry.classification ? ` · ${entry.classification}` : ""}</p>
      {entry.question?.status === "open" && <p>{t("seniority.questionOpen", { note: entry.question.note })}</p>}
      {entry.question?.status === "answered" && <p>{t("seniority.questionAnswered", { answer: entry.question.answer })}</p>}
      <QuestionForm entry={entry} api={api} onSent={load} />
    </div>)}
    {state.bids.length > 0 && <>
      <h4>{t("seniority.myBids")}</h4>
      <ul>{state.bids.map((bid) => <li key={bid.id}>
        {t("seniority.myBid", { subject: bid.subject, choice: bid.choice })}
        {bid.award ? ` · ${t("seniority.awarded", { award: bid.award })}` : ""}
      </li>)}</ul>
    </>}
  </section>;
}
