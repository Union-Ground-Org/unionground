import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { EventsDeskView } from "../src/views/EventsDeskView.jsx";

describe("events desk runtime", () => {
  it("loads and renders the shared event authoring surface", async () => {
    const api = { loadDesk: vi.fn().mockResolvedValue({ events: [] }) };
    render(<LanguageProvider lang="en"><EventsDeskView api={api} onNotice={vi.fn()} chapterName="Harborview Care United" /></LanguageProvider>);
    expect(await screen.findByRole("heading", { level: 1, name: "Meetings desk" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New meeting" })).toBeInTheDocument();
    expect(screen.getByText("No campaign meetings yet.")).toBeInTheDocument();
  });

  it("shows a loading status instead of the empty copy while loadDesk is pending", async () => {
    let resolve;
    const api = { loadDesk: vi.fn(() => new Promise((done) => { resolve = done; })) };
    render(<LanguageProvider lang="en"><EventsDeskView api={api} onNotice={vi.fn()} chapterName="Harborview Care United" /></LanguageProvider>);
    expect(screen.queryByText("No campaign meetings yet.")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading meetings");
    expect(screen.getByRole("button", { name: "New meeting" })).toBeInTheDocument();
    resolve({ events: [{ id: "member-meeting", title: "Member meeting", startsLabel: "Aug 14, noon", location: "Union hall" }] });
    expect(await screen.findByText("Member meeting")).toBeInTheDocument();
    expect(screen.queryByText("No campaign meetings yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders a stable localized load error", async () => {
    const api = { loadDesk: vi.fn().mockRejectedValue(new Error("private provider detail")) };
    render(<LanguageProvider lang="es"><EventsDeskView api={api} onNotice={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar");
    expect(screen.queryByText(/provider detail/)).not.toBeInTheDocument();
    expect(screen.queryByText("Aún no hay reuniones de la campaña.")).not.toBeInTheDocument();
    expect(screen.queryByText("No campaign meetings yet.")).not.toBeInTheDocument();
  });

  it("renders the translated Events desk subtitle through PlaneHeader in English and Spanish", async () => {
    expect(catalogue.en["eventsDesk.sub"]).not.toBe(catalogue.es["eventsDesk.sub"]);
    const api = { loadDesk: vi.fn().mockResolvedValue({ events: [] }) };
    for (const lang of ["en", "es"]) {
      const expected = catalogue[lang]["eventsDesk.sub"];
      const other = catalogue[lang === "en" ? "es" : "en"]["eventsDesk.sub"];
      render(<LanguageProvider lang={lang}><EventsDeskView api={api} onNotice={vi.fn()} chapterName="Harborview Care United" /></LanguageProvider>);
      expect(await screen.findByRole("heading", { level: 1, name: catalogue[lang]["eventsDesk.navLabel"] })).toBeInTheDocument();
      expect(expected).toEqual(expect.any(String));
      expect(expected).not.toBe("eventsDesk.sub");
      const subtitle = screen.getByText(expected);
      expect(subtitle).toHaveClass("phead__sub");
      expect(subtitle).not.toHaveClass("xus-cardsub");
      expect(screen.queryByText("eventsDesk.sub")).not.toBeInTheDocument();
      expect(screen.queryByText(other)).not.toBeInTheDocument();
      expect(document.querySelector(".xus-cardsub")).toBeNull();
      cleanup();
    }
  });
});
