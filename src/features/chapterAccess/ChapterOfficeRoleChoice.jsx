import { useLang } from "../../lib/LanguageContext.jsx";
import { chapterOfficeRoles, selectedChapterOfficeRole } from "../../lib/chapterOfficeRoles.js";

export function ChapterOfficeRoleChoice({ roles, selectedHat, onSelect }) {
  const { t } = useLang();
  const held = chapterOfficeRoles(roles);
  if (!held.length || !onSelect) return null;
  return <label className="institutional-form">{t("access.actingRole")}
    <select value={selectedChapterOfficeRole(roles, selectedHat) || "member"} onChange={(event) => onSelect(event.target.value)}>
      <option value="member">{t("demo.hatMember")}</option>
      {held.map((role) => <option key={role} value={role}>{t(`access.role.${role}`)}</option>)}
    </select>
  </label>;
}
