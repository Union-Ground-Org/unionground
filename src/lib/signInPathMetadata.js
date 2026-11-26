import { useEffect } from "react";
import { applyPageMetadata, setShellScreen } from "./pageMetadata.js";

// MemberApp shows the landing page, the sign-in screen or the workspace at its
// addresses (/, every /m page, /auth and its aliases) by session, not by
// address, and keeps the address across signing in and out, while the
// route-level usePageMetadata only reruns on a new pathname. So the head
// follows the screen: "sign-in", "landing" or "workspace", or null while the
// session is still settling, when the head is left as it is
// (BUG-UG-PUBLIC-PAGE-TITLE-MEMBER-WORKSPACE-20261003,
// BUG-UG-SIGN-IN-SCREEN-CARRIES-ANOTHER-PAGES-TAB-TITLE-20261122).
export function useSignInPathMetadata(screen) {
  useEffect(() => {
    if (!screen) return;
    setShellScreen(screen);
    applyPageMetadata(window.location.pathname);
  }, [screen]);
  useEffect(() => () => setShellScreen(null), []);
}
