import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, BellRing, CalendarDays, CheckCircle2, Download, FileClock, MapPin, Pin, Plus, RefreshCw, Send, Users } from "lucide-react";
import { Dialog } from "../../components/Dialog.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { dateTimeFormat, formatDateTimeWithZone } from "../../lib/i18n.js";
import { withLoadDeadline } from "../../lib/loadDeadline.js";
import {
  attachMinutesToMeeting,
  clearMinutesPreEventNotice,
  downloadOrganizationExport,
  loadInstitutionalRecordsWorkspace,
  loadMeetingsForMinutes,
  loadMinutesMeetingCheckins,
  loadMinutesPreEventNotices,
  requestOrganizationExport,
  saveChapterContactLog,
  saveInstitutionalRecord,
  saveMinutesPreEventNotice,
  setChapterMinutesApproval,
  saveChapterMinutes,
} from "../../lib/institutionalRecordsApi.js";
import { isConflictRefusalCode } from "../../lib/memberApiError.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

const SECTIONS = ["minutes", "timeline", "contacts", "exports"];
const EXPORT_DOMAINS = ["members", "cases", "tasks", "minutes", "timeline", "contacts"];

function localDateTime(value = new Date().toISOString()) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function recordStatus(record) {
  return record.lifecycle_status || "published";
}

function findTimelineGaps(records) {
  const ordered = [...records].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const gaps = [];
  ordered.forEach((record, index) => {
    if (record.gap_note) gaps.push({ id: `note-${record.id}`, label: record.gap_note, after: record.title });
    const next = ordered[index + 1];
    if (!next) return;
    const days = Math.floor((new Date(next.occurred_at) - new Date(record.occurred_at)) / 86400000);
    if (days >= 183) gaps.push({ id: `${record.id}-${next.id}`, days, after: record.title });
  });
  return gaps;
}

function WorkspaceEmpty({ children }) {
  return <p className="institutional-empty">{children}</p>;
}

export function InstitutionalRecordsPanel({ client, fallbackRecords = [], canStaff = false, onNotice = () => {}, openIntent = null }) {
  const { t, lang } = useLang();
  const [section, setSection] = useState("minutes");
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(Boolean(client));
  const [error, setError] = useState("");
  const [editor, setEditor] = useState(null);
  const [preEvent, setPreEvent] = useState(null);
  const [meetings, setMeetings] = useState(null);
  // Each refresh owns the whole read chain; retired reads cannot settle any
  // part of the current workspace, including after the panel unmounts.
  const refreshRequest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++refreshRequest.current;
    if (!client) return;
    setLoading(true);
    setError("");
    try {
      // Bounded like the shell: a read that never answers becomes the error
      // card with Refresh instead of a permanent "Loading" line.
      const loaded = await withLoadDeadline(loadInstitutionalRecordsWorkspace(client));
      if (request !== refreshRequest.current) return;
      setWorkspace(loaded);
      // Staff only, and two soft reads: the records stay usable when the notice
      // read is unavailable (the card then offers no notice control at all),
      // and the same holds for the meetings minutes attach to (the events desk
      // list). They do not depend on each other, so they run together instead
      // of one after the other (REQ-UG-PAGE-LOADING-STALLS-20261030).
      const [nextPreEvent, nextMeetings] = canStaff && loaded?.canManage
        ? await Promise.all([
          withLoadDeadline(loadMinutesPreEventNotices(client)).catch(() => null),
          withLoadDeadline(loadMeetingsForMinutes(client)).catch(() => null),
        ])
        : [null, null];
      if (request !== refreshRequest.current) return;
      setPreEvent(nextPreEvent);
      setMeetings(nextMeetings);
    }
    catch { if (request === refreshRequest.current) setError(t("records.loadFailed")); }
    finally { if (request === refreshRequest.current) setLoading(false); }
  }, [client, t, canStaff]);

  useEffect(() => {
    refresh();
    return () => { refreshRequest.current += 1; };
  }, [refresh]);

  // An authorized minutes notice opened while this panel is already mounted
  // reloads the workspace and shows Minutes. The intent present at mount is
  // already served by the mount load above, so only a later one acts here, and
  // each repeat (a new id) acts again. The notice's source-chapter match and
  // the backend's authorization are decided before the intent exists.
  const handledIntent = useRef(openIntent?.id ?? 0);
  useEffect(() => {
    if (!openIntent || openIntent.path !== "/m/organize/record" || openIntent.id === handledIntent.current) return;
    handledIntent.current = openIntent.id;
    setSection("minutes");
    refresh();
  }, [openIntent, refresh]);

  const records = workspace?.records || fallbackRecords;
  const minutes = records.filter((record) => ["minutes", "meeting"].includes(record.record_type));
  const timeline = records.filter((record) => ["decision", "milestone", "correspondence"].includes(record.record_type));
  const legacyContacts = records.filter((record) => ["management_contact", "member_contact"].includes(record.record_type));
  const gaps = useMemo(() => findTimelineGaps(timeline), [timeline]);
  const effectiveStaff = canStaff && (workspace?.canManage ?? true);
  const visibleSections = SECTIONS.filter((item) => (item === "contacts" ? (workspace?.canContacts ?? effectiveStaff) : item === "exports" ? workspace?.canExport : true));

  async function saveRecord(fields) {
    const original = workspace?.records?.find((record) => record.id === fields.recordId);
    const storedScope = original?.access_unit_id ? `unit:${original.access_unit_id}` : original?.access_committee_id ? `committee:${original.access_committee_id}` : "";
    const scoped = { ...fields, ...(workspace?.chapterId ? {
      expectedChapter: workspace.chapterId, expectedOrganization: workspace.organizationId,
      accessScope: Object.hasOwn(fields, "accessScope") ? fields.accessScope : storedScope,
    } : {}) };
    // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: a changed
    // location is saved with the record in one version-checked transaction,
    // so a refused save leaves both as they were. Archiving never writes it.
    const locationChanged = fields.action !== "archive" && fields.recordType === "minutes"
      && (fields.location || "") !== (fields.previousLocation || "");
    if (locationChanged) {
      // That transaction saves through save_institutional_record, which keeps
      // the record's stored access scope, so a scope change cannot ride along.
      // A new record is first created as a draft in its chosen scope, then the
      // minutes save adds the location and the chosen action in that scope. An
      // existing record's scope change is refused rather than saved wider.
      if ((scoped.accessScope ?? storedScope) !== storedScope) {
        if (original) throw new Error("Save the access scope and the location separately");
        const created = await saveInstitutionalRecord(client, { ...scoped, action: "save" });
        await saveChapterMinutes(client, { ...scoped, recordId: created.id, expectedVersion: created.version });
      } else await saveChapterMinutes(client, scoped);
    } else await saveInstitutionalRecord(client, scoped);
    setEditor(null);
    onNotice(fields.action === "publish" ? t("records.published") : t("records.saved"));
    await refresh();
  }

  async function approveMinutes(record, approved) {
    try {
      await setChapterMinutesApproval(client, record.id, record.version || 1, approved);
      onNotice(t(approved ? "records.approvedNotice" : "records.approvalRemoved"));
      await refresh();
    } catch (failure) {
      // A newer version was saved since this card loaded: show it first.
      onNotice(t(isConflictRefusalCode(failure?.code) ? "records.approvalStaleRefused" : "records.approvalFailed"), true);
      if (isConflictRefusalCode(failure?.code)) await refresh();
    }
  }

  async function saveContact(fields) {
    await saveChapterContactLog(client, fields);
    setEditor(null);
    onNotice(t("records.contactSaved"));
    await refresh();
  }

  async function savePreEvent(fields) {
    await saveMinutesPreEventNotice(client, fields);
    setEditor(null);
    onNotice(t("preEvent.saved"));
    await refresh();
  }

  async function clearPreEvent(recordId) {
    await clearMinutesPreEventNotice(client, recordId);
    setEditor(null);
    onNotice(t("preEvent.removed"));
    await refresh();
  }

  async function attachMeeting(recordId, eventId) {
    await attachMinutesToMeeting(client, recordId, eventId);
    setEditor(null);
    onNotice(t(eventId ? "records.meetingAttached" : "records.meetingDetached"));
    await refresh();
  }

  return <section className="institutional" data-mi1-surface="institutional-records">
    <div className="institutional-head">
      <div>
        <p className="institutional-kicker">{t("records.kicker")}</p>
        <h2>{t("records.title")}</h2>
        <p>{t("records.sub")}</p>
      </div>
      {client && <button type="button" className="institutional-refresh" onClick={refresh} disabled={loading}><RefreshCw size={16} />{t("records.refresh")}</button>}
    </div>
    <div className="institutional-tabs" role="group" aria-label={t("records.sections")}>
      {visibleSections.map((item) => <button type="button" key={item} aria-pressed={section === item} onClick={() => setSection(item)}>{t(`records.section.${item}`)}</button>)}
    </div>
    {error && <p className="institutional-error" role="alert">{error}</p>}
    {loading ? <WorkspaceEmpty>{t("records.loading")}</WorkspaceEmpty> : <>
      {section === "minutes" && <RecordsList
        records={minutes}
        type="minutes"
        canStaff={effectiveStaff && Boolean(client)}
        t={t}
        lang={lang}
        preEvent={effectiveStaff && client ? preEvent : null}
        onCreate={() => setEditor({ kind: "record", recordType: "minutes" })}
        onEdit={(record) => setEditor({ kind: "record", record })}
        onPreEvent={(record) => setEditor({ kind: "preEvent", record })}
        meetings={effectiveStaff && client ? meetings : null}
        onMeeting={(record) => setEditor({ kind: "meeting", record })}
        roster={workspace?.roster || []}
        onApprove={client ? approveMinutes : null}
      />}
      {section === "timeline" && <TimelineList
        records={timeline}
        gaps={gaps}
        canStaff={effectiveStaff && Boolean(client)}
        t={t}
        lang={lang}
        onCreate={() => setEditor({ kind: "record", recordType: "milestone" })}
        onEdit={(record) => setEditor({ kind: "record", record })}
      />}
      {section === "contacts" && <ContactLedger
        contacts={workspace?.contacts || []}
        legacyRecords={legacyContacts}
        t={t}
        lang={lang}
        onCreate={() => setEditor({ kind: "contact" })}
        onEdit={(contact) => setEditor({ kind: "contact", contact })}
      />}
      {section === "exports" && <ExportBuilder client={client} runs={workspace?.exportRuns || []} t={t} lang={lang} onNotice={onNotice} onRefresh={refresh} />}
    </>}
    {editor?.kind === "record" && <RecordEditor
      t={t}
      roster={workspace?.roster || []}
      scopes={workspace?.recordScopes || []}
      canManageUnscoped={workspace?.canManageUnscoped !== false}
      record={editor.record}
      recordType={editor.recordType}
      onLoadCheckins={client ? (recordId) => loadMinutesMeetingCheckins(client, recordId) : null}
      onClose={() => setEditor(null)}
      onSave={saveRecord}
    />}
    {editor?.kind === "contact" && <ContactEditor t={t} roster={workspace?.roster || []} contact={editor.contact} onClose={() => setEditor(null)} onSave={saveContact} />}
    {editor?.kind === "preEvent" && preEvent && <PreEventNoticeEditor
      t={t}
      lang={lang}
      record={editor.record}
      config={preEvent}
      notice={(preEvent.notices || []).find((item) => item.recordId === editor.record.id) || null}
      onClose={() => setEditor(null)}
      onSave={savePreEvent}
      onClear={clearPreEvent}
    />}
    {editor?.kind === "meeting" && meetings && <MeetingAttachEditor
      t={t}
      lang={lang}
      record={editor.record}
      meetings={meetings}
      onClose={() => setEditor(null)}
      onSave={attachMeeting}
    />}
  </section>;
}

function preEventSummary(notice, t, lang) {
  if (!notice) return "";
  const when = notice.eventStartsAt ? dateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(notice.eventStartsAt)) : "";
  if (notice.status === "sent") return t("preEvent.sent", { event: notice.eventTitle || "", count: notice.recipientCount || 0 });
  if (notice.status === "expired") return t(`preEvent.expired.${notice.outcome || "event_started"}`, { event: notice.eventTitle || "" });
  return t("preEvent.scheduled", { event: notice.eventTitle || "", when });
}

function minutesApproved(record) {
  return Boolean(record?.approved_at) && record.approved_version === (record.version || 1);
}

function RecordsList({ records, type, canStaff, t, lang, preEvent = null, onCreate, onEdit, onPreEvent = () => {}, meetings = null, onMeeting = () => {}, roster = [], onApprove = null }) {
  const nameById = new Map((roster || []).map((member) => [member.userId, member.name]));
  const notices = new Map((preEvent?.notices || []).map((notice) => [notice.recordId, notice]));
  const meetingById = new Map((meetings || []).map((meeting) => [meeting.id, meeting]));
  return <div className="institutional-section">
    <SectionHead title={t("records.minutesTitle")} action={canStaff ? t("records.newMinutes") : null} onAction={onCreate} />
    {canStaff && preEvent && !preEvent.enabled && <p className="institutional-followup">{t("preEvent.turnedOff")}</p>}
    {records.length === 0 ? <WorkspaceEmpty>{t("records.minutesEmpty")}</WorkspaceEmpty> : records.map((record) => <article className="institutional-card" key={record.id}>
      <div className="institutional-card__top">
        <div><span className={`institutional-status institutional-status--${recordStatus(record)}`}>{t(`records.status.${recordStatus(record)}`)}</span><h3>{record.title}</h3></div>
        {canStaff && record.canManage !== false && <button type="button" onClick={() => onEdit(record)}>{t("records.edit")}</button>}
      </div>
      <p>{record.body}</p>
      <div className="institutional-meta">
        <span><FileClock size={15} />{new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(record.occurred_at))}</span>
        <span>{t("records.version", { count: record.version || 1 })}</span>
        {canStaff && record.dispatch && <span><Send size={15} />{t("records.dispatch", { count: Number(record.dispatch.delivered) || 0 })}</span>}
        {canStaff && type === "minutes" && <span><Users size={15} />{t("records.attendance", { count: record.attendance?.length || 0 })}</span>}
        {canStaff && preEvent && notices.has(record.id) && <span data-pre-event-status={notices.get(record.id).status}><BellRing size={15} />{preEventSummary(notices.get(record.id), t, lang)}</span>}
        {canStaff && meetingById.has(record.event_id) && <span data-minutes-meeting={record.event_id}><CalendarDays size={15} />{t("records.meeting", { event: meetingById.get(record.event_id).title })}</span>}
        {record.location && <span data-minutes-location><MapPin size={15} />{t("records.locationLine", { location: record.location })}</span>}
        {type === "minutes" && minutesApproved(record) && <span data-minutes-approved><CheckCircle2 size={15} />{nameById.has(record.approved_by)
          ? t("records.approvedBy", { date: new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(record.approved_at)), name: nameById.get(record.approved_by) })
          : t("records.approvedOn", { date: new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(record.approved_at)) })}</span>}
        {type === "minutes" && canStaff && record.approved_at && !minutesApproved(record) && <span data-minutes-approval-stale>{t("records.approvalStale", { version: record.approved_version })}</span>}
      </div>
      {canStaff && onApprove && type === "minutes" && recordStatus(record) === "published" && <button type="button" className="institutional-refresh" onClick={() => onApprove(record, !minutesApproved(record))}><CheckCircle2 size={16} />{t(minutesApproved(record) ? "records.removeApproval" : "records.markApproved")}</button>}
      {canStaff && preEvent?.enabled && type === "minutes" && recordStatus(record) !== "archived" && <button type="button" className="institutional-refresh" onClick={() => onPreEvent(record)}><BellRing size={16} />{t(notices.has(record.id) ? "preEvent.change" : "preEvent.add")}</button>}
      {canStaff && meetings && record.record_type === "minutes" && recordStatus(record) !== "archived" && <button type="button" className="institutional-refresh" onClick={() => onMeeting(record)}><CalendarDays size={16} />{t(meetingById.has(record.event_id) ? "records.changeMeeting" : "records.attachMeeting")}</button>}
      {(record.versions || []).length > 1 && <details><summary>{t("records.versionHistory")}</summary><ol>{record.versions.map((version) => <li key={version.version}>v{version.version} · {t(`records.status.${version.lifecycle_status}`)}</li>)}</ol></details>}
    </article>)}
  </div>;
}

function TimelineList({ records, gaps, canStaff, t, lang, onCreate, onEdit }) {
  return <div className="institutional-section">
    <SectionHead title={t("records.timelineTitle")} action={canStaff ? t("records.newTimeline") : null} onAction={onCreate} />
    {canStaff && <aside className="institutional-gaps" aria-label={t("records.gapsTitle")}><strong>{t("records.gapsTitle")}</strong>{gaps.length === 0 ? <span>{t("records.noGaps")}</span> : <ul>{gaps.map((gap) => <li key={gap.id}>{gap.label || t("records.gapDays", { count: gap.days })}</li>)}</ul>}</aside>}
    {records.length === 0 ? <WorkspaceEmpty>{t("records.timelineEmpty")}</WorkspaceEmpty> : <div className="institutional-timeline">{records.map((record) => <article key={record.id} className="institutional-timeline__item">
      <span className="institutional-timeline__dot" aria-hidden="true" />
      <div>
        <div className="institutional-card__top"><div>{record.pinned_at && <span className="institutional-pin"><Pin size={13} />{t("records.pinned")}</span>}<h3>{record.title}</h3></div>{canStaff && record.canManage !== false && <button type="button" onClick={() => onEdit(record)}>{t("records.edit")}</button>}</div>
        <p>{record.body}</p><small>{new Intl.DateTimeFormat(lang, { dateStyle: "long" }).format(new Date(record.occurred_at))} · {t(`records.status.${recordStatus(record)}`)}</small>
      </div>
    </article>)}</div>}
  </div>;
}

function ContactLedger({ contacts, legacyRecords, t, lang, onCreate, onEdit }) {
  return <div className="institutional-section">
    <SectionHead title={t("records.contactsTitle")} action={t("records.newContact")} onAction={onCreate} />
    {contacts.length === 0 && legacyRecords.length === 0 ? <WorkspaceEmpty>{t("records.contactsEmpty")}</WorkspaceEmpty> : contacts.map((contact) => <article className="institutional-card" key={contact.id}>
      <div className="institutional-card__top"><div><span className="institutional-status">{t(`records.contactKind.${contact.contact_kind}`)}</span><h3>{contact.purpose}</h3></div><button type="button" onClick={() => onEdit(contact)}>{t("records.edit")}</button></div>
      <p>{contact.summary}</p>
      <div className="institutional-meta"><span>{contact.subjectName || t("records.noSubject")}</span><span>{t(`records.channel.${contact.channel}`)}</span><span>{new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(contact.occurred_at))}</span></div>
      {contact.follow_up_at && <p className="institutional-followup">{t("records.followUp")}: {new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(contact.follow_up_at))}</p>}
    </article>)}
    {legacyRecords.map((record) => <article className="institutional-card" key={record.id}>
      <div className="institutional-card__top"><div><span className="institutional-status">{t("records.legacyContact")}</span><h3>{record.title}</h3></div></div>
      <p>{record.body}</p>
      <div className="institutional-meta"><span>{new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(record.occurred_at))}</span><span>{t("records.version", { count: record.version || 1 })}</span></div>
    </article>)}
  </div>;
}

function SectionHead({ title, action, onAction }) {
  return <div className="institutional-section__head"><h3>{title}</h3>{action && <button type="button" className="institutional-primary" onClick={onAction}><Plus size={16} />{action}</button>}</div>;
}

function RecordEditor({ record, recordType, roster, scopes, canManageUnscoped, t, onClose, onSave, onLoadCheckins = null }) {
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435), keyed by the record the write changes.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const [type, setType] = useState(record?.record_type || recordType || "minutes");
  const recordScopes = scopes.filter((scope) => scope.records);
  const chooseScope = recordScopes.length > 0 || !canManageUnscoped;
  const scopeTag = (scope) => scope?.unitId ? `unit:${scope.unitId}` : scope?.committeeId ? `committee:${scope.committeeId}` : "";
  const initialScope = record?.access_unit_id ? `unit:${record.access_unit_id}` : record?.access_committee_id ? `committee:${record.access_committee_id}` : canManageUnscoped ? "" : scopeTag(recordScopes[0]);
  const retainScope = initialScope && !recordScopes.some((scope) => scopeTag(scope) === initialScope);
  const [attendanceStatus, setAttendanceStatus] = useState(() => Object.fromEntries((record?.attendance || []).map((item) => [item.userId, item.status])));
  const [checkinNote, setCheckinNote] = useState("");
  // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: attendance
  // from the attached meeting's check-ins, marked present without clearing
  // anything already recorded.
  async function fillFromCheckins() {
    try {
      const checkedIn = new Set(await onLoadCheckins(record.id));
      const present = roster.filter((member) => checkedIn.has(member.userId));
      setAttendanceStatus((current) => ({ ...current, ...Object.fromEntries(present.map((member) => [member.userId, "present"])) }));
      setCheckinNote(t("records.checkinsFilled", { count: present.length }));
    } catch { setCheckinNote(t("records.checkinsFailed")); }
  }
  function submit(event, action) {
    return runBusyWrite(busyWriteRef, `record:${record?.id ?? "new"}`, () => submitNow(event, action), event);
  }

  async function submitNow(event, action) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget.closest("form") || event.currentTarget;
    const data = new FormData(form);
    const attendance = type === "minutes" ? roster.flatMap((member) => {
      const status = attendanceStatus[member.userId];
      return status ? [{ userId: member.userId, status }] : [];
    }) : [];
    setBusy(true); setError("");
    try { await onSave({ recordId: record?.id, expectedVersion: record?.version, recordType: data.get("recordType"), title: data.get("title"), body: data.get("body"), occurredAt: new Date(data.get("occurredAt")).toISOString(), visibility: data.get("visibility"), pinned: data.get("pinned") === "on", gapNote: data.get("gapNote"), attendance, action, ...(type === "minutes" ? { location: String(data.get("location") || "").trim(), previousLocation: record?.location || "" } : {}), ...(chooseScope ? { accessScope: data.get("accessScope") } : {}) }); }
    catch { setError(t("records.saveFailed")); }
    finally { setBusy(false); }
  }
  return <Dialog eyebrow={t("records.kicker")} title={record ? t("records.editRecord") : t("records.newRecord")} onClose={onClose} wide>
    <form className="institutional-form" onSubmit={(event) => submit(event, "save")}>
      {chooseScope && <label>{t("access.scope")}<select className="chapter-access-record-scope" name="accessScope" defaultValue={initialScope} required={!canManageUnscoped}>{canManageUnscoped && <option value="">{t("access.chapter")}</option>}{retainScope && <option value={initialScope}>{t("access.currentScope")}</option>}{recordScopes.map((scope) => <option key={`${scope.role}:${scopeTag(scope)}`} value={scopeTag(scope)}>{scope.name}</option>)}</select></label>}
      <label>{t("records.type")}<select name="recordType" value={type} onChange={(event) => setType(event.target.value)}><option value="minutes">{t("records.type.minutes")}</option><option value="decision">{t("records.type.decision")}</option><option value="milestone">{t("records.type.milestone")}</option></select></label>
      <label>{t("records.recordTitle")}<input name="title" maxLength="200" defaultValue={record?.title || ""} required /></label>
      <label>{t("records.body")}<textarea name="body" maxLength="20000" defaultValue={record?.body || ""} required /></label>
      <label>{t("records.date")}<input type="datetime-local" name="occurredAt" defaultValue={localDateTime(record?.occurred_at)} required /></label>
      {type === "minutes" && <label>{t("records.location")}<input name="location" maxLength="200" defaultValue={record?.location || ""} /></label>}
      <label>{t("records.visibility")}<select name="visibility" defaultValue={record?.visibility || "chapter"}><option value="chapter">{t("records.visibilityChapter")}</option><option value="staff">{t("records.visibilityStaff")}</option></select></label>
      <label>{t("records.gapNote")}<textarea name="gapNote" maxLength="1000" defaultValue={record?.gap_note || ""} /></label>
      <label className="institutional-check"><input type="checkbox" name="pinned" defaultChecked={Boolean(record?.pinned_at)} />{t("records.pin")}</label>
      {type === "minutes" && <fieldset className="institutional-attendance"><legend>{t("records.attendanceTitle")}</legend>{onLoadCheckins && record?.event_id && <p className="institutional-followup"><button type="button" className="institutional-refresh" onClick={fillFromCheckins}><Users size={16} />{t("records.fillFromCheckins")}</button>{checkinNote && <span role="status"> {checkinNote}</span>}</p>}{roster.map((member) => <label key={member.userId}><span>{member.name}</span><select name={`attendance-${member.userId}`} value={attendanceStatus[member.userId] || ""} onChange={(event) => setAttendanceStatus((current) => ({ ...current, [member.userId]: event.target.value }))}><option value="">{t("records.notRecorded")}</option><option value="present">{t("records.present")}</option><option value="absent">{t("records.absent")}</option><option value="excused">{t("records.excused")}</option><option value="guest">{t("records.guest")}</option></select></label>)}</fieldset>}
      {error && <p className="institutional-error" role="alert">{error}</p>}
      <div className="institutional-actions">
        {record && <BusyButton type="button" className="institutional-danger" pending={busy} onClick={(event) => submit(event, "archive")}><Archive size={16} />{t("records.archive")}</BusyButton>}
        <BusyButton type="submit" pending={busy}>{t("records.saveDraft")}</BusyButton>
        <BusyButton type="button" className="institutional-primary" pending={busy} onClick={(event) => submit(event, "publish")}><Send size={16} />{t("records.publish")}</BusyButton>
      </div>
    </form>
  </Dialog>;
}

// REQ-UG-MINUTES-PRE-EVENT-DISPATCH-20261001: the old events form's
// "Minutes / agenda share" block (audience + hours before), attached to a
// minutes record and one of the chapter's upcoming meetings.
function PreEventNoticeEditor({ record, config, notice, t, lang, onClose, onSave, onClear }) {
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435), keyed by the record the write changes.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const events = config.events || [];
  const staffOnly = record.visibility === "staff";
  const pendingEvent = notice && events.some((event) => event.id === notice.eventId) ? notice.eventId : "";
  function submit(event) {
    return runBusyWrite(busyWriteRef, `notice:${record.id}`, () => submitNow(event), event);
  }

  async function submitNow(event) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      await onSave({ recordId: record.id, eventId: data.get("eventId"), audience: data.get("audience"), hoursBefore: data.get("hoursBefore") });
    } catch { setError(t("preEvent.saveFailed")); }
    finally { setBusy(false); }
  }
  function remove() {
    return runBusyWrite(busyWriteRef, `notice:${record.id}`, () => removeNow());
  }

  async function removeNow() {
    if (busy) return;
    setBusy(true); setError("");
    try { await onClear(record.id); }
    catch { setError(t("preEvent.saveFailed")); }
    finally { setBusy(false); }
  }
  return <Dialog eyebrow={t("preEvent.eyebrow")} title={record.title} onClose={onClose}>
    <form className="institutional-form" onSubmit={submit}>
      <p>{t("preEvent.help")}</p>
      {events.length === 0 ? <p className="institutional-followup">{t("preEvent.noMeetings")}</p> : <>
        <label>{t("preEvent.meeting")}<select name="eventId" defaultValue={pendingEvent} required><option value="">{t("preEvent.chooseMeeting")}</option>{events.map((event) => <option key={event.id} value={event.id}>{event.title} · {dateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.startsAt))}</option>)}</select></label>
        <label>{t("preEvent.audience")}<select name="audience" defaultValue={notice?.audience || (staffOnly ? "stewards_only" : "all_members")}>{!staffOnly && <option value="all_members">{t("preEvent.audience.all_members")}</option>}<option value="stewards_only">{t("preEvent.audience.stewards_only")}</option></select></label>
        <label>{t("preEvent.hours")}<input type="number" name="hoursBefore" min="1" max="336" step="1" inputMode="numeric" defaultValue={notice?.hoursBefore ?? ""} placeholder={String(config.defaultHours ?? 24)} /></label>
        <p className="institutional-followup">{t("preEvent.hoursHelp", { hours: config.defaultHours ?? 24 })}</p>
        {staffOnly && <p className="institutional-followup">{t("preEvent.staffOnlyRecord")}</p>}
      </>}
      {error && <p className="institutional-error" role="alert">{error}</p>}
      <div className="institutional-actions">
        {notice && <BusyButton type="button" className="institutional-danger" pending={busy} onClick={remove}>{t("preEvent.remove")}</BusyButton>}
        <BusyButton type="submit" className="institutional-primary" pending={busy} disabled={events.length === 0}><BellRing size={16} />{t("preEvent.save")}</BusyButton>
      </div>
    </form>
  </Dialog>;
}

// Minutes attach to one of the chapter's meetings, past or upcoming (owner
// decision, October 8, 2026). The chosen meeting's agenda is shown read-only
// so the minutes can be checked against it.
function MeetingAttachEditor({ record, meetings, t, lang, onClose, onSave }) {
  const attached = meetings.some((meeting) => meeting.id === record.event_id) ? record.event_id : "";
  const [eventId, setEventId] = useState(attached);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435), keyed by the record the write changes.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const choices = meetings.filter((meeting) => !meeting.cancelledAt || meeting.id === attached);
  const chosen = choices.find((meeting) => meeting.id === eventId) || null;
  function save(nextEventId) {
    return runBusyWrite(busyWriteRef, `meeting:${record.id}`, () => saveNow(nextEventId));
  }

  async function saveNow(nextEventId) {
    if (busy) return;
    setBusy(true); setError("");
    try { await onSave(record.id, nextEventId); }
    catch { setError(t("records.meetingFailed")); }
    finally { setBusy(false); }
  }
  return <Dialog eyebrow={t("records.meetingEyebrow")} title={record.title} onClose={onClose}>
    <form className="institutional-form" onSubmit={(event) => { event.preventDefault(); save(eventId); }}>
      <p>{t("records.meetingHelp")}</p>
      {choices.length === 0 ? <p className="institutional-followup">{t("preEvent.noMeetings")}</p> : <>
        <label>{t("preEvent.meeting")}<select name="eventId" value={eventId} required onChange={(event) => setEventId(event.target.value)}><option value="">{t("preEvent.chooseMeeting")}</option>{choices.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title} · {dateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(meeting.startsAt))}</option>)}</select></label>
        {chosen && <div className="institutional-agenda"><strong>{t("admin.eventAgenda")}</strong><p>{chosen.agenda || t("records.meetingNoAgenda")}</p></div>}
      </>}
      {error && <p className="institutional-error" role="alert">{error}</p>}
      <div className="institutional-actions">
        {attached && <BusyButton type="button" className="institutional-danger" pending={busy} onClick={() => save(null)}>{t("records.detachMeeting")}</BusyButton>}
        <BusyButton type="submit" className="institutional-primary" pending={busy} disabled={choices.length === 0}><CalendarDays size={16} />{t("records.saveMeeting")}</BusyButton>
      </div>
    </form>
  </Dialog>;
}

function ContactEditor({ contact, roster, t, onClose, onSave }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  // Synchronous write lock (record 8435), keyed by the record the write changes.
  const busyWriteRef = useRef(new Set());
  function submit(event, archive = false) {
    return runBusyWrite(busyWriteRef, `contact:${contact?.id ?? "new"}`, () => submitNow(event, archive), event);
  }

  async function submitNow(event, archive = false) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget.closest("form") || event.currentTarget;
    const data = new FormData(form); setBusy(true); setError("");
    try { await onSave({ contactId: contact?.id, contactKind: data.get("contactKind"), channel: data.get("channel"), purpose: data.get("purpose"), summary: data.get("summary"), outcome: data.get("outcome"), occurredAt: new Date(data.get("occurredAt")).toISOString(), followUpAt: data.get("followUpAt") ? new Date(data.get("followUpAt")).toISOString() : null, subjectUserId: data.get("subjectUserId") || null, caseId: contact?.case_id || null, taskId: contact?.task_id || null, archive }); }
    catch { setError(t("records.saveFailed")); }
    finally { setBusy(false); }
  }
  return <Dialog eyebrow={t("records.contactsTitle")} title={contact ? t("records.editContact") : t("records.newContact")} onClose={onClose} wide><form className="institutional-form" onSubmit={submit}>
    <label>{t("records.contactKindLabel")}<select name="contactKind" defaultValue={contact?.contact_kind || "member"}>{["member","management","community","provider","other"].map((kind) => <option value={kind} key={kind}>{t(`records.contactKind.${kind}`)}</option>)}</select></label>
    <label>{t("records.channelLabel")}<select name="channel" defaultValue={contact?.channel || "phone"}>{["in_person","phone","email","message","meeting","other"].map((channel) => <option value={channel} key={channel}>{t(`records.channel.${channel}`)}</option>)}</select></label>
    <label>{t("records.subject")}<select name="subjectUserId" defaultValue={contact?.subject_user_id || ""}><option value="">{t("records.noSubject")}</option>{roster.map((member) => <option value={member.userId} key={member.userId}>{member.name}</option>)}</select></label>
    <label>{t("records.purpose")}<input name="purpose" maxLength="160" defaultValue={contact?.purpose || ""} required /></label>
    <label>{t("records.summary")}<textarea name="summary" maxLength="4000" defaultValue={contact?.summary || ""} required /></label>
    <label>{t("records.outcome")}<textarea name="outcome" maxLength="1000" defaultValue={contact?.outcome || ""} /></label>
    <label>{t("records.date")}<input type="datetime-local" name="occurredAt" defaultValue={localDateTime(contact?.occurred_at)} required /></label>
    <label>{t("records.followUp")}<input type="datetime-local" name="followUpAt" defaultValue={contact?.follow_up_at ? localDateTime(contact.follow_up_at) : ""} /></label>
    {error && <p className="institutional-error" role="alert">{error}</p>}
    <div className="institutional-actions">{contact && <BusyButton type="button" className="institutional-danger" pending={busy} onClick={(event) => submit(event, true)}><Archive size={16} />{t("records.archive")}</BusyButton>}<BusyButton className="institutional-primary" pending={busy}>{t("records.save")}</BusyButton></div>
  </form></Dialog>;
}

// REQ-UG-SURVEY-AND-FILTERED-EXPORTS-XLSX-20261001: XLSX is offered only
// while the organization switch is on; an unreadable configuration keeps the
// registered default (on) and the server still refuses when it is off.
const XLSX_SWITCH = "features.analytics.filtered_export_xlsx";

function ExportBuilder({ client, runs, t, lang, onNotice, onRefresh }) {
  const [domains, setDomains] = useState(["members"]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  // Synchronous write lock (record 8435), keyed by the record the write changes.
  const busyWriteRef = useRef(new Set());
  const [xlsxEnabled, setXlsxEnabled] = useState(true);
  useEffect(() => {
    if (!client?.rpc) return undefined;
    let active = true;
    Promise.resolve(client.rpc("get_member_organization_configuration", {}))
      .then((result) => { if (active && !result?.error) setXlsxEnabled(result?.data?.switches?.[XLSX_SWITCH] !== false); })
      .catch(() => {});
    return () => { active = false; };
  }, [client]);
  function submit(event) {
    return runBusyWrite(busyWriteRef, "export", () => submitNow(event), event);
  }

  async function submitNow(event) {
    event.preventDefault(); if (busy || domains.length === 0) return;
    const data = new FormData(event.currentTarget); setBusy(true); setError("");
    try {
      const result = await requestOrganizationExport(client, { domains, format: data.get("format"), from: data.get("from") ? new Date(`${data.get("from")}T00:00:00`).toISOString() : null, to: data.get("to") ? new Date(`${data.get("to")}T23:59:59.999`).toISOString() : null });
      downloadOrganizationExport(result); onNotice(t("records.exportReady", { count: result.rowCount })); await onRefresh();
    } catch { setError(t("records.exportFailed")); }
    finally { setBusy(false); }
  }
  return <div className="institutional-section"><SectionHead title={t("records.exportsTitle")} /><form className="institutional-export" onSubmit={submit}>
    <fieldset><legend>{t("records.domains")}</legend>{EXPORT_DOMAINS.map((domain) => <label key={domain}><input type="checkbox" checked={domains.includes(domain)} onChange={(event) => setDomains((current) => event.target.checked ? [...current, domain] : current.filter((item) => item !== domain))} />{t(`records.domain.${domain}`)}</label>)}</fieldset>
    <label>{t("records.format")}<select name="format"><option value="csv">CSV</option>{xlsxEnabled && <option value="xlsx">XLSX</option>}<option value="json">JSON</option></select></label>
    <label>{t("records.from")}<input type="date" name="from" /></label><label>{t("records.to")}<input type="date" name="to" /></label>
    <p>{t("records.exportBoundary")}</p>{error && <p className="institutional-error" role="alert">{error}</p>}
    <BusyButton className="institutional-primary" pending={busy} disabled={domains.length === 0}><Download size={16} />{busy ? t("records.building") : t("records.download")}</BusyButton>
  </form>
  {runs.length > 0 && <div className="institutional-runs"><h4>{t("records.recentExports")}</h4>{runs.map((run) => <p key={run.id}>{run.format.toUpperCase()} · {run.row_count} · {formatDateTimeWithZone(run.created_at, lang)}</p>)}</div>}
  </div>;
}
