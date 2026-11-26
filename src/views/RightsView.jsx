import { useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { BookOpen, FileText, Megaphone, Scale, Search, ShieldCheck, TriangleAlert } from "lucide-react";
import { LearningLearnArea } from "../features/learningContent/LearningLearnArea.jsx";
import { ContextualPulseSlot } from "../features/engagement/ContextualPulseSlot.jsx";
import { IssueSignalBanner } from "../features/issueIntelligence/IssueSignals.jsx";
import { RightsLawLibrary } from "../features/rightsLibrary/RightsLawLibrary.jsx";
import { RightsCommonQuestions } from "../features/rightsQuestions/RightsCommonQuestions.jsx";
import { rightsLibraryEnabled } from "../features/rightsLibrary/rightsLawLibrary.js";
import { Icon } from "../alt/icons.jsx";
import { HelpCrumbs } from "../alt/help/HelpParts.jsx";
import { useToastLifetime } from "../lib/useToastLifetime.js";
import { CitedCompassArticle } from "../features/compass/CitedCompassArticle.jsx";
import { compassArticleForFocus } from "../features/compass/compassSourceTarget.js";
import "../lib/i18n/features/altHelpPagesStrings.js";
import "../lib/i18n/features/learningContentStrings.js";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { noStewardNamed, STEWARD_PRESENCE } from "../lib/stewardConversations.js";
import { formatGroupMoment } from "../lib/i18n/zonedDates.js";

// The Union Base prototype's Learn surface. Phone mirrors mpgLearn (in-page
// "Learn" title, resume hero, guide rows, learning-pays card) with an in-view
// walkthrough detail; desktop mirrors pg.rights (page header + search, START
// HERE hero, walkthrough + say-this/steward rail, article grid). All lesson
// content, progress and scripts come from data.rights — nothing is seeded in
// this file. The global mobile top bar owns top chrome; this view renders none.
//
// Decorative glyphs per known lesson id (the rows in mpgLearn each carry one);
// unknown lessons fall back to a neutral book.
// Union Ground's organizing lessons carry their own ids; the shared seed
// ids stay mapped so a legacy row still gets its glyph.
const LESSON_ICONS = {
  "section-7": ShieldCheck, "supervisor-questions": Megaphone, "cards-majority": FileText, "captive-meeting": TriangleAlert, retaliation: Scale,
  weingarten: ShieldCheck, loudermill: Scale, harassment: Megaphone, pip: FileText, safety: TriangleAlert,
};
const FALLBACK_ICON = BookOpen;
const STEWARD_FOLLOW_UP_MS = 24 * 60 * 60 * 1000;

function completedCount(record) {
  return record.steps.reduce((count, _, index) => count + (record.completedSteps.includes(index) ? 1 : 0), 0);
}

// learningContent is App's wiring for governed mini-lessons (session client,
// session, selected organization and chapter, language); learningSection
// "manage" is the addressable editor page (/m/rights?learning=manage) and
// onLearningSection moves between it and the library.
// pulse: { client, configuration } for the reading-screen quick check
// (REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001); absent in previews.
// onMessageSteward opens the member's steward conversation from the laws and
// agencies library (REQ-UG-RIGHTS-LAW-LIBRARY-20261012), which renders
// below the lessons only while features.rights.law_library is on.
// REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the alternate shell's guide
// filter chips, each a test on a lesson's saved progress.
const ALT_GUIDE_FILTERS = Object.freeze(["all", "todo", "doing", "done"]);
function guideInFilter(filter, done, total) {
  if (filter === "todo") return done === 0;
  if (filter === "doing") return done > 0 && done < total;
  if (filter === "done") return total > 0 && done >= total;
  return true;
}

export function RightsView({ alt = false, onOpenHome = null, data, onAssistant, onSaveProgress, onRequestSteward, onMessageSteward = null, stewardRequests = [], stewardPresence = null, focus = null, desktop = false, learningContent = null, learningSection = null, onLearningSection = null, pulse = null, issueSignals = null }) {
  const { t, lang } = useLang();
  const rights = data.rights;
  const citedArticle = compassArticleForFocus(data?.kbArticles, focus?.view === "rights" ? focus : null);
  const cited = citedArticle ? <CitedCompassArticle article={citedArticle} /> : null;
  const records = useMemo(() => (
    rights.lessonRecords?.length
      ? rights.lessonRecords
      // The synthesized Section 7 record the worker loader falls back to.
      // No pre-marked progress: an untouched checklist starts untouched.
      : [{ id: "section-7", label: rights.selected, title: rights.title, description: rights.description, steps: rights.steps, script: rights.script, completedSteps: [] }]
  ), [rights]);

  const [lesson, setLesson] = useDeviceParityState("rights.lesson", rights.selected);
  const [detailOpen, setDetailOpen] = useDeviceParityState("rights.detailOpen", false);
  const [query, setQuery] = useDeviceParityState("rights.query", "");
  const [notice, setNotice] = useState("");
  // In-flight guard: a second tap before the request lands (and the status
  // line replaces the button) would file a duplicate and re-ping every
  // steward. Plain state, not parity-synced — it tracks one network call.
  const [requesting, setRequesting] = useState(false);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [altFilter, setAltFilter] = useState("all");

  // Search deep-link: SearchView keys lessons by their display label. On the
  // phone the walkthrough lives behind the guide list, so the deep link also
  // opens it.
  useEffect(() => {
    if (focus?.lessonLabel) {
      setLesson(focus.lessonLabel);
      setDetailOpen(true);
    }
  }, [focus, setDetailOpen, setLesson]);

  const lessonRecord = records.find((item) => item.label === lesson) || records[0];
  const [done, setDone] = useDeviceParityState("rights.done", () => lessonRecord.steps.map((_, index) => lessonRecord.completedSteps.includes(index)));
  const [savingProgress, setSavingProgress] = useState({});
  const savingCurrentLesson = savingProgress[lessonRecord.id] ?? 0;
  const progressLessonRef = useRef(lessonRecord.id);
  progressLessonRef.current = lessonRecord.id;
  // A route may first render its last-good snapshot, then receive fresh
  // progress. Compare semantic progress rather than fresh array identities,
  // and defer reconciliation while an optimistic save is still in flight.
  const savedProgress = JSON.stringify(lessonRecord.steps.map((_, index) => lessonRecord.completedSteps.includes(index)));
  useEffect(() => {
    if (!savingCurrentLesson) setDone(JSON.parse(savedProgress));
  }, [lessonRecord.id, savedProgress, savingCurrentLesson, setDone]);

  // The member's own steward request for the OPEN lesson (role-map UB-RGT-03).
  // data.stewardRequests has carried {id, lesson_id, status, created_at} on
  // every member session since the loader shipped — the member's own-row
  // SELECT grant deliberately exposes status — but nothing has ever rendered
  // it, so a member who tapped Request saw one toast and then no trace of it.
  // Newest row for this lesson wins; 'closed' (or nothing) returns the card to
  // the Request button, because a resolved request must never block asking
  // again.
  const openStewardRequest = useMemo(() => {
    const newest = (stewardRequests || [])
      .filter((item) => item && item.lesson_id === lessonRecord.id)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    if (!newest) return null;
    return newest.status === "requested" || newest.status === "acknowledged" ? newest : null;
  }, [stewardRequests, lessonRecord.id]);

  const completed = useMemo(() => done.filter(Boolean).length, [done]);
  const total = done.length;
  const pct = total ? Math.round((completed / total) * 100) : 0;

  const filteredRecords = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return records;
    return records.filter((item) => [item.label, item.title, item.description].some((text) => (text || "").toLowerCase().includes(needle)));
  }, [records, query]);

  // Hero: the first partially-worked lesson wins ("pick up where you left
  // off"); with none in flight, the canonical selected/first guide ("start
  // here"). The open lesson reads live checkbox state, others their saved rows.
  const heroRecord = useMemo(() => {
    const started = records.find((item) => {
      const n = completedCount(item);
      return n > 0 && n < item.steps.length;
    });
    return started || records.find((item) => item.label === rights.selected) || records[0];
  }, [records, rights.selected]);
  const heroDone = heroRecord.id === lessonRecord.id ? completed : completedCount(heroRecord);
  const heroStarted = heroDone > 0 && heroDone < heroRecord.steps.length;

  // The prototype's toast clock (core.js UG.toast): 4.2 s, a .3s fade, gone at 320 ms.
  const { leaving: noticeLeaving } = useToastLifetime({ notice, onExpire: () => setNotice("") });

  async function toggleStep(index) {
    const previous = done[index];
    const next = done.map((value, itemIndex) => (itemIndex === index ? !value : value));
    setDone(next);
    setSavingProgress((counts) => ({ ...counts, [lessonRecord.id]: (counts[lessonRecord.id] ?? 0) + 1 }));
    try {
      await onSaveProgress(lessonRecord.id, next.flatMap((value, itemIndex) => (value ? [itemIndex] : [])));
    } catch {
      if (progressLessonRef.current === lessonRecord.id) {
        setDone((current) => current.map((value, itemIndex) => (itemIndex === index ? previous : value)));
      }
      // Say so: a checkbox that silently springs back reads as a misclick.
      setNotice(t("rights.saveFailed"));
    } finally {
      setSavingProgress((counts) => ({ ...counts, [lessonRecord.id]: (counts[lessonRecord.id] ?? 1) - 1 }));
    }
  }

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(lessonRecord.script);
      setNotice(t("learn.scriptCopied"));
    } catch {
      setNotice(t("learn.scriptCopyManual"));
    }
  }

  function openLesson(label) {
    setLesson(label);
    setDetailOpen(true);
  }

  const searchField = (extraClass) => (
    <label className={`learn-search${extraClass ? ` ${extraClass}` : ""}`}>
      <span aria-hidden="true"><Search size={17} /></span>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("learn.searchPlaceholder")} aria-label={t("learn.searchLabel")} />
    </label>
  );

  const progressBar = (
    <div className="learn-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed} aria-label={t("learn.progressLabel", { lesson: lessonRecord.label })}>
      <span className="learn-track__fill" style={{ width: `${pct}%` }} key={lessonRecord.id} />
    </div>
  );

  const stepsList = (
    <div className="learn-steps">
      {lessonRecord.steps.map((step, index) => (
        <button type="button" className={`learn-step${done[index] ? " learn-step--done" : ""}`} aria-pressed={done[index]} onClick={() => toggleStep(index)} key={`${lessonRecord.id}-${index}`}>
          <span className="learn-step__dot" aria-hidden="true">{done[index] ? "✓" : ""}</span>
          <span className="learn-step__label">{step}</span>
        </button>
      ))}
    </div>
  );

  const sayCard = (
    <section className="learn-say">
      <div className="learn-say__kicker">{t("learn.sayThis")}</div>
      <p className="learn-say__script">“{lessonRecord.script}”</p>
      <button type="button" className="learn-say__copy" onClick={copyScript}>{t("learn.copyScript")}</button>
    </section>
  );

  // #9595: with no steward named for this reader (stewardPresence), the card
  // does not promise a ping nobody would receive or offer a request nobody
  // could read; it gives the fallback and who can name a steward.
  const noSteward = noStewardNamed(stewardPresence);
  const noChapter = stewardPresence === STEWARD_PRESENCE.noChapter;
  const onlySelf = stewardPresence === STEWARD_PRESENCE.onlySelf;
  const noStewardTitle = t(noChapter ? "learn.noStewardNoChapter" : onlySelf ? "learn.noOtherSteward" : "learn.noSteward");
  const noStewardFallback = t(noChapter ? "learn.noStewardFallbackNoChapter" : onlySelf ? "learn.noOtherStewardFallback" : "learn.noStewardFallback");
  const requestedAt = Date.parse(openStewardRequest?.created_at);
  const requestInstant = Number.isFinite(requestedAt) ? new Date(requestedAt).toISOString() : null;
  const sentAt = formatGroupMoment(requestInstant, lang);
  const waitingForSteward = openStewardRequest?.status === "requested"
    && Date.now() - requestedAt >= STEWARD_FOLLOW_UP_MS;
  const requestStatus = openStewardRequest && (
    <div role="status">
      <strong>{t(openStewardRequest.status === "acknowledged" ? "learn.stewardOnIt" : "learn.stewardRequested")}</strong>
      {sentAt && <div><time dateTime={requestInstant}>{t("learn.stewardSentAt", { when: sentAt })}</time></div>}
      {waitingForSteward && <div>{t("learn.stewardWaiting")}</div>}
    </div>
  );
  const followUp = waitingForSteward && onMessageSteward && (
    <button type="button" className={alt ? "ug-btn ug-btn-soft ug-btn-sm" : "learn-request-btn"} onClick={onMessageSteward}>{t("learn.stewardOpenMessages")}</button>
  );
  const stewardCard = (cardClass) => noSteward ? (
    <section className={cardClass}>
      <span className="learn-steward__icon" aria-hidden="true"><Megaphone size={18} /></span>
      <span className="learn-steward__body">{t("learn.stewardLead")} <strong>{noStewardTitle}</strong> {noStewardFallback}</span>
    </section>
  ) : (
    <section className={cardClass}>
      <span className="learn-steward__icon" aria-hidden="true"><Megaphone size={18} /></span>
      {openStewardRequest ? (
        <div className="learn-steward__body learn-steward__status">
          {requestStatus}
          {followUp}
        </div>
      ) : (
        <>
          <span className="learn-steward__body">{t("learn.stewardLead")} <strong>{t("learn.stewardStrong")}</strong> {t("learn.stewardTail")}</span>
          <BusyButton type="button" className="learn-request-btn" pending={requesting} onClick={() => runBusyWrite(busyWriteRef, "steward-request", async () => {
            setRequesting(true);
            await onRequestSteward(lessonRecord.id).catch(() => {}).finally(() => setRequesting(false));
          })}>{t("learn.request")}</BusyButton>
        </>
      )}
    </section>
  );

  const contractCard = onAssistant && (
    <button type="button" className="learn-row learn-contract-card" onClick={onAssistant}>
      <span className="learn-row__icon" aria-hidden="true"><BookOpen size={18} /></span>
      <span className="learn-row__copy">
        <span className="learn-row__label">{t("learn.contractTitle")}</span>
        <span className="learn-row__sub">{t("learn.contractSub")}</span>
      </span>
      <span className="learn-row__chev" aria-hidden="true">›</span>
    </button>
  );

  const miniLessons = learningContent
    ? <LearningLearnArea {...learningContent} section={null} onSection={onLearningSection} />
    : null;

  // Plain answers on cards, part-timers and visa questions
  // (REQ-UG-RIGHTS-CONTRACT-AND-LIBRARY-CONTENT-20261030). Its
  // referral line stands alone here: the page already offers one "Talk to
  // your steward" button, and a second with the same name would be noise.
  const commonQuestions = <RightsCommonQuestions />;

  const lawLibrary = rightsLibraryEnabled(data.organizationConfiguration)
    ? <RightsLawLibrary onAskSteward={onMessageSteward} />
    : null;

  // No sourced glossary: its content (union terms such as grievance steps
  // and dues) is not part of Union Ground.
  const glossary = null;

  const learningPaysCard = (
    <section className="learn-pays">
      <span className="learn-pays__title">{t("learn.paysTitle")}</span>
      <p className="learn-pays__body">{t("learn.paysBody")}</p>
    </section>
  );

  const phone = detailOpen ? (
    <div className="learn-stack">
      <button type="button" className="learn-back" onClick={() => setDetailOpen(false)}><span aria-hidden="true">‹</span>{t("learn.back")}</button>
      <section className="learn-card learn-walk">
        <div className="learn-walk__head">
          <span className="learn-chip learn-chip--terra">{t("learn.walkChip")}</span>
          <span className="learn-walk__count">{t("learn.stepsDone", { completed, total })}</span>
        </div>
        <h2 className="learn-walk__title">{lessonRecord.title}</h2>
        <p className="learn-walk__desc">{lessonRecord.description}</p>
        {progressBar}
        {stepsList}
        <p className="learn-walk__note">{t("learn.progressNote")}</p>
      </section>
      {sayCard}
      {stewardCard("learn-card learn-steward")}
    </div>
  ) : (
    <div className="learn-stack">
      <h1 className="learn-title">{t("learn.title")}</h1>
      {searchField("")}
      <section className="learn-hero">
        <span className="learn-chip learn-chip--gold">{heroStarted ? t("learn.resumeChip") : t("learn.startChip")}</span>
        <h2 className="learn-hero__title">{heroRecord.title}</h2>
        <p className="learn-hero__meta">{t("learn.heroMeta", { completed: heroDone, total: heroRecord.steps.length })} · {heroRecord.description}</p>
        <button type="button" className="learn-hero__cta" onClick={() => openLesson(heroRecord.label)}>{heroStarted ? t("learn.continue") : t("learn.startGuide")}</button>
      </section>
      <div className="learn-kicker">{t("learn.guidesKicker")}</div>
      <div className="learn-rows">
        {filteredRecords.map((item) => {
          const LessonIcon = LESSON_ICONS[item.id] || FALLBACK_ICON;
          return (
          <button type="button" className="learn-row" onClick={() => openLesson(item.label)} key={item.id}>
            <span className="learn-row__icon" aria-hidden="true"><LessonIcon size={18} /></span>
            <span className="learn-row__copy">
              <span className="learn-row__label">{item.title}</span>
              <span className="learn-row__sub">{item.description}</span>
            </span>
            <span className="learn-row__chev" aria-hidden="true">›</span>
          </button>
          );
        })}
        {contractCard}
        {!filteredRecords.length && <p className="learn-empty">{t("learn.noMatches")}</p>}
      </div>
      {miniLessons}
      {commonQuestions}
      {lawLibrary}
      {glossary}
      {learningPaysCard}
    </div>
  );

  const desktopBody = (
    <div className="learn-desktop">
      <header className="learn-ph">
        <div className="learn-ph__copy">
          <h1 className="learn-ph__title">{t("nav.knowRights")}</h1>
          <p className="learn-ph__sub">{t("learn.desktopSub")}</p>
        </div>
        {searchField("learn-search--desktop")}
      </header>
      <div className="learn-pbody">
        <section className="learn-dhero">
          <span className="learn-dhero__mark" aria-hidden="true"><Scale size={104} /></span>
          <span className="learn-chip learn-chip--gold">{heroStarted ? t("learn.resumeChip") : t("learn.startChip")}</span>
          <h2 className="learn-dhero__title">{heroRecord.title}</h2>
          <p className="learn-dhero__sub">{heroRecord.description}</p>
          <button type="button" className="learn-hero__cta learn-hero__cta--inline" onClick={() => setLesson(heroRecord.label)}>{t("learn.readGuide")}</button>
        </section>
        <div className="learn-grid">
          <section className="learn-stat learn-walkstat">
            <div className="learn-walk__head">
              <span className="learn-chip learn-chip--terra">{t("learn.walkChip")}</span>
              <span className="learn-walkstat__title">{lessonRecord.title}</span>
              <span className="learn-walk__count">{t("learn.stepsDone", { completed, total })}</span>
            </div>
            {progressBar}
            {stepsList}
            <p className="learn-walk__note">{t("learn.progressNote")}</p>
          </section>
          <div className="learn-rail">
            {sayCard}
            {stewardCard("learn-stat learn-steward")}
          </div>
        </div>
        <div className="learn-articles">
          {filteredRecords.map((item) => (
            <button type="button" className="learn-stat learn-article" aria-pressed={lesson === item.label} onClick={() => setLesson(item.label)} key={item.id}>
              <span className="learn-chip learn-chip--lesson">{item.label}</span>
              <span className="learn-article__title">{item.title}</span>
              <span className="learn-article__blurb">{item.description}</span>
              <span className="learn-article__read">{t("learn.read")} ›</span>
            </button>
          ))}
          {!filteredRecords.length && <p className="learn-empty">{t("learn.noMatches")}</p>}
        </div>
        {miniLessons}
        {commonQuestions}
        {lawLibrary}
        {glossary}
        <div className="learn-support">
          {contractCard}
          {learningPaysCard}
        </div>
      </div>
    </div>
  );

  // The manage section is its own focused page; only it mounts.
  const managing = learningSection === "manage" && learningContent;

  // REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the alternate shell's Know
  // your rights (prototype pages/help.js /rights and /rights/:id) on the same
  // lessons, progress, script, steward requests and learning extras as the
  // classic page above. The index is the hero, the open lesson's checklist
  // beside the "Say this" card and the steward note, then every guide; a
  // guide opens as the prototype's guide page.
  if (alt) {
    const crumbsHome = { label: t("altHelpPages.helpRights"), href: "/m/rights", onOpen: () => setDetailOpen(false) };
    const progressFill = (
      <div className="ug-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed} aria-label={t("learn.progressLabel", { lesson: lessonRecord.label })}>
        <i style={{ width: `${pct}%` }} />
      </div>
    );
    const altSteps = (
      <div className="ug-alt-help-opts">
        {lessonRecord.steps.map((step, index) => (
          <button type="button" className={`ug-opt${done[index] ? " ug-done" : ""}`} role="checkbox" aria-checked={Boolean(done[index])} onClick={() => toggleStep(index)} key={`${lessonRecord.id}-${index}`}>
            <span className="ug-box"><Icon name="check" /></span>
            <span className="ug-alt-help-grow"><b>{step}</b></span>
          </button>
        ))}
      </div>
    );
    const walkPanel = (heading) => (
      <div className="ug-panel ug-alt-help-walk">
        <div className="ug-alt-help-head"><h2>{heading}</h2><span>{t("altHelpPages.rightsStepsDone", { completed, total })}</span></div>
        <p className="ug-alt-help-sub">{lessonRecord.description}</p>
        {progressFill}
        {altSteps}
        <p className="ug-alt-help-sub">{t("learn.progressNote")}</p>
      </div>
    );
    const altScript = (withOpen) => (
      <div className="ug-script">
        <small>{t("learn.sayThis")}</small>
        <q>{lessonRecord.script}</q>
        <div className="ug-btn-row ug-alt-help-row">
          <button className="ug-btn ug-btn-gold ug-btn-sm" type="button" onClick={copyScript}><Icon name="file" />{t("learn.copyScript")}</button>
          {withOpen ? <button className="ug-btn ug-btn-ghost ug-btn-sm" type="button" onClick={() => openLesson(lessonRecord.label)}>{t("altHelpPages.rightsOpenGuide")}</button> : null}
        </div>
      </div>
    );
    const altRequest = noSteward ? null : openStewardRequest ? (
      <div className="ug-alt-help-status">{requestStatus}</div>
    ) : (
      <BusyButton type="button" className="ug-btn ug-btn-dark ug-btn-sm" pending={requesting} onClick={() => runBusyWrite(busyWriteRef, "steward-request", async () => {
        setRequesting(true);
        await onRequestSteward(lessonRecord.id).catch(() => {}).finally(() => setRequesting(false));
      })}><Icon name="megaphone" />{t("learn.request")}</BusyButton>
    );
    const messageSteward = onMessageSteward && !noSteward && (followUp ||
      <button className="ug-btn ug-btn-soft ug-btn-sm" type="button" onClick={onMessageSteward}><Icon name="msg" />{t("altHelpPages.messageSteward")}</button>);
    const extras = (
      <div className="ug-legacy ug-alt-help-extras">
        {miniLessons}
        {commonQuestions}
        {lawLibrary}
        {glossary}
        <div className="learn-support">
          {contractCard}
          {learningPaysCard}
        </div>
      </div>
    );
    const toast = notice ? <div className="ug-legacy"><div className="toast" role="status" data-leaving={noticeLeaving || undefined}>{notice}</div></div> : null;
    const signals = (
      <div className="ug-wrap ug-legacy ug-alt-help-signals">
        <ContextualPulseSlot pulse={pulse} contextKey="rights.page" active={!managing} className="eng-pulse-slot--inset" />
        {!managing && issueSignals && <IssueSignalBanner issueSignals={issueSignals} surface="rights" variant="boost" />}
      </div>
    );

    if (managing) {
      return (
        <div className="ug-alt-help">
          {cited}
          <section className="ug-page-hero ug-alt-help-hero"><div className="ug-wrap"><HelpCrumbs onOpenHome={onOpenHome} trail={[{ ...crumbsHome, onOpen: () => onLearningSection?.("library") }, { label: t("learningContent.library.manage") }]} /></div></section>
          {signals}
          <div className="ug-wrap ug-legacy"><LearningLearnArea {...learningContent} section="manage" onSection={onLearningSection} /></div>
        </div>
      );
    }

    if (detailOpen) {
      const others = records.filter((item) => item.id !== lessonRecord.id);
      return (
        <div className="ug-alt-help">
          {cited}
          <section className="ug-page-hero ug-alt-help-hero">
            <div className="ug-wrap">
              <HelpCrumbs onOpenHome={onOpenHome} trail={[crumbsHome, { label: lessonRecord.label }]} />
              <span className="ug-tag ug-t-rights">{lessonRecord.label} · {t("altHelpPages.rightsStepCount", { count: lessonRecord.steps.length })}</span>
              <h1 className="ug-alt-help-guide-h1">{lessonRecord.title}</h1>
              <p className="ug-lede">{lessonRecord.description}</p>
            </div>
          </section>
          {signals}
          <section className="ug-wrap ug-split ug-alt-help-split">
            <article className="ug-alt-help-stack">
              {walkPanel(t("altHelpPages.rightsSteps"))}
              {altScript(false)}
              <div className="ug-panel ug-alt-help-feedback"><b>{t("altHelpPages.rightsUseful")}</b><p>{t("altHelpPages.rightsUsefulBody")}</p></div>
            </article>
            <aside className="ug-alt-help-stack">
              <div className="ug-panel-w">
                <h3>{t("altHelpPages.rightsNeedSteward")}</h3>
                <p className="ug-alt-help-sub">{noSteward ? `${noStewardTitle} ${noStewardFallback}` : t("altHelpPages.rightsNeedStewardBody")}</p>
                <div className="ug-btn-row ug-alt-help-row">{altRequest}{messageSteward}</div>
              </div>
              <div className="ug-panel">
                <h3>{t("altHelpPages.rightsMoreGuides")}</h3>
                {others.length ? (
                  <ul className="ug-list">
                    {others.map((item) => (
                      <li key={item.id}><button type="button" className="ug-li ug-alt-help-li" onClick={() => openLesson(item.label)}><span><b>{item.title}</b><span>{item.label} · {t("altHelpPages.rightsStepCount", { count: item.steps.length })}</span></span></button></li>
                    ))}
                  </ul>
                ) : <p className="ug-alt-help-sub">{t("altHelpPages.rightsNoOthers")}</p>}
              </div>
            </aside>
          </section>
          {toast}
        </div>
      );
    }

    const doneOf = (item) => (item.id === lessonRecord.id ? completed : completedCount(item));
    const filterCounts = Object.fromEntries(ALT_GUIDE_FILTERS.map((key) => [
      key, filteredRecords.filter((item) => guideInFilter(key, doneOf(item), item.steps.length)).length,
    ]));
    const guides = filteredRecords.filter((item) => guideInFilter(altFilter, doneOf(item), item.steps.length));
    return (
      <div className="ug-alt-help">
        {cited}
        <section className="ug-page-hero ug-alt-help-hero">
          <div className="ug-wrap">
            <HelpCrumbs onOpenHome={onOpenHome} trail={[{ label: t("altHelpPages.helpRights") }]} />
            <h1>{t("altHelpPages.rightsH1Lead")}<span className="ug-accent">{t("altHelpPages.rightsH1Accent")}</span></h1>
            <p className="ug-lede">{t("altHelpPages.rightsLede")}</p>
            <div className="ug-btn-row ug-alt-help-cta">
              <button className="ug-btn ug-btn-dark" type="button" onClick={() => openLesson(heroRecord.label)}>{heroStarted ? t("learn.continue") : t("learn.startGuide")}<span className="ug-sr">{": "}{heroRecord.title}</span></button>
              {onAssistant ? <button className="ug-btn ug-btn-soft" type="button" onClick={onAssistant}>{t("learn.contractTitle")}</button> : null}
            </div>
          </div>
        </section>
        {signals}
        <section className="ug-wrap ug-split ug-alt-help-split">
          {walkPanel(lessonRecord.title)}
          <aside className="ug-alt-help-stack">
            {altScript(true)}
            <div className="ug-note ug-warn">
              <Icon name="megaphone" />
              <div><b>{t("altHelpPages.rightsMeetingNow")}</b> {noSteward ? `${noStewardTitle} ${noStewardFallback}` : !openStewardRequest && t("altHelpPages.rightsMeetingNowBody")}
                <div className="ug-btn-row ug-alt-help-row">{altRequest}{messageSteward}</div>
              </div>
            </div>
          </aside>
        </section>
        <section className="ug-wrap ug-section ug-alt-help-guides">
          <div className="ug-section-head"><h2>{t("altHelpPages.rightsAllLead")}<span className="ug-accent">{t("altHelpPages.rightsAllAccent")}</span></h2></div>
          <div className="ug-toolbar">
            <label className="ug-search-in"><span className="ug-sr">{t("learn.searchLabel")}</span><Icon name="search" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("learn.searchPlaceholder")} /></label>
            <div className="ug-chips" role="group" aria-label={t("altHelpPages.rightsProgress")}>
              {ALT_GUIDE_FILTERS.map((key) => <button className="ug-chip" type="button" aria-pressed={altFilter === key} key={key} onClick={() => setAltFilter(key)}>{t(`altHelpPages.rightsFilter_${key}`)} <span className="ug-n">{filterCounts[key]}</span></button>)}
            </div>
          </div>
          <div className="ug-grid-3 ug-alt-help-grid">
            {guides.length ? guides.map((item) => (
              <article className="ug-pg ug-alt-help-guide" aria-labelledby={`ug-guide-${item.id}`} key={item.id}>
                <div className="ug-alt-help-head"><span className="ug-tag ug-t-rights">{item.label}</span><span>{t("altHelpPages.rightsStepCount", { count: item.steps.length })}</span></div>
                <h3 id={`ug-guide-${item.id}`}>{item.title}</h3>
                <p className="ug-alt-help-sub">{item.description}</p>
                <button type="button" className="ug-link ug-alt-help-read" onClick={() => openLesson(item.label)}>{t("learn.read")}{" "}<span className="ug-sr">{item.title}</span></button>
              </article>
            )) : <div className="ug-empty ug-alt-help-empty"><b>{t("altHelpPages.rightsNone")}</b>{t("altHelpPages.rightsNoneBody")}</div>}
          </div>
        </section>
        <section className="ug-wrap ug-alt-help-more" aria-label={t("altHelpPages.rightsMore")}>{extras}</section>
        {toast}
      </div>
    );
  }

  return (
    <div className={`screen learn-screen${desktop ? " learn-screen--desktop" : ""}`}>
      {cited}
      <ContextualPulseSlot pulse={pulse} contextKey="rights.page" active={!managing} className="eng-pulse-slot--inset" />
      {!managing && issueSignals && <IssueSignalBanner issueSignals={issueSignals} surface="rights" variant="boost" />}
      {managing
        ? <LearningLearnArea {...learningContent} section="manage" onSection={onLearningSection} />
        : desktop ? desktopBody : phone}
      {notice && <div className="toast" role="status" data-leaving={noticeLeaving || undefined}>{notice}</div>}
    </div>
  );
}
