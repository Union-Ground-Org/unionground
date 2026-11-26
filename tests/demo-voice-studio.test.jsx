import { StrictMode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoVoiceStudio } from "../src/components/DemoVoiceStudio.jsx";
import { catalogue } from "../src/lib/i18n.js";

function voiceLiveRegion() {
  const region = document.querySelector("p.voice-demo-live");
  expect(region).toBeTruthy();
  return region;
}

// English literals the studio used to seed into drafts regardless of language
// (UX-UG-VOICE-STUDIO-SEED-DRAFTS-ENGLISH-IN-SPANISH-EDITOR-20260920). No
// input or results heading may carry any of these at lang="es".
const EN_SEED_PATTERN =
  /Worker priorities|Which issue should we address first|Staffing, Scheduling, Pay|Tell us more about your choice|Workplace safety follow-up|Safety follow-up|Which safety concern needs the quickest response|Staffing, Equipment, Training, Facility|Where did this happen|Main site, Satellite site, Remote|What should a steward know|Which bargaining update|Staffing proposal|Scheduling proposal|Pay proposal/;

function seededFieldValues() {
  return [...document.querySelectorAll("input, textarea")]
    .map((node) => node.value)
    .join("\n");
}

function expectBranchValueAmongOptions(optionsLabel, branchLabel) {
  const options = screen
    .getAllByLabelText(optionsLabel)[0]
    .value.split(",")
    .map((option) => option.trim());
  expect(options).toContain(screen.getByLabelText(branchLabel).value);
}

describe("SAMPLE staff Voice studio", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates an AI-assisted, sectioned multi-question survey draft", () => {
    render(<DemoVoiceStudio />);
    fireEvent.click(
      screen.getByRole("button", { name: "Draft a safety survey" }),
    );
    expect(
      screen.getByRole("heading", { name: "Workplace safety follow-up" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/structured draft/i)).toBeInTheDocument();
    expect(
      screen.getAllByLabelText("Type").map((control) => control.value),
    ).toEqual(["radio", "dropdown", "text"]);

    fireEvent.click(screen.getByRole("button", { name: "Add section" }));
    fireEvent.change(screen.getAllByLabelText(/Section 2/)[0], {
      target: { value: "Closing review" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Add question" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(
      screen.getByRole("heading", { name: "Workplace safety follow-up" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Survey draft saved/i)).toBeInTheDocument();
  });

  // UX-UG-VOICE-STUDIO-QUESTION-TYPE-OPTIONS-RAW-TOKENS-20260920: the type
  // options carried no `value`, so the raw English token was both the label the
  // reader saw and the value the draft stored. The label has to be catalogue
  // copy in each language while the stored value stays the canonical token that
  // branching and the options field compare against.
  it("labels the question type options in the reader's language and keeps the stored token", () => {
    const { unmount } = render(<DemoVoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "New survey" }));
    const english = screen.getAllByLabelText("Type")[0];
    expect(
      [...english.options].map((option) => [option.value, option.textContent]),
    ).toEqual([
      ["text", "Text answer"],
      ["radio", "One choice"],
      ["checkbox", "Multiple choice"],
      ["dropdown", "Dropdown"],
      ["scale", "Scale"],
      ["yes/no", "Yes / no"],
    ]);
    unmount();

    render(<DemoVoiceStudio lang="es" />);
    fireEvent.click(screen.getByRole("button", { name: "Nueva encuesta" }));
    const spanish = screen.getAllByLabelText("Tipo")[0];
    expect(
      [...spanish.options].map((option) => [option.value, option.textContent]),
    ).toEqual([
      ["text", "Respuesta de texto"],
      ["radio", "Una opción"],
      ["checkbox", "Varias opciones"],
      ["dropdown", "Lista desplegable"],
      ["scale", "Escala"],
      ["yes/no", "Sí / no"],
    ]);
    // Choosing a type in Spanish stores the canonical token, so the
    // comma-separated options field still appears for a choice question.
    fireEvent.change(spanish, { target: { value: "checkbox" } });
    expect(spanish.value).toBe("checkbox");
    expect(
      screen.getAllByLabelText("Opciones, separadas por comas").length,
    ).toBeGreaterThan(0);
  });

  it("runs distribution, review, weekly editorial, and live-meeting controls", () => {
    render(<DemoVoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "Operations" }));
    fireEvent.change(screen.getByLabelText("Select survey"), {
      target: { value: "survey-scheduling" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Distribute" }));
    expect(screen.getByText(/Survey distributed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send reminder" }));
    expect(screen.getByText(/queued for escalation/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Move forward" })[0]);
    expect(screen.getByText(/next review lane/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Weekly pool" }));
    const weekly = screen
      .getByText("Should the chapter publish a monthly staffing snapshot?")
      .closest("article");
    fireEvent.click(within(weekly).getByRole("button", { name: "Publish" }));
    expect(within(weekly).getByText("Published")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Live meeting" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Draft poll with the Guide" }),
    );
    expect(screen.getByLabelText("Poll prompt")).toHaveValue(
      "Which bargaining update should we discuss next?",
    );
    expect(screen.getByText(/handed it to the editor/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(
      screen.getByText(/Results update as votes arrive/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Simulate live votes" }),
    );
    expect(screen.getByText(/Three SAMPLE votes arrived/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Check in" })[0]);
    expect(screen.getByText(/checked in manually/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(
      screen.getByText(/archived with the meeting record/i),
    ).toBeInTheDocument();
  });

  it("withholds small-group reports and enables exports only above the threshold", () => {
    render(<DemoVoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "Insights" }));
    expect(screen.getByText("238")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CSV" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Survey"), {
      target: { value: "survey-scheduling" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Breakdown withheld");
    expect(screen.getByRole("button", { name: "CSV" })).toBeDisabled();
    // The privacy floor of 25 (Lovable audit APP-STEWARD-07): a lower minimum
    // group size cannot be entered, and the withheld note names 25.
    expect(screen.getByLabelText("Minimum group size")).toHaveAttribute("min", "25");
    fireEvent.change(screen.getByLabelText("Minimum group size"), {
      target: { value: "5" },
    });
    expect(screen.getByLabelText("Minimum group size")).toHaveValue(25);
    expect(screen.getByRole("status")).toHaveTextContent(
      /smallest group has 0 responses. At least 25 are required/i,
    );
  });

  it("localizes staff navigation and primary actions", () => {
    render(<DemoVoiceStudio lang="es" />);
    expect(
      screen.getByRole("heading", { name: "Estudio de encuestas y reuniones" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Operaciones" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Nueva encuesta" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Activa")).toBeInTheDocument();
    expect(screen.getByText(/Trimestral · 8 secciones/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preguntas semanales" }));
    expect(screen.getByText("Prioridad")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reunión en vivo" }));
    expect(screen.getByText("Programada")).toBeInTheDocument();
    expect(screen.getAllByText(/Respuesta: Sí/)).toHaveLength(3);
    expect(screen.getByText(/Respuesta: Quizás/)).toBeInTheDocument();
  });

  it("supports the manual builder fields, branching, and cancellation", () => {
    render(<DemoVoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "New survey" }));
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Survey title"), {
      target: { value: "Member scheduling pulse" },
    });
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "Priya Nair" },
    });
    fireEvent.change(screen.getByLabelText("Instrument"), {
      target: { value: "quarterly" },
    });
    fireEvent.change(screen.getByLabelText("Section 1"), {
      target: { value: "Schedule choices" },
    });
    fireEvent.change(screen.getAllByLabelText("Question")[0], {
      target: { value: "Which shift should change?" },
    });
    fireEvent.change(screen.getAllByLabelText("Type")[0], {
      target: { value: "scale" },
    });
    expect(
      screen.queryAllByLabelText("Options, separated by commas"),
    ).toHaveLength(0);
    fireEvent.click(screen.getAllByLabelText("Required")[0]);
    fireEvent.change(screen.getAllByLabelText("Show after")[1], {
      target: { value: "" },
    });
    expect(screen.queryByLabelText("When answer is")).not.toBeInTheDocument();
    fireEvent.change(screen.getAllByLabelText("Show after")[1], {
      target: { value: "draft-q1" },
    });
    fireEvent.change(screen.getByLabelText("When answer is"), {
      target: { value: "Scheduling" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    expect(screen.getAllByLabelText("Question")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Survey title")).not.toBeInTheDocument();
  });

  it("seeds New survey, safety survey and live poll drafts in Spanish at lang=\"es\"", () => {
    render(<DemoVoiceStudio lang="es" />);

    fireEvent.click(screen.getByRole("button", { name: "Nueva encuesta" }));
    expect(seededFieldValues()).not.toMatch(EN_SEED_PATTERN);
    expect(screen.getByLabelText("Sección 1")).toHaveValue(
      catalogue.es["voiceDemo.seedMemberPriorities"],
    );
    expectBranchValueAmongOptions(
      "Opciones, separadas por comas",
      "Cuando la respuesta sea",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Crear encuesta de seguridad" }),
    );
    expect(seededFieldValues()).not.toMatch(EN_SEED_PATTERN);
    expect(
      screen.getByRole("heading", {
        name: catalogue.es["voiceDemo.aiSafetyTitle"],
      }),
    ).toBeInTheDocument();
    expectBranchValueAmongOptions(
      "Opciones, separadas por comas",
      "Cuando la respuesta sea",
    );

    fireEvent.click(screen.getByRole("button", { name: "Reunión en vivo" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Crear encuesta con la Guía" }),
    );
    expect(seededFieldValues()).not.toMatch(EN_SEED_PATTERN);
    const pollTitle = catalogue.es["voiceDemo.livePollDraftTitle"];
    expect(screen.getByLabelText("Pregunta de la encuesta")).toHaveValue(pollTitle);
    expect(screen.getByRole("heading", { name: pollTitle })).toBeInTheDocument();
  });

  it("keeps the English seed drafts unchanged at lang=\"en\"", () => {
    render(<DemoVoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "New survey" }));
    expect(screen.getByLabelText("Section 1")).toHaveValue("Worker priorities");
    expect(screen.getAllByLabelText("Question")[0]).toHaveValue(
      "Which issue should we address first?",
    );
    expect(screen.getByLabelText("Options, separated by commas")).toHaveValue(
      "Staffing, Scheduling, Pay",
    );
    expect(screen.getAllByLabelText("Question")[1]).toHaveValue(
      "Tell us more about your choice.",
    );
    expect(screen.getByLabelText("When answer is")).toHaveValue("Staffing");
    expectBranchValueAmongOptions("Options, separated by commas", "When answer is");

    fireEvent.click(
      screen.getByRole("button", { name: "Draft a safety survey" }),
    );
    expect(screen.getByLabelText("Survey title")).toHaveValue(
      "Workplace safety follow-up",
    );
    expect(screen.getByLabelText("Section 1")).toHaveValue("Safety follow-up");
    expect(screen.getAllByLabelText("Question")[0]).toHaveValue(
      "Which safety concern needs the quickest response?",
    );
    expect(
      screen.getAllByLabelText("Options, separated by commas")[0],
    ).toHaveValue("Staffing, Equipment, Training, Facility");
    expect(screen.getByLabelText("When answer is")).toHaveValue("Staffing");
    expectBranchValueAmongOptions("Options, separated by commas", "When answer is");

    fireEvent.click(screen.getByRole("button", { name: "Live meeting" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Draft poll with the Guide" }),
    );
    expect(screen.getByLabelText("Poll prompt")).toHaveValue(
      "Which bargaining update should we discuss next?",
    );
    expect(screen.getByLabelText("Option 1")).toHaveValue("Staffing proposal");
    expect(screen.getByLabelText("Option 2")).toHaveValue("Scheduling proposal");
    expect(screen.getByLabelText("Option 3")).toHaveValue("Pay proposal");
    expect(
      screen.getByRole("heading", {
        name: "Which bargaining update should we discuss next?",
      }),
    ).toBeInTheDocument();
  });

  it("keeps every seed draft string at EN/ES parity in the tú register", () => {
    const seedKeys = Object.keys(catalogue.en).filter((key) =>
      /^voiceDemo\.(?:seed|aiSafety|livePollDraftTitle|livePollOption)/.test(key),
    );
    expect(seedKeys).toHaveLength(15);
    for (const key of seedKeys) {
      expect(catalogue.es[key], `${key} es`).toBeTruthy();
      expect(catalogue.es[key], `${key} copied English`).not.toBe(catalogue.en[key]);
      expect(catalogue.es[key], `${key} usted`).not.toMatch(/\busted\b/i);
    }
    const optionCount = (value) => value.split(",").length;
    for (const key of ["voiceDemo.seedIssueFirstOptions", "voiceDemo.aiSafetyQ1Options", "voiceDemo.aiSafetyQ2Options"]) {
      expect(optionCount(catalogue.es[key]), key).toBe(optionCount(catalogue.en[key]));
    }
  });

  it("handles ownership, readiness, generated work, and survey deactivation", () => {
    render(<DemoVoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "Operations" }));
    fireEvent.change(screen.getByLabelText("Assigned owner"), {
      target: { value: "Priya Nair" },
    });
    expect(screen.getByText("Survey owner reassigned.")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Audience confirmed"));
    expect(screen.getByRole("button", { name: "Distribute" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Audience confirmed"));
    fireEvent.click(
      screen.getByRole("button", { name: "Follow up on flagged responses" }),
    );
    expect(
      screen.getByRole("button", { name: "Follow up on flagged responses" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Send reminder" }));
    expect(screen.getByText(/2 reminder run/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(screen.getByText(/moved to reporting/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeDisabled();
  });

  it("enforces one weekly priority while supporting every editorial outcome", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    render(<DemoVoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "Weekly pool" }));
    const cards = screen.getAllByRole("article");
    fireEvent.click(within(cards[1]).getByRole("button", { name: "Reserve" }));
    expect(screen.getByText(/reserved for editorial review/i)).toBeInTheDocument();
    fireEvent.click(within(cards[1]).getByRole("button", { name: "Prioritize" }));
    expect(screen.getAllByText("Priority")).toHaveLength(1);
    fireEvent.click(within(cards[2]).getByRole("button", { name: "Reject" }));
    expect(within(cards[2]).getByText("Rejected")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Run weighted selection" }),
    );
    expect(screen.getByText(/Weighted selection chose:/)).toBeInTheDocument();
    expect(screen.getAllByText("Priority")).toHaveLength(1);
  });

  it("locks live editing, changes exactly three votes, and toggles projection", () => {
    render(<DemoVoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "Live meeting" }));
    // Votes already cast lock the ballot content (Lovable audit
    // APP-STEWARD-07); a new poll starts from Draft poll with the Guide.
    expect(screen.getByLabelText("Poll prompt")).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(/locked: \d+ votes have been cast/);
    fireEvent.click(screen.getByRole("button", { name: "Draft poll with the Guide" }));
    expect(screen.getByLabelText("Poll prompt")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Poll prompt"), {
      target: { value: "Choose the next meeting topic" },
    });
    fireEvent.change(screen.getByLabelText("Scheduled for"), {
      target: { value: "2026-09-01T18:30" },
    });
    fireEvent.change(screen.getByLabelText("Option 1"), {
      target: { value: "Staffing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(screen.getByText("Meeting poll scheduled.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Projector view" }));
    expect(screen.getByRole("button", { name: "Exit projector" })).toBeInTheDocument();
    const voteTotal = () =>
      Number(
        screen
          .getByText((_, element) =>
            /^\d+ votes$/.test(element?.textContent || ""),
          )
          .textContent.match(/\d+/)[0],
      );
    const before = voteTotal();
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(screen.getByLabelText("Poll prompt")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Draft poll with the Guide" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Simulate live votes" }));
    const after = voteTotal();
    expect(after - before).toBe(3);
  });

  // PERF-UG-VOICE-LIVE-POLL-COUNTDOWN-REARMS-AND-UNNAMED-TIMER-20260920:
  // the countdown effect used to depend on secondsRemaining, so every tick tore
  // the interval down and armed a new one, and the mm:ss clock had no
  // accessible name.
  it("keeps one named countdown interval for the whole live window", () => {
    vi.useFakeTimers();
    try {
      const setInterval = vi.spyOn(window, "setInterval");
      const clearInterval = vi.spyOn(window, "clearInterval");
      render(<DemoVoiceStudio />);
      fireEvent.click(screen.getByRole("button", { name: "Live meeting" }));
      setInterval.mockClear();
      clearInterval.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "Activate" }));
      expect(setInterval).toHaveBeenCalledTimes(1);

      act(() => vi.advanceTimersByTime(3000));
      expect(setInterval).toHaveBeenCalledTimes(1);
      expect(clearInterval).not.toHaveBeenCalled();

      const countdown = screen.getByRole("timer", {
        name: "Live poll countdown",
      });
      expect(countdown).toHaveTextContent("01:27");

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(clearInterval).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(3000));
      expect(countdown).toHaveTextContent("01:27");
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the live countdown in Spanish", () => {
    render(<DemoVoiceStudio lang="es" />);
    fireEvent.click(screen.getByRole("button", { name: "Reunión en vivo" }));
    expect(
      screen.getByRole("timer", {
        name: "Cuenta regresiva de la encuesta en vivo",
      }),
    ).toBeInTheDocument();
  });

  it("changes the already-mounted live region when Reserve repeats the same sentence", () => {
    render(
      <StrictMode>
        <DemoVoiceStudio />
      </StrictMode>,
    );
    const region = voiceLiveRegion();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Weekly pool" }));
    const card = screen.getAllByRole("article")[1];
    const reserve = within(card).getByRole("button", { name: "Reserve" });
    fireEvent.click(reserve);
    const first = region.textContent;
    expect(screen.getByText("Question reserved for editorial review.")).toBe(region);
    expect(region.querySelector(".sr-only")).not.toHaveAttribute("aria-hidden");
    fireEvent.click(reserve);
    expect(screen.getByText("Question reserved for editorial review.")).toBe(region);
    expect(region.textContent).not.toBe(first);
    expect(voiceLiveRegion()).toBe(region);
  });

  it("repeats the Spanish reserve notice by changing that same live region", () => {
    render(<DemoVoiceStudio lang="es" />);
    const region = voiceLiveRegion();
    fireEvent.click(screen.getByRole("button", { name: "Preguntas semanales" }));
    const card = screen.getAllByRole("article")[1];
    const reserve = within(card).getByRole("button", { name: "Reservar" });
    fireEvent.click(reserve);
    const first = region.textContent;
    expect(screen.getByText("Pregunta reservada para revisión editorial.")).toBe(region);
    fireEvent.click(reserve);
    expect(screen.getByText("Pregunta reservada para revisión editorial.")).toBe(region);
    expect(region.textContent).not.toBe(first);
  });

  it("uses the chosen range and survey for privacy-aware exports", () => {
    const createObjectURL = vi.fn(() => "blob:voice-report");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<DemoVoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "Insights" }));
    fireEvent.change(screen.getByLabelText("Date range"), {
      target: { value: "year" },
    });
    expect(screen.getByText("276")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Date range"), {
      target: { value: "all" },
    });
    expect(screen.getByText("313")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Minimum group size"), {
      target: { value: "" },
    });
    expect(screen.getByLabelText("Minimum group size")).toHaveValue(25);
    fireEvent.change(screen.getByLabelText("Minimum group size"), {
      target: { value: "30" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Breakdown withheld");
    expect(screen.getByRole("button", { name: "CSV" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Minimum group size"), {
      target: { value: "10" },
    });
    expect(screen.getByLabelText("Minimum group size")).toHaveValue(25);
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "XLSX" }));
    expect(click).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Prepare report" }));
    expect(screen.getByText("Printable All responses report prepared.")).toBeInTheDocument();
  });

  it("keeps the live-meeting check-in code static and names it as a tour sample in both locales", () => {
    const captionKey = "voiceDemo.checkInCodeShownForTheTour";
    expect(catalogue.en[captionKey]).toBe("Sample code shown for the tour");
    expect(catalogue.es[captionKey]).toBe(
      "Código de ejemplo mostrado en el recorrido",
    );
    expect(catalogue.en["voiceDemo.rotatesWhenTheMeetingCloses"]).toBeUndefined();
    expect(catalogue.es["voiceDemo.rotatesWhenTheMeetingCloses"]).toBeUndefined();

    const locales = [
      {
        lang: "en",
        liveTab: "Live meeting",
        activate: "Activate",
        close: "Close",
        archive: "Archive",
        checkInLabel: "Check-in code",
        caption: catalogue.en[captionKey],
      },
      {
        lang: "es",
        liveTab: "Reunión en vivo",
        activate: "Activar",
        close: "Cerrar",
        archive: "Archivar",
        checkInLabel: "Código de registro",
        caption: catalogue.es[captionKey],
      },
    ];

    for (const locale of locales) {
      window.sessionStorage.clear();
      const { unmount } = render(<DemoVoiceStudio lang={locale.lang} />);
      fireEvent.click(screen.getByRole("button", { name: locale.liveTab }));

      const readPanel = () => {
        const label = screen.getByText(locale.checkInLabel);
        return label.closest(".voice-demo-checkin-code");
      };

      const assertStaticCode = () => {
        const panel = readPanel();
        expect(panel).toHaveTextContent("736 218");
        expect(panel).toHaveTextContent(locale.caption);
        expect(panel.textContent).not.toMatch(/rotates/i);
        expect(panel.textContent).not.toMatch(/Cambia al cerrar/i);
        expect(panel.querySelector("strong")?.textContent).toBe("736 218");
      };

      assertStaticCode();
      fireEvent.click(screen.getByRole("button", { name: locale.activate }));
      assertStaticCode();
      fireEvent.click(screen.getByRole("button", { name: locale.close }));
      assertStaticCode();
      fireEvent.click(screen.getByRole("button", { name: locale.archive }));
      assertStaticCode();
      unmount();
    }
  });

  it("persists once per action under StrictMode", () => {
    const writes = vi.spyOn(window.Storage.prototype, "setItem");
    const broadcasts = vi.fn();
    window.addEventListener("union-ground:demo-voice-change", broadcasts);
    try {
      render(
        <StrictMode>
          <DemoVoiceStudio />
        </StrictMode>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Operations" }));
      fireEvent.change(screen.getByLabelText("Select survey"), {
        target: { value: "survey-scheduling" },
      });
      expect(writes).not.toHaveBeenCalled();
      expect(broadcasts).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Distribute" }));
      expect(screen.getByText(/Survey distributed/i)).toBeInTheDocument();
      expect(writes).toHaveBeenCalledTimes(1);
      expect(broadcasts).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Send reminder" }));
      expect(screen.getByText(/queued for escalation/i)).toBeInTheDocument();
      expect(writes).toHaveBeenCalledTimes(2);
      expect(broadcasts).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("union-ground:demo-voice-change", broadcasts);
    }
  });

  it("persists each live countdown tick once under StrictMode", () => {
    vi.useFakeTimers();
    const broadcasts = vi.fn();
    window.addEventListener("union-ground:demo-voice-change", broadcasts);
    try {
      render(
        <StrictMode>
          <DemoVoiceStudio />
        </StrictMode>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Live meeting" }));
      fireEvent.click(screen.getByRole("button", { name: "Activate" }));
      const writes = vi.spyOn(window.Storage.prototype, "setItem");
      broadcasts.mockClear();

      act(() => vi.advanceTimersByTime(1000));
      expect(writes).toHaveBeenCalledTimes(1);
      expect(broadcasts).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("timer", { name: "Live poll countdown" }),
      ).toHaveTextContent("01:29");

      act(() => vi.advanceTimersByTime(1000));
      expect(writes).toHaveBeenCalledTimes(2);
      expect(broadcasts).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("union-ground:demo-voice-change", broadcasts);
      vi.useRealTimers();
    }
  });

  it("renders the shared weekly seed as readable body text and options in both languages", () => {
    const view = render(<DemoVoiceStudio />);
    fireEvent.click(screen.getByRole("button", { name: "Weekly pool" }));
    expect(
      screen.getByRole("heading", {
        name: "Which shift needs a steward walk-through next?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Day · Evening · Overnight · 18/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Should the chapter publish a monthly staffing snapshot?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Yes · No · Discuss first · 11/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "What training would help new stewards most?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Intake · Investigations · Deadlines · 7/),
    ).toBeInTheDocument();
    expect(view.container.textContent).not.toContain("[object Object]");
    view.unmount();

    const es = render(<DemoVoiceStudio lang="es" />);
    fireEvent.click(screen.getByRole("button", { name: "Preguntas semanales" }));
    expect(
      screen.getByRole("heading", {
        name: "¿Qué turno necesita un recorrido del delegado a continuación?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Día · Tarde · Noche · 18/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "¿Debería el capítulo publicar un resumen mensual de dotación?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Sí · No · Discutir primero · 11/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "¿Qué capacitación ayudaría más a los nuevos delegados?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Recepción de casos · Investigaciones · Plazos · 7/),
    ).toBeInTheDocument();
    expect(es.container.textContent).not.toContain("[object Object]");
    expect(es.container.textContent).not.toContain(
      "Which shift needs a steward walk-through next?",
    );
  });
});
