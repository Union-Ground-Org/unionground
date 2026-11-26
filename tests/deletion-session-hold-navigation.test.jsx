import { act, fireEvent, render, waitFor, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { applyDeviceParityState } from "../src/lib/deviceParity.js";

// BUG-UG-ACCOUNT-DELETION-SESSION-SCOPE-20260814: while the session holds
// an unresolved account deletion, no navigation path — local nav or the
// paired-device sg-nav mirror — may switch this frame away from the hub,
// because switching views unmounts ProductHubView and the pending deletion
// dialog with it, releasing the per-tree lock through its own cleanup.
//
// The hold is session.destructiveHold device-parity state: the pane that owns
// the pending dialog publishes it, and BOTH panes' shells consult it before
// applying a view change away from the hub.

const hubTitle = () => document.querySelector(".hub2-ph__title");
const realMatchMedia = window.matchMedia;

function stubWideScreen() {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: query.includes("min-width"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  act(() => {
    applyDeviceParityState("session.destructiveHold", false);
  });
  window.matchMedia = realMatchMedia;
  window.history.replaceState({}, "", "/m");
});

describe("session destructive hold pins the hub view", () => {
  it("refuses local navigation away from the hub while the hold is active", async () => {
    window.history.replaceState({}, "", "/m/organize/organize");
    render(<App />);
    await waitFor(() => expect(hubTitle()).not.toBeNull());

    act(() => {
      applyDeviceParityState("session.destructiveHold", true);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Home" })[0]);
    expect(hubTitle()).not.toBeNull();

    act(() => {
      applyDeviceParityState("session.destructiveHold", false);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Home" })[0]);
    await waitFor(() => expect(hubTitle()).toBeNull());
  });

  it("refuses a mirrored sg-nav view switch while the hold is active, and resumes when it clears", async () => {
    // embed=phone only counts inside a REAL frame, and the embed only obeys
    // sg-nav from its parent — so shadow window.parent with a real jsdom
    // Window (an actual iframe's) and post from that same window, exactly as
    // the desktop-shell embed test does.
    const host = document.createElement("iframe");
    document.body.appendChild(host);
    const parentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { configurable: true, value: host.contentWindow });
    try {
      window.history.replaceState({}, "", "/m/organize/organize?embed=phone");
      render(<App />);
      await waitFor(() => expect(hubTitle()).not.toBeNull());

      act(() => {
        applyDeviceParityState("session.destructiveHold", true);
      });
      fireEvent(window, new MessageEvent("message", {
        data: { type: "sg-nav", path: "/m/messages" },
        origin: window.location.origin,
        source: host.contentWindow,
      }));
      expect(hubTitle()).not.toBeNull();

      // Steering ONTO the hub stays allowed — the guard pins the hub against
      // being left, never against being joined.
      fireEvent(window, new MessageEvent("message", {
        data: { type: "sg-nav", path: "/m/organize/organize" },
        origin: window.location.origin,
        source: host.contentWindow,
      }));
      expect(hubTitle()).not.toBeNull();

      act(() => {
        applyDeviceParityState("session.destructiveHold", false);
      });
      fireEvent(window, new MessageEvent("message", {
        data: { type: "sg-nav", path: "/m/messages" },
        origin: window.location.origin,
        source: host.contentWindow,
      }));
      await waitFor(() => expect(hubTitle()).toBeNull());
    } finally {
      if (parentDescriptor) Object.defineProperty(window, "parent", parentDescriptor);
      host.remove();
    }
  });

  it("refuses a spoofed sg-nav-up view switch while the hold is active", async () => {
    stubWideScreen();
    window.history.replaceState({}, "", "/m/organize/organize");
    render(<App />);
    await waitFor(() => expect(hubTitle()).not.toBeNull());
    expect(document.querySelector(".companion-phone")).toBeNull();

    act(() => {
      applyDeviceParityState("session.destructiveHold", true);
    });
    fireEvent(window, new MessageEvent("message", {
      data: { type: "sg-nav-up", path: "/m/messages" },
      origin: window.location.origin,
      source: window,
    }));
    expect(hubTitle()).not.toBeNull();
    expect(window.location.pathname).toBe("/m/organize/organize");

    act(() => {
      applyDeviceParityState("session.destructiveHold", false);
    });
    fireEvent.click(screen.getByRole("link", { name: "Messages" }));
    await waitFor(() => expect(hubTitle()).toBeNull());
    expect(window.location.pathname).toBe("/m/messages");
  });

  it("repairs a browser history traversal that tries to leave the held hub", async () => {
    window.history.replaceState({}, "", "/m/organize/organize?demo=1");
    render(<App />);
    await waitFor(() => expect(hubTitle()).not.toBeNull());

    act(() => {
      applyDeviceParityState("session.destructiveHold", true);
    });
    // popstate runs after the browser has already moved the URL. Model that
    // post-traversal state directly so the guard must restore both URL and UI.
    window.history.pushState({}, "", "/m?demo=1");
    fireEvent.popState(window);

    expect(window.location.pathname).toBe("/m/organize/organize");
    expect(window.location.search).toBe("?demo=1");
    expect(hubTitle()).not.toBeNull();
  });
});
