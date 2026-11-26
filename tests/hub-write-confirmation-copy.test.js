// #9470 (W2-3): after Report or ask, a reply, or a new space or thread, the
// confirmation says what happened ("Report sent to your chapter"), never the
// button's own word ("Submit", "Reply"). Each App.jsx hub writer passes its
// confirmation as mutate()'s third argument.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { organizeStrings as en } from "../src/lib/i18n/locales/en/organize.js";
import { organizeStrings as es } from "../src/lib/i18n/locales/es/organize.js";

const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
const WRITERS = {
  createChapterSpace: "hub.done.spaceCreated",
  createChapterThread: "hub.done.threadStarted",
  sendChapterThreadPost: "hub.done.replyPosted",
  createMemberIntake: "hub.done.reportSent",
  createChapterDocument: "hub.done.documentSaved",
  createChapterRecord: "hub.done.recordSaved",
  createChapterHandshake: "hub.done.partnerRequestSent",
  createGovernanceRequest: "hub.done.governanceRequestSubmitted",
};
const BUTTON_LABELS = ["hub.newSpace", "hub.newThread", "hub.reply", "hub.submit", "hub.save", "hub.sendRequest"];

function confirmationKey(writer) {
  const call = new RegExp(`return mutate\\(memberMutationResources\\("${writer}"\\), [^\\n]*?, tr\\("([^"]+)"\\)\\);`).exec(app);
  return call?.[1] ?? null;
}

describe("hub write confirmations", () => {
  it.each(Object.entries(WRITERS))("%s confirms in the past tense, not with its button label", (writer, key) => {
    const used = confirmationKey(writer);
    expect(used).not.toBeNull();
    expect(BUTTON_LABELS).not.toContain(used);
    expect(used).toBe(key);
  });
  it.each(Object.values(WRITERS))("%s exists in English and Spanish and differs from every button label", (key) => {
    for (const table of [en, es]) {
      expect(table[key]).toMatch(/\S/);
      expect(BUTTON_LABELS.map((label) => table[label])).not.toContain(table[key]);
    }
  });
});
