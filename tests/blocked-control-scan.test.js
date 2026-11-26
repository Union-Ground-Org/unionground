// @vitest-environment node
//
// #9485 part A: unit tests on synthetic input for the reporting tool behind
// rule (a) of docs/contracts/visible-control-honesty.md. Nothing here reads
// the product tree; enforcement is #9485 part B.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  CONTRACT_PATH, SURFACES, attributeValue, blockedWithoutReason, busyOnly, listBlockedControls, scanBlockedControls,
} from "../scripts/lib/blocked-control-scan.mjs";

const scan = (lines) => blockedWithoutReason(lines.join("\n")).map(({ line, gate }) => `${line} ${gate}`);

describe("the blocked-control scan", () => {
  it("finds a planted blocked button with no reason, with its line and gate", () => {
    expect(scan([
      "return <form>",
      "  <BusyButton type=\"submit\" pending={busy} disabled={!name.trim()}>Save</BusyButton>",
      "  <button type=\"button\" disabled>Coming soon</button>",
      "  <Button disabled={busy || name.length < 3}>Send</Button>",
      "</form>;",
    ])).toEqual(["2 !name.trim()", "3 ", "4 busy || name.length < 3"]);
  });

  it("passes a stated reason and the pressable pattern", () => {
    expect(scan([
      "<BusyButton type=\"submit\" pending={busy} disabled={!canFinish} disabledReason={block && t(block)}>Save</BusyButton>",
      "<BusyButton type=\"submit\" pending={busy}>{t(\"auth.passwordChange\")}</BusyButton>",
      "{outcome ? <div role=\"alert\">{t(outcome.key)}</div> : null}",
    ])).toEqual([]);
  });

  it("exempts busy-only and pass-through gates and nothing else", () => {
    for (const busy of ["busy", "Boolean(busy)", "!!saving", "savingId === row.id", "busy || pending", "state === \"loading\"",
      "historyLoading", "props.disabled", "option?.disabled", "false"]) {
      expect(busyOnly(busy), busy).toBe(true);
    }
    for (const blocked of [true, "!ready", "busy || !valid", "!hasPendingChanges", "!saving", "locked", "phase !== \"loading\"",
      "(a && b)", "busy && (a || b)"]) {
      expect(busyOnly(blocked), String(blocked)).toBe(false);
    }
  });

  it("raises no alarm on a loading label, a row that names why, or the shared button itself", () => {
    expect(scan([
      "<button disabled={loading}>{loading ? t(\"more.loading\") : t(\"more\")}</button>",
      "<button disabled={item.disabled}>{item.title}</button>",
      "export function BusyButton({ disabled = false, disabledReason = null, ...props }) {",
      "  return <button {...props} disabled={nativeDisabled} />;",
      "}",
    ])).toEqual([]);
    expect(scan(["<button {...rest} disabled={!ok} />"])).toEqual(["1 !ok"]);
  });

  it("skips comments and unclosed tags; counts markup in a string (a stated limit)", () => {
    expect(scan(["// <button disabled>Soon</button>", "{/* <button disabled={!ok}> */}", "/*", " <button disabled>", "*/"])).toEqual([]);
    expect(scan(["<button onClick={go}", "<Button disabled={!ok}>Go</Button>"])).toEqual(["2 !ok"]);
    expect(scan(["<button disabled={!ok}"])).toEqual([]);
    expect(scan(["const html = `<button disabled={locked}>Save</button>`;"])).toEqual(["1 locked"]);
  });

  it("reads a tag to its real end and only its top-level attributes", () => {
    const source = "<BusyButton onClick={() => count > 2 && go(\"a>b\")} title=\"x > y\" disabled={count > 9}>Go</BusyButton>";
    expect(attributeValue(source, "disabled")).toBe("count > 9");
    expect(attributeValue(source, "disabledReason")).toBeUndefined();
    expect(attributeValue("<button disabled>", "disabled")).toBe(true);
    expect(attributeValue("<Button isDisabled={x} disabledLook>", "disabled")).toBeUndefined();
    expect(attributeValue("<Button className={disabled ? \"a\" : \"b\"}>", "disabled")).toBeUndefined();
    expect(attributeValue("<Button\n  disabled={!ok}\n>", "disabled")).toBe("!ok");
  });
});

describe("the tree scan and its listing", () => {
  const root = mkdtempSync(join(tmpdir(), "blocked-control-scan-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "src/views/Fixture.jsx": "<button disabled={!ready}>Go</button>\n<Button disabled>Soon</Button>\n",
    "src/views/Fine.jsx": "<button disabled={saving}>Save</button>\n",
    "src/views/Fixture.test.jsx": "<button disabled={!ready}>Go</button>\n",
    "src/styles/site.css": "button[disabled] { opacity: 0.5; }\n",
    "api/handler.js": "<button disabled={!ready}>Go</button>\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);

  it("reads tracked source under src/ only, skipping tests, other types and other trees", () => {
    expect(SURFACES.map(({ tree }) => tree)).toEqual(["src/"]);
    expect(scanBlockedControls(root)).toEqual({
      "src/views/Fixture.jsx": [{ line: 1, tag: "button", gate: "!ready" }, { line: 2, tag: "Button", gate: "" }],
    });
  });

  it("skips a listed path that is gone", () => {
    expect(scanBlockedControls(root, ["src/views/Gone.jsx", "src/views/Fixture.jsx"])["src/views/Fixture.jsx"]).toHaveLength(2);
    expect(scanBlockedControls(root, ["src/views/Gone.jsx"])).toEqual({});
  });

  it("prints one line per place and a count that points at the contract", () => {
    expect(listBlockedControls(root)).toEqual([
      "src/views/Fixture.jsx:1 <button> disabled={!ready}",
      "src/views/Fixture.jsx:2 <Button> disabled",
      `2 place(s); see ${CONTRACT_PATH} rule (a)`,
    ]);
    expect(listBlockedControls(root, [])).toEqual([`0 place(s); see ${CONTRACT_PATH} rule (a)`]);
  });

  it("prints the same listing from the command line", () => {
    const script = join(import.meta.dirname, "../scripts/lib/blocked-control-scan.mjs");
    expect(execFileSync(process.execPath, [script, "--list"], { cwd: root, encoding: "utf8" })).toBe(`${listBlockedControls(root).join("\n")}\n`);
  });
});
