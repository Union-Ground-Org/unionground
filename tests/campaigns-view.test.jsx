import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignsView } from "../src/views/CampaignsView.jsx";
import { publishCampaign } from "../src/lib/campaignApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick, expectPendingFocus } from "./helpers/busyWriteFocus.js";

const draft = {
  id: "ballot-draft", kind: "ballot", scope: "chapter", chapterId: "wor",
  titleEn: "Contract vote", titleEs: "Votación del contrato", bodyEn: "", bodyEs: "",
  closesAt: new Date(Date.now() + 86400000).toISOString(), quorumTarget: 125, state: "draft", active: false,
  options: [
    { id: "yes", labelEn: "Yes", labelEs: "Sí", orderIndex: 1 },
    { id: "no", labelEn: "No", labelEs: "No", orderIndex: 2 },
  ],
};

function wrap(ui, lang = "en") {
  return render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);
}

describe("CampaignsView", () => {
  it("uses a labelled section so the application shell remains the only main landmark", () => {
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [], canManageUnion: false, chapterId: "wor" }) };
    const view = wrap(<CampaignsView api={api} />);
    expect(view.container.querySelector("main.campaigns-screen")).toBeNull();
    expect(view.container.querySelector("section.campaigns-screen")).toHaveAccessibleName("Campaigns");
  });

  it("renders loading then a truthful empty state and create action", async () => {
    let resolve;
    const api = { load: () => new Promise((done) => { resolve = done; }) };
    wrap(<CampaignsView api={api} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading campaigns");
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drafts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Closed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /All 0/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Drafts 0/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open 0/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Closed 0/ })).not.toBeInTheDocument();
    expect(document.querySelector(".cam-filters")).toHaveAttribute("aria-busy", "true");
    resolve({ campaigns: [], canManageUnion: false, chapterId: "wor" });
    expect(await screen.findByText("No campaigns yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New campaign" })).toBeInTheDocument();
  });

  it("shows load failure with a working retry", async () => {
    const api = { load: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ campaigns: [], canManageUnion: false, chapterId: "wor" }) };
    wrap(<CampaignsView api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Campaigns are unavailable");
    expect(screen.queryByRole("button", { name: /All 0/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No campaigns yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No campaigns yet")).toBeInTheDocument();
    expect(api.load).toHaveBeenCalledTimes(2);
  });

  it("shows load failure when api.load hangs past the shared deadline", async () => {
    const api = { load: vi.fn(() => new Promise(() => {})) };
    wrap(<CampaignsView api={api} loadDeadlineMs={40} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading campaigns");
    expect(await screen.findByRole("alert")).toHaveTextContent("Campaigns are unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api.load).toHaveBeenCalledTimes(2);
  });

  it("edits a bilingual draft and requires confirmation before publishing", async () => {
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: true, chapterId: "wor" }),
      saveDraft: vi.fn().mockResolvedValue({ id: draft.id, state: "draft" }),
      publish: vi.fn().mockResolvedValue({ id: draft.id, state: "open" }),
      close: vi.fn(),
    };
    wrap(<CampaignsView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit Contract vote/ }));
    expect(screen.getByRole("heading", { name: "Edit draft" })).toBeInTheDocument();
    expect(screen.getByLabelText("English title")).toHaveValue("Contract vote");
    expect(screen.getByLabelText("Spanish title")).toHaveValue("Votación del contrato");
    fireEvent.change(screen.getByLabelText("English details"), { target: { value: "Review the tentative agreement." } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ bodyEn: "Review the tentative agreement." })));
    fireEvent.click(screen.getByRole("button", { name: /Publish Contract vote/ }));
    const dialog = screen.getByRole("dialog", { name: "Publish campaign?" });
    expect(within(dialog).getByText(/125 eligible workers/)).toBeInTheDocument();
    expect(within(dialog).getByText(/workers in your campaign/i)).toBeInTheDocument();
    expect(api.publish).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith("ballot", draft.id));
  });

  // Record 8435, Nov 24 triage:  made the editor's four
  // fieldsets natively disabled while the draft saved, which also disabled the
  // pending controls inside them; Enter in a field lost the keyboard focus.
  it("keeps focus on a field in every editor fieldset while the draft saves", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: true, chapterId: "wor" }),
      saveDraft: vi.fn(async () => { await held; return { id: draft.id, state: "draft" }; }),
      publish: vi.fn(),
      close: vi.fn(),
    };
    wrap(<CampaignsView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit Contract vote/ }));
    const form = screen.getByRole("heading", { name: "Edit draft" }).closest("form");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveDraft).toHaveBeenCalledTimes(1));
    const fieldsets = [...form.querySelectorAll("fieldset.cam-fieldset")];
    expect(fieldsets).toHaveLength(4);
    for (const fieldset of fieldsets) await expectPendingFocus(fieldset.querySelector("input:not([disabled])"));
    await act(async () => { release(); });
  });

  it("traps confirmation focus, restores the trigger, and confirms close explicitly", async () => {
    const open = { ...draft, id: "ballot-open", state: "open", active: true };
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [open], canManageUnion: false, chapterId: "wor" }),
      close: vi.fn().mockResolvedValue({ id: open.id, state: "closed" }),
    };
    wrap(<CampaignsView api={api} />);
    const trigger = await screen.findByRole("button", { name: /Close Contract vote/ });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Close campaign?" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const close = within(dialog).getByRole("button", { name: "Close now" });
    await waitFor(() => expect(within(dialog).getByRole("heading", { name: "Close campaign?" })).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    close.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(api.close).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Close campaign?" })).getByRole("button", { name: "Close now" }));
    await waitFor(() => expect(api.close).toHaveBeenCalledWith("ballot", open.id));
  });

  // The confirmation leaves
  // with the 200 ms scrim fade, focus held inside and nothing answered mid-fade.
  it("holds the confirmation for its close fade, ignores a second answer, then returns focus", async () => {
    const open = { ...draft, id: "ballot-open", state: "open", active: true };
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [open], canManageUnion: false, chapterId: "wor" }),
      close: vi.fn().mockResolvedValue({ id: open.id, state: "closed" }),
    };
    wrap(<CampaignsView api={api} />);
    const trigger = await screen.findByRole("button", { name: /Close Contract vote/ });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Close campaign?" });
    const layer = dialog.parentElement;
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.click(cancel);
    expect(layer).toHaveAttribute("data-state", "closing");
    expect(cancel).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close now" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.mouseDown(layer);
    expect(api.close).not.toHaveBeenCalled();
    fireEvent.transitionEnd(dialog);
    expect(layer.isConnected).toBe(true);
    fireEvent.transitionEnd(layer);
    expect(screen.queryByRole("dialog", { name: "Close campaign?" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes the confirmation at once under reduced motion", async () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn((query) => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    try {
      const open = { ...draft, id: "ballot-open", state: "open", active: true };
      const api = { load: vi.fn().mockResolvedValue({ campaigns: [open], canManageUnion: false, chapterId: "wor" }), close: vi.fn() };
      wrap(<CampaignsView api={api} />);
      const trigger = await screen.findByRole("button", { name: /Close Contract vote/ });
      trigger.focus();
      fireEvent.click(trigger);
      fireEvent.keyDown(screen.getByRole("dialog", { name: "Close campaign?" }), { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Close campaign?" })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it("keeps quorum off pulses and labels demo writes as preview-only in Spanish", async () => {
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [], canManageUnion: true, chapterId: "wor" }), saveDraft: vi.fn() };
    wrap(<CampaignsView api={api} demo />, "es");
    expect(await screen.findByText("Vista previa: los cambios se restablecen al salir")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Nueva campaña" }));
    fireEvent.click(screen.getByLabelText("Pulso"));
    expect(screen.queryByLabelText("Quórum requerido")).not.toBeInTheDocument();
    expect(screen.getByText("Los pulsos no usan quórum.")).toBeInTheDocument();
  });

  it("shows the SAMPLE Voice studio without falsely labeling backed writes as preview-only", async () => {
    const api = {
      load: vi.fn().mockResolvedValue({
        campaigns: [],
        canManageUnion: true,
        chapterId: "wor",
      }),
    };
    wrap(<CampaignsView api={api} sampleStudio />);
    expect(
      screen.getByRole("heading", { name: "Survey and meeting studio" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Preview: changes reset when you leave"),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("No campaigns yet")).toBeInTheDocument();
  });

  it("builds, reorders, filters, and reports a failed union pulse draft", async () => {
    const open = { ...draft, id: "ballot-open", state: "open", active: true };
    const closed = { ...draft, id: "ballot-closed", state: "closed", active: false };
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [closed, open, draft], canManageUnion: true, chapterId: "wor" }),
      saveDraft: vi.fn().mockRejectedValue(new Error("offline")),
    };
    wrap(<CampaignsView api={api} />);

    expect(await screen.findAllByText("Contract vote")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /Open 1/ }));
    expect(screen.getAllByText("Contract vote")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /All 3/ }));

    fireEvent.click(screen.getByRole("button", { name: "New campaign" }));
    fireEvent.click(screen.getByLabelText("Pulse"));
    fireEvent.click(screen.getByLabelText("Organization-wide"));
    fireEvent.change(screen.getByLabelText("English title"), { target: { value: "Member pulse" } });
    fireEvent.change(screen.getByLabelText("Spanish title"), { target: { value: "Pulso de miembros" } });
    fireEvent.change(screen.getByLabelText("English details"), { target: { value: "Choose one." } });
    fireEvent.change(screen.getByLabelText("Spanish details"), { target: { value: "Elige una." } });
    fireEvent.change(screen.getByLabelText("Option 1 in English"), { target: { value: "Ready" } });
    fireEvent.change(screen.getByLabelText("Option 1 in Spanish"), { target: { value: "Listo" } });
    fireEvent.change(screen.getByLabelText("Option 2 in English"), { target: { value: "Not yet" } });
    fireEvent.change(screen.getByLabelText("Option 2 in Spanish"), { target: { value: "Todavía no" } });
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getByLabelText("Option 3 in English"), { target: { value: "Unsure" } });
    fireEvent.change(screen.getByLabelText("Option 3 in Spanish"), { target: { value: "No sé" } });
    fireEvent.click(screen.getByRole("button", { name: "Move option 3 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Move option 2 down" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove option 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(api.saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      kind: "pulse",
      scope: "union",
      titleEn: "Member pulse",
      quorumTarget: 1,
    })));
    expect(await screen.findByText("That campaign change could not be saved.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "New campaign" })).not.toBeInTheDocument();
  });

  it("keeps a failed publish confirmation open and reports the error", async () => {
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: false, chapterId: "wor" }),
      publish: vi.fn().mockRejectedValue(new Error("offline")),
    };
    wrap(<CampaignsView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /Publish Contract vote/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Publish campaign?" })).getByRole("button", { name: "Publish now" }));
    //: said inside the open window as well as on the page line under it.
    expect(await within(screen.getByRole("dialog", { name: "Publish campaign?" })).findByText("That campaign change could not be saved.")).toBeInTheDocument();
    expect(document.querySelector(".cam-live")).toHaveTextContent("That campaign change could not be saved.");
  });

  it("confirms an edited draft on its card even while the registry refresh hangs", async () => {
    const api = {
      load: vi.fn().mockResolvedValueOnce({ campaigns: [draft] }).mockImplementation(() => new Promise(() => {})),
      saveDraft: vi.fn().mockResolvedValue({ id: draft.id }),
    };
    wrap(<CampaignsView api={api} />);
    const edit = await screen.findByRole("button", { name: "Edit Contract vote" });
    fireEvent.click(edit);
    const save = screen.getByRole("button", { name: "Save draft" });
    save.focus();
    fireEvent.click(save);
    expect(await within(edit.closest("article")).findByText("Draft saved.")).toHaveAttribute("role", "status");
    expect(edit).toHaveFocus();
    expect(api.load).toHaveBeenCalledTimes(2);
  });

  it("confirms a draft save once in the registry when its card is filtered away during the write", async () => {
    let finish;
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [draft] }),
      saveDraft: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
    };
    wrap(<CampaignsView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Contract vote" }));
    const save = screen.getByRole("button", { name: "Save draft" });
    save.focus();
    fireEvent.click(save);
    const open = screen.getByRole("button", { name: "Open 0" });
    open.focus();
    fireEvent.click(open);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    await act(async () => { finish(); });
    const receipt = screen.getByText(/Contract vote.*Draft saved/);
    expect(receipt).toHaveAttribute("role", "status");
    expect(open).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "All 1" }));
    expect(screen.queryByText(/Contract vote.*Draft saved/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("article")).getByText("Draft saved.")).not.toHaveAttribute("role", "status");
    fireEvent.click(open);
    expect(screen.queryByText(/Draft saved/)).not.toBeInTheDocument();
  });

  it("does not restore opener focus after focus leaves and returns to Save during a pending write", async () => {
    let finish;
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [draft] }),
      saveDraft: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
    };
    wrap(<CampaignsView api={api} />);
    const edit = await screen.findByRole("button", { name: "Edit Contract vote" });
    fireEvent.click(edit);
    const save = screen.getByRole("button", { name: "Save draft" });
    save.focus();
    fireEvent.click(save);
    screen.getByRole("button", { name: "All 1" }).focus();
    save.focus();
    await act(async () => { finish(); });
    expect(await within(edit.closest("article")).findByText("Draft saved.")).toBeInTheDocument();
    expect(edit).not.toHaveFocus();
  });

  it("keeps a Spanish permission refusal by Save until the draft changes", async () => {
    const api = {
      load: vi.fn().mockResolvedValue({ campaigns: [draft] }),
      saveDraft: vi.fn().mockRejectedValue({ code: "42501", message: "campaign scope unavailable" }),
    };
    wrap(<CampaignsView api={api} />, "es");
    fireEvent.click(await screen.findByRole("button", { name: "Editar Votación del contrato" }));
    const form = screen.getByRole("heading", { name: "Editar borrador" }).closest("form");
    const title = within(form).getByDisplayValue(draft.titleEn);
    fireEvent.change(title, { target: { value: "Contract vote update" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar borrador" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Tu rol no permite este cambio");
    expect(title).toHaveValue("Contract vote update");
    fireEvent.change(title, { target: { value: "Revised vote title" } });
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
  });
});

// The campaign writes keep focus on their control while they
// run, and a second activation in the same tick starts no second write.
describe("CampaignsView busy writes", () => {
  const api = () => ({
    load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: true, chapterId: "wor" }),
    saveDraft: vi.fn(async () => ({ id: draft.id, state: "draft" })),
    publish: vi.fn(async () => ({ id: draft.id, state: "open" })),
    close: vi.fn(),
  });

  it("keeps Save draft focused while the draft is saved, and saves it once", async () => {
    const backend = api();
    wrap(<CampaignsView api={backend} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit Contract vote/ }));
    await expectHeldWriteFocus(backend.saveDraft, screen.getByRole("button", { name: "Save draft" }));
    expect(backend.saveDraft).toHaveBeenCalledTimes(1);
  });

  it("keeps Publish now focused while the campaign is published, and publishes it once", async () => {
    const backend = api();
    wrap(<CampaignsView api={backend} />);
    fireEvent.click(await screen.findByRole("button", { name: /Publish Contract vote/ }));
    const dialog = screen.getByRole("dialog", { name: "Publish campaign?" });
    await expectHeldWriteFocus(backend.publish, within(dialog).getByRole("button", { name: "Publish now" }));
    expect(backend.publish).toHaveBeenCalledExactlyOnceWith("ballot", draft.id);
  });

  it("saves a draft once when Save draft is activated twice in one tick", async () => {
    const backend = api();
    wrap(<CampaignsView api={backend} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit Contract vote/ }));
    const save = screen.getByRole("button", { name: "Save draft" });
    await expectOneWriteFromOneTick(backend.saveDraft, [() => fireEvent.click(save), () => fireEvent.click(save)]);
  });

  it("publishes once when Publish now is activated twice in one tick", async () => {
    const backend = api();
    wrap(<CampaignsView api={backend} />);
    fireEvent.click(await screen.findByRole("button", { name: /Publish Contract vote/ }));
    const publish = within(screen.getByRole("dialog", { name: "Publish campaign?" })).getByRole("button", { name: "Publish now" });
    await expectOneWriteFromOneTick(backend.publish, [() => fireEvent.click(publish), () => fireEvent.click(publish)]);
  });
});

// Exercise the real view and its wrapped PostgREST refusal.
describe("expired campaign drafts", () => {
  const now = Date.parse("2030-01-01T12:00:00Z");
  const past = new Date(now - 6 * 60000).toISOString();
  const future = new Date(now + 60000).toISOString();
  const reason = {
    en: "The close date has passed. Change it before publishing.",
    es: "La fecha de cierre ya pasó. Cámbiela antes de publicar.",
  };
  afterEach(() => vi.restoreAllMocks());

  for (const lang of ["en", "es"]) for (const kind of ["ballot", "pulse"]) {
    it(`explains the expired ${kind} in ${lang}, keeps Edit, and restores Publish after a date change`, async () => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      let campaign = { ...draft, kind, closesAt: past };
      const api = {
        load: vi.fn(async () => ({ campaigns: [campaign], canManageUnion: true })),
        saveDraft: vi.fn(async (fields) => { campaign = { ...campaign, closesAt: fields.closesAt }; }),
        publish: vi.fn(),
      };
      wrap(<CampaignsView api={api} />, lang);
      expect(await screen.findByText(reason[lang])).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^(Publish|Publicar) / })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^(Edit|Editar) / }));
      fireEvent.change(screen.getByLabelText(lang === "es" ? "Cierra el" : "Closes at"), { target: { value: "2030-01-02T12:00" } });
      fireEvent.click(screen.getByRole("button", { name: lang === "es" ? "Guardar borrador" : "Save draft" }));
      expect(await screen.findByRole("button", { name: /^(Publish|Publicar) / })).toBeInTheDocument();
      expect(screen.queryByText(reason[lang])).not.toBeInTheDocument();
      expect(api.publish).not.toHaveBeenCalled();
    });

    it(`shows the same ${lang} reason when ${kind} expires during confirmation`, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const client = { rpc: vi.fn(async () => ({ data: null, error: { code: "22023", message: "campaign is not ready to publish" } })) };
      const api = { load: async () => ({ campaigns: [{ ...draft, kind, closesAt: future }] }), publish: (type, id) => publishCampaign(client, type, id) };
      wrap(<CampaignsView api={api} />, lang);
      fireEvent.click(await screen.findByRole("button", { name: /^(Publish|Publicar) / }));
      clock.mockReturnValue(now + 60001);
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: lang === "es" ? "Publicar ahora" : "Publish now" }));
      await waitFor(() => expect(document.querySelector(".cam-live")).toHaveTextContent(reason[lang]));
      expect(client.rpc).toHaveBeenCalledWith("publish_vote_campaign", { p_kind: kind, p_campaign_id: draft.id });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: /^(Publish|Publicar) / })).toBeInTheDocument();
      expect(screen.getAllByText(reason[lang])).toHaveLength(1);
    });

    it.each([
      ["two minutes past", new Date(now - 2 * 60000).toISOString(), true],
      ["six minutes past", past, false],
      ["two minutes before", new Date(now + 2 * 60000).toISOString(), true],
      ["null close time", null, true],
    ])(`keeps the server in charge for ${kind} in ${lang}: %s`, async (_label, closesAt, publishable) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      const client = { rpc: vi.fn(async () => ({ data: null, error: { code: "22023", message: "campaign is not ready to publish" } })) };
      const api = { load: async () => ({ campaigns: [{ ...draft, kind, closesAt }] }), publish: (type, id) => publishCampaign(client, type, id) };
      wrap(<CampaignsView api={api} />, lang);
      await screen.findByRole("button", { name: /^(Edit|Editar) / });
      const publish = screen.queryByRole("button", { name: /^(Publish|Publicar) / });
      if (publishable) {
        expect(publish).toBeInTheDocument();
        expect(screen.queryByText(reason[lang])).not.toBeInTheDocument();
      } else {
        expect(publish).not.toBeInTheDocument();
        expect(screen.getByText(reason[lang])).toBeInTheDocument();
      }
      if (_label === "two minutes past") {
        fireEvent.click(publish);
        fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: lang === "es" ? "Publicar ahora" : "Publish now" }));
        await waitFor(() => expect(document.querySelector(".cam-live")).toHaveTextContent(reason[lang]));
        expect(screen.getAllByText(reason[lang])).toHaveLength(1);
        expect(screen.getByRole("button", { name: /^(Publish|Publicar) / })).toBeInTheDocument();
        expect(client.rpc).toHaveBeenCalledWith("publish_vote_campaign", { p_kind: kind, p_campaign_id: draft.id });
      } else expect(client.rpc).not.toHaveBeenCalled();
    });
  }

  it.each([
    ["22023", "campaign not found", true],
    ["42501", "campaign is not ready to publish", true],
    ["22023", "campaign is not ready to publish", false],
    ["", "Network request failed", true],
  ])("keeps unrelated refusal %s / %s generic (expired: %s)", async (code, message, expires) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const client = { rpc: async () => ({ data: null, error: { code, message } }) };
    const api = { load: async () => ({ campaigns: [{ ...draft, closesAt: future }] }), publish: (type, id) => publishCampaign(client, type, id) };
    wrap(<CampaignsView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Publish / }));
    if (expires) clock.mockReturnValue(now + 60001);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(document.querySelector(".cam-live")).toHaveTextContent("That campaign change could not be saved."));
    expect(document.querySelector(".cam-live")).not.toHaveTextContent(reason.en);
  });
});
