// #9458 web slice 1.
import axe from "axe-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BusyButton } from "../src/components/BusyControls.jsx";
import { Button } from "../src/components/Button.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { NEW_PASSWORD_MAX, NEW_PASSWORD_MIN as MIN } from "../src/lib/passwordPolicy.js";
import { RECOVERY_CODE_MAX, RECOVERY_CODE_MIN } from "../src/lib/authenticatorCode.js";
import { PasswordResetView } from "../src/views/PasswordResetView.jsx";
import { OpenSignupConfirmView } from "../src/views/OpenSignupConfirmView.jsx";

const PASSWORD = "p".repeat(30);
const reply = body => ({ status: 200, ok: true, json: vi.fn().mockResolvedValue(body) });
const described = node => (node.getAttribute("aria-describedby") || "").split(" ").filter(Boolean)
  .map(id => document.getElementById(id)?.textContent || "").join(" ");
const type = (name, value) => fireEvent.change(document.querySelector(`[name="${name}"]`), { target: { value } });
const finishCalls = fetcher => fetcher.mock.calls.filter(([, init]) => init?.body?.includes('"finish"'));
const noAxe = async node => expect((await axe.run(node, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);

describe("the shared web button (W3a-1)", () => {
  it("keeps a blocked button reachable, described and announced", () => {
    const [onClick, onBlockedPress, onSubmit] = [vi.fn(), vi.fn(), vi.fn()];
    render(<form onSubmit={onSubmit}><BusyButton type="submit" disabled disabledReason="Enter your name first." onBlockedPress={onBlockedPress} onClick={onClick} aria-describedby="rule">Save</BusyButton></form>);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save.getAttribute("aria-describedby").split(" ")[1]).toBe("rule");
    expect(described(save)).toContain("Enter your name first.");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(save);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your name first.");
    const first = screen.getByRole("alert");
    fireEvent.keyDown(save, { key: "Enter" });
    expect(screen.getByRole("alert")).not.toBe(first);
    fireEvent.keyDown(save, { key: " " });
    expect(onBlockedPress).toHaveBeenCalledTimes(3);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("stays silent when typing alone brings a pressed reason back", () => {
    const view = blocked => <BusyButton disabled={blocked} disabledReason="Enter the code.">Save</BusyButton>;
    const { rerender } = render(view(true));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the code.");
    rerender(view(false));
    rerender(view(true));
    expect(screen.getByText("Enter the code.")).not.toHaveAttribute("role");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the code.");
  });

  it("reads as busy, not blocked, while work is in flight", () => {
    render(<BusyButton pending disabled disabledReason="Enter your name first.">Saving</BusyButton>);
    expect(screen.getByRole("button", { name: "Saving" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Enter your name first.")).toBeNull();
  });

  it("is unchanged without a reason", () => {
    const onBlockedPress = vi.fn();
    const { container } = render(<div><BusyButton disabled onBlockedPress={onBlockedPress} aria-describedby="rule">Save</BusyButton></div>);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("aria-describedby", "rule");
    expect(container.firstChild.childNodes).toHaveLength(1);
    fireEvent.click(save);
    expect(onBlockedPress).not.toHaveBeenCalled();
  });

  it("Button passes it on, never to a link", () => {
    const onClick = vi.fn();
    render(<LanguageProvider lang="en">
      <Button disabled disabledReason="Pick a date first." onClick={onClick}>Book</Button>
      <Button as="a" href="/x" disabled disabledReason="Not for links.">Link</Button>
      <Button as="a" href="/y" tabIndex={3}>Open</Button>
    </LanguageProvider>);
    const book = screen.getByRole("button", { name: "Book" });
    expect(described(book)).toBe("Pick a date first.");
    fireEvent.click(book);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a date first.");
    expect(screen.getByText("Link").closest("a")).toHaveAttribute("tabindex", "-1");
    expect(screen.queryByText("Not for links.")).toBeNull();
    expect(screen.getByText("Open").closest("a")).toHaveAttribute("tabindex", "3");
  });
});

describe.each(["en", "es"])("/reset-password (%s)", lang => {
  async function openReset(recovery = false) {
    const fetcher = vi.fn().mockResolvedValue(reply({ mode: "challenge", state: "sealed" }));
    const view = render(<LanguageProvider lang={lang}><PasswordResetView fetcher={fetcher} readToken={() => `t1.${"A".repeat(16)}.${"b".repeat(120)}`} /></LanguageProvider>);
    const save = await screen.findByRole("button", { name: t(lang, "reset.finishSubmit") });
    if (recovery) fireEvent.click(screen.getByRole("button", { name: t(lang, "reset.useRecoveryCode") }));
    return { ...view, fetcher, save };
  }

  it("names each unmet rule in field order", async () => {
    const { container, fetcher, save } = await openReset();
    expect(described(save)).toContain(t(lang, "reset.blockedCode"));
    type("code", "123456");
    type("password", "a".repeat(MIN - 4));
    type("passwordConfirm", "a".repeat(MIN - 4));
    expect(described(save)).toContain(t(lang, "auth.blockedPasswordShort"));
    expect(container.querySelector("#reset-password-length")).toHaveTextContent(t(lang, "auth.newPasswordTooShort", { count: MIN - 4 }));
    fireEvent.click(save);
    expect(screen.getByRole("alert")).toHaveTextContent(String(MIN));
    type("password", "a".repeat(NEW_PASSWORD_MAX + 1));
    expect(described(save)).toContain(t(lang, "auth.blockedPasswordLong"));
    type("password", PASSWORD);
    type("passwordConfirm", "");
    expect(described(save)).toContain(t(lang, "auth.blockedConfirm"));
    type("passwordConfirm", `${PASSWORD}x`);
    expect(described(save)).toContain(t(lang, "auth.blockedMismatch"));
    container.querySelector("form").requestSubmit();
    expect(finishCalls(fetcher)).toEqual([]);
    await noAxe(container);
    type("passwordConfirm", PASSWORD);
    expect(save).not.toHaveAttribute("aria-disabled");
  });

  it("names a short recovery code on a press", async () => {
    const { fetcher, save } = await openReset(true);
    type("code", "A".repeat(10));
    type("password", PASSWORD);
    type("passwordConfirm", PASSWORD);
    fireEvent.click(save);
    expect(screen.getByRole("alert")).toHaveTextContent(t(lang, "reset.blockedRecoveryCode", { min: RECOVERY_CODE_MIN, max: RECOVERY_CODE_MAX }));
    expect(finishCalls(fetcher)).toEqual([]);
  });
});

describe.each(["en", "es"])("/signup/confirm (%s)", lang => {
  it("names the unmet rule beside #9452's message and announces it", async () => {
    const fetcher = vi.fn();
    const { container } = render(<LanguageProvider lang={lang}><OpenSignupConfirmView available client={{ auth: {} }} fetcher={fetcher} readToken={() => `v1.${"a".repeat(16)}.${"b".repeat(40)}`} onSignedIn={vi.fn()} /></LanguageProvider>);
    const create = await screen.findByRole("button", { name: t(lang, "signup.confirmSubmit") });
    type("password", "a".repeat(MIN - 4));
    expect(create).toBeEnabled();
    expect(described(create)).toContain(t(lang, "auth.blockedPasswordShort"));
    expect(container.querySelector("#signup-password-length")).toHaveTextContent(t(lang, "auth.newPasswordTooShort", { count: MIN - 4 }));
    fireEvent.click(create);
    expect(screen.getByRole("alert")).toHaveTextContent(t(lang, "auth.blockedPasswordShort"));
    type("password", PASSWORD);
    expect(described(create)).toContain(t(lang, "auth.blockedConfirm"));
    type("passwordConfirm", `${PASSWORD}x`);
    fireEvent.click(create);
    expect(screen.getAllByRole("alert").map(node => node.textContent)).toContain(t(lang, "auth.blockedMismatch"));
    container.querySelector("form").requestSubmit();
    expect(fetcher).not.toHaveBeenCalled();
    await noAxe(container);
  });
});
