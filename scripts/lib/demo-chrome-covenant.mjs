import { SAMPLE_BACKEND } from "../../src/lib/sampleBackend.js";
/* global NodeFilter, document, getComputedStyle */

// Covenant coverage for the merged SAMPLE demo-chrome repairs (PR #1511 and
// PR #1522). The generic 32-surface visual audit measures collisions, clipped
// interactives and overflow against a baseline; it deliberately knows nothing
// about the specific promises those records made:
//
//   * every rendered navigation label fits its allocation and never breaks
//     inside a word, in both rail states and in both shipped languages;
//   * the chapter rail keeps all seeded chapter names and count lines legible
//     at 1280, 1440 and 1920 without page-level horizontal scrolling;
//   * every desktop rail control stays inside a 450px-high viewport and keeps
//     its 44px target floor;
//   * the first-visit welcome is the sole foreground modal, its dismissal opens
//     the explanatory hat menu, hands focus to the visible Switch-hat trigger,
//     accepts an explicit Coordinator selection, and never replays on reload.
//
// The measurement functions in this module are serialized into the audited
// page by the driver, so they must stay self-contained. The classifiers are
// pure and are the unit-tested half of the contract.

const EPSILON = 0.5;
const MIN_TARGET_PX = 44;
const OPAQUE_ENOUGH = 0.95;

export const DEMO_CHROME_COVENANT_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "desktop-1280x800", width: 1280, height: 800 }),
  Object.freeze({ name: "wide-1440x900", width: 1440, height: 900 }),
  Object.freeze({ name: "wide-1920x1080", width: 1920, height: 1080 }),
  // 1024x450 is the 200%-zoom-equivalent short-height surface that caught the
  // Cobalt Signal row-direction regression and Forms 2 sitting at bottom
  // 450.21875 during PR #1522 follow-up review.
  Object.freeze({ name: "short-1024x450", width: 1024, height: 450 }),
]);

export const DEMO_CHROME_COVENANT_LANGUAGES = Object.freeze(["en", "es"]);
export const DEMO_CHROME_RAIL_STATES = Object.freeze(["expanded", "collapsed"]);
export const DEMO_CHROME_SEQUENCE_VIEWPORT = Object.freeze({
  name: "wide-1440x900",
  width: 1440,
  height: 900,
});
export const DEMO_CHROME_LANGUAGE_STORAGE_KEY = "sg-lang";
export const DEMO_CHROME_HAT_INTRO_STORAGE_KEY = "sg:demo:desktop-hat-intro-seen:v1";
export const DEMO_CHROME_SHORT_HEIGHT_VIEWPORT_NAME = "short-1024x450";
// The merged repair deliberately keeps the legacy 184px chapter allocation
// through 1279px and expands to 272px only at the record's supported desktop
// widths, so chapter-name and count legibility is asserted from 1280px up.
export const DEMO_CHROME_CHAPTER_LEGIBILITY_MIN_WIDTH = 1280;

// BUG-UNION-GROUND-DEMO-CHAPTER-RAIL-CLIPPING-20260902 pins the fictional
// SAMPLE chapter seed at exactly 20 chapters, and the record's acceptance is
// literally "All 20 chapter names and count lines are legible without
// clipping". The generic clip check said nothing about how many rows must be
// present, so a surface that rendered a single legible chapter passed. The
// covenant now requires every seeded chapter NAME and its matching COUNT line
// to be measured, so a truncated or partially-hydrated rail fails closed.
export const DEMO_CHROME_EXPECTED_CHAPTER_COUNT = 20;
export const DEMO_CHROME_EXPECTED_CHAPTER_NAMES = Object.freeze([
  "Cedar Ridge Care Services",
  "Pine Harbor Care Services",
  "Maple Crossing Care Services",
  "Pine Harbor Family Services",
  "Pine Harbor Health Services",
  "Pine Harbor Benefits Office",
  "Spruce Point Care Services",
  "Willow Bend Care Services",
  "Birch Hollow Care Services",
  "Cedar Ridge Family Services",
  "Maple Crossing Family Services",
  "Willow Bend Family Services",
  "Elm Grove Health Services",
  "Oak Meadow Health Services",
  "Cedar Ridge Health Services",
  "Cedar Ridge Rehab Services",
  "Maple Crossing Benefits Office",
  "Cedar Ridge Benefits Office",
  "Aspen Flats Benefits Office",
  "Pine Harbor Rehab Services"
]);

// Hosted SAMPLE personas share database rows, so changing a persona's saved
// language would mutate the demo for every visitor. The covenant instead
// projects the requested language into the GET response inside its isolated
// browser context. Every other profile field and every production rendering
// path stays intact, while the proof remains read-only against SAMPLE.
export function projectMemberProfileLanguage(payload, language) {
  if (!DEMO_CHROME_COVENANT_LANGUAGES.includes(language)) {
    throw new Error(`Unsupported covenant language: ${String(language)}`);
  }
  const project = (row) => (
    row && typeof row === "object" && !Array.isArray(row)
      ? { ...row, language }
      : row
  );
  return Array.isArray(payload) ? payload.map(project) : project(payload);
}

export class CovenantAssertionError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CovenantAssertionError";
  }
}

export function attachCovenantFindings(error, findings = []) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return error;
  const accumulated = Array.isArray(error.covenantFindings) ? [...error.covenantFindings] : [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!accumulated.includes(finding)) accumulated.push(finding);
  }
  Object.defineProperty(error, "covenantFindings", {
    configurable: true,
    enumerable: true,
    value: accumulated,
  });
  return error;
}

export class CovenantTransientRunnerError extends Error {
  constructor(classification, cause, findings = []) {
    super(summarizeCovenantError(cause), { cause });
    this.name = "CovenantTransientRunnerError";
    this.classification = classification;
    attachCovenantFindings(this, findings);
  }
}

// Case retries are deliberately narrower than Playwright's error vocabulary.
// Locator timeouts, language/identity assertions, document provenance errors,
// and every unknown exception are covenant failures. Only runner transport and
// artifact-capture failures identified here can receive a fresh context.
export function classifyTransientCovenantRunnerError(error) {
  if (error instanceof CovenantTransientRunnerError) return error.classification;
  return null;
}

export async function runCovenantCaseWithRetry(operation, {
  attempts = 2,
  onRetry = () => {},
  classifyRetry = classifyTransientCovenantRunnerError,
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("Covenant retry attempts must be a positive integer");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const classification = classifyRetry(error);
      if (!classification || attempt >= attempts) throw error;
      await onRetry(error, attempt, classification);
    }
  }
  throw lastError;
}

export function summarizeCovenantError(error, maxLength = 500) {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const firstLine = String(error?.message || error || "Unknown covenant error")
    .split(/\r?\n/, 1)[0]
    .replace(ansiPattern, "")
    .trim();
  return firstLine.slice(0, maxLength);
}

export function covenantErrorDetails(error) {
  return {
    name: error?.name || "Error",
    classification: classifyTransientCovenantRunnerError(error) || "assertion-or-unclassified",
    detail: summarizeCovenantError(error, 1200),
  };
}

export function attachCovenantSecondaryError(primary, phase, error) {
  const errors = primary.covenantSecondaryErrors ?? [];
  primary.covenantSecondaryErrors = [...errors, { phase, ...covenantErrorDetails(error) }];
}

export function chapterIdentityEvidence(chapterNames, expectedNames = DEMO_CHROME_EXPECTED_CHAPTER_NAMES) {
  const observed = Array.isArray(chapterNames)
    ? chapterNames.map((entry) => String(entry?.label ?? "").trim())
    : [];
  const expected = Array.isArray(expectedNames)
    ? expectedNames.map((entry) => String(entry).trim())
    : [];
  const counts = (values) => values.reduce((result, value) => {
    result.set(value, (result.get(value) ?? 0) + 1);
    return result;
  }, new Map());
  const observedCounts = counts(observed);
  const expectedCounts = counts(expected);
  const missing = [];
  const unexpected = [];
  for (const [label, count] of expectedCounts) {
    for (let index = observedCounts.get(label) ?? 0; index < count; index += 1) missing.push(label);
  }
  for (const [label, count] of observedCounts) {
    for (let index = expectedCounts.get(label) ?? 0; index < count; index += 1) unexpected.push(label);
  }
  const duplicates = [...observedCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([label, count]) => ({ label, count }));
  return { observed, expected, missing, unexpected, duplicates };
}

// Explicit identities/routes from App's DEMO_HATS and staffPlanes. Floors
// retain the shipped full rail, including Compass/profile/collapse controls;
// Member/Steward 24, Coordinator/Advisor 20, Admin 25, President 23.
export const DEMO_CHROME_COVENANT_HATS = Object.freeze([
  { key: "member", route: "/m", labels: { en: "Member", es: "Miembro" }, minControls: 24 },
  { key: "steward", route: "/m/steward", labels: { en: "Steward", es: "Delegado" }, minControls: 24 },
  { key: "coordinator", route: "/m/coordinator", labels: { en: "Coordinator", es: "Coordinador" }, minControls: 20 },
  { key: "advisor", route: "/m/advisor", labels: { en: "Advisor", es: "Asesor" }, minControls: 20 },
  { key: "admin", route: "/m/admin", labels: { en: "Admin", es: "Administrador" }, minControls: 25 },
  { key: "vp", route: "/m/vp", labels: { en: "President", es: "Presidente" }, minControls: 23 },
].map((hat) => Object.freeze({ ...hat, labels: Object.freeze(hat.labels) })));

// Work label fitting has its own required surface; it never substitutes for
// the Coordinator desk, or makes unrelated desks pretend to have Work tabs.
export function demoChromeGeometryCases() {
  return DEMO_CHROME_COVENANT_VIEWPORTS.flatMap((viewport) => (
    DEMO_CHROME_COVENANT_LANGUAGES.flatMap((language) => [
      ...DEMO_CHROME_COVENANT_HATS.map((hat) => ({ viewport, language, hat, route: hat.route })),
      { viewport, language, hat: DEMO_CHROME_COVENANT_HATS[2], route: "/m/tasks" },
    ])
  ));
}

// Validate observed rows against the fixed contract, never report-supplied
// hats/viewports. A missing whole hat, duplicate, or extra row cannot pass.
export function classifyCovenantCoverage(report) {
  const key = (row) => [row.hat, row.route, row.viewport?.name, row.viewport?.width,
    row.viewport?.height, row.language, row.railState, row.check].join("|");
  const expected = demoChromeGeometryCases().flatMap(({ hat, route, viewport, language }) => [
    ...DEMO_CHROME_RAIL_STATES.map((railState) => ({ hat: hat.key, route, viewport, language, railState, check: "geometry" })),
    ...(viewport.name === DEMO_CHROME_SHORT_HEIGHT_VIEWPORT_NAME
      ? [{ hat: hat.key, route, viewport, language, railState: "expanded", check: "short-height-controls" }] : []),
  ]);
  const actual = report.surfaces ?? [];
  const expectedKeys = new Set(expected.map(key));
  const findings = [];
  for (const row of expected) {
    const matches = actual.filter((candidate) => key(candidate) === key(row));
    if (matches.length !== 1 || (report.expectedSha && matches[0]?.documentSha !== report.expectedSha)) {
      findings.push(finding("covenant-matrix-incomplete", row,
        `expected one independently attested ${key(row)} row; observed ${matches.length}`));
    }
  }
  for (const row of actual) {
    if (!expectedKeys.has(key(row))) findings.push(finding("covenant-matrix-unexpected", row, `unexpected ${key(row)} row`));
  }
  return findings;
}

// Presentation only. Every original finding remains in report.findings and
// still controls the exit status. Missing evidence after an abort is not a
// measured geometry regression; duplicate or wrong-SHA rows remain distinct.
const covenantCaseKey = (row) => [row.hat, row.route, row.viewport?.name,
  row.viewport?.width, row.viewport?.height, row.language].join("|");

function isUnrunCoverageFinding(report, row) {
  return Boolean(report.executionFailure)
    && row.rule === "covenant-matrix-incomplete" && row.detail.endsWith("observed 0")
    && !(report.geometryCasesStarted ?? []).some((started) => covenantCaseKey(started) === covenantCaseKey(row));
}

export function summarizeCovenantCoverage(report) {
  const findings = classifyCovenantCoverage(report);
  const missing = findings.filter((row) => row.rule === "covenant-matrix-incomplete" && row.detail.endsWith("observed 0"));
  return {
    missingRows: missing.length,
    unrunRows: missing.filter((row) => isUnrunCoverageFinding(report, row)).length,
    invalidRows: findings.filter((row) => row.rule === "covenant-matrix-incomplete" && !row.detail.endsWith("observed 0")).length,
    unexpectedRows: findings.filter((row) => row.rule === "covenant-matrix-unexpected").length,
  };
}

export function renderCovenantFailureLines(report) {
  const lines = [];
  const failure = report.executionFailure;
  if (failure) {
    lines.push(`STOP ${failure.kind ?? "runner"} ${failure.activationKey ?? ""} ${failure.viewport?.name ?? ""} ${failure.language ?? ""} ${failure.route ?? ""} at ${failure.phase ?? "unknown"}: ${failure.error?.name ?? "Error"}: ${failure.error?.detail ?? "unknown error"}`);
    for (const secondary of failure.secondaryErrors ?? []) {
      lines.push(`SECONDARY ${secondary.phase}: ${secondary.name}: ${secondary.detail}`);
    }
  }
  const coverage = summarizeCovenantCoverage(report);
  if (coverage.missingRows || coverage.invalidRows || coverage.unexpectedRows) {
    lines.push(`COVERAGE missing=${coverage.missingRows} unrun-after-abort=${coverage.unrunRows} invalid=${coverage.invalidRows} unexpected=${coverage.unexpectedRows}; exact coverage is still required; individual rows retained in JSON`);
  }
  const primaryFindings = (report.findings ?? []).filter((row) => !isUnrunCoverageFinding(report, row));
  for (const entry of primaryFindings.slice(0, 40)) {
    lines.push(`FAIL ${entry.rule} ${entry.viewport?.name ?? ""} ${entry.language ?? ""} ${entry.railState ?? ""}: ${entry.detail}`);
  }
  if (primaryFindings.length > 40) lines.push(`Further findings retained in JSON: ${primaryFindings.length - 40}`);
  return lines;
}

// BUG-UNION-GROUND-DEMO-HAT-INTRO-WELCOME-20260902: the first-visit intro must
// present Member plus the five staff hats, in this exact identity set. Counting
// six labels was not enough — six duplicate "Member" entries, or five staff
// hats with a wrong sixth, both satisfied a length check while failing the
// record. The identities are the English demo hat labels the sequence renders.
export const DEMO_CHROME_EXPECTED_HAT_LABELS = Object.freeze([
  "Member",
  "Steward",
  "Coordinator",
  "Advisor",
  "Admin",
  "President",
]);

// The 450px short-height surface is where the PR #1522 follow-up regression
// lived (a control sitting at bottom 450.21875). Measuring zero controls in
// that viewport is not a pass — it means the rail never rendered or focus never
// reached it — so the covenant requires the full rail control set. The SAMPLE
// member/coordinator rail seeds 20 focusable destinations at every supported
// desktop width, so fewer than that is a fail-closed regression.
export const DEMO_CHROME_MIN_SHORT_HEIGHT_CONTROLS = 20;

// BUG-UNION-GROUND-DESKTOP-RAIL-APPOINTMENTS-WRAP-20260902 is about the
// "Appointments" destination, which lives on the Steward desk rail at the
// stable href below. The record's acceptance also requires "every desktop
// destination remains readable", so the covenant asserts the full Steward-desk
// destination set is present by stable, language-independent href — a rail with
// a single label, or one missing Appointments, now fails closed. Hrefs are used
// rather than labels because the labels are bilingual (en/es).
export const DEMO_CHROME_APPOINTMENTS_HREF = "/m/steward/appointments";
export const DEMO_CHROME_APPOINTMENTS_LABELS = Object.freeze({
  en: "Appointments",
  es: "Citas",
});
export const DEMO_CHROME_STEWARD_REQUIRED_DESTINATIONS = Object.freeze([
  "/m/steward",
  "/m/steward/caseload",
  "/m/steward/requests",
  "/m/steward/appointments",
  "/m/steward/forms",
  "/m/steward/messages",
  "/m/steward/checkins",
  "/m/steward/broadcasts",
  "/m/steward/qa",
  "/m/steward/email-intake",
  "/m/steward/workload",
  "/m/steward/casework-hub",
]);
// PR1815 made these existing controls addressable pages. Preserve the full
// bilingual label-fit obligation and also require each real destination once.
export const DEMO_CHROME_WORK_REQUIRED_DESTINATIONS = Object.freeze([
  "/m/tasks/board", "/m/tasks/list", "/m/tasks/timeline", "/m/tasks/calendar",
  "/m/tasks/deadlines", "/m/tasks/field_notes", "/m/tasks/progress", "/m/tasks/report",
]);
// The full Steward rail seeds this many destinations at supported desktop
// widths; fewer means a truncated or unhydrated rail.
export const DEMO_CHROME_STEWARD_MIN_DESTINATIONS = 20;

export const DEMO_CHROME_COVENANT_RULES = Object.freeze({
  RAIL_LABEL_CLIPPED: "rail-label-clipped",
  RAIL_LABEL_INTRA_WORD_BREAK: "rail-label-intra-word-break",
  RAIL_LABELS_MISSING: "rail-labels-missing",
  WORK_TAB_PAINTED_LABEL_MISMATCH: "work-tab-painted-label-mismatch",
  WORK_TAB_LABEL_CLIPPED: "work-tab-label-clipped",
  WORK_TAB_FIT_MISMATCH: "work-tab-fit-mismatch",
  WORK_TABS_MISSING: "work-tabs-missing",
  WORK_TAB_DESTINATIONS_INCOMPLETE: "work-tab-destinations-incomplete",
  WORK_TAB_BELOW_TARGET_FLOOR: "work-tab-below-target-floor",
  CHAPTER_TEXT_CLIPPED: "chapter-text-clipped",
  CHAPTER_ROWS_MISSING: "chapter-rows-missing",
  CHAPTER_IDENTITIES_INCOMPLETE: "chapter-identities-incomplete",
  CHAPTER_NAMES_INCOMPLETE: "chapter-names-incomplete",
  CHAPTER_COUNTS_INCOMPLETE: "chapter-counts-incomplete",
  DOCUMENT_HORIZONTAL_OVERFLOW: "document-horizontal-overflow",
  CONTROL_OUTSIDE_VIEWPORT: "control-outside-viewport",
  CONTROL_BELOW_TARGET_FLOOR: "control-below-target-floor",
  CONTROL_NOT_FOCUSABLE: "control-not-focusable",
  SHORT_HEIGHT_CONTROLS_MISSING: "short-height-controls-missing",
  RAIL_DESTINATION_MISSING: "rail-destination-missing",
  RAIL_DESTINATIONS_BELOW_EXPECTED: "rail-destinations-below-expected",
  APPOINTMENTS_DESTINATION_MISSING: "appointments-destination-missing",
  WELCOME_NOT_FIRST: "welcome-not-first",
  HAT_MENU_BEFORE_DISMISSAL: "hat-menu-before-dismissal",
  HAT_MENU_NOT_VISIBLE: "hat-menu-not-visible",
  HAT_OPTIONS_INCOMPLETE: "hat-options-incomplete",
  HAT_OPTIONS_WRONG_IDENTITY: "hat-options-wrong-identity",
  WELCOME_FOCUS_NOT_HANDED_OFF: "welcome-focus-not-handed-off",
  SWITCH_HAT_TRIGGER_NOT_VISIBLE: "switch-hat-trigger-not-visible",
  COORDINATOR_SELECTION_REJECTED: "coordinator-selection-rejected",
  HAT_INTRO_REPLAYED: "hat-intro-replayed",
  ESCAPE_FOCUS_UNRESOLVED: "escape-focus-unresolved",
  REPEAT_VISIT_FOCUS_STOLEN: "repeat-visit-focus-stolen",
  PHONE_RECEIVED_DEMO_FOCUS: "phone-received-demo-focus",
  SAAS_RECEIVED_DEMO_FOCUS: "saas-received-demo-focus",
});

function finding(rule, context, detail, extra = {}) {
  return {
    rule,
    viewport: context?.viewport
      ? {
        name: context.viewport.name ?? null,
        width: Number(context.viewport.width ?? 0),
        height: Number(context.viewport.height ?? 0),
      }
      : null,
    hat: context?.hat ?? null,
    route: context?.route ?? null,
    language: context?.language ?? null,
    railState: context?.railState ?? null,
    detail,
    ...extra,
  };
}

function clipped(entry) {
  return Number(entry?.scrollWidth ?? 0) > Number(entry?.clientWidth ?? 0) + EPSILON
    || Number(entry?.scrollHeight ?? 0) > Number(entry?.clientHeight ?? 0) + EPSILON;
}

function describeEntry(entry) {
  return JSON.stringify({
    label: entry?.label ?? null,
    selector: entry?.selector ?? null,
    clientWidth: entry?.clientWidth ?? null,
    scrollWidth: entry?.scrollWidth ?? null,
    clientHeight: entry?.clientHeight ?? null,
    scrollHeight: entry?.scrollHeight ?? null,
  });
}

/**
 * Classifies one rendered SAMPLE desktop surface. `measurement` is exactly the
 * object `collectDemoChromeGeometry` returns inside the page.
 */
export function classifyDemoChromeGeometry(measurement, context = {}) {
  const findings = [];
  const railLabels = Array.isArray(measurement?.railLabels) ? measurement.railLabels : [];
  const chapterTexts = Array.isArray(measurement?.chapterTexts) ? measurement.chapterTexts : [];
  const chapterNames = Array.isArray(measurement?.chapterNames) ? measurement.chapterNames : [];
  const chapterMetas = Array.isArray(measurement?.chapterMetas) ? measurement.chapterMetas : [];
  const expectedChapterCount = Number.isSafeInteger(measurement?.expectedChapterCount)
    ? measurement.expectedChapterCount
    : DEMO_CHROME_EXPECTED_CHAPTER_COUNT;
  const workTabs = measurement?.workTabs ?? null;

  if (railLabels.length === 0) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.RAIL_LABELS_MISSING,
      context,
      "no rendered desktop rail label was measured",
    ));
  }
  if (context.railState === "expanded" && railLabels.length < (context.expectedMinLabels ?? 0)) {
    findings.push(finding(DEMO_CHROME_COVENANT_RULES.RAIL_LABELS_MISSING, context,
      `expected at least ${context.expectedMinLabels} rail labels; measured ${railLabels.length}`));
  }
  for (const entry of railLabels) {
    if (clipped(entry)) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_CLIPPED,
        context,
        `rail label overflows its allocation: ${describeEntry(entry)}`,
        { label: entry.label ?? null, selector: entry.selector ?? null },
      ));
    }
    const splitWords = Array.isArray(entry?.splitWords) ? entry.splitWords : [];
    if (splitWords.length > 0) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_INTRA_WORD_BREAK,
        context,
        `rail label breaks inside ${JSON.stringify(splitWords.join(" "))}: ${describeEntry(entry)}`,
        { label: entry.label ?? null, selector: entry.selector ?? null, splitWords },
      ));
    }
  }

  // The Work desk always paints its toolbar, so on that surface an absent
  // toolbar is a finding rather than a silently skipped assertion: a renamed
  // container or a changed tablist role must fail the covenant, not vacate it.
  if (measurement?.expectWorkTabs === true && !workTabs) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.WORK_TABS_MISSING,
      context,
      "the desktop Work toolbar was not found on the Work desk surface",
    ));
  }

  if (workTabs) {
    const measurements = Array.isArray(workTabs.measurements) ? workTabs.measurements : [];
    const visibleLabels = Array.isArray(workTabs.visibleLabels) ? workTabs.visibleLabels : [];
    if (context.route === "/m/tasks") {
      const observed = measurements.map((entry) => entry.href);
      const expected = DEMO_CHROME_WORK_REQUIRED_DESTINATIONS;
      if (observed.length !== expected.length || expected.some((href) => observed.filter((value) => value === href).length !== 1)) {
        findings.push(finding(DEMO_CHROME_COVENANT_RULES.WORK_TAB_DESTINATIONS_INCOMPLETE,
          context, `expected every focused Work destination exactly once; observed ${JSON.stringify(observed)}`));
      }
      for (const entry of measurements) {
        if (!(entry.allocatedWidth >= MIN_TARGET_PX && entry.height >= MIN_TARGET_PX)) {
          findings.push(finding(DEMO_CHROME_COVENANT_RULES.WORK_TAB_BELOW_TARGET_FLOOR,
            context, `Work control ${JSON.stringify(entry.href)} is below the ${MIN_TARGET_PX}px target floor`,
            { href: entry.href, width: entry.allocatedWidth, height: entry.height }));
        }
      }
    }
    if (measurements.length === 0) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.WORK_TABS_MISSING,
        context,
        "the desktop Work toolbar rendered no measurable tab",
      ));
    }
    // The merged repair paints labels only when every current-locale label
    // actually fits its measured allocation. Rendering and fit must agree in
    // both directions: a painted label that does not fit is the original
    // defect, and a hidden label that would fit is a silent regression of the
    // measured threshold.
    if (measurements.length > 0 && workTabs.rendered !== workTabs.fits) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.WORK_TAB_FIT_MISMATCH,
        context,
        `Work tab labels rendered=${String(workTabs.rendered)} but measured fit=${String(workTabs.fits)}: ${JSON.stringify(measurements)}`,
      ));
    }
    const paintedNames = visibleLabels.map((entry) => entry.label).sort();
    const expectedNames = workTabs.rendered === true
      ? measurements.map((entry) => entry.label).sort() : [];
    if (JSON.stringify(paintedNames) !== JSON.stringify(expectedNames)) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.WORK_TAB_PAINTED_LABEL_MISMATCH,
        context,
        `painted Work labels ${JSON.stringify(paintedNames)} do not match enabled tabs ${JSON.stringify(expectedNames)}`,
      ));
    }
    for (const entry of visibleLabels) {
      if (clipped(entry)) {
        findings.push(finding(
          DEMO_CHROME_COVENANT_RULES.WORK_TAB_LABEL_CLIPPED,
          context,
          `painted Work tab label is clipped: ${describeEntry(entry)}`,
          { label: entry.label ?? null },
        ));
      }
      const splitWords = Array.isArray(entry?.splitWords) ? entry.splitWords : [];
      if (splitWords.length > 0) {
        findings.push(finding(
          DEMO_CHROME_COVENANT_RULES.RAIL_LABEL_INTRA_WORD_BREAK,
          context,
          `painted Work tab label breaks inside ${JSON.stringify(splitWords.join(" "))}: ${describeEntry(entry)}`,
          { label: entry.label ?? null, splitWords },
        ));
      }
    }
  }

  if (measurement?.expectChapterRail === true) {
    if (chapterTexts.length === 0) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.CHAPTER_ROWS_MISSING,
        context,
        "the chapter rail rendered no measurable name or count line",
      ));
    }
    // The record promises "All 20 chapter names and count lines" — measure both
    // families and require the full seeded set. A truncated rail that renders a
    // handful of legible chapters must not pass the clip check by omission.
    if (chapterNames.length !== expectedChapterCount) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.CHAPTER_NAMES_INCOMPLETE,
        context,
        `the chapter rail rendered ${chapterNames.length} chapter names, not the seeded ${expectedChapterCount}`,
        { chapterNameCount: chapterNames.length, expected: expectedChapterCount },
      ));
    }
    const identityEvidence = chapterIdentityEvidence(chapterNames);
    if (chapterNames.length === expectedChapterCount
        && (identityEvidence.missing.length > 0 || identityEvidence.unexpected.length > 0)) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.CHAPTER_IDENTITIES_INCOMPLETE,
        context,
        `the chapter rail must contain each seeded identity exactly once; missing=${JSON.stringify(identityEvidence.missing)}; unexpected=${JSON.stringify(identityEvidence.unexpected)}; duplicates=${JSON.stringify(identityEvidence.duplicates)}`,
        identityEvidence,
      ));
    }
    if (chapterMetas.length !== expectedChapterCount) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.CHAPTER_COUNTS_INCOMPLETE,
        context,
        `the chapter rail rendered ${chapterMetas.length} count lines, not the seeded ${expectedChapterCount}`,
        { chapterMetaCount: chapterMetas.length, expected: expectedChapterCount },
      ));
    }
    for (const entry of chapterTexts) {
      if (clipped(entry)) {
        findings.push(finding(
          DEMO_CHROME_COVENANT_RULES.CHAPTER_TEXT_CLIPPED,
          context,
          `chapter rail text is clipped: ${describeEntry(entry)}`,
          { label: entry.label ?? null, selector: entry.selector ?? null },
        ));
      }
    }
  }

  const documentGeometry = measurement?.document ?? null;
  if (documentGeometry
      && Number(documentGeometry.scrollWidth ?? 0) > Number(documentGeometry.clientWidth ?? 0) + EPSILON) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.DOCUMENT_HORIZONTAL_OVERFLOW,
      context,
      `document scrollWidth ${documentGeometry.scrollWidth} exceeds clientWidth ${documentGeometry.clientWidth}`,
    ));
  }

  return findings;
}

/**
 * Classifies the focused, scrolled-into-view desktop rail controls measured in
 * the 450px short-height viewport.
 */
export function classifyShortHeightControls(controls, context = {}) {
  const findings = [];
  const height = Number(context?.viewport?.height ?? 0);
  const entries = Array.isArray(controls) ? controls : [];
  const expectedMin = Number.isSafeInteger(context?.expectedMinControls)
    ? context.expectedMinControls
    : DEMO_CHROME_MIN_SHORT_HEIGHT_CONTROLS;
  // An empty (or short) collection is the vacuity this covenant closes: the
  // short-height regression cannot be observed if no control was measured, so
  // fewer than the seeded rail control count fails closed rather than passing
  // by returning no findings.
  if (entries.length < expectedMin) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.SHORT_HEIGHT_CONTROLS_MISSING,
      context,
      `the ${height}px short-height rail exposed ${entries.length} focusable controls, below the ${expectedMin} expected`,
      { controlCount: entries.length, expected: expectedMin },
    ));
  }
  for (const control of entries) {
    if (control?.focused !== true) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.CONTROL_NOT_FOCUSABLE,
        context,
        `rail control did not accept focus: ${JSON.stringify(control?.label ?? null)}`,
        { label: control?.label ?? null },
      ));
    }
    // Exact, not tolerant: the follow-up review's regression was a control
    // sitting at bottom 450.21875 in a 450px viewport, and the merged e2e
    // regression pins the same exact bounds.
    if (Number(control?.height ?? 0) < MIN_TARGET_PX) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.CONTROL_BELOW_TARGET_FLOOR,
        context,
        `rail control height ${control?.height} is below the ${MIN_TARGET_PX}px target floor: ${JSON.stringify(control?.label ?? null)}`,
        { label: control?.label ?? null },
      ));
    }
    if (Number(control?.top ?? 0) < 0 || Number(control?.bottom ?? 0) > height) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.CONTROL_OUTSIDE_VIEWPORT,
        context,
        `focused rail control spans ${control?.top}..${control?.bottom} outside the ${height}px viewport: ${JSON.stringify(control?.label ?? null)}`,
        { label: control?.label ?? null },
      ));
    }
  }
  return findings;
}

/**
 * Classifies the first-visit welcome/hat-intro sequence observation.
 */
export function classifyWelcomeSequence(observation, context = {}) {
  const findings = [];
  const initial = observation?.initial ?? {};
  const afterDismissal = observation?.afterDismissal ?? {};
  const afterCoordinator = observation?.afterCoordinator ?? {};
  const afterReload = observation?.afterReload ?? {};

  if (initial.welcomeVisible !== true) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.WELCOME_NOT_FIRST,
      context,
      "the first SAMPLE desktop visit did not present the welcome dialog",
    ));
  }
  if (Number(initial.hatMenuCount ?? 0) !== 0 || Number(initial.hatIntroCount ?? 0) !== 0) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.HAT_MENU_BEFORE_DISMISSAL,
      context,
      `the hat menu was mounted under the welcome scrim: ${JSON.stringify(initial)}`,
    ));
  }

  if (afterDismissal.welcomeCount !== 0) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.WELCOME_NOT_FIRST,
      context,
      "the welcome layer survived its own dismissal",
    ));
  }
  if (afterDismissal.menuVisible !== true || afterDismissal.introVisible !== true) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.HAT_MENU_NOT_VISIBLE,
      context,
      `dismissing the welcome did not open the visible hat intro: ${JSON.stringify({
        menuVisible: afterDismissal.menuVisible ?? null,
        introVisible: afterDismissal.introVisible ?? null,
      })}`,
    ));
  }
  const optionLabels = Array.isArray(afterDismissal.optionLabels) ? afterDismissal.optionLabels : [];
  const expectedHats = Array.isArray(context?.expectedHatLabels) && context.expectedHatLabels.length > 0
    ? context.expectedHatLabels
    : DEMO_CHROME_EXPECTED_HAT_LABELS;
  if (optionLabels.length !== expectedHats.length) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.HAT_OPTIONS_INCOMPLETE,
      context,
      `the intro offered ${optionLabels.length} hats, not the ${expectedHats.length} of Member plus five staff hats: ${JSON.stringify(optionLabels)}`,
      { optionLabels, expected: [...expectedHats] },
    ));
  } else {
    // Cardinality is not identity. Six duplicate "Member" hats, or five staff
    // hats with a wrong sixth, both satisfy a length check while failing the
    // record. Require the exact ordered identity set the intro must present.
    const identityMatches = expectedHats.every((label, index) => optionLabels[index] === label);
    if (!identityMatches) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.HAT_OPTIONS_WRONG_IDENTITY,
        context,
        `the intro hats ${JSON.stringify(optionLabels)} are not the expected identity set ${JSON.stringify([...expectedHats])}`,
        { optionLabels, expected: [...expectedHats] },
      ));
    }
  }
  if (afterDismissal.activeElementIsTrigger !== true) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.WELCOME_FOCUS_NOT_HANDED_OFF,
      context,
      `welcome dismissal left focus on ${JSON.stringify(afterDismissal.activeElement ?? null)} instead of the Switch-hat trigger`,
    ));
  }
  if (afterDismissal.triggerVisible !== true
      || Number(afterDismissal.triggerOpacity ?? 0) < OPAQUE_ENOUGH) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.SWITCH_HAT_TRIGGER_NOT_VISIBLE,
      context,
      `the focused Switch-hat trigger is not visibly painted: ${JSON.stringify({
        triggerVisible: afterDismissal.triggerVisible ?? null,
        triggerOpacity: afterDismissal.triggerOpacity ?? null,
      })}`,
    ));
  }

  if (afterCoordinator.path !== "/m/coordinator" || afterCoordinator.selected !== true) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.COORDINATOR_SELECTION_REJECTED,
      context,
      `an explicit Coordinator selection did not change hats: ${JSON.stringify(afterCoordinator)}`,
    ));
  }

  if (Number(afterReload.hatMenuCount ?? 0) !== 0 || Number(afterReload.hatIntroCount ?? 0) !== 0) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.HAT_INTRO_REPLAYED,
      context,
      `a reload replayed the once-only hat intro: ${JSON.stringify(afterReload)}`,
    ));
  }
  if (Number(afterReload.triggerCount ?? 0) !== 1) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.SWITCH_HAT_TRIGGER_NOT_VISIBLE,
      context,
      `the reloaded surface carries ${afterReload.triggerCount} Switch-hat triggers, not exactly one`,
    ));
  }
  // A repeat visit (reload) must NOT re-hand focus to the hat trigger: the
  // intro is once-only, so the reloaded surface leaves focus where the visitor
  // put it. Stolen focus on every reload is the "repeat visits do not receive
  // unexpected focus" clause of the accessibility acceptance.
  if (afterReload.activeElementIsTrigger === true) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.REPEAT_VISIT_FOCUS_STOLEN,
      context,
      "a repeat visit re-focused the Switch-hat trigger, stealing focus from the returning visitor",
    ));
  }

  // Escape must have a predictable focus destination: closing the intro returns
  // focus to the Switch-hat trigger (the record's "immediate interaction
  // anchor"), never stranding it on document.body. Skipped only when the driver
  // did not measure the Escape leg (afterEscape omitted).
  const afterEscape = observation?.afterEscape ?? null;
  if (afterEscape) {
    if (afterEscape.introVisible === true || Number(afterEscape.hatIntroCount ?? 0) !== 0) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.ESCAPE_FOCUS_UNRESOLVED,
        context,
        `Escape did not close the hat intro: ${JSON.stringify(afterEscape)}`,
      ));
    }
    if (afterEscape.activeElementIsTrigger !== true) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.ESCAPE_FOCUS_UNRESOLVED,
        context,
        `Escape left focus on ${JSON.stringify(afterEscape.activeElement ?? null)} instead of the Switch-hat trigger`,
      ));
    }
  }

  // A re-toggle of the switcher after the intro was already seen must reopen the
  // menu WITHOUT replaying the once-only explanatory intro.
  const afterRetoggle = observation?.afterRetoggle ?? null;
  if (afterRetoggle) {
    if (afterRetoggle.introVisible === true) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.HAT_INTRO_REPLAYED,
        context,
        `re-toggling the switcher replayed the once-only intro: ${JSON.stringify(afterRetoggle)}`,
      ));
    }
    if (afterRetoggle.menuVisible !== true) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.HAT_MENU_NOT_VISIBLE,
        context,
        `re-toggling the switcher did not reopen the menu: ${JSON.stringify(afterRetoggle)}`,
      ));
    }
  }

  // Phone and SaaS surfaces must NOT receive the demo-only welcome/hat focus
  // handoff. The desktop hat switcher is a SAMPLE-demo-desktop feature; on the
  // responsive phone surface it must be absent and must not steal focus, and on
  // the SaaS surface it must never mount at all.
  const phone = observation?.phone ?? null;
  if (phone) {
    if (phone.hatSelectorPresent === true
        || phone.activeElementIsTrigger === true
        || phone.welcomeFocusHandoff === true) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.PHONE_RECEIVED_DEMO_FOCUS,
        context,
        `the phone surface received the demo-only hat focus handoff: ${JSON.stringify(phone)}`,
      ));
    }
  }
  const saas = observation?.saas ?? null;
  if (saas) {
    if (saas.hatSelectorPresent === true
        || saas.welcomeLayerPresent === true
        || saas.activeElementIsTrigger === true) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.SAAS_RECEIVED_DEMO_FOCUS,
        context,
        `the SaaS surface mounted the demo-only welcome/hat layer: ${JSON.stringify(saas)}`,
      ));
    }
  }

  return findings;
}

/**
 * Classifies the Steward-desk rail destination set, where the "Appointments"
 * destination lives. The record requires Appointments to be present and every
 * desktop destination readable, so a rail that renders a single label, or one
 * missing Appointments, fails closed. Destinations are matched by stable,
 * language-independent href.
 */
export function classifyRailDestinations(measurement, context = {}) {
  const findings = [];
  const hrefs = Array.isArray(measurement?.destinationHrefs) ? measurement.destinationHrefs : [];
  const required = Array.isArray(context?.requiredDestinations) && context.requiredDestinations.length > 0
    ? context.requiredDestinations
    : DEMO_CHROME_STEWARD_REQUIRED_DESTINATIONS;
  const expectedMin = Number.isSafeInteger(context?.expectedMinDestinations)
    ? context.expectedMinDestinations
    : DEMO_CHROME_STEWARD_MIN_DESTINATIONS;
  const appointmentsHref = context?.appointmentsHref ?? DEMO_CHROME_APPOINTMENTS_HREF;
  const present = new Set(hrefs);

  if (!present.has(appointmentsHref)) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.APPOINTMENTS_DESTINATION_MISSING,
      context,
      `the Appointments destination ${JSON.stringify(appointmentsHref)} was not present in the rail: ${JSON.stringify(hrefs)}`,
      { appointmentsHref },
    ));
  }
  for (const href of required) {
    if (!present.has(href)) {
      findings.push(finding(
        DEMO_CHROME_COVENANT_RULES.RAIL_DESTINATION_MISSING,
        context,
        `required rail destination ${JSON.stringify(href)} was not rendered`,
        { href },
      ));
    }
  }
  if (hrefs.length < expectedMin) {
    findings.push(finding(
      DEMO_CHROME_COVENANT_RULES.RAIL_DESTINATIONS_BELOW_EXPECTED,
      context,
      `the rail rendered ${hrefs.length} destinations, below the ${expectedMin} expected`,
      { destinationCount: hrefs.length, expected: expectedMin },
    ));
  }
  return findings;
}

export function summarizeCovenantFindings(findings = []) {
  const byRule = new Map();
  for (const entry of findings) {
    byRule.set(entry.rule, (byRule.get(entry.rule) ?? 0) + 1);
  }
  return [...byRule.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rule, count]) => ({ rule, count }));
}

export function renderCovenantMarkdown(report) {
  const lines = [
    "# SAMPLE demo-chrome covenant proof",
    "",
    `Status: ${report?.status ?? "unknown"}`,
    `Base URL: ${report?.baseUrl ?? "unknown"}`,
    `Expected SHA: ${report?.expectedSha ?? "none"}`,
    "",
  ];
  if (report?.executionFailure) {
    lines.push("```text", ...renderCovenantFailureLines(report), "```", "");
  }
  for (const surface of report?.surfaces ?? []) {
    lines.push(
      `## ${surface.viewport?.name}: ${surface.route} · ${surface.hat ?? "n/a"} · ${surface.language ?? "n/a"} · ${surface.railState ?? "n/a"}`,
      "",
      `Rail labels measured: ${surface.railLabelCount ?? 0}`,
      `Work tabs measured: ${surface.workTabCount ?? 0}`,
      `Chapter rows measured: ${surface.chapterRowCount ?? surface.chapterNameCount ?? 0}`,
      `Chapter names measured: ${surface.chapterNameCount ?? 0}`,
      `Chapter count lines measured: ${surface.chapterMetaCount ?? 0}`,
      "",
    );
  }
  const summary = summarizeCovenantFindings(report?.findings ?? []);
  if (summary.length === 0) lines.push("No covenant findings.", "");
  else {
    lines.push("| Rule | Count |", "| --- | --- |");
    for (const { rule, count } of summary) lines.push(`| ${rule} | ${count} |`);
    lines.push("");
    for (const entry of report.findings) {
      if (isUnrunCoverageFinding(report, entry)) continue;
      lines.push(`- \`${entry.rule}\` ${entry.viewport?.name ?? ""} ${entry.language ?? ""} ${entry.railState ?? ""}: ${entry.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Page-side collectors. These run inside the audited document.
// ---------------------------------------------------------------------------

export function collectDemoChromeGeometry(config) {
  const epsilon = 0.5;
  const roundedTop = (rect) => Math.round(rect.top * 2) / 2;

  const isPainted = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(node);
    return style.visibility !== "hidden"
      && style.display !== "none"
      && Number.parseFloat(style.opacity || "1") > 0.01;
  };

  const splitWords = (node) => {
    const broken = [];
    if (!node) return broken;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const value = text.nodeValue || "";
      for (const match of value.matchAll(/\S+/g)) {
        if (match[0].length < 2) continue;
        const range = document.createRange();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        const tops = new Set(
          [...range.getClientRects()]
            .filter((rect) => rect.width > epsilon && rect.height > epsilon)
            .map(roundedTop),
        );
        range.detach?.();
        if (tops.size > 1) broken.push(match[0]);
      }
    }
    return broken;
  };

  const measureText = (node, selector) => ({
    selector,
    label: (node.textContent || "").trim().slice(0, 120),
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    splitWords: splitWords(node),
  });

  const railLabels = [];
  for (const selector of config.railLabelSelectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (!isPainted(node)) continue;
      railLabels.push(measureText(node, selector));
    }
  }

  const chapterTexts = [];
  const chapterNames = [];
  const chapterMetas = [];
  const chapterRows = [];
  const chapterNameSelector = config.chapterNameSelector || ".chapter-rail__name";
  const chapterMetaSelector = config.chapterMetaSelector || ".chapter-rail__meta";
  const chapterRowSelector = config.chapterRowSelector || ".chapter-rail__row";
  for (const selector of config.chapterTextSelectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (!isPainted(node)) continue;
      const measured = measureText(node, selector);
      chapterTexts.push(measured);
      if (selector === chapterNameSelector) chapterNames.push(measured);
      else if (selector === chapterMetaSelector) chapterMetas.push(measured);
    }
  }
  for (const row of document.querySelectorAll(chapterRowSelector)) {
    if (!isPainted(row)) continue;
    chapterRows.push({
      name: (row.querySelector(chapterNameSelector)?.textContent || "").trim(),
      meta: (row.querySelector(chapterMetaSelector)?.textContent || "").trim(),
    });
  }

  let workTabs = null;
  const toolbar = document.querySelector(config.workTabGroupSelector);
  if (toolbar) {
    const buttons = [...toolbar.querySelectorAll(":scope > :is(button,a).kan-pill")];
    const measurements = buttons.map((button) => {
      const style = getComputedStyle(button);
      const icon = button.querySelector("svg");
      const measureLabel = button.querySelector(".kan-pill__measure");
      const labelWidth = Math.max(
        measureLabel?.scrollWidth || 0,
        measureLabel?.getBoundingClientRect().width || 0,
      );
      const iconWidth = icon?.getBoundingClientRect().width
        || Number.parseFloat(icon?.getAttribute("width") || "0")
        || 0;
      const chromeWidth = (Number.parseFloat(style.paddingLeft) || 0)
        + (Number.parseFloat(style.paddingRight) || 0)
        + (Number.parseFloat(style.columnGap) || Number.parseFloat(style.gap) || 0)
        + iconWidth;
      let href = null;
      try {
        const target = new URL(button.getAttribute("href"), globalThis.location.href);
        if (button.hasAttribute("href") && target.origin === globalThis.location.origin) href = `${target.pathname}${target.hash}`;
      } catch { /* Missing or invalid links fail the exact destination check. */ }
      return {
        label: button.getAttribute("aria-label"),
        href,
        allocatedWidth: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
        labelWidth,
        requiredWidth: labelWidth + chromeWidth,
      };
    });
    const visibleLabels = [];
    for (const button of buttons) {
      for (const span of button.querySelectorAll(":scope > .kan-pill__label")) {
        if (span.classList.contains("kan-pill__measure") || !isPainted(span)) continue;
        visibleLabels.push(measureText(span, ".kan-pill span"));
      }
    }
    workTabs = {
      rendered: toolbar.getAttribute("data-labels-visible") === "true",
      fits: measurements.length > 0 && measurements.every(({ allocatedWidth, labelWidth, requiredWidth }) => (
        labelWidth > 0 && requiredWidth <= allocatedWidth
      )),
      measurements,
      visibleLabels,
    };
  }

  return {
    document: {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    },
    expectChapterRail: config.expectChapterRail === true,
    expectWorkTabs: config.expectWorkTabs === true,
    expectedChapterCount: Number.isSafeInteger(config.expectedChapterCount)
      ? config.expectedChapterCount
      : null,
    railLabels,
    chapterTexts,
    chapterNames,
    chapterMetas,
    chapterRows,
    workTabs,
  };
}

// Page-side collector for the Steward-desk rail destinations. Runs inside the
// audited document and returns the stable hrefs plus the measured Appointments
// label geometry so its intra-word break can be asserted by identity.
export function collectRailDestinations(config = {}) {
  const railSelector = config.railSelector || "nav.desktop-rail";
  const rail = document.querySelector(railSelector);
  const links = rail ? [...rail.querySelectorAll("a[href]")] : [];
  const normalize = (href) => {
    if (!href) return null;
    try {
      const url = new URL(href, globalThis.location?.href || "http://127.0.0.1/");
      if (url.origin !== globalThis.location.origin) return null;
      return `${url.pathname}${url.hash || ""}`;
    } catch {
      return href;
    }
  };
  const appointmentsHref = config.appointmentsHref || "/m/steward/appointments";
  const appointmentsLink = links.find((node) => normalize(node.getAttribute("href")) === appointmentsHref) || null;
  const appointmentsLabelNode = appointmentsLink?.querySelector(".desktop-rail__label") || appointmentsLink;
  const roundedTop = (rect) => Math.round(rect.top * 2) / 2;
  const brokenWords = (node) => {
    const broken = [];
    if (!node || typeof document.createTreeWalker !== "function") return broken;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const value = text.nodeValue || "";
      for (const match of value.matchAll(/\S+/g)) {
        if (match[0].length < 2) continue;
        const range = document.createRange();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        const tops = new Set(
          [...range.getClientRects()]
            .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
            .map(roundedTop),
        );
        range.detach?.();
        if (tops.size > 1) broken.push(match[0]);
      }
    }
    return broken;
  };
  return {
    railPresent: Boolean(rail),
    destinationHrefs: links.map((node) => normalize(node.getAttribute("href"))).filter(Boolean),
    appointmentsPresent: Boolean(appointmentsLink),
    appointmentsLabel: appointmentsLabelNode ? (appointmentsLabelNode.textContent || "").trim() : null,
    appointmentsSplitWords: brokenWords(appointmentsLabelNode),
  };
}

export function collectWelcomeSurface() {
  const painted = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const trigger = document.querySelector("button.demo-hat-selector__trigger");
  const menu = document.querySelector(".demo-hat-selector__menu");
  const intro = document.querySelector(".demo-hat-selector__intro");
  const active = document.activeElement;
  return {
    welcomeVisible: painted(document.querySelector(".demo-welcome-layer")),
    welcomeCount: document.querySelectorAll(".demo-welcome-layer").length,
    hatMenuCount: document.querySelectorAll(".demo-hat-selector__menu").length,
    hatIntroCount: document.querySelectorAll(".demo-hat-selector__intro").length,
    menuVisible: painted(menu),
    introVisible: painted(intro),
    optionLabels: [...document.querySelectorAll(".demo-hat-selector__option")]
      .map((option) => (option.textContent || "").trim()),
    triggerCount: document.querySelectorAll("button.demo-hat-selector__trigger").length,
    triggerVisible: painted(trigger),
    triggerOpacity: trigger ? Number.parseFloat(getComputedStyle(trigger).opacity || "1") : 0,
    triggerLabel: trigger ? (trigger.textContent || "").trim() : null,
    activeElementIsTrigger: Boolean(trigger && active === trigger),
    activeElement: active
      ? `${active.tagName.toLowerCase()}${active.className ? `.${String(active.className).split(/\s+/).join(".")}` : ""}`
      : null,
    path: globalThis.location?.pathname ?? null,
  };
}

// Hosted SAMPLE stays SAMPLE without a query string. Only the isolated
// loopback harness can exercise both surfaces on one origin. Union Ground
// has no provisioned production origin, so a hosted run must name one
// explicitly; the SAMPLE portal pinned in config/sample-backend.json is never
// accepted as the non-demo surface.
export function nonDemoCovenantUrl(baseUrl, saasBaseUrl) {
  const sample = new URL(baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(sample.hostname);
  if (!saasBaseUrl && !loopback) {
    throw new Error("No non-demo origin is configured; set DEMO_COVENANT_SAAS_BASE_URL (the hosted SAMPLE origin cannot stand in)");
  }
  const target = new URL("/m", saasBaseUrl || sample.origin);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new Error("SaaS covenant target must be an HTTP(S) origin without credentials");
  }
  if (target.origin === new URL(SAMPLE_BACKEND.samplePortalOrigin).origin
      || (!loopback && target.origin === sample.origin)) {
    throw new Error("SaaS isolation cannot be measured on the hosted SAMPLE origin");
  }
  return target.href;
}
