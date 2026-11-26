// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decryptSensitive, encryptSensitive, migrateSensitiveValue, rewrapSensitive, sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { protectArguments, revealRow } from "../api/_lib/sensitiveContent.js";
import { decryptCaseDocument, encryptCaseDocument } from "../api/_lib/sensitiveCaseDocuments.js";

const organization = randomUUID(), record = randomUUID();
const context = { organization, record, field: "description", purpose: "member_accommodation_requests" };
const key = () => randomBytes(32).toString("base64");
const makeRing = () => sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: key() }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
const plaintext = Buffer.from("Private accommodation health detail — synthetic test only");

describe("sensitive envelope boundary", () => {
  it("uses random authenticated payload and wrapped data keys, never plaintext", () => {
    const ring = makeRing();
    const first = encryptSensitive(plaintext, context, ring), second = encryptSensitive(plaintext, context, ring);
    expect(first).not.toEqual(second);
    expect(JSON.stringify(first)).not.toContain(plaintext.toString());
    expect(decryptSensitive(first, context, ring)).toEqual(plaintext);
    expect(Buffer.from(first.payload.ciphertext, "base64")).toHaveLength(plaintext.length);
  });
  it.each(["organization", "record", "field", "purpose"])("rejects substitution at %s, including rewritten metadata", (coordinate) => {
    const ring = makeRing(), envelope = encryptSensitive(plaintext, context, ring);
    const other = { ...context, [coordinate]: ["organization", "record"].includes(coordinate) ? randomUUID() : "foreign" };
    expect(() => decryptSensitive(envelope, other, ring)).toThrow("sensitive-data-key-or-ciphertext-unavailable");
    expect(() => decryptSensitive({ ...envelope, ...other }, other, ring)).toThrow();
  });
  it.each(["payload", "wrappedKey"])("rejects nonce/tag/ciphertext damage in %s", (box) => {
    const ring = makeRing(), envelope = encryptSensitive(plaintext, context, ring);
    for (const field of ["nonce", "tag", "ciphertext"]) {
      const bad = structuredClone(envelope), bytes = Buffer.from(bad[box][field], "base64");
      bytes[0] ^= 1; bad[box][field] = bytes.toString("base64");
      expect(() => decryptSensitive(bad, context, ring)).toThrow();
      expect(() => rewrapSensitive(bad, context, ring, ring)).toThrow();
    }
  });
  it("fails closed for wrong key version, missing key, changed DEK version and revoked organization", () => {
    const ring = makeRing(), envelope = encryptSensitive(plaintext, context, ring);
    for (const bad of [{ ...envelope, keyVersion: "v2" }, { ...envelope, dataVersion: randomUUID() }, { ...envelope, schema: 2 }]) expect(() => decryptSensitive(bad, context, ring)).toThrow();
    expect(() => decryptSensitive(envelope, context, makeRing())).toThrow();
    expect(() => decryptSensitive(envelope, context, { ...ring, keys: new Map() })).toThrow();
    const revoked = { ...ring, revoked: new Set([organization]) };
    expect(() => decryptSensitive(envelope, context, revoked)).toThrow();
    expect(() => encryptSensitive(plaintext, context, revoked)).toThrow();
  });
  it("validates key configuration and never falls back between SAMPLE and production", () => {
    for (const env of [{}, { SENSITIVE_DATA_KEYS: "bad" }, { SENSITIVE_DATA_KEYS: '{"v1":"literal"}', SENSITIVE_DATA_ACTIVE_KEY: "v1" }, { SENSITIVE_DATA_KEYS: "[]", SENSITIVE_DATA_ACTIVE_KEY: "v1" }]) expect(() => sensitiveKeyring("saas", env)).toThrow();
    const env = { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: key() }), SENSITIVE_DATA_ACTIVE_KEY: "v1" };
    expect(() => sensitiveKeyring("demo", env)).toThrow();
    expect(() => sensitiveKeyring("saas", { ...env, SENSITIVE_DATA_REVOKED_ORGANIZATIONS: '["invalid"]' })).toThrow();
  });
  it("rewraps without changing data bytes/version and restores from separate backup custody", () => {
    const oldRing = makeRing(), newRing = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v2: key() }), SENSITIVE_DATA_ACTIVE_KEY: "v2" });
    const envelope = encryptSensitive(plaintext, context, oldRing);
    const moved = rewrapSensitive(envelope, context, oldRing, newRing);
    expect(moved.payload).toEqual(envelope.payload);
    expect(moved.dataVersion).toBe(envelope.dataVersion);
    expect(moved.keyVersion).toBe("v2");
    expect(decryptSensitive(moved, context, newRing)).toEqual(plaintext);
    expect(() => decryptSensitive(moved, context, oldRing)).toThrow();
    const restored = JSON.parse(JSON.stringify(moved));
    expect(decryptSensitive(restored, context, newRing)).toEqual(plaintext);
    expect(() => decryptSensitive(restored, context, makeRing())).toThrow();
  });
  it("explicit backfill is repeatable, rejects damaged envelopes and never reads legacy plaintext implicitly", () => {
    const ring = makeRing(), envelope = migrateSensitiveValue(plaintext.toString(), null, context, ring);
    expect(migrateSensitiveValue("[encrypted]", envelope, context, ring)).toBe(envelope);
    expect(() => migrateSensitiveValue("[encrypted]", null, context, ring)).toThrow();
    const row = { id: record, organization_id: organization, description: "[encrypted]", staff_note: "", encrypted_content: { description: envelope } };
    expect(revealRow("member_accommodation_requests", row, ring).description).toBe(plaintext.toString());
    expect(() => revealRow("member_accommodation_requests", { ...row, description: plaintext.toString(), encrypted_content: {} }, ring)).toThrow("backfill-required");
    expect(() => migrateSensitiveValue("legacy", { ...envelope, keyVersion: "missing" }, context, ring)).toThrow();
  });
  it("protects RPC fields while retaining original authorization arguments", () => {
    const ring = makeRing();
    const result = protectArguments("create_member_accommodation_request", { p_description: plaintext.toString(), p_request_type: "schedule", p_idempotency_key: record }, organization, ring);
    expect(result.p_arguments).toEqual({ p_description: "[encrypted]", p_request_type: "schedule", p_idempotency_key: record });
    expect(decryptSensitive(result.p_envelopes.description, context, ring)).toEqual(plaintext);
    expect(() => protectArguments("arbitrary_rpc", {}, organization, ring)).toThrow();
    expect(() => protectArguments("create_member_accommodation_request", { p_description: "", p_idempotency_key: record }, organization, ring)).toThrow();
  });
  it("documents encrypt before storage with equal-length ciphertext and authenticate canonical row identity", () => {
    const ring = makeRing(), row = { id: record, organization_id: organization, size_bytes: plaintext.length };
    const { ciphertext, envelope } = encryptCaseDocument(plaintext, row, ring);
    expect(ciphertext).not.toEqual(plaintext);
    expect(ciphertext).toHaveLength(plaintext.length);
    expect(envelope.payload).not.toHaveProperty("ciphertext");
    expect(decryptCaseDocument(ciphertext, { ...row, encrypted_content: envelope }, ring)).toEqual(plaintext);
    expect(() => decryptCaseDocument(ciphertext, { ...row, organization_id: randomUUID(), encrypted_content: envelope }, ring)).toThrow();
    expect(() => decryptCaseDocument(plaintext, { ...row, encrypted_content: envelope }, ring)).toThrow();
    expect(() => decryptCaseDocument(ciphertext, row, ring)).toThrow();
    expect(() => encryptCaseDocument(plaintext, { ...row, size_bytes: 1 }, ring)).toThrow();
  });
  it("does not log secrets or include source data in any failure", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const ring = makeRing(), envelope = encryptSensitive(plaintext, context, ring);
    try { decryptSensitive(envelope, context, makeRing()); } catch (error) {
      expect(error.message).toBe("sensitive-data-key-or-ciphertext-unavailable");
      expect(JSON.stringify(error)).not.toContain(plaintext.toString());
    }
    expect(log).not.toHaveBeenCalled(); log.mockRestore();
  });
});
