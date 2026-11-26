import { WorkspaceSection, useWorkspace, workspaceHref, WorkspaceCardTitle } from "../components/WorkspacePages.jsx";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { Building2, RefreshCcw, UsersRound } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { rpcRefusalKey } from "../lib/rpcErrorText.js";
import { ROLE_LABEL_KEYS, PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { caseExportFilename } from "../lib/caseExport.js";
import { AdminSecurityConfiguration } from "./AdminSecurityConfiguration.jsx";
import { ChapterBindingCard, ChapterMembershipCard, HandshakeDocumentsCard } from "./ChapterLifecycleAdmin.jsx";
import { NoChapterYetNotice, organizationHasNoChapter } from "./NoChapterYetNotice.jsx";
import { TemplateKeyDetails } from "./AdminFormTemplateEditor.jsx";
import { isConflictRefusalCode } from "../lib/memberApiError.js";
import { webNameFrom } from "../lib/webName.js";

// Update the literal chapter ID pattern’s {0,31} quantifier when changing this cap.
const CHAPTER_ID_MAX = 32;
const EMPTY_CHAPTER = { id: "", name: "", region: "", orderIndex: "" };
// The per-chapter staff role counts. Organizer is a Union Ground staff hat:
// get_admin_org_structure counts it with the other staff roles, so its chip
// shows here too.
const CHAPTER_ROLES = ["steward", "organizer", "coordinator", "advisor", "admin", "vp"];

// A blank query lists every member and two or more characters filter, but a
// single character is refused, so the field's description states both halves.
const DIRECTORY_FILTER_ID = "admin-directory-filter";
const DIRECTORY_HELP_ID = "admin-directory-filter-help";
// Vice President, Treasurer and Secretary are
// display titles only, offered as suggestions in the title field.
const OFFICER_TITLE_SUGGESTIONS = ["vicePresident", "treasurer", "secretary", "secretaryTreasurer", "president"];

// A link to another admin desk page that stays inside the app when the desk
// runs in its workspace (a modified click still opens a new tab).
export function DeskPageLink({ path, children }) {
  const workspace = useWorkspace();
  return <a href={workspaceHref(path)} onClick={(event) => {
    if (!workspace || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    workspace.open(path);
  }}>{children}</a>;
}

const NO_STAFF_ROLE = "member";

// Role and chapter filters over the members already listed. They narrow the
// rows on screen; "Show more" still pages the server's name-ordered list.
export function filterDirectoryRows(rows, { role = "", chapterId = "" } = {}) {
  return rows.filter((person) => {
    const roles = Array.isArray(person?.roles) ? person.roles : [];
    if (role === NO_STAFF_ROLE ? roles.length > 0 : role && !roles.includes(role)) return false;
    return !chapterId || person?.chapterId === chapterId;
  });
}

// Saves the CSV the server built. A UTF-8 byte-order mark lets spreadsheet
// programs read accented names; the browser never widens or edits the rows.
export function saveDirectoryCsv(csv, { now = new Date(), doc = typeof document === "undefined" ? null : document } = {}) {
  const filename = caseExportFilename("member-directory", now);
  if (!doc || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return { filename, downloaded: false };
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = filename;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { filename, downloaded: true };
}

// REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030 (owner ruling of
// October 30, 2026, item 4): the export is exactly the directory's fields for
// everyone the requester may see, built and logged by the server.
function DirectoryExport({ api, context }) {
  const { t, lang } = useLang();
  const [busy, setBusy] = useState(false);
  // Synchronous write lock: refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [status, setStatus] = useState(null);
  function exportList() {
    return runBusyWrite(busyWriteRef, "export", () => exportListNow());
  }

  async function exportListNow() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const exported = await api.exportMemberDirectory(context, lang);
      saveDirectoryCsv(exported.csv);
      setStatus({ ok: true, text: t("admin.command.directoryExported", { count: exported.rowCount }) });
    } catch (failure) {
      const key = failure?.code === "54000" ? "admin.command.directoryExportTooLarge"
        : isConflictRefusalCode(failure?.code) ? "admin.command.directoryExportContextChanged" : "admin.command.directoryExportFailed";
      setStatus({ ok: false, text: t(key) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="xus-inline">
      <BusyButton type="button" className="xus-btn" pending={busy} disabled={!context} onClick={exportList}>
        {busy ? t("admin.command.directoryExporting") : t("admin.command.directoryExport")}
      </BusyButton>
      {status && <p className={status.ok ? "xus-note" : "xus-note xus-note--error"} role={status.ok ? "status" : "alert"}>{status.text}</p>}
    </div>
  );
}

// Two pages share a context when both name the same one, or when neither names
// one (a server ahead of the migration, where the export stays disabled).
function sameDirectoryContext(left, right) {
  if (!left && !right) return true;
  return Boolean(left && right) && left.organizationId === right.organizationId && left.chapterId === right.chapterId;
}

// `officer` is a chapter President or Secretary-Treasurer reading through
// their office: the same card, without the admin desk's invitation links.
export function DirectoryCard({ initial, api, reload, officer = false, sectionName = "admin-member-directory" }) {
  const { t } = useLang();
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [page, setPage] = useState(initial);
  // The rows on screen, for the page-context check after an await.
  const pageRef = useRef(initial);
  useEffect(() => { pageRef.current = page; }, [page]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const appliedQueryRef = useRef("");
  const previousInitial = useRef(initial);
  const requestToken = useRef(0);

  const loadPage = useCallback(async (needle, cursor, append) => {
    const token = ++requestToken.current;
    setBusy(true);
    setFailed(false);
    try {
      const next = await api.loadMemberDirectory(needle, cursor);
      if (token !== requestToken.current) return;
      // A later page read under another chapter or organization (switched in
      // another tab) must not join the rows on screen or rebind the export:
      // drop the mixed list and ask for a fresh first page.
      if (append && !sameDirectoryContext(pageRef.current?.context, next.context)) {
        setPage({ items: [], nextCursor: null, context: null, query: needle });
        setFailed(true);
        return;
      }
      setPage((current) => ({
        items: append ? [...(current?.items ?? []), ...next.items] : next.items,
        nextCursor: next.nextCursor,
        context: next.context ?? null,
        query: needle,
      }));
    } catch {
      if (token === requestToken.current) setFailed(true);
    } finally {
      if (token === requestToken.current) setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    if (previousInitial.current === initial) return;
    previousInitial.current = initial;
    if (initial === null || !appliedQueryRef.current) {
      requestToken.current += 1;
      setBusy(false);
      setFailed(false);
      setPage(initial);
      return;
    }
    loadPage(appliedQueryRef.current, null, false);
  }, [initial, loadPage]);

  async function read(event, append = false) {
    event?.preventDefault();
    const needle = append ? appliedQueryRef.current : query.trim();
    if (busy || needle.length === 1 || !api.loadMemberDirectory) return;
    if (!append) {
      appliedQueryRef.current = needle;
      setAppliedQuery(needle);
    }
    await loadPage(needle, append ? page?.nextCursor ?? null : null, append);
  }

  const [roleFilter, setRoleFilter] = useState("");
  const [chapterFilter, setChapterFilter] = useState({ id: "", name: "" });
  const loadedRows = useMemo(() => page?.items ?? [], [page]);
  // An active chapter stays a choice even when a later name search loads no
  // one from it, so the filter that hides those results can still be cleared.
  const chapterOptions = useMemo(() => {
    const options = new Map(loadedRows
      .filter((person) => person?.chapterId)
      .map((person) => [person.chapterId, person.chapterName || person.chapterId]));
    if (chapterFilter.id && !options.has(chapterFilter.id)) options.set(chapterFilter.id, chapterFilter.name || chapterFilter.id);
    return [...options.entries()].sort((left, right) => String(left[1]).localeCompare(String(right[1])));
  }, [loadedRows, chapterFilter]);
  const rows = filterDirectoryRows(loadedRows, { role: roleFilter, chapterId: chapterFilter.id });
  const filtering = Boolean(roleFilter || chapterFilter.id);
  const card = (
    <article id={sectionName || "officer-member-directory"} className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
      <header className="xus-cardhead">
        <span className="xus-glyph" aria-hidden="true"><UsersRound size={18} /></span>
        <div className="xus-cardhead__copy">
          <WorkspaceCardTitle outline className="xus-cardttl">{t("admin.command.directoryTitle")}</WorkspaceCardTitle>
          <p className="xus-cardsub">{t(officer ? "admin.command.directoryOfficerSub" : "admin.command.directorySub")}</p>
        </div>
      </header>
      {initial === null ? (
        <div className="xus-cardbody"><p className="xus-note">{t("admin.command.directoryUnavailable")}</p></div>
      ) : (
        <>
          <div className="xus-cardbody">
            <form className="xus-searchrow" onSubmit={(event) => read(event, false)}>
              <div className="xus-field xus-command-search">
                <label htmlFor={DIRECTORY_FILTER_ID}>{t("admin.command.directoryFilter")}</label>
                <input className="xus-input xus-search" id={DIRECTORY_FILTER_ID} type="search" aria-describedby={DIRECTORY_HELP_ID} value={query} onChange={(event) => setQuery(event.target.value)} />
                <small className="xus-note" id={DIRECTORY_HELP_ID}>{t("admin.command.directoryHelp")}</small>
              </div>
              <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy} disabled={query.trim().length === 1}>
                {busy ? t("admin.command.directoryLoading") : t("admin.command.directoryRefresh")}
              </BusyButton>
            </form>
            {(loadedRows.length > 0 || filtering) && <div className="xus-formgrid">
              <label className="xus-field">{t("admin.command.directoryRoleFilter")}
                <select className="xus-input" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
                  <option value="">{t("admin.command.directoryAnyRole")}</option>
                  <option value={NO_STAFF_ROLE}>{t("admin.inviteMemberRole")}</option>
                  {CHAPTER_ROLES.map((role) => <option key={role} value={role}>{t(ROLE_LABEL_KEYS[role])}</option>)}
                </select>
              </label>
              {(chapterOptions.length > 1 || chapterFilter.id) && <label className="xus-field">{t("admin.command.directoryChapterFilter")}
                <select className="xus-input" value={chapterFilter.id} onChange={(event) => {
                  const id = event.target.value;
                  setChapterFilter({ id, name: chapterOptions.find(([option]) => option === id)?.[1] ?? "" });
                }}>
                  <option value="">{t("admin.command.directoryAnyChapter")}</option>
                  {chapterOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>}
            </div>}
            {filtering && <p className="xus-note" role="status">{t("admin.command.directoryFiltered", { shown: rows.length, total: loadedRows.length })}</p>}
            {!officer && <p className="xus-note">
              <DeskPageLink path="/m/admin/roster-import">{t("roster.importTitle")}</DeskPageLink>
              {" · "}
              <DeskPageLink path="/m/admin/invitations">{t("admin.inviteTitle")}</DeskPageLink>
            </p>}
            {api.exportMemberDirectory && <>
              <DirectoryExport api={api} context={page?.context ?? null} />
              <p className="xus-note">{t("admin.command.directoryExportNote")}</p>
            </>}
            {failed && <p className="xus-note xus-note--error" role="alert">{t("admin.command.directoryError")}</p>}
            {!failed && loadedRows.length === 0 && !filtering && <p className="xus-note xus-note--pad">{t("admin.command.directoryEmpty")}</p>}
            {!failed && (loadedRows.length > 0 || filtering) && rows.length === 0 && <p className="xus-note xus-note--pad">{t("admin.command.directoryFilterEmpty")}</p>}
          </div>
          {rows.map((person) => (
            <div className="xus-row" key={person.userId}>
              <span className="xus-av" aria-hidden="true">{person.initials}</span>
              <div className="xus-rowmain">
                <strong className="xus-name">{person.fullName}</strong>
                <small className="xus-meta">
                  {[person.memberSince ? t("today.memberSince", { year: person.memberSince }) : null, person.chapterName || person.chapterId].filter(Boolean).join(" · ")}
                </small>
                {/* Only what the member chose to share with administrators
                    (REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006). */}
                {sharedProfileLine(person.profileDetails) && <small className="xus-meta">
                  {t("admin.command.sharedDetails")}: {sharedProfileLine(person.profileDetails)}
                </small>}
                {(person.roles || []).length > 0 && <span className="xus-chiprow">
                  {person.roles.map((role) => <span className="reward-chip reward-chip--tier" key={role}>{ROLE_LABEL_KEYS[role] ? t(ROLE_LABEL_KEYS[role]) : role}</span>)}
                </span>}
                <DirectoryTitle person={person} api={api} onSaved={(displayTitle) => {
                  setPage((current) => current && ({
                    ...current,
                    items: current.items.map((item) => item.userId === person.userId ? { ...item, displayTitle } : item),
                  }));
                  // The save wrote an audit row; refresh the desk so the audit trail shows it.
                  reload?.();
                }} />
              </div>
            </div>
          ))}
          {page?.nextCursor && (page?.query ?? "") === appliedQuery && query.trim() === appliedQuery && <div className="xus-cardbody xus-cardbody--divided">
            <BusyButton type="button" className="xus-btn" pending={busy} onClick={(event) => read(event, true)}>{t("admin.command.directoryMore")}</BusyButton>
          </div>}
        </>
      )}
    </article>
  );
  // A null section renders in place, for pages outside a staff workspace.
  return sectionName ? <WorkspaceSection name={sectionName}>{card}</WorkspaceSection> : card;
}

// Officer display title (BUG-UG-INVITE-STARTING-ACCESS-NO-OFFICER-TITLES-20261003;
// Display title plus separately assigned
// access). Shown apart from the role chips and never sent with a role; the
// editor appears only when the directory marks the row displayTitleEditable
// (the setter's own chapter check), so a database without titles keeps
// today's row and an admin is never offered a save the database refuses.
//
// A failed save names its reason
// (BUG-UG-ADMIN-CANNOT-SAVE-OFFICER-DISPLAY-TITLES-20261006): the
// setter adds a two-step sign-in check the directory flag does not, refuses a
// membership that stopped being active, and bounds the title; a busy or slow
// server is said as such. The typed title stays in the field for a retry.
function titleRefusalKey(error) {
  const code = error?.code == null ? "" : String(error.code);
  if (code === "42501") return "admin.command.titleRefusedAccess";
  const message = String(error?.message || "");
  if (code === "22023" && /membership not found/i.test(message)) return "admin.command.titleRefusedMembership";
  if (code === "22023" && /invalid display title/i.test(message)) return "admin.command.titleRefusedInvalid";
  // Any other database refusal (a membership trigger raises 22023 too) is not
  // the title's fault and a retry will not help, so it is not called busy.
  if (/^(?:22|23|42|P0)/.test(code)) return rpcRefusalKey(error, "admin.command.titleRefusedOther");
  return rpcRefusalKey(error, "admin.command.titleRetry");
}

function sharedProfileLine(details) {
  if (!details || typeof details !== "object") return "";
  return [details.pronouns, details.jobTitle, details.worksite, details.shift, details.classification, details.phone]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" · ");
}

export function DirectoryTitle({ person, api, onSaved }) {
  const { t } = useLang();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(person.displayTitle ?? "");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock: refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [failed, setFailed] = useState(null);
  const editable = person.displayTitleEditable === true && typeof api?.setMemberDisplayTitle === "function" && Boolean(person.chapterId);
  if (!person.displayTitle && !editable) return null;
  function save(next) {
    return runBusyWrite(busyWriteRef, "title", () => saveNow(next));
  }

  async function saveNow(next) {
    setBusy(true);
    setFailed(null);
    try {
      const result = await api.setMemberDisplayTitle(person.userId, person.chapterId, next);
      onSaved(result?.displayTitle ?? null);
      setEditing(false);
    } catch (error) {
      setFailed(titleRefusalKey(error));
    } finally {
      setBusy(false);
    }
  }
  return <div className="xus-title-editor">
    {person.displayTitle && <span className="xus-chiprow"><span className="xus-chip xus-chip--note">{t("admin.command.titleLabel")}: {person.displayTitle}</span></span>}
    {editing ? (
      <form className="xus-searchrow" onSubmit={(event) => { event.preventDefault(); save(value); }}>
        <label className="xus-field">{t("admin.command.titleLabel")}
          <input className="xus-input" value={value} maxLength={60} list={`officer-titles-${person.userId}`} onChange={(event) => setValue(event.target.value)} />
          {/* Common officer titles as suggestions only: free text stays allowed and
              a title still grants nothing (REQ-UG-OFFICER-ROLES-VP-TREASURER-SECRETARY-20261006). */}
          <datalist id={`officer-titles-${person.userId}`}>{OFFICER_TITLE_SUGGESTIONS.map((key) => <option key={key} value={t(`admin.command.titleSuggestion.${key}`)} />)}</datalist>
          <small className="xus-note">{t("admin.command.titleHelp")}</small>
        </label>
        <div className="xus-btnrow">
          <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy}>{t("admin.command.titleSave")}</BusyButton>
          {person.displayTitle && <BusyButton type="button" className="xus-btn" pending={busy} onClick={() => save("")}>{t("admin.command.titleClear")}</BusyButton>}
          <BusyButton type="button" className="xus-btn" pending={busy} onClick={() => { setEditing(false); setFailed(null); }}>{t("admin.cancel")}</BusyButton>
        </div>
        {failed && <p className="xus-note xus-note--error" role="alert">{t("admin.command.titleError")} {t(failed, { name: person.fullName, chapter: person.chapterName || t("admin.command.titleThisChapter") })}</p>}
      </form>
    ) : editable && (
      <button type="button" className="xus-btn" onClick={() => { setValue(person.displayTitle ?? ""); setEditing(true); }}>{t("admin.command.titleEdit", { name: person.fullName })}</button>
    )}
  </div>;
}

function ChapterFields({ value, setValue, includeId = false, includeStructure = true }) {
  const { t } = useLang();
  const idHelp = useId();
  const [idInvalid, setIdInvalid] = useState(false);
  const [idLimitAnnouncement, setIdLimitAnnouncement] = useState(null);
  const idLength = value.id.length;
  const idRule = t("admin.command.chapterIdRule", { max: CHAPTER_ID_MAX });
  // Typed or filled from the name, a web name that reaches or leaves the cap
  // is announced once, on the crossing.
  const announceIdLimit = (nextId) => {
    const reachedCap = nextId.length >= CHAPTER_ID_MAX;
    if (reachedCap !== (idLength >= CHAPTER_ID_MAX)) {
      setIdLimitAnnouncement(reachedCap ? "admin.command.chapterIdLimitReached" : "admin.command.chapterIdBelowLimit");
    }
  };
  return <div className="xus-formgrid">
    <label className="xus-field">{t("admin.command.chapterName")}
      <input className="xus-input" value={value.name} minLength="2" maxLength="120" required onChange={(event) => {
        const name = event.target.value;
        // A new chapter's web name follows its name until the person touches
        // the web name field (idEdited). idAuto is the last name the name
        // produced, so a form that arrives with some other id keeps it.
        const follows = includeId && !value.idEdited && (!value.id || value.id === value.idAuto);
        if (!follows) {
          setValue((current) => ({ ...current, name }));
          return;
        }
        const id = webNameFrom(name, CHAPTER_ID_MAX);
        announceIdLimit(id);
        setValue((current) => ({ ...current, name, id, idAuto: id }));
      }} />
    </label>
    {includeId && <label className="xus-field">{t("admin.command.chapterId")}
      <input className="xus-input" value={value.id} pattern="[a-z0-9][a-z0-9\-]{0,31}" maxLength={CHAPTER_ID_MAX} required
        title={idRule} aria-label={t("admin.command.chapterId")} aria-describedby={idHelp} aria-invalid={idInvalid || undefined}
        onInvalid={({ currentTarget }) => setIdInvalid(currentTarget.validity.patternMismatch)}
        onChange={({ currentTarget }) => {
          const { value: id, validity } = currentTarget;
          if (!validity.patternMismatch) setIdInvalid(false);
          announceIdLimit(id);
          setValue((current) => ({ ...current, id, idEdited: true }));
        }} />
      <small className="xus-note">
        <span id={idHelp}>{t("admin.command.chapterIdFromName")} {idInvalid ? <span className="xus-note--error" role="alert">{idRule}</span> : idRule}</span>
        {idLength >= Math.ceil(CHAPTER_ID_MAX * 0.8)
          && <> <span>{t("forms.charCount", { count: idLength, max: CHAPTER_ID_MAX })}</span></>}
      </small>
      <span className="sr-only" role="status">{idLimitAnnouncement ? t(idLimitAnnouncement) : ""}</span>
    </label>}
    {includeStructure && <label className="xus-field">{t("admin.command.chapterRegion")}
      <input className="xus-input" value={value.region} maxLength="120" onChange={(event) => setValue((current) => ({ ...current, region: event.target.value }))} />
    </label>}
    {includeStructure && <label className="xus-field">{t("admin.command.chapterOrder")}
      <input className="xus-input" type="number" min="1" max="10000" step="1" value={value.orderIndex} required onChange={(event) => setValue((current) => ({ ...current, orderIndex: event.target.value }))} />
    </label>}
  </div>;
}

function OrganizationCard({ organization, api, reload, onNotice }) {
  const { t } = useLang();
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState(EMPTY_CHAPTER);
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState(EMPTY_CHAPTER);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock: refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [failure, setFailure] = useState(null);
  const clearCreateFailure = () => setFailure((current) => current?.editor === "create" ? null : current);

  function submitCreate(event) {
    return runBusyWrite(busyWriteRef, "organization", () => submitCreateNow(event), event);
  }

  async function submitCreateNow(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setFailure(null);
    try {
      // Only the chapter fields: the web-name flags stay in the form.
      await api.createChapter({ id: createDraft.id, name: createDraft.name, region: createDraft.region,
        orderIndex: Number(createDraft.orderIndex) });
      onNotice(t("admin.command.chapterCreated"));
      setCreating(false); setCreateDraft(EMPTY_CHAPTER);
      reload();
    } catch (error) {
      let key = "admin.command.chapterError";
      if (String(error?.code) !== "23505") key = rpcRefusalKey(error, key);
      // The chapter RPC raises this message for duplicate IDs or names.
      // Other uniqueness errors do not identify a chapter conflict.
      else if (error.message === "chapter already exists" || error.message === "Create chapter: chapter already exists") {
        key = "admin.command.chapterCreateConflict";
      }
      setFailure({ editor: "create", key });
    } finally { setBusy(false); }
  }

  function submitEdit(event, chapterId) {
    return runBusyWrite(busyWriteRef, "organization", () => submitEditNow(event, chapterId), event);
  }

  async function submitEditNow(event, chapterId) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setFailure(null);
    try {
      await api.updateChapter(chapterId, {
        name: editDraft.name,
        region: editDraft.region,
        orderIndex: Number(editDraft.orderIndex),
      });
      onNotice(t("admin.command.chapterUpdated"));
      setEditing(null);
      reload();
    } catch { setFailure({ editor: "edit", key: "admin.command.chapterError" }); } finally { setBusy(false); }
  }

  const scopedName = organization?.chapters?.[0]?.name || organization?.chapterId || "";
  return (
    <WorkspaceSection name="admin-organization"><article id="admin-organization" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
      <header className="xus-cardhead">
        <span className="xus-glyph" aria-hidden="true"><Building2 size={18} /></span>
        <div className="xus-cardhead__copy">
          <WorkspaceCardTitle outline className="xus-cardttl">{t("admin.command.organizationTitle")}</WorkspaceCardTitle>
          <p className="xus-cardsub">{t("admin.command.organizationSub")}</p>
        </div>
      </header>
      {organization === null ? <div className="xus-cardbody"><p className="xus-note">{t("admin.command.organizationUnavailable")}</p></div> : <>
        <div className="xus-cardbody xus-inline">
          <p className="xus-note">{organization.scope === "organization"
            ? t("admin.command.scopeOrganization")
            : t("admin.command.scopeChapter", { chapter: scopedName })}</p>
          {organization.canCreateChapter && !creating && <button type="button" className="xus-btn xus-btn--go" onClick={() => { clearCreateFailure(); setCreating(true); }}>{t("admin.command.addChapter")}</button>}
        </div>
        {organizationHasNoChapter(organization) && <div className="xus-cardbody"><NoChapterYetNotice link={false} /></div>}
        {failure?.editor === "edit" && <div className="xus-cardbody"><p className="xus-note xus-note--error" role="alert">{t(failure.key)}</p></div>}
        {creating && <form className="xus-cardbody xus-form" onSubmit={submitCreate}
          onChange={clearCreateFailure}>
          <ChapterFields value={createDraft} setValue={setCreateDraft} includeId />
          {failure?.editor === "create" && <p className="xus-note xus-note--error" role="alert">{t(failure.key)}</p>}
          <div className="xus-btnrow">
            <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy}>{t("admin.command.createChapter")}</BusyButton>
            <BusyButton type="button" className="xus-btn" pending={busy} onClick={() => setCreating(false)}>{t("admin.cancel")}</BusyButton>
          </div>
        </form>}
        {(organization.chapters || []).map((chapter) => <div className="xus-erow" key={chapter.id}>
          <div className="xus-etop">
            <div className="xus-emain">
              <strong className="xus-etitle">{chapter.name}</strong>
              <p className="xus-eline">{[
                t(chapter.memberCount === 1 ? "admin.command.chapterMembers.one" : "admin.command.chapterMembers.many", { count: chapter.memberCount }),
                t(chapter.staffCount === 1 ? "admin.command.chapterStaff.one" : "admin.command.chapterStaff.many", { count: chapter.staffCount }),
              ].join(" · ")}</p>
              <ul className="xus-chiprow xus-rolecounts" aria-label={t("admin.command.roleCountsLabel")}>
                {CHAPTER_ROLES.map((role) => <li className="reward-chip reward-chip--tier" key={role}>
                  {t("admin.command.roleCount", {
                    role: ROLE_LABEL_KEYS[role] ? t(ROLE_LABEL_KEYS[role]) : role,
                    count: chapter.roleCounts?.[role] ?? 0,
                  })}
                </li>)}
              </ul>
              {chapter.region && <small className="xus-meta">{chapter.region}</small>}
              {/* The id is for CSV imports and support, not for reading . */}
              <TemplateKeyDetails summary={t("admin.templates.technicalDetails")} name={t("admin.templates.technicalDetailsAria", { title: chapter.name })} label={t("admin.command.chapterIdValue", { id: chapter.id })} />
              {chapter.isDefault && <span className="xus-chip xus-chip--note">{t("admin.command.defaultChapter")}</span>}
            </div>
            <BusyButton type="button" className="xus-btn" pending={busy} aria-label={t("admin.command.editChapter", { chapter: chapter.name })} onClick={() => {
              setEditing(chapter.id);
              setEditDraft({ id: chapter.id, name: chapter.name, region: chapter.region || "", orderIndex: String(chapter.orderIndex) });
            }}>{t("admin.command.edit")}</BusyButton>
          </div>
          {editing === chapter.id && <form role="group" aria-label={t("admin.command.editChapter", { chapter: chapter.name })} className="xus-form" onSubmit={(event) => submitEdit(event, chapter.id)}>
            <ChapterFields value={editDraft} setValue={setEditDraft} includeStructure={organization.scope === "organization"} />
            <div className="xus-btnrow">
              <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy}>{t("admin.command.saveChapter")}</BusyButton>
              <BusyButton type="button" className="xus-btn" pending={busy} onClick={() => setEditing(null)}>{t("admin.cancel")}</BusyButton>
            </div>
          </form>}
        </div>)}
      </>}
    </article></WorkspaceSection>
  );
}

function LifecycleCard() {
  const { t } = useLang();
  const controls = [
    ["admin.command.lifecycleInvite", "admin.command.lifecycleInviteAction", "#admin-invitations"],
    ["admin.command.lifecycleRecovery", "admin.command.lifecycleRecoveryAction", "#admin-signin-recovery"],
    ["admin.command.lifecycleRights", "admin.command.lifecycleRightsAction", "#admin-governance"],
    ["admin.command.lifecycleCompass", "admin.command.lifecycleCompassAction", "#admin-compass-governance"],
    ["admin.command.lifecycleAccount", "admin.command.lifecycleAccountAction", "/m/organize/governance"],
    ["admin.command.lifecycleRetention", "admin.command.lifecycleRetentionAction", "/retention"],
  ];
  return <WorkspaceSection name="admin-lifecycle"><article id="admin-lifecycle" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><RefreshCcw size={18} /></span>
      <div className="xus-cardhead__copy">
        <WorkspaceCardTitle outline className="xus-cardttl">{t("admin.command.lifecycleTitle")}</WorkspaceCardTitle>
        <p className="xus-cardsub">{t("admin.command.lifecycleSub")}</p>
      </div>
    </header>
    {controls.map(([title, action, href]) => <div className="xus-row" key={title}>
      <div className="xus-rowmain"><strong className="xus-name">{t(title)}</strong><small className="xus-meta">{t(`${title}Help`)}</small></div>
      <a className="xus-btn" href={href}>{t(action)}</a>
    </div>)}
  </article></WorkspaceSection>;
}

export function AdminCommandCenter({ directory, organization, chapterLifecycle, railChapter = null, configuration, configurationCurrent = true, chapterScoped = false, failedLoginInbox, showRetention = true, api, reload, onNotice }) {
  const { t } = useLang();
  const destinations = [
    ["admin.command.directoryTitle", "#admin-member-directory"],
    ["admin.command.organizationTitle", "#admin-organization"],
    ["admin.chapterLifecycle.title", "#admin-chapter-handshake"],
    ["admin.chapterLifecycle.documentsTitle", "#admin-handshake-documents"],
    ["admin.chapterLifecycle.membershipTitle", "#admin-chapter-memberships"],
    ["admin.config.title", "#admin-configuration"],
    ["admin.labels.title", "#admin-labels"],
    ["admin.loginInbox.title", "#admin-failed-logins"],
    ["admin.command.lifecycleTitle", "#admin-lifecycle"],
    ["admin.automation.title", "#admin-automation-control"],
    ...(showRetention ? [["admin.retention.title", "#admin-retention-engine"]] : []),
    ["admin.command.inviteIndex", "#admin-invitations"],
    ["admin.command.rightsIndex", "#admin-governance"],
  ];
  return <section className="xus-command" aria-label={t("admin.command.title")}>
    <WorkspaceSection name="overview"><header className="xus-sechead">
      <h2 className="xus-eyebrow" id="admin-command-title">{t("admin.command.title")}</h2>
      <p className="xus-secsub">{t("admin.command.sub")}</p>
    </header>
    <nav className="xus-command__nav" aria-label={t("admin.command.navLabel")}>
      {destinations.map(([label, href]) => <a className="xus-btn" href={href} key={href}>{t(label)}</a>)}
    </nav></WorkspaceSection>
    <DirectoryCard initial={directory} api={api} reload={reload} />
    <OrganizationCard organization={organization} api={api} reload={reload} onNotice={onNotice} />
    <WorkspaceSection name="admin-chapter-handshake"><ChapterBindingCard lifecycle={chapterLifecycle} railChapter={railChapter} organization={organization} api={api} reload={reload} onNotice={onNotice} /></WorkspaceSection>
    <WorkspaceSection name="admin-handshake-documents"><HandshakeDocumentsCard lifecycle={chapterLifecycle} api={api} reload={reload} onNotice={onNotice} /></WorkspaceSection>
    <WorkspaceSection name="admin-chapter-memberships"><ChapterMembershipCard directory={directory} organization={organization} api={api} reload={reload} onNotice={onNotice} /></WorkspaceSection>
    <AdminSecurityConfiguration configuration={configuration} configurationCurrent={configurationCurrent} chapterScoped={chapterScoped} failedLoginInbox={failedLoginInbox} api={api} reload={reload} onNotice={onNotice} />
    <LifecycleCard />
  </section>;
}
