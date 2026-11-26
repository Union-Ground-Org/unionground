// The web build targets Safari 14, Chrome 87, Firefox 78 and Edge 88, which
// predate Object.hasOwn, and the bootstrap (loadLanguage, t) calls it before
// React or its ErrorBoundary exist (BUG-UG-BOOTSTRAP-MISSING-HASOWN-
// COMPATIBILITY-20261020). src/main.jsx imports this module first, so a
// browser without the static method gets this one before any other
// application module runs. A native implementation is never replaced.
const hasOwnProperty = Object.prototype.hasOwnProperty;

/**
 * Object.hasOwn semantics: nullish targets are refused like the native method,
 * primitives are boxed, only own (not inherited) keys count, and null-prototype
 * objects work because the check never relies on the target's prototype.
 * @param {unknown} target
 * @param {PropertyKey} key
 * @returns {boolean}
 */
function hasOwn(target, key) {
  if (target === null || target === undefined) throw new TypeError("Cannot convert undefined or null to object");
  return hasOwnProperty.call(target, key);
}

export const objectHasOwnFallback = hasOwn;

/**
 * @param {ObjectConstructor} [target]
 * @returns {boolean} true when the fallback was installed
 */
export function installObjectHasOwn(target = Object) {
  if (typeof target.hasOwn === "function") return false;
  Object.defineProperty(target, "hasOwn", { value: hasOwn, writable: true, configurable: true, enumerable: false });
  return true;
}

installObjectHasOwn();
