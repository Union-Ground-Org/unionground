import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as espree from "espree";

import {
  MemberApiError,
  adminSearchRecoveryMembers,
  adminSearchMembers,
  hasPushSubscription,
  softDeleteChapterTask,
  subscribeToPush,
} from "../src/lib/memberApi.js";

// A PostgREST/RPC failure that carries every field a caller could want to branch
// on. 42501 is the RLS refusal a member actually hits; 22023 is the raise_exception
// PR7 needs to map to an i18n key, which is why this PR exists at all.
const RLS_REFUSAL = {
  message: 'new row violates row-level security policy for table "member_forms"',
  code: "42501",
  details: "Failing row contains (f-1, u-9, submitted).",
  hint: "Check the member_forms insert policy.",
};

const RAISED = {
  message: "daily workload log limit reached",
  code: "22023",
  details: null,
  hint: null,
};

function chainable(result) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
      return () => proxy;
    },
  });
  return proxy;
}

const rpcClient = (error) => ({ rpc: () => Promise.resolve({ data: null, error }) });
const tableClient = (error) => ({ from: () => chainable({ data: null, error }) });

// Every path in memberApi.js that turns a server failure into a thrown error.
// Two are the shared helpers; two are hand-rolled inside the push-subscription
// calls and are the reason this list is a list rather than a pair — a fix
// scoped to the helpers alone would have left these two discarding the code
// with every helper-level assertion still green.
const THROW_PATHS = [
  ["requireData", "Member search", (error) => adminSearchMembers(rpcClient(error), "ana")],
  ["requireData recovery", "Recovery member search", (error) => adminSearchRecoveryMembers(rpcClient(error), "ana")],
  ["expectWrite", "Delete task", (error) => softDeleteChapterTask(rpcClient(error), "task-1")],
  [
    "subscribeToPush",
    "Save push subscription failed",
    (error) => subscribeToPush(rpcClient(error), { endpoint: "https://push.example/1", keys: {} }),
  ],
  [
    "hasPushSubscription",
    "Read push subscription failed",
    (error) => hasPushSubscription(tableClient(error), "u-9", "https://push.example/1"),
  ],
];

describe("a server refusal arrives with its code, not just its sentence", () => {
  it.each(THROW_PATHS)("%s preserves code, details and hint", async (_path, label, call) => {
    const thrown = await call(RLS_REFUSAL).then(
      () => null,
      (error) => error,
    );

    expect(thrown, "the call resolved instead of throwing").toBeInstanceOf(MemberApiError);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.label).toBe(label);
    expect(thrown.code).toBe("42501");
    expect(thrown.details).toBe(RLS_REFUSAL.details);
    expect(thrown.hint).toBe(RLS_REFUSAL.hint);
  });

  it.each(THROW_PATHS)("%s leaves the message byte-identical to the old template", async (_p, label, call) => {
    const thrown = await call(RLS_REFUSAL).then(
      () => null,
      (error) => error,
    );

    // The exact string the pre-change code produced. tests/member-api.test.js
    // asserts this shape across four call sites and App.jsx puts it in a toast,
    // so the code rides ALONGSIDE the message rather than reshaping it.
    expect(thrown.message).toBe(`${label}: ${RLS_REFUSAL.message}`);
  });

  it("carries a raise_exception code, the one PR7 has to branch on", async () => {
    const thrown = await adminSearchMembers(rpcClient(RAISED), "ana").then(
      () => null,
      (error) => error,
    );

    expect(thrown.code).toBe("22023");
    expect(thrown.message).toBe(`Member search: ${RAISED.message}`);
  });

  it("distinguishes a missing code from a falsy one", async () => {
    // PostgREST codes are strings, but a server that answers "" or 0 is telling
    // us something; `|| null` would erase that difference and a caller checking
    // `code === null` would read "the server said nothing" when it did.
    const empty = await adminSearchMembers(rpcClient({ message: "x", code: "" }), "a").then(
      () => null,
      (error) => error,
    );
    const absent = await adminSearchMembers(rpcClient({ message: "x" }), "a").then(
      () => null,
      (error) => error,
    );

    expect(empty.code).toBe("");
    expect(absent.code).toBeNull();
  });

  it("keeps the one stringify fallback in src/ printing the message", async () => {
    // src/lib/outbox.js does `String(error?.message || error)`. Subclassing Error
    // changes `name`, so if `message` were ever falsy that fallback would start
    // printing "MemberApiError: ..." into a member-visible failure list. The
    // label guarantees message is non-empty; this pins that guarantee.
    const thrown = await adminSearchMembers(rpcClient({ message: "", code: "42501" }), "a").then(
      () => null,
      (error) => error,
    );

    expect(thrown.message).toBe("Member search: ");
    expect(String(thrown.message || thrown)).toBe("Member search: ");
  });
});

// ---------------------------------------------------------------------------
// The structural guard.
//
// The behavioural tests above pin the four throw paths that exist TODAY. They
// would all pass if someone added a fifth hand-rolled `throw new Error(...)`
// tomorrow — which is exactly how the two push calls came to differ from the
// helpers in the first place. So this reads src/ and asserts the property
// directly, over a directory walk rather than a file list, because pinning a
// guard to the filenames that exist when it is written is how the next file
// escapes it.
// ---------------------------------------------------------------------------

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) jsFiles(full, out);
    else if (/\.jsx?$/.test(name)) out.push(full);
  }
  return out;
}

const relative = (file) => file.slice(SRC_DIR.length + 1).split(sep).join("/");

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) walkAst(node[key], visit);
}

function collectThrows() {
  const files = jsFiles(SRC_DIR);
  const throwSites = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    let ast;
    try {
      ast = espree.parse(source, {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
        loc: true,
      });
    } catch (error) {
      // Loud, not skipped. A guard that quietly ignores what it cannot read
      // reports "no violations" for exactly the file most likely to hold one.
      throw new Error(`${relative(file)} did not parse, so this guard cannot see its throws: ${error.message}`, { cause: error });
    }

    walkAst(ast, (node) => {
      if (node.type !== "ThrowStatement") return;
      const argument = node.argument;
      const constructor =
        argument?.type === "NewExpression" && argument.callee?.type === "Identifier"
          ? argument.callee.name
          : null;

      let wrapsServerMessage = false;
      walkAst(argument, (inner) => {
        if (inner.type === "MemberExpression" && !inner.computed && inner.property?.name === "message") {
          wrapsServerMessage = true;
        }
      });

      throwSites.push({
        where: `${relative(file)}:${node.loc.start.line}`,
        constructor,
        wrapsServerMessage,
      });
    });
  }

  return { files, throwSites };
}

describe("no throw in src/ may drop a server error code", () => {
  const { files, throwSites } = collectThrows();

  it("finds no throw that interpolates an error message outside MemberApiError", () => {
    const offenders = throwSites
      .filter((site) => site.wrapsServerMessage && site.constructor !== "MemberApiError")
      .map((site) => `${site.where} (throws ${site.constructor ?? "a non-constructor expression"})`);

    expect(
      offenders,
      "this throw puts a server error's message in a string but drops its code — construct a MemberApiError instead",
    ).toEqual([]);
  });

  // Floors, because the assertion above passes trivially against an empty set.
  // Narrowing the walk, the extension filter or the AST predicate until nothing
  // is inspected is the cheapest way to make this file green while it guards
  // nothing, and it is the specific escape a previous round of this campaign
  // had to close with a mutation.
  it("actually inspected the source tree it claims to cover", () => {
    expect(files.length, "the file walk collapsed").toBeGreaterThanOrEqual(50);
    expect(throwSites.length, "the AST predicate stopped finding throws").toBeGreaterThanOrEqual(25);
  });

  it("finds MemberApiError in use on every path that wraps a server error", () => {
    const carried = throwSites.filter((site) => site.constructor === "MemberApiError");
    expect(
      carried.length,
      "the class exists but nothing throws it — the helpers were reverted, or the walk missed memberApi.js",
    ).toBeGreaterThanOrEqual(THROW_PATHS.length);
  });

  // STATED LIMIT, deliberately a comment and not an it() — a test that cannot
  // fail is not coverage, it is coverage-shaped noise. This guard recognises a
  // wrapped server error by the `.message` it interpolates. A throw that wrapped
  // `error.details` or `error.hint` while ignoring `message` would carry no code
  // and would not be seen here. No such throw exists in src/ today, and the
  // behavioural tests above cover every path that does. Recorded because an
  // overclaimed guard is the same defect as an unguarded path.
});
