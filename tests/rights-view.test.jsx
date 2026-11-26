import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { RightsView } from "../src/views/RightsView.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

// Role-map UB-RGT-03, member half: data.stewardRequests has carried the
// member's own {id, lesson_id, status, created_at} rows since the loader
// shipped — the own-row SELECT grant deliberately exposes status — but the
// rights card rendered only the Request button, so a member who asked for a
// steward saw one toast and then no trace of the request anywhere in the app.
//
// The open lesson is the canonical selected one (fallbackData.rights.selected
// = "Section 7" → lesson id "section-7"), so every case below keys on that.
const LESSON = "section-7";

function renderRights(stewardRequests, { desktop = true, alt = false, lang = "en", onMessageSteward } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <RightsView
        data={fallbackData}
        desktop={desktop}
        alt={alt}
        onMessageSteward={onMessageSteward}
        stewardRequests={stewardRequests}
        onAssistant={vi.fn()}
        onSaveProgress={vi.fn().mockResolvedValue(undefined)}
        onRequestSteward={vi.fn().mockResolvedValue(undefined)}
      />
    </LanguageProvider>,
  );
}

const requestButton = () => screen.queryByRole("button", { name: "Request" });

describe("rights card steward-request status", () => {
  it("selects a desktop guide from the article list", () => {
    renderRights([], { desktop: true });
    const supervisorGuide = screen.getByRole("button", { name: /Supervisor questionsIf a supervisor asks about organizing/ });

    fireEvent.click(screen.getByRole("button", { name: "Read the guide" }));
    expect(supervisorGuide).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(supervisorGuide);
    expect(supervisorGuide).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the Request button when the member has no request for this lesson", () => {
    renderRights([]);
    expect(requestButton()).toBeInTheDocument();
    expect(screen.queryByText("Request sent — a committee member has been pinged.")).not.toBeInTheDocument();
    expect(screen.queryByText("A committee member is on it.")).not.toBeInTheDocument();
  });

  it("replaces the button with the sent status while the request is still open", () => {
    renderRights([{ id: "req-1", lesson_id: LESSON, status: "requested", created_at: "2026-08-08T10:00:00Z" }]);
    expect(screen.getByText("Request sent — a committee member has been pinged.")).toBeInTheDocument();
    // The button must go, not merely be disabled: a second identical row is
    // exactly what the table has no dedupe against.
    expect(requestButton()).not.toBeInTheDocument();
  });

  it("says a steward is on it once the request is acknowledged", () => {
    renderRights([{ id: "req-1", lesson_id: LESSON, status: "acknowledged", created_at: "2026-08-08T10:00:00Z" }]);
    expect(screen.getByText("A committee member is on it.")).toBeInTheDocument();
    expect(requestButton()).not.toBeInTheDocument();
  });

  it.each([
    [false, "en", "Sent Aug 8, 2026, 6:00 AM EDT", "Open Messages"],
    [true, "es", "Enviada el 8 ago 2026, 6:00 a. m. EDT", "Abrir Mensajes"],
  ])("shows when the request was sent and where to follow up (alt=%s, %s)", (alt, lang, sentAt, openMessages) => {
    const onMessageSteward = vi.fn();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-09T10:00:00.123Z"));
      renderRights([{ id: "req-1", lesson_id: LESSON, status: "requested", created_at: "2026-08-08T05:00:00.123456-05:00" }], { alt, lang, onMessageSteward });
      expect(screen.getByText(sentAt)).toHaveAttribute("datetime", "2026-08-08T10:00:00.123Z");
      fireEvent.click(screen.getByRole("button", { name: openMessages }));
      expect(onMessageSteward).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a request with a missing timestamp visible without time or follow-up", () => {
    const view = renderRights([{ id: "req-1", lesson_id: LESSON, status: "requested" }], { onMessageSteward: vi.fn() });
    expect(screen.getByText("Request sent — a committee member has been pinged.")).toBeVisible();
    expect(view.container.querySelector("time")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Messages" })).not.toBeInTheDocument();
  });

  it("shows a future timestamp without offering an early follow-up", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-09T10:00:00Z"));
      renderRights([{ id: "req-1", lesson_id: LESSON, status: "requested", created_at: "2026-08-09T05:30:00.654321-05:00" }], { onMessageSteward: vi.fn() });
      expect(screen.getByText("Sent Aug 9, 2026, 6:30 AM EDT")).toHaveAttribute("datetime", "2026-08-09T10:30:00.654Z");
      expect(screen.queryByText(/A day or more has passed/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open Messages" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["requested", "2026-08-09T09:00:00Z", true],
    ["acknowledged", "2026-08-07T09:00:00Z", true],
    ["requested", "not-a-date", false],
  ])("omits the follow-up for %s at %s", (status, created_at, hasTime) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-09T10:00:00Z"));
      const view = renderRights([{ id: "req-1", lesson_id: LESSON, status, created_at }], { onMessageSteward: vi.fn() });
      expect(Boolean(view.container.querySelector("time[datetime]"))).toBe(hasTime);
      expect(screen.queryByRole("button", { name: "Open Messages" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the button once the request is closed — asking again is never blocked", () => {
    renderRights([{ id: "req-1", lesson_id: LESSON, status: "closed", created_at: "2026-08-08T10:00:00Z" }]);
    expect(requestButton()).toBeInTheDocument();
    expect(screen.queryByText("A committee member is on it.")).not.toBeInTheDocument();
  });

  it("reads the NEWEST row for the lesson, not the first one handed over", () => {
    // Deliberately out of order: an older open request must not outrank the
    // newer closed one, and vice versa.
    renderRights([
      { id: "req-old", lesson_id: LESSON, status: "requested", created_at: "2026-08-01T10:00:00Z" },
      { id: "req-new", lesson_id: LESSON, status: "closed", created_at: "2026-08-08T10:00:00Z" },
    ]);
    expect(requestButton()).toBeInTheDocument();
  });

  it("prefers a newer open request over an older closed one", () => {
    renderRights([
      { id: "req-old", lesson_id: LESSON, status: "closed", created_at: "2026-08-01T10:00:00Z" },
      { id: "req-new", lesson_id: LESSON, status: "acknowledged", created_at: "2026-08-08T10:00:00Z" },
    ]);
    expect(screen.getByText("A committee member is on it.")).toBeInTheDocument();
    expect(requestButton()).not.toBeInTheDocument();
  });

  it("never leaks another lesson's request into this card", () => {
    renderRights([{ id: "req-1", lesson_id: "supervisor-questions", status: "requested", created_at: "2026-08-08T10:00:00Z" }]);
    expect(requestButton()).toBeInTheDocument();
    expect(screen.queryByText("Request sent — a committee member has been pinged.")).not.toBeInTheDocument();
  });

  it("shows the same status on the phone walkthrough, where the card also lives", async () => {
    renderRights([{ id: "req-1", lesson_id: LESSON, status: "requested", created_at: "2026-08-08T10:00:00Z" }], { desktop: false });
    // The phone parks the steward card behind the lesson detail.
    fireEvent.click(screen.getByRole("button", { name: "Start the walkthrough" }));
    expect(await screen.findByText("Request sent — a committee member has been pinged.")).toBeInTheDocument();
    expect(requestButton()).not.toBeInTheDocument();
  });

  it("defaults to the button when the prop is absent entirely", () => {
    render(
      <LanguageProvider lang="en">
        <RightsView
          data={fallbackData}
          desktop
          onAssistant={vi.fn()}
          onSaveProgress={vi.fn().mockResolvedValue(undefined)}
          onRequestSteward={vi.fn().mockResolvedValue(undefined)}
        />
      </LanguageProvider>,
    );
    expect(requestButton()).toBeInTheDocument();
  });
});

it("reconciles a changed successful progress snapshot without overwriting a pending optimistic save", async () => {
  let resolveSave;
  const saving = new Promise(resolve => { resolveSave = resolve; });
  const initial = structuredClone(fallbackData);
  const record = initial.rights.lessonRecords.find(item => item.label === initial.rights.selected);
  record.completedSteps = [];
  const save = vi.fn(() => saving);
  const element = data => <LanguageProvider lang="en"><RightsView data={data} desktop onSaveProgress={save} onRequestSteward={vi.fn()} /></LanguageProvider>;
  const rendered = render(element(initial));
  const step = document.querySelector(".learn-step");
  fireEvent.click(step);
  expect(step).toHaveAttribute("aria-pressed", "true");
  rendered.rerender(element(structuredClone(initial)));
  expect(step).toHaveAttribute("aria-pressed", "true");
  const updated = structuredClone(initial);
  updated.rights.lessonRecords.find(item => item.label === updated.rights.selected).completedSteps = [0];
  rendered.rerender(element(updated));
  await act(async () => resolveSave());
  expect(step).toHaveAttribute("aria-pressed", "true");
  rendered.rerender(element(initial));
  expect(step).toHaveAttribute("aria-pressed", "false");
});

it("rolls back only the failed step while a later in-flight toggle stays pressed", async () => {
  const pending = [];
  const save = vi.fn(() => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
  }));
  const data = structuredClone(fallbackData);
  data.rights.lessonRecords.find(item => item.label === "Section 7").completedSteps = [];
  const element = rightsData => (
    <LanguageProvider lang="en">
      <RightsView data={rightsData} desktop onSaveProgress={save} onRequestSteward={vi.fn()} />
    </LanguageProvider>
  );
  const rendered = render(element(data));
  const steps = document.querySelectorAll(".learn-step");
  fireEvent.click(steps[0]);
  fireEvent.click(steps[1]);
  expect(steps[0]).toHaveAttribute("aria-pressed", "true");
  expect(steps[1]).toHaveAttribute("aria-pressed", "true");
  await act(async () => pending[0].reject(new Error("first step save failed")));
  expect(steps[0]).toHaveAttribute("aria-pressed", "false");
  expect(steps[1]).toHaveAttribute("aria-pressed", "true");
  const updated = structuredClone(data);
  updated.rights.lessonRecords.find(item => item.label === "Section 7").completedSteps = [1];
  rendered.rerender(element(updated));
  expect(steps[1]).toHaveAttribute("aria-pressed", "true");
  await act(async () => pending[1].resolve());
  expect(steps[0]).toHaveAttribute("aria-pressed", "false");
  expect(steps[1]).toHaveAttribute("aria-pressed", "true");
});

it("keeps a different lesson's progress when an older lesson save fails after switching", async () => {
  let rejectSave;
  const saving = new Promise((_resolve, reject) => { rejectSave = reject; });
  const data = structuredClone(fallbackData);
  data.rights.lessonRecords.find(item => item.label === "Section 7").completedSteps = [];
  data.rights.lessonRecords.find(item => item.label === "Supervisor questions").completedSteps = [1];
  render(<LanguageProvider lang="en"><RightsView data={data} desktop onSaveProgress={() => saving} onRequestSteward={vi.fn()} /></LanguageProvider>);
  fireEvent.click(document.querySelector(".learn-step"));
  fireEvent.click(screen.getByRole("button", { name: /Supervisor questionsIf a supervisor asks about organizing/ }));
  expect(document.querySelectorAll(".learn-step")[0]).toHaveAttribute("aria-pressed", "false");
  expect(document.querySelectorAll(".learn-step")[1]).toHaveAttribute("aria-pressed", "true");
  await act(async () => rejectSave(new Error("older lesson save failed")));
  expect(document.querySelectorAll(".learn-step")[0]).toHaveAttribute("aria-pressed", "false");
  expect(document.querySelectorAll(".learn-step")[1]).toHaveAttribute("aria-pressed", "true");
});

// A11Y-UG-LEARN-BACK-CHEVRON-ACCESSIBLE-NAME-20260920: the phone
// walkthrough's back control spelled its chevron as a text node inside the
// button, so its accessible name was "‹ Learn" — a screen reader announced the
// decorative single left-pointing angle quotation mark as part of the control's
// name in both languages. The glyph belongs to sight only.
describe("phone walkthrough back control", () => {
  function openWalkthrough(lang) {
    render(
      <LanguageProvider lang={lang}>
        <RightsView
          data={fallbackData}
          desktop={false}
          onAssistant={vi.fn()}
          onSaveProgress={vi.fn().mockResolvedValue(undefined)}
          onRequestSteward={vi.fn().mockResolvedValue(undefined)}
        />
      </LanguageProvider>,
    );
    const back = document.querySelector(".learn-back");
    if (!back) fireEvent.click(document.querySelector(".learn-hero__cta"));
    return document.querySelector(".learn-back");
  }

  it("names the back control with the destination alone in English", () => {
    const back = openWalkthrough("en");
    expect(back).toHaveAccessibleName("Learn");
    expect(screen.getByRole("button", { name: "Learn" })).toBe(back);
    // The chevron still shows, hidden from the accessibility tree.
    expect(back.textContent).toContain("‹");
    expect(back.querySelector("[aria-hidden='true']").textContent).toContain("‹");
  });

  it("names the back control with the destination alone in Spanish", () => {
    const back = openWalkthrough("es");
    expect(back).toHaveAccessibleName("Aprender");
    expect(back.textContent).toContain("‹");
  });
});

// Union Ground: the rollback was silent, so a worker whose step never saved
// saw the checkbox spring back with no reason. The view now says so.
it("tells the worker when a step could not be saved", async () => {
  const data = structuredClone(fallbackData);
  data.rights.lessonRecords.find(item => item.label === "Section 7").completedSteps = [];
  const save = vi.fn().mockRejectedValue(new Error("offline"));
  render(<LanguageProvider lang="en"><RightsView data={data} desktop onSaveProgress={save} onRequestSteward={vi.fn()} /></LanguageProvider>);
  await act(async () => { fireEvent.click(document.querySelector(".learn-step")); });
  expect(await screen.findByRole("status")).toHaveTextContent("That step could not be saved");
  expect(document.querySelector(".learn-step")).toHaveAttribute("aria-pressed", "false");
});

it("teaches organizing rights, never grievance-era doctrine, from the demo data", () => {
  renderRights([], { desktop: true });
  for (const label of ["Section 7", "Supervisor questions", "Cards & majority", "Captive meeting", "Retaliation"]) {
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  }
  expect(document.body.textContent).not.toMatch(/Weingarten|Loudermill/);
});


// Record 8435: Request keeps focus while the steward request is sent, and a
// second activation in the same tick sends no second request.
describe("steward request while it is sent", () => {
  const mount = (onRequestSteward) => render(
    <LanguageProvider lang="en">
      <RightsView data={fallbackData} desktop stewardRequests={[]} onAssistant={vi.fn()} onSaveProgress={vi.fn().mockResolvedValue(undefined)} onRequestSteward={onRequestSteward} />
    </LanguageProvider>,
  );

  it("keeps Request focused while the request is sent, and requests once", async () => {
    const onRequestSteward = vi.fn(async () => undefined);
    mount(onRequestSteward);
    await expectHeldWriteFocus(onRequestSteward, requestButton());
    expect(onRequestSteward).toHaveBeenCalledExactlyOnceWith(LESSON);
  });

  it("requests once when Request is activated twice in one tick", async () => {
    const onRequestSteward = vi.fn(async () => undefined);
    mount(onRequestSteward);
    const request = requestButton();
    await expectOneWriteFromOneTick(onRequestSteward, [() => fireEvent.click(request), () => fireEvent.click(request)]);
  });
});

// #9595 (D2-9): with no steward named for the reader, the card beside the
// disciplinary-meeting script promised "your steward is pinged instantly" and
// offered Request, which saves a row only steward accounts can read.
describe("Organizing rights with no steward named (#9595)", () => {
  function renderNoSteward({ lang = "en", alt = false, presence = "none", desktop = true } = {}) {
    return render(
      <LanguageProvider lang={lang}>
        <RightsView
          alt={alt}
          data={fallbackData}
          desktop={desktop}
          stewardPresence={presence}
          stewardRequests={[]}
          onAssistant={vi.fn()}
          onMessageSteward={vi.fn()}
          onSaveProgress={vi.fn().mockResolvedValue(undefined)}
          onRequestSteward={vi.fn().mockResolvedValue(undefined)}
        />
      </LanguageProvider>,
    );
  }




  it("says the same in Spanish", () => {
    renderNoSteward({ lang: "es" });
    expect(screen.queryByText(/recibe el aviso al instante/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Solicitar" })).not.toBeInTheDocument();
    expect(screen.getByText("Todavía no hay un miembro del comité nombrado para tu campaña.")).toBeInTheDocument();
  });

  it("keeps the phone walkthrough's card honest too", () => {
    renderNoSteward({ desktop: false });
    fireEvent.click(screen.getByRole("button", { name: "Start the walkthrough" }));
    expect(screen.getByText("No committee member is named for your campaign yet.")).toBeInTheDocument();
    expect(requestButton()).not.toBeInTheDocument();
  });


  it("says the only-steward line in Spanish", () => {
    renderNoSteward({ presence: "only-self", lang: "es" });
    expect(screen.getByText("No hay otro miembro del comité nombrado en tu campaña con quien comunicarte.")).toBeInTheDocument();
    expect(screen.queryByText(/No tienes que responder/)).not.toBeInTheDocument();
  });

  // Sol re-read of dadafe1f, P1: paused stewards keep the page exactly as on Main.
});
