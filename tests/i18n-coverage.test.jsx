import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogue, dateTimeFormat, formatDateTime, formatDateTimeWithZone, localeFor, t as translate } from "../src/lib/i18n.js";
import { formatGroupMoment } from "../src/lib/i18n/zonedDates.js";
import { formatZoneInstant } from "../src/lib/zoneTime.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { AppointmentsView } from "../src/views/AppointmentsView.jsx";
import { EventsView } from "../src/views/EventsView.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { VerifyReceiptView } from "../src/views/VerifyReceiptView.jsx";
import { TasksView } from "../src/views/TasksView.jsx";
import { CasesView } from "../src/views/CasesView.jsx";
import { rightsLessonFallback } from "../src/data/rightsLabels.js";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { TasksReport } from "../src/views/TasksReport.jsx";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { CaseworkOperationsPanel } from "../src/components/CaseworkOperationsPanel.jsx";
import {
  CASEWORK_ADMIN_FORMAL_IMPERATIVES,
  CASEWORK_ADMIN_REGISTER_MARKERS,
  FORMAL_IMPERATIVES,
  USTED_MARKERS as QA_USTED_MARKERS,
} from "./i18nRegisterMarkers.js";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

// Strip comments before the static scan so a comment that *names* the old
// anti-pattern (e.g. "…instead of a hardcoded en-US…") is not mistaken for the
// anti-pattern itself. Block comments first; then line comments, but only when
// `//` is not preceded by `:` so an `https://` URL in code survives.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// The three surfaces PR7 translated. Every route that renders user-facing
// text must go through the catalogue.
//
// 2026-08-01 adds the three files of the t0ggles kanban rebuild (647466cb5).
// They belong on this list for a reason the PR7 three did not have: the board
// is the densest date surface in the app. A card shows a short due date, the
// column heads show counts, the modal shows a start date, a due date and a
// timestamp on every comment — four `Intl.DateTimeFormat` call sites written
// in one week, which is exactly the shape that produced the hardcoded "en-US"
// this guard was built to ban in the first place. A Spanish-speaking steward
// reading "Aug 4" on a card while the rest of the screen speaks Spanish is the
// bug; it is invisible to a parity test, because the catalogue is complete and
// the literal never went through it. The static half below catches the locale
// string, and the behavioural half at the bottom catches the other direction —
// an English label passed straight into JSX without t().
const TRANSLATED_VIEWS = [
  "src/views/StewardView.jsx",
  "src/views/VerifyReceiptView.jsx",
  "src/views/TasksView.jsx",
  "src/views/KanbanBoard.jsx",
  "src/views/KanbanCalendar.jsx",
  "src/views/KanbanList.jsx",
  "src/views/TaskModal.jsx",
  "src/views/TaskDeadlinesView.jsx",
  "src/views/TaskDesktopTimeline.jsx",
  "src/views/TaskFieldNotesView.jsx",
  // 2026-09-17: CasesView joins the list with the locale-ternary repair. It
  // formats every date through localeFor(lang) already, so the en-US ban below
  // costs it nothing and stops the next date formatter from being written
  // inline.
  "src/views/CasesView.jsx",
  // Union Ground's public front door: LearnView serves "/" and "/learn" and
  // ConnectView serves "/connect". The public routes need the guard most,
  // because /connect asks a visitor which language they read in and then shows
  // them the consent text.
  "src/views/LearnView.jsx",
  "src/views/ConnectView.jsx",
];

// 2026-09-17 locale-ternary / date-locale repair. Kept as a sibling array of
// the views that repair reached; the static guard below concatenates both.
const ADDITIONAL_TRANSLATED_VIEWS = [
  "src/views/AppointmentsView.jsx",
  "src/views/EventsView.jsx",
  "src/views/IntegrationsView.jsx",
  "src/views/OperationsHealthView.jsx",
  "src/views/OfficerQaView.jsx",
  "src/views/MemberQaView.jsx",
  "src/views/SettingsView.jsx",
  "src/views/TasksReport.jsx",
  "src/views/WorkloadView.jsx",
  "src/components/AdminSecurityConfiguration.jsx",
  "src/components/DemoVoiceMember.jsx",
  "src/components/DemoVoiceStudio.jsx",
  // 2026-10-30: REQ-UG-MEETING-QUORUM-COUNTS-20261030. The quorum
  // line and the staff quorum control render every word through t().
  "src/components/EventQuorum.jsx",
  // 2026-09-21: UX-UG-WEB-HUB-DIALOG-OPTIONS-AND-LIST-ENUMS-ENGLISH-ONLY-
  // 20260920. ProductHubView's six create/edit dialogs used to carry literal
  // English <option> children (Chapter/Staff/Private, …) that no parity check
  // could see because the literals never went through t(). The literal-option
  // ban below is what actually guards that file; the two generic checks above
  // ride along for free.
  "src/views/ProductHubView.jsx",
  // 2026-10-01: invitation-only accounts; the page the invitation QR opens.
  "src/views/GetAppView.jsx",
  // REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003: open signup, behind the
  // owner's switch (off by default).
  "src/views/OpenSignupView.jsx",
  "src/views/OpenSignupConfirmView.jsx",
  "src/features/openSignup/CreateOrganizationGate.jsx",
  "src/views/RequestInviteView.jsx",
  // REQ-UG-UNION-CATALOG-SETUP-REVIEW-PREFILL-20260925: the setup review,
  // its row editor, banner and two-step notice, and the placement card/badge.
  "src/features/orgSetup/SetupReviewPage.jsx",
  "src/features/orgSetup/SetupRowEditor.jsx",
  "src/features/orgSetup/SetupBanner.jsx",
  "src/features/orgSetup/AdminLaunchChecklist.jsx",
  "src/features/orgSetup/ChapterUnitsCard.jsx",
  "src/features/orgSetup/SetupTwoStepNotice.jsx",
  "src/features/unionCatalog/PlacementCard.jsx",
  "src/features/unionCatalog/PlacementBadge.jsx",
];

// Left out of Union Ground (owner decision, 2026-10-13): contract clauses,
// the public union directory and catalog profile, and organization claims.
// They left the guard lists above with their files; this pins that they are
// gone, so a re-import has to come back through the guard.
const REMOVED_TRANSLATED_VIEWS = [
  "src/views/ClauseQuickReferenceView.jsx",
  "src/features/clauses/ui/ClauseQuickReference.jsx",
  "src/views/FindYourUnionView.jsx",
  "src/features/unionCatalog/UnionProfilePanel.jsx",
  "src/features/unionCatalog/OrganizationClaimPage.jsx",
  "src/features/unionCatalog/CatalogVouchPage.jsx",
  "src/features/unionCatalog/PlacementVerificationLine.jsx",
  "src/views/OrganizationLandingView.jsx",
  "src/views/OrganizationClaimConfirmView.jsx",
  "src/features/unionCatalog/VerifierQueuePage.jsx",
  "src/views/DuesView.jsx",
];

afterEach(() => {
  // An assertion throw skips any restore later in the test, and later cases
  // in this file would inherit the fake clock or a stubbed global.
  vi.useRealTimers();
  vi.unstubAllGlobals();
  try {
    window.localStorage.removeItem("unionground-lang");
    window.localStorage.removeItem("sg-lang");
  } catch { /* jsdom always has storage */ }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Static guard: reintroducing a hardcoded English literal fails CI.
//
// This is the guard the plan asked for. It does not try to parse JSX — it bans
// the two shapes that let English or a fixed locale sneak back onto a surface
// that is supposed to follow the member's language: a `translate("en", …)`
// hardcode (the exact anti-pattern StewardView carried before PR7) and an
// "en-US"/"en_US" locale string (VerifyReceipt's old hardcoded date formatter).
// A new date must go through localeFor(lang)/formatDateTimeWithZone, and a new string
// through t(), or this test flags the file by name.
// ---------------------------------------------------------------------------
describe("i18n static coverage guard", () => {
  it("ships none of the left-out views the guard used to cover", () => {
    for (const path of REMOVED_TRANSLATED_VIEWS) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(false);
    }
  });

  for (const path of [...TRANSLATED_VIEWS, ...ADDITIONAL_TRANSLATED_VIEWS]) {
    it(`${path} pins no hardcoded language or locale`, () => {
      const src = stripComments(read(path));
      expect(src, `${path} hardcodes translate("en", …) — use useLang()/t()`).not.toMatch(/translate\(\s*['"]en['"]/);
      expect(src, `${path} hardcodes an en-US locale — route dates through localeFor(lang)`).not.toMatch(/en[-_]US/);
    });
  }

  // UX-UG-SETTINGS-QUIET-HOURS-TIMEZONE-ENGLISH-ES-20260920: both bans above
  // are call-shaped, so the quiet-hours form's bare English literals — the AM/PM
  // the chip concatenated and the ten English zone labels the picker rendered —
  // passed the guard while rendering English on a Spanish hub. Pin that form's
  // member-facing copy to the catalogue by shape.
  it("SettingsView takes the quiet-hours meridiem and zone labels from the catalogue", () => {
    const src = stripComments(read("src/views/SettingsView.jsx"));
    expect(src, "the quiet-hours chip hardcodes AM/PM — read the meridiem from the catalogue").not.toMatch(/["'](AM|PM)["']/);
    expect(src, "FOCUS_TIME_ZONES carries English zone labels — carry catalogue keys instead").not.toMatch(/["'][A-Za-z]+ — [^"']*["']/);
  });

  it("StewardView reads the active language instead of forcing English", () => {
    const src = stripComments(read("src/views/StewardView.jsx"));
    expect(src).toMatch(/useLang\(\)/);
    // The old `const en = (key) => translate("en", key)` shim must be gone.
    expect(src).not.toMatch(/const en\s*=/);
  });
});

// ---------------------------------------------------------------------------
// UX-UG-WEB-HUB-DIALOG-OPTIONS-AND-LIST-ENUMS-ENGLISH-ONLY-20260920. The
// hub dialogs' enum <option> labels must come from the catalogue — a literal
// English child (`<option value="campaign">Chapter</option>`) is the exact
// defect this record closed, and it is invisible to parity checks because the
// literal never went through t(). The ban is on a non-expression child: an
// option whose text does not open with `{` is a hardcoded label. An option
// whose only child is an expression (`{t(key)}`, `{org.name} · …`) is the
// repaired shape. Whitespace-only children (`<option value="">`) stay legal —
// HandshakeDialog's empty placeholder value renders its label through t().
// ---------------------------------------------------------------------------
const LITERAL_OPTION_CHILD = /<option\b[^>]*>\s*[^{<\s][^<]*<\s*\/\s*option\s*>/;

describe("ProductHubView pins every option label to the catalogue", () => {
  it("the literal-option pattern matches the defect it bans", () => {
    // Prove the regex sees the old shape, so a future edit that silently
    // weakens the pattern fails here instead of leaving the ban toothless.
    expect(LITERAL_OPTION_CHILD.test('<option value="campaign">Chapter</option>')).toBe(true);
    expect(LITERAL_OPTION_CHILD.test('<option value="minutes">Meeting minutes</option>')).toBe(true);
  });

  it("the literal-option pattern leaves the repaired shapes alone", () => {
    expect(LITERAL_OPTION_CHILD.test('<option value="">{t("hub.selectOrganization")}</option>')).toBe(false);
    expect(LITERAL_OPTION_CHILD.test('<option value="org.id">{org.name} · {org.city}</option>')).toBe(false);
    expect(LITERAL_OPTION_CHILD.test('<option value=""></option>')).toBe(false);
  });

  it("src/views/ProductHubView.jsx carries no literal option child", () => {
    const src = stripComments(read("src/views/ProductHubView.jsx"));
    expect(src, "ProductHubView has a literal <option> child — route the label through t()").not.toMatch(LITERAL_OPTION_CHILD);
  });
});

// ---------------------------------------------------------------------------
// Catalogue coverage: every retained steward./verify./learn./connect. key
// resolves in BOTH locales with a non-empty, non-placeholder value.
// (i18n.test.js proves whole-catalogue parity; this asserts these namespaces
// specifically, so a half-added key is caught here with a namespace-scoped
// message. learn. and connect. carry Union Ground's public front door. The
// contractSurvey. namespace was removed 2026-08-08 with the sub-app.)
// ---------------------------------------------------------------------------
describe("i18n catalogue coverage for the public and PR7 namespaces", () => {
  const namespaces = ["steward.", "verify.", "learn.", "connect."];
  const keys = Object.keys(catalogue.en).filter((k) => namespaces.some((ns) => k.startsWith(ns)));

  it("has a non-trivial number of keys in each namespace", () => {
    for (const ns of namespaces) {
      expect(keys.filter((k) => k.startsWith(ns)).length, `${ns}* has no keys`).toBeGreaterThan(0);
    }
  });

  it("keeps the removed contractSurvey namespace out of both locales", () => {
    // The sub-app left 2026-08-08; parity alone cannot catch obsolete keys
    // reintroduced symmetrically, so pin the absence in each locale.
    for (const locale of ["en", "es"]) {
      const stale = Object.keys(catalogue[locale]).filter((k) => k.startsWith("contractSurvey."));
      expect(stale, `${locale} still carries contractSurvey.* keys`).toEqual([]);
    }
  });

  it("resolves every key in en and es to a non-empty string", () => {
    for (const key of keys) {
      expect(typeof catalogue.en[key], `${key} en`).toBe("string");
      expect(catalogue.en[key].trim().length, `${key} en empty`).toBeGreaterThan(0);
      expect(typeof catalogue.es[key], `${key} es missing`).toBe("string");
      expect(catalogue.es[key].trim().length, `${key} es empty`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Catalogue coverage for the kanban namespace, same contract as the block
// above. The board shipped ~60 keys in one commit, added to both locale
// objects roughly 1,800 lines apart in i18n.js — the one arrangement where a
// key genuinely can be added to `en` and forgotten in `es` without anything
// looking wrong in the diff. i18n.test.js proves whole-catalogue parity, so
// this repeats the check only to fail with a message that names the namespace
// and points at the board rather than at the catalogue in general.
// ---------------------------------------------------------------------------
describe("i18n catalogue coverage for the kanban namespace", () => {
  const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("kanban."));

  it("carries the board's key set", () => {
    // Not a magic number: it is a floor under the spec's key list, so deleting
    // half the namespace to make a failing render pass cannot go unnoticed.
    expect(keys.length, "kanban.* has lost keys").toBeGreaterThanOrEqual(40);
  });

  it("resolves every key in en and es to a non-empty string", () => {
    for (const key of keys) {
      expect(typeof catalogue.en[key], `${key} en`).toBe("string");
      expect(catalogue.en[key].trim().length, `${key} en empty`).toBeGreaterThan(0);
      expect(typeof catalogue.es[key], `${key} es missing`).toBe("string");
      expect(catalogue.es[key].trim().length, `${key} es empty`).toBeGreaterThan(0);
    }
  });

  it("translates rather than copying the English through", () => {
    // The failure mode a parity check cannot see: `es` present, non-empty, and
    // byte-identical to `en` because the key was pasted into both objects. A
    // handful of kanban strings are legitimately identical across the two
    // locales (interpolation-only shapes like "+{count}"), so this asserts the
    // shape of the namespace as a whole instead of policing each key.
    const identical = keys.filter((key) => catalogue.es[key] === catalogue.en[key]);
    expect(
      identical.length,
      `most of kanban.* is untranslated English: ${identical.slice(0, 8).join(", ")}`,
    ).toBeLessThan(keys.length / 4);
  });

  it("keeps the locked glossary inside the board copy", () => {
    // capítulo, not "campaign"; the board's workstream picker and focus-mode
    // copy are the newest place the glossary could drift.
    const spanish = keys.map((key) => catalogue.es[key]).join(" ");
    expect(spanish).not.toMatch(/\bchapter\b/i);
    expect(spanish).not.toMatch(/\bworkstream\b/i);
  });
});

// ---------------------------------------------------------------------------
// Behavioural proof: the wiring actually renders Spanish. A file could satisfy
// the static guard yet still pass an English string literal straight into JSX;
// these render each surface in Spanish and assert canon Spanish text appears.
// ---------------------------------------------------------------------------
describe("PR7 surfaces render in Spanish", () => {
  it("StewardView renders the desk in the active locale", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue({
        queue: [], threads: [], broadcasts: [], formsInbox: [], formTemplateVersions: [],
        kpis: { openRequests: 0, membersCovered: 0, awaitingReply: 0, broadcasts30d: 0 },
      }),
    };
    render(
      <LanguageProvider lang="es">
        <StewardView data={{ member: { id: "s-1", initials: "SO" }, events: [] }} api={api} onNotice={() => {}} />
      </LanguageProvider>,
    );
    expect(await screen.findByText("Solicitudes de trabajadores")).toBeInTheDocument();
    expect(screen.getByText("Bandeja de revisión del comité")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publicar comunicado" })).toBeInTheDocument();
    // and no English leaked onto the primary titles
    expect(screen.queryByText("Worker requests")).toBeNull();
  });

  it("VerifyReceiptView honours the saved Union Ground language choice", () => {
    window.localStorage.setItem("unionground-lang", "es");
    render(<VerifyReceiptView />);
    expect(screen.getByRole("heading", { name: "Verifica un comprobante de voto" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verificar comprobante" })).toBeInTheDocument();
    expect(screen.queryByText("Verify a vote receipt")).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// The kanban board renders in Spanish, end to end.
//
// The static guard above only proves the three files contain no banned
// literal. It cannot prove they call `t()` for the strings a member actually
// reads, and on this surface that gap is wide: TasksView owns the chrome,
// hands `t` down as a prop to KanbanBoard and TaskModal, and those two render
// almost every label the board has. A prop named `t` that is never called, or
// called for the chrome and skipped for the card composer, passes every static
// check in this file. So the proof is a render of the real chain — TasksView
// mounting the real board, then the real modal — with the assertions written
// as pairs: the canon Spanish string is present AND its English twin is not,
// because "Nueva tarea" appearing somewhere does not rule out an English
// composer sitting next to it.
// ---------------------------------------------------------------------------
describe("the kanban board renders in Spanish", () => {
  // Wide-layout stub: TasksView asks matchMedia("(min-width: 1024px)") twice
  // and jsdom answers false for everything, which would render the compact
  // top bar. Captured and restored so the compact suites keep their own answer.
  const realMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
  });
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  function renderBoard(lang = "es") {
    const props = {
      data: structuredClone(fallbackData),
      onProfile: vi.fn(),
      onAssistant: vi.fn(),
      onCreateTask: vi.fn(async (fields) => ({ ...fields, id: "new-task" })),
      onUpdateTask: vi.fn(async (_id, fields) => fields),
      onDeleteTask: vi.fn(async () => ({ deleted: true })),
      onSendTaskMessage: vi.fn(async () => null),
    };
    render(<LanguageProvider lang={lang}><TasksView {...props} /></LanguageProvider>);
    return props;
  }

  it("labels the column composers from the catalogue, not from a literal", () => {
    renderBoard();
    // kanban.newTask — the ghost row at the top and bottom of every column. It
    // is the string a member touches most often on this screen and the one the
    // board renders even when no card passes the active filter.
    expect(screen.getAllByRole("button", { name: /Nueva tarea/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
  });

  it("labels the focus-mode target from the catalogue", () => {
    renderBoard();
    // kanban.focusOn takes an interpolated {name}, the shape most likely to be
    // assembled in JSX ("Focus on " + name) instead of routed through t().
    expect(screen.getAllByRole("button", { name: /^Enfocarse en / }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^Focus on / })).toBeNull();
  });

  it("opens the detail modal in Spanish too", async () => {
    renderBoard();
    // The modal is a separate file receiving the same `t` prop; opening it is
    // the only way to prove the prop survived the hand-off.
    fireEvent.click(screen.getByRole("button", { name: "Prepare August campaign meeting" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Descripción" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Comentarios" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("heading", { name: "Description" })).toBeNull();
    expect(within(dialog).queryByRole("heading", { name: "Comments" })).toBeNull();
  });

  it("still speaks English when English is the active language", () => {
    // The mirror. A surface can pass every Spanish assertion above by being
    // hardcoded Spanish, which is the same bug pointed the other way.
    renderBoard("en");
    expect(screen.getAllByRole("button", { name: /New task/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Nueva tarea" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Content, not just chrome.
//
// The bilingual design pass filed this as its first finding: `t()` covers the
// app's chrome, and the parity tests pass, but the CONTENT a member reads can
// still be English on the ordinary signed-in path. The disciplinary-meeting
// fallback is the sharpest case in the product — the four strings a member
// reads aloud to their manager in a meeting that can end their job, shown
// whenever the rights-lessons table has no row. "No row" is not a state that
// should change which language the product speaks.
// ---------------------------------------------------------------------------
describe("the disciplinary-meeting fallback follows the member's language", () => {
  it("answers in Spanish for es and English for en", () => {
    const en = rightsLessonFallback("en");
    const es = rightsLessonFallback("es");
    expect(es.title).not.toBe(en.title);
    expect(es.script).not.toBe(en.script);
    // The script is the load-bearing string: it is spoken, not read. Before
    // recognition it asks for a coworker.
    expect(en.script).toMatch(/coworker to be present/);
    expect(es.script).toMatch(/compañero o compañera de trabajo esté presente/);
    expect(es.steps).toHaveLength(en.steps.length);
    expect(es.steps.every((step) => typeof step === "string" && step.length > 0)).toBe(true);
  });

  it("promises no right to union representation in either language", () => {
    for (const lang of ["en", "es"]) {
      const text = Object.values(rightsLessonFallback(lang)).flat().join(" ");
      expect(text, lang).not.toMatch(/union representation|representation|representación|Weingarten|steward|delegad/i);
    }
  });

  it("falls back to English for a locale it does not carry", () => {
    // A map indexed directly would hand back `undefined` here, turning a
    // missing translation into a blank rights screen rather than an English
    // one. That is why the module exports a function.
    expect(rightsLessonFallback("fr")).toEqual(rightsLessonFallback("en"));
    expect(rightsLessonFallback(undefined)).toEqual(rightsLessonFallback("en"));
  });

  it("sends the worker to the committee or an organizer, per Union Ground's glossary", () => {
    expect(rightsLessonFallback("en").steps.join(" ")).toMatch(/committee member or organizer/);
    expect(rightsLessonFallback("es").steps.join(" ")).toMatch(/miembro del comité o a un organizador/);
  });
});

// ---------------------------------------------------------------------------
// CasesView used to pick the missing-source status with `lang === "es" ? …`,
// which left the string outside the catalogue and the coverage scan. The
// static half bans that ternary (and a locale twin) so it cannot return; the
// behavioural half proves the catalogue string is what the member actually
// reads in both languages.
// ---------------------------------------------------------------------------
describe("CasesView routes copy through the catalogue", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("does not select user-facing strings with a language ternary", () => {
    const src = stripComments(read("src/views/CasesView.jsx"));
    // The ban is written on the *comparison*, not on `=== "es"`, because the
    // ternary has four equivalent spellings and the repaired one was only the
    // first: `lang === "es" ? es: en`, `lang === "en" ? en: es`,
    // `lang !== "es" ? en: es` and `lang !== "en" ? es: en` all pick copy in
    // the component. `&&`/`||` are included so the conditional-render spelling
    // (`{lang === "en" && "…"}`) is caught too. Hoisting the comparison into a
    // boolean first (`const spanish = lang === "es"`, the shape
    // IntegrationsView uses) is the same defect one line apart, so it is
    // banned as well. Both bans run through copyTernaryLeftovers (defined
    // below, evaluated when this test runs) rather than a private pair of
    // regexes, so CasesView also gets the Yoda operand order `"es" === lang`
    // that the private pair never matched.
    expect(
      copyTernaryLeftovers(src),
      "CasesView picks copy with a language comparison — use t()",
    ).toEqual([]);
    expect(src).toMatch(/t\("cases\.unavailable"\)/);
  });

  it("covers cases.unavailable in both locales", () => {
    expect(catalogue.en["cases.unavailable"]).toBe("This issue is unavailable or you no longer have access.");
    expect(catalogue.es["cases.unavailable"]).toBe("Este asunto no está disponible o ya no tienes acceso.");
  });

  it("renders the missing-source status from t() in English and Spanish", () => {
    const props = {
      data: { cases: [] },
      onCreateCase: vi.fn(),
      onUpdateCase: vi.fn(),
      onAddCaseUpdate: vi.fn(),
      onAddCaseFile: vi.fn(),
      onRemoveCaseFile: vi.fn(),
      onOpenCaseFile: vi.fn(),
    };
    window.history.replaceState({}, "", "/m/cases?case=missing-case");

    const { unmount } = render(
      <LanguageProvider lang="en">
        <CasesView {...props} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(catalogue.en["cases.unavailable"]);
    expect(screen.queryByText(catalogue.es["cases.unavailable"])).toBeNull();
    unmount();

    render(
      <LanguageProvider lang="es">
        <CasesView {...props} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(catalogue.es["cases.unavailable"]);
    expect(screen.queryByText(catalogue.en["cases.unavailable"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Remaining view/component copy ternaries and inline date-locale picks. Kept
// in a separate describe from the CasesView block above; the two cover
// different views and share the comparison regexes defined below.
// ---------------------------------------------------------------------------
const COPY_TERNARY_REPAIR_VIEWS = [
  "src/views/AppointmentsView.jsx",
  "src/views/EventsView.jsx",
  "src/views/IntegrationsView.jsx",
  "src/views/OperationsHealthView.jsx",
  "src/views/OfficerQaView.jsx",
  "src/views/MemberQaView.jsx",
  "src/components/DemoVoiceMember.jsx",
  "src/components/DemoVoiceStudio.jsx",
];

const DATE_LOCALE_REPAIR_VIEWS = [
  "src/views/AppointmentsView.jsx",
  "src/views/MemberSupportView.jsx",
  "src/views/EventsView.jsx",
  "src/views/SettingsView.jsx",
  "src/views/TasksReport.jsx",
  "src/views/WorkloadView.jsx",
  "src/components/AdminSecurityConfiguration.jsx",
];

// Both operand orders: `lang === "es"` and the Yoda spelling `"es" === lang`
// pick copy identically, and a ban that only knows one of them is a ban on a
// spelling rather than on the defect.
const COMPARISON = "(?:(?:\\blang|\\blocale|Lang|Locale)\\s*(?:===|!==|==|!=)\\s*[\"'](?:en|es)[\"']"
  + "|[\"'](?:en|es)[\"']\\s*(?:===|!==|==|!=)\\s*(?:\\blang|\\blocale|Lang|Locale))";
const LANGUAGE_COMPARISON = new RegExp(COMPARISON);
const COPY_BRANCH = new RegExp(`${COMPARISON}\\s*(?:\\?|&&|\\|\\|)`);
const HOISTED_FLAG = new RegExp(
  "(?:const|let|var)\\s+[\\w$]+\\s*=\\s*\\(?\\s*"
  + "(?:[\\w$.]*(?:lang|locale|Lang|Locale)\\s*(?:===|!==|==|!=)\\s*[\"'](?:en|es)[\"']"
  + "|[\"'](?:en|es)[\"']\\s*(?:===|!==|==|!=)\\s*[\\w$.]*(?:lang|locale|Lang|Locale))",
);

// One implementation of the copy-ternary ban, so a view-specific copy of it
// cannot drift narrower than this pair. Returns the offending lines; an empty
// array is the pass.
function copyTernaryLeftovers(src) {
  return src.split("\n").filter((line) => COPY_BRANCH.test(line) || HOISTED_FLAG.test(line));
}

// A catalogue-KEY choice is `t(cond ? "a.key": "b.key")` — the call has to
// open immediately before the comparison for the exemption to apply. Testing
// the whole line for a `t(` anywhere (the first spelling of this guard) let a
// raw copy ternary ride along on any of this codebase's very long JSX lines
// that happens to call t() somewhere else on the same line, which is most of
// them.
const CATALOGUE_KEY_CALL = /(?:\bt|\btranslate)\s*\(\s*(?:[\w$]+\s*\.\s*)?$/;

function listSourceFiles(dir) {
  return readdirSync(resolve(process.cwd(), dir))
    .filter((name) => name.endsWith(".js") || name.endsWith(".jsx"))
    .map((name) => `${dir}/${name}`);
}

function comparisonAllowed(line, index) {
  if (CATALOGUE_KEY_CALL.test(line.slice(0, index))) return true;
  if (/aria-pressed|onLanguageChange|onLanguage\b|\bchecked=/.test(line)) return true;
  if (/labelEs|labelEn|titleEs|titleEn|summaryEs|summaryEn|promptsEs|promptsEn|label_es|label_en|blurb_es|blurb_en/.test(line)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Guard self-test. The CasesView ban above used to be a private pair of
// regexes that only knew `lang === "es"`, so the Yoda spelling `"es" === lang`
// picked the same Spanish copy and walked straight past it. It also carried a
// file-scoped exemption for the missing-source sentence, keyed on the
// catalogue entry being absent — dead since that entry landed, and a hole the
// day someone renamed the key. Both are gone; these cases pin every spelling
// so a narrowed copy fails here instead of in production Spanish.
// ---------------------------------------------------------------------------
describe("the copy-ternary ban covers every spelling of the comparison", () => {
  const CAUGHT = [
    'const msg = lang === "es" ? esCopy : enCopy;',
    'const msg = "es" === lang ? esCopy : enCopy;',
    'const msg = lang !== "en" ? esCopy : enCopy;',
    '{"en" === lang && <p>This issue is unavailable or you no longer have access.</p>}',
    'const spanish = lang === "es";',
    'const spanish = "es" === lang;',
  ];
  for (const sample of CAUGHT) {
    it(`flags ${sample}`, () => {
      expect(copyTernaryLeftovers(sample)).toEqual([sample]);
    });
  }

  it("leaves a catalogue-key choice alone", () => {
    const line = 'const label = t(lang === "es" ? "a.key" : "b.key");';
    expect(comparisonAllowed(line, line.indexOf("lang"))).toBe(true);
  });

  it("keeps no file-scoped exemption for the CasesView missing-source sentence", () => {
    const line = 'const msg = "es" === lang ? "no disponible" : "This issue is unavailable or you no longer have access.";';
    expect(comparisonAllowed(line, line.indexOf('"es"'))).toBe(false);
    expect(copyTernaryLeftovers(line)).toEqual([line]);
  });
});

describe("remaining views route copy and dates through the catalogue", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  for (const path of COPY_TERNARY_REPAIR_VIEWS) {
    it(`${path} does not select user-facing strings with a language ternary`, () => {
      const src = stripComments(read(path));
      expect(src, `${path} picks copy with a language ternary — use t()`).not.toMatch(COPY_BRANCH);
      expect(src, `${path} hoists a language comparison into a flag — use t()`).not.toMatch(HOISTED_FLAG);
    });
  }

  for (const path of DATE_LOCALE_REPAIR_VIEWS) {
    it(`${path} formats dates through localeFor(lang)`, () => {
      const src = stripComments(read(path));
      // dateTimeFormat(lang, …) is the 12-hour-aware wrapper around
      // localeFor(lang) (UX-UG-SPANISH-CLOCK); either
      // spelling keeps the member's locale in charge of the date.
      // Account sessions share the Eastern formatter with Notifications.
      // formatGroupMoment(value, lang) is the same wrapper with the group's
      // zone named, and formatDateTime(value, lang) is the catalogue's stamp
      // helper over the same dateTimeFormat(lang); each keeps the member's
      // locale in charge too.
      const formatter = path === "src/views/SettingsView.jsx" ? stripComments(read("src/lib/easternTimestamp.js")) : src;
      expect(formatter).toMatch(/(?:localeFor|dateTimeFormat)\(\s*lang\b|formatGroupMoment\([^;]*?,\s*lang\s*\)|formatDateTime\([^()]*(?:\([^()]*\))?[^()]*,\s*lang\s*\)/);
      if (path === "src/views/SettingsView.jsx") expect(src).toMatch(/formatEasternTimestamp\(session\.lastActiveAt,\s*lang\)/);
      expect(src).not.toMatch(/["']es-US["']/);
      expect(src).not.toMatch(/["']en-US["']/);
      // The other way to write the same defect: no locale argument at all, so
      // the date follows the BROWSER, not the member. The repair puts every
      // formatter on these screens behind localeFor(lang); a bare
      // toLocaleDateString() would quietly reopen the drift.
      expect(src, `${path} formats a date with no locale — use localeFor(lang)`)
        .not.toMatch(/toLocale(?:Date|Time)?String\(\s*\)/);
    });
  }

  it("covers the moved copy keys in both locales", () => {
    const expected = {
      "appt.unavailable": ["This one-on-one is unavailable or you no longer have access.", "Esta reunión individual no está disponible o ya no tienes acceso."],
      "mevents.unavailable": ["This meeting is unavailable or you no longer have access.", "Esta reunión no está disponible o ya no tienes acceso."],
      "integrations.constantContactCanceled": [
        "The Constant Contact connection was canceled. You can try Connect again when ready.",
        "Se canceló la conexión con Constant Contact. Puedes volver a intentar Conectar cuando estés listo.",
      ],
      "integrations.constantContactError": [
        "Constant Contact could not be connected. Verify provider setup and try again.",
        "No se pudo conectar Constant Contact. Verifica la configuración del proveedor e inténtalo de nuevo.",
      ],
      "operations.saveError": [
        "The acknowledgement could not be saved. Try again.",
        "No se pudo guardar el reconocimiento. Inténtalo de nuevo.",
      ],
      "operations.retryError": [
        "The retry request could not be saved. Try again.",
        "No se pudo guardar la solicitud de reintento. Inténtalo de nuevo.",
      ],
      "operations.mfaError": [
        "Complete two-step sign-in, then retry this operation.",
        "Completa el inicio de sesión en dos pasos y vuelve a intentar esta operación.",
      ],
      "operations.olderAuditError": [
        "Older audit entries could not be loaded.",
        "No se pudieron cargar entradas anteriores.",
      ],
      "common.changesSaved": ["Changes saved.", "Cambios guardados."],
      "cases.retaliation.title": ["Report retaliation", "Reportar represalias"],
      "cases.retaliation.help": [
        "Use this structured report for adverse action connected to protected activity. It is visible only to you and authorized staff for this issue.",
        "Usa este informe estructurado para una acción adversa relacionada con actividad protegida. Solo tú y el personal autorizado del asunto pueden verlo.",
      ],
    };
    for (const [key, [en, es]] of Object.entries(expected)) {
      expect(catalogue.en[key], key).toBe(en);
      expect(catalogue.es[key], key).toBe(es);
    }
    expect(catalogue.es["cases.retaliation.help"]).not.toMatch(/usted/i);
    expect(catalogue.es["cases.retaliation.help"]).toMatch(/tú/);
    expect(catalogue.es["operations.mfaError"]).not.toMatch(/\bvuelva\b/);
  });

  it("renders the missing-source status from t() on appointments and events", () => {
    const apptApi = {
      stewards: vi.fn().mockResolvedValue([]),
      slots: vi.fn().mockResolvedValue({ slots: [] }),
    };
    const apptProps = { data: { appointments: [] }, api: apptApi, onBook: vi.fn(), onCancel: vi.fn(), onReschedule: vi.fn() };
    window.history.replaceState({}, "", "/m/appointments?appointment=missing-appt");
    const enAppt = render(
      <LanguageProvider lang="en">
        <AppointmentsView {...apptProps} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(catalogue.en["appt.unavailable"]);
    enAppt.unmount();

    const esAppt = render(
      <LanguageProvider lang="es">
        <AppointmentsView {...apptProps} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(catalogue.es["appt.unavailable"]);
    esAppt.unmount();

    window.history.replaceState({}, "", "/m/events?event=missing-event");
    const enEvent = render(
      <LanguageProvider lang="en">
        <EventsView data={{ events: [] }} onRsvp={vi.fn()} onCheckIn={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(catalogue.en["mevents.unavailable"]);
    enEvent.unmount();

    render(
      <LanguageProvider lang="es">
        <EventsView data={{ events: [] }} onRsvp={vi.fn()} onCheckIn={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(catalogue.es["mevents.unavailable"]);
  });

  // The static guard above proves the PICK goes through localeFor(lang). This
  // proves what a Spanish member actually reads, which is the part the record
  // is about: `es` and `es-US` agree on a medium date and disagree on the
  // clock (17:05 vs 5:05 p. m.), so the screens that print a TIME — the
  // workload reminder and the settings session list — are exactly where the
  // old "es-US" picks were visible, and a static grep cannot see that.
  it("renders one Spanish date format across every repaired screen", () => {
    const instant = new Date("2026-03-04T17:05:00Z");
    // The four option sets the repaired screens pass: a medium date (the
    // option set the removed membership card's receipt used, kept as the
    // plain medium-date case), Settings session, TasksReport day, Workload
    // reminder.
    const optionSets = [
      { dateStyle: "medium", timeZone: "UTC" },
      { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" },
      { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" },
      { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" },
    ];
    const spanishDate = new Intl.DateTimeFormat(localeFor("es"), { dateStyle: "medium", timeZone: "UTC" }).format(instant);
    for (const options of optionSets) {
      const spanish = new Intl.DateTimeFormat(localeFor("es"), options).format(instant);
      const english = new Intl.DateTimeFormat(localeFor("en"), options).format(instant);
      expect(spanish, JSON.stringify(options)).toContain(spanishDate);
      expect(spanish).not.toBe(english);
    }

    // And the same instant rendered by a real repaired screen.
    const reminders = {
      available: true, enabled: true, cadence: "weekly", weekday: 1,
      localHour: 9, timezone: "UTC", nextDueAt: instant.toISOString(),
    };
    // The screen prints through formatZoneInstant (the schedule's zone named,
    // UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122), which
    // carries the 12-hour Spanish clock on top of localeFor(lang).
    const dueAt = (lang) => formatZoneInstant(instant, lang, "UTC");
    for (const lang of ["es", "en"]) {
      const view = render(
        <LanguageProvider lang={lang}>
          <WorkloadView data={{ workload: { entries: [], stats: { enoughData: false }, reminders } }} />
        </LanguageProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["workload.tab.reminders"] }));
      // The 12-hour Spanish clock prints "p.\u00A0m."; testing-library collapses
      // whitespace in the NODE text but not in a string matcher, so normalise
      // the expectation the same way before comparing.
      expect(screen.getByText(
        catalogue[lang]["workload.remindersNext"].replace("{date}", dueAt(lang)).replace(/\s+/g, " "),
      )).toBeInTheDocument();
      view.unmount();
    }
    expect(dueAt("es")).not.toBe(dueAt("en"));
  });

  it("leaves no copy-picking lang comparison in src/views or src/components except catalogue-key choices", () => {
    const leftovers = [];
    // Every comparison on the line is judged on its own position, not the line
    // as a whole, so one exempt catalogue-key choice cannot cover a raw copy
    // ternary sitting next to it.
    const scan = new RegExp(LANGUAGE_COMPARISON.source, "g");
    for (const path of [...listSourceFiles("src/views"), ...listSourceFiles("src/components")]) {
      const src = stripComments(read(path));
      const lines = src.split("\n");
      lines.forEach((line, index) => {
        scan.lastIndex = 0;
        let match = scan.exec(line);
        while (match) {
          if (!comparisonAllowed(line, match.index)) {
            leftovers.push(`${path}:${index + 1}: ${line.trim()}`);
          }
          match = scan.exec(line);
        }
      });
    }
    expect(leftovers, leftovers.join("\n")).toEqual([]);
  });
});

// Organization Intelligence (UX-UG-ORG-INTELLIGENCE-CATALOGUE-AND-LABELS-
// 20260920). The view used to own a private EN/ES COPY table with usted
// imperatives, an English-only workspace name and map labels, and rendered raw
// enum identifiers ("reports_to", "payroll_snapshot") as option and badge
// text. Every string now reads orgIntel.* from the catalogue; an enum keeps its
// identifier as the option value and only its label is translated.
// ---------------------------------------------------------------------------
describe("Organization Intelligence routes copy and enum labels through the catalogue", () => {
  const VIEW = "src/views/OrganizationIntelligenceView.jsx";

  it("carries every orgIntel.* key and every contract enum label in both locales, in the tú register", async () => {
    const contract = await import("../src/features/organizationIntelligence/contract.js");
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("orgIntel."));
    expect(keys.length, "orgIntel.* has lost keys").toBeGreaterThanOrEqual(60);
    const enumKeys = [
      ...contract.ORGANIZATION_CHART_KINDS.map((kind) => `orgIntel.${kind}`),
      ...contract.ORGANIZATION_NODE_KINDS.map((kind) => `orgIntel.nodeKind.${kind}`),
      ...contract.RELATIONSHIP_KINDS.map((kind) => `orgIntel.relationshipKind.${kind}`),
      ...contract.TOPIC_PROGRESS_STATES.map((state) => `orgIntel.topicState.${state}`),
      ...contract.LEADERSHIP_TIMELINE_KINDS.map((kind) => `orgIntel.timelineKind.${kind}`),
    ];
    for (const key of [...keys, ...enumKeys]) {
      for (const locale of ["en", "es"]) {
        expect(typeof catalogue[locale][key], `${key} ${locale} missing`).toBe("string");
        expect(catalogue[locale][key].trim().length, `${key} ${locale} empty`).toBeGreaterThan(0);
      }
      expect(catalogue.es[key], `${key} still uses usted`).not.toMatch(QA_USTED_MARKERS);
      expect(catalogue.es[key], `${key} leaks a raw enum identifier`).not.toMatch(/_/);
    }
    expect(catalogue.es["orgIntel.sub"]).toMatch(/^Mantén /);
    expect(catalogue.es["orgIntel.unauthorized"]).toMatch(/^Selecciona /);
  });

  it("keeps no private copy table, raw enum label or English accessible name in the view", () => {
    const src = stripComments(read(VIEW));
    expect(src).toMatch(/from ["']\.\.\/lib\/LanguageContext\.jsx["']/);
    expect(src).toMatch(/useOrganizationTranslator\(lang\)/);
    expect(src).toMatch(/t\(`orgIntel\.\$\{key\}`/);
    expect(src, "private EN/ES copy table").not.toMatch(/\ben\s*:\s*\{/);
    expect(src, "private EN/ES copy table").not.toMatch(/\bes\s*:\s*\{/);
    expect(src, "raw enum identifier rendered as a label").not.toMatch(/replaceAll\(\s*["']_["']/);
    expect(src, "hard-coded accessible name").not.toMatch(/aria-label="[^"]*[A-Za-z]/);
    expect(src, "English template accessible name").not.toMatch(/aria-label=\{`/);
    expect(src).not.toMatch(/en[-_]US/);
  });

  it("renders the Spanish workspace with catalogue copy, accessible names and enum labels over stable values", async () => {
    const { OrganizationIntelligenceView } = await import("../src/views/OrganizationIntelligenceView.jsx");
    const { ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION } = await import("./fixtures/retired-pre-bot/src/features/organizationIntelligence/preview.js");
    const contract = await import("../src/features/organizationIntelligence/contract.js");
    const actor = {
      userId: "staff-1",
      organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION,
      selectedHat: "admin",
      organizationRoles: ["admin"],
      membershipStatus: "active",
      organizationStatus: "active",
      mfaSatisfied: true,
    };
    // The subtitle names the Neuro Map only once a read says it is on .
    render(<OrganizationIntelligenceView actor={actor} preview lang="es" organizationConfiguration={{ switches: { [contract.NEURO_MAP_SWITCH_KEY]: true } }} />);
    expect(await screen.findByRole("region", { name: catalogue.es["orgIntel.workspace"] })).toBeInTheDocument();
    await screen.findByRole("group", { name: "Diseño guardado de Agencia" });
    expect(screen.getByText(catalogue.es["orgIntel.sub"])).toBeInTheDocument();
    expect(screen.queryByText(/Organization intelligence|persisted layout/)).toBeNull();

    const optionsOf = (select) => [...select.options].map((option) => [option.value, option.textContent]);
    const nodeForm = screen.getByRole("heading", { name: catalogue.es["orgIntel.addNode"] }).closest("form");
    expect(optionsOf(within(nodeForm).getByLabelText("Tipo"))).toEqual(
      contract.ORGANIZATION_NODE_KINDS.map((kind) => [kind, catalogue.es[`orgIntel.nodeKind.${kind}`]]),
    );
    expect(document.querySelector(".oi-badge").textContent).not.toMatch(/^[a-z_]+$/);

    fireEvent.click(screen.getByRole("button", { name: "Mapa Neuro" }));
    expect(screen.getByRole("img", { name: /^\d+ personas conectadas por \d+ relaciones$/ })).toBeInTheDocument();
    const relationshipForm = screen.getByRole("heading", { name: catalogue.es["orgIntel.addRelationship"] }).closest("form");
    expect(optionsOf(within(relationshipForm).getByLabelText("Tipo"))).toEqual(
      contract.RELATIONSHIP_KINDS.map((kind) => [kind, catalogue.es[`orgIntel.relationshipKind.${kind}`]]),
    );
    const topicForm = screen.getByRole("heading", { name: catalogue.es["orgIntel.addTopic"] }).closest("form");
    expect(optionsOf(within(topicForm).getByLabelText("Estado"))).toEqual(
      contract.TOPIC_PROGRESS_STATES.map((state) => [state, catalogue.es[`orgIntel.topicState.${state}`]]),
    );
    expect(document.querySelector(".oi-edge-list").textContent).not.toMatch(/[a-z]+_[a-z]+/);

    fireEvent.click(screen.getByRole("button", { name: "Liderazgo y nómina" }));
    const timelineForm = screen.getByRole("heading", { name: catalogue.es["orgIntel.addTimeline"] }).closest("form");
    expect(optionsOf(within(timelineForm).getByLabelText("Tipo"))).toEqual(
      contract.LEADERSHIP_TIMELINE_KINDS.map((kind) => [kind, catalogue.es[`orgIntel.timelineKind.${kind}`]]),
    );
    expect(document.querySelector(".oi-timeline").textContent).not.toMatch(/leadership_term|payroll_snapshot/);
  });
});

// ---------------------------------------------------------------------------
// Owner 2026-09-17 decision 16.2: 12-hour clock for the US local.
//
// localeFor(lang) is the one LOCALE source and dateTimeFormat(lang, options)
// is the one CLOCK source. A new `es`/`es-US`/`en-US` literal in a
// time-printing Intl call is the same split this record closed; a raw
// Intl.DateTimeFormat with hour options is the same split one layer down,
// because it silently opts out of the h12 the helper carries. Kept as a
// sibling describe so  can append its locale-ternary coverage without
// a one-line merge on the existing static guard.
// ---------------------------------------------------------------------------
const CLOCK_TWELVE = /[ap]\.?\s*m\.?/i;
const CLOCK_TWENTY_FOUR = /(?:^|[^\d])(?:1[3-9]|2[0-3]):[0-5]\d/;
const HARD_CODED_TIME_LOCALE = /(?:new\s+Intl\.DateTimeFormat|toLocale(?:Date|Time)?String)\(\s*(?:lang\s*===\s*["']es["']\s*\?\s*["'][^"']+["']|["'](?:es-US|en-US|es|en)["'])/;
const CLOCK_INSTANT = "2026-03-04T17:05:00Z";
// A formatter can also leave the ruling without naming a locale: an explicit
// `hour12: false` or `hourCycle: "h23"/"h24"` overrides whatever localeFor
// resolved and prints 17:05 again. Banning only the locale literal caught the
// spelling this record repaired and not the one that replaces it, so both are
// named here. `h11`/`h12` stay legal: they agree with the ruling.
const FORCED_TWENTY_FOUR_HOUR = /hour12\s*:\s*false|hourCycle\s*:\s*["'](?:h23|h24)["']/;
// The helper is only the one clock source if nothing builds its own. A raw
// Intl.DateTimeFormat / toLocaleTimeString / toLocaleString whose options ask
// for an hour renders a time without the h12 dateTimeFormat() carries, which
// on plain `es` is 17:05 again. `[\s\S]{0,60}?` spans the locale argument;
// `[^{}]*?` keeps the match inside one option object.
const RAW_TIME_FORMATTER = /(?:new\s+Intl\.DateTimeFormat|\.toLocaleTimeString|\.toLocaleString)\s*\(\s*[\s\S]{0,60}?\{[^{}]*?\b(?:hour|minute|second|timeStyle|dayPeriod|fractionalSecondDigits)\s*:/;
// And the no-options spelling of the same bypass: toLocaleString(locale) means
// date AND time. Number.prototype.toLocaleString shares the name and is not a
// clock, so a line that formats a number is not a hit (RewardsView:58).
const RAW_TIME_STAMP = /\.toLocaleString\s*\(\s*localeFor\s*\(/;
// The clock helper lives in TWO files and nowhere else: src/lib/i18n/format.js
// builds the catalogue-free formatter (dateTimeFormatCore), and src/lib/i18n.js
// wraps it with the owner's long-zone-name substitution, which needs t(). The
// split exists so a React Native screen can localise a date without pulling the
// catalogue (PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917); naming
// both keeps this guard's invariant — one clock source — pointed at the files
// that actually construct a formatter. src/data holds English demo fixtures that
// never see a member language (registered in .lane/FINDINGS.md).
const CLOCK_HELPER_HOMES = new Set(["src/lib/i18n.js", "src/lib/i18n/format.js"]);
// Empty: its one entry, DuesView's English-only dues date stamp, left with
// dues (not part of Union Ground).
const CLOCK_DATE_ONLY_EXEMPTIONS = new Set([]);

function listSourceFilesRecursive(dir) {
  const root = resolve(process.cwd(), dir);
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const nextRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(`${abs}/${entry.name}`, nextRel);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".jsx")) out.push(nextRel);
    }
  };
  walk(root, dir);
  return out;
}

function clockLabel(lang, options) {
  return dateTimeFormat(lang, options).format(new Date(CLOCK_INSTANT));
}

function collapseSpaces(value) {
  return String(value || "").replace(/[\u00a0\u202f\u2007\u2009]/g, " ").replace(/\s+/g, " ").trim();
}

function hasExactCollapsedText(expected) {
  const needle = collapseSpaces(expected);
  return (_content, node) => Boolean(node) && node.children.length === 0 && collapseSpaces(node.textContent) === needle;
}

function hasCollapsedText(expected) {
  const needle = collapseSpaces(expected);
  return (_content, node) => {
    if (!node || node.children.length > 0) return false;
    const haystack = collapseSpaces(node.textContent);
    return haystack === needle || haystack.includes(needle);
  };
}

describe("Spanish times use a 12-hour US clock", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    try { window.localStorage.clear(); } catch { /* jsdom always has storage */ }
  });

  it("localeFor stays plain, dateTimeFormat carries the clock", () => {
    const utc = { timeZone: "UTC" };
    expect(localeFor("es")).toBe("es");
    expect(dateTimeFormat("es", { hour: "numeric", ...utc }).resolvedOptions().hourCycle).toBe("h12");
    expect(new Intl.DateTimeFormat(localeFor("es"), { dateStyle: "medium", ...utc }).format(new Date(CLOCK_INSTANT)))
      .toBe(new Intl.DateTimeFormat("es", { dateStyle: "medium", ...utc }).format(new Date(CLOCK_INSTANT)));
    const spanishTime = clockLabel("es", { hour: "numeric", minute: "2-digit", ...utc });
    const englishTime = clockLabel("en", { hour: "numeric", minute: "2-digit", ...utc });
    expect(spanishTime).toMatch(CLOCK_TWELVE);
    expect(spanishTime).not.toMatch(CLOCK_TWENTY_FOUR);
    expect(englishTime).toBe(new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...utc }).format(new Date(CLOCK_INSTANT)));
    expect(englishTime).not.toBe(spanishTime);
  });

  it("bans a new hard-coded time locale literal in views, components, and features", () => {
    const leftovers = [];
    for (const path of [
      ...listSourceFilesRecursive("src/views"),
      ...listSourceFilesRecursive("src/components"),
      ...listSourceFilesRecursive("src/features"),
    ]) {
      if (CLOCK_DATE_ONLY_EXEMPTIONS.has(path)) continue;
      const src = stripComments(read(path));
      if (HARD_CODED_TIME_LOCALE.test(src)) leftovers.push(path);
    }
    expect(leftovers, leftovers.join("\n")).toEqual([]);
  });

  it("bans a time formatter built outside the shared helper", () => {
    const leftovers = [];
    for (const path of [
      ...listSourceFilesRecursive("src/views"),
      ...listSourceFilesRecursive("src/components"),
      ...listSourceFilesRecursive("src/features"),
      ...listSourceFilesRecursive("src/lib"),
      "src/App.jsx",
    ]) {
      if (CLOCK_HELPER_HOMES.has(path)) continue;
      const src = stripComments(read(path));
      if (RAW_TIME_FORMATTER.test(src)) leftovers.push(`${path}: builds its own time formatter — use dateTimeFormat(lang, options)`);
      for (const line of src.split("\n")) {
        if (RAW_TIME_STAMP.test(line) && !/Number\s*\(/.test(line)) {
          leftovers.push(`${path}: toLocaleString(localeFor(lang)) renders a clock — use dateTimeFormat(lang)`);
          break;
        }
      }
    }
    expect(leftovers, leftovers.join("\n")).toEqual([]);
  });

  it("bans a formatter that forces the 24-hour clock back on", () => {
    const leftovers = [];
    for (const path of [
      ...listSourceFilesRecursive("src/views"),
      ...listSourceFilesRecursive("src/components"),
      ...listSourceFilesRecursive("src/features"),
      ...listSourceFilesRecursive("src/lib"),
    ]) {
      const src = stripComments(read(path));
      if (FORCED_TWENTY_FOUR_HOUR.test(src)) leftovers.push(path);
    }
    expect(leftovers, leftovers.join("\n")).toEqual([]);
  });

  it("Workplace log reminders render a 12-hour Spanish time and leave English unchanged", () => {
    const reminders = {
      available: true, enabled: true, cadence: "weekly", weekday: 1,
      localHour: 17, timezone: "UTC", nextDueAt: CLOCK_INSTANT,
    };
    const dueAt = (lang) => dateTimeFormat(lang, {
      dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
    }).format(new Date(CLOCK_INSTANT));
    for (const lang of ["es", "en"]) {
      const view = render(
        <LanguageProvider lang={lang}>
          <WorkloadView data={{ workload: { entries: [], stats: { enoughData: false }, reminders } }} />
        </LanguageProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["workload.tab.reminders"] }));
      expect(screen.getByText(hasCollapsedText(
        catalogue[lang]["workload.remindersNext"].replace("{date}", dueAt(lang)),
      ))).toBeInTheDocument();
      view.unmount();
    }
    expect(dueAt("es")).toMatch(CLOCK_TWELVE);
    expect(dueAt("es")).not.toMatch(CLOCK_TWENTY_FOUR);
    expect(dueAt("en")).toBe(new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
    }).format(new Date(CLOCK_INSTANT)));
  });

  it("Settings sessions render localized 12-hour Eastern times in both languages", async () => {
    const lastActiveAt = CLOCK_INSTANT;
    const sessions = [{
      handle: "a".repeat(64), deviceLabel: "windows_computer", browserLabel: "chrome",
      current: true, createdAt: CLOCK_INSTANT, lastActiveAt,
    }];
    const stamp = (lang) => `${dateTimeFormat(lang, {
      timeZone: "America/New_York",
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(lastActiveAt))} ET`;
    for (const lang of ["es", "en"]) {
      const view = render(
        <LanguageProvider lang={lang}>
          <SettingsView
            data={{ member: { initials: "MV" }, roles: [] }}
            lang={lang}
            onLoadSessions={() => Promise.resolve(sessions)}
          />
        </LanguageProvider>,
      );
      expect(screen.getByRole("heading", {
        name: catalogue[lang]["settings.sessionsTitle"],
      })).toBeInTheDocument();
      // The heading renders before onLoadSessions resolves, so waiting on it
      // would let the loading placeholder satisfy the gate. Wait on the stamp.
      await waitFor(() => expect(collapseSpaces(document.body.textContent)).toContain(collapseSpaces(
        catalogue[lang]["settings.sessionLastActive"].replace("{date}", stamp(lang)),
      )));
      view.unmount();
    }
    expect(stamp("es")).toMatch(CLOCK_TWELVE);
    expect(stamp("es")).not.toMatch(CLOCK_TWENTY_FOUR);
    expect(stamp("en")).toBe(`${new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(lastActiveAt))} ET`);
  });

  // The shared stamp helper the member screens print times through. (This
  // was pinned through the membership card's as-of stamp; Union Ground has
  // no membership card, so the helper is pinned directly.)
  it("formatDateTime stamps are 12-hour in Spanish and unchanged in English", () => {
    expect(formatDateTime(CLOCK_INSTANT, "es")).toMatch(CLOCK_TWELVE);
    expect(formatDateTime(CLOCK_INSTANT, "es")).not.toMatch(CLOCK_TWENTY_FOUR);
    expect(formatDateTime(CLOCK_INSTANT, "en")).toBe(new Date(CLOCK_INSTANT).toLocaleString("en-US", {
      dateStyle: "medium", timeStyle: "short",
    }));
    expect(formatDateTime(CLOCK_INSTANT, "es")).not.toBe(formatDateTime(CLOCK_INSTANT, "en"));
  });

  it("Tasks report Spanish dates stay date-only and English is unchanged", async () => {
    const from = "2026-03-04";
    const report = {
      from, to: "2026-03-04", totals: { total: 0, done: 0, open: 0, done_late: 0 },
      deletedCount: 0, byMonth: [], byWorkstream: [], byPerson: [],
    };
    const day = (lang) => new Intl.DateTimeFormat(localeFor(lang), {
      year: "numeric", month: "short", day: "numeric",
    }).format(new Date(`${from}T12:00:00`));
    for (const lang of ["es", "en"]) {
      const view = render(
        <TasksReport
          t={(key, vars) => translate(lang, key, vars)}
          lang={lang}
          chapterName="Harborview Care United"
          onLoadReport={async () => report}
        />,
      );
      await waitFor(() => expect(screen.getByText(translate(lang, "tasks.reportAllTime"))).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: translate(lang, "tasks.reportThisYear") }));
      await waitFor(() => expect(screen.getByText(hasCollapsedText(
        translate(lang, "tasks.reportWindow", { from: day(lang), to: day(lang) }),
      ))).toBeInTheDocument());
      expect(day(lang)).not.toMatch(CLOCK_TWENTY_FOUR);
      view.unmount();
    }
    expect(day("es")).toBe(new Intl.DateTimeFormat("es", {
      year: "numeric", month: "short", day: "numeric",
    }).format(new Date(`${from}T12:00:00`)));
    expect(day("en")).toBe(new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "short", day: "numeric",
    }).format(new Date(`${from}T12:00:00`)));
  });

  it("One-on-ones slot picker renders a 12-hour Spanish time and leaves English unchanged", async () => {
    const api = {
      stewards: vi.fn().mockResolvedValue([{ id: "st-1", name: "Sam Okafor" }]),
      slots: vi.fn().mockResolvedValue({ slots: [{ startsAt: CLOCK_INSTANT, stewardCount: 1 }] }),
    };
    const expected = (lang) => dateTimeFormat(lang, {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
    }).format(new Date(CLOCK_INSTANT));
    for (const lang of ["es", "en"]) {
      const view = render(
        <LanguageProvider lang={lang}>
          <AppointmentsView data={{ appointments: [] }} api={api} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />
        </LanguageProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["appt.request"] }));
      await waitFor(() => expect(screen.getByRole("button", {
        name: new RegExp(catalogue[lang]["appt.type.office_hours"]),
      })).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: new RegExp(catalogue[lang]["appt.type.office_hours"]) }));
      fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["appt.minutes"].replace("{minutes}", "45") }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Sam Okafor" })).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Sam Okafor" }));
      fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["appt.next"] }));
      await waitFor(() => expect(screen.getByText(hasCollapsedText(expected(lang)))).toBeInTheDocument());
      view.unmount();
    }
    expect(expected("es")).toMatch(CLOCK_TWELVE);
    expect(expected("es")).not.toMatch(CLOCK_TWENTY_FOUR);
    expect(expected("en")).toBe(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
    }).format(new Date(CLOCK_INSTANT)));
  });

  it("Events live time source is 12-hour in Spanish and unchanged in English", () => {
    const startsAt = CLOCK_INSTANT;
    const timeLabel = (lang) => dateTimeFormat(lang, {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
    }).format(new Date(startsAt));
    const dateParts = (lang) => ({
      day: new Intl.DateTimeFormat(localeFor(lang), { timeZone: "America/New_York", day: "numeric" }).format(new Date(startsAt)),
      month: new Intl.DateTimeFormat(localeFor(lang), { timeZone: "America/New_York", month: "short" }).format(new Date(startsAt)),
    });
    for (const lang of ["es", "en"]) {
      const view = render(
        <LanguageProvider lang={lang}>
          <EventsView
            data={{ events: [{
              id: "evt-clock", title: "Chapter meeting", startsAt,
              dateLabel: "Wed, Mar 4", timeLabel: timeLabel(lang),
              location: "Union hall", chapterName: "Harborview Care United",
              isPublic: false, isPublicAcrossAgencies: false, rsvpStatus: null, checkedIn: false,
            }] }}
            onRsvp={vi.fn()}
            onCheckIn={vi.fn()}
          />
        </LanguageProvider>,
      );
      expect(screen.getAllByText(hasCollapsedText(timeLabel(lang))).length).toBeGreaterThan(0);
      expect(screen.getByText(dateParts(lang).day)).toBeInTheDocument();
      expect(screen.getByText(dateParts(lang).month)).toBeInTheDocument();
      view.unmount();
    }
    expect(timeLabel("es")).toMatch(CLOCK_TWELVE);
    expect(timeLabel("es")).not.toMatch(CLOCK_TWENTY_FOUR);
    expect(timeLabel("en")).toBe(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
    }).format(new Date(startsAt)));
  });

  it("admin login inbox renders a 12-hour Spanish time and names the zone in both languages", () => {
    const occurredAt = CLOCK_INSTANT;
    const inbox = {
      openLast24Hours: 1, attentionThreshold: 5,
      items: [{
        id: "30000000-0000-4000-8000-000000000003",
        memberName: "Former participant", memberReference: "A1B2C3",
        method: "password", source: "web-saas", userAgent: "Test Browser/1.0",
        status: "open", dispositionNote: null, occurredAt, reviewedAt: null,
      }],
    };
    //: the inbox prints the moment with its zone and no seconds.
    const stamp = (lang) => formatGroupMoment(occurredAt, lang);
    const configuration = { settings: [], labelKeys: [], labelOverrides: {} };
    const api = {
      updateOrganizationSetting: vi.fn(),
      updateOrganizationLabel: vi.fn(),
      loadFailedLoginInbox: vi.fn().mockResolvedValue(inbox),
      dispositionFailedLoginAttempt: vi.fn(),
    };
    for (const lang of ["es", "en"]) {
      const view = render(
        <LanguageProvider lang={lang}>
          <AdminSecurityConfiguration
            configuration={configuration}
            failedLoginInbox={inbox}
            api={api}
            reload={vi.fn()}
            onNotice={vi.fn()}
          />
        </LanguageProvider>,
      );
      expect(screen.getByText(hasCollapsedText(stamp(lang)))).toBeInTheDocument();
      view.unmount();
    }
    expect(stamp("es")).toMatch(CLOCK_TWELVE);
    expect(stamp("es")).not.toMatch(CLOCK_TWENTY_FOUR);
    for (const lang of ["es", "en"]) {
      expect(stamp(lang)).toMatch(/ E[SD]T$/u);
      expect(stamp(lang)).not.toMatch(/\d:\d{2}:\d{2}/u);
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-09-17 QA chrome register (UX-UG-QA-CHROME-REGISTER-SPLIT-20260917).
//
// src/features/qa/copy.js used to be a private EN/ES catalogue written in
// usted, invisible to the views/components scan above. The chrome now lives
// in the main catalogue under qa.* in the tú register; copy.js only forwards
// to t(). This sibling describe walks src/features itself so a new private
// en:/es: copy module fails CI. It does not edit the scan roots or describes
// above, so it composes with PRs,  and  (each appends its own
// describe) and with the sibling features-copy lane.
// ---------------------------------------------------------------------------
//
// TEMPORARY SKIP. src/features/analytics still ships private en:/es: LABELS and
// COPY objects (AnalyticsCoreDesk.jsx, AnalyticsParityPanels.jsx,
// MemberReportCard.jsx). They belong to the parallel lane
// UX-UG-FEATURE-COPY-HELPERS-AND-DUES-LOCALE-20260917, which folds them
// into the catalogue. DELETE QA_FEATURE_COPY_SKIP and this note once that PR
// merges — the guard is blind to a whole feature directory until then, and the
// test below asserts the skip stays minimal so the blind spot cannot grow.
// ---------------------------------------------------------------------------
const QA_FEATURE_COPY_SKIP = new Set(["analytics"]);

// Usted pronouns and formal imperatives live in tests/i18nRegisterMarkers.js.
// `\b` is ASCII-only, so that module matches on a Unicode letter class:
// `\bdé\b` never matches `Dé los hechos…`.

describe("QA chrome lives in the catalogue tú register", () => {
  it("carries the former private QA chrome under qa.* in both locales", () => {
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("qa."));
    expect(keys.length, "qa.* has no keys").toBeGreaterThanOrEqual(50);
    // Union Ground's organizing copy: a campaign and its committee answer.
    expect(catalogue.en["qa.sub"]).toBe("Ask your campaign. A committee member posts the official reply.");
    expect(catalogue.es["qa.sub"]).toBe("Pregunta a tu campaña. Un miembro del comité publica la respuesta oficial.");
    expect(catalogue.es["qa.sub"]).toMatch(/\btu\b/);
    expect(catalogue.es["qa.sub"]).not.toMatch(QA_USTED_MARKERS);
    expect(catalogue.en).not.toHaveProperty("qa.saved");
    expect(catalogue.es).not.toHaveProperty("qa.saved");
    for (const key of keys) {
      expect(typeof catalogue.es[key], `${key} es missing`).toBe("string");
      expect(catalogue.es[key].trim().length, `${key} es empty`).toBeGreaterThan(0);
      expect(catalogue.es[key], `${key} still uses usted`).not.toMatch(QA_USTED_MARKERS);
    }
  });

  it("carries a distinct sign-in and revoked-membership string per locale", () => {
    // UX-UG-QA-SIGNED-OUT-AND-REVOKED-GATES-READ-AS-AN-OUTAGE-20260920: the
    // two gate strings are new keys, so the half-added failure mode this block
    // exists for is exactly the one they can hit. Both must be present, in the
    // tú register, and distinct from the outage notice they used to share.
    for (const locale of ["en", "es"]) {
      for (const key of ["qa.signInRequired", "qa.membershipRevoked"]) {
        expect(typeof catalogue[locale][key], `${key} ${locale} missing`).toBe("string");
        expect(catalogue[locale][key].trim().length, `${key} ${locale} empty`).toBeGreaterThan(0);
        expect(catalogue[locale][key], `${key} ${locale} still reads as an outage`)
          .not.toBe(catalogue[locale]["qa.unavailable"]);
        expect(catalogue[locale][key], `${key} ${locale} duplicates the membership prompt`)
          .not.toBe(catalogue[locale]["qa.membershipRequired"]);
      }
      expect(catalogue[locale]["qa.signInRequired"]).not.toBe(catalogue[locale]["qa.membershipRevoked"]);
    }
    expect(catalogue.es["qa.signInRequired"]).not.toMatch(QA_USTED_MARKERS);
    expect(catalogue.es["qa.membershipRevoked"]).not.toMatch(QA_USTED_MARKERS);
  });

  it("forwards QA chrome through t() instead of a private en/es catalogue", () => {
    const src = stripComments(read("src/features/qa/copy.js"));
    // The barrel or one of its namespace chunks — both are the same register.
    // copy.js reaches src/lib/i18n/qa.js so the native bundle does not carry
    // the whole catalogue (PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917).
    expect(src).toMatch(/from ["']\.\.\/\.\.\/lib\/i18n(?:\/qa)?\.js["']/);
    expect(src).toMatch(/t\(lang,\s*`qa\.\$\{key\}`/);
    expect(src).not.toMatch(/\ben\s*:\s*\{/);
    expect(src).not.toMatch(/\bes\s*:\s*\{/);
    expect(src).not.toMatch(/Changes saved/);
  });

  it("fails CI when a private EN/ES copy module reappears under src/features", async () => {
    // The blind spot is one directory wide and is meant to close, not grow:
    // widening it (or forgetting to delete it after the analytics lane lands)
    // fails here rather than passing silently.
    expect([...QA_FEATURE_COPY_SKIP]).toEqual(["analytics"]);
    const { readdirSync, readFileSync: readSource } = await import("node:fs");
    const { join, resolve: resolvePath } = await import("node:path");
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (QA_FEATURE_COPY_SKIP.has(entry.name)) continue;
          walk(join(dir, entry.name));
          continue;
        }
        if (/\.(js|jsx)$/.test(entry.name)) files.push(join(dir, entry.name));
      }
    };
    walk(resolvePath(process.cwd(), "src/features"));
    // Both orders: an `es:` block declared before `en:` escaped the single
    // ordered regex this guard shipped with.
    const privateCatalogues = files.filter((file) => {
      const source = stripComments(readSource(file, "utf8"));
      return /\ben\s*:\s*\{/.test(source) && /\bes\s*:\s*\{/.test(source);
    });
    expect(
      privateCatalogues,
      `private EN/ES copy module under src/features — move chrome into src/lib/i18n.js: ${privateCatalogues.join(", ")}`,
    ).toEqual([]);
  });

  it("renders Member Q&A in Spanish in one tú register, including the save notice", async () => {
    const { buildQaActor } = await import("../src/lib/mi1QaWiring.js");
    const { createInMemoryQaStore, createQaStoreAdapter } = await import("../src/features/qa/index.js");
    const { MemberQaView } = await import("../src/views/MemberQaView.jsx");
    const actor = buildQaActor({
      userId: "preview-member",
      organizationId: "preview-qa-organization",
      chapterId: "preview-chapter",
      mfaSatisfied: true,
    });
    const api = createQaStoreAdapter(createInMemoryQaStore(), actor);
    render(
      <LanguageProvider lang="es">
        <MemberQaView lang="es" actor={actor} client={null} api={api} />
      </LanguageProvider>,
    );

    expect(await screen.findByRole("heading", { name: catalogue.es["qa.title"] })).toBeInTheDocument();
    expect(screen.getByText(catalogue.es["qa.sub"])).toBeInTheDocument();
    expect(screen.getByText(catalogue.es["qa.empty"])).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(QA_USTED_MARKERS);

    fireEvent.click(screen.getByRole("button", { name: catalogue.es["qa.askTitle"] }));
    fireEvent.change(screen.getByLabelText(catalogue.es["qa.titleLabel"]), {
      target: { value: "When is the next chapter meeting?" },
    });
    fireEvent.change(screen.getByLabelText(catalogue.es["qa.bodyLabel"]), {
      target: { value: "I want to confirm the date and location for the next chapter meeting." },
    });
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["qa.post"] }));

    expect(await screen.findByText("Cambios guardados.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(QA_USTED_MARKERS);
    expect(screen.queryByText(/\busted\b/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2026-09-17: src/features copy helpers and DuesView locale
// (UX-UG-FEATURE-COPY-HELPERS-AND-DUES-LOCALE-20260917).
//
// Sibling describes from PRs  /  /  append after the Weingarten
// block as well; this block is self-contained (own walker, no new top-level
// imports, no edits to existing scan roots) so those land without a one-line
// merge on this file. Object-literal EN/ES catalogues under src/features/qa
// are a sibling lane and are not flagged here.
// ---------------------------------------------------------------------------
const FEATURE_COPY_REPAIR_FILES = [
  "src/features/automation/ConnectedAutomationPages.jsx",
  "src/features/automation/AutomationGuidedBuilder.jsx",
  "src/features/automation/AutomationDiscover.jsx",
  "src/features/automation/AutomationRecipeLibrary.jsx",
  "src/features/automation/AutomationReviewPanel.jsx",
  "src/features/analytics/ui/AnalyticsCoreDesk.jsx",
  // The seven modules the first pass left on the ratchet, repaired by
  // UX-UG-FEATURE-COPY-REMAINING-SEVEN-MODULES-20260917.
  "src/features/automation/AutomationWorkflowLink.jsx",
  "src/features/automation/automationUiLabels.js",
  "src/features/integrations/IntegrationControlPlane.jsx",
  "src/features/knowledge/KnowledgeWorkspacePanel.jsx",
  "src/features/operations/AuditLogPanel.jsx",
  "src/features/operations/JobHealthPanel.jsx",
  "src/features/accessHistory/ui/AccessHistory.jsx",
];

// Modules a copy-helper record has not repaired yet. This is a RATCHET, not an
// exemption list: each entry records the EXACT shape still outstanding, and the
// walker fails when a listed file's shape moves in either direction — a new
// offence of any kind fails as a defect, and a repaired file fails until its
// entry is deleted, so the list can only shrink. The `c(en, es)` helper is
// banned everywhere, listed or not; it is the one shape no file may
// reintroduce.
//
// The list is EMPTY as of
// UX-UG-FEATURE-COPY-REMAINING-SEVEN-MODULES-20260917: the last seven
// entries moved into FEATURE_COPY_REPAIR_FILES above. It stays here, empty, so
// the walker below keeps its shape and a future module that needs a staged
// repair has somewhere to be recorded — and so an entry can never be added for
// a module that is already repaired.
const FEATURE_COPY_REMAINING = new Map([]);

// The helper is banned by SHAPE, not by the name it was given: renaming
// `c(en, es)` to `pick(en, es)` is the same defect with a different label. The
// language comparison in the BODY is what makes it one, which is also what
// keeps `const text = (en, es) => ({ en, es })` in recipes.js out of the ban —
// that builds a bilingual DATA object the caller indexes by lang, and never
// decides which language to speak.
const FEATURE_COPY_HELPER =
  /(?:const|let|var)\s+[\w$]+\s*=\s*\(\s*en\s*,\s*es\s*\)\s*=>[^;\n]*(?:lang|locale|Lang|Locale)\s*(?:===|!==|==|!=)\s*["'](?:en|es)["']/;
const FEATURE_HOISTED_FLAG = /(?:const|let|var)\s+[\w$]+\s*=\s*[\w$.]*(?:lang|locale|Lang|Locale)\s*(?:===|!==|==|!=)\s*["'](?:en|es)["']\s*[;,\n]/;
const FEATURE_COPY_MAP = /COPY\[\s*(?:lang|locale)\s*===\s*["']es["']/;
const FEATURE_COPY_TERNARY = /(?:\blang|\blocale|Lang|Locale)\s*(?:===|!==|==|!=)\s*["'](?:en|es)["']\s*\?\s*(?:`[^`]*`|["'][^"']+["'])/;
const FEATURE_LOCALE_OR_LANG_NAME = /\?\s*["'](?:es|en|es-US|en-US|es_US|en_US|Español|English|Inglés|Spanish)["']/;

describe("src/features copy helpers route through the catalogue", () => {
  async function listFeatureFiles() {
    const { readdirSync } = await import("node:fs");
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "qa") continue;
          walk(path);
        } else if (entry.name.endsWith(".js") || entry.name.endsWith(".jsx")) {
          files.push(path);
        }
      }
    };
    walk("src/features");
    return files;
  }

  function copyTernaryHits(src) {
    const hits = [];
    const scan = new RegExp(FEATURE_COPY_TERNARY.source, "g");
    let match = scan.exec(src);
    while (match) {
      if (!FEATURE_LOCALE_OR_LANG_NAME.test(match[0])) hits.push(match[0]);
      match = scan.exec(src);
    }
    return hits;
  }

  for (const path of FEATURE_COPY_REPAIR_FILES) {
    it(`${path} does not pick copy with a helper, hoisted flag, COPY map or ternary`, () => {
      const src = stripComments(read(path));
      expect(src, `${path} still defines c(en, es)`).not.toMatch(FEATURE_COPY_HELPER);
      expect(src, `${path} hoists a language flag — use t()`).not.toMatch(FEATURE_HOISTED_FLAG);
      expect(src, `${path} reads COPY[lang === "es"] — use t()`).not.toMatch(FEATURE_COPY_MAP);
      expect(copyTernaryHits(src), `${path} still has a copy ternary`).toEqual([]);
    });
  }

  it("covers the moved feature and dues keys in both locales", () => {
    const expected = {
      "automation.discover.heroTitle": [
        "Make routine follow-up dependable",
        "Haz que el seguimiento rutinario sea confiable",
      ],
      "clause.quickref.title": ["Contract clauses", "Cláusulas del contrato"],
      "clause.quickref.searchFallback": [
        "Search this organization's published language.",
        "Busca el lenguaje publicado de esta organización.",
      ],
      "analytics.title": ["Organization analytics", "Analítica de la organización"],
      "analytics.mfaRequired": [
        "Complete two-step sign-in, then retry organization analytics.",
        "Completa el inicio de sesión en dos pasos y vuelve a intentar la analítica.",
      ],
    };
    for (const [key, [en, es]] of Object.entries(expected)) {
      expect(catalogue.en[key], key).toBe(en);
      expect(catalogue.es[key], key).toBe(es);
    }
    // Union Ground leaves dues out (owner decision): the dues workspace,
    // its Stripe setup and its reminder job carry no copy in either language.
    for (const lang of ["en", "es"]) {
      expect(Object.keys(catalogue[lang]).filter((key) => /^dues\.|(^|\.)dues_|[Dd]ues$|topicDues/.test(key)), lang).toEqual([]);
    }
    expect(catalogue.es["clause.quickref.searchFallback"]).toMatch(/^Busca /);
    expect(catalogue.es["analytics.mfaRequired"]).toMatch(/^Completa /);
    expect(catalogue.es["analytics.mfaRequired"]).toMatch(/vuelve /);
  });

  it("localizes case history structured values in the tu register", () => {
    const expected = {
      "caseHistory.value.status.active": ["Active", "Activo"],
      "caseHistory.value.status.missed": ["Missed", "Vencido"],
      "caseHistory.value.kind.hearing": ["Hearing", "Audiencia"],
      "caseHistory.value.kind.follow_up": ["Follow-up", "Seguimiento"],
      "caseHistory.value.band.needs_evidence": ["Needs evidence", "Necesita evidencia"],
      "caseHistory.value.factor.contract_support": ["Policy or law support", "Respaldo en política o ley"],
      "caseHistory.value.recommendation.review_deadlines": ["Review deadlines", "Revisa los plazos"],
      "caseHistory.value.recommendation.confirm_contract_support": ["Confirm policy or law support", "Confirma el respaldo en política o ley"],
      "caseHistory.yes": ["Yes", "Sí"],
      "caseHistory.none": ["None", "Ninguno"],
    };
    for (const [key, [en, es]] of Object.entries(expected)) {
      expect(catalogue.en[key], key).toBe(en);
      expect(catalogue.es[key], key).toBe(es);
      expect(catalogue.es[key], `${key} formal register`).not.toMatch(/\b(usted|ustedes)\b/i);
    }
    const valueKeys = Object.keys(catalogue.en).filter((key) => key.startsWith("caseHistory.value."));
    expect(valueKeys.length).toBeGreaterThanOrEqual(Object.keys(expected).length);
    for (const key of valueKeys) {
      expect(typeof catalogue.es[key], key).toBe("string");
      expect(catalogue.es[key].trim().length, key).toBeGreaterThan(0);
    }
  });

  function featureCopyShape(src) {
    return {
      hoistedFlag: FEATURE_HOISTED_FLAG.test(src),
      copyMap: FEATURE_COPY_MAP.test(src),
      ternaries: copyTernaryHits(src).length,
    };
  }

  it("walks src/features so a new copy helper, hoisted flag or COPY map fails CI", async () => {
    const leftovers = [];
    const seen = new Set();
    for (const path of await listFeatureFiles()) {
      const src = stripComments(read(path));
      // Banned everywhere, including in the not-yet-repaired modules.
      if (FEATURE_COPY_HELPER.test(src)) leftovers.push(`${path}: (en, es) copy helper`);
      const shape = featureCopyShape(src);
      const recorded = FEATURE_COPY_REMAINING.get(path);
      if (recorded) {
        seen.add(path);
        // Both directions fail. More than was recorded is a new defect in a
        // module that already owed a repair; less than was recorded means the
        // module was repaired and its entry has to come off this list.
        if (shape.hoistedFlag !== recorded.hoistedFlag || shape.copyMap !== recorded.copyMap
          || shape.ternaries !== recorded.ternaries) {
          leftovers.push(
            `${path}: FEATURE_COPY_REMAINING records ${JSON.stringify(recorded)} but the file now has `
            + `${JSON.stringify(shape)} — add the new offence to the repair, or drop the entry if it is fixed`,
          );
        }
        continue;
      }
      if (shape.hoistedFlag) leftovers.push(`${path}: hoisted language flag`);
      if (shape.copyMap) leftovers.push(`${path}: COPY[lang === "es"]`);
      for (const hit of copyTernaryHits(src)) leftovers.push(`${path}: ${hit}`);
    }
    // A path that no longer exists (renamed or deleted) must leave the list too.
    for (const path of FEATURE_COPY_REMAINING.keys()) {
      if (!seen.has(path)) leftovers.push(`${path}: listed as remaining but no longer walked — drop the entry`);
    }
    expect(leftovers, leftovers.join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2026-09-17: the seven modules the first copy-helper pass left on the ratchet
// (UX-UG-FEATURE-COPY-REMAINING-SEVEN-MODULES-20260917).
//
// The ratchet above already fails if one of the seven reintroduces a COPY map,
// a hoisted language flag or a copy ternary. What it cannot see is whether the
// copy those modules used to hold SURVIVED the move: a key that was renamed,
// dropped or translated differently would leave the walker green and the screen
// wrong. The cases below pin the exact strings both locales rendered before the
// move, and pin the provider catalog — which still owns the English label and
// setup summary as data — to the English catalogue entries that now render it.
//
// Self-contained on purpose: its own describe, dynamic imports, no new
// top-level import, so sibling lanes append after it without a merge.
// ---------------------------------------------------------------------------
const MOVED_FEATURE_COPY = {
  "automation.workflowLink": ["Automate this workflow", "Automatizar este flujo"],
  "automation.condition.needs_review": ["Needs review", "Necesita revisión"],
  "automation.condition.no_show": ["No-show", "Ausencia"],
  "automation.conditionUnavailable": ["Condition unavailable", "Condición no disponible"],
  "accessHistory.rangeLegend": ["Range", "Periodo"],
  "accessHistory.range30": ["Last 30 days", "Últimos 30 días"],
  "accessHistory.range365": ["Last year", "Último año"],
  "accessHistory.retryAction": ["Try again", "Reintentar"],
  "accessHistory.loadingBody": [
    "Loading who accessed your records.",
    "Cargando el historial de acceso.",
  ],
  "operations.jobHealth.title": [
    "Background job health",
    "Estado de tareas en segundo plano",
  ],
  "operations.jobHealth.neverRunLabel": ["Never run", "Nunca ejecutado"],
  "operations.jobHealth.requestRetry": [
    "Record retry request",
    "Registrar solicitud de reintento",
  ],
  "operations.audit.title": [
    "Organization audit log",
    "Registro de auditoría de la organización",
  ],
  "operations.audit.system": ["System", "Sistema"],
  "operations.audit.timeUnavailable": ["Time unavailable", "Hora no disponible"],
  "knowledge.title": ["Knowledge workspace", "Espacio de conocimiento"],
  "knowledge.empty": ["Nothing has been added yet.", "Todavía no hay contenido."],
  "knowledge.driveLimit": [
    "Drive uploads from this screen are limited to 3 MB.",
    "Las cargas a Drive tienen un límite de 3 MB.",
  ],
  //  renames the plane and the unset status in plain words.
  "integrations.plane": ["Integrations", "Integraciones"],
  "integrations.status.unset": ["Not set up", "Sin configurar"],
  "integrations.jobKind.sms_consent": ["SMS consent update", "Cambio de consentimiento SMS"],
  // The dues_notice purpose left with the dues copy; policy_notice is the
  // moved purpose Union Ground still offers.
  "integrations.smsPurpose.policy_notice": ["Policy notice", "Aviso de política"],
  "integrations.error.events": [
    "Pick at least one supported webhook event.",
    "Selecciona al menos un evento de webhook compatible.",
  ],
  "integrations.smsUnavailableSub": [
    "SMS requires a connected, enabled provider for this organization.",
    "SMS requiere un proveedor conectado y activado para esta organización.",
  ],
  "integrations.scimPublicMessage": [
    "Let your identity provider (Okta, Microsoft Entra ID or Google) invite, update and deprovision workers over SCIM 2.0. It stays off until an organization admin turns it on.",
    "Permite que tu proveedor de identidad (Okta, Microsoft Entra ID o Google) invite, actualice y retire trabajadores mediante SCIM 2.0. Permanece apagado hasta que una persona administradora de la organización lo active.",
  ],
};

describe("the last seven feature copy modules read the catalogue", () => {
  it("carries every moved string in both locales, unchanged", () => {
    for (const [key, [en, es]] of Object.entries(MOVED_FEATURE_COPY)) {
      expect(catalogue.en[key], key).toBe(en);
      expect(catalogue.es[key], key).toBe(es);
    }
  });

  it("keeps the integration provider catalog and its English catalogue entries in step", async () => {
    const { INTEGRATION_PROVIDER_CATALOG } = await import("../src/features/integrations/catalog.js");
    // Union Ground has no Stripe dues entry, so every catalogue entry is
    // rendered and needs copy in both languages.
    const rendered = Object.values(INTEGRATION_PROVIDER_CATALOG);
    expect(rendered.filter((entry) => entry.setupSurface === "dues")).toEqual([]);
    expect(rendered.length).toBeGreaterThan(0);
    for (const entry of rendered) {
      expect(catalogue.en[`integrations.provider.${entry.id}.label`], entry.id).toBe(entry.label);
      expect(catalogue.en[`integrations.provider.${entry.id}.summary`], entry.id)
        .toBe(entry.setupSummary);
      expect(catalogue.es[`integrations.provider.${entry.id}.label`], entry.id).toBeTruthy();
      expect(catalogue.es[`integrations.provider.${entry.id}.summary`], entry.id).toBeTruthy();
    }
  });

  it("labels an automation condition, and an unknown one, from the catalogue", async () => {
    const { automationConditionLabel } = await import("../src/features/automation/automationUiLabels.js");
    expect(automationConditionLabel("needs_review", "es")).toBe("Necesita revisión");
    expect(automationConditionLabel("needs_review", "en")).toBe("Needs review");
    expect(automationConditionLabel("not_a_condition", "es")).toBe("Condición no disponible");
  });

  it("renders the Spanish access history chrome from the catalogue", async () => {
    const { AccessHistory } = await import("../src/features/accessHistory/ui/AccessHistory.jsx");
    render(
      <LanguageProvider lang="es">
        <AccessHistory lang="es" presentation={{ state: "loading", events: [] }} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("group", { name: "Periodo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Últimos 30 días" })).toBeInTheDocument();
    expect(screen.getByText("Cargando el historial de acceso.")).toBeInTheDocument();
  });

  it("renders the Spanish job health panel from the catalogue", async () => {
    const { JobHealthPanel } = await import("../src/features/operations/JobHealthPanel.jsx");
    render(
      <LanguageProvider lang="es">
        <JobHealthPanel
          state="ready"
          jobs={[{ jobName: "digest", title: "Digest", health: "never_run", remediations: [] }]}
        />
      </LanguageProvider>,
    );
    expect(screen.getByRole("heading", { name: "Estado de tareas en segundo plano" })).toBeInTheDocument();
    expect(screen.getByText(/Nunca ejecutado/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2026-09-21: MemberOperations.jsx English-only copy
// (UX-UG-MEMBEROPERATIONS-JSX-IS-ENTIRELY-ENGLISH-ONLY-HARDCODED-COPY-AND-IS-INVISIBLE-TO-20260921).
//
// The static lists above ban locale literals, copy ternaries, and private EN/ES
// modules. MemberOperations.jsx had none of those — it was an entire English
// render layer with no catalogue read, so it never entered the ratchet. This
// sibling describe walks src/features/**/*.jsx and fails a file that still
// renders user copy without reading the catalogue. It sits after the other
// src/features copy describes.
// ---------------------------------------------------------------------------
const MEMBER_OPERATIONS_SURFACE = "src/features/memberOperations/MemberOperations.jsx";

// Feature files that still render user copy without a catalogue read. This is a
// RATCHET: a new offence fails, and a repaired file fails until its entry is
// deleted, so the list can only shrink. MemberOperations.jsx is not listed —
// it is the file this record repaired.
const FEATURE_NO_CATALOGUE_COPY_REMAINING = new Set([
  "src/features/analytics/ui/AnalyticsParityPanels.jsx",
  "src/features/analytics/ui/MemberReportCard.jsx",
]);

const FEATURE_CATALOGUE_READ =
  /\buseLang\s*\(|from\s+["'][^"']*LanguageContext|from\s+["'][^"']*\/i18n(?:\/[\w-]+)?\.js["']|\bt\s*\(\s*["'`]/;
const FEATURE_USER_COPY_LITERAL = /["'`][A-Z][A-Za-z][^"'`]{6,}["'`]/;
const FEATURE_USER_COPY_JSX_TEXT = />\s*[A-Z][A-Za-z][^<>{]{6,}/;

function featureFileRendersUserCopy(src) {
  return FEATURE_USER_COPY_LITERAL.test(src) || FEATURE_USER_COPY_JSX_TEXT.test(src);
}

describe("MemberOperations copy lives in the catalogue", () => {
  const memberOpsKeys = () => Object.keys(catalogue.en).filter((key) => key.startsWith("memberOperations."));

  it("covers memberOperations.* in both locales in the tú register", () => {
    const keys = memberOpsKeys();
    expect(keys.length, "memberOperations.* has no keys").toBeGreaterThanOrEqual(80);
    expect(catalogue.en["memberOperations.state.loading"]).toBe("Loading worker operations…");
    expect(catalogue.es["memberOperations.state.loading"]).toBe("Cargando operaciones de trabajadores…");
    expect(catalogue.en["memberOperations.profileLabels.memberNumber"]).toBe("Worker number");
    expect(catalogue.es["memberOperations.profileLabels.memberNumber"]).toBe("Número de trabajador");
    expect(catalogue.en["memberOperations.profileLabels.jobTitle"]).toBe("Job title");
    expect(catalogue.es["memberOperations.profileLabels.jobTitle"]).toBe("Puesto de trabajo");
    expect(catalogue.en["memberOperations.languageName.notSet"]).toBe("Not set");
    expect(catalogue.es["memberOperations.languageName.notSet"]).toBe("Sin definir");
    expect(catalogue.es["memberOperations.directory.editorEmpty"]).toMatch(/^Selecciona /);
    expect(catalogue.es["memberOperations.state.mfaRequired"]).toMatch(/^Completa /);
    for (const key of keys) {
      expect(typeof catalogue.es[key], `${key} es missing`).toBe("string");
      expect(catalogue.es[key].trim().length, `${key} es empty`).toBeGreaterThan(0);
      expect(catalogue.es[key], `${key} still uses usted`).not.toMatch(/\busted(?:es)?\b/i);
    }
  });

  it("reads MemberOperations.jsx through useLang()/t() instead of English literals", () => {
    const src = stripComments(read(MEMBER_OPERATIONS_SURFACE));
    expect(src, `${MEMBER_OPERATIONS_SURFACE} does not call useLang()`).toMatch(/useLang\s*\(/);
    expect(src).toMatch(/t\("memberOperations\./);
    expect(src, `${MEMBER_OPERATIONS_SURFACE} still hardcodes PROFILE_LABELS English copy`)
      .not.toMatch(/PROFILE_LABELS\s*=/);
    expect(src, `${MEMBER_OPERATIONS_SURFACE} still hardcodes loading copy`)
      .not.toMatch(/Loading member operations/);
    expect(src, `${MEMBER_OPERATIONS_SURFACE} still hardcodes Worker number`)
      .not.toMatch(/["']Worker number["']/);
    expect(src, `${MEMBER_OPERATIONS_SURFACE} still hardcodes Job title`)
      .not.toMatch(/["']Job title["']/);
    expect(src, `${MEMBER_OPERATIONS_SURFACE} still hardcodes Not set`)
      .not.toMatch(/["']Not set["']/);
  });

  it("fails CI when a src/features JSX file renders user copy with no catalogue read", async () => {
    const leftovers = [];
    const seen = new Set();
    for (const path of listSourceFilesRecursive("src/features").filter((file) => file.endsWith(".jsx"))) {
      const src = stripComments(read(path));
      const readsCatalogue = FEATURE_CATALOGUE_READ.test(src);
      const rendersCopy = featureFileRendersUserCopy(src);
      if (FEATURE_NO_CATALOGUE_COPY_REMAINING.has(path)) {
        seen.add(path);
        if (readsCatalogue || !rendersCopy) {
          leftovers.push(
            `${path}: FEATURE_NO_CATALOGUE_COPY_REMAINING records an English-only render, but the file `
            + `now ${readsCatalogue ? "reads the catalogue" : "no longer renders user copy"} — drop the entry`,
          );
        }
        continue;
      }
      if (rendersCopy && !readsCatalogue) {
        leftovers.push(`${path}: renders user copy with no catalogue read — move chrome into src/lib/i18n.js`);
      }
    }
    for (const path of FEATURE_NO_CATALOGUE_COPY_REMAINING) {
      if (!seen.has(path)) leftovers.push(`${path}: listed as remaining but no longer walked — drop the entry`);
    }
    expect(leftovers, leftovers.join("\n")).toEqual([]);
  });

  const memberOpsActor = {
    userId: "11111111-1111-4111-8111-111111111111",
    selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
    membershipStatus: "active",
    selectedHat: "admin",
    organizationRoles: ["admin"],
    mfaSatisfied: true,
  };
  const memberOpsWorkspace = {
    state: "ready",
    organizationId: memberOpsActor.selectedOrganizationId,
    deliveryConfigured: false,
    directory: {
      items: [{
        userId: "33333333-3333-4333-8333-333333333333",
        fullName: "Avery Brooks",
        initials: "AB",
        chapterId: "bos",
        chapterName: "Boston",
        version: 2,
        profile: { department: "Nursing" },
      }],
      nextCursor: null,
    },
    campaigns: [],
    imports: [],
  };

  function renderMemberOperations(lang, snapshot = memberOpsWorkspace) {
    const client = {
      rpc: vi.fn(async (name) => ({
        data: name === "get_member_operations_workspace" ? snapshot : { updated: true },
        error: null,
      })),
    };
    return render(
      <LanguageProvider lang={lang}>
        <MemberOperationsSurface actor={memberOpsActor} client={client} />
      </LanguageProvider>,
    );
  }

  let MemberOperationsSurface;

  beforeEach(async () => {
    if (!MemberOperationsSurface) {
      ({ MemberOperations: MemberOperationsSurface } = await import(
        "../src/features/memberOperations/MemberOperations.jsx"
      ));
    }
  });

  it("renders the member-operations surface in Spanish and leaves English unchanged", async () => {
    const englishLeftovers = [
      /Loading member operations/,
      /Worker number/,
      /Job title/,
      /\bNot set\b/,
    ];

    const es = renderMemberOperations("es");
    expect(await screen.findByRole("heading", { name: catalogue.es["memberOperations.directory.title"] })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: catalogue.es["memberOperations.title"] })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Avery Brooks/ }));
    expect(await screen.findByLabelText(catalogue.es["memberOperations.profileLabels.memberNumber"])).toBeInTheDocument();
    expect(screen.getByLabelText(catalogue.es["memberOperations.profileLabels.jobTitle"])).toBeInTheDocument();
    expect(screen.getByRole("option", { name: catalogue.es["memberOperations.languageName.notSet"] })).toBeInTheDocument();
    const esText = document.body.textContent;
    for (const leftover of englishLeftovers) {
      expect(esText, `Spanish surface still contains ${leftover}`).not.toMatch(leftover);
    }
    es.unmount();

    const en = renderMemberOperations("en");
    expect(await screen.findByRole("heading", { name: catalogue.en["memberOperations.directory.title"] })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: catalogue.en["memberOperations.title"] })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Avery Brooks/ }));
    expect(await screen.findByLabelText(catalogue.en["memberOperations.profileLabels.memberNumber"])).toBeInTheDocument();
    expect(screen.getByLabelText(catalogue.en["memberOperations.profileLabels.jobTitle"])).toBeInTheDocument();
    expect(screen.getByRole("option", { name: catalogue.en["memberOperations.languageName.notSet"] })).toBeInTheDocument();
    expect(screen.queryByText(catalogue.es["memberOperations.directory.title"])).toBeNull();
    expect(screen.queryByLabelText(catalogue.es["memberOperations.profileLabels.memberNumber"])).toBeNull();
    en.unmount();
  });

  it("renders the loading status from the catalogue in Spanish", async () => {
    const { MemberOperations } = await import("../src/features/memberOperations/MemberOperations.jsx");
    const client = { rpc: vi.fn(() => new Promise(() => {})) };
    render(
      <LanguageProvider lang="es">
        <MemberOperations actor={memberOpsActor} client={client} />
      </LanguageProvider>,
    );
    expect(await screen.findByText(catalogue.es["memberOperations.state.loading"])).toBeInTheDocument();
    expect(screen.queryByText(/Loading member operations/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2026-09-21 case-tools clock (UX-UG-CASE-TOOLS-CLOCK-IGNORES-APP-LANGUAGE-20260920).
//
// CaseworkOperationsPanel used to stamp every transition, deadline, alert,
// management, reminder, extension and score time with zero-argument
// Date.toLocaleString, so a Spanish session on an English-locale browser
// printed English order and clock syntax. The repo-wide RAW_TIME_STAMP guard
// only matches toLocaleString(localeFor(…)), so this sibling describe owns
// this component only: it bans the zero-argument Date spelling here and
// proves both language/runtime crossings render dateTimeFormat(lang) on
// every stamped surface (transition, deadline, extension, management,
// addendum, retaliation, reminder).
// Number.prototype.toLocaleString elsewhere is not scanned.
// ---------------------------------------------------------------------------
const CASE_TOOLS_CLOCK_INSTANTS = {
  transition: "2026-03-04T17:05:00Z",
  deadline: "2026-04-11T13:20:00Z",
  extension: "2026-05-18T21:40:00Z",
  management: "2026-06-09T08:15:00Z",
  addendum: "2026-07-22T19:50:00Z",
  retaliation: "2026-08-15T14:30:00Z",
  reminder: "2026-09-27T11:00:00Z",
};
const CASE_TOOLS_PANEL_SOURCE = "src/components/CaseworkOperationsPanel.jsx";
const CASE_TOOLS_ZERO_ARG_DATE_STAMP = /new Date\([^)]*\)\.toLocaleString\(\s*\)/;
const CASE_TOOLS_ZERO_ARG_TO_LOCALE = /\.toLocaleString\s*\(\s*\)/;

function caseToolsClockPayload() {
  return {
    scope: { id: "case-1", organization_id: "org-1", chapter_id: "ch-1", step: "Intake", status: "active", is_restricted: false },
    strength: [],
    deadlines: [{
      id: "deadline-1",
      label: "File response",
      due_at: CASE_TOOLS_CLOCK_INSTANTS.deadline,
      status: "open",
      extensions: [{
        id: "extension-1",
        status: "requested",
        requested_due_at: CASE_TOOLS_CLOCK_INSTANTS.extension,
      }],
    }],
    checklists: [],
    transitions: [{
      id: "transition-1",
      from_step: "Triage",
      to_step: "Intake",
      outcome: "Accepted",
      created_at: CASE_TOOLS_CLOCK_INSTANTS.transition,
    }],
    alerts: [],
    management: [{
      id: "entry-1",
      occurred_at: CASE_TOOLS_CLOCK_INSTANTS.management,
      category: "scheduling",
      summary: "Changed assignment",
      casework_management_people: { display_name: "Manager One" },
      casework_management_addenda: [{
        id: "addendum-1",
        body: "Confirmed in writing",
        created_at: CASE_TOOLS_CLOCK_INSTANTS.addendum,
      }],
    }],
    retaliation: [{
      id: "report-1",
      status: "submitted",
      management_person: "A Manager",
      incident_at: CASE_TOOLS_CLOCK_INSTANTS.retaliation,
      protected_activity: "Filed a grievance",
      adverse_action: "Schedule changed",
    }],
    links: [],
    reminders: [{
      id: "reminder-1",
      title: "Call member",
      remind_at: CASE_TOOLS_CLOCK_INSTANTS.reminder,
      recurrence: "weekly",
      status: "active",
    }],
  };
}

// Union Ground issues have no grievance procedure, so the panel renders no
// step progression: the transition row in the payload must stay unrendered,
// stamp and all, while every other surface still stamps in the app language.
const CASE_TOOLS_REMOVED_SURFACES = new Set(["transition"]);

function expectCaseToolsClockStamps(lang) {
  for (const [surface, instant] of Object.entries(CASE_TOOLS_CLOCK_INSTANTS)) {
    const expected = formatGroupMoment(instant, lang);
    if (CASE_TOOLS_REMOVED_SURFACES.has(surface)) {
      expect(screen.queryAllByText(hasCollapsedText(expected)), `${surface} stamp ${instant}`).toEqual([]);
      continue;
    }
    expect(
      screen.getAllByText(hasCollapsedText(expected)).length,
      `${surface} stamp ${instant}`,
    ).toBeGreaterThanOrEqual(1);
  }
  expect(screen.queryByText(hasCollapsedText("Triage → Intake"))).toBeNull();
}

function caseToolsClockApi() {
  return {
    loadCaseworkCase: vi.fn().mockResolvedValue(caseToolsClockPayload()),
    scoreCase: vi.fn(),
    setCaseRestriction: vi.fn(),
    createCaseDeadline: vi.fn(),
    requestDeadlineExtension: vi.fn(),
    decideDeadlineExtension: vi.fn(),
    advanceCaseStep: vi.fn(),
    createCaseAlert: vi.fn(),
    acknowledgeCaseAlert: vi.fn(),
    createCaseReminder: vi.fn(),
    setReminderStatus: vi.fn(),
    setChecklistItem: vi.fn(),
    logManagementBehavior: vi.fn(),
    addManagementAddendum: vi.fn(),
    linkCases: vi.fn(),
  };
}

async function withRuntimeLocale(locale, work) {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  const originalToLocaleString = Date.prototype.toLocaleString;
  Date.prototype.toLocaleString = function (...args) {
    if (args.length === 0) return originalToLocaleString.call(this, locale);
    return originalToLocaleString.apply(this, args);
  };
  function RuntimeDateTimeFormat(locales, options) {
    return new OriginalDateTimeFormat(locales === undefined ? locale : locales, options);
  }
  RuntimeDateTimeFormat.supportedLocalesOf = OriginalDateTimeFormat.supportedLocalesOf.bind(OriginalDateTimeFormat);
  Intl.DateTimeFormat = RuntimeDateTimeFormat;
  try {
    return await work();
  } finally {
    Date.prototype.toLocaleString = originalToLocaleString;
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }
}

describe("CaseworkOperationsPanel stamps follow the app language", () => {
  it("contains no zero-argument Date.toLocaleString and routes stamps through formatGroupMoment", () => {
    const src = stripComments(read(CASE_TOOLS_PANEL_SOURCE));
    expect(src).not.toMatch(CASE_TOOLS_ZERO_ARG_DATE_STAMP);
    expect(src).not.toMatch(CASE_TOOLS_ZERO_ARG_TO_LOCALE);
    expect(src).toMatch(/formatGroupMoment/);
  });

  it("renders a Spanish stamp on an English-locale runtime as formatGroupMoment(value, 'es')", async () => {
    await withRuntimeLocale("en-US", async () => {
      const view = render(
        <LanguageProvider lang="es">
          <CaseworkOperationsPanel caseId="case-1" api={caseToolsClockApi()} />
        </LanguageProvider>,
      );
      expect(await screen.findByText("Herramientas del asunto")).toBeInTheDocument();
      expectCaseToolsClockStamps("es");
      view.unmount();
    });
  });

  it("renders an English stamp on a Spanish-locale runtime as formatGroupMoment(value, 'en')", async () => {
    await withRuntimeLocale("es", async () => {
      const view = render(
        <LanguageProvider lang="en">
          <CaseworkOperationsPanel caseId="case-1" api={caseToolsClockApi()} />
        </LanguageProvider>,
      );
      expect(await screen.findByText("Issue tools")).toBeInTheDocument();
      expectCaseToolsClockStamps("en");
      view.unmount();
    });
  });
});

// ---------------------------------------------------------------------------
// Casework and admin Spanish reader address
// (UX-UG-CASEWORK-ADMIN-SPANISH-FORMAL-REGISTER-20260920).
//
// Lifecycle help is chosen with t(`${title}Help`), so a scan of literal key
// names in the component cannot see those strings. This census walks the
// caseDash.*, caseBulk.* and admin.command.* prefixes instead.
// ---------------------------------------------------------------------------
const CASEWORK_ADMIN_TU_ES = Object.freeze({
  "caseDash.stepSub": "Cada asunto activo de la campaña que puedes ver, agrupado por el paso en el que está.",
  "caseBulk.advanceOutcomeRequired": "Elige un paso siguiente y escribe un resultado de al menos 3 caracteres.",
  "admin.command.directorySub": "Explora o filtra trabajadores dentro de tu alcance administrativo vigente. Nunca se devuelven datos de contacto ni de asuntos.",
  "admin.command.lifecycleInviteHelp": "Emite, vuelve a emitir o revoca la invitación vigente y de corta duración de la campaña.",
  "admin.command.lifecycleCompassHelp": "Registra la confirmación de un administrador sobre cómo el proveedor de IA trata los datos de la Guía, y activa o pausa la Guía.",
  "admin.command.lifecycleRetentionHelp": "Mira qué pone fin a la conservación de los datos activos y de las copias de seguridad.",
  "admin.command.lifecycleRecoveryHelp": "Reemplaza el correo perdido de un trabajador solo después de confirmar quién es por otra vía, como en persona o por teléfono.",
  "admin.command.lifecycleRightsHelp": "Responde solicitudes de acceso, corrección, eliminación, exportación o retención de trabajadores.",
  "caseBulk.candidateRosterCapped": "La lista de asignación es demasiado grande para combinarla con seguridad (más de {limit} nombres para un asunto), así que no se puede verificar para esta selección. Asigna asunto por asunto.",
});

const CASEWORK_ADMIN_EN = Object.freeze({
  "caseDash.stepSub": "Every active issue in the campaign you can see, grouped by the step it is sitting on.",
  "caseBulk.advanceOutcomeRequired": "Choose a next step and write an outcome of at least 3 characters.",
  "admin.command.directorySub": "Browse or filter the workers inside your live admin scope. Contact and issue data are never returned.",
  "admin.command.lifecycleInviteHelp": "Issue, reissue, or revoke the existing short-lived campaign invitation.",
  "admin.command.lifecycleCompassHelp": "Record an admin's confirmation of how the AI provider handles the Guide data, and turn the Guide on or off.",
  "admin.command.lifecycleRetentionHelp": "See what ends the keeping of live data and of backups.",
  "admin.command.lifecycleRecoveryHelp": "Replace a worker's lost email address only after confirming who they are some other way, such as in person or by phone.",
  "admin.command.lifecycleRightsHelp": "Respond to worker access, correction, deletion, export, or retention questions.",
  "caseBulk.candidateRosterCapped": "The assignment list is too large to combine safely (over {limit} names for an issue), so it cannot be verified for this selection. Assign issue by issue instead.",
});

const CASEWORK_ADMIN_REGISTER_PREFIXES = Object.freeze(["caseDash.", "caseBulk.", "admin.command."]);
const CASEWORK_ADMIN_EXEMPT_KEY = "caseBulk.advanceOutcomeHelp";
const CASEWORK_ADMIN_EXEMPT_ES = "Este resultado se registra en cada transición de asunto que se complete.";

describe("casework and admin Spanish catalogue uses the tú register", () => {
  it("detects the casework and admin formal imperatives on letter boundaries", () => {
    expect([...CASEWORK_ADMIN_FORMAL_IMPERATIVES].sort()).toEqual([
      "administre", "asigne", "elija", "emita", "explore", "filtre", "reemplace", "responda", "revoque",
    ]);
    const markerSource = stripComments(read("tests/i18nRegisterMarkers.js"));
    for (const word of CASEWORK_ADMIN_FORMAL_IMPERATIVES) {
      expect(FORMAL_IMPERATIVES, word).toContain(word);
      const quoted = markerSource.match(new RegExp(`["']${word}["']`, "g")) ?? [];
      expect(quoted, `${word} must be declared once in the marker module`).toHaveLength(1);
      const sample = `${word.charAt(0).toUpperCase()}${word.slice(1)} el siguiente paso.`;
      expect(sample, word).toMatch(CASEWORK_ADMIN_REGISTER_MARKERS);
    }
    expect("Dé los hechos").toMatch(CASEWORK_ADMIN_REGISTER_MARKERS);
    expect(/\bdé\b/i.test("Dé los hechos")).toBe(false);
    expect("Exploremos el directorio").not.toMatch(CASEWORK_ADMIN_REGISTER_MARKERS);
  });

  it("retires the private usted word lists in favour of tests/i18nRegisterMarkers.js", () => {
    const coverage = stripComments(read("tests/i18n-coverage.test.jsx"));
    const entry = stripComments(read("tests/qa-entry-points-register.test.jsx"));
    expect(coverage).toContain('from "./i18nRegisterMarkers.js"');
    expect(entry).toContain('from "./i18nRegisterMarkers.js"');
    const retiredLists = ["QA_USTED_WORDS", "QA_ENTRY_USTED_WORDS"];
    expect(coverage).not.toContain(`const ${retiredLists[0]}`);
    expect(entry).not.toContain(`const ${retiredLists[1]}`);
  });

  it("censuses caseDash, caseBulk and admin.command, including dynamic Help keys", () => {
    const center = stripComments(read("src/components/AdminCommandCenter.jsx"));
    expect(center).toContain("t(`${title}Help`)");
    for (const key of ["lifecycleInviteHelp", "lifecycleCompassHelp", "lifecycleRetentionHelp"]) {
      expect(center).not.toContain(`"${key}"`);
      expect(center).not.toContain(`'${key}'`);
    }

    const scanned = Object.keys(catalogue.es)
      .filter((key) => CASEWORK_ADMIN_REGISTER_PREFIXES.some((prefix) => key.startsWith(prefix)))
      .sort();
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned.filter((key) => key.endsWith("Help"))).toEqual(expect.arrayContaining([
      "caseBulk.advanceOutcomeHelp",
      "admin.command.lifecycleInviteHelp",
      "admin.command.lifecycleRecoveryHelp",
      "admin.command.lifecycleRightsHelp",
      "admin.command.lifecycleCompassHelp",
      "admin.command.lifecycleAccountHelp",
      "admin.command.lifecycleRetentionHelp",
    ]));

    const matches = scanned.filter((key) => CASEWORK_ADMIN_REGISTER_MARKERS.test(catalogue.es[key]));
    expect(matches).toEqual([CASEWORK_ADMIN_EXEMPT_KEY]);
    expect(catalogue.es[CASEWORK_ADMIN_EXEMPT_KEY]).toBe(CASEWORK_ADMIN_EXEMPT_ES);
    expect(CASEWORK_ADMIN_EXEMPT_ES).toMatch(CASEWORK_ADMIN_REGISTER_MARKERS);
    expect(catalogue.en[CASEWORK_ADMIN_EXEMPT_KEY]).toBe(
      "This outcome is recorded on every successful issue transition.",
    );

    const accountHelp = catalogue.es["admin.command.lifecycleAccountHelp"];
    expect(accountHelp).toBe(
      "Los trabajadores generan su propia exportación o solicitan eliminación permanente desde Derechos de datos.",
    );
    expect(accountHelp).toMatch(QA_USTED_MARKERS);
    expect(accountHelp).not.toMatch(CASEWORK_ADMIN_REGISTER_MARKERS);

    for (const [key, spanish] of Object.entries(CASEWORK_ADMIN_TU_ES)) {
      expect(catalogue.en[key], `${key} en`).toBe(CASEWORK_ADMIN_EN[key]);
      expect(catalogue.es[key], `${key} es`).toBe(spanish);
      expect(catalogue.es[key], key).not.toMatch(CASEWORK_ADMIN_REGISTER_MARKERS);
    }
  });
});
