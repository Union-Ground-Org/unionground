import { useEffect, useMemo, useState } from "react";
import { DirectoryCard } from "./AdminCommandCenter.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { exportMemberDirectoryCsv, loadAdminMemberDirectory, loadMemberDirectoryAccess } from "../lib/memberApi.js";
import { PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { WorkspaceCardHead } from "./WorkspacePages.jsx";

// REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030: a chapter
// President or Secretary-Treasurer reads and exports the member directory of
// their own chapter through the office, without the admin role. The database
// decides (get_member_directory_access); anyone else sees nothing here, and a
// web deployment ahead of the migration renders nothing either.
const HIDDEN_PROBE_CODES = new Set(["42501", "PGRST202", "42883"]);

export function OfficerMemberDirectory({ client, sectionName = null }) {
  const { t } = useLang();
  const api = useMemo(() => (client?.rpc ? {
    loadMemberDirectory: (query, after) => loadAdminMemberDirectory(client, { query, after, limit: 25 }),
    exportMemberDirectory: (context, locale) => exportMemberDirectoryCsv(client, context, locale),
  } : null), [client]);
  // hidden | ready | failed: a failed first page offers Retry, not a dead card.
  const [state, setState] = useState({ status: "hidden", page: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ status: "hidden", page: null });
    if (!api) return undefined;
    (async () => {
      try {
        const access = await loadMemberDirectoryAccess(client);
        if (!access.canRead) return;
      } catch (failure) {
        // Hidden on a refusal or before the probe is deployed; a transient
        // failure offers Retry like a failed directory page.
        if (live && !HIDDEN_PROBE_CODES.has(failure?.code)) setState({ status: "failed", page: null });
        return;
      }
      try {
        const page = await api.loadMemberDirectory("", null);
        if (live) setState({ status: "ready", page });
      } catch {
        if (live) setState({ status: "failed", page: null });
      }
    })();
    return () => { live = false; };
  }, [api, client, attempt]);

  if (state.status === "failed") {
    return <article id={sectionName || "officer-member-directory"} className={`${PLANE_CARD_CLASS} xus-card`}>
      <WorkspaceCardHead title={t("admin.command.directoryTitle")}><header className="xus-cardhead">
        <div className="xus-cardhead__copy"><h2 className="xus-cardttl">{t("admin.command.directoryTitle")}</h2></div>
      </header></WorkspaceCardHead>
      <div className="xus-cardbody xus-inline">
        <p className="xus-note xus-note--error" role="alert">{t("admin.command.directoryUnavailable")}</p>
        <button type="button" className="xus-btn" onClick={() => setAttempt((value) => value + 1)}>{t("app.tryAgain")}</button>
      </div>
    </article>;
  }
  if (state.status !== "ready") return null;
  return <DirectoryCard initial={state.page} api={api} officer sectionName={sectionName} />;
}
