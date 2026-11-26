// Semgrep fixture: the safe counterpart must produce no finding.
import { timingSafeEqual } from "node:crypto";

export function runRule(providedSignature, expectedSignature) {
  return timingSafeEqual(
    Buffer.from(providedSignature, "utf8"),
    Buffer.from(expectedSignature, "utf8"),
  );
}
