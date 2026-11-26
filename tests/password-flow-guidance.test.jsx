import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PasswordChangeForm } from "../src/views/SettingsView.jsx";
import { ChoosePasswordCard } from "../src/features/memberHome/ChoosePasswordCard.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

const t = key => catalogue.en[key];
function fill(container) {
  for (const [name, value] of [["currentPassword", "old123"], ["password", "a new private passphrase 12345"], ["confirm", "a new private passphrase 12345"]]) {
    fireEvent.change(container.querySelector(`input[name="${name}"]`), { target: { value } });
  }
}

describe("password guidance before the first attempt", () => {
  it.each([["en", "Use at least 24 characters."], ["es", "Usa al menos 24 caracteres."]])("states the minimum on the untouched Home reminder (%s)", (lang, rule) => {
    render(<LanguageProvider lang={lang}><ChoosePasswordCard userId="guidance-member" issuedAt="issued" /></LanguageProvider>);
    expect(screen.getByText(rule)).toBeVisible();
  });

  it("associates both new-password fields with visible minimum guidance", () => {
    const { container } = render(<PasswordChangeForm client={{ auth: { updateUser: vi.fn() } }} t={t} />);
    for (const field of container.querySelectorAll('[autocomplete="new-password"]')) {
      const hint = document.getElementById(field.getAttribute("aria-describedby"));
      expect(hint).toBeVisible();
      expect(hint).toHaveTextContent("Use at least 24 characters.");
    }
  });
});

describe("one password-change outcome", () => {
  it("admits only one request when submits arrive in the same render", async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const updateUser = vi.fn(value => value.password ? pending : Promise.resolve({ error: null }));
    const { container } = render(<PasswordChangeForm client={{ auth: { updateUser } }} t={t} />);
    fill(container);
    act(() => {
      const form = container.querySelector("form");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const requests = updateUser.mock.calls.filter(([value]) => value.password).length;
    await act(async () => { finish({ error: null }); });
    expect(requests).toBe(1);
  });

  it("replaces an error with one durable success and requires dismissal before another attempt", async () => {
    const updateUser = vi.fn().mockResolvedValueOnce({ error: { code: "current_password_invalid" } }).mockResolvedValue({ error: null });
    const client = { auth: { updateUser } };
    const view = render(<PasswordChangeForm client={client} t={t} />);
    fill(view.container);
    fireEvent.submit(view.container.querySelector("form"));
    await screen.findByRole("alert");
    fill(view.container);
    fireEvent.submit(view.container.querySelector("form"));
    expect(await screen.findByRole("status")).toHaveTextContent("Your password was changed.");
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(<PasswordChangeForm client={client} t={t} />);
    expect(screen.getByRole("status")).toHaveTextContent("Your password was changed.");
    expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Change password" })).toBeEnabled();
  });
});
