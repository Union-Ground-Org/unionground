import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  canAcceptQaAnswer,
  canModerateQa,
  canOfficialReplyOnQa,
  canSeeQaRecord,
  compareQaQuestions,
  createInMemoryQaStore,
  createQaRpcAdapter,
  createQaStoreAdapter,
  isMissingQaRpcError,
  normalizeQaBody,
  normalizeQaListQuery,
  normalizeQaSearchQuery,
  normalizeQaTitle,
  normalizeQaVoteTarget,
  officerRolesFor,
  projectQaListItem,
  QA_MAX_BODY_LENGTH,
  QA_MAX_TITLE_LENGTH,
  QA_MIN_BODY_LENGTH,
  QA_MIN_TITLE_LENGTH,
  QA_RPC,
  qaFailureText,
  qaStatusLabel,
  qaText,
  questionMatchesQaSearch,
  redactQaDisplayName,
  requireActiveQaMember,
  searchQaHistory,
  sortQaReplies,
} from "../src/features/qa/index.js";
import { MemberQaForum } from "../src/features/qa/MemberQaForum.jsx";
import { OfficerQaQueue } from "../src/features/qa/OfficerQaQueue.jsx";
import { MemberQaView } from "../src/views/MemberQaView.jsx";
import { OfficerQaView } from "../src/views/OfficerQaView.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const passiveEffectGate = vi.hoisted(() => ({
  hold: false,
  pending: [],
  begin() {
    this.hold = true;
    this.pending = [];
  },
  release() {
    this.hold = false;
    const effects = this.pending.splice(0);
    effects.forEach((effect) => effect());
  },
}));

vi.mock("react", async () => {
  const actual = await vi.importActual("react");
  return {
    ...actual,
    useEffect(effect, dependencies) {
      return actual.useEffect(() => {
        // The question-id effects are the two one-dependency effects in
        // MemberQaForum. Keep their passive callbacks behind an explicit
        // test gate so the committed detail can receive input first.
        if (passiveEffectGate.hold && Array.isArray(dependencies) && dependencies.length === 1) {
          passiveEffectGate.pending.push(effect);
          return undefined;
        }
        return effect();
      }, dependencies);
    },
  };
});

const activeMember = {
  userId: "member-a",
  organizationId: "org-a",
  organizationStatus: "active",
  membershipStatus: "active",
  chapterId: "chapter-a",
  organizationRoles: [],
  chapterRoles: [],
  mfaSatisfied: true,
  selectedHat: "member",
};

const activeOfficer = {
  ...activeMember,
  userId: "officer-a",
  organizationRoles: ["steward", "steward", "unknown"],
  selectedHat: "steward",
};

const question = {
  id: "q-1",
  organizationId: "org-a",
  chapterId: "chapter-a",
  authorId: "member-a",
  authoredByMe: true,
  authorDisplayName: "Taylor M.",
  title: "When does the posted schedule become final?",
  body: "The schedule has changed twice after it was posted for the coming week.",
  preview: "The schedule has changed twice after it was posted for the coming week.",
  status: "open",
  acceptedReplyId: null,
  upvoteCount: 3,
  replyCount: 0,
  officialReplyCount: 0,
  votedByMe: false,
  voterIds: [],
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: "2026-08-20T12:00:00.000Z",
  deletedAt: null,
  replies: [],
};

const officialReply = {
  id: "r-1",
  organizationId: "org-a",
  chapterId: "chapter-a",
  questionId: "q-1",
  authorId: "officer-a",
  authorDisplayName: "Morgan S.",
  kind: "official",
  body: "The schedule becomes final at the deadline printed in the current agreement.",
  accepted: false,
  upvoteCount: 1,
  votedByMe: false,
  voterIds: [],
  createdAt: "2026-08-20T13:00:00.000Z",
  deletedAt: null,
};

describe("CR-018 Q&A coverage contract", () => {
  it("covers membership, moderation, visibility, and acceptance branches", () => {
    expect(officerRolesFor(activeOfficer)).toEqual(["steward"]);
    expect(officerRolesFor({})).toEqual([]);
    expect(requireActiveQaMember(null).code).toBe("unauthenticated");
    expect(requireActiveQaMember({ userId: "u", mfaSatisfied: false }).code).toBe("mfa_required");
    expect(requireActiveQaMember({ userId: "u", mfaSatisfied: true }).code).toBe("organization_required");
    expect(requireActiveQaMember({ ...activeMember, membershipStatus: "revoked" }).code).toBe("membership_revoked");
    expect(requireActiveQaMember({ ...activeMember, chapterId: null }).code).toBe("chapter_required");
    expect(requireActiveQaMember(activeMember).ok).toBe(true);

    const otherOrganization = { ...question, organizationId: "org-b" };
    const otherChapter = { ...question, chapterId: "chapter-b", authoredByMe: false, authorId: "member-b" };
    expect(canOfficialReplyOnQa(activeOfficer)).toBe(true);
    expect(canOfficialReplyOnQa(activeOfficer, otherOrganization)).toBe(false);
    expect(canOfficialReplyOnQa({ ...activeOfficer, organizationRoles: [], chapterRoles: ["steward"] }, otherChapter)).toBe(false);
    expect(canOfficialReplyOnQa({ ...activeOfficer, organizationRoles: [], chapterRoles: ["steward"] }, question)).toBe(true);
    expect(canAcceptQaAnswer(activeMember, null)).toBe(false);
    expect(canAcceptQaAnswer(activeMember, otherOrganization)).toBe(false);
    expect(canAcceptQaAnswer(activeMember, question)).toBe(true);
    expect(canAcceptQaAnswer(activeOfficer, { ...question, authoredByMe: false, authorId: "member-b" })).toBe(true);
    expect(canModerateQa(activeMember, question)).toBe(true);
    expect(canModerateQa(activeMember, { ...question, chapterId: null })).toBe(true);
    expect(canModerateQa(activeMember, otherChapter)).toBe(false);
    expect(canModerateQa(activeOfficer, { ...question, authoredByMe: false, authorId: "member-b" })).toBe(true);
    expect(canSeeQaRecord(activeMember, { ...question, deletedAt: "2026-08-21" })).toBe(false);
    expect(canSeeQaRecord(activeMember, otherChapter)).toBe(false);
    expect(canSeeQaRecord(activeOfficer, otherChapter)).toBe(true);
  });

  it("keeps both officer gates total for actors that carry no organizationRoles field", () => {
    const partialMember = { ...activeMember };
    delete partialMember.organizationRoles;
    const partialChapterOfficer = { ...partialMember, userId: "officer-b", chapterRoles: ["steward"] };
    const partialUnknownRole = { ...partialMember, chapterRoles: ["unknown"] };
    const otherChapter = { ...question, chapterId: "chapter-b", authoredByMe: false, authorId: "member-b" };

    // A member with no officer grant of any kind still reads its own chapter.
    expect(canSeeQaRecord(partialMember, question)).toBe(true);
    expect(canSeeQaRecord(partialMember, otherChapter)).toBe(false);
    expect(canOfficialReplyOnQa(partialMember, question)).toBe(false);
    expect(canOfficialReplyOnQa(partialUnknownRole, question)).toBe(false);
    expect(canSeeQaRecord(partialUnknownRole, otherChapter)).toBe(false);

    // A chapter-scoped officer stays chapter-scoped; it never gains org-wide reach.
    expect(canOfficialReplyOnQa(partialChapterOfficer)).toBe(true);
    expect(canOfficialReplyOnQa(partialChapterOfficer, question)).toBe(true);
    expect(canOfficialReplyOnQa(partialChapterOfficer, otherChapter)).toBe(false);
    expect(canOfficialReplyOnQa(partialChapterOfficer, { ...question, organizationId: "org-b" })).toBe(false);
    expect(canSeeQaRecord(partialChapterOfficer, question)).toBe(true);
    expect(canSeeQaRecord(partialChapterOfficer, otherChapter)).toBe(false);

    // Actors that do carry organizationRoles keep every boolean they had.
    expect(canOfficialReplyOnQa(activeOfficer, otherChapter)).toBe(true);
    expect(canSeeQaRecord(activeOfficer, otherChapter)).toBe(true);
    expect(canSeeQaRecord(activeMember, otherChapter)).toBe(false);
  });

  it("moderates a server-shaped reply and settles one reply payload across both adapters", async () => {
    const store = createInMemoryQaStore({ clock: { now: () => Date.parse("2026-08-22T12:00:00Z") } });
    const asked = store.ask(activeMember, { title: question.title, body: question.body });
    const questionId = asked.value.id;
    const follow = store.reply(activeMember, {
      questionId,
      kind: "follow_up",
      body: "Could you also clarify the posting deadline?",
    });
    const replyId = follow.value.replies[0].id;

    // The server reply projection withholds organizationId, chapterId and the
    // author identifier; the parent question carries the scope instead.
    const serverQuestion = { id: questionId, organizationId: "org-a", chapterId: "chapter-a", authoredByMe: true };
    const serverReply = {
      id: replyId,
      questionId,
      kind: "follow_up",
      body: officialReply.body,
      authoredByMe: true,
      accepted: false,
      upvoteCount: 0,
      votedByMe: false,
      createdAt: "2026-08-20T13:00:00.000Z",
      updatedAt: "2026-08-20T13:00:00.000Z",
      deletedAt: null,
    };
    expect(Object.hasOwn(serverReply, "authorId")).toBe(false);
    expect(canModerateQa(activeMember, serverReply, serverQuestion)).toBe(true);
    expect(canModerateQa(activeMember, serverReply)).toBe(false);
    expect(canModerateQa(activeMember, { ...serverReply, authoredByMe: false }, serverQuestion)).toBe(false);
    expect(canModerateQa(activeOfficer, { ...serverReply, authoredByMe: false }, serverQuestion)).toBe(true);
    expect(canModerateQa(activeMember, { ...serverReply, organizationId: "org-a" }, serverQuestion)).toBe(true);
    expect(canModerateQa(activeMember, { ...serverReply, organizationId: "org-b" }, serverQuestion)).toBe(false);
    expect(canModerateQa(activeMember, { ...serverReply, chapterId: "chapter-b" }, serverQuestion)).toBe(false);
    expect(canModerateQa(activeMember, serverReply, { ...serverQuestion, organizationId: "org-b" })).toBe(false);
    expect(canModerateQa(activeMember, serverReply, { ...serverQuestion, chapterId: "chapter-b" })).toBe(false);

    const calls = [];
    const live = createQaRpcAdapter({ rpc: async (name, args) => { calls.push([name, args]); return { data: { name } }; } });
    const preview = createQaStoreAdapter(store, activeMember);
    const editPayload = { replyId, body: "Could you clarify the exact weekly posting deadline?" };
    const deletePayload = { replyId };

    const liveEdit = await live.editReply(editPayload);
    const previewEdit = await preview.editReply(editPayload);
    expect([liveEdit.ok, liveEdit.code]).toEqual([previewEdit.ok, previewEdit.code]);
    expect(liveEdit.ok).toBe(true);
    expect(calls.at(-1)).toEqual([QA_RPC.editReply, { p_reply_id: replyId, p_body: editPayload.body }]);
    expect(previewEdit.value.replies.every((reply) => reply.authorId === undefined)).toBe(true);

    const liveDelete = await live.deleteReply(deletePayload);
    const previewDelete = await preview.deleteReply(deletePayload);
    expect([liveDelete.ok, liveDelete.code]).toEqual([previewDelete.ok, previewDelete.code]);
    expect(liveDelete.ok).toBe(true);
    expect(calls.at(-1)).toEqual([QA_RPC.deleteReply, { p_reply_id: replyId }]);

    const missing = createQaRpcAdapter({ rpc: async () => ({ error: { code: "P0002" } }) });
    expect((await missing.editReply({ replyId: "missing", body: editPayload.body })).code)
      .toBe((await preview.editReply({ replyId: "missing", body: editPayload.body })).code);
    expect((await preview.editReply({ replyId: "missing", body: editPayload.body })).code).toBe("not_found");
    expect((await missing.deleteReply({ replyId: "missing" })).code)
      .toBe((await preview.deleteReply({ replyId: "missing" })).code);

    // The question payloads already agreed and stay untouched.
    await live.editQuestion({ questionId, title: question.title, body: question.body });
    expect(calls.at(-1)[1]).toEqual({ p_question_id: questionId, p_title: question.title, p_body: question.body });
    await live.deleteQuestion({ questionId });
    expect(calls.at(-1)[1]).toEqual({ p_question_id: questionId });
  });

  it("normalizes every text, query, vote, display-name, and copy edge", () => {
    expect(normalizeQaTitle("  A valid   question title ").value).toBe("A valid question title");
    expect(normalizeQaTitle("bad\u0007title").code).toBe("invalid_text");
    // SEC-UG-QA-INVISIBLE-TITLE-VALIDATION-20260921: characters of no
    // visible width used to count toward the eight-character floor, so a title
    // that renders as "ab" — or as nothing — passed as a real question.
    expect(normalizeQaTitle("a\u200b\u200b\u200b\u200b\u200b\u200b\u200bb").code).toBe("invalid_text");
    expect(normalizeQaTitle("\u2060".repeat(40)).code).toBe("invalid_text");
    expect(normalizeQaTitle("Dues \u202erefund policy").code).toBe("invalid_text");
    expect(normalizeQaTitle("Bargaining\ufeff update").code).toBe("invalid_text");
    expect(normalizeQaTitle("Contract\u00adquestion here").code).toBe("invalid_text");
    expect(normalizeQaTitle("Contract question\u{e0041}").code).toBe("invalid_text");
    expect(normalizeQaTitle("\u00a0\u00a0\u00a0\u00a0hi\u00a0\u00a0").code).toBe("title_too_short");
    expect(normalizeQaTitle("Preguntas sobre el \u00e9xito del contrato").ok).toBe(true);
    expect(normalizeQaTitle("Question about \u26a0\ufe0f safety gear").ok).toBe(true);
    expect(normalizeQaTitle("short").code).toBe("title_too_short");
    expect(normalizeQaTitle("x".repeat(201)).code).toBe("title_too_long");
    expect(normalizeQaBody("line one\r\nline two has enough text").value).toContain("\n");
    expect(normalizeQaBody("bad\u007fbody value").code).toBe("invalid_text");
    expect(normalizeQaBody("short").code).toBe("body_too_short");
    expect(normalizeQaBody("x".repeat(10_001)).code).toBe("body_too_long");
    expect(normalizeQaSearchQuery("  posted   schedule ").value).toBe("posted schedule");
    expect(normalizeQaSearchQuery("bad\u0001query").code).toBe("invalid_text");
    expect(normalizeQaSearchQuery("x".repeat(121)).code).toBe("search_too_long");
    expect(normalizeQaListQuery()).toEqual({ ok: true, value: { query: "", status: "all", sort: "newest" } });
    expect(normalizeQaListQuery({ status: "unknown" }).code).toBe("invalid_status");
    expect(normalizeQaListQuery({ sort: "oldest" }).code).toBe("invalid_sort");
    expect(normalizeQaListQuery({ query: "x".repeat(121) }).code).toBe("search_too_long");
    expect(normalizeQaVoteTarget("reply").ok).toBe(true);
    expect(normalizeQaVoteTarget("answer").code).toBe("invalid_vote_target");
    expect(redactQaDisplayName("")).toBe("Worker");
    expect(redactQaDisplayName("Taylor")).toBe("Taylor");
    expect(redactQaDisplayName(" Taylor middle morgan ")).toBe("Taylor M.");
    expect(qaText("es", "votes", { count: 2 })).toBe("2 votos");
    expect(qaText("fr", "missing-key")).toBe("qa.missing-key");
    expect(qaStatusLabel("en", "open")).toBe("Open");
    expect(qaStatusLabel("en", "replied")).toBe("Replied");
    expect(qaStatusLabel("en", "accepted")).toBe("Accepted");
    expect(qaStatusLabel("en", "archived")).toBe("archived");
    expect(qaFailureText("en", { code: "organization_scope_missing" })).toContain("Select an active organization");
    expect(qaFailureText("en", { code: "conflict" })).toBe("This question changed. Reload it and try again.");
    expect(qaFailureText("es", { code: "conflict" })).toContain("Vuelve a cargarla");
    expect(qaFailureText("en", { code: "body_too_short" })).toBe("Check the question details and try again.");
  });

  // DEBT-UG-QA-FAILURE-COPY-MAPS-A-CODE-NOTHING-EMITS-20260920: the
  // membership branch and the officer queue's authorization set list only codes
  // a Q&A module or the analytics dashboard actually emits.
  it("maps only membership failure codes that some module emits", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const qaDir = resolve(process.cwd(), "src/features/qa");
    const emitted = new Set();
    for (const name of readdirSync(qaDir).filter((entry) => entry.endsWith(".js"))) {
      for (const [, code] of readFileSync(resolve(qaDir, name), "utf8").matchAll(/qaFailure\(\s*"([a-z_]+)"/g)) {
        emitted.add(code);
      }
    }
    const dashboard = readFileSync(resolve(process.cwd(), "src/features/analytics/dashboard.js"), "utf8");
    for (const [, code] of dashboard.matchAll(/reason:\s*"([a-z_]+)"/g)) emitted.add(code);

    const copySource = readFileSync(resolve(qaDir, "copy.js"), "utf8");
    const branch = copySource.match(
      /\[([^\]]+)\]\.includes\(failure\?\.code\)\)\s*\{\s*return text\("membershipRequired"\)/,
    );
    expect(branch).not.toBeNull();
    const mapped = [...branch[1].matchAll(/"([a-z_]+)"/g)].map(([, code]) => code);
    for (const code of ["organization_required", "chapter_required", "organization_scope_missing"]) {
      expect(mapped).toContain(code);
    }
    expect(mapped.filter((code) => !emitted.has(code))).toEqual([]);
    for (const code of mapped) {
      expect(qaFailureText("en", { code })).toBe(qaText("en", "membershipRequired"));
      expect(qaFailureText("es", { code })).toBe(qaText("es", "membershipRequired"));
    }

    const officerSource = readFileSync(resolve(process.cwd(), "src/views/OfficerQaView.jsx"), "utf8");
    const queueCodes = officerSource.match(/AUTHORIZATION_QUEUE_CODES = new Set\(\[([^\]]+)\]\)/);
    expect(queueCodes).not.toBeNull();
    const queued = [...queueCodes[1].matchAll(/"([a-z_]+)"/g)].map(([, code]) => code);
    expect(queued).toContain("organization_scope_missing");
    expect(queued.filter((code) => !emitted.has(code))).toEqual([]);
  });

  // UX-UG-QA-SIGNED-OUT-AND-REVOKED-GATES-READ-AS-AN-OUTAGE-20260920.
  // requireActiveQaMember's first two gates are the two the member can act on:
  // sign in, or ask the chapter to restore a revoked membership. Both used to
  // fall past every branch of qaFailureText to qa.unavailable, so the member
  // read "Questions are unavailable and could not be loaded." — an outage
  // notice — and was told nothing about the action that clears the gate.
  it("names the sign-in and revoked-membership gates instead of reporting an outage", () => {
    const outage = { en: qaText("en", "unavailable"), es: qaText("es", "unavailable") };

    const signedOut = requireActiveQaMember({ ...activeMember, userId: null });
    expect(signedOut.ok).toBe(false);
    expect(signedOut.code).toBe("unauthenticated");
    const revoked = requireActiveQaMember({ ...activeMember, membershipStatus: "revoked" });
    expect(revoked.ok).toBe(false);
    expect(revoked.code).toBe("membership_revoked");

    for (const lang of ["en", "es"]) {
      const signInText = qaFailureText(lang, signedOut);
      const revokedText = qaFailureText(lang, revoked);
      // Not the outage notice, and not each other: the two gates clear by
      // different actions, so one shared string would still mislead.
      expect(signInText, `${lang} sign-in gate still reads as an outage`).not.toBe(outage[lang]);
      expect(revokedText, `${lang} revoked gate still reads as an outage`).not.toBe(outage[lang]);
      expect(revokedText).not.toBe(signInText);
      // Resolved copy, not a leaked `qa.` key from a half-added catalogue entry.
      expect(signInText).not.toMatch(/^qa\./);
      expect(revokedText).not.toMatch(/^qa\./);
    }

    expect(qaFailureText("en", signedOut)).toBe("Sign in to use worker questions.");
    expect(qaFailureText("es", signedOut)).toBe("Inicia sesión para usar las preguntas de trabajadores.");
    expect(qaFailureText("en", revoked)).toContain("campaign access is no longer active");
    expect(qaFailureText("es", revoked)).toContain("acceso a la campaña ya no está activo");
    // The neighbouring membership family keeps its own, different string.
    expect(qaFailureText("en", { code: "organization_required" })).not.toBe(qaFailureText("en", revoked));
    // An unrecognised code still falls back to the outage notice.
    expect(qaFailureText("en", { code: "boom" })).toBe(outage.en);
  });

  it("searches deleted-safe reply content and exercises every stable sort", () => {
    const older = { ...question, id: "q-a", upvoteCount: 1, createdAt: "2026-08-19T12:00:00Z" };
    const newer = {
      ...question,
      id: "q-b",
      title: "Where is the current holiday schedule?",
      status: "replied",
      upvoteCount: 5,
      createdAt: "2026-08-21T12:00:00Z",
      replies: [officialReply, { ...officialReply, id: "r-deleted", body: "secret needle", deletedAt: "2026-08-22" }],
    };
    expect(questionMatchesQaSearch(newer, "agreement")).toBe(true);
    expect(questionMatchesQaSearch(newer, "secret needle")).toBe(false);
    expect(questionMatchesQaSearch(newer, "")).toBe(true);
    expect(compareQaQuestions(older, newer, "votes")).toBeGreaterThan(0);
    expect(compareQaQuestions(older, newer, "unanswered")).toBeLessThan(0);
    expect(compareQaQuestions(older, newer, "newest")).toBeGreaterThan(0);
    expect(searchQaHistory([older, newer, { ...older, id: "gone", deletedAt: "now" }], {
      query: "holiday",
      status: "replied",
      sort: "votes",
    }).map((item) => item.id)).toEqual(["q-b"]);
    expect(searchQaHistory([older, newer], { query: "", status: "all", sort: "unanswered" })[0].id).toBe("q-a");
  });

  it("maps RPC failures and calls the complete persistence surface", async () => {
    expect(isMissingQaRpcError({ code: "PGRST202" })).toBe(true);
    expect(isMissingQaRpcError({ status: 42883 })).toBe(true);
    expect(isMissingQaRpcError(new Error("function does not exist"))).toBe(true);
    expect(isMissingQaRpcError({ code: "500" })).toBe(false);
    expect((await createQaRpcAdapter(null).list({})).code).toBe("unavailable");

    const messages = [
      { error: { code: "42501", message: "mfa required" } },
      { error: { code: "42501", message: "permission denied" } },
      { error: { message: "permission denied 42501" } },
      { error: { message: "input must be valid" } },
      { error: { message: "record not found" } },
      { error: { message: "transport exploded" } },
    ];
    const errors = createQaRpcAdapter({ rpc: vi.fn(async () => messages.shift()) });
    expect((await errors.get("q")).code).toBe("mfa_required");
    expect((await errors.get("q")).code).toBe("forbidden");
    expect((await errors.get("q")).code).toBe("forbidden");
    expect((await errors.get("q")).code).toBe("invalid_input");
    expect((await errors.get("q")).code).toBe("not_found");
    expect((await errors.get("q")).code).toBe("unavailable");
    const thrown = createQaRpcAdapter({ rpc: async () => { throw new Error("Could not find the function"); } });
    expect((await thrown.get("q")).code).toBe("unavailable");

    const calls = [];
    const api = createQaRpcAdapter({ rpc: async (name, args) => { calls.push([name, args]); return { data: { name } }; } });
    expect((await api.list({ status: "bad" })).code).toBe("invalid_status");
    expect((await api.toggleVote({ targetKind: "bad", targetId: "x" })).code).toBe("invalid_vote_target");
    await api.get("q-1");
    await api.search({ query: "schedule", status: "all", sort: "votes" });
    await api.ask({ title: question.title, body: question.body });
    await api.officialReply({ questionId: "q-1", body: officialReply.body });
    await api.followUp({ questionId: "q-1", body: "This is a member follow-up question." });
    await api.toggleVote({ targetKind: "reply", targetId: "r-1" });
    await api.accept({ questionId: "q-1", replyId: "r-1" });
    await api.editQuestion({ questionId: "q-1", title: question.title, body: question.body });
    await api.deleteQuestion({ questionId: "q-1" });
    await api.editReply({ replyId: "r-1", body: officialReply.body });
    await api.deleteReply({ replyId: "r-1" });
    await api.officerQueue();
    expect(calls).toHaveLength(12);
    expect(calls[2][1].p_idempotency_key).toBeNull();
    expect(calls.at(-1)[1]).toEqual({
      p_limit: 50,
      p_after_created_at: null,
      p_after_id: null,
    });
  });

  it("classifies RPC outages separately from deleted questions and SQLSTATE digits in message text", async () => {
    const classificationMatrix = [
      [{}, "unavailable"],
      [{ message: "" }, "unavailable"],
      [{ status: 503, message: "Service Unavailable" }, "unavailable"],
      [{ code: "P0002" }, "not_found"],
      [{ message: "that question was not found" }, "not_found"],
      [{ message: "amount 42501 rejected" }, "unavailable"],
      [{ message: "ticket 40001" }, "unavailable"],
      [{ code: "42501" }, "forbidden"],
      [{ code: "23514" }, "invalid_input"],
      [{ code: "40001" }, "conflict"],
      [{ code: "PT409" }, "conflict"],
      [{ message: "mfa required" }, "mfa_required"],
    ];
    for (const [error, code] of classificationMatrix) {
      const adapter = createQaRpcAdapter({ rpc: async () => ({ error }) });
      expect((await adapter.get("q")).code, JSON.stringify(error)).toBe(code);
    }
    expect((await createQaRpcAdapter({}).get("q")).code).toBe("unavailable");
  });

  it("covers store idempotency, edits, votes, deletion, projection, and adapters", async () => {
    const clock = { now: () => Date.parse("2026-08-22T12:00:00Z") };
    const store = createInMemoryQaStore({ clock });
    const asked = store.ask(activeMember, { ...question, idempotencyKey: "ask-key", authorDisplayName: "Taylor Morgan" });
    expect(store.ask(activeMember, { ...question, idempotencyKey: "ask-key" })).toBe(asked);
    const questionId = asked.value.id;
    expect(store.get(activeMember, "missing").code).toBe("not_found");
    expect(store.reply(activeMember, { questionId: "missing", kind: "follow_up", body: "A sufficiently long follow-up." }).code).toBe("not_found");
    expect(store.editQuestion(activeMember, { questionId: "missing", title: question.title, body: question.body }).code).toBe("not_found");
    expect(store.deleteQuestion(activeMember, { questionId: "missing" }).code).toBe("not_found");
    expect(store.editReply(activeMember, { questionId: "missing", replyId: "missing", body: question.body }).code).toBe("not_found");
    expect(store.deleteReply(activeMember, { questionId: "missing", replyId: "missing" }).code).toBe("not_found");

    const follow = store.reply(activeMember, {
      questionId,
      kind: "follow_up",
      body: "Could you also clarify the posting deadline?",
      idempotencyKey: "follow-key",
    });
    expect(store.reply(activeMember, { questionId, kind: "follow_up", body: "ignored", idempotencyKey: "follow-key" })).toBe(follow);
    const followId = follow.value.replies[0].id;
    const official = store.reply(activeOfficer, { questionId, kind: "official", body: officialReply.body });
    const officialId = official.value.replies.find((item) => item.kind === "official").id;
    expect(store.toggleVote(activeMember, { targetKind: "reply", targetId: officialId }).value.upvoteCount).toBe(1);
    expect(store.toggleVote(activeMember, { targetKind: "reply", targetId: officialId }).value.upvoteCount).toBe(0);
    expect(store.toggleVote(activeMember, { targetKind: "reply", targetId: "missing" }).code).toBe("not_found");

    expect(store.editQuestion(activeMember, {
      questionId,
      title: "When is the posted schedule considered final?",
      body: "The posted schedule has changed twice after the weekly posting deadline.",
    }).value.title).toContain("considered final");
    expect(store.editQuestion({ ...activeMember, userId: "member-b" }, { questionId, title: question.title, body: question.body }).code).toBe("forbidden");
    expect(store.editReply(activeMember, { questionId, replyId: followId, body: "Could you clarify the exact weekly posting deadline?" }).ok).toBe(true);
    expect(store.editReply(activeMember, { questionId, replyId: officialId, body: officialReply.body }).code).toBe("forbidden");
    expect(store.accept(activeMember, { questionId, replyId: officialId }).value.status).toBe("accepted");
    expect(store.accept(activeMember, { questionId, replyId: officialId }).value.status).toBe("replied");
    expect(store.deleteReply(activeMember, { questionId, replyId: officialId }).code).toBe("forbidden");
    expect(store.deleteReply(activeOfficer, { questionId, replyId: officialId }).value.status).toBe("open");
    expect(store.deleteReply(activeMember, { questionId, replyId: "missing" }).code).toBe("not_found");
    expect(store.officerQueue(activeOfficer).value.questions).toHaveLength(1);

    const item = projectQaListItem(store.get(activeMember, questionId).value);
    expect(item.preview.length).toBeLessThanOrEqual(180);
    expect(item.accepted).toBe(false);
    expect(store.deleteQuestion(activeMember, { questionId }).value).toEqual({ deleted: true, id: questionId });
    expect(store.list(activeMember, { query: "", status: "all", sort: "newest" }).value).toEqual([]);

    const secondStore = createInMemoryQaStore();
    const storeApi = createQaStoreAdapter(secondStore, activeMember);
    const viaAdapter = await storeApi.ask({ title: question.title, body: question.body });
    const viaId = viaAdapter.value.id;
    expect((await storeApi.list()).value).toHaveLength(1);
    expect((await storeApi.list({ query: "", status: "all", sort: "newest" })).value).toHaveLength(1);
    expect((await storeApi.search({ query: "schedule", status: "all", sort: "newest" })).value).toHaveLength(1);
    expect((await storeApi.get(viaId)).ok).toBe(true);
    expect((await storeApi.followUp({ questionId: viaId, body: "This is another member follow-up." })).ok).toBe(true);
    expect((await storeApi.toggleVote({ targetKind: "question", targetId: viaId })).ok).toBe(true);
    expect((await storeApi.officerQueue()).value.questions).toEqual([]);
  });
});

describe("live Q&A RPC writes normalize title and body before call", () => {
  const validTitle = "When does the posted schedule become final?";
  const validBody = "The schedule has changed twice after it was posted for the coming week.";
  const tabTitle = "When does\tthe posted schedule become final?";
  const paddedBody = `  ${validBody}  \r\n`;
  const shortTitle = "short";
  const longTitle = "x".repeat(QA_MAX_TITLE_LENGTH + 1);
  const shortBody = "too short";
  const longBody = "x".repeat(QA_MAX_BODY_LENGTH + 1);
  const expectedTitle = normalizeQaTitle(tabTitle).value;
  const expectedBody = normalizeQaBody(paddedBody, "Question").value;

  function stubRpc() {
    const rpc = vi.fn(async (name, args) => ({ data: { name, args } }));
    return { rpc, api: createQaRpcAdapter({ rpc }) };
  }

  function previewPair() {
    const store = createInMemoryQaStore();
    const memberApi = createQaStoreAdapter(store, activeMember);
    const officerApi = createQaStoreAdapter(store, activeOfficer);
    return { store, memberApi, officerApi };
  }

  const writeMethods = [
    {
      name: "ask",
      rpcName: QA_RPC.ask,
      hasTitle: true,
      hasIdempotency: true,
      live: (api, input) => api.ask(input),
      previewWrite: (pair, input) => pair.memberApi.ask(input),
      liveInput: (text) => ({ title: text.title, body: text.body, idempotencyKey: text.key }),
      previewInput: (text) => ({ title: text.title, body: text.body, idempotencyKey: text.key }),
      liveText: (args) => ({ title: args.p_title, body: args.p_body }),
      previewText: (result) => ({ title: result.value.title, body: result.value.body }),
    },
    {
      name: "officialReply",
      rpcName: QA_RPC.officialReply,
      hasTitle: false,
      hasIdempotency: true,
      live: (api, input) => api.officialReply(input),
      previewWrite: (pair, input) => pair.officerApi.officialReply(input),
      liveInput: (text, ctx) => ({
        questionId: ctx.questionId,
        body: text.body,
        idempotencyKey: text.key,
      }),
      previewInput: (text, ctx) => ({
        questionId: ctx.questionId,
        body: text.body,
        idempotencyKey: text.key,
      }),
      liveText: (args) => ({ body: args.p_body }),
      previewText: (result) => ({
        body: result.value.replies.find((item) => item.kind === "official").body,
      }),
    },
    {
      name: "followUp",
      rpcName: QA_RPC.followUp,
      hasTitle: false,
      hasIdempotency: true,
      live: (api, input) => api.followUp(input),
      previewWrite: (pair, input) => pair.memberApi.followUp(input),
      liveInput: (text, ctx) => ({
        questionId: ctx.questionId,
        body: text.body,
        idempotencyKey: text.key,
      }),
      previewInput: (text, ctx) => ({
        questionId: ctx.questionId,
        body: text.body,
        idempotencyKey: text.key,
      }),
      liveText: (args) => ({ body: args.p_body }),
      previewText: (result) => ({
        body: result.value.replies.find((item) => item.kind === "follow_up").body,
      }),
    },
    {
      name: "editQuestion",
      rpcName: QA_RPC.editQuestion,
      hasTitle: true,
      hasIdempotency: false,
      live: (api, input) => api.editQuestion(input),
      previewWrite: (pair, input) => pair.memberApi.editQuestion(input),
      liveInput: (text, ctx) => ({
        questionId: ctx.questionId,
        title: text.title,
        body: text.body,
      }),
      previewInput: (text, ctx) => ({
        questionId: ctx.questionId,
        title: text.title,
        body: text.body,
      }),
      liveText: (args) => ({ title: args.p_title, body: args.p_body }),
      previewText: (result) => ({ title: result.value.title, body: result.value.body }),
    },
    {
      name: "editReply",
      rpcName: QA_RPC.editReply,
      hasTitle: false,
      hasIdempotency: false,
      live: (api, input) => api.editReply(input),
      previewWrite: (pair, input) => pair.memberApi.editReply(input),
      liveInput: (text, ctx) => ({ replyId: ctx.replyId, body: text.body }),
      previewInput: (text, ctx) => ({
        questionId: ctx.questionId,
        replyId: ctx.replyId,
        body: text.body,
      }),
      liveText: (args) => ({ body: args.p_body }),
      previewText: (result, ctx) => ({
        body: result.value.replies.find((item) => item.id === ctx.replyId).body,
      }),
    },
  ];

  async function seedPreviewQuestion(pair, { withFollowUp = false } = {}) {
    const asked = await pair.memberApi.ask({ title: validTitle, body: validBody });
    const ctx = { questionId: asked.value.id, replyId: "r-1" };
    if (withFollowUp) {
      const follow = await pair.memberApi.followUp({
        questionId: asked.value.id,
        body: "Could you also clarify the posting deadline?",
      });
      ctx.replyId = follow.value.replies[0].id;
    }
    return ctx;
  }

  it("sends a title with an interior tab as collapsed whitespace without control characters", async () => {
    expect(expectedTitle).toBe(validTitle);
    expect(expectedTitle).not.toMatch(/\t/);
    expect(expectedBody).toBe(validBody);

    for (const method of writeMethods) {
      const { rpc, api } = stubRpc();
      const result = await method.live(api, method.liveInput({
        title: tabTitle,
        body: paddedBody,
        key: "tab-key",
      }, { questionId: "q-1", replyId: "r-1" }));
      expect(result.ok, method.name).toBe(true);
      expect(rpc, method.name).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0][0], method.name).toBe(method.rpcName);
      const text = method.liveText(rpc.mock.calls[0][1]);
      if (method.hasTitle) {
        expect(text.title, method.name).toBe(expectedTitle);
        expect(text.title, method.name).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\t]/);
      }
      expect(text.body, method.name).toBe(expectedBody);
    }
  });

  it("returns field-specific length failures and never calls rpc", async () => {
    const lengthCases = [
      { title: shortTitle, body: validBody, code: "title_too_short", titleOnly: true },
      { title: longTitle, body: validBody, code: "title_too_long", titleOnly: true },
      { title: validTitle, body: shortBody, code: "body_too_short", titleOnly: false },
      { title: validTitle, body: longBody, code: "body_too_long", titleOnly: false },
    ];
    expect(shortTitle.length).toBeLessThan(QA_MIN_TITLE_LENGTH);
    expect(shortBody.length).toBeLessThan(QA_MIN_BODY_LENGTH);

    for (const method of writeMethods) {
      for (const sample of lengthCases) {
        if (sample.titleOnly && !method.hasTitle) continue;
        const { rpc, api } = stubRpc();
        const result = await method.live(api, method.liveInput({
          title: sample.title,
          body: sample.body,
          key: "invalid-key",
        }, { questionId: "q-1", replyId: "r-1" }));
        expect(result.ok, `${method.name} ${sample.code}`).toBe(false);
        expect(result.code, `${method.name} ${sample.code}`).toBe(sample.code);
        expect(rpc, `${method.name} ${sample.code}`).not.toHaveBeenCalled();
      }
    }
  });

  it("matches preview-store normalized text and validation outcomes", async () => {
    const samples = [
      { title: tabTitle, body: paddedBody, expectOk: true },
      { title: shortTitle, body: validBody, expectOk: false, code: "title_too_short", titleOnly: true },
      { title: longTitle, body: validBody, expectOk: false, code: "title_too_long", titleOnly: true },
      { title: validTitle, body: shortBody, expectOk: false, code: "body_too_short" },
      { title: validTitle, body: longBody, expectOk: false, code: "body_too_long" },
    ];

    for (const method of writeMethods) {
      for (const sample of samples) {
        if (sample.titleOnly && !method.hasTitle) continue;
        const { rpc, api } = stubRpc();
        const pair = previewPair();
        const ctx = await seedPreviewQuestion(pair, { withFollowUp: method.name === "editReply" });
        const liveInput = method.liveInput({
          title: sample.title,
          body: sample.body,
          key: `${method.name}-live`,
        }, ctx);
        const previewInput = method.previewInput({
          title: sample.title,
          body: sample.body,
          key: `${method.name}-preview`,
        }, ctx);
        const liveResult = await method.live(api, liveInput);
        const previewResult = await method.previewWrite(pair, previewInput);
        expect(liveResult.ok, `${method.name} live ok`).toBe(sample.expectOk);
        expect(previewResult.ok, `${method.name} preview ok`).toBe(sample.expectOk);
        if (sample.expectOk) {
          expect(rpc, method.name).toHaveBeenCalledTimes(1);
          expect(method.liveText(rpc.mock.calls[0][1])).toEqual(
            method.previewText(previewResult, ctx),
          );
        } else {
          expect(liveResult.code, `${method.name} live ${sample.code}`).toBe(sample.code);
          expect(previewResult.code, `${method.name} preview ${sample.code}`).toBe(sample.code);
          expect(rpc, `${method.name} ${sample.code}`).not.toHaveBeenCalled();
        }
      }
    }
  });

  it("forwards p_idempotency_key byte-identical to the caller value", async () => {
    const key = "idempotency-key/ask-01";
    for (const method of writeMethods.filter((item) => item.hasIdempotency)) {
      const { rpc, api } = stubRpc();
      const result = await method.live(api, method.liveInput({
        title: validTitle,
        body: validBody,
        key,
      }, { questionId: "q-1", replyId: "r-1" }));
      expect(result.ok, method.name).toBe(true);
      expect(rpc.mock.calls[0][1].p_idempotency_key, method.name).toBe(key);
    }
  });
});

describe("CR-018 Q&A interaction coverage", () => {
  it("covers list loading, retry, filters, opening, cancel, and failed/successful asks", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<MemberQaForum actor={activeMember} state="loading" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading questions");
    rerender(<MemberQaForum actor={activeMember} state="error" error="offline" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();

    const onSearch = vi.fn();
    const onOpen = vi.fn();
    const onAsk = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce({ ok: true });
    rerender(<MemberQaForum actor={activeMember} questions={[question]} onSearch={onSearch} onOpen={onOpen} onAsk={onAsk} />);
    fireEvent.change(screen.getByLabelText("Search questions"), { target: { value: "schedule" } });
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "votes" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${question.title}`) }));
    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));
    expect(onSearch).toHaveBeenLastCalledWith({ query: "schedule", sort: "votes", status: "open" });
    expect(onOpen).toHaveBeenCalledWith("q-1");

    fireEvent.click(screen.getByRole("button", { name: "Ask a question" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask a question" }));
    fireEvent.change(screen.getByLabelText("Question title"), { target: { value: question.title } });
    fireEvent.change(screen.getByLabelText("Details"), { target: { value: question.body } });
    fireEvent.click(screen.getByRole("button", { name: "Post question" }));
    await waitFor(() => expect(onAsk).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Question title")).toHaveValue(question.title);
    fireEvent.click(await screen.findByRole("button", { name: "Post question" }, { timeout: 5000 }));
    await waitFor(() => expect(screen.queryByLabelText("Question title")).not.toBeInTheDocument());
  });

  it("covers detail back, voting, accepting, and officer/member reply paths", async () => {
    const selected = { ...question, status: "replied", replies: [officialReply] };
    const onBack = vi.fn();
    const onVote = vi.fn().mockResolvedValue({ ok: true });
    const onAccept = vi.fn().mockResolvedValue({ ok: true });
    const onFollowUp = vi.fn().mockResolvedValue(false);
    const { rerender } = render(
      <MemberQaForum actor={activeMember} selectedQuestion={selected} onBack={onBack} onVote={onVote} onAccept={onAccept} onFollowUp={onFollowUp} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "All questions" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Upvote/ })[0]);
    await waitFor(() => expect(onVote).toHaveBeenCalledWith({ targetKind: "question", targetId: "q-1", voted: true }));
    fireEvent.click(screen.getByRole("button", { name: "Accept answer" }));
    await waitFor(() => expect(onAccept).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Add a follow-up"), { target: { value: "Please clarify the exact deadline." } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(onFollowUp).toHaveBeenCalled());
    expect(screen.getByLabelText("Add a follow-up")).toHaveValue("Please clarify the exact deadline.");

    const onOfficialReply = vi.fn().mockResolvedValue({ ok: true });
    rerender(<MemberQaForum actor={activeOfficer} selectedQuestion={selected} onOfficialReply={onOfficialReply} />);
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: officialReply.body } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(onOfficialReply).toHaveBeenCalled());
    expect(screen.getByLabelText("Post official reply")).toHaveValue("");
  });

  it("keys reply drafts to the current question without erasing current input", async () => {
    const first = { ...question, id: "q-draft-first", status: "replied", replies: [officialReply] };
    const second = { ...question, id: "q-draft-second", title: "When is the next schedule posted?", status: "replied", replies: [officialReply] };
    const onOfficialReply = vi.fn().mockResolvedValue(false);
    const { rerender } = render(
      <MemberQaForum actor={activeOfficer} selectedQuestion={first} onOfficialReply={onOfficialReply} />,
    );

    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: "Draft for the first question." } });
    expect(screen.getByLabelText("Post official reply")).toHaveValue("Draft for the first question.");

    rerender(<MemberQaForum actor={activeOfficer} selectedQuestion={second} onOfficialReply={onOfficialReply} />);
    expect(screen.getByLabelText("Post official reply")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: "Draft for the second question." } });
    await waitFor(() => expect(screen.getByLabelText("Post official reply")).toHaveValue("Draft for the second question."));

    rerender(<MemberQaForum actor={activeOfficer} selectedQuestion={first} onOfficialReply={onOfficialReply} />);
    expect(screen.getByLabelText("Post official reply")).toHaveValue("");
  });

  it("does not let a completed reply for the previous question clear the current draft", async () => {
    const first = { ...question, id: "q-submit-first", status: "replied", replies: [officialReply] };
    const second = { ...question, id: "q-submit-second", title: "How do I update my contact details?", status: "replied", replies: [officialReply] };
    let resolveReply;
    const onOfficialReply = vi.fn(() => new Promise((resolve) => { resolveReply = resolve; }));
    const { rerender } = render(
      <MemberQaForum actor={activeOfficer} selectedQuestion={first} onOfficialReply={onOfficialReply} />,
    );

    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: "Submitted reply for the first question." } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(onOfficialReply).toHaveBeenCalledTimes(1));

    rerender(<MemberQaForum actor={activeOfficer} selectedQuestion={second} onOfficialReply={onOfficialReply} />);
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: "Current draft for the second question." } });
    resolveReply({ ok: true });

    await waitFor(() => expect(screen.getByLabelText("Post official reply")).toHaveValue("Current draft for the second question."));
  });

  it("preserves newer text entered while the current reply is submitting", async () => {
    let resolveReply;
    const onOfficialReply = vi.fn(() => new Promise((resolve) => { resolveReply = resolve; }));
    render(<MemberQaForum actor={activeOfficer} selectedQuestion={question} onOfficialReply={onOfficialReply} />);

    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: "Reply currently being submitted." } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(onOfficialReply).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: "Newer draft written while sending." } });
    resolveReply({ ok: true });

    await waitFor(() => expect(screen.getByLabelText("Post official reply")).toHaveValue("Newer draft written while sending."));
  });

  it("BUG-UG-MEMBER-QA-REPLY-DRAFT-RESET-RACE-20260902 preserves new-question input while delayed passive cleanup is released", async () => {
    const first = { ...question, id: "q-passive-cleanup-first", status: "replied", replies: [officialReply] };
    const second = { ...question, id: "q-passive-cleanup-second", title: "When is the next schedule posted?", status: "replied", replies: [officialReply] };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<MemberQaForum actor={activeOfficer} selectedQuestion={first} onOfficialReply={vi.fn()} />);
      });

      passiveEffectGate.begin();
      await act(async () => {
        root.render(<MemberQaForum actor={activeOfficer} selectedQuestion={second} onOfficialReply={vi.fn()} />);
        await Promise.resolve();
      });

      // The second question has committed while its dependency-triggered
      // passive callbacks are held explicitly. Enter text before releasing
      // those callbacks, rather than relying on a timer scheduling race.
      expect(container.querySelector("h1")).toHaveTextContent(second.title);
      expect(passiveEffectGate.pending.length).toBeGreaterThan(0);
      const draft = container.querySelector("#qa-official-reply");
      fireEvent.change(draft, { target: { value: "Keep this draft for the new question." } });
      await act(async () => { passiveEffectGate.release(); });

      expect(draft).toHaveValue("Keep this draft for the new question.");
    } finally {
      if (passiveEffectGate.hold) {
        await act(async () => { passiveEffectGate.release(); });
      }
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it("covers the officer queue loading, retry, open, busy, false result, and empty states", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<OfficerQaQueue actor={activeOfficer} state="loading" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    rerender(<OfficerQaQueue actor={activeOfficer} state="error" error="offline" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
    rerender(<OfficerQaQueue actor={activeOfficer} questions={[]} />);
    expect(screen.getByText("No open questions in your scope.")).toBeInTheDocument();

    const onOpen = vi.fn();
    let settleFirstReply;
    const firstReply = new Promise((resolve) => { settleFirstReply = resolve; });
    const onReply = vi.fn().mockReturnValueOnce(firstReply).mockResolvedValueOnce({ ok: true });
    rerender(<OfficerQaQueue actor={activeOfficer} questions={[question]} onOpen={onOpen} onReply={onReply} />);
    fireEvent.click(screen.getByRole("button", { name: question.title }));
    expect(onOpen).toHaveBeenCalledWith("q-1");
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: officialReply.body } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
    // Pending, not natively disabled (record 8435).
    expect(screen.getByRole("button", { name: "Posting…" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Post official reply")).toHaveValue(officialReply.body);
    // Invocation alone does not settle the request or commit its busy state.
    // Exercise that boundary explicitly before attempting the false-result retry.
    await act(async () => { settleFirstReply(false); await firstReply; });
    const retryReply = await screen.findByRole("button", { name: "Post reply" });
    expect(retryReply).toBeEnabled();
    expect(screen.getByLabelText("Post official reply")).toHaveValue(officialReply.body);
    fireEvent.click(retryReply);
    await waitFor(() => expect(screen.getByLabelText("Post official reply")).toHaveValue(""));
    expect(onReply).toHaveBeenCalledTimes(2);
  });

  it("drives member and officer view success and failure refresh paths", async () => {
    const memberApi = {
      list: vi.fn().mockResolvedValue({ ok: true, value: { questions: [question] } }),
      get: vi.fn().mockResolvedValue({ ok: true, value: { ...question, status: "replied", replies: [officialReply] } }),
      ask: vi.fn()
        .mockResolvedValueOnce({ ok: false, message: "ask failed" })
        .mockResolvedValueOnce({ ok: true, value: { id: question.id } }),
      toggleVote: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      accept: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      followUp: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      officialReply: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    const { unmount } = render(<MemberQaView actor={activeMember} client={null} api={memberApi} />);
    await screen.findByRole("button", { name: new RegExp(`^${question.title}`) });
    fireEvent.change(screen.getByLabelText("Search questions"), { target: { value: "schedule" } });
    await waitFor(() => expect(memberApi.list).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${question.title}`) }));
    expect(await screen.findByRole("heading", { name: question.title })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Upvote/ })[0]);
    await waitFor(() => expect(memberApi.toggleVote).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Accept answer" }));
    await waitFor(() => expect(memberApi.accept).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Add a follow-up"), { target: { value: "Please clarify the posting deadline." } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(memberApi.followUp).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "All questions" }));
    await screen.findByRole("button", { name: new RegExp(`^${question.title}`) });
    fireEvent.click(screen.getByRole("button", { name: "Ask a question" }));
    fireEvent.change(screen.getByLabelText("Question title"), { target: { value: question.title } });
    fireEvent.change(screen.getByLabelText("Details"), { target: { value: question.body } });
    fireEvent.click(screen.getByRole("button", { name: "Post question" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't confirm it was saved. Check before retrying.");
    expect(screen.getByLabelText("Question title")).toHaveValue(question.title);
    expect(screen.getByLabelText("Details")).toHaveValue(question.body);
    const firstAskKey = memberApi.ask.mock.calls[0][0].idempotencyKey;
    fireEvent.click(screen.getByRole("button", { name: "Post question" }));
    await waitFor(() => expect(memberApi.ask).toHaveBeenCalledTimes(2));
    expect(memberApi.ask.mock.calls[1][0].idempotencyKey).toBe(firstAskKey);
    await screen.findByRole("heading", { name: question.title });
    unmount();

    const officerMemberApi = {
      ...memberApi,
      list: vi.fn().mockResolvedValue({ ok: true, value: [question] }),
      get: vi.fn().mockResolvedValue({ ok: true, value: { ...question, status: "replied", replies: [officialReply] } }),
      officialReply: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    const officerMemberView = render(<MemberQaView actor={activeOfficer} client={null} api={officerMemberApi} />);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${question.title}`) }));
    await screen.findByRole("heading", { name: question.title });
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: officialReply.body } });
    await waitFor(() => expect(screen.getByLabelText("Post official reply")).toHaveValue(officialReply.body));
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(officerMemberApi.officialReply).toHaveBeenCalled());
    officerMemberView.unmount();

    const officerApi = {
      officerQueue: vi.fn().mockResolvedValueOnce({ ok: true, value: { questions: [question] } }).mockResolvedValue({ ok: true, value: [] }),
      officialReply: vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, message: "reply failed" }),
    };
    const view = render(<OfficerQaView actor={activeOfficer} client={null} api={officerApi} embedded onOpenQuestion={vi.fn()} />);
    await screen.findByText(question.body);
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: officialReply.body } });
    await waitFor(() => expect(screen.getByLabelText("Post official reply")).toHaveValue(officialReply.body));
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(officerApi.officerQueue).toHaveBeenCalledTimes(2));
    view.unmount();

    const failingOfficerApi = {
      officerQueue: vi.fn().mockResolvedValue({ ok: true, value: [question] }),
      officialReply: vi.fn().mockResolvedValue({ ok: false, message: "reply failed" }),
    };
    render(<OfficerQaView actor={activeOfficer} client={null} api={failingOfficerApi} />);
    await screen.findByText(question.body);
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: officialReply.body } });
    await waitFor(() => expect(screen.getByLabelText("Post official reply")).toHaveValue(officialReply.body));
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't confirm it was saved. Check before retrying.");
    expect(screen.getByLabelText("Post official reply")).toHaveValue(officialReply.body);
  });
});

describe("CR-018 reply ordering", () => {
  it("puts accepted and official replies first with stable date and id fallbacks", () => {
    const replies = [
      { ...officialReply, id: "c", kind: "follow_up", accepted: false, createdAt: "2026-08-20T14:00:00Z" },
      { ...officialReply, id: "b", accepted: false, createdAt: "2026-08-20T13:00:00Z" },
      { ...officialReply, id: "a", accepted: true, createdAt: "2026-08-20T15:00:00Z" },
    ];
    expect(sortQaReplies(replies).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

// Record 8435: Q&A writes keep focus on their control while they run, and a
// second activation in the same tick starts no second write.
describe("Q&A writes while one runs", () => {
  const selected = () => ({ ...question, status: "replied", replies: [officialReply] });

  it("keeps Accept answer focused while it is accepted, and accepts once", async () => {
    const onAccept = vi.fn(async () => ({ ok: true }));
    render(<MemberQaForum actor={activeMember} selectedQuestion={selected()} onVote={vi.fn()} onAccept={onAccept} onFollowUp={vi.fn()} />);
    await expectHeldWriteFocus(onAccept, screen.getByRole("button", { name: "Accept answer" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("starts one forum write when Upvote and Accept answer are activated in one tick", async () => {
    const onVote = vi.fn(async () => ({ ok: true }));
    const onAccept = vi.fn(async () => ({ ok: true }));
    render(<MemberQaForum actor={activeMember} selectedQuestion={selected()} onVote={onVote} onAccept={onAccept} onFollowUp={vi.fn()} />);
    const upvote = screen.getAllByRole("button", { name: /Upvote/ })[0];
    const accept = screen.getByRole("button", { name: "Accept answer" });
    await expectOneWriteFromOneTick([onVote, onAccept], [() => fireEvent.click(upvote), () => fireEvent.click(upvote), () => fireEvent.click(accept)]);
  });

  const openQueue = (onReply) => {
    render(<OfficerQaQueue actor={activeOfficer} questions={[question]} onOpen={vi.fn()} onReply={onReply} />);
    fireEvent.click(screen.getByRole("button", { name: question.title }));
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: officialReply.body } });
    return screen.getByRole("button", { name: "Post reply" });
  };

  it("keeps the queue's Post reply focused while the reply is posted, and posts once", async () => {
    const onReply = vi.fn(async () => ({ ok: true }));
    await expectHeldWriteFocus(onReply, openQueue(onReply));
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it("sends no forum official reply for an empty draft, even on a direct submit", () => {
    const onOfficialReply = vi.fn(async () => ({ ok: true }));
    render(<MemberQaForum actor={activeOfficer} selectedQuestion={selected()} onOfficialReply={onOfficialReply} />);
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: "   " } });
    fireEvent.submit(screen.getByLabelText("Post official reply").closest("form"));
    expect(onOfficialReply).not.toHaveBeenCalled();
  });

  it("sends no official reply for a draft under 12 characters, even on a direct submit", () => {
    const onReply = vi.fn(async () => ({ ok: true }));
    const post = openQueue(onReply);
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: "Too short" } });
    expect(post).toBeDisabled();
    fireEvent.submit(post.closest("form"));
    expect(onReply).not.toHaveBeenCalled();
  });

  it("posts one official reply when Post reply is activated twice in one tick", async () => {
    const onReply = vi.fn(async () => ({ ok: true }));
    const post = openQueue(onReply);
    await expectOneWriteFromOneTick(onReply, [() => fireEvent.click(post), () => fireEvent.click(post)]);
  });
});

