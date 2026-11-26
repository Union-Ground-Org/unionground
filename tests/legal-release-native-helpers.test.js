// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bundledPendingTexts } from "../src/lib/legalPending.native.js";
import { runNativeLegalOperation } from "../src/lib/legalReleaseGate.js";

// The phone app reaches these through Metro (legalPending.native.js replaces
// legalPending.js) and apps/mobile/src/lib/legalReleaseGate.ts; the web graph
// never imports them, so their contract is held here.
describe("native legal release helpers", () => {
  it("reads every bundled pending declaration in a stable order", () => {
    const files = { "./b.json": { schema: 1, recordId: "b" }, "./a.json": { schema: 1, recordId: "a" } };
    const context = Object.assign((path) => files[path], { keys: () => Object.keys(files) });
    expect(bundledPendingTexts(context)).toEqual([JSON.stringify(files["./a.json"]), JSON.stringify(files["./b.json"])]);
  });

  it("runs a native operation only when its path is open, and says why not otherwise", () => {
    let calls = 0;
    expect(runNativeLegalOperation("terms-receipt", { pendingUnreadable: true }, () => { calls += 1; }))
      .toEqual({ ran: false, plane: "native", reason: "pending-unreadable" });
    expect(runNativeLegalOperation("terms-receipt", { pending: [], gatedPaths: [] }, () => { calls += 1; return "done"; }))
      .toEqual({ ran: true, plane: "native", reason: "open", result: "done" });
    expect(calls).toBe(1);
  });
});
