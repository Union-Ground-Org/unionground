import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LearnView } from "../src/views/LearnView.jsx";

afterEach(() => {
  try {
    window.localStorage.removeItem("unionground-lang");
  } catch { /* jsdom always has storage */ }
});

describe("public Union Ground front door", () => {
  it("explains the lifecycle and offers safe contact plus a fictional workspace demo", () => {
    render(<LearnView connectEnabled />);
    expect(screen.getByRole("heading", { name: /Organize first/i })).toBeInTheDocument();
    expect(screen.getByText(/Recognition and election are separate paths/i)).toBeInTheDocument();
    expect(screen.getByText(/not a member portal/i)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /fictional.*demo/i })[0]).toHaveAttribute("href", "/m?demo=1");
    expect(screen.getAllByRole("link", { name: /private connection|connect safely/i })[0]).toHaveAttribute("href", "/connect");
    expect(screen.getByRole("link", { name: "Worker sign in" })).toHaveAttribute("href", "/m");
  });

  it("states the public/private boundary and legal disclaimer", () => {
    render(<LearnView connectEnabled />);
    for (const text of ["No coworker names", "No support lists", "No employer allegations"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(screen.getAllByText(/Not legal advice/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("has a keyboard bypass target", () => {
    render(<LearnView connectEnabled />);
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
    expect(document.querySelector("main#main-content")).not.toBeNull();
  });

  // The page advertised /connect as its hero CTA, its closing CTA and its nav
  // link while /connect ships disabled by default — so the site's only offered
  // action dead-ended on "Connection intake is not open yet."
  it("advertises no /connect link when intake is closed, and still offers a real action", () => {
    render(<LearnView connectEnabled={false} />);
    expect(screen.queryAllByRole("link").filter((link) => link.getAttribute("href") === "/connect")).toEqual([]);
    expect(screen.getByText(/Private intake is not open yet/i)).toBeInTheDocument();
    const demoLinks = screen.getAllByRole("link", { name: /fictional.*demo/i });
    expect(demoLinks.length).toBeGreaterThan(0);
    for (const link of demoLinks) expect(link).toHaveAttribute("href", "/m?demo=1");
  });

  it("renders in Spanish for a visitor whose saved language is Spanish", () => {
    window.localStorage.setItem("unionground-lang", "es");
    render(<LearnView connectEnabled />);
    expect(screen.getByRole("heading", { name: /Primero organizar/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ingreso de trabajadores" })).toHaveAttribute("href", "/m");
    expect(screen.getByText("Sin nombres de compañeros de trabajo")).toBeInTheDocument();
    expect(screen.queryByText("No coworker names")).toBeNull();
  });
});
