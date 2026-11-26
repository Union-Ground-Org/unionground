import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AltSignedOut from "../src/alt/AltSignedOut.jsx";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import SignInOrbit, { ORBIT_RINGS } from "../src/components/SignInOrbit.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

// UX-UG-SIGN-IN-FORM-WITH-ORBIT-STORY-SIDE-20261113: sign-in design 1
// of the promo package. The card stays the real form; beside it, from 900 CSS
// px, the orbit of Union Ground capability icons (owner answers of Nov 13,
// 2026, choice 5: no real union's logo). Phones get the form only and never
// download the orbit.

const readiness = { ok: true, json: async () => ({ providers: {}, released: { apple: false, google: false, sso: false } }) };
const client = () => ({ auth: { signInWithPasskey: vi.fn(), setSession: vi.fn() } });

function mediaQueries({ wide = true, reduced = false } = {}) {
  const lists = new Map();
  const matchMedia = vi.fn((query) => {
    if (!lists.has(query)) {
      const list = {
        media: query,
        matches: query.includes("min-width") ? wide : query.includes("reduce") ? reduced : false,
        listener: null,
        addEventListener: (_type, listener) => { list.listener = listener; },
        removeEventListener: () => { list.listener = null; },
      };
      lists.set(query, list);
    }
    return lists.get(query);
  });
  return { matchMedia, lists };
}

let observers;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => readiness));
  observers = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const showScreen = (lang = "en") => render(<LanguageProvider lang={lang}><AltSignedOut><AuthScreen client={client()} lang={lang} /></AltSignedOut></LanguageProvider>);
const showOrbit = (lang = "en") => render(<LanguageProvider lang={lang}><SignInOrbit /></LanguageProvider>);

describe("the sign-in story side", () => {
  it("draws the orbit beside the card at desktop width, after the first paint", async () => {
    vi.stubGlobal("matchMedia", mediaQueries({ wide: true }).matchMedia);
    const { container } = showScreen();
    const shell = container.querySelector(".ug-signin");
    // The card column comes first, so keyboard focus reaches the form first.
    expect(shell.firstElementChild).toHaveClass("ug-signin-panel");
    expect(shell.lastElementChild).toHaveClass("ug-signin-story");
    await waitFor(() => expect(container.querySelector(".ug-signin-story .sgauth-orbit")).not.toBeNull());
    expect(screen.getByRole("button", { name: catalogue.en["auth.orbitPause"] })).toBeInTheDocument();
  });

  it("never asks for the orbit below 900 CSS px, where the page is the form only", async () => {
    vi.stubGlobal("matchMedia", mediaQueries({ wide: false }).matchMedia);
    const { container } = showScreen();
    await screen.findByRole("heading", { name: catalogue.en["auth.passwordTitle"] });
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".ug-signin-story-stage")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: catalogue.en["auth.orbitPause"] })).toBeNull();
  });

  it("loads the orbit when a narrow window is widened to desktop width", async () => {
    const queries = mediaQueries({ wide: false });
    vi.stubGlobal("matchMedia", queries.matchMedia);
    const { container } = showScreen();
    expect(container.querySelector(".sgauth-orbit")).toBeNull();
    const story = queries.lists.get("(min-width: 900px)");
    story.matches = true;
    act(() => story.listener());
    await waitFor(() => expect(container.querySelector(".sgauth-orbit")).not.toBeNull());
  });

  it("leaves the story side out of the classic standalone card", async () => {
    vi.stubGlobal("matchMedia", mediaQueries({ wide: true }).matchMedia);
    const { container } = render(<LanguageProvider lang="en"><AuthScreen client={client()} lang="en" /></LanguageProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".sgauth-orbit")).toBeNull();
  });
});

describe("the orbit", () => {
  it("carries the eight Union Ground capability icons twice each, and no logo or union name", () => {
    vi.stubGlobal("matchMedia", mediaQueries().matchMedia);
    const { container } = showOrbit();
    const tiles = [...container.querySelectorAll(".sgauth-orbit__tile")];
    expect(tiles).toHaveLength(16);
    expect([...new Set(tiles.map((tile) => tile.dataset.icon))]).toEqual(["messages", "calendar", "vote", "cases", "rights", "contract", "compass", "chapters"]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".sgauth-orbit__globe")).toHaveAttribute("aria-hidden", "true");
    const source = readFileSync("src/components/SignInOrbit.jsx", "utf8");
    for (const union of ["AFGE", "AFSCME", "CWA", "NEA", "Teamsters", "USW", "AFT", "union-logos"]) expect(source).not.toContain(union);
    expect(ORBIT_RINGS.map((ring) => ring.size)).toEqual([576, 704, 848]);
  });

  it.each(["en", "es"])("pauses and plays from one visible control (%s)", (lang) => {
    vi.stubGlobal("matchMedia", mediaQueries().matchMedia);
    const { container } = showOrbit(lang);
    const globe = container.querySelector(".sgauth-orbit__globe");
    expect(globe).toHaveAttribute("data-paused", "false");
    fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["auth.orbitPause"] }));
    expect(globe).toHaveAttribute("data-paused", "true");
    fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["auth.orbitPlay"] }));
    expect(globe).toHaveAttribute("data-paused", "false");
  });

  it("stands still with no control under reduced motion", () => {
    vi.stubGlobal("matchMedia", mediaQueries({ reduced: true }).matchMedia);
    const { container } = showOrbit();
    expect(container.querySelector(".sgauth-orbit__globe")).toHaveAttribute("data-paused", "true");
    expect(container.querySelector(".sgauth-orbit__motion")).not.toBeVisible();
  });

  it("stops when it leaves the screen or the tab is hidden", () => {
    vi.stubGlobal("matchMedia", mediaQueries().matchMedia);
    const { container } = showOrbit();
    const globe = container.querySelector(".sgauth-orbit__globe");
    act(() => observers[0].callback([{ isIntersecting: false }]));
    expect(globe).toHaveAttribute("data-paused", "true");
    act(() => observers[0].callback([{ isIntersecting: true }]));
    expect(globe).toHaveAttribute("data-paused", "false");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(globe).toHaveAttribute("data-paused", "true");
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(globe).toHaveAttribute("data-paused", "false");
  });

  it("paints the globe in theme colours and advances it only while running", () => {
    vi.stubGlobal("matchMedia", mediaQueries().matchMedia);
    const context = { clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillStyle: "", globalAlpha: 1 };
    const colours = new Set();
    Object.defineProperty(context, "fillStyle", { set: (value) => { colours.add(value); }, get: () => "" });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const frames = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => { frames.push(callback); return frames.length; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    showOrbit();
    expect(context.clearRect).toHaveBeenCalledTimes(1);
    expect(context.arc).toHaveBeenCalledTimes(9000);
    for (const colour of colours) expect(["#efa738", "#f7c56e", "#137c54", "#cfe0d8", "#9aa39d", "#0e4034", "#1b6e49"]).toContain(colour);
    act(() => frames.at(-1)());
    expect(context.clearRect).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["auth.orbitPause"] }));
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});

describe("the story side's styles", () => {
  const firstPaint = readFileSync("src/components/authStory.css", "utf8");
  const orbit = readFileSync("src/components/signInOrbit.css", "utf8");

  it("reserves the stage at first paint and shows the story only from 900 CSS px", () => {
    expect(firstPaint).toMatch(/^\.sgauth-story \{ display: none; \}/m);
    expect(firstPaint).toContain("@media (min-width: 900px)");
    expect(firstPaint).toContain("height: calc(516 * var(--sgauth-orbit-u) + 52px)");
    expect(firstPaint).toContain(".ugalt .sgauth-story { display: none; }");
  });

  // REQ-UG-SIGN-IN-AND-CHAPTER-DIRECTORY-TAKE-THE-SITE-CHROME-20261117:
  // in the pine look the story side is pine and the form side stays on the
  // canvas, split in the middle of the gap between them.
  it("paints the story side pine from 900 CSS px in the pine look, on the classic page only", () => {
    const css = firstPaint.replace(/\/\*[\s\S]*?\*\//g, "");
    const wide = css.slice(css.lastIndexOf("@media (min-width: 900px)"));
    const pine = ':root[data-site-look="pine"] .sg-app--public > .sgauth-shell';
    expect(wide).toContain(`${pine} {`);
    // The split is the form column's right edge plus half the gap, measured
    // from the same page edge the row itself uses.
    expect(css).toContain(".sgauth-shell { --sgauth-form: 440px; --sgauth-gap: clamp(36px, 4vw, 70px); }");
    expect(css).toContain("grid-template-columns: minmax(0, var(--sgauth-form)) minmax(0, 1fr);");
    expect(wide).toContain("--sgauth-split: calc(max(0px, (100% - var(--ug-wrap)) / 2) + var(--ug-gutter) + var(--sgauth-form) + var(--sgauth-gap) / 2);");
    expect(wide).toContain("linear-gradient(90deg, var(--canvas) var(--sgauth-split), transparent var(--sgauth-split)), linear-gradient(160deg, var(--sg-light-brand-deep), var(--sg-light-brand) 78%)");
    expect(wide).toContain(`${pine} .auth-screen--story { background: transparent; }`);
    // Nothing before the wide block names the look, so below 900px the page
    // is the form on the canvas in both looks.
    const narrow = css.slice(0, css.lastIndexOf("@media (min-width: 900px)"));
    expect(narrow).not.toContain("data-site-look");
    // The orbit's rings and its pause control are readable on pine.
    expect(css).toContain(`${pine} .sgauth-orbit__ring { border-color: var(--sg-light-rail-count); }`);
    expect(css).toContain(`${pine} .sgauth-orbit__motion { color: var(--sg-light-rail-ink); }`);
    expect(css).toContain(`${pine} .sgauth-orbit__motion:focus-visible { outline-color: var(--sg-light-accent-on-dark); }`);
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    // The alternate shell hides the shared header inside its panel and keeps
    // the footer links on the panel's own surface.
    const alt = readFileSync("src/alt/styles/shell.css", "utf8");
    expect(alt).toContain(".ugalt .ug-signin .site-head { display: none; }");
    expect(alt).toMatch(/\.ugalt \.ug-signin \.sgauth-shell \.site-foot \{[^}]*--chrome-bg: transparent;/);
  });

  it("takes every colour from the theme tokens", () => {
    for (const token of ["--sg-light-line", "--sg-light-card", "--sg-light-brand", "--sg-light-ink-2", "--sg-light-focus"]) expect(orbit).toContain(`var(${token})`);
    expect(orbit).not.toMatch(/#[0-9a-f]{6}/i);
  });
});
