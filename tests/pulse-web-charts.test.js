import { describe, expect, it, vi } from "vitest";
import {
  builderScopes,
  builderSpec,
  explorerSpec,
  latestRow,
  pulseChartFigures,
  pulseChartOptions,
  pulseChartSpec,
  pulseCsv,
  pulseCsvFilename,
  pulseHat,
  pulseRowLabel,
  pulseSeries,
  pulseUpdated,
  savedPulseChart,
  savedPulseCharts,
} from "../src/features/pulse/pulseCharts.js";
import { createPulseApi, PulseReadError } from "../src/features/pulse/pulseApi.js";
import { createPreviewPulseApi, PULSE_PREVIEW_ORGANIZATION } from "../src/features/pulse/pulsePreview.js";
import { pulseCopy, pulseCountedFrom } from "../src/features/pulse/pulseCopy.js";
import { catalogue, t as translate } from "../src/lib/i18n.js";

const SPEC = { version: 1, measure: "published_actions", breakdown: "month", period: "3m", form: "bars" };
const MINE = { version: 1, measure: "my_actions", breakdown: "month", period: "3m", form: "bars" };
const ID = "0f6b4c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";

function server(rows, extra = {}) {
  return { rows, withheld: false, privacyFloor: 10, countedFrom: "Recorded sign-ups.", ...extra };
}

describe("website Pulse chart specs", () => {
  it("accepts the server's fields and refuses anything else", () => {
    expect(pulseChartSpec({ ...SPEC, level: "local", unitID: ID, caseType: "Pay" })).toEqual({ ...SPEC, level: "local", unitID: ID, caseType: "Pay" });
    expect(pulseChartSpec({ ...SPEC, caseType: "Arson", extra: "drop" })).toEqual(SPEC);
    for (const bad of [null, { ...SPEC, version: 2 }, { ...SPEC, measure: "everyone" }, { ...SPEC, form: "pie" },
      { ...SPEC, breakdown: "person" }, { ...SPEC, period: "24m" }, { ...SPEC, level: "region" }]) {
      expect(() => pulseChartSpec(bad)).toThrow("Chart specification unavailable.");
    }
  });

  it("builds explorer cards that never narrow the person's own figures", () => {
    expect(explorerSpec("my_actions", { period: "6m", level: "local", unitID: ID })).toEqual({ ...MINE, period: "6m" });
    expect(explorerSpec("visible_cases", { period: "bogus", level: "local", unitID: ID })).toEqual({ version: 1, measure: "visible_cases", breakdown: "month", period: "12m", form: "bars", level: "local", unitID: ID });
    expect(explorerSpec("meeting_turnout")).toEqual({ version: 1, measure: "meeting_turnout", breakdown: "month", period: "12m", form: "bars" });
  });

  it("corrects a builder draft to a combination the server accepts", () => {
    const options = { measures: ["my_actions", "published_actions", "meeting_turnout", "visible_cases"], levels: ["chapter", "local"], units: [{ id: ID, name: "Residential", current: true }] };
    expect(builderSpec({ measure: "my_actions", breakdown: "unit", level: "local", unitID: ID, caseType: "Pay", period: "6m", form: "line" }, { hat: "admin", options }))
      .toEqual({ version: 1, measure: "my_actions", breakdown: "month", period: "6m", form: "line" });
    expect(builderSpec({ measure: "visible_cases", breakdown: "unit", level: "local", unitID: ID, caseType: "Pay" }, { hat: "admin", options }))
      .toEqual({ version: 1, measure: "visible_cases", breakdown: "unit", period: "12m", form: "bars", level: "local", unitID: ID, caseType: "Pay" });
    expect(builderSpec({ measure: "visible_cases", breakdown: "unit", unitID: ID }, { hat: "steward", options }))
      .toEqual({ version: 1, measure: "visible_cases", breakdown: "month", period: "12m", form: "bars" });
    expect(builderSpec({ measure: "published_actions", breakdown: "meeting", unitID: "not-offered" }, { hat: "admin", options }).breakdown).toBe("month");
    expect(builderSpec({ measure: "meeting_turnout", breakdown: "meeting" }, { hat: "member", options: { ...options, levels: ["chapter"] } }).breakdown).toBe("meeting");
    expect(builderSpec({ measure: "visible_cases" }, { hat: "member", options: { ...options, measures: ["my_actions", "published_actions"] } }).measure).toBe("my_actions");
    expect(builderSpec(null).measure).toBe("my_actions");
    expect(builderScopes("member", "my_actions")).toEqual(["personal"]);
    expect(builderScopes("member", "published_actions")).toEqual(["personal", "chapter"]);
    expect(builderScopes("admin", "visible_cases")).toEqual(["personal", "chapter", "organization"]);
  });

  it("normalizes hats and series colors", () => {
    expect(pulseHat("advisor")).toBe("advisor");
    expect(pulseHat("root")).toBe("member");
    expect(pulseSeries("published_actions")).toBe("var(--chart-series-1)");
    expect(pulseSeries("meeting_turnout")).toBe("var(--chart-series-2)");
    expect(pulseSeries("visible_cases")).toBe("var(--chart-series-3)");
    expect(pulseSeries("unknown")).toBe("var(--chart-series-1)");
  });
});

// The server tests every cell against the organization's limit (never under
// ten); the browser releases no aggregate group under 25 on top of that
// (Lovable audit APP-STEWARD-07, REQ-UNIONGROUND-LOVABLE-AUDIT-WEBAPP-FIXES-
// 20261103), on the card and in its CSV.
describe("website Pulse figures keep the floor of 25", () => {
  it("shows only rows the server cleared", () => {
    const figures = pulseChartFigures(server([{ label: "2026-09", value: 0 }, { label: "2026-10", value: "148" }]), SPEC);
    expect(figures).toMatchObject({ floor: 25, person: false, withheld: false, locked: false, unavailable: false });
    expect(figures.rows).toEqual([{ label: "2026-09", value: 0 }, { label: "2026-10", value: 148 }]);
    expect(latestRow(figures)).toEqual({ label: "2026-10", value: 148 });
    expect(latestRow({ rows: [] })).toBeNull();
  });

  it("withholds a whole card when any returned aggregate cell is under the floor", () => {
    const small = pulseChartFigures(server([{ label: "2026-09", value: 40 }, { label: "2026-10", value: 9 }]), SPEC);
    expect(small).toMatchObject({ withheld: true, rows: [] });
    expect(pulseChartFigures(server([], { withheld: true }), SPEC)).toMatchObject({ withheld: true, rows: [] });
    const raised = pulseChartFigures(server([{ label: "2026-10", value: 20 }], { privacyFloor: 25 }), SPEC);
    expect(raised).toMatchObject({ floor: 25, withheld: true, rows: [] });
    // An organization that lowered its own limit to ten still releases no
    // group under 25; its read stays valid and the card is withheld.
    const lowered = pulseChartFigures(server([{ label: "2026-10", value: 148 }, { label: "2026-11", value: 12 }]), SPEC);
    expect(lowered).toMatchObject({ floor: 25, unavailable: false, withheld: true, rows: [] });
    expect(pulseCsv(lowered)).toBeNull();
    expect(pulseChartFigures(server([{ label: "2026-10", value: 60 }], { privacyFloor: 40 }), SPEC)).toMatchObject({ floor: 40, withheld: false });
  });

  it("lets a person see their own small counts, as the server does", () => {
    const mine = pulseChartFigures(server([{ label: "2026-10", value: 2 }], { withheld: undefined, privacyFloor: undefined }), MINE);
    expect(mine).toMatchObject({ person: true, withheld: false, unavailable: false, rows: [{ label: "2026-10", value: 2 }] });
  });

  it("reports locked and unverifiable reads with no rows", () => {
    expect(pulseChartFigures({ locked: true, rows: [], countedFrom: "Complete the survey.", privacyFloor: 10 }, SPEC)).toMatchObject({ locked: true, unavailable: false, withheld: false, rows: [] });
    for (const bad of [null, server([{ label: "", value: 1 }]), server([{ label: "x", value: -1 }]), server("rows"),
      server([{ label: "x", value: 12 }], { countedFrom: "" }), server([{ label: "x", value: 12 }], { withheld: "no" }),
      server([{ label: "x", value: 12 }], { privacyFloor: 5 }), server(Array.from({ length: 401 }, (_, index) => ({ label: `r${index}`, value: 0 })))]) {
      expect(pulseChartFigures(bad, SPEC)).toMatchObject({ unavailable: true, rows: [] });
    }
    expect(pulseChartFigures(server([{ label: "x", value: 12 }]), null)).toMatchObject({ unavailable: true });
  });

  it("downloads exactly the cleared rows, and nothing for a withheld card", () => {
    const figures = pulseChartFigures(server([{ label: "2026-10", value: 148 }, { label: "=cmd", value: 32 }]), SPEC);
    expect(pulseCsv(figures, { labelHeader: "Month", valueHeader: "Sign-ups" })).toBe("Month,Sign-ups\r\n2026-10,148\r\n'=cmd,32\r\n");
    expect(pulseCsv(figures)).toMatch(/^Label,Count\r\n/);
    expect(pulseCsv(pulseChartFigures(server([{ label: "a", value: 3 }]), SPEC))).toBeNull();
    expect(pulseCsv(pulseChartFigures(null, SPEC))).toBeNull();
    expect(pulseCsv(null)).toBeNull();
    expect(pulseCsv({ person: false, unavailable: false, locked: false, withheld: false, floor: 10, rows: [{ label: "a", value: 4 }] })).toBeNull();
    // An export never releases a group under 25, even from a figure set that
    // claims a lower floor.
    expect(pulseCsv({ person: false, unavailable: false, locked: false, withheld: false, floor: 10, rows: [{ label: "a", value: 12 }] })).toBeNull();
    expect(pulseCsv(pulseChartFigures(server([{ label: "a", value: 3 }]), MINE))).toBe("Label,Count\r\na,3\r\n");
    expect(pulseCsvFilename("Chapter action sign-ups", new Date("2026-11-02T17:00:00Z"))).toBe("pulse-chapter-action-sign-ups-2026-11-02.csv");
    expect(pulseCsvFilename("", new Date(Number.NaN))).toBe("pulse-pulse-export.csv");
  });
});

describe("website Pulse reads", () => {
  it("normalizes options, saved charts and labels", () => {
    expect(pulseChartOptions({ measures: ["visible_cases", "my_actions", "spy"], levels: ["chapter", "local"], units: [{ id: ID, name: "Residential" }, { id: "", name: "x" }] }))
      .toEqual({ measures: ["my_actions", "visible_cases"], levels: ["chapter", "local"], units: [{ id: ID, name: "Residential", current: true }] });
    expect(pulseChartOptions({ measures: ["my_actions"] })).toEqual({ measures: ["my_actions"], levels: ["chapter"], units: [] });
    expect(() => pulseChartOptions({ measures: [] })).toThrow("No chart measures");
    expect(() => pulseChartOptions(null)).toThrow();

    const chart = savedPulseChart({ id: ID, title: "Sign-ups", scope: "chapter", spec: SPEC, pinned: true, home: true, owned: true, figures: server([{ label: "2026-10", value: 32 }]) });
    expect(chart).toMatchObject({ id: ID, pinned: true, home: true, owned: true, spec: SPEC });
    expect(chart.figures.rows).toHaveLength(1);
    const stale = savedPulseChart({ id: ID, title: "Old", scope: "personal", spec: { version: 9 }, pinned: false, home: true, owned: true, unavailable: true });
    expect(stale).toMatchObject({ spec: null, home: false, figures: { unavailable: true } });
    expect(() => savedPulseChart({ id: "x", title: "t", scope: "personal" })).toThrow("Saved chart unavailable.");
    expect(savedPulseCharts([{ id: ID, title: "Ok", scope: "personal", spec: MINE, owned: true, figures: server([], { countedFrom: "x" }) }, { id: "bad" }])).toHaveLength(1);
    expect(() => savedPulseCharts(null)).toThrow("Saved charts could not be verified.");

    expect(pulseRowLabel("2026-10", "en")).toBe("Oct 2026");
    expect(pulseRowLabel("2026-10", "es")).toMatch(/oct/i);
    expect(pulseRowLabel("Residential", "en")).toBe("Residential");
    expect(pulseUpdated(new Date("2026-11-02T17:40:00Z"))).toBe("12:40 PM");
    expect(pulseUpdated(new Date("2026-11-02T17:40:00Z"), "es")).toMatch(/12:40/);
    expect(pulseUpdated(null)).toBeNull();
    expect(pulseUpdated(new Date(Number.NaN))).toBeNull();
  });

  it("calls the same RPCs as the app and turns every failure into an error", async () => {
    const rpc = vi.fn(async (name) => ({
      pulse_chart_options: { data: { measures: ["my_actions"], levels: ["chapter"], units: [] }, error: null },
      preview_pulse_chart: { data: server([{ label: "2026-10", value: 3 }]), error: null },
      list_pulse_charts: { data: [], error: null },
      save_pulse_chart: { data: ID, error: null },
      remove_pulse_chart: { data: null, error: null },
    })[name]);
    const api = createPulseApi({ rpc });
    await expect(api.options("member")).resolves.toEqual({ measures: ["my_actions"], levels: ["chapter"], units: [] });
    await expect(api.preview("member", MINE)).resolves.toMatchObject({ rows: [{ label: "2026-10", value: 3 }] });
    await expect(api.list("member")).resolves.toEqual([]);
    await expect(api.save("steward", { title: "T", spec: SPEC, scope: "chapter", pinned: false, home: true })).resolves.toBe(ID);
    await api.remove(ID);
    await api.remove(ID, true);
    expect(rpc).toHaveBeenCalledWith("pulse_chart_options", { p_hat: "member" });
    expect(rpc).toHaveBeenCalledWith("preview_pulse_chart", { p_spec: MINE, p_hat: "member" });
    expect(rpc).toHaveBeenCalledWith("save_pulse_chart", { p_id: null, p_title: "T", p_spec: SPEC, p_scope: "chapter", p_pinned: false, p_home: false, p_hat: "steward" });
    expect(rpc).toHaveBeenCalledWith("remove_pulse_chart", { p_id: ID, p_undo: true });

    await expect(createPulseApi({ rpc: async () => ({ data: null, error: { code: "42501" } }) }).options("vp")).rejects.toBeInstanceOf(PulseReadError);
    await expect(createPulseApi({ rpc: async () => { throw new Error("offline"); } }).list("vp")).rejects.toThrow("Pulse could not be verified.");
    await expect(createPulseApi(null).options("member")).rejects.toThrow("Pulse is not connected.");
  });
});

describe("website Pulse preview fixture", () => {
  it("is Tamarack, floors every aggregate and withholds the small unit", async () => {
    expect(PULSE_PREVIEW_ORGANIZATION).toBe("Tamarack Valley Human Services");
    const api = createPreviewPulseApi({ now: () => new Date("2026-11-02T17:00:00Z") });
    expect(api.isPreview).toBe(true);
    const admin = await api.options("admin");
    expect(admin.units).toHaveLength(3);
    expect((await api.options("member")).measures).not.toContain("visible_cases");
    expect((await api.options("member")).levels).toEqual(["chapter"]);
    const year = await api.preview("admin", explorerSpec("published_actions", { period: "12m" }));
    expect(year.rows).toHaveLength(12);
    expect(year.rows.at(-1)).toEqual({ label: "2026-11", value: 148 });
    expect(year.rows.every((row) => row.value === 0 || row.value >= 10)).toBe(true);
    for (const unit of admin.units) {
      const narrowed = await api.preview("admin", explorerSpec("published_actions", { period: "3m", unitID: unit.id }));
      expect(narrowed.rows.every((row) => row.value === 0 || row.value >= 10)).toBe(true);
    }
    expect(await api.preview("admin", explorerSpec("visible_cases", { unitID: admin.units[2].id }))).toMatchObject({ withheld: true, rows: [] });
    expect(await api.preview("admin", { ...SPEC, breakdown: "unit" })).toMatchObject({ withheld: true });
    expect((await api.preview("advisor", explorerSpec("published_actions", { level: "local", period: "3m" }))).rows.at(-1).value).toBe(444);
    expect((await api.preview("member", { ...SPEC, measure: "meeting_turnout", breakdown: "meeting" })).rows).toHaveLength(4);
    expect((await api.preview("member", { ...MINE, period: "6m" })).rows).toHaveLength(6);

    const charts = await api.list("member");
    expect(charts.map((chart) => chart.title)).toEqual(["Chapter sign-ups", "My sign-ups"]);
    const id = await api.save("member", { title: " New ", spec: MINE, scope: "personal", pinned: true, home: true });
    expect((await api.list("member")).find((chart) => chart.id === id)).toMatchObject({ title: "New", home: true });
    await api.save("member", { id, title: "Renamed", spec: MINE, scope: "personal" });
    expect((await api.list("member")).find((chart) => chart.id === id).title).toBe("Renamed");
    await expect(api.save("member", { title: "Leak", spec: MINE, scope: "chapter" })).rejects.toThrow("scope");
    await api.remove(id);
    expect((await api.list("member")).some((chart) => chart.id === id)).toBe(false);
    await api.remove(id, true);
    expect((await api.list("member")).some((chart) => chart.id === id)).toBe(true);
    await expect(api.remove(id, true)).rejects.toThrow("undo expired");
    await expect(api.remove("missing")).rejects.toThrow("chart unavailable");
  });

  it("gives Spanish readers the measure's own explanation", () => {
    const es = pulseCopy((key, vars) => translate("es", key, vars));
    const en = pulseCopy((key, vars) => translate("en", key, vars));
    expect(es.countedFrom.my_actions).toMatch(/^Tus inscripciones/);
    expect(es.withheld(10)).toBe("Oculto por completo: un grupo tiene menos de 10 personas.");
    expect(en.chartLabel("Bar chart", "Sign-ups", 3, "")).toBe("Bar chart of Sign-ups: 3 values");
    expect(en.removed("Pay")).toBe("Removed “Pay”.");
    // Every pulse.* key exists in both catalogues, so no reader falls back to a key name.
    const keys = (lang) => Object.keys(catalogue[lang]).filter((key) => key.startsWith("pulse.")).sort();
    expect(keys("en").length).toBeGreaterThan(100);
    expect(keys("es")).toEqual(keys("en"));
    expect(pulseCountedFrom(es, "es", "my_actions", "Server text")).toBe(es.countedFrom.my_actions);
    expect(pulseCountedFrom(en, "en", "my_actions", "Server text")).toBe("Server text");
    expect(pulseCountedFrom(en, "en", "my_actions", "")).toBe(en.countedFrom.my_actions);
    expect(pulseCountedFrom(es, "es", "unknown", "Server")).toBe("Server");
    expect(pulseCountedFrom(es, "en", "unknown", "")).toBe("");
  });
});
