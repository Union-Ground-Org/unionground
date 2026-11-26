import { loadEnv } from "vite";

export function loadViteRuntimeEnv(mode, root, ambientEnv = process.env) {
  return {
    ...loadEnv(mode, root, ""),
    ...ambientEnv,
  };
}
