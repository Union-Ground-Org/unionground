import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { OrganizationCoordinationDesk } from "../src/features/coordination/ui/OrganizationCoordinationDesk.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { useWorkspaceDocumentTitle } from "../src/lib/workspaceTitle.js";

const actor = { userId: "fictional-member", selectedHat: "member", roles: [] };
const ready = { state: "ready", organizationId: "fictional-org", records: [] };
const record = { id: "fictional-link", kind: "network_link", status: "active", title: "Tamarack partners" };
const path = "/m/network";

function NetworkPage({ lang, status, model, onRetry }) {
  useWorkspaceDocumentTitle(catalogue[lang]["demo.hatMember"]);
  return (
    <LanguageProvider lang={lang}>
      <main id="main-content">
        <WorkspacePages view="coordination" location={path} hat="member" navigate={vi.fn()}>
          <OrganizationCoordinationDesk actor={actor} status={status} model={model} onRetry={onRetry} />
        </WorkspacePages>
      </main>
    </LanguageProvider>
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  document.title = "";
});

describe.each(["en", "es"])("Member Organization network in %s (#9527)", (lang) => {
  it.each([
    ["loading", null, "coordination.deskLoading"],
    ["error", null, "coordination.stateUnavailableTitle"],
    ["unavailable", null, "coordination.stateUnavailableTitle"],
    ["mfa_required", null, "coordination.stateMfaTitle"],
    ["unauthorized", null, "coordination.stateUnauthorizedTitle"],
    ["empty", null, "coordination.stateEmptyTitle"],
    ["ready without an organization", { state: "ready" }, "coordination.stateEmptyTitle"],
    ["ready without records", ready, "coordination.tab.network"],
    ["ready with records", { ...ready, records: [record] }, "coordination.tab.network"],
  ])("uses one heading and the matching tab title while %s", async (state, model, messageKey) => {
    const strings = catalogue[lang];
    const title = strings["nav.network"];
    const onRetry = vi.fn();
    window.history.replaceState({}, "", path);
    document.title = "Previous page";
    render(<NetworkPage lang={lang} status={model?.state ?? state} model={model} onRetry={onRetry} />);

    expect(screen.queryAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual([title]);
    expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe(`${title} · ${strings["demo.hatMember"]} | Union Ground`));

    if (state === "loading") {
      expect(screen.getByRole("status")).toHaveTextContent(strings[messageKey]);
    } else {
      expect(screen.getByRole("heading", { level: 2, name: strings[messageKey] })).toBeVisible();
    }
    if (state === "error" || state === "unavailable") {
      expect(screen.getByRole("alert")).toHaveTextContent(strings[messageKey]);
      fireEvent.click(screen.getByRole("button", { name: strings["coordination.stateRetry"] }));
      expect(onRetry).toHaveBeenCalledOnce();
    }
    if (model?.records?.length) expect(screen.getByRole("heading", { name: record.title })).toBeVisible();
  });
});
