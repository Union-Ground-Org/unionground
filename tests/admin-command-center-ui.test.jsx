import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AdminView } from "../src/views/AdminView.jsx";
import { DeskPageLink, DirectoryCard, filterDirectoryRows, saveDirectoryCsv } from "../src/components/AdminCommandCenter.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { MemberApiError } from "../src/lib/memberApiError.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

function commandDesk(overrides = {}) {
  return {
    ...JSON.parse(JSON.stringify(fallbackData.adminDesk)),
    memberDirectory: {
      items: [
        { userId: "00000000-0000-0000-0000-000000000001", fullName: "Ana Rivera", initials: "AR", memberSince: 2021, chapterId: "wor", chapterName: "Harborview Care United", roles: ["admin"] },
        { userId: "00000000-0000-0000-0000-000000000002", fullName: "Darnell Brooks", initials: "DB", memberSince: 2019, chapterId: "wor", chapterName: "Harborview Care United", roles: [] },
      ],
      nextCursor: { name: "Darnell Brooks", id: "00000000-0000-0000-0000-000000000002" },
    },
    organization: {
      scope: "organization", chapterId: null, canCreateChapter: true,
      chapters: [
        { id: "wor", name: "Harborview Care United", region: "Central", isDefault: true, orderIndex: 1, memberCount: 812, staffCount: 7, roleCounts: { steward: 3, organizer: 1, coordinator: 1, advisor: 1, admin: 1, vp: 0 } },
        // No organizer key: a server that predates the organizer count.
        { id: "bos", name: "Harborview Care Boston", region: "Metro", isDefault: false, orderIndex: 2, memberCount: 420, staffCount: 4, roleCounts: { steward: 2, coordinator: 1, advisor: 0, admin: 1, vp: 0 } },
      ],
    },
    ...overrides,
  };
}

function makeApi(desk = commandDesk(), overrides = {}) {
  return {
    loadDesk: vi.fn().mockResolvedValue(desk),
    loadMemberDirectory: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    createChapter: vi.fn().mockResolvedValue({ created: true }),
    updateChapter: vi.fn().mockResolvedValue({ updated: true }),
    grantRole: vi.fn().mockResolvedValue({ granted: true }),
    revokeRole: vi.fn().mockResolvedValue({ revoked: true }),
    searchMembers: vi.fn().mockResolvedValue([]),
    searchRecoveryMembers: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn().mockResolvedValue({ created: true }),
    updateEvent: vi.fn().mockResolvedValue({ updated: true }),
    closeGovernance: vi.fn().mockResolvedValue({ updated: true }),
    loadFormTemplates: vi.fn().mockResolvedValue([]),
    upsertFormTemplate: vi.fn().mockResolvedValue({}),
    deactivateFormTemplate: vi.fn().mockResolvedValue({}),
    reactivateFormTemplate: vi.fn().mockResolvedValue({}),
    updateOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
    updateOrganizationLabel: vi.fn().mockResolvedValue({ updated: true }),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
    dispositionFailedLoginAttempt: vi.fn().mockResolvedValue({ updated: true }),
    ...overrides,
  };
}

function mount(lang = "en", desk = commandDesk(), overrides = {}) {
  const api = makeApi(desk, overrides.api);
  const onNotice = overrides.onNotice || vi.fn();
  render(<LanguageProvider lang={lang}>
    <AdminView data={{ member: { initials: "AR", chapterName: "Harborview Care United" } }} api={api} onNotice={onNotice} demo={overrides.demo} />
  </LanguageProvider>);
  return { api, onNotice };
}

describe("UB-DESK-03 command center UI", () => {
  it("keeps the labelled directory search compact inside its flex row", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toMatch(/\.xus-command-search \.xus-search\s*\{[^}]*flex:\s*0 0 auto/);
  });

  it("composes backed admin surfaces from a keyboard-reachable command index", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Admin command center" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Command center index" });
    expect(within(nav).getByRole("link", { name: "Worker directory" })).toHaveAttribute("href", "#admin-member-directory");
    expect(within(nav).getByRole("link", { name: "Organization & campaigns" })).toHaveAttribute("href", "#admin-organization");
    expect(within(nav).getByRole("link", { name: "Lifecycle controls" })).toHaveAttribute("href", "#admin-lifecycle");
    expect(within(nav).getByRole("link", { name: "Invite & onboarding" })).toHaveAttribute("href", "#admin-invitations");
    expect(within(nav).getByRole("link", { name: "Data-rights queue" })).toHaveAttribute("href", "#admin-governance");
  });

  it("browses a privacy-minimal directory and appends the next keyset page", async () => {
    const next = { userId: "00000000-0000-0000-0000-000000000003", fullName: "Jordan Bell", initials: "JB", memberSince: 2023, chapterId: "wor", chapterName: "Harborview Care United", roles: [] };
    const { api } = mount("en", commandDesk(), {
      api: { loadMemberDirectory: vi.fn().mockResolvedValue({ items: [next], nextCursor: null }) },
    });
    const directoryHeading = await screen.findByRole("heading", { name: "Worker directory" });
    const directory = within(directoryHeading.closest("article"));
    expect(directory.getByText("Darnell Brooks")).toBeInTheDocument();
    expect(directory.getByText("With the campaign since 2019 · Harborview Care United")).toBeInTheDocument();
    expect(directory.queryByText(/#0002/)).toBeNull();
    fireEvent.click(directory.getByRole("button", { name: "Load more workers" }));
    expect(await directory.findByText("Jordan Bell")).toBeInTheDocument();
    expect(api.loadMemberDirectory).toHaveBeenCalledWith("", { name: "Darnell Brooks", id: "00000000-0000-0000-0000-000000000002" });
    expect(directory.queryByText(/@/)).toBeNull();
  });

  it("BUG-UG-ADMIN-DIRECTORY-LOAD-MORE-CURSOR-QUERY-20260907 binds a whitespace-normalized search to its cursor", async () => {
    const first = { userId: "00000000-0000-0000-0000-000000000010", fullName: "Zeta Adams", initials: "ZA", memberSince: 2022, chapterId: "wor", chapterName: "Harborview Care United", roles: [] };
    const second = { userId: "00000000-0000-0000-0000-000000000011", fullName: "Zeta Brown", initials: "ZB", memberSince: 2023, chapterId: "wor", chapterName: "Harborview Care United", roles: [] };
    const cursor = { name: first.fullName, id: first.userId };
    const { api } = mount("en", commandDesk(), {
      api: { loadMemberDirectory: vi.fn().mockResolvedValueOnce({ items: [first], nextCursor: cursor }).mockResolvedValueOnce({ items: [second], nextCursor: null }) },
    });
    const directory = within((await screen.findByRole("heading", { name: "Worker directory" })).closest("article"));
    const filter = directory.getByRole("searchbox", { name: "Filter worker directory by name (optional)" });
    fireEvent.change(filter, { target: { value: "Zeta" } });
    fireEvent.submit(filter.closest("form"));
    expect(await directory.findByText("Zeta Adams")).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: " Zeta " } });
    fireEvent.click(directory.getByRole("button", { name: "Load more workers" }));
    expect(await directory.findByText("Zeta Brown")).toBeInTheDocument();
    expect(api.loadMemberDirectory).toHaveBeenLastCalledWith("Zeta", cursor);
    expect(directory.queryByText("Ana Rivera")).toBeNull();
  });

  it("does not expose a stale keyset cursor after the search text changes", async () => {
    mount();
    const directoryHeading = await screen.findByRole("heading", { name: "Worker directory" });
    const directory = within(directoryHeading.closest("article"));
    fireEvent.change(directory.getByRole("searchbox", { name: "Filter worker directory by name (optional)" }), {
      target: { value: "Zeta" },
    });

    expect(directory.queryByRole("button", { name: "Load more workers" })).toBeNull();
  });

  it("does not page a prior cursor after the submitted search fails or changes", async () => {
    const cursor = { name: "Darnell Brooks", id: "00000000-0000-0000-0000-000000000002" };
    const { api } = mount("en", commandDesk(), {
      api: { loadMemberDirectory: vi.fn().mockRejectedValue(new Error("reader unavailable")) },
    });
    const directoryHeading = await screen.findByRole("heading", { name: "Worker directory" });
    const directory = within(directoryHeading.closest("article"));
    const filter = directory.getByRole("searchbox", { name: "Filter worker directory by name (optional)" });
    fireEvent.change(filter, { target: { value: "Zeta" } });
    fireEvent.submit(filter.closest("form"));
    expect(await directory.findByRole("alert")).toBeInTheDocument();
    expect(directory.queryByRole("button", { name: "Load more workers" })).toBeNull();

    fireEvent.change(filter, { target: { value: "Omega" } });
    fireEvent.submit(filter.closest("form"));
    await waitFor(() => expect(api.loadMemberDirectory).toHaveBeenLastCalledWith("Omega", null));
    expect(directory.queryByRole("button", { name: "Load more workers" })).toBeNull();
    expect(api.loadMemberDirectory).toHaveBeenCalledWith("Zeta", null);
    expect(api.loadMemberDirectory).not.toHaveBeenCalledWith("Omega", cursor);
  });

  it("releases an unfiltered directory request superseded by a desk reload", async () => {
    const initialDesk = commandDesk();
    const reloadedDesk = commandDesk();
    let resolvePage;
    const loadMemberDirectory = vi.fn().mockImplementation(() => new Promise((resolve) => { resolvePage = resolve; }));
    const { api } = mount("en", initialDesk, {
      api: {
        loadDesk: vi.fn().mockResolvedValueOnce(initialDesk).mockResolvedValueOnce(reloadedDesk),
        loadMemberDirectory,
      },
    });
    const directoryHeading = await screen.findByRole("heading", { name: "Worker directory" });
    const directory = within(directoryHeading.closest("article"));
    fireEvent.click(directory.getByRole("button", { name: "Load more workers" }));
    expect(directory.getByRole("button", { name: "Loading…" })).toHaveAttribute("aria-disabled", "true");

    // Union Ground offers no passkey sign-in, so its setting is not on the
    // desk; the sibling save that reloads the desk is the recovery-code switch.
    expect(screen.queryByText("Member passkey enrollment")).toBeNull();
    const siblingRow = document.querySelector('.xus-config-row[data-setting-key="features.mfa_recovery_code_enrollment"]');
    expect(within(siblingRow).getByText("Recovery code enrollment")).toBeInTheDocument();
    fireEvent.click(within(siblingRow).getByRole("checkbox"));
    fireEvent.click(within(siblingRow).getByRole("button", { name: /^Save Recovery code enrollment/ }));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
    resolvePage({ items: [], nextCursor: null });

    expect(await directory.findByRole("button", { name: "Refresh directory" })).toBeEnabled();
    expect(directory.getByRole("button", { name: "Load more workers" })).toBeEnabled();
  });

  it("keeps an applied directory search after a sibling save reloads the desk", async () => {
    const filtered = { userId: "00000000-0000-0000-0000-000000000009", fullName: "Zeta Jones", initials: "ZJ", memberSince: 2024, chapterId: "wor", chapterName: "Harborview Care United", roles: [] };
    const initialDesk = commandDesk();
    const reloadedDesk = commandDesk();
    const { api } = mount("en", initialDesk, {
      api: {
        loadDesk: vi.fn().mockResolvedValueOnce(initialDesk).mockResolvedValueOnce(reloadedDesk),
        loadMemberDirectory: vi.fn().mockResolvedValue({ items: [filtered], nextCursor: null }),
      },
    });
    const directoryHeading = await screen.findByRole("heading", { name: "Worker directory" });
    const directory = within(directoryHeading.closest("article"));
    const filter = directory.getByRole("searchbox", { name: "Filter worker directory by name (optional)" });
    fireEvent.change(filter, { target: { value: "Zeta" } });
    fireEvent.submit(filter.closest("form"));
    expect(await directory.findByText("Zeta Jones")).toBeInTheDocument();

    // Union Ground offers no passkey sign-in, so its setting is not on the
    // desk; the sibling save that reloads the desk is the recovery-code switch.
    expect(screen.queryByText("Member passkey enrollment")).toBeNull();
    const siblingRow = document.querySelector('.xus-config-row[data-setting-key="features.mfa_recovery_code_enrollment"]');
    expect(within(siblingRow).getByText("Recovery code enrollment")).toBeInTheDocument();
    fireEvent.click(within(siblingRow).getByRole("checkbox"));
    fireEvent.click(within(siblingRow).getByRole("button", { name: /^Save Recovery code enrollment/ }));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));

    expect(await directory.findByText("Zeta Jones")).toBeInTheDocument();
    expect(directory.queryByText("Ana Rivera")).toBeNull();
    expect(api.loadMemberDirectory).toHaveBeenLastCalledWith("Zeta", null);
  });

  it("accepts an empty directory search and distinguishes an unavailable reader", async () => {
    const { api } = mount();
    const directoryHeading = await screen.findByRole("heading", { name: "Worker directory" });
    const directory = within(directoryHeading.closest("article"));
    expect(directory.getByText("Darnell Brooks")).toBeInTheDocument();
    const filter = directory.getByRole("searchbox", { name: "Filter worker directory by name (optional)" });
    fireEvent.change(filter, { target: { value: "" } });
    fireEvent.submit(filter.closest("form"));
    await waitFor(() => expect(api.loadMemberDirectory).toHaveBeenCalledWith("", null));

    cleanup();
    mount("en", commandDesk({ memberDirectory: null }));
    expect(await screen.findByText("The worker directory could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("No workers match this directory view.")).toBeNull();
  });

  // UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122: a chapter
  // shows its name and region, never its machine id under the name; the id
  // stays reachable behind Technical details for CSV imports; one member reads
  // "1 active member".

  // A new chapter's name comes first and its web name follows the name until
  // the person touches the web name field. Fictional chapters only.
  it.each([
    ["en", { add: "Add campaign", name: "Campaign name", web: "Web name", order: "List position", save: "Create campaign",
      fromName: "Filled in from the campaign name, and part of the campaign's web address. You can change it before you save; after that it stays." }],
    ["es", { add: "Añadir campaña", name: "Nombre de la campaña", web: "Nombre web", order: "Posición en la lista", save: "Crear campaña",
      fromName: "Se completa con el nombre de la campaña y forma parte de su dirección web. Puedes cambiarlo antes de guardar; después queda fijo." }],
  ])("asks for the chapter name first and fills the web name from it (%s)", async (lang, labels) => {
    const { api } = mount(lang, commandDesk(), { api: { createChapter: vi.fn().mockResolvedValue({ created: true }) } });
    fireEvent.click(await screen.findByRole("button", { name: labels.add }));
    const name = screen.getByLabelText(labels.name);
    const web = screen.getByLabelText(labels.web);
    expect(name.compareDocumentPosition(web) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(web).toHaveAccessibleDescription(expect.stringContaining(labels.fromName));
    expect(screen.getByLabelText(labels.order)).toBeRequired();
    fireEvent.change(name, { target: { value: "Tamarack Peña Depot" } });
    expect(web).toHaveValue("tamarack-pena-depot");
    fireEvent.change(web, { target: { value: "" } });
    fireEvent.change(name, { target: { value: "Tamarack Peña Depot North" } });
    expect(web).toHaveValue("");
    fireEvent.change(web, { target: { value: "tamarack-north" } });
    fireEvent.change(name, { target: { value: "Tamarack North Depot" } });
    expect(web).toHaveValue("tamarack-north");
    fireEvent.change(screen.getByLabelText(labels.order), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(api.createChapter).toHaveBeenCalledWith({ id: "tamarack-north", name: "Tamarack North Depot", region: "", orderIndex: 4 }));
  });

  it("announces the web name limit when the name fills it past the cap and back", async () => {
    mount("en", commandDesk());
    fireEvent.click(await screen.findByRole("button", { name: "Add campaign" }));
    const name = screen.getByLabelText("Campaign name");
    const status = () => screen.getByLabelText("Web name").closest("label").querySelector('[role="status"]');
    fireEvent.change(name, { target: { value: "Tamarack Valley Human Services North" } });
    expect(screen.getByLabelText("Web name")).toHaveValue("tamarack-valley-human-services-n");
    expect(status()).toHaveTextContent("Web name limit reached.");
    fireEvent.change(name, { target: { value: "Tamarack Valley" } });
    expect(screen.getByLabelText("Web name")).toHaveValue("tamarack-valley");
    expect(status()).toHaveTextContent("Web name is below the limit.");
  });

  it.each([
    ["en", "Add campaign", "Web name", "Campaign name", "List position", "Create campaign",
      "Use up to 32 lowercase letters (a–z), digits (0–9), or hyphens.",
      "32 of 32 characters", "A campaign already uses this web name or name. Choose a different one."],
    ["es", "Añadir campaña", "Nombre web", "Nombre de la campaña", "Posición en la lista", "Crear campaña",
      "Usa hasta 32 letras minúsculas (a–z), dígitos (0–9) o guiones.",
      "32 de 32 caracteres", "Ya hay una campaña con este nombre web o este nombre. Elige otro."],
  ])("explains chapter ID limits and conflicts in %s",
    async (lang, add, idLabel, nameLabel, orderLabel, save, rule, count, conflict) => {
      const refusal = { code: "23505", message: "chapter already exists" };
      const { api } = mount(lang, commandDesk(), {
        api: { createChapter: vi.fn().mockRejectedValue(lang === "en" ? refusal : new MemberApiError("Create chapter", refusal)) },
      });
      fireEvent.click(await screen.findByRole("button", { name: add }));
      const id = screen.getByLabelText(idLabel);
      const form = within(id.form);
      expect(id).toHaveAccessibleDescription(expect.stringContaining(rule));
      fireEvent.change(form.getByLabelText(nameLabel), { target: { value: "Tamarack Orchard" } });
      fireEvent.change(form.getByLabelText(orderLabel), { target: { value: "3" } });
      fireEvent.change(id, { target: { value: "Norte-1" } });
      fireEvent.click(form.getByRole("button", { name: save }));
      expect(form.getByRole("alert")).toHaveTextContent(rule);
      expect(api.createChapter).not.toHaveBeenCalled();
      expect(id).toHaveValue("Norte-1");

      const validId = "tamarack-".padEnd(32, "a");
      fireEvent.change(id, { target: { value: validId } });
      expect(form.queryByRole("alert")).toBeNull();
      expect(form.getByText(count)).toBeVisible();
      fireEvent.click(form.getByRole("button", { name: save }));
      expect(await form.findByRole("alert")).toHaveTextContent(conflict);
      expect(id).toHaveValue(validId);
      expect(api.createChapter).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: validId, name: "Tamarack Orchard", orderIndex: 3 }),
      );
    },
  );

  it("uses the generic chapter error for an unrelated uniqueness refusal", async () => {
    const error = new MemberApiError("Create chapter", {
      code: "23505",
      message: 'duplicate key value violates unique constraint "audit_receipt_key"',
    });
    const { api } = mount("en", commandDesk(), { api: { createChapter: vi.fn().mockRejectedValue(error) } });
    fireEvent.click(await screen.findByRole("button", { name: "Add campaign" }));
    const id = screen.getByLabelText("Web name");
    const form = within(id.form);
    fireEvent.change(id, { target: { value: "tamarack" } });
    fireEvent.change(form.getByLabelText("Campaign name"), { target: { value: "Tamarack Orchard" } });
    fireEvent.change(form.getByLabelText("List position"), { target: { value: "3" } });
    fireEvent.click(form.getByRole("button", { name: "Create campaign" }));
    expect(await form.findByRole("alert")).toHaveTextContent("The campaign change could not be saved.");
    expect(form.queryByText(/already uses this web name or name|audit_receipt_key/)).toBeNull();
    expect(id).toHaveValue("tamarack");
    expect(api.createChapter).toHaveBeenCalledOnce();
  });

  it.each([
    ["en", "Add campaign", "Web name", "of 32 characters", "Web name limit reached.", "Web name is below the limit."],
    ["es", "Añadir campaña", "Nombre web", "de 32 caracteres", "Se alcanzó el límite del nombre web.", "El nombre web está por debajo del límite."],
  ])("announces only crossings of the chapter ID cap in %s",
    async (lang, add, idLabel, counter, reached, below) => {
      mount(lang);
      fireEvent.click(await screen.findByRole("button", { name: add }));
      const id = screen.getByLabelText(idLabel);
      const form = within(id.form);
      const status = form.getByRole("status");
      expect(status).toBeEmptyDOMElement();

      for (const length of [26, 31]) {
        fireEvent.change(id, { target: { value: "a".repeat(length) } });
        expect(form.getByText(`${length} ${counter}`)).toBeVisible();
        expect(status).toBeEmptyDOMElement();
      }
      fireEvent.change(id, { target: { value: "a".repeat(32) } });
      expect(form.getByText(`32 ${counter}`)).toBeVisible();
      expect(id).not.toHaveAccessibleDescription(expect.stringContaining(`32 ${counter}`));
      expect(status).toHaveTextContent(reached);
      fireEvent.change(id, { target: { value: "b".repeat(32) } });
      expect(status).toHaveTextContent(reached);
      for (const length of [31, 30]) {
        fireEvent.change(id, { target: { value: "a".repeat(length) } });
        expect(form.getByText(`${length} ${counter}`)).toBeVisible();
        expect(status).toHaveTextContent(below);
      }
    },
  );


  it("shows current organization counts and routes create/update through audited APIs", async () => {
    const { api, onNotice } = mount();
    expect(await screen.findByText("812 active workers · 7 staff")).toBeInTheDocument();
    // Role counts use Union Ground's hat labels (steward = Committee,
    // vp = Campaign chair); the internal role ids are unchanged.
    expect(screen.getByText("Committee 3")).toBeInTheDocument();
    expect(screen.getAllByText("Campaign chair 0")).toHaveLength(2);
    expect(screen.queryByText(/^(Steward|President) \d/)).toBeNull();
    const roleCounts = screen.getAllByRole("list", { name: "Staff role counts" });
    expect(roleCounts).toHaveLength(2);
    // Organizer is a staff hat with its own count (
    // October 15, 2026); a chapter the server reports without one reads 0.
    expect(within(roleCounts[0]).getAllByRole("listitem")).toHaveLength(6);
    expect(within(roleCounts[0]).getByText("Organizer 1")).toBeInTheDocument();
    expect(within(roleCounts[1]).getByText("Organizer 0")).toBeInTheDocument();
    expect(screen.queryByText(/^organizer \d/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add campaign" }));
    fireEvent.change(screen.getByLabelText("Web name"), { target: { value: "north" } });
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "North Shore DDS" } });
    fireEvent.change(screen.getByLabelText("Region (optional)"), { target: { value: "Northeast" } });
    fireEvent.change(screen.getByLabelText("List position"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(api.createChapter).toHaveBeenCalledWith({ id: "north", name: "North Shore DDS", region: "Northeast", orderIndex: 3 }));
    expect(onNotice).toHaveBeenCalledWith("Campaign created");

    // The create leaves the card busy, and every chapter's Edit button is
    // disabled while it is. Waiting only for createChapter to have been called
    // says nothing about that flag being cleared on screen, so clicking Edit
    // here can land on a still-disabled button and silently do nothing.
    const editWorcester = await screen.findByRole("button", { name: "Edit Harborview Care United" });
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = editWorcester; expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    fireEvent.click(editWorcester);
    const form = await screen.findByRole("group", { name: "Edit Harborview Care United" });
    fireEvent.change(within(form).getByLabelText("Region (optional)"), { target: { value: "Central Massachusetts" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save campaign" }));
    await waitFor(() => expect(api.updateChapter).toHaveBeenCalledWith("wor", { name: "Harborview Care United", region: "Central Massachusetts", orderIndex: 1 }));
  });

  it("keeps scoped admins in their current chapter and omits destructive/fake controls", async () => {
    const scoped = commandDesk({
      organization: {
        scope: "campaign", chapterId: "wor", canCreateChapter: false,
        chapters: [{ id: "wor", name: "Harborview Care United", region: "Central", isDefault: true, orderIndex: 1, memberCount: 812, staffCount: 6, roleCounts: { steward: 3, coordinator: 1, advisor: 1, admin: 1, vp: 0 } }],
      },
    });
    mount("en", scoped);
    await screen.findByText("812 active workers · 6 staff");
    expect(screen.getByText("Campaign-scoped admin access · Harborview Care United")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add campaign" })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete chapter/i })).toBeNull();
    expect(screen.queryByText(/bulk import|dues|retention timer|api key|webhook|sso/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Harborview Care United" }));
    const form = screen.getByRole("group", { name: "Edit Harborview Care United" });
    expect(within(form).getByLabelText("Campaign name")).toBeInTheDocument();
    expect(within(form).queryByLabelText("Region (optional)")).toBeNull();
    expect(within(form).queryByLabelText("List position")).toBeNull();
  });

  it("maps real lifecycle controls without duplicating member-owned destruction", async () => {
    mount();
    await screen.findByRole("heading", { name: "Lifecycle controls" });
    const lifecycle = document.getElementById("admin-lifecycle");
    expect(within(lifecycle).getByRole("link", { name: "Review invitations" })).toHaveAttribute("href", "#admin-invitations");
    expect(within(lifecycle).getByRole("link", { name: "Review data-rights requests" })).toHaveAttribute("href", "#admin-governance");
    expect(within(lifecycle).getByRole("link", { name: "Open retention schedule" })).toHaveAttribute("href", "/retention");
    //: it opened Organize and the person still had to choose Data rights.
    expect(within(lifecycle).getByRole("link", { name: "Open worker data rights" })).toHaveAttribute("href", "/m/organize/governance");
    expect(within(lifecycle).queryByRole("button", { name: /delete.*account/i })).toBeNull();
  });

  it("names the command index apart from the command region and gates each card once", async () => {
    mount();
    await screen.findByRole("heading", { name: "Admin command center" });
    // The region and its index are two landmarks; a screen-reader landmark list
    // has to tell them apart, so they cannot share one accessible name.
    expect(screen.getByRole("region", { name: "Admin command center" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Admin command center" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Command center index" })).toBeInTheDocument();
    // WorkspaceSection is a pure mount gate. A card wrapped in a second gate of
    // the same name can only ever repeat the test its own body already runs.
    const source = readFileSync("src/components/AdminCommandCenter.jsx", "utf8");
    const gates = [...source.matchAll(/<WorkspaceSection name="([^"]+)"/g)].map(([, name]) => name);
    expect(gates).toHaveLength(new Set(gates).size);
  });

  it("A11Y-UG-ADMIN-FIELDS-HIDE-TWO-CHARACTER-MINIMUM-20260920 describes the directory filter's blank-or-two-character rule in both languages", async () => {
    const { api } = mount();
    const directory = within((await screen.findByRole("heading", { name: "Worker directory" })).closest("article"));
    const filter = directory.getByRole("searchbox", { name: "Filter worker directory by name (optional)" });
    const help = directory.getByText("Leave this blank to list every worker, or enter at least 2 characters to filter. One character is not enough.");
    expect(help.id).toBeTruthy();
    expect(filter).toHaveAttribute("aria-describedby", help.id);

    // The help text is only honest if the guard matches it: one character is
    // refused, blank submits, and two characters filter.
    fireEvent.change(filter, { target: { value: "Z" } });
    expect(directory.getByRole("button", { name: "Refresh directory" })).toBeDisabled();
    fireEvent.submit(filter.closest("form"));
    expect(api.loadMemberDirectory).not.toHaveBeenCalled();

    fireEvent.change(filter, { target: { value: "" } });
    fireEvent.submit(filter.closest("form"));
    await waitFor(() => expect(api.loadMemberDirectory).toHaveBeenCalledWith("", null));
    fireEvent.change(filter, { target: { value: "Ze" } });
    expect(directory.getByRole("button", { name: "Refresh directory" })).toBeEnabled();
    fireEvent.submit(filter.closest("form"));
    await waitFor(() => expect(api.loadMemberDirectory).toHaveBeenLastCalledWith("Ze", null));

    cleanup();
    mount("es");
    const spanish = within((await screen.findByRole("heading", { name: "Directorio de trabajadores" })).closest("article"));
    const spanishFilter = spanish.getByRole("searchbox", { name: "Filtrar el directorio por nombre (opcional)" });
    const spanishHelp = spanish.getByText("Déjalo en blanco para ver a todos los trabajadores o escribe al menos 2 caracteres para filtrar. Un solo carácter no basta.");
    expect(spanishFilter).toHaveAttribute("aria-describedby", spanishHelp.id);
  });

  it("renders the restored command center in Spanish", async () => {
    mount("es");
    expect(await screen.findByRole("heading", { name: "Centro de mando administrativo" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Directorio de trabajadores" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Organización y campañas" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Controles del ciclo de vida" })).toBeInTheDocument();
    expect(screen.getByText("812 trabajadores activos · 7 personas del personal")).toBeInTheDocument();
    expect(screen.getByText("Comité 3")).toBeInTheDocument();
    expect(screen.getByText("Organizador 1")).toBeInTheDocument();
    expect(screen.getAllByText("Presidencia de campaña 0")).toHaveLength(2);
  });
});

// Edges of the command center that the flows above do not reach: modified
// clicks on desk links, a title saved from the directory row, cancelled chapter
// forms, a failed chapter save and sparse chapter rows.
describe("command center edges", () => {
  it("opens a desk link in the workspace on a plain click and leaves modified clicks to the browser", () => {
    const navigate = vi.fn();
    render(<LanguageProvider lang="en">
      <WorkspacePages view="admin" location="/m/admin" navigate={navigate} hat="admin" menu={false}>
        <DeskPageLink path="/m/admin/roster-import">Import</DeskPageLink>
      </WorkspacePages>
    </LanguageProvider>);
    const link = screen.getByRole("link", { name: "Import" });
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
      expect(fireEvent.click(link, { [modifier]: true })).toBe(true);
    }
    expect(navigate).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(false);
    expect(navigate).toHaveBeenCalledWith("admin", "/m/admin/roster-import", null, { replace: false });
    cleanup();
    render(<DeskPageLink path="/m/admin/invitations">Invitations</DeskPageLink>);
    expect(fireEvent.click(screen.getByRole("link", { name: "Invitations" }))).toBe(true);
  });

  it("filters rows that carry no role list and saves nothing without a document", () => {
    expect(filterDirectoryRows([{ userId: "a" }, null, { userId: "b", roles: ["vp"] }], { role: "member" }).map((row) => row?.userId ?? null))
      .toEqual(["a", null]);
    expect(saveDirectoryCsv("a,b", { doc: null, now: new Date("2026-11-01T12:00:00Z") })).toMatchObject({ downloaded: false });
  });



  it("says when the organization structure could not be loaded", async () => {
    mount("en", commandDesk({ organization: null }));
    expect(await screen.findByText("The organization structure could not be loaded.")).toBeInTheDocument();
  });
});

describe("command center writes keep focus while they run (#8435)", () => {
  it("keeps Save title focused while the title is saved, and saves it once", async () => {
    const api = {
      loadMemberDirectory: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      setMemberDisplayTitle: vi.fn(async (_user, _chapter, title) => ({ updated: true, displayTitle: title })),
    };
    const initial = { items: [{ userId: "u1", fullName: "Ada Stone", initials: "AS", chapterId: "north", chapterName: "North", roles: [], displayTitleEditable: true }], nextCursor: null };
    render(<LanguageProvider lang="en"><DirectoryCard initial={initial} api={api} reload={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Set a title for Ada Stone" }));
    fireEvent.change(document.querySelector('input[list="officer-titles-u1"]'), { target: { value: "Recording Secretary" } });
    await expectHeldWriteFocus(api.setMemberDisplayTitle, screen.getByRole("button", { name: "Save title" }));
    expect(api.setMemberDisplayTitle).toHaveBeenCalledTimes(1);
  });
});
