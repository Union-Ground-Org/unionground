// How one quote or mini-lesson reads to a member. Home, the Learn library and
// the editor preview all render through here, so a preview shows exactly what
// a member would see. Text is rendered as plain text, never as markup.
export function LearningContentBody({ item, tr, headingId, headingLevel = 3, expanded = true, showSource = false, showTitle = true }) {
  const Heading = { 2: "h2", 4: "h4" }[headingLevel] ?? "h3";
  const title = showTitle ? <Heading id={headingId} className="lc-body__title">{item.title}</Heading> : null;
  if (item.kind === "quote") {
    return (
      <div className="lc-body lc-body--quote">
        {title}
        <blockquote className="lc-body__quote"><p>{item.body}</p></blockquote>
        {item.attribution ? <p className="lc-body__attribution">{tr("home.attribution", { name: item.attribution })}</p> : null}
        {showSource && item.source ? <p className="lc-body__source">{tr("library.source", { source: item.source })}</p> : null}
      </div>
    );
  }
  return (
    <div className="lc-body lc-body--lesson">
      {title}
      <p className={`lc-body__text${expanded ? "" : " lc-body__text--clamped"}`}>{item.body}</p>
      {expanded && item.bullets.length > 0 ? (
        <div className="lc-body__points">
          <p className="lc-body__label">{tr("library.keyPoints")}</p>
          <ul>{item.bullets.map((bullet, index) => <li key={`${index}-${bullet}`}>{bullet}</li>)}</ul>
        </div>
      ) : null}
      {expanded && item.learning_outcome ? (
        <p className="lc-body__outcome"><span className="lc-body__label">{tr("library.outcome")}</span> {item.learning_outcome}</p>
      ) : null}
      {expanded && item.attribution ? <p className="lc-body__attribution">{tr("home.attribution", { name: item.attribution })}</p> : null}
      {expanded && showSource && item.source ? <p className="lc-body__source">{tr("library.source", { source: item.source })}</p> : null}
    </div>
  );
}

// A lesson carries more than its first lines when it has key points, an
// outcome or a long body; only then does Home offer "Read more".
export function lessonHasMore(item) {
  return item.kind === "mini_lesson" && (item.bullets.length > 0 || Boolean(item.learning_outcome) || Boolean(item.attribution) || [...item.body].length > 180);
}
