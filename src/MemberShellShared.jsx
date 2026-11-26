import { useEffect, useState } from "react";
import { BrandMark } from "./components/BrandMark.jsx";
import { publicContact } from "./lib/publicContact.js";
import { openSignupAvailable, openSignupEligible, readOpenSignupSwitch, TURNSTILE_SITE_KEY } from "./lib/openSignup.js";
import { appBackendKind } from "./lib/supabase.js";
import { resolveAppSurface } from "./lib/demoOrigin.js";
import { MEMBER_PATH_VIEWS, STAFF_TOOL_PATH_VIEWS } from "./lib/appRoutes.js";
// Where a member writes when a view keeps crashing (ChunkBoundary fallback):
// the deployment's published support mailbox, or none (src/lib/publicContact.js),
// in which case the crash screens name no address.
export const VIEW_SUPPORT_EMAIL = publicContact("support")?.email ?? "";

export function AppLoadingScreen({ label }) {
  return <main className="loading-screen"><span className="loading-screen__brand" aria-hidden="true"><BrandMark size={48} /></span><p role="status" aria-live="polite" aria-atomic="true">{label}</p></main>;
}

export const pathViews = MEMBER_PATH_VIEWS;

// Staff TOOLS resolve through their own table (lib/staffPlanes.js), not
// pathViews: /m/tasks is not a member route any more (owner decision
// 2026-07-27). The resolver stays role-blind — MemberApp redirects a
// role-less member once `data` is available, because roles are not known here.
export const staffToolByPath = STAFF_TOOL_PATH_VIEWS;

// Full-page routes that render INSTEAD of the member shell, not as a view
// inside it. Deliberately a separate table from pathViews: these are
// reachable without a session (a receipt link, the legal pages),
// so falling one of them through to pathViews' "today" default would drop a
// signed-out visitor on the sign-in screen with no explanation. Each was
// previously its own inline `["/x", "/x/"].includes(pathname)` check, which
// is where the trailing-slash pair kept having to be remembered.
// Open signup (D2e, 2026-09-25) is offered only on the canonical SaaS host,
// on the SaaS surface, against the live backend and with a Turnstile site key,
// and only while the owner's switch is on
// (REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003). The switch ships off, so
// every surface below renders exactly as invitation-only until the owner
// opens the signup period.
function signupSurface() {
  return {
    hostname: window.location.hostname,
    surface: resolveAppSurface(),
    backendKind: appBackendKind,
    siteKey: TURNSTILE_SITE_KEY,
  };
}

// The server is asked at most once per page load, and only where signup could
// otherwise be offered; anywhere else the switch reads off without a request.
// While that read is pending the answer is null (not yet known), so
// /signup/confirm can hold its token until the switch has been read.
let openSignupSwitchRead = null;

export function useOpenSignupAvailable() {
  const surface = signupSurface();
  const eligible = openSignupEligible(surface);
  const [switchOpen, setSwitchOpen] = useState(null);
  useEffect(() => {
    if (!eligible) return undefined;
    let cancelled = false;
    openSignupSwitchRead ||= readOpenSignupSwitch((...args) => fetch(...args));
    openSignupSwitchRead.then((open) => { if (!cancelled) setSwitchOpen(open); });
    return () => { cancelled = true; };
  }, [eligible]);
  if (!eligible) return false;
  return switchOpen === null ? null : openSignupAvailable({ ...surface, switchOpen });
}
