import { beta } from "./beta.js";

export function alpha(value) {
  return value === 0 ? 0 : beta(value - 1);
}
