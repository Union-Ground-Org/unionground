import { useState } from "react";
import { useWorkspace } from "../../components/WorkspacePages.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { PLANE_CARD_CLASS } from "../../lib/staffPlaneStyles.js";

const SETUP_REVIEW_PATH = "/m/admin/setup-review";

export function setupBannerKey(organizationId) {
  return `ug.setupBanner.dismissed.${organizationId}`;
}

function readDismissed(organizationId) {
  try {
    return window.localStorage.getItem(setupBannerKey(organizationId)) === "true";
  } catch {
    return false;
  }
}

// Shown on the admin overview while the organization looks unset: at most one
// chapter. There is no setup-status table (brief A4), so this is a heuristic;
// the page stays reachable from the admin menu either way. The dismissal is a
// per-browser boolean and nothing else.
export function SetupBanner({ organization, organizationId }) {
  const { t } = useLang();
  const workspace = useWorkspace();
  const [dismissed, setDismissed] = useState(() => Boolean(organizationId) && readDismissed(organizationId));
  const chapters = Array.isArray(organization?.chapters) ? organization.chapters : null;
  if (!organizationId || !chapters || chapters.length > 1 || dismissed) return null;
  function dismiss() {
    try { window.localStorage.setItem(setupBannerKey(organizationId), "true"); } catch { /* storage refused: hide for this view only */ }
    setDismissed(true);
  }
  return <aside className={`${PLANE_CARD_CLASS} xus-card`} aria-label={t("unions.setup.pageTitle")}>
    <div className="xus-cardbody xus-form">
      <p className="xus-note">{t("unions.setup.bannerBody")}</p>
      <div className="xus-btnrow">
        <a className="xus-btn xus-btn--go" href={SETUP_REVIEW_PATH} onClick={(event) => {
          if (!workspace) return;
          event.preventDefault();
          workspace.open(SETUP_REVIEW_PATH);
        }}>{t("unions.setup.bannerLink")}</a>
        <button type="button" className="xus-btn" onClick={dismiss}>{t("unions.setup.bannerDismiss")}</button>
      </div>
    </div>
  </aside>;
}
