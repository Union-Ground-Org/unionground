// REQ-UG-COOP-CHECKOFF-LISTS-20261001: the member check-off list inside a
// Standard Task, plus the client helpers that port the old coop-tasks rules.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskCheckoffPanel } from "../src/views/TaskCheckoffPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import {
  checkoffDenialReason,
  checkoffProgress,
  createTaskCheckoff,
  evaluateCheckoff,
  filterCheckoffEntries,
  setTaskCheckoffEntry,
} from "../src/lib/taskCheckoff.js";

const me = "steward-me";
const entry = (id, extra = {}) => ({ id, memberUserId: `m-${id}`, memberName: `Member ${id}`, assignedStewardId: me, assignedStewardName: "Me Steward", status: "pending", note: "", actionedBy: null, actionedByName: null, ...extra });
const list = (entries, extra = {}) => ({ enabled: true, list: { taskId: "task-1", mode: "split_even", status: "open", createdBy: "creator", canManage: false, entries, ...extra } });

function clientWith(responses) {
  return { rpc: vi.fn(async (name, args) => {
    const value = typeof responses[name] === "function" ? responses[name](args) : responses[name];
    return value instanceof Error ? { data: null, error: value } : { data: value, error: null };
  }) };
}

describe("check-off helpers", () => {
  it("ports evaluateCheckoff: closed, reset, ownership, terminal and follow-up rules", () => {
    const base = { actorId: me, isManager: false, listStatus: "open", entry: entry("1"), nextStatus: "done" };
    expect(evaluateCheckoff(base)).toEqual({ allowed: true });
    expect(evaluateCheckoff({ ...base, listStatus: "closed" }).reason).toBe("list_closed");
    expect(evaluateCheckoff({ ...base, nextStatus: "pending" }).reason).toBe("reset_requires_manager");
    expect(evaluateCheckoff({ ...base, entry: entry("1", { assignedStewardId: "other" }) }).reason).toBe("assigned_to_other");
    expect(evaluateCheckoff({ ...base, entry: entry("1", { status: "done" }) }).reason).toBe("already_actioned");
    expect(evaluateCheckoff({ ...base, entry: entry("1", { status: "follow_up", actionedBy: "other" }) }).reason).toBe("follow_up_owned_by_other");
    expect(evaluateCheckoff({ ...base, entry: entry("1", { status: "follow_up", actionedBy: me }) }).allowed).toBe(true);
    expect(evaluateCheckoff({ ...base, isManager: true, listStatus: "closed", nextStatus: "pending" }).allowed).toBe(true);
  });

  it("rolls progress up per steward with shared rows credited to whoever actioned them", () => {
    const progress = checkoffProgress([
      entry("1", { status: "done" }),
      entry("2", { status: "follow_up" }),
      entry("3", { assignedStewardId: null, status: "unreachable", actionedBy: "s2", actionedByName: "Bea" }),
      entry("4", { assignedStewardId: null }),
    ]);
    expect(progress).toMatchObject({ total: 4, completed: 2, done: 1, unreachable: 1, followUp: 1, pending: 1 });
    expect(progress.perSteward.map((bucket) => [bucket.stewardId, bucket.total, bucket.completed])).toEqual([["s2", 1, 1], [me, 2, 1], [null, 1, 0]]);
    expect(checkoffProgress(null).total).toBe(0);
    expect(filterCheckoffEntries([entry("1"), entry("2", { status: "done" })], "done").map((row) => row.id)).toEqual(["2"]);
    expect(filterCheckoffEntries(undefined, "all")).toEqual([]);
  });

  it("maps database refusals to stable reasons", () => {
    expect(checkoffDenialReason({ message: "checkoff:assigned_to_other" })).toBe("assigned_to_other");
    expect(checkoffDenialReason({ message: "checkoff:unknown_thing" })).toBe("failed");
    expect(checkoffDenialReason({ message: "member check-off lists are turned off" })).toBe("disabled");
    expect(checkoffDenialReason(null)).toBe("failed");
  });

  it("sends only the fields each mode uses and trims notes", async () => {
    const client = clientWith({ create_task_checkoff_list: {}, set_task_checkoff_entry: {} });
    await createTaskCheckoff(client, { taskId: "t", mode: "shared", memberIds: ["a"], stewardIds: ["s"], manual: { a: "s" } });
    expect(client.rpc).toHaveBeenLastCalledWith("create_task_checkoff_list", { p_task_id: "t", p_mode: "shared", p_member_ids: ["a"], p_steward_ids: [], p_manual: {} });
    await createTaskCheckoff(client, { taskId: "t", mode: "manual", memberIds: ["a"], stewardIds: ["s"], manual: { a: "s" } });
    expect(client.rpc).toHaveBeenLastCalledWith("create_task_checkoff_list", { p_task_id: "t", p_mode: "manual", p_member_ids: ["a"], p_steward_ids: [], p_manual: { a: "s" } });
    await expect(createTaskCheckoff(client, { taskId: "t", mode: "bogus", memberIds: [] })).rejects.toThrow(/invalid mode/);
    await setTaskCheckoffEntry(client, { entryId: "e", status: "done", note: `  ${"n".repeat(600)}  `, expectedStatus: "pending" });
    expect(client.rpc.mock.calls.at(-1)[1].p_note).toHaveLength(500);
  });
});

describe("TaskCheckoffPanel", () => {
  it.each(["en", "es"])("explains an invalid steward assignment in %s without closing the builder", async (lang) => {
    const failure = Object.assign(new Error("checkoff:assignment_scope: A selected steward cannot see the assigned member."), { code: "22023" });
    const client = clientWith({ get_task_checkoff_list: { enabled: true, list: null },
      list_task_checkoff_candidates: { members: [{ id: "m-1", name: "Member 1", steward: false }, { id: me, name: "Me Steward", steward: true }] },
      create_task_checkoff_list: failure });
    render(<LanguageProvider lang={lang}><TaskCheckoffPanel client={client} taskId="task-1" memberId={me} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: t(lang, "taskCheckoff.add") }));
    fireEvent.click(await screen.findByRole("button", { name: t(lang, "taskCheckoff.selectAll") }));
    const staff = screen.getByRole("group", { name: t(lang, "taskCheckoff.stewards", { count: 0 }) });
    fireEvent.click(within(staff).getByRole("checkbox", { name: "Me Steward" }));
    fireEvent.click(screen.getByRole("button", { name: t(lang, "taskCheckoff.create") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t(lang, "taskCheckoff.error.assignment_scope"));
    expect(screen.getByRole("button", { name: t(lang, "taskCheckoff.create") })).toBeInTheDocument();
    expect(checkoffDenialReason(failure)).toBe("assignment_scope");
  });
  it("renders nothing while the organization switch is off", async () => {
    const client = clientWith({ get_task_checkoff_list: { enabled: false, list: null } });
    const { container } = render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    await waitFor(() => expect(client.rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("builds an even split from the chapter roster", async () => {
    const created = list([entry("1"), entry("2", { assignedStewardId: "s2", assignedStewardName: "Bea" })]);
    const client = clientWith({
      get_task_checkoff_list: { enabled: true, list: null },
      list_task_checkoff_candidates: { members: [
        { id: "m-1", name: "Member 1", steward: false },
        { id: "m-2", name: "Member 2", steward: false },
        { id: me, name: "Me Steward", steward: true },
      ] },
      create_task_checkoff_list: created,
    });
    render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a worker check-off list" }));
    const create = await screen.findByRole("button", { name: "Create list" });
    expect(create).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    const stewards = screen.getByRole("group", { name: /Committee members/ });
    fireEvent.click(within(stewards).getByRole("checkbox", { name: "Me Steward" }));
    expect(create).not.toHaveAttribute("aria-disabled");
    fireEvent.click(create);
    expect(await screen.findByText("0 of 2 complete · Split evenly")).toBeVisible();
    expect(client.rpc).toHaveBeenCalledWith("create_task_checkoff_list", {
      p_task_id: "task-1", p_mode: "split_even", p_member_ids: ["m-1", "m-2", me], p_steward_ids: [me], p_manual: {},
    });
  });

  it("requires a steward per member in manual mode", async () => {
    const client = clientWith({
      get_task_checkoff_list: { enabled: true, list: null },
      list_task_checkoff_candidates: { members: [{ id: "m-1", name: "Member 1", steward: false }, { id: me, name: "Me Steward", steward: true }] },
      create_task_checkoff_list: list([entry("1")], { mode: "manual" }),
    });
    render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a worker check-off list" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Pick a committee member for each worker" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Member 1" }));
    expect(screen.getByRole("button", { name: "Create list" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByRole("combobox", { name: "Committee member for Member 1" }), { target: { value: me } });
    fireEvent.click(screen.getByRole("button", { name: "Create list" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("create_task_checkoff_list", expect.objectContaining({ p_mode: "manual", p_manual: { "m-1": me } })));
  });

  it("checks a member off with an expected-status token and offers no action on another steward's row", async () => {
    const after = list([entry("1", { status: "done", actionedBy: me, actionedByName: "Me Steward" }), entry("2", { assignedStewardId: "s2", assignedStewardName: "Bea" })]);
    const client = clientWith({
      get_task_checkoff_list: list([entry("1"), entry("2", { assignedStewardId: "s2", assignedStewardName: "Bea" })]),
      set_task_checkoff_entry: after,
    });
    render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    fireEvent.click(await screen.findByRole("button", { name: "Done: Member 1" }));
    expect(screen.queryByRole("button", { name: "Done: Member 2" })).not.toBeInTheDocument();
    expect(await screen.findByText("1 of 2 complete · Split evenly")).toBeVisible();
    expect(client.rpc).toHaveBeenCalledWith("set_task_checkoff_entry", { p_entry_id: "1", p_status: "done", p_note: "", p_expected_status: "pending" });
    expect(screen.queryByRole("button", { name: "Close list" })).not.toBeInTheDocument();
  });

  it("explains a stale double check-off and reloads", async () => {
    const stale = Object.assign(new Error("checkoff:stale"), { code: "40001" });
    const client = clientWith({ get_task_checkoff_list: list([entry("1")]), set_task_checkoff_entry: stale });
    render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unreachable: Member 1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else updated this worker first");
    await waitFor(() => expect(client.rpc.mock.calls.filter(([name]) => name === "get_task_checkoff_list")).toHaveLength(2));
  });

  it("lets a manager reset, close and filter the list", async () => {
    const managed = list([entry("1", { status: "done", actionedBy: "s2", actionedByName: "Bea", note: "Spoke at lunch" }), entry("2")], { canManage: true });
    const client = clientWith({
      get_task_checkoff_list: managed,
      set_task_checkoff_entry: managed,
      set_task_checkoff_list_status: { ...managed, list: { ...managed.list, status: "closed" } },
    });
    render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    expect(await screen.findByText("Spoke at lunch")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reset to pending: Member 1" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("set_task_checkoff_entry", { p_entry_id: "1", p_status: "pending", p_note: "Spoke at lunch", p_expected_status: "done" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), { target: { value: "follow_up" } });
    expect(screen.getByText("No workers match this filter.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close list" }));
    expect(await screen.findByRole("button", { name: "Reopen list" })).toBeVisible();
    expect(client.rpc).toHaveBeenCalledWith("set_task_checkoff_list_status", { p_task_id: "task-1", p_status: "closed" });
  });

  it("saves a follow-up note through the same guarded write", async () => {
    const client = clientWith({
      get_task_checkoff_list: list([entry("1", { status: "follow_up", actionedBy: me, actionedByName: "Me Steward" })]),
      set_task_checkoff_entry: list([entry("1", { status: "follow_up", actionedBy: me, note: "Call Friday" })]),
    });
    render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Call Friday" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("set_task_checkoff_entry", { p_entry_id: "1", p_status: "follow_up", p_note: "Call Friday", p_expected_status: "follow_up" }));
  });

  it("stays silent in the task when the list cannot be read", async () => {
    const client = clientWith({ get_task_checkoff_list: new Error("network") });
    const { container } = render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    await waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("reports a failed roster read without opening the builder", async () => {
    const client = clientWith({ get_task_checkoff_list: { enabled: true, list: null }, list_task_checkoff_candidates: new Error("checkoff:manager_required") });
    render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a worker check-off list" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That did not go through. Try again.");
    expect(screen.queryByRole("button", { name: "Create list" })).not.toBeInTheDocument();
  });
});

describe("check-off controls keep focus while their writes run (#8435)", () => {
  it("says plainly when no members are available to the caller to build a list", async () => {
    const client = clientWith({ get_task_checkoff_list: { enabled: true, list: null }, list_task_checkoff_candidates: { members: [] } });
    render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a worker check-off list" }));
    // The roster note and, since #9468, the reason beside Create list.
    expect(await screen.findAllByText("No active workers are available for you to add.")).toHaveLength(2);
    expect(screen.getByText("No worker in this campaign holds a staff role.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create list" })).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps a member's Done focused while the check-off is saved, and saves it once", async () => {
    const after = list([entry("1", { status: "done", actionedBy: me, actionedByName: "Me Steward" })]);
    const client = clientWith({ get_task_checkoff_list: list([entry("1")]), set_task_checkoff_entry: after });
    render(<TaskCheckoffPanel client={client} taskId="task-1" memberId={me} />);
    const done = await screen.findByRole("button", { name: "Done: Member 1" });
    await expectHeldWriteFocus(client.rpc, done);
    await waitFor(() => expect(client.rpc.mock.calls.filter(([name]) => name === "set_task_checkoff_entry")).toHaveLength(1));
  });
});
