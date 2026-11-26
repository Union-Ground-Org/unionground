import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(join(root, "src/styles.css"), "utf8").replace(/\r\n/g, "\n");

describe("Voting contrast contract", () => {
  it("keeps past-vote metadata on the AA secondary-text token", () => {
    const rule = styles.match(/\.voting-past-row__copy small\s*\{([^}]*)\}/)?.[1] || "";
    expect(rule).toContain("color: var(--sg-color-sec)");
    expect(rule).not.toContain("color: var(--sg-color-muted)");
  });

  // The routed Ballots/Past strip used to paint only inside VotingView's desktop
  // body; it now renders in the phone header too, so every theme reaches this
  // pair at 390. A hard-coded white is invisible to scripts/contrast-audit.mjs,
  // which can only compare token pairs, so a theme that repoints
  // --sg-color-green could drop it under the 4.5:1 floor unseen. The audit
  // already enforces --sg-color-green against --sg-color-canvas in every
  // theme, so the token keeps itself honest.
  it("paints the selected voting tab in canvas ink, never a hard-coded white", () => {
    const rule = styles.match(/\.voting-tab--on\s*\{([^}]*)\}/)?.[1] || "";
    expect(rule).toContain("background: var(--sg-color-green)");
    expect(rule).toContain("color: var(--sg-color-canvas)");
    expect(rule).not.toMatch(/color:\s*#(fff|ffffff)\b/i);
  });

  // The strip only clears the bar at 390 if it actually renders there.
  it("renders the tab strip under the phone page title", () => {
    expect(styles).toMatch(/\.protohead \.voting-tabs\s*\{/);
  });

  // Desktop-only cards (.voting-stat) used to paint linear-gradient(180deg,
  // #fefefe, var(--sg-color-card)). The runner fails closed on any ancestor
  // background-image, so every text node inside those cards counted as a
  // PR1815_CONTRAST failure at 1440 in both themes; phone uses the already-flat
  // .voting-card and stayed green at 390/768. Flat --sg-color-card is the
  // surface contrast-audit already measures against --sg-color-ink / --sg-color-sec.
  it("paints desktop voting-stat cards as a flat theme card, never a gradient the runner cannot composite", () => {
    const rule = styles.match(/\.voting-stat\s*\{([^}]*)\}/)?.[1] || "";
    expect(rule).toContain("background: var(--sg-color-card)");
    expect(rule).not.toMatch(/linear-gradient/);
    expect(rule).not.toContain("#fefefe");
  });
});
