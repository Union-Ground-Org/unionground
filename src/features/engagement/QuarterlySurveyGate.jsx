import { useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { engagementApi } from "./api.js";
import "./quarterlyGate.css";

// REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001 (CR-002, "give to view"),
// server-enforced since REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002
//
// public.get_quarterly_survey_gate() is the only authority: it applies the
// organization switch features.engagement_voice.quarterly_survey_gate, exempts
// organization admins and fails open whenever the member cannot answer a
// survey. The member report reads behind these pages return a locked payload
// under the same rule, so this wrapper never shows the page while it is locked
// or unknown:
//   * open (unlocked, or no client/organization in a fixture preview): the page;
//   * locked: the banner that links to the survey, and no page;
//   * checking: a short status line, and no page;
//   * a failed or malformed read: locked, with a retry, and no page, so stale
//     data is never shown.
// Every result carries the client, organization and session it was read for.
// A result read for another context counts as checking, so a switch of
// organization or account never shows the page on the previous answer while
// the new check is still running.

export function quarterLabel(periodKey) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(periodKey ?? ""));
  return match ? `Q${match[2]} ${match[1]}` : "";
}

export function gateLocksPage(gate) {
  return Boolean(gate && typeof gate === "object" && gate.unlocked === false && gate.surveyId);
}

export function gateOpensPage(gate) {
  return Boolean(gate && typeof gate === "object" && !Array.isArray(gate) && gate.unlocked === true);
}

// The status to render for a stored check in the current context: a result
// read for another client, organization or session is still checking.
export function gateStatusFor(check, context) {
  if (!context.enforced) return "open";
  const current = check
    && check.client === context.client
    && check.organizationId === context.organizationId
    && check.sessionKey === context.sessionKey;
  return current ? check.status : "checking";
}

export function QuarterlySurveyGate({ client, organizationId, sessionKey = null, onTakeSurvey, children }) {
  const { t } = useLang();
  const enforced = Boolean(client && organizationId);
  const [check, setCheck] = useState({ status: "checking", gate: null, client, organizationId, sessionKey });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enforced) return undefined;
    let current = true;
    const context = { client, organizationId, sessionKey };
    setCheck({ status: "checking", gate: null, ...context });
    engagementApi.loadQuarterlyGate(client)
      .then((next) => {
        if (!current) return;
        if (gateOpensPage(next)) setCheck({ status: "open", gate: next, ...context });
        else if (gateLocksPage(next)) setCheck({ status: "locked", gate: next, ...context });
        else setCheck({ status: "error", gate: null, ...context });
      })
      .catch(() => { if (current) setCheck({ status: "error", gate: null, ...context }); });
    return () => { current = false; };
  }, [client, organizationId, sessionKey, enforced, attempt]);

  const status = gateStatusFor(check, { enforced, client, organizationId, sessionKey });
  if (status === "open") {
    return <div className="qsg-content" data-testid="quarterly-gate-content" data-quarterly-gate="open">{children}</div>;
  }
  if (status === "checking") {
    return <p className="qsg-checking" role="status" data-testid="quarterly-gate-checking" data-quarterly-gate="checking">{t("quarterlyGate.checking")}</p>;
  }
  const failed = status === "error";
  const quarter = quarterLabel(check.gate?.periodKey);
  const title = failed
    ? t("quarterlyGate.errorTitle")
    : quarter ? t("quarterlyGate.title", { quarter }) : t("quarterlyGate.titleNoQuarter");
  return (
    <aside className="qsg-banner" role="status" aria-live="polite" data-testid="quarterly-survey-banner" data-quarterly-gate={failed ? "error" : "locked"}>
      <ClipboardList aria-hidden="true" />
      <div className="qsg-banner__copy">
        <p className="qsg-banner__title">{title}</p>
        <p>{failed ? t("quarterlyGate.errorBody") : t("quarterlyGate.body")}</p>
      </div>
      <div className="qsg-banner__actions">
        {failed ? (
          <button className="qsg-banner__retry" type="button" data-testid="quarterly-survey-banner-retry" onClick={() => setAttempt((count) => count + 1)}>
            {t("quarterlyGate.retry")}
          </button>
        ) : null}
        <button className="qsg-banner__cta" type="button" data-testid="quarterly-survey-banner-cta" onClick={() => onTakeSurvey?.(check.gate?.surveyId ?? null)}>
          {t("quarterlyGate.cta")}
        </button>
      </div>
    </aside>
  );
}
