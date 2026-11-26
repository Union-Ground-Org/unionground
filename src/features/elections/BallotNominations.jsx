// REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: the member's
// side of nominations, on Voting. Each ballot taking nominations lists its
// nominees (never who nominated or seconded them), lets the member nominate a
// person and second someone else's nomination. Renders nothing while no
// ballot is taking nominations. A failed read says so, with Try again, instead
// of looking like no open nominations
// (SYS-UG-SHARED-SWALLOWED-ERROR-GUARD-20261113).
import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../../lib/i18n.js";
import { READ_LOADING, READ_STATES, readResult } from "../../lib/readResult.js";
import { NOMINATIONS_PER_BALLOT_MAX, loadOpenNominations, nominateForBallot, secondNomination } from "./nominationsApi.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

function NominationForm({ ballot, client, onSaved }) {
  const { t } = useLang();
  const [name, setName] = useState("");
  const [statement, setStatement] = useState("");
  const [busy, setBusy] = useState(false);
  // A synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  function submit(event) {
    return runBusyWrite(busyWriteRef, "nominate", () => submitNow(event), event);
  }

  async function submitNow(event) {
    event.preventDefault();
    if (busy || name.trim().length < 2) return;
    setBusy(true); setError("");
    try {
      await nominateForBallot(client, ballot.ballotId, name, statement);
      setName(""); setStatement("");
      await onSaved(t("nominations.saved"));
    } catch (failure) {
      setError(failure?.code === "54000" ? t("nominations.limit", { max: NOMINATIONS_PER_BALLOT_MAX }) : t("nominations.saveFailed"));
    } finally { setBusy(false); }
  }
  return <form className="voting-nominate" onSubmit={submit}>
    <label className="voting-nominate__field"><span>{t("nominations.nominee")}</span><input value={name} minLength="2" maxLength="120" required onChange={(event) => setName(event.target.value)} /></label>
    <label className="voting-nominate__field"><span>{t("nominations.statement")}</span><textarea value={statement} maxLength="1000" rows="2" onChange={(event) => setStatement(event.target.value)} /></label>
    {error && <p className="voting-none__body" role="alert">{error}</p>}
    <BusyButton type="submit" className="voting-btn voting-btn--green" pending={busy} disabled={name.trim().length < 2}>{t("nominations.submit")}</BusyButton>
  </form>;
}

export function BallotNominations({ client }) {
  const { t, lang } = useLang();
  const [read, setRead] = useState(READ_LOADING);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  // A synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const load = useCallback(async () => {
    if (!client) return;
    setRead(await readResult(() => loadOpenNominations(client)));
  }, [client]);
  useEffect(() => { load(); }, [load]);
  const saved = async (message) => { setNotice(message); await load(); };
  function second(nomination) {
    return runBusyWrite(busyWriteRef, `second:${nomination.id}`, () => secondNow(nomination));
  }

  async function secondNow(nomination) {
    setBusyId(nomination.id); setNotice("");
    try { await secondNomination(client, nomination.id); await saved(t("nominations.seconded")); }
    catch { setNotice(t("nominations.secondFailed")); }
    finally { setBusyId(""); }
  }
  if (read.state === READ_STATES.failed) {
    return <section className="voting-card voting-nominations" aria-label={t("nominations.title")}>
      <h2 className="voting-none__title">{t("nominations.title")}</h2>
      {/* a review note (#9042): a save that succeeded keeps its notice
          when the reload after it fails. */}
      {notice ? <p className="voting-none__body" aria-live="polite">{notice}</p> : null}
      <p className="voting-none__body" role="alert">{t("nominations.loadFailed")}</p>
      <button type="button" className="voting-btn voting-btn--soft" onClick={load}>{t("nominations.retry")}</button>
    </section>;
  }
  if (read.state !== READ_STATES.loaded) return null;
  const ballots = read.value;
  return <section className="voting-card voting-nominations" aria-label={t("nominations.title")}>
    <h2 className="voting-none__title">{t("nominations.title")}</h2>
    <p className="voting-none__body">{t("nominations.help")} {t("nominations.cap", { max: NOMINATIONS_PER_BALLOT_MAX })}</p>
    {ballots.map((ballot) => <article key={ballot.ballotId} className="voting-nominations__ballot">
      <h3 className="voting-pulse__title">{lang === "es" ? (ballot.titleEs || ballot.title) : ballot.title}</h3>
      <p className="voting-pulse__meta">{t("nominations.closes", { date: formatDateTimeWithZone(ballot.nominationsCloseAt, lang) })}</p>
      {ballot.nominations.length === 0
        ? <p className="voting-none__body">{t("nominations.none")}</p>
        : <ul className="voting-nominations__list">{ballot.nominations.map((nomination) => <li key={nomination.id}>
          <strong>{nomination.nomineeName}</strong>
          {nomination.statement && <span> · {nomination.statement}</span>}
          {" "}
          {nomination.seconded
            ? <span className="voting-chip">{t("nominations.secondedChip")}</span>
            : nomination.mine
              ? <span className="voting-chip">{t("nominations.awaitingSecond")}</span>
              : <BusyButton type="button" className="voting-btn voting-btn--soft" pending={busyId === nomination.id} aria-label={t("nominations.secondNamed", { name: nomination.nomineeName })} onClick={() => second(nomination)}>{t("nominations.second")}</BusyButton>}
        </li>)}</ul>}
      <NominationForm ballot={ballot} client={client} onSaved={saved} />
    </article>)}
    <p className="voting-none__body" aria-live="polite">{notice}</p>
  </section>;
}
