import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeConversionReviewCard } from "../src/features/knowledge/KnowledgeConversionReviewCard.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { BusyTestHost, expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const pending = {
  id: "conv-pending", organizationId: "org-1", attempt: 1, outcome: "succeeded",
  reviewStatus: null, reviewedAt: null, rejectionReason: null, errorCode: null,
};
const failed = {
  id: "conv-failed", organizationId: "org-1", attempt: 2, outcome: "failed",
  reviewStatus: null, reviewedAt: null, rejectionReason: null, errorCode: "knowledge-no-text",
};
const rejected = {
  id: "conv-rejected", organizationId: "org-1", attempt: 3, outcome: "succeeded",
  reviewStatus: "rejected", reviewedAt: "2026-09-16T14:00:00Z",
  rejectionReason: "Extracted text does not match the signed agreement.", errorCode: null,
};
const approved = {
  id: "conv-approved", organizationId: "org-1", attempt: 4, outcome: "succeeded",
  reviewStatus: "approved", reviewedAt: "2026-09-16T15:00:00Z", rejectionReason: null, errorCode: null,
};

function show(props = {}) {
  return render(
    <LanguageProvider lang={props.lang || "en"}>
      <KnowledgeConversionReviewCard
        conversions={props.conversions ?? [pending, failed, rejected, approved]}
        working={props.working || false}
        reviewColumnsAvailable={props.reviewColumnsAvailable}
        hasMore={props.hasMore || false}
        onApprove={props.onApprove || vi.fn()}
        onReject={props.onReject || vi.fn()}
        onLoadMore={props.onLoadMore || vi.fn()}
      />
    </LanguageProvider>,
  );
}

describe("knowledge conversion review card", () => {
  it("shows pending, failed, approved, and rejected conversions distinctly", () => {
    show();
    expect(screen.getByRole("heading", { name: "Conversion review" })).toBeInTheDocument();
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.getByText("Reason: Extracted text does not match the signed agreement.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Deny" })).toHaveLength(2);
  });

  // UX-UG-KNOWLEDGE-CONVERSION-CARD-POLISH-20260917. The pill used to be
  // applied to the refusal alone, so three of four states rendered as bare
  // text; inside one list that reads as an inconsistency, not as emphasis.
  it("renders every one of the four states through the same status element and class", () => {
    show();
    const labels = ["Awaiting review", "Failed", "Approved", "Rejected"];
    const statuses = labels.map((label) => screen.getByText(label));
    for (const [index, status] of statuses.entries()) {
      expect(status.tagName, labels[index]).toBe("SPAN");
      expect(status.className, labels[index]).toBe("knowledge-workspace__status knowledge-workspace__status--phrase");
    }
    // One element, one class list, for all four -- asserted as a set so a later
    // per-state modifier cannot slip back in.
    expect(new Set(statuses.map((status) => `${status.tagName}.${status.className}`)).size).toBe(1);
  });

  // The card used to re-implement the panel's card and empty markup verbatim.
  it("renders through the workspace card and empty primitives rather than copies of them", () => {
    const { container } = show({ conversions: [] });
    const card = container.querySelector("article.knowledge-workspace__card");
    expect(card).toBeInTheDocument();
    expect(card.querySelector("header.knowledge-workspace__head")).toBeInTheDocument();
    const empty = screen.getByText("No conversions have been recorded yet.");
    expect(empty.tagName).toBe("P");
    expect(empty).toHaveClass("knowledge-workspace__empty");
    expect(empty.parentElement).toHaveClass("knowledge-workspace__body");
  });

  it("offers the next page only when one exists and reports it upward once", () => {
    const onLoadMore = vi.fn();
    show({ conversions: [pending], onLoadMore });
    expect(screen.queryByRole("button", { name: "Show more conversions" })).not.toBeInTheDocument();

    const more = show({ conversions: [pending], hasMore: true, onLoadMore });
    fireEvent.click(more.getByRole("button", { name: "Show more conversions" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  // Review of #2176, MEDIUM-1. The control used to live inside the non-empty
  // branch of the emptiness ternary, so in the steady state of a well-run
  // organization -- nothing awaiting review, a full ledger behind it -- the card
  // claimed the ledger was empty and every settled decision ever recorded was
  // unreachable from the only surface that reviews them.
  it("still offers the next page when the loaded section came back empty", () => {
    const onLoadMore = vi.fn();
    const view = show({ conversions: [], hasMore: true, onLoadMore });
    const more = view.getByRole("button", { name: "Show more conversions" });
    expect(more).toBeInTheDocument();
    // And it does not claim the ledger is empty while offering more of it.
    expect(view.getByText("Nothing is awaiting review.")).toBeInTheDocument();
    expect(view.queryByText("No conversions have been recorded yet.")).not.toBeInTheDocument();
    fireEvent.click(more);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("says the ledger is empty only when there is nothing left to read", () => {
    const view = show({ conversions: [], hasMore: false });
    expect(view.getByText("No conversions have been recorded yet.")).toBeInTheDocument();
    expect(view.queryByText("Nothing is awaiting review.")).not.toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Show more conversions" })).not.toBeInTheDocument();
  });

  it("renders the Spanish section-empty copy", () => {
    const view = show({ lang: "es", conversions: [], hasMore: true });
    expect(view.getByText("No hay nada pendiente de revisión.")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Mostrar más conversiones" })).toBeInTheDocument();
  });

  it("does not persist a denial until a reason is entered", async () => {
    const onReject = vi.fn();
    show({ conversions: [pending], onReject });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.getByRole("button", { name: "Save denial" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save denial" }));
    expect(onReject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason for denial"), {
      target: { value: "  Extracted text does not match the signed agreement.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save denial" }));
    expect(onReject).toHaveBeenCalledWith(pending, "Extracted text does not match the signed agreement.");
  });

  it("lets a reviewer reject a failed conversion so it does not stay pending", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    show({ conversions: [failed], onApprove, onReject });
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.change(screen.getByLabelText("Reason for denial"), {
      target: { value: "No extractable text; wait for a readable scan." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save denial" }));
    expect(onReject).toHaveBeenCalledWith(failed, "No extractable text; wait for a readable scan.");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("renders Spanish copy for a rejected conversion", () => {
    show({ lang: "es", conversions: [rejected] });
    expect(screen.getByRole("heading", { name: "Revisión de conversión" })).toBeInTheDocument();
    expect(screen.getByText("Rechazada")).toBeInTheDocument();
    expect(screen.getByText("Motivo: Extracted text does not match the signed agreement.")).toBeInTheDocument();
  });

  it("disables Deny with a cutover hint when review columns are not available yet", () => {
    show({ conversions: [pending, failed], reviewColumnsAvailable: false });
    const hint = screen.getByText("Available after the next database update");
    expect(hint).toHaveAttribute("role", "status");
    // The card's gutter lives on the header and the body, never on the card
    // itself, so a hint rendered as their sibling sits flush on the border.
    expect(hint.parentElement).toHaveClass("knowledge-workspace__body");
    expect(hint).toHaveClass("knowledge-workspace__hint");
    expect(screen.queryByText("Rejected")).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Deny" })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });
});

// The card's controls stay focusable while its owner's write runs
// (the knowledge panel holds the synchronous lock), and refuse a second one.
describe("knowledge conversion review card while a decision is saved", () => {
  it("keeps the denial open with its reason when the owner refuses it", async () => {
    const onReject = vi.fn(async () => false);
    show({ conversions: [failed], onReject });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.change(screen.getByLabelText("Reason for denial"), { target: { value: "Unreadable scan." } });
    fireEvent.click(screen.getByRole("button", { name: "Save denial" }));
    await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Reason for denial")).toHaveValue("Unreadable scan.");
  });

  it("keeps Save denial focused while the denial is saved, and saves it once", async () => {
    const reject = vi.fn(async () => true);
    render(<LanguageProvider lang="en"><BusyTestHost>{(pending, run) => (
      <KnowledgeConversionReviewCard conversions={[failed]} working={pending} hasMore={false} onApprove={vi.fn()} onReject={(conversion, reason) => run(() => reject(conversion, reason))} onLoadMore={vi.fn()} />
    )}</BusyTestHost></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.change(screen.getByLabelText("Reason for denial"), { target: { value: "No extractable text; wait for a readable scan." } });
    await expectHeldWriteFocus(reject, screen.getByRole("button", { name: "Save denial" }));
    expect(reject).toHaveBeenCalledTimes(1);
  });
});
