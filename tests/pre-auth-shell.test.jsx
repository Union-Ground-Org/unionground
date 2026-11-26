import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { VerifyReceiptView } from "../src/views/VerifyReceiptView.jsx";

// F4 — /verify is a screen a member reaches WITHOUT the app shell: from an
// email, usually on a phone, sometimes on a shared terminal. It had drifted
// into its own product: .sg-app > .app-column with no card, its own input
// rule, and .dialog-primary — a DIALOG class — as its submit. (/reset, the
// other screen this suite once covered, was removed with the member-facing
// password path —.)

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

const navigatorLanguageDescriptor =
  Object.getOwnPropertyDescriptor(window.navigator, "language")
  ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window.navigator), "language");

function stubNavigatorLanguage(value) {
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    enumerable: true,
    get: () => value,
  });
}

function restoreNavigatorLanguage() {
  if (navigatorLanguageDescriptor) {
    Object.defineProperty(window.navigator, "language", navigatorLanguageDescriptor);
  }
}

describe("the pre-auth routes share one shell", () => {
  afterEach(() => {
    window.localStorage.removeItem("sg-lang");
    restoreNavigatorLanguage();
  });

  it("renders /verify in the auth card, like every other pre-auth screen", () => {
    const { container } = render(<VerifyReceiptView />);
    expect(container.querySelector("main.auth-screen"), "/verify is not on the auth shell").not.toBeNull();
    expect(container.querySelector("section.auth-card.vrx-card")).not.toBeNull();
    // The old shell, named so a revert is red rather than merely different.
    expect(container.querySelector(".sg-app")).toBeNull();
    expect(container.querySelector(".app-column")).toBeNull();
  });

  it("submits with the receipt card's own submit case, not a dialog class", () => {
    // Since Wave 2d the card CONTENT is vrx-owned: .vrx-submit restates the
    // shell submit at the prototype's measurements and carries the .7 disabled
    // opacity the shell's .55 fails on over the cream card. The defect this
    // test exists to keep out is unchanged: a DIALOG class doing submit duty
    // on a public page.
    const { container } = render(<VerifyReceiptView />);
    const submit = container.querySelector("form button[type=submit]");
    expect(submit).not.toBeNull();
    expect(submit.className).toContain("vrx-submit");
    expect(submit.className).not.toContain("dialog-primary");
  });

  it("upper-cases the receipt code on the way in, not only on display", () => {
    // text-transform: uppercase changes what the member SEES. If the state kept
    // the lowercase text, the lookup and the screen would disagree — and the
    // member reading a code back off this field would read back something they
    // never typed.
    render(<VerifyReceiptView />);
    const field = screen.getByLabelText(/receipt code/i);
    fireEvent.change(field, { target: { value: "sg-abc1" } });
    expect(field.value).toBe("SG-ABC1");
  });

  it("keeps the phone's helpers off a transcribed code", () => {
    render(<VerifyReceiptView />);
    const field = screen.getByLabelText(/receipt code/i);
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("autocapitalize")).toBe("characters");
    expect(field.getAttribute("spellcheck")).toBe("false");
  });

  it("styles the receipt code as a code field", () => {
    // The design system's code-entry case: mono, tracked, uppercase, so O/0 and
    // I/1 stay apart while typing. It was a 15px body input with a little extra
    // letter-spacing, which is the case it is NOT.
    const rule = read("src/styles.css").match(/^\.vrx-card \.vrx-input \{([^}]*)\}/m);
    expect(rule, ".vrx-card .vrx-input rule not found").not.toBeNull();
    expect(rule[1]).toContain("font-family: var(--utility)");
    expect(rule[1]).toContain("text-transform: uppercase");
    // --utility must be a real alias, not an undefined name that silently
    // falls back to the inherited family and looks fine to a reader.
    expect(read("src/styles.css")).toContain("--utility: var(--sg-font-family-mono);");
  });

  it("resolves language through the shared preferredLanguage helper", () => {
    window.localStorage.setItem("sg-lang", "es");
    const spanish = render(<VerifyReceiptView />);
    expect(screen.getByRole("heading", { name: "Verifica un comprobante de voto" })).toBeInTheDocument();
    spanish.unmount();

    window.localStorage.removeItem("sg-lang");
    stubNavigatorLanguage("en-US");
    render(<VerifyReceiptView />);
    expect(screen.getByRole("heading", { name: "Verify a vote receipt" })).toBeInTheDocument();
  });
});
