import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkChartPalette } from "../apps/mobile/src/theme/chartPalette.ts";

// REQ-UG-PULSE-WEB-EXPLORER-AND-STUDIO-20261031: the website series
// are the app's trio, and they pass the app's six-check palette validator
// (lightness band, chroma floor, normal-vision and colour-vision ΔE, 3:1
// against the surface) on both website surfaces. The site renders light only
// (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105), so the dormant dark
// trio and its tokens are deleted.
const tokens = readFileSync(resolve(__dirname, "../src/sg-tokens.css"), "utf8");
const styles = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
const token = (name) => tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1]?.toLowerCase();

const MODES = {
  light: { series: ["#137c54", "#1473e6", "#8a5a00"], prefix: "sg-light", surfaces: { card: "#ffffff", canvas: "#f4f2ec" } },
};

describe("website chart trio", () => {
  for (const [mode, expected] of Object.entries(MODES)) {
    it(`declares the ${mode} trio and passes the validator on both ${mode} surfaces`, () => {
      const series = [1, 2, 3].map((index) => token(`${expected.prefix}-chart-${index}`));
      expect(series).toEqual(expected.series);
      for (const [surface, hex] of Object.entries(expected.surfaces)) {
        expect(token(`${expected.prefix}-${surface}`)).toBe(hex);
        const check = checkChartPalette(series, mode, hex);
        expect(check, `${mode} ${surface}`).toMatchObject({ lightness: true, chroma: true, pass: true });
        expect(check.normalVision.pass && check.cvd.pass && check.contrast.pass).toBe(true);
      }
    });
  }

  it("binds the series carriers to the light trio", () => {
    for (const index of [1, 2, 3]) {
      expect(tokens).toContain(`--chart-series-${index}: var(--sg-light-chart-${index});`);
      expect(styles).not.toMatch(new RegExp(`--chart-series-${index}:\\s*var\\(--sg-dark-`));
    }
  });
});
