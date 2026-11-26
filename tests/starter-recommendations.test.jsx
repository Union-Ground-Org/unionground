import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { StarterRecommendations } from "../src/features/orgSetup/StarterRecommendations.jsx";
import { buildStarterRecommendations, starterCatalogContext } from "../src/features/orgSetup/starterRecommendations.js";
import { loadSetupProfile } from "../src/features/orgSetup/setupApi.js";
import { ISSUE_FAMILIES } from "../src/features/issueIntelligence/model.js";
import { starterRecommendationsCatalogue } from "../src/lib/i18n/starterRecommendations.js";
import { workspacePageForLocation } from "../src/lib/workspacePages.js";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import axe from "axe-core";

afterEach(cleanup);
const raw = {
  found: true, organization: { key: "olms-900000099", name: "Example Organization", sector: "public" },
  subunits: [{ key: "chapter", name: "Example chapter", employer: "Example agency", kind: "chapter" }],
  documents: [{ kind: "contract", key: "c", title: "Example contract", url: "https://example.invalid/contract" },
    { kind: "form", key: "f", title: "Example form", url: "https://example.invalid/form", asOf: "2026-10-01" }],
};
const signals = { enabled: true, viewer: "staff", signals: [
  { family: ISSUE_FAMILIES.contractRights, evidenceFamilies: ["cases"] },
  { family: ISSUE_FAMILIES.retaliation, evidenceFamilies: ["cases"] },
] };
const show = (props = {}, lang = "en") => render(<LanguageProvider lang={lang}><StarterRecommendations {...props} /></LanguageProvider>);

describe("starter recommendation building", () => {
  it("uses sector, agency presence and safe catalog documents without carrying employer prose", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: raw, error: null });
    const profile = await loadSetupProfile({ rpc }, raw.organization.key);
    expect(rpc).toHaveBeenCalledWith("get_union_catalog_profile", { p_key: raw.organization.key });
    expect(profile.starter).toEqual(starterCatalogContext(raw));
    expect(JSON.stringify(profile)).not.toContain("Example agency");
    expect(buildStarterRecommendations({ catalog: profile.starter })).toEqual([
      expect.objectContaining({ id: "library", reasons: ["sector.public", "document.contract"], documents: [expect.objectContaining({ title: "Example contract" })] }),
      expect.objectContaining({ id: "structure", reasons: ["agency"] }),
      expect.objectContaining({ id: "forms", reasons: ["document.form"] }),
    ]);
  });

  it("accepts only known sectors and safe, bounded, deduplicated document links", () => {
    expect(starterCatalogContext(null)).toBeNull();
    expect(starterCatalogContext({ found: true })).toEqual({ confidence: "unreviewed", sector: null, agencyListed: false, documents: [] });
    const context = starterCatalogContext({ ...raw, organization: { sector: "invented" }, documents: [
      null, { kind: "form", title: "" }, { kind: "newsletter", title: "Ignored" },
      { kind: "form", title: "Unsafe", url: "javascript:alert(1)" },
      { kind: "form", title: "Unsafe", url: "https://user:secret@example.invalid" },
      { kind: "form", title: "Broken", url: "not a URL" },
      ...raw.documents, ...raw.documents,
      ...Array.from({ length: 9 }, (_, i) => ({ kind: "handbook", title: `Handbook ${i}`, url: `https://example.invalid/${i}` })),
    ] });
    expect(context.sector).toBeNull();
    expect(context.documents).toHaveLength(6);
    expect(new Set(context.documents.map((doc) => doc.href)).size).toBe(6);
    expect(context.documents.every((doc) => doc.href.startsWith("https://example.invalid/"))).toBe(true);
  });

  it.each(["public", "private", "mixed"])("explains a %s sector recommendation", (sector) => {
    expect(buildStarterRecommendations({ catalog: { sector } })[0].reasons).toEqual([`sector.${sector}`]);
  });

  it.each(["contract", "support", "learning"])("builds from the creator's %s answer without needing cases", (focus) => {
    const items = buildStarterRecommendations({ answers: { focus, multiUnit: "yes" } });
    expect(items[0].reasons).toEqual([`answer.${focus}`]);
    expect(items[1]).toMatchObject({ id: "structure", reasons: ["answer.multiUnit"] });
  });

  it("ignores missing/unknown answers and merges case reasons into the starter set", () => {
    expect(buildStarterRecommendations()).toEqual([]);
    expect(buildStarterRecommendations({ answers: { focus: "other", multiUnit: "no" } })).toEqual([]);
    const items = buildStarterRecommendations({ catalog: starterCatalogContext(raw), answers: { focus: "contract" }, caseSignals: signals });
    expect(items.map((item) => item.id)).toEqual(["library", "structure", "forms"]);
    expect(items[0].reasons).toEqual(["sector.public", "document.contract", "answer.contract", "cases.contract"]);
    expect(items[2].reasons).toEqual(["document.form", "cases.support"]);
    expect(buildStarterRecommendations({ caseSignals: { ...signals, signals: [...signals.signals, ...signals.signals] } })[0].reasons).toEqual(["cases.contract"]);
  });

  it("requires enabled staff signals, known families and explicit case evidence", () => {
    for (const caseSignals of [null, {}, { ...signals, enabled: false }, { ...signals, viewer: "member" },
      { ...signals, signals: [{ family: ISSUE_FAMILIES.retaliation }, { family: ISSUE_FAMILIES.contractRights, evidenceFamilies: ["messages"] }, { family: "unknown", evidenceFamilies: ["cases"] }] },
      { enabled: true, viewer: "staff" }]) expect(buildStarterRecommendations({ caseSignals })).toEqual([]);
  });

  it("resolves every recommendation to the real authorized workspace page", () => {
    for (const item of buildStarterRecommendations({ catalog: starterCatalogContext(raw) })) {
      expect(workspacePageForLocation(item.href)?.path).toBe(item.href);
    }
  });

  it.each(["official_site", "secondary", "olms_filing", "not_found"])("retains the %s provenance marker", (confidence) => {
    expect(starterCatalogContext({ ...raw, organization: { confidence } }).confidence).toBe(confidence);
  });
});

describe("starter recommendations in setup", () => {
  it("offers optional accessible questions and changes recommendations without a write", () => {
    show();
    expect(screen.getByText(/Choose a public listing or answer a question/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "What would help your organization first?" }), { target: { value: "support" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Does your chapter have more than one unit?" }), { target: { value: "yes" } });
    expect(screen.getByText(/Why: you chose member support/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open form review and import" })).toHaveAttribute("href", "/m/admin/form-templates");
    expect(screen.getByRole("link", { name: "Open organization structure" })).toHaveAttribute("href", "/m/admin/organization");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows public source links and all reasons alongside server-protected case signals", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: signals, error: null });
    show({ catalog: starterCatalogContext(raw), issueSignals: { client: { rpc }, scopeKey: "org-a" } });
    expect(await screen.findAllByText(/case.*in your organization\./)).toHaveLength(2);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_issue_intelligence_signals", { p_selected_hat: "admin" });
    const contract = screen.getByRole("link", { name: "Example contract" });
    expect(contract).toHaveAttribute("href", "https://example.invalid/contract");
    expect(contract).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.getAllByText(/Why:/).length).toBe(6);
  });

  it("keeps starter suggestions available when the case service fails", async () => {
    show({ catalog: starterCatalogContext(raw), issueSignals: { client: { rpc: vi.fn().mockRejectedValue(new Error("unavailable")) } } });
    await screen.findByText(/Case-based suggestions could not be loaded/);
    expect(screen.getByRole("link", { name: "Example contract" })).toBeInTheDocument();
  });

  it("keeps the chosen role during navigation and provides accessible controls in both languages", async () => {
    const navigate = vi.fn();
    const view = render(<LanguageProvider lang="en"><WorkspacePages view="admin" location="/m/admin/setup-review" hat="admin" navigate={navigate} menu={false}><StarterRecommendations catalog={starterCatalogContext(raw)} /></WorkspacePages></LanguageProvider>);
    fireEvent.click(screen.getByRole("link", { name: /Open library to review/ }));
    expect(navigate).toHaveBeenCalledWith("hub", "/m/organize/library", null, { replace: false });
    fireEvent.click(screen.getByRole("link", { name: /Open form review/ }));
    expect(navigate).toHaveBeenCalledWith("admin", "/m/admin/form-templates", null, { replace: false });
    fireEvent.click(screen.getByRole("link", { name: /Open organization structure/ }), { ctrlKey: true });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect((await axe.run(view.container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
    view.unmount();
    show({ catalog: starterCatalogContext(raw) }, "es");
    expect((await axe.run(screen.getByRole("region", { name: /Un punto de partida/ }), { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });

  it("clears answers and drops late case results when the setup organization changes", async () => {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const first = { client: { rpc: () => pending }, scopeKey: "org-a" };
    const { rerender } = show({ issueSignals: first });
    fireEvent.change(screen.getByRole("combobox", { name: /What would help/ }), { target: { value: "support" } });
    rerender(<LanguageProvider lang="en"><StarterRecommendations key="org-b" /></LanguageProvider>);
    resolve({ data: signals, error: null });
    await waitFor(() => expect(screen.getByRole("combobox", { name: /What would help/ })).toHaveValue(""));
    expect(screen.queryByText(/Why:/)).toBeNull();
  });

  it("has Spanish copy for every reason and control", () => {
    expect(Object.keys(starterRecommendationsCatalogue.es).sort()).toEqual(Object.keys(starterRecommendationsCatalogue.en).sort());
    show({ catalog: starterCatalogContext(raw) }, "es");
    const section = screen.getByRole("region", { name: "Un punto de partida para tu organización" });
    fireEvent.change(within(section).getByRole("combobox", { name: "¿Qué ayudaría primero a tu organización?" }), { target: { value: "learning" } });
    expect(within(section).getByText(/Por qué: elegiste compartir información/)).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: /Abrir la biblioteca/ })).toBeInTheDocument();
  });
});
