import { useRef, useState } from "react";
import { BrandMark } from "../../components/BrandMark.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";
import { prepareBusyWrite } from "../../lib/busyWrite.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import {
  createMyOrganization, newIdempotencyKey, ORGANIZATION_NAME_MAX, organizationNameProblem,
} from "../../lib/openSignup.js";
import { UnionCatalogPicker } from "./UnionCatalogPicker.jsx";

const OUTCOME_KEYS = {
  name_unavailable: "createOrg.nameUnavailable",
  limit_reached: "createOrg.limitReached",
  unavailable: "createOrg.unavailable",
  "not-permitted": "createOrg.notPermitted",
  "has-organization": "createOrg.hasOrganization",
  "invalid-name": "createOrg.nameCharacters",
  error: "createOrg.error",
};

const NAME_PROBLEM_KEYS = { length: "createOrg.nameLength", characters: "createOrg.nameCharacters" };

// Rendered by MemberApp in place of the member shell when a signed-in account
// on the SaaS host has no organization. It creates one unverified organization
// through public.create_my_organization and then hands the creator to two-step
// sign-in (require_staff_mfa stays true for every new organization). The union
// catalog picker above the name suggests a name and the local to set up under
// (REQ-UG-SIGNUP-UNION-CATALOG-PICKER-20261109); onCreated receives
// that placement, which grants nothing.
export function CreateOrganizationGate({ client, onCreated, onSignOut }) {
  const { t } = useLang();
  // One key for the life of this screen: a retry after a lost response
  // replays the first creation instead of attempting a second one.
  const idempotencyKey = useRef(null);
  if (!idempotencyKey.current) idempotencyKey.current = newIdempotencyKey();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [created, setCreated] = useState(false);
  const [placement, setPlacement] = useState(null);
  // Synchronous create lock (#8435): the name check sends nothing and runs
  // without it; the create holds it until it settles.
  const busyWriteRef = useRef(new Set());

  function choosePlacement(next) {
    setPlacement(next);
    if (next?.name) {
      setName(next.name);
      setProblem("");
    }
  }

  function submit(event) {
    event.preventDefault();
    return prepareBusyWrite(busyWriteRef, "create", () => {
      if (created) return undefined;
      const nameProblem = organizationNameProblem(name);
      if (nameProblem) {
        setProblem(NAME_PROBLEM_KEYS[nameProblem]);
        return undefined;
      }
      return submitNow;
    }, event);
  }

  async function submitNow() {
    setBusy(true);
    setProblem("");
    const result = await createMyOrganization(client, name.trim(), idempotencyKey.current);
    setBusy(false);
    if (result.status === "created") {
      setCreated(true);
      onCreated(result, placement ? { unionKey: placement.unionKey, scope: placement.scope } : null);
      return;
    }
    setProblem(OUTCOME_KEYS[result.status] || OUTCOME_KEYS.error);
  }

  const noteId = "create-org-unverified";
  return (
    <main className="auth-screen">
      <div className="sgauth-column">
        <section className="auth-card" aria-labelledby="create-org-title">
          <span className="iac-brand"><BrandMark size={40} /></span>
          <span className="eyebrow">{t("createOrg.eyebrow")}</span>
          <h1 id="create-org-title">{t("createOrg.title")}</h1>
          <p>{t("createOrg.intro")}</p>
          <p className="auth-requirements" id={noteId}>{t("createOrg.unverified")}</p>
          <UnionCatalogPicker client={client} pending={busy} disabled={created} onChoose={choosePlacement} />
          <form onSubmit={submit} noValidate aria-describedby={noteId}>
            <label>
              <span>{t("createOrg.name")}</span>
              <div><input name="organizationName" type="text" autoComplete="organization" required maxLength={ORGANIZATION_NAME_MAX * 2} value={name} onChange={(event) => setName(event.target.value)} /></div>
            </label>
            {placement?.name && name === placement.name && <p className="auth-requirements" role="status">{t("createOrg.pick.prefilled")}</p>}
            <BusyButton className="auth-submit" type="submit" pending={busy} disabled={created || !name.trim()}>
              {busy ? t("createOrg.working") : t("createOrg.submit")}
            </BusyButton>
          </form>
          {problem && <p className="auth-message auth-message--error" role="alert">{t(problem)}</p>}
          {created && <p className="auth-message auth-message--success" role="status">{t("createOrg.created")}</p>}
          <p className="sgauth-recovery">{t("createOrg.invite")}</p>
          <button className="auth-switch" type="button" onClick={onSignOut}>{t("createOrg.signOut")}</button>
        </section>
      </div>
    </main>
  );
}
