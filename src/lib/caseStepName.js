// BUG-UG-SPANISH-CASE-STAGE-ARBITRATION-AND-MEDIATION-STAY-ENGLISH-20261110:
// the one rule for turning a stored case step into words. Stored steps are
// locale-neutral English values. The app-known stages ("Step N", "Intake",
// "Arbitration", "Mediation", "Closed") are named in the reader's language;
// any other value (an organization's own step name, "Loudermill") is shown
// exactly as stored. The coordinator queue, steward caseload, case dashboards,
// member Cases and Home, case signals, casework history, the CSV export and the
// alternate case desk all read it, so a new app-known stage is added here once.
const KNOWN_STAGES = Object.freeze([
  [/^step\s*(\d+)$/i, (match) => ({ key: "coordinator.stepN", vars: { n: match[1] } })],
  [/^intake$/i, () => ({ key: "coordinator.stepIntake" })],
  [/^arbitration$/i, () => ({ key: "coordinator.stepArbitration" })],
  [/^mediation$/i, () => ({ key: "coordinator.stepMediation" })],
  [/^closed$/i, () => ({ key: "coordinator.stepClosed" })],
]);

// The catalogue key (and its variables) for an app-known stage, else null.
export function knownCaseStep(step) {
  const value = typeof step === "string" ? step.trim() : "";
  for (const [pattern, name] of KNOWN_STAGES) {
    const match = pattern.exec(value);
    if (match) return name(match);
  }
  return null;
}

export function caseStepLabel(step, t) {
  const known = knownCaseStep(step);
  return known ? t(known.key, known.vars) : step;
}
