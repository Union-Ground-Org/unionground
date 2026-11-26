import { useLayoutEffect, useRef } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { staffItemHref } from "../lib/staffNavigation.js";
import { NavGlyph } from "./NavGlyphs.jsx";
import { Dialog } from "./Dialog.jsx";

// The chapter context sheet (owner voice spec, 2026-08-05): on phones the
// Work card's chapter chip opens this sheet instead of a desktop-style side
// rail. It names the chapter the account belongs to and lists the
// chapter-scoped surfaces that exist today. Rides the shared Dialog so it
// keeps the bottom-sheet rise, modal isolation, and Escape handling every
// other overlay has.
//
// Honesty note, load-bearing: the product has exactly ONE chapter per member
// (data.member.chapterId is a fixed membership fact; every chapter-scoped
// table is RLS-bound to it). The spec's multi-chapter list — search, recents,
// pinned — needs a membership model the schema does not have, so this sheet
// renders the single real chapter as the current context and is shaped to
// take a list when that model ships. It must not grow a fake switcher first.

function ToolRow({ item, onNavigate, onClose }) {
  const { t } = useLang();
  const { viewKey = item.key, path, sectionId } = item;
  return (
    <a
      className="morehub-row morehub-row--nav"
      href={staffItemHref(item)}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onClose();
        onNavigate(viewKey, path, sectionId);
      }}
    >
      <span className="morehub-row__icon" aria-hidden="true">
        {item.key === "campaigns" ? <NavGlyph name={item.key} fallback={item.icon} /> : item.icon}
      </span>
      <span className="morehub-row__label">{t(item.labelKey)}</span>
      <span className="morehub-row__chev" aria-hidden="true">›</span>
    </a>
  );
}

// Chapter-scoped member surfaces that exist today. Staff additions (the
// chapter-work desk) arrive through the `tools` prop so role gating stays in
// App, next to every other role gate.
const CHAPTER_MEMBER_TOOLS = [
  { key: "hub", labelKey: "nav.myChapter", path: "/m/organize/organize", icon: "⌂" },
  { key: "network", viewKey: "coordination", labelKey: "nav.network", path: "/m/network", icon: "◎" },
  { key: "events", labelKey: "morehub.events", path: "/m/events", icon: "📅" },
  { key: "voice", labelKey: "morehub.beHeard", path: "/m/voice", icon: "📣" },
  { key: "pay", labelKey: "nav.pay", path: "/m/pay", icon: "💲" },
  { key: "voting", labelKey: "nav.voting", path: "/m/voting", icon: "🗳" },
];

export function ChapterSheet({
  chapterName, // the account's one real chapter
  memberTools = true, // false when an explicit staff hat owns the phone shell
  dues = true, // false only when the organization runs no dues (duesNavigation.js)
  tools = null, // optional role-gated additions (e.g. Chapter work)
  onNavigate,
  onClose,
}) {
  const { t } = useLang();
  const memberRows = dues ? CHAPTER_MEMBER_TOOLS : CHAPTER_MEMBER_TOOLS.filter((item) => item.key !== "dues");
  const rows = [...(memberTools ? memberRows : []), ...(tools ?? [])];
  // The shared Dialog manages isolation but not focus return. Capture the
  // opener (the Work card's chapter chip) before isolation inerts it —
  // layout effect, so it runs ahead of the Dialog's — and hand focus back
  // on close. Navigating away unmounts the chip; isConnected skips it then.
  const openerRef = useRef(null);
  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
    };
  }, []);
  return (
    <Dialog eyebrow={t("chapter.sheetTitle")} title={chapterName} onClose={onClose}>
      <div className="chapter-sheet__current">
        <span className="morehub-row__icon" aria-hidden="true">⌂</span>
        <span className="chapter-sheet__name">
          <strong>{chapterName}</strong>
          <small>{t("chapter.currentSub")}</small>
        </span>
      </div>
      {/* One membership is the whole list today; said plainly rather than
          dressed up as a switcher. */}
      <p className="chapter-sheet__note">{t("chapter.singleNote")}</p>
      <h3 className="morehub-eyebrow">{t("chapter.tools")}</h3>
      <div className="morehub-list">
        {rows.map((item) => (
          <ToolRow key={item.key} item={item} onNavigate={onNavigate} onClose={onClose} />
        ))}
      </div>
    </Dialog>
  );
}
