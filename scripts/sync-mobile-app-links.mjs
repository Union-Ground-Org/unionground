import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ASSOCIATION_ROUTES, expectedAssociationDocuments, validateMobileAppLinkPolicy } from "./lib/mobile-app-link-policy.mjs";

const policy = validateMobileAppLinkPolicy(JSON.parse(
  readFileSync(resolve(process.cwd(), "config/mobile-app-links.json"), "utf8"),
));
const documents = expectedAssociationDocuments(policy);
// Static files win over Vercel rewrites, so the well-known paths stay rewrite-only.
for (const { path } of ASSOCIATION_ROUTES) rmSync(resolve(process.cwd(), `public${path}`), { force: true });
// Union Ground publishes no credential association.
rmSync(resolve(process.cwd(), "public/native-credentials"), { recursive: true, force: true });
const directory = resolve(process.cwd(), "public/native-links");
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, "apple-app-site-association.json"), `${JSON.stringify(documents.apple, null, 2)}\n`, "utf8");
writeFileSync(resolve(directory, "assetlinks.json"), `${JSON.stringify(documents.android, null, 2)}\n`, "utf8");
console.log(`Synchronized ${policy.enabled ? "enabled" : "fail-closed"} mobile association documents.`);
