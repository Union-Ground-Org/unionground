import { Children } from "react";
import "./pageHeader.css";

export function PageHeader({ title, titleId, eyebrow, purpose, action, children, toolbar = false, className = "" }) {
  const hasActions = Boolean(action) || Children.toArray(children).length > 0;
  return <header className={`phead sg-page-header${toolbar ? " phead--toolbar" : ""} ${className}`.trim()}>
    <div className="phead__copy">
      {eyebrow && <span className="phead__eyebrow">{eyebrow}</span>}
      <h1 id={titleId} className="phead__title">{title}</h1>
      {purpose && <p className="phead__sub">{purpose}</p>}
    </div>
    {hasActions && <div className="phead__actions">{action}{children}</div>}
  </header>;
}
