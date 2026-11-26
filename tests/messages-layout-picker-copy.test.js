import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { messageWorkflowPickerCopy, messageWorkflowPickerCopyFor } from "../src/lib/messageWorkflowPickerCopy.js";

// BUG-UG-MESSAGES-LAYOUT-PICKER-DESIGN-DOC-WORDING-20261106: the
// Messages layout picker read like a design document. The replacement wording
// lives in its own module so the locale barrels stay byte-identical (the
// release guard reads any barrel edit as a published legal change).
describe("Messages layout picker copy", () => {
  it("labels the downside and the default without design-document words", () => {
    expect(messageWorkflowPickerCopy.en.conLabel).toBe("Keep in mind:");
    expect(messageWorkflowPickerCopy.es.conLabel).toBe("Ten en cuenta:");
    expect(messageWorkflowPickerCopy.en.pro["people-spaces-work"]).toBe("everyday messages, grouped by who and where.");
    expect(messageWorkflowPickerCopy.es.pro["people-spaces-work"]).toBe("los mensajes de cada día, agrupados por persona y lugar.");
    const words = /tradeoff|mental model|modelo mental|consideración/i;
    for (const lang of ["en", "es"]) expect(JSON.stringify(messageWorkflowPickerCopy[lang])).not.toMatch(words);
    expect(messageWorkflowPickerCopyFor("fr")).toBe(messageWorkflowPickerCopy.en);
  });

  it("no longer reads the old barrel keys in the picker", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/MessageWorkflowPicker.jsx"), "utf8");
    expect(source).not.toContain("inbox.workflow.conLabel");
    expect(source).toContain("messageWorkflowPickerCopyFor(lang)");
  });
});
