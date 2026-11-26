import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskFieldNotesView } from "../src/views/TaskFieldNotesView.jsx";
import { t as translate } from "../src/lib/i18n.js";

const people = [
  { id: "tamarack-east", fullName: "Alex Rivera" },
  { id: "tamarack-west", fullName: "Alex Rivera" },
  { id: "tamarack-north", fullName: "Alex Chen" },
];
const label = (person) => `@${person.fullName}${person.fullName === "Alex Rivera" ? ` (${person.id})` : ""}`;
afterEach(cleanup);
describe.each(["en", "es"])("field-note mention identities in %s", (lang) => {
  it.each(people)("keeps the full chosen name and sends exactly $id", async (person) => {
    const onAddComment = vi.fn().mockResolvedValue({ id: "note" });
    const t = (key, vars) => translate(lang, key, vars);
    render(<TaskFieldNotesView tasks={[{ id: "tamarack-task", taskNumber: 1, title: "Tamarack agenda", status: "to_do" }]} comments={[]} assignees={[...people, people[0]]} memberId="author" chapterId="tamarack" lang={lang} t={t} onOpen={vi.fn()} onCreate={vi.fn()} onAddComment={onAddComment} />);
    for (const candidate of people) expect(screen.getByRole("button", { name: label(candidate) })).toHaveTextContent(label(candidate));
    const chip = screen.getByRole("button", { name: label(person) });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveTextContent(label(person));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Tamarack agenda update" } });
    fireEvent.click(screen.getByRole("button", { name: t("tasks.addFieldNote") }));
    await waitFor(() => expect(onAddComment).toHaveBeenCalledWith("tamarack-task", "Tamarack agenda update", [person.id]));
    await waitFor(() => expect(chip).toHaveAttribute("aria-pressed", "false"));
    expect(chip).toHaveTextContent(label(person));
  });
});
