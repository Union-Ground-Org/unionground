import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
// BUG-UG-CASE-PRIVACY-AND-TOPIC-SWITCHES-VANISH-ON-A-FAILED-READ-20261125
//: a case's identity-privacy switch and the
// case-topic switches rendered nothing when their first read failed, so a
// failed read looked like a case without the switch. A refusal for role or
// scope and an older backend without the call still show nothing; any other
// failed read says so and offers Try again. The privacy switch also tells a
// failed save from a failed re-read after a confirmed save. Fictional data.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { GrievanceIdentityControl } from "../src/features/chapterAccess/GrievanceIdentityControl.jsx";
import { CaseRowTopicCaseControl, CaseRowTopicChapterControl } from "../src/features/chapterAccess/CaseRowTopicControls.jsx";
import { MemberApiError } from "../src/lib/memberApiError.js";
import { createChapterAccessApi, createGrievancePrivacyApi } from "../src/lib/chapterAccessApi.js";

const wrap = (node, lang = "en") => <LanguageProvider lang={lang}>{node}</LanguageProvider>;
const offline = () => new MemberApiError("get_grievance_identity_visibility", { message: "Failed to fetch" });
const refusal = (code) => new MemberApiError("get_grievance_identity_visibility", { message: "case unavailable", code });

// A read whose outcome the test switches between calls; held by mockImplementation, never a queued Once value.
function switchableRead(first) {
  let outcome = first;
  const read = vi.fn(async () => { if (outcome instanceof Error) throw outcome; return outcome; });
  return { read, next: (value) => { outcome = value; } };
}

const IDENTITY_LOAD_ERROR = "The setting that hides the worker’s identity from other committee members could not be loaded.";

describe("a case's identity-privacy switch after a failed read", () => {
  it("says the setting could not be loaded and keeps focus on Try again while it reads again", async () => {
    const { read, next } = switchableRead(offline());
    const api = { loadIdentityVisibility: read, setIdentityPrivate: vi.fn() };
    render(wrap(<GrievanceIdentityControl api={api} caseId="case-maple-14" />));
    expect(await screen.findByRole("alert")).toHaveTextContent(IDENTITY_LOAD_ERROR);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    next({ canChange: true, private: true });
    await expectHeldWriteFocus(read, screen.getByRole("button", { name: "Try again" }));
    const box = await screen.findByRole("checkbox", { name: "Hide the worker’s identity from other committee members" });
    expect(box).toBeChecked();
    // The switch replaces Try again and takes its focus.
    expect(box).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledWith("case-maple-14");
  });

  it("says it in Spanish", async () => {
    const api = { loadIdentityVisibility: vi.fn(async () => { throw offline(); }), setIdentityPrivate: vi.fn() };
    render(wrap(<GrievanceIdentityControl api={api} caseId="case-maple-14" />, "es"));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar el ajuste que oculta la identidad del trabajador a otros miembros del comité.");
    expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeEnabled();
  });

  it.each([
    ["a refusal for role or scope", refusal("42501")],
    ["a facade refusal", refusal("not_authorized")],
    ["an older backend without the call", refusal("PGRST202")],
  ])("still shows nothing after %s", async (_label, failure) => {
    const api = { loadIdentityVisibility: vi.fn(async () => { throw failure; }), setIdentityPrivate: vi.fn() };
    const { container } = render(wrap(<GrievanceIdentityControl api={api} caseId="case-maple-14" />));
    await act(async () => {});
    await act(async () => {});
    expect(api.loadIdentityVisibility).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it("hides the switch when the read again is refused", async () => {
    const { read, next } = switchableRead(offline());
    const api = { loadIdentityVisibility: read, setIdentityPrivate: vi.fn() };
    const { container } = render(wrap(<GrievanceIdentityControl api={api} caseId="case-maple-14" />));
    const retry = await screen.findByRole("button", { name: "Try again" });
    next(refusal("42501"));
    fireEvent.click(retry);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("reports a failed re-read after a confirmed save as a reload error and shows the saved state", async () => {
    const { read, next } = switchableRead({ canChange: true, private: false });
    const api = { loadIdentityVisibility: read, setIdentityPrivate: vi.fn(async () => { next(offline()); }) };
    render(wrap(<GrievanceIdentityControl api={api} caseId="case-maple-14" />));
    const box = await screen.findByRole("checkbox");
    fireEvent.click(box);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your change was saved, but the current setting could not be reloaded. Refresh to check it.");
    expect(alert).not.toHaveTextContent("could not be saved");
    expect(box).toBeChecked();
    expect(api.setIdentityPrivate).toHaveBeenCalledWith("case-maple-14", true);
  });
});

describe("the case-topic switches after a failed read", () => {
  it("says a case's own topic setting could not be loaded and shows it after Try again", async () => {
    const { read, next } = switchableRead(new MemberApiError("get_case_row_topic", { message: "upstream timeout", code: "57014" }));
    const api = { loadCaseRowTopic: read, setCaseRowTopic: vi.fn() };
    render(wrap(<CaseRowTopicCaseControl api={api} caseId="case-maple-14" />));
    expect(await screen.findByRole("alert")).toHaveTextContent("The setting that shows this issue’s topic in your own issue lists could not be loaded.");
    next({ shown: true, chapterShown: false, canChange: true });
    await expectHeldWriteFocus(read, screen.getByRole("button", { name: "Try again" }));
    const box = await screen.findByRole("checkbox", { name: "Show this issue’s topic in my own issue lists" });
    expect(box).toBeChecked();
    expect(box).toHaveFocus();
  });

  it("says the chapter's case-topic setting could not be loaded, under its heading, in Spanish", async () => {
    const api = { caseRowTopicPolicy: vi.fn(async () => { throw new MemberApiError("get_chapter_case_row_topic", { message: "Failed to fetch" }); }), setCaseRowTopicPolicy: vi.fn() };
    render(wrap(<CaseRowTopicChapterControl api={api} chapterId="chapter-birch" />, "es"));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar el ajuste de la campaña para los temas de los asuntos.");
    expect(screen.getByRole("heading", { name: "Temas de los asuntos en las listas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeEnabled();
  });

  it("still shows nothing to a caller outside the role", async () => {
    const api = { loadCaseRowTopic: vi.fn(async () => { throw refusal("42501"); }), setCaseRowTopic: vi.fn() };
    const { container } = render(wrap(<CaseRowTopicCaseControl api={api} caseId="case-maple-14" />));
    await act(async () => {});
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
});

//: a refusal can arrive as an HTTP status with no code. The
// production wrapper keeps that status on the error it throws, so the switch
// still shows nothing; any other status is a failed read and says so.
describe("the production wrapper's status-only answers", () => {
  const clientAnswering = (status) => ({ rpc: vi.fn(async () => ({ data: null, error: { message: status === 403 ? "Forbidden" : "Not Found" }, status })) });

  it.each([403, 404])("keeps a status-only %i on the wrapped error", async (status) => {
    const failure = await createChapterAccessApi(clientAnswering(status)).identityVisibility("case-maple-14").catch((caught) => caught);
    expect(failure).toBeInstanceOf(MemberApiError);
    expect(failure.code).toBeNull();
    expect(failure.status).toBe(status);
  });

  it.each([403, 404])("shows no privacy or topic switch after a status-only %i through createGrievancePrivacyApi", async (status) => {
    const client = clientAnswering(status);
    const api = createGrievancePrivacyApi(client);
    const { container } = render(wrap(<><GrievanceIdentityControl api={api} caseId="case-maple-14" /><CaseRowTopicCaseControl api={api} caseId="case-maple-14" /></>));
    await act(async () => {});
    await act(async () => {});
    expect(client.rpc).toHaveBeenCalledWith("get_grievance_identity_visibility", { p_case: "case-maple-14" });
    expect(client.rpc).toHaveBeenCalledWith("get_case_row_topic", { p_case: "case-maple-14" });
    expect(container).toBeEmptyDOMElement();
  });

  it("says a status-only 503 is a failed read", async () => {
    const api = createGrievancePrivacyApi({ rpc: vi.fn(async () => ({ data: null, error: { message: "Service Unavailable" }, status: 503 })) });
    render(wrap(<GrievanceIdentityControl api={api} caseId="case-maple-14" />));
    expect(await screen.findByRole("alert")).toHaveTextContent(IDENTITY_LOAD_ERROR);
  });
});

//  and its scope lock, in the shared switch.
describe("the shared case switch's retry", () => {
  const heldRead = (value) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    return { run: async () => { await gate; if (value instanceof Error) throw value; return value; }, release: () => release() };
  };

  it("leaves focus where the person moved it, during the retry or after its read landed", async () => {
    for (const moveAfterLanding of [false, true]) {
      const slow = heldRead({ canChange: true, private: false });
      const read = vi.fn().mockRejectedValueOnce(offline()).mockImplementation(slow.run);
      const view = render(wrap(<><button type="button">Elsewhere</button><GrievanceIdentityControl api={{ loadIdentityVisibility: read, setIdentityPrivate: vi.fn() }} caseId="case-maple-14" /></>));
      const retry = await screen.findByRole("button", { name: "Try again" });
      const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
      retry.focus();
      fireEvent.click(retry);
      if (!moveAfterLanding) elsewhere.focus();
      await act(async () => {
        slow.release();
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        if (moveAfterLanding) { expect(retry).toHaveFocus(); elsewhere.focus(); }
      });
      expect(await screen.findByRole("checkbox")).toBeInTheDocument();
      expect(elsewhere).toHaveFocus();
      view.unmount();
    }
  });

  it("lets the next case's Try again read while a retry for the case the person left is still running", async () => {
    const slow = heldRead({ canChange: true, private: true });
    const read = vi.fn(async (caseId) => {
      if (caseId === "case-maple-14" && read.mock.calls.length === 2) return slow.run();
      throw offline();
    });
    const api = { loadIdentityVisibility: read, setIdentityPrivate: vi.fn() };
    const view = render(wrap(<GrievanceIdentityControl api={api} caseId="case-maple-14" />));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    view.rerender(wrap(<GrievanceIdentityControl api={api} caseId="case-oak-2" />));
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(retry).not.toHaveAttribute("aria-disabled");
    fireEvent.click(retry);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(4);
    expect(read).toHaveBeenLastCalledWith("case-oak-2");
    await act(async () => { slow.release(); });
    await act(async () => {});
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

