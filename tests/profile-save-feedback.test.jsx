import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
// A11Y-UG-MODAL-SAVE-FAILURES-ANNOUNCED-20261013: a refused member-card
// save raises its shell notice outside the open dialog, where modal isolation
// hides it, so the card announces the refusal itself and keeps the edits.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileDialog } from "../src/components/Dialogs.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberApiError } from "../src/lib/memberApi.js";
import { catalogue } from "../src/lib/i18n.js";

afterEach(cleanup);

const member = { firstName: "Renata", fullName: "Renata Silva", initials: "RS", roleLine: "Member", sinceYear: 2019 };

describe.each(["en", "es"])("member card save refusal (%s)", (lang) => {
  const tr = (key) => catalogue[lang][key];

  it("profile save refusal announces inside the member card and preserves edits", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn()
      .mockRejectedValueOnce(new MemberApiError("Update profile", { message: "new row violates row-level security policy for table member_profiles" }))
      .mockRejectedValueOnce(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }))
      .mockResolvedValueOnce(undefined);
    render(
      <LanguageProvider lang={lang}>
        <p role="status" data-testid="shell-notice">{tr("toast.saveFailed")}</p>
        <ProfileDialog member={member} onClose={onClose} onSave={onSave} />
      </LanguageProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: tr("header.profile") });
    fireEvent.change(within(dialog).getByLabelText(tr("dialogs.roleLine")), { target: { value: "Steward" } });
    const save = within(dialog).getByRole("button", { name: tr("dialogs.saveProfile") });

    fireEvent.click(save);
    const first = await within(dialog).findByRole("alert");
    expect(first).toHaveTextContent(tr("toast.saveFailed"));
    expect(first).not.toHaveTextContent(/row-level security/);
    expect(first.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(screen.getByTestId("shell-notice").closest("[inert], [aria-hidden='true']")).not.toBeNull();
    expect(within(dialog).getByLabelText(tr("dialogs.roleLine"))).toHaveValue("Steward");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    const second = await within(dialog).findByRole("alert");
    expect(second).not.toBe(first);
    expect(second).toHaveTextContent(tr("error.serviceBusy"));

    fireEvent.click(save);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ roleLine: "Steward" }));
  });
});

describe("member card save refusal and language switch", () => {
  it("drops an already-translated refusal when the member switches language", async () => {
    const onSave = vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { code: "57014" }));
    const onLanguage = vi.fn().mockResolvedValue(undefined);
    render(
      <LanguageProvider lang="en">
        <ProfileDialog member={member} onClose={vi.fn()} onSave={onSave} onLanguage={onLanguage} />
      </LanguageProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Profile" });
    fireEvent.click(within(dialog).getByRole("button", { name: catalogue.en["dialogs.saveProfile"] }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(catalogue.en["error.serviceBusy"]);
    fireEvent.click(within(dialog).getByRole("switch", { name: catalogue.en["morehub.spanish"] }));
    await waitFor(() => expect(onLanguage).toHaveBeenCalledWith("es"));
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });
});

// REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030: Sign out on the
// member card waits on the server before the page changes. The first click
// looked like it did nothing (no change on the button, and a refusal only in
// the shell notice behind modal isolation), so people clicked twice.
describe.each(["en", "es"])("member card sign out (%s)", (lang) => {
  const tr = (key) => catalogue[lang][key];

  it("shows the sign-out underway on the first click and ignores a repeat", async () => {
    let finish;
    const onSignOut = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(
      <LanguageProvider lang={lang}><ProfileDialog member={member} onClose={vi.fn()} onSave={vi.fn()} onSignOut={onSignOut} /></LanguageProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: tr("header.profile") });
    fireEvent.click(within(dialog).getByRole("button", { name: tr("dialogs.signOut") }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    // App owns the running sign-out and passes it back as `signingOut`.
    rerender(
      <LanguageProvider lang={lang}><ProfileDialog member={member} onClose={vi.fn()} onSave={vi.fn()} onSignOut={onSignOut} signingOut /></LanguageProvider>,
    );
    const pending = within(dialog).getByRole("button", { name: tr("app.signingOut") });
    expect((pending).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(pending);
    expect(pending).toHaveAttribute("aria-busy", "true");
    fireEvent.click(pending);
    expect(onSignOut).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
  });

  it("announces a refused sign-out inside the member card", async () => {
    const onSignOut = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("push"), { noticeKey: "toast.signOutPushPaused" }))
      .mockRejectedValueOnce(new Error("no key"));
    render(
      <LanguageProvider lang={lang}><ProfileDialog member={member} onClose={vi.fn()} onSave={vi.fn()} onSignOut={onSignOut} /></LanguageProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: tr("header.profile") });
    const signOut = within(dialog).getByRole("button", { name: tr("dialogs.signOut") });
    fireEvent.click(signOut);
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(tr("toast.signOutPushPaused"));
    expect(alert.closest("[inert], [aria-hidden='true']")).toBeNull();
    fireEvent.click(signOut);
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(tr("toast.signOutCleanupFailed")));
  });
});

describe("member card cosmetic badge", () => {
  it("shows the chosen badge only when one is selected", () => {
    const { rerender } = render(
      <LanguageProvider lang="en"><ProfileDialog member={member} cosmeticBadge="Founding member" onClose={vi.fn()} onSave={vi.fn()} /></LanguageProvider>,
    );
    expect(screen.getByText("✦ Founding member")).toHaveClass("reward-chip--tier");
    rerender(<LanguageProvider lang="en"><ProfileDialog member={member} onClose={vi.fn()} onSave={vi.fn()} /></LanguageProvider>);
    expect(screen.queryByText(/✦/)).toBeNull();
  });
});
