import { Activity } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { t } from "../../lib/i18n.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { formatZoneInstant, groupTimeZone } from "../../lib/zoneTime.js";

// timeZone is the organization's zone as the server delivers it; until it is
// delivered groupTimeZone() answers the starting zone, still labelled
// (docs/contracts/time-zones-per-group.md). A run shows as a local time with
// its zone, and a job that never ran shows no time at all: its cadence is
// scheduler syntax ("17 4 * * *"), not something a person reads
// (UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122).
export function JobHealthPanel({
  state = "loading",
  jobs = [],
  timeZone,
  busyJobName = null,
  onRetry,
  onAcknowledge,
  onRequestRetry,
}) {
  const { lang } = useLang();
  const zone = groupTimeZone(timeZone);
  const healthLabel = {
    healthy: t(lang, "operations.jobHealth.healthy"),
    running: t(lang, "operations.jobHealth.running"),
    skipped: t(lang, "operations.jobHealth.skipped"),
    stale: t(lang, "operations.jobHealth.stale"),
    failing: t(lang, "operations.jobHealth.failing"),
    never_run: t(lang, "operations.jobHealth.neverRunLabel"),
    acknowledged: t(lang, "operations.jobHealth.acknowledged"),
  };
  return (
    <article id="admin-job-health" className="plane-card xus-card role-section-target" tabIndex="-1">
      <header className="xus-cardhead">
        <span className="xus-glyph" aria-hidden="true"><Activity size={18} /></span>
        <div className="xus-cardhead__copy">
          <h3 className="xus-cardttl">{t(lang, "operations.jobHealth.title")}</h3>
          <p className="xus-cardsub">{t(lang, "operations.jobHealth.sub")}</p>
        </div>
      </header>

      {state === "loading" && (
        <div className="xus-cardbody"><p className="xus-note">{t(lang, "operations.jobHealth.loading")}</p></div>
      )}
      {state === "error" && (
        <div className="xus-cardbody xus-inline">
          <p className="xus-note" role="alert">{t(lang, "operations.jobHealth.error")}</p>
          <button type="button" className="xus-btn" onClick={onRetry}>{t(lang, "operations.jobHealth.retry")}</button>
        </div>
      )}
      {state === "empty" && (
        <div className="xus-cardbody"><p className="xus-note">{t(lang, "operations.jobHealth.empty")}</p></div>
      )}
      {state === "unavailable" && (
        <div className="xus-cardbody"><p className="xus-note">{t(lang, "operations.jobHealth.unavailable")}</p></div>
      )}
      {state === "mfa" && (
        <div className="xus-cardbody xus-inline">
          <p className="xus-note" role="status">{t(lang, "operations.jobHealth.mfa")}</p>
          <button type="button" className="xus-btn" onClick={onRetry}>{t(lang, "operations.jobHealth.retry")}</button>
        </div>
      )}
      {state === "ready" && jobs.map((job) => (
        <div key={job.jobName} className="xus-arow">
          <p className="xus-atext">
            {job.title} · {healthLabel[job.health] || job.health}
            {job.lastRun?.failureCode ? ` · ${job.lastRun.failureCode}` : ""}
            {!job.lastRun ? ` · ${t(lang, "operations.jobHealth.neverRun")}` : ""}
            {job.acknowledgement?.remediation
              ? ` · ${t(lang, "operations.jobHealth.remediation")}: ${job.acknowledgement.remediation === "request_retry" ? t(lang, "operations.jobHealth.remediationRetry") : t(lang, "operations.jobHealth.remediationAcknowledge")}`
              : ""}
          </p>
          {job.lastRun && <small className="xus-atime">{formatZoneInstant(job.lastRun.completedAt || job.lastRun.startedAt, lang, zone)}</small>}
          {job.remediations?.length > 0 && (
            <div className="xus-inline">
              {job.remediations.includes("acknowledge") && (
                <BusyButton
                  type="button"
                  className="xus-btn"
                  aria-label={`${t(lang, "operations.jobHealth.acknowledge")} ${job.title}`}
                  pending={busyJobName !== null} disabled={!job.lastRun?.runId}
                  onClick={() => onAcknowledge?.({ jobName: job.jobName, runId: job.lastRun?.runId })}
                >
                  {t(lang, "operations.jobHealth.acknowledge")}
                </BusyButton>
              )}
              {job.remediations.includes("request_retry") && (
                <BusyButton
                  type="button"
                  className="xus-btn xus-btn--go"
                  aria-label={`${t(lang, "operations.jobHealth.requestRetry")} ${job.title}`}
                  pending={busyJobName !== null} disabled={!job.lastRun?.runId}
                  onClick={() => onRequestRetry?.({ jobName: job.jobName, runId: job.lastRun?.runId })}
                >
                  {t(lang, "operations.jobHealth.requestRetry")}
                </BusyButton>
              )}
            </div>
          )}
        </div>
      ))}
    </article>
  );
}
