import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryPayCatalog } from "../src/features/pay/index.js";
import * as pay from "../src/features/pay/index.js";
import { catalogue, t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildPayActor } from "../src/lib/mi1PayWiring.js";
import { PayToolsView } from "../src/views/PayToolsView.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const ORG = "11111111-1111-4111-8111-111111111111";

function wrap(node, lang = "en") {
  return render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
}

describe("MI1 pay web surface", () => {
  it.each([
    ["en", "Enter hours and either a direct rate or a published grade and step."],
    ["es", "Ingresa las horas y una tarifa por hora, o un grado y escalón publicados."],
  ])("explains the two rate paths before showing the conditional date (%s)", (lang, hint) => {
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })} />, lang);
    const date = t(lang, "pay.calculationDate");
    expect(screen.getByText(hint)).toBeVisible();
    expect(screen.queryByLabelText(date)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t(lang, "pay.grade")), { target: { value: "A" } });
    expect(screen.getByLabelText(date)).toBeVisible();
    fireEvent.change(screen.getByLabelText(t(lang, "pay.hourlyRate")), { target: { value: "25" } });
    expect(screen.queryByLabelText(date)).not.toBeInTheDocument();
  });

  it.each([
    ["en", "Enter an hourly rate, or enter a published grade and step."],
    ["es", "Ingresa una tarifa por hora, o un grado y escalón publicados."],
  ])("explains the missing calculator rate beside the field (%s)", (lang, message) => {
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })} />, lang);
    const rate = screen.getByLabelText(t(lang, "pay.hourlyRate"));
    fireEvent.click(screen.getByRole("button", { name: t(lang, "pay.calculate") }));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(rate).toHaveAttribute("aria-invalid", "true");
    expect(rate).toHaveAccessibleDescription(message);
    expect(screen.getByLabelText(t(lang, "pay.regularHours"))).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.change(rate, { target: { value: "25" } });
    expect(rate).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: t(lang, "pay.calculate") }));
    expect(screen.getByRole("status")).toHaveTextContent("$1000.00");
  });

  it.each([
    ["en", "pay.overtimeHours", "10001", "Enter a number of hours from 0 to 10,000."],
    ["es", "pay.nightHours", "-1", "Ingresa una cantidad de horas entre 0 y 10.000."],
    ["en", "pay.amountPaid", "-4", "Enter the amount already paid in dollars, from 0 to 1,000,000."],
    ["en", "pay.raisePercent", "-5", "Enter a raise percentage from 0 to 100."],
    ["es", "pay.unpaidPeriods", "2", "Ingresa un porcentaje de aumento para calcular el pago retroactivo."],
  ])("names the rejected calculator input (%s, %s)", (lang, key, value, message) => {
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })} />, lang);
    const input = screen.getByLabelText(t(lang, key));
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: t(lang, "pay.calculate") }));
    const field = key === "pay.unpaidPeriods" ? screen.getByLabelText(t(lang, "pay.raisePercent")) : input;
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(message);
    expect(input).toHaveValue(value);
  });

  it.each([
    ["en", "Enter the amount already paid in dollars, from 0 to 1,000,000."],
    ["es", "Ingresa el monto ya pagado en dólares, entre 0 y 1.000.000."],
  ])("accepts the paid amount cap and explains a cent over it (%s)", (lang, message) => {
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })} />, lang);
    const input = screen.getByLabelText(t(lang, "pay.amountPaid"));
    const calculate = screen.getByRole("button", { name: t(lang, "pay.calculate") });
    fireEvent.change(screen.getByLabelText(t(lang, "pay.hourlyRate")), { target: { value: "25" } });
    fireEvent.change(input, { target: { value: "1000000" } });
    fireEvent.click(calculate);
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "1000000.01" } });
    fireEvent.click(calculate);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(message);
    expect(input).toHaveValue("1000000.01");
  });

  it.each([
    ["en", "Enter a calculation date."],
    ["es", "Ingresa una fecha de cálculo."],
  ])("marks only the missing side’s date in Compare (%s)", (lang, message) => {
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })} />, lang);
    fireEvent.click(screen.getByRole("button", { name: t(lang, "pay.compareTab") }));
    const left = screen.getByLabelText(t(lang, "pay.leftDate"));
    const right = screen.getByLabelText(t(lang, "pay.rightDate"));
    fireEvent.change(right, { target: { value: "2026-07-01" } });
    fireEvent.click(screen.getByRole("button", { name: t(lang, "pay.compare") }));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(left).toHaveAccessibleDescription(message);
    expect(left).toHaveAttribute("aria-invalid", "true");
    expect(right).not.toHaveAttribute("aria-invalid", "true");
  });

  it.each([
    ["Calculator", "Calculate", "Regular hours", "Night hours"],
    ["Compare rates", "Compare", "From date", "To date"],
  ])("focuses the first invalid input on every rejected %s submit", (tab, action, first, second) => {
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })} />);
    fireEvent.click(screen.getByRole("button", { name: tab }));
    const firstField = screen.getByLabelText(first);
    const secondField = screen.getByLabelText(second);
    if (tab === "Calculator") {
      fireEvent.change(firstField, { target: { value: "-1" } });
      fireEvent.change(secondField, { target: { value: "-1" } });
    }
    const submit = screen.getByRole("button", { name: action, exact: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      submit.focus();
      expect(submit).toHaveFocus();
      fireEvent.click(submit);
      expect(firstField).toHaveAttribute("aria-invalid", "true");
      expect(secondField).toHaveAttribute("aria-invalid", "true");
      expect(firstField).toHaveFocus();
    }
  });

  it("retranslates visible calculator feedback and its limit when language changes", () => {
    const actor = buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" });
    const view = wrap(<PayToolsView actor={actor} />);
    const hours = screen.getByLabelText("Regular hours");
    fireEvent.change(hours, { target: { value: "10001" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(hours).toHaveAccessibleDescription("Enter a number of hours from 0 to 10,000.");
    view.rerender(<LanguageProvider lang="es"><PayToolsView actor={actor} /></LanguageProvider>);
    const spanishHours = screen.getByLabelText("Horas regulares");
    expect(spanishHours).toHaveValue("10001");
    expect(spanishHours).toHaveAttribute("aria-invalid", "true");
    expect(spanishHours).toHaveAccessibleDescription("Ingresa una cantidad de horas entre 0 y 10.000.");
  });

  it("marks unpaid periods when the raise percentage is valid", () => {
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })} />);
    const raise = screen.getByLabelText("Raise percent");
    const periods = screen.getByLabelText("Unpaid pay periods");
    fireEvent.change(raise, { target: { value: "5" } });
    fireEvent.change(periods, { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(raise).not.toHaveAttribute("aria-invalid", "true");
    expect(periods).toHaveAttribute("aria-invalid", "true");
    expect(periods).toHaveAccessibleDescription("Enter a whole number of unpaid pay periods from 0 to 104.");
  });

  it("keeps the no-match explanation for a valid published-scale query", () => {
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })} />);
    const grade = screen.getByLabelText("Grade");
    const step = screen.getByLabelText("Step");
    fireEvent.change(grade, { target: { value: "A" } });
    fireEvent.change(step, { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Calculation date"), { target: { value: "2026-07-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByRole("status")).toHaveTextContent("No published rate matches those inputs for the selected organization.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a supplied contract rule editable after its hours are cleared", () => {
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })} />);
    const hours = screen.getByLabelText("Overtime hours");
    fireEvent.change(hours, { target: { value: "2" } });
    const multiplier = screen.getByLabelText("Overtime multiplier");
    fireEvent.change(multiplier, { target: { value: "11" } });
    fireEvent.change(hours, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(multiplier).toHaveValue("11");
    expect(multiplier).toHaveAccessibleDescription("Enter a contract multiplier from 0 to 10.");
    expect(hours).not.toHaveAttribute("aria-invalid", "true");
  });

  it("calculates pay from explicit rates and leaves the catalog empty", () => {
    wrap(<PayToolsView actor={buildPayActor({
      userId: "user-a",
      organizationId: ORG,
      membershipStatus: "active",
    })} />);
    fireEvent.change(screen.getByLabelText("Regular hours"), { target: { value: "40" } });
    for (const label of ["Overtime hours", "Night hours", "Weekend hours", "Standby hours"]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: "1" } });
      fireEvent.change(screen.getByLabelText(label), { target: { value: "0" } });
    }
    fireEvent.change(screen.getByLabelText("Hourly rate"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Step"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Amount already paid"), { target: { value: "800" } });
    fireEvent.change(screen.getByLabelText("Raise percent"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Raise percent"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Unpaid pay periods"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Unpaid pay periods"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByText(/Gross owed:/)).toHaveTextContent("$1000.00");
    expect(screen.getByText(/Back pay:/)).toHaveTextContent("$200.00");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    expect(screen.getByText(/has not added its contract pay rates yet/i)).toBeInTheDocument();
  });

  it("renders each used wage bucket and the complete raise calculation", () => {
    wrap(<PayToolsView actor={buildPayActor({
      userId: "user-a",
      organizationId: ORG,
      membershipStatus: "active",
    })} />);
    fireEvent.change(screen.getByLabelText("Regular hours"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Overtime hours"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Overtime multiplier"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("Hourly rate"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Raise percent"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Annual hours"), { target: { value: "2000" } });
    fireEvent.change(screen.getByLabelText("Paychecks per year"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Unpaid pay periods"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));

    expect(screen.getByText(/Regular: 40 h × \$25\.00 =/)).toHaveTextContent("$1000.00");
    expect(screen.getByText(/Overtime: 2 h × \$37\.50 =/)).toHaveTextContent("$75.00");
    expect(screen.getByText(/Current annual pay:/)).toHaveTextContent("$50000.00");
    expect(screen.getByText(/New annual pay:/)).toHaveTextContent("$52500.00");
    expect(screen.getByText(/Annual raise difference:/)).toHaveTextContent("$2500.00");
    expect(screen.getByText(/Per-paycheck difference:/)).toHaveTextContent("$100.00");
    expect(screen.getByText(/Raise retroactive pay:/)).toHaveTextContent("$200.00");
  });

  it("does not invent an organization or a published scale", () => {
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByText(/zero organizations is a valid launch state/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    // Pin the state this actor actually reaches: no organization, not an empty
    // catalog for a resolved one. Accepting either message hid which one ran.
    expect(screen.getByText(catalogue.en["pay.noOrganization"])).toBeInTheDocument();
    expect(screen.queryByText(catalogue.en["pay.catalogEmpty"])).not.toBeInTheDocument();
    expect(screen.queryByText(/G1|SEIU|Commonwealth/i)).not.toBeInTheDocument();
  });

  it("gates direct-rate calculations on session-scope lookup and retries before treating the tenant as empty", async () => {
    let scopeAttempts = 0;
    const client = {
      rpc: vi.fn(async (name) => {
        if (name !== "get_my_chapter_memberships") throw new Error("catalog RPC must stay gated");
        scopeAttempts += 1;
        return scopeAttempts === 1
          ? { data: null, error: new Error("temporarily unavailable") }
          : { data: [], error: null };
      }),
    };
    wrap(<PayToolsView actor={buildPayActor({ userId: "user-a" })} client={client} />);

    fireEvent.change(screen.getByLabelText("Hourly rate"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(await screen.findByText(/catalog could not be reached/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(2));
    await screen.findByText(/enter hours and either a direct rate/i);
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(await screen.findByText(/zero organizations is a valid launch state/i)).toBeInTheDocument();
  });

  it("keeps resolved scope and results when a parent recreates an equivalent actor", async () => {
    const client = {
      rpc: vi.fn(async () => ({
        data: [{ organizationId: ORG, chapterId: "chapter-a", roles: ["member"], selected: true }],
        error: null,
      })),
    };
    const catalog = createMemoryPayCatalog();
    const api = { loadCatalog: vi.fn(async () => ({ ok: true, catalog })) };
    const renderActor = (roles) => buildPayActor({
      userId: "user-a",
      roles,
      organizationRoles: roles,
      membershipStatus: "active",
    });
    const view = wrap(<PayToolsView actor={renderActor(["admin", "steward"])} client={client} api={api} />);

    await waitFor(() => expect(api.loadCatalog).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Hourly rate"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByText(/Gross owed:/)).toHaveTextContent("$1000.00");

    view.rerender(
      <LanguageProvider lang="en">
        <PayToolsView actor={renderActor(["steward", "admin"])} client={client} api={api} />
      </LanguageProvider>,
    );

    expect(screen.getByText(/Gross owed:/)).toHaveTextContent("$1000.00");
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(api.loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("localizes the empty catalog and disclaimer in Spanish", () => {
    wrap(<PayToolsView actor={buildPayActor({
      userId: "user-a",
      organizationId: ORG,
      membershipStatus: "active",
    })} />, "es");
    fireEvent.click(screen.getByRole("button", { name: "Tablas salariales" }));
    expect(screen.getByText(/aún no ha agregado sus tarifas salariales del contrato/i)).toBeInTheDocument();
    expect(screen.getByText(/no son nómina, asesoría legal ni un asunto guardado/i)).toBeInTheDocument();
  });

  it("renders rates loaded from the session-scoped persistence adapter", async () => {
    const catalog = createMemoryPayCatalog([
      { kind: "grade", organizationId: ORG, grade: "A", title: "Grade A", stepCount: 1 },
      { kind: "step", organizationId: ORG, grade: "A", effectiveOn: "2026-08-25", stepNumber: 1, hourlyRateCents: 3000 },
    ]);
    wrap(<PayToolsView
      actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })}
      api={{ loadCatalog: async () => ({ ok: true, catalog }) }}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    expect(await screen.findByText("$30.00")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Effective date" })).toBeInTheDocument();
    expect(screen.getByText("2026-08-25")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Annual" })).not.toBeInTheDocument();
    expect(screen.queryByText("Not set")).not.toBeInTheDocument();
    expect(screen.queryByText("$62610.00")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Calculator" }));
    fireEvent.change(screen.getByLabelText("Hourly rate"), { target: { value: "not-a-rate" } });
    fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Step"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Regular hours"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid hourly rate in dollars.");
    expect(screen.queryByText("$30.00")).not.toBeInTheDocument();
  });

  it("keeps the annual column when the rates have annual amounts", async () => {
    const catalog = createMemoryPayCatalog([
      { kind: "grade", organizationId: ORG, grade: "A", title: "Grade A", stepCount: 2 },
      { kind: "step", organizationId: ORG, grade: "A", effectiveOn: "2026-08-25", stepNumber: 1, hourlyRateCents: 3000 },
      { kind: "step", organizationId: ORG, grade: "A", effectiveOn: "2026-08-25", stepNumber: 2, hourlyRateCents: 3200 },
    ]);
    const createPayTools = pay.createPayTools;
    const toolsSpy = vi.spyOn(pay, "createPayTools").mockImplementation(options => {
      const tools = createPayTools(options);
      return { ...tools, presentTables: () => tools.presentTables({ rules: { hoursPerYear: 2000 } }) };
    });
    try {
      wrap(<PayToolsView actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })}
        api={{ loadCatalog: async () => ({ ok: true, catalog }) }} />);
      fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
      expect(await screen.findByRole("columnheader", { name: "Annual" })).toBeVisible();
      expect(screen.getByText("$64000.00")).toBeVisible();
    } finally { toolsSpy.mockRestore(); }
  });

  it("lets an MFA-verified authorized actor publish grades and effective rates", async () => {
    const catalog = createMemoryPayCatalog();
    const api = {
      loadCatalog: vi.fn(async () => ({ ok: true, catalog })),
      upsertGrade: vi.fn(async () => ({ ok: true })),
      upsertStep: vi.fn(async () => ({ ok: true })),
    };
    const actor = buildPayActor({
      userId: "admin-a",
      organizationId: ORG,
      membershipStatus: "active",
      roles: ["admin"],
      organizationRoles: ["admin"],
      mfaSatisfied: true,
    });
    wrap(<PayToolsView actor={actor} api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    expect(await screen.findByRole("heading", { name: "Publish pay-scale records" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Catalog grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Grade title"), { target: { value: "Grade A" } });
    fireEvent.change(screen.getByLabelText("Job family (optional)"), { target: { value: "Direct care" } });
    fireEvent.change(screen.getByLabelText("Number of steps (optional)"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish grade" }));

    await waitFor(() => expect(api.upsertGrade).toHaveBeenCalledWith(expect.objectContaining({
      userId: "admin-a",
      selectedOrganizationId: ORG,
      mfaSatisfied: true,
    }), {
      organizationId: ORG,
      grade: "A",
      title: "Grade A",
      jobFamily: "Direct care",
      stepCount: 3,
      description: null,
    }));
    expect(await screen.findByText("Grade published for the selected organization.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Rate grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Catalog step"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Rate effective date"), { target: { value: "2026-08-25" } });
    fireEvent.change(screen.getByLabelText("Published hourly rate"), { target: { value: "30.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish rate" }));

    await waitFor(() => expect(api.upsertStep).toHaveBeenCalledWith(expect.objectContaining({
      userId: "admin-a",
      selectedOrganizationId: ORG,
      mfaSatisfied: true,
    }), {
      organizationId: ORG,
      grade: "A",
      stepNumber: 1,
      effectiveOn: "2026-08-25",
      hourlyRate: 30.5,
    }));
    expect(await screen.findByText("Rate published for the selected organization.")).toBeInTheDocument();
    expect(api.loadCatalog).toHaveBeenCalledTimes(3);
  });

  it("refuses an out-of-range step at the field without calling the catalog writers", async () => {
    const api = {
      loadCatalog: vi.fn(async () => ({ ok: true, catalog: createMemoryPayCatalog() })),
      upsertGrade: vi.fn(async () => ({ ok: true })),
      upsertStep: vi.fn(async () => ({ ok: true })),
    };
    const actor = buildPayActor({
      userId: "admin-a",
      organizationId: ORG,
      membershipStatus: "active",
      roles: ["admin"],
      organizationRoles: ["admin"],
      mfaSatisfied: true,
    });
    wrap(<PayToolsView actor={actor} api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    await screen.findByRole("heading", { name: "Publish pay-scale records" });
    fireEvent.change(screen.getByLabelText("Catalog grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Grade title"), { target: { value: "Grade A" } });
    for (const value of ["0", "100", "2.5", "abc"]) {
      fireEvent.change(screen.getByLabelText("Number of steps (optional)"), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "Publish grade" }));
      expect(screen.getByLabelText("Number of steps (optional)")).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText("Number of steps (optional)")).toHaveAccessibleDescription("Enter a whole number from 1 to 99.");
    }
    expect(api.upsertGrade).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Number of steps (optional)"), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish grade" }));
    await waitFor(() => expect(api.upsertGrade).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepCount: 99 })));
    expect(screen.getByLabelText("Number of steps (optional)")).not.toHaveAttribute("aria-invalid");

    fireEvent.change(screen.getByLabelText("Rate grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Catalog step"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Rate effective date"), { target: { value: "2026-08-25" } });
    fireEvent.change(screen.getByLabelText("Published hourly rate"), { target: { value: "30.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish rate" }));
    expect(screen.getByLabelText("Catalog step")).toHaveAccessibleDescription("Enter a whole number from 1 to 99.");
    expect(api.upsertStep).not.toHaveBeenCalled();
    expect(screen.queryByText("Check the catalog fields and try again.")).not.toBeInTheDocument();
  });

  it("clears every publisher draft and status when the selected organization changes", async () => {
    const otherOrganization = "22222222-2222-4222-8222-222222222222";
    const api = {
      loadCatalog: vi.fn(async () => ({ ok: true, catalog: createMemoryPayCatalog() })),
      upsertGrade: vi.fn(async () => ({ ok: true })),
      upsertStep: vi.fn(async () => ({ ok: true })),
    };
    const actorFor = (organizationId) => buildPayActor({
      userId: "admin-a",
      organizationId,
      membershipStatus: "active",
      roles: ["admin"],
      organizationRoles: ["admin"],
      mfaSatisfied: true,
    });
    const view = wrap(<PayToolsView actor={actorFor(ORG)} api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    await screen.findByRole("heading", { name: "Publish pay-scale records" });
    for (const [label, value] of [
      ["Catalog grade", "A"],
      ["Grade title", "Grade A"],
      ["Job family (optional)", "Direct care"],
      ["Number of steps (optional)", "3"],
      ["Grade description (optional)", "Organization A draft"],
      ["Rate grade", "A"],
      ["Catalog step", "1"],
      ["Rate effective date", "2026-08-25"],
      ["Published hourly rate", "30.50"],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Publish grade" }));
    expect(await screen.findByText("Grade published for the selected organization.")).toBeInTheDocument();

    view.rerender(
      <LanguageProvider lang="en">
        <PayToolsView actor={actorFor(otherOrganization)} api={api} />
      </LanguageProvider>,
    );

    await waitFor(() => expect(screen.queryByText("Grade published for the selected organization.")).not.toBeInTheDocument());
    for (const label of [
      "Catalog grade",
      "Grade title",
      "Job family (optional)",
      "Number of steps (optional)",
      "Grade description (optional)",
      "Rate grade",
      "Catalog step",
      "Rate effective date",
      "Published hourly rate",
    ]) {
      expect(screen.getByLabelText(label)).toHaveValue("");
    }
  });

  it("does not expose catalog write controls without the staff and MFA gates", async () => {
    const api = {
      loadCatalog: vi.fn(async () => ({ ok: true, catalog: createMemoryPayCatalog() })),
      upsertGrade: vi.fn(),
      upsertStep: vi.fn(),
    };
    wrap(<PayToolsView
      actor={buildPayActor({ userId: "member-a", organizationId: ORG, membershipStatus: "active", mfaSatisfied: true })}
      api={api}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    expect(await screen.findByText(/can publish pay scales/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish grade" })).not.toBeInTheDocument();
  });

  it("settles the initial calculator into a neutral prompt after catalog loading", async () => {
    const catalog = createMemoryPayCatalog();
    wrap(<PayToolsView
      actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })}
      api={{ loadCatalog: async () => ({ ok: true, catalog }) }}
    />);

    expect(await screen.findByText(/enter hours and either a direct rate/i)).toBeInTheDocument();
    expect(screen.queryByText("Loading pay tools.")).not.toBeInTheDocument();
  });

  it("shows loading and retry states and retries the session-scoped catalog", async () => {
    let resolveCatalog;
    const loadCatalog = vi.fn(() => new Promise((resolve) => { resolveCatalog = resolve; }));
    wrap(<PayToolsView
      actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })}
      api={{ loadCatalog }}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    expect(screen.getByText("Loading pay tools.")).toBeInTheDocument();
    resolveCatalog({ ok: false, reason: "catalog_unavailable" });
    expect(await screen.findByText(/catalog could not be reached/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Calculator" }));
    fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Step"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Calculation date"), { target: { value: "2026-08-25" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByText(/catalog could not be reached/i)).toBeInTheDocument();
    expect(screen.queryByText(/no published rate matches/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(loadCatalog).toHaveBeenCalledTimes(2);
  });

  it("compares two published grade, step, and date selections end to end", async () => {
    const otherOrganization = "22222222-2222-4222-8222-222222222222";
    const catalog = createMemoryPayCatalog([
      { kind: "grade", organizationId: ORG, grade: "A", title: "Grade A", stepCount: 2 },
      { kind: "step", organizationId: ORG, grade: "A", effectiveOn: "2025-01-01", stepNumber: 1, hourlyRateCents: 2500 },
      { kind: "step", organizationId: ORG, grade: "A", effectiveOn: "2026-01-01", stepNumber: 2, hourlyRateCents: 3000 },
    ]);
    const api = { loadCatalog: async () => ({ ok: true, catalog }) };
    const view = wrap(<PayToolsView
      actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })}
      api={api}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    expect(await screen.findByText("$25.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compare rates" }));
    fireEvent.change(screen.getByLabelText("From grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("From step"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("To grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("To step"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Annual hours"), { target: { value: "2000" } });
    fireEvent.change(screen.getByLabelText("Paychecks per year"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByLabelText("From date")).toHaveAccessibleDescription("Enter a calculation date.");
    expect(screen.getByLabelText("To date")).toHaveAccessibleDescription("Enter a calculation date.");

    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2025-12-31" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    expect(await screen.findByText(/Hourly difference:/)).toHaveTextContent("$5.00");
    expect(screen.getByText(/Annual difference:/)).toHaveTextContent("$10000.00");
    expect(screen.getByText(/Per-paycheck difference:/)).toHaveTextContent("$400.00");

    view.rerender(
      <LanguageProvider lang="en">
        <PayToolsView
          actor={buildPayActor({ userId: "user-a", organizationId: otherOrganization, membershipStatus: "active" })}
          api={api}
        />
      </LanguageProvider>,
    );
    await waitFor(() => {
      expect(screen.queryByText(/Hourly difference:/)).not.toBeInTheDocument();
    });
  });

  it("clears a completed estimate when the selected organization changes", async () => {
    const otherOrganization = "22222222-2222-4222-8222-222222222222";
    const api = { loadCatalog: async () => ({ ok: true, catalog: createMemoryPayCatalog() }) };
    const view = wrap(<PayToolsView
      actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })}
      api={api}
    />);
    await screen.findByText(/enter hours and either a direct rate/i);
    fireEvent.change(screen.getByLabelText("Hourly rate"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Regular hours"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByText(/Gross owed:/)).toHaveTextContent("$1000.00");

    view.rerender(
      <LanguageProvider lang="en">
        <PayToolsView
          actor={buildPayActor({ userId: "user-a", organizationId: otherOrganization, membershipStatus: "active" })}
          api={api}
        />
      </LanguageProvider>,
    );
    await waitFor(() => expect(screen.queryByText(/Gross owed:/)).not.toBeInTheDocument());
    expect(screen.getByText(/enter hours and either a direct rate/i)).toBeInTheDocument();
  });

  it("uses a Supabase client adapter and localizes validation and authorization states", async () => {
    const client = {
      rpc: vi.fn(async (name) => ({
        data: name === "get_my_chapter_memberships" ? [{
          organizationId: ORG,
          chapterId: null,
          organizationRoles: [],
          chapterRoles: [],
          selected: true,
        }] : [],
        error: null,
      })),
    };
    const first = wrap(<PayToolsView
      actor={buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active" })}
      client={client}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    expect(await screen.findByText(/has not added its contract pay rates yet/i)).toBeInTheDocument();
    first.unmount();

    const second = wrap(<PayToolsView actor={buildPayActor({
      userId: "user-a",
      organizationId: ORG,
      membershipStatus: "revoked",
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByText(/active worker in the organization/i)).toBeInTheDocument();
    second.unmount();

    wrap(<PayToolsView actor={buildPayActor({
      userId: "user-a",
      organizationId: ORG,
      membershipStatus: "active",
    })} />);
    fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Step"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByText(/enter a calculation date/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Calculation date"), { target: { value: "2026-08-25" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByText(/no published rate matches/i)).toBeInTheDocument();
  });

  it("shows an honest unset state until each used contract rule is entered", () => {
    wrap(<PayToolsView actor={buildPayActor({
      userId: "user-a",
      organizationId: ORG,
      membershipStatus: "active",
    })} />);
    fireEvent.change(screen.getByLabelText("Hourly rate"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Overtime hours"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByLabelText("Overtime multiplier")).toHaveAccessibleDescription("Enter the value from your contract for this estimate.");

    fireEvent.change(screen.getByLabelText("Overtime multiplier"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByText("$1075.00")).toBeInTheDocument();
  });
});

// Record 8435: Publish grade keeps focus while the grade is published, and a
// second activation in the same tick publishes nothing more.
describe("pay-scale publishing while it runs", () => {
  const ready = async (upsertGrade) => {
    const catalog = createMemoryPayCatalog();
    const api = { loadCatalog: vi.fn(async () => ({ ok: true, catalog })), upsertGrade, upsertStep: vi.fn(async () => ({ ok: true })) };
    const actor = buildPayActor({ userId: "admin-a", organizationId: ORG, membershipStatus: "active", roles: ["admin"], organizationRoles: ["admin"], mfaSatisfied: true });
    wrap(<PayToolsView actor={actor} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    await screen.findByRole("heading", { name: "Publish pay-scale records" });
    fireEvent.change(screen.getByLabelText("Catalog grade"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Grade title"), { target: { value: "Grade A" } });
    return screen.getByRole("button", { name: "Publish grade" });
  };

  it("keeps Publish grade focused while the grade is published, and publishes once", async () => {
    const upsertGrade = vi.fn(async () => ({ ok: true }));
    await expectHeldWriteFocus(upsertGrade, await ready(upsertGrade));
    expect(upsertGrade).toHaveBeenCalledTimes(1);
  });

  // #8973 delta 2 (record 8435): the form remounts for each organization, so
  // its busy state and lock end together, and a publish from an earlier mount
  // does not reload the catalog the page now shows.
  const organizations = async (firstAnswer) => {
    const other = "22222222-2222-4222-8222-222222222222";
    let releaseFirst;
    const upsertGrade = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve(firstAnswer); }))
      .mockResolvedValue({ ok: false, reason: "invalid_input" });
    const api = { loadCatalog: vi.fn(async () => ({ ok: true, catalog: createMemoryPayCatalog() })), upsertGrade, upsertStep: vi.fn(async () => ({ ok: true })) };
    const actorFor = (organizationId) => buildPayActor({ userId: "admin-a", organizationId, membershipStatus: "active", roles: ["admin"], organizationRoles: ["admin"], mfaSatisfied: true });
    const view = wrap(<PayToolsView actor={actorFor(ORG)} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay-scale tables" }));
    const fill = async () => {
      await screen.findByRole("heading", { name: "Publish pay-scale records" });
      fireEvent.change(screen.getByLabelText("Catalog grade"), { target: { value: "A" } });
      fireEvent.change(screen.getByLabelText("Grade title"), { target: { value: "Grade A" } });
      const publish = screen.getByRole("button", { name: "Publish grade" });
      expect(publish).not.toHaveAttribute("aria-disabled", "true");
      return publish;
    };
    fireEvent.click(await fill());
    expect(upsertGrade).toHaveBeenCalledTimes(1);
    const show = async (organizationId) => {
      view.rerender(<LanguageProvider lang="en"><PayToolsView actor={actorFor(organizationId)} api={api} /></LanguageProvider>);
      return fill();
    };
    return { api, upsertGrade, show, other, release: () => releaseFirst() };
  };

  it("publishes a ready grade after organization A to B and back to A while A's first publish is held", async () => {
    const run = await organizations({ ok: false, reason: "invalid_input" });
    try {
      const readyB = await run.show(run.other);
      await act(async () => { fireEvent.click(readyB); });
      expect(run.upsertGrade).toHaveBeenCalledTimes(2);
      const readyA = await run.show(ORG);
      await act(async () => { fireEvent.click(readyA); });
      expect(run.upsertGrade).toHaveBeenCalledTimes(3);
    } finally {
      await act(async () => { run.release(); });
    }
  });

  it("does not reload the catalog or show a status when an earlier organization's publish answers late", async () => {
    const run = await organizations({ ok: true });
    await run.show(run.other);
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish grade" })).toBeInTheDocument());
    const loads = run.api.loadCatalog.mock.calls.length;
    await act(async () => { run.release(); });
    expect(run.api.loadCatalog).toHaveBeenCalledTimes(loads);
    expect(screen.queryByText("Grade published for the selected organization.")).not.toBeInTheDocument();
  });

  it("publishes one grade when Publish grade is activated twice in one tick", async () => {
    const upsertGrade = vi.fn(async () => ({ ok: true }));
    const publish = await ready(upsertGrade);
    await expectOneWriteFromOneTick(upsertGrade, [() => fireEvent.click(publish), () => fireEvent.click(publish)]);
  });
});

