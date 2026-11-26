import { useMemo, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../lib/i18n.js";
import { captureSanitizedDiagnostic } from "../lib/deferredObservability.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { Compass, Handshake, PencilLine } from "lucide-react";
import { DemoVoiceMember } from "../components/DemoVoiceMember.jsx";
import { MemberEngagement } from "../features/engagement/MemberEngagement.jsx";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";

// The Union Base prototype's "Be heard" page (pg.voice, dc.html 3815–3840),
// rebuilt as a live member screen. The prototype has no phone twin for this
// page, so one component serves both: the phone stacks, `desktop` widens the
// three how-it-works cards into the prototype's 3-up grid.
//
// DATA HONESTY — what this screen is allowed to say:
//   The prototype's page is mostly a mock-up of features that do not exist.
//   Its suggestions feed, its "3 open threads in your unit", its contract
//   survey with "214 of 313 have answered", and its whole "You said → the
//   union did" response tracker have NO backing table, no loader and no
//   route. None of them are rendered here, and none of their numbers appear
//   anywhere in this file (see the deviations list in the wave manifest).
//
//   Three things are real, and they are the whole screen:
//     1. the composer, whose submit hands the draft to Compass through
//        onSuggest(text, scope) — the same callback shape VotingView's poll
//        suggestion box uses, wired by App to openCompassWithDraft;
//     2. "Message a steward" via onMessageSteward(), wired by App to
//        /m/messages — the human path, for when Compass is not what the
//        member wants;
//     3. `threads` — the member's OWN Compass threads (data.guideThreads, the
//        same rows the Assistant renders), surfaced as "your recent asks".
//        Absent or empty, the section says so rather than inventing rows.
//
//   With neither callback wired the composer does not render at all: a send
//   button that cannot send is worse than an honest note.
//
// The global mobile top bar owns the logo/bell/avatar chrome, so this view
// renders no ScreenHeader — it opens with its own in-page header, `.protohead`
// on the phone (shared with Voice/Search/More) and `.bevoice-ph` on desktop.
const MAX_ASKS = 4;
const WEEKLY_QUESTION_MIN = 10;
const WEEKLY_QUESTION_MAX = 280;
const WEEKLY_OPTIONS_MIN = 2;

export function VoiceView({
  desktop = false,
  demo = false,
  fixtureDemo = false,
  threads = null,
  onSuggest,
  onMessageSteward,
  onOpenQa,
  onAssistant,
  weeklyQuestions = null,
  onSubmitWeeklyQuestion,
  onBoostWeeklyQuestion,
  onPromoteWeeklyQuestion,
  engagementClient = null,
  engagementOrganizationId = null,
  onNotice = () => {},
  onEngagementChanged = null,
}) {
  const { t, lang } = useLang();
  const previewFixture = fixtureDemo || (demo && !engagementClient);

  const [draft, setDraft] = useDeviceParityState("voice.draft", "");
  const [scope, setScope] = useDeviceParityState("voice.scope", "chapter");
  const [busy, setBusy] = useState(false);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [sent, setSent] = useDeviceParityState("voice.sent", false);
  const [weeklyDraft, setWeeklyDraft] = useState("");
  const [weeklyOptions, setWeeklyOptions] = useState(["", ""]);
  const [weeklyBusy, setWeeklyBusy] = useState(false);
  const [weeklyError, setWeeklyError] = useState("");
  const weeklyBody = weeklyDraft.trim();
  const answeredWeeklyOptions = weeklyOptions.map((option) => option.trim()).filter(Boolean);
  const weeklyQuestionTooShort = weeklyBody.length < WEEKLY_QUESTION_MIN;
  const weeklyNeedsOptions = answeredWeeklyOptions.length < WEEKLY_OPTIONS_MIN;
  const weeklyBlocked = weeklyQuestionTooShort || weeklyNeedsOptions;
  const weeklyBlockReason = [
    weeklyQuestionTooShort && t("bevoice.weeklyQuestionTooShort", { count: WEEKLY_QUESTION_MIN }),
    weeklyNeedsOptions && t("bevoice.weeklyNeedOptions", { count: WEEKLY_OPTIONS_MIN }),
  ].filter(Boolean).join(" ");

  const canSend = Boolean(onSuggest || onMessageSteward);

  // Already ordered updated_at-desc by the loader; the slice is a display cap,
  // not a filter, so nothing is silently hidden beyond "recent".
  const asks = useMemo(() => (Array.isArray(threads) ? threads.slice(0, MAX_ASKS) : []), [threads]);

  function submit(event) {
    return runBusyWrite(busyWriteRef, "suggest", () => submitNow(event), event);
  }

  async function submitNow(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    if (onSuggest) {
      setBusy(true);
      try {
        await onSuggest(text, scope);
        // Cleared on purpose: the draft has MOVED to the Compass composer,
        // which is now open in front of the member. Two copies of the same
        // unsent sentence, only one of which can be sent, is a trap.
        setDraft("");
        setSent(true);
      } catch {
        // App's mutate() handler owns the failure toast.
      } finally {
        setBusy(false);
      }
      return;
    }
    // No Compass wiring: route to the steward, who is the reader either way.
    // The draft stays in the box — nothing is faked as delivered.
    onMessageSteward?.(text);
  }

  const header = desktop ? (
    <header className="bevoice-ph">
      <h1 className="bevoice-ph__title">{t("bevoice.title")}</h1>
      <p className="bevoice-ph__sub">{t("bevoice.sub")}</p>
    </header>
  ) : (
    <header className="protohead">
      <h1 className="protohead__title">{t("bevoice.title")}</h1>
      <p className="bevoice-ph__sub">{t("bevoice.sub")}</p>
    </header>
  );

  const composer = canSend && (
    <form className="bevoice-composer" onSubmit={submit}>
      <h2 className="bevoice-composer__title">{t("bevoice.composerTitle")}</h2>
      {sent ? (
        <div className="bevoice-sentrow" role="status">
          <span className="bevoice-sentrow__check" aria-hidden="true">✓</span>
          <span className="bevoice-sentrow__text">{t("bevoice.sentBody")}</span>
          <button type="button" className="bevoice-again" onClick={() => setSent(false)}>
            {t("bevoice.again")}
          </button>
        </div>
      ) : (
        <>
          <textarea
            className="bevoice-composer__input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("bevoice.composerPlaceholder")}
            aria-label={t("bevoice.composerTitle")}
            rows={3}
          />
          {/* Filter-style buttons with aria-pressed, not ARIA tabs or radios:
              the swept pattern in this app (tests/aria-tab-sweep.test.js). */}
          <div className="bevoice-scope" role="group" aria-label={t("bevoice.scopeLabel")}>
            <p className="bevoice-scope__label">{t("bevoice.scopeLabel")}</p>
            <button
              type="button"
              className="bevoice-scope__btn"
              aria-pressed={scope === "chapter"}
              onClick={() => setScope("chapter")}
            >
              {t("bevoice.scopeChapter")}
            </button>
            <button
              type="button"
              className="bevoice-scope__btn"
              aria-pressed={scope === "local"}
              onClick={() => setScope("local")}
            >
              {t("bevoice.scopeLocal")}
            </button>
          </div>
          <div className="bevoice-composer__foot">
            <p className="bevoice-composer__note">
              {onSuggest ? t("bevoice.composerNote") : t("bevoice.composerNoteSteward")}
            </p>
            <BusyButton type="submit" className="bevoice-send" pending={busy} disabled={!draft.trim()}>
              {busy ? t("bevoice.sending") : t("bevoice.send")}
            </BusyButton>
          </div>
        </>
      )}
    </form>
  );

  const noSend = !canSend && (
    <p className="bevoice-empty">{t("bevoice.noSendBody")}</p>
  );

  // Descriptive copy about the flow the member is standing in — no counts, no
  // feeds, no per-unit figures. This is the slot the prototype's three mocked
  // cards (Report an issue / Join an issue thread / Open survey) occupied.
  const how = (
    <div className="bevoice-how">
      <section className="bevoice-card">
        <div className="bevoice-card__icon" aria-hidden="true"><PencilLine size={18} /></div>
        <h3 className="bevoice-card__title">{t("bevoice.how1Title")}</h3>
        <p className="bevoice-card__body">{t("bevoice.how1Body")}</p>
      </section>
      <section className="bevoice-card">
        <div className="bevoice-card__icon" aria-hidden="true"><Compass size={18} /></div>
        <h3 className="bevoice-card__title">{t("bevoice.how2Title")}</h3>
        <p className="bevoice-card__body">{t("bevoice.how2Body")}</p>
      </section>
      <section className="bevoice-card">
        <div className="bevoice-card__icon" aria-hidden="true"><Handshake size={18} /></div>
        <h3 className="bevoice-card__title">{t("bevoice.how3Title")}</h3>
        <p className="bevoice-card__body">{t("bevoice.how3Body")}</p>
      </section>
    </div>
  );

  const steward = onMessageSteward && (
    <section className="bevoice-steward">
      <h2 className="bevoice-steward__title">{t("bevoice.stewardTitle")}</h2>
      <p className="bevoice-steward__body">{t("bevoice.stewardBody")}</p>
      <button type="button" className="bevoice-steward__cta" onClick={() => onMessageSteward()}>
        {t("bevoice.stewardCta")}
      </button>
    </section>
  );

  const qa = onOpenQa && (
    <section className="bevoice-steward" data-mi1-surface="voice-qa">
      <h2 className="bevoice-steward__title">{t("bevoice.qaTitle")}</h2>
      <p className="bevoice-steward__body">{t("bevoice.qaBody")}</p>
      <button type="button" className="bevoice-steward__cta" onClick={() => onOpenQa()}>
        {t("bevoice.qaCta")}
      </button>
    </section>
  );

  // Rendered only when the caller passes threads at all: a member app that has
  // not wired guideThreads should show no section, not an empty one.
  const asksSection = Array.isArray(threads) && (
    <section className="bevoice-asks">
      <h2 className="bevoice-asks__head">{t("bevoice.asksKicker")}</h2>
      {asks.length === 0 ? (
        <p className="bevoice-asks__empty">{t("bevoice.asksEmpty")}</p>
      ) : (
        asks.map((thread) => (
          <div className="bevoice-asks__row" key={thread.id}>
            <span className="bevoice-asks__copy">
              <p className="bevoice-asks__title">{thread.title}</p>
              <p className="bevoice-asks__meta">
                {t("bevoice.askMeta", { date: formatDateTimeWithZone(thread.updated_at ?? thread.created_at, lang) })}
              </p>
            </span>
            <span className="bevoice-asks__chip">{t("bevoice.askChip")}</span>
          </div>
        ))
      )}
      {/* One button, not per-row links: the Assistant takes an initial draft
          but has no "open thread N" entry point, so a row that claimed to
          open its own thread would not. */}
      {onAssistant && (
        <div className="bevoice-asks__foot">
          <button type="button" className="bevoice-asks__open" onClick={() => onAssistant()}>
            {t("bevoice.asksOpen")}
          </button>
        </div>
      )}
    </section>
  );

  function submitWeekly(event) {
    return runBusyWrite(busyWriteRef, "weekly", () => submitWeeklyNow(event), event);
  }

  async function submitWeeklyNow(event) {
    event.preventDefault();
    if (!onSubmitWeeklyQuestion || weeklyBlocked || weeklyBusy) return;
    setWeeklyBusy(true);
    setWeeklyError("");
    try {
      const result = await onSubmitWeeklyQuestion(weeklyBody, answeredWeeklyOptions);
      if (result) { setWeeklyDraft(""); setWeeklyOptions(["", ""]); }
    } catch (error) {
      captureSanitizedDiagnostic({
        kind: "weekly_question_submit_failure",
        code: error?.code,
        name: error?.name,
      });
      setWeeklyError(t("bevoice.weeklySubmitFailed"));
    } finally {
      setWeeklyBusy(false);
    }
  }

  const weeklySection = Array.isArray(weeklyQuestions) && (
    <section className="bevoice-weekly" aria-labelledby="weekly-question-title">
      <div className="bevoice-weekly__head">
        <div>
          <p className="bevoice-kicker">{t("bevoice.weeklyKicker")}</p>
          <h2 id="weekly-question-title">{t("bevoice.weeklyTitle")}</h2>
        </div>
        <p>{t("bevoice.weeklyHelp")}</p>
      </div>
      {onSubmitWeeklyQuestion && !weeklyQuestions.some((question) => question.submittedByMe) && (
        <form className="bevoice-weekly__form" onSubmit={submitWeekly}>
          <label htmlFor="weekly-question-draft">{t("bevoice.weeklyLabel")}</label>
          <textarea
            id="weekly-question-draft"
            value={weeklyDraft}
            onChange={(event) => setWeeklyDraft(event.target.value)}
            minLength={WEEKLY_QUESTION_MIN}
            maxLength={WEEKLY_QUESTION_MAX}
            rows={3}
            placeholder={t("bevoice.weeklyPlaceholder")}
          />
          <fieldset className="bevoice-weekly__options">
            <legend>{t("bevoice.weeklyOptions", { count: WEEKLY_OPTIONS_MIN })}</legend>
            {weeklyOptions.map((option, index) => (
              <label key={`weekly-option-${index}`}>
                <span>{t("bevoice.weeklyOption", { count: index + 1 })}</span>
                <input
                  value={option}
                  maxLength={120}
                  onChange={(event) => setWeeklyOptions((current) => current.map((item, at) => at === index ? event.target.value : item))}
                />
                {weeklyOptions.length > WEEKLY_OPTIONS_MIN && <button type="button" aria-label={t("bevoice.weeklyRemoveOption", { count: index + 1 })} onClick={() => setWeeklyOptions((current) => current.filter((_, at) => at !== index))}>×</button>}
              </label>
            ))}
            {weeklyOptions.length < 8 && <button type="button" onClick={() => setWeeklyOptions((current) => [...current, ""])}>{t("bevoice.weeklyAddOption")}</button>}
          </fieldset>
          <div>
            <small>{t("bevoice.weeklyBounded", { minimum: WEEKLY_QUESTION_MIN, maximum: WEEKLY_QUESTION_MAX })}</small>
            {weeklyError && <p role="alert">{weeklyError}</p>}
            <div>
              <BusyButton type="submit" pending={weeklyBusy} disabled={weeklyBlocked} disabledReason={weeklyBlockReason}>
                {weeklyBusy ? t("bevoice.sending") : t("bevoice.weeklySubmit")}
              </BusyButton>
            </div>
          </div>
        </form>
      )}
      {weeklyQuestions.length === 0 ? (
        <p className="bevoice-asks__empty">{t("bevoice.weeklyEmpty")}</p>
      ) : (
        <div className="bevoice-weekly__list">
          {weeklyQuestions.map((question) => (
            <article className="bevoice-weekly__row" key={question.id}>
              <div>
                <p>{question.body}</p>
                {(question.options || []).length > 0 && <p className="bevoice-weekly__choices">{question.options.join(" · ")}</p>}
                <small>
                  {question.priority ? `${t("bevoice.weeklyPriority")} · ` : ""}
                  {t("bevoice.weeklySupport", { count: question.score })}
                </small>
              </div>
              {onBoostWeeklyQuestion && !question.submittedByMe && (
                <BusyButton
                  type="button"
                  pending={weeklyBusy} disabled={question.boostedByMe}
                  onClick={() => runBusyWrite(busyWriteRef, "weekly", async () => {
                    setWeeklyBusy(true);
                    try { await onBoostWeeklyQuestion(question.id); } finally { setWeeklyBusy(false); }
                  })}
                >
                  {question.boostedByMe ? t("bevoice.weeklyBoosted") : t("bevoice.weeklyBoost")}
                </BusyButton>
              )}
              {onPromoteWeeklyQuestion && question.submittedByMe && !question.priority && (
                <BusyButton
                  type="button"
                  pending={weeklyBusy} disabled={!question.promotionAvailable}
                  disabledReason={t("bevoice.weeklyPromotionUnavailable")}
                  onClick={() => runBusyWrite(busyWriteRef, "weekly", async () => {
                    setWeeklyBusy(true);
                    try { await onPromoteWeeklyQuestion(question.id); } finally { setWeeklyBusy(false); }
                  })}
                >
                  {t("bevoice.weeklyPromote")}
                </BusyButton>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className={`screen bevoice-screen${desktop ? " bevoice-screen--desktop" : ""}`}>
      {header}
      <div className="bevoice-body">
        {composer}
        {noSend}
        <div className="bevoice-cardgroup">
          <p className="bevoice-kicker">{t("bevoice.howKicker")}</p>
          {how}
        </div>
        {steward}
        {qa}
        {previewFixture && <DemoVoiceMember lang={lang} showWeeklyFacade={!Array.isArray(weeklyQuestions)} />}
        {!previewFixture && <MemberEngagement client={engagementClient} organizationId={engagementOrganizationId} onNotice={onNotice} onSnapshotChanged={onEngagementChanged} />}
        {weeklySection}
        {asksSection}
      </div>
    </div>
  );
}
