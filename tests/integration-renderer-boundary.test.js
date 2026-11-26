// @vitest-environment node
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const renderers = ["IntegrationControlPlane", "FireworksConnector", "ScimSetup"]
  .map((name) => resolve(`src/features/integrations/${name}.jsx`));

// Follow real static import/re-export edges, including barrels. A named data
// import must not make route-only renderers members of the preload closure.
function staticClosure(entry) {
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const ast = parse(readFileSync(file, "utf8"), { sourceType: "module", plugins: ["jsx"] });
    for (const node of ast.program.body) {
      if (!["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
        || !node.source?.value.startsWith(".")) continue;
      const path = resolve(dirname(file), node.source.value);
      const target = [path, `${path}.js`, `${path}.jsx`, `${path}/index.js`]
        .find((candidate) => /\.[jt]sx?$/.test(candidate) && existsSync(candidate));
      if (target) visit(target);
    }
  }
  visit(resolve(entry));
  return seen;
}

describe("integration renderer loading boundary", () => {
  it.each([
    "src/main.jsx", "src/App.jsx", "src/lib/mi1FeatureWiring.js",
    "src/views/OperationsHealthView.jsx", "src/views/AutomationControlRoomView.jsx",
  ])("keeps the renderer cluster outside cold/shared %s", (entry) => {
    const loaded = staticClosure(entry);
    for (const renderer of renderers) expect(loaded.has(renderer), renderer).toBe(false);
    if (entry !== "src/main.jsx") {
      expect(loaded.has(resolve("src/features/integrations/catalog.js"))).toBe(true);
      expect(loaded.has(resolve("src/features/integrations/controlPlane.js"))).toBe(true);
    }
  });

  it("excludes the unshipped SSO renderer from the Integrations view", () => {
    expect(staticClosure("src/views/IntegrationsView.jsx").has(resolve("src/features/integrations/SsoSetup.jsx"))).toBe(false);
  });

  it("loads every renderer with the existing Integrations view boundary", () => {
    const loaded = staticClosure("src/views/IntegrationsView.jsx");
    for (const renderer of renderers) expect(loaded.has(renderer), renderer).toBe(true);
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toMatch(/integrations: \(\) => import\("\.\/views\/IntegrationsView\.jsx"\)/);
  });
});
