import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MemberOperations } from "../src/features/memberOperations/MemberOperations.jsx";

// BUG-UG-MEMBER-DIRECTORY-MOUNT-EFFECT-PAGINATION-LOSS-20260910 and
// TEST-UG-MEMBER-OPERATIONS-FIRST-PAGE-CI-FOLLOWUP-20260909: the Directory
// next-page boundary. A page response is only meaningful for the listing whose
// cursor requested it. These cases pin the exact cursor arguments, RPC
// completion, notices and state append for the two ways a listing can be
// replaced while a page is still in flight, a Load next page activated from a
// rendering that was already replaced but not yet re-rendered, and a repeated
// Load next page. Promise settlement order is controlled explicitly; no
// effect, timer or scheduler is mocked and no timeout is changed.

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
  membershipStatus: "active",
  selectedHat: "admin",
  organizationRoles: ["admin"],
  mfaSatisfied: true,
};
const first = {
  userId: "33333333-3333-4333-8333-333333333333",
  fullName: "Avery Brooks",
  initials: "AB",
  chapterId: "bos",
  chapterName: "Boston",
  version: 2,
  profile: { department: "Nursing" },
};
const second = { ...first, userId: "88888888-8888-4888-8888-888888888888", fullName: "Jordan Lee" };
const replacement = { ...first, userId: "99999999-9999-4999-8999-999999999999", fullName: "Morgan Chen" };
const workspace = {
  state: "ready",
  organizationId: actor.selectedOrganizationId,
  deliveryConfigured: false,
  directory: { items: [first], nextCursor: { name: first.fullName, id: first.userId } },
  campaigns: [],
  imports: [],
};
const cursorArgs = { p_query: null, p_after_name: first.fullName, p_after_id: first.userId, p_limit: 25 };

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function clientFor(snapshot, directoryHandler) {
  return {
    rpc: vi.fn(async (name, args) => {
      if (name === "get_member_operations_workspace") return { data: snapshot, error: null };
      if (name === "get_member_operations_directory") return directoryHandler(args);
      return { data: { updated: true }, error: null };
    }),
  };
}

const directoryCalls = (client) => client.rpc.mock.calls.filter(([name]) => name === "get_member_operations_directory");
const rows = () => document.querySelectorAll(".member-operations-row").length;

describe("member directory superseded next page", () => {
  it("discards a next page that settles after a search replaced the listing", async () => {
    const page = deferred();
    const search = deferred();
    const client = clientFor(workspace, (args) => (args.p_after_id ? page.promise : search.promise));
    const onNotice = vi.fn();
    render(<MemberOperations actor={actor} client={client} onNotice={onNotice} />);
    await screen.findByRole("heading", { name: "Worker directory" });

    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));
    expect(directoryCalls(client)).toHaveLength(1);
    expect(client.rpc).toHaveBeenCalledWith("get_member_operations_directory", cursorArgs);

    fireEvent.change(screen.getByPlaceholderText("Search by worker name"), { target: { value: "Morgan" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(directoryCalls(client)).toHaveLength(2);
    expect(client.rpc).toHaveBeenLastCalledWith("get_member_operations_directory", {
      p_query: "Morgan", p_after_name: null, p_after_id: null, p_limit: 25,
    });
    await act(async () => {
      search.resolve({ data: { items: [replacement], nextCursor: null }, error: null });
      await search.promise;
    });
    expect(await screen.findByText(replacement.fullName)).toBeInTheDocument();
    expect(rows()).toBe(1);

    // The page requested for the original listing settles last. It belongs to
    // a superseded query and must neither append rows nor restore a cursor.
    await act(async () => {
      page.resolve({ data: { items: [second], nextCursor: { name: second.fullName, id: second.userId } }, error: null });
      await page.promise;
    });
    expect(screen.queryByText(second.fullName)).not.toBeInTheDocument();
    expect(screen.queryByText(first.fullName)).not.toBeInTheDocument();
    expect(rows()).toBe(1);
    expect(screen.queryByRole("button", { name: "Load next page" })).not.toBeInTheDocument();
    expect(screen.getByText("1 shown")).toBeInTheDocument();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("discards a next page that settles after a workspace replacement", async () => {
    const page = deferred();
    const client = clientFor(workspace, () => page.promise);
    const onNotice = vi.fn();
    const { rerender } = render(<MemberOperations actor={actor} client={client} onNotice={onNotice} />);
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));
    expect(client.rpc).toHaveBeenCalledWith("get_member_operations_directory", cursorArgs);

    const refreshed = { ...workspace, directory: { items: [replacement], nextCursor: null } };
    const replacementClient = clientFor(refreshed, () => { throw new Error("no page expected"); });
    rerender(<MemberOperations actor={actor} client={replacementClient} onNotice={onNotice} />);
    expect(await screen.findByText(replacement.fullName)).toBeInTheDocument();
    expect(rows()).toBe(1);

    await act(async () => {
      page.resolve({ data: { items: [second], nextCursor: null }, error: null });
      await page.promise;
    });
    expect(screen.queryByText(second.fullName)).not.toBeInTheDocument();
    expect(rows()).toBe(1);
    expect(screen.queryByRole("button", { name: "Load next page" })).not.toBeInTheDocument();
    expect(directoryCalls(replacementClient)).toHaveLength(0);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("ignores a Load next page activated from a rendering that was already replaced but not yet re-rendered", async () => {
    const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    // Real React scheduling: outside act, a replacement set from a promise
    // continuation is committed in a later task, so the old control is still
    // in the DOM when its click handler runs against the replaced listing.
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const search = deferred();
    const page = deferred();
    const client = clientFor(workspace, (args) => (args.p_after_id ? page.promise : search.promise));
    const onNotice = vi.fn();
    try {
      root.render(<MemberOperations actor={actor} client={client} onNotice={onNotice} />);
      const oldButton = await within(container).findByRole("button", { name: "Load next page" });
      fireEvent.change(within(container).getByPlaceholderText("Search by worker name"), { target: { value: "Morgan" } });
      fireEvent.click(within(container).getByRole("button", { name: "Search" }));
      expect(directoryCalls(client)).toHaveLength(1);
      search.resolve({ data: { items: [replacement], nextCursor: null }, error: null });
      // Drain every microtask so the component has replaced its listing, but
      // yield no task: React has not committed the replacement yet.
      for (let tick = 0; tick < 25; tick += 1) await Promise.resolve();
      expect(container.contains(oldButton)).toBe(true);
      expect(within(container).queryByText(replacement.fullName)).not.toBeInTheDocument();

      // The stale control still holds the original cursor. Its activation must
      // not request a page for the listing that no longer exists.
      fireEvent.click(oldButton);
      expect(directoryCalls(client)).toHaveLength(1);
      expect(await within(container).findByText(replacement.fullName)).toBeInTheDocument();
      expect(container.querySelectorAll(".member-operations-row")).toHaveLength(1);
      expect(within(container).queryByText(second.fullName)).not.toBeInTheDocument();
      expect(within(container).queryByRole("button", { name: "Load next page" })).not.toBeInTheDocument();
      expect(onNotice).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      container.remove();
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it("issues one request for a repeated Load next page and appends the page once", async () => {
    const page = deferred();
    const client = clientFor(workspace, () => page.promise);
    const onNotice = vi.fn();
    render(<MemberOperations actor={actor} client={client} onNotice={onNotice} />);
    await screen.findByRole("heading", { name: "Worker directory" });
    const button = screen.getByRole("button", { name: "Load next page" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(directoryCalls(client)).toHaveLength(1);

    await act(async () => {
      page.resolve({ data: { items: [second], nextCursor: null }, error: null });
      await page.promise;
    });
    expect(await screen.findByText(second.fullName)).toBeInTheDocument();
    expect(screen.getAllByText(second.fullName)).toHaveLength(1);
    expect(rows()).toBe(2);
    expect(screen.getByText("2 shown")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load next page" })).not.toBeInTheDocument();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("still appends a page and reports a failure for the listing that requested it", async () => {
    const page = deferred();
    const client = clientFor(workspace, () => page.promise);
    const onNotice = vi.fn();
    render(<MemberOperations actor={actor} client={client} onNotice={onNotice} />);
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));
    await act(async () => {
      page.resolve({ data: null, error: new Error("Directory offline") });
      await page.promise;
    });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Directory offline"));
    // The failed request released its cursor, so the same page can be retried.
    const retry = deferred();
    client.rpc.mockImplementation(async (name) => (name === "get_member_operations_directory"
      ? retry.promise
      : { data: workspace, error: null }));
    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));
    await act(async () => {
      retry.resolve({ data: { items: [second], nextCursor: null }, error: null });
      await retry.promise;
    });
    expect(await screen.findByText(second.fullName)).toBeInTheDocument();
    expect(rows()).toBe(2);
  });
});
