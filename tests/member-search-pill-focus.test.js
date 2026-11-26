import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { stripComments } from "../scripts/lib/css-vars.mjs";

const stylesCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css"),
  "utf8",
).replace(/\r\n/g, "\n");

const selectorParts = (selector) => selector.split(",").map((part) => part.trim());

function collectRules(css) {
  const rules = [];
  const walk = (text, offset) => {
    let pos = 0;
    while (pos < text.length) {
      const open = text.indexOf("{", pos);
      if (open === -1) break;
      const selector = text.slice(pos, open).split(";").pop().trim();
      let depth = 1;
      let at = open + 1;
      for (; at < text.length && depth > 0; at += 1) {
        if (text[at] === "{") depth += 1;
        else if (text[at] === "}") depth -= 1;
      }
      if (depth !== 0) throw new Error(`unclosed block after selector: ${selector.slice(0, 60)}`);
      const body = text.slice(open + 1, at - 1);
      const index = offset + open;
      if (selector.startsWith("@")) walk(body, offset + open + 1);
      else rules.push({ selector, body, index });
      pos = at;
    }
  };
  walk(stripComments(css), 0);
  return rules;
}

const hasPart = (rule, part) => selectorParts(rule.selector).includes(part);

const hasRingIndicator = (body) => {
  const outline = body.match(/(?:^|;)\s*outline\s*:\s*([^;]+)/);
  const shadow = body.match(/(?:^|;)\s*box-shadow\s*:\s*([^;]+)/);
  const value = outline?.[1] ?? shadow?.[1];
  if (!value) return false;
  if (/^\s*(none|0)\s*$/i.test(value)) return false;
  return /var\(--ring\)/.test(value);
};

const PILLS = [
  {
    container: ".search-box",
    input: ".search-box input",
    stripOutline: /outline\s*:\s*0/,
    background: /background\s*:\s*var\(--input\)/,
    radius: /border-radius\s*:\s*17px/,
  },
  {
    container: ".inbox-search",
    input: ".inbox-search input",
    stripOutline: /outline\s*:\s*none/,
    background: /background\s*:\s*var\(--card2\)/,
    radius: /border-radius\s*:\s*10px/,
  },
  {
    container: ".learn-search",
    input: ".learn-search input",
    stripOutline: /outline\s*:\s*0/,
    background: /background\s*:\s*var\(--sg-color-card\)/,
    radius: /border-radius\s*:\s*12px/,
  },
];

describe("member search pill keyboard focus rings", () => {
  const rules = collectRules(stylesCss);

  for (const pill of PILLS) {
    it(`repays ${pill.container} after its input outline strip and keeps the resting pill`, () => {
      const stripping = rules.filter((rule) => hasPart(rule, pill.input) && pill.stripOutline.test(rule.body));
      expect(stripping.length, `${pill.input} must still strip outline`).toBeGreaterThan(0);

      const repayments = rules.filter((rule) => hasPart(rule, `${pill.container}:focus-within`) && hasRingIndicator(rule.body));
      expect(
        repayments.length,
        `${pill.container}:focus-within must paint a non-none outline or box-shadow with var(--ring)`,
      ).toBeGreaterThan(0);

      const firstStrip = Math.min(...stripping.map((rule) => rule.index));
      expect(
        repayments.some((rule) => rule.index > firstStrip),
        `${pill.container}:focus-within must appear later in the sheet than ${pill.input}'s outline strip`,
      ).toBe(true);

      const container = rules.find((rule) => hasPart(rule, pill.container) && !/:focus/.test(rule.selector));
      expect(container, `${pill.container} resting rule`).toBeDefined();
      expect(container.body).toMatch(pill.background);
      expect(container.body).toMatch(pill.radius);

      const input = rules.find((rule) => hasPart(rule, pill.input));
      expect(input, `${pill.input} resting rule`).toBeDefined();
      expect(input.body).toMatch(pill.stripOutline);
      expect(input.body).toMatch(/background\s*:\s*transparent/);
    });
  }

  it("does not add a focus-repayment rule for the out-of-scope voting suggest field", () => {
    const votingFocus = rules.filter((rule) =>
      selectorParts(rule.selector).some(
        (part) => part.includes(".voting-suggest__input") && /:focus(?:-visible|-within)?/.test(part),
      ),
    );
    expect(votingFocus).toEqual([]);

    const resting = rules.find((rule) => hasPart(rule, ".voting-suggest__input"));
    expect(resting, ".voting-suggest__input resting rule").toBeDefined();
    expect(resting.body).toMatch(/outline\s*:\s*none/);
  });
});
