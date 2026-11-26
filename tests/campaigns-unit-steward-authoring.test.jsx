// SEC-UG-UNIT-STEWARD-OPENS-CHAPTER-WIDE-VOTE-CAMPAIGNS-20261115 (,
// and 's web work): a steward limited to one unit is refused every
// chapter-wide campaign save, so the Campaigns page offers them neither New
// campaign nor New officer removal ballot. The page reads the server's
// canManageChapter; an answer without it keeps the controls.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CampaignsView } from "../src/views/CampaignsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

function view(registry, lang = "en") {
  const api = {
    load: vi.fn().mockResolvedValue({ campaigns: [], chapterId: "wor", ...registry }),
    saveDraft: vi.fn(),
    saveRemovalDraft: vi.fn(),
    removalDetails: vi.fn().mockResolvedValue({ enabled: true, byId: new Map() }),
    removalTargets: vi.fn().mockResolvedValue([]),
  };
  render(<LanguageProvider lang={lang}><CampaignsView api={api} /></LanguageProvider>);
  return api;
}
const chapterRadio = () => screen.queryByRole("radio", { name: "My campaign" });
const unionRadio = () => screen.queryByRole("radio", { name: "Organization-wide" });

describe("Campaigns page authoring controls for a unit-limited steward", () => {
  it("hides both create controls and says who runs chapter-wide campaigns", async () => {
    view({ canManageUnion: false, canManageChapter: false });
    expect(await screen.findByTestId("campaigns-leadership-only")).toHaveTextContent("Ballots and pulses for the whole campaign are run by campaign leadership.");
    expect(screen.queryByRole("button", { name: "New campaign" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New officer removal ballot" })).not.toBeInTheDocument();
  });

  it("says it in Spanish too", async () => {
    view({ canManageUnion: false, canManageChapter: false }, "es");
    expect(await screen.findByTestId("campaigns-leadership-only")).toHaveTextContent("Las votaciones y los sondeos de todo la campaña los organiza la dirección de la campaña.");
    expect(screen.queryByRole("button", { name: "Nueva campaña" })).not.toBeInTheDocument();
  });

  it("keeps both controls for chapter leadership, chapter-wide staff and carry-over stewards", async () => {
    view({ canManageUnion: false, canManageChapter: true });
    fireEvent.click(await screen.findByRole("button", { name: "New campaign" }));
    expect(chapterRadio()).toBeChecked();
    expect(unionRadio()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New officer removal ballot" })).toBeInTheDocument();
    expect(screen.queryByTestId("campaigns-leadership-only")).not.toBeInTheDocument();
  });

  it("keeps both controls when the answer has no canManageChapter field", async () => {
    view({ canManageUnion: false });
    expect(await screen.findByRole("button", { name: "New campaign" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "New officer removal ballot" })).toBeInTheDocument();
    expect(screen.queryByTestId("campaigns-leadership-only")).not.toBeInTheDocument();
  });

  it("starts an organization-wide draft with no chapter choice for an author with only the organization scope", async () => {
    const api = view({ canManageUnion: true, canManageChapter: false });
    fireEvent.click(await screen.findByRole("button", { name: "New campaign" }));
    expect(chapterRadio()).not.toBeInTheDocument();
    expect(unionRadio()).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "New officer removal ballot" }));
    expect(chapterRadio()).not.toBeInTheDocument();
    expect(unionRadio()).toBeChecked();
    expect(api.removalTargets).toHaveBeenCalledWith("union");
  });

  //, a review note: while the registry is still loading, a missing
  // canManageChapter counted as "may author", so New campaign showed and an
  // editor opened then stayed open after the answer refused it.
  it("shows no create control and no leadership line until the registry answers", async () => {
    let answer;
    const api = {
      load: vi.fn(() => new Promise((resolve) => { answer = resolve; })),
      saveDraft: vi.fn(),
      saveRemovalDraft: vi.fn(),
      removalDetails: vi.fn().mockResolvedValue({ enabled: true, byId: new Map() }),
      removalTargets: vi.fn().mockResolvedValue([]),
    };
    render(<LanguageProvider lang="en"><CampaignsView api={api} /></LanguageProvider>);
    expect(screen.queryByRole("button", { name: "New campaign" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New officer removal ballot" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("campaigns-leadership-only")).not.toBeInTheDocument();
    await act(async () => { answer({ campaigns: [], chapterId: "wor", canManageUnion: false, canManageChapter: false }); });
    expect(await screen.findByTestId("campaigns-leadership-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New campaign" })).not.toBeInTheDocument();
  });

  // The refetch that closes an editor says so in the live
  // notice; a refetch that still allows the audience keeps the typed text.
  const registryApi = (canManageChapter, canManageUnion = false) => ({
    load: vi.fn().mockResolvedValue({ campaigns: [], chapterId: "wor", canManageUnion, canManageChapter }),
    saveDraft: vi.fn(),
    saveRemovalDraft: vi.fn(),
    removalDetails: vi.fn().mockResolvedValue({ enabled: true, byId: new Map() }),
    removalTargets: vi.fn().mockResolvedValue([]),
  });
  const page = (api, lang = "en") => <LanguageProvider lang={lang}><CampaignsView api={api} /></LanguageProvider>;
  const closedNotice = "Your permission to write campaigns for that audience changed, so the unsaved draft was closed.";
  const editors = [
    { name: "New campaign", open: "New campaign", field: "English title", text: "Ratify the agreement" },
    { name: "officer removal ballot", open: "New officer removal ballot", field: "Reason (at least 10 characters)", text: "Missed every meeting since June" },
  ];

  for (const editor of editors) {
    it(`closes an open ${editor.name} editor a later answer refuses, and says so in the live notice`, async () => {
      const { rerender, container } = render(page(registryApi(true)));
      fireEvent.click(await screen.findByRole("button", { name: editor.open }));
      fireEvent.change(screen.getByLabelText(editor.field), { target: { value: editor.text } });
      expect(container.querySelector(".cam-live")).toHaveTextContent("");
      // A fresh read (here: a new api) now says this account may not author for the chapter.
      rerender(page(registryApi(false)));
      expect(await screen.findByTestId("campaigns-leadership-only")).toBeInTheDocument();
      // The editor closes in the effect that follows the refusing answer.
      await waitFor(() => expect(screen.queryByLabelText(editor.field)).not.toBeInTheDocument());
      expect(chapterRadio()).not.toBeInTheDocument();
      const live = container.querySelector(".cam-live");
      expect(live).toHaveAttribute("aria-live", "polite");
      await waitFor(() => expect(live).toHaveTextContent(closedNotice));
    });

    it(`keeps the typed text of an open ${editor.name} editor when a later answer still allows it, with no notice`, async () => {
      const { rerender, container } = render(page(registryApi(true)));
      fireEvent.click(await screen.findByRole("button", { name: editor.open }));
      fireEvent.change(screen.getByLabelText(editor.field), { target: { value: editor.text } });
      const api = registryApi(true, true);
      rerender(page(api));
      // The second answer adds the union audience, so its radio shows once it has landed.
      await waitFor(() => expect(unionRadio()).toBeInTheDocument());
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByLabelText(editor.field)).toHaveValue(editor.text);
      expect(container.querySelector(".cam-live")).toHaveTextContent("");
    });
  }

  it("says in Spanish that the unsaved draft was closed", async () => {
    const { rerender, container } = render(page(registryApi(true), "es"));
    fireEvent.click(await screen.findByRole("button", { name: "Nueva campaña" }));
    rerender(page(registryApi(false), "es"));
    expect(await screen.findByTestId("campaigns-leadership-only")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector(".cam-live")).toHaveTextContent("Cambió su permiso para escribir campañas para ese público, así que se cerró el borrador sin guardar."));
  });
});
