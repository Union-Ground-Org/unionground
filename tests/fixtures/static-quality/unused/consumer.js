import { referenced } from "./library.js";

export function total(values) {
  return values.reduce((sum, value) => sum + referenced(value), 0);
}
