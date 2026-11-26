import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemberOperations } from "../src/features/memberOperations/MemberOperations.jsx";
import { parseMemberOperationsCsv } from "../src/features/memberOperations/csv.js";

describe("member CSV closing quotes", () => {
  it.each([
    '"Finance"Payroll',
    '""Payroll',
    '"Finance" Payroll',
    '"Finance"\tPayroll',
    '"Finance"\rPayroll',
  ])("refuses trailing text without changing the row width: %j", (field) => {
    expect(() => parseMemberOperationsCsv(`email,department\nmember@example.test,${field}`))
      .toThrow("Malformed CSV quote");
  });

  it("rejects trailing text in a quoted header before returning import rows", () => {
    expect(() => parseMemberOperationsCsv('email,"department"junk\nmember@example.test,Finance'))
      .toThrow("Malformed CSV quote");
  });

  it.each([
    ["LF, no final newline", "\n", false],
    ["LF, final newline", "\n", true],
    ["CRLF, no final newline", "\r\n", false],
    ["CRLF, final newline", "\r\n", true],
  ])("preserves quoted delimiters, escaped quotes, multiline and empty fields (%s)", (_name, eol, terminated) => {
    const source = [
      '"email","department","notes"',
      '"member@example.test","Finance, Payroll","Said ""hello"""',
      `second@example.test,"First${eol}Second",ordinary`,
      'third@example.test,"","Done"',
    ].join(eol) + (terminated ? eol : "");
    expect(parseMemberOperationsCsv(source)).toEqual({
      headers: ["email", "department", "notes"],
      rows: [
        { email: "member@example.test", department: "Finance, Payroll", notes: 'Said "hello"' },
        { email: "second@example.test", department: `First${eol}Second`, notes: "ordinary" },
        { email: "third@example.test", department: "", notes: "Done" },
      ],
    });
  });

  it("clears a valid preview and prevents staging after a malformed upload", async () => {
    const actor = {
      userId: "11111111-1111-4111-8111-111111111111",
      selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
      membershipStatus: "active", selectedHat: "admin", organizationRoles: ["admin"], mfaSatisfied: true,
    };
    const client = { rpc: vi.fn(async () => ({ data: {
      state: "ready", organizationId: actor.selectedOrganizationId,
      directory: { items: [], nextCursor: null }, campaigns: [], imports: [], deliveryConfigured: false,
    }, error: null })) };
    const { container } = render(<MemberOperations actor={actor} client={client} />);
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Imports" }));
    const input = container.querySelector('input[type="file"]');
    const upload = (source) => {
      const file = new File([source], "members.csv", { type: "text/csv" });
      Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(source) });
      fireEvent.change(input, { target: { files: [file] } });
    };
    upload("email,department\nmember@example.test,Finance");
    await screen.findByText("1 row ready to upload and check.");
    expect(screen.getByRole("button", { name: "Upload 1 row for checking" })).toBeEnabled();
    upload('email,department\nmember@example.test,Finance\nsecond@example.test,"Finance"Payroll');
    await screen.findByText("Malformed CSV quote");
    const stage = screen.getByRole("button", { name: "Upload rows for checking" });
    expect(stage).toBeDisabled();
    fireEvent.click(stage);
    expect(client.rpc.mock.calls.filter(([name]) => name === "stage_member_operations_import")).toEqual([]);
    expect(screen.queryByText(/ready to upload and check/)).not.toBeInTheDocument();
  });
});
