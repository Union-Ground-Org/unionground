// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 111: the
// Feature switches & limits page carries a short, static guide to what a
// small local can safely turn off, in English and Spanish, naming real
// switches from the catalogue. Finding 87: the bargaining survey switch no
// longer names another organization's agreement.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { spanishCatalogue } from "../src/lib/i18n/es.js";
import { useDesk } from "../src/lib/useDesk.js";

const GUIDE_KEYS = [
  "features.ai_assistant.enabled",
  "features.intelligence.issue_signals", "features.intelligence.weekly_digest",
  "features.intelligence.neuro_map_derived_graph", "features.intelligence.neuro_map_auto_progress",
  "features.attention.guided_portal",
  "features.casework.gc_escalation_flags", "features.casework.gc_escalation_notify",
  "features.engagement_voice.contextual_pulses", "features.engagement_voice.weekly_question_priority_slot",
  "features.engagement_voice.quarterly_survey_gate",
  "features.integrations.scim", "features.integrations.drive_case_meeting_folders",
  "features.integrations.org_calendar_push",
  "features.casework.deadline_reminders", "features.casework.mark_missed_deadlines", "features.casework.ulp_deadline",
];

// The admin list as the server returns it with every guide switch released.
const settingRow = (key) => ({ key, kind: "boolean", category: key.split(".")[1], label: key, description: "", value: true, defaultValue: true, overridden: false, updatedAt: null, lastChange: null });
const configuration = { settings: GUIDE_KEYS.map(settingRow), labelKeys: [], labelOverrides: {} };
// BUG-UG-SMALL-LOCAL-GUIDE-NAMES-HELD-SWITCHES-20261112: the admin
// list leaves out a held switch, so the guide must not name it.
const HELD_GUIDE_KEYS = [
  "features.intelligence.weekly_digest", "features.intelligence.neuro_map_derived_graph",
  "features.intelligence.neuro_map_auto_progress", "features.attention.guided_portal",
];

function renderPage(lang, config = configuration) {
  render(<LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={config} failedLoginInbox={null} api={{ updateOrganizationSetting: vi.fn() }} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
}

afterEach(cleanup);

describe("small-local guide on Feature switches & limits", () => {
  it("names only switches that exist in both catalogues", () => {
    for (const key of GUIDE_KEYS) {
      expect(catalogue.en[`settings.def.${key}.label`], key).toEqual(expect.any(String));
      expect(spanishCatalogue.es[`settings.def.${key}.label`], key).toEqual(expect.any(String));
    }
  });

  it("opens a short guide with one line per group and a keep-on note", () => {
    renderPage("en");
    const summary = screen.getByText("Safe to turn off for a small local");
    const guide = summary.closest("details");
    expect(guide).not.toHaveAttribute("open");
    fireEvent.click(summary);
    const items = within(guide).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(within(guide).getByText("Guide AI assistant")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("Turns the AI assistant off for everyone in your organization, if your local won't use it.");
    expect(guide.querySelector('[data-guide="integrations"]')).toHaveTextContent("SCIM directory provisioning");
    // ULP deadline tracking is a left-out feature: its switch is never named.
    expect(guide).toHaveTextContent("Keep the security and sign-in switches on, and Deadline reminders and Mark passed deadlines missed, so no issue deadline slips by.");
    expect(guide).not.toHaveTextContent("ULP");
    // It sits above the filters, so it is there however the list is filtered.
    expect(guide.compareDocumentPosition(document.querySelector(".xus-config-filters")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reads in Spanish with the Spanish switch names", () => {
    renderPage("es");
    const guide = screen.getByText("Se pueden desactivar sin riesgo en un local pequeño").closest("details");
    expect(guide).toHaveTextContent("Asistente de IA Guía");
    expect(guide).toHaveTextContent("Recordatorios de plazos y Marcar plazos vencidos como incumplidos");
    expect(guide).not.toHaveTextContent("ULP");
    expect(guide.textContent).not.toMatch(/Turn off|Keep the/);
  });

  it("names no switch the admin list leaves out, as it does a held one, and names it again once released", () => {
    renderPage("en", { ...configuration, settings: configuration.settings.filter((item) => !HELD_GUIDE_KEYS.includes(item.key)) });
    const guide = screen.getByText("Safe to turn off for a small local").closest("details");
    expect(within(guide).getAllByRole("listitem")).toHaveLength(5);
    expect(guide.querySelector('[data-guide="attention"]')).toBeNull();
    expect(guide.querySelector('[data-guide="intelligence"] strong').textContent).toBe(catalogue.en["settings.def.features.intelligence.issue_signals.label"]);
    for (const key of HELD_GUIDE_KEYS) expect(guide).not.toHaveTextContent(catalogue.en[`settings.def.${key}.label`]);
    cleanup();
    renderPage("es", { ...configuration, settings: configuration.settings.filter((item) => !HELD_GUIDE_KEYS.includes(item.key)) });
    const spanish = screen.getByText("Se pueden desactivar sin riesgo en un local pequeño").closest("details");
    for (const key of HELD_GUIDE_KEYS) expect(spanish).not.toHaveTextContent(spanishCatalogue.es[`settings.def.${key}.label`]);
    cleanup();
    renderPage("en");
    const released = screen.getByText("Safe to turn off for a small local").closest("details");
    for (const key of HELD_GUIDE_KEYS) expect(released).toHaveTextContent(catalogue.en[`settings.def.${key}.label`]);
  });

  it("is left out when the admin list has none of its switches", () => {
    renderPage("en", { ...configuration, settings: [] });
    expect(screen.queryByText("Safe to turn off for a small local")).toBeNull();
  });

  it("is not shown when the settings could not be read", () => {
    renderPage("en", null);
    expect(screen.queryByText("Safe to turn off for a small local")).toBeNull();
  });
});

const releasedSettings = configuration.settings;
const heldSettings = configuration.settings.filter((item) => !HELD_GUIDE_KEYS.includes(item.key));
const guideLabel = { en: (key) => catalogue.en[`settings.def.${key}.label`], es: (key) => spanishCatalogue.es[`settings.def.${key}.label`] };
const COPY = {
  en: { summary: "Safe to turn off for a small local", history: "Show recent changes", empty: "No configuration changes yet.", loading: "Loading recent changes…", renamed: "Label renamed" },
  es: { summary: "Se pueden desactivar sin riesgo en un local pequeño", history: "Ver cambios recientes", empty: "Todavía no hay cambios de configuración.", loading: "Cargando cambios recientes…", renamed: "Etiqueta renombrada" },
};

describe.each(["en", "es"])("configuration history names no held switch (%s)", (lang) => {
  const audit = [
    ...HELD_GUIDE_KEYS.map((key, index) => ({ id: `held-${index}`, action: index % 2 ? "setting_reset" : "setting_updated", key, previousValue: true, newValue: false, actorName: "Alex Rivera", createdAt: "2026-10-01T12:00:00Z" })),
    { id: "released", action: "setting_updated", key: "features.ai_assistant.enabled", previousValue: true, newValue: false, actorName: "Alex Rivera", createdAt: "2026-10-01T12:00:00Z" },
    { id: "label", action: "label_updated", key: "term.steward", previousValue: null, newValue: "Rep", actorName: "Alex Rivera", createdAt: "2026-10-01T12:00:00Z" },
  ];
  function renderHistory(settings, rows = audit) {
    const api = { updateOrganizationSetting: vi.fn(), loadConfigurationAudit: vi.fn().mockResolvedValue(rows) };
    render(<LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={{ ...configuration, settings }} failedLoginInbox={null} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: COPY[lang].history }));
    return document.querySelector("#admin-configuration-history");
  }

  it("leaves out setting changes and resets of a switch the admin list leaves out, and keeps label changes", async () => {
    const history = renderHistory(heldSettings);
    expect(await within(history).findByText(guideLabel[lang]("features.ai_assistant.enabled"))).toBeInTheDocument();
    expect(within(history).getByText(new RegExp(COPY[lang].renamed))).toBeInTheDocument();
    expect(within(history).getAllByRole("listitem")).toHaveLength(2);
    for (const key of HELD_GUIDE_KEYS) {
      expect(history).not.toHaveTextContent(key);
      expect(history).not.toHaveTextContent(guideLabel[lang](key));
    }
  });

  it("shows those changes again once the switches are released", async () => {
    const history = renderHistory(releasedSettings);
    await within(history).findByText(guideLabel[lang]("features.ai_assistant.enabled"));
    expect(within(history).getAllByRole("listitem")).toHaveLength(6);
    for (const key of HELD_GUIDE_KEYS) expect(history).toHaveTextContent(guideLabel[lang](key));
  });

  it("says there are no changes when every change is of a held switch", async () => {
    const history = renderHistory(heldSettings, audit.slice(0, HELD_GUIDE_KEYS.length));
    expect(await within(history).findByText(COPY[lang].empty)).toBeInTheDocument();
    expect(within(history).queryByRole("listitem")).toBeNull();
  });
});

// The admin desk guard of src/views/AdminView.jsx: the command center shows
// while there is no error and a desk, and the configuration is current only
// when no read is in flight.
function AdminDeskHarness({ api }) {
  const { desk, error, pending, load } = useDesk(api);
  return <>
    <button type="button" onClick={() => { void load(); }}>reload</button>
    {!error && desk && <AdminSecurityConfiguration configuration={desk.configuration} configurationCurrent={!pending} failedLoginInbox={null} api={{ updateOrganizationSetting: vi.fn(), loadConfigurationAudit: desk.audit }} reload={load} onNotice={vi.fn()} />}
  </>;
}

describe.each(["en", "es"])("guide and history during a refresh or retry (%s)", (lang) => {
  it("names nothing from the previous read while a refresh or retry is in flight, and names the fresh list once it lands", async () => {
    const reads = [];
    const audit = vi.fn().mockResolvedValue(HELD_GUIDE_KEYS.map((key, index) => ({ id: `a${index}`, action: "setting_updated", key, previousValue: true, newValue: false, actorName: "Alex Rivera", createdAt: "2026-10-01T12:00:00Z" })));
    const api = { loadDesk: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) };
    const desk = (settings) => ({ configuration: { ...configuration, settings }, audit });
    render(<LanguageProvider lang={lang}><AdminDeskHarness api={api} /></LanguageProvider>);
    const guide = () => screen.queryByText(COPY[lang].summary)?.closest("details") ?? null;
    // The guide and the history; the switch rows below keep the previous read
    // until the new one lands, as every desk panel does.
    const named = (key) => [guide(), document.querySelector("#admin-configuration-history")]
      .some((element) => element?.textContent.includes(guideLabel[lang](key)) ?? false);

    // Released on the first read; the admin opens the guide and the history.
    await act(async () => reads[0].resolve(desk(releasedSettings)));
    fireEvent.click(screen.getByText(COPY[lang].summary));
    fireEvent.click(screen.getByRole("button", { name: COPY[lang].history }));
    await screen.findAllByText(guideLabel[lang](HELD_GUIDE_KEYS[0]));
    for (const key of HELD_GUIDE_KEYS) expect(named(key)).toBe(true);

    // The hold takes effect and a refresh starts: the previous list is on
    // screen but names nothing until the new read lands.
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(guide()).toHaveAttribute("aria-busy", "true");
    expect(guide().querySelector("[data-guide]")).toBeNull();
    expect(screen.getByText(COPY[lang].loading)).toBeInTheDocument();
    for (const key of HELD_GUIDE_KEYS) expect(named(key)).toBe(false);

    // The refresh lands with the four switches held: the guide stays open and
    // names only what the fresh list holds; the history names none of them.
    await act(async () => reads[1].resolve(desk(heldSettings)));
    expect(guide()).not.toHaveAttribute("aria-busy");
    expect(guide()).toHaveAttribute("open");
    expect(guide().querySelectorAll("[data-guide]")).toHaveLength(5);
    expect(screen.getByText(COPY[lang].empty)).toBeInTheDocument();
    for (const key of HELD_GUIDE_KEYS) expect(named(key)).toBe(false);

    // The next read fails: the desk shows its error instead of the page.
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    await act(async () => reads[2].reject(new Error("offline")));
    expect(guide()).toBeNull();

    // The switches are released and a retry is in flight: the page is back on
    // the previous (held) list, which names nothing while the retry runs.
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(guide()).toHaveAttribute("aria-busy", "true");
    expect(guide().querySelector("[data-guide]")).toBeNull();

    // The retry lands: everything is named as before, with no deploy.
    await act(async () => reads[3].resolve(desk(releasedSettings)));
    expect(guide()).not.toHaveAttribute("aria-busy");
    expect(guide().querySelectorAll("[data-guide]")).toHaveLength(6);
    for (const key of HELD_GUIDE_KEYS) expect(named(key)).toBe(true);
  });

});

describe("bargaining survey switch wording", () => {
  it("names no other organization's agreement in English or Spanish", () => {
    for (const table of [catalogue.en, spanishCatalogue.es]) {
      const label = table["settings.def.features.engagement_voice.bargaining_survey_template.label"];
      const description = table["settings.def.features.engagement_voice.bargaining_survey_template.description"];
      expect(`${label} ${description}`).not.toMatch(/Units? 8|Unidades 8|2024 (to|a) 2026/);
    }
    expect(catalogue.en["settings.def.features.engagement_voice.bargaining_survey_template.label"]).toBe("Bargaining survey from a built-in template");
    expect(spanishCatalogue.es["settings.def.features.engagement_voice.bargaining_survey_template.label"]).toBe("Encuesta de negociación a partir de una plantilla incluida");
  });
});
