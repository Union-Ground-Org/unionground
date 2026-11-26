import { useEffect, useMemo, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { Link2, Network, UserRoundCog } from "lucide-react";
import { ConfirmActionDialog } from "./ConfirmActionDialog.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { PLANE_CARD_CLASS, ROLE_LABEL_KEYS } from "../lib/staffPlaneStyles.js";
import { NoChapterYetNotice, organizationHasNoChapter } from "./NoChapterYetNotice.jsx";
import { UnionNetworkNav } from "../features/unionCatalog/UnionNetworkNav.jsx";
import { REGISTRY_SEARCH_MIN_LENGTH, registrySearchPlan } from "../features/unionCatalog/registryQuery.js";
import { WorkspaceCardTitle } from "./WorkspacePages.jsx";

const CHAPTER_ROLES = ["steward", "organizer", "coordinator", "advisor", "admin", "vp"];
const CONNECTIONS = ["sms", "calendar_google", "calendar_microsoft", "cba", "notion", "enterprise"];

function unionOrg(binding) {
  const value = binding?.union_orgs;
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function sharedDocumentTitle(row) {
  const value = row?.chapter_documents;
  const document = Array.isArray(value) ? value[0] : value;
  return document?.title || row?.document_id || "";
}

function statusLabel(t, value) {
  return t(`admin.chapterLifecycle.status.${value || "unset"}`);
}

// Which chapter this page acts for comes from the server's selected
// membership. The desktop chapter rail may show another chapter (a demo
// browsing choice or a fallback), so the card says which one applies and
// offers only chapters the server lists for this account, switched through
// switch_my_chapter; a refusal changes nothing.
function ChapterSelectionNote({ lifecycle, railChapter, api, busy, onSwitch, t }) {
  const memberships = lifecycle.memberships || [];
  const selectedId = lifecycle.chapterId;
  const rail = railChapter?.id ? railChapter : null;
  const railMembership = rail ? memberships.find((row) => row.chapterId === rail.id) : null;
  const canSwitch = typeof api?.switchMyChapter === "function";
  const switchButton = (row, key) => <BusyButton type="button" className="xus-btn"
    style={{ minHeight: 48, minWidth: 0, maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere" }} key={row.chapterId} pending={busy !== null}
    onClick={event => onSwitch(row, event.currentTarget)}>{t(key, { chapter: row.name })}</BusyButton>;

  if (selectedId) {
    const chapter = lifecycle.chapterName || selectedId;
    if (!rail || rail.id === selectedId) return <p className="xus-note">{t("admin.chapterLifecycle.managing", { chapter })}</p>;
    return <>
      <p className="xus-note">{railMembership
        ? t("admin.chapterLifecycle.railMismatch", { rail: rail.name, chapter })
        : t("admin.chapterLifecycle.railNotMember", { rail: rail.name, chapter })}</p>
      {railMembership && canSwitch && <div className="xus-btnrow">{switchButton(railMembership, "admin.chapterLifecycle.switchInstead")}</div>}
    </>;
  }
  if (memberships.length > 0) {
    const ordered = railMembership ? [railMembership, ...memberships.filter((row) => row !== railMembership)] : memberships;
    return <>
      <p className="xus-note">{t("admin.chapterLifecycle.noSelection")}</p>
      {canSwitch && <div className="xus-btnrow">{ordered.map((row) => switchButton(row, "admin.chapterLifecycle.switchTo"))}</div>}
    </>;
  }
  return <>
    <p className="xus-note">{t("admin.chapterLifecycle.noChapter")}</p>
    {rail && <p className="xus-note">{t("admin.chapterLifecycle.railBrowsing", { rail: rail.name })}</p>}
  </>;
}

export function ChapterBindingCard({ lifecycle, organization, api, reload, onNotice, railChapter = null }) {
  const { t } = useLang();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [capability, setCapability] = useState("sms");
  const [providerLabel, setProviderLabel] = useState("");
  const [connectionNotes, setConnectionNotes] = useState({});
  const [busy, setBusy] = useState(null);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState(false);
  const [switchDenied, setSwitchDenied] = useState(false);
  const cardRef = useRef(null);
  const switchControlRef = useRef(null);
  const [focusChapterId, setFocusChapterId] = useState(null);
  const orgWide = organization?.scope === "organization";
  const binding = lifecycle?.binding ?? null;
  const boundOrg = unionOrg(binding);
  const searchable = registrySearchPlan(query).searchable;

  useEffect(() => {
    if (busy !== null) return;
    if (switchDenied) {
      switchControlRef.current?.focus();
      switchControlRef.current = null;
    } else if (focusChapterId && lifecycle?.chapterId === focusChapterId) {
      cardRef.current?.focus();
      switchControlRef.current = null;
      setFocusChapterId(null);
    }
  }, [busy, focusChapterId, lifecycle?.chapterId, switchDenied]);

  function act(key, work, notice) {
    return runBusyWrite(busyWriteRef, "binding", () => actNow(key, work, notice));
  }

  async function actNow(key, work, notice) {
    if (busy) return;
    setBusy(key); setError(false);
    try {
      await work();
      onNotice(t(notice));
      await reload();
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }

  function switchChapter(row, control) {
    return runBusyWrite(busyWriteRef, "binding", () => switchChapterNow(row, control));
  }

  async function switchChapterNow(row, control) {
    if (busy) return;
    switchControlRef.current = control;
    setFocusChapterId(null);
    setBusy("switch"); setError(false); setSwitchDenied(false);
    try {
      await api.switchMyChapter(row.chapterId);
      setFocusChapterId(row.chapterId);
      onNotice(t("admin.chapterLifecycle.switched", { chapter: row.name }));
      await reload();
    } catch {
      setSwitchDenied(true);
    } finally {
      setBusy(null);
    }
  }

  function search(event) {
    event.preventDefault();
    if (busy) return;
    if (!searchable) return event.currentTarget.querySelector('button[type="submit"]')?.click();
    return runBusyWrite(busyWriteRef, "binding", searchNow);
  }

  async function searchNow() {
    setBusy("search"); setError(false);
    setSearched(false);
    setSearchFailed(false);
    try {
      const rows = await api.searchUnionOrganizations(query);
      const list = Array.isArray(rows) ? rows : [];
      setResults(list);
      setSelectedOrg((current) => (list.some((row) => row.id === current?.id) ? current : null));
      setSearched(true);
    } catch { setSearchFailed(true); }
    finally { setBusy(null); }
  }

  const visibleSelection = selectedOrg && results.some((row) => row.id === selectedOrg.id) ? selectedOrg : null;

  return <article ref={cardRef} id="admin-chapter-handshake" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
    <UnionNetworkNav staff admin />
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><Link2 size={18} /></span>
      <div className="xus-cardhead__copy">
        <WorkspaceCardTitle outline className="xus-cardttl">{t("admin.chapterLifecycle.title")}</WorkspaceCardTitle>
        <p className="xus-cardsub">{t("admin.chapterLifecycle.sub")}</p>
      </div>
    </header>
    {error && <div className="xus-cardbody"><p className="xus-note xus-note--error" role="alert">{t("admin.chapterLifecycle.error")}</p></div>}
    {switchDenied && <div className="xus-cardbody"><p className="xus-note xus-note--error" role="alert">{t("admin.chapterLifecycle.switchDenied")}</p></div>}
    {lifecycle
      ? <div className="xus-cardbody"><ChapterSelectionNote lifecycle={lifecycle} railChapter={railChapter} api={api} busy={busy} onSwitch={switchChapter} t={t} /></div>
      : <div className="xus-cardbody"><p className="xus-note">{t("admin.chapterLifecycle.unavailable")}</p></div>}
    {!lifecycle?.chapterId ? null : <>
      <section className="xus-cardbody xus-form" aria-labelledby="chapter-binding-heading">
        <div><h3 className="xus-etitle" id="chapter-binding-heading">{t("admin.chapterLifecycle.bindingTitle")}</h3>
          <p className="xus-note">{binding
            ? t("admin.chapterLifecycle.bindingState", { organization: boundOrg?.name || binding.union_org_id, status: statusLabel(t, binding.status) })
            : t("admin.chapterLifecycle.bindingEmpty")}</p>
          {binding?.public_note && <p className="xus-meta">{binding.public_note}</p>}
        </div>
        {binding?.status !== "verified" && <form className="xus-form" onSubmit={search}>
          <label className="xus-field">{t("admin.chapterLifecycle.orgSearch")}
            <input className="xus-input" type="search" value={query} maxLength="80" onChange={(event) => { setQuery(event.target.value); setSearchFailed(false); }} />
          </label>
          <BusyButton className="xus-btn" type="submit" pending={busy !== null} disabled={!searchable}
            disabledReason={t("admin.chapterLifecycle.searchRule", { min: REGISTRY_SEARCH_MIN_LENGTH })}>{busy === "search" ? t("admin.chapterLifecycle.searching") : t("admin.chapterLifecycle.search")}</BusyButton>
          {searchFailed && <p className="xus-note xus-note--error" role="alert">{t("admin.chapterLifecycle.searchFailed")}</p>}
          {results.length > 0 && <fieldset className="xus-form"><legend className="xus-field">{t("admin.chapterLifecycle.orgResults")}</legend>
            {results.map((organizationResult) => <label className="xus-check" key={organizationResult.id}>
              <input type="radio" name="union-organization" checked={visibleSelection?.id === organizationResult.id} onChange={() => setSelectedOrg(organizationResult)} />
              <span>{organizationResult.name} · {[organizationResult.affiliation, [organizationResult.designation, organizationResult.local_number].filter(Boolean).join(" "), organizationResult.city, organizationResult.state].filter(Boolean).join(" · ")}</span>
            </label>)}
          </fieldset>}
          {searchable && searched && results.length === 0 && <p className="xus-note">{t("admin.chapterLifecycle.orgNoResults")}</p>}
          <BusyButton type="button" className="xus-btn xus-btn--go" pending={busy !== null} disabled={!visibleSelection} onClick={() => {
            const orgId = visibleSelection?.id;
            if (!orgId) return;
            act("binding-request", () => api.requestChapterBinding(orgId), "admin.chapterLifecycle.bindingRequested");
          }}>{t("admin.chapterLifecycle.requestBinding")}</BusyButton>
        </form>}
        {binding?.status === "requested" && <p className="xus-note">{t("admin.chapterLifecycle.reviewBoundary")}</p>}
      </section>
      <section className="xus-cardbody xus-form xus-cardbody--divided" aria-labelledby="chapter-connections-heading">
        <div><h3 className="xus-etitle" id="chapter-connections-heading">{t("admin.chapterLifecycle.connectionsTitle")}</h3><p className="xus-note">{t("admin.chapterLifecycle.connectionsSub")}</p></div>
        <div className="xus-formgrid">
          <label className="xus-field">{t("admin.chapterLifecycle.capability")}
            <select className="xus-input" value={capability} onChange={(event) => setCapability(event.target.value)}>{CONNECTIONS.map((item) => <option value={item} key={item}>{t(`admin.chapterLifecycle.capability.${item}`)}</option>)}</select>
          </label>
          <label className="xus-field">{t("admin.chapterLifecycle.providerLabel")}
            <input className="xus-input" maxLength="100" value={providerLabel} onChange={(event) => setProviderLabel(event.target.value)} />
          </label>
        </div>
        <BusyButton type="button" className="xus-btn" pending={busy !== null} onClick={() => act("connection-request", () => api.requestConnectionSetup(capability, providerLabel), "admin.chapterLifecycle.connectionRequested")}>{t("admin.chapterLifecycle.requestConnection")}</BusyButton>
        {(lifecycle.connections || []).map((connection) => <div className="xus-erow" key={connection.capability}>
          <div className="xus-emain"><strong className="xus-etitle">{t(`admin.chapterLifecycle.capability.${connection.capability}`)}</strong><p className="xus-eline">{statusLabel(t, connection.status)}{connection.provider_label ? ` · ${connection.provider_label}` : ""}</p><small className="xus-meta">{connection.public_message}</small></div>
          {orgWide && <div className="xus-form">
            <label className="xus-field">{t("admin.chapterLifecycle.verificationMessage")}
              <input className="xus-input" maxLength="500" value={connectionNotes[connection.capability] || ""} onChange={(event) => setConnectionNotes((current) => ({ ...current, [connection.capability]: event.target.value }))} />
            </label>
            <div className="xus-btnrow">{["active", "error", "disabled"].map((status) => <BusyButton type="button" className={`xus-btn${status === "active" ? " xus-btn--go" : ""}`} pending={busy !== null} key={status} onClick={() => act(`connection-${connection.capability}-${status}`, () => api.verifyConnectionSetup({ chapterId: lifecycle.chapterId, capability: connection.capability, status, publicMessage: connectionNotes[connection.capability] || "" }), "admin.chapterLifecycle.connectionVerified")}>{t(`admin.chapterLifecycle.mark.${status}`)}</BusyButton>)}</div>
          </div>}
        </div>)}
        {lifecycle.connections?.length === 0 && <p className="xus-note">{t("admin.chapterLifecycle.connectionsEmpty")}</p>}
      </section>
    </>}
  </article>;
}

export function HandshakeDocumentsCard({ lifecycle, api, reload, onNotice }) {
  const { t } = useLang();
  const active = useMemo(() => (lifecycle?.handshakes || []).filter((item) => item.status === "active" && item.data_scope === "docs_only"), [lifecycle]);
  const [handshakeId, setHandshakeId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState(false);
  function share(event) {
    return runBusyWrite(busyWriteRef, "share", () => shareNow(event), event);
  }

  async function shareNow(event) {
    event.preventDefault();
    if (!handshakeId || !documentId || busy) return;
    setBusy(true); setError(false);
    try {
      await api.shareHandshakeDocument(handshakeId, documentId, crypto.randomUUID());
      onNotice(t("admin.chapterLifecycle.documentShared"));
      await reload();
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <article id="admin-handshake-documents" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
    <header className="xus-cardhead"><span className="xus-glyph" aria-hidden="true"><Network size={18} /></span><div className="xus-cardhead__copy"><WorkspaceCardTitle outline className="xus-cardttl">{t("admin.chapterLifecycle.documentsTitle")}</WorkspaceCardTitle><p className="xus-cardsub">{t("admin.chapterLifecycle.documentsSub")}</p></div></header>
    <form className="xus-cardbody xus-form" onSubmit={share}>
      {error && <p className="xus-note xus-note--error" role="alert">{t("admin.chapterLifecycle.documentError")}</p>}
      <label className="xus-field">{t("admin.chapterLifecycle.activeHandshake")}
        <select className="xus-input" value={handshakeId} onChange={(event) => setHandshakeId(event.target.value)}><option value="">{t("admin.chapterLifecycle.chooseHandshake")}</option>{active.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select>
      </label>
      <label className="xus-field">{t("admin.chapterLifecycle.publishedDocument")}
        <select className="xus-input" value={documentId} onChange={(event) => setDocumentId(event.target.value)}><option value="">{t("admin.chapterLifecycle.chooseDocument")}</option>{(lifecycle?.documents || []).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select>
      </label>
      <BusyButton className="xus-btn xus-btn--go" type="submit" pending={busy} disabled={!handshakeId || !documentId}>{busy ? t("admin.chapterLifecycle.sharing") : t("admin.chapterLifecycle.shareDocument")}</BusyButton>
      {active.length === 0 && <p className="xus-note">{t("admin.chapterLifecycle.noDocumentHandshake")}</p>}
    </form>
    {(lifecycle?.sharedDocuments || []).slice(0, 5).map((item) => <div className="xus-row" key={`${item.handshake_id}:${item.document_id}`}><div className="xus-rowmain"><strong className="xus-name">{sharedDocumentTitle(item)}</strong><small className="xus-meta">{t("admin.chapterLifecycle.sharedRecord")}</small></div></div>)}
    {(lifecycle?.events || []).slice(0, 5).map((event) => <div className="xus-row" key={event.id}><div className="xus-rowmain"><strong className="xus-name">{t(`admin.chapterLifecycle.transition.${event.transition}`)}</strong><small className="xus-meta">{statusLabel(t, event.to_status)}</small></div></div>)}
  </article>;
}

// Membership administration is deliberately explicit: an admin names the
// person, names the chapter, and each button maps to exactly one audited RPC.
// Nothing here infers a target from the current hat or the selected chapter.
//
// BUG-UG-CHAPTER-MEMBERSHIP-REVOKE-GENERIC-REFUSAL-20261103: every
// refusal said "refused or could not be confirmed", and a revoke that
// committed after the client gave up waiting (REST calls are bounded at 30 s,
// the RPC waits on two advisory locks) read as refused. A refusal is now
// named by its server code, and a lost answer re-reads the member: success
// only when the re-read proves the change, "not saved" only when it proves
// the opposite, otherwise "could not be confirmed". The person's row is read
// again after every write, so the card never offers a change it already made.
//
// BUG-UG-CHAPTER-MEMBERSHIP-EXACT-STATE-READ-20261103: that row names
// one chapter and organization-wide roles, so the buttons also read the
// member's exact chapters (api.loadMemberChapterMemberships): which chapters
// they hold, the roles held in each and whether a chapter is their last. That
// read is repeated after every write; while it is missing the card falls back
// to what the directory row proves. Opening the revoke confirm reads it again
// and words the confirm from that fresh answer, since another admin may have
// removed the member's other chapter meanwhile; Confirm reads it once more
// and refuses if the member's chapters changed from what the confirm showed.
// Even then a revoke cannot be bound to that read, so a non-last confirm keeps
// the conditional organization-removal warning. A failed refresh keeps the
// last read and says so, and an answer for a member no longer selected is
// dropped.
const MEMBERSHIP_REFUSALS = Object.freeze([
  ["lastAdmin", /last organization admin/u],
  ["ownAdminRole", /cannot remove the active admin role/u],
  ["notMember", /membership unavailable|active chapter membership required/u],
  ["unavailable", /membership target unavailable|active organization membership required|unknown role/u],
]);

function membershipRefusal(error) {
  const code = String(error?.code ?? "");
  if (code === "42501") return "session";
  if (code === "22023") {
    const message = String(error?.message ?? "");
    return MEMBERSHIP_REFUSALS.find(([, pattern]) => pattern.test(message))?.[0] ?? "unavailable";
  }
  // No server code: the request or its answer was lost, so the write may
  // have committed.
  return "unconfirmed";
}

// What a fresh directory row proves about a write: "applied", "notApplied",
// or null when the row cannot tell. The row names one active chapter (home
// first) and the member's roles: organization-wide for an organization
// Admin, the selected chapter's for a chapter Admin, who can act only there.
function provenOutcome(action, before, reread, orgWide) {
  if (!reread) return null;
  const { row, complete } = reread;
  if (action.kind === "revoke") {
    if (!row) return complete ? "applied" : null;
    if (row.chapterId === action.chapterId) return "notApplied";
    return before?.chapterId === action.chapterId ? "applied" : null;
  }
  if (action.kind === "grant") return row?.chapterId === action.chapterId ? "applied" : null;
  if (!row || !Array.isArray(row.roles)) return null;
  const held = row.roles.includes(action.role);
  const heldBefore = Array.isArray(before?.roles) && before.roles.includes(action.role);
  if (action.kind === "role-grant") {
    if (!held) return "notApplied";
    return !orgWide || !heldBefore ? "applied" : null;
  }
  if (!held) return "applied";
  return orgWide ? null : "notApplied";
}

export function ChapterMembershipCard({ directory, organization, api, reload, onNotice }) {
  const { t } = useLang();
  const chapters = organization?.chapters || [];
  const orgWide = organization?.scope === "organization";
  const chapterOnly = organization?.scope === "chapter";
  const ownChapterId = organization?.chapterId || directory?.context?.chapterId || null;
  const ownChapter = chapters.find((chapter) => chapter.id === ownChapterId) ?? null;
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState(directory?.items || []);
  const [userId, setUserId] = useState("");
  const [chapterId, setChapterId] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(null);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [outcome, setOutcome] = useState(null);
  // null, or { userId, chapterId, status: "none" | "checking" | "fresh" | "failed", lastChapter }.
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  // Chapter role removal waits for the same confirmation shape as an
  // organization-wide role removal. Membership removal keeps its own confirm.
  const [confirmingRoleRevoke, setConfirmingRoleRevoke] = useState(null);
  const [holdings, setHoldings] = useState(null);
  const holdingsRequest = useRef(0);
  const selectedRef = useRef(userId);
  selectedRef.current = userId;
  const chapterRef = useRef(chapterId);
  chapterRef.current = chapterId;
  // Each Confirm press holds a token; Cancel or a new choice retires it, so a
  // confirm-time read that answers late never starts the revoke.
  const confirmPress = useRef(0);
  const selected = useMemo(() => people.find((person) => person.userId === userId) ?? null, [people, userId]);
  const chapter = chapters.find((item) => item.id === chapterId) ?? null;
  const names = { member: selected?.fullName || "", chapter: chapter?.name || chapterId, role: role ? t(ROLE_LABEL_KEYS[role]) : "" };
  const outOfScope = (id) => chapterOnly && Boolean(ownChapterId) && id !== ownChapterId;

  // A new choice or a new action retires the last outcome and any open
  // confirmation, so an old refusal never sits above a fresh step.
  function closeConfirm() {
    confirmPress.current += 1;
    setConfirmRevoke(null);
    setConfirmingRoleRevoke(null);
  }
  function clearOutcome() { setOutcome(null); closeConfirm(); }

  function search(event) {
    return runBusyWrite(busyWriteRef, "membership", () => searchNow(event), event);
  }

  async function searchNow(event) {
    event.preventDefault();
    if (busy) return;
    setBusy("search"); clearOutcome();
    try {
      const page = await api.loadMemberDirectory(query.trim(), null);
      setPeople(Array.isArray(page?.items) ? page.items : []);
      // The member chosen now, not when the search started: the selector stays
      // usable while it runs.
      const current = selectedRef.current;
      const kept = (page?.items || []).some((person) => person.userId === current) ? current : "";
      setUserId(kept);
      // The same member stays selected, so read their chapters again here.
      if (kept) loadHoldings(kept);
    } catch { setOutcome({ key: "searchError" }); }
    finally { setBusy(null); }
  }

  // Resolves to the fresh holdings, false when the read failed, or null when
  // it was skipped or overtaken (another member is selected, or a newer read
  // for this one is in flight).
  async function loadHoldings(id) {
    if (!id || typeof api?.loadMemberChapterMemberships !== "function") {
      holdingsRequest.current += 1;
      setHoldings(null);
      return null;
    }
    if (id !== selectedRef.current) return null;
    const request = ++holdingsRequest.current;
    let fresh = null;
    try { fresh = { ...(await api.loadMemberChapterMemberships(id)), userId: id, stale: false }; }
    catch { fresh = null; }
    if (request !== holdingsRequest.current || id !== selectedRef.current) return null;
    setHoldings((current) => fresh ?? (current?.userId === id ? { ...current, stale: true } : null));
    return fresh ?? false;
  }

  async function openRevoke() {
    setOutcome(null);
    setConfirmingRoleRevoke(null);
    const target = { userId, chapterId };
    if (typeof api?.loadMemberChapterMemberships !== "function") {
      setConfirmRevoke({ ...target, status: "none" });
      return;
    }
    setConfirmRevoke({ ...target, status: "checking" });
    const fresh = await loadHoldings(target.userId);
    setConfirmRevoke((current) => {
      if (current?.userId !== target.userId || current?.chapterId !== target.chapterId) return current;
      if (!fresh) return { ...current, status: "failed" };
      const row = fresh.chapters.find((item) => item.chapterId === target.chapterId);
      // No longer held: close the confirm; Revoke now shows why it is off.
      return row ? { ...current, status: "fresh", lastChapter: row.lastChapter } : null;
    });
  }

  // Confirm reads the chapters once more. Wording from a fresh read is honoured
  // only if the member's chapters still match it; a failed read turns the
  // confirm to the "could not be confirmed" wording for a second press.
  async function confirmRevokeChange() {
    const shown = confirmRevoke;
    if (!shown || shown.verifying) return;
    const press = ++confirmPress.current;
    if (shown.status === "fresh") {
      setConfirmRevoke({ ...shown, verifying: true });
      const fresh = await loadHoldings(shown.userId);
      if (press !== confirmPress.current) return;
      if (selectedRef.current !== shown.userId || chapterRef.current !== shown.chapterId) return;
      if (!fresh) {
        setConfirmRevoke((current) => (current?.userId === shown.userId && current?.chapterId === shown.chapterId ? { ...shown, status: "failed" } : current));
        return;
      }
      const row = fresh.chapters.find((item) => item.chapterId === shown.chapterId);
      if (!row || row.lastChapter !== shown.lastChapter) {
        setConfirmRevoke(null);
        setOutcome({ key: "changed", ...names });
        return;
      }
    }
    act({ kind: "revoke", chapterId: shown.chapterId, member: names.member, work: () => api.revokeChapterMembership(shown.userId, shown.chapterId), notice: "admin.chapterLifecycle.membershipRevoked" });
  }

  useEffect(() => { loadHoldings(userId); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function rereadMember(person) {
    try {
      const page = await api.loadMemberDirectory(String(person.fullName || "").trim(), null);
      const items = Array.isArray(page?.items) ? page.items : [];
      const row = items.find((item) => item.userId === person.userId) ?? null;
      return { row, complete: row !== null || !page?.nextCursor };
    } catch {
      return null;
    }
  }

  function successNotice(action, reread) {
    if (action.kind === "revoke" && orgWide && reread?.complete && !reread.row) {
      return t("admin.chapterLifecycle.removedFromOrganization", { member: action.member });
    }
    return t(action.notice);
  }

  function act(action) {
    return runBusyWrite(busyWriteRef, "membership", () => actNow(action));
  }

  async function actNow(action) {
    if (!selected || !chapterId || busy) return;
    const before = selected;
    setBusy(action.kind); setOutcome(null);
    let refusal = null;
    try { await action.work(); }
    catch (error) { refusal = membershipRefusal(error); }
    const reread = await rereadMember(before);
    await loadHoldings(before.userId);
    if (reread?.row) setPeople((current) => current.map((person) => (person.userId === before.userId ? reread.row : person)));
    else if (reread?.complete) {
      setPeople((current) => current.filter((person) => person.userId !== before.userId));
      setUserId("");
    }
    const proof = refusal === "unconfirmed" ? provenOutcome(action, before, reread, orgWide) : null;
    setConfirmRevoke(null);
    if (!refusal || proof === "applied") {
      onNotice(successNotice(action, reread));
    } else {
      setOutcome({ key: refusal === "unconfirmed" ? (proof === "notApplied" ? "notSaved" : "unconfirmed") : refusal, ...names });
    }
    setBusy(null);
    try { await reload(); } catch { /* the desk shows its own load state */ }
  }

  const roles = Array.isArray(selected?.roles) ? selected.roles : [];
  const currentChapterId = selected?.chapterId || null;
  const scopeReason = chapterId && outOfScope(chapterId) ? "outOfScope" : null;
  const exact = holdings?.userId === userId ? holdings : null;
  const holding = (id) => exact?.chapters.find((row) => row.chapterId === id) ?? null;
  const held = chapterId ? holding(chapterId) : null;
  const notHeld = exact && chapterId && !held ? "notMemberHere" : null;
  const grantReason = scopeReason || (chapterId && (exact ? held : currentChapterId === chapterId) ? "alreadyMember" : null);
  const revokeReason = scopeReason || notHeld;
  // #7663: a steward needs a unit, which this screen does not choose.
  const roleGrantReason = scopeReason || (!role ? "chooseRole" : notHeld || ((exact ? held?.roles.includes(role) : chapterOnly && roles.includes(role)) ? "roleHeld" : role === "steward" ? "stewardNeedsUnit" : null));
  const roleRevokeReason = scopeReason || (!role ? "chooseRole" : notHeld || (exact ? (held?.roles.includes(role) ? null : "roleNotHeldHere") : !roles.includes(role) ? "roleNotHeld" : null));
  const confirmOpen = confirmRevoke?.userId === userId && confirmRevoke?.chapterId === chapterId ? confirmRevoke : null;
  const roleConfirm = confirmingRoleRevoke
    && confirmingRoleRevoke.userId === userId
    && confirmingRoleRevoke.chapterId === chapterId
    && confirmingRoleRevoke.role === role
    ? confirmingRoleRevoke
    : null;
  const confirmKey = {
    none: "confirmRevoke",
    checking: "confirmRevokeChecking",
    failed: "confirmRevokeUnconfirmed",
    fresh: confirmOpen?.lastChapter ? "confirmRevokeLast" : "confirmRevokeOther",
  }[confirmOpen?.status];
  const ready = busy === null && Boolean(selected) && Boolean(chapterId);
  const reasonNote = (reason, id) => reason && ready ? <p className="xus-meta" id={id}>{t(`admin.chapterLifecycle.disabled.${reason}`, { ...names, own: ownChapter?.name || ownChapterId || "" })}</p> : null;
  const chapterLabel = (item) => {
    const row = exact ? holding(item.id) : null;
    if (row?.home) return t("admin.chapterLifecycle.chapterHome", { chapter: item.name });
    if (exact ? row : item.id === currentChapterId) return t("admin.chapterLifecycle.chapterCurrent", { chapter: item.name });
    return outOfScope(item.id) ? t("admin.chapterLifecycle.chapterOutOfScope", { chapter: item.name }) : item.name;
  };

  return <article id="admin-chapter-memberships" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
    <header className="xus-cardhead"><span className="xus-glyph" aria-hidden="true"><UserRoundCog size={18} /></span><div className="xus-cardhead__copy"><WorkspaceCardTitle outline className="xus-cardttl">{t("admin.chapterLifecycle.membershipTitle")}</WorkspaceCardTitle><p className="xus-cardsub">{t("admin.chapterLifecycle.membershipSub")}</p></div></header>
    {chapterOnly && <div className="xus-cardbody"><div className="xus-note" role="note" data-membership-scope-notice="">
      <p>{t("admin.chapterLifecycle.scopeNotice", { chapter: ownChapter?.name || ownChapterId || t("admin.chapterLifecycle.noHomeChapter") })}</p>
      <div className="xus-btnrow"><a className="xus-btn" href="/m/settings/security">{t("admin.chapterLifecycle.scopeNoticeAction")}</a></div>
    </div></div>}
    {outcome && <div className="xus-cardbody"><p className="xus-note xus-note--error" role="alert">{t(`admin.chapterLifecycle.refusal.${outcome.key}`, outcome)}</p></div>}
    <section className="xus-cardbody xus-form" aria-labelledby="membership-step-member">
      <div><h3 className="xus-etitle" id="membership-step-member">{t("admin.chapterLifecycle.stepMember")}</h3><p className="xus-note">{t("admin.chapterLifecycle.stepMemberSub")}</p></div>
      <form className="xus-form" onSubmit={search}>
        <label className="xus-field">{t("admin.chapterLifecycle.memberSearch")}
          <input className="xus-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <BusyButton className="xus-btn" type="submit" pending={busy !== null}>{busy === "search" ? t("admin.chapterLifecycle.searching") : t("admin.chapterLifecycle.searchMembers")}</BusyButton>
      </form>
      <label className="xus-field">{t("admin.chapterLifecycle.member")}
        <select className="xus-input" value={userId} onChange={(event) => { setUserId(event.target.value); clearOutcome(); }}><option value="">{t("admin.chapterLifecycle.chooseMember")}</option>{people.map((person) => <option value={person.userId} key={person.userId}>{person.fullName}</option>)}</select>
      </label>
      {selected && <p className="xus-meta" role="status">{t("admin.chapterLifecycle.memberContext", {
        chapter: selected.chapterName || selected.chapterId || t("admin.chapterLifecycle.noHomeChapter"),
        roles: roles.length ? roles.map((item) => t(ROLE_LABEL_KEYS[item] || item)).join(", ") : t("admin.chapterLifecycle.noRoles"),
      })}</p>}
      {exact?.stale && <p className="xus-note" data-membership-holdings-stale="">{t("admin.chapterLifecycle.holdingsStale", names)}</p>}
      {people.length === 0 && <p className="xus-note">{t("admin.chapterLifecycle.membersEmpty")}</p>}
    </section>
    <section className="xus-cardbody xus-form xus-cardbody--divided" aria-labelledby="membership-step-chapter">
      <div><h3 className="xus-etitle" id="membership-step-chapter">{t("admin.chapterLifecycle.stepChapter")}</h3><p className="xus-note">{t("admin.chapterLifecycle.stepChapterSub")}</p></div>
      <label className="xus-field">{t("admin.chapterLifecycle.chapter")}
        <select className="xus-input" value={chapterId} onChange={(event) => { setChapterId(event.target.value); clearOutcome(); }}><option value="">{t("admin.chapterLifecycle.chooseChapter")}</option>{chapters.map((item) => <option value={item.id} key={item.id} disabled={outOfScope(item.id)}>{chapterLabel(item)}</option>)}</select>
      </label>
      <div className="xus-btnrow">
        <BusyButton type="button" className="xus-btn xus-btn--go" pending={busy !== null} disabled={!selected || !chapterId || Boolean(grantReason)} aria-describedby={grantReason && ready ? "membership-grant-reason" : undefined} onClick={() => { clearOutcome(); act({ kind: "grant", chapterId, work: () => api.grantChapterMembership(userId, chapterId), notice: "admin.chapterLifecycle.membershipGranted" }); }}>{busy === "grant" ? t("admin.chapterLifecycle.working") : t("admin.chapterLifecycle.grantMembership")}</BusyButton>
        <BusyButton type="button" className="xus-btn xus-btn--danger" pending={busy !== null} disabled={!selected || !chapterId || Boolean(revokeReason)} aria-describedby={revokeReason && ready ? (revokeReason === grantReason ? "membership-grant-reason" : "membership-revoke-reason") : undefined} onClick={openRevoke}>{t("admin.chapterLifecycle.revokeMembership")}</BusyButton>
      </div>
      {reasonNote(grantReason, "membership-grant-reason")}
      {revokeReason !== grantReason && reasonNote(revokeReason, "membership-revoke-reason")}
      {confirmOpen && <div className="xus-confirm" role="alert"><p className="xus-note">{t(`admin.chapterLifecycle.${confirmKey}`, names)}</p><div className="xus-btnrow"><BusyButton type="button" className="xus-btn xus-btn--danger" pending={busy !== null || confirmOpen.verifying === true} disabled={confirmOpen.status === "checking"} onClick={confirmRevokeChange}>{busy === "revoke" || confirmOpen.verifying ? t("admin.chapterLifecycle.working") : t("admin.chapterLifecycle.confirm")}</BusyButton><BusyButton type="button" className="xus-btn" pending={busy !== null} onClick={closeConfirm}>{t("admin.cancel")}</BusyButton></div></div>}
      {chapters.length === 0 && (organizationHasNoChapter(organization) ? <NoChapterYetNotice /> : <p className="xus-note">{t("admin.chapterLifecycle.chaptersEmpty")}</p>)}
    </section>
    <section className="xus-cardbody xus-form xus-cardbody--divided" aria-labelledby="membership-step-role">
      <div><h3 className="xus-etitle" id="membership-step-role">{t("admin.chapterLifecycle.stepRole")}</h3><p className="xus-note">{t("admin.chapterLifecycle.roleBoundary")}</p></div>
      <label className="xus-field">{t("admin.chapterLifecycle.chapterRole")}
        <select className="xus-input" value={role} onChange={(event) => { setRole(event.target.value); clearOutcome(); }}><option value="">{t("admin.chapterLifecycle.chooseRole")}</option>{CHAPTER_ROLES.map((item) => <option value={item} key={item}>{t(ROLE_LABEL_KEYS[item])}</option>)}</select>
      </label>
      <div className="xus-btnrow">
        <BusyButton type="button" className="xus-btn" pending={busy !== null} disabled={!selected || !chapterId || Boolean(roleGrantReason)} aria-describedby={roleGrantReason && ready ? "membership-role-grant-reason" : undefined} onClick={() => { clearOutcome(); act({ kind: "role-grant", chapterId, role, work: () => api.setChapterRole(userId, chapterId, role, true), notice: "admin.chapterLifecycle.roleGranted" }); }}>{busy === "role-grant" ? t("admin.chapterLifecycle.working") : t("admin.chapterLifecycle.grantRole")}</BusyButton>
        <BusyButton type="button" className="xus-btn" pending={busy !== null} disabled={!selected || !chapterId || Boolean(roleRevokeReason)} aria-describedby={roleRevokeReason && ready ? (roleRevokeReason === roleGrantReason ? "membership-role-grant-reason" : "membership-role-revoke-reason") : undefined} onClick={() => { clearOutcome(); setConfirmingRoleRevoke({ userId, chapterId, role }); }}>{busy === "role-revoke" ? t("admin.chapterLifecycle.working") : t("admin.chapterLifecycle.revokeRole")}</BusyButton>
      </div>
      {reasonNote(roleGrantReason, "membership-role-grant-reason")}
      {roleRevokeReason !== roleGrantReason && reasonNote(roleRevokeReason, "membership-role-revoke-reason")}
    </section>
    {roleConfirm && <ConfirmActionDialog
      title={t("admin.chapterLifecycle.confirmRevokeRole", names)}
      effects={[t("admin.chapterLifecycle.confirmRevokeRoleEffect", names)]}
      affected={names.member}
      confirmLabel={t("admin.chapterLifecycle.confirmRevokeRoleGo", names)}
      onClose={() => setConfirmingRoleRevoke(null)}
      onConfirm={() => {
        const pending = roleConfirm;
        setConfirmingRoleRevoke(null);
        act({ kind: "role-revoke", chapterId: pending.chapterId, role: pending.role, work: () => api.setChapterRole(pending.userId, pending.chapterId, pending.role, false), notice: "admin.chapterLifecycle.roleRevoked" });
      }}
    />}
  </article>;
}
