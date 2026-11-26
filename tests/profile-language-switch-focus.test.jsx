import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProfileDialog } from "../src/components/Dialogs.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

// The profile dialog's language switch keeps focus while the language saves.
// A disabled element loses focus at the next rendering update (the HTML focus
// fixup rule, which jsdom 31 runs on a timer), which sent keyboard and
// screen-reader users to the top of the page and made
// tests/staff-route-refusal-lifecycle.test.jsx fail on a slow runner.

const member = { firstName: "Rae", fullName: "Rae Harbor", initials: "RH", roleLine: "Library assistant", sinceYear: 2019 };

describe("profile language switch", () => {
  it("keeps focus while the language saves, and takes one change at a time", async () => {
    enableFocusFixup();
    let finish;
    const onLanguage = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    render(<LanguageProvider lang="en"><ProfileDialog member={member} onClose={vi.fn()} onSave={vi.fn()} onLanguage={onLanguage} /></LanguageProvider>);
    const languageSwitch = screen.getByRole("switch", { name: "Español" });
    languageSwitch.focus();
    fireEvent.click(languageSwitch);
    await afterRenderingUpdate();

    expect(onLanguage).toHaveBeenCalledWith("es");
    expect(languageSwitch).toHaveAttribute("aria-disabled", "true");
    expect(languageSwitch).toHaveFocus();
    fireEvent.click(languageSwitch);
    expect(onLanguage).toHaveBeenCalledTimes(1);

    finish();
    await afterRenderingUpdate();
    expect(languageSwitch).not.toHaveAttribute("aria-disabled");
    expect(languageSwitch).toHaveFocus();
  });
});
