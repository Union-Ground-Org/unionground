import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildQaActor } from "../src/lib/mi1QaWiring.js";
import { MemberQaView } from "../src/views/MemberQaView.jsx";
import { OfficerQaView } from "../src/views/OfficerQaView.jsx";
import { VoiceView } from "../src/views/VoiceView.jsx";
import { createInMemoryQaStore, createQaStoreAdapter } from "../src/features/qa/index.js";

function wrap(node) {
  return render(<LanguageProvider lang="en">{node}</LanguageProvider>);
}

function wrapLang(lang, node) {
  return render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
}

const languageToggleOfficer = buildQaActor({
  userId: "steward-lang",
  organizationId: "org-officer-lang",
  chapterId: "chapter-officer-lang",
  organizationRoles: ["steward"],
  mfaSatisfied: true,
  selectedHat: "steward",
});

function languageToggleQuestion(id, title) {
  return {
    id,
    organizationId: "org-officer-lang",
    chapterId: "chapter-officer-lang",
    authorId: "member-a",
    authorDisplayName: "Taylor M.",
    title,
    body: `${title} details for the officer queue.`,
    status: "open",
    replies: [],
  };
}

function officerQueuePage(id, title, next = null) {
  return {
    ok: true,
    value: {
      questions: [languageToggleQuestion(id, title)],
      nextAfterCreatedAt: next ? next.createdAt : null,
      nextAfterId: next ? next.id : null,
    },
  };
}

describe("officer Q&A language toggle keeps paging", () => {
  it("keeps appended pages and does not refetch when language changes", async () => {
    const api = {
      officerQueue: vi.fn(async (cursor) => (
        cursor
          ? officerQueuePage("q-page-two", "Page two seniority")
          : officerQueuePage("q-page-one", "Page one overtime", { createdAt: "2026-08-20T12:00:00.000Z", id: "q-page-one" })
      )),
      officialReply: vi.fn(),
    };
    const view = wrapLang("en", <OfficerQaView lang="en" actor={languageToggleOfficer} client={null} api={api} />);
    expect(await screen.findByText("Page one overtime")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more questions" }));
    expect(await screen.findByText("Page two seniority")).toBeInTheDocument();
    expect(screen.getByText("Page one overtime")).toBeInTheDocument();
    expect(api.officerQueue).toHaveBeenCalledTimes(2);

    view.rerender(
      <LanguageProvider lang="es">
        <OfficerQaView lang="es" actor={languageToggleOfficer} client={null} api={api} />
      </LanguageProvider>,
    );

    expect(screen.getByText("Page one overtime")).toBeInTheDocument();
    expect(screen.getByText("Page two seniority")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more questions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cargar más preguntas" })).not.toBeInTheDocument();
    expect(api.officerQueue).toHaveBeenCalledTimes(2);
  });

  it("re-labels a queue failure in the new language without another officerQueue call", async () => {
    const api = {
      officerQueue: vi.fn().mockResolvedValue({ ok: false, code: "unavailable" }),
      officialReply: vi.fn(),
    };
    const view = wrapLang("en", <OfficerQaView lang="en" actor={languageToggleOfficer} client={null} api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Questions are unavailable and could not be loaded.");
    expect(api.officerQueue).toHaveBeenCalledTimes(1);

    view.rerender(
      <LanguageProvider lang="es">
        <OfficerQaView lang="es" actor={languageToggleOfficer} client={null} api={api} />
      </LanguageProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Las preguntas no están disponibles y no se pudieron cargar.");
    expect(screen.queryByText("Questions are unavailable and could not be loaded.")).not.toBeInTheDocument();
    expect(api.officerQueue).toHaveBeenCalledTimes(1);
  });

  it("re-labels the saved-reply notice without a refetch", async () => {
    const api = {
      officerQueue: vi.fn().mockResolvedValue(officerQueuePage("q-reply", "Schedule question")),
      officialReply: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    const view = wrapLang("en", <OfficerQaView lang="en" actor={languageToggleOfficer} client={null} api={api} />);
    expect(await screen.findByText("Schedule question")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Post official reply"), {
      target: { value: "The posted schedule becomes final at the printed deadline." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Changes saved.");
    await waitFor(() => expect(api.officerQueue).toHaveBeenCalledTimes(2));
    expect(api.officialReply).toHaveBeenCalledTimes(1);

    view.rerender(
      <LanguageProvider lang="es">
        <OfficerQaView lang="es" actor={languageToggleOfficer} client={null} api={api} />
      </LanguageProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Cambios guardados.");
    expect(screen.queryByText("Changes saved.")).not.toBeInTheDocument();
    expect(screen.getByText("Schedule question")).toBeInTheDocument();
    expect(api.officerQueue).toHaveBeenCalledTimes(2);
  });
});

describe("CR-018 QA web surfaces", () => {
  it("keeps member Q&A honest when persistence is missing", async () => {
    wrap(<MemberQaView actor={buildQaActor({ userId: "user-a", chapterId: "ch-a" })} client={null} />);
    expect(await screen.findByText(/not wired yet|unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText("When does overtime start")).not.toBeInTheDocument();
  });

  it("keeps the officer queue honest when persistence is missing", async () => {
    wrap(<OfficerQaView actor={buildQaActor({
      userId: "steward-a",
      organizationId: "11111111-1111-4111-8111-111111111111",
      chapterId: "ch-a",
      roles: ["steward"],
      organizationRoles: ["steward"],
      mfaSatisfied: true,
      selectedHat: "steward",
    })} client={null} />);
    expect(await screen.findByText(/not wired yet|unavailable/i)).toBeInTheDocument();
  });

  it("runs the explicit fixture through the session-only adapter", async () => {
    const actor = buildQaActor({
      userId: "preview-member",
      organizationId: "preview-qa-organization",
      chapterId: "preview-chapter",
      mfaSatisfied: true,
    });
    const api = createQaStoreAdapter(createInMemoryQaStore(), actor);
    wrap(<MemberQaView actor={actor} client={null} api={api} />);
    expect(await screen.findByText("No questions yet. Ask the first one for this campaign.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask a question" }));
    fireEvent.change(screen.getByLabelText("Question title"), {
      target: { value: "When is the next chapter meeting?" },
    });
    fireEvent.change(screen.getByLabelText("Details"), {
      target: { value: "I want to confirm the date and location for the next chapter meeting." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post question" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "When is the next chapter meeting?" })).toBeInTheDocument());
    expect(screen.getByText(/confirm the date and location/)).toBeInTheDocument();
  });

  it("opens Q&A from Be heard without inventing weekly threads", () => {
    const onOpenQa = vi.fn();
    wrap(<VoiceView onOpenQa={onOpenQa} onMessageSteward={() => {}} threads={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Q&A" }));
    expect(onOpenQa).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Nothing yet. What you send through the Guide shows up here.")).toBeInTheDocument();
  });
});

describe("BUG-UG-QA-RETRIES-REUSE-IDEMPOTENCY-KEYS-AFTER-CONTENT-CHANGES-20260920", () => {
  const organizationId = "preview-qa-organization";
  const member = buildQaActor({ userId: "member-a", organizationId, chapterId: "chapter-a", mfaSatisfied: true });
  const steward = buildQaActor({
    userId: "steward-a",
    organizationId,
    chapterId: "chapter-a",
    roles: ["steward"],
    organizationRoles: ["steward"],
    mfaSatisfied: true,
    selectedHat: "steward",
  });
  const seedTitle = "When is the next chapter meeting?";
  const seedBody = "I want to confirm the date and location for the next chapter meeting.";

  // The server commits the first two attempts but the client never sees the
  // acknowledgement, then the third attempt's response arrives.
  function loseResponses(api, method, count = 2) {
    const real = api[method];
    const keys = [];
    let lost = 0;
    api[method] = vi.fn(async (input) => {
      keys.push(input.idempotencyKey);
      const result = await real(input);
      if (lost < count) {
        lost += 1;
        return { ok: false, code: "network", message: "lost response" };
      }
      return result;
    });
    return keys;
  }

  function seedQuestion(store) {
    return store.ask(member, { title: seedTitle, body: seedBody, idempotencyKey: "seed" }).value.id;
  }

  async function submitTwiceThenEdit(label, button, original, edited) {
    fireEvent.change(screen.getByLabelText(label), { target: { value: original } });
    fireEvent.click(screen.getByRole("button", { name: button }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(screen.getByRole("button", { name: button })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText(label), { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: button }));
  }

  function expectReuseThenRotation(keys) {
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  }

  it("member question: same content reuses the key, an edited retry rotates it and posts the edit", async () => {
    const store = createInMemoryQaStore();
    const api = createQaStoreAdapter(store, member);
    const keys = loseResponses(api, "ask");
    wrap(<MemberQaView actor={member} client={null} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask a question" }));
    fireEvent.change(screen.getByLabelText("Details"), { target: { value: seedBody } });
    await submitTwiceThenEdit("Question title", "Post question", seedTitle, "When is the October chapter meeting?");
    expect(await screen.findByRole("heading", { name: "When is the October chapter meeting?" })).toBeInTheDocument();
    expectReuseThenRotation(keys);
    const listed = await createQaStoreAdapter(store, member).list({});
    expect((Array.isArray(listed.value) ? listed.value : listed.value.questions).map((row) => row.title).sort())
      .toEqual(["When is the October chapter meeting?", seedTitle]);
  });

  it("member follow-up: same content reuses the key, an edited retry rotates it and posts the edit", async () => {
    const store = createInMemoryQaStore();
    const questionId = seedQuestion(store);
    const api = createQaStoreAdapter(store, member);
    const keys = loseResponses(api, "followUp");
    wrap(<MemberQaView actor={member} client={null} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${seedTitle}`) }));
    await screen.findByRole("heading", { name: seedTitle });
    await submitTwiceThenEdit("Add a follow-up", "Post reply", "Is it still at the union hall?", "Is it still at the union hall downtown?");
    expect(await screen.findByText("Is it still at the union hall downtown?")).toBeInTheDocument();
    expectReuseThenRotation(keys);
    expect(store.get(member, questionId).value.replies.map((reply) => reply.body))
      .toEqual(["Is it still at the union hall?", "Is it still at the union hall downtown?"]);
  });

  it("member official reply: same content reuses the key, an edited retry rotates it and posts the edit", async () => {
    const store = createInMemoryQaStore();
    const questionId = seedQuestion(store);
    const api = createQaStoreAdapter(store, steward);
    const keys = loseResponses(api, "officialReply");
    wrap(<MemberQaView actor={steward} client={null} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${seedTitle}`) }));
    await screen.findByRole("heading", { name: seedTitle });
    await submitTwiceThenEdit("Post official reply", "Post reply", "The meeting is on the first Tuesday.", "The meeting is on the second Tuesday.");
    expect(await screen.findByText("The meeting is on the second Tuesday.")).toBeInTheDocument();
    expectReuseThenRotation(keys);
    expect(store.get(steward, questionId).value.replies.map((reply) => reply.body))
      .toEqual(["The meeting is on the first Tuesday.", "The meeting is on the second Tuesday."]);
  });

  it("officer reply: same content reuses the key, an edited retry rotates it and posts the edit", async () => {
    const store = createInMemoryQaStore();
    const questionId = seedQuestion(store);
    const api = createQaStoreAdapter(store, steward);
    const keys = loseResponses(api, "officialReply");
    wrap(<OfficerQaView actor={steward} client={null} api={api} />);
    await screen.findByText(seedBody);
    await submitTwiceThenEdit("Post official reply", "Post reply", "The meeting is on the first Tuesday.", "The meeting is on the second Tuesday.");
    expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
    expectReuseThenRotation(keys);
    expect(store.get(steward, questionId).value.replies.map((reply) => reply.body))
      .toEqual(["The meeting is on the first Tuesday.", "The meeting is on the second Tuesday."]);
  });
});

// #9462 (M2-17's web twin): a failed post with no known cause said questions
// "could not be loaded"; it is a write whose outcome is unknown.
describe("Q&A writes do not report a failed load", () => {
  const organizationId = "preview-qa-organization";
  const member = buildQaActor({ userId: "member-a", organizationId, chapterId: "chapter-a", mfaSatisfied: true });
  const lost = { ok: false, code: "unavailable", message: "Q&A is unavailable." };

  it.each([
    ["en", "We couldn't confirm it was saved. Check before retrying."],
    ["es", "No pudimos confirmar que se guardó. Revisa antes de reintentar."],
  ])("member question in %s", async (lang, sentence) => {
    const api = createQaStoreAdapter(createInMemoryQaStore(), member);
    api.ask = vi.fn(async () => lost);
    wrapLang(lang, <MemberQaView lang={lang} actor={member} client={null} api={api} />);
    const es = lang === "es";
    fireEvent.click(await screen.findByRole("button", { name: es ? "Hacer una pregunta" : "Ask a question" }));
    fireEvent.change(screen.getByLabelText(es ? "Título de la pregunta" : "Question title"), { target: { value: "When is the next chapter meeting?" } });
    fireEvent.change(screen.getByLabelText(es ? "Detalles" : "Details"), { target: { value: "I want to confirm the date and location for the meeting." } });
    fireEvent.click(screen.getByRole("button", { name: es ? "Publicar pregunta" : "Post question" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
  });

  it("officer reply", async () => {
    const steward = buildQaActor({ userId: "steward-a", organizationId, chapterId: "chapter-a", roles: ["steward"], organizationRoles: ["steward"], mfaSatisfied: true, selectedHat: "steward" });
    const store = createInMemoryQaStore();
    store.ask(member, { title: "When is the next chapter meeting?", body: "I want to confirm the date and location for the meeting.", idempotencyKey: "seed" });
    const api = createQaStoreAdapter(store, steward);
    api.officialReply = vi.fn(async () => lost);
    wrap(<OfficerQaView actor={steward} client={null} api={api} />);
    await screen.findByText("I want to confirm the date and location for the meeting.");
    fireEvent.change(screen.getByLabelText("Post official reply"), { target: { value: "The meeting is on the first Tuesday." } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't confirm it was saved.");
  });
});

const queueOfficer = buildQaActor({
  userId: "steward-a",
  organizationId: "org-a",
  chapterId: "chapter-a",
  organizationRoles: ["steward"],
  mfaSatisfied: true,
  selectedHat: "steward",
});

const queuePage = (id, title, next = null) => ({
  ok: true,
  value: {
    questions: [{
      id,
      organizationId: "org-a",
      chapterId: "chapter-a",
      authorId: "member-a",
      authorDisplayName: "Taylor M.",
      title,
      body: `${title} — the officer needs this row to survive a failed reread.`,
      status: "open",
      replies: [],
    }],
    nextAfterCreatedAt: next ? next.createdAt : null,
    nextAfterId: next ? next.id : null,
  },
});

describe("officer Q&A queue keeps its place when a reread fails", () => {
  it("keeps the loaded page and shows an inline alert when Load more fails", async () => {
    const api = {
      officerQueue: vi.fn()
        .mockResolvedValueOnce(queuePage("q-1", "Page one question", { createdAt: "2026-08-20T12:00:00.000Z", id: "q-1" }))
        .mockResolvedValue({ ok: false, code: "unavailable" }),
      officialReply: vi.fn(),
    };
    wrap(<OfficerQaView actor={queueOfficer} client={null} api={api} />);
    await screen.findByText(/Page one question —/);
    fireEvent.click(screen.getByRole("button", { name: "Load more questions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Questions are unavailable and could not be loaded.");
    expect(screen.getByText(/Page one question —/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more questions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-qa-surface='officer-queue']")).not.toBeNull();
  });

  it("retires the answered row and keeps the rest when the reread after a reply fails", async () => {
    const firstPage = queuePage("q-1", "Answered question");
    firstPage.value.questions.push(queuePage("q-2", "Still waiting").value.questions[0]);
    const api = {
      officerQueue: vi.fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValue({ ok: false, code: "unavailable" }),
      officialReply: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    wrap(<OfficerQaView actor={queueOfficer} client={null} api={api} />);
    await screen.findByText(/Answered question —/);
    fireEvent.change(document.getElementById("qa-officer-q-1"), {
      target: { value: "The posted schedule becomes final at the printed deadline." },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Post reply" })[0]);
    await waitFor(() => expect(api.officerQueue).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("Questions are unavailable and could not be loaded.");
    expect(screen.getByRole("status")).toHaveTextContent("Changes saved");
    expect(screen.queryByText(/Answered question —/)).not.toBeInTheDocument();
    expect(screen.getByText(/Still waiting —/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(api.officialReply).toHaveBeenCalledTimes(1);
  });

  it.each(["forbidden", "mfa_required"])("clears the loaded queue when Load more fails with %s", async (code) => {
    const api = {
      officerQueue: vi.fn()
        .mockResolvedValueOnce(queuePage("q-1", "Page one question", { createdAt: "2026-08-20T12:00:00.000Z", id: "q-1" }))
        .mockResolvedValue({ ok: false, code }),
      officialReply: vi.fn(),
    };
    wrap(<OfficerQaView actor={queueOfficer} client={null} api={api} />);
    await screen.findByText(/Page one question —/);
    fireEvent.click(screen.getByRole("button", { name: "Load more questions" }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(/Page one question —/)).not.toBeInTheDocument();
    expect(document.querySelector("[data-qa-surface='officer-queue']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more questions" })).not.toBeInTheDocument();
  });

  it("clears the queue when the reread after a reply is forbidden", async () => {
    const api = {
      officerQueue: vi.fn()
        .mockResolvedValueOnce(queuePage("q-1", "Page one question"))
        .mockResolvedValue({ ok: false, code: "forbidden" }),
      officialReply: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    wrap(<OfficerQaView actor={queueOfficer} client={null} api={api} />);
    await screen.findByText(/Page one question —/);
    fireEvent.change(screen.getByLabelText("Post official reply"), {
      target: { value: "The posted schedule becomes final at the printed deadline." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(api.officerQueue).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(/Page one question —/)).not.toBeInTheDocument();
    expect(document.querySelector("[data-qa-surface='officer-queue']")).toBeNull();
  });

  it("shows the full error card with retry when the first load fails", async () => {
    const api = {
      officerQueue: vi.fn().mockResolvedValue({ ok: false, code: "unavailable" }),
      officialReply: vi.fn(),
    };
    wrap(<OfficerQaView actor={queueOfficer} client={null} api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Questions are unavailable and could not be loaded.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(document.querySelector("[data-qa-surface='officer-queue']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more questions" })).not.toBeInTheDocument();
  });

  it("keeps the full error card when retry from an empty queue fails", async () => {
    const api = {
      officerQueue: vi.fn().mockResolvedValue({ ok: false, code: "unavailable" }),
      officialReply: vi.fn(),
    };
    wrap(<OfficerQaView actor={queueOfficer} client={null} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.officerQueue).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent("Questions are unavailable and could not be loaded.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(document.querySelector("[data-qa-surface='officer-queue']")).toBeNull();
  });
});

