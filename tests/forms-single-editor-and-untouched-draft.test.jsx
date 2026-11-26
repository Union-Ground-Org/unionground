import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// UX-UG-FORMS-SILENT-200-CHARACTER-CUT-AND-DOUBLE-EDITOR-20261111.
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const editors = () => screen.queryAllByRole("button", { name: /Close form/ }).length;

describe("only one form editor is on screen at a time", () => {
  it("removes a closed draft's editor before the next form opens, with draft sharing on", async () => {
    const draftSharingApi = { sharing: vi.fn().mockResolvedValue([]), share: vi.fn() };
    const errors = vi.spyOn(console, "error");
    render(
      <LanguageProvider lang="en">
        <FormsView
          data={{ member: { id: "m1" }, forms: [{ id: "grv-1", templateKey: "grievance", status: "draft", step: 0, answers: {}, cosigners: [] }] }}
          draftSharingApi={draftSharingApi}
          onSaveDraft={vi.fn().mockResolvedValue("grv-1")}
          onSubmit={vi.fn()}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await flush();
    expect(editors()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await flush();
    expect(editors()).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /^Start$/ }));
    await flush();
    expect(editors()).toBe(1);
    // The editor and the sharing panel no longer share a React key.
    expect(errors.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    errors.mockRestore();
  });
});

describe("an untouched form is not saved", () => {
  it("stepping through a blank form saves no empty draft; the first answer does", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue("fixture-draft");
    render(
      <LanguageProvider lang="en">
        <FormsView
          data={{ member: { id: "m1" }, forms: [] }}
          focus={{ templateKey: "alt_work" }}
          onSaveDraft={onSaveDraft}
          onSubmit={vi.fn()}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(onSaveDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await flush();
    fireEvent.change(screen.getByRole("textbox", { name: "Current schedule" }), { target: { value: "Fixture schedule" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(onSaveDraft).toHaveBeenCalled();
    expect(onSaveDraft.mock.calls.at(-1)[0]).toMatchObject({ templateKey: "alt_work", answers: { schedule: "Fixture schedule" } });
  });
});
