process.stderr.write(`${JSON.stringify({
  event: "blocked",
  blocker: "TEST",
  message: "The inherited Guide-only RLS verifier is destructive and is disabled for Union Ground.",
  nextSafeAction: "Use test:unionground-db against an explicitly named disposable unionground-lab container.",
})}\n`);
process.exitCode = 2;
