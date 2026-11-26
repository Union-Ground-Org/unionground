// The prototype's Campaign page (pages/campaign.js) under the alternate shell
// (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030), drawn on the collective
// actions model CollectiveActionsView loads and with its handlers: join and
// withdraw, edit, export, load more and the create form all run the view's
// own server calls. The day-by-day strip lays the published actions' own
// participation windows over the 30 days around today. The prototype's
// campaign-day counter and campaign demand have no record behind them, so
// they keep their place with an honest empty state.
import { useState } from "react";
import { DIGITAL_ACTION_PARTICIPATION_KINDS, digitalActionParticipationKind } from "../../features/organizationIntelligence/contract.js";
import { StaffAuthoringHint } from "../../components/StaffAuthoringHint.jsx";
import { formatDateTimeWithZone } from "../../lib/i18n/zonedDates.js";
import { localeFor } from "../../lib/i18n.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { Icon } from "../icons.jsx";
import { formatDay, formatNumber, formatShortDay } from "../format.js";
import { TakePartHero } from "./TakePartHero.jsx";
import "../../lib/i18n/features/altTakePartStrings.js";
import { BusyButton } from "../../components/BusyControls.jsx";

const STRIP_DAYS = 30;
// Days before today on the strip; the rest are today and what is coming.
const STRIP_LEAD = 7;
const STATUS_TAG = { published: "ug-t-win", closed: "ug-t-vote", draft: "ug-t-meeting", cancelled: "ug-t-rights" };

const stamp = (value) => {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// The strip's days: each lists the published (or closed) actions whose
// participation window touches it, and which of them open or close that day.
// An action with neither a start nor an end has no place on a calendar.
export function stripDays(actions, now = new Date()) {
  const scheduled = actions.filter((action) => (action.status === "published" || action.status === "closed") && (stamp(action.startsAt) != null || stamp(action.endsAt) != null));
  return Array.from({ length: STRIP_DAYS }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index - STRIP_LEAD);
    const start = date.getTime();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index - STRIP_LEAD + 1).getTime();
    const running = scheduled.filter((action) => {
      const from = stamp(action.startsAt);
      const to = stamp(action.endsAt);
      return (from == null || from < end) && (to == null || to >= start);
    });
    const within = (value) => value != null && value >= start && value < end;
    return {
      index,
      date,
      today: index === STRIP_LEAD,
      future: index > STRIP_LEAD,
      running,
      opens: running.filter((action) => within(stamp(action.startsAt))),
      closes: running.filter((action) => within(stamp(action.endsAt))),
    };
  });
}

export function CampaignPage({ lang, copy, model, loading, stateMessage, notice, busyKey, onRetry, onToggleJoin, onEdit, onExport, onLoadMore, moreFailed = false, createForm, onOpenHome, windowOf, now = null }) {
  const { t } = useLang();
  const [picked, setPicked] = useState(STRIP_LEAD);
  const ready = model?.state === "ready";
  const actions = ready ? model.actions : [];
  const live = actions.filter((action) => action.status === "published");
  const openNow = live.filter((action) => windowOf(action) === "open");
  const joinedOpen = openNow.filter((action) => action.viewerParticipation).length;
  const joinedAll = actions.filter((action) => action.viewerParticipation).length;
  const counted = live.filter((action) => typeof action.participantCount === "number");
  const people = counted.reduce((sum, action) => sum + action.participantCount, 0);
  const days = stripDays(actions, now ?? new Date());
  const day = days[picked];
  const share = openNow.length ? Math.round((100 * joinedOpen) / openNow.length) : 0;
  const kindOf = (kind) => copy.participationKinds[kind] || kind;
  const weekday = (date, style) => date.toLocaleDateString(localeFor(lang), { weekday: style });
  const number = (value) => (ready ? formatNumber(value, lang) : "—");

  const kpi = (key, value, sub, extra = null) => (
    <div className="ug-kpi" key={key}>
      <dt><small>{t(`altTakePart.kpi_${key}`)}</small></dt>
      <dd><b className="ug-tnum">{value}</b>{sub ? <span>{sub}</span> : null}{extra}</dd>
    </div>
  );

  const actionCard = (action) => {
    const joined = Boolean(action.viewerParticipation);
    const joinWindow = action.status === "published" ? windowOf(action) : null;
    const strength = typeof action.strengthPercent === "number" ? action.strengthPercent : null;
    return (
      <article className="ug-ta-action" key={action.id} aria-labelledby={`ug-action-${action.id}`}>
        <div className="ug-ta-card-top">
          <span className="ug-ta-who">
            <span className="ug-tag ug-t-action">{copy.kinds[action.kind] || action.kind}</span>
            <span className={`ug-tag ${STATUS_TAG[action.status] ?? "ug-t-bargaining"}`}>{copy[action.status] ?? action.status}</span>
          </span>
        </div>
        <h3 id={`ug-action-${action.id}`}>{action.title}</h3>
        {action.summary ? <p className="ug-ta-muted">{action.summary}</p> : null}
        <div className="ug-ta-turnout-line ug-ta-gap">
          <span>{action.participantCount === null ? <b>{copy.withheld}</b> : <><b className="ug-tnum">{action.participantCount}</b> {copy.strength}</>}</span>
          <span>{action.targetCount} {copy.target}</span>
        </div>
        {strength !== null ? (
          <div className="ug-progress" role="progressbar" aria-label={copy.participation} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, strength)}>
            <i style={{ width: `${Math.min(100, strength)}%` }} />
          </div>
        ) : null}
        {joinWindow === "open" && !joined && action.viewerCanJoin === false ? <p className="ug-ta-muted">{copy.chapterOnlyJoin}</p> : null}
        {joinWindow === "open" && (joined || action.viewerCanJoin !== false) ? (
          <BusyButton
            type="button"
            role="checkbox"
            aria-checked={joined}
            className={`ug-opt ug-ta-join${joined ? " ug-done" : ""}`}
            pending={Boolean(busyKey)}
            onClick={() => onToggleJoin(action)}
          >
            <span className="ug-box"><Icon name="check" /></span>
            <span className="ug-ta-grow">
              <b>{busyKey === `join-${action.id}` ? copy.saving : copy.join}</b>
              <span>{joined ? `${copy.joined} · ${kindOf(action.viewerParticipation)} · ${t("altTakePart.partWithdraw")}` : kindOf(digitalActionParticipationKind(action.kind))}</span>
            </span>
          </BusyButton>
        ) : null}
        {joined && joinWindow !== "open" ? <p className="ug-ta-muted">{copy.joined} · {kindOf(action.viewerParticipation)}</p> : null}
        {joinWindow === "upcoming" ? <p className="ug-ta-muted">{copy.windowOpens.replace("{date}", formatDateTimeWithZone(action.startsAt, lang))}</p> : null}
        {joinWindow === "ended" ? <p className="ug-ta-muted">{copy.windowEnded}</p> : null}
        {action.viewerCanEdit ? <button type="button" className="ug-btn ug-btn-soft ug-btn-xs ug-ta-gap" onClick={() => onEdit(action)}>{copy.save}</button> : null}
        {model.exportAllowed ? (
          <details className="ug-ta-export">
            <summary>{copy.export}</summary>
            <div className="ug-btn-row">
              {DIGITAL_ACTION_PARTICIPATION_KINDS.map((kind) => <BusyButton key={kind} type="button" className="ug-link" pending={Boolean(busyKey)} onClick={() => onExport(action, kind)}>{kindOf(kind)}</BusyButton>)}
            </div>
          </details>
        ) : model.manageAllowed ? <p className="ug-ta-muted">{model.manageScope === "chapter" ? copy.exportOrganizationOnly : copy.exportDenied}</p> : null}
      </article>
    );
  };

  const dayTitle = (item) => item.opens[0]?.title ?? item.closes[0]?.title ?? "";
  const dayLabel = (item) => [
    `${weekday(item.date, "long")}, ${formatDay(item.date, lang, { year: true })}${item.today ? ` · ${t("altTakePart.today")}` : ""}`,
    item.running.length ? item.running.map((action) => action.title).join(", ") : t("altTakePart.dayNothing"),
  ].join(": ")
    + (item.opens.length ? `, ${t("altTakePart.dayOpens")}` : "")
    + (item.closes.length ? `, ${t("altTakePart.dayCloses")}` : "");

  return (
    <div className="ug-ta-page ug-ta-campaign" data-mi1-surface="collective-actions">
      <TakePartHero
        crumb={t("altTakePart.campaignCrumb")}
        lead={t("altTakePart.campaignH1Lead")}
        accent={t("altTakePart.campaignH1Accent")}
        lede={t("altTakePart.campaignLede")}
        onOpenHome={onOpenHome}
      />
      <section className="ug-wrap" aria-label={t("altTakePart.campaignFigures")}>
        <dl className="ug-kpis ug-ta-kpis">
          {kpi("day", "—", t("altTakePart.kpi_daySub"))}
          {kpi("open", number(openNow.length), ready ? t("altTakePart.kpi_openSub", { count: formatNumber(live.length, lang) }) : "")}
          {kpi("joined", number(joinedAll), ready ? t("altTakePart.kpi_joinedSub", { joined: formatNumber(joinedOpen, lang), open: formatNumber(openNow.length, lang) }) : "",
            ready ? <div className="ug-progress ug-ta-kpi-bar" aria-hidden="true"><i style={{ width: `${share}%` }} /></div> : null)}
          {kpi("people", ready && counted.length ? formatNumber(people, lang) : "—", ready ? (counted.length ? t("altTakePart.kpi_peopleSub", { count: formatNumber(counted.length, lang) }) : t("altTakePart.kpi_peopleNone")) : "")}
        </dl>
        <div className="ug-panel ug-ta-strip" aria-labelledby="ug-campaign-days">
          <div className="ug-tl-head ug-ta-report-head">
            <h2 id="ug-campaign-days">{t("altTakePart.daysTitle")}</h2>
            <div className="ug-legend">
              <span><i className="ug-ta-dot" style={{ background: "var(--ug-act)" }} />{t("altTakePart.dayOpensLegend")}</span>
              <span><i className="ug-ta-dot" style={{ background: "var(--ug-terra)" }} />{t("altTakePart.dayClosesLegend")}</span>
            </div>
          </div>
          <div className="ug-days30" role="group" aria-label={t("altTakePart.daysTitle")}>
            {days.map((item) => (
              <button
                key={item.index}
                type="button"
                className={`ug-d30${item.today ? " ug-today" : ""}${item.future ? " ug-future" : ""}`}
                aria-pressed={picked === item.index}
                aria-label={dayLabel(item)}
                onClick={() => setPicked(item.index)}
              >
                <small><span className="ug-d30-l">{weekday(item.date, "short")} </span>{item.date.getDate()}</small>
                <b>{dayTitle(item)}</b>
                <span className="ug-dd">
                  <span className="ug-pips" aria-hidden="true">
                    {item.opens.length ? <i style={{ background: "var(--ug-act)" }} /> : null}
                    {item.closes.length ? <i style={{ background: "var(--ug-terra)" }} /> : null}
                  </span>
                  <span>{formatShortDay(item.date, lang)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="ug-panel-w ug-ta-day" aria-live="polite">
          <div className="ug-ta-card-top">
            <h3>{weekday(day.date, "long")}, {formatDay(day.date, lang, { year: true })}{day.today ? ` · ${t("altTakePart.today")}` : ""}</h3>
          </div>
          {day.running.length ? (
            <ul className="ug-list">
              {day.running.map((action) => (
                <li className="ug-li" key={action.id}>
                  <span className="ug-av ug-av-sm ug-ta-av" aria-hidden="true"><Icon name="megaphone" /></span>
                  <span>
                    <b>{action.title}</b>
                    <span>
                      {day.opens.includes(action) ? t("altTakePart.dayOpens") : day.closes.includes(action) ? t("altTakePart.dayCloses") : t("altTakePart.dayRunning")}
                    </span>
                  </span>
                  <span className="ug-tag ug-t-action">{copy.kinds[action.kind] || action.kind}</span>
                </li>
              ))}
            </ul>
          ) : <p className="ug-ta-muted">{t("altTakePart.dayNone")}</p>}
        </div>
      </section>
      <section className="ug-wrap ug-split ug-ta-split" aria-label={t("altTakePart.partTitle")}>
        <div className="ug-panel ug-ta-part">
          <h2>{t("altTakePart.partTitle")}</h2>
          {notice ? <div className="ug-note ug-ta-gap-b" role="status"><Icon name="info" /><span>{notice}</span></div> : null}
          {!ready || loading ? (
            <div className="ug-empty ug-ta-empty" role="status">
              <b>{stateMessage}</b>
              {!loading ? <button type="button" className="ug-btn ug-btn-soft ug-btn-sm ug-ta-gap" onClick={onRetry}>{copy.retry}</button> : null}
            </div>
          ) : null}
          {ready ? (
            <>
              <p className="ug-ta-panel-lede">{t("altTakePart.partLede")}</p>
              {actions.length ? <div className="ug-ta-actions">{actions.map(actionCard)}</div> : (
                <>
                  <div className="ug-empty ug-ta-empty"><b>{copy.noActions}</b>{t("altTakePart.partNoneBody")}</div>
                  {!model.manageAllowed ? <div className="ug-legacy"><StaffAuthoringHint item="actions" className="oi-state staff-authoring-hint" buttonClassName="oi-button oi-button--secondary" /></div> : null}
                </>
              )}
              {model.hasMore ? <BusyButton type="button" className="ug-btn ug-btn-soft ug-btn-sm ug-ta-gap" pending={Boolean(busyKey)} onClick={onLoadMore}>{busyKey === "load-more" ? copy.loadingMore : copy.loadMore}</BusyButton> : null}
              {model.hasMore && moreFailed ? <p role="alert">{copy.loadMoreFailed}</p> : null}
              {openNow.length ? (
                <div className="ug-ta-gap">
                  <div className="ug-ta-turnout-line"><span>{t("altTakePart.partProgress", { joined: formatNumber(joinedOpen, lang), open: formatNumber(openNow.length, lang) })}</span><span>{share}%</span></div>
                  <div className="ug-progress" aria-hidden="true"><i style={{ width: `${share}%` }} /></div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <aside className="ug-panel ug-ta-demand" aria-labelledby="ug-campaign-demand">
          <h3 id="ug-campaign-demand">{t("altTakePart.demandTitle")}</h3>
          <div className="ug-empty ug-ta-empty"><b>{t("altTakePart.statsNotYet")}</b>{t("altTakePart.demandEmpty")}</div>
        </aside>
      </section>
      {createForm ? <section className="ug-wrap ug-ta-form-wrap"><div className="ug-legacy">{createForm}</div></section> : null}
    </div>
  );
}
