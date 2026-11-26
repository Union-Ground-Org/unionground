import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PasswordChangeForm } from "../src/views/SettingsView.jsx";
import { catalogue } from "../src/lib/i18n.js";

const password = "a new private passphrase 12345";
function setup(error = null) {
  const updateUser = vi.fn().mockResolvedValue({ error });
  const { container } = render(<PasswordChangeForm client={{ auth: { updateUser } }} t={key => catalogue.en[key]} />);
  for (const name of ["password", "confirm"]) {
    fireEvent.change(container.querySelector(`input[name="${name}"]`), { target: { value: password } });
  }
  return { updateUser, form: container.querySelector("form") };
}

describe("Settings current-password proof", () => {
  it("rejects a missing current password even when form validation is bypassed", () => {
    const { updateUser, form } = setup();
    const current = screen.getByLabelText("Current password");
    expect(current).toHaveAttribute("autocomplete", "current-password");
    expect(current).toBeRequired();
    expect(current).not.toHaveAttribute("minlength"); // Old passwords may predate today's rule.
    fireEvent.submit(form);
    expect(updateUser).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your current password");
  });

  it("passes the exact current password to Auth without creating a replacement session", async () => {
    const { updateUser, form } = setup();
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: " old123 " } });
    fireEvent.submit(form);
    await screen.findByRole("status");
    expect(updateUser).toHaveBeenNthCalledWith(1, { current_password: " old123 ", password });
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it.each(["current_password_required", "current_password_invalid", "current_password_mismatch"])("keeps the prompt and reports %s", async code => {
    const { updateUser, form } = setup({ code });
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "incorrect" } });
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your current password");
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it.each([
    ["reauthentication_needed", "auth.passwordChangeReauth"],
    ["reauthentication_not_valid", "auth.passwordChangeReauth"],
    ["unexpected_failure", "auth.passwordChangeFailed"],
  ])("retains the provider's separate %s remedy", async (code, key) => {
    const { form } = setup({ code });
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old123" } });
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en[key]);
  });
});
