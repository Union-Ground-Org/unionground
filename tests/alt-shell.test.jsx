import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { ALT_SHELL, CLASSIC_SHELL, SHELL_STORAGE_KEY, readShellChoice, withShellParam } from "../src/alt/altShell.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import AltSignedOut from "../src/alt/AltSignedOut.jsx";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// REQ-UG-ALT-SHELL-FOUNDATION-20261015. The alternate shell is a
// second presentation layer inside MemberApp, selected per visit. These tests
// pin the three things the swap depends on: the choice logic, that the design
// chrome wraps the SAME member app (a production view mounts inside it and the
// side nav drives App.navigate), and that nothing changes for a visit that did
// not ask for it.

function stubMatchMedia(matches) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: typeof matches === "function" ? matches(query) : matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

const realMatchMedia = window.matchMedia;
// Every layout query matches; of the two colour-scheme queries only dark does.
const prefersDarkDesktop = (query) => !query.includes("prefers-color-scheme: light");

beforeEach(() => {
  window.scrollTo = vi.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  primeDemoHat("member");
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("shell choice", () => {
  it("takes the query parameter first and remembers it", () => {
    const storage = new Map();
    const store = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
    expect(readShellChoice({ search: "?demo=1&shell=alt", storage: store })).toBe(ALT_SHELL);
    expect(storage.get(SHELL_STORAGE_KEY)).toBe(ALT_SHELL);
    expect(readShellChoice({ search: "", storage: store })).toBe(ALT_SHELL);
    expect(readShellChoice({ search: "?shell=classic", storage: store })).toBe(CLASSIC_SHELL);
    expect(storage.get(SHELL_STORAGE_KEY)).toBe(CLASSIC_SHELL);
  });

  it("ignores unknown values and falls back to the build default, then classic", () => {
    const store = { getItem: () => null, setItem: () => {} };
    expect(readShellChoice({ search: "?shell=purple", storage: store, defaultShell: "alt" })).toBe(ALT_SHELL);
    expect(readShellChoice({ search: "", storage: store, defaultShell: "nonsense" })).toBe(CLASSIC_SHELL);
    expect(readShellChoice({ search: "", storage: null })).toBe(CLASSIC_SHELL);
  });

  it("keeps the shell parameter on in-app paths only while the page carries it", () => {
    expect(withShellParam("/m/messages", "?shell=alt")).toBe("/m/messages?shell=alt");
    expect(withShellParam("/m/messages?x=1#top", "?demo=1&shell=classic")).toBe("/m/messages?x=1&shell=classic#top");
    expect(withShellParam("/m/messages", "?demo=1")).toBe("/m/messages");
    expect(withShellParam("/m?shell=alt", "?shell=alt")).toBe("/m?shell=alt");
  });
});

describe("alternate shell around the member app (demo fixtures)", () => {
  it("renders the design chrome and the Now page, and mounts a production view inside it on navigation", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1&shell=alt");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: /^Now at/ }, { timeout: 5_000 });
    const root = document.querySelector(".ugalt");
    expect(root).toBeTruthy();
    expect(root.getAttribute("data-shell")).toBe("alt");
    // The classic rails stay out of the tree; the design's side nav is the navigation.
    expect(document.querySelector(".sg-shell-body")).toBeNull();
    const side = document.getElementById("ug-side");
    const nowLink = within(side).getByRole("link", { name: "Now" });
    expect(nowLink.getAttribute("aria-current")).toBe("page");
    // The Messages item carries the unread badge in its name.
    expect(within(side).getByRole("link", { name: /^Messages/ })).toBeTruthy();
    expect(within(side).getByRole("link", { name: "Organizing rights" })).toBeTruthy();
    expect(within(side).getByRole("link", { name: "Worker questions" })).toBeTruthy();
    // The Now page content is the live snapshot, not sample copy.
    expect(screen.getByText("Latest update")).toBeTruthy();
    expect(document.getElementById("ug-ftr")).toBeTruthy();

    fireEvent.click(within(side).getByRole("link", { name: /^Messages/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/messages"));
    // The explicit choice rides on the URL, and the demo rider survives.
    expect(window.location.search).toContain("shell=alt");
    expect(window.location.search).toContain("demo=1");
    await screen.findByRole("heading", { level: 1, name: "Messages" }, { timeout: 5_000 });
    expect(document.querySelector(".ugalt .ug-legacy")).toBeTruthy();
    expect(within(document.getElementById("ug-side")).getByRole("link", { name: /^Messages/ }).getAttribute("aria-current")).toBe("page");
    expect(document.querySelector(".ug-now-page")).toBeNull();
  });

  it("carries the design's look onto a production page: dotted grid, light identity, adapter scope", async () => {
    // A desktop-width browser whose system asks for dark.
    stubMatchMedia(prefersDarkDesktop);
    window.history.replaceState({}, "", "/m/events?demo=1&shell=alt");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Meetings" }, { timeout: 5_000 });
    // The dotted canvas sits behind the production page, outside its content.
    const page = document.querySelector(".ugalt .ug-legacy-page");
    expect(page).toBeTruthy();
    const dots = page.querySelector(":scope > .ug-dots");
    expect(dots).toBeTruthy();
    expect(dots.getAttribute("aria-hidden")).toBe("true");
    // REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the prototype's page
    // hero (crumbs, the title for sight, the lede) and, on Events, its month
    // calendar come between the canvas and the production page, whose own h1
    // stays the page's one heading.
    expect(dots.nextElementSibling.classList.contains("ug-alt-page-hero")).toBe(true);
    expect(page.querySelector(":scope > .ug-alt-page-calendar .ug-cal")).toBeTruthy();
    expect(page.querySelector(":scope > .ug-legacy")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // The design is light only: the legacy adapter maps the LIGHT identity's
    // roles, so the alternate shell never renders the dark workspace theme.
    expect(document.querySelector(".ugalt").getAttribute("data-workspace-theme")).not.toBe("union-ground-dark");
  });

  // REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105: the site renders
  // light only, so the classic root stays light on a device that prefers dark.
  it("keeps the classic shell's root light for a visit whose device prefers dark", async () => {
    stubMatchMedia(prefersDarkDesktop);
    window.history.replaceState({}, "", "/m/events?demo=1");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Meetings" }, { timeout: 5_000 });
    expect(document.querySelector(".ug-legacy-page")).toBeNull();
    expect(document.querySelector(".ug-dots")).toBeNull();
    expect(document.querySelector(".sg-app").getAttribute("data-workspace-theme")).toBe("union-ground");
    expect(document.querySelector('[data-workspace-theme="union-ground-dark"], [data-work-theme="union-ground-dark"], .ug-work-dark')).toBeNull();
  });

  it("opens and closes the menu sheet on a narrow screen", async () => {
    stubMatchMedia(false);
    window.history.replaceState({}, "", "/m?demo=1&shell=alt");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: /^Now at/ }, { timeout: 5_000 });
    const header = document.getElementById("ug-hdr");
    const menu = within(header).getByRole("button", { name: "Menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(menu);
    const sheet = document.getElementById("ug-msheet");
    expect(sheet.classList.contains("ug-open")).toBe(true);
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.hasAttribute("inert")).toBe(false);
    // Every branch outside the open drawer is inert, the skip link included.
    const skip = document.querySelector(".skip-link");
    expect(skip.hasAttribute("inert")).toBe(true);
    expect(header.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(sheet.classList.contains("ug-open")).toBe(false));
    expect(sheet.hasAttribute("inert")).toBe(true);
    expect(skip.hasAttribute("inert")).toBe(false);
    // A closed sheet carries no dialog semantics, so the slash shortcut and
    // non-modal Escape layers keep working.
    expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    // REQ-UG-ALT-PORT-SHELL-MOTION-HOME-20261030: the owner's word of
    // October 30, 2026 ("I WANT IT FULLY WIRED, INCLUDING THE EFFECTS, MOTIONS
    // ETC FROM THAT PROTOTYPE TO CARRY OVER") brings the prototype's phone tab
    // bar to the alternate shell only (superseding, for this shell, the mobile
    // web support tier's no-designed-bottom-bar rule): Now, Messages and Menu,
    // whose Menu opens the same sheet. The classic shell keeps none (see the
    // classic test below).
    const tabbar = document.getElementById("ug-tabbar");
    expect(tabbar).not.toBeNull();
    expect(within(tabbar).getByRole("link", { name: /^Now/ })).toHaveAttribute("aria-current", "page");
    expect(within(tabbar).getByRole("link", { name: /^Messages/ })).toHaveAttribute("href", "/m/messages");
    expect(document.querySelector(".sg-app").classList.contains("ug-has-tabbar")).toBe(true);
    fireEvent.click(within(tabbar).getByRole("button", { name: "Menu" }));
    await waitFor(() => expect(sheet.classList.contains("ug-open")).toBe(true));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(sheet.classList.contains("ug-open")).toBe(false));
  });

  it("offers a worn staff hat its own destinations and the way back to Member only", async () => {
    stubMatchMedia(true);
    primeDemoHat("steward");
    window.history.replaceState({}, "", "/m/steward?demo=1&shell=alt");
    render(<App />);
    const side = await waitFor(() => {
      const element = document.getElementById("ug-side");
      expect(element).toBeTruthy();
      return element;
    }, { timeout: 5_000 });
    // The way back to Member is the hat switch (the row at the top and the hat list).
    expect((await within(side).findAllByRole("button", { name: "Worker" }, {}, { timeout: 5_000 })).length).toBeGreaterThan(0);
    // Member destinations the hat gate refuses are not advertised anywhere in the chrome.
    expect(within(side).queryByRole("link", { name: "Organizing rights" })).toBeNull();
    expect(within(side).queryByRole("button", { name: "Search" })).toBeNull();
    const footer = document.getElementById("ug-ftr");
    expect(within(footer).queryByRole("link", { name: "Organizing rights" })).toBeNull();
    expect(within(footer).queryByRole("link", { name: "Settings" })).toBeNull();
  });


  it("shows a worn staff hat's plane on phone Home instead of Member Now", async () => {
    stubMatchMedia(false);
    primeDemoHat("steward");
    window.history.replaceState({}, "", "/m?demo=1&shell=alt");
    render(<App />);
    await waitFor(() => expect(document.querySelector(".ug-body .ug-legacy")).toBeTruthy(), { timeout: 5_000 });
    // Member Now (and its refused destinations) never renders under the hat.
    expect(document.querySelector(".ug-now")).toBeNull();
    expect(screen.queryByRole("button", { name: "Organizing rights" })).toBeNull();
    // The side nav marks a staff destination current, not the way back to Member.
    expect(document.querySelector('#ug-side a[aria-current="page"]')).toBeTruthy();
  });

  it("changes nothing for a visit that did not choose the alternate shell", async () => {
    stubMatchMedia(true);
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    await screen.findByRole("main", {}, { timeout: 5_000 });
    await waitFor(() => expect(document.querySelector(".sg-shell-body")).toBeTruthy());
    expect(document.querySelector(".ugalt")).toBeNull();
    expect(document.getElementById("ug-side")).toBeNull();
    // The classic shell keeps the mobile web support tier: no designed bottom bar.
    expect(document.getElementById("ug-tabbar")).toBeNull();
    expect(window.localStorage.getItem(SHELL_STORAGE_KEY)).toBeNull();
  });
});

describe("alternate sign-in chrome", () => {
  it("wraps the production sign-in form and keeps one page heading", () => {
    const onBackToLanding = vi.fn();
    render(
      <LanguageProvider lang="en">
        <AltSignedOut onBackToLanding={onBackToLanding}>
          <AuthScreen client={{ auth: {} }} lang="en" onLanguageChange={() => {}} />
        </AltSignedOut>
      </LanguageProvider>,
    );
    expect(document.querySelector(".ugalt.ug-signed-out[data-shell=\"alt\"]")).toBeTruthy();
    // The form, its labels and its heading are AuthScreen's own; this
    // edition's sign-in card shows the email and password form directly.
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to the site" }));
    expect(onBackToLanding).toHaveBeenCalledTimes(1);
  });
});
