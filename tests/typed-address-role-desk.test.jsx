import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, explicitHatAllowsView } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { ACTING_HAT_STORAGE_KEY, readActingHat, writeActingHat } from "../src/lib/actingHat.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";

// REQ-UG-TYPED-ADDRESS-ROLE-DESK-BOUNCE-20261030: in the Oct 29-30
// role-play run, staff who typed or reloaded /m/tasks, /m/campaigns,
// /m/events-desk, /m/organization-map, /m/analytics or /m/admin were sent to
// Member Home with "Tasks opens from your Admin desk. Switch to Admin, then
// open it again.", and "Act as … here" reset on every typed address. A typed
// or reloaded address now opens in the role that opens it, and the chosen
// hat is kept for the tab's session. Same seam as tasks-staff-gating: `demo`
// stays false, which is the live product after sign-in.

const OWN_ID = fallbackData.member.id;

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => primeDemoData(fallbackData));

function arrive(path, roles) {
  primeDemoData({ ...fallbackData, roles });
  window.history.replaceState({}, "", path);
  return render(<App />);
}

// A reload: the page and its in-memory hat go away, the tab's session stays.
function reload(path, roles) {
  cleanup();
  clearDeviceParityState();
  return arrive(path, roles);
}

const refusals = () => [...document.querySelectorAll("[data-staff-route-refusal] p")].map((node) => node.textContent);

describe("a typed or reloaded staff address", () => {
  it.each([
    ["/m/tasks"],
    ["/m/campaigns"],
    ["/m/events-desk"],
    ["/m/organization-map"],
    ["/m/analytics"],
  ])("%s reloads in the Campaign chair hat the person chose", async (path) => {
    writeActingHat(OWN_ID, "vp");
    arrive(path, ["vp"]);
    await waitFor(() => expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "vp" }));
    expect(window.location.pathname).toBe(path);
    expect(refusals()).toEqual([]);
    expect(screen.queryByRole("heading", { name: PHONE_HOME_GREETING })).toBeNull();
  });

  // AGENTS.md, desktop rail contract: a shared staff tool opens only under an
  // explicitly worn staff hat. Typed while acting as Member it keeps the
  // refusal that names the desk; only desk planes enter a held role.
  it("keeps the refusal naming the desk for a shared tool typed while acting as Worker", async () => {
    arrive("/m/tasks", ["vp"]);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(refusals()).toEqual(["Tasks opens from your Campaign chair desk. Switch to Campaign chair and it opens there."]);
    expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "member" });
  });

  // UX-UG-STAFF-LINKS-FROM-WRONG-DESK-LAND-ON-HOME-OR-OVERVIEW-20261111:
  // after the refusal, switching to the desk it named opened that desk's
  // overview and the person had to find the page again.
  it("opens the refused page itself when the person switches to the desk the notice names", async () => {
    arrive("/m/tasks?view=list", ["vp"]);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(refusals()).toEqual(["Tasks opens from your Campaign chair desk. Switch to Campaign chair and it opens there."]);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Desks" })).getByRole("button", { name: "Campaign chair" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/tasks"));
    expect(window.location.search).toBe("?view=list");
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
    expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "vp" });
  });

  it("forgets the refused page after it opens, so a later switch opens the desk overview", async () => {
    arrive("/m/tasks", ["vp"]);
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    const desks = () => within(screen.getByRole("navigation", { name: "Desks" }));
    fireEvent.click(desks().getByRole("button", { name: "Campaign chair" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/tasks"));
    act(() => {
      window.history.pushState({}, "", "/m");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByRole("navigation", { name: "Desks" });
    fireEvent.click(desks().getByRole("button", { name: "Worker" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    fireEvent.click(desks().getByRole("button", { name: "Campaign chair" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/vp"));
  });

  it("opens a Site guide entry for another desk on that page, not the desk overview", async () => {
    arrive("/m/guide", ["admin"]);
    fireEvent.click(await screen.findByRole("button", { name: "Campaign partnerships & connections" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/admin/chapter-handshake"));
    expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "admin" });
  });

  it("omits the excluded membership card without changing the worn hat", async () => {
    writeActingHat(OWN_ID, "steward");
    arrive("/m/guide", ["steward"]);
    expect(await screen.findByRole("heading", { name: "Site guide" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Worker card" })).toBeNull();
    expect(window.location.pathname).toBe("/m/guide");
    expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "steward" });
    expect(refusals()).toEqual([]);
  });

  it("opens the Admin desk for an admin who last wore Committee worker", async () => {
    writeActingHat(OWN_ID, "steward");
    arrive("/m/admin", ["steward", "admin"]);
    await waitFor(() => expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "admin" }));
    expect(window.location.pathname).toBe("/m/admin");
    expect(refusals()).toEqual([]);
  });

  it("says which role a desk needs to a person who does not hold it", async () => {
    arrive("/m/admin", ["vp"]);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(refusals()).toEqual(["The Admin desk needs the Admin role, so Home opened instead."]);
  });

  it("says a staff tool is for campaign staff to a person with no staff role", async () => {
    arrive("/m/tasks", []);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(refusals()).toEqual(["Tasks is only for campaign staff, so Home opened instead."]);
  });

  it("opens a worker page in Worker when the restored hat cannot open it", async () => {
    expect(explicitHatAllowsView("coordinator", "rights", false, ["coordinator"], true, "/m/rights")).toBe(false);
    writeActingHat(OWN_ID, "coordinator");
    arrive("/m/rights", ["coordinator"]);
    await waitFor(() => expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "member" }));
    expect(window.location.pathname).toBe("/m/rights");
    expect(refusals()).toEqual([]);
  });
});

describe("the chosen hat across reloads", () => {

  it("still refuses a staff page reached later under a Worker hat the person chose", async () => {
    arrive("/m", ["coordinator"]);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    act(() => {
      window.history.pushState({}, "", "/m/campaigns");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(refusals()).toEqual(["Campaigns opens from your Campaign lead desk. Switch to Campaign lead and it opens there."]);
    expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "member" });
  });

  it("drops a hat another account chose in this tab", async () => {
    writeActingHat("someone-else", "coordinator");
    arrive("/m/settings", ["coordinator"]);
    await waitFor(() => expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "member" }));
  });

  it("drops a restored hat whose role is gone and never writes it back", async () => {
    writeActingHat(OWN_ID, "admin");
    arrive("/m/settings", []);
    await waitFor(() => expect(readActingHat()).toEqual({ userId: OWN_ID, hat: "member" }));
    expect(sessionStorage.getItem(ACTING_HAT_STORAGE_KEY)).not.toContain("admin");
  });
});
