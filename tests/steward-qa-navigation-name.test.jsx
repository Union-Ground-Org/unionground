import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

describe("Steward Q&A navigation", () => {
  it.each([["en", "Q&A desk preview", "Q&A queue"], ["es", "Vista previa de preguntas del escritorio", "Cola de preguntas"]])("gives every rail destination a distinct visible name in %s", (lang, preview, queue) => {
    render(<LanguageProvider lang={lang}><DesktopRail active="steward" activeHat="steward" demo renderMode="desktop" staffPlanes={[{ key: "steward", view: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]} onNavigate={vi.fn()} onAsk={vi.fn()} /></LanguageProvider>);
    const links = screen.getAllByRole("link");
    const labels = links.map(link => link.textContent.trim());
    expect(new Set(labels).size).toBe(labels.length);
    expect(screen.getByRole("link", { name: preview })).toHaveAttribute("href", "/m/steward/qa");
    expect(screen.getByRole("link", { name: queue })).toHaveAttribute("href", "/m/qa-queue");
  });
});
