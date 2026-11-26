// #9460 slice 2: member forms name the rule that holds their button, beside the control.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { OfficerQaQueue } from "../src/features/qa/OfficerQaQueue.jsx";
import { VoiceView } from "../src/views/VoiceView.jsx";

const set = (el, value) => fireEvent.change(el, { target: { value } });
const wrap = (lang, node) => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);

describe("member forms say what holds the button (#9460)", () => {
  it("W5-2 officer queue: plain rule when empty, a count once typed, held look, and one polite 'Long enough.'", () => {
    const actor = { userId: "s", organizationId: "o", organizationStatus: "active", membershipStatus: "active",
      chapterId: "c", organizationRoles: ["steward"], chapterRoles: [], mfaSatisfied: true };
    const question = { id: "q", organizationId: "o", chapterId: "c", title: "Overtime?", body: "When?", status: "open" };
    const onReply = vi.fn(async () => true);
    render(<OfficerQaQueue actor={actor} questions={[question]} onReply={onReply} />);
    const field = screen.getByLabelText("Post official reply");
    const send = screen.getByRole("button", { name: "Post reply" });
    expect(field).toHaveAccessibleDescription("At least 12 characters.");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(send).toBeDisabled();
    expect(send.style.cursor).toBe("not-allowed");
    set(field, "Approved.");
    expect(field).toHaveAccessibleDescription("At least 12 characters: 3 more needed.");
    expect(field).toHaveAttribute("aria-invalid", "true");
    set(field, "Yes, file it");
    expect(document.getElementById("qa-officer-q-length-met")).toHaveTextContent("Long enough.");
    expect(send.style.cursor).toBe("pointer");
    fireEvent.click(send);
    expect(onReply).toHaveBeenCalledWith({ questionId: "q", body: "Yes, file it" });
  });

  it("W5-2 officer queue: each row has its own polite, atomic region, and only the typed row changes", () => {
    const actor = { userId: "s", organizationId: "o", organizationStatus: "active", membershipStatus: "active",
      chapterId: "c", organizationRoles: ["steward"], chapterRoles: [], mfaSatisfied: true };
    const row = (id) => ({ id, organizationId: "o", chapterId: "c", title: `Question ${id}`, body: "When?", status: "open" });
    render(<OfficerQaQueue actor={actor} questions={[row("a"), row("b")]} onReply={vi.fn()} />);
    const regions = ["a", "b"].map((id) => document.getElementById(`qa-officer-${id}-length-met`));
    for (const region of regions) {
      expect(region).toHaveAttribute("aria-live", "polite");
      expect(region).toHaveAttribute("aria-atomic", "true");
      expect(region).not.toHaveAttribute("role");
      expect(region).toHaveTextContent("");
    }
    set(document.getElementById("qa-officer-a"), "Yes, file it");
    expect(regions[0]).toHaveTextContent("Long enough.");
    expect(regions[1]).toHaveTextContent("");
    expect(document.getElementById("qa-officer-b")).toHaveAccessibleDescription("At least 12 characters.");
  });

  it.each(["en", "es"])("W4-2 weekly question legend says at least two options (%s)", (lang) => {
    wrap(lang, <VoiceView weeklyQuestions={[]} onSubmitWeeklyQuestion={vi.fn()} />);
    expect(screen.getByText(lang === "en" ? "Answer options (at least 2)" : "Opciones de respuesta (al menos 2)").tagName).toBe("LEGEND");
  });

  it.each([
    ["en", "Your weekly question", "Option", "Submit question", "Write a question with at least 10 characters.", "Fill in at least 2 answer options."],
    ["es", "Tu pregunta semanal", "Opción", "Enviar pregunta", "Escribe una pregunta de al menos 10 caracteres.", "Completa al menos 2 opciones de respuesta."],
  ])("W4-2 explains and announces each weekly question submission rule (%s)", async (lang, label, option, submit, lengthRule, optionsRule) => {
    const onSubmitWeeklyQuestion = vi.fn().mockResolvedValue(true);
    wrap(lang, <VoiceView weeklyQuestions={[]} onSubmitWeeklyQuestion={onSubmitWeeklyQuestion} />);
    const question = screen.getByRole("textbox", { name: label });
    const firstOption = screen.getByRole("textbox", { name: `${option} 1` });
    const secondOption = screen.getByRole("textbox", { name: `${option} 2` });
    const button = screen.getByRole("button", { name: submit });

    set(question, "  Short? ");
    set(firstOption, "  Yes  ");
    set(secondOption, "   ");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(`${lengthRule} ${optionsRule}`);
    expect(button.nextElementSibling).toHaveTextContent(`${lengthRule} ${optionsRule}`);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent(`${lengthRule} ${optionsRule}`);
    expect(onSubmitWeeklyQuestion).not.toHaveBeenCalled();

    set(secondOption, "  No ");
    expect(button).toHaveAccessibleDescription(lengthRule);
    set(secondOption, "");
    set(question, "  Paid time?  ");
    expect(button).toHaveAccessibleDescription(optionsRule);
    fireEvent.click(button);
    expect(screen.getByRole("alert")).toHaveTextContent(optionsRule);
    expect(onSubmitWeeklyQuestion).not.toHaveBeenCalled();

    set(secondOption, "  No ");
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAccessibleDescription();
    fireEvent.click(button);
    expect(onSubmitWeeklyQuestion).toHaveBeenCalledExactlyOnceWith("Paid time?", ["Yes", "No"]);
    await waitFor(() => expect(question).toHaveValue(""));
  });

  it.each([1, 2])("W4-2 allows two filled options when option %s is blank", async (blankOption) => {
    const onSubmitWeeklyQuestion = vi.fn().mockResolvedValue(true);
    wrap("en", <VoiceView weeklyQuestions={[]} onSubmitWeeklyQuestion={onSubmitWeeklyQuestion} />);
    const question = screen.getByRole("textbox", { name: "Your weekly question" });
    set(question, "Paid time?");
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    const options = screen.getAllByRole("textbox", { name: /^Option / });
    set(options[2 - blankOption], "Yes");
    set(options[2], "No");
    const button = screen.getByRole("button", { name: "Submit question" });
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button.form.checkValidity()).toBe(true);
    fireEvent.click(button);
    expect(onSubmitWeeklyQuestion).toHaveBeenCalledExactlyOnceWith("Paid time?", ["Yes", "No"]);
    await waitFor(() => expect(question).toHaveValue(""));
  });

});
