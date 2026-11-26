// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const component = readFileSync("src/views/TaskTemplateDialog.jsx", "utf8");
const block = styles.slice(styles.indexOf("/* Specialized task templates"), styles.indexOf("/* Assignee picker"));

describe("specialized task template responsive and semantic UI contract", () => {
  it("uses audited task tokens and no raw colors", () => {
    expect(block).toMatch(/var\(--kan-(modal|card|card-2|ink|muted|accent|accent-ink|line|track)\)/);
    expect(block).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(|hsla?\(/i);
  });

  it("pins touch floors and the phone/tablet/desktop layout", () => {
    expect(block).toContain("width: min(100%, 920px)");
    expect(block).toContain("@media (max-width: 720px)");
    expect(block).toContain("@media (max-width: 430px)");
    expect(block).toMatch(/@media \(max-width: 430px\)[\s\S]+?task-template-choices \{ grid-template-columns: 1fr;/);
    expect(styles).toContain(".sg-app--desktop .task-template-backdrop { right: var(--companion-column); }");
    expect(block).toMatch(/task-template-iconbutton[^}]+width: 44px; height: 44px/s);
    expect(block).toMatch(/task-template-button[^}]+min-height: 44px/s);
    expect(block).toMatch(/task-template-field input[^}]+min-height: 44px/s);
  });

  it("exposes modal, selection, pending, alert/status, and labeled form semantics without hover-only controls", () => {
    for (const needle of [
      'role="dialog"', 'aria-modal="true"', 'aria-busy={busy}', "aria-pressed={selectedKey === template.key}",
      'role="alert"', 'role="status"', "aria-current={", "pending={busy}", "onKeyDown",
    ]) expect(component).toContain(needle);
    expect(component).not.toContain("onMouseEnter");
  });
});
