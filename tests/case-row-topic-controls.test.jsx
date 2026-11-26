import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
// REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043):
// the chapter's leadership and a case's assigned steward each get one switch
// for case topics in lists; nobody else sees a control, and the rows show the
// topic only where the server marks it shown.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ChapterAccessPanel } from "../src/features/chapterAccess/ChapterAccessPanel.jsx";
import { CaseRowTopicCaseControl, CaseRowTopicChapterControl } from "../src/features/chapterAccess/CaseRowTopicControls.jsx";
import { createChapterAccessApi, createGrievancePrivacyApi } from "../src/lib/chapterAccessApi.js";

const wrap = (node, lang = "en") => <LanguageProvider lang={lang}>{node}</LanguageProvider>;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe("chapter case-topic switch", () => {
  it("lets leadership turn case topics on and shows the saved state", async () => {
    let enabled = false;
    const api = {
      caseRowTopicPolicy: vi.fn(async () => ({ chapterId: "ch", enabled, canChange: true })),
      setCaseRowTopicPolicy: vi.fn(async (_chapter, next) => { enabled = next; }),
    };
    render(wrap(<CaseRowTopicChapterControl api={api} chapterId="ch" />));
    const box = await screen.findByLabelText("Show issue topics in this campaign’s issue lists and search results");
    expect(box).not.toBeChecked();
    expect(screen.getByText(/Off by default/)).toBeInTheDocument();
    await expectHeldWriteFocus(api.setCaseRowTopicPolicy, box);
    await waitFor(() => expect(box).toBeChecked());
    expect(api.setCaseRowTopicPolicy).toHaveBeenCalledWith("ch", true);
    expect(api.caseRowTopicPolicy).toHaveBeenCalledTimes(2);
  });

  it("says it in Spanish, reports a failed save and keeps the saved state", async () => {
    const api = {
      caseRowTopicPolicy: vi.fn(async () => ({ enabled: true, canChange: true })),
      setCaseRowTopicPolicy: vi.fn(async () => { throw new Error("refused"); }),
    };
    render(wrap(<CaseRowTopicChapterControl api={api} chapterId="ch" />, "es"));
    const box = await screen.findByLabelText("Mostrar los temas de los asuntos en las listas y búsquedas de esta campaña");
    expect(screen.getByRole("heading", { name: "Temas de los asuntos en las listas" })).toBeInTheDocument();
    fireEvent.click(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron guardar los cambios. Inténtalo de nuevo.");
    expect(box).toBeChecked();
    expect(api.caseRowTopicPolicy).toHaveBeenCalledTimes(1);
  });

  // #7059 gate r2s1/r4s1: the save went through, only the re-read failed.
  it("shows the saved state and a reload error when the re-read after a save fails", async () => {
    const api = {
      caseRowTopicPolicy: vi.fn().mockResolvedValueOnce({ chapterId: "ch", enabled: false, canChange: true }).mockRejectedValueOnce(new Error("offline")),
      setCaseRowTopicPolicy: vi.fn(async () => undefined),
    };
    render(wrap(<CaseRowTopicChapterControl api={api} chapterId="ch" />));
    const box = await screen.findByLabelText("Show issue topics in this campaign’s issue lists and search results");
    fireEvent.click(box);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your change was saved, but the current setting could not be reloaded. Refresh to check it.");
    expect(alert).not.toHaveTextContent("could not be saved");
    expect(box).toBeChecked();
    expect(box).not.toBeDisabled();
  });

  it("shows nothing to a caller the server refuses, or without the switch API", async () => {
    const api = { caseRowTopicPolicy: vi.fn(async () => { throw Object.assign(new Error("no"), { code: "42501" }); }), setCaseRowTopicPolicy: vi.fn() };
    const view = render(wrap(<CaseRowTopicChapterControl api={api} chapterId="ch" />));
    await act(async () => {});
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    view.rerender(wrap(<CaseRowTopicChapterControl api={{}} chapterId="ch" />));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("sits in the chapter access panel for leadership", async () => {
    const workspace = {
      policy: { steward_grievances: true, steward_breadth: "campaign" }, members: [], units: [], committees: [], grants: [], roles: [], settings: [], grantableRoles: [],
    };
    const client = { rpc: vi.fn(async (name) => ({ data: name === "get_chapter_access_workspace" ? workspace : name === "get_chapter_case_row_topic" ? { enabled: false, canChange: true } : { updated: true }, error: null })) };
    render(wrap(<ChapterAccessPanel client={client} chapterId="ch" />));
    fireEvent.click(await screen.findByLabelText("Show issue topics in this campaign’s issue lists and search results"));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("set_chapter_case_row_topic", { p_chapter: "ch", p_enabled: true }));
    expect(client.rpc).toHaveBeenCalledWith("get_chapter_case_row_topic", { p_chapter: "ch" });
  });
});

describe("steward case-topic switch", () => {
  it("lets the assigned steward show the case's topic in their own lists", async () => {
    let shown = false;
    const api = {
      loadCaseRowTopic: vi.fn(async () => ({ shown, chapterShown: false, canChange: true })),
      setCaseRowTopic: vi.fn(async (_case, next) => { shown = next; }),
    };
    render(wrap(<CaseRowTopicCaseControl api={api} caseId="c1" />));
    const box = await screen.findByLabelText("Show this issue’s topic in my own issue lists");
    expect(screen.getByText("Only your own lists change. Other people see what the campaign setting allows. Restricted and private-identity issues stay neutral.")).toBeInTheDocument();
    await expectHeldWriteFocus(api.setCaseRowTopic, box);
    await waitFor(() => expect(box).toBeChecked());
    expect(api.setCaseRowTopic).toHaveBeenCalledWith("c1", true);
  });

  it("says when the chapter already shows topics, in Spanish", async () => {
    const api = { loadCaseRowTopic: vi.fn(async () => ({ shown: false, chapterShown: true, canChange: true })), setCaseRowTopic: vi.fn() };
    render(wrap(<CaseRowTopicCaseControl api={api} caseId="c1" />, "es"));
    await screen.findByLabelText("Mostrar el tema de este asunto en mis propias listas de asuntos");
    expect(screen.getByText("Tu campaña muestra los temas de los asuntos en las listas. Los asuntos restringidos y los de identidad privada siguen neutros.")).toBeInTheDocument();
  });

  // #7059 gate r4g1: the chapter-on note never replaces the neutrality warning.
  it("keeps the restricted and private-identity warning beside the chapter-on note", async () => {
    const api = { loadCaseRowTopic: vi.fn(async () => ({ shown: true, chapterShown: true, canChange: true })), setCaseRowTopic: vi.fn() };
    render(wrap(<CaseRowTopicCaseControl api={api} caseId="c1" />));
    await screen.findByLabelText("Show this issue’s topic in my own issue lists");
    expect(screen.getByText("Your campaign shows issue topics in lists. Restricted and private-identity issues stay neutral.")).toBeInTheDocument();
  });

  it("keeps the steward's choice and says only the re-read failed, or says a refused save changed nothing", async () => {
    const api = {
      loadCaseRowTopic: vi.fn().mockResolvedValueOnce({ shown: false, chapterShown: false, canChange: true }).mockRejectedValueOnce(new Error("offline")),
      setCaseRowTopic: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("refused")),
    };
    render(wrap(<CaseRowTopicCaseControl api={api} caseId="c1" />));
    const box = await screen.findByLabelText("Show this issue’s topic in my own issue lists");
    fireEvent.click(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your change was saved, but the current setting could not be reloaded.");
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Changes could not be saved. Try again."));
    expect(box).toBeChecked();
    expect(api.setCaseRowTopic).toHaveBeenLastCalledWith("c1", false);
    expect(api.loadCaseRowTopic).toHaveBeenCalledTimes(2);
  });

  it("shows nothing to a reader who is not the case's steward", async () => {
    const api = { loadCaseRowTopic: vi.fn(async () => ({ shown: false, chapterShown: false, canChange: false })), setCaseRowTopic: vi.fn() };
    render(wrap(<CaseRowTopicCaseControl api={api} caseId="c1" />));
    await act(async () => {});
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("ignores a previous case's late answer", async () => {
    const first = deferred();
    const api = {
      loadCaseRowTopic: vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue({ shown: false, chapterShown: false, canChange: true }),
      setCaseRowTopic: vi.fn(),
    };
    const view = render(wrap(<CaseRowTopicCaseControl api={api} caseId="old" />));
    view.rerender(wrap(<CaseRowTopicCaseControl api={api} caseId="new" />));
    const box = await screen.findByRole("checkbox");
    await act(async () => first.resolve({ shown: true, chapterShown: false, canChange: true }));
    expect(box).not.toBeChecked();
  });
});

describe("case-topic switch API", () => {
  it("calls the four switch RPCs with their arguments", async () => {
    const client = { rpc: vi.fn(async () => ({ data: { updated: true }, error: null })) };
    const api = createChapterAccessApi(client);
    await api.caseRowTopicPolicy("ch");
    await api.setCaseRowTopicPolicy("ch", true);
    await api.caseRowTopic("c1");
    await api.setCaseRowTopic("c1", false);
    expect(client.rpc.mock.calls).toEqual([
      ["get_chapter_case_row_topic", { p_chapter: "ch" }],
      ["set_chapter_case_row_topic", { p_chapter: "ch", p_enabled: true }],
      ["get_case_row_topic", { p_case: "c1" }],
      ["set_case_row_topic", { p_case: "c1", p_shown: false }],
    ]);
    const steward = createGrievancePrivacyApi(client);
    await steward.loadCaseRowTopic("c2");
    await steward.setCaseRowTopic("c2", true);
    expect(client.rpc).toHaveBeenLastCalledWith("set_case_row_topic", { p_case: "c2", p_shown: true });
    await expect(createChapterAccessApi({ rpc: async () => ({ data: null, error: { message: "no", code: "42501" } }) }).setCaseRowTopic("c", true)).rejects.toThrow();
  });
});
