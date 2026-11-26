const CANONICAL_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "tablet", width: 768, height: 1024 }),
  Object.freeze({ name: "desktop", width: 1280, height: 900 }),
  Object.freeze({ name: "wide", width: 1440, height: 900 }),
]);

const UNIONGROUND_WORK_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "tablet-768", width: 768, height: 1024 }),
  Object.freeze({ name: "tablet-edge-1023", width: 1023, height: 900 }),
  Object.freeze({ name: "desktop-1024", width: 1024, height: 900 }),
  Object.freeze({ name: "desktop-1280", width: 1280, height: 900 }),
  Object.freeze({ name: "desktop-edge-1359", width: 1359, height: 900 }),
  Object.freeze({ name: "paired-1360", width: 1360, height: 900 }),
  Object.freeze({ name: "paired-1440", width: 1440, height: 900 }),
  Object.freeze({ name: "wide-1920", width: 1920, height: 1080 }),
]);

export function resolveVisualAuditViewports(rawPreset = process.env.VISUAL_AUDIT_MATRIX) {
  if (rawPreset == null || rawPreset === "" || rawPreset === "canonical") return CANONICAL_VIEWPORTS;
  if (rawPreset === "unionground-work") return UNIONGROUND_WORK_VIEWPORTS;
  throw new Error(`VISUAL_AUDIT_MATRIX is unknown: ${rawPreset}`);
}
