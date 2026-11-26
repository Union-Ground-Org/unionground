import Module, { createRequire } from 'node:module';

// TEST-UG-PHONE-TESTS-EXECUTE-SCREENS-ON-ONE-SHARED-STAND-IN-20261111 (#8319):
// some screens load a module with a plain require at first use (Metro bundles
// it the same way). vi.mock does not reach a plain require, so a screen test
// answers it here, by request text. Returns the undo.
type ResolveFilename = (this: unknown, request: string, ...rest: unknown[]) => string;

export function stubPlainRequire(stubs: Record<string, unknown>): () => void {
  const original = Reflect.get(Module, '_resolveFilename') as ResolveFilename;
  const cache = createRequire(import.meta.url).cache;
  const idFor = (request: string) => `/plain-require-stub/${request}`;
  for (const [request, exports] of Object.entries(stubs)) {
    cache[idFor(request)] = { id: idFor(request), filename: idFor(request), loaded: true, exports } as NodeJS.Module;
  }
  const resolve: ResolveFilename = function resolve(request, ...rest) {
    return Object.hasOwn(stubs, request) ? idFor(request) : original.call(this, request, ...rest);
  };
  Reflect.set(Module, '_resolveFilename', resolve);
  return () => {
    Reflect.set(Module, '_resolveFilename', original);
    for (const request of Object.keys(stubs)) delete cache[idFor(request)];
  };
}
