import { AlertTriangle, Bell, Bot, Inbox, LayoutGrid, Unplug } from "lucide-react";
import { FlowValue } from "./FlowValue.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { formatCount } from "../lib/formatCount.js";
import "./stateBlock.css";

export function ScreenHeader({ initials, eyebrow, title, notifications = 0, compact = false, onProfile, onNotifications, onMenu, onAssistant }) {
  const { t } = useLang();
  return (
    <header className={`screen-header ${compact ? "screen-header--compact" : ""}`}>
      <button className="avatar" type="button" aria-label={`${initials} ${t("header.profile")}`} onClick={onProfile}>{initials}</button>
      <div className="screen-header__copy">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {(!compact || onAssistant) && (
        <div className="screen-header__actions">
          {!compact && <button className="icon-button" type="button" aria-label={t("header.more")} onClick={onMenu}><LayoutGrid size={19} /></button>}
          {onAssistant && <button className="icon-button" type="button" aria-label={t("header.assistant")} onClick={onAssistant}><Bot size={19} /></button>}
          {!compact && <button className="icon-button notification-button" type="button" aria-label={t("header.notifications", { count: notifications })} onClick={onNotifications}><Bell size={19} />{notifications > 0 && <span>{notifications}</span>}</button>}
        </div>
      )}
    </header>
  );
}

export function SectionTitle({ children, sub }) {
  return (
    <header className="section-title">
      <h2>{children}</h2>
      {sub && <p>{sub}</p>}
    </header>
  );
}

export function StatCard({ label, value, suffix, delta, tone = "gold" }) {
  // FlowValue animates what it is given; whole counts arrive grouped in the
  // viewer's language ("1,506", BUG-UG-DESK-COUNTS-NO-THOUSANDS-SEPARATOR-20261106).
  const { lang } = useLang();
  return (
    <article className="stat-card">
      <div className="stat-card__top">
        <span className="eyebrow">{label}</span>
        {delta && <span className={`delta delta--${tone}`}>{delta}</span>}
      </div>
      <strong><FlowValue value={formatCount(value, lang)} /><small>{suffix}</small></strong>
    </article>
  );
}

export function EmptyState({ children }) {
  return <div className="empty-state">{children}</div>;
}

// The October 2 design's one empty state and one error state
// (reports/chosen-direction/build-order.md section 3, "State block"): a tile, a
// title naming the thing, one sentence and one next step. The error kind adds
// what is safe and a smaller line for when it keeps happening. It replaces a
// page's body, never its header. Colours are today's tokens, so the identity
// swap restyles it without touching callers.
//
// The "unavailable" kind is the Lovable audit's status state (Batch A pattern
// 1, REQ-UG-LOVABLE-AUDIT-WEBAPP-FIXES-20261103): a page that cannot
// show its content says why, gives a next step as a real link (`links`, each
// { label, href, onClick }; the first is the primary one) and, in `hint`, who
// can fix it. It is announced as a status, never as an error.
export function StateBlock({ kind = "empty", title, body, safe, hint, actionLabel, onAction, links = null, headingLevel = 2 }) {
  const Icon = kind === "error" ? AlertTriangle : kind === "unavailable" ? Unplug : Inbox;
  const Heading = `h${headingLevel}`;
  return (
    <section className={`state-block state-block--${kind}`} data-state-block={kind} role={kind === "unavailable" ? "status" : undefined}>
      <span className="state-block__tile" aria-hidden="true"><Icon size={26} strokeWidth={2} /></span>
      <Heading className="state-block__title">{title}</Heading>
      {body && <p className="state-block__body">{body}</p>}
      {safe && <p className="state-block__body">{safe}</p>}
      {actionLabel && onAction && (
        <button type="button" className="state-block__action" onClick={onAction}>{actionLabel}</button>
      )}
      {links?.length > 0 && (
        <div className="state-block__links">
          {links.map((link, index) => (
            <a key={link.href} href={link.href} onClick={link.onClick} className={`state-block__action${index === 0 ? " state-block__action--primary" : ""}`}>{link.label}</a>
          ))}
        </div>
      )}
      {hint && <p className="state-block__hint">{hint}</p>}
    </section>
  );
}
