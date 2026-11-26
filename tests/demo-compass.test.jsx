import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoHat } from "./helpers/demoHat.js";

// #7462: the sources under an answer are a labelled list, one row per source
// (its title, then the article it cites, keeping the PREVIEW marker).
const sourceRows = (label = "Sources") => within(screen.getByRole("list", { name: label })).getAllByRole("listitem")
  .map((item) => [...item.querySelectorAll(".guide2-msg__source-name, .guide2-msg__source-ref")].map((part) => part.textContent));

// Vitest runs App in demo mode (MODE === "test"), which is exactly the surface
// these tests pin: a demo visitor's Compass question must produce a visible
// answer from the explicitly marked SAMPLE/PREVIEW fixture — the original defect was a success
// toast over an empty sheet.
beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

// The panel's accessible name is the product name (GUIDE_NAME) in both
// languages; the directory row is translated.
async function openCompass(rowLabel = "Union Ground Guide") {
  render(<App />);
  const directoryCompass = [...document.querySelectorAll(".morehub-row")]
    .find((row) => row.textContent.includes(rowLabel));
  fireEvent.click(directoryCompass);
  return screen.findByRole("dialog", { name: "Union Ground Guide" });
}

async function ask(question) {
  const composer = screen.getByLabelText("Ask Union Ground Guide a question");
  fireEvent.change(composer, { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(composer).toHaveValue(""));
}

const SUPERVISOR_BODY = /You do not have to say who signed a card or what was said at a meeting/;
const CAPTIVE_BODY = /They cannot force you to speak, sign, or name coworkers/;

describe("demo Compass", () => {
  it("renders the retained Spanish fixture answer when Spanish is selected", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1&lang=es");
    window.localStorage.setItem("sg-lang", "es");
    try {
      await openCompass("Guía de Union Ground");
      const composer = screen.getByLabelText("Hazle una pregunta a la Guía de Union Ground");
      fireEvent.change(composer, { target: { value: "¿Cómo reportamos la presión del empleador?" } });
      fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
      expect(await screen.findByText(/No puede obligarte a hablar, firmar ni nombrar a tus compañeros/)).toBeInTheDocument();
      expect(screen.queryByText(CAPTIVE_BODY)).not.toBeInTheDocument();
      expect(sourceRows("Fuentes")).toEqual([expect.arrayContaining(["PREVIEW · Organizing rights · captive meeting"])]);
    } finally {
      window.localStorage.removeItem("sg-lang");
    }
  });

  it("answers a chip question with the fixture text and its source", async () => {
    await openCompass();
    fireEvent.click(screen.getByRole("button", { name: "How do we report employer pressure?" }));
    await ask(screen.getByLabelText("Ask Union Ground Guide a question").value);
    expect(await screen.findByText(CAPTIVE_BODY)).toBeInTheDocument();
    expect(sourceRows()).toEqual([expect.arrayContaining(["PREVIEW · Organizing rights · captive meeting"])]);
    expect(screen.getByText(/PREVIEW content is fictional/)).toBeInTheDocument();
    // The question text appears at least twice: the suggestion chip and the
    // member's bubble (double-render of the bubble itself is pinned at
    // component level in Guide.test.jsx).
    expect(screen.getAllByText("How do we report employer pressure?").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a follow-up in the same thread and titles history with the first question", async () => {
    await openCompass();
    await ask("How do we report employer pressure?");
    await screen.findByText(CAPTIVE_BODY);
    await ask("what can my supervisor ask about the card I signed");
    await screen.findByText(SUPERVISOR_BODY);
    fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
    const history = screen.getByRole("complementary", { name: "Conversation history" });
    const entries = history.querySelectorAll("button");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toHaveTextContent("How do we report employer pressure?");
  });

  // A card majority is not certification (PRODUCT.md, design principle 4).
  it("answers the card-majority chip from the cards fixture, never as recognition", async () => {
    const dialog = await openCompass();
    await ask("When is a card majority enough?");
    expect(await screen.findByText(/A card majority is not certification/)).toBeInTheDocument();
    expect(sourceRows()).toEqual([expect.arrayContaining(["PREVIEW · Organizing rights · cards and recognition"])]);
    expect(dialog.textContent).not.toMatch(/GR-2026-312|telework|certified union|you won/i);
  });

  it("admits a no-match honestly, with no sources line", async () => {
    await openCompass();
    await ask("zxqv flurble");
    expect(await screen.findByText(/I don't have a source for that in this preview tour/)).toBeInTheDocument();
    expect(screen.queryByText(/^Sources ·/)).not.toBeInTheDocument();
  });

  it("renders the demo copy, never the live-provider claims", async () => {
    await openCompass();
    expect(screen.getByText("🧭 PREVIEW")).toBeInTheDocument();
    expect(screen.getByText(/fictional PREVIEW fixture/)).toBeInTheDocument();
    expect(screen.queryByText(/processed by the portal's AI provider/)).not.toBeInTheDocument();
    expect(screen.getByText(/never reads a real campaign's sources/)).toBeInTheDocument();
    expect(screen.queryByText(/Preview mode — nothing is retrieved and nothing is saved/)).not.toBeInTheDocument();
  });

  it("touches no network and never mutates the shared fixture object", async () => {
    await openCompass();
    await ask("How do we report employer pressure?");
    await screen.findByText(CAPTIVE_BODY);
    expect(global.fetch).not.toHaveBeenCalled();
    // The demo append must be immutable: the module-level fixture is shared
    // by every test and primes every demo boot.
    expect(fallbackData.guideThreads).toEqual([]);
  });
});
