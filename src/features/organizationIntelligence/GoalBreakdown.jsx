// REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030: one
// collective action's live count against its goal, by shift and by
// classification (public.get_digital_action_goal_breakdown). Read when the
// administrator opens it, and again on each reopen, so the count is current.
// A person's shift and classification count only when they shared their
// profile details with administrators; the rest show as not shared.
import { useRef, useState } from "react";
import { t as translate } from "../../lib/i18n.js";
import "../../lib/i18n/features/adminAttentionStrings.js";

function Groups({ title, groups, tr }) {
  return <div className="oi-breakdown__group">
    <h3>{title}</h3>
    <ul>
      {groups.map((group) => <li key={group.label ?? ""}>
        <span>{group.label ?? tr("goalBreakdown.notShared")}</span>
        <strong>{group.count}</strong>
      </li>)}
    </ul>
  </div>;
}

function normalize(payload) {
  const groups = (value) => (Array.isArray(value) ? value : [])
    .filter((group) => Number.isInteger(group?.count) && group.count > 0)
    .map((group) => ({ label: typeof group.label === "string" && group.label.trim() ? group.label.trim() : null, count: group.count }));
  return {
    targetCount: Number.isInteger(payload?.targetCount) ? payload.targetCount : 0,
    participantCount: Number.isInteger(payload?.participantCount) ? payload.participantCount : 0,
    byShift: groups(payload?.byShift),
    byClassification: groups(payload?.byClassification),
  };
}

export function GoalBreakdown({ actionId, load, lang = "en" }) {
  const tr = (key, vars) => translate(lang, key, vars);
  const [state, setState] = useState({ phase: "idle", value: null });
  // Only the latest read may settle the view: an older response that lands
  // after a reopen never replaces the newer count.
  const generation = useRef(0);
  const read = async () => {
    const mine = ++generation.current;
    setState({ phase: "loading", value: null });
    try {
      const value = normalize(await load({ actionId }));
      if (mine === generation.current) setState({ phase: "ready", value });
    } catch (error) {
      if (mine === generation.current) setState({ phase: error?.code === "42501" ? "denied" : "error", value: null });
    }
  };
  return <details className="oi-breakdown" onToggle={(event) => { if (event.currentTarget.open) read(); }}>
    <summary>{tr("goalBreakdown.open")}</summary>
    <div aria-live="polite">
      {state.phase === "loading" && <p className="oi-muted">{tr("goalBreakdown.loading")}</p>}
      {state.phase === "denied" && <p className="oi-muted">{tr("goalBreakdown.denied")}</p>}
      {state.phase === "error" && <p role="alert">{tr("goalBreakdown.error")} <button type="button" className="oi-link" onClick={read}>{tr("goalBreakdown.retry")}</button></p>}
      {state.phase === "ready" && <>
        <p><strong>{tr("goalBreakdown.total", { count: state.value.participantCount, target: state.value.targetCount })}</strong></p>
        {state.value.participantCount === 0 ? <p className="oi-muted">{tr("goalBreakdown.none")}</p> : <>
          <Groups title={tr("goalBreakdown.shift")} groups={state.value.byShift} tr={tr} />
          <Groups title={tr("goalBreakdown.classification")} groups={state.value.byClassification} tr={tr} />
        </>}
        <p className="oi-muted">{tr("goalBreakdown.note")}</p>
      </>}
    </div>
  </details>;
}
