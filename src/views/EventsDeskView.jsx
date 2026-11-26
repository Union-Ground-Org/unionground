import { EventAuthoringCard } from "../components/EventAuthoringCard.jsx";
import { PlaneHeader } from "../components/PlaneHeader.jsx";
import { EmptyState } from "../components/Primitives.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { useDesk } from "../lib/useDesk.js";

// UB-EVT-06. Event authoring is a staff TOOL, not a plane: it carries no hat
// and no role of its own, and any of the five staff hats may open it — the same
// shape Tasks has had since 2026-07-27.
//
// It deliberately does NOT reuse loadAdminDesk. That loader also calls the
// roster, audit, MFA and reward-queue RPCs, every one of which is still
// admin-only; a steward opening this desk would take a 42501 on the first of
// them and see an empty screen. loadEventsDesk reads the one RPC the five hats
// are now allowed.
//
// Like the admin desk, a chapter switch fences the tool until the new scope
// commits, and the scope key mounts a fresh desk so no draft, late save or
// event row from the old chapter survives the switch.
export function EventsDeskView({ scope = "", chapterTransition = null, onRetryChapter, ...props }) {
  const { t } = useLang();
  if (chapterTransition) return (
    <div className="screen">
      <PlaneHeader title={t("eventsDesk.navLabel")} sub={t("eventsDesk.sub")} />
      {chapterTransition === "error" ? <EmptyState>
        <p role="alert">{t("eventsDesk.chapterRefreshFailed")}</p>
        <button type="button" className="xus-btn admin-panel-retry" onClick={onRetryChapter}>{t("app.tryAgain")}</button>
      </EmptyState> : <p className="empty-state" role="status">{t("eventsDesk.loading")}</p>}
    </div>
  );
  return <EventsDesk key={scope} {...props} />;
}

function EventsDesk({ api, onNotice, chapterName = "", renderConnectedActions = null }) {
  const { t } = useLang();
  const { desk, error, load } = useDesk(api);

  return (
    <div className="screen">
      <PlaneHeader title={t("eventsDesk.navLabel")} sub={t("eventsDesk.sub")} />
      {error
        ? <p className="xus-eline" role="alert">{t("toast.loadFailed")}</p>
        : (
          <EventAuthoringCard
            events={desk?.events || []}
            api={api}
            onNotice={onNotice}
            reload={load}
            titleKey="eventsDesk.title"
            subKey="eventsDesk.sub"
            emptyKey="eventsDesk.empty"
            chapterName={chapterName}
            showHeading={false}
            loading={desk === null && !error}
            renderConnectedActions={renderConnectedActions}
          />
        )}
    </div>
  );
}
