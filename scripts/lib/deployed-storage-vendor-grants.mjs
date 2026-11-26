import { createHash } from "node:crypto";

// Reviewed vendor-only correction, independent of application migration count.
// The retained application baseline and its historical evidence stay intact.
export const STORAGE_VENDOR_SOURCE_SHA256 = "71d74c9f7e9ebbd4fdcdc89fafa816e3f2ab2a2e9058d916243055b498edcc92";
export const STORAGE_VENDOR_EXPORT_SHA256 = "e240d64fc23bce94426eeb878cf7f96f6e5a6aa5e2440160b78c0bce764aeb6e";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// The historical receipt binds the input; this separate reviewed pin binds
// the exact corrected output. Followed sources retain their own Git identity.
export function assertReviewedStorageVendorExport(source, output) {
  if (digest(source) === STORAGE_VENDOR_SOURCE_SHA256 && digest(output) !== STORAGE_VENDOR_EXPORT_SHA256) {
    throw new Error("Storage vendor correction exported bytes differ from the reviewed digest");
  }
}

export const STORAGE_VENDOR_GRANT_NOTE = "Supabase Storage migration 0073-revoke-grants-to-unused-operations (upstream https://github.com/supabase/storage/pull/1395, merged September 16, 2026) applied to production October 14, 2026 at 12:22:44 AM ET. It revoked TRUNCATE, REFERENCES, TRIGGER and, on PostgreSQL 17, MAINTAIN from anon/authenticated on storage.buckets, storage.objects and storage.buckets_analytics, leaving DELETE,INSERT,SELECT,UPDATE. Last deployed drift pass: run 38507552176 at 12:20:55 AM ET; first failure: run 38525044775 at 3:34:01 AM ET. SAMPLE remains on Storage migration 72 with the old full grants. This is a reviewed platform expectation correction; no application migration or hosted grant change is authorized.";

const TABLES = ["storage.buckets", "storage.objects", "storage.buckets_analytics"];
const ROLES = ["anon", "authenticated"];
const OLD = "DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE";
const CURRENT = "DELETE,INSERT,SELECT,UPDATE";
const normalized = (privileges) => privileges.split(",").sort().join(",");

export function applyReviewedStorageVendorGrants(bytes) {
  let text = bytes.toString("utf8");
  const contract = JSON.parse(text);
  const vendor = contract.knownGaps.vendorSchemaClientGrants;
  for (const table of TABLES) {
    for (const role of ROLES) {
      const entries = vendor.entries.filter((entry) => entry.table === table && entry.role === role);
      if (entries.length !== 1) throw new Error(`Storage vendor correction needs exactly one ${table}/${role} entry`);
      const entry = entries[0];
      if (entry.owner !== "supabase_storage_admin" || entry.rls !== true
          || ![OLD, CURRENT].includes(normalized(entry.privileges))) {
        throw new Error(`Storage vendor correction refuses unexpected source state for ${table}/${role}`);
      }
      // Preserve every byte outside these six privilege strings and the note.
      const pattern = new RegExp(`("table":\\s*${JSON.stringify(table).replaceAll(".", "\\.")},\\s*"role":\\s*${JSON.stringify(role)},\\s*"privileges":\\s*)"[^"]*"`, "g");
      if ([...text.matchAll(pattern)].length !== 1) throw new Error(`Storage vendor correction refuses ambiguous text for ${table}/${role}`);
      text = text.replace(pattern, `$1${JSON.stringify(CURRENT)}`);
    }
  }
  if (!vendor.why.includes(STORAGE_VENDOR_GRANT_NOTE)) {
    const notePattern = /("why":\s*)("(?:[^"\\]|\\.)*")/g;
    const notes = [...text.matchAll(notePattern)].filter(match => JSON.parse(match[2]) === vendor.why);
    if (notes.length !== 1) throw new Error("Storage vendor correction needs one explanation");
    const [note] = notes;
    const amended = note[1] + note[2].slice(0, -1) + JSON.stringify(` ${STORAGE_VENDOR_GRANT_NOTE}`).slice(1);
    text = text.slice(0, note.index) + amended + text.slice(note.index + note[0].length);
  }
  return Buffer.from(text);
}
