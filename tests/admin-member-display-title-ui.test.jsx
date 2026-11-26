// BUG-UG-INVITE-STARTING-ACCESS-NO-OFFICER-TITLES-20261003: an admin
// sets a display-only officer title from the member directory; it is shown
// apart from the role chips, never sent as a role, and the editor is offered
// only on rows the directory marks displayTitleEditable.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryTitle } from "../src/components/AdminCommandCenter.jsx";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

afterEach(cleanup);

function Harness({ initial, api }) {
  const [person, setPerson] = useState(initial);
  return <DirectoryTitle person={person} api={api} onSaved={(displayTitle) => setPerson((current) => ({ ...current, displayTitle }))} />;
}

const nadia = { userId: "u-nadia", fullName: "Nadia Okafor", chapterId: "hb-hhs", chapterName: "HHS Chapter", roles: ["admin"] };

function renderTitle(person, overrides = {}) {
  const api = { setMemberDisplayTitle: vi.fn(async (_user, _chapter, title) => ({ updated: true, displayTitle: title.trim() || null })), grantRole: vi.fn(), ...overrides };
  render(<LanguageProvider lang="en"><Harness initial={person} api={api} /></LanguageProvider>);
  return api;
}

describe("officer display title in the member directory", () => {
  it("offers no editor before the database returns the field", () => {
    renderTitle({ ...nadia });
    expect(screen.queryByRole("button", { name: /Set a title/ })).not.toBeInTheDocument();
  });

  it("shows a title but offers no editor on a row the admin cannot edit", () => {
    // An organization admin sees members of chapters they do not belong to;
    // the setter refuses those, so the directory marks them not editable.
    renderTitle({ ...nadia, displayTitle: "Trustee", displayTitleEditable: false });
    expect(screen.getByText("Title: Trustee")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Set a title/ })).not.toBeInTheDocument();
    cleanup();
    renderTitle({ ...nadia, displayTitle: null, displayTitleEditable: false });
    expect(screen.queryByText(/Title:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Set a title/ })).not.toBeInTheDocument();
  });

  it("sets a title that is shown apart from access and never sent as a role", async () => {
    const api = renderTitle({ ...nadia, displayTitle: null, displayTitleEditable: true });
    fireEvent.click(screen.getByRole("button", { name: "Set a title for Nadia Okafor" }));
    expect(screen.getByText("A display title only, such as Vice President, Treasurer or Secretary. It grants no access; access is assigned separately.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Secretary-Treasurer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() => expect(screen.getByText("Title: Secretary-Treasurer")).toBeInTheDocument());
    expect(api.setMemberDisplayTitle).toHaveBeenCalledWith("u-nadia", "hb-hhs", "Secretary-Treasurer");
    expect(api.grantRole).not.toHaveBeenCalled();
  });

  // REQ-UG-OFFICER-ROLES-VP-TREASURER-SECRETARY-20261006: owner decision
  // October 8, 2026, the officer offices are display titles only.
  it("suggests Vice President, Treasurer and Secretary as titles that are saved as text, not access", async () => {
    const api = renderTitle({ ...nadia, displayTitle: null, displayTitleEditable: true });
    fireEvent.click(screen.getByRole("button", { name: "Set a title for Nadia Okafor" }));
    const input = screen.getByLabelText(/Title/);
    const list = document.getElementById(input.getAttribute("list"));
    expect([...list.querySelectorAll("option")].map((option) => option.value))
      .toEqual(["Vice President", "Treasurer", "Secretary", "Secretary-Treasurer", "President"]);
    fireEvent.change(input, { target: { value: "Vice President" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() => expect(screen.getByText("Title: Vice President")).toBeInTheDocument());
    expect(api.setMemberDisplayTitle).toHaveBeenCalledWith("u-nadia", "hb-hhs", "Vice President");
    expect(api.grantRole).not.toHaveBeenCalled();
  });

  it("suggests the Spanish office names in Spanish", () => {
    render(<LanguageProvider lang="es"><Harness initial={{ ...nadia, displayTitle: null, displayTitleEditable: true }} api={{ setMemberDisplayTitle: vi.fn() }} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Nadia Okafor/ }));
    const input = document.querySelector("input[list]");
    expect([...document.getElementById(input.getAttribute("list")).querySelectorAll("option")].map((option) => option.value))
      .toEqual(["Vicepresidente/a", "Tesorero/a", "Secretario/a", "Secretario/a-Tesorero/a", "Presidente/a"]);
    // #7662: office titles remain free text, independently of the neutral
    // chapter-lead access label used when a leader has no display title.
    expect(t("es", "admin.command.titleSuggestion.president")).toBe("Presidente/a");
    expect(t("es", "settings.leadershipPresident")).toBe("Líder de la campaña");
    expect(t("en", "admin.command.titleSuggestion.president")).toBe("President");
    expect(t("en", "settings.leadershipPresident")).toBe("Chapter lead");
  });

  it("clears a title and reports a failed save", async () => {
    const api = renderTitle({ ...nadia, displayTitle: "Trustee", displayTitleEditable: true });
    expect(screen.getByText("Title: Trustee")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set a title for Nadia Okafor" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear title" }));
    await waitFor(() => expect(screen.queryByText("Title: Trustee")).not.toBeInTheDocument());
    expect(api.setMemberDisplayTitle).toHaveBeenCalledWith("u-nadia", "hb-hhs", "");
    cleanup();
    renderTitle({ ...nadia, displayTitle: null, displayTitleEditable: true }, { setMemberDisplayTitle: vi.fn().mockRejectedValue(new Error("admin role required")) });
    fireEvent.click(screen.getByRole("button", { name: "Set a title for Nadia Okafor" }));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Trustee" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The title could not be saved.");
  });
});
