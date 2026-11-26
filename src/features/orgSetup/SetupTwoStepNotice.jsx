import { useLang } from "../../lib/LanguageContext.jsx";
import { plainClick } from "../../lib/plainClick.js";
import { useWorkspace } from "../../components/WorkspacePages.jsx";
import { setupSecurityPath } from "../../lib/setupSecurityReturn.js";

// The two-step form renders only in the Settings security section
// (src/views/SettingsView.jsx), so both setup links point there, not at the
// Settings overview.

// An in-app click opens the form without a page load when a workspace is
// mounted; anywhere else, and for a new-tab or modified click, the plain link
// still works. `plain` is for a page holding unsaved work (the setup review
// draft): a full page load, so the browser's leave-page prompt that the page
// already arms guards the draft, and nothing unmounts silently.
export function TwoStepSettingsLink({ children, plain = false, returnTo = null }) {
  const workspace = useWorkspace();
  const settingsPath = setupSecurityPath(returnTo);
  if (plain) return <a href={settingsPath}>{children}</a>;
  return <a
    href={settingsPath}
    onClick={(event) => {
      if (!workspace || !plainClick(event)) return;
      event.preventDefault();
      workspace.open(settingsPath, "settings");
    }}
  >{children}</a>;
}

// A creator whose organization requires staff two-step sign-in and who has no
// factor yet has every staff hat paused (memberApi mirrors the server), so
// the admin workspace is not offered. Until now the reason showed only in
// Settings; this says it where they land.
// On Home (`home`) it names the paused staff roles plainly, for every staff
// member rather than only an organization's creator
// (REQ-UG-STAFF-ROLE-PAUSE-AND-RESTORE-CLARITY-20261030, finding 2).
export function SetupTwoStepNotice({ staffMfa, home = false }) {
  const { t } = useLang();
  if (!staffMfa?.blocked || !staffMfa?.holdsStaffRole) return null;
  return <p className="xus-note" role="status">
    {t(home ? "today.staffRolesPaused" : "unions.setup.twoStepNotice")} <TwoStepSettingsLink>{t(home ? "today.staffRolesPausedLink" : "unions.setup.twoStepLink")}</TwoStepSettingsLink>
  </p>;
}
