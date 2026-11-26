import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { countKey } from "../../lib/i18n.js";
import { caseSignalsT } from "../../lib/i18n/caseSignals.js";
import { caseStepLabel } from "../../lib/caseHistoryValue.js";
import { caseDeadlinePhrase } from "../../lib/caseNextDeadline.js";
import {
  attentionSnapshotKey, attentionTrend, normalizeAttention,
  readAttentionSnapshot, readNextActions, writeAttentionSnapshot,
} from "./model.js";
import "./caseSignals.css";

// REQ-UG-CASE-QUEUE-SIGNALS-AND-NEXT-ACTION-20261001 and
// REQ-UG-STEWARD-ATTENTION-TREND-20261001. Both panels read their own
// SECURITY DEFINER projection through a client captured to the session; the
// server authorizes the hat, scopes cases with the casework access predicate
// and enforces every switch.

function useSessionClient(source) {
  const direct = source?.client ?? null;
  const factory = typeof source?.createSessionClient === "function" ? source.createSessionClient : null;
  const token = typeof source?.session?.access_token === "string" && source.session.access_token ? source.session.access_token : null;
  return useMemo(() => {
    if (direct) return direct;
    if (!factory || !token) return null;
    try {
      return factory({ access_token: token });
    } catch {
      return null;
    }
  }, [direct, factory, token]);
}

// Literal RPC names keep the read-RPC drift guard able to see every call.
// readNextActions lives in model.js, so the shell can start it early (#9840).

async function readAttention(client, hat) {
  const { data, error } = await client.rpc("get_steward_attention_queue", { p_selected_hat: hat });
  if (error) throw error;
  return normalizeAttention(data);
}

function useProjection(source, hat, read) {
  const client = useSessionClient(source);
  const scopeKey = source?.scopeKey ?? "";
  const [state, setState] = useState({ scopeKey, status: client ? "loading" : "idle", result: null });
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    if (!client) { setState({ scopeKey, status: "idle", result: null }); return; }
    setState((current) => ({ scopeKey, status: "loading", result: current.scopeKey === scopeKey ? current.result : null }));
    try {
      const result = await read(client, hat);
      if (mine === generation.current) setState({ scopeKey, status: "ready", result });
    } catch {
      if (mine === generation.current) setState({ scopeKey, status: "error", result: null });
    }
  }, [client, hat, read, scopeKey]);
  useEffect(() => { load(); return () => { generation.current += 1; }; }, [load, scopeKey]);
  return { ...(state.scopeKey === scopeKey ? state : { status: client ? "loading" : "idle", result: null }), reload: load };
}

// #9840: a source may hand over a read the shell already started for this
// hat (`takeNextActions`, once, for the same visit, account and scope); when
// there is none, or it failed, and on every reload, the panel reads for itself.
export function useNextActions(source, hat) {
  const take = source?.takeNextActions ?? null;
  const read = useCallback((client, selectedHat) => (take
    ? take(selectedHat, () => readNextActions(client, selectedHat))
    : readNextActions(client, selectedHat)), [take]);
  return useProjection(source, hat, read);
}

export function useStewardAttention(source, hat) {
  return useProjection(source, hat, readAttention);
}

function useCopy() {
  const { lang } = useLang();
  return useCallback((key, vars) => caseSignalsT(lang, key, vars), [lang]);
}

function dueText(tr, days) {
  if (!Number.isInteger(days)) return tr("caseSignals.due.none");
  if (days < 0) return tr(Math.abs(days) === 1 ? "caseSignals.due.overdueOne" : "caseSignals.due.overdue", { count: Math.abs(days) });
  if (days === 0) return tr("caseSignals.due.today");
  return tr(days === 1 ? "caseSignals.due.inOne" : "caseSignals.due.inDays", { count: days });
}

// BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110:
// a dated item names which deadline it is about (a step deadline with the
// step's label, or the case deadline) and shows its date, in the same words
// the member's My cases card and Home use. An item from a server that does
// not name it yet reads "deadline in 4 days (Nov 14)"
// (BUG-UG-WHAT-TO-DO-NEXT-OVERDUE-ITEMS-SAY-ACT-BEFORE-DEADLINE-20261110).
function namedDeadline(tr, item, lang) {
  if (!item.dueDate || !Number.isInteger(item.days)) return null;
  return caseDeadlinePhrase(tr, { kind: item.dueKind, label: item.dueLabel, days: item.days, dueOn: item.dueDate }, lang);
}

export function nextActionTitle(tr, item, lang = "en") {
  const reference = item.reference || tr("caseSignals.caseFallback");
  const deadline = namedDeadline(tr, item, lang);
  switch (item.kind) {
    case "deadline_risk": return deadline
      ? tr("caseSignals.title.deadline_named", { reference, deadline })
      : tr("caseSignals.title.deadline_risk", { reference, due: dueText(tr, item.days) });
    case "missing_owner": return tr("caseSignals.title.missing_owner", { reference });
    case "stale_contact": return tr("caseSignals.title.stale_contact", { name: item.memberName || tr("caseSignals.memberFallback") });
    case "missing_evidence": return deadline
      ? tr("caseSignals.title.missing_evidence_named", { reference, deadline })
      : tr("caseSignals.title.missing_evidence", { reference, due: dueText(tr, item.days) });
    case "weak_strength": return tr("caseSignals.title.weak_strength", { reference, score: item.strength ?? 0 });
    default: return reference;
  }
}

export function nextActionReason(tr, item) {
  if (item.kind === "stale_contact") {
    const count = item.openCases ?? 1;
    const cases = tr(countKey("caseSignals.activeCases", count), { count });
    return Number.isInteger(item.lastContactDays)
      ? tr("caseSignals.reason.stale_contact", { days: item.lastContactDays, cases })
      : tr("caseSignals.reason.stale_contact_never", { cases });
  }
  // BUG-UG-WHAT-TO-DO-NEXT-OVERDUE-ITEMS-SAY-ACT-BEFORE-DEADLINE-20261110:
  // an item whose deadline has passed never asks staff to beat it.
  if ((item.kind === "deadline_risk" || item.kind === "missing_evidence") && Number.isInteger(item.days) && item.days < 0) {
    return tr(`caseSignals.reason.${item.kind}_passed`);
  }
  return tr(`caseSignals.reason.${item.kind}`);
}

function nextActionsSummary(tr, { items, summary: { total, urgent } }) {
  const urgentLabel = tr(countKey("caseSignals.nextUrgent", urgent), { count: urgent });
  const shown = items.length;
  if (shown > 0 && shown < total) {
    return tr(countKey("caseSignals.nextSummaryTop", shown), { shown, total, urgent: urgentLabel });
  }
  return tr(countKey("caseSignals.nextSummary", total), { total, urgent: urgentLabel });
}

// Old next-action digest panel (lib/crm/next-action-digest.ts): the ranked
// "what next" list with severity, owner and reason.
export function NextActionsPanel({ caseSignals, hat, onOpenCase = null, scope = null }) {
  const tr = useCopy();
  const { t, lang } = useLang();
  const headingId = useId();
  const { status, result, reload } = useNextActions(caseSignals, hat);
  if (status === "idle" || (status === "ready" && !result?.enabled)) return null;
  let body;
  if (status === "loading" && !result) body = <p className="cs-muted" role="status">{tr("caseSignals.loading")}</p>;
  else if (status === "error") {
    body = (
      <div className="cs-state" role="alert">
        <p>{tr("caseSignals.unavailable")}</p>
        <button type="button" className="cs-button" onClick={reload}>{tr("caseSignals.retry")}</button>
      </div>
    );
  } else if (!result.items.length) body = <p className="cs-muted" role="status">{tr("caseSignals.nextEmpty")}</p>;
  else {
    body = (
      <ol className="cs-list">
        {result.items.map((item) => (
          <li key={item.id} className="cs-item">
            <span className={`cs-severity cs-severity--${item.severity}`}>{tr(`caseSignals.severity.${item.severity}`)}</span>
            <div className="cs-item__copy">
              <strong>{nextActionTitle(tr, item, lang)}</strong>
              <small>{nextActionReason(tr, item)}</small>
              {item.noEvidence ? <small data-testid="next-action-no-evidence">{tr("caseSignals.deadlineNoEvidence")}</small> : null}
              {item.kind !== "stale_contact" && item.memberName ? <small>{item.memberName}{item.step ? ` · ${caseStepLabel(item.step, t)}` : ""}</small> : null}
            </div>
            {onOpenCase && item.caseId ? (
              <button type="button" className="cs-button" onClick={() => onOpenCase(item.caseId)} aria-label={tr("caseSignals.openCaseFor", { reference: item.reference || tr("caseSignals.caseFallback") })}>
                {tr("caseSignals.openCase")}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <section id="steward-next-actions" className="cwk-panel cs-panel" aria-labelledby={headingId} data-testid="next-actions-panel">
      <div className="cs-head">
        <h2 id={headingId}>{tr("caseSignals.nextTitle")}</h2>
        {/* UX-UG-STAFF-DESK-COUNTS-SAY-WHAT-THEY-COUNT-20261108: the
            server counts every next action but sends only the top page, so
            the summary says how many of them the list shows. */}
        {result?.enabled ? <span className="cs-summary">{nextActionsSummary(tr, result)}</span> : null}
      </div>
      <p className="cs-muted">{tr("caseSignals.nextIntro")}</p>
      {/* UX-UG-COORDINATOR-NEXT-ACTIONS-SPAN-THE-ORGANIZATION-WHILE-THE-QUEUE-SHOWS-ONE-CHAPTER-20261124
          (#9794): under an organization-level grant the server reads next
          actions across every chapter, while the page's queue, deadlines and
          funnel read the open chapter, so the panel says which it shows. */}
      {scope === "organization" ? <p className="cs-muted" data-testid="next-actions-scope">{tr("caseSignals.nextScopeOrganization")}</p> : null}
      {body}
    </section>
  );
}

function attentionLine(tr, member) {
  if (member.reasons.includes("deadline_risk") && Number.isInteger(member.days)) {
    return tr("caseSignals.attention.deadlineLine", { due: dueText(tr, member.days), reference: member.reference || tr("caseSignals.caseFallback") });
  }
  return member.openCases > 1 ? tr("caseSignals.attention.openMany", { count: member.openCases }) : tr("caseSignals.attention.openOne");
}

// Old dashboard attention hero + member attention queue
// (app/dashboard/attention/page.tsx). `attention` is the hook result, lifted
// so the caseload can reuse it for badges.
export function AttentionPanel({ attention, snapshot, onOpenCase = null }) {
  const tr = useCopy();
  const headingId = useId();
  const { status, result, reload } = attention;
  if (status === "idle" || (status === "ready" && !result?.enabled)) return null;
  let body;
  if (status === "loading" && !result) body = <p className="cs-muted" role="status">{tr("caseSignals.loading")}</p>;
  else if (status === "error") {
    body = (
      <div className="cs-state" role="alert">
        <p>{tr("caseSignals.attention.unavailable")}</p>
        <button type="button" className="cs-button" onClick={reload}>{tr("caseSignals.retry")}</button>
      </div>
    );
  } else {
    const trend = attentionTrend(snapshot?.previousCount ?? null, result.count, result.dominantReason);
    body = (
      <>
        <p className="cs-hero"><strong>{result.count === 1 ? tr("caseSignals.attention.countOne") : tr("caseSignals.attention.count", { count: result.count })}</strong></p>
        {trend ? (
          <p className="cs-trend" role="status">
            {trend.direction === "same" ? tr("caseSignals.attention.noChange") : tr(trend.direction === "up" ? "caseSignals.attention.up" : "caseSignals.attention.down", { count: trend.magnitude })}
            {trend.reason ? ` ${tr(`caseSignals.attention.reason.${trend.reason}`)}` : ""}
          </p>
        ) : null}
        {result.members.length ? (
          <>
            <div className="cs-chips" role="group" aria-label={tr("caseSignals.attention.breakdown")}>
              <span className="cs-chip">{tr("caseSignals.attention.dueSoon", { count: result.breakdown.dueSoon })}</span>
              <span className="cs-chip">{tr("caseSignals.attention.openOnly", { count: result.breakdown.openWithoutDeadlineRisk })}</span>
            </div>
            <ul className="cs-list">
              {result.members.map((member) => (
                <li key={member.memberId} className="cs-item">
                  <span className={`cs-severity ${member.reasons.includes("deadline_risk") ? "cs-severity--critical" : "cs-severity--medium"}`}>
                    {member.reasons.includes("deadline_risk") ? tr("caseSignals.attention.badgeUrgent") : tr("caseSignals.attention.badgeOpen")}
                  </span>
                  <div className="cs-item__copy">
                    <strong>{member.memberName || tr("caseSignals.memberFallback")}</strong>
                    {/* No step line: Union Ground issues carry no
                        grievance step (owner decision, 2026-10-13). */}
                    <small>{attentionLine(tr, member)}</small>
                  </div>
                  {onOpenCase && member.caseId ? (
                    <button type="button" className="cs-button" onClick={() => onOpenCase(member.caseId)} aria-label={tr("caseSignals.openCaseFor", { reference: member.reference || tr("caseSignals.caseFallback") })}>
                      {tr("caseSignals.openCase")}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : <p className="cs-muted">{tr("caseSignals.attention.empty")}</p>}
      </>
    );
  }
  return (
    <section id="steward-attention" className="cwk-panel cs-panel" aria-labelledby={headingId} data-testid="attention-panel">
      <div className="cs-head"><h2 id={headingId}>{tr("caseSignals.attention.title")}</h2></div>
      {body}
    </section>
  );
}

// "Since your last visit": read the previous visit's count once per mount,
// then record this visit's count after a successful read.
export function useAttentionVisit(attention, scope, storage = typeof window === "undefined" ? null : window.localStorage) {
  const key = attentionSnapshotKey(scope || {});
  const previous = useMemo(() => readAttentionSnapshot(storage, key), [storage, key]);
  const count = attention.status === "ready" && attention.result?.enabled ? attention.result.count : null;
  useEffect(() => {
    if (Number.isInteger(count)) writeAttentionSnapshot(storage, key, count);
  }, [storage, key, count]);
  return { previousCount: previous?.count ?? null };
}

// Directory badge (old attention member surfaces): one small marker beside a
// caseload row whose member needs attention, when that switch is on.
export function AttentionBadge({ attention, memberId }) {
  const tr = useCopy();
  const result = attention?.status === "ready" ? attention.result : null;
  if (!result?.enabled || !result.memberSurfaces || !memberId) return null;
  const member = result.members.find((entry) => entry.memberId === memberId);
  if (!member) return null;
  const urgent = member.reasons.includes("deadline_risk");
  return (
    <span className={`cs-badge${urgent ? " cs-badge--urgent" : ""}`} data-testid="attention-badge">
      {urgent ? tr("caseSignals.attention.badgeUrgent") : tr("caseSignals.attention.badgeOpen")}
    </span>
  );
}
