import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProfileDialog } from "../src/components/Dialogs.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 114: the
// Profile button's dialog ended with Sign out under the member-card form,
// partly off a phone screen. Settings and Sign out are now a plain account
// menu at the top, in the Settings list's row style.

const member = { firstName: "Rae", fullName: "Rae Harbor", initials: "RH", roleLine: "Library assistant", sinceYear: 2019 };

function renderDialog(props = {}, lang = "en") {
  return render(<LanguageProvider lang={lang}><ProfileDialog member={member} onClose={vi.fn()} onSave={vi.fn()} {...props} /></LanguageProvider>);
}

describe("Profile dialog account menu (#6578 finding 114)", () => {
  it.each(["en", "es"])("puts Settings and Sign out in a menu above the member-card form (%s)", (lang) => {
    const onSignOut = vi.fn().mockResolvedValue(undefined);
    const onSettings = vi.fn();
    renderDialog({ onSignOut, onSettings }, lang);
    const dialog = screen.getByRole("dialog");
    const menu = within(dialog).getByRole("region", { name: catalogue[lang]["morehub.account"] });
    const signOut = within(menu).getByRole("button", { name: catalogue[lang]["dialogs.signOut"] });
    const settings = within(menu).getByRole("button", { name: catalogue[lang]["dialogs.settingsLink"] });
    expect(signOut).toHaveClass("morehub-row");
    expect(settings).toHaveClass("morehub-row");
    const form = dialog.querySelector("form");
    // The menu comes before the form in reading order, not after it.
    expect(menu.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form.querySelector("button[type=button]")).toBeNull();
    expect(dialog.querySelectorAll(".dialog-secondary-row")).toHaveLength(0);
    fireEvent.click(settings);
    expect(onSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(signOut);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("says the sign-out is underway on the menu row", async () => {
    const onSignOut = vi.fn();
    renderDialog({ onSignOut, signingOut: true });
    const row = screen.getByRole("button", { name: catalogue.en["app.signingOut"] });
    expect((row).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(row);
    expect(row).toHaveAttribute("aria-busy", "true");
    fireEvent.click(row);
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("shows no account menu without Settings or Sign out handlers (demo)", () => {
    renderDialog();
    expect(screen.queryByRole("region", { name: catalogue.en["morehub.account"] })).toBeNull();
    expect(screen.queryByRole("button", { name: catalogue.en["dialogs.signOut"] })).toBeNull();
  });
});
