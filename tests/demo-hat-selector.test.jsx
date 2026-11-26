import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEMO_HAT_INTRO_KEY, DEMO_HAT_INTRO_MS, DemoHatSelector } from "../src/components/DemoHatSelector.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const options = [
  { key: "member", labelKey: "demo.hatMember" },
  { key: "steward", labelKey: "demo.hatSteward" },
  { key: "coordinator", labelKey: "demo.hatCoordinator" },
  { key: "advisor", labelKey: "demo.hatAdvisor" },
  { key: "admin", labelKey: "demo.hatAdmin" },
  { key: "vp", labelKey: "demo.hatVp" },
];

function selectorTree({ active = "steward", introduce = true, introReady = true, onChange = vi.fn(), lang = "en", pageKey = "today" } = {}) {
  return (
    <LanguageProvider lang={lang}>
      <DemoHatSelector options={options} active={active} introduce={introduce} introReady={introReady} onChange={onChange} pageKey={pageKey} />
      <button type="button">Next control</button>
    </LanguageProvider>
  );
}

function renderSelector(options = {}) {
  return render(selectorTree(options));
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  window.localStorage.clear();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
});

afterEach(() => {
  window.localStorage.clear();
  window.matchMedia = realMatchMedia;
});

describe("DemoHatSelector", () => {
  it("opens once on a first-visit deep link without stealing page-load focus", () => {
    renderSelector();
    const trigger = screen.getByRole("button", { name: "Switch role, current: Committee" });
    const menu = screen.getByRole("menu", { name: "Switch role" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(6);
    const intro = screen.getByRole("status");
    expect(intro).toHaveTextContent(/Try another role/);
    expect(menu).not.toContainElement(intro);
    expect(trigger).not.toHaveFocus();
    expect(window.localStorage.getItem(DEMO_HAT_INTRO_KEY)).toBe("true");
  });

  // BUG-UG-DEMO-ROLE-MENU-OPENS-OVER-LOADING-SCREEN-20261108


  it("does not replay the intro on repeat visits", () => {
    window.localStorage.setItem(DEMO_HAT_INTRO_KEY, "true");
    renderSelector();
    expect(screen.queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch role, current: Committee" })).toHaveAttribute("aria-expanded", "false");
  });

  it("restores welcome focus on repeat visits without replaying the intro", () => {
    window.localStorage.setItem(DEMO_HAT_INTRO_KEY, "true");
    const rendered = renderSelector({ introduce: false });
    const trigger = screen.getByRole("button", { name: "Switch role, current: Committee" });

    rendered.rerender(selectorTree({ introduce: true }));

    expect(screen.queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps a static selector under Reduce Motion and marks the intro seen", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    const rendered = renderSelector({ introduce: false });
    rendered.rerender(selectorTree({ introduce: true }));
    expect(screen.queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Switch role, current: Committee" });
    expect(trigger).toHaveFocus();
    expect(window.localStorage.getItem(DEMO_HAT_INTRO_KEY)).toBe("true");
  });

  it("supports roving keys, selection, Escape, and Spanish copy", async () => {
    const onChange = vi.fn();
    renderSelector({ active: "member", introduce: false, onChange, lang: "es" });
    const trigger = screen.getByRole("button", { name: "Cambiar de rol, actual: Trabajador" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const menu = screen.getByRole("menu", { name: "Cambiar de rol" });
    for (const retired of ["Miembro", "Delegado", "Presidente"]) expect(within(menu).queryByRole("menuitemradio", { name: retired })).toBeNull();
    const president = within(menu).getByRole("menuitemradio", { name: "Presidencia de campaña" });
    expect(president).toHaveFocus();
    fireEvent.keyDown(president, { key: "Home" });
    const member = within(menu).getByRole("menuitemradio", { name: "Trabajador" });
    expect(member).toHaveFocus();
    fireEvent.keyDown(member, { key: "ArrowDown" });
    fireEvent.keyDown(within(menu).getByRole("menuitemradio", { name: "Comité" }), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("steward");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes when keyboard focus leaves the selector", () => {
    renderSelector({ introduce: false });
    const trigger = screen.getByRole("button", { name: "Switch role, current: Committee" });
    fireEvent.click(trigger);
    const activeOption = screen.getByRole("menuitemradio", { name: "Committee" });
    const nextControl = screen.getByRole("button", { name: "Next control" });

    expect(activeOption).toHaveFocus();
    fireEvent.blur(activeOption, { relatedTarget: nextControl });
    nextControl.focus();

    expect(screen.queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(nextControl).toHaveFocus();
  });

  it("does not yank focus to the trigger when Escape dismisses the passive intro", async () => {
    const nextControl = document.createElement("button");
    nextControl.textContent = "Outside control";
    document.body.append(nextControl);
    nextControl.focus();

    renderSelector();
    expect(screen.getByRole("menu", { name: "Switch role" })).toBeInTheDocument();
    expect(nextControl).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu", { name: "Switch role" })).not.toBeInTheDocument());
    expect(nextControl).toHaveFocus();
    nextControl.remove();
  });
});

// #9776 (demo walk of Nov 24, 2026): the role menu opened on entry and then
// sat over the top right of every page the visitor moved to.
describe("the role menu never stays open over the pages", () => {
  afterEach(() => { vi.useRealTimers(); });



  // Sol read of aadb6142 (P1): a timer must never take the interactive menu
  // from someone reading it without DOM focus in it (a screen reader's
  // cursor, a magnifier). Only the intro's hint line is brief.



  it("leaves no timer behind when it unmounts during the intro", () => {
    vi.useFakeTimers();
    const rendered = renderSelector();
    expect(screen.getByRole("status")).toHaveTextContent(/Try another role/);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    rendered.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });


  // A desk's own pages share one view (Casework desk, Your caseload), so the
  // shell hands over the whole address, not the view.
  it("is told the address the shell shows", () => {
    const source = readFileSync("src/App.jsx", "utf8");
    expect(source).toMatch(/<DemoHatSelector[\s\S]*?pageKey=\{routeLocation\}[\s\S]*?\/>/);
  });
});

// BUG-UG-DEMO-ROLE-MENU-OPENS-OVER-LOADING-SCREEN-20261108: live on
// demo.example.com (Nov 8, 5:15 AM ET) the first-entry intro opened the role menu
// over the in-page "Loading Union Ground..." before the Home page existed.
describe("demo role menu intro in the app shell", () => {
  it("passes the page's load state to the selector's intro", () => {
    const source = readFileSync("src/App.jsx", "utf8");
    expect(source).toContain('introReady={routeLoad.status === "loaded" && !rolesPendingForView}');
  });
});
