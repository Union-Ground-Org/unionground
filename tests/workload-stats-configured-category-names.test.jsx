// BUG-UG-WORKLOAD-STATS-IGNORE-CONFIGURED-CATEGORY-NAMES-20261106:
// once an organization applies a workload configuration, the member Stats tab,
// the advisor workload card and the steward workload trends name, order and
// hide the eight categories the way that version's entry form does. Before a
// version is applied (version 0) the #6910 layout and label overrides stay.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { t } from "../src/lib/i18n.js";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { AdvisorView } from "../src/views/AdvisorView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { WORKLOAD_CATEGORY_KEYS } from "../src/lib/workloadCategories.js";
import { WORKLOAD_CONFIGURATION_RESOURCE, configuredWorkloadCategories, defaultWorkloadDefinition, withConfiguredWorkloadCategories } from "../src/lib/workloadConfiguration.js";
import { memberResourcesForRoute } from "../src/lib/memberSessionLoader.js";

const RENAMED = { priority: "Hot files" };
const HIDDEN = ["todos"];
const RETIRED = ["referrals"];
const ORDER = ["aged_cases", "priority", "pending", "unread_docs", "todos", "referrals", "ce_activities", "assistance_requests"];
function configuration(version = 1) {
  const base = defaultWorkloadDefinition();
  const byKey = new Map(base.fields.map((f) => [f.key, f]));
  const categories = ORDER.map((key) => ({ ...byKey.get(key), label: RENAMED[key] ?? byKey.get(key).label, visible: !HIDDEN.includes(key), retired: RETIRED.includes(key) }));
  return { organizationId: "fictional-tamarack", version, definition: { ...base, fields: [...categories, ...base.fields.filter((f) => f.kind !== "category")] } };
}
const name = (key, lang = "en") => RENAMED[key] ?? t(lang, `workload.cat.${key}`);
const expected = (lang = "en") => ORDER.filter((key) => !HIDDEN.includes(key) && !RETIRED.includes(key)).map((key) => name(key, lang));
// The older #6910 layout says something else: all shown, default order, an old name.
const olderLayout = { categories: WORKLOAD_CATEGORY_KEYS.map((key) => ({ key, visible: true })), canEdit: false };
const olderNames = { "workload.cat.priority": "Old priority name", "workload.cat.todos": "Old todos name" };
const stats = { enoughData: true, categories: WORKLOAD_CATEGORY_KEYS.map((key) => ({ key, avg: 2, median: 2, p90: 3 })), tiles: { pctFullTime: 50, pctPartTime: 50, avgOtHours: 1 } };
const counts = Object.fromEntries(WORKLOAD_CATEGORY_KEYS.map((key, index) => [key, index + 1]));
const labels = (container, selector) => [...container.querySelectorAll(selector)].map((node) => node.textContent);

beforeEach(() => clearDeviceParityState());

function renderStats({ lang = "en", config = configuration() } = {}) {
  const view = render(
    <LanguageProvider lang={lang} labelOverrides={olderNames}>
      <WorkloadView data={{ workload: { entries: [{ id: "e1", receipt: "R1", counts, meta: "", note: "", dateLabel: "Nov 2" }], stats, reminders: { available: false }, categories: olderLayout, configuration: config } }} onLogWork={vi.fn()} onSaveReminder={vi.fn()} />
    </LanguageProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: t(lang, "workload.tab.stats") }));
  return view;
}

describe("configured category names and visibility", () => {
  for (const lang of ["en", "es"]) {
    it(`Stats tab follows the applied configuration in ${lang}: renamed, hidden and retired categories`, () => {
      const { container } = renderStats({ lang });
      expect(labels(container, ".mwl-bar__label")).toEqual(expected(lang));
      expect(labels(container, ".mwl-cmprow__label")).toEqual(expected(lang));
      expect(container.textContent).not.toContain("Old priority name");
      expect(container.textContent).not.toContain("Old todos name");
      expect(container.textContent).not.toContain(t(lang, "workload.cat.todos"));
      expect(container.textContent).not.toContain(t(lang, "workload.cat.referrals"));
    });
  }

  it("leaves the unconfigured (version 0) Stats tab on the #6910 layout and names", () => {
    const { container } = renderStats({ config: configuration(0) });
    expect(labels(container, ".mwl-bar__label")).toEqual(WORKLOAD_CATEGORY_KEYS.map((key) => olderNames[`workload.cat.${key}`] ?? t("en", `workload.cat.${key}`)));
    expect(configuredWorkloadCategories(configuration(0), "en")).toBeNull();
    expect(configuredWorkloadCategories(null, "en")).toBeNull();
    expect(withConfiguredWorkloadCategories([{ key: "pending" }], null)).toEqual([{ key: "pending" }]);
  });

  it("advisor workload card uses the configured names and hides hidden categories", async () => {
    const workload = { enoughData: true, period: "2026-Q2", submittersBand: "25-49", categories: WORKLOAD_CATEGORY_KEYS.map((key, index) => ({ key, avg: index + 10 })), tiles: {} };
    render(
      <LanguageProvider lang="en" labelOverrides={olderNames}>
        <AdvisorView data={{ member: { initials: "CL" }, workload: { configuration: configuration() } }} api={{ loadDesk: vi.fn().mockResolvedValue({ overview: {}, workload, stewards: [] }) }} />
      </LanguageProvider>,
    );
    await screen.findByText("Hot files");
    expect(labels(document, "#advisor-workload .ach-bar__name")).toEqual(expected());
    expect(screen.queryByText("Old priority name")).toBeNull();
  });

  it("advisor workload card keeps its server rows and names without an applied configuration", async () => {
    const workload = { enoughData: true, period: "2026-Q2", submittersBand: "25-49", categories: [{ key: "todos", avg: 3 }, { key: "priority", avg: 4 }], tiles: {} };
    render(<LanguageProvider lang="en"><AdvisorView data={{ member: { initials: "CL" } }} api={{ loadDesk: vi.fn().mockResolvedValue({ overview: {}, workload, stewards: [] }) }} /></LanguageProvider>);
    await screen.findByText("Priority");
    expect(labels(document, "#advisor-workload .ach-bar__name")).toEqual([t("en", "workload.cat.todos"), t("en", "workload.cat.priority")]);
  });

  it("steward workload trends use the configured names and hide hidden categories", async () => {
    const trend = (key) => ({ key, slope: 1, latest: 4, forecast4Weeks: 5, points: 6 });
    const api = { loadDesk: vi.fn().mockResolvedValue({ queue: [], threads: [], broadcasts: [], formsInbox: [], kpis: {}, workloadIntelligence: { available: true, eligibleWeeks: 6, categories: ["todos", "pending", "priority"].map(trend), rebalancing: { stewards: [], suggestions: [] } } }) };
    render(<LanguageProvider lang="es"><StewardView data={{ member: { initials: "SO" }, workload: { configuration: configuration() } }} api={api} onNotice={() => {}} /></LanguageProvider>);
    const heading = await screen.findByRole("heading", { name: t("es", "steward.workloadTitle") });
    const section = heading.closest("section");
    expect([...section.querySelectorAll(".cwk-workload__trend strong")].map((node) => node.textContent)).toEqual(["Hot files", t("es", "workload.cat.pending")]);
    expect(within(section).queryByText(t("es", "workload.cat.todos"))).toBeNull();
  });

  it("loads the applied configuration on a cold advisor or steward route", () => {
    expect(memberResourcesForRoute("advisor")).toContain(WORKLOAD_CONFIGURATION_RESOURCE);
    expect(memberResourcesForRoute("steward")).toContain(WORKLOAD_CONFIGURATION_RESOURCE);
  });
});
