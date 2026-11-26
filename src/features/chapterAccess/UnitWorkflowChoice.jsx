import { useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { BusyButton, BusySelect } from "../../components/BusyControls.jsx";

export function useUnitWorkflow(api, scopeKey, member = null) {
  const actorId = member?.id;
  const chapterId = member?.chapterId;
  const organizationId = member?.organizationId;
  const [selection, setSelection] = useState({ scopeKey, unit: null });
  const unit = selection.scopeKey === scopeKey ? selection.unit : null;
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState({ scopeKey, offset: 0 });
  const offset = page.scopeKey === scopeKey ? page.offset : 0;
  const [state, setState] = useState({ phase: "loading", context: null, scopeKey });
  const generation = useRef(0);
  useEffect(() => {
    if (!api) return undefined;
    const current = ++generation.current;
    setState({ phase: "loading", context: null, scopeKey });
    (offset ? api.load(unit, offset) : api.load(unit)).then((context) => {
      if (context && !context.legacy && ((actorId && context.actorId !== actorId) || (chapterId && context.chapterId !== chapterId) || (organizationId && context.organizationId !== organizationId))) throw new Error("Work context changed");
      if (current === generation.current && context) setState({ phase: "ready", context, scopeKey });
    }).catch(() => { if (current === generation.current) setState({ phase: "error", context: null, scopeKey }); });
    return () => { generation.current += 1; };
  }, [api, scopeKey, unit, offset, revision, actorId, chapterId, organizationId]);
  const select = (value) => {
    generation.current += 1;
    setState({ phase: "loading", context: null, scopeKey });
    setSelection({ scopeKey, unit: value || null });
  };
  const fresh = state.scopeKey === scopeKey;
  return {
    ...state, context: fresh ? state.context : null, phase: fresh ? state.phase : "loading",
    ready: fresh && state.phase === "ready" && Boolean(state.context?.effective),
    select, retry: () => { select(null); setRevision((value) => value + 1); },
    offset, page: (next) => { generation.current += 1; setState({ phase: "loading", context: null, scopeKey }); setPage({ scopeKey, offset: next }); },
  };
}

// pending: the host's own write is running. The unit choice and its pages stay
// focusable and refuse changes until it settles (record 8435).
export function UnitWorkflowChoice({ workflow, pending = false }) {
  const { t } = useLang();
  const context = workflow.context;
  // Nothing about units shows until the server says they are released.
  if (workflow.phase === "loading" || context?.legacy) return null;
  return <div className="institutional-form">
    {workflow.phase === "error" && <div role="alert"><p>{t("unitSettings.loadError")}</p><button type="button" onClick={workflow.retry}>{t("access.retry")}</button></div>}
    {(context?.unitCount ?? context?.units.length) > 1 && <label>{t("unitSettings.choose")}<BusySelect pending={pending} value={context.unitId || ""} onChange={(event) => workflow.select(event.target.value)}>
      <option value="">{t("unitSettings.choose")}</option>
      {context.unitId && !context.units.some((unit) => unit.id === context.unitId) && <option value={context.unitId}>{context.unitName}</option>}
      {context.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
    </BusySelect></label>}
    {context && Boolean(workflow.offset || context.nextUnitOffset) && <div>
      <BusyButton type="button" pending={pending} disabled={!workflow.offset} onClick={() => workflow.page(Math.max(0, workflow.offset - 30))}>{t("unitSettings.previous")}</BusyButton>
      <BusyButton type="button" pending={pending} disabled={context.nextUnitOffset == null} onClick={() => workflow.page(context.nextUnitOffset)}>{t("unitSettings.next")}</BusyButton>
    </div>}
    {context && !context.needsChoice && <p>{context.unitId ? context.unitName || context.units.find((unit) => unit.id === context.unitId)?.name : t("unitSettings.chapter")}</p>}
  </div>;
}
