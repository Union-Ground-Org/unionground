import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PresidentInvitations } from "../src/components/PresidentInvitations.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

async function start() {
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const api = {
    load: vi.fn().mockResolvedValue({ chapters: [{ id: "a", name: "Chapter A" }, { id: "b", name: "Chapter B" }], items: [] }),
    inviteMember: vi.fn().mockReturnValue(pending),
  };
  render(<LanguageProvider lang="en"><PresidentInvitations api={api} /></LanguageProvider>);
  const name = await screen.findByLabelText("Full name");
  const email = screen.getByLabelText("Email address");
  fireEvent.change(name, { target: { value: "First invitee" } });
  fireEvent.change(email, { target: { value: "first@example.test" } });
  fireEvent.submit(name.closest("form"));
  expect(api.inviteMember).toHaveBeenCalledWith(expect.objectContaining({ fullName: "First invitee", email: "first@example.test", chapterId: "a", locale: "en" }));
  return { name, email, resolve, reject };
}

it.each([
  ["Full name", "Next invitee"], ["Email address", "next@example.test"],
  ["Campaign", "b"], ["Invitation language", "es"],
])("preserves the next draft after an in-flight %s edit", async (label, value) => {
  const form = await start();
  const field = screen.getByLabelText(label);
  expect(field).not.toBeDisabled();
  fireEvent.change(field, { target: { value } });
  await act(async () => form.resolve({ accepted: true }));
  expect(field).toHaveValue(value);
  expect(form.name).toHaveValue(label === "Full name" ? value : "First invitee");
  expect(form.email).toHaveValue(label === "Email address" ? value : "first@example.test");
});

it("clears an unchanged successful invitation draft", async () => {
  const form = await start();
  await act(async () => form.resolve({ accepted: true }));
  expect(form.name).toHaveValue("");
  expect(form.email).toHaveValue("");
});

it("preserves entered values when an invitation fails", async () => {
  const form = await start();
  fireEvent.change(form.name, { target: { value: "Next invitee" } });
  await act(async () => form.reject(new Error("invitation refused")));
  expect(form.name).toHaveValue("Next invitee");
  expect(form.email).toHaveValue("first@example.test");
  expect(screen.getByRole("alert")).toBeInTheDocument();
});
