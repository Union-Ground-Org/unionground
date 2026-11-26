import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IssueSignalBanner, IssueSignalsStaffPanel } from "../src/features/issueIntelligence/IssueSignals.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const contract = { family: "contract_rights_confusion", threadKey: "contract-rights-confusion" };
const retaliation = { family: "retaliation_protected_activity_pressure", threadKey: "retaliation-protected-activity-pressure" };

// The staff panel also reads the weekly digest; it answers "off" here so these
// tests stay about the signals read.
const DIGEST_OFF = { data: { enabled: false, digests: [] }, error: null };
function clientFor(response) {
  return { rpc: vi.fn(async (name) => (name === "get_issue_intelligence_weekly_digests" ? DIGEST_OFF : response)) };
}

describe("member issue banner", () => {
  it("reads the member projection and shows the member-safe banner with guidance", async () => {
    const client = clientFor({ data: { enabled: true, viewer: "member", signals: [contract] }, error: null });
    const onNavigate = vi.fn();
    render(<IssueSignalBanner issueSignals={{ client, scopeKey: "u:o:c", onNavigate }} surface="today" />);
    expect(await screen.findByText("Questions about contract rights are coming up often.")).toBeInTheDocument();
    expect(client.rpc).toHaveBeenCalledWith("get_issue_intelligence_signals", { p_selected_hat: "member" });
    expect(client.rpc).not.toHaveBeenCalledWith("get_issue_intelligence_weekly_digests", expect.anything());
    expect(screen.queryByText(/Seen across/)).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Why this matters now" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("Review incoming messages")).not.toBeInTheDocument();
    // Union Ground has no contract yet: the guidance opens rights, Q&A and
    // member support, never a contract reference.
    expect(screen.queryByRole("button", { name: /Contract reference/ })).not.toBeInTheDocument();
    const links = [...document.querySelectorAll(".issue-links .issue-link")];
    expect(links).toHaveLength(3);
    for (const link of links) fireEvent.click(link);
    expect(onNavigate.mock.calls.map(([destination]) => destination)).toEqual(["rights", "qa", "memberSupport"]);
    expect(onNavigate).not.toHaveBeenCalledWith("clauses");
  });

  it("renders nothing when the feature is off, empty, or the read fails", async () => {
    for (const response of [
      { data: { enabled: false, viewer: "member", signals: [] }, error: null },
      { data: { enabled: true, viewer: "member", signals: [] }, error: null },
      { data: null, error: { code: "42501", message: "not authorized" } },
    ]) {
      const client = clientFor(response);
      const { container, unmount } = render(<IssueSignalBanner issueSignals={{ client, scopeKey: "k" }} surface="today" />);
      await waitFor(() => expect(client.rpc).toHaveBeenCalled());
      await Promise.resolve();
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("shows two boosted guidance links on Know your rights in Spanish", async () => {
    const client = clientFor({ data: { enabled: true, viewer: "member", signals: [retaliation] }, error: null });
    render(<LanguageProvider lang="es"><IssueSignalBanner issueSignals={{ client, scopeKey: "k" }} surface="rights" variant="boost" /></LanguageProvider>);
    expect(await screen.findByText("Podrías estar enfrentando presión por una actividad protegida.")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Reporta lo que pasó/ })).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Por qué importa ahora" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls"))).toBeInTheDocument();
  });
});

describe("staff issue panel", () => {
  it("shows confidence, evidence, trend, follow-up and poll drafts for a strong signal", async () => {
    const client = clientFor({ data: { enabled: true, viewer: "staff", signals: [{ ...contract, confidence: "strong", trend: "rising", evidenceFamilies: ["qa", "messages", "cases", "polls"] }] }, error: null });
    const onNavigate = vi.fn();
    render(<IssueSignalsStaffPanel issueSignals={{ client, scopeKey: "k", onNavigate }} hat="steward" />);
    expect(await screen.findByText("Seen across 4 channels.")).toBeInTheDocument();
    // The title and the confidence tag are not repeated in the line under them.
    expect(screen.getAllByText(/Contract and rights confusion/)).toHaveLength(1);
    expect(screen.getAllByText(/Strong/)).toHaveLength(1);
    expect(client.rpc).toHaveBeenCalledWith("get_issue_intelligence_signals", { p_selected_hat: "steward" });
    expect(screen.getByText(/Pattern visible across Q&A, messages and issues\. Trend: rising/)).toBeInTheDocument();
    expect(screen.getByText("Strong · Issue pattern")).toBeInTheDocument();
    const drafts = screen.getAllByRole("button", { name: "Use this draft" });
    expect(drafts).toHaveLength(3);
    fireEvent.click(drafts[0]);
    expect(onNavigate).toHaveBeenCalledWith("campaigns", expect.stringMatching(/^\/m\/campaigns\?issueDraft=How%20confident/));
    fireEvent.click(screen.getByRole("button", { name: "Why this matters now" }));
    expect(screen.getByText("This pattern has grown to 4 channels recently.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Review incoming messages/ }));
    expect(onNavigate).toHaveBeenCalledWith("messages");
  });

  it("explains an off switch, an empty organization and a failed read", async () => {
    const off = clientFor({ data: { enabled: false, viewer: "staff", signals: [] }, error: null });
    const { unmount } = render(<IssueSignalsStaffPanel issueSignals={{ client: off, scopeKey: "a" }} hat="admin" />);
    expect(await screen.findByText(/turned off for your organization/)).toBeInTheDocument();
    unmount();
    const empty = clientFor({ data: { enabled: true, viewer: "staff", signals: [] }, error: null });
    const second = render(<IssueSignalsStaffPanel issueSignals={{ client: empty, scopeKey: "b" }} hat="admin" />);
    expect(await screen.findByText("No active issue patterns right now.")).toBeInTheDocument();
    second.unmount();
    const signalReads = vi.fn().mockResolvedValueOnce({ data: null, error: { code: "42501" } }).mockResolvedValueOnce({ data: { enabled: true, viewer: "staff", signals: [] }, error: null });
    const failing = { rpc: vi.fn(async (name) => (name === "get_issue_intelligence_weekly_digests" ? DIGEST_OFF : signalReads())) };
    render(<IssueSignalsStaffPanel issueSignals={{ client: failing, scopeKey: "c" }} hat="admin" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Issue patterns could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No active issue patterns right now.")).toBeInTheDocument();
  });

  // UB-UG-ISSUE-INTELLIGENCE-CARD-REPEATS-ITS-TITLE-20261108: the
  // line under the title adds only the channel count, in both languages.
  it("says only the channel count under an emerging signal's title, offers no poll drafts, and reports a failed digest read", async () => {
    const signal = { ...retaliation, confidence: "emerging", trend: "stable", evidenceFamilies: ["retaliation_reports", "messages", "cases"] };
    const client = { rpc: vi.fn(async (name) => (name === "get_issue_intelligence_weekly_digests"
      ? { data: null, error: { message: "unavailable" } }
      : { data: { enabled: true, viewer: "staff", signals: [signal] }, error: null })) };
    render(<LanguageProvider lang="es"><IssueSignalsStaffPanel issueSignals={{ client, scopeKey: "k" }} hat="steward" /></LanguageProvider>);
    expect(await screen.findByText("Aparece en 3 canales.")).toBeInTheDocument();
    expect(screen.getAllByText(/Represalias \/ presión por actividad protegida/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Usar este borrador" })).not.toBeInTheDocument();
    expect(await screen.findByText("No se pudo cargar el resumen semanal.")).toBeInTheDocument();
  });

  it("renders nothing without a backend client", () => {
    const { container } = render(<IssueSignalsStaffPanel issueSignals={{ client: null, scopeKey: "" }} hat="admin" />);
    expect(container).toBeEmptyDOMElement();
  });
});
