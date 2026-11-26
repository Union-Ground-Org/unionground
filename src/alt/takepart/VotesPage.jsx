// The prototype's Votes page (pages/votes.js) under the alternate shell
// (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030): its open ballot card,
// official ballot panels, live show of hands, poll question box, past votes
// and receipt check, drawn on VotingView's plan items and handlers. Every
// option still goes through VotingView's castThrough -> onPlanAction -> App's
// confirmation dialog; the poll box is VotingView's own draft and submit; the
// detail dialogs are VotingView's. The receipt check calls
// verify_ballot_receipt, the RPC behind /verify. The live show of hands and
// the poll review queue have no record behind them and say so.
//
// This module holds the design's markup apart from VotingView.jsx on purpose:
// the route-style splitter treats class names written in one file as able to
// meet on one element, so design classes in VotingView.jsx would pin its
// route sheet's rules back into the critical sheet.
import { useEffect, useRef, useState } from "react";
import { BusyButton } from "../../components/BusyControls.jsx";
import { RadioGroup } from "../../components/RadioGroup.jsx";
import { OfficerRemovalSummary } from "../../features/governance/OfficerRemovalEditor.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../../lib/i18n.js";
import { verifyBallotReceipt } from "../../lib/memberApi.js";
import { supabase } from "../../lib/supabase.js";
import { Icon } from "../icons.jsx";
import { formatClock, formatDay } from "../format.js";
import { Countdown } from "./Countdown.jsx";
import { TakePartHero } from "./TakePartHero.jsx";
import { quorumTurnoutText } from "../../lib/quorumTurnout.js";
import { closedPollRecordedLine } from "../../lib/pollRecordedCopy.js";
import "../../lib/i18n/features/altTakePartStrings.js";

export function VotesPage({
  demo = false,
  primary = null,
  primaryClose = null,
  primaryQuorumPct = null,
  extraOpen = [],
  surveys = [],
  past = [],
  rules = [],
  poll,
  onCast,
  onDetail,
  onQuorum,
  onMessageSteward = null,
  noStewardNote = null,
  onOpenHome = null,
  verifyReceipt = null,
  focusPast = false,
  dialogs = null,
  // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: the
  // nominations card and the staff way to the ballot tools.
  extra = null,
}) {
  const { t, lang } = useLang();
  const [picks, setPicks] = useState({});
  const [pickError, setPickError] = useState("");
  const [receiptInput, setReceiptInput] = useState("");
  const receiptLookupRef = useRef(false);
  const [receiptCheck, setReceiptCheck] = useState(null);
  const [copiedCode, setCopiedCode] = useState("");
  // #9463: a refused clipboard says so beside the receipt code; only the
  // latest copy attempt sets either line.
  const [copyFailedCode, setCopyFailedCode] = useState("");
  const copyAttempt = useRef(0);

  // /m/voting/past: one page holds both lists, so the routed Past tab brings
  // its panel into view instead of swapping the page.
  useEffect(() => {
    if (focusPast) document.getElementById("ug-votes-past")?.scrollIntoView?.({ block: "start" });
  }, [focusPast]);

  async function checkReceipt(event) {
    event.preventDefault();
    // #9914: the lookup button stays focusable while it runs, so a lookup in
    // flight refuses a second one (Enter in the field still submits).
    if (receiptLookupRef.current) return;
    const code = receiptInput.trim();
    if (!code) {
      setReceiptCheck({ state: "empty" });
      return;
    }
    const verify = verifyReceipt ?? (supabase ? (value) => verifyBallotReceipt(supabase, value) : null);
    if (!verify) {
      setReceiptCheck({ state: "offline" });
      return;
    }
    receiptLookupRef.current = true;
    setReceiptCheck({ state: "checking" });
    try {
      const result = await verify(code);
      setReceiptCheck(result?.found
        ? { state: result.counted === false ? "uncounted" : "counted", title: result.ballotTitle ?? "", issuedAt: result.issuedAt ?? null }
        : { state: "missing" });
    } catch {
      setReceiptCheck({ state: "error" });
    } finally {
      receiptLookupRef.current = false;
    }
  }

  const canCopy = typeof navigator !== "undefined" && Boolean(navigator.clipboard?.writeText);
  const copyCode = (code) => {
    const mine = ++copyAttempt.current;
    setCopyFailedCode("");
    Promise.resolve().then(() => navigator.clipboard.writeText(code)).then(
      () => { if (mine === copyAttempt.current) setCopiedCode(code); },
      () => { if (mine === copyAttempt.current) { setCopiedCode(""); setCopyFailedCode(code); } },
    );
  };
  const receiptLine = (code) => (
    <>
      {demo ? t("voting.sampleReceiptCode", { code }) : <>{t("altTakePart.votesReceipt")} <span className="ug-mono ug-ta-code">{code}</span></>}
      {canCopy && !demo ? <> <button type="button" className="ug-link" onClick={() => copyCode(code)}>{copiedCode === code ? t("altTakePart.copied") : t("altTakePart.copy")}</button></> : null}
      {copyFailedCode === code ? <> <span role="alert">{t("altTakePart.copyFailed")}</span></> : null}
    </>
  );
  const ballotAvatar = <span className="ug-av ug-av-sm ug-ta-av" aria-hidden="true"><Icon name="ballot" /></span>;
  const quorum = primary?.quorum?.quorumTarget ? primary.quorum : null;

  const primaryCard = primary ? (
    <article className="ug-vote-card ug-ta-vote" aria-labelledby="ug-votes-primary">
      <div className="ug-ta-card-top">
        <span className="ug-ta-who">{ballotAvatar}<b>{t("voting.secretBallot")}</b><span className="ug-tag ug-t-vote">{t("altTakePart.votesOpenTag")}</span></span>
        {primaryClose != null
          ? <span className="ug-tag ug-t-action"><Icon name="clock" />{t("altTakePart.votesClosesIn")} <Countdown target={primaryClose} /></span>
          : <span className="ug-tag ug-t-action">{primary.meta}</span>}
      </div>
      <h2 id="ug-votes-primary" className="ug-ta-vote-title">{primary.title}</h2>
      <div className="ug-legacy"><OfficerRemovalSummary chapterId={primary.chapterId} detail={primary.officerRemoval} /></div>
      <p className="ug-ta-vote-body">{primary.body || t("voting.heroSub")}</p>
      {quorum ? (
        <div className="ug-ta-turnout">
          <div><div className="ug-count-big ug-tnum">{primaryQuorumPct}%</div><span>{t("altTakePart.votesOfQuorum")}</span></div>
          <div>
            <div className="ug-ta-turnout-line">
              <span>{quorumTurnoutText(t, quorum)}</span>
              <span>{quorum.totalVotes >= quorum.quorumTarget ? t("altTakePart.quorumReached") : t("altTakePart.quorumNotYet")}</span>
            </div>
            <div className="ug-progress" aria-hidden="true"><i style={{ width: `${primaryQuorumPct}%` }} /></div>
          </div>
        </div>
      ) : <p className="ug-ta-muted ug-ta-gap">{t("altTakePart.votesNoTurnout")}</p>}
      <p className="ug-ta-muted">
        {primaryClose != null ? `${t("altTakePart.votesPollsClose", { when: `${formatDay(primaryClose, lang, { year: true })} · ${formatClock(primaryClose, lang)}` })} ` : ""}
        {quorum ? <button type="button" className="ug-link" onClick={() => onQuorum(primary)}>{t("voting.quorumTitle")}</button> : null}
      </p>
      {primary.receiptCode ? (
        <div className="ug-note ug-ta-gap"><Icon name="check" /><span><b>{t("altTakePart.votesBallotIn")}</b> {receiptLine(primary.receiptCode)}</span></div>
      ) : (
        <div className="ug-btn-row ug-ta-cast">
          <button type="button" className="ug-btn ug-btn-dark" onClick={() => onCast(primary)}><Icon name="ballot" />{t("voting.castVote")}</button>
          <button type="button" className="ug-btn ug-btn-soft" onClick={() => onDetail(primary)}>{t("voting.readSummary")}</button>
        </div>
      )}
    </article>
  ) : (
    <article className="ug-vote-card ug-ta-vote" aria-labelledby="ug-votes-none">
      <div className="ug-ta-card-top"><span className="ug-ta-who">{ballotAvatar}<span className="ug-tag ug-t-vote">{t("altTakePart.votesNoneTag")}</span></span></div>
      <h2 id="ug-votes-none" className="ug-ta-vote-title">{t("voting.noOpenTitle")}</h2>
      <p className="ug-ta-vote-body">{t("voting.noOpenBody")}</p>
    </article>
  );

  const officialPanel = (item) => {
    const pick = picks[item.id] ?? "";
    const options = item.options || [];
    const submitBallot = (event) => {
      event.preventDefault();
      if (options.length && !pick) {
        setPickError(item.id);
        return;
      }
      setPickError("");
      onCast(item, pick || undefined);
    };
    return (
      <article className="ug-panel ug-ta-ballot" key={item.id} aria-labelledby={`ug-vote-${item.id}`}>
        <div className="ug-ta-card-top">
          <span className="ug-ta-who">{ballotAvatar}<span className="ug-tag ug-t-vote">{t("altTakePart.votesOfficialTag")}</span></span>
          <span className="ug-ta-muted">{item.meta}</span>
        </div>
        <h2 id={`ug-vote-${item.id}`}>{item.title}</h2>
        <div className="ug-legacy"><OfficerRemovalSummary chapterId={item.chapterId} detail={item.officerRemoval} /></div>
        <p className="ug-ta-panel-lede">{item.body || t("voting.officialSub")}</p>
        {item.receiptCode ? (
          <div className="ug-note"><Icon name="check" /><span><b>{t("altTakePart.votesSubmitted")}</b> {receiptLine(item.receiptCode)} {t("altTakePart.votesChoicePrivate")}</span></div>
        ) : (
          <form className="ug-ta-form" onSubmit={submitBallot}>
            {options.length ? (
              <RadioGroup className="ug-ta-opts" aria-label={item.title}>
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={pick === option.id}
                    className="ug-opt"
                    onClick={() => { setPicks((current) => ({ ...current, [item.id]: option.id })); setPickError(""); }}
                  >
                    <span className="ug-ta-grow"><b>{option.label}</b></span>
                    <span className="ug-box ug-round"><Icon name="check" /></span>
                  </button>
                ))}
              </RadioGroup>
            ) : null}
            {pickError === item.id ? <p className="ug-ta-err" role="alert">{t("altTakePart.votesPickFirst")}</p> : null}
            <div className="ug-btn-row">
              <button type="submit" className="ug-btn ug-btn-dark ug-btn-sm">{t("altTakePart.votesSubmit")}</button>
              <button type="button" className="ug-btn ug-btn-soft ug-btn-sm" onClick={() => onDetail(item)}>{t("voting.readSummary")}</button>
            </div>
          </form>
        )}
        <p className="ug-ta-anon"><Icon name="lock" />{t("voting.anonMode")}</p>
      </article>
    );
  };

  const surveyPanel = ({ item, recorded }) => (
    <article className="ug-panel ug-ta-ballot" key={item.id} id={`survey-${item.id}`} aria-labelledby={`ug-survey-${item.id}`}>
      <div className="ug-ta-card-top">
        <span className="ug-ta-who"><span className="ug-tag ug-t-action">{t("altTakePart.votesSurveyTag")}</span></span>
        <span className="ug-ta-muted">{item.meta}</span>
      </div>
      <h2 id={`ug-survey-${item.id}`}>{item.title}</h2>
      {item.body ? <p className="ug-ta-panel-lede">{item.body}</p> : null}
      {!item.selectedOption && !item.closed ? (
        <div className="ug-ta-opts">
          {(item.options || []).map((option) => (
            <button key={option.id} type="button" className="ug-opt" onClick={() => onCast(item, option.id)}>
              <span className="ug-ta-grow"><b>{option.label}</b></span>
              <span className="ug-box ug-round"><Icon name="check" /></span>
            </button>
          ))}
        </div>
      ) : null}
      {item.selectedOption ? <div className="ug-note"><Icon name="check" /><span>{item.closed ? closedPollRecordedLine(lang, recorded) : t("voting.pulseRecorded", { label: recorded })}</span></div> : null}
      {!item.selectedOption && item.closed ? <p className="ug-ta-muted">{t("altTakePart.pastClosed")}</p> : null}
    </article>
  );

  const receiptOut = (() => {
    const state = receiptCheck?.state;
    if (!state || state === "checking") return null;
    if (state === "counted") {
      return (
        <div className="ug-note"><Icon name="check" /><span>
          <b>{t("verify.counted")}.</b> {receiptCheck.title}
          {receiptCheck.issuedAt ? ` · ${t("verify.issued", { date: formatDateTimeWithZone(receiptCheck.issuedAt, lang) })}` : ""}. {t("altTakePart.verifyPrivate")}
        </span></div>
      );
    }
    const [title, body] = {
      uncounted: [t("vrx.notCountedTitle"), t("vrx.notCountedBody")],
      missing: [t("verify.notFound"), t("verify.notFoundBody")],
      offline: ["", t("verify.notConnected")],
      error: ["", t("verify.lookupFailed")],
      empty: ["", t("altTakePart.verifyEmpty")],
    }[state];
    return <div className="ug-note ug-warn"><Icon name="alert" /><span>{title ? <><b>{title}.</b> </> : null}{body}</span></div>;
  })();

  return (
    <div className="ug-ta-page ug-ta-votes">
      <TakePartHero
        crumb={t("altTakePart.votesCrumb")}
        lead={t("altTakePart.votesH1Lead")}
        accent={t("altTakePart.votesH1Accent")}
        lede={t("altTakePart.votesLede")}
        onOpenHome={onOpenHome}
      />
      <section className="ug-wrap ug-split ug-ta-split" aria-label={t("voting.tabBallots")}>
        <div className="ug-ta-col">
          {primaryCard}
          {extraOpen.map(officialPanel)}
          {extra}
          {surveys.map(surveyPanel)}
        </div>
        <aside className="ug-ta-col" aria-label={t("altTakePart.votesAside")}>
          <article className="ug-script ug-ta-live" aria-labelledby="ug-votes-live">
            <small>{t("altTakePart.liveKicker")}</small>
            <h2 id="ug-votes-live">{t("altTakePart.liveNoneTitle")}</h2>
            <p>{t("altTakePart.liveNoneBody")}</p>
          </article>
          <div className="ug-panel ug-ta-ask">
            <h3>{t("altTakePart.askTitle")}</h3>
            {poll.enabled ? <p className="ug-ta-panel-lede">{t("voting.suggestBody")}</p> : null}
            {poll.enabled && poll.sent ? (
              <div className="ug-note"><Icon name="check" /><span>{t("voting.pollSent")} <button type="button" className="ug-link" onClick={() => poll.setSent(false)}>{t("voting.suggestAnother")}</button></span></div>
            ) : null}
            {poll.enabled && !poll.sent ? (
              <form className="ug-ta-form" onSubmit={poll.submit}>
                <div className="ug-field">
                  <label className="ug-sr" htmlFor="ug-votes-ask">{t("altTakePart.askLabel")}</label>
                  <textarea id="ug-votes-ask" value={poll.draft} maxLength={200} onChange={(event) => poll.setDraft(event.target.value)} placeholder={t("voting.suggestPlaceholderDesktop")} />
                </div>
                <RadioGroup className="ug-chips ug-ta-chips" aria-label={t("voting.suggestAudience")}>
                  <button type="button" role="radio" aria-checked={poll.scope === "chapter"} className="ug-chip" onClick={() => poll.setScope("chapter")}>{t("altTakePart.scopeChapter")}</button>
                  <button type="button" role="radio" aria-checked={poll.scope === "local"} className="ug-chip" onClick={() => poll.setScope("local")}>{t("altTakePart.scopeLocal")}</button>
                </RadioGroup>
                <BusyButton type="submit" className="ug-btn ug-btn-dark ug-btn-sm ug-ta-start" pending={poll.busy} disabled={!poll.draft.trim()}>{t("altTakePart.askSubmit")}</BusyButton>
              </form>
            ) : null}
            {/* #9595: with no steward named, "Questions you send go to a
                steward" is untrue; the note says who can name one instead. */}
            {noStewardNote ? null : (
              <>
                <h4 className="ug-ta-h4">{t("altTakePart.askQueueTitle")}</h4>
                <ul className="ug-list"><li className="ug-li ug-ta-li-1"><span><b>{t("altTakePart.askQueueEmpty")}</b><span>{t("altTakePart.askQueueEmptySub")}</span></span></li></ul>
              </>
            )}
            {noStewardNote || onMessageSteward ? <h4 className="ug-ta-h4">{t("voting.questionsTitle")}</h4> : null}
            {noStewardNote ?? (onMessageSteward ? (
              <>
                <p className="ug-ta-muted">{t("voting.questionsBody")}</p>
                <button type="button" className="ug-btn ug-btn-soft ug-btn-sm ug-ta-gap" onClick={() => onMessageSteward()}>{t("voting.messageSteward")}</button>
              </>
            ) : null)}
          </div>
        </aside>
      </section>
      <section className="ug-wrap ug-section ug-ta-section" aria-label={t("voting.tabPast")}>
        <div className="ug-grid-2">
          <div className="ug-panel" id="ug-votes-past">
            <h2>{t("voting.pastTitle")}</h2>
            {past.length ? (
              <ul className="ug-list">
                {past.map(({ item, leader }) => (
                  <li className="ug-li" key={item.id}>
                    {ballotAvatar}
                    <span>
                      <b><button type="button" className="ug-ta-rowlink" onClick={() => onDetail(item)}>{item.title}</button></b>
                      <span>{item.meta}{item.quorum?.quorumTarget ? ` · ${quorumTurnoutText(t, item.quorum)}` : ""}</span>
                    </span>
                    <span className={`ug-tag ${leader ? "ug-t-win" : "ug-t-vote"}`}>
                      {leader ? t("voting.resultLead", { label: leader.label, pct: leader.pct }) : item.receiptCode ? t("altTakePart.pastVoted") : t("altTakePart.pastClosed")}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="ug-ta-muted">{t("voting.pastEmpty")}</p>}
          </div>
          <div className="ug-panel" id="ug-votes-verify">
            <h2>{t("altTakePart.verifyTitle")}</h2>
            <p className="ug-ta-panel-lede">{t("altTakePart.verifyLede")}</p>
            {demo ? (
              <div className="ug-note ug-warn"><Icon name="info" /><span>{t("voting.sampleReceipt")}</span></div>
            ) : (
              <form className="ug-ta-form" onSubmit={checkReceipt}>
                <div className="ug-field">
                  <label htmlFor="ug-votes-receipt">{t("verify.codeLabel")}</label>
                  <input id="ug-votes-receipt" className="ug-ta-code-in" type="text" value={receiptInput} onChange={(event) => setReceiptInput(event.target.value)} placeholder={t("verify.codePlaceholder")} autoComplete="off" spellCheck={false} />
                </div>
                <BusyButton type="submit" className="ug-btn ug-btn-dark ug-btn-sm ug-ta-start" pending={receiptCheck?.state === "checking"}>
                  {receiptCheck?.state === "checking" ? t("verify.checking") : t("altTakePart.verifySubmit")}
                </BusyButton>
                <div aria-live="polite">{receiptOut}</div>
              </form>
            )}
            <h4 className="ug-ta-h4">{t("altTakePart.rulesTitle")}</h4>
            <ul className="ug-checks ug-ta-checks">
              {rules.map((rule) => <li key={rule}><Icon name="check" /><span>{rule}</span></li>)}
            </ul>
          </div>
        </div>
      </section>
      <div className="ug-legacy">{dialogs}</div>
    </div>
  );
}
