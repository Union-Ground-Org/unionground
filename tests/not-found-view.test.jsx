import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { NotFoundView } from "../src/views/NotFoundView.jsx";

describe("not-found view", () => {
  it("offers clear routes back to the public site", () => {
    render(
      <LanguageProvider lang="en">
        <NotFoundView />
      </LanguageProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Where to go next" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
    // Two in the page's own text; the site's shared header and footer link
    // Contact as well, and every one of them goes to /contact.
    expect(within(screen.getByRole("main")).getAllByRole("link", { name: "Contact" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Contact" }).every((link) => link.getAttribute("href") === "/contact")).toBe(true);
  });
});
