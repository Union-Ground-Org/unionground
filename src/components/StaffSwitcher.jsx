import { useLang } from "../lib/LanguageContext.jsx";
import { STAFF_PLANES, planeRoles } from "../lib/staffPlanes.js";

// Isolated staff-plane strip over the shared STAFF_PLANES table. App no longer
// mounts this on the empty SaaS origin — Switch hat is SAMPLE-only. Keep the
// component for unit coverage of the strip itself. planeRoles admits the
// organize plane for organizers and the staff roles that supervise them.
export function StaffSwitcher({ roles, activeView, onNavigate }) {
  const { t } = useLang();
  const planes = STAFF_PLANES.filter((plane) => planeRoles(plane).some((role) => roles.includes(role)));
  if (planes.length === 0) return null;
  const onMemberPlane = !planes.some((plane) => plane.view === activeView);
  return (
    <div className="staff-switcher" role="group" aria-label={t("staff.switcherLabel")}>
      <button type="button" aria-pressed={onMemberPlane} onClick={() => onNavigate("today", "/m")}>{t("demo.hatWorker")}</button>
      {planes.map((plane) => (
        <button type="button" key={plane.key} aria-pressed={activeView === plane.view} onClick={() => onNavigate(plane.view, plane.path)}>{t(plane.labelKey)}</button>
      ))}
    </div>
  );
}
