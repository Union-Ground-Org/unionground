import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { JsonReporter } from "vitest/node";

// Vitest's JSON reporter includes file errors and assertion errors, but omits
// errors on nested describe suites (notably a failed afterAll with green tests).
export function describeHookErrors(task, ancestors = []) {
  const names = [...ancestors, task.name].filter(Boolean);
  const errors = (task.result?.errors ?? []).map(error => ({
    suite: names.join(" > "),
    hook: Object.entries(task.result?.hooks ?? {}).filter(([, state]) => state === "fail" || state === "run").map(([name]) => name).join(", ") || "suite hook",
    message: error.stack || error.message || String(error),
  }));
  return [...errors, ...(task.tasks ?? []).filter(child => child.type === "suite")
    .flatMap(child => describeHookErrors(child, names))];
}

export default class RequiredDbProofJsonReporter extends JsonReporter {
  constructor() { super({}); }
  async onTestRunEnd(modules) {
    await super.onTestRunEnd(modules);
    const output = this.ctx.config.outputFile;
    const path = resolve(this.ctx.config.root, typeof output === "string" ? output : output.json);
    const report = JSON.parse(readFileSync(path, "utf8"));
    for (const module of modules) {
      const file = report.testResults.find(result => result.name === module.task.filepath);
      if (file) file.suiteErrors = (module.task.tasks ?? []).filter(task => task.type === "suite")
        .flatMap(task => describeHookErrors(task));
    }
    writeFileSync(path, JSON.stringify(report));
  }
}
