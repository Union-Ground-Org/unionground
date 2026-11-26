// REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the
// member's own reminders and private dates, shown where members looked for
// them (Messages > Reminders, Settings > Calendar, Workload > Reminders).
// Only the member sees them; the server delivers each one in the app at its
// time, and a repeating one comes back on its schedule.
import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../../lib/i18n.js";
import { PERSONAL_REPEATS, cancelPersonalReminder, listPersonalReminders, savePersonalReminder } from "./api.js";
import "./personalReminders.css";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

function localInputValue(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

export function PersonalReminders({ client, heading = true }) {
  const { t, lang } = useLang();
  const [items, setItems] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState(() => localInputValue(new Date(Date.now() + 3600000)));
  const [repeat, setRepeat] = useState("none");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // #9465: a failed read is not "No reminders yet"; it says so, with Try again.
  const [loadFailed, setLoadFailed] = useState(false);
  // Only the newest read paints, so a late failure cannot bring the notice
  // back after a later read worked; Try again stays pending while its read runs.
  const loadRun = useRef(0);
  const retryingRef = useRef(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    const run = ++loadRun.current;
    try {
      const page = await listPersonalReminders(client);
      if (run !== loadRun.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setLoadFailed(false);
    } catch {
      if (run !== loadRun.current) return;
      setLoadFailed(true); setError(t("personalReminders.loadFailed"));
    }
  }, [client, t]);
  async function retry() {
    if (retryingRef.current) return;
    retryingRef.current = true; setRetrying(true); setError("");
    try { await load(); } finally { retryingRef.current = false; setRetrying(false); }
  }
  useEffect(() => { load(); }, [load]);
  // When the soonest reminder comes due the server delivers it and, for a
  // repeat, schedules the next one under a new id, so the list reloads a
  // minute after that time instead of keeping a Cancel for a row that fired.
  const soonest = (items || []).reduce((min, item) => {
    const at = Date.parse(item.remindAt);
    return Number.isFinite(at) && (min === null || at < min) ? at : min;
  }, null);
  useEffect(() => {
    if (soonest === null) return undefined;
    const delay = Math.min(Math.max(soonest - Date.now(), 0) + 60000, 2147483647);
    const timer = setTimeout(load, delay);
    return () => clearTimeout(timer);
  }, [soonest, load]);

  async function more() {
    setBusy(true);
    try {
      const page = await listPersonalReminders(client, cursor);
      setItems((current) => [...(current || []), ...page.items]);
      setCursor(page.nextCursor);
    } catch { setError(t("personalReminders.loadFailed")); }
    finally { setBusy(false); }
  }

  function save(event) {
    return runBusyWrite(busyWriteRef, "reminders", () => saveNow(event), event);
  }

  async function saveNow(event) {
    event.preventDefault();
    if (busy) return;
    const at = new Date(when);
    if (!title.trim() || Number.isNaN(at.getTime())) return;
    if (at.getTime() <= Date.now()) { setError(t("personalReminders.past")); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await savePersonalReminder(client, { title, note, remindAt: at.toISOString(), repeat });
      setTitle(""); setNote(""); setRepeat("none");
      setNotice(t("personalReminders.saved"));
      await load();
    } catch (failure) {
      setError(t(failure?.code === "54000" ? "personalReminders.limit" : "personalReminders.saveFailed"));
    } finally { setBusy(false); }
  }

  function cancel(item) {
    return runBusyWrite(busyWriteRef, "reminders", () => cancelNow(item));
  }

  async function cancelNow(item) {
    setBusy(true); setError(""); setNotice("");
    try {
      await cancelPersonalReminder(client, item.id);
      setNotice(t("personalReminders.cancelled"));
      await load();
    } catch (failure) {
      // P0002: the row is no longer scheduled (it fired, or was cancelled
      // elsewhere). Either way the list is reloaded, so it never keeps a
      // Cancel that cannot work.
      setError(t(failure?.code === "P0002" ? "personalReminders.cancelGone" : "personalReminders.cancelFailed"));
      await load();
    } finally { setBusy(false); }
  }

  if (!client) return null;
  return <section className="prm" aria-label={t("personalReminders.title")}>
    {heading && <h3 className="prm__title">{t("personalReminders.title")}</h3>}
    <p className="prm__help">{t("personalReminders.help")}</p>
    <form className="prm__form" onSubmit={save}>
      <label className="prm__field"><span>{t("personalReminders.what")}</span><input value={title} maxLength="160" required onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="prm__field"><span>{t("personalReminders.when")}</span><input type="datetime-local" value={when} required onChange={(event) => setWhen(event.target.value)} /></label>
      <label className="prm__field"><span>{t("personalReminders.repeat")}</span><select value={repeat} onChange={(event) => setRepeat(event.target.value)}>{PERSONAL_REPEATS.map((rule) => <option key={rule} value={rule}>{t(`personalReminders.repeat.${rule}`)}</option>)}</select></label>
      <label className="prm__field prm__field--wide"><span>{t("personalReminders.note")}</span><textarea value={note} maxLength="500" rows="2" onChange={(event) => setNote(event.target.value)} /></label>
      <BusyButton type="submit" className="dialog-primary" pending={busy} disabled={!title.trim()}>{t("personalReminders.add")}</BusyButton>
    </form>
    {error && <p className="prm__error" role="alert">{error}</p>}
    {loadFailed && <BusyButton type="button" className="dialog-secondary" pending={busy || retrying} onClick={() => { void retry(); }}>{t("personalReminders.retry")}</BusyButton>}
    <p className="prm__status" aria-live="polite">{notice}</p>
    {items !== null && !(loadFailed && items.length === 0) && (items.length === 0
      ? <p className="prm__empty">{t("personalReminders.empty")}</p>
      : <ul className="prm__list">{items.map((item) => <li key={item.id} className="prm__item">
        <div><strong>{item.title}</strong><span className="prm__when">{formatDateTimeWithZone(item.remindAt, lang)}{item.repeat && item.repeat !== "none" ? ` · ${t(`personalReminders.repeat.${item.repeat}`)}` : ""}</span>{item.note && <span className="prm__note">{item.note}</span>}</div>
        <BusyButton type="button" className="dialog-secondary" pending={busy} aria-label={t("personalReminders.cancelNamed", { title: item.title })} onClick={() => cancel(item)}>{t("personalReminders.cancel")}</BusyButton>
      </li>)}</ul>)}
    {cursor && <BusyButton type="button" className="dialog-secondary" pending={busy} onClick={more}>{t("personalReminders.more")}</BusyButton>}
  </section>;
}
