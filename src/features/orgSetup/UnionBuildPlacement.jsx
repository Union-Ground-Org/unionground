import { useEffect, useRef, useState } from "react";
import { CATALOG_KEY_PATTERN } from "../unionCatalog/catalogSearch.js";
import { loadSetupProfile, probeSetupCatalog } from "./setupApi.js";
import { featuredUnionForKey, resolveUnionProfileKey } from "../unionCatalog/unionIdentity.js";
import { unionNetworkCopy } from "../unionCatalog/unionNetworkCopy.js";
import { PlacementBadge } from "../unionCatalog/PlacementBadge.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";

export function unionBuildContext(search) {
  const params = new URLSearchParams(search);
  if (params.get("build") !== "chapter" || !params.has("union")) return null;
  return { key: resolveUnionProfileKey(params.get("union")) };
}

export function placementMatchesParent(placement, parent) {
  if (!placement || !parent) return false;
  return parent.catalogKey ? placement.parentCatalogKey === parent.catalogKey && placement.parentActive !== false
    : !placement.parentCatalogKey && placement.unlistedParentName === parent.name;
}

// Public selection is a proposal, never an authority claim. Read both sides,
// then require an explicit placement save before the existing structure import.
export function UnionBuildPlacement({ context, client, api, organizationId, offline, lang, onChange, onStartOver }) {
  const tr = unionNetworkCopy(lang);
  const [state, setState] = useState("loading");
  const [parent, setParent] = useState(null);
  const [placement, setPlacement] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pendingKey = useRef(null);
  const mounted = useRef(false);
  const active = useRef(false);
  const callback = useRef(onChange); callback.current = onChange;
  useEffect(() => {
    mounted.current = true;
    let live = true;
    setState("loading"); setParent(null); setPlacement(null);
    callback.current({ confirmed: false });
    (async () => {
      try {
        if (!context.key) throw new Error("unknown_union");
        let next;
        let publicProfile = null;
        let publicPin = null;
        if (CATALOG_KEY_PATTERN.test(context.key)) {
          if (offline || !client) throw new Error("catalog_unavailable");
          const probe = await probeSetupCatalog(client);
          if (probe.catalog !== "live") throw new Error("catalog_unavailable");
          const profile = await loadSetupProfile(client, context.key);
          if (!profile.found || profile.organization.key !== context.key) throw new Error("catalog_unavailable");
          next = { key: context.key, catalogKey: context.key, name: profile.organization.name };
          publicProfile = profile;
          publicPin = probe.status;
        } else {
          const featured = featuredUnionForKey(context.key);
          if (!featured) throw new Error("unknown_union");
          next = { key: context.key, catalogKey: null, name: featured.name };
        }
        const current = !offline && organizationId ? await api.getOrganizationCatalogPlacement(organizationId) : null;
        if (!live) return;
        setParent(next); setPlacement(current); setState("ready");
        callback.current({ parent: next, confirmed: placementMatchesParent(current, next), publicProfile, publicPin });
      } catch { if (live) setState("error"); }
    })();
    return () => { live = false; mounted.current = false; };
  }, [context.key, client, api, organizationId, offline, attempt]);
  async function confirm() {
    if (active.current || offline || !parent || !organizationId) return;
    active.current = true; setBusy(true); setFailed(false);
    pendingKey.current ??= crypto.randomUUID();
    try {
      const fields = { ...(parent.catalogKey ? { parentCatalogKey: parent.catalogKey }
        : { unlistedParentName: parent.name }), identityUnlisted: placement?.identityUnlisted === true };
      const saved = await api.setOrganizationCatalogPlacement(organizationId, fields, pendingKey.current);
      if (!placementMatchesParent(saved, parent)) throw new Error("placement_not_confirmed");
      if (!mounted.current) return;
      pendingKey.current = null; setPlacement(saved);
      callback.current((value) => ({ ...value, parent, confirmed: true }));
    } catch { if (mounted.current) setFailed(true); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  const confirmed = placementMatchesParent(placement, parent);
  return <section className="xus-cardbody xus-form" aria-label={tr("parentTitle")}>
    <h3 className="xus-etitle">{tr("parentTitle")}</h3><p className="xus-note">{tr("parentHelp")}</p>
    {state === "loading" && <p role="status">{tr("parentLoading")}</p>}
    {state === "error" && <><p role="status">{tr("parentUnavailable")}</p><button className="xus-btn" onClick={() => setAttempt((value) => value + 1)}>{tr("parentRetry")}</button></>}
    {parent && <><p><strong lang="en">{parent.name}</strong>{confirmed && <> <PlacementBadge state={placement.verificationStatus} /></>}</p>
      <p className="xus-note">{tr("parentExisting")}</p>
      {placement && !confirmed && <p>{placement.parentName || placement.unlistedParentName} <PlacementBadge state={placement.verificationStatus} /></p>}
      {confirmed ? <p role="status" className="xus-note xus-note--success">{tr("parentSaved")}</p>
        : <BusyButton className="xus-btn xus-btn--go" pending={busy} disabled={offline || !organizationId} onClick={confirm}>{tr("useParent")}</BusyButton>}
    </>}
    {failed && <p role="alert" className="xus-note xus-note--error">{tr("placementFailed")}</p>}
    <BusyButton className="xus-btn" pending={busy} onClick={onStartOver}>{tr("ownStructure")}</BusyButton>
  </section>;
}
