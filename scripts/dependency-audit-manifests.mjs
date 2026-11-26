#!/usr/bin/env node
// The isolated production dependency audit required CI runs (ci.yml job
// dependency-audit, review X0-S1 and A6-S1 on #7942). The job checks out only
// the base commit's scripts, writes the candidate's and the fork point's
// package.json and package-lock.json into two otherwise empty directories,
// and runs this trusted base copy with npm's user configuration neutralised:
//   node scripts/dependency-audit-manifests.mjs --head DIR --base DIR \
//     --merge-base SHA --registry https://registry.npmjs.org/
// The decision is manifestAuditCommand in dependency-audit-introduced.mjs.
// When a base commit predates this file, the job keeps its inline strict
// audit instead. Node built-ins only.
import { parseArgs } from 'node:util';
import { manifestAuditCommand } from './dependency-audit-introduced.mjs';

const { values } = parseArgs({ options: {
  head: { type: 'string' }, base: { type: 'string' }, 'merge-base': { type: 'string' }, registry: { type: 'string' },
} });
process.exitCode = manifestAuditCommand({ headDir: values.head, baseDir: values.base, mergeBase: values['merge-base'], registry: values.registry });
