// The knowledge workspace's shared presentation primitives.
//
// KnowledgeWorkspacePanel kept these private, so KnowledgeConversionReviewCard
// re-implemented the card header/body and the empty paragraph verbatim -- which
// is how its pre-cutover hint ended up outside the card's 16px gutter, and how
// three of the card's four review states ended up as unstyled text. They live
// here rather than in the panel because the panel imports the card, so a card
// importing them back from the panel is an import cycle, and a panel that only
// re-exported them would add unused exports -- scripts/verify-static-quality.mjs
// refuses both. The panel IMPORTS them from here rather than re-exporting them,
// so this module, not KnowledgeWorkspacePanel, is their named owner.

export function Card({ title, sub, icon: Icon, children }) {
  return <article className="knowledge-workspace__card">
    <header className="knowledge-workspace__head">
      <span className="knowledge-workspace__icon" aria-hidden="true"><Icon size={18} /></span>
      <div><h3>{title}</h3><p>{sub}</p></div>
    </header>
    <div className="knowledge-workspace__body">{children}</div>
  </article>;
}

// `value` is a raw column token that the pill capitalizes. `children` is an
// already-translated phrase, which must not be re-capitalized, so it carries
// the `--phrase` modifier; every state of one list uses the same one, because a
// pill styled for one state out of four reads as an inconsistency and not as
// emphasis.
export function Status({ value, children }) {
  if (children !== undefined) {
    return <span className="knowledge-workspace__status knowledge-workspace__status--phrase">{children}</span>;
  }
  return <span className="knowledge-workspace__status">{String(value || "unset").replaceAll("_", " ")}</span>;
}

export function Empty({ children }) {
  return <p className="knowledge-workspace__empty">{children}</p>;
}
