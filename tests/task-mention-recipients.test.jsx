import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { TaskModal } from "../src/views/TaskModal.jsx";

function Harness(props) {
  const { lang, t } = useLang();
  return <TaskModal {...props} lang={lang} t={t} />;
}

const recipients = [
  { id: "22222222-2222-4222-8222-222222222222", fullName: "Jordan O’Neill-Santos", initials: "JO" },
  { id: "22222222-2222-4222-8222-222222222223", fullName: "Jordan Rivera", initials: "JR" },
];

describe("task comment recipient identity", () => {
  it.each(["en", "es"].flatMap(lang => [0, 1].flatMap(chosen => [false, true].map(sameName => ({ lang, chosen, sameName })))))("identifies and notifies recipient $chosen, duplicate full name $sameName, in $lang", async ({ lang, chosen, sameName }) => {
      const people = recipients.map(person => ({ ...person, fullName: sameName ? "Jordan O’Neill-Santos" : person.fullName }));
      const task = fallbackData.tasks.find(item => item.id === "task-demo-1");
      const onAddComment = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ id: "comment-new" });
      render(<LanguageProvider lang={lang}><Harness task={task} chapterId={fallbackData.member.chapterId}
        memberId={fallbackData.member.id} assignees={[...people, { id: fallbackData.member.id, fullName: "Current Person" }]}
        onClose={vi.fn()} onUpdate={vi.fn()} onAddComment={onAddComment} /></LanguageProvider>);
      fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["kanban.comments"] }));
      const choices = people.map(person => screen.getByRole("button", { name: `@${person.fullName}${sameName ? ` (${person.id})` : ""}` }));
      expect(screen.queryByRole("button", { name: "@Current Person" })).toBeNull();
      for (let index = 0; index < choices.length; index++) {
        expect(choices[index]).toHaveTextContent(people[index].fullName);
        expect(choices[index]).toHaveAttribute("aria-pressed", "false");
      }
      const draft = screen.getByPlaceholderText(catalogue[lang]["tasks.commentPlaceholder"]);
      fireEvent.change(draft, { target: { value: "  Tamarack follow-up for the chosen person.  " } });
      fireEvent.click(choices[1 - chosen]);
      fireEvent.click(choices[1 - chosen]);
      fireEvent.click(choices[chosen]);
      expect(choices[chosen]).toHaveAttribute("aria-pressed", "true");
      expect(choices[1 - chosen]).toHaveAttribute("aria-pressed", "false");
      expect(draft).toHaveValue("  Tamarack follow-up for the chosen person.  ");
      const submit = screen.getByRole("button", { name: catalogue[lang]["tasks.addComment"] });
      fireEvent.click(submit);
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
      expect(onAddComment).toHaveBeenLastCalledWith(task.id, "Tamarack follow-up for the chosen person.", [people[chosen].id]);
      expect(draft).toHaveValue("  Tamarack follow-up for the chosen person.  ");
      expect(choices[chosen]).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(submit);
      await waitFor(() => expect(draft).toHaveValue(""));
      expect(onAddComment).toHaveBeenCalledTimes(2);
      expect(onAddComment).toHaveBeenLastCalledWith(task.id, "Tamarack follow-up for the chosen person.", [people[chosen].id]);
      expect(choices[chosen]).toHaveAttribute("aria-pressed", "false");
    });
});
