import { verifyMobileAppLinkArtifacts } from "./lib/mobile-app-link-policy.mjs";

const dist = process.argv.includes("--dist");
const policy = verifyMobileAppLinkArtifacts({ root: dist ? "dist" : "public" });
console.log(`Verified ${policy.enabled ? "enabled" : "fail-closed"} mobile app-link policy${dist ? " in dist" : ""}.`);
