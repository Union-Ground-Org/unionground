import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmActionDialog } from "../src/components/ConfirmActionDialog.jsx";
import { Switch } from "../src/components/Surfaces.jsx";
import { runBusyWrite } from "../src/lib/busyWrite.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

describe("shared busy control adoption", () => {
it("keeps confirmation focus across a rendering update during a held write", async () => {
    enableFocusFixup();
    let finish;
    const write = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    function Surface() {
      const [busy, setBusy] = useState(false);
      async function save() {
        setBusy(true);
        try { await write(); } finally { setBusy(false); }
      }
      return <ConfirmActionDialog title="Apply this change?" confirmLabel="Apply change" busy={busy} onConfirm={save} onClose={vi.fn()} />;
    }
    render(<LanguageProvider lang="en"><Surface /></LanguageProvider>);
    const control = screen.getByRole("button", { name: "Apply change" });
    control.focus();
    fireEvent.click(control);
    await afterRenderingUpdate();
    expect(control).toHaveFocus();
    expect(control).toBeEnabled();
    expect(control).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(control);
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await afterRenderingUpdate();
    expect(control).toHaveFocus();
    expect(control).not.toHaveAttribute("aria-disabled", "true");
  });

it("keeps the shared switch focused and guards its own pending callback", async () => {
    enableFocusFixup();
    let finish;
    const write = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const lock = { current: new Set() };
    const save = value => runBusyWrite(lock, "preference", () => write(value));
    const { rerender } = render(<Switch label="Preference" checked={false} onChange={save} />);
    const control = screen.getByRole("switch", { name: "Preference" });
    control.focus(); fireEvent.click(control); fireEvent.click(control);
    expect(write).toHaveBeenCalledTimes(1);
    rerender(<Switch label="Preference" checked={false} pending onChange={save} />);
    await afterRenderingUpdate();
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("aria-disabled", "true");
    await act(async () => finish());
  });
});
