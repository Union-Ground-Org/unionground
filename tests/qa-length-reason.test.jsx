// #9460 W5-1, W5-2: each Questions field says what it needs; a held post looks held.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemberQaForum } from "../src/features/qa/MemberQaForum.jsx";
import { QA_MIN_BODY_LENGTH as BODY, QA_MIN_TITLE_LENGTH as TITLE } from "../src/features/qa/contract.js";
import { qaText } from "../src/features/qa/copy.js";

const actor = { userId: "u", organizationId: "o", organizationStatus: "active", membershipStatus: "active",
  chapterId: "c", organizationRoles: [], chapterRoles: [], mfaSatisfied: true };
const question = { id: "q", organizationId: "o", chapterId: "c", title: "Overtime?", body: "When?", status: "open", replies: [] };
const need = (min, short) => `At least ${min} characters: ${short} more needed.`;
const set = (el, value) => fireEvent.change(el, { target: { value } });
function held(button, yes) {
  expect(button.disabled).toBe(yes);
  expect(button.style.cursor).toBe(yes ? "not-allowed" : "pointer");
  if (yes) expect(button.style.background).toBe("var(--disabled)");
}

describe("Questions fields say what they need (#9460)", () => {
  it("W5-1: names both minimums, counts down, looks held until met", () => {
    const onAsk = vi.fn(async () => true);
    render(<MemberQaForum actor={actor} onAsk={onAsk} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask a question" }));
    const title = screen.getByLabelText("Question title");
    const body = screen.getByLabelText("Details");
    const post = screen.getByRole("button", { name: "Post question" });
    // Untouched and empty: the plain rule, no count, not invalid, nothing said.
    expect(title).toHaveAccessibleDescription(`At least ${TITLE} characters.`);
    expect(screen.getByText(`At least ${BODY} characters.`)).toBeInTheDocument();
    expect(title).not.toHaveAttribute("aria-invalid");
    expect(document.getElementById("qa-title-length-met")).toHaveTextContent("");
    held(post, true);
    set(title, "Leave?"); set(body, "See title"); // the audit's live reproduction
    expect(title).toHaveAccessibleDescription(need(TITLE, TITLE - 6));
    expect(body).toHaveAttribute("aria-describedby", "qa-body-length qa-body-audience");
    expect(screen.getByText(need(BODY, BODY - 9))).toBeInTheDocument();
    expect(body).toHaveAttribute("aria-invalid", "true");
    held(post, true);
    set(title, "Leave on a holiday?"); set(body, "Is a holiday leave day paid?");
    // Reaching the minimum is said once in a polite status tied to the field.
    const met = document.getElementById("qa-title-length-met");
    expect(met).toHaveAttribute("aria-live", "polite");
    expect(met).toHaveTextContent("Long enough.");
    expect(title).toHaveAttribute("aria-describedby", "qa-title-length-met");
    set(title, "Leave on a holiday, paid?");
    expect(met).toHaveTextContent("Long enough.");
    expect(body).not.toHaveAttribute("aria-invalid");
    held(post, false);
    fireEvent.click(post);
    expect(onAsk).toHaveBeenCalledWith({ title: "Leave on a holiday, paid?", body: "Is a holiday leave day paid?" });
  });

  it("W5-1: says it in Spanish", () => {
    render(<MemberQaForum lang="es" actor={actor} onAsk={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: qaText("es", "askTitle") }));
    expect(screen.getByText(`Al menos ${BODY} caracteres.`)).toBeInTheDocument();
    set(screen.getByLabelText(qaText("es", "bodyLabel")), "Hola");
    expect(screen.getByText(`Al menos ${BODY} caracteres: faltan ${BODY - 4}.`)).toBeInTheDocument();
    set(screen.getByLabelText(qaText("es", "bodyLabel")), "Hola, ¿pagan las horas?");
    expect(document.getElementById("qa-body-length-met")).toHaveTextContent("Longitud suficiente.");
  });

  it.each([
    ["follow-up", actor, "Add a follow-up", { onFollowUp: vi.fn(async () => true) }],
    ["official reply", { ...actor, organizationRoles: ["steward"] }, "Post official reply", { onOfficialReply: vi.fn(async () => true) }],
  ])("W5-2: %s counts to QA_MIN_BODY_LENGTH, looks held until met", (_, who, label, handlers) => {
    render(<MemberQaForum actor={who} selectedQuestion={{ ...question, authoredByMe: label === "Add a follow-up" }} {...handlers} />);
    const field = screen.getByLabelText(label);
    const send = screen.getByRole("button", { name: "Post reply" });
    set(field, "Any update?");
    expect(field).toHaveAccessibleDescription(expect.stringContaining(need(BODY, BODY - 11)));
    expect(field).toHaveAttribute("aria-invalid", "true");
    held(send, true);
    set(field, "Any update yet?");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(field).toHaveAccessibleDescription(expect.stringContaining("Long enough."));
    held(send, false);
  });
});
