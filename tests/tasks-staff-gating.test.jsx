import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { NAV_ITEMS, STAFF_WORK_RAIL_ITEM } from "../src/components/BottomNav.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { STAFF_TOOL_ROLES, STAFF_VIEWS } from "../src/lib/staffPlanes.js";
import { TasksView } from "../src/views/TasksView.jsx";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";

// Work coordination is a STAFF surface. The
// role-less redirect and the SAMPLE-hat entrance are pinned in App.test.jsx.
// This file pins the SaaS half under the product policy
// (ROLE-DERIVED DESK ENTRANCE): a real role holder still has no Switch hat,
// but each role in data.roles is a desk entry in navigation, a role holder
// reaches their own desk (entrance or deep link) but not another role's
// plane, and staff TOOL deep links still fail closed while Member is worn.
//
// Same seam as tests/steward-rail.test.jsx: re-prime the demo-data cache with
// a role and restore the plain-member fixture afterwards. `demo` stays false
// (no ?demo=1), which is the SaaS surface after sign-in.

function stubMatchMedia(matches) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  primeDemoData(fallbackData);
});

describe("the shared tables", () => {
  it("keeps tasks out of the member nav and inside the staff views", () => {
    expect(NAV_ITEMS.some((item) => item.key === "tasks")).toBe(false);
    expect(STAFF_VIEWS).toContain("tasks");
    // Any of the five roles may open a staff tool.
    expect([...STAFF_TOOL_ROLES].sort()).toEqual(["admin", "advisor", "coordinator", "steward", "vp"]);
    // The steward rail group carries the desktop entrance.
    expect(STAFF_WORK_RAIL_ITEM.path).toBe("/m/tasks");
  });
});

describe("a real coordinator", () => {
  beforeEach(() => primeDemoData({ ...fallbackData, roles: ["coordinator"] }));

  it("fails a direct staff-tool URL closed while the member hat is worn", async () => {
    window.history.replaceState({}, "", "/m/tasks");
    render(<App />);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(screen.queryByText("Move the work together")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Switch role" })).toBeNull();
    expect(document.querySelector(".staff-switcher")).toBeNull();
  });

  it("offers a Campaign lead desk entrance on SaaS without any Switch hat", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Switch role" })).toBeNull();
    const desks = screen.getByRole("navigation", { name: "Desks" });
    expect(within(desks).getAllByRole("button").map((node) => node.textContent)).toEqual(["Worker", "Organizer", "Campaign lead"]);
    expect(within(desks).getByRole("button", { name: "Worker" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "Issue queue" })).toBeNull();
    expect(document.querySelector(".staff-switcher")).toBeNull();
    expect(document.querySelector(".desktop-rail__hat-switcher")).toBeNull();
  });

  it("sees the staff-only tasks topic in Settings", async () => {
    window.history.replaceState({}, "", "/m/settings/notifications");
    render(<App />);
    expect(await screen.findByRole("switch", { name: "Campaign work" })).toBeInTheDocument();
  });

  // Planes are per-role, unlike the shared tool: holding coordinator opens
  // /m/coordinator but NOT /m/admin — a cross-role deep link is repaired to
  // /m exactly like a role-less one.
  it("is redirected off another plane's route", async () => {
    window.history.replaceState({}, "", "/m/admin");
    const historyLength = window.history.length;
    render(<App />);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(window.history.length).toBe(historyLength);
    expect(screen.getByText("The Admin desk needs the Admin role, so Home opened instead.")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-staff-route-refusal]")).toHaveLength(1);
  });
});

describe("the staff-gated Tasks workstream control", () => {
  function renderBoard(overrides = {}) {
    const props = {
      data: structuredClone(fallbackData),
      onProfile: vi.fn(),
      onAssistant: vi.fn(),
      onCreateTask: vi.fn(async (fields) => ({ ...fields, id: "new-task" })),
      onUpdateTask: vi.fn(async (_id, fields) => fields),
      onDeleteTask: vi.fn(async () => ({ deleted: true })),
      onSendTaskMessage: vi.fn(async () => null),
      onRenameWorkstream: vi.fn(async () => ({ id: "w-1", name: "renamed", movedTasks: 0 })),
      ...overrides,
    };
    return render(<LanguageProvider lang="en"><TasksView {...props} /></LanguageProvider>);
  }

  it("offers Workstreams on the staff Tasks surface and withholds it from a member", () => {
    const staffData = structuredClone(fallbackData);
    staffData.roles = ["coordinator"];
    const { unmount } = renderBoard({ data: staffData, staffAccess: true });
    expect(screen.getByRole("button", { name: "Workstreams" })).toBeInTheDocument();
    unmount();

    renderBoard({ staffAccess: false });
    expect(screen.queryByRole("button", { name: "Workstreams" })).not.toBeInTheDocument();
  });
});

describe("a degraded roles read", () => {
  // Roles=[] from a FAILED read is not a role-less
  // member. The gate holds the URL (per-role render gates keep the protected
  // content unmounted anyway) instead of bouncing a steward off their desk
  // over a transient error; the next successful refresh settles it.
  beforeEach(() => primeDemoData({ ...fallbackData, roles: [], rolesUnknown: true }));

  it("does not repair a staff URL while who-this-member-is is unknown", async () => {
    window.history.replaceState({}, "", "/m/steward");
    render(<App />);
    // Deliberately NOT redirected: unknown ≠ role-less. Nor is Member Home
    // rendered under the staff URL: the view region holds and re-reads the
    // roles (BUG-UG-SAMPLE-COORDINATOR-SURVEY-NAVIGATION-LANDS-ON-HOME-20261019).
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(document.querySelector("[data-roles-pending]")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: PHONE_HOME_GREETING })).toBeNull();
    expect(window.location.pathname).toBe("/m/steward");
  });
});

describe("a real steward", () => {
  beforeEach(() => primeDemoData({ ...fallbackData, roles: ["steward"] }));

  // The desk entry is derived from data.roles and
  // rendered as a rail destination; no hat switcher and no Chapter work
  // shortcut appear in Member chrome.
  it("reaches the steward desk from a desktop rail entrance without a hat switcher", async () => {
    stubMatchMedia(true);
    render(<App />);
    expect(document.querySelector(".desktop-rail")).not.toBeNull();
    expect(document.querySelector(".desktop-rail__hat-switcher")).toBeNull();
    expect(screen.queryByRole("button", { name: "Committee" })).toBeNull();
    // Union Ground's worker Work list is a Me destination beside Home;
    // the staff Campaign work shortcut still never appears in Member chrome.
    expect(screen.getByRole("link", { name: "Work" })).toHaveAttribute("href", "/m/work");
    expect(screen.queryByRole("link", { name: "Campaign work" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Work" })).toBeNull();
    expect(document.querySelector(".app-column--coordination")).toBeNull();
    const labels = [...document.querySelectorAll(".desktop-rail__grouplabel")].map((node) => node.textContent);
    expect(labels).toEqual(["Desks", "Me", "Campaign", "Account"]);
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Committee" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/steward");
    expect(document.querySelector(".desktop-rail__hat-switcher")).toBeNull();
    // The staff rail keeps Worker as the way back, still without a switcher.
    fireEvent.click(screen.getByRole("link", { name: "Worker" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(await screen.findByRole("heading", { name: "Welcome back, Darnell" })).toBeInTheDocument();
  });

  it("offers a phone desk entry for the steward role on SaaS, never a Switch hat, and enters the desk from it", async () => {
    render(<App />);
    expect(screen.queryByRole("combobox", { name: "Switch role" })).toBeNull();
    expect(screen.queryByText("Committee desk")).toBeNull();
    expect(document.querySelector(".staff-switcher")).toBeNull();
    const desks = screen.getByRole("navigation", { name: "Desks" });
    expect(within(desks).getByRole("button", { name: "Worker" })).toHaveAttribute("aria-pressed", "true");
    expect(within(desks).getByRole("button", { name: "Committee" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(desks).getByRole("button", { name: "Committee" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/steward");
    expect(screen.queryByRole("combobox", { name: "Switch role" })).toBeNull();
  });

  // The record's regression requirement: a /m/steward deep link mounts
  // StewardView for a steward with demo=false instead of bouncing to /m.
  it("mounts StewardView on a /m/steward deep link instead of bouncing to /m", async () => {
    window.history.replaceState({}, "", "/m/steward");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/steward");
    expect(screen.queryByRole("combobox", { name: "Switch role" })).toBeNull();
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("is still redirected off another role's plane", async () => {
    window.history.replaceState({}, "", "/m/admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(screen.getByText("The Admin desk needs the Admin role, so Home opened instead.")).toBeInTheDocument();
  });
});

describe("a two-role account", () => {
  beforeEach(() => primeDemoData({ ...fallbackData, roles: ["steward", "admin"] }));

  it("sees both desks in the desktop rail and on the phone home", () => {
    stubMatchMedia(true);
    const { unmount } = render(<App />);
    const rail = document.querySelector(".desktop-rail");
    expect(within(rail).getByRole("link", { name: "Committee" })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Admin" })).toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "Campaign lead" })).toBeNull();
    expect(document.querySelector(".desktop-rail__hat-switcher")).toBeNull();
    unmount();
    stubMatchMedia(false);
    render(<App />);
    const desks = screen.getByRole("navigation", { name: "Desks" });
    expect(within(desks).getAllByRole("button").map((node) => node.textContent)).toEqual(["Worker", "Committee", "Admin"]);
  });
});

describe("a role-less member", () => {
  it("sees no desk entry on either shell", () => {
    stubMatchMedia(true);
    const { unmount } = render(<App />);
    const labels = [...document.querySelectorAll(".desktop-rail__grouplabel")].map((node) => node.textContent);
    expect(labels).toEqual(["Me", "Campaign", "Account"]);
    unmount();
    stubMatchMedia(false);
    render(<App />);
    expect(screen.queryByRole("navigation", { name: "Desks" })).toBeNull();
  });
  it("can mute the tasks topic even without the board: assignment has no role filter", async () => {
    window.history.replaceState({}, "", "/m/settings/notifications");
    render(<App />);
    expect(await screen.findByRole("switch", { name: "Deadlines" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Campaign work" })).toBeInTheDocument();
  });
});
