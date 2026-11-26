import { Workflow } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { workspaceHref } from "./WorkspacePages.jsx";

const AUTOMATION_SUBPAGES = Object.freeze({
  definitions: "automation.automations",
  recipes: "automation.recipes",
  builder: "automation.pages.pageBuilder",
  definition: "automation.pages.pageDefinition",
  history: "automation.runs",
  run: "automation.pages.pageRun",
  settings: "automation.readiness.safety",
});

// The admin or President subroute this card stands on, such as
// /m/admin/automations/builder, and the matching page of the workspace.
export function automationSubpage(pathname) {
  const match = /^\/m\/(?:admin|vp)\/automations\/([a-z]+)\/?$/.exec(String(pathname || ""));
  return match && AUTOMATION_SUBPAGES[match[1]] ? { tab: match[1], labelKey: AUTOMATION_SUBPAGES[match[1]] } : null;
}

// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001 (inventory A5): the
// automation control room moved to its own /m/automations workspace (#1857),
// which left the admin and VP "Automation control room" pages empty. This card
// is what those pages show instead: one honest link to the working control,
// never a second embedded copy of it. On a subroute it names that page and
// links the same page of the workspace (Lovable audit APP-ADMIN-02 to -04,
// APP-VP-01 to -04), so Builder or Settings never reads as the overview.
export function AutomationWorkspaceLink({ id = "admin-automation-control" }) {
  const { t } = useLang();
  const subpage = automationSubpage(typeof window === "undefined" ? "" : window.location.pathname);
  const page = subpage ? t(subpage.labelKey) : null;
  return <article id={id} className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1" aria-labelledby={`${id}-title`}>
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><Workflow size={18} /></span>
      <div className="xus-cardhead__copy"><h2 className="xus-cardttl" id={`${id}-title`}>{page ? t("admin.automation.subpageTitle", { page }) : t("admin.automation.title")}</h2><p className="xus-cardsub">{t("admin.automation.sub")}</p></div>
    </header>
    <div className="xus-cardbody">
      <p className="xus-note">{page ? t("admin.automation.subpageHelp", { page }) : t("admin.automation.workspaceHelp")}</p>
      <a className="xus-btn xus-btn--go" href={workspaceHref(subpage ? `/m/automations/${subpage.tab}` : "/m/automations")}>{page ? t("admin.automation.openSubpage", { page }) : t("admin.automation.openWorkspace")}</a>
    </div>
  </article>;
}
