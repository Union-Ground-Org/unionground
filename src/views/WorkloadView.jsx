import { useRoutedTab, RoutedTabLink } from "../components/WorkspacePages.jsx";
import { useEffect, useRef, useState } from "react";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { Bot } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { dateTimeFormat, localeFor } from "../lib/i18n.js";
import { EmptyState } from "../components/Primitives.jsx";
import { FlowValue } from "../components/FlowValue.jsx";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { WORKLOAD_CATEGORY_KEYS, shownWorkloadCategories } from "../lib/workloadCategories.js";
import { WorkloadConfiguredEntry } from "../components/WorkloadConfiguredEntry.jsx";
import { WorkloadConfiguredHistory } from "../components/WorkloadConfiguredHistory.jsx";
import { configuredWorkloadCategories, emptyWorkloadDraft, hasOriginalWorkloadCounts } from "../lib/workloadConfiguration.js";
import { UnitWorkflowChoice, useUnitWorkflow } from "../features/chapterAccess/UnitWorkflowChoice.jsx";
import { BOOKING_TIME_ZONES } from "../lib/appointmentDetailsApi.js";
import { formatZoneInstant } from "../lib/zoneTime.js";

// GAP-804 — member "Workload log". A ~10-second self-report form (Submit), the
// member's own past logs (History), anonymized collective aggregates (Stats),
// and the member's self-owned reminder schedule. Individual entries are never
// browsable; only chapter aggregates surface once enough members have logged
// (K=25), and only winsorized average/median/p90 summaries are shown — never
// exact contributor counts, per-member data or ranks. All copy flows
// through t(); no data leaves via network here (the parent owns onLogWork); the
// only browser API used is the CSV Blob download in History.
//
// Wave 2c: restyled to the design prototype's pg.workload (Union Base
// Site.dc.html 3997-4147) with the page's own in-page header (the global
// MobileTopBar owns identity chrome). Privacy floors outrank pixel parity:
// the prototype's exact submitter count remains intentionally absent. UB-WKL-03
// restores the privacy-safe percentile summary and server-owned Reminders tab.

// All eight categories travel to the server on every log and stay in the CSV
// export. REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103:
// the organization's shown categories, in its order, are the only ones the
// form asks for and the summaries show; a hidden category is logged as 0.
const CATEGORY_KEYS = WORKLOAD_CATEGORY_KEYS;

const LEAVE_OPTIONS = [
  { id: "none", type: null, labelKey: "workload.leaveNone" },
  { id: "sick", type: "sick_leave", labelKey: "workload.leaveSick" },
  { id: "annual", type: "annual_leave", labelKey: "workload.leaveAnnual" },
  { id: "lwop", type: "lwop", labelKey: "workload.leaveLwop" },
  { id: "fmla", type: "fmla", labelKey: "workload.leaveFmla" },
  { id: "admin", type: "admin_leave", labelKey: "workload.leaveAdmin" },
  { id: "comp", type: "comp_time", labelKey: "workload.leaveComp" },
];

const WEEKLY_PRESETS = [12, 15, 18];

function zeroCounts() {
  return CATEGORY_KEYS.reduce((acc, key) => ({ ...acc, [key]: 0 }), {});
}

export function WorkloadView({ data, onAssistant, onLogWork, onSaveReminder, personalReminders = null, statsGate = null, unitSettingsApi = null }) {
  const { t, lang } = useLang();
  const [tab, setTab] = useRoutedTab("workload", "submit");
  // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: an
  // address like /m/workload?tab=reminders opens that tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (["submit", "history", "stats", "reminders"].includes(requested) && requested !== tab) setTab(requested);
    // Read once on mount: later tab changes are the member's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The Submit draft lives one level above the routed tabs. The device-parity
  // store deletes a key once its LAST consumer unmounts (see deviceParity.js),
  // and SubmitTab mounts only while its tab is selected (mount only
  // the selected section) — so owning the thirteen fields here keeps a live
  // consumer across History/Stats/Reminders hops and browser Back, and the
  // unselected section's form, effects and live regions are truly absent.
  // Leaving the workload view entirely still unmounts this parent and lets
  // the store drop the draft, exactly as before the tab rebuild.
  const draft = useWorkloadDraft();
  const unitWorkflow = useUnitWorkflow(unitSettingsApi, `${data.member?.id}:${data.member?.chapterId}:${data.member?.organizationId}`, data.member);
  const unitEnabled = unitSettingsApi && !unitWorkflow.context?.legacy;
  const [unitSaveBusy, setUnitSaveBusy] = useState(false);

  const workload = data.workload || {};
  const entries = workload.entries || [];
  const stats = workload.stats || { enoughData: false };
  const shownKeys = shownWorkloadCategories(workload.categories);
  const configuration = unitEnabled ? unitWorkflow.context?.effective?.configuration : workload.configuration;
  const configured = unitEnabled ? unitWorkflow.ready : configuration?.version > 0;
  // BUG-UG-WORKLOAD-STATS-IGNORE-CONFIGURED-CATEGORY-NAMES-20261106:
  // an applied version names, orders and hides the Stats categories the way
  // its entry form does; before one, the #6910 layout and labels stay.
  const configuredCategories = configuredWorkloadCategories(workload.configuration, lang);
  const statsKeys = configuredCategories ? configuredCategories.map((category) => category.key) : shownKeys;
  const categoryName = (key) => configuredCategories?.find((category) => category.key === key)?.name ?? t(`workload.cat.${key}`);
  const configuredHistory = configured || entries.some((entry) => entry.configurationSnapshot?.version > 0);
  // Keep a live draft owner while the selected tab's form is unmounted.
  // Each organization/version has its own draft for this view's lifetime.
  const [configuredDrafts, setConfiguredDrafts] = useState({});
  const configuredScope = `${configuration?.organizationId}:${configuration?.unitId}:${configuration?.version}:${configuration?.settingsRevision}`;
  const configuredDraft = configured ? configuredDrafts[configuredScope] || emptyWorkloadDraft(configuration.definition) : null;
  const changeConfiguredDraft = (update) => setConfiguredDrafts((current) => ({
    ...current,
    [configuredScope]: typeof update === "function" ? update(current[configuredScope] || emptyWorkloadDraft(configuration.definition)) : update,
  }));

  const tabs = [
    { id: "submit", label: t("workload.tab.submit") },
    { id: "history", label: t("workload.tab.history") },
    { id: "stats", label: t("workload.tab.stats") },
    { id: "reminders", label: t("workload.tab.reminders") },
  ];

  return (
    <div className="screen">
      <header className="mwl-head">
        <div className="mwl-head__copy">
          <h1 className="mwl-title">{t("nav.workload")}</h1>
          <p className="mwl-sub">{t("mwl.sub")}</p>
        </div>
        {onAssistant && (
          <button type="button" className="icon-button" aria-label={t("header.assistant")} onClick={onAssistant}>
            <Bot size={19} />
          </button>
        )}
      </header>
      {unitEnabled && <UnitWorkflowChoice workflow={unitWorkflow} pending={unitSaveBusy} />}

      {/* aria-pressed, not a tab role — see AuthScreen.jsx. */}
      <div className="mwl-tabs" role="group" aria-label={t("nav.workload")}>
        {tabs.map((item) => (
          <RoutedTabLink group="workload" value={item.id}
            key={item.id}
            type="button"
            className="mwl-tab"
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </RoutedTabLink>
        ))}
      </div>

      {tab === "submit" && configured && <section className="mwl-body"><WorkloadConfiguredEntry key={configuredScope} configuration={configuration} onSave={onLogWork} draft={configuredDraft} onDraftChange={changeConfiguredDraft} onBusyChange={setUnitSaveBusy} /></section>}
      {tab === "submit" && !configured && !unitEnabled && (
        <SubmitTab t={t} onLogWork={onLogWork} entries={entries} draft={draft} shownKeys={shownKeys} />
      )}
      {tab === "history" && (configuredHistory
        ? <WorkloadConfiguredHistory entries={entries} configuration={configuration || entries.find((entry) => entry.configurationSnapshot?.definition)?.configurationSnapshot} unitContext={unitEnabled ? unitWorkflow.context : null} requireUnitContext={Boolean(unitEnabled)} onSave={onLogWork} />
        : <HistoryTab t={t} entries={entries} shownKeys={shownKeys} />)}
      {/* REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030:
          the quarterly survey gate covers the stats it unlocks, not the log,
          its history or reminders. */}
      {tab === "stats" && configured && <p className="xus-note">{t("workload.config.collectiveLimit")}</p>}
      {tab === "stats" && (statsGate
        ? statsGate(<StatsTab t={t} lang={lang} stats={stats} entries={entries} shownKeys={statsKeys} categoryName={categoryName} />)
        : <StatsTab t={t} lang={lang} stats={stats} entries={entries} shownKeys={statsKeys} categoryName={categoryName} />)}
      {tab === "reminders" && (
        <>
          <RemindersTab
            t={t}
            lang={lang}
            initial={workload.reminders}
            onSave={onSaveReminder}
          />
          {personalReminders}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Submit tab */

function todayInputValue(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// The worked day and hours ride in the entry's sub_details, validated here:
// a past or current calendar date, and 0 to 24 hours in quarter hours.
export function workedDetails(workedOn, hoursWorked, now = new Date()) {
  const details = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(workedOn || "") && workedOn <= todayInputValue(now)) details.workedOn = workedOn;
  if (hoursWorked !== "" && hoursWorked != null) {
    const hours = Number(hoursWorked);
    if (Number.isFinite(hours) && hours >= 0 && hours <= 24 && Number.isInteger(hours * 4)) details.hoursWorked = hours;
  }
  return details;
}

// A real calendar date after the device's today: the one dropped day the form
// names (#9469). Anything else workedDetails drops is left as Main left it.
export function futureWorkedOn(workedOn, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workedOn || "")) return false;
  const [year, month, date] = workedOn.split("-").map(Number);
  const day = new Date(Date.UTC(year, month - 1, date));
  return day.getUTCMonth() === month - 1 && day.getUTCDate() === date && workedOn > todayInputValue(now);
}

function workedLine(t, entry) {
  const parts = [];
  if (entry.workedOn) parts.push(t("workload.workedOnLine", { date: entry.workedOn }));
  if (entry.hoursWorked != null) parts.push(t("workload.hoursLine", { hours: entry.hoursWorked }));
  return parts.join(" · ");
}

// Owns the thirteen draft fields for the life of the WorkloadView mount so
// the routed Submit tab can unmount while unselected without the device-parity
// store discarding the half-filled draft. See the call site in WorkloadView.
function useWorkloadDraft() {
  const [counts, setCounts] = useDeviceParityState("workload.counts", zeroCounts);
  const [weeklyAssigned, setWeeklyAssigned] = useDeviceParityState("workload.weeklyAssigned", 0);
  const [employment, setEmployment] = useDeviceParityState("workload.employment", "full_time");
  const [ptHours, setPtHours] = useDeviceParityState("workload.ptHours", 20);
  const [onPlan, setOnPlan] = useDeviceParityState("workload.onPlan", false);
  const [otWorked, setOtWorked] = useDeviceParityState("workload.otWorked", false);
  const [otHours, setOtHours] = useDeviceParityState("workload.otHours", 0);
  const [noIntake, setNoIntake] = useDeviceParityState("workload.noIntake", false);
  const [halfDay, setHalfDay] = useDeviceParityState("workload.halfDay", false);
  const [leave, setLeave] = useDeviceParityState("workload.leave", "none");
  const [leaveTiming, setLeaveTiming] = useDeviceParityState("workload.leaveTiming", null);
  const [note, setNote] = useDeviceParityState("workload.note", "");
  // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the
  // day the work was done and its hours, kept on the member's own entry.
  const [workedOn, setWorkedOn] = useDeviceParityState("workload.workedOn", "");
  const [hoursWorked, setHoursWorked] = useDeviceParityState("workload.hoursWorked", "");
  const [confirmClear, setConfirmClear] = useDeviceParityState("workload.confirmClear", false);

  return {
    counts, setCounts,
    weeklyAssigned, setWeeklyAssigned,
    employment, setEmployment,
    ptHours, setPtHours,
    onPlan, setOnPlan,
    otWorked, setOtWorked,
    otHours, setOtHours,
    noIntake, setNoIntake,
    halfDay, setHalfDay,
    leave, setLeave,
    leaveTiming, setLeaveTiming,
    note, setNote,
    workedOn, setWorkedOn,
    hoursWorked, setHoursWorked,
    confirmClear, setConfirmClear,
  };
}

function SubmitTab({ t, onLogWork, entries, draft, shownKeys }) {
  const {
    counts, setCounts,
    weeklyAssigned, setWeeklyAssigned,
    employment, setEmployment,
    ptHours, setPtHours,
    onPlan, setOnPlan,
    otWorked, setOtWorked,
    otHours, setOtHours,
    noIntake, setNoIntake,
    halfDay, setHalfDay,
    leave, setLeave,
    leaveTiming, setLeaveTiming,
    note, setNote,
    workedOn, setWorkedOn,
    hoursWorked, setHoursWorked,
    confirmClear, setConfirmClear,
  } = draft;

  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const isPartTime = employment === "part_time";
  const hasLeave = leave !== "none";
  const lastLabel = entries.length > 0 ? entries[0].dateLabel : null;

  function setCount(key, value) {
    setCounts((prev) => ({ ...prev, [key]: value }));
    clearFeedback();
  }

  function clearFeedback() {
    if (result) setResult(null);
    if (error) setError(null);
  }

  function pickLeave(id) {
    setLeave(id);
    // default the timing to what the server would record so the chip row shows
    // a selection that matches what's actually stored ('unplanned').
    setLeaveTiming(id === "none" ? null : (leaveTiming ?? "unplanned"));
    clearFeedback();
  }

  function resetForm() {
    setCounts(zeroCounts());
    setWeeklyAssigned(0);
    setEmployment("full_time");
    setPtHours(20);
    setOnPlan(false);
    setOtWorked(false);
    setOtHours(0);
    setNoIntake(false);
    setHalfDay(false);
    setLeave("none");
    setLeaveTiming(null);
    setNote("");
    setWorkedOn("");
    setHoursWorked("");
  }

  function buildFields() {
    const leaveOpt = LEAVE_OPTIONS.find((o) => o.id === leave) || LEAVE_OPTIONS[0];
    const trimmed = note.trim();
    const subDetails = workedDetails(workedOn, hoursWorked);
    // A draft kept from before a category was hidden never sends a number the
    // member can no longer see.
    const count = (key) => (shownKeys.includes(key) ? counts[key] : 0);
    return {
      priority: count("priority"),
      pending: count("pending"),
      unread_docs: count("unread_docs"),
      todos: count("todos"),
      referrals: count("referrals"),
      ce_activities: count("ce_activities"),
      assistance_requests: count("assistance_requests"),
      aged_cases: count("aged_cases"),
      weeklyAssigned,
      employment,
      ptHours: isPartTime ? ptHours : null,
      onPlan,
      otWorked,
      otHours: otWorked ? otHours : 0,
      leaveType: leaveOpt.type,
      leaveTiming: hasLeave ? leaveTiming : null,
      noIntake,
      halfDay,
      note: trimmed ? trimmed : null,
      ...(Object.keys(subDetails).length ? { subDetails } : {}),
    };
  }

  function submit() {
    return runBusyWrite(busyWriteRef, "workload", () => submitNow());
  }

  async function submitNow() {
    if (busy) return;
    if (hoursWorked !== "" && workedDetails(workedOn, hoursWorked).hoursWorked === undefined) {
      setError(t("workload.hoursInvalid"));
      return;
    }
    // A real day after today is refused with its reason, not dropped (#9469).
    if (futureWorkedOn(workedOn)) {
      setError(t("workload.workedOnFuture"));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await onLogWork(buildFields());
      // The demo twin returns a truthy result WITHOUT a receipt (demo
      // receipts must never look verifiable), so branch on the code itself,
      // not on mere truthiness.
      if (outcome?.receiptCode) {
        setResult({ code: outcome.receiptCode, remaining: outcome.remainingToday });
      } else {
        setResult({ demo: true });
      }
      resetForm();
      setConfirmClear(false);
    } catch (error) {
      // The daily cap is the one refusal a member can act on, so it gets its
      // own sentence; every other failure keeps the generic one.
      setError(t(error?.details === "workload_daily_limit" ? "rpcError.workload_daily_limit" : error?.code === "worked_hours" ? "workload.hoursInvalid" : "workload.submitFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mwl-body" data-testid="workload-submit-panel">
      <div className="mwl-card mwl-card--warn">
        <div className="mwl-warn">
          <span className="mwl-warn__icon" aria-hidden="true">⏱</span>
          <div className="mwl-warn__copy">
            <strong className="mwl-cardtitle">{t("workload.eyebrow")}</strong>
            <p className="mwl-warn__body">{t("mwl.protectBody")}</p>
          </div>
        </div>
      </div>

      <div className="mwl-grid">
        <div className="mwl-col">
          <div className="mwl-card mwl-card--flush">
            <div className="mwl-cathead">
              <strong className="mwl-cardtitle">{t("mwl.catTitle")}</strong>
              <span className="mwl-cathint">{t("mwl.catHint")}</span>
            </div>
            {shownKeys.map((key) => (
              <div className="mwl-catrow" key={key}>
                <div className="mwl-catrow__copy">
                  <span className="mwl-catrow__label">{t(`workload.cat.${key}`)}</span>
                  <span className="mwl-catrow__sub">{t(`mwl.catSub.${key}`)}</span>
                </div>
                {counts[key] > 4 && <span className="mwl-trend">{t("workload.trendingUp")}</span>}
                <Stepper
                  inline
                  label={t(`workload.cat.${key}`)}
                  value={counts[key]}
                  onChange={(value) => setCount(key, value)}
                />
              </div>
            ))}
          </div>

          <div className="mwl-card mwl-form">
            <div>
              <span className="mwl-eyebrow">{t("mwl.weeklyTitle")}</span>
              <div className="mwl-chips">
                {WEEKLY_PRESETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="mwl-chip"
                    aria-pressed={weeklyAssigned === n}
                    onClick={() => {
                      setWeeklyAssigned(n);
                      clearFeedback();
                    }}
                  >
                    {t("mwl.weeklyCases", { n })}
                  </button>
                ))}
                <span className="mwl-finehint">{t("mwl.weeklyManual")}</span>
                <Stepper
                  inline
                  label={t("workload.weeklyAssigned")}
                  value={weeklyAssigned}
                  onChange={(value) => {
                    setWeeklyAssigned(value);
                    clearFeedback();
                  }}
                />
              </div>
            </div>

            <div>
              <span className="mwl-eyebrow">{t("mwl.empStatus")}</span>
              <div className="mwl-chips">
                <button
                  type="button"
                  className="mwl-chip"
                  aria-pressed={employment === "full_time"}
                  onClick={() => {
                    setEmployment("full_time");
                    clearFeedback();
                  }}
                >
                  {t("workload.fullTime")}
                </button>
                <button
                  type="button"
                  className="mwl-chip"
                  aria-pressed={employment === "part_time"}
                  onClick={() => {
                    setEmployment("part_time");
                    clearFeedback();
                  }}
                >
                  {t("workload.partTime")}
                </button>
                {isPartTime && (
                  <Stepper
                    inline
                    label={t("workload.ptHours")}
                    value={ptHours}
                    onChange={(value) => {
                      setPtHours(value);
                      clearFeedback();
                    }}
                    max={80}
                    suffix={t("mwl.hrsWk")}
                  />
                )}
              </div>
              <CheckRow
                label={t("workload.onPlan")}
                checked={onPlan}
                onChange={(v) => {
                  setOnPlan(v);
                  clearFeedback();
                }}
              />
              <CheckRow
                label={t("workload.otWorked")}
                checked={otWorked}
                onChange={(v) => {
                  setOtWorked(v);
                  setOtHours(v ? Math.max(1, otHours) : 0);
                  clearFeedback();
                }}
              >
                <Stepper
                  inline
                  label={t("workload.otHours")}
                  value={otHours}
                  onChange={(value) => {
                    setOtHours(value);
                    clearFeedback();
                  }}
                  min={1}
                  max={99}
                  suffix={t("mwl.hrsShort")}
                />
              </CheckRow>
            </div>

            <div>
              <span className="mwl-eyebrow">{t("mwl.leavePeriod")}</span>
              <div className="mwl-chips" role="group" aria-label={t("mwl.leavePeriod")}>
                {LEAVE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className="mwl-chip"
                    aria-pressed={leave === opt.id}
                    onClick={() => pickLeave(opt.id)}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
              {hasLeave && (
                <div className="mwl-chips" role="group" aria-label={t("mwl.leaveTiming")}>
                  <button
                    type="button"
                    className="mwl-chip"
                    aria-pressed={leaveTiming === "planned"}
                    onClick={() => {
                      setLeaveTiming("planned");
                      clearFeedback();
                    }}
                  >
                    {t("workload.planned")}
                  </button>
                  <button
                    type="button"
                    className="mwl-chip"
                    aria-pressed={leaveTiming === "unplanned"}
                    onClick={() => {
                      setLeaveTiming("unplanned");
                      clearFeedback();
                    }}
                  >
                    {t("workload.unplanned")}
                  </button>
                </div>
              )}
              {/* ALWAYS visible, matching the pre-rebuild contract: buildFields()
                  submits both flags unconditionally into the WRITE-ONCE ledger,
                  so gating them behind leave both lost staffing evidence (a
                  no-leave member could no longer report stopped-intake or a
                  half day) and let a hidden stale `true` ride into an
                  immutable submission the member could not see or undo. Only
                  the leave TIMING chips above are leave-scoped. */}
              <CheckRow
                label={t("workload.noIntake")}
                hint={t("mwl.noIntakeHint")}
                checked={noIntake}
                onChange={(v) => {
                  setNoIntake(v);
                  clearFeedback();
                }}
              />
              <CheckRow
                label={t("workload.halfDay")}
                checked={halfDay}
                onChange={(v) => {
                  setHalfDay(v);
                  clearFeedback();
                }}
              />
            </div>

            <div>
              <span className="mwl-eyebrow">{t("mwl.note")}</span>
              <textarea
                className="mwl-notefield"
                aria-label={t("mwl.note")}
                placeholder={t("mwl.notePlaceholder")}
                value={note}
                maxLength={4000}
                onChange={(event) => {
                  setNote(event.target.value);
                  clearFeedback();
                }}
              />
            </div>

            <div className="mwl-worked">
              <label className="mwl-worked__field">
                <span className="mwl-eyebrow">{t("workload.workedOn")}</span>
                <input type="date" value={workedOn} max={todayInputValue()} onChange={(event) => { setWorkedOn(event.target.value); clearFeedback(); }} />
              </label>
              <label className="mwl-worked__field">
                <span className="mwl-eyebrow">{t("workload.hoursWorked")}</span>
                <input type="number" inputMode="decimal" min="0" max="24" step="0.25" value={hoursWorked} onChange={(event) => { setHoursWorked(event.target.value); clearFeedback(); }} />
              </label>
              <p className="mwl-worked__help">{t("workload.workedHelp")}</p>
            </div>

            {error && (
              <p role="alert" className="mwl-error">
                {error}
              </p>
            )}

            <div className="mwl-actions">
              <BusyButton type="button" className="mwl-btn mwl-btn--primary" onClick={submit} pending={busy}>
                {t("workload.submitCta")}
              </BusyButton>
              {!confirmClear && (
                <button type="button" className="mwl-btn mwl-btn--ghost" onClick={() => setConfirmClear(true)}>
                  {t("mwl.clearAll")}
                </button>
              )}
              {confirmClear && (
                <>
                  <button type="button" className="mwl-btn mwl-btn--ghost" onClick={() => setConfirmClear(false)}>
                    {t("mwl.clearCancel")}
                  </button>
                  <button
                    type="button"
                    className="mwl-btn mwl-btn--danger"
                    onClick={() => {
                      resetForm();
                      setConfirmClear(false);
                      clearFeedback();
                    }}
                  >
                    {t("mwl.clearYes")}
                  </button>
                </>
              )}
              <span className="mwl-finehint">{t("workload.anonNote")}</span>
            </div>
          </div>
        </div>

        <div className="mwl-col">
          {result && (
            <div role="status" className="mwl-card mwl-card--logged">
              <strong className="mwl-logged__title">
                {result.demo ? t("toast.workLogged") : t("workload.receipt", { code: result.code })}
              </strong>
              {!result.demo && (
                <span className="mwl-logged__body">{t("workload.logAnother", { remaining: result.remaining })}</span>
              )}
            </div>
          )}
          {/* The rate-limit note renders for EVERYONE — its whole audience is
              the member who has not submitted yet, who would never see it if
              it only lived behind entries.length > 0. */}
          <div className="mwl-card">
            {lastLabel && (
              <>
                <strong className="mwl-cardtitle">{t("mwl.lastSubmitted")}</strong>
                <p className="mwl-side__meta">{lastLabel}</p>
              </>
            )}
            <p className="mwl-side__hint">{t("workload.limitNote")}</p>
          </div>
          <div className="mwl-card">
            <strong className="mwl-cardtitle">{t("workload.whereTitle")}</strong>
            <p className="mwl-side__body">{t("workload.whereBody")}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- History tab */

function HistoryTab({ t, entries, shownKeys }) {
  function downloadCsv() {
    if (!entries.length) return;
    // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the
    // day worked and its hours export beside the entry they belong to.
    const header = ["date", "receipt", ...CATEGORY_KEYS, "meta", "note", "worked_on", "hours_worked"];
    const rows = entries.map((entry) => [
      entry.dateLabel || "",
      entry.receipt || "",
      ...CATEGORY_KEYS.map((key) => entry.counts?.[key] ?? ""),
      entry.meta || "",
      entry.note || "",
      entry.workedOn || "",
      entry.hoursWorked != null ? entry.hoursWorked : "",
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    // Excel reads a .csv with no byte order mark as the machine's legacy code
    // page, so an accented name or a Spanish note in a member's own log opens
    // as mojibake. The UTF-8 BOM is the only signal it honours; the MIME
    // charset above is not. Everything after the mark — column order, values,
    // quoting, CRLF endings — is byte-identical, and the repo's own importer
    // strips a leading mark (src/features/memberOperations/csv.js).
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "workload-log.csv";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  if (entries.length === 0) {
    return (
      <section className="mwl-body">
        <EmptyState>
          <p>{t("workload.histEmpty")}</p>
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="mwl-body">
      <div className="mwl-histhead">
        <span className="mwl-histcount">{t("workload.histTitle", { count: entries.length })}</span>
        <span className="mwl-spacer" />
        <button type="button" className="mwl-btn mwl-btn--ghost" onClick={downloadCsv}>
          {t("workload.downloadCsv")}
        </button>
      </div>

      <div className="mwl-histlist">
        {entries.map((entry) => (
          <article key={entry.id} className="mwl-card mwl-histrow">
            <span className="mwl-histwhen">{entry.dateLabel}</span>
            <span className="mwl-histline">{countSummary(t, entry.counts, shownKeys)}</span>
            {entry.meta && <span className="mwl-histmeta">{entry.meta}</span>}
            {(entry.workedOn || entry.hoursWorked != null) && <span className="mwl-histmeta">{workedLine(t, entry)}</span>}
            {entry.note && <span className="mwl-histnote">{entry.note}</span>}
            <span className="mwl-histwhen">#{entry.receipt}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- Stats tab */

function StatsTab({ t, lang, stats, entries, shownKeys, categoryName }) {
  // Only show the submitter band once there's enough data; below the floor the
  // threshold (25) is not a real count, so fall back to the anonymity note.
  const hasBand = stats.submittersBand != null;
  const header = (
    <div className="mwl-statshead">
      <strong className="mwl-statstitle">{t("workload.statsTitle")}</strong>
      <p className="mwl-statssub">
        {hasBand ? t("workload.statsSub", { count: stats.submittersBand }) : t("workload.anonNote")}
      </p>
      {stats.period && (
        <p className="mwl-period">{t("workload.statsPeriod", { period: stats.period })}</p>
      )}
    </div>
  );

  if (!stats.enoughData) {
    return (
      <section className="mwl-body">
        {header}
        <EmptyState>
          <p>{t("workload.notEnough")}</p>
        </EmptyState>
      </section>
    );
  }

  const avgByKey = {};
  const distributionsByKey = {};
  (stats.categories || []).forEach((category) => {
    avgByKey[category.key] = category.avg;
    distributionsByKey[category.key] = category;
  });
  // #7180: the server withholds a category that fewer than 25 members
  // measured. Neither the bars nor the comparison may stand in a zero for it.
  const publishedKeys = shownKeys.filter((key) => distributionsByKey[key]);
  const maxAvg = Math.max(1, ...publishedKeys.map((key) => avgByKey[key] || 0));

  const latest = entries.find(hasOriginalWorkloadCounts)?.counts || null;
  const tiles = stats.tiles || {};
  // UX-UG-WORKLOAD-STATS-TILES-LOCALE-NUMBER-FORMAT-20260920. The three
  // summary tiles used to interpolate their number straight into a literal
  // with an English "%" or "h" glued on. get_workload_stats rounds
  // avgOtHours to one decimal, so a fractional value really does reach the
  // tile and a Spanish reader saw "1.5h" inside otherwise translated copy.
  // The number now goes through the member's locale the way RewardsView
  // formats its totals, and the unit and the spacing before it come from the
  // catalogue — Spanish writes "{value} h", English "{value}h" — so neither
  // is a hard-coded mark here. The percentages travel the same path; they are
  // whole tens from the same function, so their rendering does not move.
  const tileValue = (value, key) => value == null ? "—" : t(key, { value: Number(value).toLocaleString(localeFor(lang)) });

  return (
    <section className="mwl-body">
      {header}

      <div className="mwl-statsgrid">
        <div className="mwl-card">
          <div className="mwl-barhead">
            <strong className="mwl-cardtitle">{t("mwl.perCategory")}</strong>
            <span className="mwl-legend">{t("workload.distributionLegend")}</span>
          </div>
          <div className="mwl-bars">
            {publishedKeys.map((key) => {
              const avg = avgByKey[key] || 0;
              const distribution = distributionsByKey[key] || {};
              const median = distribution.median ?? 0;
              const p90 = distribution.p90 ?? 0;
              const width = `${Math.max(4, Math.round((avg / maxAvg) * 100))}%`;
              return (
                <div key={key} className="mwl-bar">
                  <span className="mwl-bar__label">{categoryName(key)}</span>
                  <span className="mwl-bar__rail">
                    <span className="mwl-bar__fill" style={{ width }} />
                  </span>
                  {/* A generic span prohibits naming, so aria-label on the glyph row was
                      dropped by assistive technology. Hide the glyphs and read the same
                      figures from real text instead. */}
                  <span className="mwl-bar__val">
                    <span aria-hidden="true">{avg} / {median} / {p90}</span>
                    <span className="sr-only">
                      {t("workload.distributionValues", { average: avg, median, p90 })}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mwl-col">
          <div className="mwl-tiles">
            <StatTile label={t("workload.fullTime")} value={tileValue(tiles.pctFullTime, "workload.tilePercent")} />
            <StatTile label={t("workload.partTime")} value={tileValue(tiles.pctPartTime, "workload.tilePercent")} />
            <StatTile label={t("mwl.avgOt")} value={tileValue(tiles.avgOtHours, "workload.tileHours")} />
          </div>

          {latest && (
            <div className="mwl-card mwl-card--flush">
              <div className="mwl-cathead">
                <strong className="mwl-cardtitle">{t("workload.youVsChapter")}</strong>
              </div>
              {publishedKeys.map((key) => {
                const mine = latest[key] != null ? latest[key] : 0;
                const avg = avgByKey[key] || 0;
                const diff = mine - avg;
                let text;
                let mod;
                if (diff > 0) {
                  text = t("workload.above", { n: diff });
                  mod = "mwl-cmprow__delta--up";
                } else if (diff < 0) {
                  text = t("workload.below", { n: Math.abs(diff) });
                  mod = "mwl-cmprow__delta--down";
                } else {
                  text = t("workload.onPar");
                  mod = "mwl-cmprow__delta--par";
                }
                return (
                  <div key={key} className="mwl-cmprow">
                    <span className="mwl-cmprow__label">{categoryName(key)}</span>
                    <span className="mwl-cmprow__nums">{t("mwl.youVsNums", { mine, avg })}</span>
                    <span className={`mwl-cmprow__delta ${mod}`}>{text}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- Reminders tab */

const REMINDER_CADENCES = ["weekday_daily", "weekly", "biweekly", "monthly", "quarterly"];
// The zones a reminder may use: the same [IANA id, catalogue key] list that
// Settings and booking hours offer, so a person reads "Central — Chicago",
// never the stored id (UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122).
const REMINDER_TIMEZONES = BOOKING_TIME_ZONES;

// A whole hour as a clock time in the app's language ("5:00 PM"). The hour is
// a wall-clock value, not an instant, so it is formatted on a fixed reference
// day in UTC, where no daylight change can move it.
function reminderHourLabel(hour, lang) {
  return dateTimeFormat(lang, { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    .format(Date.UTC(2000, 0, 3, hour))
    .replace(/[\u202F\u00A0]/gu, " ");
}

// The next reminder as a moment in the schedule's own zone, with the zone named.
function formatReminderDueAt(value, lang, timezone) {
  try {
    return formatZoneInstant(value, lang, timezone) || null;
  } catch {
    return null;
  }
}

function RemindersTab({ t, lang, initial, onSave }) {
  const defaults = {
    available: true, enabled: false, cadence: "weekly", weekday: 1,
    localHour: 9, timezone: "America/New_York", nextDueAt: null,
  };
  const [schedule, setSchedule] = useState(() => ({ ...defaults, ...(initial || {}) }));
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [message, setMessage] = useState(null);
  // The form is seeded once, so a saved schedule that changes afterwards
  // (#7027: an undo re-reads it) replaces it; otherwise the next Save would
  // write the undone schedule back. Our own save hands back what we sent.
  const initialKey = JSON.stringify(initial || {});
  const adoptedKey = useRef(initialKey);
  useEffect(() => {
    if (initialKey === adoptedKey.current) return;
    adoptedKey.current = initialKey;
    setSchedule({ ...defaults, ...JSON.parse(initialKey) });
  }, [initialKey]); // eslint-disable-line react-hooks/exhaustive-deps -- defaults is a per-render literal

  // Every control edits through here: the saved/failed status describes the
  // schedule that was sent, so touching any field has to retire it rather than
  // leave "Schedule saved" sitting above values nobody has saved yet.
  function editSchedule(patch) {
    setSchedule((current) => ({ ...current, ...patch }));
    setMessage(null);
  }

  if (schedule.available === false) {
    return (
      <section className="mwl-body">
        <div className="mwl-card mwl-reminder" role="status">
          <strong className="mwl-cardtitle">{t("workload.remindersTitle")}</strong>
          <p>{t("workload.remindersUnavailable")}</p>
        </div>
      </section>
    );
  }

  function save() {
    return runBusyWrite(busyWriteRef, "workload", () => saveNow());
  }

  async function saveNow() {
    if (busy || !onSave) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await onSave({
        enabled: schedule.enabled,
        cadence: schedule.cadence,
        weekday: schedule.weekday,
        localHour: schedule.localHour,
        timezone: schedule.timezone,
      });
      setSchedule((current) => ({ ...current, ...result, available: true }));
      setMessage({ kind: "success", text: t("workload.remindersSaved") });
    } catch {
      setMessage({ kind: "error", text: t("workload.remindersSaveFailed") });
    } finally {
      setBusy(false);
    }
  }

  const nextDue = schedule.enabled ? formatReminderDueAt(schedule.nextDueAt, lang, schedule.timezone) : null;
  const nextDueLabel = schedule.enabled
    ? (nextDue || t("workload.remindersNextUnknown"))
    : null;

  return (
    <section className="mwl-body">
      <div className="mwl-card mwl-reminder">
        <div className="mwl-reminder__head">
          <div>
            <strong className="mwl-cardtitle">{t("workload.remindersTitle")}</strong>
            <p>{t("workload.remindersPrivacy")}</p>
          </div>
          {schedule.preview && <span className="mwl-reminder__sample">{t("workload.remindersSample")}</span>}
        </div>

        <CheckRow
          label={t("workload.remindersEnable")}
          checked={schedule.enabled}
          onChange={(enabled) => editSchedule({ enabled })}
        />
        <p className="mwl-reminder__state">{t(schedule.enabled ? "workload.remindersOn" : "workload.remindersOff")}</p>

        <div className="mwl-reminder__grid">
          <label>
            <span>{t("workload.remindersCadence")}</span>
            <select
              aria-label={t("workload.remindersCadence")}
              value={schedule.cadence}
              onChange={(event) => editSchedule({ cadence: event.target.value })}
            >
              {REMINDER_CADENCES.map((cadence) => (
                <option key={cadence} value={cadence}>{t(`workload.cadence.${cadence}`)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("workload.remindersWeekday")}</span>
            <select
              aria-label={t("workload.remindersWeekday")}
              value={schedule.weekday}
              onChange={(event) => editSchedule({ weekday: Number(event.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((weekday) => (
                <option key={weekday} value={weekday}>{t(`workload.weekday.${weekday}`)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("workload.remindersHour")}</span>
            <select
              aria-label={t("workload.remindersHour")}
              value={schedule.localHour}
              onChange={(event) => editSchedule({ localHour: Number(event.target.value) })}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>{reminderHourLabel(hour, lang)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("workload.remindersTimezone")}</span>
            <select
              aria-label={t("workload.remindersTimezone")}
              value={schedule.timezone}
              onChange={(event) => editSchedule({ timezone: event.target.value })}
            >
              {REMINDER_TIMEZONES.map(([timezone, labelKey]) => <option key={timezone} value={timezone}>{t(labelKey)}</option>)}
            </select>
          </label>
        </div>

        {nextDueLabel && <p className="mwl-reminder__due">{nextDue ? t("workload.remindersNext", { date: nextDue }) : nextDueLabel}</p>}
        {message && <p role={message.kind === "error" ? "alert" : "status"} className={`mwl-${message.kind}`}>{message.text}</p>}
        <BusyButton type="button" className="mwl-btn mwl-btn--primary" onClick={save} pending={busy} disabled={!onSave}>
          {busy ? t("workload.remindersSaving") : t("workload.remindersSave")}
        </BusyButton>
      </div>
    </section>
  );
}

/* ----------------------------------------------------- small building blocks */

function Stepper({ label, value, onChange, min = 0, max = 300, suffix, inline }) {
  const { t } = useLang();
  return (
    <div role="group" aria-label={label} className={inline ? "mwl-step mwl-step--inline" : "mwl-step"}>
      {!inline && <span className="mwl-step__label">{label}</span>}
      {/* Both buttons used to answer to the field's own name, so a screen
          reader announced "Priority, button" twice with nothing to tell minus
          from plus. The group keeps `label`; the buttons say what they DO
          to it. */}
      <button
        type="button"
        className="mwl-stepbtn"
        aria-label={t("workload.stepper.decrease", { label })}
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
      >
        −
      </button>
      {/* No aria-live here: ten steppers meant ten live regions competing on
          one screen, and the value is already inside the group these buttons
          name, so a press re-announces it without one. */}
      <span className="mwl-stepval">
        {value}
        {suffix ? <small>{suffix}</small> : null}
      </span>
      <button
        type="button"
        className="mwl-stepbtn"
        aria-label={t("workload.stepper.increase", { label })}
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
      >
        +
      </button>
    </div>
  );
}

// Prototype 18px checkbox rows (wlChk). The whole row is the hit target so the
// visual box can stay prototype-small without dropping under the tap floor.
// Nested controls (the OT stepper) must live OUTSIDE the row button.
function CheckRow({ label, hint, checked, onChange, children }) {
  return (
    <div className="mwl-checkline">
      <button type="button" className="mwl-checkrow" aria-pressed={checked} onClick={() => onChange(!checked)}>
        <span className="mwl-checkbox" aria-hidden="true">
          {checked ? "✓" : ""}
        </span>
        <span className="mwl-checkrow__label">{label}</span>
        {hint && <span className="mwl-checkrow__hint">{hint}</span>}
      </button>
      {checked && children}
    </div>
  );
}

function StatTile({ label, value }) {
  return (
    <article className="mwl-card mwl-tile">
      <span className="mwl-eyebrow mwl-eyebrow--tight">{label}</span>
      <strong className="mwl-tile__val"><FlowValue value={value} /></strong>
    </article>
  );
}

/* ------------------------------------------------------------------- helpers */

function countSummary(t, counts, shownKeys) {
  const source = counts || {};
  return shownKeys.map((key) => `${t(`workload.cat.${key}`)} ${source[key] ?? "—"}`).join(" · ");
}

function csvCell(value) {
  const str = String(value == null ? "" : value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
