// UX-UG-WEBSITE-ONE-STANDARD-PAGE-WIDTH-20261116: the
// website has one standard page width, a 1600px shell with gutters included,
// declared once in src/sg-tokens.css and read by the landing page, both
// sign-in pages, the public information pages and the alternate shell's
// signed-in pages.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import AltSignedOut from "../src/alt/AltSignedOut.jsx";
import { captureViewError } from "../src/lib/deferredObservability.js";

const orbit = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/components/SignInOrbit.jsx", () => ({
  default: function SignInOrbit() {
    if (orbit.fail) throw new Error("orbit chunk failed");
    return <div data-testid="orbit" />;
  },
}));
vi.mock("../src/lib/deferredObservability.js", () => ({ captureViewError: vi.fn() }));

const read = (path) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};
const STANDARD = "min(calc(var(--ug-wrap) - 2 * var(--ug-gutter)), 100%)";

function cssFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith(".css") ? [full] : [];
  });
}

describe("one standard page width", () => {
  it("is declared once, in the canonical token file, as a 1600px shell", () => {
    const declaring = cssFiles("src").filter((file) => /--ug-(wrap|gutter)\s*:/.test(read(file)));
    expect(declaring).toEqual([join("src", "sg-tokens.css")]);
    const tokens = read("src/sg-tokens.css");
    const block = tokens.match(/:root,\s*\.ugalt:not\(\.ug-signed-out\)\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/--ug-wrap:\s*1600px;/);
    // 6.25 of a hundredth of the width is 48px at 768px and 64px at 1024px.
    expect(block).toMatch(/--ug-gutter:\s*clamp\(16px, calc\(6\.25 \* var\(--ug-vw, 1vw\)\), 64px\);/);
  });

  // Gate round 1 (r2s1): with the phone gutter the Spanish name overlapped the
  // EN | ES toggle at 360, 375 and 390px (measured), so below 414px the
  // Spanish header shows the mark alone, as every language does below 360px.
  it("gives the Spanish landing header room for the language toggle on a phone", () => {
    // The site's shared header since the product policy.
    const chrome = read("src/components/siteChrome.css");
    expect(chrome).toMatch(/@media \(max-width: 359px\)\s*\{\s*\.site-head__name\s*\{\s*display:\s*none;/);
    expect(chrome).toMatch(/@media \(max-width: 413px\)\s*\{\s*:lang\(es\) \.site-head__name\s*\{\s*display:\s*none;/);
  });

  it("keeps running text on the wider landing at a reading width", () => {
    const home = read("src/views/home/publicHome.css");
    expect(home).toMatch(/\.site-home-compass__body,\s*\.site-home-close__body,\s*\.site-home-close__invite,\s*\.site-home-close__note\s*\{\s*max-width:\s*34em;/);
    expect(rule(home, ".site-home-hero__sub")).toMatch(/max-width:\s*34em/);
    const styles = read("src/styles.css");
    expect(rule(styles, ".land-interest-unavailable p")).toMatch(/max-width:\s*34em/);
    // The company description moved from the retired company card to the
    // site footer, where it keeps a short measure beside the link columns.
    expect(rule(read("src/components/siteChrome.css"), ".site-foot__about")).toMatch(/max-width:\s*24em/);
    // A link to a place on the page stops below the sticky header (68px).
    expect(read("src/components/siteChrome.css")).toMatch(/\.site-page :is\(\.legal-page section, \.pilot-section,[^)]*\) \{ scroll-margin-top: 92px; \}/);
    // The footer's closing sentence (the independence line the pilot page's own
    // legal note used to carry) keeps the same reading width.
    expect(rule(read("src/components/siteChrome.css"), ".site-foot__legal p")).toMatch(/max-width:\s*34em/);
  });

  it("keeps the public edition's classic sign-in header and footer full-width", () => {
    const styles = read("src/styles.css");
    const auth = readFileSync("src/components/AuthScreen.jsx", "utf8");
    expect(auth).toContain('<header className="sgauth-site-header">');
    expect(auth).toContain('<footer className="sgauth-site-footer">');
    const chrome = rule(styles, ".sgauth-site-footer");
    expect(chrome).toMatch(/width:\s*100%/);
    expect(chrome).toMatch(/padding:\s*14px clamp\(18px, 4vw, 56px\)/);
    expect(rule(styles, ".sgauth-site-header")).toMatch(/min-height:\s*68px/);
    const story = rule(read("src/components/authStory.css"), ".sgauth-shell .auth-screen--story");
    expect(story).toMatch(/max-width:\s*var\(--ug-wrap\);/);
    expect(story).toMatch(/padding-inline:\s*var\(--ug-gutter\);/);
  });

  it("puts the information pages on it and retires the 1120px measure", () => {
    const styles = read("src/styles.css");
    expect(rule(styles, ".public-document-shell")).toMatch(/padding:\s*0 var\(--ug-gutter\) 32px/);
    // The pages' own header and footer bars left with the shared site chrome.
    expect(styles).not.toMatch(/\.public-document-(header|footer)\b/);
    const layout = rule(styles, ".public-document-layout");
    expect(layout).toContain(`width: ${STANDARD}`);
    expect(layout).toMatch(/justify-content:\s*start/);
    expect(styles).not.toMatch(/\.public-document-(header|footer|layout)[^{]*\{[^}]*1120px/);
  });

  it("drives the alternate shell's wrap from it and retires the 1324px wrap and 520px sign-in cap", () => {
    const design = read("src/alt/styles/design.css");
    expect(design).toContain(".ug-wrap{width:calc(min(var(--ug-wrap),100%) - 2*var(--ug-gutter));margin-inline:auto}");
    expect(design).not.toMatch(/1324px|\.ug-signin\{/);
    const shell = read("src/alt/styles/shell.css");
    expect(rule(shell, ".ugalt .ug-signin")).toMatch(/grid-template-columns:\s*minmax\(0, 520px\);/);
    expect(shell).toMatch(/@media \(min-width: 900px\)\s*\{[^@]*\.ugalt \.ug-signin\s*\{[^}]*grid-template-columns:\s*minmax\(0, 520px\) minmax\(0, 1fr\)/);
  });
});

describe("the alternate sign-in page's story side", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    orbit.fail = false;
    vi.mocked(captureViewError).mockClear();
  });

  const query = (state) => {
    const listeners = [];
    const remove = vi.fn();
    vi.stubGlobal("matchMedia", vi.fn((media) => ({
      get matches() { return state.matches; },
      media,
      addEventListener: (_, fn) => listeners.push(fn),
      removeEventListener: remove,
    })));
    return { listeners, remove };
  };
  const page = () => render(<LanguageProvider lang="en"><AltSignedOut><p>form here</p></AltSignedOut></LanguageProvider>);

  it("reserves the story beside the panel and asks for the orbit only at the width that shows it", () => {
    const { listeners, remove } = query({ matches: false });
    const { container, unmount } = page();
    const row = container.querySelector(".ug-wrap.ug-signin");
    expect(row.querySelector(":scope > .ug-signin-panel")).not.toBeNull();
    const stage = row.querySelector(":scope > .ug-signin-story > .ug-signin-story-stage");
    expect(stage).not.toBeNull();
    expect(stage.childElementCount).toBe(0);
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 900px)");
    expect(listeners).toHaveLength(1);
    unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("draws the orbit on a wide screen, and once a narrow window is widened", async () => {
    query({ matches: true });
    const wide = page();
    expect(await screen.findByTestId("orbit")).toBeInTheDocument();
    wide.unmount();

    const state = { matches: false };
    const { listeners } = query(state);
    page();
    expect(screen.queryByTestId("orbit")).toBeNull();
    state.matches = true;
    await act(async () => { listeners.forEach((fn) => fn()); });
    expect(await screen.findByTestId("orbit")).toBeInTheDocument();
  });

  it("draws nothing and reports once when the orbit fails, keeping the form", async () => {
    orbit.fail = true;
    query({ matches: true });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = page();
    await vi.waitFor(() => expect(captureViewError).toHaveBeenCalledTimes(1));
    quiet.mockRestore();
    expect(container.querySelector(".ug-signin-story-stage").childElementCount).toBe(0);
    expect(screen.getByText("form here")).toBeInTheDocument();
  });

  it("keeps the panel when the browser has no media queries", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { container } = page();
    expect(container.querySelector(".ug-signin-story-stage").childElementCount).toBe(0);
    expect(screen.getByText("form here")).toBeInTheDocument();
  });
});
