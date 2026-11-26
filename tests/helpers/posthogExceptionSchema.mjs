// The parts of PostHog's exception processor (cymbal) schema a `$exception`
// event must satisfy before it can become an error-tracking issue, transcribed
// from the serde types at PostHog/posthog d0f709c0489b6fbbf2e0efa5774741e46b4ed9a2
// (rust/cymbal/src): modes/processing/types/mod.rs RawExceptionProperties,
// core/types/exception.rs Exception, core/types/stacktrace.rs Stacktrace,
// core/types/mod.rs Mechanism, core/types/frames/mod.rs RawFrame (tagged by
// "platform"), core/types/langs/{js,node,hermes,mod}.rs RawJSFrame,
// RawNodeFrame, RawHermesFrame and CommonFrameMetadata. Serde ignores unknown
// fields there, so only required fields and declared types are checked. A
// failure here is what PostHog records as
// error_tracking_exception_processing_errors (#6826: "missing field function").
// Returns the violations; an empty list means cymbal deserializes the event.
const U32_MAX = 2 ** 32 - 1;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isU32 = (value) => Number.isInteger(value) && value >= 0 && value <= U32_MAX;
const isU64 = (value) => Number.isSafeInteger(value) && value >= 0;
const isI32 = (value) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31;
const isString = (value) => typeof value === "string";
const isBool = (value) => typeof value === "boolean";
const isStringList = (value) => Array.isArray(value) && value.every(isString);

// Field rules: required fields must be present and typed; optional fields may
// be absent or null (serde Option) unless marked notNull (serde default).
const COMMON = { in_app: { type: isBool, notNull: true }, synthetic: { type: isBool, notNull: true } };
const FRAME_SCHEMAS = {
  // RawJSFrame; also the legacy "javascript" tag. lineno and colno are one
  // flattened Option<FrameLocation>: both u32 or the location is dropped.
  "web:javascript": { function: { type: isString, required: true }, filename: { type: isString }, lineno: { type: isU32 }, colno: { type: isU32 }, chunk_id: { type: isString }, chunkId: { type: isString }, ...COMMON },
  "node:javascript": {
    filename: { type: isString, required: true }, function: { type: isString, required: true }, lineno: { type: isU32 }, colno: { type: isU32 }, module: { type: isString },
    context_line: { type: isString }, pre_context: { type: isStringList, notNull: true }, post_context: { type: isStringList, notNull: true }, chunk_id: { type: isString }, chunkId: { type: isString }, ...COMMON,
  },
  hermes: { filename: { type: isString, required: true }, function: { type: isString, required: true }, colno: { type: isU32 }, chunkId: { type: isString }, chunk_id: { type: isString }, ...COMMON },
};
FRAME_SCHEMAS.javascript = FRAME_SCHEMAS["web:javascript"];
const MECHANISM = { handled: { type: isBool }, type: { type: isString }, source: { type: isString }, synthetic: { type: isBool }, exception_id: { type: isU64 }, parent_id: { type: isU64 } };
const EXCEPTION = { type: { type: isString, required: true }, value: { type: isString, notNull: true }, id: { type: isString }, module: { type: isString }, thread_id: { type: isI32 } };

export const POSTHOG_SCHEMA_SOURCE = "PostHog/posthog@d0f709c0489b6fbbf2e0efa5774741e46b4ed9a2 rust/cymbal";
export const POSTHOG_JS_FRAME_PLATFORMS = Object.freeze(Object.keys(FRAME_SCHEMAS));

function checkFields(value, rules, path, errors) {
  for (const [name, rule] of Object.entries(rules)) {
    const present = Object.prototype.hasOwnProperty.call(value, name) && value[name] !== undefined;
    if (!present) {
      if (rule.required) errors.push(`${path}: missing field ${name}`);
    } else if (value[name] === null) {
      if (rule.required || rule.notNull) errors.push(`${path}.${name}: null is not allowed`);
    } else if (!rule.type(value[name])) {
      errors.push(`${path}.${name}: invalid type ${JSON.stringify(value[name])}`);
    }
  }
}

export function posthogFrameSchemaErrors(frame, path = "frame") {
  if (!isObject(frame)) return [`${path}: not an object`];
  if (!isString(frame.platform)) return [`${path}: missing field platform`];
  const rules = FRAME_SCHEMAS[frame.platform];
  if (!rules) return [`${path}.platform: ${frame.platform} is not a JavaScript frame schema this contract covers`];
  const errors = [];
  checkFields(frame, rules, path, errors);
  return errors;
}

export function posthogExceptionSchemaErrors(event) {
  const errors = [];
  if (!isObject(event) || event.event !== "$exception") return ["event: not a $exception event"];
  const properties = event.properties;
  if (!isObject(properties)) return ["properties: not an object"];
  checkFields(properties, { $exception_fingerprint: { type: isString }, $exception_handled: { type: isBool }, $issue_name: { type: isString }, $issue_description: { type: isString } }, "properties", errors);
  const list = properties.$exception_list;
  if (!Array.isArray(list)) return [...errors, "properties: missing field $exception_list"];
  if (!list.length) errors.push("properties.$exception_list: must not be empty");
  list.forEach((exception, index) => {
    const path = `$exception_list[${index}]`;
    if (!isObject(exception)) return errors.push(`${path}: not an object`);
    checkFields(exception, EXCEPTION, path, errors);
    if (exception.mechanism != null) {
      if (isObject(exception.mechanism)) checkFields(exception.mechanism, MECHANISM, `${path}.mechanism`, errors);
      else errors.push(`${path}.mechanism: not an object`);
    }
    const stack = exception.stacktrace;
    if (stack == null) return undefined;
    if (!isObject(stack) || (stack.type !== "raw" && stack.type !== "resolved")) return errors.push(`${path}.stacktrace: type must be raw or resolved`);
    if (!Array.isArray(stack.frames)) return errors.push(`${path}.stacktrace: missing field frames`);
    if (stack.type === "raw") stack.frames.forEach((frame, at) => errors.push(...posthogFrameSchemaErrors(frame, `${path}.stacktrace.frames[${at}]`)));
    return undefined;
  });
  return errors;
}
