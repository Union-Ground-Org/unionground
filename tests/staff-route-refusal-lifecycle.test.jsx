import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

const { loadRoute } = vi.hoisted(() => ({ loadRoute: vi.fn() }));
vi.mock("../src/lib/supabase.js", async (original) => ({
  ...await original(), appSupabase: {},
}));
vi.mock("../src/lib/memberSessionLoader.js", async (original) => ({
  ...await original(),
  createMemberSessionLoader: (_client, user) => ({
    userId: user.id, loadRoute, invalidateResources: vi.fn(),
    resourcesForRoute: () => [], failuresForResources: () => [],
    stateForRoute: () => ({ status: "loaded", error: "" }),
    dispose: vi.fn(),
  }),
}));
// Keep the real App data refresh, route/hat gates and profile dialog. Only the
// unrelated desk loader is replaced; no test sets App's state directly.
vi.mock("../src/views/StewardView.jsx", () => ({
  StewardView: ({ onProfile, accessActor }) => <>
    <h1>{accessActor.selectedHat} desk</h1>
    <button onClick={onProfile}>Open test profile</button>
  </>,
}));

const fixture = { ...fallbackData, roles: ["steward"], member: {
  ...fallbackData.member, organizationId: "fixture-org", language: "en",
} };

beforeEach(() => {
  window.history.replaceState({}, "", "/m/steward");
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
  primeDemoData(fixture);
  loadRoute.mockReset().mockResolvedValue(fixture);
});
afterEach(() => { primeDemoData(fallbackData); vi.unstubAllGlobals(); });

async function openDesk() {
  render(<App />);
  expect(await screen.findByRole("heading", { name: "steward desk" })).toBeInTheDocument();
}
function visit(path) {
  act(() => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}
async function refreshWith(next) {
  loadRoute.mockResolvedValue(next);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(loadRoute).toHaveBeenCalledWith("steward");
}

describe("persistent staff-route refusal lifecycle", () => {
  it("explains an actual role loss after refresh and keeps the revoked desk inaccessible", async () => {
    await openDesk();
    await refreshWith({ ...fixture, roles: [] });
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m");
    const refusal = screen.getByText("The Committee desk needs the Committee role, so Home opened instead.");
    expect(refusal.closest('[role="status"]')).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "steward desk" })).not.toBeInTheDocument();
    visit("/m/steward?hat=steward");
    expect(window.location.pathname).toBe("/m");
    expect(screen.queryByRole("heading", { name: "steward desk" })).not.toBeInTheDocument();
    expect(refusal).toBeInTheDocument();
  });

  it("translates a retained refusal when the profile changes language", async () => {
    enableFocusFixup();
    await openDesk();
    visit("/m/rights");
    const refusal = document.querySelector("[data-staff-route-refusal]");
    expect(refusal).toHaveTextContent("Your Committee role cannot open that page");
    fireEvent.click(screen.getByRole("button", { name: "Open test profile" }));
    const languageSwitch = await screen.findByRole("switch", { name: "Español" });
    languageSwitch.focus();
    fireEvent.click(languageSwitch);
    const close = await screen.findByRole("button", { name: "Cerrar", exact: true });
    // The switch keeps focus through the language save, as a browser that
    // moves focus off disabled controls would show.
    await afterRenderingUpdate();
    expect(languageSwitch).toHaveFocus();
    fireEvent.click(close);
    await waitFor(() => expect(within(refusal).getByRole("button")).toHaveTextContent("Descartar"));
    expect(refusal).toHaveTextContent("Tu rol de Comité");
    expect(refusal).not.toHaveTextContent("Your Committee role");
    expect(window.location.pathname).toBe("/m/steward");
  });

  it("wears a held desk on Back under the Member hat instead of refusing it", async () => {
    window.history.replaceState({}, "", "/m");
    render(<App />);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    visit("/m/steward");
    expect(await screen.findByRole("heading", { name: "steward desk" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/steward");
    expect(document.querySelector("[data-staff-route-refusal]")).not.toBeInTheDocument();
  });

  it.each(["organizationId", "id"])("invalidates a retained refusal when the loaded member's %s changes", async (field) => {
    await openDesk();
    visit("/m/rights");
    expect(document.querySelector("[data-staff-route-refusal]")).toBeInTheDocument();
    await refreshWith({ ...fixture, member: { ...fixture.member, [field]: "another-scope" } });
    expect(document.querySelector("[data-staff-route-refusal]")).not.toBeInTheDocument();
  });
});
