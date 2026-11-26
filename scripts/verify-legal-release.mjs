import { pathToFileURL } from "node:url";
import { verifyWorkingTree } from "./lib/legal-release.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyWorkingTree(process.cwd());
  console.log("legal release surfaces match the stamp");
}
