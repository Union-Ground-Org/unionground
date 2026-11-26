import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemberQaForum } from "../src/features/qa/MemberQaForum.jsx";
import { OfficerQaQueue } from "../src/features/qa/OfficerQaQueue.jsx";

const memberActor = {
  userId: "user-a",
  organizationId: "org-a",
  organizationStatus: "active",
  membershipStatus: "active",
  chapterId: "ch-a",
  organizationRoles: [],
  chapterRoles: [],
  mfaSatisfied: true,
};

const stewardActor = {
  ...memberActor,
  userId: "stew-a",
  organizationRoles: ["steward"],
};

const openQuestion = {
  id: "q-1",
  organizationId: "org-a",
  chapterId: "ch-a",
  authorId: "user-a",
  title: "When does overtime start after a forced stay?",
  body: "Night shift was held two hours past the posted end without a written order.",
  preview: "Night shift was held two hours past the posted end without a written order.",
  status: "open",
  upvoteCount: 2,
  replyCount: 0,
  officialReplyCount: 0,
  votedByMe: false,
  authorDisplayName: "Sam O.",
  authoredByMe: true,
  createdAt: "2026-08-21T12:00:00.000Z",
  replies: [],
};

const repliedQuestion = {
  ...openQuestion,
  status: "replied",
  replyCount: 1,
  officialReplyCount: 1,
  replies: [{
    id: "r-1",
    organizationId: "org-a",
    chapterId: "ch-a",
    questionId: "q-1",
    authorId: "stew-a",
    kind: "official",
    body: "Overtime starts after eight hours under Article 12.",
    accepted: false,
    upvoteCount: 1,
    votedByMe: false,
    authorDisplayName: "Sam O.",
    createdAt: "2026-08-21T13:00:00.000Z",
  }],
};

describe("CR-018 Q&A surfaces", () => {
  it("delegates search to the server without erasing server-projected reply matches", async () => {
    const onSearch = vi.fn();
    render(<MemberQaForum actor={memberActor} questions={[openQuestion]} onSearch={onSearch} />);
    expect(screen.getByRole("heading", { name: "Worker questions" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search questions")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search questions"), { target: { value: "overtime" } });
    expect(screen.getByText("When does overtime start after a forced stay?")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search questions"), { target: { value: "zzzz" } });
    expect(screen.getByText("When does overtime start after a forced stay?")).toBeInTheDocument();
    await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith({ query: "zzzz", sort: "newest", status: "all" }));
    expect(screen.queryByLabelText("Post official reply")).not.toBeInTheDocument();
  });

  it("shows official replies and accept for the asker, follow-up only for members", async () => {
    const onAccept = vi.fn().mockResolvedValue({ ok: true });
    const onFollowUp = vi.fn().mockResolvedValue({ ok: true });
    render(
      <MemberQaForum
        actor={memberActor}
        selectedQuestion={repliedQuestion}
        onAccept={onAccept}
        onFollowUp={onFollowUp}
      />,
    );
    expect(screen.getByText(/Official reply/)).toBeInTheDocument();
    expect(screen.getByText("Official replies are posted by the committee.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept answer" }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith({ questionId: "q-1", replyId: "r-1", accepted: true }));
    fireEvent.change(screen.getByLabelText("Add a follow-up"), {
      target: { value: "The written order still has not been posted on the board." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(onFollowUp).toHaveBeenCalled());
  });

  it("does not offer the author-only follow-up composer to another member", () => {
    render(
      <MemberQaForum
        actor={{ ...memberActor, userId: "user-b" }}
        selectedQuestion={{ ...repliedQuestion, authoredByMe: false }}
        onFollowUp={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Add a follow-up")).not.toBeInTheDocument();
  });

  it("lets a steward answer the officer queue and hides it from members", async () => {
    const onReply = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = render(
      <OfficerQaQueue actor={memberActor} questions={[openQuestion]} onReply={onReply} />,
    );
    expect(screen.getByText("You cannot do that in this role.")).toBeInTheDocument();

    rerender(<OfficerQaQueue actor={stewardActor} questions={[openQuestion]} onReply={onReply} />);
    expect(screen.getByRole("heading", { name: "Questions waiting" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Post official reply"), {
      target: { value: "Overtime starts after eight hours under Article 12." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(onReply).toHaveBeenCalledWith({
      questionId: "q-1",
      body: "Overtime starts after eight hours under Article 12.",
    }));
  });
});
