import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, NotificationsDialog } from "../src/components/Dialogs.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Open campaign</button>
      {open && (
        <Dialog title="Create campaign" onClose={() => setOpen(false)}>
          <button type="button">First action</button>
          <input aria-label="Campaign name" />
          <button type="button">Last action</button>
        </Dialog>
      )}
    </div>
  );
}

function BusyHarness({ busy }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Open writer</button>
      {open && (
        <Dialog title="Record milestone" onClose={() => setOpen(false)} busy={busy}>
          <label>
            Campaign name
            <input aria-label="Campaign name" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <button type="button">Save</button>
        </Dialog>
      )}
    </div>
  );
}

describe("shared modal focus boundary", () => {
  it("focuses the dialog, traps Tab, hides the background, and restores the opener", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open campaign" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Create campaign" });
    expect(dialog).toHaveFocus();
    expect(opener).toHaveAttribute("inert");
    expect(opener).toHaveAttribute("aria-hidden", "true");
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();

    const last = within(dialog).getByRole("button", { name: "Last action" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();

    const first = within(dialog).getByRole("button", { name: "Close" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).not.toHaveAttribute("inert");
    expect(opener).not.toHaveAttribute("aria-hidden");
    expect(opener).toHaveFocus();
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps focus stable across callback rerenders and blocks every close path while busy", async () => {
    const view = render(<BusyHarness busy />);
    const opener = screen.getByRole("button", { name: "Open writer" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Record milestone" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    const input = within(dialog).getByLabelText("Campaign name");
    input.focus();
    fireEvent.change(input, { target: { value: "Harbor" } });
    expect(input).toHaveFocus();

    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toBeEnabled();
    expect(close).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(close);
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toBeInTheDocument();
    fireEvent.mouseDown(dialog.closest(".dialog-backdrop"));
    expect(dialog).toBeInTheDocument();

    view.rerender(<BusyHarness busy={false} />);
    const readyDialog = screen.getByRole("dialog", { name: "Record milestone" });
    fireEvent.keyDown(readyDialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});

// Unread was carried by a green tint and nothing else (WCAG 1.4.1). A screen
// reader announced the two states identically, and so did any monochrome or
// forced-colours rendering.
describe("notification unread marking", () => {
  const notifications = [
    { id: "n1", title: "Deadline in three days", body: "Step 2 response is due.", created_at: "2026-07-20T12:00:00Z", read_at: null },
    { id: "n2", title: "Case updated", body: "Your steward added a note.", created_at: "2026-07-19T12:00:00Z", read_at: "2026-07-19T13:00:00Z" },
  ];

  function renderList(lang) {
    render(
      <LanguageProvider lang={lang}>
        <NotificationsDialog notifications={notifications} onClose={vi.fn()} onReadAll={vi.fn()} />
      </LanguageProvider>,
    );
  }

  it("names the unread state in text, in both locales", () => {
    renderList("en");
    expect(within(screen.getByText("Deadline in three days").closest("article")).getByText("Unread")).toBeVisible();
    expect(within(screen.getByText("Case updated").closest("article")).queryByText("Unread")).not.toBeInTheDocument();
  });

  it("also marks it without colour for a sighted reader", () => {
    renderList("es");
    const unread = within(screen.getByText("Deadline in three days").closest("article"));
    expect(unread.getByText("Sin leer")).toBeVisible();
    expect(within(screen.getByText("Case updated").closest("article")).queryByText("Sin leer")).not.toBeInTheDocument();
  });
});
