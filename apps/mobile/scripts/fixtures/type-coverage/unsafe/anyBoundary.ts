// An untyped API boundary: everything downstream of `load` is `any`.
export function load(): any {
  return JSON.parse('{"items":[]}');
}

export const payload = load();
export const first = payload.items[0];
export const label = first.name.trim();
