import { within } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MemberOperations } from "../src/features/memberOperations/MemberOperations.jsx";

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
const workspace = {
  state: "ready",
  organizationId: actor.selectedOrganizationId,
  deliveryConfigured: false,
  directory: { items: [first], nextCursor: { name: first.fullName, id: first.userId } },
  campaigns: [],
  imports: [],
};

it("keeps an immediate first page after mount effects and still replaces a later workspace", async () => {
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  // A real DOM commit is observable before passive effects. An act-wrapped
  // render would flush that boundary away and hide the reported scheduling.
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let clickObserved = false;
  let signalClick;
  let rejectClick;
  const clicked = new Promise((resolve, reject) => { signalClick = resolve; rejectClick = reject; });
  const clickDeadline = setTimeout(() => rejectClick(new Error("Initial directory did not expose its next-page button")), 1000);
  const observer = new MutationObserver(() => {
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent === "Load next page");
    if (!button || clickObserved) return;
    clickObserved = true;
    button.click();
    signalClick();
  });
  observer.observe(container, { childList: true, subtree: true });
  const client = { rpc: vi.fn(async (name) => ({
    data: name === "get_member_operations_workspace" ? workspace : { items: [second], nextCursor: null },
    error: null,
  })) };
  const onNotice = vi.fn();
  try {
    root.render(<MemberOperations actor={actor} client={client} onNotice={onNotice} />);
    await clicked;
    clearTimeout(clickDeadline);
    expect(await within(container).findByText(second.fullName)).toBeInTheDocument();
    expect(container.querySelectorAll(".member-operations-row")).toHaveLength(2);
    expect(within(container).queryByRole("button", { name: "Load next page" })).not.toBeInTheDocument();
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "get_member_operations_workspace", "get_member_operations_directory",
    ]);
    expect(client.rpc).toHaveBeenCalledWith("get_member_operations_directory", {
      p_query: null, p_after_name: first.fullName, p_after_id: first.userId, p_limit: 25,
    });
    expect(onNotice).not.toHaveBeenCalled();

    const replacement = { ...first, fullName: "Morgan Chen", userId: "99999999-9999-4999-8999-999999999999" };
    const refreshed = { ...workspace, directory: { items: [replacement], nextCursor: null } };
    const replacementClient = { rpc: vi.fn(async () => ({ data: refreshed, error: null })) };
    root.render(<MemberOperations actor={actor} client={replacementClient} onNotice={onNotice} />);
    expect(await within(container).findByText(replacement.fullName)).toBeInTheDocument();
    expect(container.querySelectorAll(".member-operations-row")).toHaveLength(1);
    expect(within(container).queryByText(first.fullName)).not.toBeInTheDocument();
    expect(within(container).queryByText(second.fullName)).not.toBeInTheDocument();
    expect(replacementClient.rpc).toHaveBeenCalledExactlyOnceWith("get_member_operations_workspace", undefined);
  } finally {
    clearTimeout(clickDeadline);
    observer.disconnect();
    root.unmount();
    container.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
