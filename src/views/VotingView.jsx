import { useRoutedTab, RoutedTabLink } from "../components/WorkspacePages.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, MessageSquareText, Search, ShieldCheck } from "lucide-react";
import { Dialog } from "../components/Dialog.jsx";
import { ArrivalCount, ChartArrival, arriveAt } from "../components/ChartArrival.jsx";
import { RadioGroup } from "../components/RadioGroup.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { NoStewardNote } from "../components/NoStewardNote.jsx";
import { memberHasNoChapter, noStewardNamed } from "../lib/stewardConversations.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { OfficerRemovalSummary } from "../features/governance/OfficerRemovalEditor.jsx";
import { voiceAvailabilityLabel } from "../lib/voiceAvailability.js";
import { VotesPage } from "../alt/takepart/VotesPage.jsx";
import { BallotNominations } from "../features/elections/BallotNominations.jsx";
import { quorumTurnoutText } from "../lib/quorumTurnout.js";
import { closedPollRecordedLine } from "../lib/pollRecordedCopy.js";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";

// The Union Base prototype's Voting page ("Voice" in the member nav).
// Desktop mirrors pg.voting (tabbed Ballots / Past votes + info rail);
// phone mirrors mpg.voting (secret-ballot hero, surveys & polls, past
// results). Every ballot, pulse, receipt and quorum figure comes from the
// SAME plan items TodayView renders — one data shape, one vote flow: every
// cast goes through onPlanAction -> App's ChoiceDialog -> submit_ballot_vote,
// never a second submission path in this file.
//
// Vote-window states (prototype v:1 / v:c / v:0):
//   open    — at least one open ballot
//   closing — an open ballot carries a raw close timestamp within 2 hours
//             (the loader ships closes_at on ballot plan items; the countdown
//             reads item.closesAt ?? item.closes_at and shows a live clock
//             only inside that 2-hour band)
//   closed  — ballots exist but none are open (or none exist at all)
const CRUNCH_WINDOW_MS = 2 * 60 * 60 * 1000;
// setTimeout coerces delays above the 32-bit signed maximum to fire
// immediately, so a far-off close is waited out in slices of this size.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function closesAtMs(item) {
  const raw = item?.closesAt ?? item?.closes_at ?? null;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function countdownLabel(ms) {
  const clamped = Math.max(0, ms);
  const hours = Math.floor(clamped / 3600000);
  const minutes = String(Math.floor(clamped / 60000) % 60).padStart(2, "0");
  const seconds = String(Math.floor(clamped / 1000) % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function optionLabel(item, optionId) {
  return (item.options || []).find((option) => option.id === optionId)?.label || "";
}

function quorumPct(quorum) {
  if (!quorum?.quorumTarget) return 0;
  return Math.min(100, Math.round((quorum.totalVotes / quorum.quorumTarget) * 100));
}

// Published results (UB-VOTE-02): the loader attaches `results` only after a
// ballot closes — get_ballot_tally never emits per-option counts while voting
// is open — so a non-null array here is always safe to render. Percentages are
// of ballots cast (the option-count sum), not of quorum.
function resultRows(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const cast = results.reduce((sum, option) => sum + (option.votes || 0), 0);
  const top = Math.max(...results.map((option) => option.votes || 0));
  return results.map((option) => ({
    optionId: option.optionId,
    label: option.label,
    votes: option.votes || 0,
    pct: cast > 0 ? Math.round(((option.votes || 0) / cast) * 100) : 0,
    leading: cast > 0 && (option.votes || 0) === top,
  }));
}

// The one leading option of a closed ballot's published result, or null when
// there is none or the lead is tied (a tie must not crown the first-listed
// option:, finding 6).
function pastLeader(item) {
  const leaders = resultRows(item.results)?.filter((row) => row.leading) ?? [];
  return leaders.length === 1 ? leaders[0] : null;
}

// The logo/role/bell/avatar chrome lives in the shell's global mobile top bar
// now, so the phone page opens with the prototype's own in-page title ("Voice",
// mpg.voting line 1) instead of a per-view ScreenHeader. Desktop keeps its
// richer .voting-ph header, which is likewise in-page.
export function VotingView({
  alt = false,
  onOpenHome = null,
  data,
  demo = false,
  desktop = false,
  onPlanAction,
  onMessageSteward,
  onSuggestPoll,
  stewardPresence = null,
  verifyReceipt = null,
  // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: ballots
  // taking nominations, and for staff the way to the ballot tools.
  nominationsClient = null,
  onOpenCampaigns = null,
  campaignsSwitch = null,
}) {
  const { t, lang } = useLang();
  const planItems = useMemo(() => data.planItems ?? [], [data.planItems]);
  const ballots = useMemo(() => planItems.filter((item) => item.kind === "ballot"), [planItems]);
  const pulses = useMemo(() => planItems.filter((item) => item.kind === "pulse"), [planItems]);
  const openBallots = useMemo(() => ballots.filter((item) => !item.closed), [ballots]);
  const pastBallots = useMemo(() => ballots.filter((item) => Boolean(item.closed)), [ballots]);
  const primary = openBallots[0] ?? null;
  const extraOpen = openBallots.slice(1);
  // Voted state is receipt-derived only: choices are stored unlinkably
  // (20260808230000), so no ballot item carries a selectedOption and this
  // screen can never echo WHICH option a member picked — only that they voted.
  const primaryVoted = Boolean(primary && primary.receiptCode);

  // Countdown (prototype v:c). Ticks only while an open ballot carries a raw
  // close timestamp; without one the calm CLOSES chip renders instead.
  const crunchTarget = useMemo(() => {
    const stamps = openBallots.map(closesAtMs).filter((ms) => ms != null);
    return stamps.length ? Math.min(...stamps) : null;
  }, [openBallots]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The per-second clock is what the crunch chip reads, so it may only run
  // while that chip is on screen: inside the 2-hour window and before the
  // close. A ballot closing next week arms a single wake-up timer instead of
  // 600k no-op re-renders, and the interval retires itself on the tick that
  // reaches the close.
  useEffect(() => {
    if (crunchTarget == null) return undefined;
    let tick;
    let wake;
    const arm = () => {
      const remaining = crunchTarget - Date.now();
      if (remaining <= 0) return;
      if (remaining > CRUNCH_WINDOW_MS) {
        wake = setTimeout(arm, Math.min(remaining - CRUNCH_WINDOW_MS, MAX_TIMEOUT_MS));
        return;
      }
      setNowMs(Date.now());
      tick = setInterval(() => {
        const now = Date.now();
        setNowMs(now);
        if (crunchTarget - now <= 0) clearInterval(tick);
      }, 1000);
    };
    arm();
    return () => {
      clearTimeout(wake);
      clearInterval(tick);
    };
  }, [crunchTarget]);
  const crunch = crunchTarget != null && crunchTarget - nowMs > 0 && crunchTarget - nowMs <= CRUNCH_WINDOW_MS;
  const countdown = crunch ? countdownLabel(crunchTarget - nowMs) : "";

  const [tab, setTab] = useRoutedTab("voting", "ballots");
  const [detail, setDetail] = useDeviceParityState("voting.detail", null); // { kind: "ballot" | "quorum", item }
  const [pollDraft, setPollDraft] = useDeviceParityState("voting.pollDraft", "");
  const [pollScope, setPollScope] = useDeviceParityState("voting.pollScope", "chapter");
  const [pollSent, setPollSent] = useDeviceParityState("voting.pollSent", false);
  const [pollBusy, setPollBusy] = useState(false);
  // A synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());

  useEffect(() => {
    let surveyId;
    try { surveyId = new URLSearchParams(window.location.search).get("survey"); } catch { surveyId = null; }
    if (!surveyId || !pulses.some((item) => item.id === surveyId)) return;
    window.requestAnimationFrame(() => document.getElementById(`survey-${surveyId}`)?.scrollIntoView?.({ block: "center" }));
  }, [pulses]);

  // Voting counts only what it lists. Organization
  // surveys are answered in Voice, where Home's count and card lead.
  const headerChip = voiceAvailabilityLabel(planItems, t);

  //: a poll suggestion is a message to the chapter's stewards, so with
  // no steward named for the reader (stewardPresence) there is no box to send
  // it from and no Message a steward; the questions card says who can name one.
  const noSteward = noStewardNamed(stewardPresence);
  const canSuggest = !noSteward && Boolean(onSuggestPoll || onMessageSteward);

  function castThrough(item, optionId) {
    // Belt: closed items never reach the dialog; App re-checks anyway.
    if (!item || item.closed) return;
    setDetail(null);
    // A tapped option rides along as a preselection so the confirmation
    // dialog opens with THAT choice already selected — the member confirms
    // the tap, they do not make it again (nothing submits on open).
    onPlanAction?.(optionId ? { ...item, selectedOption: optionId } : item);
  }

  function submitPoll(event) {
    return runBusyWrite(busyWriteRef, "poll", () => submitPollNow(event), event);
  }

  async function submitPollNow(event) {
    event.preventDefault();
    const text = pollDraft.trim();
    if (!text || pollBusy) return;
    if (onSuggestPoll) {
      setPollBusy(true);
      try {
        await onSuggestPoll(text, pollScope);
        // The handoff owns the text now; a stored draft would refill the
        // next suggestion with this one.
        setPollDraft("");
        setPollSent(true);
      } catch {
        // The app-level mutate() handler already toasts the failure.
      } finally {
        setPollBusy(false);
      }
      return;
    }
    // No suggestion backend wired: route the member to their steward, who is
    // the reviewer either way. The draft stays in the box — nothing is faked.
    onMessageSteward?.(text);
  }

  //  (D2-2): a member with no chapter sees no ballot at all, chapter or
  // organization-wide: member_ballots_read_eligible reads
  // private.current_member_organization(), which is found through the chapter.
  const rules = [t("voting.rule1"), t(memberHasNoChapter(data.member) ? "voting.rule2NoChapter" : "voting.rule2"), t("voting.rule3"), t("voting.rule4")];
  const questionsBody = noSteward ? <NoStewardNote presence={stewardPresence} className="voting-rail-dark__body" /> : (
    <>
      <p className="voting-rail-dark__body">{t("voting.questionsBody")}</p>
      <button type="button" className="voting-btn voting-btn--gold" onClick={() => onMessageSteward()}>{t("voting.messageSteward")}</button>
    </>
  );

  // ── shared fragments ──────────────────────────────────────────────────

  const quorumRow = (item, tone = "hero") => (
    item.quorum?.quorumTarget ? (
      <button
        type="button"
        className="voting-quorum-row"
        title={t("voting.quorumTitle")}
        onClick={() => setDetail({ kind: "quorum", item })}
      >
        <span className="voting-quorum-row__label">{t("voting.quorumLabel")}</span>
        <ChartArrival as="span" name={`voting:quorum:${item.id}`} className="voting-quorum-row__track" aria-hidden="true">
          <i className={`voting-quorum-row__fill voting-quorum-row__fill--${tone} arrive-meter`} style={{ width: `${quorumPct(item.quorum)}%` }} />
        </ChartArrival>
        <span className="voting-quorum-row__count">{quorumTurnoutText(t, item.quorum)}</span>
      </button>
    ) : null
  );

  // Demo receipts are minted locally (an 8-char sample, not the DB-backed
  // SG-XXXX-XXXX namespace) and the /verify RPC would honestly report them
  // not found — so in demo the strip labels the code a sample and the verify
  // affordance never renders. Verification is a live-vote promise only.
  const receiptStrip = (item) => (
    <div className="voting-receipt-strip">
      <span className="voting-receipt-strip__check" aria-hidden="true">✓</span>
      <span className="voting-receipt-strip__text">{t(demo ? "voting.submittedReceiptDemo" : "voting.submittedReceipt", { code: item.receiptCode || "—" })}</span>
      {demo
        ? <span className="voting-verify-link voting-verify-link--demo">{t("voting.sampleReceipt")}</span>
        : <a className="voting-verify-link" href="/verify" target="_blank" rel="noopener">{t("voting.verifyIt")}</a>}
    </div>
  );

  // ── phone: mpg.voting ─────────────────────────────────────────────────

  const heroCard = primary && !primaryVoted && (
    <section className="voting-hero" aria-label={t("voting.secretBallot")}>
      <div className="voting-hero__badge">
        <span className="voting-hero__dot" aria-hidden="true" />
        <span className="voting-hero__badge-text">{t("voting.secretBallot")} · {primary.meta}</span>
        {crunch && <span className="voting-hero__countdown">{countdown}</span>}
      </div>
      <h2 className="voting-hero__title">{primary.title}</h2>
      <OfficerRemovalSummary chapterId={primary.chapterId} detail={primary.officerRemoval} />
      <p className="voting-hero__sub">{primary.body || t("voting.heroSub")}</p>
      <button type="button" className="voting-hero__docs" onClick={() => setDetail({ kind: "ballot", item: primary })}>
        <span aria-hidden="true"><FileText size={18} /></span>
        <span>{t("voting.fullProposal")}</span>
        <b aria-hidden="true">›</b>
      </button>
      <div className="voting-hero__actions">
        {/* Every configured option is reachable from the hero row — a third
            or later choice (e.g. Abstain) renders with the same neutral
            bordered treatment as the non-primary options. */}
        {(primary.options || []).map((option, index) => (
          <button
            key={option.id}
            type="button"
            className={index === 0 ? "voting-hero__approve" : "voting-hero__reject"}
            onClick={() => castThrough(primary, option.id)}
          >
            {option.label}
          </button>
        ))}
        {(primary.options || []).length === 0 && (
          <button type="button" className="voting-hero__approve" onClick={() => castThrough(primary)}>{t("voting.castVote")}</button>
        )}
      </div>
      <p className="voting-hero__anon"><ShieldCheck size={16} aria-hidden="true" /> {t("voting.anonNote")}</p>
    </section>
  );

  const votedCard = primary && primaryVoted && (
    <section className="voting-card voting-voted" aria-label={t("voting.votedTitle")}>
      <span className="voting-voted__seal" aria-hidden="true">✓</span>
      <h2 className="voting-voted__title">{t("voting.ballotIn")}</h2>
      {primary.receiptCode && <p className="voting-voted__code">{primary.receiptCode}</p>}
      <p className="voting-voted__meta">
        {primary.quorum?.quorumTarget
          ? t("voting.votedMeta", { turnout: quorumTurnoutText(t, primary.quorum) })
          : t("voting.votedMetaNoQuorum")}
      </p>
      {demo
        ? <span className="voting-voted__verify voting-voted__verify--demo">{t("voting.sampleReceipt")}</span>
        : <a className="voting-voted__verify" href="/verify" target="_blank" rel="noopener">{t("voting.verifyReceipt")}</a>}
    </section>
  );

  const electionCards = <>
    {nominationsClient && <BallotNominations client={nominationsClient} />}
    {(onOpenCampaigns || campaignsSwitch) && <section className="voting-card voting-run-ballot">
      <h2 className="voting-none__title">{t("voting.runBallotTitle")}</h2>
      <p className="voting-none__body">{t("voting.runBallotBody")}</p>
      {onOpenCampaigns
        ? <button type="button" className="voting-btn voting-btn--soft" onClick={onOpenCampaigns}>{t("voting.runBallotAction")}</button>
        : <button type="button" className="voting-btn voting-btn--soft" onClick={campaignsSwitch.onSwitch}>{t("voting.runBallotSwitch", { role: campaignsSwitch.label })}</button>}
    </section>}
  </>;

  const noOpenCard = openBallots.length === 0 && (
    <section className="voting-card voting-none">
      <h2 className="voting-none__title">{t("voting.noOpenTitle")}</h2>
      <p className="voting-none__body">{t("voting.noOpenBody")}</p>
    </section>
  );

  const extraOpenRows = (compact) => extraOpen.map((item) => (
    <div className="voting-card voting-extra" key={item.id}>
      <div className="voting-extra__chips">
        <span className="voting-chip voting-chip--official">{t("voting.officialChip")}</span>
        <span className="voting-chip voting-chip--closes">{item.meta}</span>
      </div>
      {desktop
        ? <h2 className="voting-extra__title">{item.title}</h2>
        : <h3 className="voting-extra__title">{item.title}</h3>}
      <OfficerRemovalSummary chapterId={item.chapterId} detail={item.officerRemoval} />
      {!compact && <p className="voting-extra__sub">{item.body || t("voting.officialSub")}</p>}
      {!compact && (
        <div className="voting-extra__options">
          {/* No selected echo here: the client never learns which option a
              cast ballot carried, so a voted row shows plain options and the
              tap routes to the read-only detail instead of the cast flow. */}
          {(item.options || []).map((option) => (
            <button
              key={option.id}
              type="button"
              className="voting-option"
              onClick={() => (item.receiptCode ? setDetail({ kind: "ballot", item }) : castThrough(item, option.id))}
            >
              <span className="voting-option__dot" aria-hidden="true"></span>
              <span className="voting-option__label">{option.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="voting-anon-strip"><span aria-hidden="true"><ShieldCheck size={16} /></span><span>{t("voting.anonMode")}</span></div>
      {item.receiptCode
        ? receiptStrip(item)
        : <button type="button" className="voting-extra__submit" onClick={() => castThrough(item)}>{t("voting.reviewSubmit")}</button>}
    </div>
  ));

  const pulseCards = pulses.map((item) => {
    const answered = Boolean(item.selectedOption);
    return (
      <div className="voting-card voting-pulse" key={item.id} id={`survey-${item.id}`}>
        <div className="voting-pulse__head">
          <span className="voting-chip voting-chip--pulse">{t("voting.pulseChip")}</span>
          <span className="voting-pulse__meta">{item.meta}</span>
        </div>
        {desktop
          ? <h2 className="voting-pulse__title">{item.title}</h2>
          : <h3 className="voting-pulse__title">{item.title}</h3>}
        {item.body && <p className="voting-pulse__body">{item.body}</p>}
        {!answered && !item.closed && (
          <div className="voting-pulse__opts">
            {(item.options || []).map((option) => (
              <button key={option.id} type="button" className="voting-pulse__opt" onClick={() => castThrough(item, option.id)}>
                {option.label}
              </button>
            ))}
          </div>
        )}
        {answered && (
          <div className="voting-done-strip">
            <span className="voting-done-strip__check" aria-hidden="true">✓</span>
            {/* BUG-UG-CLOSED-POLL-PROMISES-RESULTS-20261106: Voting never
                shows pulse results, so a closed poll must not promise them. */}
            <span>{item.closed ? closedPollRecordedLine(lang, optionLabel(item, item.selectedOption)) : t("voting.pulseRecorded", { label: optionLabel(item, item.selectedOption) })}</span>
          </div>
        )}
        {!answered && item.closed && (
          <div className="voting-done-strip voting-done-strip--muted"><span>{t("voting.closedChip")}</span></div>
        )}
      </div>
    );
  });

  const suggestCardPhone = canSuggest && (
    <div className="voting-card voting-suggest">
      <div className="voting-pulse__head">
        <span className="voting-chip voting-chip--polls">{t("voting.pollsChip")}</span>
        <span className="voting-pulse__meta">{t("voting.pollsMeta")}</span>
      </div>
      <h3 className="voting-pulse__title">{t("voting.suggestTitle")}</h3>
      {pollSent ? (
        <div className="voting-done-strip">
          <span className="voting-done-strip__check" aria-hidden="true">✓</span>
          <span>{t("voting.pollSent")}</span>
          <button type="button" className="voting-btn voting-btn--soft" onClick={() => setPollSent(false)}>{t("voting.suggestAnother")}</button>
        </div>
      ) : (
        <form className="voting-suggest__row" onSubmit={submitPoll}>
          <div className="voting-suggest__entry">
            <input
              className="voting-suggest__input"
              value={pollDraft}
              onChange={(event) => setPollDraft(event.target.value)}
              placeholder={t("voting.suggestPlaceholder")}
              aria-label={t("voting.suggestTitle")}
            />
            <BusyButton type="submit" className="voting-suggest__send" pending={pollBusy} disabled={!pollDraft.trim()}>{t("voting.send")}</BusyButton>
          </div>
          <RadioGroup className="voting-scope-row" aria-label={t("voting.suggestAudience")}>
            <button type="button" role="radio" aria-checked={pollScope === "chapter"} className={`voting-chip voting-scope${pollScope === "chapter" ? " voting-scope--on" : ""}`} onClick={() => setPollScope("chapter")}>{t("voting.myChapter")}</button>
            <button type="button" role="radio" aria-checked={pollScope === "local"} className={`voting-chip voting-scope${pollScope === "local" ? " voting-scope--on" : ""}`} onClick={() => setPollScope("local")}>{t("voting.wholeLocal")}</button>
          </RadioGroup>
        </form>
      )}
    </div>
  );

  const pastRows = pastBallots.map((item) => {
    // Summary line only when one option actually leads — tied ballots send
    // the reader to the dialog's full bars instead.
    const leader = pastLeader(item);
    return (
    <button key={item.id} type="button" className="voting-past-row" onClick={() => setDetail({ kind: "ballot", item })}>
      <span className="voting-past-row__copy">
        <strong>{item.title}</strong>
        <small>
          {item.meta}
          {item.quorum?.quorumTarget ? ` · ${quorumTurnoutText(t, item.quorum)}` : ""}
          {leader ? ` · ${t("voting.resultLead", { label: leader.label, pct: leader.pct })}` : ""}
        </small>
      </span>
      <span className={`voting-chip ${item.receiptCode ? "voting-chip--done" : "voting-chip--official"}`}>
        {item.receiptCode ? t("voting.votedChip") : t("voting.closedChip")}
      </span>
      <b className="voting-past-row__chev" aria-hidden="true">›</b>
    </button>
    );
  });

  /* Filter buttons, not ARIA tabs: the app has never implemented the tab
     keyboard model, so these follow the swept aria-pressed pattern
     (tests/aria-tab-sweep.test.js). Rendered at EVERY width: /m/voting/ballots
     and /m/voting/past are focused pages, and a phone that only advertised them
     from the desktop header left them reachable by typed URL alone (PR1815
     DISCOVERABLE_PARENT_REQUIRED at 390). */
  const tabStrip = (
    <div className="voting-tabs" role="group" aria-label={t("voting.desktopTitle")}>
      <RoutedTabLink group="voting" value={"ballots"} type="button" aria-pressed={tab === "ballots"} className={`voting-tab${tab === "ballots" ? " voting-tab--on" : ""}`} onClick={() => setTab("ballots")}>{t("voting.tabBallots")}</RoutedTabLink>
      <RoutedTabLink group="voting" value={"past"} type="button" aria-pressed={tab === "past"} className={`voting-tab${tab === "past" ? " voting-tab--on" : ""}`} onClick={() => setTab("past")}>{t("voting.tabPast")}</RoutedTabLink>
    </div>
  );

  const phone = (
    <>
      <header className="protohead">
        <h1 className="protohead__title">{t("nav.voting")}</h1>
        <p className="voting-ph__sub">{headerChip}</p>
        {tabStrip}
      </header>
      <div className="voting-stack">
        {tab === "ballots" && <>
        {heroCard}
        {votedCard}
        {noOpenCard}
        {electionCards}
        {primary && !primaryVoted && (
          <button type="button" className="voting-card voting-deal" onClick={() => setDetail({ kind: "ballot", item: primary })}>
            <span className="voting-deal__icon" aria-hidden="true"><Search size={18} /></span>
            <span className="voting-deal__copy">
              <strong>{t("voting.notSureTitle")}</strong>
              <small>{t("voting.notSureSub")}</small>
            </span>
            <b aria-hidden="true">›</b>
          </button>
        )}
        {extraOpenRows(false)}
        {(pulses.length > 0 || canSuggest) && (
          <div>
            <p className="voting-kicker">{t("voting.surveysKicker")}</p>
            <div className="voting-substack">
              {pulseCards}
              {suggestCardPhone}
            </div>
          </div>
        )}
        </>}
        {tab === "past" && (
          <div>
            <p className="voting-kicker">{t("voting.pastKicker")}</p>
            {pastBallots.length === 0
              ? <p className="voting-none__body voting-pastlist__empty">{t("voting.pastEmpty")}</p>
              : <div className="voting-substack">{pastRows}</div>}
          </div>
        )}
        <div className="voting-substack voting-phone-info">
          <section className="voting-card">
            <h3 className="voting-rail__head">{t("voting.howTitle")}</h3>
            <ul className="voting-rules">
              {rules.map((rule) => <li key={rule}><span aria-hidden="true">✓</span><p>{rule}</p></li>)}
            </ul>
          </section>
          {(onMessageSteward || noSteward) && (
            <section className="voting-card voting-rail-dark">
              <h3 className="voting-rail__head voting-rail-dark__head">{t("voting.questionsTitle")}</h3>
              {questionsBody}
            </section>
          )}
        </div>
      </div>
    </>
  );

  // ── desktop: pg.voting ────────────────────────────────────────────────

  const desktopOpenVote = primary && !primaryVoted && (
    <section className="voting-stat voting-openvote" aria-label={t("voting.openVote")}>
      <div className="voting-openvote__chips">
        <span className="voting-chip voting-chip--open">{t("voting.openVote")}</span>
        {crunch
          ? <span className="voting-chip voting-chip--crunch"><span aria-hidden="true">⏳</span> {t("voting.closesIn", { time: countdown })}</span>
          : <span className="voting-chip voting-chip--closes">{primary.meta}</span>}
      </div>
      <button type="button" className="voting-openvote__title" title={t("voting.fullProposal")} onClick={() => setDetail({ kind: "ballot", item: primary })}>
        {primary.title}
      </button>
      <OfficerRemovalSummary chapterId={primary.chapterId} detail={primary.officerRemoval} />
      <p className="voting-openvote__sub">{t("voting.heroSub")}</p>
      {primary.body && <p className="voting-openvote__details">{primary.body}</p>}
      {quorumRow(primary, "hero")}
      <div className="voting-openvote__cta">
        <button type="button" className="voting-btn voting-btn--green voting-openvote__cast" onClick={() => castThrough(primary)}>{t("voting.castVote")}</button>
        <button type="button" className="voting-btn voting-btn--soft" onClick={() => setDetail({ kind: "ballot", item: primary })}>{t("voting.readSummary")}</button>
      </div>
    </section>
  );

  const desktopVoted = primary && primaryVoted && (
    <section className="voting-stat voting-openvote voting-openvote--voted" aria-label={t("voting.votedTitle")}>
      <div className="voting-voted-head">
        <span className="voting-voted-head__seal" aria-hidden="true">✓</span>
        <div>
          <h2 className="voting-voted-head__title">{t("voting.votedTitle")}</h2>
          <p className="voting-voted-head__sub">{primary.title} · {t("voting.votedSub")}</p>
        </div>
      </div>
      {quorumRow(primary, "success")}
      {primary.receiptCode ? receiptStrip(primary) : <p className="voting-openvote__sub">{t("voting.votedMetaNoQuorum")}</p>}
    </section>
  );

  const desktopNoOpen = openBallots.length === 0 && (
    <section className="voting-stat voting-none">
      <h2 className="voting-none__title">{t("voting.noOpenTitle")}</h2>
      <p className="voting-none__body">{t("voting.noOpenBody")}</p>
    </section>
  );

  const desktopPast = (
    <section className="voting-stat voting-pastlist">
      <h2 className="voting-pastlist__head">{t("voting.pastTitle")}</h2>
      {pastBallots.length === 0
        ? <p className="voting-none__body voting-pastlist__empty">{t("voting.pastEmpty")}</p>
        : <div className="voting-pastlist__rows">{pastRows}</div>}
    </section>
  );

  const desktopRail = (
    <aside className="voting-rail" aria-label={t("voting.howTitle")}>
      <section className="voting-stat">
        <h2 className="voting-rail__head">{t("voting.howTitle")}</h2>
        <ul className="voting-rules">
          {rules.map((rule) => <li key={rule}><span aria-hidden="true">✓</span><p>{rule}</p></li>)}
        </ul>
      </section>
      {(onMessageSteward || noSteward) && (
        <section className="voting-stat voting-rail-dark">
          <h2 className="voting-rail__head voting-rail-dark__head">{t("voting.questionsTitle")}</h2>
          {questionsBody}
        </section>
      )}
      {canSuggest && (
        <section className="voting-stat voting-rail-suggest">
          <div className="voting-rail-suggest__head"><span aria-hidden="true"><MessageSquareText size={18} /></span><h2 className="voting-rail__head">{t("voting.suggestDesktopTitle")}</h2></div>
          <p className="voting-rail-suggest__body">{t("voting.suggestBody")}</p>
          {pollSent ? (
            <div className="voting-done-strip">
              <span className="voting-done-strip__check" aria-hidden="true">✓</span>
              <span>{t("voting.pollSent")}</span>
              <button type="button" className="voting-btn voting-btn--soft" onClick={() => setPollSent(false)}>{t("voting.suggestAnother")}</button>
            </div>
          ) : (
            <form onSubmit={submitPoll}>
              <input
                className="voting-suggest__input voting-rail-suggest__input"
                value={pollDraft}
                onChange={(event) => setPollDraft(event.target.value)}
                placeholder={t("voting.suggestPlaceholderDesktop")}
                aria-label={t("voting.suggestDesktopTitle")}
              />
              <RadioGroup className="voting-scope-row" aria-label={t("voting.suggestAudience")}>
                <button type="button" role="radio" aria-checked={pollScope === "chapter"} className={`voting-chip voting-scope${pollScope === "chapter" ? " voting-scope--on" : ""}`} onClick={() => setPollScope("chapter")}>{t("voting.myChapter")}</button>
                <button type="button" role="radio" aria-checked={pollScope === "local"} className={`voting-chip voting-scope${pollScope === "local" ? " voting-scope--on" : ""}`} onClick={() => setPollScope("local")}>{t("voting.wholeLocal")}</button>
              </RadioGroup>
              <BusyButton type="submit" className="voting-btn voting-btn--green voting-rail-suggest__submit" pending={pollBusy} disabled={!pollDraft.trim()}>{t("voting.submitReview")}</BusyButton>
            </form>
          )}
        </section>
      )}
    </aside>
  );

  const desktopBody = (
    <>
      <header className="voting-ph">
        <div>
          <h1 className="voting-ph__title">{t("nav.voting")}</h1>
          <p className="voting-ph__sub">{t("voting.desktopSub")}</p>
        </div>
        {tabStrip}
        <span className="voting-count-chip">{headerChip}</span>
      </header>
      <div className="voting-columns">
        <div className="voting-main">
          {tab === "ballots" && (
            <>
              {desktopOpenVote}
              {desktopVoted}
              {desktopNoOpen}
              {electionCards}
              {extraOpenRows(false)}
              {pulses.length > 0 && (
                <section aria-label={t("voting.surveysKicker")}>
                  <p className="voting-kicker">{t("voting.surveysKicker")}</p>
                  <div className="voting-substack">{pulseCards}</div>
                </section>
              )}
            </>
          )}
          {tab === "past" && desktopPast}
        </div>
        {desktopRail}
      </div>
    </>
  );

  // ── tap-through detail dialogs (prototype dd:vote / dd:vote2 / dd:quorum) ─

  const detailResults = detail?.kind === "ballot" ? resultRows(detail.item.results) : null;
  const detailDialog = detail && detail.kind === "ballot" && (
    <Dialog eyebrow={t("voting.detailEyebrow")} title={detail.item.title} onClose={() => setDetail(null)}>
      <div className="voting-detail">
        <p className="voting-detail__meta">{detail.item.meta}</p>
        <OfficerRemovalSummary chapterId={detail.item.chapterId} detail={detail.item.officerRemoval} />
        {detail.item.body && <p className="voting-detail__body">{detail.item.body}</p>}
        {detailResults ? (
          <>
            <p className="voting-kicker">{t("voting.resultsKicker")}</p>
            <ChartArrival name={`voting:results:${detail.item.id}`} className="voting-detail__results">
              {/* Per-option counts only — never WHO. The aggregate arrives from
                  get_ballot_tally after close; the member's own pick stays
                  unknowable (20260808230000) even on their voted ballot. */}
              {detailResults.map((row, index) => (
                <div key={row.optionId} className="voting-result-row">
                  <span className="voting-result-row__label">{row.label}</span>
                  <span className="voting-quorum-row__track" aria-hidden="true">
                    <i className={`voting-quorum-row__fill voting-quorum-row__fill--${row.leading ? "success" : "hero"} arrive-x`} style={arriveAt(index, { width: `${row.pct}%` })} />
                  </span>
                  <span className="voting-result-row__count">{t("voting.resultVotes", { votes: row.votes, pct: row.pct })}</span>
                </div>
              ))}
            </ChartArrival>
          </>
        ) : (detail.item.options || []).length > 0 && (
          <>
            <p className="voting-kicker">{t("voting.detailOptions")}</p>
            <div className="voting-detail__options">
              {/* Never a selected echo: a cast choice is stored unlinkably
                  (20260808230000), so the client does not know it and the
                  detail must not pretend to. Voted state is the receipt. */}
              {detail.item.options.map((option) => (
                <div key={option.id} className="voting-option">
                  <span className="voting-option__dot" aria-hidden="true"></span>
                  <span className="voting-option__label">{option.label}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {detail.item.quorum?.quorumTarget ? (
          <div className="voting-detail__quorum">
            <p className="voting-kicker">{t("voting.quorumLabel")}</p>
            <ChartArrival as="span" name={`voting:quorum-detail:${detail.item.id}`} className="voting-quorum-row__track" aria-hidden="true">
              <i className="voting-quorum-row__fill voting-quorum-row__fill--hero arrive-meter" style={{ width: `${quorumPct(detail.item.quorum)}%` }} />
            </ChartArrival>
            <p className="voting-detail__meta">{quorumTurnoutText(t, detail.item.quorum)}</p>
          </div>
        ) : null}
        {detail.item.receiptCode && (
          <div className="voting-receipt-strip">
            <span className="voting-receipt-strip__check" aria-hidden="true">✓</span>
            <span className="voting-receipt-strip__text">{t(demo ? "voting.sampleReceiptCode" : "today.receipt", { code: detail.item.receiptCode })}</span>
            {demo
              ? <span className="voting-verify-link voting-verify-link--demo">{t("voting.sampleReceipt")}</span>
              : <a className="voting-verify-link" href="/verify" target="_blank" rel="noopener">{t("voting.verifyIt")}</a>}
          </div>
        )}
        <p className="voting-detail__anon"><ShieldCheck size={16} aria-hidden="true" /> {t("voting.anonMode")}</p>
        {!detail.item.closed && !detail.item.receiptCode && (
          <button type="button" className="dialog-primary" onClick={() => castThrough(detail.item)}>{t("voting.detailVote")}</button>
        )}
      </div>
    </Dialog>
  );

  const quorumDialog = detail && detail.kind === "quorum" && detail.item.quorum && (
    <Dialog eyebrow={t("voting.detailEyebrow")} title={t("voting.quorumTitle")} onClose={() => setDetail(null)}>
      <ChartArrival name={`voting:quorum-hero:${detail.item.id}`} className="voting-detail">
        <p className="voting-quorum-hero">
          <strong><ArrivalCount value={detail.item.quorum.totalVotes} /></strong>
          <span>{t("voting.quorumOf", { target: detail.item.quorum.quorumTarget, pct: quorumPct(detail.item.quorum) })}</span>
        </p>
        <span className="voting-quorum-row__track voting-quorum-row__track--tall" aria-hidden="true">
          <i className="voting-quorum-row__fill voting-quorum-row__fill--hero arrive-meter" style={{ width: `${quorumPct(detail.item.quorum)}%` }} />
        </span>
        <p className="voting-detail__meta">{t("voting.quorumExplain")}</p>
        <p className="voting-kicker">{t("voting.finePrint")}</p>
        <ul className="voting-rules">
          {rules.map((rule) => <li key={rule}><span aria-hidden="true">✓</span><p>{rule}</p></li>)}
        </ul>
        {!detail.item.closed && !detail.item.receiptCode && (
          <button type="button" className="dialog-primary" onClick={() => castThrough(detail.item)}>{t("voting.castVote")}</button>
        )}
      </ChartArrival>
    </Dialog>
  );

  // ── alternate shell: the prototype's Votes page (pages/votes.js) ───────
  // The same plan items, cast path, poll draft and detail dialogs, in the
  // design's markup (src/alt/takepart/VotesPage.jsx).
  if (alt) {
    return (
      <VotesPage
        demo={demo}
        primary={primary}
        primaryClose={primary ? closesAtMs(primary) : null}
        primaryQuorumPct={primary?.quorum?.quorumTarget ? quorumPct(primary.quorum) : null}
        extraOpen={extraOpen}
        surveys={pulses.map((item) => ({ item, recorded: optionLabel(item, item.selectedOption) }))}
        past={pastBallots.map((item) => ({ item, leader: pastLeader(item) }))}
        rules={rules}
        poll={{ enabled: canSuggest, draft: pollDraft, setDraft: setPollDraft, scope: pollScope, setScope: setPollScope, sent: pollSent, setSent: setPollSent, busy: pollBusy, submit: submitPoll }}
        onCast={castThrough}
        onDetail={(item) => setDetail({ kind: "ballot", item })}
        onQuorum={(item) => setDetail({ kind: "quorum", item })}
        onMessageSteward={noSteward ? null : onMessageSteward}
        noStewardNote={noSteward ? <NoStewardNote presence={stewardPresence} className="ug-ta-muted" /> : null}
        onOpenHome={onOpenHome}
        verifyReceipt={verifyReceipt}
        focusPast={tab === "past"}
        dialogs={<>{detailDialog}{quorumDialog}</>}
        extra={electionCards}
      />
    );
  }

  return (
    <div className={`screen voting-screen${desktop ? " voting-screen--desktop" : ""}`}>
      {desktop ? desktopBody : phone}
      {detailDialog}
      {quorumDialog}
    </div>
  );
}
