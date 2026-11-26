import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { FEATURE_GROUPS, WORK_WIDGET_KEYS } from "../src/lib/mobileNav.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { declaredFor, mountStylesheets } from "./helpers/appStylesheet.js";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

// The three-card phone home space (2026-08-05 card-nav wave; chrome-free
// revision 2026-08-07): All features · Home · Work. Edge swipes move between
// cards; the focus-revealed skip buttons are the accessible, testable way in.
// jsdom answers narrow to every media query, so render(<App />) is the phone
// shell these tests need.

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  window.localStorage.clear();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

const openFeatures = () => fireEvent.click(screen.getByRole("button", { name: "All features" }));
const openWork = () => fireEvent.click(screen.getByRole("button", { name: "Work" }));

describe("mobile card navigation", () => {
  it("mounts the three cards on the home route, feed centered, chrome-free", () => {
    render(<App />);
    const nav = document.querySelector(".card-nav");
    expect(nav).not.toBeNull();
    expect(nav.querySelectorAll(".card-nav__panel")).toHaveLength(3);
    // Browserbase readiness and Features activation depend on these rendered
    // shell selectors; pin the mounted elements rather than stale source text.
    expect(nav.querySelector(".card-nav__panel--home")).not.toBeNull();
    expect(nav.querySelector(".card-nav__panel--features")).not.toBeNull();
    // The feed still renders — inside the center card.
    expect(within(nav.querySelector(".card-nav__panel--home")).getByRole("heading", { name: /Good (morning|afternoon|evening), Darnell/ })).toBeInTheDocument();
    // The labeled pills and the menu orb are gone (owner spec, 2026-08-07).
    expect(document.querySelector(".card-nav__pill")).toBeNull();
    expect(document.querySelector(".card-nav__orb")).toBeNull();
    // At rest on the feed the Home orb has no job, so it does not render.
    expect(document.querySelector(".home-orb")).toBeNull();
    // Side cards start inert; the feed is live.
    expect(nav.querySelector(".card-nav__panel--features").hasAttribute("inert")).toBe(true);
    expect(nav.querySelector(".card-nav__panel--home").hasAttribute("inert")).toBe(false);
  });

  it("renders no hat pill for a single-hat account and the glass pill in demo", () => {
    // The role selector lives in exactly one place (owner spec, 2026-08-07):
    // the ephemeral glass pill on the Home card — and only when there is
    // more than one hat to switch into.
    const { unmount } = render(<App />);
    expect(document.querySelector(".card-nav__chrome")).toBeNull();
    expect(document.querySelector(".mobile-top")).toBeNull();
    unmount();
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    const chrome = document.querySelector(".card-nav__chrome");
    expect(chrome).not.toBeNull();
    expect(chrome.querySelector(".card-nav__hat select")).not.toBeNull();
    expect(chrome.querySelector(".card-nav__orb--menu")).toBeNull();
  });

  it("opens the drawer card through the focus-revealed skip button and returns", () => {
    render(<App />);
    const skip = screen.getByRole("button", { name: "All features" });
    expect(skip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(skip);
    expect(skip.getAttribute("aria-expanded")).toBe("true");
    const features = document.querySelector(".card-nav__panel--features");
    expect(features.hasAttribute("inert")).toBe(false);
    // With a side card active the peeking feed recedes and the Home orb
    // appears as the non-gesture way back.
    expect(document.querySelector(".card-nav--at-features")).not.toBeNull();
    fireEvent.click(document.querySelector(".home-orb"));
    expect(skip.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".card-nav--at-home")).not.toBeNull();
  });

  // BUG-UG-WEB-PHONE-SHELL-NO-VISIBLE-NAVIGATION-20261002 (owner
  // decision 4, 2026-10-02): phone web keeps no bottom bar, but it must show a
  // visible way to navigate. The Home card was the one place with nothing on
  // screen (side cards have the Home orb, inner views the top bar's Home
  // control), so its All features skip button becomes the visible menu
  // control, docked where the Home orb sits off Home.
  it("shows a visible, labelled menu control on the Home card that opens All features, with Work and Home reachable from there", () => {
    const unmountStyles = mountStylesheets();
    try {
      render(<App />);
      const menu = screen.getByRole("button", { name: "All features" });
      expect(menu).toHaveClass("card-nav__skip--menu");
      expect(menu).toHaveAttribute("aria-controls", "card-nav-panel-features");
      expect(menu).toHaveAttribute("aria-expanded", "false");
      // Visible at rest (not parked above the viewport), a 48px target, and
      // it stays docked when keyboard focus lands on it.
      const style = getComputedStyle(menu);
      expect(style.position).toBe("fixed");
      expect(style.top).toBe("auto");
      expect(style.minHeight).toBe("48px");
      expect(declaredFor(".card-nav__skip--menu:focus-visible")).toMatch(/top:\s*auto/);
      expect(document.querySelector(".home-orb")).toBeNull();
      expect(document.querySelector(".bottom-nav")).toBeNull();

      menu.focus();
      expect(menu).toHaveFocus();
      fireEvent.click(menu);
      expect(menu).toHaveAttribute("aria-expanded", "true");
      expect(document.querySelector(".card-nav--at-features")).not.toBeNull();
      // Off Home the control returns to a focus-revealed skip button; the Home
      // orb takes the docked spot, so the two never sit side by side.
      expect(menu).not.toHaveClass("card-nav__skip--menu");
      expect(document.querySelectorAll(".home-orb")).toHaveLength(1);

      const features = document.querySelector(".card-nav__panel--features");
      const workDoor = features.querySelector(".card-nav__work-door button");
      expect(workDoor).toHaveTextContent("Work");
      fireEvent.click(workDoor);
      expect(document.querySelector(".card-nav--at-work")).not.toBeNull();
      expect(features.querySelector(".card-nav__work-door")).toBeNull();
      fireEvent.click(document.querySelector(".home-orb"));
      expect(document.querySelector(".card-nav--at-home")).not.toBeNull();
      expect(screen.getByRole("button", { name: "All features" })).toHaveClass("card-nav__skip--menu");
    } finally {
      unmountStyles();
    }
  });

  it("opens active All features from an inner view in one activation and consumes the request", async () => {
    const unmountStyles = mountStylesheets();
    try {
      window.history.replaceState({}, "", "/m/settings");
      render(<App />);
      expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
      const top = document.querySelector(".mobile-top");
      const menu = within(top).getByRole("button", { name: "All features", exact: true });
      expect(menu).toHaveTextContent("All features");
      for (const button of [menu, within(top).getByRole("button", { name: "Home" })]) {
        const style = getComputedStyle(button);
        expect(parseFloat(style.minWidth)).toBeGreaterThanOrEqual(48);
        expect(parseFloat(style.minHeight)).toBeGreaterThanOrEqual(48);
      }
      expect(document.querySelector(".bottom-nav")).toBeNull();
      fireEvent.click(menu);
      const features = await screen.findByRole("region", { name: "All features" });
      expect(window.location.pathname).toBe("/m");
      expect(document.querySelector(".card-nav--at-features")).not.toBeNull();
      expect(features).not.toHaveAttribute("inert");
      expect(document.querySelector(".card-nav__panel--home")).toHaveAttribute("inert");
      fireEvent.click(within(features).getByRole("button", { name: "Work", exact: true }));
      expect(document.querySelector(".card-nav--at-work")).not.toBeNull();
      expect(document.querySelector(".card-nav__panel--work")).not.toHaveAttribute("inert");
      fireEvent.click(screen.getByRole("button", { name: "Home", exact: true }));
      expect(document.querySelector(".card-nav--at-home")).not.toBeNull();

      // Leave and mount Home again through its ordinary control. A consumed
      // entry request must not survive that later visit.
      openFeatures();
      fireEvent.click(within(features).getByRole("link", { name: /My reports/ }));
      expect(await screen.findByRole("heading", { name: "My reports" })).toBeInTheDocument();
      fireEvent.click(within(document.querySelector(".mobile-top")).getByRole("button", { name: "Home", exact: true }));
      expect(await screen.findByRole("button", { name: "All features" })).toHaveAttribute("aria-expanded", "false");
      expect(document.querySelector(".card-nav--at-home")).not.toBeNull();
      expect(document.querySelector(".card-nav__panel--features")).toHaveAttribute("inert");
      expect(document.querySelector(".bottom-nav")).toBeNull();
    } finally {
      unmountStyles();
    }
  });

  it("labels the inner menu in Spanish and preserves the demo and worn hat on entry", async () => {
    primeDemoHat("member");
    window.localStorage.setItem("sg-lang", "es");
    window.history.replaceState({}, "", "/m/settings?demo=1");
    render(<App />);
    const menu = await within(document.querySelector(".mobile-top")).findByRole("button", { name: "Todas las funciones", exact: true });
    expect(menu).toHaveTextContent("Todas las funciones");
    expect(within(document.querySelector(".mobile-top")).getByRole("combobox")).toHaveValue("member");
    fireEvent.click(menu);
    expect(window.location.pathname).toBe("/m");
    expect(window.location.search).toBe("?demo=1");
    expect(document.querySelector(".card-nav--at-features")).not.toBeNull();
    expect(screen.getByRole("region", { name: "Todas las funciones" })).not.toHaveAttribute("inert");
    expect(within(document.querySelector(".card-nav__chrome")).getByRole("combobox")).toHaveValue("member");
    expect(document.querySelector(".bottom-nav")).toBeNull();
  });

  it("keys the peek classes to the live rail position, not the settled card", async () => {
    render(<App />);
    const rail = document.querySelector(".card-nav__rail");
    const panels = rail.querySelectorAll(".card-nav__panel");
    // jsdom has no layout: stand in the phone geometry the rAF handler reads.
    Object.defineProperty(rail, "clientWidth", { configurable: true, value: 390 });
    Object.defineProperty(rail, "scrollWidth", { configurable: true, value: 1077 });
    [0, 297, 687].forEach((left, i) => Object.defineProperty(panels[i], "offsetLeft", { configurable: true, value: left }));
    const home = document.querySelector(".card-nav__panel--home");

    // Barely off the home rest position (drift < -8): the slab engages while
    // the settled card is still Home, and the home card goes inert.
    rail.scrollLeft = 280;
    fireEvent.scroll(rail);
    await waitFor(() => expect(document.querySelector(".card-nav--peek-features")).not.toBeNull());
    expect(document.querySelector(".card-nav--at-home")).not.toBeNull();
    expect(home.hasAttribute("inert")).toBe(true);

    // Past the midpoint toward Work: the peek flips sides with the drift.
    rail.scrollLeft = 640;
    fireEvent.scroll(rail);
    await waitFor(() => expect(document.querySelector(".card-nav--peek-work")).not.toBeNull());
    expect(document.querySelector(".card-nav--peek-features")).toBeNull();

    // Back at rest: no peek class, home live again.
    rail.scrollLeft = 297;
    fireEvent.scroll(rail);
    await waitFor(() => expect(document.querySelector(".card-nav--peek-work")).toBeNull());
    expect(home.hasAttribute("inert")).toBe(false);
  });

  it("keeps the card layer off inner views and mounts reachable phone chrome there", async () => {
    window.history.replaceState({}, "", "/m/settings");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(document.querySelector(".card-nav")).toBeNull();
    expect(document.querySelector(".bottom-nav")).toBeNull();
    const top = document.querySelector(".mobile-top");
    expect(top).not.toBeNull();
    // A single-hat account gets no dead selector, but keeps the bell and Home.
    expect(within(top).queryByLabelText("Switch role")).toBeNull();
    expect(within(top).getByRole("button", { name: /Notifications, \d+ unread/ })).toBeInTheDocument();
    expect(within(top).getByRole("button", { name: "Home" })).toBeInTheDocument();
    const orb = document.querySelector(".home-orb");
    expect(orb).not.toBeNull();
    fireEvent.click(orb);
    expect(window.location.pathname).toBe("/m");
    expect(await screen.findByRole("heading", { name: /Good (morning|afternoon|evening), Darnell/ })).toBeInTheDocument();
  });

  it("keeps every demo hat and notifications reachable on member inner views", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/settings?demo=1");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    const top = document.querySelector(".mobile-top");
    expect(top).not.toBeNull();
    const hats = within(top).getByLabelText("Switch role");
    expect([...hats.options].map((option) => option.textContent)).toEqual(["Worker", "Organizer", "Committee", "Campaign lead", "Advisor", "Admin", "Campaign chair"]);
    fireEvent.click(within(top).getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    expect(document.querySelector(".home-orb")).not.toBeNull();
  });

  it("opens the notifications and profile dialogs from the drawer's Account rows", async () => {
    // The bell and avatar left the chrome (owner feedback, 2026-08-05); the
    // drawer's Account group is where the two dialogs live on phones now.
    // Slide the drawer in first — the rows must be used the way a member
    // reaches them, not through the inert offscreen card.
    render(<App />);
    openFeatures();
    const panel = document.querySelector(".card-nav__panel--features");
    expect(panel.hasAttribute("inert")).toBe(false);
    // The unread signal rode along with the bell: live dot on the row, count
    // in its accessible name.
    const notifRow = within(panel).getByRole("button", { name: /Notifications, \d+ unread/ });
    expect(notifRow.querySelector(".morehub-row__dot")).not.toBeNull();
    fireEvent.click(notifRow);
    expect(await screen.findByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    // Modal isolation hides the page while a dialog is up — close it and wait
    // for the page to become accessible again before reaching for the next row.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Profile" }));
    expect(await screen.findByRole("dialog", { name: "Profile" })).toHaveTextContent("Darnell Foster");
  });

  it("lists the complete member feature directory on the All features card", () => {
    render(<App />);
    const panel = document.querySelector(".card-nav__panel--features");
    const rows = [...panel.querySelectorAll(".morehub-row")];
    const expected = FEATURE_GROUPS.flatMap((group) => group.items).length;
    expect(rows).toHaveLength(expected);
    // Group headers mirror the desktop rail's story.
    expect(within(panel).getByText("Me")).toBeInTheDocument();
    expect(within(panel).getByText("Campaign")).toBeInTheDocument();
    expect(within(panel).queryByText("Union")).toBeNull();
    expect(within(panel).getByText("Account")).toBeInTheDocument();
    // The Guide stays an overlay button; routes are links.
    expect(rows.some((row) => row.textContent.includes("Compass"))).toBe(false);
    const compassRow = rows.find((row) => row.textContent.includes("Union Ground Guide"));
    expect(compassRow).toHaveAttribute("aria-haspopup", "dialog");
    expect(compassRow.tagName).toBe("BUTTON");
    // A pinned shortcut may share the row's name since #9527; the directory row is the one checked.
    expect(within(panel).getAllByRole("link", { name: /Organizing rights/ }).some((link) => link.classList.contains("morehub-row"))).toBe(true);
    expect(within(panel).queryByRole("link", { name: /Know your rights/ })).toBeNull();
    const pinned = within(panel).getByRole("navigation", { name: "Pinned shortcuts" });
    expect(panel.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(pinned.compareDocumentPosition(within(panel).getByText("Me")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".shortcut-bubble")).toBeNull();
  });

  it("navigates from a feature row and returns through the Home orb", async () => {
    render(<App />);
    const panel = document.querySelector(".card-nav__panel--features");
    openFeatures();
    fireEvent.click(within(panel).getByRole("link", { name: /My reports/ }));
    expect(window.location.pathname).toBe("/m/numbers");
    expect(await screen.findByRole("heading", { name: "My reports" })).toBeInTheDocument();
    expect(document.querySelector(".card-nav")).toBeNull();
    expect(document.querySelector(".home-orb")).not.toBeNull();
  });

  it("gives a role-less member live widget panels on the Work card", () => {
    render(<App />);
    const work = document.querySelector(".card-nav__panel--work");
    const widgets = [...work.querySelectorAll(".workwidget")];
    expect(widgets.map((el) => el.dataset.widget)).toEqual(WORK_WIDGET_KEYS);
    // The static link list is gone.
    expect(work.querySelector(".morehub-row")).toBeNull();
    // Live previews, not bare titles: the messages panel carries the most
    // recent threads and the open-case count badge is real.
    const messages = work.querySelector('[data-widget="messages"]');
    expect(within(messages).getByRole("button", { name: /^Messages/ })).toBeInTheDocument();
    expect(messages.querySelectorAll(".workwidget__row").length).toBeGreaterThan(0);
    expect(within(messages).getByText(/unread/)).toBeInTheDocument();
    const cases = work.querySelector('[data-widget="cases"]');
    expect(within(cases).getByText("1 open")).toBeInTheDocument();
    expect(within(cases).getByText("Supervisor meeting with no stated reason")).toBeInTheDocument();
    // Issues carry no grievance steps in Union Ground.
    expect(within(cases).queryByText(/Step \d/)).toBeNull();
  });

  it("reorders widgets from the keyboard without writing device-global order", () => {
    render(<App />);
    const work = document.querySelector(".card-nav__panel--work");
    const handle = within(work).getByRole("button", { name: "Reorder Messages" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    const reordered = [...work.querySelectorAll(".workwidget")].map((el) => el.dataset.widget);
    expect(reordered[0]).toBe("appointments");
    expect(reordered[1]).toBe("messages");
    // The polite live region narrates the move for screen-reader users.
    expect(within(work).getByText("Messages moved to position 2 of 6")).toBeInTheDocument();
    // TEST-UG-WALL-CLOCK-ICU-AND-WAITFOR-TEST-ASSERTIONS-20260920: the
    // keydown above is synchronous, so a waitFor around this read resolved on
    // its first poll and proved only the instant after the keydown while
    // reading as a guarantee about a later write. The claim IS the synchronous
    // one — the keyboard reorder must not persist device-global widget order —
    // so it is asserted directly.
    expect(window.localStorage.getItem("sg-work-widgets")).toBeNull();
  });

  it("keeps a widget drag owned by its pointer and tears it down on blur and unmount", () => {
    // jsdom rects are 0x0 so the reorder geometry lives elsewhere; this pins
    // the drag SESSION (sol MAJ x2 on 97dd222c4): one pointer owns it, a
    // window blur cancels it (a mouse released outside the window never
    // sends pointerup), and unmount drops the window listeners.
    const { unmount } = render(<App />);
    const work = document.querySelector(".card-nav__panel--work");
    const handle = within(work).getByRole("button", { name: "Reorder Messages" });
    const messages = work.querySelector('[data-widget="messages"]');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, pointerType: "touch" });
    expect(messages.classList.contains("workwidget--drag")).toBe(true);
    // A second finger cannot start a rival drag while one is live…
    fireEvent.pointerDown(within(work).getByRole("button", { name: "Reorder One-on-ones" }), { button: 0, pointerId: 2, pointerType: "touch" });
    expect(work.querySelector('[data-widget="appointments"]').classList.contains("workwidget--drag")).toBe(false);
    // …and its lift must not end the first finger's drag.
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(messages.classList.contains("workwidget--drag")).toBe(true);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(messages.classList.contains("workwidget--drag")).toBe(false);

    fireEvent.pointerDown(handle, { button: 0, pointerId: 3, pointerType: "mouse" });
    expect(messages.classList.contains("workwidget--drag")).toBe(true);
    fireEvent.blur(window);
    expect(messages.classList.contains("workwidget--drag")).toBe(false);

    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 4, pointerType: "touch" });
    const dragAdds = addSpy.mock.calls.filter(([type]) => ["pointermove", "pointerup", "pointercancel", "blur"].includes(type));
    expect(dragAdds.length).toBeGreaterThanOrEqual(4);
    unmount();
    for (const [type, listener] of dragAdds) {
      expect(removeSpy.mock.calls.some(([t, l]) => t === type && l === listener)).toBe(true);
    }
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("navigates from a widget header to its backed destination", async () => {
    render(<App />);
    const work = document.querySelector(".card-nav__panel--work");
    openWork();
    fireEvent.click(within(work).getByRole("button", { name: /^My issues/ }));
    expect(window.location.pathname).toBe("/m/cases");
    expect(document.querySelector(".card-nav")).toBeNull();
  });

  it("carries the worn hat's desk on the Work card after entering its plane", async () => {
    // Hat isolation (owner rule, 2026-08-05): a fresh render wears Member and
    // the Work card shows member surfaces — the widget test above pins that.
    // Only explicitly putting a staff hat on moves
    // the desk onto the card — as the link map, never fake widgets.
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    fireEvent.change(within(document.querySelector(".card-nav__chrome")).getByRole("combobox", { name: "Switch role" }), {
      target: { value: "steward" },
    });
    expect(await screen.findByText("Committee desk")).toBeInTheDocument();
    fireEvent.click(within(document.querySelector(".mobile-top")).getByRole("button", { name: "Home" }));
    const work = document.querySelector(".card-nav__panel--work");
    const labels = [...work.querySelectorAll(".morehub-row__label")].map((row) => row.textContent);
    expect(labels).toContain("Issue work");
    expect(labels).not.toContain("Casework");
    expect(labels).toContain("Campaign duty");
    expect(labels).not.toContain("My issues");
    expect([...work.querySelectorAll(".morehub-row__icon")].every((icon) => icon.querySelector("svg.nav-glyph"))).toBe(true);
    expect(work.querySelector(".workwidget")).toBeNull();

    // Staff Home keeps shared account actions, but it must not advertise the
    // Member directory, pinned shortcuts, Settings, Compass, or Search. The
    // historical slash shortcut follows the same explicit-hat boundary.
    openFeatures();
    const features = document.querySelector(".card-nav__panel--features");
    expect(within(features).getByRole("button", { name: /Notifications, \d+ unread/ })).toBeInTheDocument();
    expect(within(features).getByRole("button", { name: "Profile" })).toBeInTheDocument();
    expect(within(features).queryByRole("navigation", { name: "Pinned shortcuts" })).toBeNull();
    expect(within(features).queryByRole("button", { name: "Search" })).toBeNull();
    expect(within(document.querySelector(".card-nav")).queryByRole("link", { name: "Settings" })).toBeNull();
    expect(within(document.querySelector(".card-nav")).queryByRole("button", { name: "Settings" })).toBeNull();
    expect(within(features).queryByText("Union Ground Guide")).toBeNull();
    expect(within(features).queryByText("Voting")).toBeNull();
    fireEvent.click(document.querySelector(".home-orb"));
    const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    window.dispatchEvent(slash);
    expect(slash.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/m");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    const paletteSearch = within(palette).getByRole("combobox", { name: "Search commands" });
    fireEvent.change(paletteSearch, { target: { value: "Guide" } });
    expect(within(palette).queryByRole("option", { name: "Union Ground Guide" })).toBeNull();
    fireEvent.change(paletteSearch, { target: { value: "Voting" } });
    expect(within(palette).queryByRole("option", { name: "Voting" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
  });

  it("opens the campaign sheet from the Work card chip and navigates a campaign tool", async () => {
    render(<App />);
    const work = document.querySelector(".card-nav__panel--work");
    openWork();
    const chip = within(work).getByRole("button", { name: /Harborview Care United/ });
    fireEvent.click(chip);
    const sheet = await screen.findByRole("dialog", { name: "Harborview Care United" });
    expect(within(sheet).getByText("Campaign tools")).toBeInTheDocument();
    // The honesty note: one campaign is the whole list — no fake switcher.
    expect(within(sheet).getByText(/participation lives in this campaign/)).toBeInTheDocument();
    expect(within(sheet).queryByText(/chapter/i)).toBeNull();
    fireEvent.click(within(sheet).getByRole("link", { name: /My campaign/ }));
    // /m/organize is Union Ground's Organize plane; the campaign hub opens
    // on its workspace page.
    expect(window.location.pathname).toBe("/m/organize/organize");
  });

  it("leaves modified and non-primary feature-row clicks to the browser", () => {
    render(<App />);
    const panel = document.querySelector(".card-nav__panel--features");
    openFeatures();
    const row = within(panel).getByRole("link", { name: /My reports/ });
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(fireEvent.click(row, init)).toBe(true);
    }
    expect(window.location.pathname).toBe("/m");
    expect(document.querySelector(".card-nav")).not.toBeNull();
  });
});
