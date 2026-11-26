import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readOperationKey } from "../api/_lib/operationKey.js";
import {
  OPERATION_KEY_MAX_AGE_MS,
  createOperationKeys,
  operationIntent,
  withOperationKey,
} from "../src/lib/operationKey.js";
import {
  checkInlineOperationKeys,
  countInlineOperationKeys,
  inScope,
  inlineOperationKeyFindings,
} from "../scripts/lib/inline-operation-key-scan.mjs";
import {
  LostResponseError,
  createEffectLedger,
  deliverTwice,
  retryAfterLostResponse,
} from "./helpers/operationReplay.js";

function sequence() {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

describe("shared operation keys", () => {
  it("keeps one key per intent until the server answers", async () => {
    const keys = createOperationKeys(sequence());
    const intent = operationIntent("save", { b: 2, a: 1 });
    expect(operationIntent("save", { a: 1, b: 2 })).toBe(intent);
    expect(operationIntent("save", { a: 1, b: 3 })).not.toBe(intent);
    const first = keys.keyFor(intent);
    expect(keys.keyFor(intent)).toBe(first);
    expect(keys.pending(intent)).toBe(first);
    expect(keys.keyFor(operationIntent("other"))).not.toBe(first);
    keys.settle(intent);
    expect(keys.pending(intent)).toBeNull();
    expect(keys.keyFor(intent)).not.toBe(first);
    keys.clear();
    expect(keys.pending(intent)).toBeNull();
  });

  it("mints a new key once a kept one is ten minutes old", () => {
    let clock = 1_000;
    const keys = createOperationKeys(sequence(), { now: () => clock });
    const first = keys.keyFor("alert");
    clock += OPERATION_KEY_MAX_AGE_MS - 1;
    expect(keys.keyFor("alert")).toBe(first);
    expect(keys.pending("alert")).toBe(first);
    clock += 1;
    expect(keys.pending("alert")).toBeNull();
    const second = keys.keyFor("alert");
    expect(second).not.toBe(first);
    expect(OPERATION_KEY_MAX_AGE_MS).toBe(600_000);
    const short = createOperationKeys(sequence(), { maxAgeMs: 5, now: () => clock });
    const kept = short.keyFor("x");
    clock += 5;
    expect(short.keyFor("x")).not.toBe(kept);
  });

  it("mints an unkept key for a write the server already merges", () => {
    const keys = createOperationKeys(sequence());
    const one = keys.mint();
    expect(keys.mint()).not.toBe(one);
    expect(keys.pending("anything")).toBeNull();
  });

  it("keeps the key after a failure and settles it after an answer", async () => {
    const keys = createOperationKeys(sequence());
    const seen = [];
    await expect(withOperationKey(keys, "write", async (key) => { seen.push(key); throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(withOperationKey(keys, "write", async (key) => { seen.push(key); return "ok"; })).resolves.toBe("ok");
    await withOperationKey(keys, "write", async (key) => { seen.push(key); });
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });

  it("refuses an empty key, a missing UUID source and a nameless intent", () => {
    expect(() => createOperationKeys(null)).toThrow(TypeError);
    expect(() => createOperationKeys(() => "").keyFor("i")).toThrow("produced no operation key");
    expect(() => createOperationKeys(() => 7).keyFor("i")).toThrow("produced no operation key");
    expect(() => operationIntent("")).toThrow(TypeError);
    const saved = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
      expect(() => createOperationKeys().keyFor("i")).toThrow(expect.objectContaining({ code: "UUID_UNAVAILABLE" }));
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: saved, configurable: true });
    }
    expect(createOperationKeys().keyFor("i")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("operation replay test kit", () => {
  it("catches a key minted per call: the retry after a lost response writes twice", async () => {
    const ledger = createEffectLedger();
    const mint = sequence();
    await retryAfterLostResponse(ledger, () => ledger.perform(mint(), "alert"));
    expect(ledger.effects).toHaveLength(2);
  });

  it("applies a kept key once across a lost response, a replay and a double delivery", async () => {
    const ledger = createEffectLedger();
    const keys = createOperationKeys(sequence());
    const send = () => withOperationKey(keys, "alert", (key) => ledger.perform(key, "alert"));
    const answer = await retryAfterLostResponse(ledger, send);
    expect(answer).toEqual({ id: ledger.keys[0], effect: 1 });
    expect(ledger.keys).toEqual([ledger.keys[0], ledger.keys[0]]);
    expect(await ledger.perform(ledger.keys[0], "replayed")).toEqual(answer);
    const twice = createEffectLedger();
    await deliverTwice(() => withOperationKey(keys, "remind", (key) => twice.perform(key)));
    expect(ledger.effects).toHaveLength(1);
    expect(twice.effects).toHaveLength(1);
  });

  it("insists on a key and on a lost first response", async () => {
    const ledger = createEffectLedger();
    await expect(ledger.perform("")).rejects.toThrow("without an operation key");
    await expect(retryAfterLostResponse(ledger, async () => "answered")).rejects.toThrow("expected to lose its response");
    const other = createEffectLedger();
    await expect(retryAfterLostResponse(other, async () => { throw new Error("refused"); })).rejects.toThrow("refused");
    expect(new LostResponseError().name).toBe("LostResponseError");
  });
});

describe("server operation key reader", () => {
  const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  it("reads the body field first, then the Idempotency-Key header", () => {
    expect(readOperationKey({ body: { idempotencyKey: ` ${uuid} ` } }, { uuid: true })).toBe(uuid);
    expect(readOperationKey({ body: {}, headers: { "idempotency-key": [uuid] } }, { uuid: true })).toBe(uuid);
    expect(readOperationKey({ body: { key: "send:delivery-0001" } }, { field: "key" })).toBe("send:delivery-0001");
  });

  it("returns null for a missing or malformed key and never mints one", () => {
    expect(readOperationKey({ body: {} })).toBeNull();
    expect(readOperationKey(undefined)).toBeNull();
    expect(readOperationKey({ body: { idempotencyKey: "send:delivery-0001" } }, { uuid: true })).toBeNull();
    expect(readOperationKey({ body: { idempotencyKey: "short" } })).toBeNull();
  });
});

describe("inline operation key scan", () => {
  it("counts keys minted where the write is sent", () => {
    expect(countInlineOperationKeys([
      "rpc('x', { p_idempotency_key: crypto.randomUUID() });",
      "send({ idempotencyKey: Crypto.randomUUID(), title });",
      "function retry(id, idempotencyKey = crypto.randomUUID()) {}",
      "const operationKey = extras.key || globalThis.crypto.randomUUID();",
    ].join("\n"))).toBe(4);
    expect(countInlineOperationKeys([
      "const [smsIdempotencyKey] = useState(() => crypto.randomUUID());",
      "const key = keys.keyFor(intent);",
      "rpc('x', { p_idempotency_key: key, id: crypto.randomUUID() });",
      "if (idempotencyKey === crypto.randomUUID()) {}",
    ].join("\n"))).toBe(0);
  });

  it("scans product code only", () => {
    expect(inScope("src/lib/memberApi.js")).toBe(true);
    expect(inScope("apps/mobile/src/features/FeatureScreen.tsx")).toBe(true);
    expect(inScope("api/twilio-send.js")).toBe(true);
    expect(inScope("src/lib/memberApi.test.js")).toBe(false);
    expect(inScope("tests/operation-key.test.js")).toBe(false);
    expect(inScope("docs/notes.md")).toBe(false);
  });

  it("never lets the known list grow past the 18 keys of Nov 13, 2026", () => {
    const { files } = JSON.parse(readFileSync("config/inline-operation-key-known.json", "utf8"));
    const total = Object.values(files).reduce((sum, count) => sum + count, 0);
    expect(total).toBeLessThanOrEqual(18);
    expect(Object.keys(files).length).toBeLessThanOrEqual(7);
  });

  it("holds the repository to its known list exactly", () => {
    const failures = [];
    const counts = checkInlineOperationKeys(process.cwd(), (message) => failures.push(message));
    expect(failures).toEqual([]);
    expect(Object.keys(counts).length).toBeGreaterThan(0);
  });

  it("fails closed outside a git checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "inline-operation-key-"));
    try {
      const failures = [];
      expect(checkInlineOperationKeys(root, (message) => failures.push(message))).toEqual({});
      expect(failures).toEqual([expect.stringContaining("cannot list tracked files")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on a new or grown case and on a known count that should shrink", () => {
    expect(inlineOperationKeyFindings({ "src/a.js": 1 }, { "src/a.js": 1 })).toEqual([]);
    const [grown] = inlineOperationKeyFindings({ "src/a.js": 2 }, { "src/a.js": 1 });
    expect(grown).toContain("src/a.js: 2 operation key(s) minted at the call (known 1)");
    const [fresh] = inlineOperationKeyFindings({ "src/b.js": 1 }, {});
    expect(fresh).toContain("known 0");
    const [stale] = inlineOperationKeyFindings({}, { "src/a.js": 1 });
    expect(stale).toContain("lower its known count from 1 to 0");
  });
});
