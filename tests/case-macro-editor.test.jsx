// @vitest-environment jsdom
// The macro editor (/m/coordinator/macros) is the only surface that writes a
// macro, and its action rows are the one place the client has to mirror
// private.casework_macro_actions_valid exactly. The lane shipped it with no
// test of its own; these cover every action kind, the add/remove path, the
// empty and failed loads, and the two save outcomes. Union Ground issues
// have no grievance procedure (owner decision, 2026-10-13), so the editor
// offers no advance_step action and reads no procedure.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseMacroEditor } from "../src/components/CaseMacroEditor.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberApiError } from "../src/lib/memberApi.js";
import { catalogue } from "../src/lib/i18n.js";

const t = (key, vars = {}) => {
  const value = catalogue.en[key];
  if (value === undefined) throw new Error(`missing en key: ${key}`);
  return value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
};

const SAVED = {
  id: "macro-1",
  name: "Resolve and note",
  chapterId: "wor",
  active: true,
  actions: [{ kind: "set_status", status: "resolved" }],
};

// get_staff_roster's shape: the whole organization's staff, each with the
// roles they hold. The editor is what filters it down to a steward list and a
// coordinator list, so the fixture carries a member with no role at all.
const STAFF = [
  { userId: "u-steward", fullName: "Ana Ruiz", roles: ["steward"] },
  { userId: "u-coordinator", fullName: "Ben Cho", roles: ["coordinator"] },
  { userId: "u-both", fullName: "Cy Ode", roles: ["steward", "coordinator"] },
  { userId: "u-member", fullName: "Dee Park", roles: [] },
];

// The action kinds the editor offers. advance_step is the server's step kind;
// Union Ground does not offer it.
const OFFERED_KINDS = ["set_status", "assign", "add_note", "add_alert"];

// listProcedures is a spy only: an API that still carries the procedure read
// must never be asked for it.
const pickers = () => ({
  loadStaffCandidates: vi.fn().mockResolvedValue(STAFF),
  listProcedures: vi.fn(),
});

function mount(api, chapterId = "wor") {
  return render(
    <LanguageProvider lang="en">
      <CaseMacroEditor api={api} chapterId={chapterId} onNotice={api.onNotice || (() => {})} />
    </LanguageProvider>,
  );
}

// A new draft opens on a status action, which a save can post as it stands.
const draftReady = () => waitFor(() => expect(screen.getByLabelText(t("caseBulk.nextStatus"))).toBeInTheDocument());
const chooseStatus = (value = "active") => fireEvent.change(screen.getByLabelText(t("caseBulk.nextStatus")), { target: { value } });

afterEach(() => { vi.restoreAllMocks(); });

describe("case macro editor", () => {
  it("renders nothing at all when the plane does not expose the macro read", () => {
    const { container } = mount({});
    expect(container.querySelector(".case-macros")).toBeNull();
  });

  it("lists saved macros with their scope, action count, and inactive marker", async () => {
    mount({
      ...pickers(),
      listMacros: vi.fn().mockResolvedValue([
        SAVED,
        { id: "macro-2", name: "Close and notify", chapterId: null, active: false, actions: [{ kind: "set_status" }, { kind: "add_note" }] },
      ]),
      saveMacro: vi.fn(),
    });
    expect(await screen.findByText("Resolve and note")).toBeInTheDocument();
    expect(screen.getByText(t("caseMacros.chapterScoped"))).toBeInTheDocument();
    expect(screen.getByText(t("caseMacros.organizationScoped"))).toBeInTheDocument();
    expect(screen.getByText(t("caseBulk.macroActionCount", { count: 2 }))).toBeInTheDocument();
    expect(screen.getByText(t("caseMacros.inactive"))).toBeInTheDocument();
  });

  // UX-UG-CASE-MACRO-LIST-REFUSED-READ-READS-AS-EMPTY-ORG-20260920. A
  // refused list used to write [] into the same slot the empty sentence
  // reads, so the coordinator saw both the failure and "no macros yet" with
  // no way to retry.
  it("shows the load failure without the empty sentence or the loading line", async () => {
    mount({ ...pickers(), listMacros: vi.fn().mockRejectedValue(new Error("nope")), saveMacro: vi.fn() });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("caseMacros.loadFailed"));
    expect(screen.queryByText(t("caseMacros.empty"))).toBeNull();
    expect(screen.queryByText(t("caseMacros.loading"))).toBeNull();
    expect(screen.getByRole("button", { name: t("app.tryAgain") })).toBeInTheDocument();
  });

  it("retries the list read and drops the alert and the retry control on success", async () => {
    const listMacros = vi.fn()
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce([
        SAVED,
        { id: "macro-2", name: "Close and notify", chapterId: null, active: false, actions: [{ kind: "set_status" }, { kind: "add_note" }] },
      ]);
    mount({ ...pickers(), listMacros, saveMacro: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: t("app.tryAgain") }));
    expect(await screen.findByText("Resolve and note")).toBeInTheDocument();
    expect(screen.getByText("Close and notify")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: t("app.tryAgain") })).toBeNull();
    expect(listMacros).toHaveBeenCalledTimes(2);
  });

  it("still names a genuinely empty organization", async () => {
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro: vi.fn() });
    expect(await screen.findByText(t("caseMacros.empty"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("app.tryAgain") })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not grow a list retry from a save refusal", async () => {
    const listMacros = vi.fn().mockResolvedValue([]);
    const saveMacro = vi.fn().mockRejectedValue(new Error("macro actions are not a valid ordered action list"));
    mount({ ...pickers(), listMacros, saveMacro });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await waitFor(() => expect(document.querySelector(".case-macros__actions li")).toBeTruthy());
    await draftReady();
    fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "Bad" } });
    chooseStatus();
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("app.tryAgain") })).toBeNull();
    expect(listMacros).toHaveBeenCalledTimes(1);
  });

  // Switching the kind must rebuild the row from blankAction, or a leftover
  // field from the previous kind travels to the server inside the action.
  it("offers the fields each action kind actually needs", async () => {
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    const row = () => document.querySelector(".case-macros__actions li");
    await waitFor(() => expect(row()).toBeTruthy());
    const kind = () => within(row()).getByLabelText(t("caseMacros.actionKind"));

    // set_status is the default. The kind menu offers no advance_step, and no
    // row grows a step menu or the step outcome field.
    expect([...kind().querySelectorAll("option")].map((option) => option.value)).toEqual(OFFERED_KINDS);
    expect(within(row()).getByLabelText(t("caseBulk.nextStatus"))).toBeInTheDocument();
    // Each row carries exactly the controls its kind needs (the kind menu
    // included), so no step menu or step outcome rides along.
    const controls = () => row().querySelectorAll("select, textarea, input").length;
    const noStepControls = () => {
      expect(row().querySelector("optgroup")).toBeNull();
      expect(within(row()).queryByText(t("caseMacros.chooseStep"))).toBeNull();
    };
    noStepControls();
    expect(controls()).toBe(2);

    fireEvent.change(kind(), { target: { value: "assign" } });
    await waitFor(() => expect(within(row()).getByLabelText(t("caseMacros.stewardId"))).toBeInTheDocument());
    expect(within(row()).getByLabelText(t("caseMacros.coordinatorId"))).toBeInTheDocument();
    expect(controls()).toBe(3);

    fireEvent.change(kind(), { target: { value: "add_note" } });
    await waitFor(() => expect(within(row()).getByLabelText(t("caseNotes.staffNoteLabel"))).toBeInTheDocument());
    expect(controls()).toBe(2);

    fireEvent.change(kind(), { target: { value: "add_alert" } });
    await waitFor(() => expect(within(row()).getByLabelText(t("caseMacros.alertKind"))).toBeInTheDocument());
    expect(within(row()).getByLabelText(t("caseMacros.severity"))).toBeInTheDocument();
    expect(within(row()).getByLabelText(t("caseMacros.alertMessage"))).toBeInTheDocument();
    expect(controls()).toBe(4);
    noStepControls();
  });

  // Every field of every kind, typed rather than defaulted: the editor is the
  // only client mirror of private.casework_macro_actions_valid, so each control
  // has to reach the payload.
  it("carries every field of every action kind into the saved macro", async () => {
    const saveMacro = vi.fn().mockResolvedValue({});
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await waitFor(() => expect(document.querySelector(".case-macros__actions li")).toBeTruthy());
    for (let index = 1; index < OFFERED_KINDS.length; index += 1) fireEvent.click(screen.getByRole("button", { name: t("caseMacros.addAction") }));
    await waitFor(() => expect(document.querySelectorAll(".case-macros__actions li")).toHaveLength(OFFERED_KINDS.length));

    const rows = () => [...document.querySelectorAll(".case-macros__actions li")];
    OFFERED_KINDS.forEach((kind, index) => {
      fireEvent.change(within(rows()[index]).getByLabelText(t("caseMacros.actionKind")), { target: { value: kind } });
    });
    await waitFor(() => expect(within(rows()[3]).getByLabelText(t("caseMacros.alertMessage"))).toBeInTheDocument());
    await waitFor(() => expect(within(rows()[1]).getByRole("option", { name: "Ana Ruiz" })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "Everything" } });
    fireEvent.change(within(rows()[0]).getByLabelText(t("caseBulk.nextStatus")), { target: { value: "active" } });
    fireEvent.change(within(rows()[1]).getByLabelText(t("caseMacros.stewardId")), { target: { value: "u-both" } });
    fireEvent.change(within(rows()[1]).getByLabelText(t("caseMacros.coordinatorId")), { target: { value: "u-coordinator" } });
    fireEvent.change(within(rows()[2]).getByLabelText(t("caseNotes.staffNoteLabel")), { target: { value: "Macro filed the packet." } });
    fireEvent.change(within(rows()[3]).getByLabelText(t("caseMacros.alertKind")), { target: { value: "safety" } });
    fireEvent.change(within(rows()[3]).getByLabelText(t("caseMacros.severity")), { target: { value: "critical" } });
    fireEvent.change(within(rows()[3]).getByLabelText(t("caseMacros.alertMessage")), { target: { value: "Safety review required." } });
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));

    await waitFor(() => expect(saveMacro).toHaveBeenCalledTimes(1));
    expect(saveMacro.mock.calls[0][0].actions).toEqual([
      { kind: "set_status", status: "active" },
      { kind: "assign", stewardId: "u-both", coordinatorId: "u-coordinator" },
      { kind: "add_note", body: "Macro filed the packet." },
      { kind: "add_alert", alertKind: "safety", severity: "critical", message: "Safety review required." },
    ]);
  });

  it("adds and removes actions, and hides the remove control on the last one", async () => {
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await waitFor(() => expect(document.querySelectorAll(".case-macros__actions li")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: t("caseMacros.removeAction") })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.addAction") }));
    await waitFor(() => expect(document.querySelectorAll(".case-macros__actions li")).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: t("caseMacros.removeAction") })[1]);
    await waitFor(() => expect(document.querySelectorAll(".case-macros__actions li")).toHaveLength(1));
  });

  it("sends the chapter scope, trimmed name and cleaned actions, then reloads and announces", async () => {
    const onNotice = vi.fn();
    const listMacros = vi.fn().mockResolvedValue([]);
    const saveMacro = vi.fn().mockResolvedValue({ id: "macro-9" });
    mount({ ...pickers(), listMacros, saveMacro, onNotice });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await waitFor(() => expect(document.querySelector(".case-macros__actions li")).toBeTruthy());

    await draftReady();
    fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "  Escalate  " } });
    chooseStatus();
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));

    await waitFor(() => expect(saveMacro).toHaveBeenCalledTimes(1));
    expect(saveMacro).toHaveBeenCalledWith({
      id: null,
      chapterId: "wor",
      name: "Escalate",
      actions: [{ kind: "set_status", status: "active" }],
      active: true,
    });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(t("caseMacros.saved")));
    expect(listMacros).toHaveBeenCalledTimes(2);
  });

  it("edits an existing macro in place, keeps its id, and can deactivate it", async () => {
    const saveMacro = vi.fn().mockResolvedValue(SAVED);
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([SAVED]), saveMacro });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.edit") }));
    await waitFor(() => expect(screen.getByLabelText(t("caseMacros.name"))).toHaveValue("Resolve and note"));
    fireEvent.click(screen.getByLabelText(t("caseMacros.activeLabel")));
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    await waitFor(() => expect(saveMacro).toHaveBeenCalledWith(expect.objectContaining({ id: "macro-1", active: false })));
  });

  // An organization-wide macro is the admin path: chapterId comes through as
  // null rather than as an empty string the server would have to interpret.
  it("sends a null chapter when the desk has no chapter of its own", async () => {
    const saveMacro = vi.fn().mockResolvedValue({});
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro }, null);
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await waitFor(() => expect(document.querySelector(".case-macros__actions li")).toBeTruthy());
    await draftReady();
    fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "Org wide" } });
    chooseStatus();
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    await waitFor(() => expect(saveMacro).toHaveBeenCalledWith(expect.objectContaining({ chapterId: null })));
  });

  // BUG-UG-CASEWORK-PANELS-RAW-DRIVER-ERROR-TEXT-20260920: the server
  // sentence (SQLSTATE 22023 wording included) is untranslated internal text;
  // the failure line now stays catalogue copy like every other refusal.
  it("shows the generic catalogue sentence when the server refuses the save", async () => {
    const saveMacro = vi.fn().mockRejectedValue(new Error("macro actions are not a valid ordered action list"));
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await waitFor(() => expect(document.querySelector(".case-macros__actions li")).toBeTruthy());
    await draftReady();
    fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "Bad" } });
    chooseStatus();
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    expect(await screen.findByText(t("caseMacros.saveFailed"))).toBeInTheDocument();
    // The draft stays open so the coordinator can repair it.
    expect(screen.getByLabelText(t("caseMacros.name"))).toBeInTheDocument();
  });

  // BUG-UG-CASE-MACRO-WRITE-AUDIENCE-WIDER-THAN-READ-20260917. Migration
  // 20260918201000 narrowed macro authorship to the macro's own read audience,
  // so casework_save_macro now refuses a save that used to be accepted for a
  // coordinator whose hat comes from member_role_chapters alone. That one
  // refusal is the only save failure the author cannot read as a typo, so it
  // gets translated copy naming the missing role instead of the SQL sentence.
  // (Ported onto the organization-scoped pickers() fixture and a status action,
  // so the draft is a valid one the save can post.)
  it("explains the audience refusal in the author's own language", async () => {
    const refusal = Object.assign(
      new Error("Save case macro: macro authorship requires the scope write role and the staff role that reads the macro"),
      { code: "42501", hint: "casework_macro_audience" },
    );
    const saveMacro = vi.fn().mockRejectedValue(refusal);
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await waitFor(() => expect(document.querySelector(".case-macros__actions li")).toBeTruthy());
    await draftReady();
    fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "Chapter hat macro" } });
    chooseStatus();
    expect(screen.getByLabelText(t("caseBulk.nextStatus"))).toHaveValue("active");
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    await waitFor(() => expect(saveMacro).toHaveBeenCalledTimes(1));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("caseMacros.audienceRefused"));
    expect(alert).not.toHaveTextContent("macro authorship requires the scope write role");
    // The draft stays open; nothing was saved, so nothing was reloaded.
    expect(screen.getByLabelText(t("caseMacros.name"))).toBeInTheDocument();
  });

  // The same SQLSTATE without the hint is a different refusal. Since
  // BUG-UG-CASEWORK-PANELS-RAW-DRIVER-ERROR-TEXT-20260920 it also reads as
  // the generic catalogue sentence: the raw server text is untranslated
  // internal wording. Only the audience decision gets its own copy.
  it("leaves every other 42501 refusal reading as the generic catalogue sentence", async () => {
    const refusal = Object.assign(new Error("Save case macro: macro scope cannot change"), { code: "42501", hint: null });
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([SAVED]), saveMacro: vi.fn().mockRejectedValue(refusal) });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.edit") }));
    await waitFor(() => expect(screen.getByLabelText(t("caseMacros.name"))).toHaveValue("Resolve and note"));
    await draftReady();
    expect(screen.getByLabelText(t("caseBulk.nextStatus"))).toHaveValue("resolved");
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    expect(await screen.findByText(t("caseMacros.saveFailed"))).toBeInTheDocument();
  });

  // BUG-UG-CASEWORK-PANELS-RAW-DRIVER-ERROR-TEXT-20260920. A driver-level
  // refusal arrives as raw English policy/constraint text; the failure line
  // must show only the fixed catalogue sentence.
  it("never renders driver policy or constraint text into the failure line", async () => {
    const driverRefusal = new MemberApiError("Save case macro", {
      message: 'new row violates row-level security policy for table "casework_macros"',
      code: "42501",
      details: null,
    });
    const bareRefusal = new Error('duplicate key value violates unique constraint "casework_macros_pkey"');
    for (const refusal of [driverRefusal, bareRefusal]) {
      const saveMacro = vi.fn().mockRejectedValue(refusal);
      const { unmount } = mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro });
      fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
      await waitFor(() => expect(document.querySelector(".case-macros__actions li")).toBeTruthy());
      await draftReady();
      fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "Org wide" } });
      chooseStatus();
      fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(t("caseMacros.saveFailed"));
      expect(alert.textContent).not.toMatch(/policy|relation|violates|constraint/i);
      unmount();
    }
  });

  // Codex review round 2 on PR #2337. The failure line used to store the
  // sentence resolved by the render that started the save, so a coordinator who
  // switched profile language while the write was in flight read the refusal in
  // the language they had just left, beside a screen in the new one.
  it("re-translates the stored failure line when the profile language changes in place", async () => {
    const saveMacro = vi.fn().mockRejectedValue(new Error('new row violates row-level security policy for table "casework_macros"'));
    const api = { ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro };
    const view = mount(api);
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await draftReady();
    fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "Org wide" } });
    chooseStatus();
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The macro was not saved.");

    view.rerender(
      <LanguageProvider lang="es">
        <CaseMacroEditor api={api} chapterId="wor" onNotice={() => {}} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("La macro no se guardó.");
  });

  // UX-UG-CASE-MACRO-EDITOR-RAW-IDS-AND-FREE-TEXT-STEP-20260917. The
  // editor used to ask for two raw user uuids; both were refused at apply
  // time, on every case in the batch, by assign_member_case (23514).
  it("saves a status action and an assign action by selection alone", async () => {
    const saveMacro = vi.fn().mockResolvedValue({});
    const api = { ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro };
    mount(api);
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await waitFor(() => expect(document.querySelector(".case-macros__actions li")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.addAction") }));
    await waitFor(() => expect(document.querySelectorAll(".case-macros__actions li")).toHaveLength(2));
    const rows = () => [...document.querySelectorAll(".case-macros__actions li")];
    fireEvent.change(within(rows()[1]).getByLabelText(t("caseMacros.actionKind")), { target: { value: "assign" } });
    await waitFor(() => expect(within(rows()[1]).getByRole("option", { name: "Ana Ruiz" })).toBeInTheDocument());

    // Every control the two actions offer is a menu.
    const status = within(rows()[0]).getByLabelText(t("caseBulk.nextStatus"));
    const steward = within(rows()[1]).getByLabelText(t("caseMacros.stewardId"));
    const coordinator = within(rows()[1]).getByLabelText(t("caseMacros.coordinatorId"));
    for (const control of [status, steward, coordinator]) expect(control.tagName).toBe("SELECT");
    // No free-text identifier, no step menu and no step outcome is reachable
    // in either row.
    expect([...document.querySelectorAll(".case-macros__actions input")]).toEqual([]);
    expect([...document.querySelectorAll(".case-macros__actions textarea")]).toEqual([]);
    expect(document.querySelector(".case-macros__actions optgroup")).toBeNull();
    for (const row of rows()) {
      const kinds = [...within(row).getByLabelText(t("caseMacros.actionKind")).querySelectorAll("option")].map((option) => option.value);
      expect(kinds).toEqual(OFFERED_KINDS);
    }

    // The steward menu offers only stewards, the coordinator menu only
    // coordinators, and a member with no role appears in neither.
    const names = (control) => [...control.querySelectorAll("option")].map((option) => option.textContent);
    expect(names(steward)).toEqual([t("caseMacros.assigneeClear"), "Ana Ruiz", "Cy Ode"]);
    expect(names(coordinator)).toEqual([t("caseMacros.assigneeClear"), "Ben Cho", "Cy Ode"]);

    fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "By selection" } });
    fireEvent.change(status, { target: { value: "active" } });
    fireEvent.change(steward, { target: { value: "u-steward" } });
    fireEvent.change(coordinator, { target: { value: "u-coordinator" } });
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));

    await waitFor(() => expect(saveMacro).toHaveBeenCalledTimes(1));
    expect(saveMacro.mock.calls[0][0].actions).toEqual([
      { kind: "set_status", status: "active" },
      { kind: "assign", stewardId: "u-steward", coordinatorId: "u-coordinator" },
    ]);
    expect(api.loadStaffCandidates).toHaveBeenCalledTimes(1);
    expect(api.listProcedures).not.toHaveBeenCalled();
  });

  // A macro outlives the roster it was written against. Losing the stored
  // value to a silent reset would change what the macro does without telling
  // anyone.
  it("keeps an assignee the current organization no longer offers", async () => {
    const saveMacro = vi.fn().mockResolvedValue({});
    const stale = {
      id: "macro-7", name: "Legacy", chapterId: "wor", active: true,
      actions: [{ kind: "assign", stewardId: "u-gone", coordinatorId: "" }],
    };
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([stale]), saveMacro });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.edit") }));
    expect(await screen.findByRole("option", { name: t("caseMacros.staleAssignee") })).toBeInTheDocument();
    expect(screen.getByLabelText(t("caseMacros.stewardId"))).toHaveValue("u-gone");

    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    await waitFor(() => expect(saveMacro.mock.calls[0][0].actions).toEqual([
      { kind: "assign", stewardId: "u-gone" },
    ]));
  });

  // A macro saved before Union Ground dropped grievance steps may still
  // carry an advance_step action. The editor drops it from the draft, says so,
  // and never saves it back.
  it("drops a legacy advance_step action on load and saves the macro without it", async () => {
    const saveMacro = vi.fn().mockResolvedValue({});
    const legacy = {
      id: "macro-8", name: "Legacy step", chapterId: "wor", active: true,
      actions: [
        { kind: "advance_step", step: "step_1", outcome: "Filed" },
        { kind: "add_note", body: "Kept note" },
      ],
    };
    const view = mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([legacy]), saveMacro });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.edit") }));
    await waitFor(() => expect(document.querySelectorAll(".case-macros__actions li")).toHaveLength(1));
    expect(view.container.querySelector(".case-macros__form p.case-macros__hint[role='status']")).not.toBeNull();
    expect(screen.getByLabelText(t("caseMacros.actionKind"))).toHaveValue("add_note");
    expect(screen.getByLabelText(t("caseNotes.staffNoteLabel"))).toHaveValue("Kept note");
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    await waitFor(() => expect(saveMacro).toHaveBeenCalledTimes(1));
    expect(saveMacro.mock.calls[0][0].actions).toEqual([{ kind: "add_note", body: "Kept note" }]);
  });

  it("shows no legacy-step notice on a macro without a step action", async () => {
    const view = mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([SAVED]), saveMacro: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.edit") }));
    await draftReady();
    expect(view.container.querySelector(".case-macros__form p.case-macros__hint[role='status']")).toBeNull();
  });

  // A read that refuses is named. The failure this record repairs was a
  // control that looked usable and was not; an empty menu with no sentence
  // beside it is the same failure in a new shape.
  it("names the read that refused instead of offering an empty menu", async () => {
    mount({
      listMacros: vi.fn().mockResolvedValue([]),
      saveMacro: vi.fn(),
      loadStaffCandidates: vi.fn().mockRejectedValue(new Error("staff role required")),
    });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await draftReady();

    fireEvent.change(screen.getByLabelText(t("caseMacros.actionKind")), { target: { value: "assign" } });
    await waitFor(() => expect(screen.getAllByText(t("caseMacros.staffUnavailable"))).toHaveLength(2));
    expect(screen.getByLabelText(t("caseMacros.stewardId"))).toBeDisabled();
    expect(screen.getByLabelText(t("caseMacros.coordinatorId"))).toBeDisabled();
    // Still no free-text way in.
    expect([...document.querySelectorAll(".case-macros__actions input")]).toEqual([]);
  });

  // The plane that exposes no picker read at all is the same refusal: a
  // desk without the organization reads may not fall back to raw ids.
  it("offers menus, not text fields, on a plane with no picker reads", async () => {
    mount({ listMacros: vi.fn().mockResolvedValue([]), saveMacro: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await waitFor(() => expect(document.querySelector(".case-macros__actions li")).toBeTruthy());
    expect(screen.getByLabelText(t("caseBulk.nextStatus")).tagName).toBe("SELECT");
    fireEvent.change(screen.getByLabelText(t("caseMacros.actionKind")), { target: { value: "assign" } });
    await waitFor(() => expect(screen.getByLabelText(t("caseMacros.stewardId")).tagName).toBe("SELECT"));
    expect([...document.querySelectorAll(".case-macros__actions input")]).toEqual([]);
  });

  // PR #2175 review MEDIUM-1. public.get_staff_roster() ends in `limit 200`
  // across all staff roles, so a large organization hands this screen an
  // alphabetical slice. The menus may then be missing the person the
  // coordinator wants, and "nobody holds that role yet" would be a claim the
  // read cannot support.
  it("says the staff read was truncated instead of calling a full page an empty organization", async () => {
    // 200 rows, every one of them a steward: the coordinator menu is empty in
    // this page and the organization's coordinators are simply past the cap.
    const page = Array.from({ length: 200 }, (_, index) => ({
      userId: `u-${index}`, fullName: `Steward ${String(index).padStart(3, "0")}`, roles: ["steward"],
    }));
    mount({
      listMacros: vi.fn().mockResolvedValue([]),
      saveMacro: vi.fn(),
      loadStaffCandidates: vi.fn().mockResolvedValue(page),
    });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    fireEvent.change(await screen.findByLabelText(t("caseMacros.actionKind")), { target: { value: "assign" } });
    await waitFor(() => expect(screen.getByLabelText(t("caseMacros.stewardId"))).toBeInTheDocument());

    // Both pickers say it, including the one that does have holders.
    await waitFor(() => expect(screen.getAllByText(t("caseMacros.staffTruncated", { count: 200 }))).toHaveLength(2));
    expect(screen.queryByText(t("caseMacros.staffEmpty"))).toBeNull();
    // The truncated page is still a usable menu, not a disabled one.
    expect(screen.getByLabelText(t("caseMacros.stewardId"))).not.toBeDisabled();
  });

  // The same screen under the cap keeps the honest empty-state sentence.
  it("still names an empty role when the page is short of the server cap", async () => {
    mount({
      listMacros: vi.fn().mockResolvedValue([]),
      saveMacro: vi.fn(),
      loadStaffCandidates: vi.fn().mockResolvedValue([{ userId: "u-1", fullName: "Ana Ruiz", roles: ["steward"] }]),
    });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    fireEvent.change(await screen.findByLabelText(t("caseMacros.actionKind")), { target: { value: "assign" } });
    expect(await screen.findByText(t("caseMacros.staffEmpty"))).toBeInTheDocument();
    expect(screen.queryByText(t("caseMacros.staffTruncated", { count: 200 }))).toBeNull();
  });

  // PR #2175 review LOW-1. A disabled control is barred from constraint
  // validation, so the browser cannot be the guard on a plane whose staff read
  // refused: the editor refuses the empty assign itself.
  it("refuses an assign action with no assignee rather than posting it when the staff read refused", async () => {
    const saveMacro = vi.fn().mockResolvedValue({});
    mount({
      listMacros: vi.fn().mockResolvedValue([]),
      saveMacro,
      loadStaffCandidates: vi.fn().mockRejectedValue(new Error("staff role required")),
    });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await draftReady();
    fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "No assignee" } });
    fireEvent.change(screen.getByLabelText(t("caseMacros.actionKind")), { target: { value: "assign" } });
    await waitFor(() => expect(screen.getAllByText(t("caseMacros.staffUnavailable"))).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    // The read refused, so the refusal names that rather than the generic ask.
    await waitFor(() => expect(screen.getAllByText(t("caseMacros.staffUnavailable")).length).toBeGreaterThan(2));
    expect(screen.queryByText(t("caseMacros.assigneeRequired"))).toBeNull();
    expect(saveMacro).not.toHaveBeenCalled();
  });

  it("refuses an assign action with neither person chosen, and saves once one is", async () => {
    const saveMacro = vi.fn().mockResolvedValue({});
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    await draftReady();
    fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "Assign only" } });
    // Neither assign menu is required — the server's rule is "at least one of
    // the two" — so this refusal is the client's own, not the browser's.
    fireEvent.change(screen.getByLabelText(t("caseMacros.actionKind")), { target: { value: "assign" } });
    await waitFor(() => expect(screen.getByRole("option", { name: "Ana Ruiz" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    expect(await screen.findByText(t("caseMacros.assigneeRequired"))).toBeInTheDocument();
    expect(saveMacro).not.toHaveBeenCalled();

    // Choosing one of the two is enough, and the refusal clears.
    fireEvent.change(screen.getByLabelText(t("caseMacros.stewardId")), { target: { value: "u-steward" } });
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
    await waitFor(() => expect(saveMacro).toHaveBeenCalledTimes(1));
    expect(saveMacro.mock.calls[0][0].actions).toEqual([{ kind: "assign", stewardId: "u-steward" }]);
    expect(screen.queryByText(t("caseMacros.assigneeRequired"))).toBeNull();
  });

  // PR #2175 review LOW-2. The sentence that explains a disabled or truncated
  // menu has to be readable from the menu itself, not only beside it.
  it("names each picker's explanation from the control it explains", async () => {
    mount({
      listMacros: vi.fn().mockResolvedValue([]),
      saveMacro: vi.fn(),
      loadStaffCandidates: vi.fn().mockRejectedValue(new Error("staff role required")),
    });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
    const described = (control) => (control.getAttribute("aria-describedby") || "")
      .split(" ").filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent);
    await draftReady();

    fireEvent.change(screen.getByLabelText(t("caseMacros.actionKind")), { target: { value: "assign" } });
    await waitFor(() => expect(screen.getAllByText(t("caseMacros.staffUnavailable"))).toHaveLength(2));
    for (const label of [t("caseMacros.stewardId"), t("caseMacros.coordinatorId")]) {
      expect(described(screen.getByLabelText(label)))
        .toEqual([t("caseMacros.staffUnavailable"), t("caseMacros.assignHint")]);
    }
  });

  // A11Y-UG-CASE-MACRO-EDITOR-FOCUS-LOST-ON-EVERY-TRANSITION-20260920.
  // Every transition on this screen unmounts the control that was activated,
  // so a keyboard or screen-reader coordinator used to land on <body> and have
  // to walk the page again after opening, cancelling, saving, or removing an
  // action.
  describe("focus across the editor's transitions", () => {
    const TEN = {
      id: "macro-10", name: "Full macro", chapterId: "wor", active: true,
      actions: Array.from({ length: 10 }, (_, index) => ({ kind: "add_note", body: `Note ${index}` })),
    };

    it("moves the caret into the draft name field when a row's Edit opens it", async () => {
      mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([SAVED]), saveMacro: vi.fn() });
      fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.edit") }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(t("caseMacros.name"))));
    });

    it("moves the caret into the draft name field when New opens it", async () => {
      mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro: vi.fn() });
      fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(t("caseMacros.name"))));
    });

    // The list is re-rendered from scratch when the draft closes, so the
    // restore has to find the row again rather than hold the old node.
    it("hands focus back to the specific row's Edit button on cancel", async () => {
      const second = { ...SAVED, id: "macro-2", name: "Close and notify" };
      mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([SAVED, second]), saveMacro: vi.fn() });
      await screen.findByText("Close and notify");
      const rowOf = (name) => [...document.querySelectorAll(".case-macros__list li")]
        .find((item) => item.textContent.includes(name));
      fireEvent.click(within(rowOf("Close and notify")).getByRole("button", { name: t("caseMacros.edit") }));
      await waitFor(() => expect(screen.getByLabelText(t("caseMacros.name"))).toHaveValue("Close and notify"));

      fireEvent.click(screen.getByRole("button", { name: t("caseMacros.cancel") }));
      await waitFor(() => expect(screen.queryByLabelText(t("caseMacros.name"))).toBeNull());
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement)
        .toBe(within(rowOf("Close and notify")).getByRole("button", { name: t("caseMacros.edit") }));
    });

    it("hands focus back to the New button after a successful save", async () => {
      const saveMacro = vi.fn().mockResolvedValue({ id: "macro-9" });
      mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro });
      fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
      await draftReady();
      fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "Escalate" } });
      chooseStatus();
      fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));

      await waitFor(() => expect(saveMacro).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(document.activeElement)
        .toBe(screen.getByRole("button", { name: t("caseMacros.new") })));
    });

    // A save that the server refuses keeps the draft open, so there is no
    // transition to restore and the caret stays where the author left it.
    it("leaves the caret alone when a refused save keeps the draft open", async () => {
      const saveMacro = vi.fn().mockRejectedValue(new Error("macro actions are not a valid ordered action list"));
      mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([SAVED]), saveMacro });
      fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.edit") }));
      await draftReady();
      fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
      expect(await screen.findByRole("alert")).toHaveTextContent(t("caseMacros.saveFailed"));
      expect(screen.getByLabelText(t("caseMacros.name"))).toBeInTheDocument();
      expect(document.activeElement).not.toBe(document.body);
    });

    // The ceiling case: at ten actions the Add-action control is not rendered
    // at all, so the only surviving target is one the removal itself leaves.
    it("keeps focus on a surviving control when an action is removed at the ten-action ceiling", async () => {
      mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([TEN]), saveMacro: vi.fn() });
      fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.edit") }));
      await waitFor(() => expect(document.querySelectorAll(".case-macros__actions li")).toHaveLength(10));
      expect(screen.queryByRole("button", { name: t("caseMacros.addAction") })).toBeNull();

      const drops = () => screen.getAllByRole("button", { name: t("caseMacros.removeAction") });
      // The control a coordinator activates is the one holding focus, and the
      // removal is what unmounts it.
      drops()[9].focus();
      fireEvent.click(drops()[9]);
      await waitFor(() => expect(document.querySelectorAll(".case-macros__actions li")).toHaveLength(9));
      expect(document.activeElement).not.toBe(document.body);
      expect(document.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(drops()[8]);
    });

    // Down to a single action there is no Remove button left to hold focus,
    // and the Add-action control is the nearest survivor.
    it("falls back to the Add-action control when the last removable row goes", async () => {
      mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro: vi.fn() });
      fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
      fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.addAction") }));
      await waitFor(() => expect(document.querySelectorAll(".case-macros__actions li")).toHaveLength(2));

      const drop = screen.getAllByRole("button", { name: t("caseMacros.removeAction") })[1];
      drop.focus();
      fireEvent.click(drop);
      await waitFor(() => expect(document.querySelectorAll(".case-macros__actions li")).toHaveLength(1));
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: t("caseMacros.addAction") }));
    });

    // The restore only ever reclaims focus the transition itself dropped: a
    // coordinator who walked away from the editor while the save was in
    // flight is not dragged back to it.
    it("does not steal focus from a control the author moved to while the save was in flight", async () => {
      let settle;
      const saveMacro = vi.fn(() => new Promise((resolve) => { settle = () => resolve({ id: "macro-9" }); }));
      render(
        <LanguageProvider lang="en">
          <button type="button" data-testid="outside">Elsewhere</button>
          <CaseMacroEditor api={{ ...pickers(), listMacros: vi.fn().mockResolvedValue([]), saveMacro }} chapterId="wor" />
        </LanguageProvider>,
      );
      fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.new") }));
      await draftReady();
      fireEvent.change(screen.getByLabelText(t("caseMacros.name")), { target: { value: "Escalate" } });
      chooseStatus();
      fireEvent.click(screen.getByRole("button", { name: t("caseMacros.save") }));
      await waitFor(() => expect(saveMacro).toHaveBeenCalledTimes(1));

      const outside = screen.getByTestId("outside");
      outside.focus();
      settle();
      await waitFor(() => expect(screen.queryByLabelText(t("caseMacros.name"))).toBeNull());
      expect(document.activeElement).toBe(outside);
    });

    // The in-flight read is a state, not a paragraph: a screen reader is told
    // the macros are loading rather than left in silence.
    it("announces the in-flight macro read as a status", async () => {
      let settle;
      const listMacros = vi.fn(() => new Promise((resolve) => { settle = () => resolve([]); }));
      mount({ ...pickers(), listMacros, saveMacro: vi.fn() });
      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(t("caseMacros.loading"));

      settle();
      await waitFor(() => expect(screen.getByText(t("caseMacros.empty"))).toBeInTheDocument());
    });
  });

  it("drops the draft and its error on cancel", async () => {
    mount({ ...pickers(), listMacros: vi.fn().mockResolvedValue([SAVED]), saveMacro: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: t("caseMacros.edit") }));
    await waitFor(() => expect(screen.getByLabelText(t("caseMacros.name"))).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: t("caseMacros.cancel") }));
    await waitFor(() => expect(screen.queryByLabelText(t("caseMacros.name"))).toBeNull());
    expect(screen.getByRole("button", { name: t("caseMacros.new") })).toBeInTheDocument();
  });
});
