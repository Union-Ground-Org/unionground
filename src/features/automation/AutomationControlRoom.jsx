import { useWorkspace } from "../../components/WorkspacePages.jsx";
import { ConnectedAutomationPages } from "./ConnectedAutomationPages.jsx";

// The automation desk exists only as the connected workspace. App mounts every
// view inside a WorkspacePages provider, so the pre-workspace control room that
// used to render when no provider was present (LegacyAutomationControlRoom,
// the only caller of the schemaVersion-1 save and of previewRun from this file)
// was unreachable in the shipped app and was deleted
// (DEBT-UG-LEGACY-AUTOMATION-CONTROL-ROOM-AND-TESTS-ARE-UNREACHABLE-20260921).
// Outside a provider this renders nothing rather than a second, divergent desk;
// tests/workspace-pages.test.jsx pins that every shipped mount is inside one.
export function AutomationControlRoom({ session, accessToken = null, api, onNotice }) {
  const workspace = useWorkspace();
  const scopeKey = [session?.userId, session?.selectedOrganizationId, session?.role, session?.authenticated, session?.mfaSatisfied, session?.membershipStatus, session?.organizationStatus].join(":");
  if (!workspace) return null;
  return <ConnectedAutomationPages key={scopeKey} session={session} accessToken={accessToken} api={api} onNotice={onNotice} />;
}
