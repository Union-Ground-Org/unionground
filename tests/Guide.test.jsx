import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { createSessionGuard } from "../src/lib/sessionGuard.js";
import { mutationFailureNotice } from "../src/App.jsx";
import { Assistant, DemoWelcome, GuidedTour, PreviewGuide } from "../src/components/FloatingControls.jsx";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

// #7462: the sources under an answer are a labelled list, one row per source
// (its title, then the article it cites).
const sourceRows = (label = "Sources") => within(screen.getByRole("list", { name: label })).getAllByRole("listitem")
  .map((item) => [...item.children].map((part) => part.textContent));

it.each(["en", "es"])("the surrounding Guide failure toast also stays localized (%s)", lang => {
  const translate = key => t(lang, key);
  const paused = Object.assign(new Error("Private raw provider text"), { code: "compass_paused" });
  expect(mutationFailureNotice(translate, paused, "guide.errorAnswer")).toBe(t(lang, "compass.pausedNotice"));
  expect(mutationFailureNotice(translate, new Error("Private raw provider text"), "guide.errorAnswer")).toBe(t(lang, "guide.errorAnswer"));
  const withheld = Object.assign(new Error("Private raw provider text"), { code: "question_withheld" });
  expect(mutationFailureNotice(translate, withheld, "guide.errorAnswer")).toBe(t(lang, "guide.errorQuestionWithheld"));
});

describe("demo welcome", () => {
  it("names the fictional member as a compact banner with one way in", () => {
    // The tour CTA left onboarding (owner spec, 2026-08-07: the six-step
    // overlay was clunky as a first-minute interruption) — the tour stays
    // reachable from the preview guide, pinned below.
    const explore = vi.fn();
    render(<DemoWelcome memberName="Darnell Foster" onExplore={explore} />);

    expect(screen.getByRole("dialog", { name: "Welcome to your Union Ground demo" })).toHaveTextContent("Darnell Foster");
    expect(document.querySelector(".demo-welcome--banner")).not.toBeNull();
    // Union Ground has no provisioned support mailbox, and the sibling
    // product's address must never appear in its demo.
    expect(document.body.innerHTML).not.toMatch(/unionground\.net/i);
    expect(siblingIdentityIn(document.body.innerHTML)).toEqual([]);
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Take the 2-minute tour" })).toBeNull();
    const start = screen.getByRole("button", { name: "Explore on my own" });
    expect(start).toHaveFocus();
    fireEvent.click(start);
    expect(explore).toHaveBeenCalledOnce();
  });

  it("lets Escape choose free exploration", () => {
    const explore = vi.fn();
    render(<DemoWelcome memberName="Darnell Foster" onExplore={explore} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(explore).toHaveBeenCalledOnce();
  });

  it("describes fixture previews as browser-session state", () => {
    render(<DemoWelcome memberName="Darnell Foster" inSession onExplore={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("An in-session preview");
    expect(screen.getByRole("dialog")).toHaveTextContent("Changes stay in this browser tab");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("sharing this demo workspace");
  });
});

describe("preview guide", () => {
  it("switches every persona into an observable selected context", () => {
    const startTour = vi.fn();
    render(<PreviewGuide onClose={vi.fn()} onNavigate={vi.fn()} onStartTour={startTour} />);

    const steward = screen.getByRole("button", { name: "Sam Okafor · Committee" });
    fireEvent.click(steward);
    expect(steward).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("You're Sam Okafor — Committee")).toBeInTheDocument();
    expect(screen.getByText(/Committee leads follow up with coworkers/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "▶ Watch this in the guided tour" }));
    expect(startTour).toHaveBeenCalledOnce();
  });

  it("honors its modal contract: focus lands inside and Escape closes (sol F7)", () => {
    // aria-modal was declared without isolation until the phone chip made
    // this dialog the tour's front door — now focus starts on the close
    // control and Escape actually closes.
    const close = vi.fn();
    render(<PreviewGuide onClose={close} onNavigate={vi.fn()} onStartTour={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("offers exactly the five staff-plane personas — no guest, one campaign chair", () => {
    render(<PreviewGuide onClose={vi.fn()} onNavigate={vi.fn()} onStartTour={vi.fn()} />);
    const personaButtons = [...document.querySelectorAll(".persona-list button")].map((el) => el.textContent);
    expect(personaButtons).toEqual([
      "Sam Okafor · Committee",
      "Jordan Patel · Campaign lead",
      "Avery Nguyen · Advisor",
      "Alex Rivera · Admin",
      "Taylor Morgan · Campaign chair",
    ]);
    // Riley Brooks was a roster invention: no guest plane or role exists.
    expect(screen.queryByText(/Riley Brooks/)).toBeNull();
    // Alex Rivera is the Admin, not a second chair beside Taylor Morgan.
    expect(personaButtons.filter((label) => /Campaign chair/.test(label))).toHaveLength(1);
    for (const label of personaButtons) expect(label).not.toMatch(/Steward|Grievance|Chapter|President/);
  });

  it("paints each persona dot through a modifier named for its tone, never through the shared base", () => {
    render(<PreviewGuide onClose={vi.fn()} onNavigate={vi.fn()} onStartTour={vi.fn()} />);
    const tones = [...document.querySelectorAll(".persona-list .dot")]
      .map((dot) => [...dot.classList].find((name) => name.startsWith("dot--")).slice("dot--".length));
    expect(tones).toHaveLength(5);
    const css = readFileSync("src/styles.css", "utf8");
    const modifiers = [...css.matchAll(/(?<=^|\})\s*\.dot--([a-z]+)\s*\{([^}]*)\}/gm)];
    // Both directions: every rendered tone has its own painted rule, and no rule exists for a tone no persona renders.
    expect(modifiers.map(([, tone]) => tone).sort()).toEqual([...new Set(tones)].sort());
    for (const [, tone, body] of modifiers) expect(body, tone).toMatch(/\bbackground\s*:/);
    const base = [...css.matchAll(/(?<=^|\})\s*\.dot\s*\{([^}]*)\}/gm)].map(([, body]) => body);
    expect(base).toHaveLength(1);
    expect(base[0]).not.toMatch(/\b(background|color)\s*:/);
  });
});

describe("guided tour", () => {
  it("moves forward, backward, navigates, and finishes", () => {
    const navigate = vi.fn();
    const close = vi.fn();
    render(<GuidedTour onClose={close} onNavigate={navigate} />);

    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigate).toHaveBeenLastCalledWith("messages", "/m/messages");
    expect(screen.getByRole("heading", { name: "Messages" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(navigate).toHaveBeenLastCalledWith("today", "/m");

    // Six steps since PR8 added Search: Today → … → Rights → Search.
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Rights" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigate).toHaveBeenLastCalledWith("search", "/m/search");
    expect(screen.getByRole("heading", { name: "Search" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish tour" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("isolates the highlighted tour layer and closes on Escape", () => {
    const close = vi.fn();
    const target = document.createElement("div");
    target.className = "home-greet";
    target.getBoundingClientRect = () => ({ top: 80, left: 20, width: 320, height: 120, right: 340, bottom: 200, x: 20, y: 80, toJSON() {} });
    document.body.append(target);
    render(<GuidedTour onClose={close} onNavigate={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Guided tour" })).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    target.remove();
  });
});

describe("Union Ground Guide history", () => {
  const threads = [
    { id: "one", title: "First question", messages: [{ id: "one-a", role: "assistant", body: "First answer" }] },
    { id: "two", title: "Second question", messages: [{ id: "two-a", role: "assistant", body: "Second answer" }] },
  ];

  it("opens a persisted thread and starts a clean conversation", () => {
    render(<Assistant threads={threads} onClose={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByText("First answer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "Second question" }));
    expect(screen.getByText("Second answer")).toBeInTheDocument();
    expect(screen.queryByText("First answer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByText("Ask me about portal tasks, procedures, or workplace-rights next steps.")).toBeInTheDocument();
  });

  it("shows a translated failure and keeps the question for retry", async () => {
    // The alert used to paint submitError.message, so an untranslated
    // rate-limit sentence became the member's copy. The catalogue string is
    // the only thing the worker may read here, in Union Ground's voice.
    render(<Assistant threads={[]} onClose={vi.fn()} onSend={vi.fn().mockRejectedValue(new Error("Union Ground Guide limit reached. Try again later."))} />);
    const composer = screen.getByLabelText("Ask Union Ground Guide a question");
    fireEvent.change(composer, { target: { value: "Where is my case?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Union Ground Guide could not answer right now\./);
    expect(alert).not.toHaveTextContent("Compass");
    expect(alert).not.toHaveTextContent("limit reached");
    expect(composer).toHaveValue("Where is my case?");
  });

  for (const lang of ["en", "es"]) {
    it(`asks the member to reword a withheld question instead of reporting an outage (${lang})`, async () => {
      const onSend = vi.fn().mockRejectedValue(Object.assign(new Error("Private server text"), { code: "question_withheld" }));
      render(<LanguageProvider lang={lang}><Assistant threads={[]} onClose={vi.fn()} onSend={onSend} /></LanguageProvider>);
      const composer = screen.getByLabelText(t(lang, "compass.askAria"));
      fireEvent.change(composer, { target: { value: "When are the committee office hours?" } });
      fireEvent.click(screen.getByRole("button", { name: t(lang, "guide.send") }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(t(lang, "guide.errorQuestionWithheld"));
      expect(alert).not.toHaveTextContent(t(lang, "guide.errorAnswer"));
      expect(alert).not.toHaveTextContent("Private server text");
      expect(composer).toHaveValue("When are the committee office hours?");
      expect(composer).toBeEnabled();
    });

    it(`holds a refused draft and disables all question entry while paused (${lang})`, async () => {
      const onSend = vi.fn().mockRejectedValue(Object.assign(new Error("Private server text"), { code: "compass_paused" }));
      const { unmount } = render(<LanguageProvider lang={lang}><Assistant threads={threads} onClose={vi.fn()} onSend={onSend} /></LanguageProvider>);
      const composer = screen.getByLabelText(t(lang, "compass.askAria"));
      fireEvent.change(composer, { target: { value: "My unsent question" } });
      fireEvent.click(screen.getByRole("button", { name: t(lang, "guide.send") }));
      await waitFor(() => expect(composer).toBeDisabled());
      expect(composer).toHaveValue("My unsent question");
      expect(screen.getByRole("status")).toHaveTextContent(t(lang, "compass.pausedNotice"));
      expect(screen.queryByText("Private server text")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: t(lang, "guide.send") })).toBeDisabled();
      for (const button of document.querySelectorAll(".compass-chips button")) expect(button).toBeDisabled();
      fireEvent.submit(composer.closest("form"));
      fireEvent.click(screen.getByRole("button", { name: t(lang, "guide.newChat") }));
      for (const button of document.querySelectorAll(".compass-starters button")) expect(button).toBeDisabled();
      expect(composer).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent(t(lang, "compass.pausedNotice"));
      fireEvent.submit(composer.closest("form"));
      expect(onSend).toHaveBeenCalledOnce();
      unmount();
      render(<LanguageProvider lang={lang}><Assistant onClose={vi.fn()} onSend={onSend} /></LanguageProvider>);
      expect(screen.getByLabelText(t(lang, "compass.askAria"))).toBeEnabled();
    });
  }

  // Every rejection reachable from onSend carries an English message nobody
  // translated: guideApi throws its own sentences, api/guide.js returns curated
  // gateway and rate-limit bodies, and an offline or CORS failure arrives as a
  // bare TypeError. None of them may reach the alert in either language.
  const rawSendFailures = [
    ["a dropped connection", new TypeError("Failed to fetch"), "Failed to fetch"],
    ["an expired session", new Error("Your session expired. Sign in again."), "Your session expired"],
    ["a provider rate limit", new Error("Union Ground Guide limit reached. Try again later."), "Union Ground Guide limit reached"],
  ];
  for (const lang of ["en", "es"]) {
    for (const [label, rejection, rawText] of rawSendFailures) {
      it(`shows only the catalogue sentence for ${label} under lang=${lang}`, async () => {
        render(
          <LanguageProvider lang={lang}>
            <Assistant threads={[]} onClose={vi.fn()} onSend={vi.fn().mockRejectedValue(rejection)} />
          </LanguageProvider>,
        );
        fireEvent.change(screen.getByLabelText(t(lang, "compass.askAria")), { target: { value: "Where is my case?" } });
        fireEvent.click(screen.getByRole("button", { name: t(lang, "guide.send") }));
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(t(lang, "guide.errorAnswer"));
        expect(alert).not.toHaveTextContent(rawText);
      });
    }
  }

  it("uses the returned thread id for the next successful exchange", async () => {
    const onSend = vi.fn().mockResolvedValue("new-thread-id");
    render(<Assistant threads={[]} onClose={vi.fn()} onSend={onSend} />);
    const composer = screen.getByLabelText("Ask Union Ground Guide a question");

    fireEvent.change(composer, { target: { value: "First question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(composer).toHaveValue(""));

    fireEvent.change(composer, { target: { value: "Second question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1][1]).toBe("new-thread-id");
  });
});

describe("Union Ground Guide citations", () => {
  it("renders the cited sources under an assistant answer", () => {
    const threads = [{
      id: "t1",
      title: "discipline",
      messages: [{
        id: "m1",
        role: "assistant",
        body: "Article 12 requires just cause before discipline.",
        sources: [{ ref: "Contract · Article 12" }, { ref: "Knowledge base" }],
      }],
    }];
    render(<Assistant threads={threads} onClose={vi.fn()} onSend={vi.fn()} />);
    expect(sourceRows()).toEqual([["Contract · Article 12"], ["Knowledge base"]]);
    expect(screen.getByText("🧭 CITES ITS SOURCES")).toBeInTheDocument();
  });

  it("omits the sources line when an answer has no sources", () => {
    const threads = [{ id: "t2", title: "hi", messages: [{ id: "m2", role: "assistant", body: "Hello.", sources: [] }] }];
    render(<Assistant threads={threads} onClose={vi.fn()} onSend={vi.fn()} />);
    expect(screen.queryByText(/^Sources ·/)).not.toBeInTheDocument();
  });

  it("fills the composer from a starter chip", () => {
    render(<Assistant threads={[]} onClose={vi.fn()} onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "How do we report employer pressure?" }));
    expect(screen.getByLabelText("Ask Union Ground Guide a question")).toHaveValue("How do we report employer pressure?");
  });
});

// ---------------------------------------------------------------------------
// All three overlays announced themselves as dialogs and once implemented none
// of the behaviour that entails: no Escape, no focus management, no inert
// background. A screen-reader user heard "dialog" and then tabbed straight out
// into the live page behind it.
//
// Union Ground's shared overlays now make each claim true instead of dropping
// it: the Guide panel's phone takeover, the preview guide and the guided tour
// are modal, isolate everything outside them (inert + aria-hidden, which is
// what keeps Tab inside in a real browser), close on Escape, and hand focus
// back to the control that opened them.
// ---------------------------------------------------------------------------
describe("overlay dialog behaviour", () => {
  function openerHarness(Overlay, props) {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>Open overlay</button>
          {open && <Overlay {...props} onClose={() => setOpen(false)} />}
        </div>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open overlay" });
    opener.focus();
    fireEvent.click(opener);
    return opener;
  }

  it("the Guide takeover isolates the background, closes on Escape and restores the opener", async () => {
    const opener = openerHarness(Assistant, { threads: [], onSend: vi.fn() });
    const dialog = screen.getByRole("dialog", { name: "Union Ground Guide" });
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(opener).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");
    // Everything a Tab could reach outside the dialog is inert.
    const outside = [...document.querySelectorAll("button, a[href], input, textarea, select")].filter((element) => !dialog.contains(element));
    expect(outside.length).toBeGreaterThan(0);
    for (const element of outside) expect(element.closest("[inert]")).not.toBeNull();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).not.toHaveAttribute("inert");
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  for (const [name, Overlay, props] of [
    ["Preview guide", PreviewGuide, { onNavigate: vi.fn(), onStartTour: vi.fn() }],
    ["Guided tour", GuidedTour, { onNavigate: vi.fn() }],
  ]) {
    it(`${name} is an honest modal: isolated, closed by Escape, focus restored`, async () => {
      const opener = openerHarness(Overlay, props);
      const dialog = screen.getByRole("dialog", { name });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(opener).toHaveAttribute("inert");

      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(opener).not.toHaveAttribute("inert");
      expect(opener).toHaveFocus();
    });
  }

  it("Preview guide moves focus inside to its close control", () => {
    openerHarness(PreviewGuide, { onNavigate: vi.fn(), onStartTour: vi.fn() });
    const dialog = screen.getByRole("dialog", { name: "Preview guide" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: t("en", "guide.close") }));
  });
});

describe("Guide panel close", () => {
  // Owner feedback (2026-08-05): minimize and close were the same handler
  // wearing two icons, so the panel keeps one close affordance, and its label
  // says the draft is discarded.
  it("offers one close control that discards the draft, and no minimize", () => {
    const onClose = vi.fn();
    render(<Assistant threads={[]} onSend={vi.fn()} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Ask Union Ground Guide a question"), {
      target: { value: "Can they change my schedule?" },
    });
    expect(screen.queryByRole("button", { name: /Minimize/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close and discard this draft" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Compass pending echo", () => {
  it("echoes the question and suppresses the empty state while onSend is unresolved", async () => {
    let resolveSend;
    const onSend = vi.fn(() => new Promise((resolve) => { resolveSend = resolve; }));
    render(<Assistant threads={[]} onClose={vi.fn()} onSend={onSend} />);
    const composer = screen.getByLabelText("Ask Union Ground Guide a question");
    fireEvent.change(composer, { target: { value: "Where is my case?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Where is my case?")).toBeInTheDocument();
    expect(document.querySelector(".guide2-msg--pending")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("The Guide is thinking…");
    expect(screen.queryByText(/Ask me about portal tasks/)).not.toBeInTheDocument();
    resolveSend("t1");
    await waitFor(() => expect(document.querySelector(".guide2-msg--pending")).toBeNull());
  });

  it("drops the echo and keeps the draft when the send fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("boom"));
    render(<Assistant threads={[]} onClose={vi.fn()} onSend={onSend} />);
    const composer = screen.getByLabelText("Ask Union Ground Guide a question");
    fireEvent.change(composer, { target: { value: "Where is my case?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    expect(document.querySelector(".guide2-msg--pending")).toBeNull();
    expect(composer).toHaveValue("Where is my case?");
    // The failed question is not shown as a bubble — only the composer has it.
    expect(screen.queryByText("Where is my case?")).not.toBeInTheDocument();
  });

  it("never renders the question twice when the saved copy lands", async () => {
    let resolveSend;
    const onSend = vi.fn(() => new Promise((resolve) => { resolveSend = resolve; }));
    const { rerender } = render(<Assistant threads={[]} onClose={vi.fn()} onSend={onSend} />);
    fireEvent.change(screen.getByLabelText("Ask Union Ground Guide a question"), { target: { value: "Where is my case?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The persisted exchange arrives (mutate's refresh) before the promise
    // resolves — the derived guard must keep the echo from doubling the
    // question in any interleaving.
    const saved = [{
      id: "t1",
      title: "Where is my case?",
      messages: [
        { id: "q1", role: "user", body: "Where is my case?" },
        { id: "a1", role: "assistant", body: "Answer." },
      ],
    }];
    rerender(<Assistant threads={saved} onClose={vi.fn()} onSend={onSend} />);
    resolveSend("t1");
    await waitFor(() => expect(screen.getByText("Answer.")).toBeInTheDocument());
    expect(document.querySelectorAll(".guide2-msg--user p")).toHaveLength(1);
  });
});


it.each([false, true, "paused"])("Assistant silently discards a superseded send; rejection=%s", async rejected => {
  const guard = createSessionGuard();
  guard.beginSession("member-a");
  const operation = guard.captureOperation("member-a");
  let resolveSend, rejectSend;
  const onSend = vi.fn(() => new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; }));
  render(<Assistant sessionOperation={operation} threads={[]} onClose={vi.fn()} onSend={onSend} />);
  const draft = screen.getByLabelText("Ask Union Ground Guide a question");
  fireEvent.change(draft, { target: { value: "An unfinished question" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onSend).toHaveBeenCalledOnce();
  guard.beginSession("member-b");
  await act(async () => {
    if (rejected) rejectSend(Object.assign(new Error("Private old-session failure"), rejected === "paused" ? { code: "compass_paused" } : {}));
    else resolveSend("private-old-thread");
  });
  expect(screen.queryByText("Private old-session failure")).toBeNull();
  expect(draft).toHaveValue("An unfinished question");
  expect(draft).toBeEnabled();
  expect(document.querySelector(".guide2-msg--pending")).not.toBeNull();
});

describe("Compass search-only degraded reply", () => {
  const degradedRejection = () => Object.assign(new Error("Union Ground Guide could not answer."), {
    code: "compass_degraded",
    degraded: "gateway_timeout",
    sources: [{ id: "kb:a", kind: "contract", title: "Article 12", ref: "Contract · Article 12" }, { id: "kb:b", kind: "faq", title: "Knowledge base", ref: "" }],
  });

  it.each(["new", "history"])("discards a late degraded reply after %s conversation navigation", async (destination) => {
    let rejectSend;
    const onSend = vi.fn(() => new Promise((_, reject) => { rejectSend = reject; }));
    const threads = destination === "history" ? [{ id: "first", title: "First thread", messages: [] }, { id: "other", title: "Other thread", messages: [] }] : [];
    render(<Assistant threads={threads} onClose={vi.fn()} onSend={onSend} />);
    fireEvent.change(screen.getByLabelText("Ask Union Ground Guide a question"), { target: { value: "Old question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    if (destination === "new") fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    else {
      fireEvent.click(screen.getByRole("button", { name: t("en", "guide.openConversations") }));
      fireEvent.click(screen.getByRole("button", { name: "Other thread" }));
    }
    await act(async () => { rejectSend(degradedRejection()); });
    expect(document.querySelector(".guide2-msg--degraded")).toBeNull();
    expect(screen.queryByText("Old question", { selector: ".guide2-msg--user p" })).toBeNull();
  });

  for (const lang of ["en", "es"]) {
    it(`replaces an outage notice with a pause and refuses another retry (${lang})`, async () => {
      const onSend = vi.fn().mockRejectedValueOnce(degradedRejection())
        .mockRejectedValueOnce(Object.assign(new Error("Private provider text"), { code: "compass_paused" }));
      render(<LanguageProvider lang={lang}><Assistant threads={[]} onClose={vi.fn()} onSend={onSend} /></LanguageProvider>);
      const composer = screen.getByLabelText(t(lang, "compass.askAria"));
      fireEvent.change(composer, { target: { value: "What does Article 12 say?" } });
      fireEvent.click(screen.getByRole("button", { name: t(lang, "guide.send") }));
      await screen.findByText(t(lang, "guide.degradedNotice"));
      expect(composer).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: t(lang, "guide.send") }));
      await waitFor(() => expect(composer).toBeDisabled());
      expect(composer).toHaveValue("What does Article 12 say?");
      expect(screen.getByRole("status")).toHaveTextContent(t(lang, "compass.pausedNotice"));
      expect(screen.queryByText(t(lang, "guide.degradedNotice"))).not.toBeInTheDocument();
      expect(screen.queryByText("Private provider text")).not.toBeInTheDocument();
      fireEvent.submit(composer.closest("form"));
      expect(onSend).toHaveBeenCalledTimes(2);
    });

    it(`shows the notice and the verified sources as a status under lang=${lang}`, async () => {
      render(
        <LanguageProvider lang={lang}>
          <Assistant threads={[]} onClose={vi.fn()} onSend={vi.fn().mockRejectedValue(Object.assign(degradedRejection(), { scopeNotices: [t(lang, "compass.scope.local_fallback"), t(lang, "compass.scope.other_organization")] }))} />
        </LanguageProvider>,
      );
      const composer = screen.getByLabelText(t(lang, "compass.askAria"));
      fireEvent.change(composer, { target: { value: "What does Article 12 say?" } });
      fireEvent.click(screen.getByRole("button", { name: t(lang, "guide.send") }));
      const status = await screen.findByText(t(lang, "guide.degradedNotice"));
      expect(status.closest("article")).toHaveAttribute("role", "status");
      expect(screen.getByText(t(lang, "compass.scope.local_fallback"))).toBeInTheDocument();
      expect(screen.getByText(t(lang, "compass.scope.other_organization"))).toBeInTheDocument();
      expect(sourceRows(t(lang, "compass.sourcesLabel"))).toEqual([["Article 12"], ["Knowledge base"]]);
      expect(screen.getByText("What does Article 12 say?", { selector: ".guide2-msg--user p" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(document.querySelector(".assistant-empty")).toBeNull();
      expect(composer).toHaveValue("What does Article 12 say?");
    });
  }

  it("clears the degraded card on New chat and never renders one without sources", async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(degradedRejection())
      .mockRejectedValueOnce(Object.assign(new Error("Union Ground Guide could not answer."), { code: "compass_degraded", degraded: "gateway_unavailable", sources: [] }));
    render(<Assistant threads={[]} onClose={vi.fn()} onSend={onSend} />);
    const composer = screen.getByLabelText("Ask Union Ground Guide a question");
    fireEvent.change(composer, { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/The Guide can't reach its answer service/);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.queryByText(/The Guide can't reach its answer service/)).not.toBeInTheDocument();

    fireEvent.change(composer, { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Union Ground Guide could not answer right now.");
    expect(screen.queryByText(/The Guide can't reach its answer service/)).not.toBeInTheDocument();
  });
});
