// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

// A focus fixup an opted-in test leaves queued must not run in the next test,
// which has the fixup off (#8430 review G7-1). jsdom keeps the queued request
// in a private flag, so enableFocusFixup's cleanup lets it run before the next
// test starts. Each opted-in test below ends with one queued, by passing,
// failing or timing out; the test after it must keep focus.

afterEach(() => { document.body.replaceChildren(); });

function focusedButtonThatGetsDisabled() {
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  button.disabled = true;
  return button;
}

async function keepsFocusWithTheFixupOff() {
  const button = focusedButtonThatGetsDisabled();
  await afterRenderingUpdate();
  expect(document.activeElement).toBe(button);
}

it.fails("fails an opted-in test with a focus fixup already queued", () => {
  enableFocusFixup();
  focusedButtonThatGetsDisabled();
  expect(true).toBe(false);
});

it("keeps the fixup off in the test after an opted-in failure", keepsFocusWithTheFixupOff);

it("passes an opted-in test with a focus fixup already queued", () => {
  enableFocusFixup();
  focusedButtonThatGetsDisabled();
});

it("keeps the fixup off in the test after an opted-in success", keepsFocusWithTheFixupOff);

it.fails("times out an opted-in test with a focus fixup queued near its deadline", async () => {
  enableFocusFixup();
  setTimeout(focusedButtonThatGetsDisabled, 75);
  await new Promise(() => {});
}, 80);

it("keeps the fixup off in the test after an opted-in timeout", keepsFocusWithTheFixupOff);
