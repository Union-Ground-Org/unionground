import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChapterBindingCard } from "../src/components/ChapterLifecycleAdmin.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const ORGANIZATION_SCOPE = {
  scope: "organization",
  chapterId: null,
  canCreateChapter: true,
  chapters: [
    { id: "wor", name: "Harborview Care United", region: "Central" },
    { id: "bos", name: "Harborview Care Boston", region: "Metro" },
  ],
};

const FIRST_RESULTS = [
  { id: "tamarack-100", name: "Tamarack Local 100", city: "Cedar Ridge", state: "MA", affiliation: "Tamarack" },
  { id: "tamarack-1199", name: "Tamarack Local 1199", city: "Pine Harbor", state: "MA", affiliation: "Tamarack" },
];

const LATER_RESULTS = [
  { id: "aft-123", name: "AFT Local 123", city: "Springfield", state: "MA", affiliation: "AFT" },
];

function lifecycle() {
  return {
    chapterId: "wor",
    binding: null,
    connections: [],
    handshakes: [],
    documents: [],
    events: [],
    sharedDocuments: [],
    latestHealth: null,
  };
}

function makeApi(overrides = {}) {
  return {
    searchUnionOrganizations: vi.fn().mockResolvedValue(FIRST_RESULTS),
    requestChapterBinding: vi.fn().mockResolvedValue({ requested: true, chapterId: "wor" }),
    requestConnectionSetup: vi.fn().mockResolvedValue({ status: "configuring" }),
    verifyConnectionSetup: vi.fn().mockResolvedValue({ status: "active" }),
    shareHandshakeDocument: vi.fn().mockResolvedValue({ shared: true }),
    grantChapterMembership: vi.fn().mockResolvedValue({ active: true }),
    revokeChapterMembership: vi.fn().mockResolvedValue({ active: false }),
    setChapterRole: vi.fn().mockResolvedValue({ enabled: true }),
    loadMemberDirectory: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    ...overrides,
  };
}

function mountBinding({ api = makeApi(), lang = "en" } = {}) {
  const onNotice = vi.fn();
  const reload = vi.fn().mockResolvedValue(undefined);
  render(<LanguageProvider lang={lang}>
    <ChapterBindingCard lifecycle={lifecycle()} organization={ORGANIZATION_SCOPE} api={api} reload={reload} onNotice={onNotice} />
  </LanguageProvider>);
  return { api, onNotice, reload };
}

async function submitSearch(query, searchName) {
  const search = screen.getByRole("searchbox", { name: searchName });
  fireEvent.change(search, { target: { value: query } });
  fireEvent.submit(search.closest("form"));
}

describe("chapter lifecycle admin — organization search selection reconcile", () => {
  it("withholds sub-threshold text searches while allowing a single-digit local number", async () => {
    const { api } = mountBinding({ api: makeApi({ searchUnionOrganizations: vi.fn().mockResolvedValue([]) }) });
    await submitSearch("a", "Find the real union organization");
    expect(screen.getByRole("button", { name: "Search organizations" })).toHaveAttribute("aria-disabled", "true");
    expect(api.searchUnionOrganizations).not.toHaveBeenCalled();
    expect(screen.queryByText("No organizations matched this search.")).toBeNull();
    await submitSearch("7", "Find the real union organization");
    expect(await screen.findByText("No organizations matched this search.")).toBeInTheDocument();
    expect(api.searchUnionOrganizations).toHaveBeenCalledExactlyOnceWith("7");
    await submitSearch("a", "Find the real union organization");
    expect(api.searchUnionOrganizations).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No organizations matched this search.")).toBeNull();
  });

  it("clears a stale pick after an empty or different search and never requests a hidden organization", async () => {
    const api = makeApi({
      searchUnionOrganizations: vi.fn()
        .mockResolvedValueOnce(FIRST_RESULTS)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(LATER_RESULTS),
    });
    mountBinding({ api });

    await submitSearch("Tamarack", "Find the real union organization");
    const second = await screen.findByRole("radio", { name: /Tamarack Local 1199/ });
    expect(screen.getByRole("radio", { name: /Tamarack Local 100/ })).toBeInTheDocument();
    const request = screen.getByRole("button", { name: "Request binding review" });
    expect(request).toBeDisabled();
    fireEvent.click(second);
    expect(request).toBeEnabled();

    await submitSearch("none", "Find the real union organization");
    expect(await screen.findByText("No organizations matched this search.")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(request).toBeDisabled();
    fireEvent.click(request);
    expect(api.requestChapterBinding).not.toHaveBeenCalled();

    await submitSearch("AFT", "Find the real union organization");
    expect(await screen.findByRole("radio", { name: /AFT Local 123/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Tamarack Local 1199/ })).toBeNull();
    expect(screen.queryByText("No organizations matched this search.")).toBeNull();
    expect(request).toBeDisabled();
    fireEvent.click(request);
    expect(api.requestChapterBinding).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: /AFT Local 123/ }));
    expect(request).toBeEnabled();
    expect(api.requestChapterBinding).not.toHaveBeenCalled();
  });

  it("renders the Spanish empty-results sentence after a completed search with no rows", async () => {
    const api = makeApi({
      searchUnionOrganizations: vi.fn()
        .mockResolvedValueOnce(FIRST_RESULTS)
        .mockResolvedValueOnce([]),
    });
    mountBinding({ api, lang: "es" });

    await submitSearch("Tamarack", "Buscar la organización sindical real");
    fireEvent.click(await screen.findByRole("radio", { name: /Tamarack Local 1199/ }));
    const request = screen.getByRole("button", { name: "Solicitar revisión del vínculo" });
    expect(request).toBeEnabled();

    await submitSearch("nada", "Buscar la organización sindical real");
    expect(await screen.findByText("Ninguna organización coincidió con esta búsqueda.")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(request).toBeDisabled();
    fireEvent.click(request);
    expect(api.requestChapterBinding).not.toHaveBeenCalled();
  });
});
