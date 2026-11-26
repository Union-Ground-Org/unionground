// @vitest-environment node
// SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022: FMLA answers
// reach the database only as one envelope plus a marker, and come back only
// through the caller's own row visibility.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import handler, { EXPORT_SEALED_FORM_LIMIT } from "../api/sensitive-content.js";
import { decryptSensitive, encryptSensitive, sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { filledFormKeys, MAX_FORM_ANSWER_KEYS, revealFormAnswers, sameFormAnswers, SEALED_FORM_TEMPLATES } from "../api/_lib/sensitiveContent.js";
import { PORTAL_HOST } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
const organization = randomUUID(), formId = randomUUID(), caller = randomUUID();
const ANSWERS = { reason: "Synthetic leave reason", dates: "2026-11-02 to 2026-11-20", notes: "" };
let rows, prepared, client;

function response() {
  return { status(code) { this.code = code; return this; }, setHeader(name, value) { this.headers ??= {}; this.headers[name] = value; return this; },
    end(body) { this.body = JSON.parse(body); } };
}
async function call(body) {
  const res = response();
  await handler({ method: "POST", headers: { host: PORTAL_HOST, authorization: "Bearer caller-token" }, body }, res);
  return res;
}
const seal = (answers, record = formId, org = organization) => encryptSensitive(Buffer.from(JSON.stringify(answers)),
  { organization: org, record, field: "answers", purpose: "member_forms" }, sensitiveKeyring());
const writes = () => client.rpc.mock.calls.filter(([name]) => name === "write_sensitive_content").map(([, args]) => args);

beforeEach(() => {
  vi.stubEnv("SENSITIVE_DATA_KEYS", JSON.stringify({ v1: randomBytes(32).toString("base64") }));
  vi.stubEnv("SENSITIVE_DATA_ACTIVE_KEY", "v1");
  rows = [];
  prepared = { formId, organizationId: organization, envelope: null };
  const chain = {};
  for (const name of ["select", "eq", "in", "order", "limit"]) chain[name] = vi.fn(() => chain);
  chain.then = (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve);
  client = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: caller } } })) },
    rpc: vi.fn(async (name) => ({ error: null, data: name === "sensitive_data_organization" ? organization
      : ["prepare_sealed_form", "prepare_unit_sealed_form"].includes(name) ? prepared : name === "stage_sensitive_write" ? randomUUID() : formId })),
    from: vi.fn(() => chain),
  };
  vi.mocked(createClient).mockReturnValue(client);
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe("sealed FMLA form drafts", () => {
  it("names exactly the two FMLA templates, matching the SQL helper", () => {
    expect([...SEALED_FORM_TEMPLATES].sort()).toEqual(["fmla_family", "fmla_self"]);
  });

  it("writes one envelope bound to the draft and no plaintext through the ticketed dispatcher", async () => {
    const res = await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: ANSWERS, step: 2, expectedDataVersion: null } });
    expect(res.code).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("prepare_sealed_form", { p_template_key: "fmla_self" });
    const [write] = writes();
    expect(write.p_operation).toBe("save_sealed_form_draft");
    expect(write.p_arguments).toMatchObject({ p_form_id: formId, p_step: 2, p_changed: true, p_filled: ["reason", "dates"] });
    expect(write.p_arguments.p_data_version).toBe(write.p_envelopes.answers.dataVersion);
    expect(JSON.stringify(write)).not.toContain("Synthetic leave reason");
    const opened = decryptSensitive(write.p_envelopes.answers,
      { organization, record: formId, field: "answers", purpose: "member_forms" }, sensitiveKeyring());
    expect(JSON.parse(opened.toString("utf8"))).toEqual(ANSWERS);
    const staged = client.rpc.mock.calls.find(([name]) => name === "stage_sensitive_write")[1];
    expect(staged).toMatchObject({ p_actor: caller, p_operation: "save_sealed_form_draft", p_arguments: write.p_arguments });
    expect(write.p_arguments.p_expected_data_version).toBeNull();
    expect(res.body.data).toEqual({ formId, dataVersion: write.p_envelopes.answers.dataVersion });
  });

  it("keeps the stored envelope when only key order changed", async () => {
    prepared.envelope = seal(ANSWERS);
    const reordered = { notes: "", dates: ANSWERS.dates, reason: ANSWERS.reason };
    const res = await call({ operation: "save_sealed_form_draft",
      args: { templateKey: "fmla_family", answers: reordered, step: 3, expectedDataVersion: prepared.envelope.dataVersion } });
    expect(res.code).toBe(200);
    expect(res.body.data).toEqual({ formId, dataVersion: prepared.envelope.dataVersion });
    const [write] = writes();
    expect(write.p_arguments).toMatchObject({ p_changed: false, p_data_version: null });
    expect(write.p_envelopes).toEqual({});
    expect(write.p_arguments.p_expected_data_version).toBe(prepared.envelope.dataVersion);
  });

  it("re-seals changed answers and never overwrites a stored envelope it cannot open", async () => {
    prepared.envelope = seal({ reason: "older" });
    await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: ANSWERS, expectedDataVersion: prepared.envelope.dataVersion } });
    expect(writes().map((write) => write.p_arguments.p_changed)).toEqual([true]);
    prepared.envelope = { ...seal(ANSWERS), payload: { nonce: "AA", ciphertext: "AA", tag: "AA" } };
    const refused = await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: {}, expectedDataVersion: prepared.envelope.dataVersion } });
    expect(refused.code).toBe(503);
    expect(writes()).toHaveLength(1);
  });

  it.each([
    ["an unsealed template", { templateKey: "grievance", answers: ANSWERS }],
    ["a non-object answer set", { templateKey: "fmla_self", answers: ["reason"] }],
    ["an invalid key", { templateKey: "fmla_self", answers: { "bad key": "x" } }],
    ["oversized answers", { templateKey: "fmla_self", answers: { reason: "x".repeat(20001) } }],
    ["a fractional step", { templateKey: "fmla_self", answers: ANSWERS, step: 1.5, expectedDataVersion: null }],
    ["a save that names no baseline version", { templateKey: "fmla_self", answers: ANSWERS }],
    ["a malformed baseline version", { templateKey: "fmla_self", answers: ANSWERS, expectedDataVersion: "v1" }],
  ])("refuses %s before any write", async (_name, args) => {
    const res = await call({ operation: "save_sealed_form_draft", args });
    expect(res.code).toBe(400);
    expect(writes()).toEqual([]);
  });

  // #6363 round 2: the draft's identity before any answers are sent.
  it("prepares a sealed draft and returns only its id", async () => {
    prepared = { formId, organizationId: organization, envelope: seal(ANSWERS) };
    const res = await call({ operation: "prepare_sealed_form", args: { templateKey: "fmla_family" } });
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ data: { formId } });
    expect(client.rpc).toHaveBeenCalledWith("prepare_sealed_form", { p_template_key: "fmla_family" });
    expect(writes()).toEqual([]);
    expect((await call({ operation: "prepare_sealed_form", args: { templateKey: "grievance" } })).code).toBe(400);
    prepared = { formId, organizationId: randomUUID(), envelope: null };
    expect((await call({ operation: "prepare_sealed_form", args: { templateKey: "fmla_self" } })).code).not.toBe(200);
  });

  // #7667: a unit-bound draft goes through the unit wrapper with the caller's
  // own context; malformed or foreign context never reaches the database.
  it("prepares and saves a unit-bound sealed draft only with a well-formed own context", async () => {
    const unitId = randomUUID();
    const unit = { unitId, actorId: caller, chapterId: "chapter-1", organizationId: organization };
    const prepare = await call({ operation: "prepare_sealed_form", args: { templateKey: "fmla_self", ...unit } });
    expect(prepare.code).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("prepare_unit_sealed_form", { p_template_key: "fmla_self", p_unit: unitId, p_actor: caller, p_chapter: "chapter-1", p_organization: organization });
    const chapterOnly = await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: ANSWERS, step: 1, expectedDataVersion: null, ...unit, unitId: null } });
    expect(chapterOnly.code).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("prepare_unit_sealed_form", { p_template_key: "fmla_self", p_unit: null, p_actor: caller, p_chapter: "chapter-1", p_organization: organization });
    client.rpc.mockClear();
    for (const bad of [{ unitId: "not-a-unit" }, { actorId: "someone" }, { organizationId: randomUUID() }, { organizationId: "nope" }, { chapterId: 42 }, { chapterId: "c".repeat(201) }]) {
      expect((await call({ operation: "prepare_sealed_form", args: { templateKey: "fmla_self", ...unit, ...bad } })).code).toBe(400);
      expect((await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: ANSWERS, step: 1, expectedDataVersion: null, ...unit, ...bad } })).code).toBe(400);
    }
    expect(client.rpc.mock.calls.filter(([name]) => name.startsWith("prepare_"))).toEqual([]);
  });

  it("refuses a draft bound to another organization", async () => {
    prepared.organizationId = randomUUID();
    const res = await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: ANSWERS, expectedDataVersion: null } });
    expect(res.code).toBe(503);
    expect(writes()).toEqual([]);
  });

  // #6363 r3s2: a save prepared against one draft is refused, not retargeted,
  // when prepare now names another (the first was submitted in between).
  it("refuses a save whose prepared form id is no longer the caller's open draft", async () => {
    const stale = await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: ANSWERS, expectedDataVersion: null, formId: randomUUID() } });
    expect(stale.code).toBe(409);
    expect(stale.body).toEqual({ error: "sensitive-data-conflict" });
    expect((await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: ANSWERS, expectedDataVersion: null, formId: "x" } })).code).toBe(400);
    expect(writes()).toEqual([]);
    const bound = await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: ANSWERS, expectedDataVersion: null, formId } });
    expect(bound.code).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it("binds a new draft's empty version and reports a stale locked save as a retryable conflict", async () => {
    const original = client.rpc.getMockImplementation();
    client.rpc.mockImplementation(async (operation, args) => operation === "write_sensitive_content"
      ? { error: { code: "PT409", message: "private detail" } } : original(operation, args));
    const res = await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: ANSWERS, expectedDataVersion: null } });
    expect(res.code).toBe(409);
    expect(res.body).toEqual({ error: "sensitive-data-conflict" });
    expect(writes()[0].p_arguments).toMatchObject({ p_expected_data_version: null, p_changed: true });
  });

  // SEC-UG-FORM-DRAFT-RETRY-BASELINE-VERSION-CAS-20261027 (#6233): a
  // retry names the version it was built on; prepare's fresher read must not
  // replace it, or the locked compare would pass against the newer answers.
  it("passes the caller's baseline version to the locked compare, not the version prepare reads", async () => {
    const baseline = randomUUID();
    prepared.envelope = seal({ reason: "Saved elsewhere C" });
    await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: { reason: "Retry B" }, expectedDataVersion: baseline } });
    const [write] = writes();
    expect(write.p_arguments.p_expected_data_version).toBe(baseline);
    expect(write.p_arguments.p_expected_data_version).not.toBe(prepared.envelope.dataVersion);
  });
});

describe("sealed FMLA form reads", () => {
  const sealedRow = (answers, overrides = {}) => ({ id: formId, template_key: "fmla_self", organization_id: organization,
    answers: { sealed: true, filled: Object.keys(answers), dataVersion: randomUUID() }, encrypted_content: { answers: seal(answers) }, ...overrides });

  it("opens only rows the caller's own query returns, scoped to the caller's organization", async () => {
    rows = [sealedRow(ANSWERS)];
    const res = await call({ operation: "get_sealed_forms", args: { formIds: [formId] } });
    // The version comes from the same row read as the answers: the envelope's,
    // which the locked save compares, not the list query's marker (#6281).
    const envelopeVersion = rows[0].encrypted_content.answers.dataVersion;
    expect(envelopeVersion).not.toBe(rows[0].answers.dataVersion);
    expect(res.body.data).toEqual([{ id: formId, answers: ANSWERS, dataVersion: envelopeVersion }]);
    const chain = client.from.mock.results[0].value;
    expect(client.from).toHaveBeenCalledWith("member_forms");
    expect(chain.eq).toHaveBeenCalledWith("organization_id", organization);
    expect(chain.in).toHaveBeenCalledWith("id", [formId]);
  });

  it.each(["get_sealed_forms", "get_my_sealed_form_answers"].flatMap((operation) => [
    [operation, "stack fields", { ...ANSWERS, stack: "Chosen equipment stack", stacktrace: "Member-supplied field answer" }],
    [operation, "exact name/message/stack fields", { name: "Error", message: "Member-supplied answer", stack: "Chosen equipment stack" }],
    [operation, "name/message/stack fields and extras", { name: "Error", message: "Member-supplied answer", stack: "Chosen equipment stack", stacktrace: "Another answer", notes: "Original note" }],
  ]))("preserves %s %s through an autosave round trip", async (operation, _case, answers) => {
    rows = [sealedRow(answers, { user_id: caller })];
    prepared.envelope = rows[0].encrypted_content.answers;
    const read = await call({ operation, args: { formIds: [formId] } });
    expect(read.code).toBe(200);
    const restored = read.body.data[0];
    expect(restored.answers).toEqual(answers);
    const edited = { ...restored.answers, notes: "Autosaved edit" };
    const saved = await call({ operation: "save_sealed_form_draft", args: {
      templateKey: "fmla_self", formId, answers: edited, step: 2, expectedDataVersion: restored.dataVersion,
    } });
    expect(saved.code).toBe(200);
    const [write] = writes();
    expect(write.p_arguments).toMatchObject({ p_changed: true, p_expected_data_version: restored.dataVersion });
    expect(write.p_arguments.p_filled).toEqual(Object.keys(edited));
    const opened = decryptSensitive(write.p_envelopes.answers,
      { organization, record: formId, field: "answers", purpose: "member_forms" }, sensitiveKeyring());
    try { expect(JSON.parse(opened.toString("utf8"))).toEqual(edited); } finally { opened.fill(0); }
    rows[0].encrypted_content.answers = write.p_envelopes.answers;
    const reread = await call({ operation, args: { formIds: [formId] } });
    expect(reread.body.data[0]).toEqual({ id: formId, answers: edited, dataVersion: saved.body.data.dataVersion });
  });

  it("never returns legacy plaintext, ciphertext or another record's envelope", async () => {
    rows = [
      sealedRow(ANSWERS, { encrypted_content: { answers: seal(ANSWERS, randomUUID()) } }),
      { id: randomUUID(), template_key: "fmla_family", organization_id: organization, answers: { reason: "legacy plaintext" }, encrypted_content: {} },
    ];
    const res = await call({ operation: "get_sealed_forms", args: { formIds: rows.map((row) => row.id) } });
    expect(res.body.data.map((row) => row.contentError)).toEqual(["sensitive-content-unavailable", "sensitive-content-unavailable"]);
    expect(JSON.stringify(res.body)).not.toMatch(/legacy plaintext|wrappedKey|Synthetic/);
  });

  it.each([[[]], [Array.from({ length: 101 }, () => randomUUID())], [["not-a-uuid"]]])("refuses an invalid id list %#", async (formIds) => {
    expect((await call({ operation: "get_sealed_forms", args: { formIds } })).code).toBe(400);
  });
});

// REQ-UG-MEMBER-EXPORT-SEALED-FMLA-ANSWERS-20261022 (#5767).
describe("own sealed answers for the member data export", () => {
  const ownRow = (answers, overrides = {}) => {
    const envelope = seal(answers, overrides.id ?? formId);
    return { id: formId, user_id: caller, template_key: "fmla_self", organization_id: organization,
      answers: { sealed: true, filled: Object.keys(answers), dataVersion: envelope.dataVersion }, encrypted_content: { answers: envelope }, ...overrides };
  };

  it("opens only the verified caller's own sealed forms in the caller's organization", async () => {
    rows = [ownRow(ANSWERS)];
    const res = await call({ operation: "get_my_sealed_form_answers" });
    expect(res.code).toBe(200);
    expect(res.body.data).toEqual([{ id: formId, answers: ANSWERS, dataVersion: rows[0].encrypted_content.answers.dataVersion }]);
    expect(client.auth.getUser).toHaveBeenCalledWith("caller-token");
    const chain = client.from.mock.results[0].value;
    expect(client.from).toHaveBeenCalledWith("member_forms");
    expect(chain.eq).toHaveBeenCalledWith("organization_id", organization);
    expect(chain.eq).toHaveBeenCalledWith("user_id", caller);
    expect(chain.in).toHaveBeenCalledWith("template_key", [...SEALED_FORM_TEMPLATES]);
  });

  it("drops another member's or another organization's row even if RLS returned it", async () => {
    rows = [ownRow(ANSWERS, { id: randomUUID(), user_id: randomUUID() }), ownRow(ANSWERS, { id: randomUUID(), organization_id: randomUUID() })];
    const res = await call({ operation: "get_my_sealed_form_answers" });
    expect(res.body.data).toEqual([]);
  });

  it("reports an unopenable envelope and legacy plaintext as unavailable, never as content", async () => {
    rows = [
      ownRow(ANSWERS, { encrypted_content: { answers: seal(ANSWERS, randomUUID()) } }),
      { id: randomUUID(), user_id: caller, template_key: "fmla_family", organization_id: organization, answers: { reason: "legacy plaintext" }, encrypted_content: {} },
    ];
    const res = await call({ operation: "get_my_sealed_form_answers" });
    expect(res.body.data.map((row) => [row.answers, row.contentError])).toEqual([[{}, "sensitive-content-unavailable"], [{}, "sensitive-content-unavailable"]]);
    expect(JSON.stringify(res.body)).not.toMatch(/legacy plaintext|wrappedKey|Synthetic/);
  });

  it("refuses an unverified caller and an export past the bound, and logs no answer", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    client.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { message: "invalid JWT" } });
    expect((await call({ operation: "get_my_sealed_form_answers" })).code).toBe(401);
    rows = Array.from({ length: EXPORT_SEALED_FORM_LIMIT + 1 }, () => ownRow(ANSWERS, { id: randomUUID() }));
    const over = await call({ operation: "get_my_sealed_form_answers" });
    expect(over.code).toBe(503);
    expect(JSON.stringify(over.body)).not.toMatch(/Synthetic/);
    for (const spy of [log, info]) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Synthetic/);
  });
});

describe("sealed answer helpers", () => {
  it.each(["not JSON", "[]", "null", '{"invalid key":"private answer"}'])("refuses authenticated but malformed answer payloads (%s)", (plaintext) => {
    const envelope = encryptSensitive(Buffer.from(plaintext),
      { organization, record: formId, field: "answers", purpose: "member_forms" }, sensitiveKeyring());
    expect(() => revealFormAnswers({ id: formId, template_key: "fmla_self", organization_id: organization,
      answers: { sealed: true }, encrypted_content: { answers: envelope } }, sensitiveKeyring()))
      .toThrow("sensitive-data-row-unavailable");
  });

  // BUG-UG-SEALED-FORM-ANSWER-COUNT-TEMPLATE-COMPATIBILITY-20261028
  // (#6320): templates allow 12 steps of 30 fields, so 360 answers are valid;
  // the payload-size bound stays.
  const answersOf = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`field_${index}`, "x"]));
  it("accepts up to the template contract's 360 answers and refuses more or an oversized payload", () => {
    expect(MAX_FORM_ANSWER_KEYS).toBe(360);
    expect(filledFormKeys(answersOf(120))).toHaveLength(120);
    expect(filledFormKeys(answersOf(360))).toHaveLength(360);
    expect(() => filledFormKeys(answersOf(361))).toThrow("sensitive-data-invalid-input");
    expect(() => filledFormKeys({ reason: "x".repeat(20000) })).toThrow("sensitive-data-invalid-input");
  });
  it("saves an fmla_self form with four 30-field steps answered", async () => {
    const res = await call({ operation: "save_sealed_form_draft", args: { templateKey: "fmla_self", answers: answersOf(120), step: 3, expectedDataVersion: null } });
    expect(res.code).toBe(200);
    expect(writes()[0].p_arguments.p_filled).toHaveLength(120);
  });

  it("counts answered keys by submit_form's rule", () => {
    expect(filledFormKeys({ a: "x", b: " ", c: [], d: ["1"], e: null, f: 0 })).toEqual(["a", "d", "f"]);
  });
  it("compares answers without regard to key order", () => {
    expect(sameFormAnswers({ a: "1", b: ["x"] }, { b: ["x"], a: "1" })).toBe(true);
    expect(sameFormAnswers({ a: "1" }, { a: "2" })).toBe(false);
  });
  it("treats empty and seed-only FMLA rows as having no answers, and refuses other templates", () => {
    const ring = sensitiveKeyring();
    expect(revealFormAnswers({ id: formId, template_key: "fmla_self", answers: {} }, ring)).toEqual({});
    expect(revealFormAnswers({ id: formId, template_key: "fmla_self", answers: { seedSequence: 3 } }, ring)).toEqual({});
    expect(() => revealFormAnswers({ id: formId, template_key: "grievance", answers: {} }, ring)).toThrow("sensitive-data-row-unavailable");
  });
});
