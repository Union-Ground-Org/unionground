import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { DemoWelcome } from "../src/components/FloatingControls.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { primeDemoHat } from "./helpers/demoHat.js";

// Role-map UB-DEMO-02/03/04 (2026-08-09): on a phone the demo must stay
// visibly marked as a demo, the six-step tour must be reachable without
// the desktop-only demo bar, the welcome banner may not promise a control it
// does not render, and demo mode must survive member-route navigation in the
// URL. jsdom answers false to every width query, so these suites exercise
// the real phone shell — the same reason the old CSS-hidden bar was
// untestable here.
beforeEach(() => {
  primeDemoHat("member");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

describe("phone demo chip (UB-DEMO-02)", () => {
  it("marks the phone home screen and does not render the desktop bar's focusable ghost", async () => {
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    await screen.findByRole("heading", { name: /Darnell/ });
    // Render-gated, not CSS-hidden: the bar left a focusable ghost in the
    // phone DOM before.
    expect(document.querySelector(".demo-bar")).toBeNull();
    expect(document.querySelector(".toast")).toBeNull();
    expect(screen.queryByText(/cannot open that page/i)).not.toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "Demo tour. Open the preview guide." });
    // The disclosure is VISIBLE text, not just the accessible name (sol F1
    // on 89660c497): a sighted visitor must read the demo marker on screen.
    // Revised contract 2026-08-20: the marker says "demo", never "sample".
    expect(chip.textContent).toContain("Demo tour");
    // The disclosure owns a normal-flow row, so it cannot cover the Home
    // greeting regardless of font metrics or safe-area insets.
    expect(chip.closest(".demo-chip-row")).not.toBeNull();
    expect(chip).not.toHaveClass("demo-chip--under-chrome");
  });

  it("keeps the marker on inner phone screens, where no other demo wording exists", async () => {
    window.history.replaceState({}, "", "/m/events?demo=1");
    render(<App />);
    // Union Ground has no points economy: the RSVP control carries no reward.
    expect((await screen.findAllByRole("button", { name: "RSVP" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /pts/ })).toBeNull();
    const chip = document.querySelector(".demo-chip");
    expect(chip).not.toBeNull();
    expect(chip.closest(".demo-chip-row")).not.toBeNull();
    expect(chip).not.toHaveClass("demo-chip--under-chrome");
    expect(chip.textContent).not.toContain("This link starts as");
  });

  // A fresh Union Ground preview wears Worker (DEFAULT_SAMPLE_HAT). Worker is
  // no staff fallback, so a cold staff deep link is refused with the ordinary
  // sentence naming the worn hat, never that the link "starts as" a desk.
  it("announces a staff deep-link refusal as a toast on phones", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/advisor?demo=1");
    render(<App />);
    expect(await screen.findByRole("status")).toHaveTextContent("Your Worker role cannot open that page. Opening Home instead.");
    expect(screen.getByRole("status")).not.toHaveTextContent(/Steward|Committee/);
    expect(document.querySelector(".demo-chip")?.textContent || "").not.toContain("This link starts as");
  });

  it("discloses the demo in the Spanish chip too, without sample labels", () => {
    expect(catalogue.es["demo.chip"]).toContain("demostración");
    expect(catalogue.en["demo.chip"]).toContain("Demo");
    expect(catalogue.es["demo.chip"]).not.toMatch(/ejemplo|muestra/i);
    expect(catalogue.en["demo.chip"]).not.toMatch(/sample/i);
  });

  it("never renders the chip outside demo mode", async () => {
    window.history.replaceState({}, "", "/m");
    render(<App />);
    await screen.findByRole("heading", { name: /Darnell/ });
    expect(document.querySelector(".demo-chip")).toBeNull();
  });
});

describe("phone tour reachability (UB-DEMO-03)", () => {
  it("reaches the six-step tour through the chip: chip → guide → tour", async () => {
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Demo tour. Open the preview guide." }));
    // The guide chunk lands through Suspense on the real macrotask queue.
    const guide = await screen.findByRole("dialog", { name: "Preview guide" });
    fireEvent.click(within(guide).getByRole("button", { name: "▶ Watch this in the guided tour" }));
    expect(await screen.findByText("Step 1 of 6")).toBeInTheDocument();
    // The tour's navigation contract keeps the demo flag riding along.
    expect(window.location.search).toContain("demo=1");
  });
});

describe("welcome copy honesty (UB-DEMO-04)", () => {
  it("renders one way in and copy that no longer promises a quick tour", () => {
    render(<DemoWelcome memberName="Darnell Foster" onExplore={vi.fn()} />);
    expect(screen.getByText(/Explore the full product on your own/)).toBeInTheDocument();
    expect(screen.queryByText(/quick tour/i)).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("keeps both locales free of the retired tour offer", () => {
    // The banner renders exactly one control (Explore). Neither language may
    // promise the tour there — its home is the preview guide, phone-reachable
    // through the chip.
    expect(catalogue.en["demo.welcomeSummary"]).not.toMatch(/tour/i);
    expect(catalogue.es["demo.welcomeSummary"]).not.toMatch(/recorrido/i);
  });
});

describe("demo survives member navigation in the URL", () => {
  it("preserves ?demo=1 when a member-route push would have dropped it", async () => {
    window.history.replaceState({}, "", "/m/events?demo=1");
    render(<App />);
    await screen.findAllByRole("button", { name: "RSVP" });
    // The Home orb navigates with the bare "/m" path — before the fix this
    // stripped the flag, so a reload or share from Home left the demo.
    fireEvent.click(document.querySelector(".home-orb"));
    await screen.findByRole("heading", { name: /Darnell/ });
    expect(window.location.pathname).toBe("/m");
    expect(window.location.search).toContain("demo=1");
    expect(document.querySelector(".demo-chip")).not.toBeNull();
  });
});
