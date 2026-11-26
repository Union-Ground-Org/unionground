import { useEffect, useRef, useState } from "react";
import { DatabaseZap, ShieldCheck } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { dateTimeFormat } from "../../lib/i18n.js";
import { PLANE_CARD_CLASS } from "../../lib/staffPlaneStyles.js";
import { PLATFORM_ENFORCED_RETENTION_CLASSES } from "./platformPurges.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { WorkspaceCardTitle } from "../../components/WorkspacePages.jsx";

function dateTimeLabel(value, lang) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return dateTimeFormat(lang, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function expiryTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

// Presentation only: private.perform_organization_retention_run rechecks
// authorization_expires_at and remains the boundary that refuses a lapsed run.
// This clock exists so the panel stops claiming a window it no longer holds —
// nothing else in this card ticks, so it re-renders once per authorized window,
// as that window closes. A deadline that is already past against a stale `now`
// schedules a zero-delay wake instead of being read as still open.
function useWindowClock(deadlines) {
  const [now, setNow] = useState(() => Date.now());
  const next = Math.min(...deadlines.filter((deadline) => deadline > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(next - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [next]);
  return now;
}

function authorizedDeadlines(rows) {
  return rows
    .filter((row) => row?.status === "authorized")
    .map((row) => expiryTimestamp(row.authorizationExpiresAt))
    .filter((deadline) => deadline !== null);
}

function initialDrafts(policies) {
  return Object.fromEntries((policies || []).map((policy) => [policy.dataClass, {
    retentionDays: String(policy.retentionDays),
    executionEnabled: policy.executionEnabled === true,
    enableConfirmation: "",
  }]));
}

function serverPolicySeed(policy) {
  return {
    retentionDays: String(policy.retentionDays),
    executionEnabled: policy.executionEnabled === true,
  };
}

function policySeedsByClass(policies) {
  return Object.fromEntries((policies || []).map((policy) => [policy.dataClass, serverPolicySeed(policy)]));
}

function sameServerSeed(left, right) {
  return Boolean(left)
    && Boolean(right)
    && left.retentionDays === right.retentionDays
    && left.executionEnabled === right.executionEnabled;
}

function reconcileDraft(existing, prior, incoming) {
  const daysUnchanged = Boolean(prior) && prior.retentionDays === incoming.retentionDays;
  const executionUnchanged = Boolean(prior) && prior.executionEnabled === incoming.executionEnabled;
  return {
    retentionDays: daysUnchanged && existing ? existing.retentionDays : incoming.retentionDays,
    executionEnabled: executionUnchanged && existing ? existing.executionEnabled : incoming.executionEnabled,
    enableConfirmation: executionUnchanged && existing ? existing.enableConfirmation : "",
  };
}

const EMPTY_POLICIES = Object.freeze([]);

// A run the server refused still resolves: the notice names the outcome and
// states that nothing was deleted, and an unknown status or failureCode falls
// back to a generic refusal — never a success string. The operation matters
// for an expired window: authorize refusing {status: "expired"} means the
// preview window lapsed before authorization, while execute refusing it means
// authorization succeeded and the 15-minute execution window lapsed instead.
function refusedNoticeKey(run, operation) {
  if (run?.status === "expired") {
    return operation === "execute"
      ? "admin.retention.refused.executionExpired"
      : "admin.retention.refused.expired";
  }
  if (run?.status === "failed") {
    if (run.failureCode === "execution_disabled") return "admin.retention.refused.executionDisabled";
    if (run.failureCode === "policy_changed") return "admin.retention.refused.policyChanged";
    if (run.failureCode === "execution_failed") return "admin.retention.refused.executionFailed";
  }
  return "admin.retention.refused.unknown";
}

// "Failed safely" and "Expired" name the outcome but not the cause, and the
// server already records one in organization_retention_runs.failure_code. An
// `expired` run reaches that status only by outliving its window, and the
// authorize/execute RPCs answer such a refusal with the status alone, so an
// expired run without a code still names the window instead of reading as an
// unrecognized reason.
const RUN_FAILURE_CAUSES = new Set([
  "authorization_expired",
  "execution_disabled",
  "policy_changed",
  "execution_failed",
]);

function runCauseKey(run) {
  if (run.status !== "failed" && run.status !== "expired") return "";
  if (RUN_FAILURE_CAUSES.has(run.failureCode)) return `admin.retention.cause.${run.failureCode}`;
  return run.status === "expired"
    ? "admin.retention.cause.authorization_expired"
    : "admin.retention.cause.unknown";
}

function RunStatus({ run, t, lang, now, live = false }) {
  if (!run) return null;
  const deadline = run.status === "authorized" ? expiryTimestamp(run.authorizationExpiresAt) : null;
  const causeKey = runCauseKey(run);
  // History reuses this markup. `live` is the current dry run only.
  return <div
    className="retention-run"
    role={live ? "status" : undefined}
    aria-live={live ? "polite" : undefined}
  >
    <div>
      <strong>{t(`admin.retention.runStatus.${run.status}`)}</strong>
      <p className="xus-note">
        {t("admin.retention.runCounts", {
          eligible: run.eligibleCount ?? 0,
          deleted: run.deletedCount ?? 0,
          remaining: run.remainingCount ?? 0,
        })}
      </p>
      {deadline !== null && <p className={`xus-note${deadline <= now ? " xus-note--error" : ""}`}>
        {t(
          deadline <= now ? "admin.retention.windowLapsed" : "admin.retention.windowDeadline",
          { deadline: dateTimeLabel(run.authorizationExpiresAt, lang) },
        )}
      </p>}
      {causeKey !== "" && <p className="xus-note xus-note--error">{t(causeKey)}</p>}
    </div>
    {(run.createdAt || run.completedAt) && <small className="xus-meta">
      {dateTimeLabel(run.completedAt || run.createdAt, lang)}
    </small>}
  </div>;
}

// The four reasons loadAdminDesk can give for a null engine. An unexpected or
// absent reason keeps the original unknown-state sentence rather than inventing
// a cause the desk did not report.
const UNAVAILABLE_REASONS = new Set([
  "missingConfiguration",
  "notPermitted",
  "readFailed",
  "unrecognizedPayload",
]);

function unavailableNoticeKey(reason) {
  return UNAVAILABLE_REASONS.has(reason)
    ? `admin.retention.unavailableWhy.${reason}`
    : "admin.retention.unavailable";
}

export function RetentionEnginePanel({ engine, unavailableReason = null, api, reload, onNotice }) {
  const { t, lang } = useLang();
  const policies = engine?.policies ?? EMPTY_POLICIES;
  const [drafts, setDrafts] = useState(() => initialDrafts(policies));
  const [preview, setPreview] = useState(null);
  const [runConfirmation, setRunConfirmation] = useState("");
  const [busy, setBusy] = useState("");
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const organizationId = engine?.organizationId ?? null;
  const previousServerSnapshot = useRef(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  // Every authorized row the panel shows — the live preview and the history —
  // needs the clock, so the deadline it prints stops being a promise the moment
  // the window closes.
  const now = useWindowClock(authorizedDeadlines([preview, ...(engine?.runs || [])]));
  const [previewDeadline] = authorizedDeadlines([preview]);
  const executionWindowLapsed = previewDeadline !== undefined && previewDeadline <= now;

  // The reset below is a passive effect, so React commits — and the browser
  // paints — one frame for a newly selected organization in which `drafts`,
  // `preview` and the typed phrases still belong to the previous one while
  // `api` already targets the new one. `ENABLE <dataClass>` is tenant-agnostic,
  // so that frame can show an enabled "Save rule". Compare the rendered
  // organization against the last committed snapshot during render and suppress
  // every action until the reset lands, so a click in that frame cannot save or
  // delete one tenant's values against another.
  const staleOrganization = engine !== null
    && previousServerSnapshot.current !== null
    && previousServerSnapshot.current.organizationId !== organizationId;

  useEffect(() => {
    // loadAdminDesk soft-fails get_organization_retention_engine to null while
    // AdminView stays mounted. That is an unavailable read, not an org switch:
    // keep the last authoritative snapshot so a sibling-card reload cannot
    // discard a locally held preview or typed AUTHORIZE phrase.
    if (engine === null) {
      return;
    }
    const nextSeeds = policySeedsByClass(policies);
    const nextSnapshot = { organizationId, seeds: nextSeeds };
    const previous = previousServerSnapshot.current;
    if (previous === null) {
      previousServerSnapshot.current = nextSnapshot;
      setDrafts((current) => (
        Object.keys(current).length > 0 ? current : initialDrafts(policies)
      ));
      return;
    }
    if (previous.organizationId !== organizationId) {
      previousServerSnapshot.current = nextSnapshot;
      setDrafts(initialDrafts(policies));
      setPreview(null);
      setRunConfirmation("");
      return;
    }
    const previousSeeds = previous.seeds;
    const keys = Object.keys(nextSeeds);
    const seedsUnchanged = keys.length === Object.keys(previousSeeds).length
      && keys.every((key) => sameServerSeed(previousSeeds[key], nextSeeds[key]));
    if (seedsUnchanged) return;

    setDrafts((current) => Object.fromEntries(keys.map((key) => [
      key,
      reconcileDraft(current[key], previousSeeds[key], nextSeeds[key]),
    ])));

    setRunConfirmation((typed) => {
      if (!typed) return typed;
      const owner = previewRef.current?.dataClass;
      if (!owner || !nextSeeds[owner]) return "";
      const prior = previousSeeds[owner];
      if (prior && prior.executionEnabled !== nextSeeds[owner].executionEnabled) return "";
      return typed;
    });

    previousServerSnapshot.current = nextSnapshot;
  }, [engine, organizationId, policies]);

  function act(key, work, notice) {
    return runBusyWrite(busyWriteRef, "retention", () => actNow(key, work, notice));
  }

  async function actNow(key, work, notice) {
    if (busy || staleOrganization) return null;
    setBusy(key);
    setError("");
    try {
      const result = await work();
      // The server refuses a run without throwing: authorize answers
      // {status: "expired"} and execute answers {status: "expired"} or
      // {status: "failed", failureCode}. The notice resolver picks the copy
      // from the actual result so a refused run never reads as a success.
      const noticeKey = typeof notice === "function" ? notice(result) : notice;
      if (noticeKey) onNotice(t(noticeKey));
      return result;
    } catch {
      setError(t("admin.retention.error"));
      return null;
    } finally {
      setBusy("");
    }
  }

  async function save(policy) {
    const draft = drafts[policy.dataClass];
    const retentionDays = Number(draft?.retentionDays);
    const result = await act(`save:${policy.dataClass}`, () => api.saveRetentionPolicy({
      dataClass: policy.dataClass,
      retentionDays,
      executionEnabled: draft.executionEnabled,
      confirmation: draft.executionEnabled && !policy.executionEnabled
        ? draft.enableConfirmation.trim()
        : null,
    }), "admin.retention.saved");
    if (result) reload();
  }

  async function createPreview(policy) {
    const result = await act(`preview:${policy.dataClass}`, () => api.previewRetentionRun(policy.dataClass));
    if (result) {
      setPreview(result);
      setRunConfirmation("");
    }
  }

  async function authorizePreview() {
    const result = await act("authorize", () => api.authorizeRetentionRun(
      preview.id,
      runConfirmation.trim(),
    ), (run) => (run?.status === "authorized"
      ? "admin.retention.authorized"
      : refusedNoticeKey(run, "authorize")));
    if (result) setPreview((current) => ({ ...current, ...result }));
  }

  async function executePreview() {
    const result = await act("execute", () => api.executeRetentionRun(preview.id), (run) => (run?.status === "completed"
      ? "admin.retention.executed"
      : refusedNoticeKey(run, "execute")));
    if (result) {
      setPreview((current) => ({ ...current, ...result }));
      reload();
    }
  }

  return <article id="admin-retention-engine" className={`${PLANE_CARD_CLASS} xus-card role-section-target retention-engine`} tabIndex="-1">
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><DatabaseZap size={18} /></span>
      <div className="xus-cardhead__copy">
        <WorkspaceCardTitle outline className="xus-cardttl">{t("admin.retention.title")}</WorkspaceCardTitle>
        <p className="xus-cardsub">{t("admin.retention.sub")}</p>
      </div>
      {engine && <span className={`xus-chip ${engine.schedulerConfigured ? "xus-chip--on" : "xus-chip--note"}`}>
        {t(engine.schedulerConfigured ? "admin.retention.schedulerOn" : "admin.retention.schedulerOff")}
      </span>}
    </header>

    {engine === null ? <div className="xus-cardbody xus-inline">
      {/* Every branch here withholds the deletion control: the whole policy
          list, preview and execute markup lives in the other half of this
          ternary. What changes is that the notice now names the cause
          (BUG-UG-RETENTION-ENGINE-STATE-UNKNOWN-FOR-ADMIN-20261009). */}
      <p className="xus-note">{t(unavailableNoticeKey(unavailableReason))}</p>
      <button type="button" className="xus-btn" onClick={reload}>{t("app.tryAgain")}</button>
    </div> : <>
      <div className="xus-cardbody retention-safety">
        <ShieldCheck size={18} aria-hidden="true" />
        <p className="xus-note">{t("admin.retention.safety")}</p>
      </div>
      {error && <div className="xus-cardbody xus-cardbody--divided">
        <p className="xus-note xus-note--error" role="alert">{error}</p>
      </div>}

      <div className="retention-policy-list">
        {policies.map((policy) => {
          // A global platform cron already deletes this class at its fixed
          // window whatever the policy says, so an execution toggle here would
          // control nothing: show the class read-only and say who deletes it.
          if (Object.hasOwn(PLATFORM_ENFORCED_RETENTION_CLASSES, policy.dataClass)) {
            return <section className="retention-policy" key={policy.dataClass} aria-labelledby={`retention-${policy.dataClass}`}>
              <div className="retention-policy__head">
                <div>
                  <h3 id={`retention-${policy.dataClass}`} className="xus-name">
                    {t(`admin.retention.class.${policy.dataClass}`)}
                  </h3>
                  <code className="xus-meta">{policy.dataClass}</code>
                </div>
                <span className="xus-chip xus-chip--note">{t("admin.retention.platformEnforced")}</span>
              </div>
              <p className="xus-note">{t(`admin.retention.description.${policy.dataClass}`)}</p>
              <p className="xus-note">{t("admin.retention.platformPurge", { days: policy.maximumDays })}</p>
            </section>;
          }
          const draft = drafts[policy.dataClass] || {
            retentionDays: String(policy.retentionDays), executionEnabled: false, enableConfirmation: "",
          };
          const days = Number(draft.retentionDays);
          const daysValid = Number.isSafeInteger(days)
            && days >= policy.minimumDays
            && days <= policy.maximumDays;
          const enabling = draft.executionEnabled && !policy.executionEnabled;
          const enablePhrase = `ENABLE ${policy.dataClass}`;
          const confirmationValid = !enabling || draft.enableConfirmation.trim() === enablePhrase;
          const dirty = days !== policy.retentionDays
            || draft.executionEnabled !== policy.executionEnabled;
          return <section className="retention-policy" key={policy.dataClass} aria-labelledby={`retention-${policy.dataClass}`}>
            <div className="retention-policy__head">
              <div>
                <h3 id={`retention-${policy.dataClass}`} className="xus-name">
                  {t(`admin.retention.class.${policy.dataClass}`)}
                </h3>
                <code className="xus-meta">{policy.dataClass}</code>
              </div>
              <span className={`xus-chip ${policy.executionEnabled ? "xus-chip--on" : "xus-chip--off"}`}>
                {t(policy.executionEnabled
                  ? (policy.configured ? "admin.retention.enabled" : "admin.retention.onByDefault")
                  : "admin.retention.observeOnly")}
              </span>
            </div>
            <p className="xus-note">{t(`admin.retention.description.${policy.dataClass}`)}</p>
            {/* Policies are visible before configuration; execution requires explicit admin enablement. */}
            {!policy.configured && <p className="xus-note">
              {t("admin.retention.defaultPolicy", { days: policy.defaultDays })}
            </p>}
            <div className="retention-policy__controls">
              <label className="xus-field">
                {t("admin.retention.days", { minimum: policy.minimumDays, maximum: policy.maximumDays })}
                <input
                  className="xus-input"
                  type="number"
                  min={policy.minimumDays}
                  max={policy.maximumDays}
                  step="1"
                  value={draft.retentionDays}
                  onChange={(event) => setDrafts((current) => ({
                    ...current,
                    [policy.dataClass]: { ...draft, retentionDays: event.target.value },
                  }))}
                />
              </label>
              <label className="retention-check">
                <input
                  type="checkbox"
                  checked={draft.executionEnabled}
                  onChange={(event) => setDrafts((current) => ({
                    ...current,
                    [policy.dataClass]: {
                      ...draft,
                      executionEnabled: event.target.checked,
                      enableConfirmation: "",
                    },
                  }))}
                />
                <span>{t("admin.retention.allowExecution")}</span>
              </label>
            </div>
            {enabling && <label className="xus-field retention-confirmation">
              {t("admin.retention.typeEnable", { phrase: enablePhrase })}
              <input
                className="xus-input xus-input--code"
                autoComplete="off"
                value={draft.enableConfirmation}
                onChange={(event) => setDrafts((current) => ({
                  ...current,
                  [policy.dataClass]: { ...draft, enableConfirmation: event.target.value },
                }))}
              />
            </label>}
            {!daysValid && <p className="xus-note xus-note--error" role="alert">
              {t("admin.retention.daysInvalid", { minimum: policy.minimumDays, maximum: policy.maximumDays })}
            </p>}
            <div className="xus-btnrow">
              <BusyButton
                type="button"
                className="xus-btn"
                pending={busy !== ""} disabled={!policy.configured || staleOrganization}
                onClick={() => createPreview(policy)}
              >{t("admin.retention.preview")}</BusyButton>
              <BusyButton
                type="button"
                className="xus-btn xus-btn--go"
                pending={busy !== ""} disabled={!dirty || !daysValid || !confirmationValid || staleOrganization}
                onClick={() => save(policy)}
              >{t("admin.retention.save")}</BusyButton>
            </div>
          </section>;
        })}
      </div>

      {preview && <section className="xus-cardbody xus-cardbody--divided retention-preview" aria-labelledby="retention-preview-title">
        <div>
          <h3 id="retention-preview-title" className="xus-name">{t("admin.retention.previewTitle")}</h3>
          <p className="xus-note">{t("admin.retention.previewHelp")}</p>
        </div>
        <RunStatus run={preview} t={t} lang={lang} now={now} live />
        {preview.status === "previewed" && (preview.eligibleCount < 1
          ? <p className="xus-note">{t("admin.retention.nothingEligible")}</p>
          : <>
          <label className="xus-field retention-confirmation">
            {t("admin.retention.typeAuthorize", { phrase: preview.confirmationPhrase })}
            <input
              className="xus-input xus-input--code"
              autoComplete="off"
              value={runConfirmation}
              onChange={(event) => setRunConfirmation(event.target.value)}
            />
          </label>
          <BusyButton
            type="button"
            className="xus-btn xus-btn--danger"
            pending={busy !== ""} disabled={staleOrganization || runConfirmation.trim() !== preview.confirmationPhrase}
            onClick={authorizePreview}
          >{t("admin.retention.authorize")}</BusyButton>
          </>)}
        {preview.status === "authorized" && <BusyButton
          type="button"
          className="xus-btn xus-btn--danger"
          pending={busy !== ""} disabled={staleOrganization || executionWindowLapsed}
          onClick={executePreview}
        >{t("admin.retention.execute")}</BusyButton>}
      </section>}

      <section className="xus-cardbody xus-cardbody--divided retention-history" aria-labelledby="retention-history-title">
        <div>
          <h3 id="retention-history-title" className="xus-name">{t("admin.retention.history")}</h3>
          <p className="xus-note">{t("admin.retention.historyHelp")}</p>
        </div>
        {(engine.runs || []).length === 0
          ? <p className="xus-note">{t("admin.retention.historyEmpty")}</p>
          : <div className="retention-history__list">
            {engine.runs.map((run) => <div className="retention-history__row" key={run.id}>
              <div>
                <strong>{t(`admin.retention.class.${run.dataClass}`)}</strong>
                <small className="xus-meta">{t(`admin.retention.mode.${run.mode}`)} · {run.retentionDays} {t("admin.retention.dayUnit")}</small>
              </div>
              <RunStatus run={run} t={t} lang={lang} now={now} />
            </div>)}
          </div>}
      </section>
    </>}
  </article>;
}
