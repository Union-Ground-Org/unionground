import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { describe, expect, it, vi } from "vitest";
import { IssueSignalsStaffPanel } from "../src/features/issueIntelligence/IssueSignals.jsx";
import { normalizeWeeklyDigests } from "../src/features/issueIntelligence/model.js";

const digest = {
  id: "00000000-0000-4000-8000-0000000000d1",
  family: "contract_rights_confusion",
  windowStart: "2026-09-21",
  windowEnd: "2026-09-27",
  confidence: "high",
  trend: "rising",
  evidence: { evidenceFamilies: ["qa", "messages"], qa: "many", messages: "several", secret: 12 },
  recommendations: ["publish_explainer", "brief_stewards", "made_up"],
  generatedAt: "2026-09-28T13:02:00Z",
  ai: { status: "available", summary: null, model: null, enrichedAt: null },
};

function clientFor(digests, signals = { enabled: true, viewer: "staff", signals: [] }) {
  return {
    rpc: vi.fn(async (name) => (name === "get_issue_intelligence_weekly_digests"
      ? { data: digests, error: null }
      : { data: signals, error: null })),
  };
}

describe("weekly digest normalization", () => {
  it("keeps bands and known recommendations only", () => {
    const { digests } = normalizeWeeklyDigests({ enabled: true, digests: [digest, { id: 1 }] });
    expect(digests).toHaveLength(1);
    expect(digests[0].bands).toEqual([{ key: "qa", band: "many" }, { key: "messages", band: "several" }]);
    expect(digests[0].recommendations).toEqual(["publish_explainer", "brief_stewards"]);
    expect(normalizeWeeklyDigests({ enabled: false, digests: [digest] })).toEqual({ enabled: false, digests: [] });
  });
});

describe("weekly digest panel", () => {
  it("shows the stored digest with bands and recommendations, then adds a Guide summary", async () => {
    const client = clientFor({ enabled: true, digests: [digest] });
    const requestDigestSummary = vi.fn(async () => ({ digest: { ...digest, ai: { status: "enriched", summary: { summary: "Workplace policy questions rose across Q&A and messages.", recommendations: ["Publish a short explainer"], caution: null } } } }));
    render(<IssueSignalsStaffPanel issueSignals={{ client, scopeKey: "k", session: { access_token: "t" }, requestDigestSummary }} hat="committee member" />);
    expect(await screen.findByText("Weekly issue digest")).toBeInTheDocument();
    expect(client.rpc).toHaveBeenCalledWith("get_issue_intelligence_weekly_digests", { p_selected_hat: "committee member" });
    expect(screen.getByText("Contract and rights confusion: rising during the week of 2026-09-21 to 2026-09-27.")).toBeInTheDocument();
    expect(screen.getByText("High confidence")).toBeInTheDocument();
    expect(screen.getByText("Publish a contract-rights explainer")).toBeInTheDocument();
    expect(screen.getByText("Brief the committee on the pattern")).toBeInTheDocument();
    expect(screen.queryByText("12")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a Guide summary" }));
    expect(await screen.findByText("Workplace policy questions rose across Q&A and messages.")).toBeInTheDocument();
    expect(requestDigestSummary).toHaveBeenCalledWith({ access_token: "t" }, "committee member", digest.id);
    expect(screen.queryByRole("button", { name: "Add a Guide summary" })).not.toBeInTheDocument();
  });

  it("reports a failed summary without losing the digest", async () => {
    const client = clientFor({ enabled: true, digests: [digest] });
    const requestDigestSummary = vi.fn(async () => { throw Object.assign(new Error("x"), { status: 503 }); });
    render(<IssueSignalsStaffPanel issueSignals={{ client, scopeKey: "k", session: { access_token: "t" }, requestDigestSummary }} hat="admin" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a Guide summary" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The Guide could not add a summary right now.");
    expect(screen.getByText("Publish a contract-rights explainer")).toBeInTheDocument();
  });

  it("hides the summary control when the AI switches are off and the whole section when the digest switch is off", async () => {
    const off = clientFor({ enabled: true, digests: [{ ...digest, ai: { status: "off" } }] });
    const first = render(<IssueSignalsStaffPanel issueSignals={{ client: off, scopeKey: "a" }} hat="admin" />);
    expect(await screen.findByText("Weekly issue digest")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a Guide summary" })).not.toBeInTheDocument();
    first.unmount();
    const disabled = clientFor({ enabled: false, digests: [] });
    render(<IssueSignalsStaffPanel issueSignals={{ client: disabled, scopeKey: "b" }} hat="admin" />);
    await waitFor(() => expect(disabled.rpc).toHaveBeenCalledWith("get_issue_intelligence_weekly_digests", { p_selected_hat: "admin" }));
    await screen.findByText("No active issue patterns right now.");
    expect(screen.queryByText("Weekly issue digest")).not.toBeInTheDocument();
  });

  it("explains that no digest has been generated yet", async () => {
    const client = clientFor({ enabled: true, digests: [] });
    render(<IssueSignalsStaffPanel issueSignals={{ client, scopeKey: "k" }} hat="admin" />);
    expect(await screen.findByText(/No weekly digest has been generated yet/)).toBeInTheDocument();
  });
});

// A Guide summary keeps its button focused under
// pending and is requested once from one tick.
describe("weekly digest summary while it runs (record 8435)", () => {
  async function summaryReady(requestDigestSummary) {
    const client = clientFor({ enabled: true, digests: [digest] });
    render(<IssueSignalsStaffPanel issueSignals={{ client, scopeKey: "k", session: { access_token: "t" }, requestDigestSummary }} hat="committee member" />);
    return screen.findByRole("button", { name: /Summarize|Guide summary/ });
  }
  const answer = async () => ({ digest: { ...digest, ai: { status: "enriched", summary: { summary: "Workplace policy questions rose.", recommendations: [] }, model: "m", enrichedAt: "2026-09-28T14:00:00Z" } } });

  it("keeps the summary button focused while Compass words it, and asks once", async () => {
    const requestDigestSummary = vi.fn(answer);
    await expectHeldWriteFocus(requestDigestSummary, await summaryReady(requestDigestSummary));
    expect(requestDigestSummary).toHaveBeenCalledTimes(1);
  });

  it("asks once when the summary button is activated twice in one tick", async () => {
    const requestDigestSummary = vi.fn(answer);
    const button = await summaryReady(requestDigestSummary);
    await expectOneWriteFromOneTick(requestDigestSummary, [() => fireEvent.click(button), () => fireEvent.click(button)]);
  });
});

describe("weekly digest summary answering after the hat changed (record 8435)", () => {
  it("does not put an earlier hat's summary into the list now shown", async () => {
    const client = clientFor({ enabled: true, digests: [digest] });
    let release;
    const requestDigestSummary = vi.fn(() => new Promise((resolve) => { release = () => resolve({ digest: { ...digest, ai: { status: "enriched", summary: { summary: "Late steward summary.", recommendations: [] }, model: "m", enrichedAt: "2026-09-28T14:00:00Z" } } }); }));
    const panel = (hat) => <IssueSignalsStaffPanel issueSignals={{ client, scopeKey: "k", session: { access_token: "t" }, requestDigestSummary }} hat={hat} />;
    const view = render(panel("committee member"));
    fireEvent.click(await screen.findByRole("button", { name: /Summarize|Guide summary/ }));
    await waitFor(() => expect(requestDigestSummary).toHaveBeenCalledTimes(1));
    view.rerender(panel("admin"));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("get_issue_intelligence_weekly_digests", { p_selected_hat: "admin" }));
    await screen.findByText("Weekly issue digest");
    await act(async () => { release(); });
    expect(screen.queryByText("Late steward summary.")).toBeNull();
  });
});
