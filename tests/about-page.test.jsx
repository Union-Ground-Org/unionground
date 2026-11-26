import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { AboutView } from "../src/views/AboutView.jsx";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

function renderAbout(lang = "en") {
  return render(<LanguageProvider lang={lang}><AboutView /></LanguageProvider>);
}

afterEach(() => {
  document.title = "Union Ground";
});

describe("AboutView", () => {
  it("publishes the product relationship and says the company, website and mailbox are not published", async () => {
    renderAbout();

    expect(screen.getByRole("heading", { name: "About Union Ground" })).toBeInTheDocument();
    expect(screen.getByText("Union Ground", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getAllByText("Not published yet", { selector: "dd" })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /unionground|@/i })).not.toBeInTheDocument();
    expect(siblingIdentityIn(document.body.textContent)).toEqual([]);
    expect(screen.getByText(/No address is published yet/)).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "On this page" }).querySelector('a[href="#about-contact"]')).toHaveTextContent("Contact");
    await waitFor(() => expect(document.title).toBe("About Union Ground"));
  });

  it("explains the independent fictional demonstration", () => {
    renderAbout();

    expect(screen.getByRole("heading", { name: "Fictional preview" })).toBeInTheDocument();
    expect(screen.getByText(/do not imply sponsorship or endorsement/i)).toBeInTheDocument();
  });

  // The upstream About page adds a Team section naming its founder. Each
  // operator of this edition names itself, so the page carries no team or
  // person and no profile links.
  it("names no team member and links no personal profile", () => {
    renderAbout();

    expect(document.getElementById("about-team")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Team", level: 2 })).not.toBeInTheDocument();
    expect(document.querySelector('a[rel="me"]')).toBeNull();
    expect(screen.queryByRole("link", { name: /LinkedIn|GitHub/ })).not.toBeInTheDocument();
  });

  it("localizes company information in Spanish", () => {
    renderAbout("es");

    expect(screen.getByRole("heading", { name: "Acerca de Union Ground" })).toBeInTheDocument();
    expect(screen.getByText("Empresa legal")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Vista previa ficticia" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Equipo", level: 2 })).not.toBeInTheDocument();
  });
});
