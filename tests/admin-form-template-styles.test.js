// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const component = readFileSync(new URL("../src/components/AdminFormTemplateEditor.jsx", import.meta.url), "utf8");
const blockStart = styles.indexOf("/* ---- Admin form-template registry");
const block = styles.slice(blockStart, styles.indexOf("\n@media (max-width: 720px)", blockStart));

describe("admin form-template editor visual contract", () => {
  it("uses semantic token paint only, with no component-local raw colors", () => {
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(component).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|style=\{\{/i);
    for (const token of [
      "--background", "--foreground", "--card", "--card-foreground", "--popover",
      "--popover-foreground", "--primary", "--primary-foreground", "--secondary",
      "--secondary-foreground", "--muted", "--muted-foreground", "--accent",
      "--accent-foreground", "--destructive", "--destructive-foreground", "--border",
      "--input", "--ring",
    ]) expect(block).toContain(`var(${token})`);
  });

  it("pins control targets, visible focus, and responsive phone/tablet layouts", () => {
    expect(block).toContain("min-height: 44px");
    expect(block).toContain("min-height: 48px");
    expect(block).toContain("outline: 3px solid var(--ring)");
    expect(block).toContain("@media (max-width: 900px)");
    expect(block).toContain("@media (max-width: 600px)");
    expect(block).toContain("font-size: 16px");
    // The shared role target reserves the sticky mobile bar. A component-local
    // scroll margin must not shrink it and hide the deep-link heading.
    expect(block).not.toMatch(/\.ftm-section\s*\{[^}]*scroll-margin-top/);
  });
});
