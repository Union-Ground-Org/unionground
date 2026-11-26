import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseNoteComposer } from "../src/components/CaseMentions.jsx";
import { catalogue } from "../src/lib/i18n.js";

const t = (key, vars = {}) => catalogue.en[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
const person = { userId: "ana", fullName: "Ana Ruiz" };

describe("case-note draft scope", () => {
  it("clears private text and mention selection when the case changes", () => {
    const onSubmit = vi.fn();
    const view = render(<CaseNoteComposer caseId="a" candidates={[person]} onSubmit={onSubmit} t={t} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Private A facts for @An" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    view.rerender(<CaseNoteComposer caseId="b" candidates={[]} onSubmit={onSubmit} t={t} />);
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("combobox").closest("form"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("retains the draft through same-case candidate retries and translator changes", async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    const view = render(<CaseNoteComposer caseId="a" candidates={[]} onSubmit={onSubmit} t={t} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Private facts for @Ana Ruiz" } });
    view.rerender(<CaseNoteComposer caseId="a" candidates={[person]} onSubmit={onSubmit} t={(...args) => t(...args)} />);
    expect(screen.getByRole("combobox")).toHaveValue("Private facts for @Ana Ruiz");
    fireEvent.submit(screen.getByRole("combobox").closest("form"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("a", "Private facts for @Ana Ruiz", ["ana"]));
  });

  it.each(["success", "failure"])("keeps a new case's draft and focus after the old save's %s", async (outcome) => {
    let resolveSave;
    let rejectSave;
    const onSubmit = vi.fn(() => new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }));
    const view = render(<CaseNoteComposer caseId="a" onSubmit={onSubmit} t={t} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Private A facts" } });
    fireEvent.submit(screen.getByRole("combobox").closest("form"));
    expect(onSubmit).toHaveBeenCalledWith("a", "Private A facts", []);
    view.rerender(<CaseNoteComposer caseId="b" onSubmit={onSubmit} t={t} />);
    const next = screen.getByRole("combobox");
    expect(next).not.toBeDisabled();
    fireEvent.change(next, { target: { value: "Separate B facts" } });
    next.focus();
    await act(async () => { if (outcome === "success") resolveSave({}); else rejectSave(new Error("old save failed")); });
    expect(next).toHaveValue("Separate B facts");
    expect(next).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
