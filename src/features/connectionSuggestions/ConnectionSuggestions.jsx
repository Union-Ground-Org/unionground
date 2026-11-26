import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CONNECTION_ISSUE_TOPICS, CONNECTION_SECTORS, CONNECTION_WEIGHT_KEYS, DEFAULT_CONNECTION_SETTINGS, organizationConnectionWeights } from "./contract.js";
import { rankConnections } from "./engine.js";
import { createConnectionAdapter } from "./adapter.js";
import { createConnectionPreview } from "./preview.js";
import { connectionCopy } from "../../lib/i18n/connectionSuggestions.js";
import { t } from "../../lib/i18n.js";
import "../../lib/i18n/features/connectionProfilePublishStrings.js";
import { ReviewedIssueSignals } from "./ReviewedIssueSignals.jsx";
import { ConnectionHandshakeDialog } from "./ConnectionHandshakeDialog.jsx";
import { PartnerOffices } from "./PartnerOffices.jsx";
import { UnionNetworkNav } from "../unionCatalog/UnionNetworkNav.jsx";
import { unionNetworkCopy } from "../unionCatalog/unionNetworkCopy.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import "./connections.css";
import "../organizationIntelligence/organization-intelligence.css";

const presets = {
  balanced: { location: 20, sector: 20, issues: 25, expertise: 20, local: 10, union: 5 },
  nearby: { location: 50, sector: 15, issues: 15, expertise: 10, local: 5, union: 5 },
  problems: { location: 5, sector: 15, issues: 55, expertise: 20, local: 0, union: 5 },
  mentors: { location: 10, sector: 15, issues: 20, expertise: 50, local: 0, union: 5 },
};
const keysOf = (values) => values.map((entry) => typeof entry === "string" ? entry : entry.key || entry.id);
const percent = (value) => `${Math.round(value * 100)}%`;

function Checklist({ title, values, selected, onChange, tr, max = Infinity }) {
  return <fieldset className="cs-checklist"><legend>{title}</legend>{values.map((key) => <label key={key}>
    <input type="checkbox" disabled={!selected.includes(key) && selected.length >= max} checked={selected.includes(key)} onChange={(event) => onChange(event.target.checked ? [...selected, key] : selected.filter((item) => item !== key))} />{tr(key)}
  </label>)}</fieldset>;
}

function ProfileEditor({ workspace, onSave, busy, lang, tr }) {
  const current = workspace.draft || workspace.profile || {};
  const [form, setForm] = useState(() => ({
    location: { country: current.location?.country || "", state: current.location?.state || "", metro: current.location?.metro || "" },
    sectorKeys: current.sectorKeys || [], expertiseOffered: current.expertiseOffered || [],
    declaredIssueKeys: current.declaredIssueKeys || [],
    kind: current.kind || "chapter", shareAnalyzedIssues: current.shareAnalyzedIssues === true,
    declaredLocalKey: current.declaredLocalKey || null, declaredUnionFamilyKey: current.declaredUnionFamilyKey || null,
  }));
  const [consent, setConsent] = useState(false);
  const publishButton = useRef(null);
  const locationHint = useId();
  const regionRequired = Boolean(form.location.metro.trim());
  const countryValid = /^[A-Z]{2}$/.test(form.location.country);
  const regionValid = (!form.location.state && !regionRequired) || /^[A-Z]{2,3}$/.test(form.location.state);
  const problem = !countryValid ? "connectionProfilePublish.country"
    : !regionValid ? form.location.state ? "connectionProfilePublish.region" : "connectionProfilePublish.metroRegion"
    : !consent ? "connectionProfilePublish.consent" : null;
  const invalidLocation = { country: !countryValid, state: !regionValid };
  const field = (key, value) => { setConsent(false); setForm((prior) => ({ ...prior, [key]: value })); };
  const location = (key, value) => { setConsent(false); setForm((prior) => ({ ...prior, location: { ...prior.location, [key]: value } })); };
  function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (problem) {
      // Direct form submits bypass the button's refusal alert.
      publishButton.current?.click();
      return;
    }
    onSave(form, true);
  }
  return <form className="cs-profile oi-card" onSubmit={submit}>
    <h3>{tr("profile")}</h3><p>{tr("publicNotice")}</p>
    <label className="oi-field">{tr("unitKind")}<select value={form.kind} onChange={(event) => field("kind", event.target.value)}><option value="chapter">{tr("chapter")}</option><option value="local">{tr("localUnit")}</option></select></label>
    <div className="oi-form__grid">
      {[["country", "countryLabel", 2], ["state", "stateLabel", 3], ["metro", "metroLabel", 80]].map(([key, label, maxLength]) => <label className="oi-field" key={key}>{tr(label)}<input required={key === "country" || (key === "state" && regionRequired)} aria-invalid={invalidLocation[key] || undefined} aria-describedby={locationHint} value={form.location[key]} maxLength={maxLength} onChange={(event) => location(key, key !== "metro" ? event.target.value.trim().toUpperCase() : event.target.value)} /></label>)}
    </div>
    <p className="cs-note" id={locationHint}>{tr("locationFormat")}</p>
    <Checklist title={tr("sectorsLabel")} max={5} values={keysOf(CONNECTION_SECTORS)} selected={form.sectorKeys} onChange={(value) => field("sectorKeys", value)} tr={tr} />
    <p className="cs-note">{tr("sectorLimit")}</p>
    <Checklist title={tr("prioritiesLabel")} values={keysOf(CONNECTION_ISSUE_TOPICS)} selected={form.declaredIssueKeys} onChange={(value) => field("declaredIssueKeys", value)} tr={tr} />
    <p className="cs-note">{tr("declared")}</p>
    <Checklist title={tr("expertiseLabel")} values={keysOf(CONNECTION_ISSUE_TOPICS)} selected={form.expertiseOffered} onChange={(value) => field("expertiseOffered", value)} tr={tr} />
    <label className="cs-consent"><input type="checkbox" checked={form.shareAnalyzedIssues} onChange={(event) => field("shareAnalyzedIssues", event.target.checked)} />{tr("shareAnalyzed")}</label>
    <label className="cs-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{tr("consent")}</label>
    <div className="oi-actions"><BusyButton ref={publishButton} type="submit" className="oi-button" pending={busy} disabled={Boolean(problem)} disabledReason={problem ? t(lang, problem) : null}>{tr(busy ? "saving" : "save")}</BusyButton>
      {workspace.profile && <BusyButton type="button" className="oi-button oi-button--secondary" pending={busy} onClick={() => onSave({}, false)}>{tr("withdraw")}</BusyButton>}
    </div>
  </form>;
}

export function ConnectionSuggestions(props) {
  const { actor, preview } = props;
  // A scope change remounts drafts, consent, preferences and async callbacks.
  // In particular, changing chapter within one organization is a new scope.
  const scope = JSON.stringify([actor?.userId, actor?.organizationId, actor?.chapterId, actor?.selectedHat, actor?.membershipStatus, actor?.mfaSatisfied, preview]);
  return <ConnectionSuggestionsSession key={scope} {...props} />;
}

function ConnectionSuggestionsSession({ client, actor, preview = false, lang = "en", adapter: override, organizationConfiguration = null }) {
  const tr = connectionCopy(lang);
  const network = unionNetworkCopy(lang);
  const adapter = useMemo(() => override || createConnectionAdapter(client, actor?.selectedHat), [override, client, actor?.selectedHat]);
  const fixtures = useRef(null);
  if (preview && !fixtures.current) fixtures.current = createConnectionPreview();
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_CONNECTION_SETTINGS, weights: { ...(organizationConnectionWeights(organizationConfiguration) || presets.balanced) } }));
  const [displayLimit, setDisplayLimit] = useState(12);
  const [data, setData] = useState(null);
  const [loadState, setLoadState] = useState("loading");
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435), keyed by the record the write changes.
  const busyWriteRef = useRef(new Set());
  const [notice, setNotice] = useState("");
  const [handshakeTarget, setHandshakeTarget] = useState(null);
  const [handshakeNotice, setHandshakeNotice] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setLoadState("loading"); setDisplayLimit(12);
    (async () => {
      try {
        if (preview) {
          setData(fixtures.current); setLoadState("ready"); return;
        }
        const workspace = await adapter.workspace(actor?.chapterId);
        if (controller.signal.aborted) return;
        if (workspace.organizationId !== actor?.organizationId) throw new Error("organization_changed");
        if (actor?.chapterId && workspace.chapterId !== actor.chapterId) throw new Error("chapter_changed");
        const result = await adapter.profiles(controller.signal, workspace.chapterId);
        if (controller.signal.aborted) return;
        setData({ workspace, profiles: Array.isArray(result) ? result : result.profiles || result.rows });
        setLoadState("ready");
      } catch (error) {
        if (!controller.signal.aborted) setLoadState(["PGRST202", "42883"].includes(error?.code) ? "unavailable" : error?.code === "42501" ? "unauthorized" : "error");
      }
    })();
    return () => controller.abort();
  }, [adapter, preview, retry, actor?.organizationId, actor?.chapterId]);
  const ranked = useMemo(() => data?.workspace.profile ? rankConnections({ source: data.workspace.profile, candidates: data.profiles || [], settings, now: Date.now(), limit: Math.min(100, displayLimit + 1) }) : null, [data, settings, displayLimit]);
  const change = (key, value) => { setDisplayLimit(12); setSettings((prior) => ({ ...prior, [key]: value })); };
  const save = (form, publish) => runBusyWrite(busyWriteRef, `profile:${data?.workspace?.chapterId ?? ""}`, () => saveNow(form, publish));
  const saveNow = async (form, publish) => {
    setBusy(true); setNotice("");
    try {
      if (preview) {
        const old = fixtures.current.workspace;
        fixtures.current = { ...fixtures.current, workspace: { ...old, draft: form, profile: publish ? { ...old.profile, id: old.chapterId, displayName: old.chapters[0].name, kind: "chapter", discoverable: true, ...form, issuePriorities: form.declaredIssueKeys.map((key) => ({ key, strength: 1 })), assistanceNeeds: form.declaredIssueKeys.map((key) => ({ key, strength: 1 })), publishedAt: new Date().toISOString() } : null } };
      } else await adapter.save(data.workspace.chapterId, form, publish);
      if (!mounted.current) return;
      setEditing(false); setNotice(publish ? "saved" : "withdrawn"); setRetry((value) => value + 1);
    } catch { if (mounted.current) setNotice("saveError"); }
    finally { if (mounted.current) setBusy(false); }
  };
  const workspace = data?.workspace;
  return <section className="cs-shell" aria-label={tr("results")}>
    <UnionNetworkNav current="connections" staff admin={actor?.selectedHat === "admin"} />
    <header className="cs-heading"><div><h2>{tr("title")}</h2><p>{tr("intro")}</p></div>{preview && <span className="oi-badge">{tr("preview")}</span>}</header>
    {handshakeNotice && <p role="status" className="oi-notice">{network(handshakeNotice)}</p>}
    {handshakeTarget && <ConnectionHandshakeDialog key={handshakeTarget.id} target={handshakeTarget} chapterId={data?.workspace.chapterId} adapter={adapter} preview={preview} lang={lang}
      onClose={() => setHandshakeTarget(null)} onSaved={(message) => { if (mounted.current) { setHandshakeTarget(null); setHandshakeNotice(message); } }} />}
    {notice && <p role="status" className="oi-notice">{tr(notice)}</p>}
    {loadState !== "ready" ? <div className="oi-state" role="status"><p>{tr(loadState)}</p>{loadState !== "loading" && <button className="oi-button oi-button--secondary" onClick={() => setRetry((value) => value + 1)}>{tr("retry")}</button>}</div> : <>
      <div className="cs-source oi-card"><div><strong>{workspace.profile?.displayName || workspace.chapters?.find((row) => row.id === workspace.chapterId)?.name || tr("ownChapter")}</strong><p>{tr("protected")}</p></div>
        {workspace.canPublish && workspace.chapterId ? <button className="oi-button oi-button--secondary" onClick={() => setEditing((value) => !value)}>{tr(editing ? "close" : workspace.profile ? "edit" : "setup")}</button> : <p>{tr(workspace.chapterId ? "noPermission" : "noChapter")}</p>}
      </div>
      {editing && <ProfileEditor workspace={workspace} onSave={save} busy={busy} lang={lang} tr={tr} />}
      {workspace.canPublish && workspace.chapterId && <ReviewedIssueSignals key={workspace.chapterId} workspace={workspace} adapter={adapter} preview={preview} lang={lang} onRefresh={() => setRetry((value) => value + 1)} />}
      <div className="cs-layout"><aside className="cs-controls oi-card" aria-label={tr("tuning")}>
        <h3>{tr("tuning")}</h3><p className="cs-note">{tr("preferences")}</p>
        <div className="cs-presets">{Object.entries(presets).map(([key, weights]) => <button className="oi-button oi-button--secondary" key={key} onClick={() => change("weights", { ...weights })}>{tr(key)}</button>)}</div>
        {CONNECTION_WEIGHT_KEYS.map((key) => <label className="cs-dial" key={key}><span><strong>{tr(key)}</strong><output>{settings.weights[key]}</output></span><small>{tr(`${key}Help`)}</small><input type="range" min="0" max="100" step="1" aria-label={tr(key)} value={settings.weights[key]} onChange={(event) => change("weights", { ...settings.weights, [key]: Number(event.target.value) })} /></label>)}
        <label className="oi-field">{tr("reach")}<select value={settings.reach} onChange={(event) => change("reach", event.target.value)}>{["anywhere", "same-country", "same-state"].map((key) => <option value={key} key={key}>{tr(key)}</option>)}</select></label>
        <label className="oi-field">{tr("scale")}<select value={settings.locationScale} onChange={(event) => change("locationScale", event.target.value)}>{["metro", "state", "country"].map((key) => <option value={key} key={key}>{tr(key)}</option>)}</select></label>
        <label className="oi-field">{tr("freshness")}<select value={settings.freshnessDays ?? ""} onChange={(event) => change("freshnessDays", event.target.value === "" ? null : Number(event.target.value))}><option value="">{tr("allAges")}</option>{[30, 90, 180].map((days) => <option value={days} key={days}>{tr(`days${days}`)}</option>)}</select></label>
        <label className="cs-dial"><span><strong>{tr("variety")}</strong><output>{Math.round(settings.diversity * 1000)}</output></span><small>{tr("varietyHelp")}</small><input type="range" min="0" max="100" step="1" aria-label={tr("variety")} value={Math.round(settings.diversity * 1000)} onChange={(event) => change("diversity", Number(event.target.value) / 1000)} /></label>
      </aside><div className="cs-results" aria-label={tr("results")} aria-live="polite" aria-atomic="false">
        <div><h3>{tr("results")}</h3><p className="cs-note">{ranked ? `${ranked.scannedCount} ${tr("examined")}. ` : ""}{tr("scoreHelp")}</p></div>
        {ranked?.disabledDimensions?.length > 0 && <p className="cs-note">{tr("inactive")}: {ranked.disabledDimensions.map((item) => tr(typeof item === "string" ? item : item.dimension)).join(", ")}</p>}
        {!workspace.profile ? <p className="oi-state">{tr("noSource")}</p> : ranked?.state !== "ready" || !ranked.results.length ? <p className="oi-state">{tr(ranked?.reason === "needs_preferences" ? "zero" : ranked?.reason === "insufficient_source_data" ? "insufficient" : ranked?.reason === "reach_location_required" ? "reachLocation" : "empty")}</p> : ranked.results.slice(0, displayLimit).map((result) => <article className="oi-card cs-result" key={result.id}>
          <div className="cs-result-heading"><div><h4>{result.displayName}</h4><p>{[result.location?.metro, result.location?.state, result.location?.country].filter(Boolean).join(" · ")}</p></div><div className="cs-score"><strong>{Math.round(result.score * 100)}</strong><span>{tr("score")}</span></div></div>
          <div className="cs-tags">{result.sectorKeys.map((key) => <span className="oi-badge" key={key}>{tr(key)}</span>)}</div>
          <p className="cs-note">{tr("coverage")}: {percent(result.coverage)}{result.diversityPenalty > 0 ? ` · ${tr("diversityApplied")}` : ""}</p>
          <details><summary>{tr("why")}</summary><dl className="cs-contributions">{result.contributions.map((item) => <div key={item.dimension}><dt>{tr(item.dimension)}</dt><dd>{item.available ? `+${(item.contribution * 100).toFixed(1)}` : tr("missing")}</dd></div>)}</dl></details>
          <div className="oi-actions">
            {workspace.canRequestHandshake && result.handshake?.eligible && <button className="oi-button" onClick={() => { setHandshakeNotice(""); setHandshakeTarget(result); }}>{network("request")}</button>}
          </div>
          {workspace.canRequestHandshake && !result.handshake?.eligible && <p className="cs-note">{network("targetUnavailable")}</p>}
        </article>)}
        {ranked?.results.length > displayLimit && <button className="oi-button oi-button--secondary" onClick={() => setDisplayLimit((value) => Math.min(100, value + 12))}>{tr("showMore")}</button>}
      </div></div>
      {/* An injected adapter without the partner reads (an older embedding) shows no panel. */}
      {workspace.chapterId && (preview || typeof adapter.listPartnerOffices === "function") && <PartnerOffices key={workspace.chapterId} adapter={adapter} chapterId={workspace.chapterId} selectedHat={actor?.selectedHat} lang={lang} preview={preview} source={workspace.profile} settings={settings} />}
    </>}
  </section>;
}
