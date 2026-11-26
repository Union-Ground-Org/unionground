#!/usr/bin/env node
// Generates src/features/messaging/generated/messagingContract.js from the
// migrations that actually define the rules, so responsive web and the Expo
// app cannot drift apart from the database — or from each other.
//
// BUG-UG-MESSAGE-REACTION-PARITY-20260904 and
// TEST-UG-SHARED-UNREAD-CONTRACT-20260904 are the same defect class: a rule
// the server owns, reimplemented once per client. Before this generator the
// database allowed five reaction kinds, responsive web hard-coded three, and
// the native channel screen carried its own emoji map; unread comparisons were
// written out twice in src/lib/memberApi.js and apps/mobile. One generated
// module plus one conformance fixture matrix replaces all of it.
//
//   npm run sync:messaging-contract          rewrite the generated module
//   npm run sync:messaging-contract -- --check   fail if it is stale (CI/tests)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(root, "supabase/migrations");
const target = join(root, "src/features/messaging/generated/messagingContract.js");

const SOURCES = Object.freeze({
  reactionKinds: "20261001010000_recovered_message_reaction_artwork.sql",
  redactionReasons: "20260907121000_member_message_body_lifecycle.sql",
  retention: "20260907121000_member_message_body_lifecycle.sql",
});

function read(name) {
  return readFileSync(join(migrations, name), "utf8");
}

function quotedList(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`${label}: pattern did not match its migration`);
  const values = [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]);
  if (values.length === 0) throw new Error(`${label}: matched an empty vocabulary`);
  return values;
}

export function readMessagingContract() {
  const reactionSql = read(SOURCES.reactionKinds);
  // The CHECK constraint and the RPC's own guard must agree, or the client
  // contract would be generated from a list the RPC then rejects.
  const constraintKinds = quotedList(
    reactionSql,
    /add constraint member_message_reactions_reaction_check\s*\n?\s*check \(reaction in \(([^)]*)\)\)/,
    "reaction kinds (constraint)",
  );
  const rpcKinds = quotedList(
    reactionSql,
    /p_reaction not in \(([^)]*)\)/,
    "reaction kinds (RPC guard)",
  );
  if (constraintKinds.join(",") !== rpcKinds.join(",")) {
    throw new Error(
      `reaction kinds disagree: constraint [${constraintKinds}] vs RPC guard [${rpcKinds}]`,
    );
  }

  const lifecycleSql = read(SOURCES.redactionReasons);
  const redactionReasons = quotedList(
    lifecycleSql,
    /add column redaction_reason text\s*\n?\s*check \(redaction_reason in \(([^)]*)\)\)/,
    "redaction reasons",
  );

  const retentionMatch = lifecycleSql.match(
    /when 'member_message_bodies' then pg_catalog\.jsonb_build_object\(\s*\n\s*'label', '([^']*)', 'minimumDays', (\d+), 'maximumDays', (\d+), 'defaultDays', (\d+),/,
  );
  if (!retentionMatch) throw new Error("retention: member_message_bodies class did not match");

  return {
    reactionKinds: constraintKinds,
    redactionReasons,
    retention: {
      dataClass: "member_message_bodies",
      label: retentionMatch[1],
      minimumDays: Number(retentionMatch[2]),
      maximumDays: Number(retentionMatch[3]),
      defaultDays: Number(retentionMatch[4]),
      operation: "redact",
    },
    sources: SOURCES,
  };
}

function render(contract) {
  const list = (values) => values.map((value) => `  ${JSON.stringify(value)},`).join("\n");
  return `// GENERATED FILE — do not edit by hand.
// Run \`npm run sync:messaging-contract\` after changing the migrations below.
// Source of truth:
${Object.entries(contract.sources).map(([key, file]) => `//   ${key}: supabase/migrations/${file}`).join("\n")}
//
// Every messaging rule the database owns lands here once, and both clients read
// it from here. A client that hard-codes one of these lists again fails
// tests/messaging-shared-contract.test.js.

export const MESSAGE_REACTION_KINDS = Object.freeze([
${list(contract.reactionKinds)}
]);

export const MESSAGE_REDACTION_REASONS = Object.freeze([
${list(contract.redactionReasons)}
]);

export const MESSAGE_BODY_RETENTION = Object.freeze({
${Object.entries(contract.retention).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join("\n")}
});
`;
}

// Rendered form of the current migrations, so tests can compare without
// touching the filesystem or running the CLI half of this module.
export function renderMessagingContract() {
  return render(readMessagingContract());
}

export function readGeneratedMessagingContract() {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

// CLI only when invoked directly: importing this module from a test must not
// write files or exit the process.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendered = renderMessagingContract();
  const current = readGeneratedMessagingContract();
  if (process.argv.includes("--check")) {
    if (current !== rendered) {
      console.error(
        "MESSAGING_CONTRACT_STALE: src/features/messaging/generated/messagingContract.js does not match the migrations. Run `npm run sync:messaging-contract`.",
      );
      process.exit(1);
    }
    console.log("messaging contract is current");
  } else if (current === rendered) {
    console.log("messaging contract already current");
  } else {
    writeFileSync(target, rendered);
    console.log(`wrote ${target}`);
  }
}
