import { randomUUID } from "node:crypto";
import { encryptSensitive } from "./sensitiveDataCrypto.js";
import { revealRow, trustedSensitiveWrite } from "./sensitiveContent.js";

export async function scanSensitivePatterns(client, service, chapter, organization, ring) {
  const reports = [];
  let after = null;
  for (;;) {
    const page = await client.rpc("sensitive_pattern_source", { p_chapter_id: chapter, p_after: after });
    if (page.error || !Array.isArray(page.data)) throw new Error("sensitive-pattern-scan-refused");
    reports.push(...page.data);
    if (reports.length > 5000) throw new Error("sensitive-pattern-scan-capacity");
    if (page.data.length < 200) break;
    after = page.data.at(-1).id;
  }
  const groups = new Map();
  for (const report of reports) {
    const label = revealRow("casework_retaliation_reports", report, ring).management_person.trim().toLowerCase();
    const group = groups.get(label) || [];
    group.push(report.id); groups.set(label, group);
  }
  const envelopes = { groups: [] };
  for (const [label, ids] of groups) {
    if (ids.length < 2) continue;
    const id = randomUUID();
    envelopes.groups.push({ id, reports: ids, label: encryptSensitive(Buffer.from(label), {
      organization, record: id, field: "subject_label", purpose: "casework_retaliation_patterns",
    }, ring) });
  }
  // SQL compares this exact ordered generation set again under row locks;
  // a withdrawal or edit during decryption invalidates the complete result.
  const prepared = { p_operation: "casework_scan_retaliation_patterns", p_arguments: {
    p_chapter_id: chapter, sources: reports.map((r) => ({ id: r.id, version: r.encrypted_content.management_person.dataVersion })),
  }, p_envelopes: envelopes };
  const result = await trustedSensitiveWrite(client, service, prepared);
  if (result.error) throw new Error("sensitive-pattern-scan-refused");
  return result.data;
}
