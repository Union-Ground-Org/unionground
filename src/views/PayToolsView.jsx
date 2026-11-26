import { useRoutedTab, RoutedTabLink } from "../components/WorkspacePages.jsx";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  authorizePay,
  createMemoryPayCatalog,
  createPayRpcAdapter,
  createPayTools,
  presentLoading,
  presentRetry,
} from "../features/pay/index.js";
import { withPayInputFeedback } from "../features/pay/webInputFeedback.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { usePayScopedActor } from "../lib/mi1PayWiring.js";
import { canLead } from "../lib/payLeaders.js";
import AltBargainingPage from "../alt/record/AltBargainingPage.jsx";
import { loadCaseworkBargainingTable } from "../lib/caseworkApi.js";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite, useBusyScope } from "../lib/busyWrite.js";

const TABS = [
  { id: "calculator", label: "pay.calculatorTab" },
  { id: "tables", label: "pay.tablesTab" },
  { id: "compare", label: "pay.compareTab" },
  // No Contract or Bargaining tab: published contract pay content needs a
  // contract, which a campaign still forming a union does not have.
];

function numberOrZero(value) {
  return value.trim() === "" ? 0 : Number(value);
}

function PayInput({ label, feedback, ...inputProps }) {
  const { t, lang } = useLang();
  const id = useId();
  const [reason, max] = feedback || [];
  const message = reason && t(reason, max == null ? undefined : { max: new Intl.NumberFormat(lang).format(max) });
  return (
    <div className="xus-field">
      <label htmlFor={id}>{label}</label>
      <input {...inputProps} id={id} className="xus-input" aria-invalid={feedback ? true : undefined} aria-describedby={feedback ? `${id}-error` : undefined} />
      {feedback && <small className="xus-note xus-note--error" id={`${id}-error`} role="alert">{message}</small>}
    </div>
  );
}

// `alt` (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030): under the alternate
// shell the same tabs and tools sit in the prototype's Bargaining page
// (src/alt/record/AltBargainingPage.jsx); the classic page is unchanged.
export function PayToolsView({ alt = false, onOpenHome = null, lang = "en", actor, client = null, api = null }) {
  void lang;
  const { t } = useLang();
  const { actor: scopedActor, retry: retrySessionScope } = usePayScopedActor(client, actor);
  const catalogApi = useMemo(() => api || (client ? createPayRpcAdapter(client) : null), [api, client]);
  const [catalog, setCatalog] = useState(() => createMemoryPayCatalog());
  const [catalogState, setCatalogState] = useState("ready");
  const catalogRequest = useRef(0);
  // Writes are bound to the organization this page rendered.
  const leader = canLead(scopedActor);
  // The alternate shell's live table: the chapter's bargaining sessions and
  // proposals. RLS alone decides who reads them (stewards, coordinators,
  // advisors, admins and VPs, at chapter or organization scope); anyone else
  // gets no sessions and keeps the page's "nothing posted" state.
  const tableChapterId = alt && client ? scopedActor.chapterId || null : null;
  const [bargainingTable, setBargainingTable] = useState(null);
  useEffect(() => {
    if (!tableChapterId) {
      setBargainingTable(null);
      return undefined;
    }
    let active = true;
    setBargainingTable({ state: "loading", sessions: [] });
    loadCaseworkBargainingTable(client, tableChapterId).then(
      (sessions) => { if (active) setBargainingTable({ state: "success", sessions }); },
      () => { if (active) setBargainingTable({ state: "error", sessions: [] }); },
    );
    return () => { active = false; };
  }, [client, tableChapterId]);
  const tools = useMemo(
    () => createPayTools({ actor: scopedActor, catalog }),
    [catalog, scopedActor],
  );
  const [tab, setTab] = useRoutedTab("pay", "calculator");
  const [regularHours, setRegularHours] = useState("40");
  const [overtimeHours, setOvertimeHours] = useState("0");
  const [overtimeMultiplier, setOvertimeMultiplier] = useState("");
  const [nightHours, setNightHours] = useState("0");
  const [nightMultiplier, setNightMultiplier] = useState("");
  const [weekendHours, setWeekendHours] = useState("0");
  const [weekendMultiplier, setWeekendMultiplier] = useState("");
  const [standbyHours, setStandbyHours] = useState("0");
  const [standbyHourlyRate, setStandbyHourlyRate] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [amountPaid, setAmountPaid] = useState("");
  const [raisePercent, setRaisePercent] = useState("");
  const [unpaidPeriods, setUnpaidPeriods] = useState("");
  const [grade, setGrade] = useState("");
  const [stepNumber, setStepNumber] = useState("");
  const [effectiveOn, setEffectiveOn] = useState("");
  const [hoursPerYear, setHoursPerYear] = useState("");
  const [checksPerYear, setChecksPerYear] = useState("");
  const [result, setResult] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [leftGrade, setLeftGrade] = useState("");
  const [leftStep, setLeftStep] = useState("");
  const [leftDate, setLeftDate] = useState("");
  const [rightGrade, setRightGrade] = useState("");
  const [rightStep, setRightStep] = useState("");
  const [rightDate, setRightDate] = useState("");
  const [comparisonHoursPerYear, setComparisonHoursPerYear] = useState("");
  const [comparisonChecksPerYear, setComparisonChecksPerYear] = useState("");
  const rejectedForm = useRef(null);

  // A submit can produce the same feedback again. Use the submitted form
  // once its latest invalid markers have been committed, in document order.
  useLayoutEffect(() => {
    const form = rejectedForm.current;
    rejectedForm.current = null;
    form?.querySelector('input[aria-invalid="true"]')?.focus();
  }, [result, comparison]);

  const reloadCatalog = useCallback(async () => {
    const request = ++catalogRequest.current;
    setComparison(null);
    if (scopedActor.organizationScopeState !== "ready") {
      setCatalog(createMemoryPayCatalog());
      setCatalogState(scopedActor.organizationScopeState);
      setResult((current) => {
        if (scopedActor.organizationScopeState === "loading") {
          return current?.state === "loading" ? current : null;
        }
        if (current?.state === "loading") return presentRetry(current.title);
        return current?.state === "retry" ? current : null;
      });
      return;
    }
    setResult(null);
    if (!catalogApi || !scopedActor.selectedOrganizationId) {
      setCatalog(createMemoryPayCatalog());
      setCatalogState("ready");
      return;
    }
    setCatalogState("loading");
    const loaded = await catalogApi.loadCatalog();
    if (request !== catalogRequest.current) return;
    if (!loaded.ok) {
      setCatalog(createMemoryPayCatalog());
      setCatalogState("retry");
      setResult((current) => current?.state === "loading"
        ? presentRetry(current.title)
        : current);
      return;
    }
    setCatalog(loaded.catalog);
    setCatalogState("ready");
    setResult((current) => current?.state === "loading" ? null : current);
  }, [catalogApi, scopedActor.organizationScopeState, scopedActor.selectedOrganizationId]);

  const retryPayData = useCallback(() => {
    if (scopedActor.organizationScopeState === "retry") {
      setCatalogState("loading");
      setResult((current) => current?.state === "retry"
        ? presentLoading(current.title)
        : current);
      retrySessionScope();
      return;
    }
    void reloadCatalog();
  }, [reloadCatalog, retrySessionScope, scopedActor.organizationScopeState]);

  useEffect(() => {
    void reloadCatalog();
    return () => {
      catalogRequest.current += 1;
    };
  }, [reloadCatalog]);

  function calculate(event) {
    event.preventDefault();
    const hourly = hourlyRate.trim() === "" ? undefined : Number(hourlyRate);
    const usesCatalogRate = hourlyRate.trim() === ""
      && (grade.trim() !== "" || stepNumber.trim() !== "");
    if (scopedActor.organizationScopeState !== "ready") {
      setResult(scopedActor.organizationScopeState === "loading"
        ? presentLoading(t("pay.calculatorTitle"))
        : presentRetry(t("pay.calculatorTitle")));
      return;
    }
    if (usesCatalogRate && catalogState !== "ready") {
      setResult(catalogState === "loading"
        ? presentLoading(t("pay.calculatorTitle"))
        : presentRetry(t("pay.calculatorTitle")));
      return;
    }
    const rules = {};
    if (overtimeMultiplier.trim() !== "") rules.overtimeMultiplier = Number(overtimeMultiplier);
    if (nightMultiplier.trim() !== "") rules.nightMultiplier = Number(nightMultiplier);
    if (weekendMultiplier.trim() !== "") rules.weekendMultiplier = Number(weekendMultiplier);
    if (standbyHourlyRate.trim() !== "") {
      rules.standbyHourlyCents = Math.round(Number(standbyHourlyRate) * 100);
    }
    if (hoursPerYear.trim() !== "") rules.hoursPerYear = Number(hoursPerYear);
    if (checksPerYear.trim() !== "") rules.checksPerYear = Number(checksPerYear);
    const input = {
      hours: {
        regular: numberOrZero(regularHours),
        overtime: numberOrZero(overtimeHours),
        night: numberOrZero(nightHours),
        weekend: numberOrZero(weekendHours),
        standby: numberOrZero(standbyHours),
      },
      hourlyRate: hourlyRate.trim() === "" ? undefined : hourly,
      amountPaid: amountPaid.trim() === "" ? undefined : Number(amountPaid),
      raisePercent: raisePercent.trim() === "" ? undefined : Number(raisePercent),
      unpaidPayPeriods: unpaidPeriods.trim() === "" ? 0 : Number(unpaidPeriods),
      grade: grade.trim() || undefined,
      stepNumber: stepNumber.trim() === "" ? undefined : Number(stepNumber),
      effectiveOn: effectiveOn || undefined,
    };
    const presentation = withPayInputFeedback(tools.presentCalculator(input, rules), rules, input);
    if (presentation.fieldFeedback) rejectedForm.current = event.currentTarget;
    setResult(presentation);
  }

  function compare(event) {
    event.preventDefault();
    if (catalogState !== "ready") {
      setComparison(catalogState === "loading"
        ? presentLoading(t("pay.comparisonTitle"))
        : presentRetry(t("pay.comparisonTitle")));
      return;
    }
    const rules = {
      hoursPerYear: comparisonHoursPerYear.trim() === "" ? undefined : Number(comparisonHoursPerYear),
      checksPerYear: comparisonChecksPerYear.trim() === "" ? undefined : Number(comparisonChecksPerYear),
    };
    const presentation = tools.presentCompare(
      {
        grade: leftGrade.trim() || undefined,
        stepNumber: leftStep.trim() === "" ? undefined : Number(leftStep),
        effectiveOn: leftDate || undefined,
      },
      {
        grade: rightGrade.trim() || undefined,
        stepNumber: rightStep.trim() === "" ? undefined : Number(rightStep),
        effectiveOn: rightDate || undefined,
      },
      rules,
    );
    const next = withPayInputFeedback(presentation, rules);
    if (next.fieldFeedback) rejectedForm.current = event.currentTarget;
    setComparison(next);
  }

  const tables = catalogState === "loading"
    ? presentLoading(t("pay.tablesTab"))
    : catalogState === "retry"
      ? presentRetry(t("pay.tablesTab"))
      : tools.presentTables({});

  const tabBar = (
    <div className={alt ? "ug-seg ug-rec-seg" : "mwl-tabs"} role="group" aria-label={t("pay.title")}>
      {TABS.filter((entry) => !entry.leaders || leader).map(({ id, label }) => (
        <RoutedTabLink group="pay" value={id}
          key={id}
          type="button"
          className={alt ? "ug-rec-seg-tab" : "mwl-tab"}
          aria-pressed={tab === id}
          onClick={() => setTab(id)}
        >
          {t(label)}
        </RoutedTabLink>
      ))}
    </div>
  );
  const tabPanels = (
    <>
      {tab === "calculator" && (
        <section className="plane-card xus-card">
          <form className="xus-formgrid xus-cardbody mi1-pay__calculator" onSubmit={calculate} onChange={() => { if (result?.fieldFeedback) setResult(null); }}>
            <PayInput label={t("pay.regularHours")} feedback={result?.fieldFeedback?.regular}
              inputMode="decimal" value={regularHours} onChange={(event) => setRegularHours(event.target.value)} />
            <PayInput label={t("pay.overtimeHours")} feedback={result?.fieldFeedback?.overtime}
              inputMode="decimal" value={overtimeHours} onChange={(event) => setOvertimeHours(event.target.value)} />
            {numberOrZero(overtimeHours) > 0 || overtimeMultiplier.trim() !== "" ? (
              <PayInput label={t("pay.overtimeMultiplier")} feedback={result?.fieldFeedback?.overtimeMultiplier}
                inputMode="decimal" value={overtimeMultiplier} onChange={(event) => setOvertimeMultiplier(event.target.value)} placeholder={t("pay.ruleUnsetHint")} />
            ) : null}
            <PayInput label={t("pay.nightHours")} feedback={result?.fieldFeedback?.night}
              inputMode="decimal" value={nightHours} onChange={(event) => setNightHours(event.target.value)} />
            {numberOrZero(nightHours) > 0 || nightMultiplier.trim() !== "" ? (
              <PayInput label={t("pay.nightMultiplier")} feedback={result?.fieldFeedback?.nightMultiplier}
                inputMode="decimal" value={nightMultiplier} onChange={(event) => setNightMultiplier(event.target.value)} placeholder={t("pay.ruleUnsetHint")} />
            ) : null}
            <PayInput label={t("pay.weekendHours")} feedback={result?.fieldFeedback?.weekend}
              inputMode="decimal" value={weekendHours} onChange={(event) => setWeekendHours(event.target.value)} />
            {numberOrZero(weekendHours) > 0 || weekendMultiplier.trim() !== "" ? (
              <PayInput label={t("pay.weekendMultiplier")} feedback={result?.fieldFeedback?.weekendMultiplier}
                inputMode="decimal" value={weekendMultiplier} onChange={(event) => setWeekendMultiplier(event.target.value)} placeholder={t("pay.ruleUnsetHint")} />
            ) : null}
            <PayInput label={t("pay.standbyHours")} feedback={result?.fieldFeedback?.standby}
              inputMode="decimal" value={standbyHours} onChange={(event) => setStandbyHours(event.target.value)} />
            {numberOrZero(standbyHours) > 0 || standbyHourlyRate.trim() !== "" ? (
              <PayInput label={t("pay.standbyHourlyRate")} feedback={result?.fieldFeedback?.standbyHourlyCents}
                inputMode="decimal" value={standbyHourlyRate} onChange={(event) => setStandbyHourlyRate(event.target.value)} placeholder={t("pay.ruleUnsetHint")} />
            ) : null}
            <PayInput label={t("pay.hourlyRate")} feedback={result?.fieldFeedback?.hourlyRate}
              inputMode="decimal" value={hourlyRate} onChange={(event) => setHourlyRate(event.target.value)} placeholder={t("pay.hourlyRateHint")} />
            <PayInput label={t("pay.grade")} feedback={result?.fieldFeedback?.grade}
              value={grade} onChange={(event) => setGrade(event.target.value)} />
            <PayInput label={t("pay.step")} feedback={result?.fieldFeedback?.stepNumber}
              inputMode="numeric" value={stepNumber} onChange={(event) => setStepNumber(event.target.value)} />
            {hourlyRate.trim() === "" && (grade.trim() !== "" || stepNumber.trim() !== "") ? (
              <PayInput label={t("pay.calculationDate")} feedback={result?.fieldFeedback?.effectiveOn}
                type="date" value={effectiveOn} onChange={(event) => setEffectiveOn(event.target.value)} />
            ) : null}
            <PayInput label={t("pay.amountPaid")} feedback={result?.fieldFeedback?.amountPaid}
              inputMode="decimal" value={amountPaid} onChange={(event) => setAmountPaid(event.target.value)} />
            <PayInput label={t("pay.raisePercent")} feedback={result?.fieldFeedback?.raisePercent}
              inputMode="decimal" value={raisePercent} onChange={(event) => setRaisePercent(event.target.value)} />
            <PayInput label={t("pay.unpaidPeriods")} feedback={result?.fieldFeedback?.unpaidPayPeriods}
              inputMode="numeric" value={unpaidPeriods} onChange={(event) => setUnpaidPeriods(event.target.value)} />
            {(raisePercent.trim() !== "" || hoursPerYear.trim() !== "" || checksPerYear.trim() !== "") ? (
              <>
                <PayInput label={t("pay.hoursPerYear")} feedback={result?.fieldFeedback?.hoursPerYear}
                  inputMode="numeric" value={hoursPerYear} onChange={(event) => setHoursPerYear(event.target.value)} placeholder={t("pay.ruleUnsetHint")} />
                <PayInput label={t("pay.checksPerYear")} feedback={result?.fieldFeedback?.checksPerYear}
                  inputMode="numeric" value={checksPerYear} onChange={(event) => setChecksPerYear(event.target.value)} placeholder={t("pay.ruleUnsetHint")} />
              </>
            ) : null}
            <button type="submit" className="xus-btn xus-btn--go">{t("pay.calculate")}</button>
          </form>
          {result ? (
            <PayPresentation presentation={result} onRetry={retryPayData} retryLabel={t("app.tryAgain")} />
          ) : (
            <p className="xus-note xus-cardbody">{t("pay.calculatorHint")}</p>
          )}
        </section>
      )}

      {tab === "tables" && (
        <section className="plane-card xus-card">
          <PayPresentation presentation={tables} onRetry={retryPayData} retryLabel={t("app.tryAgain")} />
          <CatalogPublisher
            key={scopedActor.selectedOrganizationId ?? "no-organization"}
            actor={scopedActor}
            api={catalogApi}
            onPublished={reloadCatalog}
          />
        </section>
      )}


      {tab === "compare" && (
        <section className="plane-card xus-card">
          <form className="xus-form xus-cardbody" onSubmit={compare} onChange={() => { if (comparison?.fieldFeedback) setComparison(null); }}>
            <PayInput label={t("pay.leftGrade")} feedback={comparison?.fieldFeedback?.["left.grade"]}
              value={leftGrade} onChange={(event) => setLeftGrade(event.target.value)} />
            <PayInput label={t("pay.leftStep")} feedback={comparison?.fieldFeedback?.["left.stepNumber"]}
              inputMode="numeric" value={leftStep} onChange={(event) => setLeftStep(event.target.value)} />
            <PayInput label={t("pay.leftDate")} feedback={comparison?.fieldFeedback?.["left.effectiveOn"]}
              type="date" value={leftDate} onChange={(event) => setLeftDate(event.target.value)} />
            <PayInput label={t("pay.rightGrade")} feedback={comparison?.fieldFeedback?.["right.grade"]}
              value={rightGrade} onChange={(event) => setRightGrade(event.target.value)} />
            <PayInput label={t("pay.rightStep")} feedback={comparison?.fieldFeedback?.["right.stepNumber"]}
              inputMode="numeric" value={rightStep} onChange={(event) => setRightStep(event.target.value)} />
            <PayInput label={t("pay.rightDate")} feedback={comparison?.fieldFeedback?.["right.effectiveOn"]}
              type="date" value={rightDate} onChange={(event) => setRightDate(event.target.value)} />
            <PayInput label={t("pay.hoursPerYear")} feedback={comparison?.fieldFeedback?.hoursPerYear}
              inputMode="numeric" value={comparisonHoursPerYear} onChange={(event) => setComparisonHoursPerYear(event.target.value)} placeholder={t("pay.ruleUnsetHint")} />
            <PayInput label={t("pay.checksPerYear")} feedback={comparison?.fieldFeedback?.checksPerYear}
              inputMode="numeric" value={comparisonChecksPerYear} onChange={(event) => setComparisonChecksPerYear(event.target.value)} placeholder={t("pay.ruleUnsetHint")} />
            <button type="submit" className="xus-btn xus-btn--go">{t("pay.compare")}</button>
          </form>
          {comparison ? (
            <PayPresentation presentation={comparison} onRetry={retryPayData} retryLabel={t("app.tryAgain")} />
          ) : (
            <p className="xus-note xus-cardbody">{t("pay.comparisonHint")}</p>
          )}
        </section>
      )}
    </>
  );

  if (alt) return <AltBargainingPage tables={tables} bargaining={bargainingTable} tabs={tabBar} onOpenHome={onOpenHome}>{tabPanels}</AltBargainingPage>;

  return (
    <div className="screen" data-mi1-surface="pay-tools">
      <header className="phead">
        <div className="phead__copy">
          <h1 className="phead__title">{t("pay.title")}</h1>
          <p className="phead__sub">{t("pay.sub")}</p>
        </div>
      </header>
      {tabBar}

      {tabPanels}
    </div>
  );
}

// Mirrors the catalog normalizer's step bounds so a bad value is refused at the field.
function isCatalogStep(value) {
  return /^\d{1,2}$/.test(value.trim()) && Number(value) >= 1;
}

function CatalogPublisher({ actor, api, onPublished }) {
  const { t } = useLang();
  const [gradeCode, setGradeCode] = useState("");
  const [gradeTitle, setGradeTitle] = useState("");
  const [jobFamily, setJobFamily] = useState("");
  const [stepCount, setStepCount] = useState("");
  const [description, setDescription] = useState("");
  const [stepGrade, setStepGrade] = useState("");
  const [publishedStep, setPublishedStep] = useState("");
  const [publishedEffectiveOn, setPublishedEffectiveOn] = useState("");
  const [publishedHourlyRate, setPublishedHourlyRate] = useState("");
  const [busy, setBusy] = useState(null);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [status, setStatus] = useState(null);
  const [stepErrors, setStepErrors] = useState({ stepCount: false, publishedStep: false });
  const organizationId = actor.selectedOrganizationId;
  // Record 8435: the parent remounts this form for each organization, which
  // ends busy and the lock together; a publish from an earlier mount must not
  // reload the catalog the page now shows.
  const publishScope = useBusyScope(organizationId);
  const writeGate = authorizePay({ actor, organizationId, capability: "write_catalog" });
  const hasWriters = typeof api?.upsertGrade === "function" && typeof api?.upsertStep === "function";

  function publish(kind, action) {
    return runBusyWrite(busyWriteRef, `publish:${publishScope.generation}`, () => publishNow(kind, action));
  }

  async function publishNow(kind, action) {
    const generation = publishScope.generation;
    setBusy(kind);
    setStatus(null);
    try {
      const result = await action();
      if (!publishScope.isCurrent(generation)) return;
      if (!result.ok) {
        setStatus({ state: "error", message: result.reason === "invalid_input" ? t("pay.publisherInvalid") : t("pay.publisherFailed") });
        return;
      }
      setStatus({ state: "success", message: kind === "grade" ? t("pay.gradePublished") : t("pay.stepPublished") });
      await onPublished();
    } catch {
      if (publishScope.isCurrent(generation)) setStatus({ state: "error", message: t("pay.publisherFailed") });
    } finally {
      if (publishScope.isCurrent(generation)) setBusy(null);
    }
  }

  if (!writeGate.ok) {
    return <p className="xus-note xus-cardbody xus-cardbody--divided">{t("pay.publisherRestricted")}</p>;
  }
  if (!actor.mfaSatisfied) {
    return <p className="xus-note xus-cardbody xus-cardbody--divided">{t("pay.publisherMfa")}</p>;
  }
  if (!hasWriters) {
    return <p className="xus-note xus-cardbody xus-cardbody--divided">{t("pay.publisherUnavailable")}</p>;
  }

  return (
    <div className="xus-cardbody xus-cardbody--divided">
      <h2>{t("pay.publisherTitle")}</h2>
      <p className="xus-note">{t("pay.publisherHelp")}</p>
      <form className="xus-form" onSubmit={(event) => {
        event.preventDefault();
        const stepCountInvalid = stepCount.trim() !== "" && !isCatalogStep(stepCount);
        setStepErrors((current) => ({ ...current, stepCount: stepCountInvalid }));
        if (stepCountInvalid) return;
        void publish("grade", () => api.upsertGrade(actor, {
          organizationId,
          grade: gradeCode,
          title: gradeTitle,
          jobFamily: jobFamily || null,
          stepCount: stepCount.trim() === "" ? null : Number(stepCount),
          description: description || null,
        }));
      }}>
        <h3>{t("pay.publishGradeTitle")}</h3>
        <div className="xus-formgrid">
          <label className="xus-field">
            {t("pay.catalogGrade")}
            <input className="xus-input" required value={gradeCode} onChange={(event) => setGradeCode(event.target.value)} />
          </label>
          <label className="xus-field">
            {t("pay.gradeTitle")}
            <input className="xus-input" required maxLength={120} value={gradeTitle} onChange={(event) => setGradeTitle(event.target.value)} />
          </label>
          <label className="xus-field">
            {t("pay.jobFamily")}
            <input className="xus-input" maxLength={80} value={jobFamily} onChange={(event) => setJobFamily(event.target.value)} />
          </label>
          <label className="xus-field">
            {t("pay.stepCount")}
            <input className="xus-input" inputMode="numeric" min="1" max="99" value={stepCount} aria-invalid={stepErrors.stepCount || undefined} aria-describedby={stepErrors.stepCount ? "pay-step-count-error" : undefined} onChange={(event) => setStepCount(event.target.value)} />
          </label>
          {stepErrors.stepCount ? <p className="xus-note xus-note--error" id="pay-step-count-error">{t("pay.stepRangeInvalid")}</p> : null}
        </div>
        <label className="xus-field">
          {t("pay.gradeDescription")}
          <textarea className="xus-input xus-input--area" maxLength={400} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy !== null}>
          {busy === "grade" ? t("pay.publishing") : t("pay.publishGrade")}
        </BusyButton>
      </form>
      <form className="xus-form xus-cardbody--divided mi1-pay__publisher-form" onSubmit={(event) => {
        event.preventDefault();
        const publishedStepInvalid = !isCatalogStep(publishedStep);
        setStepErrors((current) => ({ ...current, publishedStep: publishedStepInvalid }));
        if (publishedStepInvalid) return;
        void publish("step", () => api.upsertStep(actor, {
          organizationId,
          grade: stepGrade,
          stepNumber: Number(publishedStep),
          effectiveOn: publishedEffectiveOn,
          hourlyRate: Number(publishedHourlyRate),
        }));
      }}>
        <h3>{t("pay.publishStepTitle")}</h3>
        <p className="xus-note">{t("pay.publishStepHelp")}</p>
        <div className="xus-formgrid">
          <label className="xus-field">
            {t("pay.stepGrade")}
            <input className="xus-input" required value={stepGrade} onChange={(event) => setStepGrade(event.target.value)} />
          </label>
          <label className="xus-field">
            {t("pay.catalogStep")}
            <input className="xus-input" required inputMode="numeric" min="1" max="99" value={publishedStep} aria-invalid={stepErrors.publishedStep || undefined} aria-describedby={stepErrors.publishedStep ? "pay-catalog-step-error" : undefined} onChange={(event) => setPublishedStep(event.target.value)} />
          </label>
          {stepErrors.publishedStep ? <p className="xus-note xus-note--error" id="pay-catalog-step-error">{t("pay.stepRangeInvalid")}</p> : null}
          <label className="xus-field">
            {t("pay.catalogEffectiveOn")}
            <input className="xus-input" required type="date" value={publishedEffectiveOn} onChange={(event) => setPublishedEffectiveOn(event.target.value)} />
          </label>
          <label className="xus-field">
            {t("pay.catalogHourlyRate")}
            <input className="xus-input" required inputMode="decimal" value={publishedHourlyRate} onChange={(event) => setPublishedHourlyRate(event.target.value)} />
          </label>
        </div>
        <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy !== null}>
          {busy === "step" ? t("pay.publishing") : t("pay.publishStep")}
        </BusyButton>
      </form>
      {status ? (
        <p className={`xus-note xus-note--${status.state}`} role="status" aria-live="polite">{status.message}</p>
      ) : null}
    </div>
  );
}

function PayPresentation({ presentation, onRetry = null, retryLabel = "Try again" }) {
  const { t } = useLang();
  if (!presentation || presentation.fieldFeedback) return null;
  if (presentation.state !== "success") {
    return (
      <div className="empty-state" role="status" aria-live="polite">
        <p>{localizedPayMessage(presentation, t)}</p>
        <small>{t("pay.disclaimer")}</small>
        {presentation.state === "retry" && onRetry ? (
          <button type="button" className="xus-btn" onClick={onRetry}>{retryLabel}</button>
        ) : null}
      </div>
    );
  }
  const showAnnual = presentation.rows?.some((row) => row.annual != null);
  return (
    <div className="xus-cardbody" role="status" aria-live="polite">
      {presentation.rate ? (
        <p>{t("pay.hourlyRate")}: <strong>{presentation.rate.hourly}</strong> · {t("pay.annual")}: {presentation.rate.annual ?? t("pay.notSet")}</p>
      ) : null}
      {presentation.cards?.map((card) => (
        <p key={card.kind}>
          {t(`pay.bucket.${card.kind}`)}: {card.hours} {t("pay.hoursShort")} × {card.rate} = <strong>{card.amount}</strong>
        </p>
      ))}
      {presentation.grossOwed ? <p>{t("pay.grossOwed")}: <strong>{presentation.grossOwed}</strong></p> : null}
      {presentation.amountPaid ? <p>{t("pay.amountPaid")}: {presentation.amountPaid}</p> : null}
      {presentation.underpayment ? <p>{t("pay.underpayment")}: {presentation.underpayment}</p> : null}
      {presentation.backPay ? <p>{t("pay.backPay")}: <strong>{presentation.backPay}</strong></p> : null}
      {presentation.raise ? (
        <>
          <p>{t("pay.raiseResult")}: {presentation.raise.percent}%</p>
          <p>{t("pay.currentAnnual")}: {presentation.raise.nowAnnual}</p>
          <p>{t("pay.newAnnual")}: {presentation.raise.newAnnual}</p>
          <p>{t("pay.annualRaiseDelta")}: {presentation.raise.annualDelta}</p>
          <p>{t("pay.perCheckDelta")}: {presentation.raise.perCheckDelta}</p>
          <p>{t("pay.raiseRetro")}: {presentation.raise.retro}</p>
        </>
      ) : null}
      {presentation.left && presentation.right ? (
        <>
          <p>{t("pay.comparisonFrom")}: {presentation.left.grade} · {t("pay.step")} {presentation.left.stepNumber} · {presentation.left.hourly} · {presentation.left.effectiveOn}</p>
          <p>{t("pay.comparisonTo")}: {presentation.right.grade} · {t("pay.step")} {presentation.right.stepNumber} · {presentation.right.hourly} · {presentation.right.effectiveOn}</p>
          <p>{t("pay.hourlyDelta")}: <strong>{presentation.hourlyDelta}</strong></p>
          <p>{t("pay.annualDelta")}: {presentation.annualDelta}</p>
          <p>{t("pay.perCheckDelta")}: {presentation.perCheckDelta}</p>
        </>
      ) : null}
      {presentation.rows?.length > 0 && (
        <table className="mi1-pay__table">
          <thead>
            <tr>
              <th>{t("pay.grade")}</th>
              <th>{t("pay.step")}</th>
              <th>{t("pay.effectiveOn")}</th>
              <th>{t("pay.hourlyRate")}</th>
              {showAnnual && <th>{t("pay.annual")}</th>}
            </tr>
          </thead>
          <tbody>
            {presentation.rows.map((row) => (
              <tr key={`${row.grade}-${row.stepNumber}-${row.effectiveOn}`}>
                <td>{row.grade}</td>
                <td>{row.stepNumber}</td>
                <td>{row.effectiveOn}</td>
                <td>{row.hourly}</td>
                {showAnnual && <td>{row.annual ?? t("pay.notSet")}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="xus-note">{t("pay.disclaimer")}</p>
    </div>
  );
}

function localizedPayMessage(presentation, t) {
  if (presentation.state === "loading") return t("pay.loading");
  if (presentation.state === "retry" || presentation.reason === "catalog_unavailable") {
    return t("pay.catalogRetry");
  }
  switch (presentation.reason) {
    case "empty_organization":
      return t("pay.noOrganization");
    case "wrong_organization":
      return t("pay.wrongOrganization");
    case "membership_inactive":
    case "missing_actor":
    case "unauthorized":
      return t("pay.unauthorized");
    case "scale_not_found":
      return t("pay.scaleNotFound");
    case "calculation_date_required":
      return t("pay.calculationDateRequired");
    case "calculation_rules_unset":
      return t("pay.calculationRulesUnset");
    case "invalid_input":
      return t("pay.invalidInput");
    case "catalog_empty":
      return t("pay.catalogEmpty");
    default:
      return presentation.state === "empty" ? t("pay.catalogEmpty") : t("pay.failure");
  }
}
