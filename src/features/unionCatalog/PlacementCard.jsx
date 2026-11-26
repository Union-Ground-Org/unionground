import { BusyButton } from "../../components/BusyControls.jsx";
import { useEffect, useId, useRef, useState } from "react";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { Dialog } from "../../components/Dialog.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { REGISTRY_STATES } from "./registrySearch.js";
import { PlacementBadge } from "./PlacementBadge.jsx";
import { isMissingRpcError, searchCatalogKeys } from "./catalogSearch.js";

// "Where does your organization belong?" ( brief A17).
// Organization-level and separate from the chapter's union-organization
// binding on /m/admin/chapter-handshake: it stores a catalog key or an
// unlisted name, never reads a binding, and is always self-reported here.
// The first read is also the availability probe: until the DB half is applied
// the card says so and no write is ever called.

// The server refuses the same shapes (brief A7, migration 20260925960000), so
// the admin sees the reason before a round trip: 3 to 200 characters counted
// as the server counts them, no control character, at least one letter or
// digit, no email marker or link, and no run of seven digits (any script)
// once spaces, brackets, dots, plus signs, slashes, underscores and dashes
// are removed.
const PHONE_SEPARATORS = /[\s().+/_\u2010-\u2015\u2212\uFF0D-]/gu;
export function unlistedNameProblem(value) {
  const name = String(value ?? "").trim();
  const length = [...name].length;
  if (length < 3 || length > 200) return true;
  if (/\p{Cc}/u.test(name) || !/[\p{L}\p{Nd}]/u.test(name)) return true;
  if (name.includes("@") || name.includes("://")) return true;
  return /\p{Nd}{7,}/u.test(name.replace(PHONE_SEPARATORS, ""));
}

function errorKey(error) {
  const message = String(error?.message ?? "");
  if (message.includes("placement target unavailable")) return "unions.placement.error.target_unavailable";
  if (message.includes("placement change limit")) return "unions.placement.error.limit";
  if (message.includes("placement name invalid")) return "unions.placement.error.invalidName";
  // Phase 3a: a verified organization cannot change its catalog identity, and
  // one verified by its website domain or the platform cannot clear it.
  if (message.includes("placement verified")) return "unions.placement.error.verified";
  if (error?.code === "42501") return "unions.setup.error.auth";
  return "unions.placement.error.generic";
}

const UNVERIFIED = Object.freeze({ verified: false, catalogKey: null });

export function PlacementCard({ api, organizationId, catalogClient = null, catalogLive = false, onNotice = () => {} }) {
  const { t, lang } = useLang();
  const headingId = useId();
  const dataLang = lang === "en" ? undefined : "en";
  const [state, setState] = useState("loading");
  const [placement, setPlacement] = useState(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [picked, setPicked] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [unlisted, setUnlisted] = useState({ name: "", state: "", identity: false });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // A parent change while verified waits here for the admin to confirm it.
  const [confirmParent, setConfirmParent] = useState(null);
  const [errorTick, setErrorTick] = useState(0);
  const errorRef = useRef(null);
  // Catalog-listing verification (organization claims) is left
  // out: a campaign that is still forming has no public-record listing to
  // claim, so its placement is never a verified one.
  const verification = UNVERIFIED;
  // One idempotency key per user action; a retry of the same action reuses it.
  const pendingAction = useRef(null);
  const busyWriteRef = useRef(new Set());
  // After a write the control that had focus may be gone; focus the heading.
  const headingRef = useRef(null);
  const errorId = useId();

  useEffect(() => {
    let live = true;
    api.getOrganizationCatalogPlacement(organizationId)
      .then((value) => { if (live) { setPlacement(value); setState("ready"); } })
      .catch((err) => { if (live) setState(isMissingRpcError(err) ? "unavailable" : "error"); });
    return () => { live = false; };
  }, [api, organizationId]);

  // Move focus to the explanation after a refused write.
  useEffect(() => {
    if (errorTick) errorRef.current?.focus();
  }, [errorTick]);

  function actionKey(signature) {
    if (pendingAction.current?.signature !== signature) {
      pendingAction.current = { signature, key: globalThis.crypto.randomUUID() };
    }
    return pendingAction.current.key;
  }

  async function write(signature, work, notice) {
    if (busy) return;
    return runBusyWrite(busyWriteRef, "placement", async (release) => {
      setBusy("write");
      setError(null);
      try {
        const next = await work(actionKey(signature));
        pendingAction.current = null;
        setPlacement(next);
        setPicked(null);
        setAddOpen(false);
        onNotice(t(notice));
        headingRef.current?.focus();
      } catch (err) {
        setError(errorKey(err));
        setErrorTick((value) => value + 1);
      } finally {
        release();
        setBusy(null);
      }
    });
  }

  async function search(event) {
    event.preventDefault();
    const text = query.trim();
    if (busy || text.length < 2 || text.length > 80) return;
    return runBusyWrite(busyWriteRef, "placement", async (release) => {
      setBusy("search");
      setError(null);
      try {
        // A registry-only row is never a catalog entry the placement can name,
        // even when its id looks like a catalog key: the server refuses it.
        setResults((await searchCatalogKeys(catalogClient, text, { catalogOnly: true }))
          .filter((row) => !verification.verified || row.key !== verification.catalogKey));
        setPicked(null);
      } catch {
        setError("unions.placement.error.generic");
      } finally {
        release();
        setBusy(null);
      }
    });
  }

  // The client cannot see which rung verified the organization, so any parent
  // change while verified is confirmed first: a parent-union or sister-chapter
  // verification rests on the parent key and the server withdraws it.
  function saveGuarded(nextParentKey, run) {
    if (verification.verified && (nextParentKey ?? null) !== (placement?.parentCatalogKey ?? null)) {
      setConfirmParent(() => run);
      return;
    }
    run();
  }

  function saveParent() {
    if (!picked) return;
    const fields = { parentCatalogKey: picked.key, identityUnlisted: placement?.identityUnlisted === true };
    saveGuarded(picked.key, () => write(`parent:${JSON.stringify(fields)}`,
      (key) => api.setOrganizationCatalogPlacement(organizationId, fields, key), "unions.placement.saved"));
  }

  // While verified the identity checkbox is hidden and the server refuses any
  // change to it, so the stored flag is sent back as it is.
  const identityUnlisted = verification.verified ? placement?.identityUnlisted === true : unlisted.identity;
  const unlistedName = unlisted.name.trim();
  // An organization verified as a catalog listing keeps that identity with no
  // parent, so an empty submit drops its self-reported parent (the server
  // accepts it; a clear stays refused while verified).
  const verifiedListing = verification.verified && Boolean(verification.catalogKey);
  const unlistedInvalid = unlistedName
    ? unlistedNameProblem(unlistedName)
    : ((!identityUnlisted && !verifiedListing) || Boolean(unlisted.state));
  function saveUnlisted(event) {
    event.preventDefault();
    if (unlistedInvalid) return;
    const fields = {
      unlistedParentName: unlistedName || null,
      unlistedParentState: unlistedName && unlisted.state ? unlisted.state : null,
      identityUnlisted,
    };
    saveGuarded(null, () => write(`unlisted:${JSON.stringify(fields)}`,
      (key) => api.setOrganizationCatalogPlacement(organizationId, fields, key), "unions.placement.saved"));
  }

  function confirmParentChange() {
    const run = confirmParent;
    setConfirmParent(null);
    run?.();
  }

  function remove() {
    setConfirmRemove(false);
    write("clear", (key) => api.clearOrganizationCatalogPlacement(organizationId, key), "unions.placement.removed");
  }

  let current = <p className="xus-note">{t("unions.placement.notPlaced")}</p>;
  if (placement?.parentCatalogKey) {
    current = <p className="xus-note">{t("unions.placement.current")} <span lang={dataLang}>{placement.parentName || placement.parentCatalogKey}</span> — <PlacementBadge state={placement.verificationStatus} /></p>;
  } else if (placement?.unlistedParentName) {
    current = <p className="xus-note">{t("unions.placement.currentUnlisted", { name: placement.unlistedParentName })} — <PlacementBadge state={placement.verificationStatus} /></p>;
  }

  return <section className="xus-cardbody xus-form xus-cardbody--divided" aria-labelledby={headingId}>
    <div>
      <h2 className="xus-etitle" id={headingId} tabIndex="-1" ref={headingRef}>{t("unions.placement.heading")}</h2>
      <p className="xus-note">{t("unions.placement.help")}</p>
    </div>
    {state === "loading" && <p className="xus-note" role="status">{t("unions.setup.profileLoading")}</p>}
    {state === "unavailable" && <p className="xus-note" role="status">{t("unions.placement.unavailable")}</p>}
    {state === "error" && <p className="xus-note xus-note--error" role="alert">{t("unions.placement.error.load")}</p>}
    {state === "ready" && <>
      {current}
      {placement?.identityUnlisted && <p className="xus-note">{t("unions.placement.identityUnlistedNote")}</p>}
      {placement?.parentCatalogKey && !placement.parentActive && <p className="xus-note xus-note--error">{t("unions.placement.parentInactive")}</p>}
      {error && <p className="xus-note xus-note--error" role="alert" tabIndex="-1" ref={errorRef}>{t(error)}</p>}
      {catalogLive && catalogClient ? <form role="search" className="xus-form" onSubmit={search}>
        <label className="xus-field">{t("unions.placement.searchLabel")}
          <input className="xus-input" type="search" value={query} minLength="2" maxLength="80" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <BusyButton className="xus-btn" type="submit" pending={busy !== null} disabled={query.trim().length < 2}>{t("unions.placement.searchButton")}</BusyButton>
        <p className="xus-note" role="status" aria-live="polite">{results === null ? "" : results.length
          ? t(`unions.placement.searchCount.${results.length === 1 ? "one" : "other"}`, { count: results.length })
          : t("unions.placement.searchNoMatches")}</p>
      </form> : <p className="xus-note">{t("unions.setup.catalogNotLoaded")}</p>}
      {results?.length > 0 && <fieldset className="xus-form"><legend className="xus-field">{t("unions.placement.resultsLegend")}</legend>
        {results.map((row) => <label className="xus-check" key={row.key}>
          <input type="radio" name="placement-parent" checked={picked?.key === row.key} onChange={() => setPicked(row)} />
          <span lang={dataLang}>{row.name}{row.city || row.state ? ` · ${[row.city, row.state].filter(Boolean).join(", ")}` : ""}</span>
        </label>)}
        <BusyButton type="button" className="xus-btn xus-btn--go" pending={busy !== null} disabled={!picked} onClick={saveParent}>{t("unions.placement.save")}</BusyButton>
      </fieldset>}
      <div className="xus-btnrow">
        <button type="button" className="xus-btn" aria-expanded={addOpen} onClick={() => setAddOpen((open) => !open)}>{t("unions.placement.notListed")}</button>
        {placement && !verification.verified && <BusyButton type="button" className="xus-btn xus-btn--danger" pending={busy !== null} onClick={() => setConfirmRemove(true)}>{t("unions.placement.remove")}</BusyButton>}
      </div>
      {addOpen && <form className="xus-form" onSubmit={saveUnlisted}>
        <label className="xus-field">{t("unions.placement.unlistedName")}
          <input className="xus-input" value={unlisted.name} maxLength="200" aria-invalid={unlistedName && unlistedNameProblem(unlistedName) ? "true" : undefined} aria-describedby={unlistedName && unlistedNameProblem(unlistedName) ? errorId : undefined} onChange={(event) => setUnlisted((value) => ({ ...value, name: event.target.value }))} />
        </label>
        {unlistedName && unlistedNameProblem(unlistedName) && <p className="xus-note xus-note--error" id={errorId}>{t("unions.placement.error.invalidName")}</p>}
        <label className="xus-field">{t("unions.placement.unlistedState")}
          <select className="xus-input" value={unlisted.state} onChange={(event) => setUnlisted((value) => ({ ...value, state: event.target.value }))}>
            <option value="">{t("unions.placement.unlistedStateNone")}</option>
            {REGISTRY_STATES.map((code) => <option value={code} key={code}>{code}</option>)}
          </select>
        </label>
        {!verification.verified && <label className="xus-check">
          <input type="checkbox" checked={unlisted.identity} onChange={(event) => setUnlisted((value) => ({ ...value, identity: event.target.checked }))} />
          <span>{t("unions.placement.identityUnlisted")}</span>
        </label>}
        <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy !== null} disabled={unlistedInvalid}>{t("unions.placement.unlistedSubmit")}</BusyButton>
      </form>}
    </>}
    {confirmParent && <Dialog title={t("unions.placement.parentChangeTitle")} onClose={() => setConfirmParent(null)}>
      <p>{t("unions.placement.parentChangeBody")}</p>
      <div className="xus-btnrow">
        <button type="button" className="xus-btn xus-btn--danger" onClick={confirmParentChange}>{t("unions.placement.parentChangeConfirm")}</button>
        <button type="button" className="xus-btn" onClick={() => setConfirmParent(null)}>{t("unions.placement.parentChangeCancel")}</button>
      </div>
    </Dialog>}
    {confirmRemove && <Dialog title={t("unions.placement.removeTitle")} onClose={() => setConfirmRemove(false)}>
      <p>{t("unions.placement.removeBody")}</p>
      <div className="xus-btnrow">
        <button type="button" className="xus-btn xus-btn--danger" onClick={remove}>{t("unions.placement.removeConfirm")}</button>
        <button type="button" className="xus-btn" onClick={() => setConfirmRemove(false)}>{t("unions.placement.removeCancel")}</button>
      </div>
    </Dialog>}
  </section>;
}
