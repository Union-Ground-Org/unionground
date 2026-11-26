import { useLang } from "../lib/LanguageContext.jsx";
import { useWorkspace, workspaceHref } from "./WorkspacePages.jsx";

// BUG-UG-NO-CHAPTER-PAGES-GO-BLANK-OR-BLAME-PERMISSIONS-20261122
// (#9594): a new organization starts with its founder and no chapter, and the
// admin pages that need one went blank or blamed the reader's scope or desk.
// Every such page says the same thing and links to the same place, where the
// first chapter is added.
const NO_CHAPTER_DESTINATION = "/m/admin/organization";

// True only when the organization-wide read lists no chapter at all. A
// chapter-scoped desk, or a read that failed (null), is never "no chapter".
export function organizationHasNoChapter(organization) {
  return organization?.scope === "organization"
    && Array.isArray(organization.chapters)
    && organization.chapters.length === 0;
}

// `link` is false on Organization & chapters itself, where Add chapter sits
// beside the sentence.
// `xus-btn--wrap`: the label is longer than a 320 px card, and a plain
// `xus-btn` never wraps, so it ran past the card's edge.
export function NoChapterYetNotice({ link = true }) {
  const { t } = useLang();
  const workspace = useWorkspace();
  return <div className="xus-note" role="note" data-no-chapter-yet="">
    <p>{t("admin.noChapterYet.body")}</p>
    {link && <div className="xus-btnrow">
      <a className="xus-btn xus-btn--wrap" href={workspaceHref(NO_CHAPTER_DESTINATION)} onClick={(event) => {
        if (!workspace || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        workspace.open(NO_CHAPTER_DESTINATION);
      }}>{t("admin.noChapterYet.link")}</a>
    </div>}
  </div>;
}
