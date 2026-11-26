import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { primeDemoHat } from "./helpers/demoHat.js";

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.scrollTo = vi.fn();
  window.matchMedia = vi.fn((query) => ({
    matches: /min-width/.test(query), media: query,
    addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline test")));
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("saved organization terms across the web shell", () => {
  it.each([
    { lang: "en", singular: "unit", plural: "units", save: "Save labels", saved: "Organization labels saved.", banner: "PREVIEW — every person and unit is fictional. Changes stay in this browser tab.", rail: "Organization & units", admin: "Unit admin", chapterField: "campaign", chaptersField: "campaigns" },
    { lang: "es", singular: "unidad", plural: "unidades", save: "Guardar etiquetas", saved: "Etiquetas de la organización guardadas.", banner: "VISTA PREVIA — cada persona y unidad es ficticia. Los cambios permanecen en esta pestaña.", rail: "Organización y unidades", admin: "Administración de la unidad", chapterField: "campaña", chaptersField: "campañas" },
  ])("saves labels and updates the banner and rail in $lang", async ({ lang, singular, plural, save, saved, banner, rail, admin, chapterField, chaptersField }) => {
    window.localStorage.setItem("sg-lang", lang);
    primeDemoHat("admin");
    window.history.replaceState({}, "", "/m/admin/labels?demo=1");
    const { container } = render(<App />);
    // The label fields are named by their visible label (BUG-UG-ADMIN-LABELS-EDITOR-SHOWS-RAW-KEYS-20261106).
    const chapter = await screen.findByRole("textbox", { name: chapterField }, { timeout: 8000 });
    fireEvent.change(chapter, { target: { value: singular } });
    fireEvent.change(screen.getByRole("textbox", { name: chaptersField }), { target: { value: plural } });
    fireEvent.click(screen.getByRole("button", { name: save, exact: true }));
    expect(await screen.findByText(saved)).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector(".demo-bar")).toHaveTextContent(banner));
    const navigation = within(container.querySelector(".desktop-rail"));
    expect(navigation.getByRole("link", { name: rail, exact: true })).toBeInTheDocument();
    expect(navigation.getByRole("link", { name: admin, exact: true })).toBeInTheDocument();
    // Explicit menu wording is authored text, even when it contains the old term.
    expect(screen.getByDisplayValue("Campaign duty")).toHaveAttribute("maxlength", "40");
  });
});
