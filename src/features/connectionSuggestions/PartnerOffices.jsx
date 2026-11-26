import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "../../components/Dialog.jsx";
import { partnerOfficesT } from "../../lib/i18n/partnerOffices.js";
import { localeFor } from "../../lib/i18n/format.js";
import { unionNetworkCopy } from "../unionCatalog/unionNetworkCopy.js";
import { scoreConnection } from "./engine.js";
import { BusyButton, BusyInput, BusySelect, BusyTextarea } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031:
// catalogue offices that have no chapter on Union Ground yet. A chapter can
// leave a standing handshake offer that waits for the office to join, or ask
// the operator to invite a named contact. Only public catalogue fields are
// shown, and the panel never describes the requesting chapter's affiliation.
const WRITE_HATS = ["advisor", "admin", "vp"];
const SCOPES = ["no_member_data", "docs_only", "aggregate_only"];
const MIN_CONTACT_NAME_LENGTH = 2;

function partnerOfficeError(error) {
  const message = String(error?.message || "");
  if (error?.code === "23505") return "partnerErrorDuplicate";
  if (error?.code === "42501") return "partnerErrorPermission";
  if (/limit reached/.test(message)) return "partnerErrorLimit";
  if (/already on the platform/.test(message)) return "partnerErrorOnPlatform";
  if (/not onboarded/.test(message)) return "partnerErrorOnboarding";
  if (error?.code === "22023") return "partnerErrorInvalid";
  return "partnerErrorGeneric";
}

// On the suggestions screen an office is scored with the same dials as a
// chapter, from the only fields the catalogue has (state and sectors; the
// catalogue is the US register). Missing dimensions count as no match, as
// they do for chapters. A name search keeps the server's order otherwise.
function scorePartnerOffices(rows, source, settings) {
  const now = Date.now();
  const scored = rows.map((office, index) => {
    const result = source && settings ? scoreConnection({ source, settings: { ...settings, freshnessDays: null }, now, candidate: {
      id: office.unionOrgId, kind: "local", discoverable: true, displayName: office.name,
      location: { country: office.state ? "US" : null, state: office.state }, sectorKeys: office.sectorTags,
    } }) : null;
    return { office, index, score: result ? result.score : null };
  });
  return scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.index - b.index).map(({ office, score }) => ({ ...office, score }));
}

const formatDate = (value, lang) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(localeFor(lang), { dateStyle: "medium" }).format(date);
};

function PartnerOfficeDialog({ kind, office, chapterId, adapter, lang, onClose, onSaved }) {
  const tr = (key, vars) => partnerOfficesT(lang, key, vars);
  const network = unionNetworkCopy(lang);
  const [fields, setFields] = useState({ title: "", purpose: "", dataScope: "no_member_data", name: "", email: "", locale: lang === "es" ? "es" : "en" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const submitButton = useRef(null);
  const pending = useRef(null);
  const inFlight = useRef(false);
  const offer = kind === "offer";
  const problem = offer
    ? !fields.title.trim() ? "partnerOfferNeedsTitle" : !fields.purpose.trim() ? "partnerOfferNeedsPurpose" : null
    : fields.name.trim().length < MIN_CONTACT_NAME_LENGTH ? "partnerInviteNeedsName" : !fields.email.includes("@") ? "partnerInviteNeedsEmail" : null;
  const field = (key) => (event) => setFields((prior) => ({ ...prior, [key]: event.target.value }));
  async function submit(event) {
    event.preventDefault();
    if (inFlight.current) return;
    if (problem) {
      // The disabled button announces the reason and prevents another submit.
      submitButton.current?.click();
      return;
    }
    const payload = offer
      ? { title: fields.title.trim(), purpose: fields.purpose.trim(), dataScope: fields.dataScope }
      : { name: fields.name.trim(), email: fields.email.trim(), locale: fields.locale };
    // A retry of the same request reuses its key, so a lost response cannot
    // leave a second offer or a second invitation request behind.
    const signature = JSON.stringify([kind, chapterId, office.unionOrgId, payload]);
    if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
    inFlight.current = true; setBusy(true); setFailure("");
    try {
      if (offer) await adapter.createPartnerOffer(chapterId, office.unionOrgId, payload, pending.current.key);
      else await adapter.requestPartnerInvitation(chapterId, office.unionOrgId, office.openOffer?.id, payload, pending.current.key);
      onSaved(offer ? "partnerOfferSaved" : "partnerInviteSaved");
    } catch (error) { setFailure(partnerOfficeError(error)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title={tr(offer ? "partnerOfferDialog" : "partnerInviteDialog")} beforeClose={() => !inFlight.current} closeBlocked={busy} closeOperationKey={`${kind}:${office.unionOrgId}`} onClose={onClose}>
    <form className="xus-form" onSubmit={submit}>
      <p><strong>{network("to")}:</strong> {office.name}</p>
      <p>{offer ? tr("partnerOfferHelp", { office: office.name }) : tr("partnerInviteHelp")}</p>
      {!offer && office.openOffer && <p>{tr("partnerInviteOffer", { title: office.openOffer.title })}</p>}
      {offer ? <>
        <label className="xus-field">{network("title")}<BusyInput className="xus-input" required maxLength={160} value={fields.title} onChange={field("title")} pending={busy} /></label>
        <label className="xus-field">{network("purpose")}<BusyTextarea className="xus-input" required maxLength={4000} value={fields.purpose} onChange={field("purpose")} pending={busy} /></label>
        <label className="xus-field">{network("scope")}<BusySelect className="xus-input" value={fields.dataScope} onChange={field("dataScope")} pending={busy}>
          {SCOPES.map((key) => <option key={key} value={key}>{network(key)}</option>)}
        </BusySelect></label>
      </> : <>
        <label className="xus-field">{tr("partnerContactName")}<BusyInput className="xus-input" required minLength={MIN_CONTACT_NAME_LENGTH} maxLength={120} autoComplete="off" value={fields.name} onChange={field("name")} pending={busy} /></label>
        <label className="xus-field">{tr("partnerContactEmail")}<BusyInput className="xus-input" type="email" required maxLength={254} autoComplete="off" value={fields.email} onChange={field("email")} pending={busy} /></label>
        <label className="xus-field">{tr("partnerContactLocale")}<BusySelect className="xus-input" value={fields.locale} onChange={field("locale")} pending={busy}>
          <option value="en">{tr("partnerEnglish")}</option><option value="es">{tr("partnerSpanish")}</option>
        </BusySelect></label>
      </>}
      {failure && <p role="alert" className="xus-note xus-note--error">{tr(failure)}</p>}
      <div className="xus-btnrow"><BusyButton ref={submitButton} type="submit" className="xus-btn xus-btn--go" pending={busy} disabled={Boolean(problem)} disabledReason={problem ? tr(problem, { min: MIN_CONTACT_NAME_LENGTH }) : null}>{tr(busy ? "partnerSending" : offer ? "partnerSubmitOffer" : "partnerSubmitInvite")}</BusyButton>
        <BusyButton type="button" className="xus-btn" pending={busy} onClick={onClose}>{tr("partnerCancel")}</BusyButton></div>
    </form>
  </Dialog>;
}

export function PartnerOffices({ adapter, chapterId, selectedHat, lang = "en", preview = false, source = null, settings = null }) {
  const tr = (key, vars) => partnerOfficesT(lang, key, vars);
  const canWrite = WRITE_HATS.includes(selectedHat);
  const headingId = useId();
  const headingRef = useRef(null);
  const searchHelpId = useId();
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [offices, setOffices] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [loadState, setLoadState] = useState(preview ? "preview" : "loading");
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState("");
  const [busyOffer, setBusyOffer] = useState(null);
  // Synchronous write lock (record 8435), keyed by the record the write changes.
  const busyWriteRef = useRef(new Set());
  const [moreState, setMoreState] = useState("idle");
  const mounted = useRef(true);
  // Each first-page load starts a new generation; a later page from an older
  // search, chapter or refresh is discarded.
  const generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (preview) return undefined;
    let current = true;
    generation.current += 1;
    setLoadState("loading"); setMoreState("idle");
    Promise.all([adapter.listPartnerOffices(chapterId, query), adapter.listPartnerOffers(chapterId)]).then(([page, own]) => {
      if (!current) return;
      setOffices(page); setLedger(own); setLoadState("ready");
    }, (error) => {
      if (current) setLoadState(["PGRST202", "42883"].includes(error?.code) ? "unavailable" : error?.code === "42501" ? "permission" : "error");
    });
    return () => { current = false; };
  }, [adapter, chapterId, query, refresh, preview]);
  const searchValid = !draftQuery.trim() || draftQuery.trim().length >= 2;
  // Further pages append to the list; the query and chapter fix the search.
  async function showMore() {
    if (moreState === "loading" || !offices?.hasMore) return;
    setMoreState("loading");
    const started = generation.current;
    try {
      const page = await adapter.listPartnerOffices(chapterId, query, offices.rows.length);
      if (!mounted.current || started !== generation.current) return;
      setOffices((prior) => ({ ...prior, hasMore: page.hasMore === true,
        rows: [...prior.rows, ...page.rows.filter((row) => !prior.rows.some((seen) => seen.unionOrgId === row.unionOrgId))] }));
      setMoreState("idle");
    } catch { if (mounted.current && started === generation.current) setMoreState("error"); }
  }
  function withdraw(offer) {
    return runBusyWrite(busyWriteRef, `offer:${offer.id}`, () => withdrawNow(offer));
  }

  async function withdrawNow(offer) {
    if (busyOffer) return;
    setBusyOffer(offer.id); setNotice("");
    try {
      await adapter.withdrawPartnerOffer(chapterId, offer.id);
      if (mounted.current) { setNotice("partnerWithdrawn"); setRefresh((value) => value + 1); }
    } catch (error) { if (mounted.current) setNotice(partnerOfficeError(error)); }
    finally { if (mounted.current) setBusyOffer(null); }
  }
  const rows = useMemo(() => offices ? scorePartnerOffices(offices.rows, source, settings) : [], [offices, source, settings]);
  const entries = ledger ? [...ledger.offers.map((row) => ({ ...row, kind: "offer" })), ...ledger.invitations.map((row) => ({ ...row, kind: "invite" }))] : [];
  return <section className="cs-partners oi-card" aria-labelledby={headingId}>
    <h3 id={headingId} ref={headingRef} tabIndex={-1}>{tr("partnerTitle")}</h3>
    <p className="cs-note">{tr("partnerIntro")}</p>
    {loadState === "preview" ? <p className="oi-state">{tr("partnerPreview")}</p> : <>
      <form className="cs-partner-search" role="search" onSubmit={(event) => { event.preventDefault(); if (searchValid) { setNotice(""); setQuery(draftQuery.trim()); } }}>
        <label className="oi-field">{tr("partnerSearch")}<input value={draftQuery} maxLength={80} aria-describedby={searchHelpId} onChange={(event) => setDraftQuery(event.target.value)} /></label>
        <button type="submit" className="oi-button oi-button--secondary" disabled={!searchValid}>{tr("partnerSearchButton")}</button>
      </form>
      <p className="cs-note" id={searchHelpId}>{tr("partnerSearchHelp")}</p>
      {!canWrite && <p className="cs-note">{tr("partnerReadOnly")}</p>}
      {notice && <p role="status" className="oi-notice">{tr(notice)}</p>}
      {loadState === "error" ? <>
        <p className="oi-state" role="alert">{tr("partnerLoadError")}</p>
        <button type="button" className="oi-button oi-button--secondary" onClick={() => {
          headingRef.current?.focus();
          setRefresh((value) => value + 1);
        }}>{tr("partnerRetry")}</button>
      </> : loadState !== "ready" ? <p className="oi-state" role="status">{tr({ loading: "partnerLoading", unavailable: "partnerUnavailable", permission: "partnerErrorPermission" }[loadState] || "partnerLoadError")}</p> : <>
        {rows.length === 0 ? <p className="oi-state">{tr(offices.matchedOn === "none" ? "partnerNeedsState" : "partnerEmpty")}</p>
          : <ul className="cs-partner-list">{rows.map((office) => <li className="cs-partner" key={office.unionOrgId}>
            <div className="cs-result-heading"><div><strong>{office.name}</strong>
              <p>{[office.designation, office.localNumber, office.city, office.state].filter(Boolean).join(" · ")}</p></div>
              <div className="cs-partner-status"><span className="oi-badge">{tr("partnerNotOnPlatform")}</span>
                {office.score !== null && <span className="cs-note">{tr("partnerScore", { score: Math.round(office.score * 100) })}</span>}</div></div>
            <div className="cs-tags">
              {office.sameState && <span className="oi-badge">{tr("partnerSameState")}</span>}
              {office.sharedSectors > 0 && <span className="oi-badge">{tr("partnerSharedSectors", { count: office.sharedSectors })}</span>}
            </div>
            {office.openOffer && <p className="cs-note">{tr("partnerOfferOpen", { date: formatDate(office.openOffer.expiresAt, lang) })}</p>}
            {office.invitationPending && <p className="cs-note">{tr("partnerInvitationPending")}</p>}
            {canWrite && <div className="oi-actions">
              {!office.openOffer && <button type="button" className="oi-button" onClick={() => { setNotice(""); setDialog({ kind: "offer", office }); }}>{tr("partnerMakeOffer")}</button>}
              {!office.invitationPending && <button type="button" className="oi-button oi-button--secondary" onClick={() => { setNotice(""); setDialog({ kind: "invite", office }); }}>{tr("partnerRequestInvite")}</button>}
            </div>}
          </li>)}</ul>}
        {offices.hasMore === true && <div className="oi-actions">
          <button type="button" className="oi-button oi-button--secondary" disabled={moreState === "loading"} onClick={showMore}>{tr(moreState === "loading" ? "partnerLoading" : "partnerShowMore")}</button>
          {moreState === "error" && <p role="alert" className="cs-note">{tr("partnerLoadError")}</p>}
        </div>}
        <h4>{tr("partnerLedger")}</h4>
        <p className="cs-note">{tr("partnerLimits", { offers: ledger.openLimit, invitations: ledger.pendingInvitationLimit })}</p>
        {entries.length === 0 ? <p className="oi-state">{tr("partnerLedgerEmpty")}</p>
          : <ul className="cs-partner-list">{entries.map((entry) => <li className="cs-partner" key={`${entry.kind}:${entry.id}`}>
            <p><strong>{entry.officeName}</strong> · {tr(entry.kind === "offer" ? "partnerOfferKind" : "partnerInviteKind")}{entry.title ? `: ${entry.title}` : ""}</p>
            <p className="cs-note">{tr(`partnerStatus_${entry.status}`)}{entry.kind === "offer" && entry.status === "open" ? ` · ${tr("partnerExpires", { date: formatDate(entry.expiresAt, lang) })}` : ""}</p>
            {canWrite && entry.kind === "offer" && entry.status === "open" && <div className="oi-actions">
              <BusyButton type="button" className="oi-button oi-button--secondary" pending={busyOffer !== null} onClick={() => withdraw(entry)}>{tr("partnerWithdraw")}</BusyButton>
            </div>}
          </li>)}</ul>}
      </>}
    </>}
    {dialog && <PartnerOfficeDialog key={`${dialog.kind}:${dialog.office.unionOrgId}`} kind={dialog.kind} office={dialog.office} chapterId={chapterId} adapter={adapter} lang={lang}
      onClose={() => setDialog(null)} onSaved={(message) => { if (mounted.current) { setDialog(null); setNotice(message); setRefresh((value) => value + 1); } }} />}
  </section>;
}
