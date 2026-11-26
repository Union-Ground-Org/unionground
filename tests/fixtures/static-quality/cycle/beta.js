import { alpha } from "./alpha.js";

export function beta(value) {
  return value === 0 ? 0 : alpha(value - 1);
}
