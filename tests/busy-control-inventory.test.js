// @vitest-environment node
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { EXEMPTIONS_FILE, checkInventory, inventoryDirectory, inventorySource, loadExemptions, parseExemptions } from "../scripts/busy-control-inventory.mjs";

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("finds busy aliases through a cycle while leaving native validation reasons alone", () => {
  const source = `const ready = valid && !saving; const locked = !ready || cycle; const cycle = locked;
    export const View = () => <><button disabled={locked}>Save</button><input disabled={!canEdit} /><textarea disabled={busyId !== null} /></>;`;
  expect(inventorySource(source, "src/View.jsx").nativeDisabled).toEqual([
    { file: "src/View.jsx", line: 2, tag: "button", expression: "locked" },
    { file: "src/View.jsx", line: 2, tag: "textarea", expression: "busyId !== null" },
  ]);
});

// Write and read state names the first
// heuristic missed, a state compared with a string, a pass-through disabled
// and a spread of a component's rest props onto a native control.
it("counts write and read state names, compared strings, pass-through disabled and passed-on spreads", () => {
  const source = `function Field({ label, ...rest }) { return <input aria-label={label} {...rest} />; }
    function Pick({ disabled }) { return <select disabled={disabled} />; }
    function Wrap(props) { return <div {...props} />; }
    export const View = ({ creating, sending, phase, option }) => <>
      <button disabled={creating}>Add</button>
      <button disabled={sending || !ready}>Send</button>
      <button disabled={phase === "creating"}>Create</button>
      <button disabled={option.disabled}>Option</button>
      <button disabled={!ready}>Validated</button>
    </>;`;
  expect(inventorySource(source, "src/View.jsx").nativeDisabled).toEqual([
    { file: "src/View.jsx", line: 1, tag: "input", expression: "{...rest}", kind: "spread", carriesDisabled: "unknown" },
    { file: "src/View.jsx", line: 2, tag: "select", expression: "disabled", kind: "pass-through" },
    { file: "src/View.jsx", line: 5, tag: "button", expression: "creating" },
    { file: "src/View.jsx", line: 6, tag: "button", expression: "sending || !ready" },
    { file: "src/View.jsx", line: 7, tag: "button", expression: "phase === \"creating\"" },
    { file: "src/View.jsx", line: 8, tag: "button", expression: "option.disabled", kind: "pass-through" },
  ]);
});

it("lists pending controls separately without calling them proven fixes", () => {
  const report = inventorySource("const v = <><BusyButton pending={saving} /><UI.Switch pending /><button disabled={false} /></>;", "src/View.jsx");
  expect(report.nativeDisabled).toEqual([]);
  expect(report.pending).toMatchObject([{ tag: "BusyButton", expression: "saving" }, { tag: "UI.Switch", expression: "true" }]);
});

it("scans JSX and typed controls with stable paths and skips symlinked data", () => {
  const root = mkdtempSync(join(tmpdir(), "busy-inventory-")); directories.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "View.tsx"), "const busy: boolean = true; const v = <button disabled={busy}>Save</button>;");
  writeFileSync(join(root, "outside.jsx"), "const v = <button disabled={saving}>Outside</button>;");
  symlinkSync(join(root, "outside.jsx"), join(root, "src", "linked.jsx"));
  const report = inventoryDirectory(root);
  expect(report.counts).toEqual({ nativeDisabledCandidates: 1, candidateFiles: 1, pendingControls: 0, uncountedDisabled: 0 });
  expect(report.nativeDisabled[0].file).toBe("src/View.tsx");
  expect(report).toMatchObject({ heuristic: true, note: expect.stringContaining("do not prove") });
});

it("fails on an unparsable source instead of reporting a clean inventory", () => {
  expect(() => inventorySource("const v = <button", "src/Broken.jsx")).toThrow();
});

// #8435's closing check: every candidate is converted or listed, exactly.
const row = (expression, line = 1, file = "src/View.jsx", tag = "button") => ({ file, line, tag, expression });
const entry = (expression, count = 1, extra = {}) => ({ file: "src/View.jsx", tag: "button", expression, count, reason: "Reviewed native design.", reviewedIn: "#1", ...extra });
const exemptions = (entries) => JSON.stringify({ schema: "busy-control-exemptions/1", entries });

it("passes only when each candidate is listed with the exact number found", () => {
  const report = { nativeDisabled: [row("busy", 1), row("busy", 2), row("saving", 3)] };
  expect(checkInventory(report, [entry("busy", 2), entry("saving")])).toEqual({ ok: true, unlisted: [], stale: [] });
  expect(checkInventory({ nativeDisabled: [] }, [])).toEqual({ ok: true, unlisted: [], stale: [] });
});

it("fails on an unlisted candidate and on more candidates than an entry lists", () => {
  const report = { nativeDisabled: [row("busy", 1), row("busy", 2), row("saving", 3)] };
  const result = checkInventory(report, [entry("busy")]);
  expect(result.ok).toBe(false);
  expect(result.unlisted).toEqual([
    { ...row("busy", 1), listedCount: 1, foundCount: 2 },
    { ...row("busy", 2), listedCount: 1, foundCount: 2 },
    row("saving", 3),
  ]);
  expect(result.stale).toEqual([]);
});

it("fails on a stale entry: fewer candidates than listed, or none left", () => {
  const result = checkInventory({ nativeDisabled: [row("busy")] }, [entry("busy", 2), entry("gone")]);
  expect(result.ok).toBe(false);
  expect(result.unlisted).toEqual([]);
  expect(result.stale).toEqual([{ ...entry("busy", 2), foundCount: 1 }, { ...entry("gone"), foundCount: 0 }]);
});

it("refuses an exemption list with a missing field, a bad count, a repeat or the wrong schema", () => {
  expect(parseExemptions(exemptions([entry("busy")]))).toEqual([entry("busy")]);
  expect(() => parseExemptions(JSON.stringify({ schema: "other", entries: [] }))).toThrow(/schema/);
  for (const field of ["file", "tag", "expression", "reason", "reviewedIn"]) {
    expect(() => parseExemptions(exemptions([entry("busy", 1, { [field]: " " })]))).toThrow(new RegExp(field));
  }
  for (const count of [0, 1.5, "1", null]) expect(() => parseExemptions(exemptions([entry("busy", count)]))).toThrow(/count/);
  expect(() => parseExemptions(exemptions([entry("busy"), entry("busy", 2)]))).toThrow(/repeats/);
});

it("keeps the repository's exemption list exact: every entry still matches what it names", () => {
  const root = resolve(import.meta.dirname, "..");
  const entries = loadExemptions(root);
  expect(entries.length).toBeGreaterThan(0);
  expect(checkInventory(inventoryDirectory(root), entries).stale).toEqual([]);
});

it("exits non-zero from --check with each unlisted control, and zero once all are listed", () => {
  const root = mkdtempSync(join(tmpdir(), "busy-inventory-check-")); directories.push(root);
  mkdirSync(join(root, "src")); mkdirSync(join(root, "config"));
  writeFileSync(join(root, "src", "View.jsx"), "const busy = true; const v = <button disabled={busy}>Save</button>;");
  const script = resolve(import.meta.dirname, "..", "scripts", "busy-control-inventory.mjs");
  const run = () => spawnSync(process.execPath, [script, "--check"], { cwd: root, encoding: "utf8" });
  writeFileSync(join(root, EXEMPTIONS_FILE), exemptions([]));
  const failing = run();
  expect(failing.status).toBe(1);
  expect(failing.stdout).toContain("UNLISTED src/View.jsx:1 <button> disabled={busy}");
  expect(failing.stdout).toContain("BUSY_CONTROL_INVENTORY_FAILED unlisted=1 stale=0");
  writeFileSync(join(root, EXEMPTIONS_FILE), exemptions([entry("busy")]));
  const passing = run();
  expect(passing.status).toBe(0);
  expect(passing.stdout).toContain("BUSY_CONTROL_INVENTORY_CLEAN");
});

// Eight more write names, the kind in the
// exemption key, and --uncounted, the finite list of native disabled the rule
// does not count, which the closing slice's review reads instead of the names.
it("counts the deciding, dismissing, granting, hiding, restoring, minting, wording and verifying states", () => {
  const source = `export const View = ({ deciding, dismissing, granting, hideState, minting, wording, confirm }) => <>
    <button disabled={deciding}>A</button><button disabled={dismissing === id}>B</button><button disabled={Boolean(granting)}>C</button>
    <button disabled={hideState === "hiding"}>D</button><button disabled={hideState === "restoring"}>E</button>
    <button disabled={minting}>F</button><button disabled={wording}>G</button><button disabled={confirm.verifying === true}>H</button>
  </>;`;
  expect(inventorySource(source, "src/View.jsx").nativeDisabled.map(row => row.expression)).toEqual([
    "deciding", "dismissing === id", "Boolean(granting)", "hideState === \"hiding\"", "hideState === \"restoring\"", "minting", "wording", "confirm.verifying === true",
  ]);
});

it("keys an exemption by kind, so a pass-through entry does not cover an expression row", () => {
  const passThrough = { ...row("disabled"), kind: "pass-through" };
  expect(checkInventory({ nativeDisabled: [passThrough] }, [entry("disabled", 1, { kind: "pass-through" })]).ok).toBe(true);
  const result = checkInventory({ nativeDisabled: [row("disabled")] }, [entry("disabled", 1, { kind: "pass-through" })]);
  expect(result.unlisted).toEqual([row("disabled")]);
  expect(result.stale).toEqual([{ ...entry("disabled", 1, { kind: "pass-through" }), foundCount: 0 }]);
  expect(() => parseExemptions(exemptions([entry("busy", 1, { kind: "other" })]))).toThrow(/kind/);
});

it("lists every disabled the rule does not count, on any tag, wrappers included", () => {
  const source = `const v = <><button disabled={!ready}>A</button><input disabled /><select disabled={busy} />
    <BusyButton disabled={locked} /><div disabled={x} /><textarea disabled={chosen} /></>;`;
  // Every tag, wrappers included, since a
  // BusyButton renders a native disabled too.
  expect(inventorySource(source, "src/View.jsx").uncounted).toEqual([
    { file: "src/View.jsx", line: 1, tag: "button", expression: "!ready" },
    { file: "src/View.jsx", line: 1, tag: "input", expression: "true" },
    { file: "src/View.jsx", line: 2, tag: "BusyButton", expression: "locked" },
    { file: "src/View.jsx", line: 2, tag: "div", expression: "x" },
    { file: "src/View.jsx", line: 2, tag: "textarea", expression: "chosen" },
  ]);
  const root = mkdtempSync(join(tmpdir(), "busy-inventory-uncounted-")); directories.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "View.jsx"), source);
  const script = resolve(import.meta.dirname, "..", "scripts", "busy-control-inventory.mjs");
  const out = spawnSync(process.execPath, [script, "--uncounted"], { cwd: root, encoding: "utf8" });
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("UNCOUNTED src/View.jsx:1 <button> disabled={!ready}");
  expect(out.stdout).toContain("BUSY_CONTROL_UNCOUNTED scope=src/ total=5 files=1");
});

// #9927 (carved from #8435): load-more, retry and search buttons disable themselves
// under the names paging, reading, retrying and searching.
it("counts paging, reading, retrying and searching as in-flight names", () => {
  const source = `const v = <><button disabled={pagingMessages}>A</button><button disabled={reading}>B</button><button disabled={retrying}>C</button><button disabled={phase === "searching"}>D</button></>;`;
  expect(inventorySource(source, "src/View.jsx").nativeDisabled.map((row) => row.expression)).toEqual([
    "pagingMessages", "reading", "retrying", "phase === \"searching\"",
  ]);
});

// #9914 (carved from #8435): the Open task button and both ballot receipt
// lookups disable themselves under the names opening and checking.
it("counts opening and checking as in-flight names", () => {
  const source = `const v = <><button disabled={phase === "opening"}>Open</button><button disabled={receiptCheck?.state === "checking"}>Check</button><button disabled={checking || !code.trim()}>Go</button></>;`;
  expect(inventorySource(source, "src/View.jsx").nativeDisabled).toEqual([
    { file: "src/View.jsx", line: 1, tag: "button", expression: "phase === \"opening\"" },
    { file: "src/View.jsx", line: 1, tag: "button", expression: "receiptCheck?.state === \"checking\"" },
    { file: "src/View.jsx", line: 1, tag: "button", expression: "checking || !code.trim()" },
  ]);
});

it("lists a spread onto a form control the rule does not count, and counts reviewing", () => {
  const source = `const lock = lockedProps(locked); const v = <><input {...lock} /><div {...lock} /><button disabled={Boolean(reviewingId)}>Mark</button></>;`;
  const report = inventorySource(source, "src/View.jsx");
  expect(report.uncounted).toEqual([{ file: "src/View.jsx", line: 1, tag: "input", expression: "{...lock}", kind: "spread", carriesDisabled: "unknown" }]);
  expect(report.nativeDisabled).toEqual([{ file: "src/View.jsx", line: 1, tag: "button", expression: "Boolean(reviewingId)" }]);
});

// A spread beside the control's own
// disabled= and a spread onto a Busy* wrapper are in neither list before this,
// so they go with the uncounted rows; --check does not change.
it("lists a spread beside its own disabled and a spread onto a Busy wrapper as uncounted", () => {
  const source = `function Field(props) { return <><input {...props} disabled={!ready} /><BusyInput {...props} /></>; }
    const lock = { disabled: locked }; const v = <><button disabled={busy} {...lock}>A</button><BusyButton pending={busy} {...lock} /></>;`;
  const report = inventorySource(source, "src/View.jsx");
  expect(report.nativeDisabled).toEqual([{ file: "src/View.jsx", line: 2, tag: "button", expression: "busy" }]);
  expect(report.uncounted).toEqual([
    { file: "src/View.jsx", line: 1, tag: "input", expression: "!ready" },
    { file: "src/View.jsx", line: 1, tag: "input", expression: "{...props}", kind: "spread", carriesDisabled: "unknown" },
    { file: "src/View.jsx", line: 1, tag: "BusyInput", expression: "{...props}", kind: "spread", carriesDisabled: "unknown" },
    { file: "src/View.jsx", line: 2, tag: "button", expression: "{...lock}", kind: "spread", carriesDisabled: "yes" },
    { file: "src/View.jsx", line: 2, tag: "BusyButton", expression: "{...lock}", kind: "spread", carriesDisabled: "yes" },
  ]);
  expect(checkInventory({ nativeDisabled: report.nativeDisabled }, [entry("busy", 1, { tag: "button" })]).ok).toBe(true);
});

it("says whether a spread's local object, local function or inline object carries disabled", () => {
  const source = `function groupProps(field) { return field ? { "aria-describedby": field } : {}; }
    const shut = () => ({ disabled: true }); const extra = { className: "x" };
    const v = <><input {...groupProps("a")} /><input {...shut()} /><input {...extra} /><input {...(open ? {} : { disabled: true })} /><input {...unknownProps} /></>;`;
  expect(inventorySource(source, "src/View.jsx").uncounted.map(row => [row.expression, row.carriesDisabled])).toEqual([
    ['{...groupProps("a")}', "no"],
    ["{...shut()}", "yes"],
    ["{...extra}", "no"],
    ["{...open ? {} : { disabled: true }}", "yes"],
    ["{...unknownProps}", "unknown"],
  ]);
  const root = mkdtempSync(join(tmpdir(), "busy-inventory-carries-")); directories.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "View.jsx"), source);
  const script = resolve(import.meta.dirname, "..", "scripts", "busy-control-inventory.mjs");
  const out = spawnSync(process.execPath, [script, "--uncounted"], { cwd: root, encoding: "utf8" });
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("UNCOUNTED src/View.jsx:3 <input> disabled={{...shut()}} kind=spread carries-disabled=yes");
  expect(out.stdout).toContain("UNCOUNTED src/View.jsx:3 <input> disabled={{...unknownProps}} kind=spread carries-disabled=unknown\n");
});

// "no" only for a spread that resolves to
// object literals in the file; a member expression, an import, an undefined
// call, a prop or a function value is "unknown", so "no" can skip a row.
it("says unknown for a spread the inventory cannot resolve to an object literal", () => {
  const source = `import { shared } from "./shared.js";
    const base = { className: "x" }; const merged = { ...base, id: "a" }; const closed = { ...base, ...{ disabled: true } };
    function pick(flag) { if (flag) return { disabled: true }; return base; }
    const handler = () => {}; const chain = merged;
    const v = <><input {...lockedProps(locked)} /><input {...state.lock} /><input {...shared} /><input {...merged} />
      <input {...closed} /><input {...pick(x)} /><input {...handler} /><input {...chain} /><input {...(ready && base)} /></>;`;
  expect(inventorySource(source, "src/View.jsx").uncounted.map(row => [row.expression, row.carriesDisabled])).toEqual([
    ["{...lockedProps(locked)}", "unknown"],
    ["{...state.lock}", "unknown"],
    ["{...shared}", "unknown"],
    ["{...merged}", "no"],
    ["{...closed}", "yes"],
    ["{...pick(x)}", "yes"],
    ["{...handler}", "unknown"],
    ["{...chain}", "no"],
    ["{...ready && base}", "unknown"],
  ]);
});

// #8969 review P3: a computed key is read when the file fixes it, and is
// unknown otherwise; a nested spread that cannot be resolved is unknown too.
it("reads statically known computed keys and leaves other computed keys unknown", () => {
  const source = `const name = pickKey(); const local = { ["disabled"]: true }; const literal = { [\`disabled\`]: true };
    const other = { ["aria-busy"]: true }; const dynamic = { [name]: true }; const nested = { ...props.lock };
    const v = <><input {...local} /><input {...literal} /><input {...other} /><input {...dynamic} /><input {...nested} /></>;`;
  expect(inventorySource(source, "src/View.jsx").uncounted.map(row => [row.expression, row.carriesDisabled])).toEqual([
    ["{...local}", "yes"],
    ["{...literal}", "yes"],
    ["{...other}", "no"],
    ["{...dynamic}", "unknown"],
    ["{...nested}", "unknown"],
  ]);
});

// A helper that spreads its own
// call terminates at runtime; the inventory must resolve it once and end
// rather than recurse until the stack overflows.
it("resolves a spread of a helper that spreads its own call without recursing forever", () => {
  const source = `function props(depth = 1) {
  return { disabled: true, ...(depth ? props(0) : {}) };
}
const view = <input {...props()} />;`;
  expect(inventorySource(source, "src/View.jsx").uncounted.map(row => [row.expression, row.carriesDisabled])).toEqual([["{...props()}", "yes"]]);
});

