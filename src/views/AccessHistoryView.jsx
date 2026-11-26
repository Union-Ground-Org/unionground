import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createAccessHistory,
  createAccessRpcAdapter,
  createMemoryAccessCatalog,
  presentAccessHistory,
  presentLoading,
  presentMfaRequired,
  presentRetry,
} from "../features/accessHistory/index.js";
import { AccessHistory } from "../features/accessHistory/ui/AccessHistory.jsx";
import { useAccessScopedActor } from "../lib/mi1AccessHistoryWiring.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const systemNowIso = () => new Date().toISOString();

function cutoffForRange(rangeDays, nowIso) {
  return new Date(Date.parse(nowIso) - (rangeDays * DAY_MS)).toISOString();
}

export function AccessHistoryView({
  lang = "en",
  actor,
  client = null,
  api = null,
  catalog = null,
  nowIso = systemNowIso,
}) {
  const { actor: scopedActor, retry } = useAccessScopedActor(client, actor);
  const remote = useMemo(() => api || (client ? createAccessRpcAdapter(client) : null), [api, client]);
  const [store, setStore] = useState(() => catalog || createMemoryAccessCatalog());
  const [rangeDays, setRangeDays] = useState(90);
  const [remotePhase, setRemotePhase] = useState(() => (remote ? "loading" : "idle"));
  const [presentation, setPresentation] = useState(() => presentLoading(lang));
  const request = useRef(0);
  const tools = useMemo(
    () => createAccessHistory({ actor: scopedActor, catalog: store }),
    [scopedActor, store],
  );

  const reload = useCallback(async () => {
    const token = ++request.current;
    if (scopedActor.organizationScopeState === "loading") {
      setRemotePhase("loading");
      return;
    }
    if (scopedActor.organizationScopeState === "retry") {
      setRemotePhase("retry");
      return;
    }
    if (!remote?.listOwn) {
      setRemotePhase("idle");
      return;
    }
    setRemotePhase("loading");
    const loaded = await remote.listOwn(rangeDays);
    if (token !== request.current) return;
    if (!loaded.ok) {
      setRemotePhase(loaded.reason === "mfa_required" ? "mfa_required" : "retry");
      return;
    }
    setStore(loaded.catalog);
    setRemotePhase("ready");
  }, [rangeDays, remote, scopedActor.organizationScopeState]);

  useEffect(() => {
    if (remote) reload();
  }, [reload, remote]);

  useEffect(() => {
    if (scopedActor.organizationScopeState === "loading" || (remote && remotePhase === "loading")) {
      setPresentation(presentLoading(lang));
      return;
    }
    if (scopedActor.organizationScopeState === "retry" || (remote && remotePhase === "retry")) {
      setPresentation(presentRetry(lang));
      return;
    }
    if (remote && remotePhase === "mfa_required") {
      setPresentation(presentMfaRequired(lang));
      return;
    }
    setPresentation(presentAccessHistory(tools.listOwn({
      rangeDays,
      since: cutoffForRange(rangeDays, nowIso()),
    }), lang));
  }, [lang, nowIso, rangeDays, remote, remotePhase, scopedActor.organizationScopeState, tools]);

  return (
    <AccessHistory
      lang={lang}
      presentation={presentation}
      rangeDays={rangeDays}
      onRangeChange={setRangeDays}
      onRetry={() => {
        if (scopedActor.organizationScopeState === "retry") retry();
        else reload();
      }}
    />
  );
}
