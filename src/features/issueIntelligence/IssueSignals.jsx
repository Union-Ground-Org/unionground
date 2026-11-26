import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite, useBusyScope } from "../../lib/busyWrite.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { issueIntelligenceT } from "../../lib/i18n/issueIntelligence.js";
import { loadIssueSignals, loadWeeklyDigests, requestDigestSummary } from "./api.js";
import {
  actionRecommendations, guidanceRecommendations, headlineCopy, issueDraftHref, joinEvidenceList,
  normalizeWeeklyDigests, pollDrafts, reasonCopy, signalsForMemberSurface, summaryCopy,
} from "./model.js";
import "./issueIntelligence.css";

// REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001. Restores the old issue-thread
// banner, "Relevant right now" guidance boost, staff thread card and poll
// suggestion (de7df4b57c^:components/issue-threads/*). The server decides
// everything that matters: whether the feature is on, whether a family is
// active, and whether enough different people are behind it.

// Transport: App passes its per-session client factory and the session, the
// same way the learning card does, so a late response can never ride a later
// user's session. Tests may pass a ready client instead.
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

export function useIssueSignals(source, hat) {
  const client = useSessionClient(source);
  const scopeKey = source?.scopeKey ?? "";
  const [state, setState] = useState({ status: client ? "loading" : "idle", result: null });
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    if (!client) { setState({ status: "idle", result: null }); return; }
    setState((current) => ({ status: "loading", result: current.result }));
    try {
      const result = await loadIssueSignals(client, hat);
      if (mine === generation.current) setState({ status: "ready", result });
    } catch {
      if (mine === generation.current) setState({ status: "error", result: null });
    }
  }, [client, hat]);
  // A new user, organization or chapter is a new read.
  useEffect(() => { load(); return () => { generation.current += 1; }; }, [load, scopeKey]);
  return { ...state, reload: load };
}

function useCopy() {
  const { lang } = useLang();
  return useCallback((key, vars) => issueIntelligenceT(lang, key, vars), [lang]);
}

function headlineText(tr, signal, viewer) {
  const copy = headlineCopy(signal, viewer);
  return tr(copy.key, copy.vars);
}

function reasonText(tr, signal, viewer) {
  const copy = reasonCopy(signal, viewer);
  if (!copy.evidence) return tr(copy.key);
  const list = joinEvidenceList(copy.evidence.map((item) => tr(`issueIntelligence.evidence.${item}`)), tr("issueIntelligence.listAnd"));
  return tr(copy.key, { list });
}

function familyGuideKey(signal) {
  return signal.key === "retaliation" ? "retaliation" : "contractRights";
}

function LinkList({ items, prefix, signal, tr, onNavigate, limit }) {
  const shown = typeof limit === "number" ? items.slice(0, limit) : items;
  if (!shown.length) return null;
  return (
    <ul className="issue-links">
      {shown.map((item) => (
        <li key={`${item.kind}:${item.destination}`}>
          <button type="button" className="issue-link" onClick={() => onNavigate?.(item.destination)}>
            <strong>{tr(`${prefix}.${familyGuideKey(signal)}.${item.kind}.title`)}</strong>
            <small>{tr(`${prefix}.${familyGuideKey(signal)}.${item.kind}.description`)}</small>
            <span aria-hidden="true">›</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SignalDetails({ signal, viewer, tr, onNavigate, id }) {
  const summary = summaryCopy(signal, viewer);
  const guidance = guidanceRecommendations(signal, viewer);
  const actions = actionRecommendations(signal, viewer);
  return (
    <div className="issue-details" id={id}>
      <h3>{tr("issueIntelligence.whatItIs")}</h3>
      <p>{tr(summary.whatItIs)}</p>
      <p className="issue-muted">{tr(summary.whyItMatters)}</p>
      {summary.whatChanged ? (
        <>
          <h3>{tr("issueIntelligence.whatChanged")}</h3>
          <p>{tr(summary.whatChanged.key, summary.whatChanged.vars)}</p>
        </>
      ) : null}
      {actions.length ? (
        <>
          <h3>{tr("issueIntelligence.staffActions")}</h3>
          <LinkList items={actions} prefix="issueIntelligence.action" signal={signal} tr={tr} onNavigate={onNavigate} />
        </>
      ) : null}
      <h3>{tr("issueIntelligence.nextSteps")}</h3>
      <LinkList items={guidance} prefix="issueIntelligence.guide" signal={signal} tr={tr} onNavigate={onNavigate} />
    </div>
  );
}

// Member banner (old issue-thread-banner.tsx) and, on Know your rights, the
// boosted guidance panel (old guidance-boost-panel.tsx). Renders nothing
// unless the server returned an active family for this surface.
export function IssueSignalBanner({ issueSignals, surface = "today", variant = "banner" }) {
  const tr = useCopy();
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const { status, result } = useIssueSignals(issueSignals, "member");
  if (status !== "ready" || !result?.enabled) return null;
  const signal = signalsForMemberSurface(result.signals, surface)[0];
  if (!signal) return null;
  const onNavigate = issueSignals?.onNavigate;
  if (variant === "boost") {
    return (
      <section className="home-card issue-banner issue-banner--boost" aria-label={tr("issueIntelligence.kicker")} data-testid="issue-guidance-boost">
        <p className="issue-kicker">{tr("issueIntelligence.kicker")}</p>
        <p className="issue-headline">{headlineText(tr, signal, "member")}</p>
        <LinkList items={guidanceRecommendations(signal, "member")} prefix="issueIntelligence.guide" signal={signal} tr={tr} onNavigate={onNavigate} limit={2} />
        <button type="button" className="issue-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}>
          {open ? tr("issueIntelligence.hideDetails") : tr("issueIntelligence.whyNow")}
        </button>
        {open ? <SignalDetails signal={signal} viewer="member" tr={tr} onNavigate={onNavigate} id={detailsId} /> : null}
      </section>
    );
  }
  return (
    <section className="home-card issue-banner" aria-label={tr("issueIntelligence.kicker")} data-testid="issue-thread-banner">
      <div className="issue-banner__copy">
        <p className="issue-kicker">{tr("issueIntelligence.kicker")}</p>
        <p className="issue-headline">{headlineText(tr, signal, "member")}</p>
        <p className="issue-muted">{reasonText(tr, signal, "member")}</p>
      </div>
      <button type="button" className="issue-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}>
        {open ? tr("issueIntelligence.hideDetails") : tr("issueIntelligence.whyNow")}
      </button>
      {open ? <SignalDetails signal={signal} viewer="member" tr={tr} onNavigate={onNavigate} id={detailsId} /> : null}
    </section>
  );
}

function PollSuggestion({ signal, tr, onNavigate }) {
  const drafts = pollDrafts(signal, "staff");
  if (!drafts.length) return null;
  return (
    <section className="issue-poll" aria-label={tr("issueIntelligence.poll.title")}>
      <p className="issue-kicker">{tr("issueIntelligence.poll.title")}</p>
      <p className="issue-muted">{tr("issueIntelligence.poll.why", { count: (signal.evidenceFamilies || []).length })}</p>
      <ul className="issue-drafts">
        {drafts.map((draft) => (
          <li key={draft.key}>
            <span className="issue-draft__label">{tr(draft.labelKey)}</span>
            <p>{tr(draft.questionKey)}</p>
            <button type="button" className="issue-toggle" onClick={() => onNavigate?.("campaigns", issueDraftHref(tr(draft.questionKey)))}>
              {tr("issueIntelligence.poll.useDraft")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StaffSignalCard({ signal, tr, onNavigate }) {
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  return (
    <article className="issue-card" data-testid="issue-thread-card">
      <span className="issue-tag">{tr("issueIntelligence.confidenceTag", { confidence: tr(`issueIntelligence.confidence.${signal.confidence}`) })}</span>
      <h3 className="issue-card__title">{tr(`issueIntelligence.${signal.key}.title`)}</h3>
      <p className="issue-headline">{headlineText(tr, signal, "staff")}</p>
      <p className="issue-muted">{reasonText(tr, signal, "staff")} {tr("issueIntelligence.trendLabel", { trend: tr(`issueIntelligence.trend.${signal.trend}`) })}</p>
      <button type="button" className="issue-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}>
        {open ? tr("issueIntelligence.hideDetails") : tr("issueIntelligence.whyNow")}
      </button>
      {open ? <SignalDetails signal={signal} viewer="staff" tr={tr} onNavigate={onNavigate} id={detailsId} /> : null}
      <PollSuggestion signal={signal} tr={tr} onNavigate={onNavigate} />
    </article>
  );
}

// Steward and admin panel (old issue-threads page + thread card + poll
// suggestion). hat must be a staff hat the caller holds; the server refuses
// anything else and the panel then shows its unavailable state.
export function IssueSignalsStaffPanel({ issueSignals, hat }) {
  const tr = useCopy();
  const headingId = useId();
  const { status, result, reload } = useIssueSignals(issueSignals, hat);
  if (status === "idle") return null;
  const onNavigate = issueSignals?.onNavigate;
  let body;
  if (status === "loading" && !result) body = <p className="issue-muted" role="status">{tr("issueIntelligence.loading")}</p>;
  else if (status === "error") {
    body = (
      <div role="alert" className="issue-state">
        <p>{tr("issueIntelligence.unavailable")}</p>
        <button type="button" className="issue-toggle" onClick={reload}>{tr("issueIntelligence.retry")}</button>
      </div>
    );
  } else if (!result?.enabled) body = <p className="issue-muted">{tr("issueIntelligence.disabled")}</p>;
  else if (!result.signals.length) {
    body = (
      <div role="status" className="issue-state issue-state--empty">
        <p><strong>{tr("issueIntelligence.none")}</strong></p>
        <p className="issue-muted">{tr("issueIntelligence.noneHelp")}</p>
      </div>
    );
  } else {
    body = result.signals.map((signal) => <StaffSignalCard key={signal.family} signal={signal} tr={tr} onNavigate={onNavigate} />);
  }
  return (
    <section className="issue-panel" aria-labelledby={headingId} data-testid="issue-intelligence-panel">
      <h2 id={headingId}>{tr("issueIntelligence.staffTitle")}</h2>
      <p className="issue-muted">{tr("issueIntelligence.staffIntro")}</p>
      {body}
      <WeeklyDigestSection issueSignals={issueSignals} hat={hat} tr={tr} />
    </section>
  );
}

// REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001 (old
// components/issue-threads/weekly-digest-panel.tsx). Renders nothing while the
// weekly digest switch is off; otherwise the latest stored digest per family,
// or an honest "not generated yet" state.
function useWeeklyDigests(source, hat) {
  const client = useSessionClient(source);
  const scopeKey = source?.scopeKey ?? "";
  const [state, setState] = useState({ status: client ? "loading" : "idle", result: null });
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    if (!client) { setState({ status: "idle", result: null }); return; }
    setState((current) => ({ status: "loading", result: current.result }));
    try {
      const result = await loadWeeklyDigests(client, hat);
      if (mine === generation.current) setState({ status: "ready", result });
    } catch {
      if (mine === generation.current) setState({ status: "error", result: null });
    }
  }, [client, hat]);
  useEffect(() => { load(); return () => { generation.current += 1; }; }, [load, scopeKey]);
  const replace = useCallback((digest) => setState((current) => current.result ? {
    ...current,
    result: { ...current.result, digests: current.result.digests.map((item) => (item.id === digest.id ? digest : item)) },
  } : current), []);
  return { ...state, reload: load, replace };
}

function WeeklyDigestSection({ issueSignals, hat, tr }) {
  const headingId = useId();
  const { status, result, reload, replace } = useWeeklyDigests(issueSignals, hat);
  // Record 8435: a summary that answers after the hat or scope changed must
  // not replace a digest in the list now shown; one from the same scope does,
  // whether or not its card is still on screen.
  const digestKey = useMemo(() => ({ hat, scopeKey: issueSignals?.scopeKey ?? "", client: issueSignals?.client ?? null }), [hat, issueSignals?.scopeKey, issueSignals?.client]);
  const digestScope = useBusyScope(digestKey);
  if (status === "idle" || (status === "ready" && !result?.enabled) || (status === "loading" && !result)) return null;
  if (status === "error") {
    return (
      <div role="alert" className="issue-state issue-digest">
        <p>{tr("issueIntelligence.digest.unavailable")}</p>
        <button type="button" className="issue-toggle" onClick={reload}>{tr("issueIntelligence.retry")}</button>
      </div>
    );
  }
  return (
    <section className="issue-digest" aria-labelledby={headingId} data-testid="weekly-digest-panel">
      <h3 id={headingId} className="issue-card__title">{tr("issueIntelligence.digest.title")}</h3>
      {result.digests.length === 0
        ? <p className="issue-muted" role="status">{tr("issueIntelligence.digest.none")}</p>
        : result.digests.map((digest) => <DigestCard key={digest.id} digest={digest} hat={hat} session={issueSignals?.session} requestSummary={issueSignals?.requestDigestSummary} onSaved={digestScope.guard(replace)} tr={tr} />)}
    </section>
  );
}

function DigestCard({ digest, hat, session, requestSummary, onSaved, tr }) {
  const [summaryState, setSummaryState] = useState("idle");
  // Record 8435: the summary's lock and busy state live for this card's mount
  // (it is keyed by digest); onSaved is guarded by the section's own scope.
  const busyWriteRef = useRef(new Set());
  function summarize() {
    return runBusyWrite(busyWriteRef, "summary", () => summarizeNow());
  }
  async function summarizeNow() {
    setSummaryState("working");
    try {
      const payload = await (requestSummary || requestDigestSummary)(session, hat, digest.id);
      const saved = normalizeWeeklyDigests({ enabled: true, digests: [payload?.digest] }).digests[0];
      if (!saved) throw new Error("invalid");
      onSaved(saved);
      setSummaryState("idle");
    } catch {
      setSummaryState("failed");
    }
  }
  return (
    <article className="issue-card">
      <span className="issue-tag">{tr(`issueIntelligence.digest.confidence.${digest.confidence}`)}</span>
      <p className="issue-headline">{tr("issueIntelligence.digest.headline", {
        family: tr(`issueIntelligence.${digest.key}.title`),
        trend: tr(`issueIntelligence.trend.${digest.trend}`),
        start: digest.windowStart,
        end: digest.windowEnd,
      })}</p>
      {digest.bands.length ? (
        <ul className="issue-bands" aria-label={tr("issueIntelligence.digest.evidence")}>
          {digest.bands.map((item) => (
            <li key={item.key}><span>{tr(`issueIntelligence.digest.source.${item.key}`)}</span><strong>{tr(`issueIntelligence.digest.band.${item.band}`)}</strong></li>
          ))}
        </ul>
      ) : null}
      {digest.reviewedThemes ? <p className="issue-muted">{tr("issueIntelligence.digest.reviewedThemes")}</p> : null}
      {digest.recommendations.length ? (
        <>
          <h4 className="issue-subhead">{tr("issueIntelligence.digest.recommended")}</h4>
          <ul className="issue-recommendations">
            {digest.recommendations.map((kind) => (
              <li key={kind}>
                <strong>{tr(`issueIntelligence.digest.rec.${digest.key}.${kind}.title`)}</strong>
                <span className="issue-muted">{tr(`issueIntelligence.digest.rec.${digest.key}.${kind}.rationale`)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {digest.ai.status === "enriched" ? (
        <div className="issue-ai" aria-live="polite">
          <h4 className="issue-subhead">{tr("issueIntelligence.digest.aiTitle")}</h4>
          <p>{digest.ai.summary.summary}</p>
          {digest.ai.summary.recommendations.length ? <ul>{digest.ai.summary.recommendations.map((item) => <li key={item}>{item}</li>)}</ul> : null}
          {digest.ai.summary.caution ? <p className="issue-muted">{digest.ai.summary.caution}</p> : null}
        </div>
      ) : null}
      {digest.ai.status === "available" ? (
        <div className="issue-ai-actions">
          <BusyButton type="button" className="issue-toggle" pending={summaryState === "working"} onClick={summarize}>
            {summaryState === "working" ? tr("issueIntelligence.digest.summarizing") : tr("issueIntelligence.digest.summarize")}
          </BusyButton>
          <p className="issue-muted">{tr("issueIntelligence.digest.aiPrivacy")}</p>
          {summaryState === "failed" ? <p className="issue-error" role="alert">{tr("issueIntelligence.digest.summaryFailed")}</p> : null}
        </div>
      ) : null}
    </article>
  );
}
