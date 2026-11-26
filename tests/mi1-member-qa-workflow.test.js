// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  QA_AUDIT_METADATA_KEYS,
  QA_DONOR_BASELINE,
  QA_OFFICER_ROLES,
  QA_RPC,
  canOfficialReplyOnQa,
  canSeeOfficerQaQueue,
  createInMemoryQaStore,
  createQaRpcAdapter,
  deriveQaQuestionStatus,
  normalizeQaTitle,
  planAcceptQaAnswer,
  planQaReply,
  redactQaDisplayName,
  searchQaHistory,
} from "../src/features/qa/index.js";

function member(overrides = {}) {
  return {
    userId: "user-a",
    organizationId: "org-a",
    organizationStatus: "active",
    membershipStatus: "active",
    chapterId: "ch-a",
    organizationRoles: [],
    chapterRoles: [],
    mfaSatisfied: true,
    selectedHat: "member",
    ...overrides,
  };
}

function steward(overrides = {}) {
  return member({
    userId: "stew-a",
    organizationRoles: ["steward"],
    selectedHat: "steward",
    ...overrides,
  });
}

const questionText = {
  title: "When does overtime start after a forced stay?",
  body: "Night shift was held two hours past the posted end without a written order.",
};

describe("CR-018 member Q&A workflow", () => {
  it("keeps the named RPC surface organization-derived and officer-scoped", () => {
    expect(QA_DONOR_BASELINE).toBe("donor-baseline-20260721");
    expect(QA_OFFICER_ROLES).toEqual(["steward", "coordinator", "advisor", "admin", "vp"]);
    expect(Object.values(QA_RPC).every((name) => name.startsWith("list_member_qa") || name.includes("member_qa"))).toBe(true);
    expect(QA_AUDIT_METADATA_KEYS).not.toContain("body");
    expect(QA_AUDIT_METADATA_KEYS).not.toContain("title");
  });

  it("rejects short titles and redacts last names", () => {
    expect(normalizeQaTitle("Too few").ok).toBe(false);
    expect(redactQaDisplayName("Sam Okafor")).toBe("Sam O.");
  });

  it("lets a member ask and a steward post the official reply that can be accepted", () => {
    const store = createInMemoryQaStore({ clock: { now: () => 1_775_000_000_000 } });
    const asker = member();
    const officer = steward();
    const asked = store.ask(asker, questionText);
    expect(asked.ok).toBe(true);
    expect(asked.value.status).toBe("open");

    const memberReply = store.reply(asker, {
      questionId: asked.value.id,
      kind: "official",
      body: "I think overtime starts after eight hours in a day.",
    });
    expect(memberReply.ok).toBe(false);
    expect(memberReply.code).toBe("forbidden");

    const followUp = store.reply(asker, {
      questionId: asked.value.id,
      kind: "follow_up",
      body: "The written order still has not been posted on the board.",
    });
    expect(followUp.ok).toBe(true);
    expect(followUp.value.status).toBe("open");

    const official = store.reply(officer, {
      questionId: asked.value.id,
      kind: "official",
      body: "Overtime starts after eight hours in the day under Article 12.",
    });
    expect(official.ok).toBe(true);
    expect(official.value.status).toBe("replied");
    const officialReply = official.value.replies.find((reply) => reply.kind === "official");

    const acceptedFollowUp = store.accept(asker, {
      questionId: asked.value.id,
      replyId: followUp.value.replies.find((reply) => reply.kind === "follow_up").id,
    });
    expect(acceptedFollowUp.ok).toBe(false);

    const accepted = store.accept(asker, {
      questionId: asked.value.id,
      replyId: officialReply.id,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.value.status).toBe("accepted");
    expect(accepted.value.replies.find((reply) => reply.accepted).id).toBe(officialReply.id);
  });

  it("refuses to accept a reply that is not bound to the question", () => {
    const store = createInMemoryQaStore();
    const asker = member();
    const officer = steward();
    const first = store.ask(asker, questionText).value;
    const second = store.ask(asker, {
      title: "Where is the holiday schedule posted this year?",
      body: "The break-room copy is last year's sheet and the steward desk is closed.",
    }).value;
    const official = store.reply(officer, {
      questionId: first.id,
      kind: "official",
      body: "The holiday sheet is posted beside the time clock this week.",
    }).value.replies[0];

    const planned = planAcceptQaAnswer(asker, {
      ...second,
      replies: [{ ...official, questionId: first.id }],
    }, official.id);
    expect(planned.ok).toBe(false);
    expect(planned.code).toBe("not_found");
  });

  it("toggles votes without going negative and keeps history searchable", () => {
    const store = createInMemoryQaStore();
    const asker = member();
    const voter = member({ userId: "user-b" });
    const asked = store.ask(asker, questionText).value;
    const up = store.toggleVote(voter, { targetKind: "question", targetId: asked.id });
    expect(up.value.voted).toBe(true);
    expect(up.value.upvoteCount).toBe(1);
    const down = store.toggleVote(voter, { targetKind: "question", targetId: asked.id });
    expect(down.value.voted).toBe(false);
    expect(down.value.upvoteCount).toBe(0);

    store.reply(steward(), {
      questionId: asked.id,
      kind: "official",
      body: "Call the steward desk before staying past the posted end of shift.",
    });
    const found = searchQaHistory(store.list(asker, { query: "steward desk", status: "all", sort: "newest" }).value, {
      query: "steward desk",
      status: "all",
      sort: "newest",
    });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(asked.id);
  });

  it("treats repeated desired-state votes and acceptance as idempotent outcomes", () => {
    const store = createInMemoryQaStore();
    const asker = member();
    const voter = member({ userId: "user-b" });
    const asked = store.ask(asker, questionText).value;
    const official = store.reply(steward(), {
      questionId: asked.id,
      kind: "official",
      body: "The current schedule is posted beside the time clock.",
    }).value.replies[0];

    const auditStart = store.audits.length;
    expect(store.toggleVote(voter, { targetKind: "question", targetId: asked.id, voted: true }).value.upvoteCount).toBe(1);
    expect(store.toggleVote(voter, { targetKind: "question", targetId: asked.id, voted: true }).value.upvoteCount).toBe(1);
    expect(store.accept(asker, { questionId: asked.id, replyId: official.id, accepted: true }).value.acceptedReplyId).toBe(official.id);
    expect(store.accept(asker, { questionId: asked.id, replyId: official.id, accepted: true }).value.acceptedReplyId).toBe(official.id);
    expect(store.audits).toHaveLength(auditStart + 2);
  });

  it("isolates two organizations and chapter-only steward grants", () => {
    const store = createInMemoryQaStore();
    const askerA = member();
    const memberB = member({
      userId: "user-b",
      organizationId: "org-b",
      chapterId: "ch-b",
    });
    const stewardB = steward({
      userId: "stew-b",
      organizationId: "org-b",
      chapterId: "ch-b",
    });
    const chapterOnly = steward({
      userId: "stew-c",
      organizationRoles: [],
      chapterRoles: ["steward"],
      chapterId: "ch-other",
    });
    const asked = store.ask(askerA, questionText).value;

    expect(store.list(memberB, { query: "", status: "all", sort: "newest" }).value).toEqual([]);
    expect(store.get(memberB, asked.id).ok).toBe(false);
    expect(store.toggleVote(memberB, { targetKind: "question", targetId: asked.id }).ok).toBe(false);
    expect(store.reply(stewardB, {
      questionId: asked.id,
      kind: "official",
      body: "This reply must never cross organizations under any hat.",
    }).ok).toBe(false);
    expect(canOfficialReplyOnQa(chapterOnly, asked)).toBe(false);
    expect(store.officerQueue(chapterOnly).value.questions).toEqual([]);
    expect(canSeeOfficerQaQueue(askerA)).toBe(false);

    const queue = store.officerQueue(steward());
    expect(queue.value.questions.map((row) => row.id)).toEqual([asked.id]);
  });

  it("derives open/replied/accepted without treating follow-ups as official answers", () => {
    const followUp = { id: "r1", kind: "follow_up", deletedAt: null };
    const official = { id: "r2", kind: "official", deletedAt: null };
    expect(deriveQaQuestionStatus([followUp], null)).toBe("open");
    expect(deriveQaQuestionStatus([followUp, official], null)).toBe("replied");
    expect(deriveQaQuestionStatus([followUp, official], "r2")).toBe("accepted");
    expect(deriveQaQuestionStatus([followUp, official], "r1")).toBe("replied");
  });

  it("does not send a caller-supplied organization to any RPC", async () => {
    const calls = [];
    const adapter = createQaRpcAdapter({
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { data: [], error: null };
      },
    });
    await adapter.list({ query: "overtime", status: "open", sort: "votes" });
    await adapter.ask({ title: questionText.title, body: questionText.body, idempotencyKey: "ask-1" });
    await adapter.officialReply({ questionId: "q1", body: "Official chapter answer for the posted overtime rule." });
    await adapter.toggleVote({ targetKind: "question", targetId: "q1", voted: true });
    await adapter.accept({ questionId: "q1", replyId: "r1", accepted: true });
    expect(calls.map((call) => call.name)).toEqual([
      QA_RPC.list,
      QA_RPC.ask,
      QA_RPC.officialReply,
      QA_RPC.toggleVote,
      QA_RPC.accept,
    ]);
    for (const call of calls) {
      expect(JSON.stringify(call.args)).not.toMatch(/organization/i);
    }
    expect(calls[3].args).toMatchObject({ p_voted: true });
    expect(calls[4].args).toMatchObject({ p_accepted: true });
  });

  it("blocks orphan sessions from asking and officer replies from members", () => {
    const orphan = member({ organizationId: null, organizationStatus: null });
    expect(createInMemoryQaStore().ask(orphan, questionText).code).toBe("organization_required");
    expect(planQaReply(member(), {
      id: "q1",
      organizationId: "org-a",
      chapterId: "ch-a",
      authorId: "user-a",
      deletedAt: null,
      replies: [],
    }, { kind: "official", body: "Members cannot wear a staff answer." }).code).toBe("forbidden");
    expect(planQaReply(member({ userId: "other-member" }), {
      id: "q1",
      organizationId: "org-a",
      chapterId: "ch-a",
      authorId: "user-a",
      deletedAt: null,
      replies: [],
    }, { kind: "follow_up", body: "Another member cannot reopen this accepted question." }).code).toBe("forbidden");
  });
});
