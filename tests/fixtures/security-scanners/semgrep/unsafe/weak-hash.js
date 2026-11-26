// Semgrep fixture: unionground-weak-hash-for-security must report this file.
import { createHash } from "node:crypto";

export function fingerprint(value) {
  return createHash("md5").update(value).digest("hex");
}
