import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PresidentInvitations } from "../src/components/PresidentInvitations.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const chapters = Array.from({ length: 6 }, (_, index) => ({ id: `chapter-${index}`, name: `Chapter ${index}` }));
const invitations = () => Array.from({ length: 200 }, (_, index) => ({
  id: `invitation-${index}`, fullName: `Invitee ${index}`, normalizedEmail: `invitee-${index}@example.test`,
  // One chapter's history: the list shows one chapter at a time
  // (BUG-UG-PRESIDENT-INVITATIONS-LIST-HOLDS-OTHER-CHAPTERS-20261125).
  chapterId: chapters[0].id, chapterName: chapters[0].name,
  status: index < 190 ? (index % 2 ? "accepted" : "revoked") : ["pending", "delivery_failed", "expired"][index % 3],
}));

beforeEach(() => { window.history.replaceState({}, "", "/m/vp"); });
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

async function start({ lang = "en", items = invitations(), workspace = true } = {}) {
  const api = { load: vi.fn().mockResolvedValue({ chapters, items }), resendInvitation: vi.fn().mockResolvedValue({}), revokeInvitation: vi.fn().mockResolvedValue({}) };
  const card = <PresidentInvitations api={api} />;
  render(<LanguageProvider lang={lang}>{workspace
    ? <WorkspacePages view="vp" hat="vp" location="/m/vp" navigate={vi.fn()} menu={false}>{card}</WorkspacePages>
    : card}</LanguageProvider>);
  const region = await screen.findByRole("region", { name: lang === "en" ? "Invite a worker" : "Invitar a un trabajador" });
  return { api, region, items };
}

it("bounds one chapter's 200 invitations to six rows, puts actions first and reaches the last history row", async () => {
  const { region, items } = await start();
  expect(region.querySelectorAll(".xus-row")).toHaveLength(6);
  expect(within(region).getByText("Invitee 190")).toBeVisible();
  expect(within(region).queryByText("Invitee 0")).not.toBeInTheDocument();
  expect(within(region).getAllByRole("button", { name: "Resend" })).toHaveLength(6);
  expect(items[0].id).toBe("invitation-0");
  const pager = within(region).getByRole("navigation", { name: "Results pages" });
  expect(within(pager).getByRole("button", { name: "Previous" })).toBeDisabled();
  const next = within(pager).getByRole("button", { name: "Next" });
  for (let page = 1; page < 34; page += 1) {
    fireEvent.click(next);
    expect(region.querySelectorAll(".xus-row").length).toBeLessThanOrEqual(6);
  }
  expect(within(region).getByText("Invitee 189")).toBeVisible();
  expect(next).toBeDisabled();
  fireEvent.click(within(pager).getByRole("button", { name: "Previous" }));
  expect(next).not.toBeDisabled();
});

it("resends and confirms revocation for the exact invitations beyond the first page", async () => {
  const { region, api } = await start();
  expect(within(region).queryByText("Invitee 196")).not.toBeInTheDocument();
  fireEvent.click(within(region).getByRole("button", { name: "Next" }));
  const row = (name) => within(region).getByText(name).closest(".xus-row");
  fireEvent.click(within(row("Invitee 196")).getByRole("button", { name: "Resend" }));
  await waitFor(() => expect(api.resendInvitation).toHaveBeenCalledWith("invitation-196"));
  // A pending control stays enabled (record 8435): wait for its busy state to clear.
  await waitFor(() => { const control = within(row("Invitee 197")).getByRole("button", { name: "Revoke invitation" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
  fireEvent.click(within(row("Invitee 197")).getByRole("button", { name: "Revoke invitation" }));
  fireEvent.click(within(row("Invitee 197")).getByRole("button", { name: "Yes, revoke" }));
  await waitFor(() => expect(api.revokeInvitation).toHaveBeenCalledWith("invitation-197"));
  await waitFor(() => expect(api.load).toHaveBeenCalledTimes(3));
});

it("uses the shared Spanish pager labels", async () => {
  const { region } = await start({ lang: "es" });
  expect(region.querySelectorAll(".xus-row")).toHaveLength(6);
  const pager = within(region).getByRole("navigation", { name: "Páginas de resultados" });
  expect(within(pager).getByRole("button", { name: "Anterior" })).toBeDisabled();
  fireEvent.click(within(pager).getByRole("button", { name: "Siguiente" }));
  expect(within(pager).getByRole("button", { name: "Anterior" })).toBeEnabled();
});

it("keeps remaining rows reachable when rendered without workspace routing", async () => {
  const { region } = await start({ workspace: false });
  expect(region.querySelectorAll(".xus-row")).toHaveLength(6);
  fireEvent.click(within(region).getByRole("button", { name: /Show .*more/ }));
  expect(region.querySelectorAll(".xus-row")).toHaveLength(12);
});
