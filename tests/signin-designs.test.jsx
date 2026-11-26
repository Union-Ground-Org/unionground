import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import SignInDesignStory from "../src/components/SignInDesignStory.jsx";
import SignInOrbit from "../src/components/SignInOrbit.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

// REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117
// (#9038): sign-in designs 2 ("orbit"), 3 ("quiet") and 4 ("together") of the
// promo package, each drawn only when its public-page section is released
// (features.public_pages.sign_in_design_N), with no rotation: the
// highest-numbered released design wins and design 1 is the default. The
// card stays the same real form in every design. Phones get the form only,
// with its usual title, and never make the release read.

const client = () => ({ auth: { setSession: vi.fn() } });

function mediaQueries({ wide = true, reduced = false } = {}) {
  const lists = new Map();
  return vi.fn((query) => {
    if (!lists.has(query)) {
      const list = {
        media: query,
        matches: query.includes("min-width") ? wide : query.includes("reduce") ? reduced : false,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      lists.set(query, list);
    }
    return lists.get(query);
  });
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the public edition's sign-in card", () => {
  it.each(["en", "es"])("keeps one password form without reading donor design switches (%s)", (lang) => {
    vi.stubGlobal("matchMedia", mediaQueries());
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<LanguageProvider lang={lang}><AuthScreen client={client()} lang={lang} /></LanguageProvider>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(catalogue[lang]["auth.passwordTitle"]);
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(screen.getByLabelText(catalogue[lang]["auth.email"])).toBeVisible();
    expect(screen.getByLabelText(catalogue[lang]["auth.password"])).toBeVisible();
    expect(container.querySelector("[data-sign-in-design]")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("the story side of designs 2 and 4", () => {
  const showStory = (design, lang = "en") => render(<LanguageProvider lang={lang}><SignInDesignStory design={design} /></LanguageProvider>);

  it("pauses and plays the orbit with a labelled control (WCAG 2.2.2)", () => {
    vi.stubGlobal("matchMedia", mediaQueries());
    showStory(2);
    const story = screen.getByRole("complementary");
    expect(story).toHaveAttribute("data-paused", "false");
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["auth.orbitPause"] }));
    expect(story).toHaveAttribute("data-paused", "true");
    expect(screen.getByRole("button", { name: catalogue.en["auth.orbitPlay"] })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["auth.orbitPlay"] }));
    expect(story).toHaveAttribute("data-paused", "false");
  });

  it("holds still with no control under reduced motion", () => {
    vi.stubGlobal("matchMedia", mediaQueries({ reduced: true }));
    showStory(4);
    expect(screen.getByRole("complementary")).toHaveAttribute("data-paused", "true");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stops the rings while the tab is hidden, and forgets that when it leaves", () => {
    vi.stubGlobal("matchMedia", mediaQueries());
    const view = showStory(2);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(document.documentElement).toHaveAttribute("data-sgauth-tab-hidden");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(document.documentElement).not.toHaveAttribute("data-sgauth-tab-hidden");
    view.unmount();
    expect(document.documentElement).not.toHaveAttribute("data-sgauth-tab-hidden");
  });

  it("follows a change to the motion setting made while the page is open (gate round 1, r1s1 and r2s1)", () => {
    let reduced = false;
    let onChange = null;
    const removed = vi.fn();
    vi.stubGlobal("matchMedia", vi.fn((query) => ({
      media: query,
      get matches() { return query.includes("reduce") ? reduced : true; },
      addEventListener: (_type, listener) => { if (query.includes("reduce")) onChange = listener; },
      removeEventListener: removed,
    })));
    const view = showStory(2);
    const story = screen.getByRole("complementary");
    expect(story).toHaveAttribute("data-paused", "false");
    expect(screen.getByRole("button", { name: catalogue.en["auth.orbitPause"] })).toBeInTheDocument();
    reduced = true;
    act(() => onChange());
    expect(story).toHaveAttribute("data-paused", "true");
    expect(screen.queryByRole("button")).toBeNull();
    reduced = false;
    act(() => onChange());
    expect(story).toHaveAttribute("data-paused", "false");
    expect(screen.getByRole("button", { name: catalogue.en["auth.orbitPause"] })).toBeInTheDocument();
    view.unmount();
    expect(removed).toHaveBeenCalled();
  });

  it("starts stopped when it mounts in a tab that is already hidden (gate round 1, r1s2)", () => {
    vi.stubGlobal("matchMedia", mediaQueries());
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      const view = showStory(4);
      expect(document.documentElement).toHaveAttribute("data-sgauth-tab-hidden");
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(document.documentElement).not.toHaveAttribute("data-sgauth-tab-hidden");
      view.unmount();
    } finally {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    }
  });

  it("draws capability icons around the configured product mark", () => {
    vi.stubGlobal("matchMedia", mediaQueries());
    const { container } = showStory(2);
    expect(container.querySelectorAll(".sgauth-design__orb svg")).toHaveLength(6);
    expect(container.querySelector(".sgauth-design__orb img")).toBeNull();
    expect(container.querySelector(".sgauth-design__core .brand-mark")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("design details from the pre-push read of #9038 PR 2", () => {
  const css = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (source, selector) => {
    const at = source.indexOf(`${selector} {`);
    return at < 0 ? "" : source.slice(at, source.indexOf("}", at));
  };

  it("sets design 2's story headline in the theme's display family, Archivo, as the package does", () => {
    const designs = css("../src/components/signInDesigns.css");
    expect(rule(designs, ".sgauth-design h2")).toContain("font-family: var(--sg-font-family-display);");
    // The token is the theme's display family (promo package tokens.json font.display).
    const tokens = css("../src/sg-tokens.css");
    expect(tokens).toMatch(/--sg-font-family-display: 'Archivo', 'Arial', 'Helvetica', sans-serif;/);
    // Design 4 keeps the serif its package sets (theme decision 6).
    expect(rule(designs, ".sgauth-design--4 h2")).toContain("font-family: Georgia");
  });
});

describe("from the gate final of #9067", () => {

  it("styles the accent words by their class, never a bare em, so no route rule is pinned into the critical sheet", () => {
    const source = readFileSync("src/components/signInDesigns.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/\bem\s*[{,]/);
    expect(source).toContain(".sgauth-design__accent {");
    vi.stubGlobal("matchMedia", mediaQueries());
    render(<LanguageProvider lang="en"><SignInDesignStory design={2} /></LanguageProvider>);
    expect(screen.getByText(catalogue.en["auth.design2.accent"])).toHaveClass("sgauth-design__accent");
  });
});

// a review note and 492: the two repairs the last gate final of #9067
// (stage 443, r7 and r8) asks for before designs 2 to 4 are released. The
// designs stay held; these tests force them on through the release read.
describe("before designs 2 to 4 are released", () => {
  // A release read that answers only when the test says so.



  it("draws design 1's orbit from a pause choice its page holds, and hands Pause and Play back to it (ledger 487, the other direction)", () => {
    vi.stubGlobal("matchMedia", mediaQueries());
    const onPausedChange = vi.fn();
    const view = render(<LanguageProvider lang="en"><SignInOrbit paused onPausedChange={onPausedChange} /></LanguageProvider>);
    expect(view.container.querySelector(".sgauth-orbit__globe")).toHaveAttribute("data-paused", "true");
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["auth.orbitPlay"] }));
    expect(onPausedChange).toHaveBeenLastCalledWith(false);
    view.rerender(<LanguageProvider lang="en"><SignInOrbit paused={false} onPausedChange={onPausedChange} /></LanguageProvider>);
    expect(view.container.querySelector(".sgauth-orbit__globe")).toHaveAttribute("data-paused", "false");
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["auth.orbitPause"] }));
    expect(onPausedChange).toHaveBeenLastCalledWith(true);
  });


  const source = (path) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const pine = ':root[data-site-look="pine"] .sg-app--public > .sgauth-shell';
  const pineGreen = "linear-gradient(160deg, var(--sg-light-brand-deep), var(--sg-light-brand) 78%)";

  it("gives each design its own pine split, so no form sits on pine (ledger 492)", () => {
    const css = source("src/components/authStory.css");
    const wide = css.slice(css.lastIndexOf("@media (min-width: 900px)"));
    // Design 1: the form on the left, the canvas to the middle of the gap.
    expect(wide).toContain(`${pine}.sgauth-shell--design-1 {`);
    expect(wide).not.toMatch(new RegExp(`${pine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*background:`));
    // Design 2: the form on the right, so the same split from the right edge.
    expect(wide).toContain(`${pine}.sgauth-shell--design-2 { background: linear-gradient(270deg, var(--canvas) var(--sgauth-split), transparent var(--sgauth-split)), ${pineGreen}; }`);
    // Design 3 has no story side and design 4 draws its own green half: the
    // form keeps the canvas.
    expect(wide).toContain(`${pine}:is(.sgauth-shell--design-3, .sgauth-shell--design-4) { background: var(--canvas); }`);
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it("sets design 2's story in the pine look in the theme's ink for a dark ground (ledger 492)", () => {
    const css = source("src/components/signInDesigns.css");
    const story = `${pine} .sgauth-design--2`;
    expect(css).toContain(`${story} { color: var(--sg-light-on-primary); }`);
    expect(css).toContain(`${story} .sgauth-design__accent { color: var(--sg-light-accent); }`);
    expect(css).toMatch(new RegExp(`${story.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\.sgauth-design__eyebrow,[^{]*\\.sgauth-design__motion \\{ color: var\\(--sg-light-rail-label\\); \\}`));
    expect(css).toContain(`${story} .sgauth-design__motion:focus-visible { outline-color: var(--sg-light-accent-on-dark); }`);
    const pineRules = css.split("\n").filter((line) => line.includes('data-site-look="pine"')).join("\n");
    expect(pineRules).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });


  it("keeps every text colour on its pine-look background at WCAG AA, from the theme tokens (ledger 492)", () => {
    const tokens = readFileSync("src/sg-tokens.css", "utf8");
    const hex = (name) => tokens.match(new RegExp(`--sg-light-${name}: (#[0-9a-f]{6});`, "i"))[1];
    const luminance = (value) => {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    // Design 2's story on pine, on both ends of the pine gradient.
    for (const ground of ["brand", "brand-deep"]) {
      for (const ink of ["on-primary", "rail-label", "accent"]) expect(ratio(ink, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
    // Every design's form on the canvas.
    for (const ink of ["ink", "ink-2", "brand-text"]) expect(ratio(ink, "canvas"), `${ink} on canvas`).toBeGreaterThanOrEqual(4.5);
  });
});
