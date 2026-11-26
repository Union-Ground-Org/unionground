import { useId } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { useLang } from "../lib/LanguageContext.jsx";

// BUG-UG-CHAPTER-ROLES-HIDDEN-UNTIL-CHAPTER-SWITCH-20261003: the
// desktop Chapters rail is not mounted on tablet or phone, so My chapter
// carries the same switch for a member who belongs to more than one chapter.
// `chapters` are the member's own memberships (normalizeLiveChapters), never a
// catalog; a member with one chapter sees nothing new.
export function ChapterMembershipSwitch({ chapters = [], selectedId = null, onSelect, busy = false }) {
  const { t } = useLang();
  const headingId = useId();
  if (chapters.length < 2 || typeof onSelect !== "function") return null;
  return (
    <section className="chapter-switch" aria-labelledby={headingId} aria-busy={busy ? "true" : undefined}>
      <h2 id={headingId} className="chapter-switch__title">{t("chapterRail.yours")}</h2>
      <div className="chapter-switch__list">
        {chapters.map((chapter) => (
          <BusyButton
            type="button"
            key={chapter.id}
            className={`hub2-btn ${chapter.id === selectedId ? "hub2-btn--primary" : "hub2-btn--ghost"} chapter-switch__choice`}
            aria-pressed={chapter.id === selectedId ? "true" : "false"}
            aria-label={t("chapterRail.open", { name: chapter.name })}
            pending={busy}
            onClick={() => onSelect(chapter)}
          >
            {chapter.name}
          </BusyButton>
        ))}
      </div>
    </section>
  );
}
