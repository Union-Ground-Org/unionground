export function referenced(value) {
  return value * 2;
}

// Nothing imports this one, which is what the ratchet must notice.
export function orphaned(value) {
  return value * 3;
}
