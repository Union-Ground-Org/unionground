// @vitest-environment node

// OPS-UG-UNLABELED-TIME-FORMATTER-LINT-AND-MIGRATION-20261109 and the Nov 9
// review of #7868: eslint.config.js refuses the unlabeled formatDateTime under
// src/, however it is reached, and allows the zoned formatter.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });

async function restricted(code, filePath = "src/features/probe/Probe.js") {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((message) => message.ruleId === "no-restricted-syntax").length;
}

describe("unlabeled time formatter lint rule", () => {
  it.each([
    ["a named import and call", 'import { formatDateTime } from "../../lib/i18n/format.js";\nexport const x = formatDateTime(1, "en");\n', 2],
    ["a renamed import", 'import { formatDateTime as when } from "../../lib/i18n.js";\nexport const x = when(1, "en");\n', 1],
    ["a namespace import and call", 'import * as dates from "../../lib/i18n/format.js";\nexport const x = dates.formatDateTime(1, "en");\n', 1],
    ["a namespace member passed along", 'import * as dates from "../../lib/i18n.js";\nexport const pick = [dates.formatDateTime];\n', 1],
    ["a computed namespace member", 'import * as dates from "../../lib/i18n/format.js";\nexport const x = dates["formatDateTime"](1, "en");\n', 1],
  ])("flags %s", async (_label, code, count) => {
    expect(await restricted(code)).toBe(count);
  });

  it("allows the zoned formatter, including through a namespace import", async () => {
    expect(await restricted('import { formatDateTimeWithZone } from "../../lib/i18n/zonedDates.js";\nexport const x = formatDateTimeWithZone(1, "en");\n')).toBe(0);
    expect(await restricted('import * as dates from "../../lib/i18n/zonedDates.js";\nexport const x = dates.formatDateTimeWithZone(1, "en");\n')).toBe(0);
  });

  it("exempts only the formatter's own module", async () => {
    const code = 'export function formatDateTime(value) { return String(value); }\nexport const x = formatDateTime(1);\n';
    expect(await restricted(code, "src/lib/i18n/format.js")).toBe(0);
    expect(await restricted(code, "src/features/learningContent/time.js")).toBe(1);
    expect(await restricted(code, "src/features/integrations/SsoSetup.jsx")).toBe(1);
  });
});
