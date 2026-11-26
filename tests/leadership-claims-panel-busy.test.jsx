// The leadership claims panel's Reject keeps focus while the
// rejection is saved, and a second activation in the same tick sends no second
// rejection. The claim fixture is fictional.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeadershipClaimsPanel } from "../src/features/governance/LeadershipClaimsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const CLAIM = {
  id: "c1", status: "pending", chapterId: "north", chapterName: "North Chapter", claimantName: "Casey Claimant",
  claimedAt: "2026-10-02T12:00:00.000Z", effectiveAt: "2026-10-05T12:00:00.000Z", inactiveLeaderCount: 2,
};

function claimsPanel(reject) {
  const api = { listLeadershipClaims: vi.fn(async () => ({ enabled: true, inactivityMonths: 6, coolingOffHours: 72, items: [CLAIM] })), rejectLeadershipClaim: reject };
  render(<LanguageProvider lang="en"><LeadershipClaimsPanel api={api} onNotice={vi.fn()} /></LanguageProvider>);
  return screen.findByRole("button", { name: "Reject Casey Claimant's claim for North Chapter" });
}

describe("leadership claims while a rejection is saved", () => {
  it("keeps Reject focused while the rejection is saved, and rejects once", async () => {
    const reject = vi.fn(async () => undefined);
    await expectHeldWriteFocus(reject, await claimsPanel(reject));
    expect(reject).toHaveBeenCalledTimes(1);
  });

  it("rejects once when Reject is activated twice in one tick", async () => {
    const reject = vi.fn(async () => undefined);
    const button = await claimsPanel(reject);
    await expectOneWriteFromOneTick(reject, [() => fireEvent.click(button), () => fireEvent.click(button)]);
  });
});
