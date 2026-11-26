import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseworkOperationsPanel } from "../src/components/CaseworkOperationsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const scope = {
  id: "case-1",
  organization_id: "org-1",
  chapter_id: "ch-1",
  step: "Intake",
  status: "active",
  is_restricted: false,
};

const caseData = {
  scope,
  strength: [],
  deadlines: [],
  checklists: [],
  transitions: [],
  alerts: [],
  management: [],
  retaliation: [],
  links: [],
  reminders: [],
};

function operationApi(overrides = {}) {
  return {
    loadCaseworkCase: vi.fn().mockResolvedValue(caseData),
    scoreCase: vi.fn().mockResolvedValue({}),
    setCaseRestriction: vi.fn().mockResolvedValue({}),
    createCaseDeadline: vi.fn().mockResolvedValue({}),
    requestDeadlineExtension: vi.fn().mockResolvedValue({}),
    decideDeadlineExtension: vi.fn().mockResolvedValue({}),
    advanceCaseStep: vi.fn().mockResolvedValue({}),
    createCaseAlert: vi.fn().mockResolvedValue({}),
    acknowledgeCaseAlert: vi.fn().mockResolvedValue({}),
    createCaseReminder: vi.fn().mockResolvedValue({}),
    setReminderStatus: vi.fn().mockResolvedValue({}),
    setChecklistItem: vi.fn().mockResolvedValue({}),
    logManagementBehavior: vi.fn().mockResolvedValue({}),
    addManagementAddendum: vi.fn().mockResolvedValue({}),
    linkCases: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function article(name) {
  return screen.getByRole("heading", { name }).closest("article");
}

function setField(container, label, value) {
  fireEvent.change(within(container).getByLabelText(label), { target: { value } });
}

function renderPanel(api, onChanged, onNotice = vi.fn()) {
  return render(
    <LanguageProvider lang="en">
      <CaseworkOperationsPanel caseId="case-1" api={api} onNotice={onNotice} onChanged={onChanged} />
    </LanguageProvider>,
  );
}

describe("CaseworkOperationsPanel write funnel reports onChanged", () => {
  it("fires onChanged once per successful non-procedure operation and never after a rejected write", async () => {
    const api = operationApi();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const onNotice = vi.fn();
    renderPanel(api, onChanged, onNotice);
    expect(await screen.findByText("Issue tools")).toBeInTheDocument();

    const deadline = article("Deadline center");
    setField(deadline, "Deadline label", "Management response due");
    setField(deadline, "Due date and time", "2026-09-10T12:00");
    fireEvent.click(within(deadline).getByRole("button", { name: "Add deadline" }));
    await waitFor(() => expect(api.createCaseDeadline).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    const management = article("Management behavior log");
    setField(management, "Management person", "Manager Two");
    setField(management, "Occurred", "2026-08-28T12:00");
    setField(management, "Observation", "Changed the member assignment without notice");
    fireEvent.click(within(management).getByRole("button", { name: "Log behavior" }));
    await waitFor(() => expect(api.logManagementBehavior).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));

    api.createCaseDeadline.mockRejectedValueOnce(new Error("deadline refused"));
    setField(deadline, "Deadline label", "Follow-up meeting");
    setField(deadline, "Due date and time", "2026-09-11T12:00");
    fireEvent.click(within(deadline).getByRole("button", { name: "Add deadline" }));
    // The raw driver text never reaches the notice; the catalogue sentence does.
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("That casework action could not be saved."));
    expect(onNotice).not.toHaveBeenCalledWith("deadline refused");
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});

describe("CaseworkOperationsPanel records the write before the panel refresh", () => {
  // A committed case change must reach the access history even if the panel's
  // own reload never settles (network stall, or the desk closed while the
  // refresh was outstanding).
  it("fires onChanged for a case-tools write whose refresh never settles", async () => {
    const api = operationApi();
    api.loadCaseworkCase.mockResolvedValueOnce(caseData).mockReturnValue(new Promise(() => {}));
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const onNotice = vi.fn();
    renderPanel(api, onChanged, onNotice);
    expect(await screen.findByText("Issue tools")).toBeInTheDocument();

    const deadline = article("Deadline center");
    setField(deadline, "Deadline label", "Management response due");
    setField(deadline, "Due date and time", "2026-09-10T12:00");
    fireEvent.click(within(deadline).getByRole("button", { name: "Add deadline" }));

    await waitFor(() => expect(api.createCaseDeadline).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onNotice).toHaveBeenCalledWith("Issue tools updated.");
    expect(api.loadCaseworkCase).toHaveBeenCalledTimes(2);
  });
});

// Union Ground issues carry no grievance procedure, no stage checklists and
// no unfair-labor-practice filing clock (owner decision, 2026-10-13): even when
// the api still exposes the old procedure, checklist and retaliation-flag
// reads, the panel offers none of those controls and never calls them.
describe("CaseworkOperationsPanel offers no removed casework controls", () => {
  it("shows no step progression, stage checklist or ULP panel and never advances a step", async () => {
    const api = operationApi({
      getCaseProcedure: vi.fn().mockResolvedValue({
        name: "Grievance",
        steps: [
          { key: "Intake", label: "Intake", position: 1 },
          { key: "Step 1", label: "Step 1", position: 2 },
        ],
      }),
      listCaseRetaliationFlags: vi.fn().mockResolvedValue([]),
    });
    api.loadCaseworkCase.mockResolvedValue({
      ...caseData,
      checklists: [{ id: "cl-1", title: "Intake checklist", step: "Intake", items: [{ id: "item-1", label: "Collect statement", required: true, completed_at: null }] }],
    });
    const { container } = renderPanel(api, vi.fn().mockResolvedValue(undefined));
    expect(await screen.findByText("Issue tools")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deadline center" })).toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: "Step progression" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Stage checklists" })).toBeNull();
    expect(screen.queryByLabelText("Next step")).toBeNull();
    expect(screen.queryByRole("button", { name: "Advance step" })).toBeNull();
    expect(screen.queryByText("Intake checklist")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Collect statement/ })).toBeNull();
    expect(container.querySelector("[id^='casework-ulp-']")).toBeNull();
    expect(api.getCaseProcedure).not.toHaveBeenCalled();
    expect(api.listCaseRetaliationFlags).not.toHaveBeenCalled();
    expect(api.advanceCaseStep).not.toHaveBeenCalled();
    expect(api.setChecklistItem).not.toHaveBeenCalled();
  });

  it("offers only the response and follow-up deadline kinds", async () => {
    renderPanel(operationApi(), vi.fn().mockResolvedValue(undefined));
    expect(await screen.findByText("Issue tools")).toBeInTheDocument();
    const kind = within(article("Deadline center")).getByLabelText("Deadline type");
    expect([...kind.querySelectorAll("option")].map((option) => option.value)).toEqual(["response", "follow_up"]);
  });
});

// BUG-UG-WEB-CASE-GRANT-ACCESS-ALWAYS-FAILS-20261003: the grant row's
// reason is required (8 to 500 characters), so the form asks for it and sends
// it, and the database's refusal of a short reason reads as catalogue copy.
describe("CaseworkOperationsPanel explicit access grant", () => {
  function restrictedApi(overrides = {}) {
    const api = operationApi({
      loadAccessCandidates: vi.fn().mockResolvedValue([{ userId: "staff-2", fullName: "Staff Two", roles: ["steward"] }]),
      grantCaseAccess: vi.fn().mockResolvedValue({}),
      revokeCaseAccess: vi.fn().mockResolvedValue({}),
      ...overrides,
    });
    api.loadCaseworkCase.mockResolvedValue({ ...caseData, scope: { ...scope, is_restricted: true, restriction_reason: "Sensitive witness information" }, accessGrants: [] });
    return api;
  }

  function renderIn(lang, api, onNotice) {
    return render(
      <LanguageProvider lang={lang}>
        <CaseworkOperationsPanel caseId="case-1" api={api} onNotice={onNotice} onChanged={vi.fn().mockResolvedValue(undefined)} />
      </LanguageProvider>,
    );
  }

  it("requires a reason of 8 to 500 characters and sends it with the grantee", async () => {
    const api = restrictedApi();
    const onNotice = vi.fn();
    renderIn("en", api, onNotice);
    const restriction = await waitFor(() => article("Restricted access"));
    await within(restriction).findByRole("option", { name: "Staff Two · steward" });
    const reason = within(restriction).getByLabelText("Reason for access");
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute("minlength", "8");
    expect(reason).toHaveAttribute("maxlength", "500");
    setField(restriction, "Person in the organization", "staff-2");
    setField(restriction, "Reason for access", "  Preparing the step 2 meeting with the member  ");
    fireEvent.click(within(restriction).getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(api.grantCaseAccess).toHaveBeenCalledWith("case-1", "staff-2", "Preparing the step 2 meeting with the member"));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Issue tools updated."));
  });

  it.each([
    ["en", "casework_grant_reason_invalid", "Give a reason of 8 to 500 characters for letting this person into the issue."],
    ["es", "casework_grant_reason_invalid", "Indica un motivo de 8 a 500 caracteres para dar a esta persona acceso al asunto."],
    ["en", "casework_grantee_cannot_use_grant", "Only a campaign lead can be given access to a restricted issue. To bring in a committee member, assign them to the issue instead."],
    ["es", "casework_grantee_cannot_use_grant", "Solo se puede dar acceso a un asunto restringido a una persona de liderazgo de campaña. Para incluir a un miembro del comité, asígnalo al asunto."],
  ])("shows the database's %s refusal (%s) as catalogue copy", async (lang, token, copy) => {
    const refusal = Object.assign(new Error("grant reason is required"), { code: "22023", details: token });
    const api = restrictedApi({ grantCaseAccess: vi.fn().mockRejectedValue(refusal) });
    const onNotice = vi.fn();
    renderIn(lang, api, onNotice);
    const restriction = await waitFor(() => screen.getAllByRole("heading").find((heading) => /Restricted access|Acceso restringido/.test(heading.textContent)).closest("article"));
    await within(restriction).findByRole("option", { name: "Staff Two · steward" });
    fireEvent.change(within(restriction).getByRole("combobox"), { target: { value: "staff-2" } });
    fireEvent.change(restriction.querySelector('textarea[name="grantReason"]'), { target: { value: "Too short" } });
    fireEvent.click(within(restriction).getByRole("button", { name: lang === "en" ? "Grant access" : "Conceder acceso" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(copy));
    expect(onNotice).not.toHaveBeenCalledWith("grant reason is required");
  });
});

// BUG-UG-WEB-CASE-RESTRICT-LOCKS-OUT-COORDINATOR-20261003: the
// database refuses a restriction that would remove the restricting person's own
// access; the panel says so in catalogue copy instead of database text.
describe("CaseworkOperationsPanel restriction self-lockout refusal", () => {
  it.each([
    ["en", "Restrict issue", "Restricting this issue would remove your own access to it, so it was not restricted. Ask the assigned committee member or campaign lead, or an organization admin, to restrict it."],
    ["es", "Restringir asunto", "Restringir este asunto te quitaría el acceso a él, así que no se restringió. Pide al miembro del comité o al liderazgo de campaña asignado, o a un administrador de la organización, que lo restrinja."],
  ])("shows the refusal as %s catalogue copy", async (lang, button, copy) => {
    const refusal = Object.assign(new Error("restricting this case would remove your own access to it"), { code: "22023", details: "casework_restriction_self_lockout" });
    const api = operationApi({ setCaseRestriction: vi.fn().mockRejectedValue(refusal) });
    const onNotice = vi.fn();
    render(
      <LanguageProvider lang={lang}>
        <CaseworkOperationsPanel caseId="case-1" api={api} onNotice={onNotice} onChanged={vi.fn().mockResolvedValue(undefined)} />
      </LanguageProvider>,
    );
    const submit = await screen.findByRole("button", { name: button });
    const form = submit.closest("form");
    fireEvent.change(form.querySelector('textarea[name="reason"]'), { target: { value: "Sensitive witness statements" } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.setCaseRestriction).toHaveBeenCalledWith("case-1", true, "Sensitive witness statements"));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(copy));
    expect(onNotice).not.toHaveBeenCalledWith("restricting this case would remove your own access to it");
  });
});

describe("staff planes wire CaseworkOperationsPanel to the access log", () => {
  it("fails when a staff plane mounts CaseworkOperationsPanel without onChanged", () => {
    const viewsDir = join(repoRoot, "src", "views");
    const missing = [];
    for (const name of readdirSync(viewsDir).filter((file) => file.endsWith("View.jsx"))) {
      const source = readFileSync(join(viewsDir, name), "utf8");
      const mounts = source.match(/<CaseworkOperationsPanel\b[\s\S]*?\/>/g) || [];
      for (const mount of mounts) {
        if (!/\bonChanged\s*=/.test(mount)) missing.push(`${name}: ${mount.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
