import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChunkBoundary } from "../src/components/ChunkBoundary.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { captureViewError } from "../src/lib/deferredObservability.js";
import { DeferredOrgStartGuide } from "../src/features/onboardingGuideEngine/DeferredOrgStartGuide.jsx";

vi.mock("../src/lib/deferredObservability.js", () => ({ captureViewError: vi.fn() }));
vi.mock("../src/features/onboardingGuideEngine/OrgStartGuide.jsx", () => {
  throw new TypeError("Failed to fetch dynamically imported module: OrgStartGuide.js");
});

const view = {
  kind: "guide", canAct: true, milestones: [], next: null,
  title: { key: "guideEngine.org.cardTitle", params: { org: "Tamarack Valley" } },
  eyebrow: { key: "guideEngine.org.title" },
  ring: { percent: 0, done: 0, total: 7, text: { key: "guideEngine.org.ring", params: { done: 0, total: 7 } } },
};

// #9132: the failed guide's card says so, is not marked busy, and reloads the
// page only when the person presses Reload.
it("keeps the staff home and its controls when the optional guide import rejects after retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const previous = window.location;
  const reload = vi.fn();
  const fetchPage = vi.fn().mockResolvedValue({ ok: true, redirected: false });
  vi.stubGlobal("fetch", fetchPage);
  Object.defineProperty(window, "location", { configurable: true, value: { ...previous, reload } });
  const openWork = vi.fn();
  try {
    render(<LanguageProvider lang="en">
      <ChunkBoundary canReload={() => false} fallback={() => <h1>Staff home failed</h1>}>
        <h1>Staff home</h1>
        <DeferredOrgStartGuide guide={{ view }} />
        <button type="button" onClick={openWork}>Open staff work</button>
      </ChunkBoundary>
    </LanguageProvider>);
    await waitFor(() => expect(captureViewError).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(screen.getByRole("heading", { level: 1, name: "Staff home" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Staff home failed" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Get Tamarack Valley ready for workers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue setup" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("The setup steps could not load.");
    const card = screen.getByRole("heading", { name: "Get Tamarack Valley ready for workers" }).closest("section");
    expect(card).not.toHaveAttribute("aria-busy");
    fireEvent.click(screen.getByRole("button", { name: "Open staff work" }));
    expect(openWork).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: previous });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

it("says the setup steps could not load in Spanish", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(<LanguageProvider lang="es"><DeferredOrgStartGuide guide={{ view }} /></LanguageProvider>);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No se pudieron cargar los pasos de configuración."));
    expect(screen.getByRole("button", { name: "Recargar" })).toBeInTheDocument();
  } finally {
    vi.restoreAllMocks();
  }
});
