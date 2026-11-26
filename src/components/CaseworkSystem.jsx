export function CaseworkTag({ children, tone = "secondary" }) {
  return <span className={`casework-tag casework-tag--${tone}`}>{children}</span>;
}

export function CaseworkSectionHeader({ id, index, eyebrow, title, description, meta = null }) {
  return (
    <header className="casework-section-head">
      <span className="casework-section-head__key" aria-hidden="true">{index}</span>
      <div className="casework-section-head__copy">
        <span className="casework-section-head__eyebrow">{eyebrow}</span>
        <h2 id={id}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {meta && <div className="casework-section-head__meta">{meta}</div>}
    </header>
  );
}
