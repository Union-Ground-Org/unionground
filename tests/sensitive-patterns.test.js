// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { scanSensitivePatterns } from "../api/_lib/sensitivePatterns.js";
import { encryptSensitive, decryptSensitive, sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";

function fixture() {
  const organization = randomUUID(), actor = randomUUID(), ticket = randomUUID();
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  const report = (label) => {
    const id = randomUUID();
    return { id, organization_id: organization, management_person: "[encrypted]", encrypted_content: {
      management_person: encryptSensitive(Buffer.from(label), { organization, record: id, field: "management_person", purpose: "casework_retaliation_reports" }, ring),
    } };
  };
  const rows = [report("Synthetic Supervisor"), report(" synthetic supervisor "), report("Different synthetic supervisor")];
  const source = vi.fn(async () => ({ data: rows }));
  const writer = vi.fn(async () => ({ data: 1 }));
  const client = { auth: { getUser: async () => ({ data: { user: { id: actor } } }) }, rpc: vi.fn((name,args) => name === "sensitive_pattern_source" ? source(args) : writer(args)) };
  const service = { rpc: vi.fn(async () => ({ data: ticket })) };
  return { organization,actor,ticket,ring,rows,source,writer,client,service };
}
it("groups authorized decrypted names and stages only encrypted labels with exact source generations", async () => {
  const f = fixture();
  expect(await scanSensitivePatterns(f.client,f.service,"synthetic-chapter",f.organization,f.ring)).toBe(1);
  expect(f.source).toHaveBeenCalledWith({ p_chapter_id:"synthetic-chapter",p_after:null });
  const [name, staged] = f.service.rpc.mock.calls[0];
  expect(name).toBe("stage_sensitive_write");
  expect(staged.p_actor).toBe(f.actor);
  expect(staged.p_arguments.sources).toEqual(f.rows.map((r) => ({ id:r.id,version:r.encrypted_content.management_person.dataVersion })));
  expect(staged.p_envelopes.groups).toHaveLength(1);
  const group = staged.p_envelopes.groups[0];
  expect(group.reports).toEqual(f.rows.slice(0,2).map((r) => r.id));
  expect(decryptSensitive(group.label,{ organization:f.organization,record:group.id,field:"subject_label",purpose:"casework_retaliation_patterns" },f.ring).toString()).toBe("synthetic supervisor");
  expect(JSON.stringify(staged)).not.toContain("supervisor");
  expect(f.writer).toHaveBeenCalledWith(expect.objectContaining({p_ticket:f.ticket}));
});
it("refuses denied or malformed source pages before staging any derivative", async () => {
  for (const result of [{error:{code:"42501"}},{data:null}]) {
    const f=fixture(); f.source.mockResolvedValue(result);
    await expect(scanSensitivePatterns(f.client,f.service,"synthetic-chapter",f.organization,f.ring)).rejects.toThrow("scan-refused");
    expect(f.service.rpc).not.toHaveBeenCalled();
  }
});
it("fails closed on corrupt reports or a changed SQL source set without returning source content", async () => {
  const f=fixture(); f.rows[0].encrypted_content.management_person.payload.tag="invalid";
  await expect(scanSensitivePatterns(f.client,f.service,"synthetic-chapter",f.organization,f.ring)).rejects.toThrow("sensitive-data-key-or-ciphertext-unavailable");
  expect(f.service.rpc).not.toHaveBeenCalled();
  const fresh=fixture(); fresh.writer.mockResolvedValue({error:{code:"40001"}});
  await expect(scanSensitivePatterns(fresh.client,fresh.service,"synthetic-chapter",fresh.organization,fresh.ring)).rejects.toThrow("scan-refused");
});
it("advances its cursor and refuses an oversized chapter before decrypting or staging it", async () => {
  const f=fixture(), page=Array.from({length:200},()=>({id:randomUUID()}));
  f.source.mockResolvedValue({data:page});
  await expect(scanSensitivePatterns(f.client,f.service,"synthetic-chapter",f.organization,f.ring)).rejects.toThrow("scan-capacity");
  expect(f.source).toHaveBeenCalledTimes(26);
  expect(f.source.mock.calls[1][0].p_after).toBe(page.at(-1).id);
  expect(f.service.rpc).not.toHaveBeenCalled();
});
