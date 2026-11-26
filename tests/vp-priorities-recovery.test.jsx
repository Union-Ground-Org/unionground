import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VpView } from "../src/views/VpView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { SHELL_LOAD_DEADLINE_MS } from "../src/lib/loadDeadline.js";

const loaded = { overview: { priorities: [{ id: "p1", kind: "pulse", title: "Safety priorities" }] }, roster: [] };
function setup(api, lang = "en") {
  window.history.replaceState({}, "", "/m/vp/priorities");
  return render(<LanguageProvider lang={lang}><WorkspacePages view="vp" hat="vp" location="/m/vp/priorities" navigate={vi.fn()}>
    <VpView data={{ member: { initials: "TM" } }} api={api} />
  </WorkspacePages></LanguageProvider>);
}
afterEach(() => { vi.useRealTimers(); window.history.replaceState({}, "", "/"); });

describe("/m/vp/priorities request recovery", () => {
  it.each(["en", "es"])("announces a rejected priorities request and retries successfully (%s)", async (lang) => {
    const api = { loadDesk: vi.fn().mockRejectedValueOnce(new Error("private backend detail")).mockResolvedValueOnce(loaded) };
    setup(api, lang);
    expect(await screen.findByRole("alert")).toHaveTextContent(lang === "en" ? "Load failed" : "Error al cargar");
    expect(document.body).not.toHaveTextContent("private backend detail");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: lang === "en" ? "Try again" : "Reintentar" }));
    expect(await screen.findByText("Safety priorities")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.loadDesk).toHaveBeenCalledTimes(2);
  });

  it("times out a hung request, recovers on retry, and ignores the old request's late response", async () => {
    vi.useFakeTimers();
    let finishOld;
    const api = { loadDesk: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce(loaded) };
    setup(api);
    expect(screen.getByRole("status")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS));
    expect(screen.getByRole("alert")).toHaveTextContent("Load failed");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(screen.getByText("Safety priorities")).toBeInTheDocument();
    await act(async () => finishOld({ overview: { priorities: [] }, roster: [] }));
    expect(screen.getByText("Safety priorities")).toBeInTheDocument();
  });
});
