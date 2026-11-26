// OPS-UG-ROOT-SHARD-FLAKES-ON-DEPOT-20261031: on a loaded runner a
// test can act in the gap between React's commit (the DOM changed) and its
// passive effects (a later task). A MutationObserver callback runs in exactly
// that gap, which is where findByRole and waitFor resolve, so each case below
// renders outside act and acts from the observer: Escape from inside it, and
// a focus check where an awaiting test reads it, on the promise continuation.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../src/components/Dialog.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

let host;
let root;
let previousActEnvironment;

beforeEach(() => {
  previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  root.unmount();
  host.remove();
  document.body.querySelectorAll("button[data-opener]").forEach((node) => node.remove());
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

// Resolves with the observer callback's own result the first time `ready`
// holds after a DOM change, before any later task (a passive effect) runs.
function inCommitGap(ready, act) {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!ready()) return;
      observer.disconnect();
      resolve(act());
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function opener() {
  const button = document.createElement("button");
  button.dataset.opener = "";
  button.textContent = "Open";
  document.body.append(button);
  button.focus();
  return button;
}

describe("dialogs act from the commit that changes the DOM", () => {


  it("gives focus back to the shared dialog's opener in the commit that removes it", async () => {
    const button = opener();
    root.render(<LanguageProvider lang="en"><Dialog title="Before you edit" onClose={() => {}}><button type="button">Keep it as signed</button></Dialog></LanguageProvider>);
    await vi.waitFor(() => expect(document.activeElement).not.toBe(button));
    const removed = inCommitGap(() => document.querySelector(".dialog-backdrop") === null, () => undefined);
    root.render(<LanguageProvider lang="en"><p>Closed</p></LanguageProvider>);
    await removed;
    expect(document.activeElement).toBe(button);
  });
});
