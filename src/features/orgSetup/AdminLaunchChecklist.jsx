import { WorkspaceSection, useWorkspace } from "../../components/WorkspacePages.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { PLANE_CARD_CLASS } from "../../lib/staffPlaneStyles.js";

const TWO_STEP_PATH = "/m/settings/security";
const STRUCTURE_PATH = "/m/admin/setup-review";
const INVITATIONS_PATH = "/m/admin/invitations";
const STEWARDS_PATH = "/m/admin/access";
const WELCOME_PATH = "/m/support/onboarding";

// done is true, false, or null when the read behind it did not load: an
// unknown step is never shown as done and never counts toward finishing.
function readFlag(value) {
  return typeof value === "boolean" ? value : null;
}

// Two independently degradable reads where either one can prove the step: a
// proof wins, "not done" needs both reads, and anything else stays unknown.
function eitherProves(proofs, unknown) {
  if (proofs) return true;
  return unknown ? null : false;
}

// The ordered first steps of a new administrator (two-step, confirm chapters,
// invite members, assign stewards, write the welcome checklist), each backed
// by real setup state the admin desk carries. Optional integrations stay out.
// Organization structure is an organization-role flow, so a chapter-only admin
// does not get that step.
export function launchChecklistSteps({ desk, organizationAdmin = true }) {
  const chapters = Array.isArray(desk?.organization?.chapters) ? desk.organization.chapters : null;
  const roster = Array.isArray(desk?.roster) ? desk.roster : null;
  const invitations = Array.isArray(desk?.invitations?.items) ? desk.invitations.items : null;
  const stewards = roster === null ? null : roster.some((person) => (person.roles ?? []).includes("steward"));
  // The founder's own invitation (kind "founder", issued to open the
  // organization) is not the admin inviting anyone; every other invitation,
  // accepted or not, is. Members who joined without a staff role never show
  // on the staff roster, so their accepted invitations must still count
  // (REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030).
  const invitedSomeone = (invitations ?? []).some((invitation) => invitation?.kind !== "founder");
  const steps = [
    // The caller's own enrolment, which any admin may read; the organization
    // policy read refuses a chapter-scoped admin, so it is only the fallback.
    { key: "twoStep", done: readFlag(desk?.callerTwoStepEnrolled ?? desk?.mfaPolicy?.callerEnrolled), path: TWO_STEP_PATH, view: "settings" },
    { key: "structure", done: chapters === null ? null : chapters.length > 1, path: STRUCTURE_PATH },
    { key: "invite", done: eitherProves((roster?.length ?? 0) > 1 || invitedSomeone, roster === null || invitations === null), path: INVITATIONS_PATH },
    { key: "steward", done: stewards, path: STEWARDS_PATH },
    { key: "welcome", done: Number.isInteger(desk?.onboardingStepCount) ? desk.onboardingStepCount > 0 : null, path: WELCOME_PATH, view: "memberSupport" },
  ];
  return organizationAdmin ? steps : steps.filter((step) => step.key !== "structure");
}

// A short "Getting started" list above the admin directory. It leaves the
// page once every step is done. It carries no count of its own: the
// organization guide's milestone ring is the one progress counter on the
// admin home, and a second tally of different steps contradicted it.
export function AdminLaunchChecklist({ desk, organizationAdmin = true }) {
  const { t } = useLang();
  const workspace = useWorkspace();
  const steps = launchChecklistSteps({ desk, organizationAdmin });
  if (steps.every((step) => step.done === true)) return null;
  return <section className={`${PLANE_CARD_CLASS} xus-card`} aria-label={t("unions.launch.title")}>
    <div className="xus-cardbody xus-form">
      <h2 className="xus-etitle">{t("unions.launch.title")}</h2>
      <ol className="xus-list">
        {steps.map((step) => <li key={step.key} className="xus-launch-step"><span className="xus-launch-step__row">
          <a
            href={step.path}
            onClick={(event) => {
              if (!workspace) return;
              event.preventDefault();
              workspace.open(step.path, step.view);
            }}
          >{t(`unions.launch.step.${step.key}`)}</a>
          {/* UX-UG-ADMIN-CHECKLIST-LINK-AND-STATUS-POLISH-20261020: the
              state as one of the desk's chips (done, not yet, could not check). */}
          <span className={`xus-chip ${step.done === true ? "xus-chip--on" : step.done === false ? "xus-chip--off" : "xus-chip--warn"}`}>
            {step.done === true && <span className="xus-chip__ic" aria-hidden="true">✓</span>}
            {t(step.done === true ? "unions.launch.done" : step.done === false ? "unions.launch.todo" : "unions.launch.unknown")}
          </span>
        </span></li>)}
      </ol>
    </div>
  </section>;
}

// The checklist's place in the Admin overview, once the desk has loaded and
// not in a failed state. The condition lives here, not in AdminView, so the
// view's own branch count is untouched.
export function AdminLaunchChecklistSlot({ error = null, desk = null, organizationAdmin = true }) {
  if (error || !desk) return null;
  return <WorkspaceSection name="overview"><AdminLaunchChecklist desk={desk} organizationAdmin={organizationAdmin} /></WorkspaceSection>;
}
