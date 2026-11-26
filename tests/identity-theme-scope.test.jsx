import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityThemeScope } from "../src/components/IdentityThemeScope.jsx";
import { PublicDocumentShell } from "../src/components/PublicDocumentShell.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// REQ-UG-SITEWIDE-NEUROMAP-PAPER-VISUAL-LANGUAGE-20261104: the
// signed-out surfaces wrap themselves in the identity scope;
// tests/public-roots-keep-tokens-browser.test.js measures the paint.
// REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105: the site renders light
// only, so the scope stays light even when the device prefers dark.

const realMatchMedia = window.matchMedia;
afterEach(() => {
  if (realMatchMedia) window.matchMedia = realMatchMedia;
  else delete window.matchMedia;
});

function installMatchMedia(dark) {
  const state = { dark, listeners: new Set() };
  window.matchMedia = vi.fn((query) => ({
    media: query,
    get matches() {
      if (query === "(prefers-color-scheme: dark)") return state.dark;
      if (query === "(prefers-color-scheme: light)") return !state.dark;
      return false;
    },
    addEventListener: (type, listener) => { if (type === "change") state.listeners.add(listener); },
    removeEventListener: (type, listener) => { state.listeners.delete(listener); },
  }));
  state.flip = (next) => {
    state.dark = next;
    for (const listener of [...state.listeners]) listener({ matches: next });
  };
  return state;
}

const scopeOf = (container) => container.querySelector(".sg-app.sg-app--public");

describe("IdentityThemeScope", () => {
  it("renders the light identity under a dark device and never asks the device", () => {
    const media = installMatchMedia(true);
    const { container } = render(<IdentityThemeScope><p>page</p></IdentityThemeScope>);
    expect(scopeOf(container).getAttribute("data-workspace-theme")).toBe("union-ground");
    act(() => media.flip(false));
    act(() => media.flip(true));
    expect(scopeOf(container).getAttribute("data-workspace-theme")).toBe("union-ground");
    expect(window.matchMedia).not.toHaveBeenCalledWith(expect.stringContaining("prefers-color-scheme"));
  });

  it("stays light where the browser gives no usable answer", () => {
    delete window.matchMedia;
    const { container } = render(<IdentityThemeScope><p>page</p></IdentityThemeScope>);
    expect(scopeOf(container).getAttribute("data-workspace-theme")).toBe("union-ground");
  });

  it("puts the public document pages inside the light scope under a dark device", () => {
    installMatchMedia(true);
    const { container } = render(
      <LanguageProvider lang="en">
        <PublicDocumentShell eyebrow="Policy" title="Privacy" intro="Intro" sections={[{ id: "a", heading: "A" }]}>
          <section id="a"><h2>A</h2></section>
        </PublicDocumentShell>
      </LanguageProvider>,
    );
    const scope = scopeOf(container);
    expect(scope.getAttribute("data-workspace-theme")).toBe("union-ground");
    expect(scope.querySelector(".public-document-shell")).not.toBeNull();
  });
});
