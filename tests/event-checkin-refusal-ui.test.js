import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { t } from "../src/lib/i18n.js";
import { rpcErrorKeyStrict } from "../src/lib/rpcErrorText.js";

const source = readFileSync("src/App.jsx", "utf8");
const start = source.indexOf("  async function handleCheckIn(");
const handlers = source.slice(start, source.indexOf("  // Calendar feed link:", start));

it.each(["en", "es"])("keeps untokenized check-in refusals in %s catalogue copy", async (lang) => {
  const notices = [];
  const tr = (key) => t(lang, key);
  const raw = new Error("Check-in code: event not found");
  // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
  const run = new Function("memberOperation", "data", "memberMutationResources", "mutate", "tr", "checkInToEvent", "supabase", "setNotice", "demoActive", "requestEventCheckinToken", "rpcErrorKeyStrict", `${handlers}; return {handleCheckIn, handleRequestCheckinCode};`);
  let failureKey;
  const actions = run({ run: (action) => action(), wait: (value) => value, assertCurrent: () => {} }, { events: [] }, () => [],
    async (...args) => { failureKey = args[6]; return null; }, tr, () => {}, {}, (notice) => notices.push(notice), false,
    async () => { throw raw; }, rpcErrorKeyStrict);
  await actions.handleCheckIn("missing-event", "CODE");
  expect(failureKey).toBe("toast.saveFailed");
  await actions.handleRequestCheckinCode("missing-event");
  expect(notices).toEqual(["toast.saveFailed"]);
  expect(notices.map(tr)).toEqual([tr("toast.saveFailed")]);
  expect(notices[0]).not.toContain("event not found");
});
