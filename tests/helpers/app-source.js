import { readFileSync } from "node:fs";

// Source-contract tests cover the whole application, including its lazy
// member shell. Keep reading real source after the entry-router split.
export function readAppSource() {
  return ["MemberShellShared.jsx", "App.jsx", "AppRouter.jsx"]
    .map((file) => readFileSync(`src/${file}`, "utf8"))
    .join("\n\n");
}

export function readMemberSource() {
  return readFileSync("src/App.jsx", "utf8");
}
