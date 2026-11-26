import { useCallback, useEffect, useRef, useState } from "react";

// REQ-UG-NEURO-MAP-DERIVED-GRAPH-20261001 (CR-048). Derived Neuro Map
// connections and automatic topic readiness beside the hand-entered map (old
// de7df4b57c^:lib/neuro-map/graph.ts and app/m/neuro-map/actions.ts). The
// server computes both on read and enforces the switches, the casework access
// predicate and the readiness privacy floor; nothing here is stored.

const DERIVED_EDGE_KINDS = Object.freeze(["represents", "shares_issue"]);
const UUIDISH = /^[0-9a-f-]{36}$/i;
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

export function normalizeDerivedGraph(payload) {
  const empty = { derivedEnabled: false, autoProgressEnabled: false, edges: [], topics: [] };
  if (!payload || typeof payload !== "object") return empty;
  const edges = (Array.isArray(payload.edges) ? payload.edges : []).flatMap((edge) => {
    if (!edge || !DERIVED_EDGE_KINDS.includes(edge.kind) || !UUIDISH.test(String(edge.sourceId)) || !UUIDISH.test(String(edge.targetId))) return [];
    return [{
      id: String(edge.id || `${edge.kind}:${edge.sourceId}:${edge.targetId}`),
      kind: edge.kind,
      source: edge.sourceId,
      target: edge.targetId,
      strength: Math.max(1, Math.min(5, count(edge.strength) || 1)),
    }];
  });
  const topics = (Array.isArray(payload.topicReadiness) ? payload.topicReadiness : []).flatMap((row) => {
    if (!row || typeof row.topicKey !== "string" || typeof row.topicLabel !== "string") return [];
    return [{ topicKey: row.topicKey, topicLabel: row.topicLabel.slice(0, 160), members: count(row.members), introduced: count(row.introduced), developing: count(row.developing), ready: count(row.ready) }];
  });
  return { derivedEnabled: payload.derivedEnabled === true, autoProgressEnabled: payload.autoProgressEnabled === true, edges, topics };
}

async function loadDerivedGraph(client, hat) {
  if (!client || typeof client.rpc !== "function") throw new Error("derived-graph-unavailable");
  const { data, error } = await client.rpc("get_organization_derived_graph", { p_selected_hat: hat });
  if (error) throw error;
  return normalizeDerivedGraph(data);
}

export function DerivedGraphPanel({ client, hat, names, tr, canKeep = false, onKeep = null, refreshKey = 0 }) {
  const [state, setState] = useState({ status: client && hat ? "loading" : "idle", result: null });
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    if (!client || !hat) { setState({ status: "idle", result: null }); return; }
    try {
      const result = await loadDerivedGraph(client, hat);
      if (mine === generation.current) setState({ status: "ready", result });
    } catch {
      if (mine === generation.current) setState({ status: "error", result: null });
    }
  }, [client, hat]);
  useEffect(() => { load(); return () => { generation.current += 1; }; }, [load, refreshKey]);
  const { status, result } = state;
  if (status === "idle" || status === "loading") return null;
  if (status === "error") {
    return <div className="oi-callout" role="alert"><p>{tr("derivedUnavailable")}</p><button type="button" className="oi-button oi-button--secondary" onClick={load}>{tr("derivedRetry")}</button></div>;
  }
  if (!result.derivedEnabled && !result.autoProgressEnabled) return null;
  const name = (id) => names.get(id) || tr("derivedUnknownPerson");
  return <div className="oi-derived" data-testid="neuro-derived">
    {result.derivedEnabled ? <section aria-label={tr("derivedTitle")}>
      <h4>{tr("derivedTitle")}</h4>
      <p className="oi-empty">{tr("derivedHelp")}</p>
      {result.edges.length ? <ul className="oi-edge-list">{result.edges.map((edge) => <li key={edge.id}>
        <span>{name(edge.source)}</span>
        <strong>{tr(`derivedKind.${edge.kind}`)} · {edge.strength}/5</strong>
        <span>{name(edge.target)}</span>
        {canKeep && onKeep ? <button type="button" className="oi-button oi-button--secondary" onClick={() => onKeep(edge)}>{tr("derivedKeep")}</button> : null}
      </li>)}</ul> : <p className="oi-empty">{tr("derivedNone")}</p>}
    </section> : null}
    {result.autoProgressEnabled ? <section aria-label={tr("readinessTitle")}>
      <h4>{tr("readinessTitle")}</h4>
      <p className="oi-empty">{tr("readinessHelp")}</p>
      {result.topics.length ? result.topics.map((topic) => <div className="oi-progress" key={topic.topicKey}>
        <div><strong>{topic.topicLabel}</strong><span>{tr("readinessCounts", { members: topic.members, introduced: topic.introduced, developing: topic.developing, ready: topic.ready })}</span></div>
        <progress max={Math.max(1, topic.members)} value={topic.ready}>{topic.ready}</progress>
      </div>) : <p className="oi-empty">{tr("readinessNone")}</p>}
    </section> : null}
  </div>;
}
