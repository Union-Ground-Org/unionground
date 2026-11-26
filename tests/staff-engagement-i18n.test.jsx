import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { engagementApi } from "../src/features/engagement/api.js";

const client = {};
const snapshot = { surveys: [], livePolls: [], channels: [], pulsePrompts: [] };
function view(page, lang = "es") {
  window.history.replaceState({}, "", `/m/campaigns/engagement/${page}`);
  return <LanguageProvider lang={lang}><WorkspacePages view="campaigns" location={`https://fixture.invalid/m/campaigns/engagement/${page}`} navigate={() => {}}><StaffEngagement client={client} /></WorkspacePages></LanguageProvider>;
}
beforeEach(() => {
  vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(snapshot);
  vi.spyOn(engagementApi, "loadWeeklySelection").mockResolvedValue({ items: [], policy: {} });
});
afterEach(() => { window.history.replaceState({}, "", "/"); cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("staff engagement saved Spanish language", () => {
  it.each([
    ["surveys", "Nueva encuesta"], ["weekly", "Política de selección semanal"],
    ["polls", "Nueva votación en vivo"], ["pulse", "Nueva pregunta"],
    ["delivery", "Cola de entrega de correo"], ["channels", "Canales"],
  ])("localizes the directly addressed %s page", async (page, label) => {
    render(view(page));
    expect(await screen.findByRole("heading", { name: "Espacio de voz de los trabajadores" })).toBeInTheDocument();
    expect(await screen.findByText(label, { exact: true })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("es");
    expect(screen.getByRole("navigation", { name: "Espacio de participación" })).toHaveTextContent("Encuestas");
    expect(screen.queryByText("Worker voice workspace")).not.toBeInTheDocument();
  });
});

describe("localized engagement authoring preserves persisted values", () => {
  it("keeps survey status styling independent of the translated label", async () => {
    engagementApi.loadStaff.mockResolvedValue({ ...snapshot, surveys: [{ id: "survey", title: "Authored title", status: "open" }] });
    render(view("surveys"));
    expect(await screen.findByText("abierta", { exact: true })).toHaveClass("eng-status--open");
  });

  it("renders survey report answers as plain labels instead of JSON-quoted tokens", async () => {
    engagementApi.loadStaff.mockResolvedValue({ ...snapshot, surveys: [{ id: "survey", title: "Authored title", status: "open" }] });
    vi.spyOn(engagementApi, "loadSurveyReport").mockResolvedValue({
      available: true, responseCount: 5, privacyMinResponses: 3,
      questions: [{ id: "question", label: "¿Cómo va el turno?", answered: 5, distribution: [{ value: "Muy de acuerdo", count: 3 }, { value: 4, count: 2 }, { value: ["Turno", "Horas"], count: 1 }, { value: { raw: true }, count: 1 }] }],
    });
    render(view("surveys"));
    fireEvent.click(await screen.findByRole("button", { name: "Informe" }));
    expect(await screen.findByText("Muy de acuerdo: 3 · 4: 2 · Turno, Horas: 1 · —: 1")).toBeInTheDocument();
    expect(screen.queryByText(/"Muy de acuerdo"/)).not.toBeInTheDocument();
  });

  it("translates weekly status text while retaining its canonical style modifier", async () => {
    engagementApi.loadWeeklySelection.mockResolvedValue({ items: [{ id: "weekly", body: "Authored weekly question", weekStart: "2026-09-07", score: 1, editorialState: "reserved", options: [] }], policy: {} });
    render(view("weekly"));
    expect(await screen.findByText("reservada", { exact: true })).toHaveClass("eng-status--reserved");
  });

  it("uses Spanish poll controls while saving canonical eligibility and visibility", async () => {
    vi.spyOn(engagementApi, "saveLivePoll").mockResolvedValue({ id: "poll" });
    render(view("polls"));
    fireEvent.click(await screen.findByRole("button", { name: "Nueva votación en vivo" }));
    const form = screen.getByRole("heading", { name: "Crear una votación" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Pregunta"), { target: { value: "Member-authored question stays unchanged" } });
    fireEvent.change(within(form).getByLabelText("Quiénes pueden participar"), { target: { value: "chapter" } });
    fireEvent.change(within(form).getByLabelText("Resultados"), { target: { value: "staff_only" } });
    fireEvent.change(within(form).getByLabelText("Opción 1"), { target: { value: "Keep this answer" } });
    fireEvent.submit(form);
    await waitFor(() => expect(engagementApi.saveLivePoll).toHaveBeenCalledWith(client, expect.objectContaining({
      title: "Member-authored question stays unchanged", eligibility: "chapter", resultsVisibility: "staff_only",
      options: [{ label: "Keep this answer" }, { label: "" }],
    })));
    expect(await screen.findByRole("status")).toHaveTextContent("Borrador de votación en vivo guardado.");
  });

  it("localizes survey branching controls and keeps yes/no branch values canonical", async () => {
    render(view("surveys"));
    fireEvent.click(await screen.findByRole("button", { name: "Nueva encuesta" }));
    const form = screen.getByRole("heading", { name: "Nueva encuesta" }).closest("form");
    expect(within(form).getByLabelText("Título de apartado")).toHaveValue("Tu experiencia");
    fireEvent.change(within(form).getByLabelText("Tipo"), { target: { value: "yes_no" } });
    fireEvent.click(within(form).getByRole("button", { name: "Agregar pregunta" }));
    const showAfter = within(form).getByLabelText("Mostrar solo después de");
    fireEvent.change(showAfter, { target: { value: showAfter.options[1].value } });
    const answer = within(form).getByLabelText("La respuesta es");
    expect(within(answer).getByRole("option", { name: "Sí" })).toHaveValue("yes");
    expect(within(answer).getByRole("option", { name: "No" })).toHaveValue("no");
    expect(within(form).getAllByRole("button", { name: "Quitar pregunta" })).toHaveLength(2);
  });

  it("localizes new contextual defaults and starts on the Voice page screen", async () => {
    vi.spyOn(engagementApi, "savePulsePrompt").mockResolvedValue({ id: "pulse" });
    render(view("pulse"));
    fireEvent.click(await screen.findByRole("button", { name: "Nueva pregunta" }));
    const form = screen.getByRole("heading", { name: "Encuesta breve contextual" }).closest("form");
    expect(within(form).getByLabelText("Opciones, una por línea")).toHaveValue("Sí\nNo");
    fireEvent.change(within(form).getByLabelText("Pregunta"), { target: { value: "¿Necesitas ayuda?" } });
    fireEvent.submit(form);
    await waitFor(() => expect(engagementApi.savePulsePrompt).toHaveBeenCalledWith(client, expect.objectContaining({ eventKey: "voice.open", options: ["Sí", "No"] })));
  });

  it("localizes channel controls and does not translate channel names or API enums", async () => {
    engagementApi.loadStaff.mockResolvedValue({ ...snapshot, channels: [{ spaceId: "room", name: "Original channel name", postingMode: "members", slowModeSeconds: 0 }] });
    vi.spyOn(engagementApi, "setChannelControls").mockResolvedValue({});
    render(view("channels"));
    expect(await screen.findByRole("heading", { name: "Original channel name" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Publicaciones"), { target: { value: "read_only" } });
    await waitFor(() => expect(engagementApi.setChannelControls).toHaveBeenCalledWith(client, "room", expect.objectContaining({ postingMode: "read_only" })));
    expect(screen.getByLabelText("Exigir aprobación de publicaciones")).toBeInTheDocument();
  });

  it("updates the existing page when the saved language changes", async () => {
    const { rerender } = render(view("polls", "en"));
    expect(await screen.findByRole("button", { name: "New live poll" })).toBeInTheDocument();
    rerender(view("polls", "es"));
    expect(await screen.findByRole("button", { name: "Nueva votación en vivo" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Votaciones en vivo" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Live polls" })).not.toBeInTheDocument();
  });

  it("announces localized loading and retry states", async () => {
    engagementApi.loadStaff.mockRejectedValueOnce(new Error("")).mockResolvedValue(snapshot);
    render(view("surveys"));
    expect(screen.getByRole("status")).toHaveTextContent("Cargando operaciones de participación…");
    expect(await screen.findByRole("alert")).toHaveTextContent("Las operaciones de participación no están disponibles.");
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("button", { name: "Nueva encuesta" })).toBeInTheDocument();
  });
});

it("localizes live poll states and transition notices without changing poll content", async () => {
  engagementApi.loadStaff.mockResolvedValue({ ...snapshot, livePolls: [{ id: "poll", title: "Keep the authored title", state: "draft", voteCount: 3, results: [], attendance: {} }] });
  vi.spyOn(engagementApi, "transitionLivePoll").mockResolvedValue({});
  render(view("polls"));
  expect(await screen.findByText("borrador", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("3 votos")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Abrir", exact: true }));
  await waitFor(() => expect(engagementApi.transitionLivePoll).toHaveBeenCalledWith(client, "poll", "open"));
  expect(await screen.findByRole("status")).toHaveTextContent("Votación abierta.");
  fireEvent.click(screen.getByRole("button", { name: "Vista para proyector" }));
  const dialog = screen.getByRole("dialog", { name: "Keep the authored title" });
  expect(within(dialog).getByText("3 votos · borrador")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Cerrar" })).toHaveFocus();
});

describe("weekly pool load failure recovery", () => {
  const question = { id: "weekly", body: "Authored weekly question", weekStart: "2026-09-07", score: 1, editorialState: "reserved", options: [] };
  const copy = {
    en: {
      loading: "Loading the weekly question pool…",
      failed: "Weekly questions could not be loaded.",
      tryAgain: "Try again",
      archive: "Show publication archive",
    },
    es: {
      loading: "Cargando las preguntas semanales…",
      failed: "No se pudieron cargar las preguntas semanales.",
      tryAgain: "Reintentar",
      archive: "Mostrar archivo de publicaciones",
    },
  };

  it.each(["en", "es"])("replaces the stuck spinner with retry copy in %s", async (lang) => {
    const strings = copy[lang];
    let failWorkspace = true;
    engagementApi.loadWeeklySelection.mockImplementation(() => (
      failWorkspace
        ? Promise.reject(new Error("workspace unavailable"))
        : Promise.resolve({ items: [question], policy: {} })
    ));
    vi.spyOn(engagementApi, "loadWeeklySelectionPage").mockResolvedValue({ items: [question], nextCursor: null });

    render(view("weekly", lang));

    expect(await screen.findByText(strings.failed)).toBeInTheDocument();
    expect(screen.queryByText(strings.loading)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.tryAgain })).toBeInTheDocument();

    const callsBeforeArchive = engagementApi.loadWeeklySelection.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: strings.archive }));
    await waitFor(() => {
      expect(engagementApi.loadWeeklySelection.mock.calls.length).toBeGreaterThan(callsBeforeArchive);
      expect(screen.getByText(strings.failed)).toBeInTheDocument();
    });
    expect(screen.queryByText(strings.loading)).not.toBeInTheDocument();
    expect(screen.queryAllByRole("status").filter((node) => node.textContent.includes(strings.loading))).toHaveLength(0);
    expect(screen.getAllByRole("alert").filter((node) => node.textContent.includes(strings.failed))).toHaveLength(1);

    failWorkspace = false;
    fireEvent.click(screen.getByRole("button", { name: strings.tryAgain }));
    expect(await screen.findByText("Authored weekly question")).toBeInTheDocument();
    expect(screen.queryByText(strings.failed)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.loading)).not.toBeInTheDocument();
  });
});

describe("staff engagement projector focus restore", () => {
  const openPoll = {
    ...snapshot,
    livePolls: [{ id: "poll", title: "Keep the authored title", state: "open", voteCount: 3, results: [], attendance: {} }],
  };

  it("returns focus to the projector trigger after the drawer closes while mounted", async () => {
    engagementApi.loadStaff.mockResolvedValue(openPoll);
    render(view("polls"));
    const trigger = await screen.findByRole("button", { name: "Vista para proyector" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Keep the authored title" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not throw when the projector restore timer fires after unmount", async () => {
    engagementApi.loadStaff.mockResolvedValue(openPoll);
    const { unmount } = render(view("polls"));
    fireEvent.click(await screen.findByRole("button", { name: "Vista para proyector" }));
    expect(screen.getByRole("dialog", { name: "Keep the authored title" })).toBeInTheDocument();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      vi.stubGlobal("document", undefined);
      expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
