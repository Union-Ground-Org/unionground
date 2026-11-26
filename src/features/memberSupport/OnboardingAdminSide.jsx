import { useId, useMemo, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { dateTimeFormat } from "../../lib/i18n.js";
import { OnboardingHud } from "../../components/OnboardingHud.jsx";
import { ChartArrival, arriveAt } from "../../components/ChartArrival.jsx";
import { GUIDE_SWITCHES } from "../onboardingGuideEngine/memberServer.js";
import { ONBOARDING_SKIP_REASON_MAX } from "./onboardingOversight.js";
import {
  PROGRESS_FILTERS,
  applyStepMove,
  chapterProgressRows,
  filterProgressMembers,
  memberPreview,
  onboardingProgressSummary,
  onboardingReminderFailure,
  onboardingReminderState,
  previewStages,
  programInOrder,
  programSummary,
  progressFilterCounts,
  skipReasonProblem,
  stepMove,
} from "../onboardingGuideEngine/adminSide.js";
import "./onboarding-admin-side.css";
import "../../lib/i18n/features/onboardingAdminStrings.js";
import { BusyButton } from "../../components/BusyControls.jsx";

// REQ-UG-LOVABLE-ADMIN-ONBOARDING-BATCH-D-GAP-20261103: the
// organization side of member onboarding from the Batch D prototype, on the
// member-support desk's staff disclosure. Onboarding setup edits, orders and
// turns steps on and off through save_organization_onboarding_step; Preview as
// member is client only and shows no member's data; the Member progress totals
// count the oversight rows the server already returned. Decisions live in
// ../onboardingGuideEngine/adminSide.js; copy in src/lib/i18n/onboardingAdmin.js.
// REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: by-chapter counts
// from the server's floored summary, a reason on every skip, and one reminder
// a day to a stalled member.

const SWITCH_LABEL = (key) => `settings.def.${key}.label`;

function plural(t, base, n, params) {
  return t(`${base}.${n === 1 ? "one" : "other"}`, params);
}

function SetupStepRow({ step, index, program, actor, adapter, busy, commit, viewCopy }) {
  const { t } = useLang();
  const [editing, setEditing] = useState(false);
  const up = stepMove(program, step.id, "up");
  const down = stepMove(program, step.id, "down");
  const reason = (move) => (move.ok ? null : t(`onboardingAdmin.setup.${move.reason === "missing" ? "full" : move.reason}`));
  // BUG-UG-ONBOARDING-STEP-REORDER-PARTIAL-SAVE-20261104: a move is
  // three saves; a failure after the first puts the old order back, and the
  // desk reloads either way so it never shows an order members don't have.
  const move = (plan) => commit(
    () => applyStepMove(plan, (write) => adapter.saveOnboardingStep(actor, write)),
    t("onboardingAdmin.setup.moved"),
    null,
    {
      reloadOnFailure: true,
      failureText: (error) => (error?.code === "ONBOARDING_STEP_MOVE_FAILED"
        ? t(error.restored ? "onboardingAdmin.setup.moveFailed" : "onboardingAdmin.setup.moveFailedUnrestored")
        : null),
    },
  );
  const reasonId = `onboarding-admin-step-${step.id}-reason`;
  const reasons = [reason(up), reason(down)].filter(Boolean);
  return <li className="member-support-card onboarding-admin-step">
    <div className="member-support-card__heading">
      <span className="onboarding-admin-step__number" aria-label={t("onboardingAdmin.setup.stepNumber", { n: index + 1 })}>{index + 1}</span>
      <strong>{step.title}</strong>
      <span className="member-support-status">{step.active ? viewCopy.stepActive : viewCopy.stepInactive}</span>
    </div>
    {step.description && <small className="member-support-muted">{step.description}</small>}
    {editing && <form className="member-support-form" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      commit(() => adapter.saveOnboardingStep(actor, { stepId: step.id, title: data.get("title"), description: data.get("description"), position: step.position, active: step.active }), viewCopy.stepSaved, () => setEditing(false));
    }}>
      <label className="member-support-field"><span>{viewCopy.stepTitle}</span><input name="title" required maxLength={160} defaultValue={step.title} /></label>
      <label className="member-support-field"><span>{viewCopy.description}</span><textarea name="description" maxLength={2000} defaultValue={step.description} /></label>
      <div className="member-support-inline">
        <BusyButton pending={busy} className="member-support-button" type="submit">{t("onboardingAdmin.setup.save")}</BusyButton>
        <button className="member-support-button member-support-button--secondary" type="button" onClick={() => setEditing(false)}>{t("onboardingAdmin.setup.cancel")}</button>
      </div>
    </form>}
    <div className="member-support-inline">
      {!editing && <BusyButton pending={busy} className="member-support-button member-support-button--secondary" type="button" aria-label={t("onboardingAdmin.setup.editName", { title: step.title })} onClick={() => setEditing(true)}>{t("onboardingAdmin.setup.edit")}</BusyButton>}
      <BusyButton pending={busy} disabled={!up.ok} className="member-support-button member-support-button--secondary" type="button" aria-label={t("onboardingAdmin.setup.moveUpName", { title: step.title })} aria-describedby={up.ok ? undefined : reasonId} onClick={() => up.ok && move(up)}>{t("onboardingAdmin.setup.moveUp")}</BusyButton>
      <BusyButton pending={busy} disabled={!down.ok} className="member-support-button member-support-button--secondary" type="button" aria-label={t("onboardingAdmin.setup.moveDownName", { title: step.title })} aria-describedby={down.ok ? undefined : reasonId} onClick={() => down.ok && move(down)}>{t("onboardingAdmin.setup.moveDown")}</BusyButton>
      {/* Inventory A4: staff turn an existing step off and on. */}
      <BusyButton pending={busy} className="member-support-button" type="button" aria-label={(step.active ? viewCopy.deactivateStepName : viewCopy.activateStepName).replace("{title}", step.title)} onClick={() => commit(() => adapter.saveOnboardingStep(actor, { stepId: step.id, title: step.title, description: step.description, position: step.position, active: !step.active }), step.active ? viewCopy.stepDeactivated : viewCopy.stepActivated)}>{step.active ? viewCopy.deactivateStep : viewCopy.activateStep}</BusyButton>
    </div>
    {reasons.length > 0 && <small id={reasonId} className="member-support-muted">{reasons.join(" ")}</small>}
  </li>;
}

function GuideSwitchList({ guideSwitches }) {
  const { t } = useLang();
  if (!guideSwitches || typeof guideSwitches !== "object") return <p className="member-support-muted">{t("onboardingAdmin.setup.switchesUnknown")}</p>;
  return <ul className="onboarding-admin-switches">
    {GUIDE_SWITCHES.map(({ key }) => {
      const on = guideSwitches[key] === true;
      return <li key={key}><span>{t(SWITCH_LABEL(key))}</span><span className={`onboarding-admin-chip${on ? " onboarding-admin-chip--on" : ""}`}>{t(on ? "onboardingAdmin.on" : "onboardingAdmin.off")}</span></li>;
    })}
  </ul>;
}

/** Onboarding setup: the organization's whole step list, in order, plus the add-step form (children). */
export function OnboardingSetupSection({ program, actor, adapter, busy, commit, viewCopy, guideSwitches = null, children = null }) {
  const { t } = useLang();
  const ordered = programInOrder(program);
  const summary = programSummary(program);
  const summaryText = summary.active === 0 ? t("onboardingAdmin.setup.summary.none")
    : summary.momentum !== null ? t("onboardingAdmin.setup.summary.momentum", { n: summary.active, m: summary.momentum })
      : plural(t, "onboardingAdmin.setup.summary.short", summary.active, { n: summary.active });
  return <section className="onboarding-admin-section" aria-labelledby="onboarding-admin-setup-title">
    <h3 id="onboarding-admin-setup-title">{t("onboardingAdmin.setup.title")}</h3>
    <p className="member-support-muted">{t("onboardingAdmin.setup.intro")}</p>
    {ordered.length > 0 && <><h4>{viewCopy.programSteps}</h4><ol className="member-support-list onboarding-admin-steps">{ordered.map((step, index) => <SetupStepRow key={step.id} {...{ step, index, program: ordered, actor, adapter, busy, commit, viewCopy }} />)}</ol></>}
    <p className="onboarding-admin-summary">{summaryText}</p>
    {children}
    <h4>{t("onboardingAdmin.setup.switchesTitle")}</h4>
    <GuideSwitchList guideSwitches={guideSwitches} />
    <p className="member-support-muted">{t("onboardingAdmin.setup.switchesNote")}</p>
  </section>;
}

const PREVIEW_PLACE = { memberSupport: "onboardingAdmin.preview.place.memberSupport", events: "onboardingAdmin.preview.place.events" };

/** Preview as member: client only, from the organization's own steps and switches. */
export function MemberGuidePreview({ program, guideSwitches = null, now = null }) {
  const { t } = useLang();
  const stages = previewStages(program);
  const [picked, setPicked] = useState("welcome");
  const [opened, setOpened] = useState(null);
  const stage = stages.includes(picked) ? picked : "welcome";
  const clock = now ?? Date.now();
  const view = useMemo(() => memberPreview({ steps: program, switches: guideSwitches, stage, now: clock }), [program, guideSwitches, stage, clock]);
  const activateMissing = !stages.includes("activate");
  return <section className="onboarding-admin-section" aria-labelledby="onboarding-admin-preview-title">
    <h3 id="onboarding-admin-preview-title">{t("onboardingAdmin.preview.title")}</h3>
    <p className="onboarding-admin-notice">{t("onboardingAdmin.preview.notice")}</p>
    <p className="member-support-muted">{t("onboardingAdmin.preview.source")}</p>
    <div className="onboarding-admin-stages" role="group" aria-label={t("onboardingAdmin.preview.stage")}>
      {["welcome", "activate", "complete"].map((item) => <button key={item} type="button" className="member-support-goal onboarding-admin-stage" aria-pressed={stage === item} disabled={!stages.includes(item)} aria-describedby={item === "activate" && activateMissing ? "onboarding-admin-activate-needs" : undefined} onClick={() => { setPicked(item); setOpened(null); }}>{t(`onboardingAdmin.preview.stage.${item}`)}</button>)}
    </div>
    {activateMissing && view.total > 0 && <small id="onboarding-admin-activate-needs" className="member-support-muted">{t("onboardingAdmin.preview.activateNeeds")}</small>}
    <div className="onboarding-admin-preview" role="group" aria-label={t("onboardingAdmin.preview.frame")}>
      <p className="member-support-eyebrow">{t("onboardingAdmin.preview.frame")}</p>
      {view.card
        ? <OnboardingHud key={stage} card={view.card} memberId={null} onNavigate={(target) => setOpened(target)} />
        : <p className="member-support-muted">{t(`onboardingAdmin.preview.${view.reason ?? "noCard"}`)}</p>}
      {opened && <p role="status" className="member-support-muted">{t("onboardingAdmin.preview.opens", { place: t(PREVIEW_PLACE[opened] ?? PREVIEW_PLACE.memberSupport) })}</p>}
      {view.steps.length > 0 && <><h4>{t("onboardingAdmin.preview.stepsTitle")}</h4><ol className="onboarding-admin-preview__steps">
        {view.steps.map((step) => <li key={step.id} data-state={step.state}><span>{step.title}</span><span className={`onboarding-admin-chip${step.state === "done" ? " onboarding-admin-chip--on" : step.state === "next" ? " onboarding-admin-chip--next" : ""}`}>{t(`onboardingAdmin.preview.state.${step.state}`)}</span></li>)}
      </ol></>}
    </div>
  </section>;
}

/** Member progress totals and step-by-step counts, above the roster. */
export function OnboardingProgressSummary({ oversight }) {
  const { t } = useLang();
  const summary = onboardingProgressSummary(oversight);
  if (summary.counted === 0) return <p className="member-support-muted">{t("onboardingAdmin.progress.empty")}</p>;
  if (summary.withheld) return <p className="member-support-muted">{t("onboardingAdmin.progress.withheld", { floor: summary.floor, count: summary.counted })}</p>;
  if (summary.partial) return <p className="member-support-muted">{t("onboardingAdmin.progress.partial")}</p>;
  const tiles = [
    ["enrolled", summary.tiles.enrolled],
    ["notStarted", summary.tiles.notStarted],
    ["inProgress", summary.tiles.inProgress],
    ["completed", summary.tiles.completed],
    ...(summary.tiles.stalled === null ? [] : [["stalled", summary.tiles.stalled]]),
  ];
  return <div className="onboarding-admin-summary-block">
    <h4>{t("onboardingAdmin.progress.summaryTitle")}</h4>
    <dl className="onboarding-admin-tiles">
      {tiles.map(([key, value]) => <div key={key} className="onboarding-admin-tile"><dt>{t(`onboardingAdmin.progress.tile.${key}`)}</dt><dd>{value}</dd></div>)}
    </dl>
    {summary.steps.length > 0 && <>
      <h4>{t("onboardingAdmin.progress.stopsTitle")}</h4>
      <ChartArrival as="ol" name="onboarding-admin:stops" className="onboarding-admin-stops">
        {summary.steps.map((step, index) => <li key={step.id}>
          <span>{t("onboardingAdmin.progress.stepLine", { title: step.title, done: step.done, total: summary.counted, percent: step.percent })}</span>
          <span className="onboarding-admin-bar" aria-hidden="true"><span className="arrive-x" style={arriveAt(index, { width: `${step.percent}%` })} /></span>
        </li>)}
      </ChartArrival>
      {summary.biggestDrop && <p>{plural(t, "onboardingAdmin.progress.biggestDrop", summary.biggestDrop.people, summary.biggestDrop)}</p>}
    </>}
  </div>;
}

/** The roster's filter chips and "Find a member"; renders the filtered rows through `renderRow`. */
export function OnboardingProgressPeople({ members, memberCount = members.length, stalledFlag = false, renderRow }) {
  const { t } = useLang();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const counts = progressFilterCounts(members);
  // Chip counts are totals too: they follow the summary's floor and cap.
  const showCounts = onboardingProgressSummary({ members, memberCount }).tiles !== null;
  const rows = filterProgressMembers(members, { filter, query });
  if (members.length === 0) return null;
  return <div className="onboarding-admin-people">
    <h4>{t("onboardingAdmin.progress.peopleTitle")}</h4>
    <div className="onboarding-admin-stages" role="group" aria-label={t("onboardingAdmin.progress.filterGroup")}>
      {PROGRESS_FILTERS.filter((item) => stalledFlag || item !== "stalled").map((item) => <button key={item} type="button" className="member-support-goal onboarding-admin-stage" aria-pressed={filter === item} onClick={() => setFilter(item)}>{showCounts ? t(`onboardingAdmin.progress.filter.${item}`, { n: counts[item] }) : t(`onboardingAdmin.progress.filterName.${item}`)}</button>)}
    </div>
    <label className="member-support-field"><span>{t("onboardingAdmin.progress.find")}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    {rows.length === 0 ? <p className="member-support-muted" role="status">{t("onboardingAdmin.progress.noMatch")}</p> : rows.map(renderRow)}
  </div>;
}

function chapterLine(t, row) {
  const line = t("onboardingAdmin.chapters.line", { enrolled: row.enrolled, completed: row.completed, inProgress: row.inProgress, notStarted: row.notStarted });
  return row.stalled === null ? line : `${line} · ${t("onboardingAdmin.chapters.stalled", { n: row.stalled })}`;
}

/** By chapter: only what the server returned at or above its floor. */
export function OnboardingChapterProgress({ oversight }) {
  const { t } = useLang();
  const view = chapterProgressRows(oversight?.chapterSummary);
  if (!view || (oversight?.members?.length ?? 0) === 0) return null;
  const rows = view.other ? [...view.rows, view.other] : view.rows;
  return <div className="onboarding-admin-summary-block">
    <h4>{t("onboardingAdmin.chapters.title")}</h4>
    {view.withheld || rows.length === 0
      ? <p className="member-support-muted">{t("onboardingAdmin.chapters.withheld", { floor: view.floor })}</p>
      : <>
        <ChartArrival as="ul" name="onboarding-admin:chapters" className="onboarding-admin-stops onboarding-admin-chapters">
          {rows.map((row, index) => <li key={row.key}>
            <span><strong>{row.name ?? t("onboardingAdmin.chapters.other")}</strong> {chapterLine(t, row)}</span>
            <span className="onboarding-admin-bar" aria-hidden="true"><span className="arrive-x" style={arriveAt(index, { width: `${row.completedPercent}%` })} /></span>
          </li>)}
        </ChartArrival>
        {view.pooledChapters > 0 && <p className="member-support-muted">{plural(t, "onboardingAdmin.chapters.pooled", view.pooledChapters, { n: view.pooledChapters, floor: view.floor })}</p>}
        <p className="member-support-muted">{t("onboardingAdmin.chapters.floorNote", { floor: view.floor })}</p>
      </>}
  </div>;
}

/** The reason form a skip needs before it is sent. */
export function SkipStepForm({ stepTitle, busy, onSubmit, onCancel }) {
  const { t } = useLang();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState(null);
  const id = useId();
  return <form className="member-support-form onboarding-admin-skip" onSubmit={(event) => {
    event.preventDefault();
    const found = skipReasonProblem(reason);
    setProblem(found);
    if (!found) onSubmit(reason.trim());
  }}>
    <label className="member-support-field" htmlFor={`${id}-reason`}><span>{t("onboardingAdmin.skip.reasonLabel", { title: stepTitle })}</span></label>
    <textarea id={`${id}-reason`} required maxLength={ONBOARDING_SKIP_REASON_MAX} value={reason} aria-describedby={`${id}-hint`} aria-invalid={problem ? true : undefined} onChange={(event) => setReason(event.target.value)} />
    <small id={`${id}-hint`} className="member-support-muted">{problem ? t(`onboardingAdmin.skip.${problem}`) : t("onboardingAdmin.skip.reasonHint", { max: ONBOARDING_SKIP_REASON_MAX })}</small>
    <div className="member-support-inline">
      <BusyButton pending={busy} className="member-support-button" type="submit">{t("onboardingAdmin.skip.confirm")}</BusyButton>
      <button className="member-support-button member-support-button--secondary" type="button" onClick={onCancel}>{t("onboardingAdmin.skip.cancel")}</button>
    </div>
  </form>;
}

function reminderTime(value, lang) {
  return dateTimeFormat(lang, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

/** One roster row's skip reasons (read-only) and its reminder control. */
export function OnboardingRowFollowUp({ row, oversight, actor, adapter, busy, commit, now = null }) {
  const { t, lang } = useLang();
  const titles = new Map((oversight?.steps ?? []).map((step) => [step.id, step.title]));
  const skipped = (row.skippedSteps ?? []).filter((skip) => titles.has(skip.stepId));
  const reminder = onboardingReminderState(row, now ?? Date.now());
  const note = reminder.state === "optedOut" ? t("onboardingAdmin.remind.optedOut")
    : reminder.state === "sentToday" ? t("onboardingAdmin.remind.sentToday", { time: reminderTime(reminder.nextAt, lang) })
      : null;
  const send = () => commit(
    () => adapter.sendOnboardingReminder(actor, row.planId),
    t("onboardingAdmin.remind.sent"),
    null,
    {
      reloadOnFailure: true,
      failureText: (error) => {
        const reason = onboardingReminderFailure(error);
        return reason ? t(`onboardingAdmin.remind.${reason}`) : null;
      },
    },
  );
  if (skipped.length === 0 && reminder.state === "notStalled") return null;
  return <div className="onboarding-admin-follow-up">
    {skipped.length > 0 && <>
      <p className="member-support-eyebrow">{t("onboardingAdmin.skip.listTitle")}</p>
      <ul className="onboarding-admin-skips">
        {skipped.map((skip) => <li key={skip.stepId}><strong>{titles.get(skip.stepId)}</strong>: {skip.reason}</li>)}
      </ul>
    </>}
    {reminder.state !== "notStalled" && <div className="member-support-inline">
      <BusyButton type="button" className="member-support-button member-support-button--secondary" pending={busy} disabled={reminder.state !== "ready"} aria-label={t("onboardingAdmin.remind.sendName", { name: row.memberLabel })} aria-describedby={note ? `onboarding-admin-remind-${row.planId}` : undefined} onClick={send}>{t("onboardingAdmin.remind.send")}</BusyButton>
      {note ? <small id={`onboarding-admin-remind-${row.planId}`} className="member-support-muted">{note}</small> : <small className="member-support-muted">{t("onboardingAdmin.remind.note")}</small>}
    </div>}
  </div>;
}
