// REQ-UG-NEURO-MAP-ORGANIZATION-SWITCH-20261112 (#8437): the
// organization switch features.intelligence.neuro_map hides the Neuro Map tab
// of the web organization map, and a link that names that tab lands on the
// first tab that is shown. With the switch on, or never set, nothing changes.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { createOrganizationIntelligenceAdapter } from "../src/features/organizationIntelligence/adapter.js";
import { NEURO_MAP_SWITCH_KEY, neuroMapEnabled, neuroMapReadOn } from "../src/features/organizationIntelligence/contract.js";
import { ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION, ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT } from "./fixtures/retired-pre-bot/src/features/organizationIntelligence/preview.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { spanishCatalogue } from "../src/lib/i18n/es.js";
import { OrganizationIntelligenceView } from "../src/views/OrganizationIntelligenceView.jsx";

const actor = {
  userId: "staff-1",
  organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION,
  selectedHat: "admin",
  organizationRoles: ["admin"],
  membershipStatus: "active",
  organizationStatus: "active",
  mfaSatisfied: true,
};

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

async function openAt(path, organizationConfiguration, adapter) {
  window.history.replaceState(null, "", path);
  render(<LanguageProvider lang="en"><WorkspacePages view="organizationMap" hat="admin" location={window.location.href} navigate={vi.fn()} menu={false}>
    <OrganizationIntelligenceView actor={actor} preview adapter={adapter} organizationConfiguration={organizationConfiguration} />
  </WorkspacePages></LanguageProvider>);
  await screen.findByRole("link", { name: "Organization charts" });
}

// A snapshot that states the switch, as the server's does.
const snapshotSaying = (neuroMapEnabled) => createOrganizationIntelligenceAdapter({
  fetchIntelligence: async () => ({ ...ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT, neuroMapEnabled }),
});

const tabNames = () => screen.getByRole("group", { name: "Structure and relationships" }).textContent;

describe("Neuro Map organization switch on the web", () => {
  it("reads only an explicit false as off", () => {
    expect(NEURO_MAP_SWITCH_KEY).toBe("features.intelligence.neuro_map");
    expect(neuroMapEnabled(null)).toBe(true);
    expect(neuroMapEnabled({ switches: {} })).toBe(true);
    expect(neuroMapEnabled({ switches: { [NEURO_MAP_SWITCH_KEY]: true } })).toBe(true);
    expect(neuroMapEnabled({ switches: { [NEURO_MAP_SWITCH_KEY]: false } })).toBe(false);
  });

  it("opens the Neuro Map from its link with the switch on", async () => {
    await openAt("/m/organization-map/relationships", { switches: { [NEURO_MAP_SWITCH_KEY]: true } });
    expect(screen.getByRole("link", { name: "Neuro Map" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Neuro Map" })).toBeInTheDocument();
  });

  it("offers no Neuro Map tab with the switch off, and its link lands on Organization charts", async () => {
    await openAt("/m/organization-map/relationships", { switches: { [NEURO_MAP_SWITCH_KEY]: false } });
    expect(screen.queryByRole("link", { name: "Neuro Map" })).toBeNull();
    expect(tabNames()).not.toContain("Neuro Map");
    expect(screen.queryByRole("heading", { name: "Neuro Map" })).toBeNull();
    expect(screen.getByRole("group", { name: "Agency persisted layout" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Organization charts" })).toHaveAttribute("aria-current", "page");
  });

  it("shows the tab as soon as the snapshot says on, though the page's configuration still says off", async () => {
    await openAt("/m/organization-map/relationships", { switches: { [NEURO_MAP_SWITCH_KEY]: false } }, snapshotSaying(true));
    expect(screen.getByRole("link", { name: "Neuro Map" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Neuro Map" })).toBeInTheDocument();
  });

  it("hides the tab as soon as the snapshot says off, though the page's configuration still says on", async () => {
    await openAt("/m/organization-map/relationships", { switches: { [NEURO_MAP_SWITCH_KEY]: true } }, snapshotSaying(false));
    expect(screen.queryByRole("link", { name: "Neuro Map" })).toBeNull();
    expect(screen.getByRole("link", { name: "Organization charts" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the tab in the SAMPLE tour and offline preview, where the switch is never set", async () => {
    await openAt("/m/organization-map/relationships", null);
    expect(screen.getByRole("link", { name: "Neuro Map" })).toBeInTheDocument();
  });
});

// BUG-UG-HELD-FEATURE-TRACES-PACKET-LIMIT-AND-MAP-SUBTITLE-20261113
// (#8598): the page subtitle names the relationship map and topic readiness
// (the Neuro Map) only once a read says it is on. The member switch map and
// the snapshot both report a held switch as off.
describe.each([
  ["en", catalogue.en, /relationship|topic readiness/i],
  ["es", spanishCatalogue.es, /relaciones|preparación por tema/i],
])("the Organization map subtitle (%s)", (lang, names, namesNeuroMap) => {
  async function openWith(organizationConfiguration, adapter) {
    const view = render(<LanguageProvider lang={lang}><WorkspacePages view="organizationMap" hat="admin" location={window.location.href} navigate={vi.fn()} menu={false}>
      <OrganizationIntelligenceView actor={actor} lang={lang} preview adapter={adapter} organizationConfiguration={organizationConfiguration} />
    </WorkspacePages></LanguageProvider>);
    return () => view.container.querySelector(".oi-hero span").textContent;
  }
  const pending = createOrganizationIntelligenceAdapter({ fetchIntelligence: () => new Promise(() => {}) });

  it("does not name the Neuro Map while it is held (the switch map and the snapshot say off)", async () => {
    const subtitle = await openWith({ switches: { [NEURO_MAP_SWITCH_KEY]: false } }, snapshotSaying(false));
    await screen.findByRole("link", { name: names["orgIntel.charts"] });
    expect(subtitle()).toBe(names["orgIntel.subWithoutNeuroMap"]);
    expect(subtitle()).not.toMatch(namesNeuroMap);
  });

  it("reads exactly as before once released (the snapshot says on)", async () => {
    const subtitle = await openWith({ switches: { [NEURO_MAP_SWITCH_KEY]: true } }, snapshotSaying(true));
    await screen.findByRole("link", { name: names["orgIntel.charts"] });
    expect(subtitle()).toBe(names["orgIntel.sub"]);
  });

  it("follows the snapshot over a configuration that lags it", async () => {
    const subtitle = await openWith({ switches: { [NEURO_MAP_SWITCH_KEY]: true } }, snapshotSaying(false));
    await screen.findByRole("link", { name: names["orgIntel.charts"] });
    expect(subtitle()).toBe(names["orgIntel.subWithoutNeuroMap"]);
  });

  it("before the snapshot lands, names it only when the switch map says on", async () => {
    expect((await openWith({ switches: { [NEURO_MAP_SWITCH_KEY]: false } }, pending))()).toBe(names["orgIntel.subWithoutNeuroMap"]);
    cleanup();
    expect((await openWith(null, pending))()).toBe(names["orgIntel.subWithoutNeuroMap"]);
    cleanup();
    expect((await openWith({ switches: { [NEURO_MAP_SWITCH_KEY]: true } }, pending))()).toBe(names["orgIntel.sub"]);
  });
});

describe("neuroMapReadOn", () => {
  it("is on only when the snapshot, else the switch map, says on", () => {
    const on = { switches: { [NEURO_MAP_SWITCH_KEY]: true } };
    const off = { switches: { [NEURO_MAP_SWITCH_KEY]: false } };
    expect(neuroMapReadOn(true, off)).toBe(true);
    expect(neuroMapReadOn(false, on)).toBe(false);
    expect(neuroMapReadOn(null, on)).toBe(true);
    expect(neuroMapReadOn(undefined, off)).toBe(false);
    expect(neuroMapReadOn(null, { switches: {} })).toBe(false);
    expect(neuroMapReadOn(null, null)).toBe(false);
  });
});
