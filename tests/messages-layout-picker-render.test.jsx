import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageWorkflowPicker } from "../src/components/MessageWorkflowPicker.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { messageWorkflowPickerCopy } from "../src/lib/messageWorkflowPickerCopy.js";

// BUG-UG-MESSAGES-LAYOUT-PICKER-DESIGN-DOC-WORDING-20261106: the
// rendered picker uses the plain wording in both languages.
afterEach(cleanup);

describe("Messages layout picker on screen", () => {
  it.each(["en", "es"])("shows the plain downside label and default description in %s", (lang) => {
    render(<LanguageProvider lang={lang}><MessageWorkflowPicker value="people-spaces-work" onChange={vi.fn()} /></LanguageProvider>);
    expect(screen.getAllByText(messageWorkflowPickerCopy[lang].conLabel)).toHaveLength(3);
    expect(screen.getByText(messageWorkflowPickerCopy[lang].pro["people-spaces-work"])).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Tradeoff|mental model|modelo mental|Consideración/);
  });
});
