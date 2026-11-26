// Explicit unit-test data injection only. Shipped builds cannot load or prime
// the retired shared-demo dataset. Pure template cloning remains shared.
let cache = null;

// Registry labels have lazy Spanish accessors. JSON/structuredClone resolve
// those accessors too early on an English boot. Copy their descriptors while
// independently copying editable values, so later language loads still apply.
function cloneTemplateValue(value) {
  if (Array.isArray(value)) return value.map(cloneTemplateValue);
  if (value === null || typeof value !== "object") return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (Object.hasOwn(descriptor, "value")) descriptor.value = cloneTemplateValue(descriptor.value);
  }
  return Object.defineProperties({}, descriptors);
}

export function cloneDemoFormTemplates(rows) {
  return rows.map(cloneTemplateValue);
}

// Synchronous read of whatever has already been loaded. null means "not yet".
export function demoData() {
  return cache;
}

export async function loadDemoData() {
  if (import.meta.env.MODE === 'test' && cache) return cache;
  throw new Error('The shared demo has been retired.');
}

// Test/preview harnesses that need the fixtures on the first render prime the
// cache once at setup. Nothing in the shipped app calls this.
export function primeDemoData(fixtures) {
  if (import.meta.env.MODE !== "test") throw new Error("Test fixtures only");
  cache = fixtures;
}
