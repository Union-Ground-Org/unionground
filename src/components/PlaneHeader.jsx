import { PageHeader } from "./PageHeader.jsx";
import { Button } from "./Button.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { formatCount } from "../lib/formatCount.js";

// Wave 2e: the prototype's staff-plane page anatomy, shared by every plane so
// the five dashboards cannot drift apart (the Wave-2d shared-logo lesson applied to
// chrome). Two pieces:
//
//   PlaneHeader — staff-plane data and action slots rendered through the shared
//   28px serif PageHeader, with a purpose line and trailing actions slot. Replaces both ScreenHeader-on-planes and the
//   steward desk's .strip-head, which retires with this wave.
//
//   PlaneKpi — the prototype's accent-left KPI tile (.stat with a 3px
//   border-left). Tiles remain plain summaries by default, but become honest
//   disclosure buttons when a backed drill-down is supplied.
//
// The prototype paints these cards with a subtle top-tint gradient; the repo
// bans that property family outright (guards outrank pixel parity), so the
// surface is flat var(--card). Recorded in the wave manifest.

// initials/onProfile/onAssistant: staff hats render with no rail and no mobile
// top bar on desktop, so on some planes this strip is the ONLY place the
// profile dialog and Compass can be reached. Each button renders only when its
// callback is passed — partial wiring gets honest chrome, not dead controls.
//
// toolbar: declared by the planes whose actions slot is a full toolbar (Case
// queue's search row, the work tool's chip-and-buttons row). At phone widths
// the phead--toolbar modifier hands the copy the whole first line and lets the
// toolbar wrap beneath it — an explicit class rather than :has() because the
// Safari 14 build floor has no :has() and would keep the crushed-title layout
// otherwise.
export function PlaneHeader({ title, eyebrow = null, sub = null, chapterName = null, children = null, initials = null, onProfile = null, onAssistant = null, toolbar = false }) {
  const { t } = useLang();
  return (
    <PageHeader title={title} eyebrow={chapterName ? [chapterName, eyebrow].filter(Boolean).join(" · ") : eyebrow} purpose={sub} toolbar={toolbar}>
      {children}
      {onAssistant && (
        <Button variant="secondary" size="small" className="phead__btn phead__btn--assistant" aria-label={t("header.assistant")} title={t("header.assistant")} onClick={onAssistant}>
          {/* The glyph alone has no visible purpose; the tooltip names it
              for pointer users (Lovable audit APP-ADMIN-01, APP-STEWARD-06). */}
          <span aria-hidden="true">✦</span>
        </Button>
      )}
      {initials && onProfile && (
        <Button variant="quiet" size="small" className="phead__btn phead__btn--avatar" aria-label={`${initials} ${t("header.profile")}`} onClick={onProfile}>
          {initials}
        </Button>
      )}
    </PageHeader>
  );
}

// tone: green | gold | danger | terra — the four accent rails the prototype's
// staff KPIs actually use. The gold sub line swaps the rail colour for
// --gold-ink (gold itself fails 4.5:1 as text on the card); the other three
// rails are certified text inks on the card and paint the sub directly.
// suffix: a unit that reads with the number ("71 % of quorum"), set smaller
// beside it so the figure stays the headline.
//
// Every staff desk draws its headline numbers with this one tile; a desk
// theme must not restyle it (UB-UG-STAFF-DESK-STAT-CARDS-THREE-TREATMENTS-20261108).
export function PlaneKpi({ label, value, suffix = null, sub = null, tone = "green", active = false, controls = null, onClick = null }) {
  const { lang } = useLang();
  const content = (
    <>
      <div className="pkpi__label">{label}</div>
      {suffix
        ? <div className="pkpi__value pkpi__value--suffixed"><span>{formatCount(value, lang)}</span><small className="pkpi__suffix">{suffix}</small></div>
        : <div className="pkpi__value">{formatCount(value, lang)}</div>}
      {sub && <div className="pkpi__sub">{sub}</div>}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={`pkpi pkpi--${tone} pkpi--interactive`}
        aria-expanded={active}
        aria-controls={controls || undefined}
        onClick={onClick}
        data-reactive-depth="tile"
      >
        {content}
      </button>
    );
  }
  return <div className={`pkpi pkpi--${tone}`}>{content}</div>;
}
