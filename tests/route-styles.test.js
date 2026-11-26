import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import postcss from "postcss";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import {
  QUERY_ONLY_SOURCES,
  ROUTE_STYLE_PREFIXES,
  readRouteStyles,
  routeSheetsFor,
  routeStylesPlugin,
  specificity,
  splitRouteStyles,
} from "../scripts/lib/route-styles.mjs";

// PERF-UG-FIRST-PAINT-OBSERVABILITY-DEFER-AND-CSS-SPLIT-20261028: the
// document head links one critical sheet built from src/styles.css, and the
// Tasks, Voice, Voting and Workload views import their own route sheets.

function rules(css) {
  const result = [];
  postcss.parse(css).walkRules((rule) => {
    const wrappers = [];
    for (let node = rule.parent; node?.type === "atrule"; node = node.parent) wrappers.unshift(`@${node.name} ${node.params}`);
    result.push(JSON.stringify([wrappers, rule.selector, rule.nodes.map((node) => node.toString())]));
  });
  return result.sort();
}

// Ledger 609: a deferred family is pinned by its exact sorted rule list (each
// rule's at-rule wrappers and selector), not a count, so a rule that returns to
// the head while another one joins the family changes the list and fails.
function ruleSelectors(css) {
  return rules(css).map((rule) => {
    const [wrappers, selector] = JSON.parse(rule);
    return [...wrappers, selector].join(" ");
  }).sort();
}

function declarations(css) {
  const result = [];
  postcss.parse(css).walkDecls((decl) => {
    const wrappers = [];
    for (let node = decl.parent.type === "rule" ? decl.parent.parent : decl.parent; node?.type === "atrule"; node = node.parent) wrappers.unshift(`@${node.name} ${node.params}`);
    result.push(JSON.stringify([wrappers, decl.parent.selector ?? null, decl.prop, decl.value, Boolean(decl.important)]));
  });
  return result.sort();
}

const staticClosureCache = new Map();
function staticModules(start = "src/main.jsx") {
  const key = resolve(start);
  if (staticClosureCache.has(key)) return staticClosureCache.get(key);
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    if (path.endsWith(".d.ts")) return;
    const ast = parse(readFileSync(path, "utf8"), {
      sourceType: "unambiguous",
      plugins: ["jsx", ...(/\.tsx?$/.test(path) ? ["typescript"] : [])],
    });
    for (const node of ast.program.body) {
      if (!["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
        || !node.source?.value.startsWith(".")) continue;
      const target = join(dirname(path), node.source.value);
      const file = [target, ...[".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.jsx", "/index.ts", "/index.tsx"].map((suffix) => target + suffix)].find((candidate) => {
        try { return /\.(?:jsx?|tsx?)$/.test(candidate) && readFileSync(candidate) && true; } catch { return false; }
      });
      if (file) visit(file);
    }
  };
  visit(key);
  staticClosureCache.set(key, seen);
  return seen;
}

const sheets = readRouteStyles(process.cwd());

// #7728 slice 5: these small cuts each belong to exactly one lazy view.
// Keep the existing families' rule-count floor; pin the smaller cuts below.
const SINGLE_VIEW_SPLITS = {
  gapp: ["GetAppView", [
    ".gapp-card",
    ".gapp-card > :not(.gapp-list):not(.gapp-qr)",
    ".gapp-item",
    ".gapp-list",
    ".gapp-qr",
    ".gapp-qr",
  ]],
  orgstructure: ["OrgStructureView", [
    ".orgstructure-marker",
    ".orgstructure-markers",
    ".orgstructure-tree",
    ".orgstructure-tree__node",
    ".orgstructure-tree__node, .orgstructure-marker, .orgstructure-tree .orgstructure-tree",
    ".orgstructure-tree__row",
    ".orgstructure-tree__row .orgstructure-tree__node",
    ".orgstructure-tree__spacer",
    ".orgstructure-tree__toggle",
    ".orgstructure__actions",
    ".orgstructure__controls",
    ".orgstructure__count",
    ".orgstructure__detail-close",
    ".orgstructure__head",
    ".orgstructure__icon",
    ".orgstructure__legend",
    ".orgstructure__note, .orgstructure__source",
    ".orgstructure__panel",
    ".orgstructure__search",
    ".orgstructure__status, .orgstructure__empty",
  ]],
  mforms: ["FormsView", [
    ".m-card.mforms-shell",
    ".mforms-btn--ghost",
    ".mforms-btn--primary",
    ".mforms-chip",
    ".mforms-draft",
    ".mforms-grid",
    ".mforms-grid",
    ".mforms-svc",
    ".mforms-tile",
  ]],

};

// Every source module naming each added shared namespace, including comments
// and DOM queries: these all receive the sheet and must stay outside first paint.
const SHARED_SPLIT_RENDERERS = {
  mcases: ["src/views/CasesView.jsx"],
  company: ["src/views/AboutView.jsx", "src/views/OperatorView.jsx"],
  "cdash": [
    "src/components/CaseDashboards.jsx",
    "src/views/CoordinatorView.jsx"
  ],
  "mappt": [
    "src/components/StewardAppointmentsPanel.jsx",
    "src/views/AppointmentsView.jsx"
  ],
  "ach": [
    "src/components/StaffRoster.jsx",
    "src/features/analytics/ui/AnalyticsCoreDesk.jsx",
    "src/features/analytics/ui/AnalyticsParityPanels.jsx",
    "src/features/analytics/ui/MemberReportCard.jsx",
    "src/features/analytics/ui/UsageDigestPanel.jsx",
    "src/views/AdvisorView.jsx",
    "src/views/VpView.jsx"
  ],
  "case-list": [
    "src/components/CaseList.jsx",
    "src/views/StewardView.jsx"
  ],
  "cam": [
    "src/features/elections/NominationsManager.jsx",
    "src/features/governance/OfficerRemovalEditor.jsx",
    "src/views/CampaignsView.jsx"
  ],
  "institutional-timeline": [
    "src/features/institutionalRecords/InstitutionalRecordsPanel.jsx"
  ],
  "mevents": [
    "src/components/CheckinQrCode.jsx",
    "src/views/EventsView.jsx"
  ],
  "public-document": [
    "src/components/PublicDocumentShell.jsx",
  ],
  "contact-help": [
    "src/views/ContactView.jsx"
  ],
  "leadership-card": [
    "src/features/governance/ChapterLeadershipRecoveryCard.jsx"
  ],
  "form-signature": [
    "src/components/SignatureChoice.jsx",
    "src/components/SignaturePad.jsx"
  ],
  "xus-intake": [
    "src/features/intakeQueue/FounderInvitationPanel.jsx",
    "src/features/intakeQueue/PeopleWaitingPage.jsx"
  ],
  "recovery-code": [
    "src/components/MfaSettings.jsx"
  ],
  "vrx": [
    "src/views/VerifyReceiptView.jsx"
  ],
  "xus-action": [
    "src/components/EventAuthoringCard.jsx"
  ],
  "cwk-contact": [
    "src/views/StewardView.jsx"
  ],
  "screen-header": [
    "src/components/Primitives.jsx"
  ],
  "pkpi": [
    "src/components/PlaneHeader.jsx",
    "src/views/AdminView.jsx",
    "src/views/CoordinatorView.jsx",
    "src/views/StewardView.jsx",
    "src/views/VpView.jsx"
  ],
  "chapter-appts": [
    "src/components/ChapterAppointmentsPanel.jsx"
  ],
  "form-filing": [
    "src/components/FormFilingControls.jsx",
    "src/components/SignatureChoice.jsx",
    "src/components/SignatureKindNote.jsx",
    "src/components/SignaturePad.jsx",
    "src/views/FormsView.jsx",
    "src/views/StewardView.jsx"
  ],
  "setin-session": [
    "src/views/SettingsView.jsx"
  ],
  "xus-field": [
    "src/components/AdminSecurityConfiguration.jsx",
    "src/components/AdminWorkloadCategories.jsx",
    "src/components/AdminWorkloadConfiguration.jsx",
    "src/components/EventAuthoringCard.jsx",
    "src/features/messaging/CrossChapterPeersSection.jsx",
    "src/views/AdminView.jsx"
  ],
  "cwk-input": [
    "src/views/StewardView.jsx"
  ],
  "chapter-budget": [
    "src/components/ChapterBudgetPanel.jsx"
  ],
  "case-macros": [
    "src/components/CaseMacroEditor.jsx"
  ]
};

// Ledger 604 and 609: the exact case rules that leave the head stylesheet.
const MCASES_DEFERRED_RULES = [
  ".mcases-case__ref",
  ".mcases-case__stepchip",
  ".mcases-case__title",
  ".mcases-case__top",
  ".mcases-case__who",
  ".mcases-closed",
  ".mcases-closed__chip",
  ".mcases-closed__row",
  ".mcases-closed__title",
  ".mcases-closed__when",
  ".mcases-desk__chip",
  ".mcases-desk__full",
  ".mcases-desk__icon",
  ".mcases-desk__icon--now",
  ".mcases-desk__icon--todo",
  ".mcases-desk__latest",
  ".mcases-desk__latesttext",
  ".mcases-desk__meta",
  ".mcases-desk__nlabel",
  ".mcases-desk__node",
  ".mcases-desk__nsub",
  ".mcases-desk__nsub--due",
  ".mcases-desk__strip",
  ".mcases-desk__strip--center-current::before",
  ".mcases-desk__title",
  ".mcases-desk__titletext",
  ".mcases-eyebrow",
  ".mcases-ghost",
  ".mcases-head__row",
  ".mcases-new",
  ".mcases-panel",
  ".mcases-panel__chip",
  ".mcases-panel__list",
  ".mcases-panel__row",
  ".mcases-panel__rowtitle",
  ".mcases-panel__title",
  ".mcases-panel__when",
  ".mcases-ph",
  ".mcases-ph__new",
  ".mcases-ph__sub",
  ".mcases-ph__title",
  ".mcases-primary",
  ".mcases-step",
  ".mcases-step__copy",
  ".mcases-step__num",
  ".mcases-step__sub",
  ".mcases-step__title",
  ".mcases-steps",
  ".mcases-sub",
  ".mcases-title",
  ".mcases-tl",
  ".mcases-tl__copy",
  ".mcases-tl__dot",
  ".mcases-tl__due",
  ".mcases-tl__due--none",
  ".mcases-tl__label",
  ".mcases-tl__line",
  ".mcases-tl__rail",
  ".mcases-tl__row",
  ".mcases-tl__row:last-child .mcases-tl__copy",
  ".mcases-tl__sub",
];

// Ledger 609 (pull request 9356): the exact knowledge workspace rule parts.
const KNOWLEDGE_WORKSPACE_DEFERRED_RULES = [
  ".knowledge-workspace__actions",
  ".knowledge-workspace__body",
  ".knowledge-workspace__card",
  ".knowledge-workspace__collection",
  ".knowledge-workspace__drive-folder",
  ".knowledge-workspace__empty",
  ".knowledge-workspace__error",
  ".knowledge-workspace__fields",
  ".knowledge-workspace__grid",
  ".knowledge-workspace__head",
  ".knowledge-workspace__hint",
  ".knowledge-workspace__icon",
  ".knowledge-workspace__notice",
  ".knowledge-workspace__notice, .knowledge-workspace__error",
  ".knowledge-workspace__revision-content",
  ".knowledge-workspace__revision-picker",
  ".knowledge-workspace__row",
  ".knowledge-workspace__status",
  ".knowledge-workspace__title",
  "@container knowledge-card (max-width: 430px) .knowledge-workspace__revision-picker",
  "@container knowledge-workspace (max-width: 700px) .knowledge-workspace__actions",
  "@container knowledge-workspace (max-width: 700px) .knowledge-workspace__fields, .knowledge-workspace__revision-picker",
  "@container knowledge-workspace (max-width: 700px) .knowledge-workspace__grid"
];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:jsx?|tsx?)$/.test(path) ? [path] : [];
  });
}

describe("the critical and route sheets", () => {
  it("keep every declaration of src/styles.css exactly once, with its selector, priority and at-rule wrappers", () => {
    const source = readFileSync("src/styles.css", "utf8");
    expect(Object.values(sheets).flatMap(declarations).sort()).toEqual(declarations(source));
    expect(Object.keys(sheets)).toEqual(["critical", ...ROUTE_STYLE_PREFIXES]);
  });

  it("take each route's own rules out of the critical sheet", () => {
    for (const prefix of ROUTE_STYLE_PREFIXES) {
      const routeRules = rules(sheets[prefix]);
      expect(routeRules.length, prefix).toBeGreaterThan(SINGLE_VIEW_SPLITS[prefix] || SHARED_SPLIT_RENDERERS[prefix] ? 0 : 5);
      for (const rule of routeRules) expect(JSON.parse(rule)[1], prefix).toMatch(new RegExp(`\\.${prefix}(?:-|__)`));
      expect(new Set(rules(sheets.critical)).isDisjointFrom(new Set(routeRules))).toBe(true);
    }
    // The safety guard decides which rules can move; a byte quota must never
    // require an order-sensitive rule to leave the critical sheet.
    expect(sheets.critical.length).toBeLessThan(readFileSync("src/styles.css", "utf8").length);
    // Tokens, fonts and keyframes are never route-owned.
    for (const prefix of ROUTE_STYLE_PREFIXES) expect(sheets[prefix]).not.toMatch(/@font-face|@keyframes|:root\b/);
  });

  it("are imported by every module that renders a route class, and only lazily loaded modules do", () => {
    const owners = { tasks: "src/views/TasksView.jsx", voice: "src/views/VoiceView.jsx", voting: "src/views/VotingView.jsx", mwl: "src/views/WorkloadView.jsx", kan: "src/views/TasksView.jsx", ftm: "src/components/AdminFormTemplateEditor.jsx", gq: "src/views/CoordinatorView.jsx" };
    for (const [prefix, view] of Object.entries(owners)) expect(routeSheetsFor(readFileSync(view, "utf8")), view).toContain(prefix);
    const eager = [...staticModules()].map((path) => path.slice(process.cwd().length + 1))
      .filter((path) => /\.(?:jsx?|tsx?)$/.test(path) && !QUERY_ONLY_SOURCES.includes(path));
    for (const path of eager) expect(routeSheetsFor(readFileSync(path, "utf8")), path).toEqual([]);
    for (const view of Object.values(owners)) expect(eager).not.toContain(view);
  });

  it("delivers the Kanban family to the board, calendar, modal and shared task rows", () => {
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    for (const view of ["TasksView", "KanbanBoard", "KanbanCalendar", "TaskModal", "../components/TrackerRow"]) {
      const path = resolve("src/views", `${view}.jsx`);
      expect(plugin.transform(readFileSync(path, "utf8"), path).code).toContain('import "virtual:route-styles/kan.css";');
    }
    const css = plugin.load(plugin.resolveId("virtual:route-styles/kan.css"));
    expect(sheets.critical).toContain(".kan-card__circle svg");
    expect(css).toContain(".kan-insert::before");
    expect(css).toContain("@media (max-width: 700px)");
    for (const selector of [".kan-card__top", ".kan-cal__weeks", ".kan-modal__wide", ".kan-col { width: 86vw;"]) {
      expect(sheets.critical).toContain(selector);
      expect(css).not.toContain(selector);
    }
  });

  it("does not load the Kanban sheet for shell handlers that only query an already-rendered task view", () => {
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    for (const path of ["src/App.jsx", "src/components/DesktopRail.jsx", "src/components/ChapterRail.jsx"]) {
      const code = readFileSync(path, "utf8");
      expect(routeSheetsFor(code)).toContain("kan");
      // If these modules ever render a route class, this exemption is no
      // longer valid: every such reference today is in a literal DOM query.
      const withoutQueries = code.replace(/document\.querySelector\((?:"[^"]*"|'[^']*')\)/g, "");
      expect(routeSheetsFor(withoutQueries), path).toEqual([]);
      expect(plugin.transform(code, resolve(path)), path).toBeUndefined();
    }
    const helper = "src/lib/kanban.js";
    const code = readFileSync(helper, "utf8");
    expect(routeSheetsFor(code)).toContain("kan");
    expect(routeSheetsFor(code.replace(/\/\/[^\n]*/g, ""))).toEqual([]);
    expect(plugin.transform(code, resolve(helper))).toBeUndefined();
  });

  it("loads form-template styles with their renderers, outside the cold member shell", () => {
    const cold = staticModules("src/App.jsx");
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    for (const name of ["AdminFormTemplateEditor", "AdminOrganizationHtmlForms", "OrganizationHtmlForms", "OrganizationFormViewer", "FormAutofillOffer"]) {
      const path = resolve("src/components", `${name}.jsx`);
      expect(cold.has(path), name).toBe(false);
      expect(plugin.transform(readFileSync(path, "utf8"), path).code, name).toContain('import "virtual:route-styles/ftm.css";');
    }
    const css = plugin.load(plugin.resolveId("virtual:route-styles/ftm.css"));
    expect(sheets.critical).toContain(".ftm-grid--field");
    expect(css).toContain("@media (max-width: 600px)");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("loads coordinator styles with its queue renderer, outside the cold member shell", () => {
    const path = resolve("src/views/CoordinatorView.jsx");
    expect(staticModules("src/App.jsx").has(path)).toBe(false);
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    expect(plugin.transform(readFileSync(path, "utf8"), path).code).toContain('import "virtual:route-styles/gq.css";');
    const css = plugin.load(plugin.resolveId("virtual:route-styles/gq.css"));
    expect(css).toContain(".gq-c-meta { display: flex;");
    expect(css).toContain("@media (max-width: 900px)");
    expect(sheets.critical).toContain("width: calc(100% - 49px)");
    expect(css).toContain("--gq-scroll-depth: 0");
  });

  it.each(Object.entries(SINGLE_VIEW_SPLITS))("loads %s only with its owning lazy view and preserves the exact selector inventory", (prefix, [view, selectors]) => {
    const path = resolve("src/views", `${view}.jsx`);
    const usesPrefix = new RegExp(`(?:^|[^a-zA-Z0-9_-])${prefix}(?:-|__)`);
    // A new shared renderer needs another ownership decision before this
    // family can remain lazy. Scan all source modules, including export views.
    expect(sourceFiles("src").filter((file) => usesPrefix.test(readFileSync(file, "utf8")))).toEqual([`src/views/${view}.jsx`]);
    expect(staticModules().has(path)).toBe(false);
    expect(staticModules("src/App.jsx").has(path)).toBe(false);
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    expect(plugin.transform(readFileSync(path, "utf8"), path).code).toContain(`import "virtual:route-styles/${prefix}.css";`);
    const css = plugin.load(plugin.resolveId(`virtual:route-styles/${prefix}.css`));
    expect(rules(css).map((rule) => JSON.parse(rule)[1]).sort()).toEqual([...selectors].sort());
  });

  it.each(Object.entries(SHARED_SPLIT_RENDERERS))("loads %s with every lazy renderer and no cold-shell module", (prefix, renderers) => {
    const usesPrefix = new RegExp(`(?:^|[^a-zA-Z0-9_-])${prefix}(?:-|__)`);
    expect(sourceFiles("src").filter((file) => usesPrefix.test(readFileSync(file, "utf8"))).sort())
      .toEqual([...renderers, ...(prefix === "mcases" ? ["src/components/FloatingControls.jsx"] : [])].sort());
    const cold = new Set(["src/main.jsx", "src/App.jsx", "src/components/FloatingControls.jsx", "src/features/compass/CompassSourceList.jsx"].flatMap((entry) => [...staticModules(entry)]));
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    for (const renderer of renderers) {
      const path = resolve(renderer);
      expect(cold.has(path), renderer).toBe(false);
      expect(plugin.transform(readFileSync(path, "utf8"), path)?.code ?? "", renderer).toContain(`import "virtual:route-styles/${prefix}.css";`);
    }
    const deferred = ruleSelectors(plugin.load(plugin.resolveId(`virtual:route-styles/${prefix}.css`)));
    // Ledger 604 and 609: retaining even one case rule in the head, or trading
    // one for another, must be visible.
    if (prefix === "mcases") expect(deferred).toEqual(MCASES_DEFERRED_RULES);
    else if (prefix === "company") expect(deferred).toEqual([
      ".company-page__identity",
      ".company-page__person",
      ".company-page__profiles",
      ".company-page__role",
      "@media (max-width: 540px) .company-page__identity",
    ]);
    else expect(deferred.length).toBeGreaterThan(0);
  });

  it("defers exactly 23 knowledge workspace rule parts with all three lazy renderers", () => {
    const prefix = "knowledge-workspace";
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    const css = plugin.load(plugin.resolveId(`virtual:route-styles/${prefix}.css`));
    expect(ruleSelectors(css)).toEqual(KNOWLEDGE_WORKSPACE_DEFERRED_RULES);
    const renderers = [
      "src/features/knowledge/KnowledgeConversionReviewCard.jsx",
      "src/features/knowledge/KnowledgeWorkspacePanel.jsx",
      "src/features/knowledge/knowledgeWorkspacePrimitives.jsx",
    ];
    const usesPrefix = /(?:^|[^a-zA-Z0-9_-])knowledge-workspace(?:-|__)/;
    expect(sourceFiles("src").filter((file) => usesPrefix.test(readFileSync(file, "utf8"))).sort())
      .toEqual([...renderers, "src/lib/rowHighlight.js"].sort());
    const cold = new Set(["src/main.jsx", "src/App.jsx", "src/components/FloatingControls.jsx", "src/features/compass/CompassSourceList.jsx"]
      .flatMap((entry) => [...staticModules(entry)]));
    for (const renderer of renderers) {
      const path = resolve(renderer);
      expect(cold.has(path), renderer).toBe(false);
      expect(staticModules("src/views/ProductHubView.jsx").has(path), renderer).toBe(true);
      expect(plugin.transform(readFileSync(path, "utf8"), path)?.code, renderer)
        .toContain(`import "virtual:route-styles/${prefix}.css";`);
    }
    expect(plugin.transform(readFileSync("src/lib/rowHighlight.js", "utf8"), resolve("src/lib/rowHighlight.js"))).toBeUndefined();
    expect(css).toContain("@container knowledge-workspace (max-width: 700px)");
    expect(css).toContain("@container knowledge-card (max-width: 430px)");
  });

  it("keeps the case tour query out of the cold shell without exempting rendered case classes", () => {
    const path = "src/components/FloatingControls.jsx", code = readFileSync(path, "utf8");
    const ast = parse(code, { sourceType: "module", plugins: ["jsx"] });
    const tour = ast.program.body.find((node) => node.type === "VariableDeclaration"
      && node.declarations.some((declaration) => declaration.id.name === "tourSteps"));
    expect(tour).toBeTruthy();
    const targets = tour.declarations[0].init.elements.flatMap((step) => step.properties
      .filter((property) => property.key.name === "target" && property.value.type === "StringLiteral")
      .map((property) => property.value));
    const remaining = targets.reduceRight((text, target) => text.slice(0, target.start) + " ".repeat(target.end - target.start) + text.slice(target.end), code);
    expect(routeSheetsFor(code)).toContain("mcases");
    expect(routeSheetsFor(remaining)).not.toContain("mcases");
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    expect(plugin.transform(code, resolve(path))?.code ?? "").not.toContain("virtual:route-styles/mcases.css");
    // A later real renderer, including an open template, must request the
    // stylesheet and therefore fail the cold-closure proof; it cannot inherit
    // a blanket query-only exemption from the tour's source file.
    for (const extra of ['<div className="mcases-case" />', '<div className={`mcases-${kind}`} />']) {
      expect(plugin.transform(code + extra, resolve(path))?.code).toContain("virtual:route-styles/mcases.css");
    }
    const cold = new Set(["src/main.jsx", "src/App.jsx", "src/components/FloatingControls.jsx", "src/features/compass/CompassSourceList.jsx"].flatMap((entry) => [...staticModules(entry)]));
    for (const file of cold) {
      expect(plugin.transform(readFileSync(file, "utf8"), file)?.code ?? "", file).not.toContain("virtual:route-styles/mcases.css");
    }
  });

  it("loads the founder panel's sheet through the lazy People waiting graph", () => {
    const panel = resolve("src/features/intakeQueue/FounderInvitationPanel.jsx");
    expect(staticModules("src/features/intakeQueue/PeopleWaitingPage.jsx").has(panel)).toBe(true);
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    expect(plugin.transform(readFileSync(panel, "utf8"), panel).code).toContain('import "virtual:route-styles/xus-intake.css";');
    const sheet = plugin.load(plugin.resolveId("virtual:route-styles/xus-intake.css"));
    // The cascade guard may retain a panel rule in the critical sheet.
    // Both sheets are loaded before this lazy renderer appears.
    const critical = plugin.transform(readFileSync("src/styles.css", "utf8"), resolve("src/styles.css")).code;
    expect(critical + sheet).toContain(".xus-intake-pass");
    expect(critical + sheet).toContain(".xus-intake-passform");
  });

  it("does not fetch coordinator CSS for the shared plane header's explanatory comment (ledger 554)", () => {
    const path = resolve("src/components/PlaneHeader.jsx");
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    expect(plugin.transform(readFileSync(path, "utf8"), path)?.code ?? "").not.toContain('import "virtual:route-styles/gq.css";');
  });

  it("does not attach coordinator styles to the shared case-note composer", () => {
    const path = resolve("src/components/CaseMentions.jsx");
    const code = readFileSync(path, "utf8");
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    // A class mentioned only in a comment used to import the queue sheet into
    // AltWorkBody through this shared composer, without a queue renderer.
    expect(routeSheetsFor(code)).toEqual([]);
    expect(plugin.transform(code, path)).toBeUndefined();
  });
});

describe("the cascade guard", () => {
  const routeRule = ".tasks-panel { color: red; }";

  it.each([...Object.keys(SINGLE_VIEW_SPLITS), ...Object.keys(SHARED_SPLIT_RENDERERS)])("retains %s collisions, mixed selectors, layers and keyframes", (prefix) => {
    const source = `.${prefix}-surface { color: red; }\n.plain { color: blue; }\n.${prefix}-gap { gap: 8px; }\n.${prefix}-mixed, .shared { margin: 0; }\n@layer shared { .${prefix}-layer { padding: 0; } }\n@keyframes ${prefix}-pulse { to { opacity: 0; } }`;
    const split = splitRouteStyles(source, { sources: [`"${prefix}-surface plain"`] });
    expect(split.critical).toContain(`.${prefix}-surface { color: red; }`);
    expect(split.critical).toContain(`.${prefix}-mixed, .shared`);
    expect(split.critical).toContain("@layer shared");
    expect(split.critical).toContain(`@keyframes ${prefix}-pulse`);
    expect(split[prefix]).toBe(`\n.${prefix}-gap { gap: 8px; }`);
    expect(Object.values(split).flatMap(rules).sort()).toEqual(rules(source));
  });

  it("retains coordinator collisions while moving an independent queue rule", () => {
    const source = ".gq-case { color: red; }\n.plain { color: blue; }\n.gq-gap { gap: 8px; }";
    const split = splitRouteStyles(source, { sources: ['"gq-case plain"'] });
    expect(split.critical).toContain(".gq-case { color: red; }");
    expect(split.gq).not.toContain(".gq-case");
    expect(split.gq).toContain(".gq-gap { gap: 8px; }");
    expect(Object.values(split).flatMap(rules).sort()).toEqual(rules(source));
  });

  it("counts an eager popups.css rival that main imports after styles.css", () => {
    const root = mkdtempSync(join(tmpdir(), "route-styles-popup-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/main.jsx"), 'import "./styles.css";\nimport "./popups.css";\nconst names = "tasks-panel plain";');
      writeFileSync(join(root, "src/styles.css"), `${routeRule}\n.tasks-gap { gap: 8px; }`);
      writeFileSync(join(root, "src/popups.css"), ".plain { color: blue; }");
      const split = readRouteStyles(root);
      expect(split.critical).toContain(routeRule);
      expect(split.tasks).not.toContain(".tasks-panel");
      expect(split.tasks).toContain(".tasks-gap { gap: 8px; }");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps a route rule critical when a later rule of equal specificity sets the same property on the same element", () => {
    const source = `${routeRule}\n.plain { color: blue; }`;
    const together = splitRouteStyles(source, { sources: ['<div className="tasks-panel plain" />'] });
    expect(together.tasks).toBe("");
    expect(together.critical).toContain(".tasks-panel");
  });

  it.each([2, 3, 5])("reconsiders earlier rules until a %i-rule same-family chain reaches a fixed point", (count) => {
    const names = Array.from({ length: count }, (_, index) => `tasks-${String.fromCharCode(97 + index)}`);
    const source = `${names.map((name, index) => `.${name} { color: rgb(${index}, 0, 0); }`).join("\n")}\n.plain { color: green; }\n.tasks-gap { gap: 8px; }`;
    const sources = names.slice(1).map((name, index) => `"${names[index]} ${name}"`);
    sources.push(`"${names.at(-1)} plain"`);
    const split = splitRouteStyles(source, { sources });
    for (const name of names) {
      expect(split.critical, name).toContain(`.${name} { color:`);
      expect(split.tasks, name).not.toContain(`.${name} { color:`);
    }
    expect(split.tasks).toContain(".tasks-gap { gap: 8px; }");
    expect(Object.values(split).flatMap(rules).sort()).toEqual(rules(source));
  });

  it("keeps form-editor header layout together when responsive overrides remain critical", () => {
    const base = ".ftm-editor__head { align-items: flex-start; }";
    const responsive = "@media (max-width: 600px) { .ftm-editor__head { align-items: stretch; flex-direction: column; } }";
    const source = `${base}\n${responsive}\n.plain { flex-direction: row; }`;
    const split = splitRouteStyles(source, { sources: ['"ftm-editor__head plain"'] });
    expect(split.critical).toContain(base);
    expect(split.ftm).toBe("");
    expect(Object.values(split).flatMap(rules).sort()).toEqual(rules(source));
  });

  it("keeps conflicting Kanban declarations critical while moving an independent rule unchanged", () => {
    const source = ".kan-card { color: red; }\n.plain { color: blue; }\n.kan-card__spacer { flex: 1 1 auto; }";
    const split = splitRouteStyles(source, { sources: ['<div className="kan-card plain" />'] });
    expect(split.critical).toContain(".kan-card { color: red; }");
    expect(split.critical).toContain(".plain { color: blue; }");
    expect(split.kan).not.toContain("color:");
    expect(split.kan).toContain(".kan-card__spacer { flex: 1 1 auto; }");
    expect(Object.values(split).flatMap(rules).sort()).toEqual(rules(source));
  });

  it("moves it when the two classes never meet, the specificity differs, or the property differs", () => {
    expect(splitRouteStyles(`${routeRule}\n.plain { color: blue; }`, { sources: ['"tasks-panel"', '"plain"'] }).tasks).toContain(".tasks-panel");
    expect(splitRouteStyles(`${routeRule}\n.app .plain { color: blue; }`, { sources: ['"tasks-panel plain"'] }).tasks).toContain(".tasks-panel");
    expect(splitRouteStyles(`${routeRule}\n.plain { margin: 0; }`, { sources: ['"tasks-panel plain"'] }).tasks).toContain(".tasks-panel");
    expect(splitRouteStyles(`${routeRule}\n.plain::before { color: blue; }`, { sources: ['"tasks-panel plain"'] }).tasks).toContain(".tasks-panel");
  });

  it("treats shorthands, logical sides and later stylesheets as conflicts", () => {
    const sources = ['"tasks-panel plain"'];
    expect(splitRouteStyles(".tasks-panel { margin-top: 1px; }\n.plain { margin-block: 0; }", { sources }).tasks).toBe("");
    expect(splitRouteStyles(".tasks-panel { top: 0; }\n.plain { inset: 0; }", { sources }).tasks).toBe("");
    expect(splitRouteStyles(routeRule, { sources, laterSheets: [".plain { color: blue; }"] }).tasks).toBe("");
    // A classless child of a classed parent meets only that parent's component.
    expect(splitRouteStyles(`${routeRule}\n.list > * { color: blue; }`, { sources: ['"tasks-panel"', '"list"'] }).tasks).toContain(".tasks-panel");
    expect(splitRouteStyles(`${routeRule}\n:focus-visible { color: blue; }`, { sources }).tasks).toBe("");
  });

  it("counts specificity the way browsers do", () => {
    expect(specificity(".a .b")).toEqual([0, 2, 0]);
    expect(specificity("button.voting-option:not(.x)")).toEqual([0, 2, 1]);
    expect(specificity(":where(.a, #b) .c")).toEqual([0, 1, 0]);
    expect(specificity(".rail[data-collapsed=\"true\"] :is(.name, #id)")).toEqual([1, 2, 0]);
    expect(specificity("a::before")).toEqual([0, 0, 2]);
  });
});

describe("the build plugin", () => {
  it("is wired for builds and the dev server, not for tests that read src/styles.css whole", () => {
    expect(readFileSync("vite.config.mjs", "utf8")).toContain("!process.env.VITEST && routeStylesPlugin(),");
  });

  it("serves the critical sheet for styles.css and adds route imports to the modules that use them", () => {
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    expect(plugin.transform("", resolve("src/styles.css")).code).toBe(sheets.critical);
    const view = plugin.transform('<section className="tasks-screen voting-stack" />', resolve("src/views/Example.jsx")).code;
    expect(view.split("\n").slice(0, 2)).toEqual(['import "virtual:route-styles/tasks.css";', 'import "virtual:route-styles/voting.css";']);
    expect(view).not.toContain("virtual:route-styles/voice.css");
    expect(plugin.transform('"tasks-work-docket__rows"', resolve(QUERY_ONLY_SOURCES[0]))).toBeUndefined();
    expect(plugin.load(plugin.resolveId("virtual:route-styles/tasks.css"))).toBe(sheets.tasks);
  });

  it("drops the cached route sheets in the dev server when styles.css changes", () => {
    const plugin = routeStylesPlugin();
    plugin.configResolved({ root: process.cwd() });
    const tasks = { id: "\0virtual:route-styles/tasks.css" };
    const server = {
      moduleGraph: { getModuleById: (id) => (id === tasks.id ? tasks : undefined), invalidateModule: vi.fn() },
      ws: { send: vi.fn() },
    };
    plugin.handleHotUpdate({ file: resolve("src/views/TasksView.jsx"), server });
    expect(server.ws.send).not.toHaveBeenCalled();
    plugin.handleHotUpdate({ file: resolve("src/styles.css"), server });
    expect(server.moduleGraph.invalidateModule.mock.calls).toEqual([[tasks]]);
    expect(server.ws.send).toHaveBeenCalledWith({ type: "full-reload" });
  });

  it("fails a build in which the entry chunk reaches a route sheet", () => {
    const plugin = routeStylesPlugin();
    const errors = [];
    const context = { error: (message) => errors.push(message) };
    const bundle = {
      "index.js": { type: "chunk", isEntry: true, fileName: "index.js", imports: ["shared.js"], modules: { "/src/main.jsx": {} } },
      "shared.js": { type: "chunk", isEntry: false, fileName: "shared.js", imports: [], modules: {} },
      "TasksView.js": { type: "chunk", isEntry: false, fileName: "TasksView.js", imports: [], modules: { "\0virtual:route-styles/tasks.css": {} } },
    };
    plugin.generateBundle.call(context, {}, bundle);
    expect(errors).toEqual([]);
    bundle["shared.js"].modules["\0virtual:route-styles/tasks.css"] = {};
    plugin.generateBundle.call(context, {}, bundle);
    expect(errors).toEqual(["route stylesheets reached the entry chunk: virtual:route-styles/tasks.css"]);
  });
});
