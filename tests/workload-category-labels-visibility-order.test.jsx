// REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103 (#6910):
// the member Workload log names, hides and orders the eight categories the
// way the organization saved them, without touching what is logged or
// exported; the admin card on the Labels page edits all three.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { catalogue, t } from "../src/lib/i18n.js";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { WorkloadCategoriesCard } from "../src/components/AdminWorkloadCategories.jsx";
import {
  WORKLOAD_CATEGORY_KEYS,
  WORKLOAD_CATEGORY_LABEL_KEYS,
  WORKLOAD_CATEGORY_RESOURCE,
  liveWorkloadCategoriesApi,
  sampleWorkloadCategoriesApi,
  shownWorkloadCategories,
  workloadCategoryLayout,
} from "../src/lib/workloadCategories.js";
import { loadOrganizationWorkloadCategories, saveOrganizationWorkloadCategories } from "../src/lib/memberApi.js";

const ORDER = ["aged_cases", "priority", "pending", "unread_docs", "todos", "referrals", "ce_activities", "assistance_requests"];
const HIDDEN = ["todos", "referrals"];
const categories = { categories: ORDER.map((key) => ({ key, visible: !HIDDEN.includes(key) })), canEdit: false };
const counts = Object.fromEntries(WORKLOAD_CATEGORY_KEYS.map((key, index) => [key, index + 1]));
const stats = {
  enoughData: true,
  categories: WORKLOAD_CATEGORY_KEYS.map((key) => ({ key, avg: 2, median: 2, p90: 3 })),
  tiles: { pctFullTime: 50, pctPartTime: 50, avgOtHours: 1 },
};
const entries = [{ id: "e1", receipt: "R1", counts, meta: "", note: "", dateLabel: "Nov 2" }];

function renderView({ workload = {}, labelOverrides = null, onLogWork = vi.fn().mockResolvedValue({}), lang = "en" } = {}) {
  const view = render(
    <LanguageProvider lang={lang} labelOverrides={labelOverrides}>
      <WorkloadView data={{ workload: { entries, stats, reminders: { available: false }, ...workload } }} onLogWork={onLogWork} onSaveReminder={vi.fn()} />
    </LanguageProvider>,
  );
  return { ...view, onLogWork };
}

const name = (key, lang = "en") => t(lang, `workload.cat.${key}`);
const submitRows = (container) => [...container.querySelectorAll(".mwl-catrow__label")].map((node) => node.textContent);
const openTab = (tab) => fireEvent.click(screen.getByRole("button", { name: t("en", `workload.tab.${tab}`) }));

beforeEach(() => {
  clearDeviceParityState();
});

describe("workload category layout", () => {
  it("reads all eight in the saved order, appends any left out, and falls back when nothing is shown", () => {
    expect(workloadCategoryLayout(null).map((item) => item.key)).toEqual(WORKLOAD_CATEGORY_KEYS);
    expect(workloadCategoryLayout({ categories: "no" }).every((item) => item.visible)).toBe(true);
    expect(workloadCategoryLayout({ categories: [{ key: "todos", visible: false }, { key: "todos", visible: true }, { key: "overtime", visible: true }, null] }))
      .toEqual([{ key: "todos", visible: false }, ...WORKLOAD_CATEGORY_KEYS.filter((key) => key !== "todos").map((key) => ({ key, visible: true }))]);
    expect(shownWorkloadCategories({ categories: WORKLOAD_CATEGORY_KEYS.map((key) => ({ key, visible: false })) })).toEqual(WORKLOAD_CATEGORY_KEYS);
    expect(shownWorkloadCategories(categories)).toEqual(ORDER.filter((key) => !HIDDEN.includes(key)));
    expect(WORKLOAD_CATEGORY_LABEL_KEYS).toEqual(WORKLOAD_CATEGORY_KEYS.map((key) => `workload.cat.${key}`));
  });
});

describe("member Workload log with organization categories", () => {
  it("shows all eight in the default order and names when nothing is saved", () => {
    const { container } = renderView();
    expect(submitRows(container)).toEqual(WORKLOAD_CATEGORY_KEYS.map((key) => name(key)));
  });

  it("uses the organization's names in entry, history and stats", () => {
    const { container } = renderView({ labelOverrides: { "workload.cat.priority": "Hot files", "workload.cat.aged_cases": "Old cases" } });
    expect(submitRows(container)[0]).toBe("Hot files");
    expect(submitRows(container)).toContain("Old cases");
    expect(screen.getByRole("group", { name: "Hot files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("en", "workload.stepper.increase", { label: "Hot files" }) })).toBeInTheDocument();
    openTab("history");
    expect(container.querySelector(".mwl-histline")).toHaveTextContent("Hot files 1");
    openTab("stats");
    expect([...container.querySelectorAll(".mwl-bar__label")].map((node) => node.textContent)[0]).toBe("Hot files");
    expect([...container.querySelectorAll(".mwl-cmprow__label")].map((node) => node.textContent)).toContain("Old cases");
  });

  it("orders the shown categories and leaves the hidden ones out of entry and every summary", () => {
    const { container } = renderView({ workload: { categories } });
    const shown = ORDER.filter((key) => !HIDDEN.includes(key)).map((key) => name(key));
    expect(submitRows(container)).toEqual(shown);
    for (const key of HIDDEN) expect(screen.queryByRole("group", { name: name(key) })).toBeNull();

    openTab("history");
    const line = container.querySelector(".mwl-histline").textContent;
    expect(line.startsWith(`${name("aged_cases")} 8`)).toBe(true);
    for (const key of HIDDEN) expect(line).not.toContain(name(key));

    openTab("stats");
    expect([...container.querySelectorAll(".mwl-bar__label")].map((node) => node.textContent)).toEqual(shown);
    expect([...container.querySelectorAll(".mwl-cmprow__label")].map((node) => node.textContent)).toEqual(shown);
  });

  it("still logs all eight fields, with a hidden category as 0 even from an earlier draft", async () => {
    const onLogWork = vi.fn().mockResolvedValue({});
    const first = renderView({ onLogWork });
    const increase = (key) => screen.getByRole("button", { name: t("en", "workload.stepper.increase", { label: name(key) }) });
    fireEvent.click(increase("todos"));
    fireEvent.click(increase("priority"));
    first.rerender(
      <LanguageProvider lang="en">
        <WorkloadView data={{ workload: { entries, stats, reminders: { available: false }, categories } }} onLogWork={onLogWork} onSaveReminder={vi.fn()} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: t("en", "workload.submitCta") }));
    await waitFor(() => expect(onLogWork).toHaveBeenCalledTimes(1));
    const fields = onLogWork.mock.calls[0][0];
    for (const key of WORKLOAD_CATEGORY_KEYS) expect(fields).toHaveProperty(key);
    expect(fields.todos).toBe(0);
    expect(fields.priority).toBe(1);
  });

  it("keeps every category, hidden or not, in the CSV export", () => {
    const blobs = [];
    const createObjectURL = vi.fn((blob) => { blobs.push(blob); return "blob:workload"; });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    renderView({ workload: { categories } });
    openTab("history");
    fireEvent.click(screen.getByRole("button", { name: t("en", "workload.downloadCsv") }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    return blobs[0].text().then((text) => {
      expect(text.replace(/^\uFEFF/u, "").split("\r\n")[0]).toBe(["date", "receipt", ...WORKLOAD_CATEGORY_KEYS, "meta", "note", "worked_on", "hours_worked"].join(","));
    });
  });
});

function renderCard({ api: overrides = {}, configuration = { labelOverrides: { "workload.cat.priority": "Hot files" } }, chapterScoped = false, lang = "en" } = {}) {
  const api = {
    loadWorkloadCategories: vi.fn().mockResolvedValue({ categories: WORKLOAD_CATEGORY_KEYS.map((key) => ({ key, visible: true })), canEdit: true }),
    saveWorkloadCategories: vi.fn(async (layout) => ({ categories: layout, canEdit: true })),
    updateOrganizationLabel: vi.fn(async (key, value) => (value ? { key, value, updated: true } : { key, value: null, removed: true })),
    ...overrides,
  };
  const reload = vi.fn();
  const onNotice = vi.fn();
  const view = render(
    <LanguageProvider lang={lang} labelOverrides={configuration?.labelOverrides ?? null}>
      <WorkloadCategoriesCard configuration={configuration} chapterScoped={chapterScoped} api={api} reload={reload} onNotice={onNotice} />
    </LanguageProvider>,
  );
  return { ...view, api, reload, onNotice };
}

const rowKeys = (container) => [...container.querySelectorAll(".xus-workload-row")].map((node) => node.dataset.testid.replace("admin-workload-category-", ""));
const saveButton = (lang = "en") => screen.getByRole("button", { name: t(lang, "admin.workloadCategories.save") });

describe("admin workload categories card", () => {
  // Record 8435: Save stays focusable while it saves.
  it("keeps Save focused while the layout is saved, and saves it once", async () => {
    const { container, api } = renderCard();
    await waitFor(() => expect(rowKeys(container)).toEqual(WORKLOAD_CATEGORY_KEYS));
    fireEvent.click(screen.getByRole("button", { name: t("en", "admin.workloadCategories.moveDown", { label: "Hot files" }) }));
    await expectHeldWriteFocus(api.saveWorkloadCategories, saveButton());
    expect(api.saveWorkloadCategories).toHaveBeenCalledTimes(1);
  });
  it("renames, hides and reorders, then saves the layout and only the changed names", async () => {
    const { container, api, reload, onNotice } = renderCard();
    await waitFor(() => expect(rowKeys(container)).toEqual(WORKLOAD_CATEGORY_KEYS));
    expect(screen.getByLabelText(new RegExp(t("en", "admin.workloadCategories.nameFor", { label: name("priority") })))).toHaveValue("Hot files");
    expect(saveButton()).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: t("en", "admin.workloadCategories.moveDown", { label: "Hot files" }) }));
    expect(rowKeys(container).slice(0, 2)).toEqual(["pending", "priority"]);
    expect(screen.getByRole("status")).toHaveTextContent(t("en", "admin.workloadCategories.moved", { label: "Hot files", position: 2, total: 8 }));
    fireEvent.click(screen.getByRole("button", { name: t("en", "admin.workloadCategories.moveUp", { label: name("aged_cases") }) }));
    expect(rowKeys(container).slice(-2)).toEqual(["aged_cases", "assistance_requests"]);
    expect(screen.getByRole("button", { name: t("en", "admin.workloadCategories.moveUp", { label: name("pending") }) })).toBeDisabled();
    expect(screen.getByRole("button", { name: t("en", "admin.workloadCategories.moveDown", { label: name("assistance_requests") }) })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: t("en", "admin.workloadCategories.showName", { label: name("todos") }) }));
    fireEvent.change(screen.getByLabelText(new RegExp(t("en", "admin.workloadCategories.nameFor", { label: name("referrals") }))), { target: { value: "  Sent   out " } });
    fireEvent.change(screen.getByLabelText(new RegExp(t("en", "admin.workloadCategories.nameFor", { label: name("priority") }))), { target: { value: "" } });
    fireEvent.click(saveButton());

    const expected = ["pending", "priority", "unread_docs", "todos", "referrals", "ce_activities", "aged_cases", "assistance_requests"]
      .map((key) => ({ key, visible: key !== "todos" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(t("en", "admin.workloadCategories.saved")));
    expect(api.saveWorkloadCategories).toHaveBeenCalledWith(expected);
    expect(api.updateOrganizationLabel.mock.calls).toEqual([["workload.cat.priority", ""], ["workload.cat.referrals", "Sent out"]]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps unsaved names and order when the settings reload, and follows the server for untouched ones", async () => {
    const api = {
      loadWorkloadCategories: vi.fn().mockResolvedValue({ categories: WORKLOAD_CATEGORY_KEYS.map((key) => ({ key, visible: true })), canEdit: true }),
      saveWorkloadCategories: vi.fn(),
      updateOrganizationLabel: vi.fn(),
    };
    const view = (configuration, cardApi = api) => (
      <LanguageProvider lang="en" labelOverrides={configuration.labelOverrides}>
        <WorkloadCategoriesCard configuration={configuration} api={cardApi} reload={vi.fn()} onNotice={vi.fn()} />
      </LanguageProvider>
    );
    const { container, rerender } = render(view({ labelOverrides: { "workload.cat.priority": "Hot files" } }));
    await screen.findAllByRole("checkbox");
    const field = (key) => screen.getByLabelText(new RegExp(t("en", "admin.workloadCategories.nameFor", { label: name(key) })));
    fireEvent.change(field("todos"), { target: { value: "Tasks" } });
    fireEvent.click(screen.getByRole("button", { name: t("en", "admin.workloadCategories.moveDown", { label: "Hot files" }) }));
    // The Labels card saved nav.home, and someone renamed Pending meanwhile.
    rerender(view({ labelOverrides: { "workload.cat.priority": "Hot files", "workload.cat.pending": "Waiting", "nav.home": "Start" } }));
    expect(field("todos")).toHaveValue("Tasks");
    expect(field("pending")).toHaveValue("Waiting");
    expect(field("priority")).toHaveValue("Hot files");
    // The layout read runs again (the card's settings came back) and keeps the move.
    rerender(view({ labelOverrides: { "workload.cat.priority": "Hot files", "workload.cat.pending": "Waiting", "nav.home": "Start" } }, { ...api }));
    await waitFor(() => expect(api.loadWorkloadCategories).toHaveBeenCalledTimes(2));
    await screen.findAllByRole("checkbox");
    expect(rowKeys(container).slice(0, 2)).toEqual(["pending", "priority"]);
    expect(saveButton()).toBeEnabled();
  });

  it("follows a reloaded layout when nothing was moved", async () => {
    const reordered = [...WORKLOAD_CATEGORY_KEYS].reverse();
    const loadWorkloadCategories = vi.fn()
      .mockResolvedValueOnce({ categories: WORKLOAD_CATEGORY_KEYS.map((key) => ({ key, visible: true })) })
      .mockResolvedValue({ categories: reordered.map((key) => ({ key, visible: true })) });
    const make = () => ({ loadWorkloadCategories, saveWorkloadCategories: vi.fn(), updateOrganizationLabel: vi.fn() });
    const view = (api) => (
      <LanguageProvider lang="en">
        <WorkloadCategoriesCard configuration={{ labelOverrides: {} }} api={api} reload={vi.fn()} onNotice={vi.fn()} />
      </LanguageProvider>
    );
    const { container, rerender } = render(view(make()));
    await waitFor(() => expect(rowKeys(container)).toEqual(WORKLOAD_CATEGORY_KEYS));
    rerender(view(make()));
    await waitFor(() => expect(rowKeys(container)).toEqual(reordered));
    expect(saveButton()).toBeDisabled();
  });

  it("saves only names when the order and visibility did not change", async () => {
    const { api, onNotice } = renderCard();
    await screen.findAllByRole("checkbox");
    fireEvent.change(screen.getByLabelText(new RegExp(t("en", "admin.workloadCategories.nameFor", { label: name("todos") }))), { target: { value: "Tasks" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(api.saveWorkloadCategories).not.toHaveBeenCalled();
    expect(api.updateOrganizationLabel).toHaveBeenCalledWith("workload.cat.todos", "Tasks");
  });

  it("keeps at least one category shown and refuses angle brackets in a name", async () => {
    renderCard();
    const boxes = await screen.findAllByRole("checkbox");
    for (const box of boxes) fireEvent.click(box);
    expect(screen.getByRole("alert")).toHaveTextContent(t("en", "admin.workloadCategories.noneShown"));
    expect(saveButton()).toBeDisabled();
    fireEvent.click(boxes[0]);
    expect(saveButton()).toBeEnabled();
    const input = screen.getByLabelText(new RegExp(t("en", "admin.workloadCategories.nameFor", { label: name("pending") })));
    fireEvent.change(input, { target: { value: "<b>" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(saveButton()).toBeDisabled();
  });

  it("reports a failed save and keeps the edits", async () => {
    const { container, onNotice } = renderCard({ api: { saveWorkloadCategories: vi.fn().mockRejectedValue(new Error("offline")) } });
    await screen.findAllByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: t("en", "admin.workloadCategories.moveDown", { label: "Hot files" }) }));
    fireEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "admin.workloadCategories.failed"));
    expect(rowKeys(container).slice(0, 2)).toEqual(["pending", "priority"]);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("stops when the session answers nothing", async () => {
    const { api, onNotice } = renderCard({ api: { saveWorkloadCategories: vi.fn().mockResolvedValue(undefined) } });
    await screen.findAllByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: t("en", "admin.workloadCategories.moveDown", { label: "Hot files" }) }));
    fireEvent.change(screen.getByLabelText(new RegExp(t("en", "admin.workloadCategories.nameFor", { label: name("todos") }))), { target: { value: "Tasks" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.saveWorkloadCategories).toHaveBeenCalled());
    expect(api.updateOrganizationLabel).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("stops the name loop when a label write answers nothing", async () => {
    const { api, onNotice } = renderCard({ api: { updateOrganizationLabel: vi.fn().mockResolvedValue(null) } });
    await screen.findAllByRole("checkbox");
    fireEvent.change(screen.getByLabelText(new RegExp(t("en", "admin.workloadCategories.nameFor", { label: name("todos") }))), { target: { value: "Tasks" } });
    fireEvent.change(screen.getByLabelText(new RegExp(t("en", "admin.workloadCategories.nameFor", { label: name("pending") }))), { target: { value: "Waiting" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateOrganizationLabel).toHaveBeenCalledTimes(1));
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("shows the unavailable note or a load failure instead of controls, and nothing to a chapter-only Admin", async () => {
    const unavailable = renderCard({ configuration: null });
    expect(unavailable.container).toHaveTextContent(t("en", "admin.config.unavailable"));
    expect(unavailable.api.loadWorkloadCategories).not.toHaveBeenCalled();
    unavailable.unmount();

    const scoped = renderCard({ chapterScoped: true });
    expect(scoped.api.loadWorkloadCategories).not.toHaveBeenCalled();
    expect(scoped.container).toBeEmptyDOMElement();
    scoped.unmount();

    const failed = renderCard({ api: { loadWorkloadCategories: vi.fn().mockRejectedValue(new Error("offline")) } });
    await waitFor(() => expect(failed.container).toHaveTextContent(t("en", "admin.config.unavailable")));
    failed.unmount();

    const pending = renderCard({ api: { loadWorkloadCategories: vi.fn(() => new Promise(() => {})) } });
    expect(screen.getByRole("status")).toHaveTextContent(t("en", "admin.workloadCategories.loading"));
    pending.unmount();
  });

  it("is written in Spanish too", async () => {
    renderCard({ lang: "es", configuration: { labelOverrides: {} } });
    await screen.findAllByRole("checkbox");
    expect(screen.getByRole("heading", { name: t("es", "admin.workloadCategories.title") })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: t("es", "admin.workloadCategories.showName", { label: name("priority", "es") }) })).toBeInTheDocument();
    expect(saveButton("es")).toBeDisabled();
    for (const key of Object.keys(catalogue.en).filter((item) => item.startsWith("admin.workloadCategories."))) {
      expect(catalogue.es[key], key).toBeTruthy();
      expect(catalogue.es[key], key).not.toBe(catalogue.en[key]);
    }
  });
});

describe("workload category admin APIs", () => {
  const all = (hidden = []) => WORKLOAD_CATEGORY_KEYS.map((key) => ({ key, visible: !hidden.includes(key) }));
  const applyTo = (setData, current) => setData.mock.calls.reduce((state, [update]) => update(state), current);

  it("calls the two RPCs with only the key and a strict visible flag", async () => {
    const client = { rpc: vi.fn(async () => ({ data: { categories: all(), canEdit: true }, error: null })) };
    await expect(loadOrganizationWorkloadCategories(client)).resolves.toEqual({ categories: all(), canEdit: true });
    expect(client.rpc).toHaveBeenLastCalledWith("get_organization_workload_categories");
    await saveOrganizationWorkloadCategories(client, [{ key: "todos", visible: "yes", extra: 1 }, { key: "pending", visible: true }]);
    expect(client.rpc).toHaveBeenLastCalledWith("save_organization_workload_categories", {
      p_categories: [{ key: "todos", visible: false }, { key: "pending", visible: true }],
    });
    const refused = { rpc: vi.fn(async () => ({ data: null, error: { code: "42501", message: "admin role required" } })) };
    await expect(saveOrganizationWorkloadCategories(refused, all())).rejects.toBeTruthy();
  });

  it("puts a live save into member state only while the session that started it is current", async () => {
    let current = true;
    const guardRef = { current: { captureOperation: () => ({ isCurrent: () => current }) } };
    const setData = vi.fn();
    const saved = { categories: all(["todos"]), canEdit: true };
    const load = vi.fn().mockResolvedValue(saved);
    const save = vi.fn().mockResolvedValue(saved);
    const loaderRef = { current: { invalidateResources: vi.fn() } };
    const api = liveWorkloadCategoriesApi({ load, save, guardRef, loaderRef, setData });
    await expect(api.loadWorkloadCategories()).resolves.toBe(saved);
    await expect(api.saveWorkloadCategories(all(["todos"]))).resolves.toBe(saved);
    expect(save).toHaveBeenCalledWith(all(["todos"]));
    expect(loaderRef.current.invalidateResources).toHaveBeenCalledWith([WORKLOAD_CATEGORY_RESOURCE]);
    expect(applyTo(setData, { workload: { entries: [1] }, other: true })).toEqual({ workload: { entries: [1], categories: saved }, other: true });
    expect(applyTo(setData, null)).toBeNull();
    current = false;
    await expect(api.saveWorkloadCategories(all())).resolves.toBeUndefined();
    expect(setData).toHaveBeenCalledTimes(1);
    expect(loaderRef.current.invalidateResources).toHaveBeenCalledTimes(1);
    // No loader yet (a session still booting) is not an error.
    current = true;
    loaderRef.current = null;
    await expect(api.saveWorkloadCategories(all())).resolves.toBe(saved);
  });

  it("keeps the SAMPLE desk to the server's rules and records the change in configuration history", async () => {
    const d = { configurationAudit: [{ id: "older" }] };
    const setData = vi.fn();
    const api = sampleWorkloadCategoriesApi({ desk: () => d, setData });
    await expect(api.loadWorkloadCategories()).resolves.toEqual({ categories: all(), canEdit: true });
    for (const bad of [null, all().slice(0, 7), [...all().slice(0, 7), { key: "priority", visible: true }], [...all().slice(0, 7), { key: "aged_cases", visible: "no" }]]) {
      await expect(api.saveWorkloadCategories(bad)).rejects.toThrow("workload-categories-invalid");
    }
    await expect(api.saveWorkloadCategories(all(WORKLOAD_CATEGORY_KEYS))).rejects.toThrow("workload-categories-none-shown");
    const order = [...WORKLOAD_CATEGORY_KEYS].reverse().map((key) => ({ key, visible: key !== "todos" }));
    const result = await api.saveWorkloadCategories(order);
    expect(result).toEqual({ categories: order, canEdit: true });
    await expect(api.loadWorkloadCategories()).resolves.toEqual({ categories: order, canEdit: true });
    expect(d.configurationAudit[0]).toMatchObject({
      id: "demo-workload-categories-2", action: "setting_updated", key: "workload.categories", actorName: "Alex Rivera",
      previousValue: WORKLOAD_CATEGORY_KEYS, newValue: [...WORKLOAD_CATEGORY_KEYS].reverse().filter((key) => key !== "todos"),
    });
    expect(d.configurationAudit[1]).toEqual({ id: "older" });
    expect(applyTo(setData, { workload: {} })).toEqual({ workload: { categories: result } });
    const empty = { };
    await sampleWorkloadCategoriesApi({ desk: () => empty, setData: vi.fn() }).saveWorkloadCategories(all());
    expect(empty.configurationAudit).toHaveLength(1);
  });
});
