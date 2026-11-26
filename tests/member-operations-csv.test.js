// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseMemberOperationsCsv } from "../src/features/memberOperations/csv.js";

describe("member CSV column preservation", () => {
  it.each([
    "email,department\nmember@example.test,Finance,Payroll",
    "email,department\nmember@example.test,Finance,",
    'email,department\nmember@example.test,Finance,"Payroll, weekly"',
    'email,department\nmember@example.test,Finance,"Payroll\nweekly"',
    "email,department\nfirst@example.test,Finance\nsecond@example.test,Payroll,Nights",
  ])("refuses fields without a corresponding header: %s", (source) => {
    expect(() => parseMemberOperationsCsv(source)).toThrow("Every CSV column needs a header");
  });

  it("keeps quoted delimiters, newlines and escaped quotes within their named cells", () => {
    const parsed = parseMemberOperationsCsv('\uFEFFemail,department,notes\r\nmember@example.test,"Finance, Payroll","Weekly\nreview: ""approved"""\r\n');
    expect(parsed).toEqual({
      headers: ["email", "department", "notes"],
      rows: [{ email: "member@example.test", department: "Finance, Payroll", notes: 'Weekly\nreview: "approved"' }],
    });
  });

  it("continues padding omitted optional trailing columns", () => {
    expect(parseMemberOperationsCsv("email,department,notes\nmember@example.test,Finance").rows).toEqual([
      { email: "member@example.test", department: "Finance", notes: "" },
    ]);
  });

  it("retains row and column limits", () => {
    expect(parseMemberOperationsCsv(`email\n${Array(500).fill("member@example.test").join("\n")}`).rows).toHaveLength(500);
    expect(() => parseMemberOperationsCsv(`email\n${Array(501).fill("member@example.test").join("\n")}`)).toThrow("500 rows");
    const columns = Array.from({ length: 64 }, (_, index) => `column_${index}`);
    expect(parseMemberOperationsCsv(`${columns.join(",")}\n${columns.join(",")}`).headers).toHaveLength(64);
    expect(() => parseMemberOperationsCsv(`${[...columns, "extra"].join(",")}\nvalue`)).toThrow("64 columns");
  });

  it("retains cell and file size limits", () => {
    expect(parseMemberOperationsCsv(`notes\n${"x".repeat(10000)}`).rows[0].notes).toHaveLength(10000);
    expect(() => parseMemberOperationsCsv(`notes\n${"x".repeat(10001)}`)).toThrow("10,000 characters");
    expect(() => parseMemberOperationsCsv(`notes\n${"x".repeat(2 * 1024 * 1024)}`)).toThrow("2 MB");
  });
});
