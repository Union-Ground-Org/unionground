import { StrictMode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoVoiceMember } from "../src/components/DemoVoiceMember.jsx";
import {
  createDemoVoiceState,
  voiceText,
  writeDemoVoiceState,
} from "./fixtures/retired-pre-bot/src/lib/demoVoiceParity.js";

function voiceLiveRegion() {
  const region = document.querySelector("p.voice-demo-live");
  expect(region).toBeTruthy();
  return region;
}

describe("SAMPLE member Voice parity", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("gates quarterly insights behind a sectioned, conditional response session", () => {
    render(<DemoVoiceMember />);
    expect(
      screen.getByText(/unlock your personal charts/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue survey" }));

    const first = screen.getByRole("region", { name: "Workload" });
    expect(
      within(first).queryByLabelText(/^What would make staffing safer\? \*/u),
    ).not.toBeInTheDocument();
    fireEvent.click(within(first).getByLabelText("3"));
    fireEvent.click(within(first).getByLabelText("No"));
    fireEvent.change(
      within(first).getByLabelText(/^What would make staffing safer\? \*/u),
      { target: { value: "Add a second person on closing shift." } },
    );
    fireEvent.click(
      within(first).getByRole("button", { name: "Save and continue" }),
    );

    expect(
      screen.getByRole("heading", { name: "Priorities" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Staffing"));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    fireEvent.click(screen.getByLabelText("Yes"));
    fireEvent.click(screen.getByRole("button", { name: "Submit check-in" }));
    expect(
      screen.getByText(/personal insights are unlocked/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Submitted. Personal charts/i)).toBeInTheDocument();
  });

  it("keeps a submitted quarterly check-in read-only with a Close survey action", () => {
    render(<DemoVoiceMember />);
    fireEvent.click(screen.getByRole("button", { name: "Continue survey" }));
    const first = screen.getByRole("region", { name: "Workload" });
    fireEvent.click(within(first).getByLabelText("3"));
    fireEvent.click(within(first).getByLabelText("No"));
    fireEvent.change(
      within(first).getByLabelText(/^What would make staffing safer\? \*/u),
      { target: { value: "Add a second person on closing shift." } },
    );
    fireEvent.click(
      within(first).getByRole("button", { name: "Save and continue" }),
    );
    fireEvent.click(screen.getByLabelText("Staffing"));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    fireEvent.click(screen.getByLabelText("Yes"));
    fireEvent.click(screen.getByRole("button", { name: "Submit check-in" }));

    const readStored = () =>
      JSON.parse(
        window.sessionStorage.getItem("union-ground:sample:voice-parity:v1"),
      );
    const stored = readStored();
    const submittedAnswers = stored.quarterly.answers;
    const submittedAt = stored.quarterly.submittedAt;
    expect(stored.quarterly.completed).toBe(true);
    expect(submittedAt).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Review answers" }));
    const survey = screen.getByRole("region", { name: "Follow-up" });

    within(survey)
      .getAllByRole("radio")
      .forEach((control) => expect(control).toBeDisabled());
    expect(
      within(survey).getByLabelText("Anything else the chapter should know?"),
    ).toBeDisabled();
    expect(
      within(survey).getByRole("button", { name: "Back" }),
    ).toBeEnabled();

    fireEvent.click(within(survey).getByLabelText("No"));
    fireEvent.change(
      within(survey).getByLabelText("Anything else the chapter should know?"),
      { target: { value: "Changed after submit." } },
    );
    expect(readStored().quarterly.answers).toEqual(submittedAnswers);

    // An earlier page pages forward without claiming to save anything.
    fireEvent.click(within(survey).getByRole("button", { name: "Back" }));
    const priorities = screen.getByRole("region", { name: "Priorities" });
    expect(within(priorities).getByLabelText("Staffing")).toBeDisabled();
    expect(
      within(priorities).queryByRole("button", { name: "Save and continue" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(priorities).getByRole("button", { name: "Continue survey" }),
    );

    const followUp = screen.getByRole("region", { name: "Follow-up" });
    expect(
      within(followUp).queryByRole("button", { name: "Submit check-in" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(followUp).getByRole("button", { name: "Close survey" }));
    expect(
      screen.queryByRole("region", { name: "Follow-up" }),
    ).not.toBeInTheDocument();
    expect(readStored().quarterly.submittedAt).toBe(submittedAt);
    expect(readStored().quarterly.answers).toEqual(submittedAnswers);
  });

  it("records a contextual pulse, spends a promotion credit, and governs Q&A", () => {
    render(<DemoVoiceMember />);
    fireEvent.click(screen.getByRole("button", { name: "Mostly" }));
    expect(screen.getByText(/response was recorded/i)).toBeInTheDocument();

    const weekly = screen.getByRole("region", {
      name: "Help choose the next poll",
    });
    fireEvent.change(
      within(weekly).getByLabelText("Proposed weekly question"),
      { target: { value: "Should we add a second evening meeting?" } },
    );
    fireEvent.change(within(weekly).getByLabelText("Answer option 1"), {
      target: { value: "Yes" },
    });
    fireEvent.change(within(weekly).getByLabelText("Answer option 2"), {
      target: { value: "Discuss first" },
    });
    fireEvent.click(
      within(weekly).getByRole("button", { name: "Submit to pool" }),
    );
    expect(
      within(weekly).getByRole("heading", {
        name: "Should we add a second evening meeting?",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(weekly).getAllByRole("button", { name: /Use promotion/ })[0],
    );
    expect(within(weekly).getByText("0 promotion credits")).toBeInTheDocument();
    expect(screen.getByText(/next-poll priority slot/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Question title"), {
      target: { value: "Can members attend remotely?" },
    });
    fireEvent.change(screen.getByLabelText("Details"), {
      target: { value: "I need the options for next week's chapter meeting." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post question" }));
    expect(
      screen.getByRole("heading", { name: "Can members attend remotely?" }),
    ).toBeInTheDocument();

    const question = screen
      .getByRole("heading", { name: "How do I document a denied break?" })
      .closest("article");
    fireEvent.change(
      within(question).getByLabelText(
        "Reply to How do I document a denied break?",
      ),
      { target: { value: "This helped me prepare my notes." } },
    );
    fireEvent.click(
      within(question).getByRole("button", { name: "Post reply" }),
    );
    expect(
      within(question).getByText("This helped me prepare my notes."),
    ).toBeInTheDocument();
    fireEvent.click(
      within(question).getByRole("button", { name: /Accepted answer/ }),
    );
    expect(screen.getByText(/Accepted answer updated/i)).toBeInTheDocument();
    fireEvent.click(within(question).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(question).getByLabelText("Question title"), {
      target: { value: "How should I document a denied break?" },
    });
    fireEvent.click(
      within(question).getByRole("button", { name: "Save changes" }),
    );
    expect(
      screen.getByRole("heading", {
        name: "How should I document a denied break?",
      }),
    ).toBeInTheDocument();
  });

  // UX-UG-VOICE-PROMOTION-CREDIT-COUNT-NOT-PLURALISED-20260920.
  for (const [lang, one, zero, three] of [
    ["en", "1 promotion credit", "0 promotion credits", "3 promotion credits"],
    ["es", "1 crédito de promoción", "0 créditos de promoción", "3 créditos de promoción"],
  ]) {
    it(`pluralises the promotion-credit chip by count in ${lang}`, () => {
      const view = render(<DemoVoiceMember lang={lang} />);
      const chip = () => document.querySelector(".voice-demo-credit");
      expect(chip()).toHaveTextContent(new RegExp(`^${one}$`));
      fireEvent.click(
        within(chip().closest("section")).getAllByRole("button", {
          name: lang === "en" ? /Use promotion/ : /promoción/i,
        })[0],
      );
      expect(chip()).toHaveTextContent(new RegExp(`^${zero}$`));
      view.unmount();

      window.sessionStorage.clear();
      writeDemoVoiceState({ ...createDemoVoiceState(), promotionCredits: 3 });
      render(<DemoVoiceMember lang={lang} />);
      expect(chip()).toHaveTextContent(new RegExp(`^${three}$`));
    });
  }

  it("persists once per action under StrictMode", () => {
    const writes = vi.spyOn(window.Storage.prototype, "setItem");
    const broadcasts = vi.fn();
    window.addEventListener("union-ground:demo-voice-change", broadcasts);
    try {
      render(
        <StrictMode>
          <DemoVoiceMember />
        </StrictMode>,
      );
      expect(writes).not.toHaveBeenCalled();
      expect(broadcasts).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Mostly" }));
      expect(screen.getByText(/response was recorded/i)).toBeInTheDocument();
      expect(writes).toHaveBeenCalledTimes(1);
      expect(broadcasts).toHaveBeenCalledTimes(1);

      const weekly = screen.getByRole("region", {
        name: "Help choose the next poll",
      });
      fireEvent.click(
        within(weekly).getAllByRole("button", { name: /Support · / })[0],
      );
      expect(writes).toHaveBeenCalledTimes(2);
      expect(broadcasts).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("union-ground:demo-voice-change", broadcasts);
    }
  });

  it("keeps the primary SAMPLE controls available in Spanish", () => {
    render(<DemoVoiceMember lang="es" />);
    expect(
      screen.getByRole("heading", { name: "Tu espacio de participación" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continuar encuesta" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Ayuda a elegir la próxima encuesta",
      }),
    ).toBeInTheDocument();
    // A held Publicar pregunta stays focusable (aria-disabled) and posts nothing when pressed.
    const questionsBefore = document.querySelectorAll(".voice-demo-qa-list > *").length;
    fireEvent.click(screen.getByRole("button", { name: "Publicar pregunta" }));
    expect(document.querySelectorAll(".voice-demo-qa-list > *")).toHaveLength(questionsBefore);
    expect(
      screen.getByRole("button", { name: "Publicar pregunta" }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(
      screen.getByRole("button", { name: "Continuar encuesta" }),
    );
    expect(
      screen.getByRole("heading", { name: "Carga de trabajo" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /¿Tu área de trabajo tiene personal suficiente para operar con seguridad\?/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("A veces")).toBeInTheDocument();
  });

  it("keeps stable survey answers selected across a language change", () => {
    const view = render(<DemoVoiceMember />);
    fireEvent.click(screen.getByRole("button", { name: "Continue survey" }));
    fireEvent.click(screen.getByLabelText("3"));
    fireEvent.click(screen.getByLabelText("Yes"));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    fireEvent.click(screen.getByLabelText("Staffing"));
    fireEvent.change(screen.getByLabelText("Which meeting time works best?"), {
      target: { value: "after-work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    fireEvent.click(screen.getByLabelText("Yes"));
    view.rerender(<DemoVoiceMember lang="es" />);
    expect(screen.getByLabelText("Sí")).toBeChecked();
  });

  it("supports pulse dismissal, Q&A search and voting, and owned-question deletion", () => {
    render(<DemoVoiceMember />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(
      screen.queryByRole("heading", {
        name: "Was this Voice workspace easy to use?",
      }),
    ).not.toBeInTheDocument();

    const weekly = screen.getByRole("region", {
      name: "Help choose the next poll",
    });
    const firstWeekly = within(weekly)
      .getByRole("heading", {
        name: "Which shift needs a steward walk-through next?",
      })
      .closest("article");
    const support = within(firstWeekly).getByRole("button", {
      name: /Support · 18/,
    });
    fireEvent.click(support);
    expect(
      within(firstWeekly).getByRole("button", { name: /Supported · 19/ }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      within(firstWeekly).getByRole("button", { name: /Supported · 19/ }),
    );

    fireEvent.change(screen.getByLabelText("Search campaign Q&A"), {
      target: { value: "overtime" },
    });
    expect(
      screen.getByRole("heading", {
        name: "Where can I find the overtime rotation?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "How do I document a denied break?",
      }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search campaign Q&A"), {
      target: { value: "" },
    });
    const owned = screen
      .getByRole("heading", { name: "How do I document a denied break?" })
      .closest("article");
    const questionVote = within(owned).getByRole("button", {
      name: "Vote for How do I document a denied break? (votes: 14)",
    });
    fireEvent.click(questionVote);
    expect(
      within(owned).getByRole("button", {
        name: "Vote for How do I document a denied break? (votes: 15)",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      within(owned).getByRole("button", {
        name: "Mark the reply by Jordan Lee as helpful: I also save the posted schedule when it changes. (votes: 4)",
      }),
    );
    expect(
      within(owned).getByRole("button", {
        name: "Mark the reply by Jordan Lee as helpful: I also save the posted schedule when it changes. (votes: 5)",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(owned).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(owned).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(owned).getByRole("button", { name: "Delete" }));
    expect(
      screen.queryByRole("heading", {
        name: "How do I document a denied break?",
      }),
    ).not.toBeInTheDocument();
  });

  // UX-UG-VOICE-QA-SEARCH-EMPTY-RESULTS-BLANK-SILENT-20260920.
  for (const [lang, searchLabel, message, clear] of [
    ["en", "Search campaign Q&A", "No questions match your search.", "Clear search"],
    ["es", "Buscar preguntas de la campaña", "Ninguna pregunta coincide con tu búsqueda.", "Borrar búsqueda"],
  ]) {
    it(`names an empty Q&A search and clears it from the message in ${lang}`, () => {
      render(<DemoVoiceMember lang={lang} />);
      const list = document.querySelector(".voice-demo-qa-list");
      const seeded = list.querySelectorAll("article").length;
      expect(seeded).toBeGreaterThan(0);
      const status = within(list).getByRole("status");
      expect(status).toBeEmptyDOMElement();
      expect(screen.queryByText(message)).toBeNull();

      const search = screen.getByLabelText(searchLabel);
      fireEvent.change(search, { target: { value: "zzqx no such question" } });
      expect(list.querySelectorAll("article")).toHaveLength(0);
      expect(status).toHaveTextContent(message);

      fireEvent.click(within(status).getByRole("button", { name: clear }));
      expect(search).toHaveValue("");
      expect(document.activeElement).toBe(search);
      expect(list.querySelectorAll("article")).toHaveLength(seeded);
      expect(status).toBeEmptyDOMElement();
    });
  }

  it.each([
    ["en", "Vote for", "votes", "Mark the reply by", "as helpful:", "Helpful", [
      "How do I document a denied break?",
      "Where can I find the overtime rotation?",
    ]],
    ["es", "Votar por", "votos", "Marcar como útil la respuesta de", ":", "Útil", [
      "¿Cómo documento un descanso denegado?",
      "¿Dónde encuentro la rotación de horas extra?",
    ]],
  ])(
    "names each Q&A vote button by its subject and count, never by the bare count (%s)",
    (lang, voteFor, votes, replyLead, replyJoin, helpful, titles) => {
      render(<DemoVoiceMember lang={lang} />);
      const articles = titles.map((title) =>
        screen.getByRole("heading", { name: title }).closest("article"),
      );
      const names = [];
      for (const article of articles) {
        const title = within(article).getByRole("heading").textContent;
        const vote = article.querySelector(".voice-demo-vote");
        const count = vote.textContent.trim();
        expect(vote).toHaveAccessibleName(`${voteFor} ${title} (${votes}: ${count})`);
        expect(vote).toHaveAttribute("aria-pressed", "false");
        names.push(vote.getAttribute("aria-label"));
        for (const row of article.querySelectorAll(".voice-demo-replies > div")) {
          // The name must carry the author the visible byline shows.
          const author = row.querySelector("strong").textContent;
          const body = row.querySelector("p").textContent.slice(author.length);
          const button = row.querySelector("button[aria-pressed]");
          const replyCount = button.textContent.split("·")[1].trim();
          expect(button.textContent).toBe(`${helpful} · ${replyCount}`);
          const name =
            lang === "es"
              ? `${replyLead} ${author}${replyJoin} ${body} (${votes}: ${replyCount})`
              : `${replyLead} ${author} ${replyJoin} ${body} (${votes}: ${replyCount})`;
          expect(button).toHaveAccessibleName(name);
          names.push(name);
        }
      }
      expect(names.length).toBeGreaterThan(3);
      expect(new Set(names).size).toBe(names.length);

      // Pressing keeps the name's subject; aria-pressed carries the state.
      const first = articles[0].querySelector(".voice-demo-vote");
      const before = first.textContent.trim();
      fireEvent.click(first);
      expect(first).toHaveAttribute("aria-pressed", "true");
      expect(first).toHaveAccessibleName(
        `${voteFor} ${titles[0]} (${votes}: ${Number(before) + 1})`,
      );
    },
  );

  it("announces support and un-support as different sentences and clears a no-message action", () => {
    render(<DemoVoiceMember />);
    const region = voiceLiveRegion();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.textContent).toBe("");

    const weekly = screen.getByRole("region", {
      name: "Help choose the next poll",
    });
    const article = within(weekly)
      .getByRole("heading", {
        name: "Which shift needs a steward walk-through next?",
      })
      .closest("article");
    fireEvent.click(within(article).getByRole("button", { name: /Support · 18/ }));
    expect(screen.getByText("Support added.")).toBe(region);
    expect(region).toHaveAttribute("aria-atomic", "true");

    fireEvent.click(within(article).getByRole("button", { name: /Supported · 19/ }));
    expect(screen.getByText("Support removed.")).toBe(region);
    expect(region.textContent).not.toMatch(/Support added/);

    const owned = screen
      .getByRole("heading", { name: "How do I document a denied break?" })
      .closest("article");
    // The question vote carries no notice.
    fireEvent.click(owned.querySelector("button.voice-demo-vote"));
    expect(region.textContent).toBe("");
    expect(region.querySelector(".sr-only")).toBeNull();
    expect(voiceLiveRegion()).toBe(region);
  });

  it("announces Spanish support and un-support as distinct sentences", () => {
    render(<DemoVoiceMember lang="es" />);
    const region = voiceLiveRegion();
    const weekly = screen.getByRole("region", {
      name: "Ayuda a elegir la próxima encuesta",
    });
    // Seed copy follows the active language, so name the heading from the seed
    // question as the component resolves it rather than from either sentence.
    const seed = createDemoVoiceState().weeklyQuestions.find(
      (question) => question.id === "weekly-1",
    );
    const article = within(weekly)
      .getByRole("heading", { name: voiceText(seed.body, "es") })
      .closest("article");
    fireEvent.click(within(article).getByRole("button", { name: /Apoyar · 18/ }));
    expect(screen.getByText("Apoyo añadido.")).toBe(region);
    fireEvent.click(within(article).getByRole("button", { name: /Apoyada · 19/ }));
    expect(screen.getByText("Apoyo retirado.")).toBe(region);
    expect(region.textContent).not.toMatch(/Apoyo añadido/);
  });

  it("changes the already-mounted live region when the same member notice repeats", () => {
    render(<DemoVoiceMember />);
    const region = voiceLiveRegion();
    const question = screen
      .getByRole("heading", { name: "How do I document a denied break?" })
      .closest("article");
    const accepted = within(question).getByRole("button", { name: "Accepted answer" });
    fireEvent.click(accepted);
    const first = region.textContent;
    expect(screen.getByText(/Accepted answer updated/i)).toBe(region);
    const token = region.querySelector(".sr-only");
    expect(token).toBeTruthy();
    expect(token).not.toHaveAttribute("aria-hidden");
    fireEvent.click(accepted);
    expect(screen.getByText(/Accepted answer updated/i)).toBe(region);
    expect(region.textContent).not.toBe(first);
    expect(voiceLiveRegion()).toBe(region);
  });

  it("can omit the facade weekly pool when the backed SAMPLE workflow is shown", () => {
    render(<DemoVoiceMember showWeeklyFacade={false} />);
    expect(
      screen.queryByRole("heading", { name: "Help choose the next poll" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Ask once, find the answer later" }),
    ).toBeInTheDocument();
  });

  it("exposes required survey questions in the accessibility tree and leaves optional questions unmarked", () => {
    render(<DemoVoiceMember />);
    fireEvent.click(screen.getByRole("button", { name: "Continue survey" }));

    const workload = screen.getByRole("region", { name: "Workload" });
    expect(
      within(workload).getByRole("group", {
        name: "How manageable is your workload this week? Required",
      }),
    ).toBeInTheDocument();
    expect(
      within(workload).getByRole("group", {
        name: "Is your work area safely staffed? Required",
      }),
    ).toBeInTheDocument();
    for (const value of ["1", "2", "3", "4", "5"]) {
      expect(within(workload).getByRole("radio", { name: value })).toBeRequired();
    }
    for (const name of ["Yes", "Sometimes", "No"]) {
      expect(within(workload).getByRole("radio", { name })).toBeRequired();
    }
    expect(
      within(workload).queryByRole("textbox", {
        name: "What would make staffing safer? Required",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(workload).getByRole("radio", { name: "No" }));
    const safer = within(workload).getByRole("textbox", {
      name: "What would make staffing safer? Required",
    });
    expect(safer).toBeRequired();
    expect(safer.closest("label").querySelector("[aria-hidden='true']")).toHaveTextContent("*");

    fireEvent.click(within(workload).getByRole("radio", { name: "3" }));
    fireEvent.change(safer, {
      target: { value: "Add a second person on closing shift." },
    });
    fireEvent.click(
      within(workload).getByRole("button", { name: "Save and continue" }),
    );

    const priorities = screen.getByRole("region", { name: "Priorities" });
    const priorityGroup = within(priorities).getByRole("group", {
      name: "Which issues should the chapter prioritize? Required",
    });
    expect(
      within(priorityGroup).getByRole("checkbox", { name: "Staffing" }),
    ).not.toBeRequired();
    expect(
      within(priorities).getByRole("combobox", {
        name: "Which meeting time works best?",
      }),
    ).not.toBeRequired();
    fireEvent.click(
      within(priorityGroup).getByRole("checkbox", { name: "Staffing" }),
    );
    fireEvent.click(
      within(priorities).getByRole("button", { name: "Save and continue" }),
    );

    const followUp = screen.getByRole("region", { name: "Follow-up" });
    expect(within(followUp).getByRole("radio", { name: "Yes" })).toBeRequired();
    expect(within(followUp).getByRole("radio", { name: "No" })).toBeRequired();
    const note = within(followUp).getByRole("textbox", {
      name: "Anything else the chapter should know?",
    });
    expect(note).not.toBeRequired();
    expect(note.closest("label").querySelector("[aria-hidden='true']")).toBeNull();
  });

  it("announces required survey questions in Spanish and leaves optional questions unmarked", () => {
    render(<DemoVoiceMember lang="es" />);
    fireEvent.click(screen.getByRole("button", { name: "Continuar encuesta" }));

    const workload = screen.getByRole("region", { name: "Carga de trabajo" });
    expect(
      within(workload).getByRole("group", {
        name: "¿Qué tan manejable es tu carga de trabajo esta semana? Obligatoria",
      }),
    ).toBeInTheDocument();
    expect(within(workload).getByRole("radio", { name: "3" })).toBeRequired();
    fireEvent.click(within(workload).getByRole("radio", { name: "No" }));
    const safer = within(workload).getByRole("textbox", {
      name: "¿Qué haría que la dotación de personal fuera más segura? Obligatoria",
    });
    expect(safer).toBeRequired();
    fireEvent.click(within(workload).getByRole("radio", { name: "3" }));
    fireEvent.change(safer, { target: { value: "Otra persona en el cierre." } });
    fireEvent.click(
      within(workload).getByRole("button", { name: "Guardar y continuar" }),
    );

    const priorities = screen.getByRole("region", { name: "Prioridades" });
    expect(
      within(priorities).getByRole("group", {
        name: "¿Qué asuntos debería priorizar el capítulo? Obligatoria",
      }),
    ).toBeInTheDocument();
    expect(
      within(priorities).getByRole("combobox", {
        name: "¿Qué horario de reunión te conviene más?",
      }),
    ).not.toBeRequired();
    fireEvent.click(
      within(priorities).getByRole("checkbox", { name: "Dotación de personal" }),
    );
    fireEvent.click(
      within(priorities).getByRole("button", { name: "Guardar y continuar" }),
    );

    const followUp = screen.getByRole("region", { name: "Seguimiento" });
    expect(within(followUp).getByRole("radio", { name: "Sí" })).toBeRequired();
    expect(
      within(followUp).getByRole("textbox", {
        name: "¿Hay algo más que el capítulo deba saber?",
      }),
    ).not.toBeRequired();
  });

  it("keeps SAMPLE Voice seed copy in the active language and gates owner controls on viewer authorship", () => {
    const view = render(<DemoVoiceMember lang="es" />);
    const spanishTree = view.container.textContent;

    expect(
      screen.getByRole("heading", { name: "Chequeo trimestral de miembros" }),
    ).toBeInTheDocument();
    expect(spanishTree).not.toContain("Quarterly member check-in");
    expect(spanishTree).not.toMatch(/\bYou\b/);
    expect(spanishTree).not.toContain("[object Object]");

    const weekly = screen.getByRole("region", {
      name: "Ayuda a elegir la próxima encuesta",
    });
    expect(
      within(weekly).getByRole("heading", {
        name: "¿Qué turno necesita un recorrido del delegado a continuación?",
      }),
    ).toBeInTheDocument();
    expect(within(weekly).getByText("Día · Tarde · Noche")).toBeInTheDocument();
    expect(
      within(weekly).getByRole("heading", {
        name: "¿Debería el capítulo publicar un resumen mensual de dotación?",
      }),
    ).toBeInTheDocument();
    expect(within(weekly).getByText("Sí · No · Discutir primero")).toBeInTheDocument();
    expect(
      within(weekly).getByRole("heading", {
        name: "¿Qué capacitación ayudaría más a los nuevos delegados?",
      }),
    ).toBeInTheDocument();
    expect(
      within(weekly).getByText("Recepción de casos · Investigaciones · Plazos"),
    ).toBeInTheDocument();

    const ownedEs = screen
      .getByRole("heading", { name: "¿Cómo documento un descanso denegado?" })
      .closest("article");
    expect(
      within(ownedEs).getByText(
        "Quiero llevar un registro útil sin incluir información privada de salud.",
      ),
    ).toBeInTheDocument();
    expect(
      within(ownedEs).getByText(
        /Anota la fecha, el descanso programado, quién lo denegó y cualquier testigo/,
      ),
    ).toBeInTheDocument();
    expect(
      within(ownedEs).getByText("También guardo el horario publicado cuando cambia."),
    ).toBeInTheDocument();
    expect(within(ownedEs).getByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(within(ownedEs).getByRole("button", { name: "Eliminar" })).toBeInTheDocument();
    expect(
      within(ownedEs).getByRole("button", { name: "Respuesta aceptada" }),
    ).toBeInTheDocument();
    expect(
      within(ownedEs).getByRole("button", { name: "Aceptar respuesta" }),
    ).toBeInTheDocument();

    const otherEs = screen
      .getByRole("heading", { name: "¿Dónde encuentro la rotación de horas extra?" })
      .closest("article");
    expect(
      within(otherEs).getByText("¿Hay una copia actual para el capítulo?"),
    ).toBeInTheDocument();
    expect(
      within(otherEs).getByText(
        "La copia más reciente está en el Hub del capítulo, bajo Registros laborales.",
      ),
    ).toBeInTheDocument();
    expect(within(otherEs).getByText("Tú")).toBeInTheDocument();
    expect(within(otherEs).queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
    expect(
      within(otherEs).queryByRole("button", { name: "Eliminar" }),
    ).not.toBeInTheDocument();
    expect(
      within(otherEs).queryByRole("button", { name: "Aceptar respuesta" }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Buscar preguntas de la campaña"), {
      target: { value: "rotación de horas extra" },
    });
    expect(
      screen.getByRole("heading", {
        name: "¿Dónde encuentro la rotación de horas extra?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "¿Cómo documento un descanso denegado?",
      }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Buscar preguntas de la campaña"), {
      target: { value: "" },
    });

    const ownedForEdit = screen
      .getByRole("heading", { name: "¿Cómo documento un descanso denegado?" })
      .closest("article");
    fireEvent.click(within(ownedForEdit).getByRole("button", { name: "Editar" }));
    expect(within(ownedForEdit).getByLabelText("Título de la pregunta")).toHaveValue(
      "¿Cómo documento un descanso denegado?",
    );
    expect(within(ownedForEdit).getByLabelText("Detalles")).toHaveValue(
      "Quiero llevar un registro útil sin incluir información privada de salud.",
    );
    expect(within(ownedForEdit).getByLabelText("Título de la pregunta").value).not.toBe(
      "[object Object]",
    );
    fireEvent.click(within(ownedForEdit).getByRole("button", { name: "Cancelar" }));

    view.rerender(<DemoVoiceMember lang="en" />);
    const englishTree = view.container.textContent;
    expect(
      screen.getByRole("heading", { name: "Quarterly member check-in" }),
    ).toBeInTheDocument();
    expect(englishTree).not.toContain("[object Object]");
    const weeklyEn = screen.getByRole("region", {
      name: "Help choose the next poll",
    });
    expect(
      within(weeklyEn).getByRole("heading", {
        name: "Which shift needs a steward walk-through next?",
      }),
    ).toBeInTheDocument();
    expect(within(weeklyEn).getByText("Day · Evening · Overnight")).toBeInTheDocument();
    expect(
      within(weeklyEn).getByRole("heading", {
        name: "Should the chapter publish a monthly staffing snapshot?",
      }),
    ).toBeInTheDocument();
    expect(
      within(weeklyEn).getByText("Yes · No · Discuss first"),
    ).toBeInTheDocument();
    expect(
      within(weeklyEn).getByRole("heading", {
        name: "What training would help new stewards most?",
      }),
    ).toBeInTheDocument();
    expect(
      within(weeklyEn).getByText("Intake · Investigations · Deadlines"),
    ).toBeInTheDocument();

    const ownedEn = screen
      .getByRole("heading", { name: "How do I document a denied break?" })
      .closest("article");
    expect(
      within(ownedEn).getByText(
        "I want to keep a useful record without including private health information.",
      ),
    ).toBeInTheDocument();
    expect(
      within(ownedEn).getByText(
        /Record the date, scheduled break, who denied it, and any witnesses/,
      ),
    ).toBeInTheDocument();
    expect(
      within(ownedEn).getByText("I also save the posted schedule when it changes."),
    ).toBeInTheDocument();
    expect(within(ownedEn).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(ownedEn).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(
      within(ownedEn).getByRole("button", { name: "Accepted answer" }),
    ).toBeInTheDocument();
    expect(
      within(ownedEn).getByRole("button", { name: "Accept answer" }),
    ).toBeInTheDocument();

    const otherEn = screen
      .getByRole("heading", { name: "Where can I find the overtime rotation?" })
      .closest("article");
    expect(
      within(otherEn).getByText("Is there one current copy for the chapter?"),
    ).toBeInTheDocument();
    expect(
      within(otherEn).getByText(
        "The latest copy is in Chapter hub under Workplace records.",
      ),
    ).toBeInTheDocument();
    expect(within(otherEn).getByText("You")).toBeInTheDocument();
    expect(within(otherEn).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(
      within(otherEn).queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(
      within(otherEn).queryByRole("button", { name: "Accept answer" }),
    ).not.toBeInTheDocument();
  });
});
