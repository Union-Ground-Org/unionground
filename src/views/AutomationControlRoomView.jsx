import { useMemo } from "react";
import { AutomationControlRoom } from "../features/automation/AutomationControlRoom.jsx";
import { useMi1ScopedActor } from "../lib/mi1FeatureWiring.js";
import { createAutomationApi } from "../lib/mi1AutomationWiring.js";

export function AutomationControlRoomView({ session, accessToken = null, client, embedded = false, onNotice }) {
  const scopedSession = useMi1ScopedActor(client, session);
  const api = useMemo(() => createAutomationApi(client), [client]);
  return <div className={embedded ? "" : "screen"} data-mi1-surface="automation-control-room">
    <AutomationControlRoom session={scopedSession} accessToken={accessToken} api={api} onNotice={onNotice} />
  </div>;
}
