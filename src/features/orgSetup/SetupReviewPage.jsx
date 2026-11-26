import { ListTree } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BusyButton, BusyInput, BusySelect } from "../../components/BusyControls.jsx";
import { Dialog } from "../../components/Dialog.jsx";
import { prepareBusyWrite, runBusyWrite, useBusyScope } from "../../lib/busyWrite.js";
import { useWorkspace, WorkspaceCardTitle } from "../../components/WorkspacePages.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { PLANE_CARD_CLASS } from "../../lib/staffPlaneStyles.js";
import { supabase } from "../../lib/supabase.js";
import { PlacementCard } from "../unionCatalog/PlacementCard.jsx";
import { formatCatalogDate, searchCatalogKeys } from "../unionCatalog/catalogSearch.js";
import { loadSetupProfile, probeSetupCatalog } from "./setupApi.js";
import {
  attestationIssues,
  buildSetupPayload,
  KNOWN_IMPORT_ERRORS,
  MAX_ITEMS,
  NODE_LABEL_MAX,
  newOwnRow,
  ROW_TYPES,
  rowForErrorPath,
  rowIssues,
  rowsFromProfile,
  seatsFromProfile,
} from "./setupPayload.js";
import { NameText, SetupRowEditor, setupRowDomId, typeLabel } from "./SetupRowEditor.jsx";
import { TwoStepSettingsLink } from "./SetupTwoStepNotice.jsx";
import { setupReviewReturnPath } from "../../lib/setupSecurityReturn.js";
import { UnionNetworkNav } from "../unionCatalog/UnionNetworkNav.jsx";
import { unionNetworkCopy } from "../unionCatalog/unionNetworkCopy.js";
import { UnionBuildPlacement, unionBuildContext, placementMatchesParent } from "./UnionBuildPlacement.jsx";
import "./setupReview.css";
import { StarterRecommendations } from "./StarterRecommendations.jsx";

// /m/admin/setup-review (REQ-UG-UNION-CATALOG-SETUP-REVIEW-PREFILL-20260925).
// The creator decides the structure: start from a public
// record or from a blank list, edit everything, check it with a dry run, then
// create it through the unchanged import_organization_structure. The draft is
// React state only; nothing is stored before Confirm and nothing is created
// without it. Demo and SAMPLE send nothing.

const ADMIN_PATH = "/m/admin";
const INVITATIONS_PATH = "/m/admin/invitations";
const ONBOARDING_CHECKLIST_PATH = "/m/support/onboarding";
const ACCESS_PATH = "/m/admin/access";

function importFailure(error) {
  return error?.code === "42501" ? "auth" : "network";
}

function textLength(value) {
  return [...String(value ?? "").trim()].length;
}

export function SetupReviewPage(props) {
  const scope = JSON.stringify([props.data?.member?.id, props.data?.member?.organizationId, window.location.search]);
  // A create that settles after the person left this member or
  // organization announces and reloads nothing. The app passes a guard owned
  // above the views (it stays mounted across views and hats, so leaving this
  // page or switching hat keeps the completion). Without one, the page's own
  // scope is the owner; it outlives a session remounted for a new address.
  const memberScope = useBusyScope(JSON.stringify([props.data?.member?.id, props.data?.member?.organizationId]));
  return <SetupReviewSession key={scope} {...props} organizationGuard={props.organizationGuard ?? memberScope.guard} />;
}

function SetupReviewSession({ api, data, organization = null, demo = false, onNotice = () => {}, reload = () => {}, catalogClient: providedClient, issueSignals = null, organizationGuard = (callback) => callback }) {
  const { t, lang } = useLang();
  const network = unionNetworkCopy(lang);
  const workspace = useWorkspace();
  const ids = useId();
  const catalogClient = useMemo(() => providedClient === undefined ? supabase : providedClient, [providedClient]);
  const offline = demo || !catalogClient;
  const organizationId = data?.member?.organizationId ?? null;
  const dataLang = lang === "en" ? undefined : "en";

  const [catalog, setCatalog] = useState(offline ? "unavailable" : "probing");
  const [release, setRelease] = useState(null);
  const [buildContext, setBuildContext] = useState(() => unionBuildContext(window.location.search));
  const [buildPlacement, setBuildPlacement] = useState({ confirmed: false });
  const [placementRevision, setPlacementRevision] = useState(0);
  const [choice, setChoice] = useState(offline || buildContext ? "own" : null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [profileState, setProfileState] = useState("idle");
  const [profile, setProfile] = useState(null);
  const [candidate, setCandidate] = useState(null);
  const [candidatePin, setCandidatePin] = useState(null);
  const [importSelection, setImportSelection] = useState("all");
  const [importedSelection, setImportedSelection] = useState("all");
  const [pinned, setPinned] = useState(null);
  const [rows, setRows] = useState(() => buildContext ? [newOwnRow("", "chapter")] : []);
  const [lastRemoved, setLastRemoved] = useState(null);
  const [includeSeats, setIncludeSeats] = useState(false);
  const [rootName, setRootName] = useState(() => buildContext ? organization?.name || "" : "");
  const [suppliedBy, setSuppliedBy] = useState(data?.member?.fullName ?? "");
  const [authorityEdit, setAuthorityEdit] = useState(null);
  const [adding, setAdding] = useState(null);
  const [busy, setBusy] = useState(null);
  // The catalog search is a read beside the draft's steps. It has
  // its own lock, pending mark and failure, so a step pressed beside it (a
  // check, say) is not dropped behind it and neither clears the other's mark.
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  // The draft's steps (pick, import, dry run, commit and reload)
  // share one busy state, so they share one synchronous lock, "setup" (reload
  // holds it for the pick it runs); the search has its own lock above. The
  // session is keyed by member, organization and URL, so a scope change
  // remounts it and ends both together. Each step releases its lock where it
  // clears busy, so a step that finished synchronously (an import of the
  // chosen public record) leaves the next one free in the same tick.
  const busyWriteRef = useRef(new Set());
  const [dryRun, setDryRun] = useState(null);
  const [importErrors, setImportErrors] = useState(null);
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [touched, setTouched] = useState({});
  const summaryRef = useRef(null);
  const successRef = useRef(null);
  const undoRef = useRef(null);
  const reviewRef = useRef(null);
  const importRef = useRef(null);
  // Where focus goes after the control that had it unmounts: "undo", "review",
  // "import", or a row id.
  const focusNext = useRef(null);

  useEffect(() => {
    if (offline) return undefined;
    let live = true;
    probeSetupCatalog(catalogClient).then((result) => {
      if (!live) return;
      setCatalog(result.catalog);
      setRelease(result.status);
      if (result.catalog !== "live") setChoice("own");
    });
    return () => { live = false; };
  }, [catalogClient, offline]);

  useEffect(() => {
    if (!buildContext || candidate || !buildPlacement.publicProfile?.found || !buildPlacement.publicPin) return;
    setCandidate(buildPlacement.publicProfile);
    setCandidatePin(buildPlacement.publicPin);
    setProfileState("found");
  }, [buildContext, buildPlacement.publicProfile, buildPlacement.publicPin, candidate]);

  const publicPath = profile?.found === true;
  const availableSeats = useMemo(() => {
    if (!publicPath) return [];
    const offered = seatsFromProfile(profile);
    if (importedSelection === "organization" || (importedSelection === "all" && profile.subunits.length === 0)) {
      const importedRow = rows.find((row) => row.origin === "catalog" && row.id === profile.organization.key);
      return importedRow ? offered.filter((seat) => !seat.subunitKey).map((seat) => ({ ...seat, subunitKey: importedRow.id })) : [];
    }
    return offered.filter((seat) => (importedSelection === "all" && !seat.subunitKey)
      || rows.some((row) => row.origin === "catalog" && row.id === seat.subunitKey));
  }, [profile, publicPath, importedSelection, rows]);
  const seats = includeSeats ? availableSeats : [];
  const source = publicPath && pinned ? { releaseLabel: pinned.releaseLabel, catalogKey: profile.organization.key, dataAsOf: pinned.dataAsOf } : null;
  // Never pre-filled (REQ-UG-FOUNDER-SOLE-ADMIN-HANDOFF-TO-OFFICERS-20261006):
  // a filled-in "accepted by the organization's admin" let whoever clicked
  // first claim authority without saying where it came from. The catalog
  // source is recorded in the payload's sources either way.
  const authority = authorityEdit ?? "";
  const existingChapters = (organization?.chapters ?? []).filter((chapter) => typeof chapter?.name === "string" && chapter.name.trim());
  const existingNames = existingChapters.map((chapter) => chapter.name);
  // null means get_admin_org_structure failed, not "no chapters": without the
  // existing chapter keys the payload cannot avoid them, so nothing is checked
  // or created until they load (gate round 2 on).
  const chaptersUnknown = !demo && organization === null;
  const issues = rowIssues(rows, existingNames);
  const attestProblems = attestationIssues({ suppliedBy, authority });
  const rootProblem = !rootName.trim() || textLength(rootName) > NODE_LABEL_MAX;
  // The import takes at most MAX_ITEMS nodes; a longer list is refused here
  // rather than cut short, so what is checked is what is shown.
  const tooMany = rows.length + seats.length > MAX_ITEMS;
  const invalid = Object.keys(issues).length > 0 || attestProblems.length > 0 || rootProblem || tooMany;
  const count = rows.length + seats.length;
  // A field is flagged once it was edited or the list has rows, so a blank
  // form does not open full of errors.
  const flag = (field) => touched[field] === true || rows.length > 0;
  const signature = JSON.stringify({ rows, seats, rootName, suppliedBy, authority, source, buildPlacement: buildContext ? buildPlacement : null });
  const checked = dryRun?.signature === signature;
  const dirty = !done && (rows.length > 0 || lastRemoved !== null);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (importErrors) summaryRef.current?.focus();
  }, [importErrors]);

  useEffect(() => {
    if (done) successRef.current?.focus();
  }, [done]);

  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    if (target === "undo") undoRef.current?.focus();
    else if (target === "review") reviewRef.current?.focus();
    else if (target === "import") importRef.current?.focus();
    else document.getElementById(setupRowDomId(target))?.focus();
  });

  function edit(update) {
    setRows(update);
    setFailure(null);
  }

  function choose(next) {
    setChoice(next);
    setLastRemoved(null);
    if (next === "own") {
      setProfile(null);
      setCandidate(null);
      setProfileState("idle");
      setResults(null);
      edit((current) => current.filter((row) => row.origin === "own"));
    }
  }

  function search(event) {
    return prepareBusyWrite(busyWriteRef, "search", () => {
      event.preventDefault();
      const text = query.trim();
      if (searching || text.length < 2 || text.length > 80) return undefined;
      return (unlock) => searchNow(text, unlock);
    }, event);
  }

  async function searchNow(text, unlock) {
    setSearching(true);
    setSearchFailed(false);
    try {
      setResults(await searchCatalogKeys(catalogClient, text));
    } catch {
      setResults(null);
      setSearchFailed(true);
    } finally {
      setSearching(false);
      unlock?.();
    }
  }

  // `pinRelease` is passed when the release was just re-read, because the
  // `release` state of this render is still the old one.
  // A pick shares the setup lock: its completion clears the same busy state
  // that the other steps show, so it must not run beside one of them.
  function pick(key, pinRelease = release, reimport = false) {
    return runBusyWrite(busyWriteRef, "setup", (unlock) => pickNow(key, pinRelease, reimport, unlock));
  }

  async function pickNow(key, pinRelease, reimport, unlock) {
    setBusy("profile");
    setProfileState("loading");
    setLastRemoved(null);
    try {
      const next = await loadSetupProfile(catalogClient, key);
      if (next.found && next.organization.key !== key) throw new Error("catalog_identity_mismatch");
      setCandidate(next);
      setCandidatePin(pinRelease);
      setImportSelection("all");
      setProfileState(next.found ? "found" : "notFound");
      if (next.found) focusNext.current = "import";
      if (reimport) applyPublicRows(next, pinRelease, next.found ? rowsFromSelection(next, importedSelection, pinRelease) : [], importedSelection);
    } catch {
      setProfileState("error");
    } finally {
      setBusy(null);
      unlock?.();
    }
  }

  function rowsFromSelection(next, selection, pinRelease) {
    const all = rowsFromProfile(next);
    if (selection === "organization" || (selection === "all" && all.length === 0)) return [{ id: next.organization.key, origin: "catalog", name: next.organization.name, type: "chapter", parentId: null, sourceHost: null, sourceAsOf: pinRelease.dataAsOf }];
    return selection === "all" ? all : all.filter((row) => row.id === selection).map((row) => ({ ...row, parentId: null }));
  }

  function applyPublicRows(next, pinRelease, importedRows, selection) {
    if (importedRows.length === 0) {
      setProfile(null);
      setPinned(null);
      setDryRun(null);
      edit((current) => current.filter((row) => row.origin === "own"));
      setFailure("selection");
      focusNext.current = "import";
      return;
    }
    setProfile(next);
    setPinned(pinRelease);
    setImportedSelection(selection);
    setLastRemoved(null);
    setDryRun(null);
    edit((current) => [...importedRows, ...current.filter((row) => row.origin === "own" && row.name.trim())]);
    if (!rootName.trim()) setRootName(next.organization.name);
    focusNext.current = "review";
  }

  function importPublicRecord() {
    return prepareBusyWrite(busyWriteRef, "setup", () => (busy || offline || !candidate?.found || !candidatePin ? undefined : (unlock) => importNow(unlock)));
  }

  async function importNow(unlock) {
    setBusy("import");
    setFailure(null);
    try {
      let next = candidate;
      let importedRows;
      let selection = importSelection;
      if (importSelection.startsWith("child:")) {
        const childKey = importSelection.slice(6);
        if (!candidate.children.some((child) => child.key === childKey)) return;
        next = await loadSetupProfile(catalogClient, childKey);
        if (!next.found || next.organization.key !== childKey) throw new Error("catalog_identity_mismatch");
        selection = "organization";
        importedRows = rowsFromSelection(next, selection, candidatePin);
      } else {
        importedRows = rowsFromSelection(candidate, selection, candidatePin);
      }
      applyPublicRows(next, candidatePin, importedRows, selection);
    } catch {
      setFailure("network");
    } finally {
      setBusy(null);
      unlock?.();
    }
  }

  // Keeps the rows the admin added and drops edits to public-record rows,
  // because those rows now come from a different release.
  function reloadPublicRecord() {
    return runBusyWrite(busyWriteRef, "setup", (unlock) => reloadNow(unlock));
  }

  async function reloadNow(unlock) {
    setBusy("profile");
    setDryRun(null);
    try {
      const probe = await probeSetupCatalog(catalogClient);
      setCatalog(probe.catalog);
      setRelease(probe.status);
      setFailure(null);
      focusNext.current = "review";
      if (probe.catalog === "live" && profile?.organization?.key) await pickNow(profile.organization.key, probe.status, true, unlock);
    } finally {
      setBusy(null);
      unlock?.();
    }
  }

  function remove(row) {
    const index = rows.indexOf(row);
    edit((current) => current.filter((item) => item !== row));
    setLastRemoved({ row, index });
    focusNext.current = "undo";
  }

  function undo() {
    if (!lastRemoved) return;
    edit((current) => [...current.slice(0, lastRemoved.index), lastRemoved.row, ...current.slice(lastRemoved.index)]);
    setLastRemoved(null);
    focusNext.current = lastRemoved.row.id;
  }

  function addRow(event) {
    event.preventDefault();
    if (!adding?.name.trim()) return;
    edit((current) => [...current, newOwnRow(adding.name.trim(), adding.type)]);
    setAdding(null);
  }

  function payload() {
    return buildSetupPayload({
      organizationId,
      organizationName: rootName,
      rows,
      seats,
      attestation: { suppliedBy, authority },
      source,
      seatBadge: t("unions.setup.seatBadge"),
      seatSubtitle: (asOf) => (asOf ? t("unions.setup.seatSubtitle", { date: formatCatalogDate(asOf, lang) }) : ""),
      existingChapterIds: existingChapters.map((chapter) => chapter.id),
    });
  }

  function report(result, body) {
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    setImportErrors(errors.length ? { errors, payload: body, rows: rows.slice(0, MAX_ITEMS) } : null);
    return errors.length === 0;
  }

  function runDryRun() {
    return prepareBusyWrite(busyWriteRef, "setup", () => (busy || offline || chaptersUnknown || invalid || rows.length === 0 || (buildContext && !buildPlacement.confirmed) ? undefined : (unlock) => dryRunNow(unlock)));
  }

  async function dryRunNow(unlock) {
    setBusy("dry");
    setFailure(null);
    try {
      const body = await payload();
      const result = await api.importOrganizationStructure("admin", body, true);
      if (report(result, body)) setDryRun({ signature, count, body });
    } catch (error) {
      setFailure(importFailure(error));
    } finally {
      setBusy(null);
      unlock?.();
    }
  }

  function confirm() {
    return prepareBusyWrite(busyWriteRef, "setup", () => (busy || offline || chaptersUnknown || invalid || !checked || (buildContext && !buildPlacement.confirmed) ? undefined : (unlock) => confirmNow(unlock)));
  }

  async function confirmNow(unlock) {
    // Taken when the create starts: it runs only while the same member and
    // organization are shown.
    const announce = organizationGuard(() => {
      onNotice(t("unions.setup.success"));
      reload();
    });
    setBusy("commit");
    setFailure(null);
    try {
      if (buildContext) {
        const current = await api.getOrganizationCatalogPlacement(organizationId);
        if (!placementMatchesParent(current, buildPlacement.parent)) {
          setBuildPlacement((value) => ({ ...value, confirmed: false }));
          setPlacementRevision((value) => value + 1);
          setDryRun(null); setFailure("placement"); return;
        }
      }
      if (source) {
        const probe = await probeSetupCatalog(catalogClient);
        if (probe.status?.releaseLabel !== source.releaseLabel) {
          setFailure("release");
          return;
        }
      }
      // The body that passed the dry run, not a rebuild: the language and the
      // date it carries must not change between the check and the create.
      const body = dryRun.body;
      const result = await api.importOrganizationStructure("admin", body, false);
      if (report(result, body) && result?.committed === true) {
        setDone(true);
        announce();
      } else {
        setDryRun(null);
      }
    } catch (error) {
      setFailure(importFailure(error));
    } finally {
      setBusy(null);
      unlock?.();
    }
  }

  function goTo(path) {
    workspace?.open(path);
  }

  // REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 72): the
  // reason names every field that blocks Check and Create, because a field is
  // only highlighted once it was edited or the list has rows; "fix the
  // highlighted fields" over a form with nothing highlighted left the founder
  // guessing.
  const blockers = [
    rootProblem ? t("unions.setup.rootName") : null,
    Object.keys(issues).length > 0 ? t("unions.setup.blockerRows") : null,
    attestProblems.includes("suppliedBy") ? t("unions.setup.suppliedBy") : null,
    attestProblems.includes("authority") ? t("unions.setup.authority") : null,
  ].filter(Boolean);
  const checkReason = offline ? "unions.setup.demoUnavailable"
    : chaptersUnknown ? "unions.setup.existingUnavailableReason"
    : tooMany ? "unions.setup.tooManyItems"
    : invalid ? "unions.setup.confirmDisabledInvalid"
      : rows.length === 0 ? "unions.setup.confirmDisabledNoRows" : null;
  const confirmReason = checkReason ?? (!checked ? "unions.setup.confirmDisabledNoDryRun" : null);
  const reasonText = confirmReason === "unions.setup.confirmDisabledInvalid"
    ? t(confirmReason, { fields: new Intl.ListFormat(lang, { type: "conjunction" }).format(blockers) })
    : confirmReason ? t(confirmReason) : "";
  const catalogLive = catalog === "live";

  return <article id="admin-setup-review" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
    <UnionNetworkNav current="build" staff admin />
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><ListTree size={18} /></span>
      <div className="xus-cardhead__copy">
        <WorkspaceCardTitle outline className="xus-cardttl">{t("unions.setup.pageTitle")}</WorkspaceCardTitle>
        <p className="xus-cardsub">{t("unions.setup.intro")}</p>
      </div>
    </header>

    <StarterRecommendations catalog={profile?.starter ?? null} issueSignals={issueSignals} />

    {buildContext && <UnionBuildPlacement key={placementRevision} context={buildContext} client={catalogClient} api={api} organizationId={organizationId} offline={offline} lang={lang}
      onChange={setBuildPlacement} onStartOver={() => { setBuildContext(null); setBuildPlacement({ confirmed: false }); setDryRun(null); }} />}

    {done ? <section className="xus-cardbody xus-form">
      <p className="xus-note xus-note--success" role="status" tabIndex="-1" ref={successRef}>{t("unions.setup.success")}</p>
      <a className="xus-btn xus-btn--go" href={INVITATIONS_PATH} onClick={(event) => { if (workspace) { event.preventDefault(); goTo(INVITATIONS_PATH); } }}>{t("unions.setup.successInvite")}</a>
      {/* UX-UG-ADMIN-NOT-TOLD-ONBOARDING-NEEDS-CHECKLIST-20261018:
          members are never left with "no guide"; the distinction is the
          built-in starting list versus the organization's own checklist. */}
      <p className="xus-note">{t("unions.setup.successChecklist")}</p>
      <a className="xus-btn" href={ONBOARDING_CHECKLIST_PATH} onClick={(event) => { if (workspace) { event.preventDefault(); workspace.open(ONBOARDING_CHECKLIST_PATH, "memberSupport"); } }}>{t("unions.setup.successChecklistLink")}</a>
      {/* Whoever runs setup is the organization's only admin. A member who
          is not an elected officer needs a way to hand it over and step back;
          invitations cannot start anyone as Admin or President, so the grant
          happens on Access once the president has joined. */}
      <section className="xus-form" aria-labelledby={`${ids}-handoff`}>
        <h3 className="xus-etitle" id={`${ids}-handoff`}>{t("unions.setup.handoffTitle")}</h3>
        <p className="xus-note">{t("unions.setup.handoffIntro")}</p>
        <ol>
          <li>{t("unions.setup.handoffInvite")}</li>
          <li>{t("unions.setup.handoffGrant")}</li>
          <li>{t("unions.setup.handoffStepBack")}</li>
        </ol>
        <a className="xus-btn" href={ACCESS_PATH} onClick={(event) => { if (workspace) { event.preventDefault(); goTo(ACCESS_PATH); } }}>{t("unions.setup.handoffAccess")}</a>
      </section>
    </section> : <section className="xus-cardbody xus-form">
      <p className="xus-note">{t("unions.setup.privacyNote")}</p>
      {offline && <p className="xus-note" role="status">{t("unions.setup.demoUnavailable")}</p>}

      {/* An organization that already has chapters must see them here: a blank
          wizard made presidents fear they were about to create a duplicate
          (October 6 swarm). buildSetupPayload never reuses one of their keys,
          so confirming adds chapters and never renames these. */}
      {chaptersUnknown && <p className="xus-note" role="alert">{t("unions.setup.existingUnavailable")}</p>}
      {existingChapters.length > 0 && <section className="xus-form" aria-labelledby={`${ids}-existing`}>
        <h3 className="xus-etitle" id={`${ids}-existing`}>{t("unions.setup.existingHeading")}</h3>
        <p className="xus-note">{t("unions.setup.existingNote")}</p>
        {/* A long list would push the start choice off screen; it starts closed. */}
        <details open={existingChapters.length <= 6}>
          <summary>{t("unions.setup.existingSummary", { count: existingChapters.length })}</summary>
          <ul>{existingChapters.map((chapter, index) => <li key={chapter.id ?? `${chapter.name}-${index}`}>{chapter.name}</li>)}</ul>
        </details>
      </section>}

      {!buildContext && <fieldset className="xus-form">
        <legend className="xus-field">{t("unions.setup.chooseLegend")}</legend>
        <label className="xus-check">
          <input type="radio" name={`${ids}-start`} checked={choice === "public"} disabled={!catalogLive} aria-describedby={`${ids}-public-help`} onChange={() => choose("public")} />
          <span>{t("unions.setup.choicePublicRecord")}</span>
        </label>
        <p className="xus-meta" id={`${ids}-public-help`}>{!offline && catalog === "unavailable" ? t("unions.setup.catalogNotLoaded") : t("unions.setup.choicePublicRecordHelp")}</p>
        <label className="xus-check">
          <input type="radio" name={`${ids}-start`} checked={choice === "own"} aria-describedby={`${ids}-own-help`} onChange={() => choose("own")} />
          <span>{t("unions.setup.choiceBuildOwn")}</span>
        </label>
        <p className="xus-meta" id={`${ids}-own-help`}>{t("unions.setup.choiceBuildOwnHelp")}</p>
        {/* Finding 68: the public record is a starting list, not a listing. */}
        <p className="xus-note">{t("unions.setup.choosePrivacy")}</p>
      </fieldset>}

      {choice === "public" && <>
        <form role="search" className="xus-form" onSubmit={search}>
          <label className="xus-field">{t("unions.setup.searchLabel")}
            <input className="xus-input" type="search" value={query} minLength="2" maxLength="80" onChange={(event) => setQuery(event.target.value)} />
          </label>
          <BusyButton className="xus-btn" type="submit" pending={searching} disabled={query.trim().length < 2}>{searching ? t("unions.setup.searching") : t("unions.setup.searchButton")}</BusyButton>
          <p className="xus-note" role="status" aria-live="polite">{results === null ? "" : results.length
            ? t("unions.setup.searchCount", { count: results.length })
            : t("unions.setup.searchNoMatches")}</p>
        </form>
        {searchFailed && <p className="xus-note xus-note--error" role="alert">{t("unions.setup.error.network")}</p>}
        {results?.some((row) => row.key !== candidate?.organization?.key) && <fieldset className="xus-form">
          <legend className="xus-field">{t(candidate?.found ? "unions.otherMatches" : "unions.setup.resultsLegend")}</legend>
          {results.filter((row) => row.key !== candidate?.organization?.key).map((row) => <label className="xus-check" key={row.key}>
            <BusyInput type="radio" name={`${ids}-record`} checked={candidate?.organization?.key === row.key} pending={busy !== null || searching} onChange={() => pick(row.key)} />
            <span lang={dataLang}>{row.name}{row.city || row.state ? ` · ${[row.city, row.state].filter(Boolean).join(", ")}` : ""}</span>
          </label>)}
        </fieldset>}
        <p className="xus-note">{t("unions.setup.noLinkNote")}</p>
        {profileState === "loading" && <p className="xus-note" role="status">{t("unions.setup.profileLoading")}</p>}
        {profileState === "notFound" && <p className="xus-note" role="status">{t("unions.setup.noPublicDetails")}</p>}
        {profileState === "error" && <p className="xus-note xus-note--error" role="alert">{t("unions.setup.error.network")}</p>}
        {publicPath && <>
          {availableSeats.length > 0 && <label className="xus-check">
            <input type="checkbox" checked={includeSeats} onChange={(event) => setIncludeSeats(event.target.checked)} />
            <span>{t("unions.setup.seatsToggle")}</span>
          </label>}
          {profile.documents.length > 0 && <div>
            <h3 className="xus-etitle">{t("unions.setup.documentsHeading")}</h3>
            <ul>{profile.documents.map((doc) => <li key={doc.key}>
              <a href={doc.href} target="_blank" rel="noopener noreferrer nofollow" lang={dataLang}>{doc.title}</a> <span className="xus-meta">({doc.host})</span>
            </li>)}</ul>
          </div>}
        </>}
      </>}

      {publicPath && <>
        {profile.subunitsCapped && <p className="xus-note">{t("unions.setup.capNotice")}</p>}
        {profile.childrenTotal > 0 && <p className="xus-note">{t("unions.setup.childrenListed", { count: profile.childrenTotal })}</p>}
      </>}

      {candidate?.found && <section className="xus-form setup-record-import" aria-label={t("unions.setup.importHeading")}>
        <h3 className="xus-etitle">{t("unions.setup.importHeading")}</h3>
        {!buildContext && <p className="xus-note"><span lang={dataLang}>{candidate.organization.name}</span></p>}
        <p className="xus-note">{t("unions.setup.importHelp")}</p>
        <label className="xus-field">{t("unions.setup.importSelection")}
          <BusySelect className="xus-input" value={importSelection} pending={busy !== null} onChange={(event) => setImportSelection(event.target.value)}>
            <option value="all">{t("unions.setup.importAll")}</option>
            {candidate.subunits.map((unit) => <option key={unit.key} value={unit.key}>{unit.name}</option>)}
            {candidate.children.map((child) => <option key={child.key} value={`child:${child.key}`}>{child.name}</option>)}
          </BusySelect>
        </label>
        <BusyButton type="button" className="xus-btn" ref={importRef} pending={busy !== null} disabled={offline || !candidatePin} onClick={importPublicRecord}>{t("unions.setup.importButton")}</BusyButton>
      </section>}

      {choice && <>
        <label className="xus-field">{t("unions.setup.rootName")}
          <input className="xus-input" value={rootName} maxLength={NODE_LABEL_MAX + 40} aria-invalid={rootProblem && flag("root") ? "true" : undefined} aria-describedby={rootProblem && flag("root") ? `${ids}-root-issue` : undefined} onChange={(event) => { setRootName(event.target.value); setTouched((value) => ({ ...value, root: true })); }} />
        </label>
        {rootProblem && flag("root") && <p className="xus-note xus-note--error" id={`${ids}-root-issue`}>{t("unions.setup.rootNameProblem")}</p>}
        <div>
          <h3 className="xus-etitle" tabIndex="-1" ref={reviewRef}>{t("unions.setup.reviewHeading")}</h3>
          <p className="xus-meta" role="status">{t("unions.setup.rowCount", { count: rows.length })}</p>
        </div>
        {rows.length === 0 ? <p className="xus-note">{t(existingChapters.length > 0 ? "unions.setup.emptyListExisting" : "unions.setup.emptyList")}</p> : <ul className="xus-form">
          {rows.map((row) => <SetupRowEditor key={row.id} row={row} issues={issues[row.id]} onRemove={remove}
            onChange={(next) => edit((current) => current.map((item) => (item.id === row.id ? next : item)))} />)}
        </ul>}
        {lastRemoved && <p className="xus-note" role="status">
          <NameText template="unions.setup.rowRemoved" row={lastRemoved.row} />{" "}
          <button type="button" className="xus-btn" ref={undoRef} onClick={undo}>{t("unions.setup.rowUndo")}</button>
        </p>}
        <div className="xus-btnrow">
          <button type="button" className="xus-btn" onClick={() => setAdding({ name: "", type: "chapter" })}>{t("unions.setup.addRow")}</button>
        </div>

        <fieldset className="xus-form">
          <legend className="xus-field">{t("unions.setup.attestLegend")}</legend>
          <label className="xus-field">{t("unions.setup.suppliedBy")}
            <input className="xus-input" value={suppliedBy} maxLength="200" aria-invalid={attestProblems.includes("suppliedBy") && flag("suppliedBy") ? "true" : undefined} aria-describedby={attestProblems.includes("suppliedBy") && flag("suppliedBy") ? `${ids}-supplied-issue` : undefined} onChange={(event) => { setSuppliedBy(event.target.value); setTouched((value) => ({ ...value, suppliedBy: true })); }} />
          </label>
          {attestProblems.includes("suppliedBy") && flag("suppliedBy") && <p className="xus-note xus-note--error" id={`${ids}-supplied-issue`}>{t("unions.setup.suppliedByProblem")}</p>}
          <label className="xus-field">{t("unions.setup.authority")}
            <textarea className="xus-input" value={authority} maxLength="300" placeholder={t("unions.setup.authorityPlaceholder")} aria-invalid={attestProblems.includes("authority") && flag("authority") ? "true" : undefined} aria-describedby={attestProblems.includes("authority") && flag("authority") ? `${ids}-authority-issue` : undefined} onChange={(event) => { setAuthorityEdit(event.target.value); setTouched((value) => ({ ...value, authority: true })); }} />
          </label>
          {attestProblems.includes("authority") && flag("authority") && <p className="xus-note xus-note--error" id={`${ids}-authority-issue`}>{t("unions.setup.authorityProblem")}</p>}
          <p className="xus-meta">{t("unions.setup.consentFixed")}</p>
        </fieldset>

        {importErrors && <div className="xus-form" role="alert" tabIndex="-1" ref={summaryRef}>
          <h3 className="xus-etitle">{t("unions.setup.errorSummary")}</h3>
          <ul>{importErrors.errors.map((item, index) => {
            const row = rowForErrorPath(item.path, importErrors.rows, importErrors.payload);
            const text = t(KNOWN_IMPORT_ERRORS.includes(item.code) ? `unions.setup.error.${item.code}` : "unions.setup.error.generic");
            return <li key={`${item.path}-${item.code}-${index}`}>{row
              ? <a href={`#${setupRowDomId(row.id)}`} onClick={(event) => { event.preventDefault(); document.getElementById(setupRowDomId(row.id))?.focus(); }}><NameText row={row} />: {text}</a>
              : text}</li>;
          })}</ul>
        </div>}
        {failure === "auth" && <p className="xus-note xus-note--error" role="alert">{t("unions.setup.error.auth")} <TwoStepSettingsLink plain returnTo={setupReviewReturnPath(window.location.pathname, buildContext ? window.location.search : "")}>{t("unions.setup.twoStepLink")}</TwoStepSettingsLink></p>}
        {failure === "network" && <p className="xus-note xus-note--error" role="alert">{t("unions.setup.error.network")}</p>}
        {failure === "selection" && <p className="xus-note xus-note--error" role="alert">{t("unions.setup.selectionUnavailable")}</p>}
        {failure === "placement" && <p className="xus-note xus-note--error" role="alert">{network("parentRequired")}</p>}
        {failure === "release" && <p className="xus-note xus-note--error" role="alert">{t("unions.setup.releaseChanged")}{" "}
          <BusyButton type="button" className="xus-btn" pending={busy !== null} onClick={reloadPublicRecord}>{t("unions.setup.reloadPublicRecord")}</BusyButton>
        </p>}
        {checked && <p className="xus-note xus-note--success" role="status">{t("unions.setup.dryRunReady", { count: dryRun.count })}</p>}

        <div className="xus-btnrow">
          <BusyButton type="button" className="xus-btn" pending={busy !== null} disabled={offline || chaptersUnknown || invalid || rows.length === 0 || Boolean(buildContext && !buildPlacement.confirmed)} aria-describedby={checkReason ? `${ids}-confirm-reason` : undefined} onClick={runDryRun}>
            {busy === "dry" ? t("unions.setup.dryRunChecking") : t("unions.setup.dryRunButton", { count })}
          </BusyButton>
          <BusyButton type="button" className="xus-btn xus-btn--go" pending={busy !== null} disabled={confirmReason !== null || Boolean(buildContext && !buildPlacement.confirmed)} aria-describedby={confirmReason ? `${ids}-confirm-reason` : undefined} onClick={confirm}>
            {busy === "commit" ? t("unions.setup.creating") : t("unions.setup.confirmButton", { count })}
          </BusyButton>
          <button type="button" className="xus-btn" onClick={() => (dirty ? setLeaving(true) : goTo(ADMIN_PATH))}>{t("unions.setup.cancel")}</button>
        </div>
        {confirmReason && <p className="xus-meta" id={`${ids}-confirm-reason`}>{reasonText}</p>}
        {buildContext && !buildPlacement.confirmed && <p className="xus-note">{network("parentRequired")}</p>}
      </>}
    </section>}

    {!buildContext && !offline && organizationId && <PlacementCard api={api} organizationId={organizationId} catalogClient={catalogClient} catalogLive={catalogLive} onNotice={onNotice} optionalWhenPrivate />}

    {adding && <Dialog title={t("unions.setup.addDialogTitle")} onClose={() => setAdding(null)}>
      <form className="xus-form" onSubmit={addRow}>
        <label className="xus-field">{t("unions.setup.rowName")}
          <input className="xus-input" value={adding.name} maxLength="200" onChange={(event) => setAdding((value) => ({ ...value, name: event.target.value }))} />
        </label>
        <label className="xus-field">{t("unions.setup.rowType")}
          <select className="xus-input" value={adding.type} onChange={(event) => setAdding((value) => ({ ...value, type: event.target.value }))}>
            {ROW_TYPES.map((type) => <option value={type} key={type}>{typeLabel(t, type)}</option>)}
          </select>
        </label>
        <button type="submit" className="xus-btn xus-btn--go" disabled={!adding.name.trim()}>{t("unions.setup.addDialogConfirm")}</button>
      </form>
    </Dialog>}

    {leaving && <Dialog title={t("unions.setup.leaveTitle")} onClose={() => setLeaving(false)}>
      <p>{t("unions.setup.leaveBody")}</p>
      <div className="xus-btnrow">
        <button type="button" className="xus-btn xus-btn--danger" onClick={() => { setLeaving(false); setRows([]); setLastRemoved(null); goTo(ADMIN_PATH); }}>{t("unions.setup.leaveConfirm")}</button>
        <button type="button" className="xus-btn" onClick={() => setLeaving(false)}>{t("unions.setup.leaveCancel")}</button>
      </div>
    </Dialog>}
  </article>;
}
