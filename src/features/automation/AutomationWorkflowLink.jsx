import { useLang } from "../../lib/LanguageContext.jsx";
import { t } from "../../lib/i18n.js";
import { workspaceHref } from "../../components/WorkspacePages.jsx";
import { automationWorkflowHref } from "./links.js";

export function AutomationWorkflowLink({ session, sourceKind, sourceId, navigate }) {
  const { lang } = useLang();
  const destination = automationWorkflowHref(session, sourceKind, sourceId);
  if (!destination) return null;
  const href = workspaceHref(destination);
  return <a className="workspace-routed-tab" href={href} onClick={(event) => {
    if (!navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate("automations", href);
  }}>{t(lang, "automation.workflowLink")}</a>;
}
