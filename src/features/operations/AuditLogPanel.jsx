import { ClipboardList } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { dateTimeFormat, t } from "../../lib/i18n.js";
import { AUDIT_ACTIONS, AUDIT_DOMAINS, AUDIT_SOURCES, isAuditSinkSource, isAuditSource } from "./auditEnvelope.js";
import { AUDIT_SINK_KINDS } from "./auditProjection.js";
import { PREPARED_KNOWLEDGE_UPLOAD_LABEL, isPreparedKnowledgeUpload } from "./auditEventLabel.js";

const LEDGER_SOURCE = "organization_audit_ledger";
const INVITATION_EVENT_LABELS = new Map([
  ["invitation.reinvite_requested", "operations.audit.reinviteRequested"],
  ["invitation.reinvite_accepted", "operations.audit.reinviteAccepted"],
  ["invitation.role_cleared", "operations.audit.invitationRoleCleared"],
]);

// A date input carries a calendar day, not an instant. The start of the day is
// inclusive and the end is the last millisecond of it, so a single-day filter
// selects that whole day in the caller's own reading of the timestamp.
function dayStartIso(value) {
  return value ? `${value}T00:00:00.000Z` : null;
}

function dayEndIso(value) {
  return value ? `${value}T23:59:59.999Z` : null;
}

function isoToDayInput(value) {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : "";
}

// The unified ledger reader also returns donor source names that are not a
// selectable source. They stay readable rather than printing a missing
// translation key at the member-facing surface.
function sourceLabel(lang, source) {
  const name = source || LEDGER_SOURCE;
  return isAuditSource(name) ? t(lang, `operations.audit.source.${name}`) : readableToken(name);
}

function shortReference(id) {
  return String(id).split("-").at(-1)?.slice(-6).toUpperCase() || "——";
}

// A scheduled job has no person behind it. Its event carries no actor, and a
// scheduled retention run names the admin whose standing policy enabled it as
// metadata.userId, so the ledger shows the Scheduler acting and that admin only
// as the standing authorization, never as the one who deleted the rows.
// REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030: a person
// the administrator's organization knows is named; the short reference stays
// only for someone the name reader could not name.
function personReference(userId, names) {
  const name = names?.[userId];
  return typeof name === "string" && name.trim() ? name.trim() : shortReference(userId);
}

export function actorReference(event, lang, names = {}) {
  const userId = event.actorUserId;
  if (!userId && event.metadata?.mode === "scheduled") {
    const standing = event.metadata.userId;
    return standing
      ? t(lang, "operations.audit.schedulerStanding", { actor: personReference(standing, names) })
      : t(lang, "operations.audit.scheduler");
  }
  if (!userId) return t(lang, "operations.audit.system");
  return `${t(lang, "operations.audit.actor")} · ${personReference(userId, names)}`;
}

// Every person a ledger page names: its actors and a scheduled run's standing admin.
export function auditActorIds(events = []) {
  return [...new Set(events.flatMap((event) => [event?.actorUserId, event?.metadata?.mode === "scheduled" ? event.metadata.userId : null])
    .filter((id) => typeof id === "string" && id))];
}

function entityReference(event) {
  if (!event.entityId) return event.entityType;
  const suffix = String(event.entityId).split("-").at(-1)?.slice(-6).toUpperCase();
  return suffix ? `${event.entityType} · ${suffix}` : event.entityType;
}

function readableToken(value) {
  return String(value || "").replaceAll("_", " ").replaceAll(".", " · ");
}

// A prepared steward library upload is not an upload yet (#8545).
function eventLabel(event, lang) {
  if (isPreparedKnowledgeUpload(event)) return t(lang, PREPARED_KNOWLEDGE_UPLOAD_LABEL);
  const label = INVITATION_EVENT_LABELS.get(event.eventType);
  return label ? t(lang, label) : readableToken(event.eventType);
}

function readableTimestamp(value, lang) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t(lang, "operations.audit.timeUnavailable");
  return dateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function AuditLogPanel({
  state = "loading",
  events = [],
  filters = {},
  sources = AUDIT_SOURCES,
  onFilterChange,
  onRetry,
  onLoadOlder,
  hasOlder = false,
  actorNames = {},
}) {
  const { lang } = useLang();
  const source = filters.source || LEDGER_SOURCE;
  const sinkSelected = isAuditSinkSource(source);
  const kinds = sinkSelected ? AUDIT_SINK_KINDS[source] : [];
  const readableSources = sources.length ? sources : AUDIT_SOURCES;
  const sinceDay = isoToDayInput(filters.since);
  const untilDay = isoToDayInput(filters.until);
  const rangeInverted = Boolean(sinceDay && untilDay && sinceDay > untilDay);
  // Selecting a different source drops the filters that source cannot honour.
  // Carrying a ledger domain onto a sink reader, or a sink kind onto the
  // ledger, would ask the database for a filter it refuses with 22023.
  const selectSource = (next) => onFilterChange?.({
    ...filters,
    source: next || null,
    domain: next && next !== LEDGER_SOURCE ? null : (filters.domain ?? null),
    action: next && next !== LEDGER_SOURCE ? null : (filters.action ?? null),
    kind: null,
  });
  return (
    <article id="admin-organization-audit" className="plane-card xus-card role-section-target" tabIndex="-1">
      <header className="xus-cardhead">
        <span className="xus-glyph" aria-hidden="true"><ClipboardList size={18} /></span>
        <div className="xus-cardhead__copy">
          <h3 className="xus-cardttl">{t(lang, "operations.audit.title")}</h3>
          <p className="xus-cardsub">{t(lang, "operations.audit.sub")}</p>
        </div>
      </header>

      <div className="xus-cardbody">
        <form className="xus-searchrow" aria-label={t(lang, "operations.audit.filtersLegend")} onSubmit={(event) => event.preventDefault()}>
          <label className="xus-field">
            {t(lang, "operations.audit.source")}
            <select
              className="xus-input"
              value={filters.source ?? ""}
              onChange={(event) => selectSource(event.target.value)}
            >
              <option value="">{t(lang, "operations.audit.allSources")}</option>
              {readableSources.map((option) => (
                <option key={option} value={option}>{sourceLabel(lang, option)}</option>
              ))}
            </select>
          </label>
          <label className="xus-field">
            {t(lang, "operations.audit.domain")}
            <select
              className="xus-input"
              disabled={sinkSelected}
              value={filters.domain ?? ""}
              onChange={(event) => onFilterChange?.({ ...filters, domain: event.target.value || null })}
            >
              <option value="">{t(lang, "operations.audit.allDomains")}</option>
              {AUDIT_DOMAINS.map((domain) => (
                <option key={domain} value={domain}>{domain}</option>
              ))}
            </select>
          </label>
          <label className="xus-field">
            {t(lang, "operations.audit.action")}
            <select
              className="xus-input"
              disabled={sinkSelected}
              value={filters.action ?? ""}
              onChange={(event) => onFilterChange?.({ ...filters, action: event.target.value || null })}
            >
              <option value="">{t(lang, "operations.audit.allActions")}</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
          </label>
          <label className="xus-field">
            {t(lang, "operations.audit.kind")}
            <select
              className="xus-input"
              disabled={!sinkSelected}
              value={filters.kind ?? ""}
              onChange={(event) => onFilterChange?.({ ...filters, kind: event.target.value || null })}
            >
              <option value="">{t(lang, "operations.audit.allKinds")}</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>{readableToken(kind)}</option>
              ))}
            </select>
          </label>
          <label className="xus-field">
            {t(lang, "operations.audit.from")}
            <input
              type="date"
              className="xus-input"
              value={sinceDay}
              onChange={(event) => onFilterChange?.({ ...filters, since: dayStartIso(event.target.value) })}
            />
          </label>
          <label className="xus-field">
            {t(lang, "operations.audit.to")}
            <input
              type="date"
              className="xus-input"
              value={untilDay}
              onChange={(event) => onFilterChange?.({ ...filters, until: dayEndIso(event.target.value) })}
            />
          </label>
        </form>
        {rangeInverted && (
          <p className="xus-note xus-note--error" role="alert">{t(lang, "operations.audit.dateRangeInvalid")}</p>
        )}
      </div>

      {state === "loading" && (
        <div className="xus-cardbody"><p className="xus-note" role="status">{t(lang, "operations.audit.loading")}</p></div>
      )}
      {state === "error" && (
        <div className="xus-cardbody xus-inline">
          <p className="xus-note" role="alert">{t(lang, "operations.audit.error")}</p>
          <button type="button" className="xus-btn" onClick={onRetry}>{t(lang, "operations.audit.retry")}</button>
        </div>
      )}
      {state === "empty" && (
        <div className="xus-cardbody"><p className="xus-note" role="status">{t(lang, "operations.audit.empty")}</p></div>
      )}
      {state === "unavailable" && (
        <div className="xus-cardbody"><p className="xus-note" role="status">{t(lang, "operations.audit.unavailable")}</p></div>
      )}
      {state === "mfa" && (
        <div className="xus-cardbody xus-inline">
          <p className="xus-note" role="status">{t(lang, "operations.audit.mfa")}</p>
          <button type="button" className="xus-btn" onClick={onRetry}>{t(lang, "operations.audit.retry")}</button>
        </div>
      )}
      {state === "ready" && events.map((event) => (
        <div key={event.id || event.idempotencyKey} className="xus-arow">
          <p className="xus-atext">
            {readableToken(event.domain)} · {eventLabel(event, lang)} — {actorReference(event, lang, actorNames)} · {entityReference(event)}
          </p>
          <small className="xus-atime">
            {sourceLabel(lang, event.source)} · {readableTimestamp(event.occurredAt, lang)}
          </small>
        </div>
      ))}
      {state === "ready" && hasOlder && (
        <div className="xus-cardbody">
          <button type="button" className="xus-btn" onClick={onLoadOlder}>{t(lang, "operations.audit.older")}</button>
        </div>
      )}
    </article>
  );
}
