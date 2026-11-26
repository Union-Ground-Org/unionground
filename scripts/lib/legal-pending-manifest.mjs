import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Generate data at the statically imported directory boundary. No handwritten
// index changes are needed when declaration-only PRs add or remove JSON files.
/** @param {string} [repositoryRoot] */
export function legalPendingManifestPlugin(repositoryRoot) {
  let manifest;
  let directory;
  let stopWatching;
  return {
    name: "legal-pending-manifest",
    enforce: /** @type {"pre"} */ ("pre"),
    configResolved(config) {
      manifest = resolve(repositoryRoot ?? config.root, "content/legal/pending/directory.js");
      directory = dirname(manifest);
    },
    load(id) {
      if (id.split("?", 1)[0] !== manifest) return;
      const declarations = {};
      for (const name of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
        const path = resolve(directory, name);
        if (!lstatSync(path).isFile()) throw new Error(`pending legal declaration is not a regular file: ${name}`);
        declarations[name] = readFileSync(path, "utf8");
      }
      // Preserve raw bytes, including invalid JSON: the publication gate
      // rejects unreadable declarations without making compilation fail.
      return `export const legalPendingDirectoryPresent = true;\nexport const legalPendingDeclarations = Object.freeze(${JSON.stringify(declarations)});\n`;
    },
    configureServer(server) {
      const changed = (_event, path) => {
        if (dirname(path) !== directory || !path.endsWith(".json")) return;
        const module = server.moduleGraph.getModuleById(manifest);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.add(directory);
      server.watcher.on("all", changed);
      stopWatching = () => server.watcher.off("all", changed);
    },
    closeBundle() { stopWatching?.(); },
  };
}
