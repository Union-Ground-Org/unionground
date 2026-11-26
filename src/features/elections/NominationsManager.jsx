// REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: the election
// committee's side of nominations, on a standard ballot draft in Campaigns.
// It opens or ends the nominations period, reads every nomination with its
// nominator and seconder, downloads them as CSV, and hands the seconded
// nominees to the ballot editor as its choices.
import { useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../../lib/i18n.js";
import { exportNominations, loadNominations, nominationsCsv, secondedNominees, setNominationsPeriod } from "./nominationsApi.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// The most choices a ballot draft can hold (save_vote_campaign_draft).
const MAX_BALLOT_CHOICES = 20;
const MIN_BALLOT_CHOICES = 2;

function localValue(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function NominationsManager({ client, campaign, onUseNominees }) {
  const { t, lang } = useLang();
  const [state, setState] = useState(null);
  const [closeAt, setCloseAt] = useState("");
  const [busy, setBusy] = useState(false);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [notice, setNotice] = useState("");
  async function load() {
    setBusy(true); setNotice("");
    try {
      const exported = await loadNominations(client, campaign.id);
      setState(exported);
      setCloseAt(localValue(exported?.nominationsCloseAt));
    } catch { setNotice(t("nominations.loadFailed")); }
    finally { setBusy(false); }
  }
  function savePeriod(value) {
    return runBusyWrite(busyWriteRef, "nominations", () => savePeriodNow(value));
  }

  async function savePeriodNow(value) {
    setBusy(true); setNotice("");
    try {
      await setNominationsPeriod(client, campaign.id, value ? new Date(value).toISOString() : null);
      // Reload first: the read clears the notice line.
      await load();
      setNotice(t(value ? "nominations.periodSaved" : "nominations.periodRemoved"));
    } catch { setNotice(t("nominations.periodFailed")); setBusy(false); }
  }
  const nominations = state?.nominations || [];
  const seconded = secondedNominees(state);
  // Every open, export and hand-off reads the nominations again, so a list
  // left open never exports or offers nominees that changed since.
  async function fresh(exporting = false) {
    try { const exported = await (exporting ? exportNominations : loadNominations)(client, campaign.id); setState(exported); return exported; }
    catch { setNotice(t("nominations.loadFailed")); return null; }
  }
  async function exportCsv() {
    setBusy(true);
    const exported = await fresh(true);
    setBusy(false);
    if (exported) download(`nominations-${campaign.id}.csv`, nominationsCsv(exported, [t("nominations.csv.nominee"), t("nominations.csv.statement"), t("nominations.csv.nominatedBy"), t("nominations.csv.nominatedAt"), t("nominations.csv.secondedBy"), t("nominations.csv.secondedAt")]));
  }
  function useNominees() {
    return runBusyWrite(busyWriteRef, "nominations", () => takeNomineesNow());
  }

  async function takeNomineesNow() {
    setBusy(true);
    const exported = await fresh();
    setBusy(false);
    // A failed read keeps its load-failed notice; it is never a count.
    if (!exported) return;
    const names = secondedNominees(exported);
    // save_vote_campaign_draft takes 2 to 20 choices, so a longer list is
    // never handed off as a draft that cannot be saved.
    if (names.length > MAX_BALLOT_CHOICES) { setNotice(t("nominations.tooMany", { count: names.length, max: MAX_BALLOT_CHOICES })); return; }
    // #9468 W5-3: a refused hand-off says why instead of doing nothing.
    if (names.length < MIN_BALLOT_CHOICES) { setNotice(t("nominations.tooFew", { count: names.length, min: MIN_BALLOT_CHOICES })); return; }
    onUseNominees(names);
  }
  return <details className="cam-nominations" onToggle={(event) => { if (event.currentTarget.open && !busy) load(); }}>
    <summary>{t("nominations.manage")}</summary>
    <p className="cam-help">{t("nominations.manageHelp")}</p>
    <div className="cam-grid">
      <label className="cam-field"><span>{t("nominations.periodCloses")}</span><input type="datetime-local" value={closeAt} onChange={(event) => setCloseAt(event.target.value)} /></label>
      <div className="cam-actions">
        <BusyButton type="button" className="cam-btn cam-btn--quiet" pending={busy} disabled={!closeAt} onClick={() => savePeriod(closeAt)}>{t("nominations.savePeriod")}</BusyButton>
        {state?.nominationsCloseAt && <BusyButton type="button" className="cam-btn cam-btn--quiet" pending={busy} onClick={() => savePeriod(null)}>{t("nominations.removePeriod")}</BusyButton>}
      </div>
    </div>
    {state && (state.nominationsCloseAt
      ? <p className="cam-help">{t(new Date(state.nominationsCloseAt) > new Date() ? "nominations.periodOpen" : "nominations.periodEnded", { date: formatDateTimeWithZone(state.nominationsCloseAt, lang) })}</p>
      : <p className="cam-help">{t("nominations.periodNone")}</p>)}
    {state && (nominations.length === 0
      ? <p className="cam-help">{t("nominations.none")}</p>
      : <ul className="cam-nominations__list">{nominations.map((nomination) => <li key={nomination.id}>
        <strong>{nomination.nomineeName}</strong>
        {" · "}{t("nominations.byLine", { name: nomination.nominatedBy || t("nominations.formerMember") })}
        {" · "}{nomination.secondedAt ? t("nominations.secondedBy", { name: nomination.secondedBy || t("nominations.formerMember") }) : t("nominations.awaitingSecond")}
      </li>)}</ul>)}
    {state && <div className="cam-actions">
      <BusyButton type="button" className="cam-btn cam-btn--quiet" pending={busy} disabled={nominations.length === 0} onClick={exportCsv}>{t("nominations.exportCsv")}</BusyButton>
      <BusyButton type="button" className="cam-btn cam-btn--go" pending={busy} disabled={seconded.length < MIN_BALLOT_CHOICES || seconded.length > MAX_BALLOT_CHOICES} disabledReason={seconded.length < MIN_BALLOT_CHOICES ? t("nominations.tooFew", { count: seconded.length, min: MIN_BALLOT_CHOICES }) : seconded.length > MAX_BALLOT_CHOICES ? t("nominations.tooMany", { count: seconded.length, max: MAX_BALLOT_CHOICES }) : null} onClick={useNominees}>{t("nominations.useAsChoices", { count: seconded.length })}</BusyButton>
    </div>}
    <p className="cam-live" aria-live="polite">{notice}</p>
  </details>;
}
