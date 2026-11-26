// @vitest-environment jsdom
// BUG-UG-ADMIN-CANNOT-SAVE-OFFICER-DISPLAY-TITLES-20261006: a
// president's title saves for two officers failed with only "The title could
// not be saved." A refusal now says why, and the typed title survives it.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryTitle } from "../src/components/AdminCommandCenter.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberApiError } from "../src/lib/memberApiError.js";

afterEach(cleanup);

const shanice = { userId: "u-shanice", fullName: "Shanice Odum", chapterId: "pk-fleet", chapterName: "Fleet Maintenance Chapter", roles: ["coordinator"], displayTitle: null, displayTitleEditable: true };
const refusal = (code, message) => new MemberApiError("Set display title", { code, message });

async function failSave(error, lang = "en", person = shanice) {
  const api = { setMemberDisplayTitle: vi.fn().mockRejectedValue(error) };
  render(<LanguageProvider lang={lang}><DirectoryTitle person={person} api={api} onSaved={vi.fn()} /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: lang === "es" ? `Asignar un cargo a ${person.fullName}` : `Set a title for ${person.fullName}` }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "Vice President" } });
  fireEvent.click(screen.getByRole("button", { name: lang === "es" ? "Guardar cargo" : "Save title" }));
  return screen.findByRole("alert");
}

describe("a refused display title says why", () => {
  it.each([
    [refusal("42501", "admin role required"), "Only a current admin of Fleet Maintenance Chapter can set it, and an account with two-step sign-in must be signed in with its code. Refresh the directory to check your access, or sign in again."],
    [refusal("22023", "membership not found"), "Shanice Odum is no longer an active participant in Fleet Maintenance Chapter. Refresh the directory."],
    [refusal("22023", "invalid display title"), "Use 1 to 60 characters on one line."],
    [refusal("22023", "unit is not a sourced chapter unit"), "Nothing changed, and trying again will not help. Report it with the time it happened."],
    [refusal("57014", "canceling statement due to statement timeout"), "Union Ground is busy right now, so that did not finish. Try again in a moment."],
    [refusal("PGRST000", "Service Unavailable"), "Your title is still in the field. Try again in a moment."],
  ])("explains %#", async (error, reason) => {
    const alert = await failSave(error);
    expect(alert).toHaveTextContent(`The title could not be saved. ${reason}`);
    expect(screen.getByRole("combobox")).toHaveValue("Vice President");
  });

  it("explains in Spanish and names the campaign even when the row has no chapter name", async () => {
    const alert = await failSave(refusal("42501", "admin role required"), "es", { ...shanice, chapterName: null });
    expect(alert).toHaveTextContent("No se pudo guardar el cargo. Solo un administrador actual de esta campaña puede asignarlo, y una cuenta con verificación en dos pasos debe iniciar sesión con su código.");
  });
});
