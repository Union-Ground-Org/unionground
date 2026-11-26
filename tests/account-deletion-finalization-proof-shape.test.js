// @vitest-environment node
// TEST-UG-ACCOUNT-DELETION-PROOF-LEAKS-FIXTURES-ON-ASSERTION-20260921
// proveConcurrentReconciliation inserts autocommitted rows after the primary
// fixture transaction has rolled back. The insert and its count assertion have
// to live in the same try whose finally deletes those rows.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const localProof = readFileSync(
  new URL("../scripts/verify-account-deletion-finalization-local.mjs", import.meta.url),
  "utf8",
);

const LEAKED_SHAPE = `
  async function proveConcurrentReconciliation(pgClient) {
    let inserted = [];
    try {
      inserted = [];
      insert into private.member_account_deletions
    } finally {
      set session_replication_role = origin
    }
    assert(inserted.length === fixtureCount, "short");
    try {
      const counts = 1;
    } finally {
      delete from private.member_account_lifecycle_audit where subject_hash = any($1::text[])
      delete from private.member_account_deletions where subject_hash = any($1::text[])
    }
  }
`;

const CONTAINED_SHAPE = `
  async function proveConcurrentReconciliation(pgClient) {
    let inserted = [];
    try {
      insert into private.member_account_deletions
      assert(inserted.length === fixtureCount, "count");
      try {
        const counts = 1;
      } catch (error) {
        await worker.query("rollback").catch(() => {});
        throw error;
      } finally {
        await worker.end().catch(() => {});
      }
    } finally {
      delete from private.member_account_lifecycle_audit where subject_hash = any($1::text[])
      delete from private.member_account_deletions where subject_hash = any($1::text[])
    }
  }
`;

function keywordAt(source, index, word) {
  if (!source.startsWith(word, index)) return false;
  const before = source[index - 1];
  const after = source[index + word.length];
  if (before === "." || (before && /[A-Za-z0-9_$]/.test(before))) return false;
  if (after && /[A-Za-z0-9_$]/.test(after)) return false;
  return true;
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const token = source[index];
    if (token === "{") depth += 1;
    else if (token === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function tryFinallyRegions(source) {
  const regions = [];
  const frames = [];
  const awaitingFinally = [];
  const templateExpr = [];
  let mode = "code";
  let depth = 0;
  let index = 0;
  let nextBrace = null;

  const topAwaiting = () => awaitingFinally[awaitingFinally.length - 1];

  while (index < source.length) {
    const token = source[index];
    const next = source[index + 1];

    if (mode === "line") {
      if (token === "\n") mode = "code";
      index += 1;
      continue;
    }
    if (mode === "block") {
      if (token === "*" && next === "/") {
        mode = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (mode === "single" || mode === "double") {
      if (token === "\\") {
        index += 2;
        continue;
      }
      if ((mode === "single" && token === "'") || (mode === "double" && token === '"')) mode = "code";
      index += 1;
      continue;
    }
    if (mode === "template") {
      if (token === "\\") {
        index += 2;
        continue;
      }
      if (token === "`") {
        mode = "code";
        index += 1;
        continue;
      }
      if (token === "$" && next === "{") {
        templateExpr.push(1);
        mode = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (token === "/" && next === "/") {
      mode = "line";
      index += 2;
      continue;
    }
    if (token === "/" && next === "*") {
      mode = "block";
      index += 2;
      continue;
    }
    if (token === "'") {
      mode = "single";
      index += 1;
      continue;
    }
    if (token === '"') {
      mode = "double";
      index += 1;
      continue;
    }
    if (token === "`") {
      mode = "template";
      index += 1;
      continue;
    }

    if (token === "{") {
      depth += 1;
      if (templateExpr.length > 0) templateExpr[templateExpr.length - 1] += 1;
      const awaiting = topAwaiting();
      if (nextBrace === "try") {
        frames.push({
          kind: "try",
          depth,
          region: { tryStart: index + 1, tryEnd: -1, finallyStart: -1, finallyEnd: -1 },
        });
        nextBrace = null;
      } else if (nextBrace === "finally") {
        const region = awaitingFinally.pop();
        region.finallyStart = index + 1;
        frames.push({ kind: "finally", depth, region });
        nextBrace = null;
      } else if (awaiting?.awaitingCatchBrace) {
        awaiting.awaitingCatchBrace = false;
        awaiting.catchDepth = depth;
      }
      index += 1;
      continue;
    }

    if (token === "}") {
      if (templateExpr.length > 0) {
        templateExpr[templateExpr.length - 1] -= 1;
        if (templateExpr[templateExpr.length - 1] === 0) {
          templateExpr.pop();
          mode = "template";
          index += 1;
          continue;
        }
      }
      const awaiting = topAwaiting();
      if (awaiting?.inItsCatch && awaiting.catchDepth === depth) awaiting.inItsCatch = false;
      const closingDepth = depth;
      depth -= 1;
      while (frames.length > 0 && frames[frames.length - 1].depth === closingDepth) {
        const frame = frames.pop();
        if (frame.kind === "try") {
          frame.region.tryEnd = index;
          awaitingFinally.push(frame.region);
        } else if (frame.kind === "finally") {
          frame.region.finallyEnd = index;
          regions.push(frame.region);
        }
      }
      index += 1;
      continue;
    }

    if (keywordAt(source, index, "try")) {
      nextBrace = "try";
      index += 3;
      continue;
    }
    if (keywordAt(source, index, "catch") && topAwaiting() && !topAwaiting().inItsCatch) {
      const awaiting = topAwaiting();
      awaiting.inItsCatch = true;
      awaiting.awaitingCatchBrace = true;
      index += 5;
      continue;
    }
    if (keywordAt(source, index, "finally") && topAwaiting()) {
      nextBrace = "finally";
      index += 7;
      continue;
    }

    const awaiting = topAwaiting();
    if (awaiting && !awaiting.inItsCatch && !awaiting.awaitingCatchBrace && !/\s/.test(token)) {
      while (awaitingFinally.length > 0 && !awaitingFinally[awaitingFinally.length - 1].inItsCatch) {
        awaitingFinally.pop();
      }
    }
    index += 1;
  }

  return regions.map((region) => ({
    tryBody: source.slice(region.tryStart, region.tryEnd),
    finallyBody: source.slice(region.finallyStart, region.finallyEnd),
  }));
}

function concurrentFixtureCleanupViolation(source) {
  const fn = extractFunction(source, "proveConcurrentReconciliation");
  const cleanup = tryFinallyRegions(fn).filter((region) =>
    region.finallyBody.includes("delete from private.member_account_lifecycle_audit")
    && region.finallyBody.includes("delete from private.member_account_deletions"));
  if (cleanup.length !== 1) {
    return `expected one cleanup try/finally, found ${cleanup.length}`;
  }
  const body = cleanup[0].tryBody;
  const insertAt = body.indexOf("insert into private.member_account_deletions");
  const assertAt = body.indexOf("inserted.length === fixtureCount");
  if (insertAt < 0 || assertAt < 0 || assertAt < insertAt) {
    return "concurrent reconciliation fixture insert and count assertion must sit inside the cleanup try, before the deletes";
  }
  const initAt = fn.indexOf("let inserted = []");
  const bodyAt = fn.indexOf(body);
  if (initAt < 0 || bodyAt < 0 || initAt > bodyAt) {
    return "inserted must be initialized before the cleanup try";
  }
  return null;
}

describe("account deletion concurrent reconciliation fixture cleanup", () => {
  it("rejects a count assertion that runs outside the cleanup try", () => {
    expect(concurrentFixtureCleanupViolation(LEAKED_SHAPE)).toMatch(/cleanup try/);
  });

  it("accepts an insert and count assertion that share the cleanup try", () => {
    expect(concurrentFixtureCleanupViolation(CONTAINED_SHAPE)).toBeNull();
  });

  it("keeps the live proof insert and count assertion inside the cleanup try", () => {
    expect(concurrentFixtureCleanupViolation(localProof)).toBeNull();
  });
});
