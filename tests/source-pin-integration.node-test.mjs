import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = path => pathToFileURL(join(repository, path)).href;

// Actual generators, readers, type checker and historical ratchet, in separate
// processes so cwd and ESM caches cannot make a stale result appear current.
const imports = `
  import assert from 'node:assert/strict';
  import {readPins, writePins, assertPins} from ${JSON.stringify(moduleUrl("scripts/lib/source-pins.mjs"))};
  import {collectTelemetrySources, readTelemetrySources, writeTelemetrySources, TELEMETRY_PINS} from ${JSON.stringify(moduleUrl("scripts/lib/telemetry-disclosure-sources.mjs"))};
  import {legalCataloguePins, LEGAL_PINS} from ${JSON.stringify(moduleUrl("scripts/legal-catalogue-pins.mjs"))};
  import {loadCoveragePins, appendCoveragePin} from ${JSON.stringify(moduleUrl("scripts/lib/type-coverage-pins.mjs"))};
  import {baselineHistoryFailures, readBaselineHistory} from ${JSON.stringify(moduleUrl("scripts/type-coverage-history.mjs"))};
  const {measure, evaluate} = await import(new URL('apps/mobile/scripts/type-coverage-ratchet.mjs', 'file://' + process.cwd() + '/'));
  const baselinePath = 'apps/mobile/type-coverage-baseline.json';
  const catalogues = {en: (await import(new URL('src/lib/i18n.js', 'file://' + process.cwd() + '/'))).catalogue,
    es: (await import(new URL('src/lib/i18n/es.js', 'file://' + process.cwd() + '/'))).catalogue};
`;
const validate = `
  assert.deepEqual(collectTelemetrySources(), readTelemetrySources());
  assertPins(legalCataloguePins(catalogues), readPins(LEGAL_PINS), 'legal');
  const baseline = loadCoveragePins(baselinePath);
  assert.deepEqual(baselineHistoryFailures(baseline,readBaselineHistory({repositoryRoot:process.cwd(),env:{}})),[]);
  assert.deepEqual(evaluate(measure({projectRoot:process.cwd()+'/apps/mobile', roots:['src']}),baseline),[]);
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pin-integration-"));
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), {recursive:true}); writeFileSync(join(root,path),text); };
  const git = (...args) => execFileSync("git", args, {cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const node = code => execFileSync(process.execPath,["--input-type=module","-e",imports+code],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"],maxBuffer:2*1024*1024});
  put("package.json",'{"type":"module"}');
  put(".gitignore","node_modules\n");
  symlinkSync(join(repository,"node_modules"),join(root,"node_modules"));
  put("src/lib/i18n.js",'export const catalogue = {\n"legal.a":"A",\n\n\n\n\n\n\n"legal.b":"B"\n};');
  put("src/lib/i18n/es.js",'export const catalogue = {"legal.a":"Uno","legal.b":"Dos"};');
  put("src/a.js",'localStorage.setItem("sg-a", "old");');
  put("src/b.js",'localStorage.setItem("sg-b", "old");');
  put("src/data/telemetryDisclosure.json",JSON.stringify({storage:[{sources:["src/a.js","src/b.js"]}],cookies:[]}));
  for (const path of ["src/lib/observability.js","src/lib/observabilityPrivacy.js","src/lib/sentryPrivacy.js",
    "api/_lib/observability.js","apps/mobile/src/services/observability.ts","apps/mobile/src/services/observabilityInit.ts",
    "src/lib/shared-core/sentryPrivacy.js","src/lib/nativeAppNudge.js","public/sw.js",
    "apps/mobile/src/lib/savedPulseCharts.ts"]) put(path,"// fixture\n");
  const mobileLock = readFileSync(join(repository,"apps/mobile/package-lock.json"));
  put("apps/mobile/package-lock.json",mobileLock);
  // Root CI installs only root dependencies. Run the real mobile checker in
  // this fixture with its own compiler dependency instead of relying on a
  // root `typescript` fallback or an already-installed mobile workspace.
  const compiler = join(repository,"node_modules/typescript-compiler-api");
  assert.equal(JSON.parse(readFileSync(join(compiler,"package.json"))).version,
    JSON.parse(mobileLock).packages["node_modules/typescript"].version,
    "the fixture compiler must equal the mobile lockfile's reviewed version");
  mkdirSync(join(root,"apps/mobile/node_modules"),{recursive:true});
  symlinkSync(compiler,join(root,"apps/mobile/node_modules/typescript"),"junction");
  for (const path of ["apps/mobile/scripts/type-coverage-ratchet.mjs", "scripts/type-coverage-history.mjs",
    "scripts/lib/type-coverage-pins.mjs", "scripts/lib/source-pins.mjs"]) put(path,readFileSync(join(repository,path)));
  put("apps/mobile/tsconfig.json",JSON.stringify({compilerOptions:{strict:true,types:[],target:"es2022"},include:["src"]}));
  put("apps/mobile/src/a.ts",'export const a: string = "a";');
  put("apps/mobile/src/b.ts",'export const b: string = "b";');
  put("apps/mobile/type-coverage-baseline.json",JSON.stringify({schema:1,measured_on:"2026-10-20",minimum_coverage_percent:98,new_file_minimum_percent:95,
    maximum_suppressions:{tsNoCheck:0,tsIgnore:0,tsExpectError:0,explicitAny:0,asAny:0,doubleAssertion:0}, files:{"src/a.ts":95,"src/b.ts":95}}));
  put("config/telemetry-disclosure-sources.json",'{"schema":2,"pins":"config/telemetry-disclosure-sources.d"}');
  node(`writeTelemetrySources(collectTelemetrySources()); writePins(LEGAL_PINS,legalCataloguePins(catalogues));`);
  git("init","-b","Main");git("config","user.name","Pin fixture");git("config","user.email","pin@example.invalid");
  git("add",".");git("commit","-qm","base");
  const base=git("rev-parse","HEAD");git("update-ref","refs/remotes/origin/Main",base);
  return {root,put,git,node,base};
}

for (const order of [["a","b"],["b","a"]]) test(`three pin families merge and validate in order ${order.join(" then ")}`,()=>{
  const r=fixture();
  try {
    r.node(validate);
    for (const side of ["a","b"]) {
      r.git("checkout","-b",side,r.base);
      r.put(`src/${side}.js`,`localStorage.setItem("sg-${side}", "reviewed-${side}");`);
      r.put("src/lib/i18n.js",`export const catalogue = {"legal.a":"${side==='a'?'A reviewed':'A'}","legal.b":"${side==='b'?'B reviewed':'B'}"};`);
      // Source lines are independent, as real catalogue edits would be.
      r.put("src/lib/i18n.js",readFileSync(join(r.root,"src/lib/i18n.js"),"utf8").replace('{"legal.a"','{\n"legal.a"').replace(',"legal.b"',',\n\n\n\n\n\n\n"legal.b"').replace('};','\n};'));
      r.node(`writeTelemetrySources(collectTelemetrySources());writePins(LEGAL_PINS,legalCataloguePins(catalogues));
        const previous=loadCoveragePins(baselinePath);const next=structuredClone(previous);next.files['src/${side}.ts']=100;next.minimum_coverage_percent=99;
        appendCoveragePin(baselinePath,previous,next);`);
      r.git("add",".");r.git("commit","-qm",`delivery ${side}`);
      r.node(validate);
    }
    r.git("checkout","-b","integrated",r.base);
    for (const side of order) { r.git("merge","--no-ff","-m",`merge ${side}`,side);r.node(validate); }
    // Requiring a retained pin for every observed value rejects both stale
    // source and incorrect generated values; validation never re-pins itself.
    const original=readFileSync(join(r.root,"src/a.js"),"utf8");
    r.put("src/a.js",'localStorage.setItem("unreviewed", "bad");');
    assert.throws(()=>r.node(validate));r.put("src/a.js",original);
    const legal=readFileSync(join(r.root,"src/lib/i18n.js"),"utf8");
    r.put("src/lib/i18n.js",legal.replace("A reviewed","Unreviewed legal copy"));
    assert.throws(()=>r.node(validate));r.put("src/lib/i18n.js",legal);
    for (const family of ["telemetry","legal"]) {
      const corrupt=`const directory=${JSON.stringify(family==='telemetry'?'config/telemetry-disclosure-sources.d':'config/legal-catalogue-pins')};
        const values=readPins(directory);const key=Object.keys(values)[0];values[key]='incorrect generated pin';writePins(directory,values);`;
      r.node(corrupt);assert.throws(()=>r.node(validate));r.git("reset","--hard","HEAD");
    }
    // Dropping a ratchet cannot reset a committed floor; exact HEAD history
    // still requires it. Malformed content-addressed receipts also fail.
    rmSync(join(r.root,"apps/mobile/type-coverage-ratchets"),{recursive:true});
    assert.throws(()=>r.node(validate));r.git("reset","--hard","HEAD");
    r.node(`const dir='apps/mobile/type-coverage-ratchets';const values=readPins(dir);values[Object.keys(values)[0]].files['src/a.ts']=1;writePins(dir,values);`);
    assert.throws(()=>r.node(validate));r.git("reset","--hard","HEAD");
    r.node(validate);
  } finally {rmSync(r.root,{recursive:true,force:true});}
});
